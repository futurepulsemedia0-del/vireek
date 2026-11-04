// supabase/functions/_shared/win-cards/triggers.ts
// Pure event detectors. Each one takes rows ALREADY loaded (by the edge function, scoped to one account)
// and returns a candidate only when the REAL event happened. No row → no card. Nothing here invents data.

import { isAfterHours } from "./redact.ts";
import type { CardSettings, PrivateFacts, TriggerType } from "./types.ts";

export interface Candidate {
  trigger: TriggerType;
  sourceTable: "calls" | "revenue_recovery_events" | "speed_to_lead_requests" | "review_requests" | null;
  sourceId: string | null;
  dedupeKey: string;
  facts: PrivateFacts;
}

export function piiTerms(...vals: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (!s) continue;
    out.add(s);
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 7) { out.add(digits); out.add(digits.slice(-10)); }
  }
  return [...out];
}

// ---------------------------------------------------------------- calls

export interface CallRow {
  id: string;
  call_datetime: string;
  is_emergency: boolean;
  status: string | null;
  booking_outcome: string | null;
  caller_name: string | null;
  caller_phone: string | null;
}

export interface LinkedJobValue { invoice_amount: number | null } // jobs.invoice_amount is numeric DOLLARS

const dollarsToCents = (d: number | null | undefined) =>
  typeof d === "number" && Number.isFinite(d) && d > 0 ? Math.round(d * 100) : undefined;

export function detectEmergencyHandled(call: CallRow, job?: LinkedJobValue | null): Candidate | null {
  if (!call.is_emergency || call.booking_outcome !== "booked") return null;
  const valueCents = dollarsToCents(job?.invoice_amount);
  return {
    trigger: "emergency_handled", sourceTable: "calls", sourceId: call.id, dedupeKey: `call:${call.id}`,
    facts: { trigger: "emergency_handled", occurredAt: call.call_datetime, valueCents, valueBasis: valueCents ? "invoiced" : undefined, pii: piiTerms(call.caller_name, call.caller_phone) },
  };
}

export function detectAfterHoursBooking(call: CallRow, s: CardSettings, job?: LinkedJobValue | null): Candidate | null {
  if (call.is_emergency) return null; // emergencies get their own, more specific card (same dedupe key family)
  if (call.booking_outcome !== "booked") return null;
  if (!isAfterHours(call.call_datetime, s.timezone, s.businessHoursStart, s.businessHoursEnd)) return null;
  const valueCents = dollarsToCents(job?.invoice_amount);
  return {
    trigger: "after_hours_booking", sourceTable: "calls", sourceId: call.id, dedupeKey: `call:${call.id}`,
    facts: { trigger: "after_hours_booking", occurredAt: call.call_datetime, valueCents, valueBasis: valueCents ? "invoiced" : undefined, pii: piiTerms(call.caller_name, call.caller_phone) },
  };
}

// ---------------------------------------------------------------- recovered revenue (ledger)

export interface RecoveryRow {
  id: string;
  source_type: string;
  status: string;
  recovered_amount_cents: number | null;
  occurred_at: string;
  customer_name: string | null;
  customer_phone: string | null;
}

export function detectRecoveredLargeJob(ev: RecoveryRow, s: CardSettings): Candidate | null {
  if (ev.status !== "recovered") return null;
  if (!["missed_call", "voicemail", "not_booked"].includes(ev.source_type)) return null;
  const cents = ev.recovered_amount_cents ?? 0; // the REAL amount collected, per the ledger — never the estimate
  if (cents < s.largeJobThresholdCents) return null;
  return {
    trigger: "recovered_large_job", sourceTable: "revenue_recovery_events", sourceId: ev.id, dedupeKey: `recovery:${ev.id}`,
    facts: { trigger: "recovered_large_job", occurredAt: ev.occurred_at, valueCents: cents, valueBasis: "collected", pii: piiTerms(ev.customer_name, ev.customer_phone) },
  };
}

// ---------------------------------------------------------------- milestones

export const MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000] as const;

/** Highest milestone reached that has no card yet and no card for any higher milestone. */
export function detectMilestone(answeredCalls: number, existing: ReadonlySet<number>, nowIso: string): Candidate | null {
  if (!Number.isFinite(answeredCalls)) return null;
  const reached = MILESTONES.filter((m) => answeredCalls >= m);
  if (!reached.length) return null;
  const top = reached[reached.length - 1];
  for (const m of existing) if (m >= top) return null;
  return {
    trigger: "milestone_calls", sourceTable: null, sourceId: null, dedupeKey: `milestone:${top}`,
    facts: { trigger: "milestone_calls", occurredAt: nowIso, milestone: top, pii: [] },
  };
}

// ---------------------------------------------------------------- speed to lead

export interface SpeedRow {
  id: string;
  time_to_first_dial_ms: number | null;
  sla_met: boolean | null;
  received_at: string;
  first_name: string | null;
  full_name: string | null;
  phone_e164: string | null;
}

export const MIN_SPEED_HISTORY = 20; // a "record" among 3 attempts is meaningless

export function detectSpeedRecord(r: SpeedRow, priorBestMs: number | null, priorCount: number): Candidate | null {
  const ms = r.time_to_first_dial_ms;
  if (ms == null || ms < 0 || r.sla_met !== true) return null;
  if (priorCount < MIN_SPEED_HISTORY || priorBestMs == null) return null;
  if (ms >= priorBestMs) return null; // must strictly beat every earlier attempt
  if (ms > 300_000) return null;
  return {
    trigger: "speed_to_lead_record", sourceTable: "speed_to_lead_requests", sourceId: r.id, dedupeKey: `speed:${r.id}`,
    facts: { trigger: "speed_to_lead_record", occurredAt: r.received_at, responseMs: ms, previousBestMs: priorBestMs, pii: piiTerms(r.first_name, r.full_name, r.phone_e164) },
  };
}

// ---------------------------------------------------------------- 5-star review from an AI-booked job

export interface ReviewRequestRow {
  id: string;
  rating: number | null;
  status: string;
  completed_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}
export interface JobCallLink { call_booking_outcome: string | null } // booking_outcome of jobs.call_id → calls

export function detectFiveStarAiJob(rr: ReviewRequestRow, link: JobCallLink | null): Candidate | null {
  if (rr.status !== "completed" || rr.rating !== 5) return null;
  if (!link || link.call_booking_outcome !== "booked") return null; // the job must trace back to a booked call
  return {
    trigger: "five_star_ai_job", sourceTable: "review_requests", sourceId: rr.id, dedupeKey: `review:${rr.id}`,
    facts: { trigger: "five_star_ai_job", occurredAt: rr.completed_at ?? new Date().toISOString(), pii: piiTerms(rr.customer_name, rr.customer_phone) },
  };
}

/**
 * Walks speed-to-lead requests in chronological order, tracking the running best, and returns a card
 * candidate for every request (inside `sinceIso`) that set a NEW all-time record. Pure + O(n).
 */
export function findSpeedRecords(rowsAsc: SpeedRow[], sinceIso: string): Candidate[] {
  const out: Candidate[] = [];
  let best: number | null = null;
  let count = 0;
  for (const r of rowsAsc) {
    const ms = r.time_to_first_dial_ms;
    if (ms == null || ms < 0) continue;
    if (r.received_at >= sinceIso) {
      const c = detectSpeedRecord(r, best, count);
      if (c) out.push(c);
    }
    best = best == null ? ms : Math.min(best, ms);
    count += 1;
  }
  return out;
}
