// Seeded PRNG shared by synthetic data generation and the galaxy starfield,
// so both are reproducible without pulling in d3-random. Ported from
// reel.html's `mulberry32`.
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let s = seed;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
