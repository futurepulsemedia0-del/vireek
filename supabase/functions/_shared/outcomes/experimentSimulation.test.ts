import { describe, it, expect } from 'vitest';
import { diffInDiff, diffProportions, naiveBeforeAfter } from './experiment';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function normal(r: () => number) { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---- Binary outcome, randomized holdout ----------------------------------
function holdoutTrial(r: () => number, p0: number, tau: number, nPerArm: number) {
  let kT = 0, kC = 0;
  for (let i = 0; i < nPerArm; i++) { if (r() < p0 + tau) kT++; if (r() < p0) kC++; }
  return diffProportions({ k: kT, n: nPerArm }, { k: kC, n: nPerArm });
}

// ---- Continuous outcome, confounded + seasonal ----------------------------
// Treated units have a HIGHER baseline (level confounding) and EVERY unit gets a
// seasonal lift in the post period. Only `tau` is the true causal effect.
function didTrial(r: () => number, tau: number, season: number, n = 60) {
  const unit = (base: number) => base + 8 * normal(r);
  const tUnits = Array.from({ length: n }, () => unit(100));
  const cUnits = Array.from({ length: n }, () => unit(80));
  const obs = (u: number, shift: number) => u + shift + 10 * normal(r);
  const treatedPre = tUnits.map((u) => obs(u, 0));
  const treatedPost = tUnits.map((u) => obs(u, season + tau));
  const controlPre = cUnits.map((u) => obs(u, 0));
  const controlPost = cUnits.map((u) => obs(u, season));
  return { treatedPre, treatedPost, controlPre, controlPost };
}

describe('randomized holdout (binary outcome)', () => {
  it('false-positive rate under zero effect is near/below nominal 5%', () => {
    const r = rng(101); const T = 3000; let fp = 0;
    for (let i = 0; i < T; i++) if (holdoutTrial(r, 0.3, 0, 200).significant) fp++;
    const rate = fp / T;
    console.log(`[sim] holdout zero-effect false-positive rate = ${(rate * 100).toFixed(2)}% over ${T} trials`);
    expect(rate).toBeLessThan(0.075);
  });
  it('recovers a true +10pt effect with low bias and ~nominal coverage', () => {
    const r = rng(102); const T = 2000; const est: number[] = []; let cover = 0; let sig = 0;
    for (let i = 0; i < T; i++) {
      const e = holdoutTrial(r, 0.3, 0.1, 400);
      est.push(e.effect!); if (e.lower! <= 0.1 && 0.1 <= e.upper!) cover++; if (e.significant) sig++;
    }
    const bias = mean(est) - 0.1;
    console.log(`[sim] holdout tau=0.10 n=400/arm: bias=${bias.toFixed(4)} coverage=${(cover / T * 100).toFixed(1)}% power=${(sig / T * 100).toFixed(1)}%`);
    expect(Math.abs(bias)).toBeLessThan(0.005);
    expect(cover / T).toBeGreaterThan(0.93);
    expect(sig / T).toBeGreaterThan(0.8);
  });
  it('suppresses results below minimum n', () => {
    const e = holdoutTrial(rng(5), 0.3, 0.2, 29);
    expect(e.suppressed).toBe(true);
    expect(e.effect).toBeNull();
    expect(e.significant).toBe(false);
  });
});

describe('difference-in-differences vs the legacy before/after method', () => {
  it('zero true effect: DiD reports no effect (FPR <= nominal) while naive before/after almost always claims one', () => {
    const r = rng(201); const T = 1500; let didFp = 0, naiveFp = 0; const didEst: number[] = [], naiveEst: number[] = [];
    for (let i = 0; i < T; i++) {
      const d = didTrial(r, 0, 15);
      const a = diffInDiff(d), b = naiveBeforeAfter(d.treatedPre, d.treatedPost);
      if (a.significant) didFp++; if (b.significant) naiveFp++;
      didEst.push(a.effect!); naiveEst.push(b.effect!);
    }
    console.log(`[sim] confounded+seasonal tau=0: DiD FPR=${(didFp / T * 100).toFixed(2)}% mean=${mean(didEst).toFixed(2)} | naive FPR=${(naiveFp / T * 100).toFixed(1)}% mean=${mean(naiveEst).toFixed(2)} (truth 0)`);
    expect(didFp / T).toBeLessThan(0.075);
    expect(Math.abs(mean(didEst))).toBeLessThan(0.5);
    expect(naiveFp / T).toBeGreaterThan(0.95);
    expect(mean(naiveEst)).toBeGreaterThan(10);
  });
  it('true effect +8: DiD recovers it within 0.5 with ~nominal coverage; naive is biased by the season', () => {
    const r = rng(202); const T = 1500; const didEst: number[] = [], naiveEst: number[] = []; let cover = 0;
    for (let i = 0; i < T; i++) {
      const d = didTrial(r, 8, 15);
      const a = diffInDiff(d); didEst.push(a.effect!); naiveEst.push(naiveBeforeAfter(d.treatedPre, d.treatedPost).effect!);
      if (a.lower! <= 8 && 8 <= a.upper!) cover++;
    }
    const sd = Math.sqrt(didEst.reduce((s, x) => s + (x - mean(didEst)) ** 2, 0) / (T - 1));
    console.log(`[sim] confounded+seasonal tau=8: DiD bias=${(mean(didEst) - 8).toFixed(3)} sd=${sd.toFixed(2)} coverage=${(cover / T * 100).toFixed(1)}% | naive bias=${(mean(naiveEst) - 8).toFixed(2)}`);
    expect(Math.abs(mean(didEst) - 8)).toBeLessThan(0.5);
    expect(cover / T).toBeGreaterThan(0.93);
    expect(mean(naiveEst) - 8).toBeGreaterThan(5);
  });
  it('legacy numbers are always labelled unadjusted; DiD is labelled adjusted', () => {
    const d = didTrial(rng(3), 0, 15);
    expect(naiveBeforeAfter(d.treatedPre, d.treatedPost).label).toBe('unadjusted');
    expect(diffInDiff(d).label).toBe('adjusted');
  });
  it('suppresses when any cell is below minimum n or contains NaN', () => {
    const d = didTrial(rng(4), 0, 15, 20);
    expect(diffInDiff(d).suppressed).toBe(true);
    const e = didTrial(rng(5), 0, 15, 40); e.controlPost[0] = NaN;
    expect(diffInDiff(e).suppressed).toBe(true);
  });
  it('replay: the same fixed stream twice gives identical estimates (idempotent)', () => {
    const a = diffInDiff(didTrial(rng(77), 4, 10)), b = diffInDiff(didTrial(rng(77), 4, 10));
    expect(a).toEqual(b);
  });
});
