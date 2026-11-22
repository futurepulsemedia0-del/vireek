// Results Plan — monthly statement: snapshot model, due-month logic, canonical JSON (for the integrity hash) and the vector PDF.
// Pure with respect to I/O. jsPDF is injected (edge: npm:jspdf, browser: dynamic import('jspdf')) exactly like money-recovered/pdf.ts.
// No price, fee, cap or threshold is defined here: every amount printed comes from stored charges / approved terms.

import { pdfSafe } from "../executive-report/pdf.ts";
import { summarize, type StatementLine, type Summary } from "./statement.ts";

export const STATEMENT_SNAPSHOT_VERSION = 1;
/** Days after month end before a statement is generated, so the 30-min billing cron and retries can settle the month. Tunable. */
export const STATEMENT_GRACE_DAYS = 2;
/** How many closed months a sweep looks back, so a missed run catches up (generation is idempotent). */
export const STATEMENT_CATCHUP_MONTHS = 3;

export interface ConfirmationTotals { asked: number; confirmed: number; denied: number; noResponse: number }

export interface StatementSnapshot {
  version: typeof STATEMENT_SNAPSHOT_VERSION;
  month: string; // YYYY-MM (UTC month of charge.verified_at, same key the billing function uses)
  currency: string;
  companyName: string;
  generatedAt: string;
  termsName: string | null;
  baseFeeCents: number;
  lines: StatementLine[];
  summary: Summary;
  confirmations: ConfirmationTotals;
  pendingAtGeneration: number;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (m: string): boolean => MONTH_RE.test(m);

export function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Closed months (newest first) that are past the grace period at `now`. */
export function dueMonths(now: Date, graceDays = STATEMENT_GRACE_DAYS, catchup = STATEMENT_CATCHUP_MONTHS): string[] {
  const current = now.toISOString().slice(0, 7);
  const out: string[] = [];
  for (let back = 1; back <= catchup + 1; back++) {
    const m = monthShift(current, -back);
    const endsAt = Date.parse(`${monthShift(m, 1)}-01T00:00:00.000Z`) + graceDays * 86_400_000;
    if (now.getTime() >= endsAt) out.push(m);
    if (out.length === catchup) break;
  }
  return out;
}

export function buildSnapshot(input: {
  month: string; currency: string; companyName: string | null; generatedAt: string; termsName: string | null;
  baseFeeCents: number; lines: readonly StatementLine[]; confirmations: ConfirmationTotals;
}): StatementSnapshot {
  if (!isMonth(input.month)) throw new Error("invalid month");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("invalid currency");
  const lines = [...input.lines].sort((a, b) => a.verifiedAt.localeCompare(b.verifiedAt) || a.chargeId.localeCompare(b.chargeId));
  return {
    version: STATEMENT_SNAPSHOT_VERSION,
    month: input.month,
    currency: input.currency,
    companyName: (input.companyName ?? "").trim().slice(0, 120),
    generatedAt: input.generatedAt,
    termsName: input.termsName,
    baseFeeCents: Math.max(0, Math.trunc(input.baseFeeCents)),
    lines,
    summary: summarize(lines, Math.max(0, Math.trunc(input.baseFeeCents)), null, null),
    confirmations: input.confirmations,
    pendingAtGeneration: lines.filter((l) => l.status === "pending" || l.status === "failed").length,
  };
}

/** Deterministic JSON (sorted keys) so the same snapshot always hashes identically. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** Runtime guard for a snapshot read back from the database before it is rendered. */
export function isSnapshot(v: unknown): v is StatementSnapshot {
  const s = v as StatementSnapshot | null;
  return !!s && s.version === STATEMENT_SNAPSHOT_VERSION && isMonth(s.month) && /^[A-Z]{3}$/.test(s.currency)
    && Array.isArray(s.lines) && !!s.summary && typeof s.summary.netCents === "number" && !!s.confirmations;
}

export const formatMoneyPlain = (cents: number, currency: string): string => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format((Number(cents) || 0) / 100); }
  catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${currency}`; }
};

export const statementFilename = (month: string): string => `vireek-results-plan-statement-${month}.pdf`;

// ------------------------------------------------------------------ PDF
// deno-lint-ignore no-explicit-any
type PdfDoc = any;
export type JsPdfCtor = new (opts: Record<string, unknown>) => PdfDoc;
type RGB = [number, number, number];
const W = 595.28, H = 841.89, M = 48, CW = W - M * 2, BOTTOM = H - 64;
const ACCENT: RGB = [32, 58, 216], INK: RGB = [23, 23, 23], MUTED: RGB = [110, 110, 120], LINE: RGB = [225, 225, 232], WARN: RGB = [154, 91, 0];
const STATUS_LABEL: Record<StatementLine["status"], string> = { pending: "Pending", posted: "Billed", voided: "Voided", credited: "Credited", failed: "Retrying" };

export function buildMonthlyStatementPdf(JsPDF: JsPdfCtor, s: StatementSnapshot): Uint8Array {
  const money = (c: number) => pdfSafe(formatMoneyPlain(c, s.currency));
  const doc: PdfDoc = new JsPDF({ unit: "pt", format: "a4", compress: true });
  let y = 0;
  const text = (t: string, x: number, yy: number, size: number, rgb: RGB = INK, bold = false, opts: Record<string, unknown> = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(rgb[0], rgb[1], rgb[2]); doc.text(pdfSafe(t), x, yy, opts);
  };
  const wrap = (t: string, width: number, size: number): string[] => { doc.setFontSize(size); return doc.splitTextToSize(pdfSafe(t), width) as string[]; };
  const rule = (yy: number) => { doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.75); doc.line(M, yy, W - M, yy); };
  const header = () => {
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]); doc.rect(0, 0, W, 6, "F");
    y = 46; text(s.companyName || "Your business", M, y, 11, ACCENT, true); y += 22;
  };
  const ensure = (need: number) => { if (y + need > BOTTOM) { doc.addPage(); header(); } };
  const paragraph = (t: string, size = 9.5, rgb: RGB = MUTED) => { for (const l of wrap(t, CW, size)) { ensure(14); text(l, M, y, size, rgb); y += 13; } };
  const row = (label: string, value: string, bold = false) => { ensure(18); text(label, M, y, 10.5, INK, bold); text(value, W - M, y, 10.5, INK, bold, { align: "right" }); y += 17; };

  header();
  text("Results Plan statement", M, y + 4, 22, INK, true); y += 26;
  text(`${s.month}  -  generated ${s.generatedAt.slice(0, 10)}${s.termsName ? `  -  terms: ${s.termsName}` : ""}`, M, y, 9.5, MUTED); y += 14;
  rule(y); y += 26;

  const sm = s.summary;
  row("Verified jobs", String(sm.verifiedJobs));
  if (s.baseFeeCents > 0) row("Base fee", money(s.baseFeeCents));
  row("Charged for verified jobs", money(sm.billedCents));
  if (sm.waivedByCapsCents > 0) row("Not charged (limits and guarantee)", money(sm.waivedByCapsCents));
  if (sm.creditedCents > 0) row("Credited", money(sm.creditedCents));
  rule(y - 6); y += 6;
  row("Total for this month", money(sm.netCents), true);
  if (sm.effectiveCostPerJobCents !== null) row("Effective cost per verified job", money(sm.effectiveCostPerJobCents));
  if (sm.valueMultiple !== null) { row("Estimated revenue on verified jobs", money(sm.estimatedRevenueCents)); paragraph(sm.revenueFormula); }
  if (s.pendingAtGeneration > 0) { y += 4; paragraph(`${s.pendingAtGeneration} charge(s) were still pending or retrying when this statement was generated. Their final amounts appear in your dashboard.`, 9.5, WARN); }

  const c = s.confirmations;
  if (c.asked > 0) {
    y += 8; ensure(40); text("Customer confirmations", M, y, 12, INK, true); y += 18;
    paragraph(`${c.asked} customer(s) were asked whether we arrived: ${c.confirmed} confirmed, ${c.denied} said no (reviewed by our team), ${c.noResponse} did not reply.`, 10, INK);
  }

  y += 10; ensure(50); text("Itemized jobs", M, y, 12, INK, true); y += 16;
  const cols = { date: M, customer: M + 64, type: M + 230, status: M + 330, amount: W - M };
  const th = () => {
    text("VERIFIED", cols.date, y, 8, MUTED, true); text("CUSTOMER", cols.customer, y, 8, MUTED, true); text("JOB TYPE", cols.type, y, 8, MUTED, true);
    text("STATUS", cols.status, y, 8, MUTED, true); text("CHARGED", cols.amount, y, 8, MUTED, true, { align: "right" }); y += 6; rule(y); y += 13;
  };
  th();
  if (s.lines.length === 0) { text("No verified jobs in this month.", M, y, 10, MUTED); y += 16; }
  for (const l of s.lines) {
    if (y + 16 > BOTTOM) { doc.addPage(); header(); th(); }
    const cust = wrap(l.customerLabel || "Customer", 156, 9)[0] ?? "";
    const type = wrap(l.jobType || "-", 92, 9)[0] ?? "";
    text(l.verifiedAt.slice(0, 10), cols.date, y, 9); text(cust, cols.customer, y, 9); text(type, cols.type, y, 9);
    text(STATUS_LABEL[l.status] ?? l.status, cols.status, y, 9, l.status === "credited" || l.status === "voided" ? MUTED : INK);
    text(money(l.amountCents), cols.amount, y, 9, INK, false, { align: "right" }); y += 15;
  }

  y += 12; ensure(70); text("How to read this statement", M, y, 11, INK, true); y += 15;
  paragraph("Each line is a job that met the published verification rules in force when it was verified. Amounts are exactly those recorded on each charge. Every charge links to its evidence chain in your dashboard, where you can open a dispute within the dispute window.");
  paragraph("This statement is a fixed snapshot taken on the generation date. Later credits or reviews are shown in your dashboard.");

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); text(`Page ${p} of ${pages}`, W - M, H - 30, 8, MUTED, false, { align: "right" }); }
  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}
