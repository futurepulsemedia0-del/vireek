// supabase/functions/_shared/pilot-results/engine.ts
//
// Pilot Results — pure helpers (no Deno / network / DOM). Shared by the dashboard page, the weekly
// Money Recovered email and the tests. It NEVER computes business numbers: every figure arrives from
// the database (pilot_results RPC). This file only validates the payload, compares baseline vs now,
// calculates the display-only fee, escapes CSV and renders the email block.

import { formatMoney } from "../money-recovered/engine.ts";

export interface PilotFigures {
  unclaimed_warranty_cents: number;
  unclaimed_warranty_jobs: number;
  claims_filed_6m: number;
  claims_paid_6m: number;
  claims_paid_cents_6m: number;
  overdue60_cents: number;
  overdue60_count: number;
  avg_days_to_pay_commercial: number | null;
  avg_days_sample: number;
}

export interface PilotAttributionRow {
  kind: "warranty_claim" | "invoice";
  ref_id: string;
  ref_label: string;
  amount_cents: number;
  recovered_on: string;
  action_kind: "packet_sent" | "approval_attached" | "reminder" | null;
  action_on: string | null;
  counted: boolean;
  reason: string | null;
}

export interface StatusBucket { count: number; cents: number }

export interface PilotResults {
  started_at: string;
  generated_at: string;
  fee_pct: number | null;
  baseline: PilotFigures;
  now: PilotFigures;
  estimate_fields: string[];
  recovered: {
    counted_cents: number; counted_count: number;
    not_counted_cents: number; not_counted_count: number;
    rows: PilotAttributionRow[];
  };
  hours_minutes: number;
  claims_by_status: Record<string, StatusBucket>;
  invoices_by_status: Record<string, StatusBucket>;
}

const ACTIONS = ["packet_sent", "approval_attached", "reminder"];
export const ACTION_LABELS: Record<string, string> = {
  packet_sent: "Packet sent",
  approval_attached: "Approval attached",
  reminder: "Reminder sent",
};

const int = (v: unknown): number => (typeof v === "number" || typeof v === "string") && Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0;
const nullableNum = (v: unknown): number | null => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

function figures(raw: unknown): PilotFigures {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    unclaimed_warranty_cents: int(o.unclaimed_warranty_cents),
    unclaimed_warranty_jobs: int(o.unclaimed_warranty_jobs),
    claims_filed_6m: int(o.claims_filed_6m),
    claims_paid_6m: int(o.claims_paid_6m),
    claims_paid_cents_6m: int(o.claims_paid_cents_6m),
    overdue60_cents: int(o.overdue60_cents),
    overdue60_count: int(o.overdue60_count),
    avg_days_to_pay_commercial: nullableNum(o.avg_days_to_pay_commercial),
    avg_days_sample: int(o.avg_days_sample),
  };
}

function buckets(raw: unknown): Record<string, StatusBucket> {
  const out: Record<string, StatusBucket> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const b = (v ?? {}) as Record<string, unknown>;
      out[k] = { count: int(b.count), cents: int(b.cents) };
    }
  }
  return out;
}

/** Returns null when the pilot has not started or the payload is not usable. */
export function parsePilotResults(raw: unknown): PilotResults | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.started !== true || typeof o.started_at !== "string") return null;
  const rec = (o.recovered && typeof o.recovered === "object" ? o.recovered : {}) as Record<string, unknown>;
  const rows: PilotAttributionRow[] = (Array.isArray(rec.rows) ? rec.rows : []).flatMap((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    if (x.kind !== "warranty_claim" && x.kind !== "invoice") return [];
    const action = typeof x.action_kind === "string" && ACTIONS.includes(x.action_kind) ? x.action_kind : null;
    // The database already decides `counted`; we additionally refuse to count anything without an action.
    return [{
      kind: x.kind, ref_id: String(x.ref_id ?? ""), ref_label: String(x.ref_label ?? ""),
      amount_cents: int(x.amount_cents), recovered_on: String(x.recovered_on ?? ""),
      action_kind: action as PilotAttributionRow["action_kind"],
      action_on: typeof x.action_on === "string" ? x.action_on : null,
      counted: x.counted === true && action !== null,
      reason: typeof x.reason === "string" ? x.reason : null,
    }];
  });
  const counted = rows.filter((r) => r.counted);
  const feeRaw = nullableNum(o.fee_pct);
  return {
    started_at: o.started_at,
    generated_at: typeof o.generated_at === "string" ? o.generated_at : "",
    fee_pct: feeRaw !== null && feeRaw >= 0 && feeRaw <= 100 ? feeRaw : null,
    baseline: figures(o.baseline),
    now: figures(o.now),
    estimate_fields: Array.isArray(o.estimate_fields) ? o.estimate_fields.map(String) : [],
    recovered: {
      // Totals come from the database (rows are capped at 500); never lower than what the visible rows prove.
      counted_cents: Math.max(int(rec.counted_cents), rows.length < 500 ? counted.reduce((s, r) => s + r.amount_cents, 0) : 0),
      counted_count: int(rec.counted_count),
      not_counted_cents: int(rec.not_counted_cents),
      not_counted_count: int(rec.not_counted_count),
      rows,
    },
    hours_minutes: int(o.hours_minutes),
    claims_by_status: buckets(o.claims_by_status),
    invoices_by_status: buckets(o.invoices_by_status),
  };
}

// ------------------------------------------------------------------ comparison

export interface CompareRow {
  key: string;
  label: string;
  kind: "money" | "count" | "days";
  baseline: number | null;
  now: number | null;
  /** change = now - baseline; null when either side has no data. */
  delta: number | null;
  /** "better" | "worse" | "same" | "no_data" */
  trend: "better" | "worse" | "same" | "no_data";
  estimate: boolean;
}

// higherIsBetter: true for money/claims won, false for money stuck.
const DEFS: { key: keyof PilotFigures; label: string; kind: CompareRow["kind"]; higherIsBetter: boolean }[] = [
  { key: "unclaimed_warranty_cents", label: "Unclaimed warranty-eligible $", kind: "money", higherIsBetter: false },
  { key: "claims_filed_6m", label: "Warranty claims filed (6 mo)", kind: "count", higherIsBetter: true },
  { key: "claims_paid_6m", label: "Warranty claims paid (6 mo)", kind: "count", higherIsBetter: true },
  { key: "overdue60_cents", label: "Invoices > 60 days, $", kind: "money", higherIsBetter: false },
  { key: "overdue60_count", label: "Invoices > 60 days, count", kind: "count", higherIsBetter: false },
  { key: "avg_days_to_pay_commercial", label: "Avg days-to-pay (commercial)", kind: "days", higherIsBetter: false },
];

export function compareFigures(baseline: PilotFigures, now: PilotFigures, estimateFields: string[] = []): CompareRow[] {
  return DEFS.map((d) => {
    const b = baseline[d.key] as number | null;
    const n = now[d.key] as number | null;
    const delta = b === null || n === null ? null : Math.round((n - b) * 100) / 100;
    const trend: CompareRow["trend"] = delta === null ? "no_data" : delta === 0 ? "same" : (delta > 0) === d.higherIsBetter ? "better" : "worse";
    return { key: d.key, label: d.label, kind: d.kind, baseline: b, now: n, delta, trend, estimate: estimateFields.includes(d.key) };
  });
}

export function formatValue(row: Pick<CompareRow, "kind">, v: number | null, currency = "USD"): string {
  if (v === null) return "No data";
  if (row.kind === "money") return formatMoney(v, currency);
  if (row.kind === "days") return `${v.toFixed(1)} days`;
  return String(v);
}

// ------------------------------------------------------------------ fee (display only, never charged)

/** Integer basis-point math so 7.25% of $1,234.56 never suffers float drift. Returns null when no % is set. */
export function computeFee(countedCents: number, feePct: number | null): number | null {
  if (feePct === null || !Number.isFinite(feePct) || feePct < 0 || feePct > 100) return null;
  const c = Math.max(0, Math.trunc(countedCents));
  return Math.round((c * Math.round(feePct * 100)) / 10000);
}

export const hoursLabel = (minutes: number): string => `${(Math.max(0, minutes) / 60).toFixed(1)} h`;

// ------------------------------------------------------------------ CSV

/** Neutralizes spreadsheet formula injection (=, +, -, @, tab, CR) and quotes when needed. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsToCsv(p: PilotResults): string {
  const head = ["section", "item", "baseline", "now", "reference", "amount_usd", "recovered_on", "action", "action_on", "counted", "note"];
  const lines: unknown[][] = [head];
  for (const r of compareFigures(p.baseline, p.now, p.estimate_fields)) {
    const f = (v: number | null) => v === null ? "" : r.kind === "money" ? (v / 100).toFixed(2) : v;
    lines.push(["baseline_vs_now", r.label, f(r.baseline), f(r.now), "", "", "", "", "", "", r.estimate ? "estimate" : ""]);
  }
  for (const r of p.recovered.rows) {
    lines.push(["recovery", r.kind, "", "", r.ref_label, (r.amount_cents / 100).toFixed(2), r.recovered_on,
      r.action_kind ? ACTION_LABELS[r.action_kind] : "", r.action_on ?? "", r.counted ? "yes" : "no", r.counted ? "" : "not counted: no preceding action"]);
  }
  lines.push(["totals", "recovered_counted", "", "", "", (p.recovered.counted_cents / 100).toFixed(2), "", "", "", "", ""]);
  lines.push(["totals", "hours_manual_entry", "", "", "", "", "", "", "", "", (p.hours_minutes / 60).toFixed(1)]);
  const fee = computeFee(p.recovered.counted_cents, p.fee_pct);
  lines.push(["totals", "fee_display_only", "", "", "", fee === null ? "" : (fee / 100).toFixed(2), "", "", "", "", "not charged automatically"]);
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ email block

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderPilotBlock(p: PilotResults, currency: string, pageUrl: string): { html: string; text: string } {
  const rows = compareFigures(p.baseline, p.now, p.estimate_fields);
  const fee = computeFee(p.recovered.counted_cents, p.fee_pct);
  const label = (r: CompareRow) => `${r.label}${r.estimate ? " (estimate)" : ""}`;
  const td = "padding:8px 4px;border-bottom:1px solid #eeeef2";
  const html = `<h2 style="margin:18px 0 8px;font-size:15px;color:#171717">Pilot results</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">
<tr><th align="left" style="${td}">Metric</th><th align="right" style="${td}">Baseline</th><th align="right" style="${td}">Now</th></tr>
${rows.map((r) => `<tr><td style="${td}">${esc(label(r))}</td><td align="right" style="${td}">${esc(formatValue(r, r.baseline, currency))}</td><td align="right" style="${td};font-weight:600">${esc(formatValue(r, r.now, currency))}</td></tr>`).join("")}
<tr><td style="${td}">Recovered $ with documented action</td><td align="right" style="${td}">—</td><td align="right" style="${td};font-weight:700">${esc(formatMoney(p.recovered.counted_cents, currency))} (${p.recovered.counted_count})</td></tr>
<tr><td style="${td}">Not counted (no preceding action)</td><td align="right" style="${td}">—</td><td align="right" style="${td}">${esc(formatMoney(p.recovered.not_counted_cents, currency))} (${p.recovered.not_counted_count})</td></tr>
<tr><td style="${td}">Hours spent (manual entry)</td><td align="right" style="${td}">—</td><td align="right" style="${td}">${esc(hoursLabel(p.hours_minutes))}</td></tr>
${fee === null ? "" : `<tr><td style="${td}">Fee at ${esc(p.fee_pct)}% (display only, never charged automatically)</td><td align="right" style="${td}">—</td><td align="right" style="${td}">${esc(formatMoney(fee, currency))}</td></tr>`}
</table><p style="margin:8px 0 0;font-size:12px"><a href="${esc(pageUrl)}" style="color:#203ad8">Open Pilot Results</a></p>`;
  const text = [
    "Pilot results (baseline -> now):",
    ...rows.map((r) => `  ${label(r)}: ${formatValue(r, r.baseline, currency)} -> ${formatValue(r, r.now, currency)}`),
    `  Recovered with documented action: ${formatMoney(p.recovered.counted_cents, currency)} (${p.recovered.counted_count})`,
    `  Not counted (no preceding action): ${formatMoney(p.recovered.not_counted_cents, currency)} (${p.recovered.not_counted_count})`,
    `  Hours spent (manual entry): ${hoursLabel(p.hours_minutes)}`,
    ...(fee === null ? [] : [`  Fee at ${p.fee_pct}% (display only, never charged automatically): ${formatMoney(fee, currency)}`]),
    `  ${pageUrl}`, "",
  ].join("\n");
  return { html, text };
}
