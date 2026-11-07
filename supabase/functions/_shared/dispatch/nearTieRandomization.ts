// Near-tie randomization — PURE (no I/O). When the top eligible candidates are practically tied
// (within ε score points) the winner is drawn with a seeded hash instead of by id order, and the
// propensity is logged so the decision can be used as unbiased evidence.
//
// Hard guarantees (asserted in tests):
//   * Only candidates that ALREADY passed every hard rule (rankTechnicians().eligible) are considered.
//   * The chosen candidate's score is within ε of the best score (quality band by construction).
//   * Never randomizes VIP jobs, excluded/emergency-like service types, or when ETA differs by more than the limit
//     (or when any ETA is unknown — fail closed).
//   * Deterministic per (salt, job id): same input => same draw. Propensity of each tied candidate = 1 / |tie set|.

import type { RankedTechnician } from './rulesEngine.ts';

export interface RandomizationSettings {
  enabled: boolean;
  epsilon: number;
  top_k: number;
  max_eta_delta_minutes: number;
  excluded_service_types: string[];
  salt: string;
}

export const RANDOMIZATION_OFF: RandomizationSettings = { enabled: false, epsilon: 0, top_k: 2, max_eta_delta_minutes: 0, excluded_service_types: [], salt: '' };

/** No verified emergency column exists on jobs, so emergency-like service types are excluded by keyword (fail closed). */
export const EMERGENCY_PATTERN = /emergenc|urgent|no[\s-]?(heat|cool|ac|power|water)|burst|flood|gas\s*leak|leak/i;

const SLACK = 1e-9;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function normalizeSettings(row: unknown): RandomizationSettings {
  if (!row || typeof row !== 'object') return RANDOMIZATION_OFF;
  const r = row as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  if (r.enabled !== true || typeof r.salt !== 'string' || r.salt.length === 0) return RANDOMIZATION_OFF; // no salt => cannot draw reproducibly => off
  return {
    enabled: true,
    epsilon: clamp(num(r.epsilon, 0), 0, 10),
    top_k: Math.round(clamp(num(r.top_k, 2), 2, 5)),
    max_eta_delta_minutes: clamp(num(r.max_eta_delta_minutes, 10), 0, 120),
    excluded_service_types: Array.isArray(r.excluded_service_types) ? r.excluded_service_types.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toLowerCase()) : [],
    salt: r.salt,
  };
}

/** cyrb53 — 53-bit non-cryptographic hash, synchronous and identical in Deno, Node and browsers. */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export type SkipReason = 'disabled' | 'vip_job' | 'excluded_service' | 'fewer_than_two_tied' | 'eta_unknown' | 'eta_delta_exceeded';

export interface RandomizationPlan {
  applied: boolean;
  reason: SkipReason | 'drawn';
  epsilon: number;
  topK: number;
  maxEtaDeltaMinutes: number;
  /** Tie set, sorted by technician_id (canonical order used for the draw). */
  tieSet: { technician_id: string; score: number }[];
  drawnTechnicianId: string | null;
  /** 1 / tieSet.length when applied, otherwise null. */
  propensity: number | null;
  /** The raw 53-bit draw value (hex). Reproducible with the salt; does not reveal it. */
  seed: string | null;
}

export interface PlanInput {
  settings: RandomizationSettings;
  job: { id: string; service_type: string | null; is_vip: boolean };
  ranked: RankedTechnician[];
  /** Estimated travel minutes for a technician, or null when unknown. */
  etaMinutes: (technicianId: string) => number | null;
}

function skip(s: RandomizationSettings, reason: SkipReason, tieSet: RandomizationPlan['tieSet'] = []): RandomizationPlan {
  return { applied: false, reason, epsilon: s.epsilon, topK: s.top_k, maxEtaDeltaMinutes: s.max_eta_delta_minutes, tieSet, drawnTechnicianId: null, propensity: null, seed: null };
}

export function planRandomization(input: PlanInput): RandomizationPlan {
  const { settings: s, job, ranked } = input;
  if (!s.enabled) return skip(s, 'disabled');
  if (job.is_vip) return skip(s, 'vip_job');
  const svc = (job.service_type ?? '').trim().toLowerCase();
  if (svc && (EMERGENCY_PATTERN.test(svc) || s.excluded_service_types.includes(svc))) return skip(s, 'excluded_service');

  const eligible = ranked.filter((r) => r.eligible);
  if (eligible.length < 2) return skip(s, 'fewer_than_two_tied');
  const top = eligible.reduce((m, r) => Math.max(m, r.score), -Infinity);
  const tied = eligible.filter((r) => top - r.score <= s.epsilon + SLACK).slice(0, s.top_k);
  const tieSet = tied.map((r) => ({ technician_id: r.technician_id, score: r.score })).sort((a, b) => a.technician_id.localeCompare(b.technician_id));
  if (tieSet.length < 2) return skip(s, 'fewer_than_two_tied', tieSet);

  const etas = tieSet.map((t) => input.etaMinutes(t.technician_id));
  if (etas.some((e) => e === null || !Number.isFinite(e))) return skip(s, 'eta_unknown', tieSet);
  const known = etas as number[];
  if (Math.max(...known) - Math.min(...known) > s.max_eta_delta_minutes + SLACK) return skip(s, 'eta_delta_exceeded', tieSet);

  const draw = hash53(`${s.salt}:${job.id}`);
  const idx = draw % tieSet.length;
  return {
    applied: true, reason: 'drawn', epsilon: s.epsilon, topK: s.top_k, maxEtaDeltaMinutes: s.max_eta_delta_minutes,
    tieSet, drawnTechnicianId: tieSet[idx].technician_id, propensity: 1 / tieSet.length, seed: draw.toString(16),
  };
}

/**
 * Attempt order for the DB-gated assignment loop: the drawn technician, then the other tie members
 * (so a DB-gate block keeps the assignment inside the ε band whenever possible), then everyone else in engine order.
 */
export function attemptOrder<T extends { technician_id: string }>(eligibleInEngineOrder: T[], plan: RandomizationPlan): T[] {
  if (!plan.applied || !plan.drawnTechnicianId) return eligibleInEngineOrder;
  const tie = new Set(plan.tieSet.map((t) => t.technician_id));
  const drawn = eligibleInEngineOrder.filter((c) => c.technician_id === plan.drawnTechnicianId);
  if (drawn.length === 0) return eligibleInEngineOrder;
  const others = eligibleInEngineOrder.filter((c) => c.technician_id !== plan.drawnTechnicianId);
  return [...drawn, ...others.filter((c) => tie.has(c.technician_id)), ...others.filter((c) => !tie.has(c.technician_id))];
}

/** Value stored at dispatch_decisions.explanation.randomization (additive, versioned). */
export function buildRandomizationLog(plan: RandomizationPlan, executedTechnicianId: string | null) {
  return {
    version: 1,
    applied: plan.applied,
    reason: plan.reason,
    epsilon: plan.epsilon,
    top_k: plan.topK,
    max_eta_delta_minutes: plan.maxEtaDeltaMinutes,
    tie_set: plan.tieSet,
    propensity: plan.propensity,
    seed: plan.seed,
    drawn_technician_id: plan.drawnTechnicianId,
    executed_as_drawn: plan.applied ? executedTechnicianId === plan.drawnTechnicianId : null,
  };
}
