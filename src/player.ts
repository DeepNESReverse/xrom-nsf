/**
 * An NSF player: the game's own driver on a 6502, writing into an APU.
 *
 *   NSF → @xromdev/cpu6502 runs INIT, then PLAY every frame
 *       → each write to $4000–$4017, at the cycle it happened
 *       → @xromdev/apu → samples
 *
 * Nothing here knows how any game stores its music: the driver in the file
 * does that, exactly as it did in the cartridge. A write lands in the chip at
 * the moment inside the frame that the CPU made it — which matters for drivers
 * that play PCM by writing $4011 in a loop.
 */

import { Cpu6502, type Bus } from '@xromdev/cpu6502';
import { Apu, CPU_HZ, mixApu, N163Chip, OutputFilters, type ChannelBuffers, type RegisterWrite } from '@xromdev/apu';
import { parseNsf, type NsfInfo } from './nsf.js';

export interface NsfPlayerOptions {
  sampleRate?: number;
  /** Run the chip at this multiple of the sample rate and average down. Default 2. */
  oversample?: number;
  /** Master level. Default 2.2, as `@xromdev/apu`'s renderer. */
  gain?: number;
  /** A fader per channel, `[pulse1, pulse2, triangle, noise, dmc]`, 0..1. */
  voiceLevels?: readonly number[];
  /** The console's output filters. Default true. */
  filters?: boolean;
  /**
   * Called for every sound write the driver makes, with its time in seconds from the song's start —
   * the 2A03's `$4000`–`$4017` and, on a file that uses them, the FDS's `$4040`–`$408A` and the
   * N163's ports (`$F800` address, `$4800` data, `$E000`).
   */
  onWrite?: (write: RegisterWrite) => void;
  /**
   * Most cycles one call of INIT or PLAY may take before it is abandoned. A
   * well-behaved routine returns in a frame's worth (~30 000); the default
   * allows a few seconds, for INITs that clear memory the slow way.
   */
  maxCallCycles?: number;
}

/** Where the fake return address of a routine call points: unmapped, never executed. */
const SENTINEL = 0x5ff5;

/** The NES's memory as an NSF sees it. */
class NsfMachine implements Bus {
  readonly ram = new Uint8Array(0x800);
  readonly wram = new Uint8Array(0x2000);
  /**
   * The Disk System's memory, `$6000`–`$FFFF`, on an FDS file: the program runs from RAM, and the
   * bank registers COPY a 4 KB bank into a window of it rather than map one in. `$6000`–`$DFFF`
   * is writable.
   */
  private readonly fdsMemory: Uint8Array | null;
  /**
   * The N163's RAM as the CPU sees it, on an N163 file: kept here as well as in the chip so a
   * driver reading back what it just wrote gets it at once — the chip gets the same writes at
   * their moment in the frame.
   */
  readonly n163: N163Chip | null;
  private readonly fds: boolean;
  /** $8000–$FFFF: the file's data, laid out as the header says. */
  private readonly image: Uint8Array;
  /** 4 KB bank per window, when the file bankswitches. */
  private readonly banks: number[] | null;
  private readonly bankCount: number;
  /** Receives $4000–$4017 writes; answers $4015 reads. */
  apuWrite: (address: number, value: number) => void = () => {};
  apuStatus: () => number = () => 0;

  constructor(private readonly info: NsfInfo) {
    this.fds = info.expansion.includes('FDS');
    this.n163 = info.expansion.includes('N163') ? new N163Chip(44100) : null;
    this.fdsMemory = this.fds ? new Uint8Array(0xa000) : null;
    if (info.banks) {
      // Bankswitched files are padded so the load address falls at its offset
      // within a 4 KB bank, then cut into 4 KB banks.
      const pad = info.loadAddress & 0x0fff;
      this.image = new Uint8Array(Math.ceil((pad + info.data.length) / 0x1000) * 0x1000);
      this.image.set(info.data, pad);
      this.bankCount = this.image.length / 0x1000;
      this.banks = [...info.banks];
    } else {
      this.image = new Uint8Array(0x8000);
      const offset = info.loadAddress - 0x8000;
      if (offset < 0) throw new Error(`load address $${info.loadAddress.toString(16)} is below $8000`);
      this.image.set(info.data.subarray(0, 0x8000 - offset), offset);
      this.bankCount = 0;
      this.banks = null;
    }
    this.loadFds();
  }

  /** The image into the Disk System's RAM: by bank when the file bankswitches, at its load address when not. */
  private loadFds() {
    const memory = this.fdsMemory;
    if (!memory) return;
    memory.fill(0);
    if (this.banks && this.info.banks) {
      // $6000/$7000 start with the banks the header gives $E000/$F000 — the NSF spec's rule.
      const initial = [this.info.banks[6], this.info.banks[7], ...this.info.banks];
      initial.forEach((bank, window) => this.copyBank(window, bank));
    } else {
      const offset = this.info.loadAddress - 0x6000;
      memory.set(this.info.data.subarray(0, Math.max(0, 0xa000 - offset)), Math.max(0, offset));
    }
  }

  /** Bank `bank` into window `window` of the Disk System's memory ($6000 + window·4 KB). */
  private copyBank(window: number, bank: number) {
    const start = (bank % this.bankCount) * 0x1000;
    this.fdsMemory!.set(this.image.subarray(start, start + 0x1000), window * 0x1000);
  }

  read(address: number): number {
    if (address < 0x2000) return this.ram[address & 0x7ff];
    if (address === 0x4015) return this.apuStatus();
    if (this.n163 && address >= 0x4800 && address <= 0x4fff) return this.n163.read();
    if (this.fdsMemory && address >= 0x6000) return this.fdsMemory[address - 0x6000];
    if (address >= 0x6000 && address < 0x8000) return this.wram[address - 0x6000];
    if (address >= 0x8000) {
      if (!this.banks) return this.image[address - 0x8000];
      const window = (address - 0x8000) >> 12;
      const bank = this.banks[window] % this.bankCount;
      return this.image[bank * 0x1000 + (address & 0x0fff)];
    }
    return 0;
  }

  write(address: number, value: number) {
    if (address < 0x2000) this.ram[address & 0x7ff] = value;
    else if (address >= 0x4000 && address <= 0x4017) this.apuWrite(address, value);
    else if (this.fds && address >= 0x4040 && address <= 0x408a) this.apuWrite(address, value);
    else if (
      this.n163 &&
      ((address >= 0x4800 && address <= 0x4fff) || address >= 0xf800 || (address >= 0xe000 && address <= 0xe7ff))
    ) {
      this.n163.write(address, value);
      this.apuWrite(address, value);
    } else if (this.fdsMemory && address >= 0x5ff6 && address <= 0x5fff && this.banks) {
      // Bank switching on the Disk System copies the bank in.
      if (address >= 0x5ff8) this.banks[address - 0x5ff8] = value;
      this.copyBank(address - 0x5ff6, value);
    } else if (this.fdsMemory && address >= 0x6000 && address < 0xe000) this.fdsMemory[address - 0x6000] = value;
    else if (address >= 0x5ff8 && address <= 0x5fff && this.banks) this.banks[address - 0x5ff8] = value;
    else if (address >= 0x6000 && address < 0x8000) this.wram[address - 0x6000] = value;
  }

  resetBanks() {
    if (this.banks && this.info.banks) this.banks.splice(0, 8, ...this.info.banks);
    this.loadFds();
    if (this.n163) this.n163.ram.fill(0);
  }
}

interface PendingWrite {
  /** Chip-rate sample index. */
  at: number;
  address: number;
  value: number;
}

export class NsfPlayer {
  readonly info: NsfInfo;
  readonly sampleRate: number;
  /** The chip, for a caller that wants its `snapshot()`. */
  apu: Apu;
  private readonly machine: NsfMachine;
  private readonly cpu: Cpu6502;
  private readonly rate: number;
  private readonly oversample: number;
  private readonly options: NsfPlayerOptions;
  private filters: OutputFilters;
  private song = 0;
  /** Chip-rate samples since the song started, and when the next PLAY is due. */
  private now = 0;
  private nextPlay = 0;
  private readonly framePeriod: number;
  private pending: PendingWrite[] = [];
  private callStart = 0;
  private callAt = 0;
  private scratch: ChannelBuffers | null = null;

  constructor(file: Uint8Array, options: NsfPlayerOptions = {}) {
    this.info = parseNsf(file);
    this.options = options;
    this.sampleRate = options.sampleRate ?? 44100;
    this.oversample = Math.max(1, Math.round(options.oversample ?? 2));
    this.rate = this.sampleRate * this.oversample;
    this.framePeriod = this.rate / this.info.playHz;
    this.machine = new NsfMachine(this.info);
    this.cpu = new Cpu6502(this.machine);
    this.apu = this.newApu();
    this.filters = new OutputFilters(this.rate, false);
    this.machine.apuWrite = (address, value) => {
      const offset = ((this.cpu.cycles - this.callStart) / CPU_HZ) * this.rate;
      this.pending.push({ at: this.callAt + offset, address, value });
    };
    this.machine.apuStatus = () => {
      const s = this.apu.snapshot();
      return (
        (s.pulse[0].length > 0 ? 1 : 0) |
        (s.pulse[1].length > 0 ? 2 : 0) |
        (s.triangle.length > 0 ? 4 : 0) |
        (s.noise.length > 0 ? 8 : 0) |
        (s.dmc.remaining > 0 ? 0x10 : 0)
      );
    };
    this.start(this.info.startSong);
  }

  private newApu() {
    return new Apu(this.rate, {
      memory: (address) => this.machine.read(address),
      expansion: this.info.expansion.filter((chip) => chip === 'FDS' || chip === 'N163'),
    });
  }

  /** A byte of memory as the driver sees it — RAM, the current banks, and $4015. */
  peek(address: number): number {
    return this.machine.read(address & 0xffff);
  }

  /** The song playing, 1-based. */
  get currentSong() {
    return this.song;
  }

  /** Seconds of the current song played so far. */
  get time() {
    return this.now / this.rate;
  }

  /** (Re)start song `song` (1-based) from the top, as the NSF spec says to. */
  start(song: number) {
    const n = Math.min(Math.max(1, Math.round(song)), this.info.songs);
    this.song = n;
    this.machine.ram.fill(0);
    this.machine.wram.fill(0);
    this.machine.resetBanks();
    this.apu = this.newApu();
    this.filters = new OutputFilters(this.rate, false);
    this.now = 0;
    this.pending = [];
    // The APU as the spec leaves it for INIT: silent, all channels enabled,
    // frame counter in 4-step mode.
    for (let a = 0x4000; a <= 0x4013; a++) this.apu.write(a, 0);
    this.apu.write(0x4015, 0x00);
    this.apu.write(0x4015, 0x0f);
    this.apu.write(0x4017, 0x40);
    this.cpu.s = 0xfd;
    this.call(this.info.initAddress, n - 1, this.info.region === 'PAL' ? 1 : 0, 0);
    this.nextPlay = 0;
  }

  /** JSR `address` with A and X set, and run until it returns. */
  private call(address: number, a: number, x: number, at: number) {
    const cpu = this.cpu;
    cpu.a = a & 0xff;
    cpu.x = x & 0xff;
    cpu.y = 0;
    cpu.p = 0x24;
    // Push a return address that points at the sentinel, as JSR would.
    const back = SENTINEL - 1;
    this.machine.write(0x100 | cpu.s, back >> 8);
    cpu.s = (cpu.s - 1) & 0xff;
    this.machine.write(0x100 | cpu.s, back & 0xff);
    cpu.s = (cpu.s - 1) & 0xff;
    cpu.pc = address;
    this.callStart = cpu.cycles;
    this.callAt = at;
    const limit = this.options.maxCallCycles ?? 10_000_000;
    while (cpu.pc !== SENTINEL && !cpu.jammed && cpu.cycles - this.callStart < limit) cpu.step();
    if (cpu.pc !== SENTINEL) {
      // A routine that never returns: put the stack back and move on.
      cpu.s = 0xfd;
    }
  }

  /**
   * Advance `count` chip-rate samples (sample rate × oversample), writing each
   * channel's level into `buffers` from `offset` — as `Apu.render` does, with
   * the driver running in between. For mixing it yourself; `render` mixes.
   */
  renderLevels(count: number, buffers: ChannelBuffers, offset = 0) {
    const end = this.now + count;
    let at = offset;
    while (this.now < end) {
      if (this.now >= this.nextPlay) {
        this.call(this.info.playAddress, 0, 0, this.nextPlay);
        this.nextPlay += this.framePeriod;
      }
      // Apply writes that are due; the rest wait for their sample.
      if (this.pending.length > 0) {
        this.pending.sort((p, q) => p.at - q.at);
        while (this.pending.length > 0 && this.pending[0].at <= this.now) {
          const w = this.pending.shift()!;
          this.apu.write(w.address, w.value);
          this.options.onWrite?.({ time: w.at / this.rate, address: w.address, value: w.value });
        }
      }
      const nextEvent = Math.min(
        end,
        Math.ceil(this.nextPlay),
        this.pending.length > 0 ? Math.ceil(this.pending[0].at) : end
      );
      const run = Math.max(1, nextEvent - this.now);
      this.apu.render(run, buffers, at);
      at += run;
      this.now += run;
    }
  }

  /** Fill `out` with mixed, filtered mono samples at `sampleRate`. */
  render(out: Float32Array) {
    const over = this.oversample;
    const block = 512;
    if (!this.scratch || this.scratch.pulse1.length < block * over) {
      const n = block * over;
      this.scratch = {
        pulse1: new Uint8Array(n),
        pulse2: new Uint8Array(n),
        triangle: new Uint8Array(n),
        noise: new Float64Array(n),
        dmc: new Uint8Array(n),
        ...(this.apu.fds ? { fds: new Float64Array(n) } : {}),
        ...(this.apu.n163 ? { n163: Array.from({ length: 8 }, () => new Float64Array(n)) } : {}),
      };
    }
    const { pulse1: p1, pulse2: p2, triangle: tri, noise, dmc } = this.scratch;
    // The expansion voices, as `@xromdev/apu`'s renderer numbers them: FDS 5, N163 6.. (slot 7 first).
    const fdsOut = this.scratch.fds;
    const n163Out = this.scratch.n163;
    const f = this.options.voiceLevels ?? [];
    const fFds = f[5] ?? 1;
    const fN163 = Array.from({ length: 8 }, (_, slot) => f[6 + 7 - slot] ?? 1);
    const f0 = f[0] ?? 1;
    const f1 = f[1] ?? 1;
    const f2 = f[2] ?? 1;
    const f3 = f[3] ?? 1;
    const f4 = f[4] ?? 1;
    // Faders at 1 multiply nothing, so the tables give exactly the formula's floats.
    const faded = f0 !== 1 || f1 !== 1 || f2 !== 1 || f3 !== 1 || f4 !== 1;
    const gain = this.options.gain ?? 2.2;
    const filtered = this.options.filters !== false;
    const filters = this.filters;
    for (let done = 0; done < out.length; ) {
      const n = Math.min(block, out.length - done);
      this.renderLevels(n * over, this.scratch);
      for (let i = 0, k = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < over; j++, k++) {
          let mixed: number;
          if (faded) mixed = mixApu(p1[k] * f0, p2[k] * f1, tri[k] * f2, noise[k] * f3, dmc[k] * f4);
          else if (noise[k] === 0 && dmc[k] === 0) mixed = MIX[((p1[k] + p2[k]) << 4) | tri[k]];
          else mixed = mixApu(p1[k], p2[k], tri[k], noise[k], dmc[k]);
          if (fdsOut) mixed += fdsOut[k] * fFds;
          if (n163Out) for (let slot = 0; slot < 8; slot++) mixed += n163Out[slot]![k] * fN163[slot];
          sum += filtered ? filters.step(mixed) : mixed;
        }
        const v = (sum / over) * gain;
        out[done + i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      done += n;
    }
  }
}

/**
 * `mixApu` for whole-number levels, looked up: the two pulses summed (0..30),
 * and the triangle alone. Built by calling `mixApu` itself, so a lookup is the
 * very float the formula gives.
 */
const PULSE_MIX = Float64Array.from({ length: 31 }, (_, sum) => mixApu(sum, 0, 0, 0, 0));
const TRIANGLE_MIX = Float64Array.from({ length: 16 }, (_, level) => mixApu(0, 0, level, 0, 0));
/** The two added up in advance, at `(pulses << 4) | triangle`: one lookup, the same floats. */
const MIX = Float64Array.from({ length: 31 * 16 }, (_, i) => PULSE_MIX[i >> 4] + TRIANGLE_MIX[i & 15]);

/**
 * Render `seconds` of song `song` from an NSF file, offline. Returns the
 * samples and every APU write the driver made — writes that
 * `@xromdev/apu`'s `renderWrites` plays back the same way.
 */
export function renderNsf(
  file: Uint8Array,
  song: number,
  seconds: number,
  options: Omit<NsfPlayerOptions, 'onWrite'> = {}
): { samples: Float32Array; sampleRate: number; writes: RegisterWrite[]; info: NsfInfo } {
  const writes: RegisterWrite[] = [];
  const player = new NsfPlayer(file, { ...options, onWrite: (w) => writes.push(w) });
  player.start(song);
  const samples = new Float32Array(Math.round(seconds * player.sampleRate));
  player.render(samples);
  return { samples, sampleRate: player.sampleRate, writes, info: player.info };
}
