import { jsPDF } from 'jspdf';
import { widgetTitle, type SnapshotPayload, type WidgetData } from '@/lib/dashboardSnapshot';

// Vector text + shapes only (no DOM screenshots): crisp, small, no CORS issues.
const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const LINE: [number, number, number] = [225, 225, 232];
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 70;

export interface SnapshotPdfMeta {
  title: string;
  audience: string | null;
  businessName: string;
  expiresAt?: string;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function buildSnapshotPdf(meta: SnapshotPdfMeta, payload: SnapshotPayload): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 0;

  const header = () => {
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, PAGE_W, 6, 'F');
    y = 48;
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...ACCENT);
    doc.text(meta.businessName || 'Dashboard snapshot', M, y);
    y += 22;
  };
  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      header();
    }
  };

  header();
  doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(...INK);
  const titleLines = doc.splitTextToSize(meta.title, W) as string[];
  doc.text(titleLines, M, y + 6);
  y += 6 + titleLines.length * 26;

  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...MUTED);
  const sub = [
    meta.audience ? `Prepared for ${meta.audience}` : null,
    `${fmtDate(payload.period.start)} – ${fmtDate(payload.period.end)} (${payload.period.days} days)`,
    `Generated ${fmtDate(payload.generatedAt)}`,
  ].filter(Boolean) as string[];
  doc.text(sub.join('  ·  '), M, y);
  y += 12;
  doc.setDrawColor(...LINE).setLineWidth(1).line(M, y, PAGE_W - M, y);
  y += 24;

  // KPI tiles, 3 per row.
  const kpis = payload.widgets.filter((w): w is Extract<WidgetData, { kind: 'kpi' }> => w.kind === 'kpi');
  const tileW = (W - 24) / 3;
  kpis.forEach((k, i) => {
    const col = i % 3;
    if (col === 0) ensure(70);
    const x = M + col * (tileW + 12);
    doc.setDrawColor(...LINE).roundedRect(x, y, tileW, 58, 6, 6, 'S');
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...MUTED);
    doc.text(widgetTitle(k.key).toUpperCase(), x + 12, y + 18);
    doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...INK);
    doc.text(k.value, x + 12, y + 40);
    if (k.hint) {
      doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
      doc.text(k.hint, x + 12, y + 52);
    }
    if (col === 2 || i === kpis.length - 1) y += 72;
  });

  for (const w of payload.widgets) {
    if (w.kind === 'series') {
      ensure(150);
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
      doc.text(widgetTitle(w.key), M, y);
      y += 14;
      const chartH = 90;
      const max = Math.max(1, ...w.points.map((p) => p.value));
      const gap = 2;
      const barW = Math.max(1, (W - gap * (w.points.length - 1)) / Math.max(1, w.points.length));
      doc.setFillColor(...ACCENT);
      w.points.forEach((p, i) => {
        const h = (p.value / max) * chartH;
        if (h > 0) doc.rect(M + i * (barW + gap), y + chartH - h, barW, h, 'F');
      });
      doc.setDrawColor(...LINE).line(M, y + chartH, PAGE_W - M, y + chartH);
      doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
      if (w.points.length > 0) {
        doc.text(w.points[0].label, M, y + chartH + 11);
        doc.text(w.points[w.points.length - 1].label, PAGE_W - M, y + chartH + 11, { align: 'right' });
      }
      doc.text(`Peak ${max}`, PAGE_W / 2, y + chartH + 11, { align: 'center' });
      y += chartH + 32;
    } else if (w.kind === 'table') {
      ensure(60 + w.rows.length * 18);
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
      doc.text(widgetTitle(w.key), M, y);
      y += 16;
      const colW = W / Math.max(1, w.columns.length);
      doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...MUTED);
      w.columns.forEach((c, i) => doc.text(c.toUpperCase(), M + i * colW, y));
      y += 6;
      doc.setDrawColor(...LINE).line(M, y, PAGE_W - M, y);
      y += 14;
      doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...INK);
      for (const row of w.rows) {
        ensure(18);
        row.forEach((cell, i) => doc.text(cell, M + i * colW, y, { maxWidth: colW - 8 }));
        y += 18;
      }
      if (w.rows.length === 0) {
        doc.setTextColor(...MUTED).text('No data in this period.', M, y);
        y += 18;
      }
      y += 14;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE).line(M, PAGE_H - 52, PAGE_W - M, PAGE_H - 52);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text('Read-only snapshot. Figures are frozen at the time of generation and may differ from live data.', M, PAGE_H - 38);
    doc.text(`${p} / ${pages}`, PAGE_W - M, PAGE_H - 38, { align: 'right' });
  }
  return doc;
}
