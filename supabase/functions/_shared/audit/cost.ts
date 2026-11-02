// supabase/functions/_shared/audit/cost.ts
//
// Cost model + reservation amounts. Vendor prices are ASSUMPTIONS taken from public pricing pages in Nov 2026
// (Twilio Verify: $0.05 per successful verification + $0.0083 per US SMS; Vapi: $0.05/min platform fee, with a typical
// all-in $0.15-$0.50 per minute depending on model/voice/telephony). Confirm against your own invoices, then edit here.
// Every paid step reserves its cost atomically (audit_reserve_audit / audit_reserve_daily) BEFORE it runs.

import { MAX_CALL_SECONDS } from "./script.ts";

export const COST = {
  otpSmsCents: 6, // $0.05 + $0.0083, rounded up
  otpVoiceCents: 7, // $0.05 + a ~1 min outbound voice leg
  lookupCents: 2,
  /** All-in reservation per call: MAX_CALL_SECONDS at an assumed $0.30/min (mid-range of $0.15-$0.50). */
  callReserveCents: Math.ceil((MAX_CALL_SECONDS / 60) * 30),
  emailCents: 1,
} as const;

export interface CostInput { otp: "sms" | "voice"; lookup: boolean; calls: number; emails: number }

export function estimateAuditCostCents(i: CostInput): { typical: number; worst: number } {
  const fixed = (i.otp === "sms" ? COST.otpSmsCents : COST.otpVoiceCents) + (i.lookup ? COST.lookupCents : 0) + i.emails * COST.emailCents;
  const typicalCallCents = Math.ceil((40 / 60) * 30); // ~40 s average, mid-range price
  return { typical: fixed + i.calls * typicalCallCents, worst: fixed + i.calls * COST.callReserveCents };
}
