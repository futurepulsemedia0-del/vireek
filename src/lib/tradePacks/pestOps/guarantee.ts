/**
 * Pest Ops — re-service / callback guarantee windows (pure).
 *
 * All dates are tenant-local calendar dates (YYYY-MM-DD). A guarantee of N days starting on the
 * service date covers requests made on days 0…N INCLUSIVE; day N+1 is out of window.
 * KEEP IN SYNC with public.pest_classify_callback() in 20290301000000_pest_ops_pack.sql.
 */

import { utcToZonedParts } from '@/lib/recurringJobs';

export const DEFAULT_GUARANTEE_DAYS = 30;
export const MAX_GUARANTEE_DAYS = 365;

export type CallbackOutcome = 'covered' | 'out_of_window' | 'target_mismatch' | 'callback_limit';

export interface GuaranteeTerms {
  windowDays: number;
  /** When true the callback must share a target pest with the original service (skipped if the original recorded none). */
  sameTargetOnly: boolean;
  /** Max covered callbacks per service; null = unlimited. */
  maxCallbacks: number | null;
}

export const DEFAULT_TERMS: GuaranteeTerms = { windowDays: DEFAULT_GUARANTEE_DAYS, sameTargetOnly: true, maxCallbacks: null };

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole calendar days from `a` to `b` (b − a). Timezone-independent. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

export function addDaysISO(iso: string, days: number): string {
  const dt = new Date(toUtcMs(iso) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** The tenant-local calendar date of a UTC instant (DST-aware). */
export function localDateOf(iso: string, timeZone: string): string {
  return utcToZonedParts(iso, timeZone).date;
}

export function normalizeTerms(t: Partial<GuaranteeTerms> | null | undefined): GuaranteeTerms {
  const w = Number.isFinite(t?.windowDays) ? Math.trunc(t!.windowDays as number) : DEFAULT_TERMS.windowDays;
  const max = t?.maxCallbacks;
  return {
    windowDays: Math.min(Math.max(w, 0), MAX_GUARANTEE_DAYS),
    sameTargetOnly: t?.sameTargetOnly ?? DEFAULT_TERMS.sameTargetOnly,
    maxCallbacks: typeof max === 'number' && Number.isFinite(max) && max >= 0 ? Math.trunc(max) : null,
  };
}

export interface GuaranteeWindow {
  startsOn: string;
  /** Last covered day (inclusive). */
  endsOn: string;
}

export function guaranteeWindow(serviceDate: string, windowDays: number): GuaranteeWindow {
  return { startsOn: serviceDate, endsOn: addDaysISO(serviceDate, Math.max(Math.trunc(windowDays), 0)) };
}

export interface CallbackAssessment {
  outcome: CallbackOutcome;
  covered: boolean;
  /** Free of charge only when covered. */
  billable: boolean;
  /** Days left in the window as of the request (0 on the last covered day; negative when expired). */
  daysRemaining: number;
  coveredUntil: string;
  reason: string;
}

export interface ServiceForGuarantee {
  serviceDate: string;
  targets: string[];
  terms: GuaranteeTerms;
  /** Covered callbacks already used against this service. */
  coveredCallbacks: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Decides whether a re-service request is covered by the guarantee of ONE original service. */
export function assessCallback(requestedOn: string, original: ServiceForGuarantee, requestTargets: string[]): CallbackAssessment {
  const w = guaranteeWindow(original.serviceDate, original.terms.windowDays);
  const daysRemaining = daysBetween(requestedOn, w.endsOn);
  const base = { coveredUntil: w.endsOn, daysRemaining };

  if (requestedOn < original.serviceDate) {
    return { ...base, outcome: 'out_of_window', covered: false, billable: true, reason: 'The request is dated before the original service.' };
  }
  if (requestedOn > w.endsOn) {
    return { ...base, outcome: 'out_of_window', covered: false, billable: true, reason: `The guarantee ended on ${w.endsOn}.` };
  }
  if (original.terms.sameTargetOnly && original.targets.length > 0) {
    const have = new Set(original.targets.map(norm));
    const overlap = requestTargets.some((t) => have.has(norm(t)));
    if (!overlap) {
      return { ...base, outcome: 'target_mismatch', covered: false, billable: true, reason: 'The pest is not one that service targeted.' };
    }
  }
  if (original.terms.maxCallbacks !== null && original.coveredCallbacks >= original.terms.maxCallbacks) {
    return { ...base, outcome: 'callback_limit', covered: false, billable: true, reason: `All ${original.terms.maxCallbacks} included callback(s) were used.` };
  }
  return { ...base, outcome: 'covered', covered: true, billable: false, reason: `Covered by the guarantee through ${w.endsOn}.` };
}

export interface PriorService extends ServiceForGuarantee {
  id: string;
  /** Callback visits are not themselves guaranteed services. */
  isCallback: boolean;
}

/**
 * Picks which prior service a new request belongs to: the most recent NON-callback service on or
 * before the request whose window covers it (preferring one that shares a target pest). When none
 * covers it, returns the most recent service so the UI can explain why it is out of window.
 */
export function pickOriginalService(requestedOn: string, requestTargets: string[], services: PriorService[]): { service: PriorService; assessment: CallbackAssessment } | null {
  const candidates = services
    .filter((s) => !s.isCallback && s.serviceDate <= requestedOn)
    .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
  if (candidates.length === 0) return null;
  const scored = candidates.map((service) => ({ service, assessment: assessCallback(requestedOn, service, requestTargets) }));
  return scored.find((s) => s.assessment.covered) ?? scored[0];
}
