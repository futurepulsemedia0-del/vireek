// supabase/functions/_shared/money-recovered/pdf.ts
// Vector PDF of the weekly Money Recovered statement (no screenshots). jsPDF is injected so this
// file has no runtime dependency: the edge function passes `npm:jspdf`, the browser passes `jspdf`.

import { pdfSafe } from "../executive-report/pdf.ts";
import { METHODOLOGY, REASON_LABELS, formatMoney, formatPct, type Statement, type StatementRow } from "./engine.ts";
import { callUrl } from "./render.ts";

// deno-lint-ignore no-explicit-any
type PdfDoc = any;
export type JsPdfCtor = new (opts: Record<string, unknown>) => PdfDoc;

const W = 595.28, H = 841.89, M = 48, CW = W - M * 2, BOTTOM = H - 64;
type RGB = [number, number, number];
const ACCENT: RGB = [32, 58, 216], INK: RGB = [23, 23, 23], MUTED: RGB = [110, 110, 120], LINE: RGB = [225, 225, 232];
const GOOD: RGB = [21, 112, 74], WARN: RGB = [154, 91, 0];
const STATE_LABEL = { credited: "Recovered", in_progress: "In progress", not_claimed: "Not claimed" } as const;
const STATE_COLOR: Record<StatementRow["state"], RGB> = { credited: GOOD, in_progress: WARN, not_claimed: MUTED };

export function buildStatementPdf(
  JsPDF: JsPdfCtor,
  input: { companyName: string; statement: Statement; siteUrl: string },
): Uint8Array {
  const s = input.statement;
  const cur = s.currency;
  const money = (c: number) => pdfSafe(formatMoney(c, cur));
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
  text("Money Recovered", M, y + 4, 22, INK, true);
  y += 26;
  text(`${s.period.label} (${s.period.timezone})  -  generated ${s.generatedAt.slice(0, 10)}`, M, y, 9.5, MUTED);
  y += 14;
  rule(y);
  y += 38;

  text(money(s.creditedCents), M, y, 34, GOOD, true);
  y += 18;
  text(`recovered by Vireek across ${s.creditedCount} ${s.creditedCount === 1 ? "customer" : "customers"}, counted conservatively`, M, y, 10, MUTED);
  y += 22;

  const tiles: [string, string, string][] = [
    ["RECOVERED", money(s.creditedCents), `${s.creditedCount} counted`],
    ["NOT CLAIMED", money(s.notClaimedCents), `${s.notClaimedCount} did not meet our bar`],
    ["STILL RECOVERABLE", `~${money(s.stillOpenCents)}`, `${s.stillOpenCount} open (estimate)`],
  ];
  const tw = (CW - 24) / 3;
  tiles.forEach(([label, value, note], i) => {
    const x = M + i * (tw + 12);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
    doc.roundedRect(x, y, tw, 58, 6, 6, "S");
    text(label, x + 12, y + 17, 8, MUTED);
    text(value, x + 12, y + 37, 15, INK, true);
    text(note, x + 12, y + 50, 7.5, MUTED);
  });
  y += 74;

  heading("Compared with your baseline Leak Report");
  if (s.baseline) {
    const b = s.baseline;
    const kv: [string, string, string][] = [
      ["Baseline leak, per week", money(b.weeklyLeakCents), `from ${money(b.monthlyLeakCents)}/month`],
      ["Slipped this week", money(b.leakedThisWeekCents), `${formatPct(b.leakVsBaselinePct)} vs baseline`],
      ["Recovered by Vireek", money(b.creditedCents), b.recoveredVsBaselinePct === null ? "" : `${b.recoveredVsBaselinePct}% of weekly baseline leak`],
    ];
    for (const [k, v, n] of kv) {
      ensure(20);
      text(k, M, y, 10);
      text(v, M + CW * 0.55, y, 10, INK, true, { align: "right" });
      text(n, W - M, y, 9, MUTED, false, { align: "right" });
      y += 18;
    }
  } else {
    text("No baseline has been recorded yet. Add your Leak Report figure in the dashboard to enable this comparison.", M, y, 9.5, MUTED);
    y += 16;
  }

  heading("By category");
  if (s.categories.length) {
    const cols = [M, M + 190, M + 320, W - M];
    ensure(24);
    text("CATEGORY", cols[0], y, 8, MUTED, true);
    text("RECOVERED", cols[1] + 60, y, 8, MUTED, true, { align: "right" });
    text("NOT CLAIMED", cols[2] + 60, y, 8, MUTED, true, { align: "right" });
    text("STILL OPEN (EST.)", cols[3], y, 8, MUTED, true, { align: "right" });
    y += 6; rule(y); y += 14;
    for (const c of s.categories) {
      ensure(20);
      text(c.label, cols[0], y, 10);
      text(`${money(c.creditedCents)} (${c.creditedCount})`, cols[1] + 60, y, 10, INK, true, { align: "right" });
      text(money(c.notClaimedCents), cols[2] + 60, y, 10, MUTED, false, { align: "right" });
      text(`~${money(c.openCents)} (${c.openCount})`, cols[3], y, 10, MUTED, false, { align: "right" });
      y += 18;
    }
  } else {
    text("Nothing to report by category this week.", M, y, 9.5, MUTED);
    y += 16;
  }

  heading("Calls and customers we worked");
  if (!s.rows.length) {
    text("No recoveries or active follow-ups this week.", M, y, 9.5, MUTED);
    y += 16;
  }
  for (const r of s.rows) {
    const summary = r.summary ? wrap(r.summary, CW - 130, 8.5) : [];
    const reason = r.reason ? wrap(REASON_LABELS[r.reason], CW - 130, 8) : [];
    const url = callUrl(input.siteUrl, r.callId);
    ensure(30 + (summary.length + reason.length) * 11 + (url ? 12 : 0));
    text(r.customer, M, y, 10.5, INK, true);
    const amount = r.state === "credited" ? money(r.creditedCents) : r.state === "not_claimed" ? money(r.recoveredCents) : `~${money(r.estimatedCents)}`;
    text(amount, W - M, y, 10.5, INK, true, { align: "right" });
    y += 12;
    text(r.source, M, y, 8.5, MUTED);
    text(STATE_LABEL[r.state], W - M, y, 8.5, STATE_COLOR[r.state], true, { align: "right" });
    y += 11;
    for (const line of summary) { text(line, M, y, 8.5, [68, 68, 79]); y += 11; }
    for (const line of reason) { text(line, M, y, 8, MUTED); y += 10; }
    if (url) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
      doc.textWithLink(r.hasRecording ? "Listen and view call" : "View call", M, y, { url });
      y += 11;
    }
    y += 4; rule(y); y += 12;
  }
  if (s.rowsOmitted > 0) { ensure(16); text(`+ ${s.rowsOmitted} more not shown in this PDF.`, M, y, 9, MUTED); y += 16; }

  heading("How we count (conservative attribution)");
  METHODOLOGY.forEach((m, i) => {
    const lines = wrap(`${i + 1}. ${m.title}. ${m.body}`, CW, 9);
    ensure(lines.length * 12 + 6);
    for (const line of lines) { text(line, M, y, 9, [68, 68, 79]); y += 12; }
    y += 4;
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    rule(H - 46);
    text(`Method ${s.methodVersion}. Figures are frozen at generation time.`, M, H - 32, 7.5, MUTED);
    text(`${p} / ${pages}`, W - M, H - 32, 8, MUTED, false, { align: "right" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
