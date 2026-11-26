// Invoice-outcome monthly statement PDF (Task E). jsPDF is injected (same pattern as monthlyStatement.ts).
// Every priced line prints the invoice, the logged action, the payment ids and the evidence basis, so each amount is traceable.
import { pdfSafe } from '../executive-report/pdf.ts';
import type { OutcomeSnapshot } from './outcomeStatement.ts';

// deno-lint-ignore no-explicit-any
type PdfDoc = any;
export type JsPdfCtor = new (opts: Record<string, unknown>) => PdfDoc;
type RGB = [number, number, number];

const W = 595.28, H = 841.89, M = 48, CW = W - M * 2, BOTTOM = H - 64;
const ACCENT: RGB = [32, 58, 216], INK: RGB = [23, 23, 23], MUTED: RGB = [110, 110, 120], LINE: RGB = [225, 225, 232], WARN: RGB = [154, 91, 0];

export const OUTCOME_DISCLAIMER =
  'This statement describes payments that Vireek recorded after a logged follow-up action, using the written rules summarised on the methodology page. ' +
  'It shows what happened in your own data. It does not prove that Vireek caused a payment, and it does not guarantee future results. ' +
  'You may contest any line below; contested lines are not billed until the contest is resolved.';

export const METHODOLOGY_LINES: readonly string[] = [
  'A line is billable only if all four conditions hold:',
  '1. Vireek performed a logged action on the invoice (fix, resubmit, follow-up or escalation).',
  '2. The invoice was "at risk" when that action happened: older than the at-risk threshold, or carrying an uncleared rejection. Vireek recomputes this from the invoice facts; it does not rely on a label.',
  '3. Payment arrived after the action, inside the attribution window, and after the original due date.',
  '4. A person confirmed the outcome, or the evidence chain (action, at-risk record, payment record) is complete.',
  'Never counted: invoices paid within normal terms, disputed, credited, voided, written off or marked as tests; and any amount already counted in an earlier statement.',
  'Cap, floor and maximum adjustments are shown as a separate line so lines plus adjustment always equal the outcome fee.',
  'Before/after comparisons are observational. They are labelled "insufficient data" when the sample is small or the baseline is missing.',
];

export const formatMoneyPlain = (cents: number, currency: string): string => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((Number(cents) || 0) / 100); }
  catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${currency}`; }
};

export const evidenceUrl = (baseUrl: string, statementId: string, invoiceId: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/dashboard/invoice-outcomes/${encodeURIComponent(statementId)}?invoice=${encodeURIComponent(invoiceId)}`;

export const outcomeStatementFilename = (period: string): string => `vireek-outcome-statement-${period}.pdf`;

export function buildOutcomeStatementPdf(
  JsPDF: JsPdfCtor,
  s: OutcomeSnapshot,
  opts: { statementId: string; companyName: string; baseUrl: string },
): Uint8Array {
  const money = (c: number) => pdfSafe(formatMoneyPlain(c, s.currency));
  const doc: PdfDoc = new JsPDF({ unit: 'pt', format: 'a4', compress: true });
  let y = 0;
  const text = (t: string, x: number, yy: number, size: number, rgb: RGB = INK, bold = false, o: Record<string, unknown> = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(rgb[0], rgb[1], rgb[2]); doc.text(pdfSafe(t), x, yy, o);
  };
  const wrap = (t: string, width: number, size: number): string[] => { doc.setFontSize(size); return doc.splitTextToSize(pdfSafe(t), width) as string[]; };
  const rule = (yy: number) => { doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.75); doc.line(M, yy, W - M, yy); };
  const header = () => {
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]); doc.rect(0, 0, W, 6, 'F');
    y = 46; text(opts.companyName || 'Your business', M, y, 11, ACCENT, true); y += 22;
  };
  const ensure = (need: number) => { if (y + need > BOTTOM) { doc.addPage(); header(); } };
  const paragraph = (t: string, size = 9.5, rgb: RGB = MUTED) => { for (const l of wrap(t, CW, size)) { ensure(14); text(l, M, y, size, rgb); y += 13; } };
  const row = (label: string, value: string, bold = false) => { ensure(18); text(label, M, y, 10.5, INK, bold); text(value, W - M, y, 10.5, INK, bold, { align: 'right' }); y += 17; };

  header();
  text('Invoice recovery outcome statement', M, y + 4, 20, INK, true); y += 26;
  text(`${s.period}  -  generated ${s.generatedAt.slice(0, 10)}  -  rules ${s.ruleVersion}${s.termsVersion !== null ? `  -  terms v${s.termsVersion}` : ''}`, M, y, 9.5, MUTED); y += 14;
  rule(y); y += 26;

  // Fee calculation
  const billed = s.lines.filter((l) => !l.held);
  const held = s.lines.filter((l) => l.held);
  row('Outcomes billed this month', String(billed.length));
  row('Payments recorded on those outcomes', money(billed.reduce((a, l) => a + l.recoveredCents, 0)));
  if (s.baseFeeCents > 0) row('Base fee', money(s.baseFeeCents));
  row('Outcome fee before limits', money(s.lines.reduce((a, l) => a + l.feeCents, 0)));
  if (s.adjustmentCents !== 0) row(s.adjustmentCents < 0 ? 'Limit applied (cap / monthly maximum)' : 'Minimum applied (floor)', money(s.adjustmentCents));
  rule(y - 6); y += 6;
  row('Total for this month', money(s.totalCents), true);
  if (s.zeroReason) { y += 2; paragraph(`No outcome fee this month: ${s.zeroReason.replace(/_/g, ' ')}.`, 9.5, WARN); }
  if (held.length > 0) { y += 2; paragraph(`${held.length} line(s) are contested and are excluded from billing until resolved.`, 9.5, WARN); }

  // Itemized lines
  y += 10; ensure(50); text('Itemized outcomes', M, y, 12, INK, true); y += 16;
  const cols = { inv: M, action: M + 120, pay: M + 220, basis: M + 330, amount: W - M };
  const th = () => {
    text('INVOICE', cols.inv, y, 8, MUTED, true); text('ACTION', cols.action, y, 8, MUTED, true); text('PAYMENT', cols.pay, y, 8, MUTED, true);
    text('EVIDENCE', cols.basis, y, 8, MUTED, true); text('FEE', cols.amount, y, 8, MUTED, true, { align: 'right' }); y += 6; rule(y); y += 13;
  };
  th();
  if (s.lines.length === 0) { text('No qualifying outcomes in this month.', M, y, 10, MUTED); y += 16; }
  for (const l of s.lines) {
    if (y + 30 > BOTTOM) { doc.addPage(); header(); th(); }
    const basis = l.evidence.confirmationBasis === 'human' ? 'Confirmed by a person' : l.evidence.confirmationBasis === 'evidence_chain' ? 'Complete evidence chain' : '-';
    text((wrap(l.invoiceLabel, 110, 9)[0] ?? ''), cols.inv, y, 9);
    text((l.evidence.actionId ?? '-').slice(0, 14) + (l.evidence.actionAt ? ` ${l.evidence.actionAt.slice(0, 10)}` : ''), cols.action, y, 8);
    text(l.evidence.paymentIds.join(', ').slice(0, 22), cols.pay, y, 8);
    text(l.held ? 'CONTESTED - not billed' : basis, cols.basis, y, 8, l.held ? WARN : INK);
    text(money(l.feeCents), cols.amount, y, 9, INK, false, { align: 'right' }); y += 12;
    text(`Recorded payments ${money(l.recoveredCents)}  |  ${evidenceUrl(opts.baseUrl, opts.statementId, l.invoiceId)}`, cols.inv, y, 7, MUTED); y += 14;
  }

  // Not counted
  const ex = Object.entries(s.excludedByReason);
  if (ex.length > 0) {
    y += 8; ensure(40); text('Invoices reviewed but not counted', M, y, 12, INK, true); y += 16;
    for (const [reason, n] of ex) row(reason.replace(/_/g, ' '), String(n));
  }

  // Baseline
  y += 8; ensure(60); text('Compared with your baseline', M, y, 12, INK, true); y += 16;
  const b = s.baseline;
  if (!b || b.status === 'baseline_missing') paragraph('Baseline missing: no before/after comparison is shown.', 10, INK);
  else if (b.status === 'insufficient_data') paragraph('Insufficient data: the samples are too small to compare honestly.', 10, INK);
  else {
    const f = (v: number | null, d = 1) => (v === null ? 'n/a' : v.toFixed(d));
    row(`Days to payment (n=${b.dso.baselineN} / ${b.dso.currentN})`, `${f(b.dso.baseline)} -> ${f(b.dso.current)}  [${b.dso.change.replace(/_/g, ' ')}]`);
    row(`Over-30-day receivables (n=${b.over30Ar.baselineN} / ${b.over30Ar.currentN})`, `${money(b.over30Ar.baseline ?? 0)} -> ${money(b.over30Ar.current ?? 0)}  [${b.over30Ar.change.replace(/_/g, ' ')}]`);
    row(`First-pass acceptance (n=${b.firstPass.baselineN} / ${b.firstPass.currentN})`, `${f((b.firstPass.baseline ?? 0) * 100)}% -> ${f((b.firstPass.current ?? 0) * 100)}%  [${b.firstPass.change.replace(/_/g, ' ')}]`);
    paragraph('Observational comparison only. It does not establish that Vireek caused the change.');
  }

  // Methodology page
  doc.addPage(); header();
  text('Methodology', M, y + 4, 18, INK, true); y += 28;
  for (const l of METHODOLOGY_LINES) paragraph(l, 10, INK);
  y += 10; text('Disclaimer', M, y, 12, INK, true); y += 16;
  paragraph(OUTCOME_DISCLAIMER, 10, INK);

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); text(`Page ${p} of ${pages}`, W - M, H - 30, 8, MUTED, false, { align: 'right' }); }
  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}
