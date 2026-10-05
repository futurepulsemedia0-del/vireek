// src/lib/serviceIntelligenceLoop.ts
//
// VIREEK Service Intelligence Loop - types and PURE helpers (no I/O).
//
//   CALL -> SYMPTOM -> ADAPTIVE DIAGNOSIS -> TECHNICIAN ACTION -> PART / REPAIR
//        -> VERIFIED OUTCOME -> GLOBAL LEARNING -> BETTER NEXT DIAGNOSIS
//
// The controlled vocabulary is the existing trade playbook catalog
// (playbook slug -> job type key -> troubleshooting cause keys), so every
// tenant's outcomes are already comparable. Network calls live in
// serviceIntelligenceLoopApi.ts.

import { TRADE_PLAYBOOKS } from '@/lib/tradePlaybookCatalog';

/* ------------------------------------------------------------------ */
/* Types shared with the diagnosis-copilot edge function response      */
/* ------------------------------------------------------------------ */

export interface LoopCandidateCause {
  key: string;
  label: string;
}

/** Sent to diagnosis-copilot so the model can tag causes with catalog keys. */
export interface LoopContextInput {
  playbookSlug: string;
  jobTypeKey: string;
  jobTypeLabel: string;
  candidates: LoopCandidateCause[];
}

export interface LoopCauseBlend {
  cause_key: string;
  cause: string;
  model_likelihood: number;
  prior_share: number | null;
  prior_n: number;
  blended: number;
}

export interface DiagnosisLoopSummary {
  case_id: string | null;
  playbook_slug: string;
  job_type_key: string;
  priors_used: boolean;
  /** Weighted number of past cases behind the strongest prior (0 = cold start). */
  prior_n: number;
  /** Distinct tenants behind the network prior; 0 when only local data was used. */
  network_contributors: number;
  blended: LoopCauseBlend[];
  notes: string[];
}

export interface LoopMetrics {
  own: {
    outcomes: number;
    with_cause: number;
    verified: number;
    pending: number;
    refuted: number;
    first_visit_fixed: number;
    callbacks: number;
  };
  predictions: {
    cases: number;
    scored: number;
    top1: number;
    top3: number;
    with_priors_scored: number;
    with_priors_top1: number;
    without_priors_scored: number;
    without_priors_top1: number;
  };
  network: { job_types: number; cases: number; verified: number; max_contributors: number };
  sharing: boolean;
}

export interface LoopPriorRow {
  cause_key: string;
  local_n: number | null;
  local_share: number | null;
  global_n: number | null;
  global_share: number | null;
  global_contributors: number | null;
  blended_share: number | null;
  fix_rate: number | null;
}

/* ------------------------------------------------------------------ */
/* Vocabulary resolution                                               */
/* ------------------------------------------------------------------ */

export const MAX_LOOP_CANDIDATES = 12;

/**
 * Maps a job's free-text service_type to (playbook, job type) across ALL
 * playbooks - the longest matching fragment wins, so "water heater leak"
 * resolves to plumbing/water-heater and not hvac/furnace ("heater").
 * Returns null when nothing matches or the job type has no cause list.
 */
export function resolveLoopContext(serviceType: string | null | undefined): LoopContextInput | null {
  const text = ` ${(serviceType ?? '').toLowerCase()} `;
  if (text.trim() === '') return null;

  let best: { slug: string; key: string; len: number } | null = null;
  for (const pb of TRADE_PLAYBOOKS) {
    for (const jt of pb.jobTypes) {
      for (const fragment of jt.match) {
        if (text.includes(fragment) && (!best || fragment.length > best.len)) {
          best = { slug: pb.slug, key: jt.key, len: fragment.length };
        }
      }
    }
  }
  return best ? loopContextFor(best.slug, best.key) : null;
}

export function loopContextFor(playbookSlug: string, jobTypeKey: string): LoopContextInput | null {
  const pb = TRADE_PLAYBOOKS.find((p) => p.slug === playbookSlug);
  const jt = pb?.jobTypes.find((j) => j.key === jobTypeKey);
  const causes = jt?.troubleshooting?.causes ?? [];
  if (!pb || !jt || causes.length === 0) return null;
  return {
    playbookSlug: pb.slug,
    jobTypeKey: jt.key,
    jobTypeLabel: jt.label,
    candidates: causes.slice(0, MAX_LOOP_CANDIDATES).map((c) => ({ key: c.key, label: c.label })),
  };
}

/** Every (playbook, job type) that has a cause list - used by the manual picker. */
export function listLoopContexts(): LoopContextInput[] {
  const out: LoopContextInput[] = [];
  for (const pb of TRADE_PLAYBOOKS) {
    for (const jt of pb.jobTypes) {
      const ctx = loopContextFor(pb.slug, jt.key);
      if (ctx) out.push(ctx);
    }
  }
  return out;
}

export function causeLabel(playbookSlug: string, jobTypeKey: string, causeKey: string): string {
  const pb = TRADE_PLAYBOOKS.find((p) => p.slug === playbookSlug);
  const jt = pb?.jobTypes.find((j) => j.key === jobTypeKey);
  return jt?.troubleshooting?.causes.find((c) => c.key === causeKey)?.label ?? causeKey;
}

/* ------------------------------------------------------------------ */
/* Scale ladder: 100 -> 1,000 -> ... -> 1,000,000 jobs                  */
/* ------------------------------------------------------------------ */

export const LOOP_MILESTONES = [100, 1_000, 10_000, 100_000, 1_000_000] as const;

export interface MilestoneProgress {
  reached: number | null;
  next: number | null;
  /** 0..100 progress between the previous milestone (or 0) and `next`. */
  pct: number;
}

export function milestoneProgress(count: number): MilestoneProgress {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  let reached: number | null = null;
  for (const m of LOOP_MILESTONES) if (n >= m) reached = m;
  const next = LOOP_MILESTONES.find((m) => n < m) ?? null;
  if (next === null) return { reached, next, pct: 100 };
  const floor = reached ?? 0;
  const pct = Math.round(((n - floor) / (next - floor)) * 100);
  return { reached, next, pct: Math.min(100, Math.max(0, pct)) };
}

export function formatMilestone(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

/* ------------------------------------------------------------------ */
/* Evidence strength + accuracy                                        */
/* ------------------------------------------------------------------ */

export type EvidenceLevel = 'cold' | 'learning' | 'reliable' | 'proven';

/** How much weighted evidence sits behind a prior. Thresholds are deliberately conservative. */
export function evidenceLevel(priorN: number): EvidenceLevel {
  if (!Number.isFinite(priorN) || priorN < 10) return 'cold';
  if (priorN < 30) return 'learning';
  if (priorN < 100) return 'reliable';
  return 'proven';
}

export const EVIDENCE_META: Record<EvidenceLevel, { label: string; className: string }> = {
  cold: { label: 'Cold start - model only', className: 'text-text-secondary' },
  learning: { label: 'Learning', className: 'text-warning-500' },
  reliable: { label: 'Reliable', className: 'text-accent' },
  proven: { label: 'Proven', className: 'text-success-500' },
};

/** null when there is nothing to score yet - never show a fake 0%. */
export function pct(hits: number, total: number): number | null {
  if (!Number.isFinite(hits) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((Math.min(hits, total) / total) * 100);
}

/**
 * Percentage-point lift of diagnoses that used priors vs. those that did not.
 * Needs at least `minEach` scored cases on both sides, otherwise null: an honest
 * "not enough data yet" beats a noisy number.
 */
export function priorLift(m: LoopMetrics['predictions'], minEach = 10): number | null {
  if (m.with_priors_scored < minEach || m.without_priors_scored < minEach) return null;
  const a = pct(m.with_priors_top1, m.with_priors_scored);
  const b = pct(m.without_priors_top1, m.without_priors_scored);
  return a === null || b === null ? null : a - b;
}

export function verifiedShare(own: LoopMetrics['own']): number | null {
  return pct(own.verified, own.outcomes);
}

/* ------------------------------------------------------------------ */
/* The seven stages (UI + docs share one definition)                   */
/* ------------------------------------------------------------------ */

export interface LoopStage {
  id: 'call' | 'symptom' | 'diagnosis' | 'action' | 'repair' | 'outcome' | 'learning';
  label: string;
  detail: string;
}

export const LOOP_STAGES: LoopStage[] = [
  { id: 'call', label: 'Call', detail: 'A customer reports a problem' },
  { id: 'symptom', label: 'Symptom', detail: 'Mapped to a trade + job type' },
  { id: 'diagnosis', label: 'Adaptive diagnosis', detail: 'AI ranks causes using your history and the network' },
  { id: 'action', label: 'Technician action', detail: 'Tests run, checklist completed' },
  { id: 'repair', label: 'Part / repair', detail: 'Confirmed cause and parts used' },
  { id: 'outcome', label: 'Verified outcome', detail: 'Fix holds with no callback in 30 days' },
  { id: 'learning', label: 'Global learning', detail: 'Anonymous statistics improve every next diagnosis' },
];

export const VERIFICATION_STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: 'Verifying', className: 'bg-warning-500/10 text-warning-500' },
  verified: { label: 'Verified', className: 'bg-success-500/10 text-success-500' },
  refuted: { label: 'Callback', className: 'bg-danger/10 text-danger' },
  inconclusive: { label: 'Inconclusive', className: 'bg-bg-primary text-text-secondary' },
};
