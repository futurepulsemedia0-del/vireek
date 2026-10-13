// supabase/functions/_shared/executive-report/pdf.ts
// Vector PDF (no screenshots). jsPDF is injected so this file has no runtime
// dependency: the edge function passes `npm:jspdf`, tests pass the real one.

import type { Commentary, ExecutiveMetrics, GoalRow } from "./types.ts";
import { money, pct, signedPct, signedPts } from "./format.ts";

// deno-lint-ignore no-explicit-any
type PdfDoc = any;
export type JsPdfCtor = new (opts: Record<string, unknown>) => PdfDoc;

const W = 595.28, H = 841.89, M = 48, CW = W - M * 2;
type RGB = [number, number, number];
const ACCENT: RGB = [32, 58, 216], INK: RGB = [23, 23, 23], MUTED: RGB = [110, 110, 120], LINE: RGB = [225, 225, 232];
const STATUS: Record<string, RGB> = { achieved: [22, 130, 87], near: [183, 121, 31], behind: [200, 55, 55], no_data: MUTED };
const STATUS_LABEL: Record<string, string> = { achieved: "Achieved", near: "Near goal", behind: "Behind", no_data: "No data" };

/** Helvetica only covers Latin-1: strip accents/unsupported glyphs instead of garbling. */
export function pdfSafe(s: string): string {
  return String(s ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?");
}

const goalValue = (g: GoalRow, v: number | null) =>
  g.unit === "currency" ? money(v) : g.unit === "percent" ? pct(v) : v === null ? "n/a" : String(v);

export function buildExecutiveReportPdf(
  JsPDF: JsPdfCtor,
  input: { companyName: string; metrics: ExecutiveMetrics; commentary: Commentary; generatedAt: Date },
): Uint8Array {
  const { metrics: m, commentary: c } = input;
  const k = m.current;
  const doc: PdfDoc = new JsPDF({ unit: "pt", format: "a4", compress: true });
  let y = 0;

  const color = (rgb: RGB) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  const text = (s: string, x: number, yy: number, size: number, rgb: RGB = INK, bold = false, opts: Record<string, unknown> = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); color(rgb);
    doc.text(pdfSafe(s), x, yy, opts);
  };
  const ensure = (needed: number) => { if (y + needed > H - 56) { doc.addPage(); y = M; } };
  const heading = (s: string) => {
    ensure(40); y += 10; text(s, M, y, 13, INK, true);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.line(M, y + 6, W - M, y + 6); y += 22;
  };
  const paragraphs = (items: string[]) => {
    for (const item of items) {
      const lines: string[] = doc.splitTextToSize(pdfSafe(item), CW - 14);
      ensure(lines.length * 14 + 4);
      text("-", M, y, 10.5, ACCENT, true);
      lines.forEach((ln, i) => text(ln, M + 14, y + i * 14, 10.5));
      y += lines.length * 14 + 4;
    }
  };

  // Header band
  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]); doc.rect(0, 0, W, 92, "F");
  text("EXECUTIVE MONTHLY REPORT", M, 34, 9, [255, 255, 255], true);
  text(input.companyName, M, 58, 20, [255, 255, 255], true);
  text(m.period.label, M, 78, 11, [255, 255, 255]);
  y = 118;

  // Headline
  const head: string[] = doc.splitTextToSize(pdfSafe(c.headline), CW);
  head.forEach((ln, i) => text(ln, M, y + i * 17, 13, INK, true));
  y += head.length * 17 + 8;

  // KPI tiles (3 x 2)
  const tiles: Array<[string, string, string]> = [
    ["REVENUE", money(k.revenue), `${signedPct(m.deltas.revenuePct)} vs prior month`],
    ["JOBS COMPLETED", String(k.jobsCompleted), `${signedPct(m.deltas.jobsCompletedPct)} vs prior month`],
    ["CLOSE RATE", pct(k.closeRatePct), `${k.quotesAccepted} of ${k.quotesDecided} decided quotes`],
    ["MISSED CALLS RECOVERED", `${k.recoveredCount} of ${k.missedCallEvents}`, `${money(k.recoveredValue)} recovered`],
    ["GROSS MARGIN", pct(k.marginPct), `${signedPts(m.deltas.marginPts)} vs prior month`],
    ["AVERAGE TICKET", money(k.avgTicket), `${signedPct(m.deltas.avgTicketPct)} vs prior month`],
  ];
  const gap = 10, tw = (CW - gap * 2) / 3, th = 66;
  tiles.forEach(([label, value, sub], i) => {
    const x = M + (i % 3) * (tw + gap), ty = y + Math.floor(i / 3) * (th + gap);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.roundedRect(x, ty, tw, th, 6, 6, "S");
    text(label, x + 10, ty + 16, 7.5, MUTED, true);
    text(value, x + 10, ty + 40, 17, INK, true);
    text(sub, x + 10, ty + 56, 8, MUTED);
  });
  y += 2 * th + gap + 8;

  if (c.highlights.length) { heading("Highlights"); paragraphs(c.highlights); }
  if (c.risks.length) { heading("Risks"); paragraphs(c.risks); }
  if (c.actions.length) { heading("Recommended actions"); paragraphs(c.actions); }

  if (m.topTechnicians.length) {
    heading("Top technicians");
    text("TECHNICIAN", M, y, 8, MUTED, true);
    text("JOBS", M + 300, y, 8, MUTED, true, { align: "right" });
    text("REVENUE", M + 390, y, 8, MUTED, true, { align: "right" });
    text("AVG TICKET", W - M, y, 8, MUTED, true, { align: "right" });
    y += 14;
    m.topTechnicians.forEach((t, i) => {
      ensure(20);
      text(`${i + 1}. ${t.name}`, M, y, 10.5);
      text(String(t.jobs), M + 300, y, 10.5, INK, false, { align: "right" });
      text(money(t.revenue), M + 390, y, 10.5, INK, true, { align: "right" });
      text(money(t.avgTicket), W - M, y, 10.5, MUTED, false, { align: "right" });
      y += 18;
    });
  }

  if (m.goals.length) {
    heading("Goals vs actual");
    m.goals.forEach((g) => {
      ensure(40);
      text(g.label, M, y, 10.5, INK, true);
      text(`${goalValue(g, g.actual)} of ${goalValue(g, g.goal)}`, M + 300, y, 10.5, INK, false, { align: "right" });
      text(STATUS_LABEL[g.status], W - M, y, 10, STATUS[g.status], true, { align: "right" });
      const frac = Math.max(0, Math.min(1, (g.attainmentPct ?? 0) / 100));
      doc.setFillColor(LINE[0], LINE[1], LINE[2]); doc.roundedRect(M, y + 7, CW, 6, 3, 3, "F");
      if (frac > 0) { const s = STATUS[g.status]; doc.setFillColor(s[0], s[1], s[2]); doc.roundedRect(M, y + 7, CW * frac, 6, 3, 3, "F"); }
      y += 30;
    });
  }

  // Methodology
  heading("How these numbers are calculated");
  const notes = [
    "Revenue: invoiced amount on jobs completed in the month. Jobs completed counts completed jobs only.",
    "Close rate: accepted quotes divided by quotes sent this month that reached a decision (accepted, declined or expired).",
    "Missed calls recovered: missed calls and voicemails from the month that were later marked recovered, with the recovered revenue.",
    "Gross margin: (invoiced revenue - recorded job costs) / invoiced revenue, on jobs with recorded costs only.",
    ...m.dataQuality.notes,
    c.source === "ai" ? "Commentary was drafted by AI from the computed figures; every number in it is checked against the data." : "Commentary was generated from the computed figures.",
  ];
  notes.forEach((n) => {
    const lines: string[] = doc.splitTextToSize(pdfSafe(n), CW);
    ensure(lines.length * 11 + 4);
    lines.forEach((ln, i) => text(ln, M, y + i * 11, 8.5, MUTED));
    y += lines.length * 11 + 4;
  });

  // Footer on every page
  const pages: number = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.line(M, H - 40, W - M, H - 40);
    text(`${input.companyName} - ${m.period.label} - Generated ${input.generatedAt.toISOString().slice(0, 10)}`, M, H - 26, 8, MUTED);
    text(`Page ${p} of ${pages}`, W - M, H - 26, 8, MUTED, false, { align: "right" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
