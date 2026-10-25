// supabase/functions/_shared/data-platform/catalog.ts
//
// THE schema contract of the Vireek Data Platform. One explicit whitelist of
// the tables and columns that may leave the product, with a type, a plain-English
// description and a privacy class for every column.
//
//   - The warehouse sync (BigQuery / Snowflake / Postgres) creates tables FROM this file,
//     writes the descriptions into the warehouse as column comments, and only ever
//     SELECTs the columns listed here. Transcripts, recordings, notes, signatures and
//     photos are not in the catalog, so they can never be exported by accident.
//   - The "Schema" tab, the downloadable data dictionary and the docs read the same file.
//
// Pure: no network, no database, no Deno/DOM APIs except WebCrypto (Deno, browsers, Node 20+).
// Imported by the edge functions AND by the React app (same pattern as crm/engine.ts).

export type ColumnType = "uuid" | "text" | "integer" | "number" | "boolean" | "timestamp" | "date" | "json";

/**
 * Privacy class of a column.
 *   identifier — direct contact handle (email, phone). Pseudonymised in "hashed" mode.
 *   sensitive  — free-form personal data (names, street addresses). Blanked in "hashed" mode.
 *   (none)     — operational data, always exported.
 */
export type PiiClass = "identifier" | "sensitive";
export type PiiMode = "hashed" | "full" | "omit";
export const PII_MODES: readonly PiiMode[] = ["hashed", "full", "omit"];

export const PII_MODE_META: Record<PiiMode, { label: string; description: string }> = {
  hashed: {
    label: "Pseudonymised (recommended)",
    description:
      "Emails and phone numbers are replaced by a stable keyed hash so you can still join and count unique people. Names and street addresses are left empty.",
  },
  full: {
    label: "Full personal data",
    description: "Names, emails, phones and addresses are copied as-is. Only choose this if your warehouse is approved for customer PII.",
  },
  omit: {
    label: "No personal data",
    description: "Every personal column is left empty. Operational and financial columns are still exported.",
  },
};

export interface ColumnDef {
  name: string;
  type: ColumnType;
  description: string;
  pii?: PiiClass;
}

export type DatasetKey =
  | "customers"
  | "leads"
  | "calls"
  | "jobs"
  | "quotes"
  | "job_costs"
  | "revenue_recovery"
  | "metrics_daily";

export interface DatasetDef {
  key: DatasetKey;
  label: string;
  description: string;
  /** Source table in Vireek's database. */
  source: string;
  /** Monotonic column used as the incremental watermark (always paired with `id` as tie-break). */
  cursor: "updated_at";
  columns: readonly ColumnDef[];
}

const c = (name: string, type: ColumnType, description: string, pii?: PiiClass): ColumnDef =>
  pii ? { name, type, description, pii } : { name, type, description };

export const DATASETS: Record<DatasetKey, DatasetDef> = {
  customers: {
    key: "customers",
    label: "Customers",
    description: "One row per customer or contact, with lifecycle stage and marketing consent.",
    source: "customers",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique customer id (primary key)."),
      c("name", "text", "Customer name.", "sensitive"),
      c("phone", "text", "Phone number.", "identifier"),
      c("email", "text", "Email address.", "identifier"),
      c("address", "text", "Service address.", "sensitive"),
      c("customer_type", "text", "residential or commercial."),
      c("lifecycle_stage", "text", "lead, active, vip or inactive."),
      c("source", "text", "How the customer entered Vireek: manual, call, lead, job or import."),
      c("tags", "json", "Free-form tags (JSON array of strings)."),
      c("marketing_opt_in", "boolean", "True when the customer has consented to marketing email."),
      c("marketing_opt_in_at", "timestamp", "When marketing consent was recorded."),
      c("last_contacted_at", "timestamp", "Last time the business contacted this customer."),
      c("created_at", "timestamp", "When the customer was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  leads: {
    key: "leads",
    label: "Leads",
    description: "Every inquiry that could become a job, with its pipeline stage and quoted amount.",
    source: "leads",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique lead id (primary key)."),
      c("customer_id", "uuid", "Linked customer, when known."),
      c("call_id", "uuid", "Call that produced the lead, when any."),
      c("name", "text", "Lead name.", "sensitive"),
      c("phone", "text", "Phone number.", "identifier"),
      c("email", "text", "Email address.", "identifier"),
      c("service_interested", "text", "Service the lead asked about."),
      c("stage", "text", "new, contacted, quoted, won or lost."),
      c("quote_amount", "number", "Amount quoted, in the account currency."),
      c("follow_up_count", "integer", "Number of follow-ups sent."),
      c("quote_sent_at", "timestamp", "When the quote was sent."),
      c("stage_updated_at", "timestamp", "When the stage last changed."),
      c("tags", "json", "Free-form tags (JSON array of strings)."),
      c("created_at", "timestamp", "When the lead was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  calls: {
    key: "calls",
    label: "Calls",
    description: "Inbound and outbound calls handled by the AI receptionist. Transcripts and recordings are never exported.",
    source: "calls",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique call id (primary key)."),
      c("customer_id", "uuid", "Linked customer, when known."),
      c("caller_name", "text", "Caller name.", "sensitive"),
      c("caller_phone", "text", "Caller phone number.", "identifier"),
      c("call_datetime", "timestamp", "When the call started."),
      c("duration_seconds", "integer", "Call length in seconds."),
      c("status", "text", "new_lead, booked, missed, callback_requested or spam."),
      c("sentiment", "text", "positive, neutral or negative."),
      c("is_emergency", "boolean", "True for emergency calls."),
      c("is_voicemail", "boolean", "True when the caller left a voicemail."),
      c("call_score", "number", "AI call-quality score."),
      c("lead_score", "number", "AI lead-quality score."),
      c("lead_source", "text", "Marketing source the call is attributed to."),
      c("intent", "text", "Detected caller intent."),
      c("booking_outcome", "text", "booked, not_booked, already_scheduled or not_applicable."),
      c("created_at", "timestamp", "When the row was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  jobs: {
    key: "jobs",
    label: "Jobs",
    description: "Scheduled and completed work, with invoice amount, status and response timestamps.",
    source: "jobs",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique job id (primary key)."),
      c("customer_id", "uuid", "Customer the job is for."),
      c("lead_id", "uuid", "Originating lead, when any."),
      c("call_id", "uuid", "Originating call, when any."),
      c("customer_name", "text", "Customer name as written on the job.", "sensitive"),
      c("service_type", "text", "Type of service."),
      c("address", "text", "Job address.", "sensitive"),
      c("customer_type", "text", "residential or commercial."),
      c("job_status", "text", "scheduled, en_route, in_progress, completed, cancelled or no_show."),
      c("assigned_technician_id", "uuid", "Assigned technician (team member id)."),
      c("scheduled_datetime", "timestamp", "Scheduled start."),
      c("started_at", "timestamp", "Actual start."),
      c("completed_at", "timestamp", "Actual completion."),
      c("first_response_at", "timestamp", "When the job first left 'scheduled'. Used for response time."),
      c("duration_minutes", "integer", "Actual duration in minutes."),
      c("expected_duration_minutes", "integer", "Planned duration in minutes."),
      c("invoice_amount", "number", "Invoiced amount, in the account currency."),
      c("invoice_status", "text", "not_sent, sent or paid."),
      c("is_rework", "boolean", "True when the job is a repeat visit for earlier work."),
      c("created_at", "timestamp", "When the job was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  quotes: {
    key: "quotes",
    label: "Quotes",
    description: "Quotes sent to customers and their outcome. Close rate is computed from this table.",
    source: "quotes",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique quote id (primary key)."),
      c("lead_id", "uuid", "Lead the quote belongs to."),
      c("customer_name", "text", "Customer name on the quote.", "sensitive"),
      c("customer_email", "text", "Customer email on the quote.", "identifier"),
      c("customer_phone", "text", "Customer phone on the quote.", "identifier"),
      c("line_items", "json", "Quote line items (JSON array)."),
      c("tax_percent", "number", "Tax rate applied, in percent."),
      c("status", "text", "draft, sent, accepted, declined or expired."),
      c("sent_at", "timestamp", "When the quote was sent."),
      c("responded_at", "timestamp", "When the customer responded."),
      c("valid_until", "date", "Last day the quote is valid."),
      c("created_at", "timestamp", "When the quote was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  job_costs: {
    key: "job_costs",
    label: "Job costs",
    description: "Labor, material and other cost entries per job. Gross margin is computed from this table.",
    source: "job_cost_entries",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique cost entry id (primary key)."),
      c("job_id", "uuid", "Job the cost belongs to."),
      c("category", "text", "labor, material, equipment, subcontractor, permit or other."),
      c("description", "text", "What the cost was for."),
      c("quantity", "number", "Quantity."),
      c("unit_cost_cents", "integer", "Unit cost in cents."),
      c("total_cost_cents", "integer", "quantity x unit cost, in cents (computed by the database)."),
      c("team_member_id", "uuid", "Team member the cost is attributed to."),
      c("created_at", "timestamp", "When the entry was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  revenue_recovery: {
    key: "revenue_recovery",
    label: "Revenue recovery",
    description: "Ledger of missed calls, voicemails and lost quotes and whether the revenue was won back.",
    source: "revenue_recovery_events",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique event id (primary key)."),
      c("source_type", "text", "missed_call, voicemail, not_booked, declined_quote, expired_quote or cancelled_job."),
      c("source_table", "text", "Table the event points at: calls, quotes or jobs."),
      c("source_id", "uuid", "Row the event points at."),
      c("lead_id", "uuid", "Related lead."),
      c("call_id", "uuid", "Related call."),
      c("customer_name", "text", "Customer or caller name.", "sensitive"),
      c("customer_phone", "text", "Customer or caller phone.", "identifier"),
      c("occurred_at", "timestamp", "When the opportunity was lost."),
      c("estimated_value_cents", "integer", "Estimated value of the opportunity, in cents."),
      c("status", "text", "open, contacted, recovered or written_off."),
      c("recovery_method", "text", "How it was recovered: callback, sms, quote_resent, rebooked, manual or other."),
      c("recovered_job_id", "uuid", "Job that recovered the revenue."),
      c("recovered_amount_cents", "integer", "Revenue recovered, in cents."),
      c("follow_up_count", "integer", "Follow-ups performed."),
      c("resolved_at", "timestamp", "When the event was resolved."),
      c("created_at", "timestamp", "When the row was created."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
  metrics_daily: {
    key: "metrics_daily",
    label: "Metrics (daily)",
    description:
      "Daily values of every semantic metric (revenue, close rate, margin, response time...). Computed once by Vireek so your BI tool shows the same numbers as the dashboard.",
    source: "metric_snapshots",
    cursor: "updated_at",
    columns: [
      c("id", "uuid", "Unique snapshot id (primary key)."),
      c("metric_id", "text", "Metric key, e.g. revenue or close_rate. See the metric definitions."),
      c("day", "date", "Calendar day in the account time zone."),
      c("value", "number", "Metric value for that day. NULL when there is no data (never a fake zero)."),
      c("numerator", "number", "Numerator for ratio metrics."),
      c("denominator", "number", "Denominator for ratio metrics."),
      c("sample_size", "integer", "Rows behind the value."),
      c("definition_version", "integer", "Version of the metric definition used."),
      c("computed_at", "timestamp", "When the value was computed."),
      c("updated_at", "timestamp", "Last change. Drives incremental sync."),
    ],
  },
};

export const DATASET_KEYS = Object.keys(DATASETS) as DatasetKey[];
export const DEFAULT_DATASETS: readonly DatasetKey[] = ["customers", "leads", "calls", "jobs", "quotes", "job_costs", "metrics_daily"];

/** Columns Vireek adds to every warehouse table. */
export const META_COLUMNS: readonly ColumnDef[] = [
  c("account_id", "uuid", "Vireek account (owner) the row belongs to."),
  c("_vireek_synced_at", "timestamp", "When this row was last written by Vireek."),
  c("_vireek_deleted", "boolean", "True when the row no longer exists in Vireek (set by the weekly full refresh)."),
];

export function isDatasetKey(v: unknown): v is DatasetKey {
  return typeof v === "string" && (DATASET_KEYS as string[]).includes(v);
}

export function allColumns(dataset: DatasetKey): ColumnDef[] {
  return [...DATASETS[dataset].columns, ...META_COLUMNS];
}

/** Source columns to SELECT (never `*`). */
export function selectList(dataset: DatasetKey): string {
  return DATASETS[dataset].columns.map((col) => col.name).join(",");
}

// ============================================================
// Row transform (source row -> warehouse row)
// ============================================================

export type Pseudonymize = (value: string, kind: "email" | "phone" | "text") => Promise<string>;

export function normalizeIdentifier(value: string, kind: "email" | "phone" | "text"): string {
  const v = value.trim();
  if (kind === "email") return v.toLowerCase();
  if (kind === "phone") return v.replace(/\D+/g, "");
  return v;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Keyed, per-account pseudonymiser: HMAC-SHA256(HMAC(secret, accountId), normalised value) as hex.
 * Stable across runs (joins and unique counts keep working), not reversible by a dictionary
 * attack without the server secret, and different for every account.
 */
export async function createPseudonymizer(secret: string, accountId: string): Promise<Pseudonymize> {
  const enc = new TextEncoder();
  const sign = async (key: CryptoKey, data: string) => crypto.subtle.sign("HMAC", key, enc.encode(data));
  const master = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const accountKeyRaw = await sign(master, `vireek:pii:${accountId}`);
  const key = await crypto.subtle.importKey("raw", accountKeyRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return async (value, kind) => {
    const norm = normalizeIdentifier(value, kind);
    return norm ? hex(await sign(key, norm)) : "";
  };
}

const identifierKind = (name: string): "email" | "phone" | "text" =>
  /email/.test(name) ? "email" : /phone/.test(name) ? "phone" : "text";

function coerce(type: ColumnType, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  switch (type) {
    case "integer": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return typeof v === "boolean" ? v : v === "true" || v === "t" || v === 1 ? true : v === "false" || v === "f" || v === 0 ? false : null;
    case "json":
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    case "timestamp": {
      const t = Date.parse(String(v));
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null;
    default:
      return String(v);
  }
}

export interface TransformContext {
  accountId: string;
  piiMode: PiiMode;
  pseudonymize: Pseudonymize;
  syncedAt: string;
}

/** Produces exactly the warehouse columns (catalog + meta), in catalog order, with privacy applied. */
export async function transformRow(
  dataset: DatasetKey,
  row: Record<string, unknown>,
  ctx: TransformContext,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const col of DATASETS[dataset].columns) {
    const raw = row[col.name];
    if (col.pii && ctx.piiMode !== "full") {
      if (ctx.piiMode === "hashed" && col.pii === "identifier" && typeof raw === "string" && raw.trim()) {
        out[col.name] = await ctx.pseudonymize(raw, identifierKind(col.name));
      } else {
        out[col.name] = null;
      }
      continue;
    }
    out[col.name] = coerce(col.type, raw);
  }
  out.account_id = ctx.accountId;
  out._vireek_synced_at = ctx.syncedAt;
  out._vireek_deleted = false;
  return out;
}

// ============================================================
// Data dictionary (schema docs)
// ============================================================

export interface DictionaryRow {
  table: string;
  column: string;
  type: ColumnType;
  description: string;
  privacy: "none" | PiiClass;
}

export function dictionaryRows(datasets: readonly DatasetKey[] = DATASET_KEYS): DictionaryRow[] {
  const rows: DictionaryRow[] = [];
  for (const key of datasets) {
    for (const col of allColumns(key)) {
      rows.push({ table: key, column: col.name, type: col.type, description: col.description, privacy: col.pii ?? "none" });
    }
  }
  return rows;
}

export interface DictionaryMetric {
  id: string;
  label: string;
  unit: string;
  definition: string;
  version: number;
}

function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Markdown data dictionary: what each table and column means, and how metrics are defined. */
export function renderDataDictionaryMarkdown(opts: {
  schemaName: string;
  datasets?: readonly DatasetKey[];
  piiMode: PiiMode;
  metrics?: readonly DictionaryMetric[];
  generatedAt?: string;
}): string {
  const keys = opts.datasets?.length ? opts.datasets : DATASET_KEYS;
  const lines: string[] = [
    "# Vireek data dictionary",
    "",
    `Schema: \`${opts.schemaName}\` · Personal data: **${PII_MODE_META[opts.piiMode].label}**${opts.generatedAt ? ` · Generated ${opts.generatedAt}` : ""}`,
    "",
    "Every table has `id` as its primary key, `account_id`, `_vireek_synced_at` and `_vireek_deleted`. Rows are upserted by `id`; filter `_vireek_deleted = false` for live data.",
    "",
  ];
  for (const key of keys) {
    const d = DATASETS[key];
    lines.push(`## ${key}`, "", d.description, "", "| Column | Type | Privacy | Description |", "| --- | --- | --- | --- |");
    for (const col of allColumns(key)) {
      const privacy = col.pii ? (opts.piiMode === "full" ? col.pii : opts.piiMode === "hashed" && col.pii === "identifier" ? "hashed" : "empty") : "-";
      lines.push(`| \`${col.name}\` | ${col.type} | ${privacy} | ${mdCell(col.description)} |`);
    }
    lines.push("");
  }
  if (opts.metrics?.length) {
    lines.push("## Metric definitions", "", "| Metric | Unit | Version | Definition |", "| --- | --- | --- | --- |");
    for (const m of opts.metrics) lines.push(`| \`${m.id}\` (${mdCell(m.label)}) | ${m.unit} | v${m.version} | ${mdCell(m.definition)} |`);
    lines.push("");
  }
  return lines.join("\n");
}
