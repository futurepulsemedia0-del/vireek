// supabase/functions/_shared/adaptive-diagnostic/engine.ts
//
// Vireek Adaptive Customer Diagnostic — pure decision engine (no I/O, no imports).
//
// A Bayesian diagnostic tree that is never written down: after every answer the posterior over
// hypotheses is recomputed and the next question is whichever one is expected to remove the most
// uncertainty per unit of customer effort. Likelihoods are learned from confirmed job outcomes
// (see diag_confirm_outcome in the migration), so the "tree" rewrites itself with every job.
//
// Deterministic by design: same inputs -> same next question (exploration uses a seeded hash).

export const UNSURE = "unsure";
export const MAX_QUESTIONS = 12;
export const CONFIDENT_TOP = 0.85;
export const CONFIDENT_MARGIN = 0.3;
export const MIN_GAIN_BITS = 0.04;
/** Pseudo-count of the expert prior: how many real observations it takes to outweigh the seed. */
export const SEED_STRENGTH = 6;
export const PRIOR_STRENGTH = 20;
const EPS = 1e-6;

export interface DiagOption { id: string; label: string }
export interface DiagQuestion {
  code: string;
  text: string;
  help?: string | null;
  /** 1 = tap an answer, 2 = look at something, 3 = go and check/measure something. */
  effort: number;
  options: DiagOption[];
  status: "active" | "low_value" | "retired";
}
export interface DiagHypothesis { code: string; label: string; prior: number; safety: "none" | "caution" | "hazard" }

/** hypothesis -> question -> P(answer option | hypothesis), aligned with question.options order. */
export type Likelihoods = Record<string, Record<string, number[]>>;
/** Learned counts for this account: hypothesis -> question -> counts per option. */
export type ObsCounts = Record<string, Record<string, number[]>>;
export interface AnswerRec { q: string; a: string }
export type Posterior = Record<string, number>;

export function normalize(p: Posterior): Posterior {
  const keys = Object.keys(p);
  let sum = 0;
  for (const k of keys) sum += p[k];
  const out: Posterior = {};
  if (!(sum > 0)) {
    for (const k of keys) out[k] = 1 / keys.length;
    return out;
  }
  for (const k of keys) out[k] = p[k] / sum;
  return out;
}

export function entropyBits(p: Posterior): number {
  let h = 0;
  for (const k in p) if (p[k] > 0) h -= p[k] * Math.log2(p[k]);
  return h;
}

/** Blend the expert seed with this account's observed counts (Dirichlet smoothing). */
export function blendLikelihoods(seed: Likelihoods, obs: ObsCounts, questions: DiagQuestion[]): Likelihoods {
  const out: Likelihoods = {};
  for (const h of Object.keys(seed)) {
    out[h] = {};
    for (const q of questions) {
      const k = q.options.length;
      const s = seed[h]?.[q.code];
      const base = s && s.length === k ? s : new Array<number>(k).fill(1 / k);
      const c = obs[h]?.[q.code];
      const counts = c && c.length === k ? c : new Array<number>(k).fill(0);
      const n = counts.reduce((a, b) => a + b, 0);
      out[h][q.code] = base.map((p, i) => (counts[i] + SEED_STRENGTH * p) / (n + SEED_STRENGTH));
    }
  }
  return out;
}

export function blendPriors(hyps: DiagHypothesis[], counts: Record<string, number>): Posterior {
  const total = hyps.reduce((a, h) => a + (counts[h.code] ?? 0), 0);
  const p: Posterior = {};
  for (const h of hyps) p[h.code] = ((counts[h.code] ?? 0) + PRIOR_STRENGTH * h.prior) / (total + PRIOR_STRENGTH);
  return normalize(p);
}

function optionIndex(q: DiagQuestion, answerId: string): number {
  return q.options.findIndex((o) => o.id === answerId);
}

/** Posterior after applying one answer. "Not sure" carries no information. */
export function applyAnswer(post: Posterior, lik: Likelihoods, q: DiagQuestion, answerId: string): Posterior {
  if (answerId === UNSURE) return post;
  const idx = optionIndex(q, answerId);
  if (idx < 0) return post;
  const next: Posterior = {};
  for (const h of Object.keys(post)) next[h] = post[h] * Math.max(lik[h]?.[q.code]?.[idx] ?? 1 / q.options.length, EPS);
  return normalize(next);
}

export function computePosterior(
  prior: Posterior,
  lik: Likelihoods,
  questions: Map<string, DiagQuestion>,
  answers: AnswerRec[],
): Posterior {
  let post = prior;
  for (const a of answers) {
    const q = questions.get(a.q);
    if (q) post = applyAnswer(post, lik, q, a.a);
  }
  return post;
}

/** Expected information gain (bits) of asking `q` given the current posterior. */
export function expectedGainBits(post: Posterior, lik: Likelihoods, q: DiagQuestion): number {
  const h0 = entropyBits(post);
  let expected = 0;
  for (let i = 0; i < q.options.length; i++) {
    let pa = 0;
    for (const h of Object.keys(post)) pa += post[h] * (lik[h]?.[q.code]?.[i] ?? 1 / q.options.length);
    if (pa <= EPS) continue;
    const next: Posterior = {};
    for (const h of Object.keys(post)) next[h] = (post[h] * (lik[h]?.[q.code]?.[i] ?? 1 / q.options.length)) / pa;
    expected += pa * entropyBits(next);
  }
  return Math.max(0, h0 - expected);
}

export function topTwo(post: Posterior): { top: string; p1: number; p2: number } {
  const sorted = Object.entries(post).sort((a, b) => b[1] - a[1]);
  return { top: sorted[0]?.[0] ?? "", p1: sorted[0]?.[1] ?? 0, p2: sorted[1]?.[1] ?? 0 };
}

export type StopReason = "confident" | "max_questions" | "no_informative_question";

export interface NextStep {
  question: DiagQuestion | null;
  stop: StopReason | null;
  gainBits: number | null;
}

/** Cheap deterministic hash in [0,1) — makes exploration reproducible and testable. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export interface PickOptions {
  /** How many confirmed jobs have asked each question (drives exploration). */
  askedCounts?: Record<string, number>;
  /** Stable per-session seed. */
  seed?: string;
  explorationRate?: number;
}

/**
 * Chooses the next question: highest (information gain / effort), plus a decaying exploration
 * bonus for questions with little evidence so the system keeps learning what each question is worth.
 */
export function pickNext(
  post: Posterior,
  lik: Likelihoods,
  questions: DiagQuestion[],
  answered: Set<string>,
  opts: PickOptions = {},
): NextStep {
  const { p1, p2 } = topTwo(post);
  if (answered.size > 0 && p1 >= CONFIDENT_TOP && p1 - p2 >= CONFIDENT_MARGIN) return { question: null, stop: "confident", gainBits: null };
  if (answered.size >= MAX_QUESTIONS) return { question: null, stop: "max_questions", gainBits: null };

  const rate = opts.explorationRate ?? 0.08;
  let best: { q: DiagQuestion; score: number; gain: number } | null = null;
  for (const q of questions) {
    if (answered.has(q.code) || q.status === "retired") continue;
    if (q.status === "low_value" && answered.size < 3) continue;
    const gain = expectedGainBits(post, lik, q);
    if (gain < MIN_GAIN_BITS) continue;
    const n = opts.askedCounts?.[q.code] ?? 0;
    const bonus = rate * gain * (1 / Math.sqrt(1 + n)) * (0.5 + hash01(`${opts.seed ?? ""}:${q.code}`));
    const score = (gain + bonus) / Math.max(1, q.effort);
    if (!best || score > best.score || (score === best.score && q.code < best.q.code)) best = { q, score, gain };
  }
  if (!best) return { question: null, stop: "no_informative_question", gainBits: null };
  return { question: best.q, stop: null, gainBits: best.gain };
}

/** Rounded posterior for storage/UI: top N hypotheses with percentages. */
export function summarize(post: Posterior, n = 5): { code: string; p: number }[] {
  return Object.entries(post)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([code, p]) => ({ code, p: Math.round(p * 1000) / 1000 }));
}

// ---------------------------------------------------------------------------------------------
// Safety — deterministic and independent of the model. Runs on every free-text input.
// ---------------------------------------------------------------------------------------------

const HAZARD_PATTERNS: RegExp[] = [
  /\b(smell|smells|smelling|odor)\b.{0,20}\bgas\b|\bgas\b.{0,20}\b(smell|leak|odor)\b|rotten egg/i,
  /\bcarbon monoxide\b|\bco (alarm|detector)\b/i,
  /\b(burning|smoke|smoking)\b.{0,25}\b(smell|unit|wire|wiring|outlet|panel|furnace)\b|\bsmell\b.{0,15}\bburning\b/i,
  /\b(spark|sparking|sparks|arcing|electrical fire|on fire)\b/i,
  /\bwater\b.{0,25}\b(outlet|electrical panel|breaker)\b/i,
  /\b(flooding|flooded|burst pipe)\b/i,
];

export function detectHazard(text: string): boolean {
  const t = text.slice(0, 2000);
  return HAZARD_PATTERNS.some((re) => re.test(t));
}

/** Rough complaint-domain classifier from job type + customer text. Returns null when unsure. */
export function classifyDomain(text: string, domains: { code: string; keywords: string[] }[]): string | null {
  const t = text.toLowerCase();
  let best: { code: string; score: number } | null = null;
  for (const d of domains) {
    const score = d.keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { code: d.code, score };
  }
  return best?.code ?? null;
}

/** Realized value of one question in one confirmed job: change in probability of the true diagnosis. */
export function realizedGain(before: Posterior, after: Posterior, truth: string): number {
  return (after[truth] ?? 0) - (before[truth] ?? 0);
}
