/**
 * Vireek Insights - downloadable quarterly report (PDF) and CSV.
 * Built from the public national cells only. jsPDF is loaded on demand so the
 * public page stays light. Text is ASCII-safe for the built-in PDF fonts.
 */
import {
  METRIC_META,
  METRIC_ORDER,
  buildInsightsCsv,
  contributorBandLabel,
  formatChange,
  formatInsightValue,
  groupByTrade,
  periodLabelHuman,
  tradeLabel,
  type InsightCell,
  type InsightPeriod,
} from '@/lib/insights';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const LINE: [number, number, number] = [225, 225, 232];

const PRIVACY_NOTES = [
  'Only businesses that explicitly opted in contribute. Each business supplies one number per metric.',
  'A figure is published only when at least 10 businesses contribute and their values are not all alike.',
  'Only the 25th percentile, median and 75th percentile are released; exact business counts are never shown.',
  'Small, stable statistical noise is added to every figure. This is differential-privacy-inspired, not a certified guarantee.',
  'Published quarters are immutable. A release can be retracted, never silently edited.',
];

function ascii(s: string): string {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-').replace(/[^\x20-\x7E]/g, '');
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadInsightsCsv(cells: InsightCell[], period: string): void {
  download(new Blob([buildInsightsCsv(cells)], { type: 'text/csv;charset=utf-8' }), `vireek-insights-${period}.csv`);
}

export async function downloadInsightsReportPdf(period: InsightPeriod, cells: InsightCell[]): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const human = periodLabelHuman(period.period_label);
  let y = 0;

  const newPage = () => {
    doc.addPage();
    y = MARGIN;
  };
  const ensure = (h: number) => {
    if (y + h > PAGE_H - MARGIN - 20) newPage();
  };
  const text = (s: string, x: number, size: number, color: [number, number, number], bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(ascii(s), x, y);
  };

  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 6, 'F');
  y = 64;
  text('VIREEK INSIGHTS', MARGIN, 9, ACCENT, true);
  y += 26;
  text(`Home-service industry indexes, ${human}`, MARGIN, 20, INK, true);
  y += 18;
  text(
    `Period ${period.period_start} to ${period.period_end}. Based on ${period.contributors_rounded}+ contributing businesses (United States).`,
    MARGIN,
    9,
    MUTED,
  );
  y += 28;

  const colX = [MARGIN, 200, 290, 380, 470];
  for (const group of groupByTrade(cells)) {
    ensure(40 + METRIC_ORDER.length * 18);
    text(tradeLabel(group.trade), MARGIN, 12, INK, true);
    y += 8;
    doc.setDrawColor(...LINE);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 14;
    ['Metric', '25th pct', 'Median', '75th pct', 'vs last qtr'].forEach((h, i) => text(h, colX[i], 8, MUTED, true));
    y += 14;
    for (const metric of METRIC_ORDER) {
      const c = group.metrics[metric];
      if (!c) continue;
      ensure(18);
      text(METRIC_META[metric].label, colX[0], 9, INK);
      text(formatInsightValue(c.unit, c.p25), colX[1], 9, INK);
      text(formatInsightValue(c.unit, c.p50), colX[2], 9, INK, true);
      text(formatInsightValue(c.unit, c.p75), colX[3], 9, INK);
      text(metric === 'demand_index' ? contributorBandLabel(c.contributor_band) : formatChange(c.qoq_change_pct), colX[4], 9, MUTED);
      y += 16;
    }
    y += 12;
  }

  ensure(40 + PRIVACY_NOTES.length * 26);
  text('How your privacy is protected', MARGIN, 12, INK, true);
  y += 18;
  for (const note of PRIVACY_NOTES) {
    const lines = doc.splitTextToSize(ascii(note), PAGE_W - MARGIN * 2 - 14) as string[];
    ensure(lines.length * 12 + 6);
    text('-', MARGIN, 9, ACCENT, true);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(lines, MARGIN + 14, y);
    y += lines.length * 12 + 6;
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(ascii(`Vireek Insights ${human} - vireek.com/insights`), MARGIN, PAGE_H - 28);
    doc.text(`${i} / ${pages}`, PAGE_W - MARGIN - 20, PAGE_H - 28);
  }

  doc.save(`vireek-insights-${period.period_label}.pdf`);
}
