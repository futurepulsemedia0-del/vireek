// supabase/functions/_shared/outcomes/attribution.ts
//
// Pure, dependency-free attribution rules (version "v1") that turn raw
// business events into a conservative outcome for ONE governed agent action.
// No I/O: the outcome-reconciler edge function gathers the facts and calls
// these functions, so every rule can be unit-tested.
//
// Principles (documented contract):
//  1. Never credit an action for an event that happened at or before the
//     action's executed_at (strictly-after rule).
//  2. Attribution window is inclusive at its end: event <= executed_at + window.
//  3. Multi-touch conflict: if another governed contact touched the same
//     entity inside the lookback before the credited event, the result is
//     'unknown' with conflict=true (excluded from learning). We never pick
//     a "last touch" winner.
//  4. Pending until the window closes; a closed window with no event is
//     'no_effect'. Unresolvable/insane inputs resolve to 'unknown',
//     never to 'success'.
//  5. Events timestamped in the future (relative to `now`) are ignored and flagged.

export const ATTRIBUTION_VERSION = "v1";

export type Outcome = "success" | "partial" | "failure" | "no_effect" | "unknown";
export type WatchState = "pending" | "measured" | "final";

export interface Decision {
  state: WatchState;
  outcome: Outcome | null;
  confidence: number;
  financialCents: number | null;
  conflict: boolean;
  flags: string[];
  evidence: Record<string, unknown>;
}

export const RULES = {
  booking_after_sms: { targetTable: "workflow_runs", windowHours: 72, conflictLookbackHours: 72 },
  financing_offer_acceptance: { targetTable: "financing_offers", windowHours: 336 },
  invoice_paid_after_action: { targetTable: "invoices", windowHours: 720 },
} as const;

export type RuleKey = keyof typeof RULES;

const HOUR_MS = 3_600_000;

export function ruleForTargetTable(table: string | null | undefined): RuleKey | null {
  for (const key of Object.keys(RULES) as RuleKey[]) {
    if (RULES[key].targetTable === table) return key;
  }
  return null;
}

function ms(d: Date | string | null | undefined): number | null {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function finalUnknown(flags: string[], evidence: Record<string, unknown> = {}, conflict = false): Decision {
  return { state: "final", outcome: "unknown", confidence: 0, financialCents: null, conflict, flags, evidence };
}

function clockCheck(executedAt: number | null, now: number): string | null {
  if (executedAt === null) return "executed_at_missing";
  if (executedAt > now) return "executed_at_in_future";
  return null;
}

// -------------------------------------------------------------
// Rule 1: SMS/call workflow step -> a job booked from the same call
// -------------------------------------------------------------
export interface BookingFacts {
  executedAt: Date | string | null;
  now: Date;
  /** created_at of every job linked to the same call (any time). */
  jobCreatedAt: Array<Date | string>;
  /** executed_at of OTHER governed contacts on the same call entity. */
  otherTouchAt: Array<Date | string>;
}

export function decideBooking(f: BookingFacts): Decision {
  const rule = RULES.booking_after_sms;
  const now = f.now.getTime();
  const exec = ms(f.executedAt);
  const clock = clockCheck(exec, now);
  if (clock) return finalUnknown([clock]);
  const e = exec as number;
  const windowEnd = e + rule.windowHours * HOUR_MS;

  const flags: string[] = [];
  const jobs = f.jobCreatedAt.map(ms).filter((t): t is number => t !== null);
  const futureJobs = jobs.filter((t) => t > now);
  if (futureJobs.length > 0) flags.push("job_timestamp_in_future_ignored");
  const valid = jobs.filter((t) => t <= now).sort((a, b) => a - b);

  // Rule 1: any job at/before the action means the booking preceded it.
  if (valid.some((t) => t <= e)) {
    return {
      state: "final", outcome: "no_effect", confidence: 0.9, financialCents: null, conflict: false,
      flags: [...flags, "outcome_preceded_action"],
      evidence: { rule: "booking_after_sms", reason: "job_exists_at_or_before_action" },
    };
  }

  const credited = valid.find((t) => t > e && t <= windowEnd);
  if (credited === undefined) {
    if (now < windowEnd) {
      return { state: "pending", outcome: null, confidence: 0, financialCents: null, conflict: false, flags, evidence: { rule: "booking_after_sms", window_ends_at: new Date(windowEnd).toISOString() } };
    }
    return {
      state: "final", outcome: "no_effect", confidence: 0.8, financialCents: null, conflict: false, flags,
      evidence: { rule: "booking_after_sms", reason: "window_closed_without_booking" },
    };
  }

  const lookbackStart = credited - rule.conflictLookbackHours * HOUR_MS;
  const touches = f.otherTouchAt.map(ms).filter((t): t is number => t !== null && t > lookbackStart && t < credited);
  if (touches.length > 0) {
    return finalUnknown([...flags, "multi_touch_conflict"], { rule: "booking_after_sms", competing_touches: touches.length }, true);
  }

  return {
    state: "final", outcome: "success", confidence: 0.8, financialCents: null, conflict: false, flags,
    evidence: { rule: "booking_after_sms", job_created_at: new Date(credited).toISOString(), hours_after_action: Math.round(((credited - e) / HOUR_MS) * 10) / 10 },
  };
}

// -------------------------------------------------------------
// Rule 2: financing offer -> accepted
// -------------------------------------------------------------
export interface FinancingFacts {
  executedAt: Date | string | null;
  now: Date;
  status: string;
  statusUpdatedAt: Date | string | null;
  approvedAmountCents: number | null;
}

export function decideFinancing(f: FinancingFacts): Decision {
  const rule = RULES.financing_offer_acceptance;
  const now = f.now.getTime();
  const exec = ms(f.executedAt);
  const clock = clockCheck(exec, now);
  if (clock) return finalUnknown([clock]);
  const e = exec as number;
  const windowEnd = e + rule.windowHours * HOUR_MS;
  const upd = ms(f.statusUpdatedAt);
  const ev = { rule: "financing_offer_acceptance", status: f.status };

  if (upd === null || upd > now) return finalUnknown(["status_timestamp_invalid"], ev);

  if (f.status === "funded" || f.status === "loan_confirmed") {
    if (upd <= e) return finalUnknown(["outcome_preceded_action"], ev);
    if (upd > windowEnd) {
      return { state: "final", outcome: "partial", confidence: 0.6, financialCents: null, conflict: false, flags: ["accepted_after_window"], evidence: ev };
    }
    const cents = f.status === "funded" && f.approvedAmountCents && f.approvedAmountCents > 0 ? f.approvedAmountCents : null;
    return { state: "final", outcome: "success", confidence: f.status === "funded" ? 1 : 0.9, financialCents: cents, conflict: false, flags: [], evidence: ev };
  }
  if (f.status === "approved") {
    // Approved by the lender but not yet accepted/funded: measured, not final until the window closes.
    if (now < windowEnd) return { state: "measured", outcome: "partial", confidence: 0.6, financialCents: null, conflict: false, flags: [], evidence: ev };
    return { state: "final", outcome: "partial", confidence: 0.6, financialCents: null, conflict: false, flags: [], evidence: ev };
  }
  if (f.status === "declined" || f.status === "expired" || f.status === "canceled") {
    return { state: "final", outcome: "no_effect", confidence: 0.9, financialCents: null, conflict: false, flags: [], evidence: ev };
  }
  if (now < windowEnd) return { state: "pending", outcome: null, confidence: 0, financialCents: null, conflict: false, flags: [], evidence: ev };
  return { state: "final", outcome: "no_effect", confidence: 0.8, financialCents: null, conflict: false, flags: [], evidence: ev };
}

// -------------------------------------------------------------
// Rule 3: invoice action (e.g. payment reminder) -> invoice paid
// -------------------------------------------------------------
export interface InvoiceFacts {
  executedAt: Date | string | null;
  now: Date;
  status: string;
  paidAt: Date | string | null;
}

export function decideInvoicePaid(f: InvoiceFacts): Decision {
  const rule = RULES.invoice_paid_after_action;
  const now = f.now.getTime();
  const exec = ms(f.executedAt);
  const clock = clockCheck(exec, now);
  if (clock) return finalUnknown([clock]);
  const e = exec as number;
  const windowEnd = e + rule.windowHours * HOUR_MS;
  const ev = { rule: "invoice_paid_after_action", status: f.status };

  if (f.status === "void") return { state: "final", outcome: "no_effect", confidence: 0.9, financialCents: null, conflict: false, flags: ["invoice_void"], evidence: ev };

  if (f.status === "paid") {
    const paid = ms(f.paidAt);
    if (paid === null || paid > now) return finalUnknown(["paid_at_invalid"], ev);
    if (paid <= e) {
      return { state: "final", outcome: "no_effect", confidence: 0.9, financialCents: null, conflict: false, flags: ["outcome_preceded_action"], evidence: ev };
    }
    if (paid <= windowEnd) {
      return { state: "final", outcome: "success", confidence: 0.8, financialCents: null, conflict: false, flags: [], evidence: ev };
    }
    return { state: "final", outcome: "partial", confidence: 0.5, financialCents: null, conflict: false, flags: ["paid_after_window"], evidence: ev };
  }
  if (now < windowEnd) return { state: "pending", outcome: null, confidence: 0, financialCents: null, conflict: false, flags: [], evidence: ev };
  return { state: "final", outcome: "no_effect", confidence: 0.8, financialCents: null, conflict: false, flags: [], evidence: ev };
}
