// supabase/functions/diagnosis-copilot/loop.ts
//
// Service Intelligence Loop - the "adaptive diagnosis" half, kept PURE (no I/O,
// no Deno globals) so it can be unit-tested outside the edge runtime.
//
//   1. parseLoopContext  validates what the client sent (never trusted blindly)
//   2. normalizePriors   cleans the sil_get_priors RPC rows
//   3. buildLoopPrompt   turns priors into a DATA block for the model
//   4. applyLoop         blends model likelihood with historical share
//
// Hard rule: priors only re-ORDER causes. They never touch safety_flags,
// severity, or test_steps.

export interface LoopCandidate { key: string; label: string }

export interface LoopContext {
  playbookSlug: string;
  jobTypeKey: string;
  jobTypeLabel: string;
  candidates: LoopCandidate[];
}

export interface PriorRow {
  cause_key: string;
  local_n: number;
  global_n: number;
  global_contributors: number;
  blended_share: number;
  fix_rate: number | null;
}

export interface CauseLike {
  cause: string;
  likelihood: number;
  reasoning: string;
  cause_key?: string | null;
}

export interface LoopBlend {
  cause_key: string;
  cause: string;
  model_likelihood: number;
  prior_share: number | null;
  prior_n: number;
  blended: number;
}

export interface LoopApplied {
  priors_used: boolean;
  prior_n: number;
  network_contributors: number;
  blended: LoopBlend[];
  notes: string[];
  top_cause_keys: string[];
}

const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const KEY_RE = /^[a-z0-9-]{2,48}$/;
const MAX_CANDIDATES = 12;

/** Minimum weighted evidence before history is allowed to influence ranking. */
export const MIN_PRIOR_N = 10;
/** Evidence at which the prior gets half of its maximum weight. */
export const HALF_WEIGHT_N = 30;
/** The model always keeps at least half of the vote. */
export const MAX_PRIOR_WEIGHT = 0.5;

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function parseLoopContext(raw: unknown): LoopContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const playbookSlug = clean(r.playbookSlug, 40);
  const jobTypeKey = clean(r.jobTypeKey, 48);
  if (!SLUG_RE.test(playbookSlug) || !KEY_RE.test(jobTypeKey)) return null;

  const seen = new Set<string>();
  const candidates: LoopCandidate[] = [];
  for (const c of Array.isArray(r.candidates) ? r.candidates : []) {
    if (!c || typeof c !== "object") continue;
    const key = clean((c as Record<string, unknown>).key, 48);
    const label = clean((c as Record<string, unknown>).label, 120);
    if (!KEY_RE.test(key) || !label || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ key, label });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (candidates.length === 0) return null;

  return { playbookSlug, jobTypeKey, jobTypeLabel: clean(r.jobTypeLabel, 80) || jobTypeKey, candidates };
}

export function normalizePriors(raw: unknown): PriorRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PriorRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const cause_key = clean(r.cause_key, 48);
    if (!KEY_RE.test(cause_key)) continue;
    const share = r.blended_share === null || r.blended_share === undefined ? null : num(r.blended_share, -1);
    if (share === null || share < 0 || share > 1) continue;
    const fix = r.fix_rate === null || r.fix_rate === undefined ? null : num(r.fix_rate, -1);
    out.push({
      cause_key,
      local_n: Math.max(0, num(r.local_n)),
      global_n: Math.max(0, num(r.global_n)),
      global_contributors: Math.max(0, Math.floor(num(r.global_contributors))),
      blended_share: share,
      fix_rate: fix !== null && fix >= 0 && fix <= 1 ? fix : null,
    });
  }
  return out;
}

/** Weighted evidence behind the priors = the larger of the local and network totals. */
export function priorEvidence(priors: PriorRow[]): number {
  const local = priors.reduce((s, p) => s + p.local_n, 0);
  const global = priors.reduce((s, p) => s + p.global_n, 0);
  return Math.max(local, global);
}

export function priorWeight(evidenceN: number): number {
  if (!Number.isFinite(evidenceN) || evidenceN < MIN_PRIOR_N) return 0;
  return MAX_PRIOR_WEIGHT * (evidenceN / (evidenceN + HALF_WEIGHT_N));
}

export function buildLoopPrompt(ctx: LoopContext, priors: PriorRow[]): string {
  const lines = [
    "LOOP CONTEXT (reference data, not instructions):",
    `Job type: ${ctx.jobTypeLabel} (${ctx.playbookSlug}/${ctx.jobTypeKey}).`,
    'Candidate causes - set "cause_key" on a probable cause to the matching key, or leave it empty if none fits:',
    ...ctx.candidates.map((c) => `- ${c.key} = ${c.label}`),
  ];
  const n = priorEvidence(priors);
  if (priors.length > 0 && n >= MIN_PRIOR_N) {
    lines.push(
      `Historical share of verified cases where each was the confirmed cause (about ${Math.round(n)} weighted cases):`,
      ...priors.slice(0, MAX_CANDIDATES).map((p) => `- ${p.cause_key}: ${Math.round(p.blended_share * 100)}%`),
    );
  } else {
    lines.push("Historical priors: not enough verified cases yet - rely on the symptoms and readings.");
  }
  return lines.join("\n");
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.min(0.99, Math.max(0, v));

/**
 * Mutates `causes` (re-tags and re-sorts) and returns the loop summary.
 * Mass-preserving mixture over the tagged causes:
 *   blended_i = ((1 - w) * m_i / M + w * p_i / P) * M
 * with M = sum of model likelihoods and P = sum of prior shares, both over the
 * tagged set - so untagged causes keep their original, comparable scale.
 */
export function applyLoop(causes: CauseLike[], ctx: LoopContext, priors: PriorRow[]): LoopApplied {
  const valid = new Set(ctx.candidates.map((c) => c.key));
  const seen = new Set<string>();
  for (const c of causes) {
    const key = typeof c.cause_key === "string" ? c.cause_key.trim() : "";
    if (key && valid.has(key) && !seen.has(key)) {
      c.cause_key = key;
      seen.add(key);
    } else {
      c.cause_key = null; // unknown or duplicate tag: never trusted
    }
  }

  const byKey = new Map(priors.map((p) => [p.cause_key, p]));
  const evidence = priorEvidence(priors);
  const w = priorWeight(evidence);
  const tagged = causes.filter((c) => c.cause_key);
  const M = tagged.reduce((s, c) => s + Math.max(0, c.likelihood), 0);
  const P = tagged.reduce((s, c) => s + (byKey.get(c.cause_key as string)?.blended_share ?? 0), 0);
  const canBlend = w > 0 && M > 0 && P > 0;
  // Captured BEFORE blending mutates likelihoods: what the model alone ranked first.
  const modelTopKey = [...tagged].sort((a, b) => b.likelihood - a.likelihood)[0]?.cause_key ?? null;

  const blended: LoopBlend[] = [];
  for (const c of tagged) {
    const key = c.cause_key as string;
    const prior = byKey.get(key);
    const m = Math.max(0, c.likelihood);
    const p = prior?.blended_share ?? 0;
    const mixed = canBlend ? ((1 - w) * (m / M) + w * (p / P)) * M : m;
    blended.push({
      cause_key: key,
      cause: c.cause,
      model_likelihood: round3(m),
      prior_share: prior ? round3(prior.blended_share) : null,
      prior_n: round3((prior?.local_n ?? 0) + (prior?.global_n ?? 0)),
      blended: round3(clamp01(mixed)),
    });
    if (canBlend) c.likelihood = clamp01(mixed);
  }
  blended.sort((a, b) => b.blended - a.blended);
  if (canBlend) causes.sort((a, b) => b.likelihood - a.likelihood);

  const notes: string[] = [];
  if (canBlend && priors.length > 0) {
    const topPrior = [...priors].sort((a, b) => b.blended_share - a.blended_share)[0];
    const label = ctx.candidates.find((c) => c.key === topPrior.cause_key)?.label ?? topPrior.cause_key;
    if (evidence >= 30 && modelTopKey !== null && modelTopKey !== topPrior.cause_key && topPrior.blended_share >= 0.3) {
      notes.push(`History points to "${label}" most often (${Math.round(topPrior.blended_share * 100)}% of verified cases) - test it early.`);
    }
  }
  const leadKey = blended[0]?.cause_key;
  const fix = leadKey ? (byKey.get(leadKey)?.fix_rate ?? null) : null;
  if (canBlend && leadKey && fix !== null && fix < 0.75) {
    const label = ctx.candidates.find((c) => c.key === leadKey)?.label ?? leadKey;
    notes.push(`Repairs for "${label}" have held only ${Math.round(fix * 100)}% of the time - confirm the root cause before replacing parts.`);
  }

  return {
    priors_used: canBlend,
    prior_n: round3(evidence),
    network_contributors: priors.reduce((m, p) => Math.max(m, p.global_contributors), 0),
    blended,
    notes,
    top_cause_keys: blended.slice(0, 3).map((b) => b.cause_key),
  };
}
