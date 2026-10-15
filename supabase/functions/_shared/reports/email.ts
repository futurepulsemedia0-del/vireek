// supabase/functions/_shared/reports/email.ts
//
// Pure (no Deno / no network) builders for the scheduled-report email:
// subject + HTML + plain-text bodies and the CSV attachment. Every value that
// comes from the database (caller names, customer names, report names…) is
// HTML-escaped — caller names come from the public phone line and must never
// be able to inject markup into an email we send under the customer's brand.

import {
  RANGE_LABELS,
  formatCell,
  getField,
  groupLabel,
  formatMetricNumber,
  type CurrencyCode,
  type ExportCell,
  type ExportTable,
  type FieldDef,
  type ReportDefinition,
  type ReportResult,
} from "./engine.ts";

export const EMAIL_MAX_GROUPS = 25;
export const EMAIL_MAX_ROWS = 25;
export const EMAIL_MAX_COLUMNS = 6;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function csvCell(v: ExportCell): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows non-Latin scripts correctly. */
export function toCsv(table: ExportTable): string {
  const lines = [table.headers.map(csvCell).join(","), ...table.rows.map((r) => r.map(csvCell).join(","))];
  return "\uFEFF" + lines.join("\r\n");
}

/** Display name safe to place inside an RFC 5322 From header. */
export function safeDisplayName(name: string | null | undefined): string {
  return (name ?? "").replace(/[\r\n"<>@,;:\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface ReportEmailInput {
  companyName: string | null;
  reportName: string;
  description: string | null;
  def: ReportDefinition;
  result: ReportResult;
  currency: CurrencyCode;
  truncated: boolean;
  csvAttached: boolean;
  generatedAt: Date;
  siteUrl: string;
}

export interface ReportEmail {
  subject: string;
  html: string;
  text: string;
}

const C = { ink: "#17171a", muted: "#676770", line: "#e7e5e0", soft: "#f6f4f0", accent: "#203ad8" };

export function buildReportEmail(input: ReportEmailInput): ReportEmail {
  const { def, result, currency } = input;
  const range = RANGE_LABELS[def.range];
  const subject = `${input.reportName.replace(/[\r\n]+/g, " ").slice(0, 120)} — ${range}`;
  const company = input.companyName?.trim() || "your business";
  const generated = input.generatedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const summary = `${result.matched.toLocaleString("en-US")} ${def.entity} matched · ${range} · generated ${generated}`;

  let tableHtml = "";
  let tableText = "";
  let note = "";

  if (result.matched === 0) {
    tableHtml = `<p style="margin:16px 0;color:${C.muted};font-size:14px">No data matched this report for the period.</p>`;
    tableText = "No data matched this report for the period.";
  } else if (result.kind === "grouped") {
    const groups = result.groups.slice(0, EMAIL_MAX_GROUPS);
    const mField = def.metric.field ? getField(def.entity, def.metric.field) : undefined;
    const fmt = (v: number) => formatMetricNumber(v, def.metric.fn === "count" ? undefined : mField?.format, currency);
    const max = Math.max(...groups.map((g) => Math.max(0, g.value ?? 0)), 0);
    const showMetric = def.metric.fn !== "count";
    const head = `<tr><th align="left" style="${th()}">${escapeHtml(groupLabel(def))}</th><th align="right" style="${th()}">Rows</th>${
      showMetric ? `<th align="right" style="${th()}">${escapeHtml(result.metricLabel)}</th>` : ""
    }<th style="${th()};width:30%"></th></tr>`;
    const body = groups
      .map((g) => {
        const pct = max > 0 ? Math.round((Math.max(0, g.value ?? 0) / max) * 100) : 0;
        return `<tr><td style="${td()}">${escapeHtml(g.label)}</td><td align="right" style="${td()}">${g.count.toLocaleString("en-US")}</td>${
          showMetric ? `<td align="right" style="${td()};font-weight:600">${g.value === null ? "—" : escapeHtml(fmt(g.value))}</td>` : ""
        }<td style="${td()}"><div style="background:${C.soft};border-radius:6px;height:8px"><div style="background:${C.accent};border-radius:6px;height:8px;width:${pct}%"></div></div></td></tr>`;
      })
      .join("");
    tableHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0">${head}${body}</table>`;
    tableText = groups
      .map((g) => `${g.label}: ${g.count}${showMetric ? ` · ${g.value === null ? "—" : fmt(g.value)}` : ""}`)
      .join("\n");
    const hidden = result.groups.length - groups.length + result.hiddenGroups;
    if (hidden > 0) note = `${hidden} more group${hidden === 1 ? "" : "s"} not shown here${input.csvAttached ? " — see the attached CSV" : ""}.`;
  } else {
    const fields = def.columns
      .map((k) => getField(def.entity, k))
      .filter((f): f is FieldDef => !!f)
      .slice(0, EMAIL_MAX_COLUMNS);
    const rows = result.rows.slice(0, EMAIL_MAX_ROWS);
    const head = `<tr>${fields.map((f) => `<th align="left" style="${th()}">${escapeHtml(f.label)}</th>`).join("")}</tr>`;
    const body = rows
      .map((r) => `<tr>${fields.map((f) => `<td style="${td()}">${escapeHtml(formatCell(f, r[f.key], currency))}</td>`).join("")}</tr>`)
      .join("");
    tableHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0">${head}${body}</table>`;
    tableText = rows.map((r) => fields.map((f) => formatCell(f, r[f.key], currency)).join(" | ")).join("\n");
    if (result.matched > rows.length) {
      note = `Showing the first ${rows.length} of ${result.matched.toLocaleString("en-US")} rows${input.csvAttached ? " — the full list is in the attached CSV" : ""}.`;
    }
  }

  const warn = input.truncated
    ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff6e5;border-radius:8px;color:#7a4a00;font-size:13px">This period contains more than 5,000 records, so only the most recent 5,000 are included.</p>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;background:${C.soft};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
<div style="background:#ffffff;border:1px solid ${C.line};border-radius:16px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">Scheduled report</p>
<h1 style="margin:0;font-size:22px;line-height:1.3">${escapeHtml(input.reportName)}</h1>
${input.description ? `<p style="margin:8px 0 0;color:${C.muted};font-size:14px">${escapeHtml(input.description)}</p>` : ""}
<p style="margin:12px 0 16px;color:${C.muted};font-size:13px">${escapeHtml(summary)}</p>
${warn}${tableHtml}
${note ? `<p style="margin:0 0 8px;color:${C.muted};font-size:13px">${escapeHtml(note)}</p>` : ""}
<p style="margin:16px 0 0"><a href="${escapeHtml(input.siteUrl)}/dashboard/reports" style="color:${C.accent};font-size:14px;font-weight:600;text-decoration:none">Open in Vireek →</a></p>
</div>
<p style="margin:16px 8px 0;color:${C.muted};font-size:12px;line-height:1.5">Sent by Vireek on behalf of ${escapeHtml(company)}. To change or stop these emails, ask an account admin to edit the schedule under Reports → Scheduled.</p>
</div></body></html>`;

  const text = [`${input.reportName}`, summary, "", tableText, note ? `\n${note}` : "", `\nOpen in Vireek: ${input.siteUrl}/dashboard/reports`, `\nSent by Vireek on behalf of ${company}.`]
    .filter((p) => p !== undefined)
    .join("\n");

  return { subject, html, text };
}

function th(): string {
  return `padding:8px 10px;border-bottom:1px solid ${C.line};background:${C.soft};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em`;
}
function td(): string {
  return `padding:8px 10px;border-bottom:1px solid ${C.line};font-size:14px`;
}
