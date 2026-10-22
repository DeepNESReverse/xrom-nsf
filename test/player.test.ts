import { describe, expect, it } from 'vitest';
import { CPU_HZ } from '@xromdev/apu';
import { NsfPlayer, parseNsf, renderNsf } from '../src/index.js';

/**
 * NSF files built here, byte by byte, from a few lines of 6502 — so the tests
 * need nobody's music. Each is a tiny driver with one job to check.
 */
function nsf(
  program: Map<number, number[]>,
  {
    songs = 1,
    init = 0x8000,
    play = 0x8020,
    banks = [0, 0, 0, 0, 0, 0, 0, 0],
    size = 0x1000,
    speed = 16639, // µs — NTSC's 60.0988 Hz
    title = 'Test',
  } = {}
) {
  const header = new Uint8Array(0x80);
  header.set([0x4e, 0x45, 0x53, 0x4d, 0x1a, 1, songs, 1]);
  const word = (at: number, v: number) => header.set([v & 0xff, v >> 8], at);
  word(8, 0x8000);
  word(0x0a, init);
  word(0x0c, play);
  header.set([...title].map((c) => c.charCodeAt(0)), 0x0e);
  header.set([...'Someone'].map((c) => c.charCodeAt(0)), 0x2e);
  word(0x6e, speed);
  header.set(banks, 0x70);
  const data = new Uint8Array(size);
  for (const [address, bytes] of program) data.set(bytes, address - 0x8000);
  const file = new Uint8Array(0x80 + size);
  file.set(header);
  file.set(data, 0x80);
  return file;
}

/** Rising zero crossings over a slice, in Hz. */
function hz(samples: Float32Array, rate: number, from: number, to: number) {
  let c = 0;
  let first = -1;
  let last = -1;
  for (let i = Math.round(from * rate) + 1; i < Math.round(to * rate); i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      c++;
      if (first < 0) first = i;
      last = i;
    }
  }
  return c < 2 ? 0 : ((c - 1) * rate) / (last - first);
}

// INIT: remember the song, pulse 1 on at 50% duty, full volume, sweep off,
// period from the table, then start it. PLAY: keep $4015 in $02, count
// frames in $0200.
const PULSE_DRIVER = new Map([
  [
    0x8000,
    [
      0x85, 0x00, // STA $00          song index
      0xa9, 0xbf, 0x8d, 0x00, 0x40, // LDA #$BF, STA $4000
      0xa9, 0x08, 0x8d, 0x01, 0x40, // LDA #$08, STA $4001
      0xa6, 0x00, // LDX $00
      0xbd, 0x40, 0x80, 0x8d, 0x02, 0x40, // LDA $8040,X, STA $4002
      0xa9, 0x08, 0x8d, 0x03, 0x40, // LDA #$08, STA $4003
      0xad, 0x15, 0x40, 0x85, 0x02, // LDA $4015, STA $02
      0x60, // RTS
    ],
  ],
  [0x8020, [0xad, 0x15, 0x40, 0x85, 0x02, 0xee, 0x00, 0x02, 0x60]], // LDA $4015, STA $02, INC $0200, RTS
  [0x8040, [0xfd, 0xa9]], // periods: 253 (440 Hz), 169 (658 Hz)
]);

describe('reading an NSF header', () => {
  it('finds the addresses, the names and the rate', () => {
    const info = parseNsf(nsf(PULSE_DRIVER, { songs: 2, title: 'Hello' }));
    expect(info).toMatchObject({
      title: 'Hello',
      artist: 'Someone',
      songs: 2,
      startSong: 1,
      loadAddress: 0x8000,
      initAddress: 0x8000,
      playAddress: 0x8020,
      region: 'NTSC',
      banks: null,
      expansion: [],
    });
    expect(info.playHz).toBeCloseTo(60.1, 1);
  });

  it('refuses a file that is not an NSF', () => {
    expect(() => parseNsf(new Uint8Array(200))).toThrow(/NESM/);
  });

  it('names the expansion chips a file wants', () => {
    const file = nsf(PULSE_DRIVER);
    file[0x7b] = 0b000101;
    expect(parseNsf(file).expansion).toEqual(['VRC6', 'FDS']);
  });
});

describe('playing it', () => {
  it('plays what the driver writes, song by song', () => {
    const file = nsf(PULSE_DRIVER, { songs: 2 });
    const one = renderNsf(file, 1, 0.5);
    const two = renderNsf(file, 2, 0.5);
    expect(hz(one.samples, one.sampleRate, 0.1, 0.45)).toBeCloseTo(CPU_HZ / (16 * 254), 0);
    expect(hz(two.samples, two.sampleRate, 0.1, 0.45)).toBeCloseTo(CPU_HZ / (16 * 170), 0);
  });

  it('calls PLAY at the header rate', () => {
    const player = new NsfPlayer(nsf(PULSE_DRIVER));
    player.render(new Float32Array(44100)); // one second
    // One call at time 0 and one per frame after it.
    expect(player.peek(0x0200)).toBe(61);
  });

  it('lets the driver read $4015 from the chip', () => {
    const player = new NsfPlayer(nsf(PULSE_DRIVER));
    player.render(new Float32Array(4410));
    // Pulse 1 was started by INIT and its counter is halted: bit 0 set.
    expect(player.peek(0x0002) & 0x1f).toBe(1);
  });

  it('reports every write with its time', () => {
    const { writes } = renderNsf(nsf(PULSE_DRIVER), 1, 0.1);
    expect(writes.map((w) => w.address)).toEqual([0x4000, 0x4001, 0x4002, 0x4003]);
    // INIT's writes, in the order the code ran — all at time 0, as INIT is over before the first frame.
    for (const w of writes) expect(w.time).toBe(0);
    expect(writes[3].time).toBeLessThan(0.001);
  });

  it('switches banks through $5FF8–$5FFF', () => {
    // Window 1 ($9000) starts on bank 1, whose table says 253. Song 2's INIT
    // switches it to bank 2, whose table says 169, before reading.
    const code = new Map(PULSE_DRIVER);
    code.set(0x8000, [
      0xc9, 0x01, // CMP #1
      0xd0, 0x05, // BNE +5
      0xa9, 0x02, 0x8d, 0xf9, 0x5f, // LDA #2, STA $5FF9
      0xa9, 0xbf, 0x8d, 0x00, 0x40,
      0xa9, 0x08, 0x8d, 0x01, 0x40,
      0xad, 0x00, 0x90, 0x8d, 0x02, 0x40, // LDA $9000, STA $4002
      0xa9, 0x08, 0x8d, 0x03, 0x40,
      0x60,
    ]);
    code.set(0x9000, [0xfd]); // bank 1
    code.set(0xa000, [0xa9]); // bank 2 (laid out as the third 4 KB of data)
    const file = nsf(code, { songs: 2, banks: [0, 1, 2, 3, 4, 5, 6, 7], size: 0x3000 });
    const one = renderNsf(file, 1, 0.4);
    const two = renderNsf(file, 2, 0.4);
    expect(hz(one.samples, one.sampleRate, 0.1, 0.35)).toBeCloseTo(CPU_HZ / (16 * 254), 0);
    expect(hz(two.samples, two.sampleRate, 0.1, 0.35)).toBeCloseTo(CPU_HZ / (16 * 170), 0);
  });

  it('feeds the DMC from the file', () => {
    // A sample of all 1s at $C000: the DMC output climbs from 0 to 126.
    const code = new Map([
      [
        0x8000,
        [
          0xa9, 0x0f, 0x8d, 0x10, 0x40, // rate 15
          0xa9, 0x00, 0x8d, 0x11, 0x40, // level 0
          0x8d, 0x12, 0x40, // $C000
          0xa9, 0x01, 0x8d, 0x13, 0x40, // 17 bytes
          0xa9, 0x1f, 0x8d, 0x15, 0x40, // go
          0x60,
        ],
      ],
      [0x8020, [0x60]],
      [0xc000, new Array(17).fill(0xff)],
    ]);
    const player = new NsfPlayer(nsf(code, { size: 0x5000 }));
    player.render(new Float32Array(4410)); // 0.1 s
    expect(player.apu.snapshot().dmc.level).toBe(126);
  });

  it('gives up on a routine that never returns, instead of hanging', () => {
    const code = new Map([
      [0x8000, [0x60]],
      [0x8020, [0x4c, 0x20, 0x80]], // JMP $8020 forever
    ]);
    const player = new NsfPlayer(nsf(code), { maxCallCycles: 50_000 });
    expect(() => player.render(new Float32Array(4410))).not.toThrow();
  });
  it('finishes a slow INIT before the first PLAY', () => {
    // INIT spends ~2 frames in a delay loop, then silences everything. PLAY starts a note on its
    // first call. On the console INIT returns before PLAY ever runs, so the note must sound.
    const code = new Map([
      [
        0x8000,
        [
          0xa2, 0x30, 0xa0, 0x00, // LDX #$30, LDY #0
          0x88, 0xd0, 0xfd, // DEY / BNE
          0xca, 0xd0, 0xfa, // DEX / BNE
          0xa9, 0x00, 0x8d, 0x15, 0x40, // $4015 = 0
          0x60,
        ],
      ],
      [
        0x8020,
        [
          0xa5, 0x00, 0xd0, 0x1b, 0xe6, 0x00, // once
          0xa9, 0x01, 0x8d, 0x15, 0x40, // pulse 1 on
          0xa9, 0xbf, 0x8d, 0x00, 0x40, // 50%, held, volume 15
          0xa9, 0x00, 0x8d, 0x01, 0x40, // sweep off
          0xa9, 0xfd, 0x8d, 0x02, 0x40, // period $0FD
          0xa9, 0x00, 0x8d, 0x03, 0x40,
          0x60,
        ],
      ],
    ]);
    const writes: number[] = [];
    const { samples, sampleRate } = renderNsf(nsf(code), 1, 0.5);
    const player = new NsfPlayer(nsf(code), { onWrite: (w) => w.address === 0x4015 && writes.push(w.value) });
    player.start(1);
    player.render(new Float32Array(4410));
    expect(writes).toEqual([0x00, 0x01]);
    expect(hz(samples, sampleRate, 0.3, 0.45)).toBeCloseTo(CPU_HZ / (16 * 254), 0);
  });

  it('answers $4015 with the writes of the call that reads it', () => {
    // PLAY starts pulse 1, reads $4015 straight back and keeps it in $10; then silences it and
    // reads again into $11.
    const code = new Map([
      [0x8000, [0x60]],
      [
        0x8020,
        [
          0xa9, 0x01, 0x8d, 0x15, 0x40,
          0xa9, 0x00, 0x8d, 0x03, 0x40, // length loaded
          0xad, 0x15, 0x40, 0x85, 0x10, // read: sounding
          0xa9, 0x00, 0x8d, 0x15, 0x40,
          0xad, 0x15, 0x40, 0x85, 0x11, // read: stopped
          0x60,
        ],
      ],
    ]);
    const player = new NsfPlayer(nsf(code));
    player.render(new Float32Array(1000));
    expect(player.peek(0x10) & 1).toBe(1);
    expect(player.peek(0x11) & 1).toBe(0);
  });
});
