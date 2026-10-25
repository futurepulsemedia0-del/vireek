// supabase/functions/_shared/data-platform/reverseEtl.ts
//
// Reverse ETL: push Vireek's modelled data back out to the tools teams actually work in.
//   Google Sheets  — metrics, daily metrics, recent jobs, customer lists (call lists, win-back lists)
//   Mailchimp      — audience segments, subscribed ONLY if the customer has given marketing consent
//   Klaviyo        — same audiences, imported as profiles into a list
//
// This file is pure: it builds the rows, the consent filter and the exact API payloads. The edge
// function sends them. Compliance rules that live here and are unit-tested:
//   - Email tools never receive a customer without marketing_opt_in = true and a valid email.
//   - Mailchimp members are upserted with status_if_new, so an existing "unsubscribed" or "cleaned"
//     contact is NEVER resubscribed by a sync.
//   - Sheets values are written RAW, so a customer named "=HYPERLINK(...)" stays text.

import { dailySnapshots, formatMetric, computeMetrics, defaultQuery, METRICS, prepare, type MetricData } from "./metrics.ts";

export type ReverseDestinationKind = "sheets" | "mailchimp" | "klaviyo";
export const REVERSE_KINDS: readonly ReverseDestinationKind[] = ["sheets", "mailchimp", "klaviyo"];
export const REVERSE_META: Record<ReverseDestinationKind, { label: string; blurb: string }> = {
  sheets: { label: "Google Sheets", blurb: "Keeps a tab of a Google Sheet up to date. The sheet is shared with your own service account." },
  mailchimp: { label: "Mailchimp", blurb: "Adds consented customers to an audience with a tag. Never resubscribes anyone." },
  klaviyo: { label: "Klaviyo", blurb: "Imports consented customers as profiles into a list." },
};

export type ModelKey = "metrics_summary" | "metrics_daily" | "jobs_90d" | "lapsed_customers" | "high_value_customers" | "recent_customers";

export interface ModelDef {
  key: ModelKey;
  label: string;
  description: string;
  kind: "table" | "audience";
  destinations: readonly ReverseDestinationKind[];
  /** Tunable parameter, if any. */
  param?: { key: string; label: string; default: number; min: number; max: number };
}

export const MODELS: Record<ModelKey, ModelDef> = {
  metrics_summary: { key: "metrics_summary", label: "Metrics summary", description: "Last 30 days of every official metric against the 30 days before, with definitions.", kind: "table", destinations: ["sheets"] },
  metrics_daily: { key: "metrics_daily", label: "Metrics by day", description: "Every metric for each of the last 90 days. Ideal for pivot charts.", kind: "table", destinations: ["sheets"] },
  jobs_90d: { key: "jobs_90d", label: "Jobs (last 90 days)", description: "Completed jobs with service, technician, amount and response time. No customer names.", kind: "table", destinations: ["sheets"] },
  lapsed_customers: { key: "lapsed_customers", label: "Lapsed customers", description: "Customers with completed work whose last job was a long time ago. Win-back list.", kind: "audience", destinations: ["sheets", "mailchimp", "klaviyo"], param: { key: "months", label: "No job for (months)", default: 12, min: 3, max: 60 } },
  high_value_customers: { key: "high_value_customers", label: "High-value customers", description: "Customers whose lifetime revenue is above a threshold. VIP and referral campaigns.", kind: "audience", destinations: ["sheets", "mailchimp", "klaviyo"], param: { key: "min_revenue", label: "Lifetime revenue at least", default: 2000, min: 100, max: 1_000_000 } },
  recent_customers: { key: "recent_customers", label: "New customers", description: "Customers whose first completed job was recent. Welcome and review-request flows.", kind: "audience", destinations: ["sheets", "mailchimp", "klaviyo"], param: { key: "days", label: "First job within (days)", default: 30, min: 1, max: 365 } },
};
export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];
export const isModelKey = (v: unknown): v is ModelKey => typeof v === "string" && (MODEL_KEYS as string[]).includes(v);

export type Cell = string | number | boolean | null;
export interface TableOutput { columns: string[]; rows: Cell[][]; truncated: boolean }

export const MAX_SHEET_ROWS = 20_000;

// ============================================================
// Audience data and models
// ============================================================

export interface AudienceCustomer {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  marketing_opt_in: boolean | null;
  lifecycle_stage: string | null;
}
export interface AudienceJob { customer_id: string | null; job_status: string; invoice_amount: number | null; completed_at: string | null; created_at: string }

export interface AudienceMember {
  customer_id: string;
  email: string | null;
  phone: string | null;
  first_name: string;
  last_name: string;
  consent: boolean;
  lifetime_revenue: number;
  completed_jobs: number;
  last_job_at: string | null;
  first_job_at: string | null;
}

export const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']{2,}$/;

export function splitName(name: string | null): { first: string; last: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  return { first: parts[0].slice(0, 60), last: parts.slice(1).join(" ").slice(0, 60) };
}

export function buildAudience(customers: readonly AudienceCustomer[], jobs: readonly AudienceJob[]): AudienceMember[] {
  const by = new Map<string, { rev: number; n: number; first: number | null; last: number | null }>();
  for (const j of jobs) {
    if (!j.customer_id || j.job_status !== "completed") continue;
    const t = Date.parse(j.completed_at ?? j.created_at);
    const g = by.get(j.customer_id) ?? { rev: 0, n: 0, first: null, last: null };
    g.n += 1;
    g.rev += Number(j.invoice_amount) > 0 ? Number(j.invoice_amount) : 0;
    if (Number.isFinite(t)) {
      g.first = g.first === null ? t : Math.min(g.first, t);
      g.last = g.last === null ? t : Math.max(g.last, t);
    }
    by.set(j.customer_id, g);
  }
  return customers.map((c) => {
    const g = by.get(c.id);
    const { first, last } = splitName(c.name);
    return {
      customer_id: c.id,
      email: c.email?.trim().toLowerCase() || null,
      phone: c.phone?.trim() || null,
      first_name: first,
      last_name: last,
      consent: c.marketing_opt_in === true,
      lifetime_revenue: Math.round((g?.rev ?? 0) * 100) / 100,
      completed_jobs: g?.n ?? 0,
      last_job_at: g?.last != null ? new Date(g.last).toISOString() : null,
      first_job_at: g?.first != null ? new Date(g.first).toISOString() : null,
    };
  });
}

export function modelParam(model: ModelKey, raw: unknown): number {
  const p = MODELS[model].param;
  if (!p) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default;
}

export function selectAudience(model: ModelKey, members: readonly AudienceMember[], param: number, now: Date): AudienceMember[] {
  const t = now.getTime();
  switch (model) {
    case "lapsed_customers": {
      const cutoff = t - param * 30.44 * 86_400_000;
      return members.filter((m) => m.completed_jobs > 0 && m.last_job_at !== null && Date.parse(m.last_job_at) < cutoff);
    }
    case "high_value_customers":
      return members.filter((m) => m.lifetime_revenue >= param).sort((a, b) => b.lifetime_revenue - a.lifetime_revenue);
    case "recent_customers": {
      const cutoff = t - param * 86_400_000;
      return members.filter((m) => m.first_job_at !== null && Date.parse(m.first_job_at) >= cutoff);
    }
    default:
      return [];
  }
}

/** Only people who consented AND have a usable email may reach an email tool. */
export function consentedWithEmail(members: readonly AudienceMember[]): { eligible: AudienceMember[]; skippedNoConsent: number; skippedNoEmail: number } {
  const eligible: AudienceMember[] = [];
  let skippedNoConsent = 0;
  let skippedNoEmail = 0;
  const seen = new Set<string>();
  for (const m of members) {
    if (!m.consent) { skippedNoConsent++; continue; }
    if (!m.email || !EMAIL_RE.test(m.email)) { skippedNoEmail++; continue; }
    if (seen.has(m.email)) continue;
    seen.add(m.email);
    eligible.push(m);
  }
  return { eligible, skippedNoConsent, skippedNoEmail };
}

export function audienceTable(members: readonly AudienceMember[]): TableOutput {
  const rows = members.slice(0, MAX_SHEET_ROWS).map((m): Cell[] => [
    `${m.first_name} ${m.last_name}`.trim(), m.email, m.phone, m.consent, m.completed_jobs, m.lifetime_revenue, m.last_job_at?.slice(0, 10) ?? null,
  ]);
  return { columns: ["Name", "Email", "Phone", "Marketing consent", "Completed jobs", "Lifetime revenue", "Last job"], rows, truncated: members.length > MAX_SHEET_ROWS };
}

// ============================================================
// Table models
// ============================================================

export function metricsSummaryTable(data: MetricData, now: Date, tz: string, currency: string): TableOutput {
  const q = defaultQuery({ now, days: 30, tz, compare: true });
  const res = computeMetrics(data, q, prepare(data));
  const rows = res.results.map((m): Cell[] => [
    m.label,
    m.total.value,
    m.prior?.value ?? null,
    m.delta?.value ?? null,
    m.delta ? (m.delta.kind === "pts" ? "points" : "%") : "",
    formatMetric(m.unit, m.total.value, currency),
    METRICS[m.id].definition,
  ]);
  return { columns: ["Metric", "Last 30 days", "Previous 30 days", "Change", "Change unit", "Formatted", "Definition"], rows, truncated: false };
}

export function metricsDailyTable(data: MetricData, now: Date, tz: string): TableOutput {
  const snaps = dailySnapshots(data, { days: 90, tz, now });
  const rows = snaps.map((s): Cell[] => [s.day, METRICS[s.metric_id].label, s.value, s.sample_size]);
  return { columns: ["Day", "Metric", "Value", "Rows behind value"], rows, truncated: false };
}

export function jobs90Table(data: MetricData, now: Date): TableOutput {
  const since = now.getTime() - 90 * 86_400_000;
  const tech = new Map(data.technicians.map((t) => [t.id, t.name]));
  const rows: Cell[][] = [];
  for (const j of data.jobs) {
    if (j.job_status !== "completed") continue;
    const at = Date.parse(j.completed_at ?? j.scheduled_datetime ?? j.created_at);
    if (!Number.isFinite(at) || at < since) continue;
    const created = Date.parse(j.created_at);
    const first = j.first_response_at ? Date.parse(j.first_response_at) : NaN;
    rows.push([
      new Date(at).toISOString().slice(0, 10), j.service_type ?? "", j.assigned_technician_id ? tech.get(j.assigned_technician_id) ?? "Former team member" : "Unassigned",
      j.customer_type ?? "", j.invoice_amount ?? null, j.invoice_status ?? "",
      Number.isFinite(first) && first >= created ? Math.round(((first - created) / 60_000) * 10) / 10 : null,
    ]);
  }
  rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  return {
    columns: ["Completed", "Service", "Technician", "Customer type", "Invoice amount", "Invoice status", "Response (min)"],
    rows: rows.slice(0, MAX_SHEET_ROWS),
    truncated: rows.length > MAX_SHEET_ROWS,
  };
}

// ============================================================
// Google Sheets
// ============================================================

export function validSheetTab(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 100 && !/[\[\]*?:/\\]/.test(v) && v === v.trim();
}
export const validSpreadsheetId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(v);

/** A1 range with a quoted tab name. */
export function sheetRange(tab: string, a1: string): string {
  return `'${tab.replace(/'/g, "''")}'!${a1}`;
}

/** Header + rows, every cell a plain value. Written with valueInputOption=RAW so nothing is evaluated as a formula. */
export function sheetValues(t: TableOutput): Cell[][] {
  return [t.columns, ...t.rows.map((r) => r.map((c) => (c === null ? "" : c)))];
}

export function columnLetter(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// ============================================================
// Mailchimp
// ============================================================

/** MD5 (RFC 1321). Mailchimp addresses a member by the MD5 of the lower-cased email. */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len << 3) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16).map((_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const sh = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << sh) | (F >>> (32 - sh)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "abc123-us21" -> "us21". Validated so the host can only ever be <dc>.api.mailchimp.com. */
export function mailchimpDc(apiKey: string): string | null {
  const m = /^[0-9a-f]{32}-([a-z]{2}\d{1,2})$/.exec(apiKey.trim());
  return m ? m[1] : null;
}

export const validMailchimpListId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{10}$/.test(v);

export function mailchimpMemberRequest(listId: string, m: AudienceMember, tag: string) {
  const email = m.email as string;
  return {
    path: `/3.0/lists/${listId}/members/${md5(email.toLowerCase())}`,
    body: {
      email_address: email,
      status_if_new: "subscribed",
      merge_fields: { FNAME: m.first_name, LNAME: m.last_name, ...(m.phone ? { PHONE: m.phone } : {}) },
      tags: [tag],
    },
  };
}

export function validTag(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9 _:.-]{1,60}$/.test(v);
}

// ============================================================
// Klaviyo
// ============================================================

export const KLAVIYO_REVISION = "2024-10-15";
export const validKlaviyoListId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{6,12}$/.test(v);

/** E.164 or null. 10-digit numbers are treated as US/Canada. */
export function toE164(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, "");
  if (phone.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function klaviyoImportBody(listId: string, members: readonly AudienceMember[], segment: string) {
  return {
    data: {
      type: "profile-bulk-import-job",
      attributes: {
        profiles: {
          data: members.map((m) => {
            const phone = toE164(m.phone);
            return {
              type: "profile",
              attributes: {
                email: m.email,
                ...(phone ? { phone_number: phone } : {}),
                first_name: m.first_name,
                last_name: m.last_name,
                properties: { vireek_segment: segment, vireek_lifetime_revenue: m.lifetime_revenue, vireek_completed_jobs: m.completed_jobs, vireek_last_job_date: m.last_job_at?.slice(0, 10) ?? null },
              },
            };
          }),
        },
      },
      relationships: { lists: { data: [{ type: "list", id: listId }] } },
    },
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ============================================================
// Config validation
// ============================================================

export interface ReverseConfig {
  kind: ReverseDestinationKind;
  spreadsheet_id?: string;
  tab?: string;
  list_id?: string;
  tag?: string;
}

export function validateReverseConfig(kind: ReverseDestinationKind, raw: unknown): { ok: true; value: ReverseConfig } | { ok: false; errors: Record<string, string> } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (kind === "sheets") {
    const spreadsheet_id = typeof r.spreadsheet_id === "string" ? (/\/d\/([A-Za-z0-9_-]+)/.exec(r.spreadsheet_id)?.[1] ?? r.spreadsheet_id.trim()) : "";
    const tab = typeof r.tab === "string" ? r.tab.trim() : "Vireek";
    if (!validSpreadsheetId(spreadsheet_id)) errors.spreadsheet_id = "Paste the Google Sheet URL or its id.";
    if (!validSheetTab(tab)) errors.tab = "Tab names can't be empty or contain [ ] * ? : / \\";
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { kind, spreadsheet_id, tab } };
  }
  const list_id = typeof r.list_id === "string" ? r.list_id.trim() : "";
  const tag = typeof r.tag === "string" && r.tag.trim() ? r.tag.trim() : "vireek";
  if (kind === "mailchimp" && !validMailchimpListId(list_id)) errors.list_id = "Enter the Mailchimp audience id (10 characters).";
  if (kind === "klaviyo" && !validKlaviyoListId(list_id)) errors.list_id = "Enter the Klaviyo list id.";
  if (kind === "mailchimp" && !validTag(tag)) errors.tag = "Use letters, digits, spaces and - _ : . (max 60).";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { kind, list_id, tag } };
}
