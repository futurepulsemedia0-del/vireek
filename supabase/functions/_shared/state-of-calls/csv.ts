// supabase/functions/_shared/state-of-calls/csv.ts
// CSV export of PUBLISHED cells only. Column allowlist is fixed; every text field is neutralised against
// spreadsheet formula injection (=, +, -, @, tab, CR) and quoted per RFC 4180.

import { metricByKey, type PublishedCell } from "./schema.ts";

export const CSV_COLUMNS = [
  "edition", "metric_key", "metric_label", "dim", "dim_value", "period_key", "unit",
  "suppressed", "suppression_reason", "n_orgs", "n_events", "value", "p25", "p50", "p75", "source",
] as const;

export function csvText(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const num = (v: number | null) => (v === null ? "" : String(v));

export function toCsv(cells: readonly PublishedCell[], edition: { slug: string; title: string }): string {
  const source = `Vireek, ${edition.title}`;
  const lines = [CSV_COLUMNS.join(",")];
  for (const c of cells) {
    lines.push([
      csvText(edition.slug), csvText(c.metric_key), csvText(metricByKey(c.metric_key)?.label ?? c.metric_key),
      csvText(c.dim), csvText(c.dim_value), csvText(c.period_key), csvText(c.unit),
      c.suppressed ? "true" : "false", csvText(c.suppression_reason ?? ""),
      num(c.n_orgs), num(c.n_events), num(c.value), num(c.p25), num(c.p50), num(c.p75), csvText(source),
    ].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
