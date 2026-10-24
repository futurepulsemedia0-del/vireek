import { jsPDF } from 'jspdf';
import {
  DAY_NAMES,
  formatDuration,
  formatUsd,
  hourLabel,
  type LeakReport,
} from '../../supabase/functions/_shared/leak-report/core';

// Vector text + shapes only: crisp, tiny, no CORS. Always exactly ONE A4 page.
const ACCENT: [number, number, number] = [32, 58, 216];
const DANGER: [number, number, number] = [220, 38, 38];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const LINE: [number, number, number] = [225, 225, 232];
const SOFT: [number, number, number] = [190, 199, 245];
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const W = PAGE_W - M * 2;

export interface LeakPdfMeta {
  businessName: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  ticketLabel: string;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export function leakReportFileName(businessName: string, generatedAt: string): string {
  const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'business';
  return `leak-report-${slug}-${generatedAt.slice(0, 10)}.pdf`;
}

export function buildLeakReportPdf(meta: LeakPdfMeta, r: LeakReport): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  doc.setFillColor(...ACCENT).rect(0, 0, PAGE_W, 6, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...ACCENT);
  doc.text((meta.businessName || 'Your business').slice(0, 60), M, 48);
  doc.setFont('helvetica', 'bold').setFontSize(24).setTextColor(...INK);
  doc.text('Missed-Call Leak Report', M, 76);
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...MUTED);
  doc.text(`${fmtDate(meta.periodStart)} - ${fmtDate(meta.periodEnd)}  |  Generated ${fmtDate(meta.generatedAt)}`, M, 94);
  doc.setDrawColor(...LINE).setLineWidth(1).line(M, 106, PAGE_W - M, 106);

  // Hero
  doc.setFillColor(254, 242, 242).roundedRect(M, 120, W, 104, 8, 8, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...MUTED);
  doc.text(r.estimatedLostCents !== null ? 'ESTIMATED REVENUE LOST' : 'CUSTOMERS WHO NEVER GOT A RESPONSE', M + 18, 142);
  doc.setFont('helvetica', 'bold').setFontSize(38).setTextColor(...DANGER);
  doc.text(r.estimatedLostCents !== null ? formatUsd(r.estimatedLostCents) : String(r.lostCallers), M + 18, 184);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...INK);
  doc.text(`${r.lostCallers} caller${r.lostCallers === 1 ? '' : 's'} were never reached within 72 hours`, M + 18, 206);
  if (r.estimatedLostCents !== null) {
    doc.setFontSize(9.5).setTextColor(...MUTED);
    const right: string[] = [];
    if (r.ceilingLostCents !== null) right.push(`Up to ${formatUsd(r.ceilingLostCents)} if every one had booked`);
    if (r.annualizedLostCents !== null) right.push(`At this pace: ${formatUsd(r.annualizedLostCents)} per year`);
    right.forEach((line, i) => doc.text(line, PAGE_W - M - 18, 150 + i * 16, { align: 'right' }));
  }

  // KPI tiles
  const kpis: [string, string, string][] = [
    ['Answer rate', r.answerRate === null ? '-' : `${r.answerRate}%`, `${r.answered} of ${r.inboundTotal} calls`],
    ['Missed calls', String(r.missed), `${r.voicemails} went to voicemail`],
    ['After-hours missed', String(r.afterHoursMissed), `of ${r.afterHoursTotal} after-hours calls`],
    ['Avg first response', formatDuration(r.avgFirstResponseSeconds), 'answer or callback'],
  ];
  const tileW = (W - 36) / 4;
  kpis.forEach(([label, value, hint], i) => {
    const x = M + i * (tileW + 12);
    doc.setDrawColor(...LINE).roundedRect(x, 240, tileW, 62, 6, 6, 'S');
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text(label.toUpperCase(), x + 10, 256);
    doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...INK);
    doc.text(value, x + 10, 278);
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
    doc.text(hint, x + 10, 293, { maxWidth: tileW - 16 });
  });

  // Hour chart
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
  doc.text('Calls by hour of day (missed calls in red)', M, 330);
  const chartTop = 344;
  const chartH = 110;
  const maxHour = Math.max(1, ...r.byHour.map((b) => b.total));
  const gap = 3;
  const barW = (W - gap * 23) / 24;
  r.byHour.forEach((b, i) => {
    const x = M + i * (barW + gap);
    const h = (b.total / maxHour) * chartH;
    if (h > 0) doc.setFillColor(...SOFT).rect(x, chartTop + chartH - h, barW, h, 'F');
    const mh = (b.missed / maxHour) * chartH;
    if (mh > 0) doc.setFillColor(...DANGER).rect(x, chartTop + chartH - mh, barW, mh, 'F');
  });
  doc.setDrawColor(...LINE).line(M, chartTop + chartH, PAGE_W - M, chartTop + chartH);
  doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
  [0, 6, 12, 18].forEach((h) => doc.text(hourLabel(h), M + h * (barW + gap), chartTop + chartH + 12));

  // Day chart
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
  doc.text('Calls by day of week', M, 494);
  const dayTop = 506;
  const dayH = 60;
  const maxDay = Math.max(1, ...r.byDay.map((b) => b.total));
  const dGap = 10;
  const dW = (W - dGap * 6) / 7;
  r.byDay.forEach((b, i) => {
    const x = M + i * (dW + dGap);
    const h = (b.total / maxDay) * dayH;
    if (h > 0) doc.setFillColor(...SOFT).rect(x, dayTop + dayH - h, dW, h, 'F');
    const mh = (b.missed / maxDay) * dayH;
    if (mh > 0) doc.setFillColor(...DANGER).rect(x, dayTop + dayH - mh, dW, mh, 'F');
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
    doc.text(DAY_NAMES[i].slice(0, 3), x + dW / 2, dayTop + dayH + 12, { align: 'center' });
  });
  doc.setDrawColor(...LINE).line(M, dayTop + dayH, PAGE_W - M, dayTop + dayH);

  // Insights
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
  doc.text('What stands out', M, 606);
  const insights: string[] = [];
  if (r.worstDay !== null && r.worstHour !== null) {
    insights.push(`Most missed calls: ${DAY_NAMES[r.worstDay]}s, and around ${hourLabel(r.worstHour)} on the busiest day-part.`);
  }
  insights.push(
    r.afterHoursTotal > 0
      ? `${r.afterHoursMissed} of ${r.afterHoursTotal} after-hours calls went unanswered.`
      : 'No after-hours calls were recorded in this period.',
  );
  insights.push(
    r.medianCallbackSeconds !== null
      ? `Missed callers who were called back waited a median of ${formatDuration(r.medianCallbackSeconds)}; ${r.lostCallers} never heard back.`
      : `${r.lostCallers} missed caller${r.lostCallers === 1 ? '' : 's'} never heard back.`,
  );
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...INK);
  let y = 624;
  insights.slice(0, 3).forEach((line) => {
    const wrapped = doc.splitTextToSize(`- ${line}`, W) as string[];
    doc.text(wrapped.slice(0, 2), M, y);
    y += wrapped.slice(0, 2).length * 13 + 3;
  });

  // Method
  doc.setDrawColor(...LINE).roundedRect(M, 696, W, 66, 6, 6, 'S');
  doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...MUTED);
  doc.text('HOW THIS WAS ESTIMATED', M + 12, 712);
  doc.setFont('helvetica', 'normal').setFontSize(8);
  const method =
    r.avgTicketCents !== null
      ? `Lost revenue = callers never reached x average ticket (${formatUsd(r.avgTicketCents)}, ${meta.ticketLabel}) x assumed close rate (${Math.round(r.closeRateBps / 100)}%). A caller counts as reached if the business called back or answered a retry within 72 hours. Calls were measured without changing the phone setup.`
      : 'No average ticket is available yet, so no dollar figure is shown. Calls were measured without changing the phone setup; a caller counts as reached if the business called back or answered a retry within 72 hours.';
  doc.text((doc.splitTextToSize(method, W - 24) as string[]).slice(0, 5), M + 12, 726);

  doc.setDrawColor(...LINE).line(M, PAGE_H - 52, PAGE_W - M, PAGE_H - 52);
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
  doc.text('Estimates based on observed call data, not a guarantee of future revenue.', M, PAGE_H - 38);
  doc.text('vireek.com', PAGE_W - M, PAGE_H - 38, { align: 'right' });
  return doc;
}
