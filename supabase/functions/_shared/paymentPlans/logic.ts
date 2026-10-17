// Pure payment-plan helpers (no Deno/Node APIs) — unit-tested under vitest.

export const REMINDER_STAGES = ["upcoming_3d", "due", "overdue_1d", "overdue_7d", "overdue_14d"] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

const DAY = 86_400_000;
const toDay = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);

export interface ReminderInput {
  kind: string;
  status: string;
  due_date: string;
  reminders_sent: string[];
  auto_charge: boolean;
}

/**
 * Decides which single reminder (if any) to send today. Returns the stage to send plus every stage up to it,
 * so a long-late installment never back-fills old reminders. Deposits are never reminded (they are paid at approval).
 * With auto-charge, the day-of reminder is skipped while the charge is still pending — the charge itself is the notice.
 */
export function nextReminder(i: ReminderInput, todayIso: string): { stage: ReminderStage; mark: ReminderStage[] } | null {
  if (i.kind !== "installment") return null;
  const delta = toDay(i.due_date) - toDay(todayIso); // >0 future, 0 due today, <0 overdue
  let stage: ReminderStage | null = null;
  if (delta >= 1 && delta <= 3) stage = "upcoming_3d";
  else if (delta === 0) stage = i.auto_charge && i.status === "scheduled" ? null : "due";
  else if (delta < 0) {
    const late = -delta;
    stage = late >= 14 ? "overdue_14d" : late >= 7 ? "overdue_7d" : "overdue_1d";
  }
  if (!stage || i.reminders_sent.includes(stage)) return null;
  const upTo = REMINDER_STAGES.indexOf(stage);
  return { stage, mark: REMINDER_STAGES.slice(0, upTo + 1).filter((s) => !i.reminders_sent.includes(s)) };
}

export interface FeeRule { late_fee_type: string; late_fee_value: number; late_fee_cap_cents: number }

/** Mirror of assess_payment_plan_late_fees(): flat = cents, percent = % of the installment, optional cap (0 = none). */
export function computeLateFee(rule: FeeRule, amountCents: number): number {
  if (rule.late_fee_type === "none") return 0;
  let fee = rule.late_fee_type === "flat" ? Math.round(rule.late_fee_value) : Math.round((amountCents * rule.late_fee_value) / 100);
  if (rule.late_fee_cap_cents > 0) fee = Math.min(fee, rule.late_fee_cap_cents);
  return Math.max(0, fee);
}

export function formatMoney(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** One idempotency key per (installment, attempt): a retried HTTP call replays the same charge instead of duplicating it. */
export const chargeIdempotencyKey = (installmentId: string, attempt: number) => `pplan-${installmentId}-${attempt}`;

export interface TermsInput {
  business_name?: string | null;
  customer_name: string;
  currency: string;
  total_cents: number;
  deposit_cents: number;
  installment_count: number;
  installment_cents: number[]; // amounts of the scheduled installments (excluding deposit)
  first_due_date: string;
  frequency: string;
  auto_charge: boolean;
  late_fee_type: string;
  late_fee_value: number;
  late_fee_cap_cents: number;
  grace_days: number;
}

/** The exact text the customer sees before approving. Stored on the plan as the consent record. */
export function buildTerms(t: TermsInput): string {
  const m = (c: number) => formatMoney(c, t.currency);
  const every = t.frequency === "weekly" ? "week" : t.frequency === "biweekly" ? "2 weeks" : "month";
  const uniform = t.installment_cents.every((c) => c === t.installment_cents[0]);
  const lines = [
    `Payment plan for ${t.customer_name}${t.business_name ? ` with ${t.business_name}` : ""}: total ${m(t.total_cents)}.`,
    t.deposit_cents > 0 ? `Deposit today: ${m(t.deposit_cents)}.` : "No deposit due today.",
    `Then ${t.installment_count} payment${t.installment_count === 1 ? "" : "s"} ${uniform ? `of ${m(t.installment_cents[0] ?? 0)} ` : ""}every ${every}, starting ${t.first_due_date}.`,
    t.auto_charge
      ? "By approving, you authorize automatic charges to the card you provide on each due date, and you may cancel this authorization by contacting the business."
      : "You will receive a payment link before each due date.",
  ];
  if (t.late_fee_type !== "none") {
    const fee = t.late_fee_type === "flat" ? m(Math.round(t.late_fee_value)) : `${t.late_fee_value}% of the installment`;
    const cap = t.late_fee_cap_cents > 0 ? `, up to ${m(t.late_fee_cap_cents)}` : "";
    lines.push(`A one-time late fee of ${fee}${cap} applies to an installment still unpaid ${t.grace_days} day${t.grace_days === 1 ? "" : "s"} after its due date.`);
  } else {
    lines.push("No late fees apply.");
  }
  return lines.join(" ");
}

export function reminderMessage(
  stage: ReminderStage,
  v: { name: string; amountCents: number; lateFeeCents: number; currency: string; dueDate: string; autoCharge: boolean; link: string },
): { subject: string; text: string } {
  const amt = formatMoney(v.amountCents + v.lateFeeCents, v.currency);
  const fee = v.lateFeeCents > 0 ? ` (includes a ${formatMoney(v.lateFeeCents, v.currency)} late fee)` : "";
  const pay = `Pay securely: ${v.link}`;
  switch (stage) {
    case "upcoming_3d":
      return { subject: `Upcoming payment: ${amt} on ${v.dueDate}`, text: v.autoCharge ? `Hi ${v.name}, your payment of ${amt} is scheduled for ${v.dueDate}. We'll charge your card on file automatically.` : `Hi ${v.name}, your payment of ${amt} is due ${v.dueDate}. ${pay}` };
    case "due":
      return { subject: `Payment due today: ${amt}`, text: `Hi ${v.name}, your payment of ${amt} is due today. ${pay}` };
    default:
      return { subject: `Past-due payment: ${amt}`, text: `Hi ${v.name}, your payment of ${amt}${fee} was due ${v.dueDate} and is still open. ${pay}` };
  }
}
