/**
 * Pest Ops — plan lifecycle: renewals and cancellations (pure).
 * Dates are calendar dates (YYYY-MM-DD). The database re-validates every transition.
 * KEEP IN SYNC with pest_renew_plan() / pest_cancel_plan() in 20290301000000_pest_ops_pack.sql.
 */

import { occurrenceDate } from '@/lib/recurringJobs';
import { applySeason } from '../framework';
import { addDaysISO, daysBetween } from './guarantee';
import { PEST_CADENCES, type PestCadence, type Season } from './cadence';

export type PlanStatus = 'active' | 'paused' | 'renewal_due' | 'cancel_scheduled' | 'cancelled' | 'expired';

export const RENEWABLE_STATUSES: PlanStatus[] = ['active', 'renewal_due', 'expired'];
export const CANCELLABLE_STATUSES: PlanStatus[] = ['active', 'paused', 'renewal_due', 'cancel_scheduled'];

export const DEFAULT_RENEWAL_NOTICE_DAYS = 30;

export type RenewalState = 'not_due' | 'due' | 'overdue' | 'expired' | 'closed';

export interface RenewalInput {
  status: PlanStatus;
  termEnd: string;
  today: string;
  noticeDays: number;
}

export interface RenewalAssessment {
  state: RenewalState;
  /** Days until the term ends (negative once ended). */
  daysToEnd: number;
  /** First day the renewal prompt is shown. */
  dueFrom: string;
}

export function assessRenewal(i: RenewalInput): RenewalAssessment {
  const daysToEnd = daysBetween(i.today, i.termEnd);
  const dueFrom = addDaysISO(i.termEnd, -Math.max(i.noticeDays, 0));
  if (i.status === 'cancelled') return { state: 'closed', daysToEnd, dueFrom };
  if (daysToEnd < 0) return { state: 'expired', daysToEnd, dueFrom };
  if (i.status === 'cancel_scheduled') return { state: 'closed', daysToEnd, dueFrom };
  if (daysToEnd === 0) return { state: 'overdue', daysToEnd, dueFrom };
  if (i.today >= dueFrom) return { state: 'due', daysToEnd, dueFrom };
  return { state: 'not_due', daysToEnd, dueFrom };
}

export interface Term {
  start: string;
  end: string;
}

/** Whole months in a term (`end` is the last covered day, so the term runs to end + 1 day exclusive). */
export function termMonths(term: Term): number {
  const exclusive = addDaysISO(term.end, 1);
  const months = (Number(exclusive.slice(0, 4)) - Number(term.start.slice(0, 4))) * 12 + (Number(exclusive.slice(5, 7)) - Number(term.start.slice(5, 7)));
  return Math.max(months, 1);
}

/**
 * The term that follows `current`. Seasonal plans move to next year's window; every other plan
 * repeats its length measured from the ORIGINAL start (`anchorStart`), so a Jan-31 start never
 * drifts to Jan-28 after a short month.
 */
export function nextTerm(current: Term, cadence: PestCadence, season: Season | null | undefined, anchorStart: string = current.start): Term {
  const start = addDaysISO(current.end, 1);
  if (PEST_CADENCES[cadence].needsSeason && season) {
    const w = applySeason(start, season);
    return { start: w.start, end: w.end ?? start };
  }
  const months = termMonths(current);
  const elapsed = (Number(start.slice(0, 4)) - Number(anchorStart.slice(0, 4))) * 12 + (Number(start.slice(5, 7)) - Number(anchorStart.slice(5, 7)));
  const endExclusive = occurrenceDate(anchorStart, 'month', Math.max(elapsed, 0) + months, 1);
  return { start, end: addDaysISO(endExclusive, -1) };
}

export type CancelPolicy = 'immediate' | 'notice' | 'term_end';

export interface CancelInput {
  requestedOn: string;
  termEnd: string;
  policy: CancelPolicy;
  /** Used by the 'notice' policy. */
  noticeDays: number;
}

/**
 * Effective cancellation date. Visits after this date are cancelled; a refund or fee is a
 * commercial / legal matter and is intentionally NOT computed here (REQUIRES COUNSEL for
 * jurisdictions with cancellation-right rules).
 */
export function cancellationEffectiveOn(i: CancelInput): string {
  if (i.policy === 'immediate') return i.requestedOn;
  if (i.policy === 'term_end') return i.termEnd < i.requestedOn ? i.requestedOn : i.termEnd;
  const withNotice = addDaysISO(i.requestedOn, Math.max(i.noticeDays, 0));
  return withNotice > i.termEnd ? i.termEnd : withNotice;
}
