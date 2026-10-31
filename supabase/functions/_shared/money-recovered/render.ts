// supabase/functions/_shared/money-recovered/render.ts
// Pure email renderer (subject + HTML + plain text) for the weekly Money Recovered statement.
// Every database-sourced value (caller names, call summaries) is HTML-escaped: caller names come
// from the public phone line and must never inject markup into an email sent under the owner's brand.

import {
  METHODOLOGY, REASON_LABELS, formatMoney, formatPct,
  type NotClaimedReason, type Statement, type StatementRow,
} from "./engine.ts";

export const EMAIL_MAX_ROWS = 15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Safe for a Subject header: no CR/LF, bounded length. */
const oneLine = (s: string, n = 60) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function callUrl(siteUrl: string, callId: string | null): string | null {
  return callId && UUID_RE.test(callId) ? `${siteUrl.replace(/\/$/, "")}/dashboard/calls/${callId}` : null;
}

const STATE_LABEL = { credited: "Recovered", in_progress: "In progress", not_claimed: "Not claimed" } as const;
const STATE_COLOR = {
  credited: { bg: "#e6f6ee", fg: "#15704a" },
  in_progress: { bg: "#fff4e0", fg: "#9a5b00" },
  not_claimed: { bg: "#efeff3", fg: "#55556a" },
} as const;

export interface StatementEmailInput {
  companyName: string;
  statement: Statement;
  siteUrl: string;
  /** Shown in place of the weekly subject prefix, e.g. "[Test] ". */
  subjectPrefix?: string;
  pilot?: { html: string; text: string } | null;
}

const rowAmount = (r: StatementRow, cur: string) =>
  r.state === "credited" ? formatMoney(r.creditedCents, cur)
    : r.state === "not_claimed" ? formatMoney(r.recoveredCents, cur)
    : `~${formatMoney(r.estimatedCents, cur)}`;

export function renderStatementEmail(input: StatementEmailInput): { subject: string; html: string; text: string } {
  const { statement: s, siteUrl } = input;
  const cur = s.currency;
  const company = oneLine(input.companyName || "Your business");
  const subject = `${input.subjectPrefix ?? ""}${s.creditedCents > 0
    ? `${company}: ${formatMoney(s.creditedCents, cur)} recovered ${s.period.label}`
    : `${company}: your weekly Money Recovered statement, ${s.period.label}`}`;
  const manageUrl = `${siteUrl.replace(/\/$/, "")}/dashboard/recovery/statements`;

  const shown = s.rows.slice(0, EMAIL_MAX_ROWS);
  const hidden = s.rows.length - shown.length + s.rowsOmitted;

  const stat = (label: string, value: string, note: string) =>
    `<td style="width:33%;padding:12px;border:1px solid #e1e1e8;border-radius:10px;vertical-align:top">
      <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#6e6e78">${escapeHtml(label)}</div>
      <div style="font-size:20px;font-weight:700;color:#171717;margin-top:4px">${escapeHtml(value)}</div>
      <div style="font-size:11px;color:#6e6e78;margin-top:2px">${escapeHtml(note)}</div></td>`;

  const baselineHtml = s.baseline
    ? `<h2 style="${H2}">Compared with your baseline Leak Report</h2>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#171717">
        ${kv("Baseline leak, per week", formatMoney(s.baseline.weeklyLeakCents, cur), `from ${formatMoney(s.baseline.monthlyLeakCents, cur)}/month`)}
        ${kv("Slipped this week", formatMoney(s.baseline.leakedThisWeekCents, cur), `${formatPct(s.baseline.leakVsBaselinePct)} vs baseline`)}
        ${kv("Recovered by Vireek", formatMoney(s.baseline.creditedCents, cur), s.baseline.recoveredVsBaselinePct === null ? "" : `${s.baseline.recoveredVsBaselinePct}% of the weekly baseline leak`)}
       </table>`
    : `<h2 style="${H2}">Baseline Leak Report</h2>
       <p style="${P}">No baseline has been recorded yet. <a href="${escapeHtml(manageUrl)}" style="color:#203ad8">Add your Leak Report figure</a> to see this week compared with it.</p>`;

  const categoryHtml = s.categories.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">
        <tr>${["Category", "Recovered", "Not claimed", "Still open"].map((h, i) => `<th align="${i ? "right" : "left"}" style="${TH}">${h}</th>`).join("")}</tr>
        ${s.categories.map((c) => `<tr>
          <td style="${TD}">${escapeHtml(c.label)}</td>
          <td align="right" style="${TD};font-weight:600">${formatMoney(c.creditedCents, cur)} <span style="color:#6e6e78;font-weight:400">(${c.creditedCount})</span></td>
          <td align="right" style="${TD};color:#6e6e78">${formatMoney(c.notClaimedCents, cur)}</td>
          <td align="right" style="${TD};color:#6e6e78">~${formatMoney(c.openCents, cur)} (${c.openCount})</td></tr>`).join("")}
       </table>`
    : `<p style="${P}">Nothing to report by category this week.</p>`;

  const rowHtml = (r: StatementRow) => {
    const url = callUrl(siteUrl, r.callId);
    const c = STATE_COLOR[r.state];
    const link = url
      ? `<a href="${escapeHtml(url)}" style="color:#203ad8">${r.hasRecording ? "Listen &amp; view call" : "View call"}</a>`
      : `<span style="color:#9a9aa5">No call linked</span>`;
    return `<tr>
      <td style="${TD}"><div style="font-weight:600;color:#171717">${escapeHtml(r.customer)}</div>
        <div style="font-size:11px;color:#6e6e78">${escapeHtml(r.source)}</div>
        ${r.summary ? `<div style="font-size:12px;color:#44444f;margin-top:4px">${escapeHtml(r.summary)}</div>` : ""}
        <div style="font-size:12px;margin-top:4px">${link}</div>
        ${r.reason ? `<div style="font-size:11px;color:#6e6e78;margin-top:4px">${escapeHtml(REASON_LABELS[r.reason])}</div>` : ""}</td>
      <td align="right" style="${TD};white-space:nowrap;vertical-align:top">
        <div style="font-weight:700">${escapeHtml(rowAmount(r, cur))}</div>
        <span style="display:inline-block;margin-top:4px;padding:2px 8px;border-radius:999px;font-size:11px;background:${c.bg};color:${c.fg}">${STATE_LABEL[r.state]}</span></td></tr>`;
  };

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(`${formatMoney(s.creditedCents, cur)} recovered ${s.period.label}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#203ad8;height:6px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 8px">
  <div style="font-size:12px;font-weight:700;color:#203ad8">${escapeHtml(company)}</div>
  <h1 style="margin:6px 0 2px;font-size:22px;color:#171717">Money Recovered</h1>
  <div style="font-size:13px;color:#6e6e78">${escapeHtml(s.period.label)} (${escapeHtml(s.period.timezone)})</div>
  <div style="margin-top:18px;font-size:40px;font-weight:800;color:#15704a;line-height:1">${escapeHtml(formatMoney(s.creditedCents, cur))}</div>
  <div style="font-size:13px;color:#44444f;margin-top:6px">recovered by Vireek across ${s.creditedCount} ${s.creditedCount === 1 ? "customer" : "customers"}, counted conservatively (see how below).</div>
</td></tr>
<tr><td style="padding:8px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="8"><tr>
  ${stat("Recovered", formatMoney(s.creditedCents, cur), `${s.creditedCount} counted`)}
  ${stat("Not claimed", formatMoney(s.notClaimedCents, cur), `${s.notClaimedCount} didn't meet our bar`)}
  ${stat("Still recoverable", `~${formatMoney(s.stillOpenCents, cur)}`, `${s.stillOpenCount} open (estimate)`)}
</tr></table></td></tr>
<tr><td style="padding:8px 28px">${baselineHtml}</td></tr>
<tr><td style="padding:8px 28px"><h2 style="${H2}">By category</h2>${categoryHtml}</td></tr>
<tr><td style="padding:8px 28px"><h2 style="${H2}">Calls and customers we worked</h2>
  ${shown.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${shown.map(rowHtml).join("")}</table>
       ${hidden > 0 ? `<p style="${P}">+ ${hidden} more in the <a href="${escapeHtml(manageUrl)}" style="color:#203ad8">full statement</a> and the attached PDF.</p>` : ""}`
    : `<p style="${P}">No recoveries or active follow-ups this week.</p>`}
</td></tr>
${input.pilot ? <tr><td style="padding:8px 28px">${input.pilot.html}</td></tr> : ""}
<tr><td style="padding:8px 28px 20px"><div style="background:#f5f5f8;border-radius:10px;padding:14px 16px">
  <h2 style="${H2};margin-top:0">How we count (conservative attribution)</h2>
  <ol style="margin:0;padding-left:18px;font-size:12px;line-height:1.55;color:#44444f">
    ${METHODOLOGY.map((m) => `<li style="margin-bottom:6px"><strong>${escapeHtml(m.title)}.</strong> ${escapeHtml(m.body)}</li>`).join("")}
  </ol></div></td></tr>
<tr><td style="padding:0 28px 28px;font-size:11px;color:#8a8a96">Method ${escapeHtml(s.methodVersion)} · Generated ${escapeHtml(s.generatedAt.slice(0, 10))} ·
  <a href="${escapeHtml(manageUrl)}" style="color:#8a8a96">Manage this statement</a>. The full statement is attached as a PDF.</td></tr>
</table></td></tr></table></body></html>`;

  const lines: string[] = [
    `${company} — Money Recovered, ${s.period.label}`,
    "",
    `Recovered by Vireek: ${formatMoney(s.creditedCents, cur)} (${s.creditedCount} counted)`,
    `Recovered, not claimed: ${formatMoney(s.notClaimedCents, cur)} (${s.notClaimedCount})`,
    `Still recoverable (estimate): ~${formatMoney(s.stillOpenCents, cur)} (${s.stillOpenCount} open)`,
    "",
  ];
  if (s.baseline) {
    lines.push(
      "Compared with your baseline Leak Report:",
      `  Baseline per week: ${formatMoney(s.baseline.weeklyLeakCents, cur)}`,
      `  Slipped this week: ${formatMoney(s.baseline.leakedThisWeekCents, cur)} (${formatPct(s.baseline.leakVsBaselinePct)} vs baseline)`,
      `  Recovered by Vireek: ${formatMoney(s.baseline.creditedCents, cur)}`, "",
    );
  }
  if (s.categories.length) {
    lines.push("By category:");
    for (const c of s.categories) lines.push(`  ${c.label}: ${formatMoney(c.creditedCents, cur)} recovered, ${formatMoney(c.notClaimedCents, cur)} not claimed, ~${formatMoney(c.openCents, cur)} open`);
    lines.push("");
  }
  if (shown.length) {
    lines.push("Calls and customers:");
    for (const r of shown) {
      const url = callUrl(siteUrl, r.callId);
      lines.push(`- ${r.customer} · ${r.source} · ${rowAmount(r, cur)} · ${STATE_LABEL[r.state]}`);
      if (r.summary) lines.push(`  ${r.summary}`);
      if (r.reason) lines.push(`  ${REASON_LABELS[r.reason as NotClaimedReason]}`);
      if (url) lines.push(`  ${url}`);
    }
    if (hidden > 0) lines.push(`+ ${hidden} more in the full statement (${manageUrl}) and attached PDF.`);
    lines.push("");
  }
  if (input.pilot) lines.push(input.pilot.text);
  lines.push("How we count (conservative attribution):");
  METHODOLOGY.forEach((m, i) => lines.push(`${i + 1}. ${m.title}. ${m.body}`));
  lines.push("", `Manage: ${manageUrl}`);

  return { subject, html, text: lines.join("\n") };
}

const H2 = "margin:18px 0 8px;font-size:15px;color:#171717";
const P = "margin:0;font-size:13px;color:#44444f;line-height:1.5";
const TH = "padding:6px 4px;border-bottom:1px solid #e1e1e8;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6e6e78;font-weight:600";
const TD = "padding:10px 4px;border-bottom:1px solid #eeeef2";
function kv(label: string, value: string, note: string): string {
  return `<tr><td style="${TD}">${escapeHtml(label)}</td><td align="right" style="${TD};font-weight:700">${escapeHtml(value)}</td>
    <td align="right" style="${TD};color:#6e6e78;font-size:12px">${escapeHtml(note)}</td></tr>`;
}
