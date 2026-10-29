/**
 * Pay application PDF: page 1 = G702-style "Application and Certificate for
 * Payment" (portrait), following pages = G703-style continuation sheet
 * (landscape, repeats its header on every page, totals on the last).
 *
 * Vector text only; jsPDF is loaded on demand so it never bloats the main
 * bundle. Every figure comes from calculateApplication() and is cross-checked
 * with reconcile() — the generator refuses to render numbers that do not
 * reconcile to the cent.
 *
 * AIA® and G702/G703 are marks of The American Institute of Architects. This is
 * a document in the same format, not an official AIA form, and says so in the
 * footer.
 */

import type { jsPDF } from 'jspdf';
import { formatDate, formatMoney } from '@/lib/installProjects';
import { calculateApplication, reconcile, type PayApp, type PayAppLine } from '@/lib/payApps';

const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const ACCENT: [number, number, number] = [32, 58, 216];
const LINE: [number, number, number] = [210, 210, 220];
const SHADE: [number, number, number] = [244, 245, 250];
const DANGER: [number, number, number] = [200, 55, 55];
const WATERMARK: [number, number, number] = [238, 238, 244];

const PORTRAIT = { w: 612, h: 792 };
const LANDSCAPE = { w: 792, h: 612 };
const M = 36;

export interface PayAppPdfInput {
  contractorName: string | null;
  project: { name: string; project_number: string | null; customer_name: string; site_address: string | null };
  app: Pick<PayApp, 'application_no' | 'status' | 'period_to' | 'application_date' | 'retainage_percent' | 'retainage_release_cents' | 'notes'>;
  lines: PayAppLine[];
  previousCertificatesCents: number;
}

function fit(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let s = text;
  while (s.length > 1 && doc.getTextWidth(`${s}…`) > width) s = s.slice(0, -1);
  return `${s}…`;
}

const pct = (n: number) => `${n.toFixed(2)}%`;

export async function generatePayAppPdf(input: PayAppPdfInput): Promise<Blob> {
  const calc = calculateApplication({
    lines: input.lines,
    retainagePercent: input.app.retainage_percent,
    retainageReleaseCents: input.app.retainage_release_cents,
    previousCertificatesCents: input.previousCertificatesCents,
  });
  const problems = reconcile(calc);
  if (problems.length) throw new Error(`Pay application does not reconcile: ${problems.join('; ')}`);
  const t = calc.totals;

  const { jsPDF: PDF } = await import('jspdf');
  const doc = new PDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const status = input.app.status;
  const mark = status === 'draft' ? 'DRAFT' : status === 'void' ? 'VOID' : null;

  const watermark = (pw: number, ph: number) => {
    if (!mark) return;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(110);
    doc.setTextColor(...WATERMARK);
    doc.text(mark, pw / 2, ph / 2 + 40, { align: 'center', angle: 35 });
  };

  const label = `Pay Application #${input.app.application_no}`;
  const projectLine = [input.project.project_number, input.project.name].filter(Boolean).join(' · ');

  // ------------------------------------------------------------------
  // Page 1 — G702 summary (portrait)
  // ------------------------------------------------------------------
  let W = PORTRAIT.w;
  let CW = W - M * 2;
  watermark(PORTRAIT.w, PORTRAIT.h);

  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 6, 'F');
  let y = 38;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(...INK);
  doc.text('Application and Certificate for Payment', M, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  doc.text(`${label}  ·  G702-style summary`, M, y + 14);
  if (mark) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...(status === 'void' ? DANGER : MUTED));
    doc.text(status === 'draft' ? 'DRAFT — NOT ISSUED' : 'VOID', W - M, y, { align: 'right' });
  }
  y += 34;

  const info: [string, string][] = [
    ['To (owner)', input.project.customer_name || '—'],
    ['Project', projectLine || '—'],
    ['Site', input.project.site_address || '—'],
    ['From (contractor)', input.contractorName || '—'],
    ['Application no.', String(input.app.application_no)],
    ['Period to', formatDate(input.app.period_to)],
    ['Application date', formatDate(input.app.application_date)],
    ['Retainage rate', `${input.app.retainage_percent}%`],
  ];
  const colW = CW / 2;
  doc.setFontSize(8.5);
  info.forEach(([k, v], i) => {
    const x = M + (i % 2) * colW;
    const yy = y + Math.floor(i / 2) * 15;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...MUTED);
    doc.text(`${k}:`, x, yy);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    doc.text(fit(doc, v, colW - 100), x + 90, yy);
  });
  y += Math.ceil(info.length / 2) * 15 + 12;

  doc.setDrawColor(...LINE);
  doc.line(M, y, W - M, y);
  y += 20;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...ACCENT);
  doc.text("CONTRACTOR'S APPLICATION FOR PAYMENT", M, y);
  y += 10;

  const summary: { n: string; text: string; cents: number; strong?: boolean; sub?: boolean }[] = [
    { n: '1', text: 'Original contract sum', cents: t.originalContractCents },
    { n: '2', text: 'Net change by change orders', cents: t.changeOrdersCents },
    { n: '3', text: 'Contract sum to date (line 1 ± 2)', cents: t.contractToDateCents, strong: true },
    { n: '4', text: 'Total completed & stored to date (G703 column G)', cents: t.completedStoredCents },
    { n: '5', text: `Retainage at ${input.app.retainage_percent}% of the project's rate`, cents: t.totalRetainageCents },
    { n: 'a', text: 'Of completed work (columns D + E)', cents: t.retainageWorkCents, sub: true },
    { n: 'b', text: 'Of stored material (column F)', cents: t.retainageStoredCents, sub: true },
    ...(t.retainageReleasedCents > 0 ? [{ n: '', text: 'Less retainage released this application', cents: -t.retainageReleasedCents, sub: true }] : []),
    { n: '6', text: 'Total earned less retainage (line 4 less line 5)', cents: t.earnedLessRetainageCents, strong: true },
    { n: '7', text: 'Less previous certificates for payment', cents: t.previousCertificatesCents },
    { n: '8', text: 'CURRENT PAYMENT DUE', cents: t.currentPaymentDueCents, strong: true },
    { n: '9', text: 'Balance to finish, including retainage (line 3 less line 6)', cents: t.balanceToFinishCents },
  ];
  y += 8;
  summary.forEach((row, i) => {
    const h = row.strong ? 24 : 19;
    if (row.strong) {
      doc.setFillColor(...SHADE);
      doc.rect(M, y - 13, CW, h, 'F');
    } else if (i % 2 === 1 && !row.sub) {
      doc.setDrawColor(...LINE);
      doc.line(M, y + 6, W - M, y + 6);
    }
    doc.setFont('helvetica', row.strong ? 'bold' : 'normal');
    doc.setFontSize(row.strong ? 10.5 : 9.5);
    doc.setTextColor(...(row.sub ? MUTED : INK));
    if (row.n) doc.text(row.n, M + (row.sub ? 22 : 8), y);
    doc.text(row.text, M + (row.sub ? 34 : 24), y);
    doc.text(formatMoney(row.cents), W - M - 8, y, { align: 'right' });
    y += h - 2;
  });

  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  const reconNote = `Reconciliation: line 9 = G703 balance to finish (${formatMoney(t.balanceCents)}) + retainage held (${formatMoney(t.totalRetainageCents)}).`;
  doc.text(fit(doc, reconNote, CW), M, y);
  y += 12;
  if (input.app.notes) {
    const wrapped = doc.splitTextToSize(`Notes: ${input.app.notes}`, CW) as string[];
    doc.text(wrapped.slice(0, 6), M, y);
    y += Math.min(wrapped.length, 6) * 10 + 6;
  }

  y = Math.max(y + 14, 560);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...INK);
  doc.text("Contractor's certification", M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  const cert = doc.splitTextToSize(
    'The undersigned contractor certifies that, to the best of the contractor’s knowledge, the work covered by this application has been completed in accordance with the contract documents, that all amounts have been paid for work for which previous certificates for payment were issued, and that the current payment shown is now due.',
    CW,
  ) as string[];
  doc.text(cert, M, y + 12);
  const sigY = y + 12 + cert.length * 10 + 30;
  doc.setDrawColor(...INK);
  doc.line(M, sigY, M + 250, sigY);
  doc.line(M + 290, sigY, M + 380, sigY);
  doc.line(W - M - 130, sigY, W - M, sigY);
  doc.setFontSize(7.5);
  doc.text('Contractor signature', M, sigY + 10);
  doc.text('Date', M + 290, sigY + 10);
  doc.text('Amount certified', W - M - 130, sigY + 10);
  doc.text('Owner / architect signature', M, sigY + 38);
  doc.line(M, sigY + 28, M + 250, sigY + 28);
  doc.line(M + 290, sigY + 28, M + 380, sigY + 28);

  // ------------------------------------------------------------------
  // Pages 2+ — G703 continuation sheet (landscape)
  // ------------------------------------------------------------------
  W = LANDSCAPE.w;
  CW = W - M * 2;
  const H = LANDSCAPE.h;
  const cols = [
    { k: 'A', h: 'Item', w: 34, a: 'left' as const },
    { k: 'B', h: 'Description of work', w: 196, a: 'left' as const },
    { k: 'C', h: 'Scheduled value', w: 72, a: 'right' as const },
    { k: 'D', h: 'From previous', w: 72, a: 'right' as const },
    { k: 'E', h: 'This period', w: 72, a: 'right' as const },
    { k: 'F', h: 'Stored materials', w: 72, a: 'right' as const },
    { k: 'G', h: 'Completed & stored', w: 76, a: 'right' as const },
    { k: '%', h: '% (G ÷ C)', w: 40, a: 'right' as const },
    { k: 'H', h: 'Balance to finish', w: 72, a: 'right' as const },
  ];
  const scale = CW / cols.reduce((s, c) => s + c.w, 0);
  const widths = cols.map((c) => c.w * scale);
  const xs: number[] = [];
  widths.reduce((acc, w, i) => ((xs[i] = acc), acc + w), M);

  const startLandscape = () => {
    doc.addPage('letter', 'landscape');
    watermark(LANDSCAPE.w, LANDSCAPE.h);
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, W, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    doc.text('Continuation Sheet — Schedule of Values', M, 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(fit(doc, `${label}  ·  ${projectLine}  ·  Period to ${formatDate(input.app.period_to)}`, CW), M, 43);
    return 56;
  };

  const header = (top: number) => {
    doc.setFillColor(...SHADE);
    doc.rect(M, top, CW, 26, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    cols.forEach((c, i) => {
      const x = c.a === 'right' ? xs[i] + widths[i] - 4 : xs[i] + 4;
      doc.text(c.k, x, top + 9, { align: c.a });
      doc.setFontSize(7);
      doc.setTextColor(...INK);
      doc.text(fit(doc, c.h, widths[i] - 6), x, top + 20, { align: c.a });
      doc.setFontSize(6.5);
      doc.setTextColor(...MUTED);
    });
    return top + 26;
  };

  const rowH = 15;
  const bottom = H - 34;
  const drawRow = (cells: string[], at: number, bold: boolean, shade: boolean) => {
    if (shade) {
      doc.setFillColor(...SHADE);
      doc.rect(M, at, CW, rowH, 'F');
    } else {
      doc.setDrawColor(...LINE);
      doc.line(M, at + rowH, M + CW, at + rowH);
    }
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...INK);
    cells.forEach((text, i) => {
      const c = cols[i];
      const x = c.a === 'right' ? xs[i] + widths[i] - 4 : xs[i] + 4;
      doc.text(c.a === 'left' ? fit(doc, text, widths[i] - 8) : text, x, at + 10.5, { align: c.a });
    });
  };

  y = header(startLandscape());
  const totalsNeeds = rowH * 2 + 10;
  input.lines.forEach((line, i) => {
    if (y + rowH > bottom) y = header(startLandscape());
    const c = calc.lines[i];
    const desc = line.change_order_ref ? `${line.description}  [${line.change_order_ref}]` : line.description;
    drawRow(
      [line.item_no, desc, formatMoney(c.scheduledCents), formatMoney(c.previousCents), formatMoney(c.thisPeriodCents), formatMoney(c.storedCents), formatMoney(c.totalCents), pct(c.percent), formatMoney(c.balanceCents)],
      y,
      false,
      false,
    );
    y += rowH;
  });
  if (y + totalsNeeds > bottom) y = header(startLandscape());
  y += 4;
  drawRow(
    ['', 'GRAND TOTAL', formatMoney(t.scheduledCents), formatMoney(t.previousCents), formatMoney(t.thisPeriodCents), formatMoney(t.storedCents), formatMoney(t.totalCents), pct(t.percent), formatMoney(t.balanceCents)],
    y,
    true,
    true,
  );
  y += rowH + 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(
    `Column D = previous D + E (stored materials are billed as work once installed). Retainage is calculated on the totals: ${formatMoney(t.totalRetainageCents)} held at ${input.app.retainage_percent}%.`,
    M,
    y,
  );

  // Footers on every page (page counts are known only now).
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const size = p === 1 ? PORTRAIT : LANDSCAPE;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('Prepared in the format of AIA Documents G702/G703. This is not an official AIA form.', M, size.h - 18);
    doc.text(`Page ${p} of ${pages}`, size.w - M, size.h - 18, { align: 'right' });
  }

  return doc.output('blob');
}

export function payAppPdfFileName(projectNumber: string | null, applicationNo: number): string {
  const base = (projectNumber || 'project').replace(/[^A-Za-z0-9_-]+/g, '-');
  return `${base}-pay-application-${String(applicationNo).padStart(2, '0')}.pdf`;
}
