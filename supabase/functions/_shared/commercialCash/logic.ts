// Pure logic for Commercial Approval-to-Cash (no I/O, no Deno/browser APIs) so it can be
// unit-tested with vitest and used from the cron edge function.

export const DEMAND_DISCLAIMER =
  "DRAFT - REVIEW REQUIRED. Not sent. This text was generated automatically from the invoice record. " +
  "It is not legal advice; have it reviewed (and, if you choose, checked by your own counsel) before anything is sent.";

export type LadderAction =
  | { action: "reminder"; stepDay: number; skipped: number[] }
  | { action: "demand_draft"; stepDay: number; skipped: number[] }
  | { action: "none" };

export interface LadderInput {
  /** ISO date or timestamp the ladder counts from (sent date, or due date, per the profile). */
  anchor: string | null;
  /** ISO date or timestamp for "now". */
  today: string;
  ladderDays: number[];
  demandDraftAfterDays: number;
  /** step_day values already claimed/completed as reminders for this invoice. */
  doneReminders: number[];
  draftDone: boolean;
}

const DAY_MS = 86_400_000;

/** Whole UTC calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Number.NaN;
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((db - da) / DAY_MS);
}

/**
 * Decide the single next ladder action for one invoice.
 * - At/after demandDraftAfterDays: queue ONE human-review demand draft (never sent). Lower reminder steps not yet sent are skipped, not back-filled.
 * - Below it: send the highest reminder step already reached and not yet done; earlier missed steps are reported as skipped.
 * - Steps >= demandDraftAfterDays are never reminders; the draft takes over.
 */
export function nextLadderAction(i: LadderInput): LadderAction {
  if (!i.anchor) return { action: "none" };
  const elapsed = daysBetween(i.anchor, i.today);
  if (!Number.isFinite(elapsed) || elapsed < 1) return { action: "none" };

  const reminderSteps = [...new Set(i.ladderDays)]
    .filter((d) => Number.isInteger(d) && d >= 1 && d < i.demandDraftAfterDays)
    .sort((a, b) => a - b);
  const pendingReminders = reminderSteps.filter((d) => d <= elapsed && !i.doneReminders.includes(d));

  if (elapsed >= i.demandDraftAfterDays) {
    return i.draftDone
      ? { action: "none" }
      : { action: "demand_draft", stepDay: i.demandDraftAfterDays, skipped: pendingReminders };
  }
  if (pendingReminders.length === 0) return { action: "none" };
  const stepDay = pendingReminders[pendingReminders.length - 1];
  return { action: "reminder", stepDay, skipped: pendingReminders.slice(0, -1) };
}

export interface DraftFacts {
  businessName: string;
  customerName: string;
  invoiceNumber: string;
  balanceFormatted: string;
  dueDate: string | null;
  sentDate: string | null;
  daysOutstanding: number;
  poReference: string | null;
  remindersSent: number;
}

/** Factual, neutral payment-request draft. No legal claims, no threats, no lien language. */
export function buildDemandDraft(f: DraftFacts): { body: string; disclaimer: string } {
  const lines = [
    `Subject: Past-due invoice ${f.invoiceNumber}`,
    "",
    `Dear ${f.customerName},`,
    "",
    `Our records show invoice ${f.invoiceNumber}${f.poReference ? ` (reference ${f.poReference})` : ""} has an unpaid balance of ${f.balanceFormatted}.`,
    f.sentDate ? `The invoice was sent on ${f.sentDate}.` : "",
    f.dueDate ? `Payment was due on ${f.dueDate}.` : "",
    `It has now been outstanding for ${f.daysOutstanding} days${f.remindersSent > 0 ? `, and we have sent ${f.remindersSent} earlier reminder${f.remindersSent === 1 ? "" : "s"}` : ""}.`,
    "",
    "Please arrange payment, or let us know if there is a problem with the invoice that we can resolve (for example a missing PO number or approval).",
    "",
    "Thank you,",
    f.businessName,
  ];
  return { body: lines.filter((l, idx) => l !== "" || lines[idx - 1] !== "").join("\n").trim(), disclaimer: DEMAND_DISCLAIMER };
}

export const STAGES = ["draft", "blocked_needs_approval", "sent", "received", "approved", "rejected", "paid", "void"] as const;
export type Stage = (typeof STAGES)[number];

/** Mirror of the transition table in commercial_apply_stage (SQL is authoritative). */
const TRANSITIONS: Record<Stage, Stage[]> = {
  draft: ["sent", "paid", "void"],
  blocked_needs_approval: ["sent", "void"],
  sent: ["received", "approved", "rejected", "paid", "void"],
  received: ["approved", "rejected", "paid", "void"],
  approved: ["rejected", "paid", "void"],
  rejected: ["sent", "received", "approved", "paid", "void"],
  paid: [],
  void: [],
};
export const canTransition = (from: Stage, to: Stage): boolean => from === to || TRANSITIONS[from].includes(to);

/** Stages a person can set by hand in the UI (sent/paid/void follow the invoice itself). */
export const MANUAL_STAGES: Stage[] = ["received", "approved", "rejected", "sent"];
export const manualStageOptions = (from: Stage): Stage[] => MANUAL_STAGES.filter((s) => s !== from && canTransition(from, s));

export const STAGE_LABELS: Record<Stage, string> = {
  draft: "Draft",
  blocked_needs_approval: "Blocked - needs approval",
  sent: "Sent",
  received: "Received by customer",
  approved: "Approved for payment",
  rejected: "Rejected",
  paid: "Paid",
  void: "Void",
};

export const REASON_LABELS: Record<string, string> = {
  missing_po: "No PO / work-order approval on file",
  over_approved_amount: "Total exceeds the approved amount (NTE)",
  missing_completion_proof: "No completion photo or customer signature",
};

/** Idempotency key for one ladder step, used in logs and tests. */
export const followupKey = (invoiceId: string, kind: "reminder" | "demand_draft", stepDay: number) =>
  `${invoiceId}:${kind}:${stepDay}`;
