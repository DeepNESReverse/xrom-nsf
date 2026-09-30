/**
 * NSF — the NES Sound Format: a game's music driver and data, cut out of the
 * cartridge, with a header that says where to call it.
 *
 * `parseNsf` reads that header. The file does the rest by itself: run INIT once
 * with the song number in A, then PLAY once a frame, and the driver writes the
 * APU's registers as it did in the game.
 */

export type Expansion = 'VRC6' | 'VRC7' | 'FDS' | 'MMC5' | 'N163' | 'Sunsoft 5B';

export interface NsfInfo {
  version: number;
  title: string;
  artist: string;
  copyright: string;
  /** How many songs; the player takes 1-based song numbers. */
  songs: number;
  startSong: number;
  loadAddress: number;
  initAddress: number;
  playAddress: number;
  /** How often PLAY is called, in Hz (NTSC unless the file is PAL-only). */
  playHz: number;
  region: 'NTSC' | 'PAL' | 'dual';
  /** The eight 4 KB bank numbers for $8000–$FFFF, when the file bankswitches. */
  banks: number[] | null;
  /** Extra sound chips the music uses. This player plays only the 2A03 part of it. */
  expansion: Expansion[];
  /** The program and data, from byte $80 of the file. */
  data: Uint8Array;
}

const text = (bytes: Uint8Array, at: number) => {
  let s = '';
  for (let i = at; i < at + 32 && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
};

const EXPANSIONS: Expansion[] = ['VRC6', 'VRC7', 'FDS', 'MMC5', 'N163', 'Sunsoft 5B'];

/** Read an NSF file's header. Throws on anything that is not one. */
export function parseNsf(file: Uint8Array): NsfInfo {
  const magic = [0x4e, 0x45, 0x53, 0x4d, 0x1a]; // "NESM\x1A"
  if (file.length < 0x80 || magic.some((b, i) => file[i] !== b)) {
    throw new Error('not an NSF file: it does not start with NESM');
  }
  const word = (at: number) => file[at] | (file[at + 1] << 8);
  const bankBytes = Array.from(file.subarray(0x70, 0x78));
  const flags = file[0x7a];
  const region = flags & 2 ? 'dual' : flags & 1 ? 'PAL' : 'NTSC';
  const speed = region === 'PAL' ? word(0x78) : word(0x6e);
  const chips = file[0x7b];
  return {
    version: file[5],
    title: text(file, 0x0e),
    artist: text(file, 0x2e),
    copyright: text(file, 0x4e),
    songs: file[6],
    startSong: Math.max(1, file[7]),
    loadAddress: word(8),
    initAddress: word(0x0a),
    playAddress: word(0x0c),
    // The speed is the period in microseconds; 0 means the region's default.
    playHz: speed > 0 ? 1e6 / speed : region === 'PAL' ? 50.007 : 60.0988,
    region,
    banks: bankBytes.some((b) => b !== 0) ? bankBytes : null,
    expansion: EXPANSIONS.filter((_, i) => chips & (1 << i)),
    data: file.subarray(0x80),
  };
}
