// supabase/functions/_shared/interpreter/score.ts
//
// Evaluation metrics. Pure, dependency-free.
//  wer   word error rate (character error rate for space-less scripts)
//  chrf  character n-gram F-score (chrF, beta=2) 0..1 — a standard MT metric that needs no model
//  fieldAccuracy  exact-match accuracy of critical fields

import type { CriticalEntity } from "./critical.ts";

function edit(a: string[], b: string[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[.,!?;:¿¡。！？、،؛]/g, " ").replace(/\s+/g, " ").trim();

export function wer(reference: string, hypothesis: string, noSpaces = false): number {
  const r = norm(reference);
  const h = norm(hypothesis);
  const ra = noSpaces ? [...r.replace(/\s/g, "")] : r.split(" ").filter(Boolean);
  const ha = noSpaces ? [...h.replace(/\s/g, "")] : h.split(" ").filter(Boolean);
  if (!ra.length) return ha.length ? 1 : 0;
  return edit(ra, ha) / ra.length;
}

export function chrf(reference: string, hypothesis: string, maxN = 6, beta = 2): number {
  const r = norm(reference).replace(/\s/g, "");
  const h = norm(hypothesis).replace(/\s/g, "");
  if (!r || !h) return r === h ? 1 : 0;
  let pSum = 0, rSum = 0, used = 0;
  for (let n = 1; n <= maxN; n++) {
    if (r.length < n || h.length < n) break;
    const grams = (s: string) => {
      const m = new Map<string, number>();
      for (let i = 0; i + n <= s.length; i++) m.set(s.slice(i, i + n), (m.get(s.slice(i, i + n)) ?? 0) + 1);
      return m;
    };
    const rg = grams(r), hg = grams(h);
    let match = 0, hTot = 0, rTot = 0;
    for (const v of hg.values()) hTot += v;
    for (const v of rg.values()) rTot += v;
    for (const [g, c] of hg) match += Math.min(c, rg.get(g) ?? 0);
    pSum += match / hTot;
    rSum += match / rTot;
    used++;
  }
  if (!used) return 0;
  const p = pSum / used, rc = rSum / used;
  return p + rc === 0 ? 0 : ((1 + beta * beta) * p * rc) / (beta * beta * p + rc);
}

export function fieldAccuracy(expected: CriticalEntity[], actual: CriticalEntity[]): { correct: number; total: number } {
  const pool = actual.map((e) => `${e.kind}|${e.value}`);
  let correct = 0;
  for (const e of expected) {
    const k = `${e.kind}|${e.value}`;
    const i = pool.indexOf(k);
    if (i >= 0) { correct++; pool.splice(i, 1); }
  }
  return { correct, total: expected.length };
}
