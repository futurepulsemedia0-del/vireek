// Blind-test helpers (pure). A session id encodes which catalog voices are compared, so every
// teammate who joins with the same code hears the same labels in the same order.
import { fnv1a } from "./ab.ts";

export function makeSessionId(rand: string, indices: number[]): string {
  return `${rand}-${indices.map((i) => i.toString(36)).join("")}`;
}

export function parseSessionId(id: string, catalogSize: number): number[] | null {
  const m = /^([a-z0-9]{8})-([a-z0-9]{2,3})$/.exec(id);
  if (!m) return null;
  const idx = [...m[2]].map((c) => parseInt(c, 36));
  if (new Set(idx).size !== idx.length || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= catalogSize)) return null;
  return idx;
}

export function seededOrder<T>(items: T[], seed: string): T[] {
  return items
    .map((item, i) => ({ item, i, k: fnv1a(`${seed}:${i}`) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.item);
}

export function tally(votes: { voice_key: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of votes) out[v.voice_key] = (out[v.voice_key] ?? 0) + 1;
  return out;
}
