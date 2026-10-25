// supabase/functions/_shared/value-scoreboard/pdf.ts
// Vector PDF of the monthly Results summary. jsPDF is injected (edge: npm:jspdf, browser: jspdf).

import { pdfSafe } from "../executive-report/pdf.ts";
import { formatHours, formatMoney, formatMultiple, formatShare, methodology, type Scoreboard } from "./engine.ts";
import { costLine } from "./render.ts";

// deno-lint-ignore no-explicit-any
type PdfDoc = any;
export type JsPdfCtor = new (opts: Record<string, unknown>) => PdfDoc;

const W = 595.28, H = 841.89, M = 48, CW = W - M * 2, BOTTOM = H - 64;
type RGB = [number, number, number];
const ACCENT: RGB = [32, 58, 216], INK: RGB = [23, 23, 23], MUTED: RGB = [110, 110, 120], LINE: RGB = [225, 225, 232];
const GOOD: RGB = [21, 112, 74], WARN: RGB = [154, 91, 0];

export function buildValuePdf(JsPDF: JsPdfCtor, input: { companyName: string; board: Scoreboard; siteUrl: string }): Uint8Array {
  const b = input.board;
  const money = (c: number, cur = b.currency) => pdfSafe(formatMoney(c, cur));
  const doc: PdfDoc = new JsPDF({ unit: "pt", format: "a4", compress: true });
  let y = 0;

  const text = (t: string, x: number, yy: number, size: number, rgb: RGB = INK, bold = false, opts: Record<string, unknown> = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(rgb[0], rgb[1], rgb[2]);
    doc.text(pdfSafe(t), x, yy, opts);
  };
  const wrap = (t: string, width: number, size: number): string[] => {
    doc.setFontSize(size);
    return doc.splitTextToSize(pdfSafe(t), width) as string[];
  };
  const rule = (yy: number) => { doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.75); doc.line(M, yy, W - M, yy); };
  const header = () => {
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(0, 0, W, 6, "F");
    y = 46;
    text(input.companyName || "Your business", M, y, 11, ACCENT, true);
    y += 22;
  };
  const ensure = (need: number) => { if (y + need > BOTTOM) { doc.addPage(); header(); } };
  const heading = (t: string) => { ensure(40); y += 8; text(t, M, y, 12, INK, true); y += 16; };

  header();
  text("Vireek Results", M, y + 4, 22, INK, true);
  y += 26;
  text(`${b.window.label} (${b.window.timezone})  -  method ${b.methodVersion}`, M, y, 9.5, MUTED);
  y += 14;
  rule(y);
  y += 38;

  text(money(b.money.measuredCents), M, y, 34, GOOD, true);
  y += 18;
  text("verified revenue: measured against paid invoices in your account", M, y, 10, MUTED);
  y += 22;

  const tiles: [string, string, string][] = [
    ["MEASURED", money(b.money.measuredCents), `${b.counts.measured} items`],
    ["ESTIMATED (SEPARATE)", money(b.money.estimatedCents), `${b.counts.estimated} items`],
    ["TIME SAVED (EST.)", formatHours(b.hours.totalMinutes), "not converted to money"],
  ];
  const tw = (CW - 24) / 3;
  tiles.forEach(([label, value, note], i) => {
    const x = M + i * (tw + 12);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
    doc.roundedRect(x, y, tw, 58, 6, 6, "S");
    text(label, x + 12, y + 17, 8, i === 1 ? WARN : MUTED);
    text(value, x + 12, y + 37, 15, INK, true);
    text(note, x + 12, y + 50, 7.5, MUTED);
  });
  y += 76;

  heading("Value versus subscription cost");
  for (const line of wrap(costLine(b), CW, 10)) { ensure(14); text(line, M, y, 10); y += 14; }
  if (b.cost.netCents !== null) {
    ensure(18);
    text(`Net of subscription (measured + estimated): ${money(b.cost.netCents)}   -   ${formatMultiple(b.cost.multiple)} total, ${formatMultiple(b.cost.measuredMultiple)} verified only`, M, y + 2, 9.5, MUTED);
    y += 18;
  }

  heading("By feature");
  text("FEATURE", M, y, 8, MUTED);
  text("MEASURED", M + CW * 0.55, y, 8, MUTED, false, { align: "right" });
  text("ESTIMATED", M + CW * 0.78, y, 8, MUTED, false, { align: "right" });
  text("SHARE", W - M, y, 8, MUTED, false, { align: "right" });
  y += 8;
  rule(y);
  y += 14;
  if (b.byFeature.length === 0) { text("No value recorded this month yet.", M, y, 10, MUTED); y += 16; }
  for (const r of b.byFeature) {
    ensure(18);
    text(r.label, M, y, 10);
    text(money(r.measuredCents), M + CW * 0.55, y, 10, INK, true, { align: "right" });
    text(money(r.estimatedCents), M + CW * 0.78, y, 10, WARN, false, { align: "right" });
    text(formatShare(r.shareBp), W - M, y, 9, MUTED, false, { align: "right" });
    y += 18;
  }

  heading("Trend");
  for (const t of b.trend) {
    ensure(16);
    text(t.label, M, y, 10);
    text(`${money(t.measuredCents)} measured`, M + CW * 0.55, y, 10, INK, false, { align: "right" });
    text(`${money(t.estimatedCents)} est.`, W - M, y, 10, WARN, false, { align: "right" });
    y += 16;
  }

  if (b.otherCurrencies.length) {
    heading("Other currencies (never added to the totals above)");
    for (const o of b.otherCurrencies) { ensure(16); text(`${money(o.measuredCents, o.currency)} measured, ${money(o.estimatedCents, o.currency)} estimated`, M, y, 10); y += 16; }
  }

  heading("How this is calculated");
  for (const s of methodology) {
    ensure(40);
    text(s.title, M, y, 10, INK, true);
    y += 13;
    for (const line of wrap(s.body, CW, 9)) { ensure(13); text(line, M, y, 9, MUTED); y += 12; }
    y += 6;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
