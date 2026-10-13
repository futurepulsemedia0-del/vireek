// supabase/functions/_shared/executive-report/render.ts
// Email-safe HTML (table layout, inline styles) + plain-text twin.

import type { Commentary, ExecutiveMetrics, GoalRow } from "./types.ts";
import { money, pct, signedPct, signedPts } from "./format.ts";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const INK = "#171717", MUTED = "#6e6e78", LINE = "#e1e1e8", ACCENT = "#203ad8";
const STATUS_COLOR: Record<string, string> = { achieved: "#168257", near: "#b7791f", behind: "#c83737", no_data: MUTED };
const STATUS_LABEL: Record<string, string> = { achieved: "Achieved", near: "Near goal", behind: "Behind", no_data: "No data" };

const goalValue = (g: GoalRow, v: number | null) =>
  g.unit === "currency" ? money(v) : g.unit === "percent" ? pct(v) : v === null ? "n/a" : String(v);

function tile(label: string, value: string, delta: string): string {
  return `<td width="33%" style="padding:6px;vertical-align:top"><div style="border:1px solid ${LINE};border-radius:10px;padding:14px">
<div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${esc(label)}</div>
<div style="font-size:24px;font-weight:700;color:${INK};margin-top:4px">${esc(value)}</div>
<div style="font-size:12px;color:${MUTED};margin-top:2px">${esc(delta)}</div></div></td>`;
}

function bullets(title: string, items: string[]): string {
  if (!items.length) return "";
  return `<h3 style="font-size:14px;color:${INK};margin:18px 0 6px">${esc(title)}</h3><ul style="margin:0;padding-left:18px;color:${INK};font-size:14px;line-height:1.55">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

export function renderReportEmail(opts: {
  companyName: string; metrics: ExecutiveMetrics; commentary: Commentary; pdfUrl?: string | null; appUrl?: string;
}): { subject: string; html: string; text: string } {
  const { metrics: m, commentary: c } = opts;
  const k = m.current;
  const subject = `${opts.companyName} — Executive report for ${m.period.label}`;

  const tiles = [
    [tile("Revenue", money(k.revenue), `${signedPct(m.deltas.revenuePct)} vs prior`), tile("Jobs completed", String(k.jobsCompleted), `${signedPct(m.deltas.jobsCompletedPct)} vs prior`), tile("Close rate", pct(k.closeRatePct), `${signedPts(m.deltas.closeRatePts)} vs prior`)],
    [tile("Missed calls recovered", `${k.recoveredCount}/${k.missedCallEvents}`, `${money(k.recoveredValue)} recovered`), tile("Gross margin", pct(k.marginPct), `${signedPts(m.deltas.marginPts)} vs prior`), tile("Avg ticket", money(k.avgTicket), `${signedPct(m.deltas.avgTicketPct)} vs prior`)],
  ].map((row) => `<tr>${row.join("")}</tr>`).join("");

  const techRows = m.topTechnicians.map((t, i) => `<tr><td style="padding:6px 0;font-size:14px;color:${INK}">${i + 1}. ${esc(t.name)}</td><td align="right" style="font-size:14px">${esc(money(t.revenue))}</td><td align="right" style="font-size:14px;color:${MUTED}">${t.jobs} jobs</td></tr>`).join("");
  const goalRows = m.goals.map((g) => `<tr><td style="padding:6px 0;font-size:14px;color:${INK}">${esc(g.label)}</td><td align="right" style="font-size:14px">${esc(goalValue(g, g.actual))} / ${esc(goalValue(g, g.goal))}</td><td align="right" style="font-size:13px;font-weight:600;color:${STATUS_COLOR[g.status]}">${STATUS_LABEL[g.status]}</td></tr>`).join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:${ACCENT};padding:22px 28px;color:#fff"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Executive monthly report</div><div style="font-size:22px;font-weight:700;margin-top:4px">${esc(opts.companyName)} · ${esc(m.period.label)}</div></td></tr>
<tr><td style="padding:24px 28px">
<p style="font-size:16px;font-weight:600;color:${INK};margin:0 0 14px">${esc(c.headline)}</p>
<table width="100%" cellpadding="0" cellspacing="0">${tiles}</table>
${bullets("Highlights", c.highlights)}${bullets("Risks", c.risks)}${bullets("Recommended actions", c.actions)}
${techRows ? `<h3 style="font-size:14px;margin:22px 0 6px;color:${INK}">Top technicians</h3><table width="100%" cellpadding="0" cellspacing="0">${techRows}</table>` : ""}
${goalRows ? `<h3 style="font-size:14px;margin:22px 0 6px;color:${INK}">Goals vs actual</h3><table width="100%" cellpadding="0" cellspacing="0">${goalRows}</table>` : ""}
${opts.pdfUrl ? `<p style="margin:26px 0 0"><a href="${esc(opts.pdfUrl)}" style="background:${ACCENT};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;font-size:14px;display:inline-block">Download the full PDF</a></p>` : `<p style="font-size:13px;color:${MUTED};margin-top:24px">The full PDF report is attached.</p>`}
<p style="font-size:11px;color:${MUTED};margin:22px 0 0">${c.source === "ai" ? "Commentary drafted by AI from the figures above; all numbers are computed from your data. " : ""}${esc(m.dataQuality.notes.join(" "))}</p>
</td></tr></table></td></tr></table></body></html>`;

  const lines = [
    `${opts.companyName} — Executive report, ${m.period.label}`, "", c.headline, "",
    `Revenue: ${money(k.revenue)} (${signedPct(m.deltas.revenuePct)} vs prior)`,
    `Jobs completed: ${k.jobsCompleted}`, `Close rate: ${pct(k.closeRatePct)}`,
    `Missed calls recovered: ${k.recoveredCount}/${k.missedCallEvents} (${money(k.recoveredValue)})`,
    `Gross margin: ${pct(k.marginPct)}`, "",
    ...(c.highlights.length ? ["Highlights:", ...c.highlights.map((x) => `- ${x}`), ""] : []),
    ...(c.risks.length ? ["Risks:", ...c.risks.map((x) => `- ${x}`), ""] : []),
    ...(c.actions.length ? ["Actions:", ...c.actions.map((x) => `- ${x}`), ""] : []),
    ...(opts.pdfUrl ? [`Full PDF: ${opts.pdfUrl}`] : ["Full PDF attached."]),
  ];
  return { subject, html, text: lines.join("\n") };
}
