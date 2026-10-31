// supabase/functions/_shared/pilot-outcomes/engine.ts
//
// Pilot outcome measurement — pure engine (no Deno / network / DOM). Shared by the edge function
// (sync + weekly email), the Pilot Results page and the tests, so every surface shows the same numbers.
// Money is integer cents. Nothing here guesses: no attribution => the money is not counted.

import { attribute, formatMoney, type LedgerEvent } from "../money-recovered/engine.ts";

export const PILOT_METHOD_VERSION = "pilot-attr-v1";
export const PILOT_EMAIL_TEMPLATE_VERSION = "pilot-weekly-v1";

const DAY_MS = 86_400_000;
const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const cents = (n: number | null | undefined): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0);

// ------------------------------------------------------------------ attribution

export interface ClaimActionInput {
  id: string;
  claim_id: string;
  action_type: "status_change" | "packet_exported" | "reminder_sent" | "credit_recorded";
  to_status: string | null;
  amount_cents: number | null;
  occurred_at: string;
}

export interface ClaimInput {
  id: string;
  job_id: string | null;
  status: string;
  created_at: string;
  submitted_at: string | null;
  credit_received_cents: number | null;
  credit_received_at: string | null;
}

export type NotCountedReason =
  | "no_credit_event" | "before_pilot" | "no_preceding_action"
  | "no_invoice_link" | "no_resolution" | "owner_reported" | "no_documented_follow_up"
  | "follow_up_too_old" | "follow_up_after_recovery" | "no_amount";

export type PilotAttribution =
  | {
      counted: true; amountCents: number; recoveredAt: string;
      action: { id: string | null; type: "packet_exported" | "status_change" | "reminder_sent" | "follow_up"; at: string };
    }
  | { counted: false; reason: NotCountedReason };

/** Status changes that count as "Vireek-driven progress" on a claim. */
const QUALIFYING_STATUS = new Set(["packet_pending", "submitted", "approved"]);

/**
 * A claim credit is counted only if: a credit_recorded event exists with an amount, it happened at or
 * after the baseline, and a qualifying action (packet exported / reminder / status change to
 * packet_pending|submitted|approved) happened at or after the baseline and STRICTLY before the credit.
 * The latest such action is the one recorded.
 */
export function attributeClaim(claim: ClaimInput, actions: ClaimActionInput[], baselineAt: string): PilotAttribution {
  const base = toMs(baselineAt);
  if (base === null) return { counted: false, reason: "before_pilot" };
  const own = actions.filter((a) => a.claim_id === claim.id);
  const credits = own
    .filter((a) => a.action_type === "credit_recorded" && cents(a.amount_cents) > 0 && toMs(a.occurred_at) !== null)
    .sort((a, b) => (toMs(a.occurred_at) as number) - (toMs(b.occurred_at) as number));
  const credit = credits[0];
  if (!credit) return { counted: false, reason: "no_credit_event" };
  const creditMs = toMs(credit.occurred_at) as number;
  if (creditMs < base) return { counted: false, reason: "before_pilot" };

  let best: ClaimActionInput | null = null;
  for (const a of own) {
    const t = toMs(a.occurred_at);
    if (t === null || t < base || t >= creditMs) continue;
    const ok = a.action_type === "packet_exported" || a.action_type === "reminder_sent" ||
      (a.action_type === "status_change" && QUALIFYING_STATUS.has(a.to_status ?? ""));
    if (!ok) continue;
    if (!best || t > (toMs(best.occurred_at) as number)) best = a;
  }
  if (!best) return { counted: false, reason: "no_preceding_action" };
  return {
    counted: true, amountCents: cents(credit.amount_cents), recoveredAt: credit.occurred_at,
    action: { id: best.id, type: best.action_type as "packet_exported" | "status_change" | "reminder_sent", at: best.occurred_at },
  };
}

/**
 * Ledger events reuse the existing conservative-v1 rule (attribute()). On top of it the money must be
 * linked to a PAID invoice (via recovered_job_id) and have been resolved at or after the baseline.
 */
export function attributeLedgerEvent(e: LedgerEvent, invoiceId: string | null, baselineAt: string): PilotAttribution {
  const base = toMs(baselineAt);
  const resolved = toMs(e.resolved_at);
  if (base === null || resolved === null) return { counted: false, reason: "no_resolution" };
  if (resolved < base) return { counted: false, reason: "before_pilot" };
  const a = attribute(e);
  if (!a.claimed) return { counted: false, reason: a.reason };
  if (!invoiceId) return { counted: false, reason: "no_invoice_link" };
  return {
    counted: true, amountCents: a.creditedCents, recoveredAt: e.resolved_at as string,
    action: { id: null, type: "follow_up", at: e.last_follow_up_at as string },
  };
}

// ------------------------------------------------------------------ fee (display only)

/** floor(cents * bps / 10000), integer math. Display only — nothing in this codebase charges it. */
export function computeFeeCents(attributedCents: number, feeBps: number): number {
  const c = cents(attributedCents);
  const b = Math.min(10_000, cents(feeBps));
  return Math.floor((c * b) / 10_000);
}

// ------------------------------------------------------------------ results

export interface BaselineRow {
  captured_at: string; window_start: string; window_end: string;
  eligible_jobs_count: number; claims_filed_count: number; claims_paid_count: number; claims_paid_cents: number;
  unfiled_eligible_estimate_cents: number; qb_findings_count: number | null; qb_findings_cents: number | null;
  admin_hours_per_week: number;
}
export interface SettingsRow { current_admin_hours_per_week: number | null; fee_bps: number }
export interface AttributionRow {
  source_type: "warranty_claim" | "recovery_event"; source_id: string; claim_id: string | null; invoice_id: string | null;
  job_id: string | null; amount_cents: number; action_type: string; action_at: string; recovered_at: string;
}
export interface EligibleJobRow { job_id: string; invoice_amount: number | null; completed_at: string | null }

export const OPEN_STATUSES = ["eligible", "packet_pending", "submitted", "approved"] as const;
const FILED_STATUSES = new Set(["submitted", "approved", "denied", "credit_received", "closed"]);
export const AGING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface PilotResults {
  hasBaseline: boolean;
  baseline: BaselineRow | null;
  pilotDays: number;
  recovered: { cents: number; count: number; warrantyCents: number; ledgerCents: number };
  now: {
    claimsFiledSinceBaseline: number; claimsPaidSinceBaseline: number;
    unfiledEligibleEstimateCents: number; unfiledEligibleJobs: number;
  };
  /** Monthly rates normalised to 30 days — an ESTIMATE because the two windows differ in length. */
  monthlyEstimate: { baselineFiled: number | null; nowFiled: number | null };
  hours: { baselinePerWeek: number | null; currentPerWeek: number | null; savedPerWeek: number | null; source: "manual" };
  claimsByStatus: Record<string, { count: number; cents: number }>;
  aging: Record<AgingBucket, number>;
  findings: { available: false; note: string };
  fee: { bps: number; cents: number; displayOnly: true };
}

const bucketOf = (days: number): AgingBucket => (days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+");

export function buildPilotResults(input: {
  nowIso: string; baseline: BaselineRow | null; settings: SettingsRow | null; claims: ClaimInput[];
  attributions: AttributionRow[]; eligibleUnfiled: EligibleJobRow[];
}): PilotResults {
  const now = toMs(input.nowIso) ?? Date.now();
  const b = input.baseline;
  const baseMs = b ? toMs(b.captured_at) : null;

  let warrantyCents = 0, ledgerCents = 0;
  for (const a of input.attributions) {
    if (a.source_type === "warranty_claim") warrantyCents += cents(a.amount_cents);
    else ledgerCents += cents(a.amount_cents);
  }
  const total = warrantyCents + ledgerCents;

  const claimsByStatus: Record<string, { count: number; cents: number }> = {};
  const aging: Record<AgingBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  let filed = 0, paid = 0;
  for (const c of input.claims) {
    const s = (claimsByStatus[c.status] ??= { count: 0, cents: 0 });
    s.count += 1;
    s.cents += cents(c.credit_received_cents);
    if ((OPEN_STATUSES as readonly string[]).includes(c.status)) {
      const created = toMs(c.created_at);
      if (created !== null) aging[bucketOf(Math.max(0, Math.floor((now - created) / DAY_MS)))] += 1;
    }
    if (baseMs !== null) {
      const filedAt = toMs(c.submitted_at ?? c.created_at);
      if (FILED_STATUSES.has(c.status) && filedAt !== null && filedAt >= baseMs) filed += 1;
      const paidAt = toMs(c.credit_received_at ?? c.created_at);
      if (cents(c.credit_received_cents) > 0 && paidAt !== null && paidAt >= baseMs) paid += 1;
    }
  }

  const windowStart = now - 183 * DAY_MS;
  const seen = new Set<string>();
  let unfiledCents = 0;
  for (const j of input.eligibleUnfiled) {
    const t = toMs(j.completed_at);
    if (t === null || t < windowStart || seen.has(j.job_id)) continue;
    seen.add(j.job_id);
    unfiledCents += Math.max(0, Math.round((Number.isFinite(j.invoice_amount) ? (j.invoice_amount as number) : 0) * 100));
  }

  const pilotDays = baseMs === null ? 0 : Math.max(0, Math.floor((now - baseMs) / DAY_MS));
  const baseDays = b ? Math.max(1, Math.round(((toMs(b.window_end) ?? 0) - (toMs(b.window_start) ?? 0)) / DAY_MS)) : 0;
  const cur = input.settings?.current_admin_hours_per_week ?? null;
  const baseHours = b ? Number(b.admin_hours_per_week) : null;
  const feeBps = input.settings?.fee_bps ?? 0;

  return {
    hasBaseline: !!b, baseline: b, pilotDays,
    recovered: { cents: total, count: input.attributions.length, warrantyCents, ledgerCents },
    now: { claimsFiledSinceBaseline: filed, claimsPaidSinceBaseline: paid, unfiledEligibleEstimateCents: unfiledCents, unfiledEligibleJobs: seen.size },
    monthlyEstimate: {
      baselineFiled: b && baseDays > 0 ? Math.round((b.claims_filed_count / baseDays) * 30 * 10) / 10 : null,
      nowFiled: b && pilotDays >= 7 ? Math.round((filed / pilotDays) * 30 * 10) / 10 : null,
    },
    hours: {
      baselinePerWeek: baseHours, currentPerWeek: cur, source: "manual",
      savedPerWeek: baseHours !== null && cur !== null ? Math.round((baseHours - cur) * 100) / 100 : null,
    },
    claimsByStatus, aging,
    findings: { available: false, note: "QuickBooks reconciliation findings are not installed in this account yet." },
    fee: { bps: feeBps, cents: computeFeeCents(total, feeBps), displayOnly: true },
  };
}

// ------------------------------------------------------------------ CSV

/** Integer-only dollars string, e.g. 123456 -> "1234.56". */
export function centsToDecimal(c: number): string {
  const v = cents(c);
  return `${Math.trunc(v / 100)}.${String(v % 100).padStart(2, "0")}`;
}

function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function attributionsToCsv(rows: AttributionRow[]): string {
  const head = ["source_type", "source_id", "claim_id", "invoice_id", "job_id", "amount", "preceding_action", "action_at", "recovered_at", "method"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      r.source_type, r.source_id, r.claim_id, r.invoice_id, r.job_id, centsToDecimal(r.amount_cents),
      r.action_type, r.action_at, r.recovered_at, PILOT_METHOD_VERSION,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ weekly email (template pilot-weekly-v1)

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPilotEmail(opts: {
  companyName: string; results: PilotResults; currency: string; periodLabel: string; siteUrl: string; subjectPrefix?: string;
}): { subject: string; html: string; text: string } {
  const r = opts.results, m = (c: number) => formatMoney(c, opts.currency);
  const hours = r.hours.savedPerWeek === null ? "not entered yet" : `${r.hours.savedPerWeek} h/week (manual entry)`;
  const rows: [string, string][] = [
    ["Recovered (attributed)", m(r.recovered.cents)],
    ["Claims filed since pilot start", String(r.now.claimsFiledSinceBaseline)],
    ["Claims paid since pilot start", String(r.now.claimsPaidSinceBaseline)],
    ["Unfiled eligible value (estimate)", m(r.now.unfiledEligibleEstimateCents)],
    ["Admin hours saved", hours],
    ["Vireek fee (display only, not billed)", m(r.fee.cents)],
  ];
  const subject = `${opts.subjectPrefix ?? ""}Pilot results — ${opts.companyName} — ${opts.periodLabel}`;
  const url = `${opts.siteUrl}/dashboard/pilot-results`;
  const text = [`Pilot results — ${opts.companyName} (${opts.periodLabel})`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "",
    "Only money with a logged preceding action is counted. Items marked estimate are not DB totals.", url].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>Pilot results</h2><p>${esc(opts.companyName)} · ${esc(opts.periodLabel)}</p>` +
    `<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
      `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right"><b>${esc(v)}</b></td></tr>`).join("")}</table>` +
    `<p style="color:#666;font-size:12px">Only money with a logged preceding action is counted. Items marked “estimate” are not database totals.</p>` +
    `<p><a href="${esc(url)}">Open Pilot Results</a></p></div>`;
  return { subject, html, text };
}
