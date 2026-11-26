/**
 * Plan -> support tier. Pure logic: no React, no network.
 * Mirrors supabase/migrations/20290315000000_support_tier_targets.sql (support_tier_for_plan)
 * and docs/support/support-tiers.md.
 *
 * Not to be confused with T1/T2/T3 in docs/support/tier-model.md (internal roles) or S1-S4
 * severity in supportSla.ts. A *support tier* is what a PLAN includes; it never replaces severity.
 *
 * Response-time targets are NULL until the owner sets them (TODO(owner)). Targets live in the DB
 * (support_tier_targets); the numbers below are only a fallback shape and stay null on purpose.
 */
import type { PlanId } from '@/lib/pricing';

export type SupportTierId = 'community' | 'standard' | 'priority' | 'dedicated' | 'enterprise';
export type SupportChannel = 'help_center' | 'email' | 'priority_queue' | 'slack_channel' | 'account_manager';

export interface SupportTier {
  id: SupportTierId;
  /** Public label. Must equal COMPARE_VALUES.support[plan] in pricing.ts (tested). */
  label: string;
  channels: readonly SupportChannel[];
  /** TODO(owner): minutes. null = no target set; nothing is tracked or shown. */
  firstResponseMinutes: number | null;
  /** TODO(owner): minutes. null = no target set. */
  resolutionMinutes: number | null;
}

export const SUPPORT_TIER_IDS: readonly SupportTierId[] = ['community', 'standard', 'priority', 'dedicated', 'enterprise'];

/** TODO(counsel): keep false until counsel has cleared any public response-time wording. */
export const SUPPORT_TARGETS_PUBLISHED = false;

export const SUPPORT_TIERS: Readonly<Record<SupportTierId, SupportTier>> = {
  community: { id: 'community', label: 'Community', channels: ['help_center'], firstResponseMinutes: null, resolutionMinutes: null },
  standard: { id: 'standard', label: 'Email', channels: ['help_center', 'email'], firstResponseMinutes: null, resolutionMinutes: null },
  priority: { id: 'priority', label: 'Priority', channels: ['help_center', 'email', 'priority_queue'], firstResponseMinutes: null, resolutionMinutes: null },
  dedicated: { id: 'dedicated', label: 'Dedicated Slack', channels: ['help_center', 'email', 'priority_queue', 'slack_channel'], firstResponseMinutes: null, resolutionMinutes: null },
  enterprise: { id: 'enterprise', label: 'Account manager', channels: ['help_center', 'email', 'priority_queue', 'slack_channel', 'account_manager'], firstResponseMinutes: null, resolutionMinutes: null },
};

export const PLAN_SUPPORT_TIER: Readonly<Record<PlanId, SupportTierId>> = {
  free: 'community',
  starter: 'standard',
  professional: 'priority',
  business: 'dedicated',
  enterprise: 'enterprise',
};

/** profiles.plan can hold legacy spellings; anything unknown falls to the most restrictive tier. */
const PLAN_ALIASES: Readonly<Record<string, PlanId>> = { pro: 'professional', trial: 'free' };

export function resolveSupportTier(plan: string | null | undefined): SupportTierId {
  const key = (plan ?? '').trim().toLowerCase();
  const id = Object.prototype.hasOwnProperty.call(PLAN_ALIASES, key) ? PLAN_ALIASES[key] : key;
  return Object.prototype.hasOwnProperty.call(PLAN_SUPPORT_TIER, id) ? PLAN_SUPPORT_TIER[id as PlanId] : 'community';
}

export function supportTierForPlan(plan: string | null | undefined): SupportTier {
  return SUPPORT_TIERS[resolveSupportTier(plan)];
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} h` : `${min} min`;
}

/** Public wording for a target. Null unless explicitly published AND set, so nothing leaks by accident. */
export function publicFirstResponseText(tier: SupportTier): string | null {
  if (!SUPPORT_TARGETS_PUBLISHED) return null;
  const m = tier.firstResponseMinutes;
  return m !== null && Number.isFinite(m) && m > 0 ? formatMinutes(m) : null;
}

export type TierClockState = 'untracked' | 'on_track' | 'at_risk' | 'overdue' | 'met' | 'missed' | 'paused';

export interface TierClockInput {
  /** Server-stamped clock start (ISO). */
  startedAt: string;
  /** Target in minutes from support_tier_targets; null = untracked. */
  minutes: number | null;
  /** First staff reply / resolution time (ISO); null while the clock still runs. */
  stoppedAt: string | null;
  /** Resolution clock only: ticket is waiting on the customer. The deadline does not move. */
  paused?: boolean;
  nowMs?: number;
}

/** Fraction of the window left at which a running clock becomes "at risk". */
export const AT_RISK_FRACTION = 0.25;

export function tierClockState(i: TierClockInput): TierClockState {
  const start = Date.parse(i.startedAt);
  const m = i.minutes;
  if (!Number.isFinite(start) || m === null || !Number.isFinite(m) || m <= 0) return 'untracked';
  const total = m * 60_000;
  const due = start + total;
  if (i.stoppedAt !== null) {
    const stop = Date.parse(i.stoppedAt);
    if (!Number.isFinite(stop)) return 'untracked';
    return stop <= due ? 'met' : 'missed';
  }
  if (i.paused) return 'paused';
  const now = i.nowMs ?? Date.now();
  if (now > due) return 'overdue';
  return due - now <= total * AT_RISK_FRACTION ? 'at_risk' : 'on_track';
}
