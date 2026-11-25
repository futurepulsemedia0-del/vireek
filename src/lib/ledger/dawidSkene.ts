import { ACCURACY_PRIOR, CONFUSION_MIN_PER_CLASS, CONFUSION_PRIOR, MIN_N_RELIABILITY } from './constants';
import { makeRng } from './rng';
import { betaInterval } from './stats';

/**
 * Dawid–Skene-style EM: each technician is a noisy annotator of the TRUE root-cause class of a problem.
 *
 * Identifiability (read this): one annotation per item carries NO information about reliability, because "the
 * technician is right" and "the class is common" explain it equally well. The model is therefore FIT ONLY on
 * informative items = problems annotated by >= 2 distinct technicians (e.g. a repeat visit by another technician
 * for the same problem). Items with a single annotation get a posterior afterwards, using the fitted parameters.
 *
 * The delayed outcome is deliberately NOT a fitting input (it would make the later "do weights predict outcomes?"
 * test circular). It is used as an external validator, in validation.ts and scripts/ledger/evaluate.mjs.
 *
 * Models: 'one_coin' (one accuracy per annotator, errors uniform over the other K-1 classes) and 'confusion'
 * (full K x K matrix). 'auto' picks the confusion model only if EVERY annotator has >= CONFUSION_MIN_PER_CLASS * K
 * informative items; otherwise one_coin. MAP-EM with Beta / Dirichlet priors; the objective is tracked per iteration
 * and the run reports whether it was monotone (an EM invariant — a violation signals a bug or numeric trouble).
 */

export interface Annotation { item: string; annotator: string; cls: number }
export type DSModel = 'one_coin' | 'confusion';

export interface DSOptions {
  K: number;
  model?: DSModel | 'auto';
  maxIter?: number;
  tol?: number;
  seed?: number;
  minN?: number;
}

export interface AnnotatorFit {
  annotator: string;
  /** Items this annotator appears on (any). */
  n: number;
  /** Informative items this annotator appears on (the only ones that identify reliability). */
  nEff: number;
  state: 'ok' | 'insufficient';
  /** null when state === 'insufficient': a point estimate below the minimum n is never emitted. */
  accuracy: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** Row-stochastic K x K matrix [true][reported]; only for the confusion model and state 'ok'. */
  confusion: number[][] | null;
}

export interface DSFit {
  K: number;
  model: DSModel;
  converged: boolean;
  iterations: number;
  monotone: boolean;
  objective: number[];
  classPrior: number[];
  annotators: Map<string, AnnotatorFit>;
  /** Posterior over the true class, for EVERY item (informative or not). */
  posterior: Map<string, number[]>;
  informativeItems: number;
  totalItems: number;
}

const logSumExp = (a: readonly number[]): number => {
  let m = -Infinity;
  for (const v of a) if (v > m) m = v;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const v of a) s += Math.exp(v - m);
  return m + Math.log(s);
};

interface ItemRow { id: string; anns: { a: number; c: number }[] }

export function fitDawidSkene(annotations: readonly Annotation[], opt: DSOptions): DSFit {
  const K = opt.K;
  if (!Number.isInteger(K) || K < 2) throw new Error('K must be an integer >= 2');
  const maxIter = opt.maxIter ?? 200;
  const tol = opt.tol ?? 1e-9;
  const minN = opt.minN ?? MIN_N_RELIABILITY;
  const rng = makeRng(opt.seed ?? 1);

  // 1. Deduplicate (item, annotator): the first annotation wins (a repeat by the same technician is not independent).
  const seen = new Set<string>();
  const byItem = new Map<string, { annotator: string; cls: number }[]>();
  const allAnnotators = new Map<string, number>();
  for (const x of annotations) {
    if (!Number.isInteger(x.cls) || x.cls < 0 || x.cls >= K) throw new Error(`class out of range: ${x.cls}`);
    const key = `${x.item}\u0000${x.annotator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let arr = byItem.get(x.item);
    if (!arr) { arr = []; byItem.set(x.item, arr); }
    arr.push({ annotator: x.annotator, cls: x.cls });
    allAnnotators.set(x.annotator, (allAnnotators.get(x.annotator) ?? 0) + 1);
  }

  const annIdx = new Map<string, number>();
  const annNames: string[] = [];
  for (const name of [...allAnnotators.keys()].sort()) { annIdx.set(name, annNames.length); annNames.push(name); }
  const A = annNames.length;

  const rows: ItemRow[] = [];
  const informative: ItemRow[] = [];
  for (const id of [...byItem.keys()].sort()) {
    const r: ItemRow = { id, anns: (byItem.get(id) as { annotator: string; cls: number }[]).map((x) => ({ a: annIdx.get(x.annotator) as number, c: x.cls })) };
    rows.push(r);
    if (r.anns.length >= 2) informative.push(r);
  }

  const nEff = new Array<number>(A).fill(0);
  for (const r of informative) for (const x of r.anns) nEff[x.a] = (nEff[x.a] as number) + 1;

  // 2. Model choice.
  let model: DSModel = opt.model === 'confusion' ? 'confusion' : 'one_coin';
  if (opt.model === 'auto' || opt.model === undefined) {
    const fitted = nEff.filter((v) => v > 0);
    model = fitted.length > 0 && fitted.every((v) => v >= CONFUSION_MIN_PER_CLASS * K) ? 'confusion' : 'one_coin';
  }

  // 3. Parameters.
  let pi = new Array<number>(K).fill(1 / K);
  const acc = new Array<number>(A).fill(ACCURACY_PRIOR.correct / (ACCURACY_PRIOR.correct + ACCURACY_PRIOR.wrong));
  let conf: number[][][] = [];
  const identity = (): number[][] => Array.from({ length: K }, (_, k) => Array.from({ length: K }, (_, c) => (k === c ? 0.7 : 0.3 / (K - 1))));
  if (model === 'confusion') conf = Array.from({ length: A }, identity);

  const logLikItem = (r: ItemRow): number[] => {
    const lp = new Array<number>(K);
    for (let k = 0; k < K; k++) {
      let s = Math.log(pi[k] as number);
      for (const x of r.anns) {
        if (model === 'one_coin') {
          const a = acc[x.a] as number;
          s += x.c === k ? Math.log(a) : Math.log((1 - a) / (K - 1));
        } else {
          s += Math.log(((conf[x.a] as number[][])[k] as number[])[x.c] as number);
        }
      }
      lp[k] = s;
    }
    return lp;
  };

  const posteriorOf = (r: ItemRow): number[] => {
    const lp = logLikItem(r);
    const z = logSumExp(lp);
    return lp.map((v) => Math.exp(v - z));
  };

  const objective = (): number => {
    let ll = 0;
    for (const r of informative) ll += logSumExp(logLikItem(r));
    // log prior terms (unnormalised constants dropped; identical across iterations, so differences are exact)
    for (let k = 0; k < K; k++) ll += Math.log(pi[k] as number);
    if (model === 'one_coin') {
      for (let a = 0; a < A; a++) if ((nEff[a] as number) > 0) ll += ACCURACY_PRIOR.correct * Math.log(acc[a] as number) + ACCURACY_PRIOR.wrong * Math.log(1 - (acc[a] as number));
    } else {
      for (let a = 0; a < A; a++) for (let k = 0; k < K; k++) for (let c = 0; c < K; c++) {
        ll += (k === c ? CONFUSION_PRIOR.diagonal : CONFUSION_PRIOR.offDiagonal) * Math.log(((conf[a] as number[][])[k] as number[])[c] as number);
      }
    }
    return ll;
  };

  // 4. Initialise the posterior from vote counts with seeded jitter, then alternate M and E.
  let post: number[][] = informative.map((r) => {
    const cnt = new Array<number>(K).fill(0.01);
    for (const x of r.anns) cnt[x.c] = (cnt[x.c] as number) + 1;
    for (let k = 0; k < K; k++) cnt[k] = (cnt[k] as number) + 0.001 * rng.next();
    const s = cnt.reduce((p, v) => p + v, 0);
    return cnt.map((v) => v / s);
  });

  const objTrace: number[] = [];
  let converged = informative.length === 0;
  let monotone = true;
  let iterations = 0;

  const mStep = (): void => {
    const N = informative.length;
    pi = Array.from({ length: K }, (_, k) => {
      let s = 1; // Dirichlet(2) prior => +1 pseudo-count
      for (let i = 0; i < N; i++) s += (post[i] as number[])[k] as number;
      return s / (N + K);
    });
    if (model === 'one_coin') {
      const c = new Array<number>(A).fill(0);
      const n = new Array<number>(A).fill(0);
      informative.forEach((r, i) => { for (const x of r.anns) { c[x.a] = (c[x.a] as number) + ((post[i] as number[])[x.c] as number); n[x.a] = (n[x.a] as number) + 1; } });
      for (let a = 0; a < A; a++) acc[a] = ((c[a] as number) + ACCURACY_PRIOR.correct) / ((n[a] as number) + ACCURACY_PRIOR.correct + ACCURACY_PRIOR.wrong);
    } else {
      const cnt = Array.from({ length: A }, () => Array.from({ length: K }, (_, k) => Array.from({ length: K }, (_, c) => (k === c ? CONFUSION_PRIOR.diagonal : CONFUSION_PRIOR.offDiagonal))));
      informative.forEach((r, i) => { for (const x of r.anns) for (let k = 0; k < K; k++) { const row = (cnt[x.a] as number[][])[k] as number[]; row[x.c] = (row[x.c] as number) + ((post[i] as number[])[k] as number); } });
      conf = cnt.map((m) => m.map((row) => { const s = row.reduce((p, v) => p + v, 0); return row.map((v) => v / s); }));
    }
  };

  if (informative.length > 0) {
    for (iterations = 1; iterations <= maxIter; iterations++) {
      mStep();
      const o = objective();
      const prev = objTrace[objTrace.length - 1];
      if (prev !== undefined && o < prev - 1e-7 * (1 + Math.abs(prev))) monotone = false;
      objTrace.push(o);
      if (prev !== undefined && Math.abs(o - prev) <= tol * (1 + Math.abs(o))) { converged = true; break; }
      post = informative.map(posteriorOf);
    }
    iterations = Math.min(iterations, maxIter);
  }

  // 5. Final posteriors for every item (single-annotation items use the fitted parameters).
  const posterior = new Map<string, number[]>();
  for (const r of rows) posterior.set(r.id, informative.length === 0 ? new Array<number>(K).fill(1 / K) : posteriorOf(r));
  const postInf = new Map<string, number[]>();
  for (const r of informative) postInf.set(r.id, posterior.get(r.id) as number[]);

  // 6. Per-annotator report, with the minimum-n gate.
  const annotators = new Map<string, AnnotatorFit>();
  const correct = new Array<number>(A).fill(0);
  const latentVar = new Array<number>(A).fill(0);
  for (const r of informative) {
    const p = postInf.get(r.id) as number[];
    for (const x of r.anns) {
      const q = p[x.c] as number;
      correct[x.a] = (correct[x.a] as number) + q;
      latentVar[x.a] = (latentVar[x.a] as number) + q * (1 - q);
    }
  }
  for (let a = 0; a < A; a++) {
    const name = annNames[a] as string;
    const n = allAnnotators.get(name) as number;
    const ne = nEff[a] as number;
    if (ne < minN) {
      annotators.set(name, { annotator: name, n, nEff: ne, state: 'insufficient', accuracy: null, ciLow: null, ciHigh: null, confusion: null });
      continue;
    }
    const al = (correct[a] as number) + ACCURACY_PRIOR.correct;
    const be = ne - (correct[a] as number) + ACCURACY_PRIOR.wrong;
    // Counts are EXPECTED (posterior) counts, not observed ones. Add the uncertainty of the latent class itself:
    // sum of q(1-q) over this annotator's informative items, per n^2. Without it the interval is too narrow.
    const bi = betaInterval(al, be, 1.96, (latentVar[a] as number) / (ne * ne));
    annotators.set(name, { annotator: name, n, nEff: ne, state: 'ok', accuracy: bi.mean, ciLow: bi.lo, ciHigh: bi.hi, confusion: model === 'confusion' ? (conf[a] as number[][]).map((row) => row.slice()) : null });
  }

  return {
    K, model, converged, iterations, monotone, objective: objTrace, classPrior: pi.slice(), annotators, posterior,
    informativeItems: informative.length, totalItems: rows.length,
  };
}

export interface ReliabilityWeight {
  /** Probability the claim is right; null = insufficient data (never a guess). */
  weight: number | null;
  source: 'posterior' | 'annotator_accuracy' | 'insufficient';
  n: number;
}

/**
 * Reliability weight of ONE claim. Informative items (>= 2 annotators) use the item posterior; single-annotation
 * items fall back to the technician's accuracy, but only if that technician has enough informative data.
 * Otherwise the answer is 'insufficient' — never a guess.
 */
export function claimWeightFor(fit: DSFit, item: string, annotator: string, claimedCls: number, itemIsInformative: boolean): ReliabilityWeight {
  const a = fit.annotators.get(annotator);
  if (!a) return { weight: null, source: 'insufficient', n: 0 };
  if (a.state !== 'ok') return { weight: null, source: 'insufficient', n: a.nEff };
  if (itemIsInformative) {
    const post = fit.posterior.get(item);
    return post ? { weight: post[claimedCls] as number, source: 'posterior', n: a.nEff } : { weight: null, source: 'insufficient', n: a.nEff };
  }
  return { weight: a.accuracy, source: 'annotator_accuracy', n: a.nEff };
}
