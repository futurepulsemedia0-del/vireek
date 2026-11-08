import type { SettingsEntry } from './registry';

export interface SearchHit {
  entry: SettingsEntry;
  score: number;
  /** [start, end) ranges inside entry.label to highlight. */
  labelRanges: [number, number][];
}

export function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Edit distance <= 1 (insert/delete/substitute/transpose). */
function withinOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ra = a.slice(i + 1), rb = b.slice(i + 1);
  if (a.length === b.length) {
    if (ra === rb) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function tokenScore(token: string, words: string[]): number {
  let best = 0;
  for (const w of words) {
    if (w === token) best = Math.max(best, 10);
    else if (w.startsWith(token)) best = Math.max(best, 8);
    else if (token.length >= 3 && w.includes(token)) best = Math.max(best, 4);
    else if (token.length >= 4 && w.length >= 4 && withinOne(token, w)) best = Math.max(best, 3);
  }
  return best;
}

function labelRanges(label: string, tokens: string[]): [number, number][] {
  const lower = label.toLowerCase();
  const out: [number, number][] = [];
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0) out.push([i, i + t.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * Every query token must match somewhere (AND), so results stay precise.
 * Weights: label 5x, keywords 3x, description 1x.
 */
export function searchSettings(query: string, entries: readonly SettingsEntry[], limit = 12): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const label = normalize(entry.label).split(' ');
    const kw = entry.keywords.flatMap((k) => normalize(k).split(' '));
    const desc = normalize(entry.description).split(' ');
    let total = 0;
    let ok = true;
    for (const t of tokens) {
      const s = Math.max(tokenScore(t, label) * 5, tokenScore(t, kw) * 3, tokenScore(t, desc));
      if (s === 0) { ok = false; break; }
      total += s;
    }
    if (!ok) continue;
    const full = normalize(entry.label);
    if (full === q) total += 60;
    else if (full.startsWith(q)) total += 25;
    else if (entry.keywords.some((k) => normalize(k) === q)) total += 30;
    hits.push({ entry, score: total, labelRanges: labelRanges(entry.label, tokens) });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return hits.slice(0, limit);
}
