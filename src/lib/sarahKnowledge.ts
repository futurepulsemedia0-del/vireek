// Pure "what does Sarah know about this business?" model (no React, no network).
//
// It turns the rows Sarah already stores (sarah_learn_runs / sarah_learn_fields)
// into ONE trustworthy picture the dashboard can show: a 0-100 knowledge score,
// per-group coverage, the highest-impact gaps, and the single next best action.
//
// Rules mirror the server, they never relax it:
//   * the field catalogue and the required keys come from the same schema module
//     the edge functions validate with (schema.ts);
//   * go-live still needs the required keys approved and no sensitive field left
//     pending (enforced in sarah_learn_go_live) - this module only REPORTS that.

import { FIELD_BY_KEY, REQUIRED_KEYS, type FieldGroup } from '../../supabase/functions/_shared/sarah-learn/schema.ts';
import type { LearnField, LearnRun } from '@/pages/onboarding/sarah/sarahLearnLogic';

export type KnowledgeStage = 'not_started' | 'learning' | 'review' | 'ready_to_test' | 'live';
export type KnowledgeTier = 'new' | 'learning' | 'confident' | 'expert';
export type GapReason = 'missing' | 'unconfirmed' | 'sensitive_pending';
export type NextActionKind = 'start' | 'answer' | 'review' | 'test' | 'go_live' | 'maintain';

/** How much each fact matters to answering a real customer call correctly (relative weights). */
export const FIELD_WEIGHTS: Readonly<Record<string, number>> = {
  business_name: 8,
  trade: 3,
  languages: 2,
  services_offered: 14,
  services_not_offered: 3,
  never_book: 6,
  differentiators: 4,
  service_area: 12,
  service_area_notes: 2,
  hours: 10,
  holiday_hours: 2,
  emergency_policy: 10,
  pricing_signals: 6,
  diagnostic_fee: 6,
  financing: 2,
  licenses_insurance: 4,
  warranties: 3,
  escalation_contact: 8,
  brand_pronunciation: 3,
  team_names: 2,
  tone_samples: 2,
  tone_preference: 4,
  faqs: 6,
};

const PENDING_CREDIT = { high: 0.6, medium: 0.4, low: 0.2 } as const;
const ASSUMED_FACTOR = 0.5;

/** 1 = owner-confirmed, partial = drafted but not yet confirmed, 0 = unknown / rejected. */
export function creditFor(field: Pick<LearnField, 'status' | 'confidence' | 'assumed'> | undefined): number {
  if (!field) return 0;
  if (field.status === 'rejected') return 0;
  if (field.status === 'approved' || field.status === 'edited') return 1;
  const base = PENDING_CREDIT[field.confidence] ?? 0.2;
  return field.assumed ? base * ASSUMED_FACTOR : base;
}

export interface GroupCoverage {
  group: FieldGroup;
  /** 0-100 */
  score: number;
  known: number;
  total: number;
}

export interface KnowledgeGap {
  key: string;
  group: FieldGroup;
  weight: number;
  /** weight * (1 - credit): how much knowing this would raise the score. */
  impact: number;
  reason: GapReason;
}

export interface KnowledgeSnapshot {
  stage: KnowledgeStage;
  /** Integer 0-100. */
  score: number;
  tier: KnowledgeTier;
  groups: GroupCoverage[];
  /** Highest impact first, deterministic order. */
  gaps: KnowledgeGap[];
  requiredMissing: string[];
  sensitivePending: number;
  pendingReview: number;
  next: NextActionKind;
}

const GROUP_ORDER: readonly FieldGroup[] = ['basics', 'services', 'hours_area', 'pricing', 'trust', 'voice', 'faq'];

export function tierFor(score: number): KnowledgeTier {
  if (score >= 90) return 'expert';
  if (score >= 70) return 'confident';
  if (score >= 35) return 'learning';
  return 'new';
}

export function stageFor(run: Pick<LearnRun, 'status' | 'readiness_passed' | 'test_call_confirmed_at'> | null): KnowledgeStage {
  if (!run || run.status === 'failed') return 'not_started';
  if (run.status === 'live') return 'live';
  if (run.status === 'review') return 'review';
  if (run.status === 'readiness' || run.status === 'ready') return 'ready_to_test';
  return 'learning';
}

export function computeKnowledge(run: LearnRun | null, fields: readonly LearnField[]): KnowledgeSnapshot {
  const stage = stageFor(run);
  const byKey = new Map(fields.map((f) => [f.key, f]));

  let earned = 0;
  let total = 0;
  const gaps: KnowledgeGap[] = [];
  const groupAcc = new Map<FieldGroup, { earned: number; total: number; known: number; count: number }>();

  for (const [key, weight] of Object.entries(FIELD_WEIGHTS)) {
    const def = FIELD_BY_KEY.get(key);
    if (!def || weight <= 0) continue;
    const field = byKey.get(key);
    const credit = creditFor(field);
    earned += weight * credit;
    total += weight;

    const g = groupAcc.get(def.group) ?? { earned: 0, total: 0, known: 0, count: 0 };
    g.earned += weight * credit;
    g.total += weight;
    g.count += 1;
    if (credit >= 1) g.known += 1;
    groupAcc.set(def.group, g);

    if (credit < 1) {
      const reason: GapReason = !field || field.status === 'rejected' ? 'missing' : def.sensitive ? 'sensitive_pending' : 'unconfirmed';
      gaps.push({ key, group: def.group, weight, impact: weight * (1 - credit), reason });
    }
  }

  gaps.sort((a, b) => b.impact - a.impact || b.weight - a.weight || a.key.localeCompare(b.key));

  const score = total > 0 ? Math.max(0, Math.min(100, Math.round((earned / total) * 100))) : 0;
  const groups: GroupCoverage[] = GROUP_ORDER.filter((g) => groupAcc.has(g)).map((g) => {
    const a = groupAcc.get(g)!;
    return { group: g, score: a.total > 0 ? Math.round((a.earned / a.total) * 100) : 0, known: a.known, total: a.count };
  });

  const requiredMissing = REQUIRED_KEYS.filter((k) => {
    const f = byKey.get(k);
    return !f || (f.status !== 'approved' && f.status !== 'edited');
  });
  const sensitivePending = fields.filter((f) => f.sensitive && f.status === 'pending').length;
  const pendingReview = fields.filter((f) => !f.sensitive && f.status === 'pending').length;

  let next: NextActionKind;
  switch (stage) {
    case 'not_started':
      next = 'start';
      break;
    case 'learning':
      next = 'answer';
      break;
    case 'review':
      next = 'review';
      break;
    case 'ready_to_test':
      next = run?.readiness_passed && run.test_call_confirmed_at ? 'go_live' : 'test';
      break;
    default:
      next = 'maintain';
  }

  return { stage, score, tier: tierFor(score), groups, gaps, requiredMissing, sensitivePending, pendingReview, next };
}

/** True while a "Not now" snooze is still in force. `raw` is the stored epoch-ms string. */
export function isSnoozed(raw: string | null | undefined, nowMs: number): boolean {
  if (!raw) return false;
  const until = Number(raw);
  return Number.isFinite(until) && until > nowMs;
}

/** Accepts "acme.com" or "https://acme.com/x"; returns a safe https/http URL <= 500 chars or null. */
export function normalizeWebsite(input: string): string | null {
  const s = input.trim();
  if (!s || s.length > 500 || /\s/.test(s)) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') || u.username || u.password) return null;
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
}
