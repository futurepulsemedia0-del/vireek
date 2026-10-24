/**
 * Certified payroll PDF (landscape, WH-347-style register + statement of compliance).
 * Vector text only; jsPDF is loaded on demand so it never bloats the main bundle.
 *
 * LEGAL REVIEW REQUIRED. Many agencies require their own form or the official
 * DOL WH-347. This document is a convenience copy of the calculated data.
 */

import type { jsPDF } from 'jspdf';
import { formatHours, formatMoney, LEGAL_REVIEW_NOTICE } from '@/lib/prevailingWage';
import type { ReportSnapshot } from '@/lib/prevailingWageExport';

const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const ACCENT: [number, number, number] = [32, 58, 216];
const LINE: [number, number, number] = [210, 210, 220];
const SHADE: [number, number, number] = [244, 245, 250];
const DANGER: [number, number, number] = [200, 55, 55];

const PAGE_W = 792;
const PAGE_H = 612;
const M = 36;
const CW = PAGE_W - M * 2;

export interface PdfCertification {
  name: string;
  title: string | null;
  certifiedAt: string | null;
  status: 'draft' | 'certified' | 'void';
}

function fit(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let s = text;
  while (s.length > 1 && doc.getTextWidth(`${s}…`) > width) s = s.slice(0, -1);
  return `${s}…`;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${m}/${d}`;
}

export async function generateCertifiedPayrollPdf(snap: ReportSnapshot, payrollNumber: number, cert: PdfCertification): Promise<Blob> {
  const { jsPDF: PDF } = await import('jspdf');
  const doc = new PDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  let y = 0;

  const footer = (page: number) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(fit(doc, LEGAL_REVIEW_NOTICE, CW - 60), M, PAGE_H - 18);
    doc.text(`Page ${page}`, PAGE_W - M, PAGE_H - 18, { align: 'right' });
  };

  let page = 1;
  const newPage = () => {
    footer(page);
    doc.addPage();
    page += 1;
    y = M;
  };
  const ensure = (h: number) => {
    if (y + h > PAGE_H - 36) newPage();
  };

  // Header
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 6, 'F');
  y = 30;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...INK);
  doc.text('Certified Payroll Report', M, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  const stamp = cert.status === 'certified' ? 'CERTIFIED' : cert.status === 'void' ? 'VOID' : 'DRAFT — NOT CERTIFIED';
  doc.setTextColor(...(cert.status === 'certified' ? ACCENT : DANGER));
  doc.setFont('helvetica', 'bold');
  doc.text(stamp, PAGE_W - M, y, { align: 'right' });
  y += 16;

  const m = snap.meta;
  const info: [string, string][] = [
    ['Contractor', m.contractorName || '—'],
    ['Address', m.contractorAddress || '—'],
    ['Project', m.projectName || '—'],
    ['Location', m.projectLocation || '—'],
    ['Contract no.', m.contractNumber || '—'],
    ['Agency / prime', [m.awardingAgency, m.primeContractor].filter(Boolean).join(' / ') || '—'],
    ['Payroll no.', `${payrollNumber}${snap.meta.isFinal ? ' (FINAL)' : ''}`],
    ['Week', `${snap.weekStart} to ${snap.weekEnding}`],
    ['Wage table', [m.determinationName, m.determinationNumber, m.determinationRevision].filter(Boolean).join(' · ') || '—'],
    ['Overtime rules', m.ruleSetName || '—'],
  ];
  doc.setFontSize(8);
  const colW = CW / 2;
  info.forEach(([k, v], i) => {
    const x = M + (i % 2) * colW;
    const yy = y + Math.floor(i / 2) * 12;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...MUTED);
    doc.text(`${k}:`, x, yy);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    doc.text(fit(doc, v, colW - 90), x + 78, yy);
  });
  y += Math.ceil(info.length / 2) * 12 + 8;

  if (snap.meta.noWork) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text('No work was performed on this project during the week shown.', M, y + 10);
    y += 30;
  } else {
    // Register table
    const cols = [
      { h: 'Worker', w: 118, a: 'left' as const },
      { h: 'Classification', w: 118, a: 'left' as const },
      { h: 'Type', w: 28, a: 'left' as const },
      ...snap.days.map((d) => ({ h: shortDate(d), w: 28, a: 'right' as const })),
      { h: 'Hours', w: 38, a: 'right' as const },
      { h: 'Rate/hr', w: 48, a: 'right' as const },
      { h: 'Fringe plan/hr', w: 56, a: 'right' as const },
      { h: 'Gross cash', w: 64, a: 'right' as const },
      { h: 'Fringe plan $', w: 62, a: 'right' as const },
    ];
    const scale = CW / cols.reduce((s, c) => s + c.w, 0);
    const widths = cols.map((c) => c.w * scale);
    const drawRow = (cells: string[], bold: boolean, fill: boolean) => {
      ensure(14);
      if (fill) {
        doc.setFillColor(...SHADE);
        doc.rect(M, y - 8.5, CW, 12, 'F');
      }
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...INK);
      let x = M;
      cells.forEach((c, i) => {
        const w = widths[i];
        if (cols[i].a === 'right') doc.text(fit(doc, c, w - 3), x + w - 2, y, { align: 'right' });
        else doc.text(fit(doc, c, w - 3), x + 2, y);
        x += w;
      });
      doc.setDrawColor(...LINE);
      doc.line(M, y + 3.5, M + CW, y + 3.5);
      y += 12;
    };
    drawRow(cols.map((c) => c.h), true, true);
    const sorted = snap.lines.slice().sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.classification.localeCompare(b.classification) || a.hourType.localeCompare(b.hourType));
    sorted.forEach((l) => {
      if (y > PAGE_H - 50) {
        newPage();
        drawRow(cols.map((c) => c.h), true, true);
      }
      drawRow(
        [
          l.employeeName, l.classification, l.hourType,
          ...l.dayHours.map((h) => (h === 0 ? '' : formatHours(h))),
          formatHours(l.hours), formatMoney(l.cashHourlyCents), formatMoney(l.fringePlanHourlyCents),
          formatMoney(l.grossCashCents), formatMoney(l.fringePlanCents),
        ],
        false,
        false,
      );
    });
    y += 10;

    // Worker summary with deductions
    ensure(40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text('Worker summary', M, y);
    y += 14;
    const scols = [
      { h: 'Worker', w: 150, a: 'left' as const },
      { h: 'ID (last 4)', w: 54, a: 'left' as const },
      { h: 'Hours', w: 44, a: 'right' as const },
      { h: 'Gross cash', w: 70, a: 'right' as const },
      { h: 'FICA', w: 58, a: 'right' as const },
      { h: 'Withholding', w: 66, a: 'right' as const },
      { h: 'Other', w: 58, a: 'right' as const },
      { h: 'Net wages', w: 70, a: 'right' as const },
      { h: 'Fringe to plans', w: 72, a: 'right' as const },
    ];
    const sscale = CW / scols.reduce((s, c) => s + c.w, 0);
    const sw = scols.map((c) => c.w * sscale);
    const srow = (cells: string[], bold: boolean, fill: boolean) => {
      ensure(14);
      if (fill) {
        doc.setFillColor(...SHADE);
        doc.rect(M, y - 8.5, CW, 12, 'F');
      }
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...INK);
      let x = M;
      cells.forEach((c, i) => {
        if (scols[i].a === 'right') doc.text(fit(doc, c, sw[i] - 3), x + sw[i] - 2, y, { align: 'right' });
        else doc.text(fit(doc, c, sw[i] - 3), x + 2, y);
        x += sw[i];
      });
      doc.setDrawColor(...LINE);
      doc.line(M, y + 3.5, M + CW, y + 3.5);
      y += 12;
    };
    srow(scols.map((c) => c.h), true, true);
    snap.workers.forEach((w) =>
      srow(
        [
          w.name, w.workerIdLast4 ? `xxx-xx-${w.workerIdLast4}` : '—', formatHours(w.hours), formatMoney(w.grossCashCents),
          formatMoney(w.deductions.ficaCents), formatMoney(w.deductions.withholdingCents), formatMoney(w.deductions.otherCents),
          formatMoney(w.netCents), formatMoney(w.fringePlanCents),
        ],
        false,
        false,
      ),
    );
    srow(
      ['Totals', '', formatHours(snap.totals.hours), formatMoney(snap.totals.grossCashCents), '', '', '', '', formatMoney(snap.totals.fringePlanCents)],
      true,
      true,
    );
    y += 8;
  }

  // Statement of compliance
  ensure(120);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text('Statement of compliance', M, y);
  y += 12;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const statement =
    `I, ${cert.name || '____________________'}${cert.title ? `, ${cert.title}` : ''}, state that I pay or supervise the payment of the workers employed by ` +
    `${m.contractorName || 'the contractor'} on ${m.projectName || 'this project'}; that for the payroll period ${snap.weekStart} to ${snap.weekEnding} ` +
    `every worker has been paid the full weekly wages earned, with no rebates made directly or indirectly and no deductions except those permitted by regulation; ` +
    `and that every laborer and mechanic has been paid not less than the wage rates and fringe benefits in the applicable wage determination for the classification of work performed, ` +
    `with required fringe benefits paid to bona fide plans or in cash.`;
  const wrapped = doc.splitTextToSize(statement, CW) as string[];
  wrapped.forEach((ln) => {
    ensure(11);
    doc.text(ln, M, y);
    y += 10.5;
  });
  y += 14;
  ensure(40);
  doc.setDrawColor(...INK);
  doc.line(M, y + 14, M + 240, y + 14);
  doc.line(M + 290, y + 14, M + 440, y + 14);
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(
    cert.status === 'certified' ? `Certified electronically by ${cert.name}${cert.title ? `, ${cert.title}` : ''}` : 'Signature',
    M,
    y + 24,
  );
  doc.text(cert.certifiedAt ? new Date(cert.certifiedAt).toLocaleString('en-US') : 'Date', M + 290, y + 24);
  y += 40;

  if (snap.warnings.some((w) => w.severity !== 'info')) {
    ensure(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...DANGER);
    doc.text('Open items at generation time', M, y);
    y += 10;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    snap.warnings
      .filter((w) => w.severity !== 'info')
      .slice(0, 12)
      .forEach((w) => {
        ensure(10);
        doc.text(fit(doc, `• ${w.message}`, CW), M, y);
        y += 9.5;
      });
  }

  footer(page);
  return doc.output('blob');
}

/** Triggers a browser download for a Blob or text. */
export function saveFile(content: Blob | string, filename: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = typeof content === 'string' ? new Blob(['\ufeff', content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
