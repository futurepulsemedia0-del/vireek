// supabase/functions/_shared/estimate-recovery/rules.ts
// Deterministic detection thresholds + risk score for estimate-recovery-agent.
// Extracted verbatim from the function so it can be unit tested. No behaviour change.

// Thresholds — tune freely, nothing else in the system depends on these exact numbers.
export const FINANCING_MIN_HOURS = 72; // quote sent 3+ days, still unanswered
export const FINANCING_MIN_VALUE_CENTS = 50000; // $500+ — worth mentioning financing for
export const BOOKING_MIN_HOURS = 24; // accepted 1+ day, still no job on the calendar
export const INVOICE_MIN_HOURS = 24; // completed 1+ day, still not invoiced
export const COLLECTION_MIN_DAYS = 14; // matches OVERDUE_AFTER_DAYS in send-payment-reminders
export const PARTS_GAP_MIN_CENTS = 1500; // $15+ gap between parts installed and what was invoiced

/** 0..100. Time (max 60: 1 pt per 4 stalled hours) + value (max 40: 1 pt per $50). Integer cents in, integer out. */
export function riskScore(hoursStalled: number, valueCents: number): number {
  const timeComponent = Math.min(60, Math.round(hoursStalled / 4));
  const valueComponent = Math.min(40, Math.round(valueCents / 5000));
  return Math.min(100, timeComponent + valueComponent);
}
