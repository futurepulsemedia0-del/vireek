/**
 * Unit-economics PDF — layout. `buildReportBlocks` (pure) turns a ReportModel into blocks; `renderReportPdf` draws them
 * with vector text only (same approach as dashboardSnapshotPdf). Built-in PDF fonts only cover Latin-1, so every string
 * goes through `pdfSafe`; organisation names in other scripts fall back to a short account id.
 */
import type { jsPDF } from 'jspdf';
import { formatPct, formatUsd } from './staffUsage';
import type { ReportModel } from './unitEconomicsReportHtml';

export type PdfBlock =
  | { kind: 'title'; text: string; sub: string }
  | { kind: 'kpis'; items: { label: string; value: string; sub: string }[] }
  | { kind: 'heading'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][]; rightAlignFrom: number }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] };

export function pdfSafe(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2192/g, '->').replace(/\u2265/g, '>=').replace(/\u2264/g, '<=').replace(/\u2022/g, '-')
    .replace(/[^\t\n\x20-\x7E\xA0-\xFF]/g, '?');
}

const BASIS = { provider_reported: 'Measured (provider-reported)', estimated: 'Estimate' } as const;

function orgLabel(name: string, accountId: string): string {
  const safe = pdfSafe(name);
  const bad = (safe.match(/\?/g) ?? []).length;
  return bad > safe.length / 3 ? `Account ${accountId.slice(0, 8)}` : safe;
}

export function buildReportBlocks(m: ReportModel): PdfBlock[] {
  const t = m.totals;
  const cov = m.coverage.callsTotal > 0 ? Math.round((m.coverage.callsWithCost / m.coverage.callsTotal) * 100) : 0;
  const rec = m.reconciliation;
  const blocks: PdfBlock[] = [
    { kind: 'title', text: m.title, sub: `${m.periodLabel} · Generated ${m.generatedAtIso.slice(0, 10)} · Internal - contains estimates` },
    { kind: 'kpis', items: [
      { label: 'Revenue (estimate)', value: formatUsd(t.revenueUsd), sub: `${t.tenants} organisations` },
      { label: 'Total cost', value: formatUsd(t.totalCostUsd), sub: `${formatUsd(t.voiceReportedUsd)} measured voice` },
      { label: 'Gross margin', value: formatPct(t.marginPct), sub: formatUsd(t.marginUsd) },
      { label: 'Cost data coverage', value: `${cov}%`, sub: `${m.coverage.callsWithCost} of ${m.coverage.callsTotal} calls` },
    ] },
    { kind: 'heading', text: 'Margin by plan' },
    { kind: 'table', head: ['Plan', 'Orgs', 'Revenue (est.)', 'Cost', 'Margin', 'Org margin p10/p50/p90', 'Losing'], rightAlignFrom: 1,
      rows: m.planStats.map((p) => [p.planName, String(p.tenants), formatUsd(p.revenueUsd), formatUsd(p.costUsd), formatPct(p.marginPct), `${formatPct(p.marginPctP10)} / ${formatPct(p.marginPctP50)} / ${formatPct(p.marginPctP90)}`, String(p.lossTenants)]) },
    { kind: 'heading', text: 'Top cost drivers' },
    { kind: 'table', head: ['Driver', 'Cost', 'Basis'], rightAlignFrom: 1, rows: m.drivers.map((d) => [d.label, formatUsd(d.usd), BASIS[d.basis]]) },
    { kind: 'heading', text: 'Negative-margin organisations' },
    m.negative.length === 0
      ? { kind: 'paragraph', text: 'None in this window.' }
      : { kind: 'table', head: ['Organisation', 'Plan', 'Revenue (est.)', 'Cost', 'Margin'], rightAlignFrom: 2,
          rows: m.negative.map((o) => [orgLabel(o.name, o.accountId), o.planName, formatUsd(o.revenueUsd), formatUsd(o.totalCostUsd), formatUsd(o.marginUsd)]) },
    { kind: 'heading', text: 'Free tier' },
    { kind: 'paragraph', text: `${m.freeTier.orgs} free organisations; average cost per free organisation in this window: ${formatUsd(m.freeTier.avgCostUsd)}.` },
    { kind: 'heading', text: 'Provider invoice reconciliation' },
    { kind: 'paragraph', text: rec
      ? `${rec.provider} - ${rec.month}: reported ${formatUsd(rec.reportedUsd)} vs invoiced ${formatUsd(rec.invoicedUsd)}. ${rec.status === 'no_invoice' ? 'No invoice entered yet: NOT reconciled.' : `Drift ${formatPct(rec.driftPct)} - ${rec.status === 'drift' ? 'OVER threshold, investigate.' : 'within threshold.'}`}`
      : 'No invoice reconciliation is included in this report.' },
    { kind: 'heading', text: 'Assumptions' },
    { kind: 'bullets', items: m.assumptions },
    { kind: 'paragraph', text: 'Estimates are not invoices. Measured figures are provider-reported and not yet reconciled unless stated above.' },
  ];
  return blocks;
}

const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const LINE: [number, number, number] = [225, 225, 232];
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 60;

export function renderReportPdf(doc: jsPDF, blocks: PdfBlock[], meta: { footer: string }): jsPDF {
  let y = 0;
  const header = () => {
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, PAGE_W, 6, 'F');
    y = 48;
  };
  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) { doc.addPage(); header(); }
  };
  const fit = (s: string, maxW: number): string => {
    let out = pdfSafe(s);
    if (doc.getTextWidth(out) <= maxW) return out;
    while (out.length > 1 && doc.getTextWidth(`${out}...`) > maxW) out = out.slice(0, -1);
    return `${out}...`;
  };

  header();
  for (const b of blocks) {
    if (b.kind === 'title') {
      doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(...INK);
      const lines = doc.splitTextToSize(pdfSafe(b.text), W) as string[];
      doc.text(lines, M, y + 6);
      y += 6 + lines.length * 26;
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...MUTED);
      doc.text(pdfSafe(b.sub), M, y);
      y += 12;
      doc.setDrawColor(...LINE).setLineWidth(1).line(M, y, PAGE_W - M, y);
      y += 22;
    } else if (b.kind === 'kpis') {
      const tileW = (W - 12 * (b.items.length - 1)) / b.items.length;
      ensure(72);
      b.items.forEach((k, i) => {
        const x = M + i * (tileW + 12);
        doc.setDrawColor(...LINE).roundedRect(x, y, tileW, 58, 6, 6, 'S');
        doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
        doc.text(fit(k.label.toUpperCase(), tileW - 16), x + 8, y + 16);
        doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...INK);
        doc.text(fit(k.value, tileW - 16), x + 8, y + 36);
        doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...MUTED);
        doc.text(fit(k.sub, tileW - 16), x + 8, y + 50);
      });
      y += 76;
    } else if (b.kind === 'heading') {
      ensure(44);
      y += 8;
      doc.setFont('helvetica', 'bold').setFontSize(12.5).setTextColor(...ACCENT);
      doc.text(pdfSafe(b.text), M, y);
      y += 16;
    } else if (b.kind === 'paragraph' || b.kind === 'bullets') {
      const items = b.kind === 'paragraph' ? [b.text] : b.items;
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...INK);
      for (const it of items) {
        const lines = doc.splitTextToSize((b.kind === 'bullets' ? '- ' : '') + pdfSafe(it), W - (b.kind === 'bullets' ? 8 : 0)) as string[];
        for (const ln of lines) {
          ensure(14);
          doc.text(ln, M + (b.kind === 'bullets' ? 8 : 0), y);
          y += 13;
        }
        y += 3;
      }
    } else {
      const n = b.head.length;
      const weights = b.head.map((_, i) => (i === 0 ? 2 : 1));
      const total = weights.reduce((a, c) => a + c, 0);
      const colW = weights.map((w) => (W * w) / total);
      const colX = colW.map((_, i) => M + colW.slice(0, i).reduce((a, c) => a + c, 0));
      const drawRow = (cells: string[], bold: boolean) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(8.5).setTextColor(...(bold ? MUTED : INK));
        for (let i = 0; i < n; i++) {
          const txt = fit(cells[i] ?? '', colW[i] - 8);
          if (i >= b.rightAlignFrom) doc.text(txt, colX[i] + colW[i] - 4, y, { align: 'right' });
          else doc.text(txt, colX[i] + 4, y);
        }
      };
      ensure(32);
      drawRow(b.head, true);
      y += 5;
      doc.setDrawColor(...LINE).setLineWidth(0.8).line(M, y, PAGE_W - M, y);
      y += 12;
      if (b.rows.length === 0) { doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED); doc.text('No data', M + 4, y); y += 14; }
      for (const r of b.rows) {
        if (y + 16 > BOTTOM) { doc.addPage(); header(); drawRow(b.head, true); y += 5; doc.setDrawColor(...LINE).setLineWidth(0.8).line(M, y, PAGE_W - M, y); y += 12; }
        drawRow(r, false);
        y += 15;
      }
      y += 4;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text(pdfSafe(meta.footer), M, PAGE_H - 30);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - M, PAGE_H - 30, { align: 'right' });
  }
  return doc;
}
