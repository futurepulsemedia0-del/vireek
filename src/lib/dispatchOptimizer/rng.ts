export interface Rng {
  next(): number;
  int(n: number): number;
}

export function createRng(seed: number): Rng {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 1) >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n: number): number {
      if (!Number.isFinite(n) || n <= 1) return 0;
      return Math.floor(next() * Math.floor(n));
    },
  };
}
