# @xromdev/nsf

Play NES music from **NSF files** in TypeScript: the game's own music driver
running on [@xromdev/6502](https://github.com/DeepNESReverse/xrom-6502), writing
into [@xromdev/apu](https://github.com/DeepNESReverse/xrom-apu).

```
.nsf → the 6502 runs INIT, then PLAY sixty times a second
     → every write to $4000–$4017, at the cycle it was made
     → the APU → samples
```

Nothing here knows how any game stores its music — the driver in the file
does that, exactly as it did in the cartridge. So it plays any NSF, and every
write lands in the chip at the moment inside the frame that the CPU made it
(which matters for drivers that stream PCM through `$4011`).

- Header parsing: title, artist, songs, load/init/play, play rate, region,
  bankswitching, expansion chips.
- Bankswitched files (`$5FF8`–`$5FFF`), WRAM at `$6000`, `$4015` reads answered
  by the real chip state, DMC samples read from the file.
- Streaming (`NsfPlayer.render`) for live playback, offline (`renderNsf`) for a
  buffer — plus every APU write with its time.

**Try it: [xrom.dev/utils/nsf](https://xrom.dev/utils/nsf)** — drop an NSF and listen.

## Install

```sh
npm install @xromdev/nsf
```

## Use

```ts
import { renderNsf, NsfPlayer, parseNsf } from '@xromdev/nsf';

const file = new Uint8Array(await (await fetch('/music.nsf')).arrayBuffer());
console.log(parseNsf(file)); // { title, artist, songs, playHz, expansion, … }

// Offline: 30 seconds of song 1, and every register write the driver made.
const { samples, sampleRate, writes } = renderNsf(file, 1, 30);

// Live: pull blocks as the audio side needs them.
const player = new NsfPlayer(file, { sampleRate: 48000 });
player.start(2);
const block = new Float32Array(128);
player.render(block);
```

`writes` is a plain list of `{ time, address, value }` — the same input
`@xromdev/apu`'s `renderWrites` takes, so a song can be decoded once and
replayed, edited, or drawn.

## Options

| option | default | |
|---|---|---|
| `sampleRate` | 44100 | |
| `oversample` | 2 | Chip rate multiple, averaged down. |
| `gain` | 2.2 | Master level. |
| `voiceLevels` | `[1,1,1,1,1]` | Per-channel faders: pulse 1, pulse 2, triangle, noise, DMC. |
| `filters` | true | The console's output filters. |
| `onWrite` | — | Called with every APU write and its time. |
| `maxCallCycles` | 10 000 000 | A routine that runs longer is abandoned rather than hanging the player. |

`player.apu` is the chip itself — `player.apu.snapshot()` gives its counters,
and `player.renderLevels()` the per-channel levels for drawing oscilloscopes.

## Not supported

- **Expansion audio**: VRC6, VRC7, FDS, MMC5, N163, Sunsoft 5B. `parseNsf`
  lists what a file needs in `expansion`; only its 2A03 part is played.
- NSF2 and NSFe extras (per-track lengths, playlists, IRQ-driven playback).
- PAL timing of the chip itself (a PAL file's play rate is honoured).

## Development

```sh
npm install
npm test   # NSF files assembled byte by byte in the tests — no one's music needed
```

## License

MIT © Oleksandr Maksymov
