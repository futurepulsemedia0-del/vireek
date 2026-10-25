// supabase/functions/_shared/data-platform/warehouse.ts
//
// Everything about the warehouse sync that can be decided WITHOUT a network connection:
//   - destination validation (BigQuery, Snowflake, customer Postgres) incl. SSRF protection,
//   - identifier safety and per-dialect quoting,
//   - table DDL (with the catalog's descriptions as column comments) and upsert / soft-delete SQL,
//   - the incremental cursor (updated_at, id) and its overlap window,
//   - retry classification and backoff.
//
// The adapters (adapters/*.ts) only execute what this file builds. Pure: no network, no Deno APIs.

import { allColumns, DATASETS, type ColumnType, type DatasetKey } from "./catalog.ts";

export type WarehouseKind = "bigquery" | "snowflake" | "postgres";
export const WAREHOUSE_KINDS: readonly WarehouseKind[] = ["bigquery", "snowflake", "postgres"];

export const WAREHOUSE_META: Record<WarehouseKind, { label: string; blurb: string }> = {
  bigquery: { label: "Google BigQuery", blurb: "Serverless warehouse on Google Cloud. Uses a service account you create." },
  snowflake: { label: "Snowflake", blurb: "Cloud data platform. Uses a key-pair user or a programmatic access token." },
  postgres: { label: "Postgres replica", blurb: "Your own Postgres (RDS, Cloud SQL, Supabase, Neon, self-hosted) reachable from the internet." },
};

// ============================================================
// Identifiers
// ============================================================

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const isSafeIdent = (v: unknown): v is string => typeof v === "string" && IDENT_RE.test(v);

/**
 * Quotes an identifier for a dialect. Callers must have validated it with isSafeIdent first;
 * quoting is a second line of defence, not a substitute.
 *   postgres  "name"     (lowercase, matches unquoted resolution)
 *   snowflake "NAME"     (upper-case, matches unquoted resolution, so analysts never have to quote)
 *   bigquery  `name`
 */
export function quoteIdent(kind: WarehouseKind, name: string): string {
  if (!isSafeIdent(name)) throw new Error(`Unsafe identifier: ${name}`);
  if (kind === "bigquery") return `\`${name}\``;
  return kind === "snowflake" ? `"${name.toUpperCase()}"` : `"${name.toLowerCase()}"`;
}

// ============================================================
// Network safety (SSRF)
// ============================================================

function ipv4Private(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224
  );
}

/**
 * True when `host` is something a customer database could legitimately live on the public
 * internet: a DNS name with a dot, or a public IP literal. Rejects localhost, link-local/metadata
 * addresses, private ranges, IPv6 loopback/ULA/link-local, `.local`/`.internal`/`.svc` names.
 * (A hostname that later resolves to a private IP is additionally refused at connect time by
 * the Postgres adapter, which resolves the name first.)
 */
export function isPublicHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h.length > 253) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (/\.(local|internal|intranet|lan|home|corp|svc|cluster\.local)$/.test(h)) return false;
  if (h.includes(":")) {
    // IPv6 literal
    if (h === "::" || h === "::1") return false;
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(h)) return false;
    if (/^::ffff:/.test(h)) return isPublicHost(h.slice(7));
    return /^[0-9a-f:]+$/.test(h);
  }
  if (/^[\d.]+$/.test(h)) return /^(\d{1,3}\.){3}\d{1,3}$/.test(h) && !ipv4Private(h);
  if (!h.includes(".")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h);
}

export const isPublicAddress = (ip: string): boolean => isPublicHost(ip);

// ============================================================
// Destination config validation
// ============================================================

export interface BigQueryConfig { kind: "bigquery"; project_id: string; dataset: string; location: string }
export interface SnowflakeConfig {
  kind: "snowflake";
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string;
}
export interface PostgresConfig {
  kind: "postgres";
  host: string;
  port: number;
  database: string;
  username: string;
  schema: string;
  ssl: "require" | "verify-full";
}
export type WarehouseConfig = BigQueryConfig | SnowflakeConfig | PostgresConfig;

export type SnowflakeCredentials = { auth: "pat"; token: string } | { auth: "keypair"; private_key: string };
export type PostgresCredentials = { password: string };
export type BigQueryCredentials = { service_account_json: string };
export type WarehouseCredentials = SnowflakeCredentials | PostgresCredentials | BigQueryCredentials;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function validateWarehouseConfig(kind: WarehouseKind, raw: unknown): Validation<WarehouseConfig> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};

  if (kind === "bigquery") {
    const project_id = str(r.project_id);
    const dataset = str(r.dataset) || "vireek";
    const location = str(r.location) || "US";
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project_id)) errors.project_id = "Enter the Google Cloud project id (lowercase letters, digits, hyphens).";
    if (!isSafeIdent(dataset)) errors.dataset = "Use letters, digits and underscores (max 63).";
    if (!/^[A-Za-z][A-Za-z0-9-]{1,30}$/.test(location)) errors.location = "Enter a BigQuery location such as US, EU or europe-west1.";
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { kind, project_id, dataset, location } };
  }

  if (kind === "snowflake") {
    const account = str(r.account).replace(/\.snowflakecomputing\.com$/i, "");
    const username = str(r.username);
    const warehouse = str(r.warehouse);
    const database = str(r.database);
    const schema = str(r.schema) || "VIREEK";
    const role = str(r.role);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,100}$/.test(account)) errors.account = "Use your account identifier, e.g. myorg-myaccount or xy12345.us-east-1.";
    if (!username || username.length > 128 || /[\s"']/.test(username)) errors.username = "Enter the Snowflake user name.";
    for (const [k, v] of [["warehouse", warehouse], ["database", database], ["schema", schema]] as const) {
      if (!isSafeIdent(v)) errors[k] = "Use letters, digits and underscores (unquoted identifier).";
    }
    if (role && !isSafeIdent(role)) errors.role = "Use letters, digits and underscores.";
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { kind, account, username, warehouse, database, schema, role } };
  }

  const host = str(r.host).toLowerCase();
  const port = Number(r.port ?? 5432);
  const database = str(r.database);
  const username = str(r.username);
  const schema = str(r.schema) || "vireek";
  const ssl = r.ssl === "verify-full" ? "verify-full" : "require";
  if (!isPublicHost(host)) errors.host = "Enter a public hostname or IP. Private, local and internal addresses are not allowed.";
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "Enter a port between 1 and 65535.";
  if (!database || database.length > 63 || /[\s"';]/.test(database)) errors.database = "Enter the database name.";
  if (!username || username.length > 63 || /[\s"';]/.test(username)) errors.username = "Enter the database user.";
  if (!isSafeIdent(schema)) errors.schema = "Use letters, digits and underscores (max 63).";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { kind: "postgres", host, port, database, username, schema, ssl } };
}

export function validateWarehouseCredentials(kind: WarehouseKind, raw: unknown): Validation<WarehouseCredentials> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (kind === "bigquery") {
    const json = typeof r.service_account_json === "string" ? r.service_account_json.trim() : "";
    if (!json || json.length > 20_000) errors.service_account_json = "Paste the service account JSON key.";
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { service_account_json: json } };
  }
  if (kind === "snowflake") {
    if (r.auth === "pat") {
      const token = str(r.token, 4000);
      if (token.length < 20) errors.token = "Paste the programmatic access token.";
      return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { auth: "pat", token } };
    }
    const pem = typeof r.private_key === "string" ? r.private_key.trim() : "";
    if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) {
      errors.private_key = "Paste an unencrypted PKCS#8 private key (-----BEGIN PRIVATE KEY-----).";
    }
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { auth: "keypair", private_key: pem } };
  }
  const password = typeof r.password === "string" ? r.password : "";
  if (!password || password.length > 500) errors.password = "Enter the database password.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { password } };
}

/** "schema.table" for display and docs. */
export function tableRef(config: WarehouseConfig, dataset: DatasetKey): string {
  switch (config.kind) {
    case "bigquery": return `${config.project_id}.${config.dataset}.${dataset}`;
    case "snowflake": return `${config.database}.${config.schema}.${dataset}`.toUpperCase();
    default: return `${config.schema}.${dataset}`;
  }
}

// ============================================================
// Types per dialect
// ============================================================

const PG_TYPES: Record<ColumnType, string> = {
  uuid: "uuid", text: "text", integer: "bigint", number: "numeric", boolean: "boolean", timestamp: "timestamptz", date: "date", json: "jsonb",
};
const SF_TYPES: Record<ColumnType, string> = {
  uuid: "VARCHAR(36)", text: "VARCHAR", integer: "NUMBER(38,0)", number: "NUMBER(38,6)", boolean: "BOOLEAN", timestamp: "TIMESTAMP_TZ", date: "DATE", json: "VARIANT",
};
const BQ_TYPES: Record<ColumnType, string> = {
  uuid: "STRING", text: "STRING", integer: "INT64", number: "NUMERIC", boolean: "BOOL", timestamp: "TIMESTAMP", date: "DATE", json: "STRING",
};

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface BigQueryField { name: string; type: string; mode: "NULLABLE" | "REQUIRED"; description: string }
export function bigQuerySchema(dataset: DatasetKey): BigQueryField[] {
  return allColumns(dataset).map((c) => ({ name: c.name, type: BQ_TYPES[c.type], mode: c.name === "id" ? "REQUIRED" : "NULLABLE", description: c.description }));
}

// ============================================================
// SQL builders (positional `?` parameters; adapters translate)
// ============================================================

export interface Statement { sql: string; params: string[] }

/** Idempotent DDL: create schema + table, add columns introduced after the table was created, comment columns. */
export function buildDdl(config: PostgresConfig | SnowflakeConfig, dataset: DatasetKey): string[] {
  const kind = config.kind;
  const cols = allColumns(dataset);
  const q = (n: string) => quoteIdent(kind, n);
  const types = kind === "postgres" ? PG_TYPES : SF_TYPES;
  const schemaSql = kind === "postgres" ? q(config.schema) : `${q(config.database)}.${q(config.schema)}`;
  const table = `${schemaSql}.${q(dataset)}`;
  const colDefs = cols.map((c) => `${q(c.name)} ${types[c.type]}${c.name === "id" ? " NOT NULL" : ""}`);
  const out: string[] = [];
  out.push(`CREATE SCHEMA IF NOT EXISTS ${schemaSql}`);
  out.push(`CREATE TABLE IF NOT EXISTS ${table} (${colDefs.join(", ")}, PRIMARY KEY (${q("id")}))`);
  for (const c of cols) out.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${q(c.name)} ${types[c.type]}`);
  if (kind === "postgres") {
    out.push(`COMMENT ON TABLE ${table} IS ${sqlStr(DATASETS[dataset].description)}`);
    for (const c of cols) out.push(`COMMENT ON COLUMN ${table}.${q(c.name)} IS ${sqlStr(c.description)}`);
    out.push(`CREATE INDEX IF NOT EXISTS ${q(`${dataset}_account_idx`)} ON ${table} (${q("account_id")})`);
  } else {
    out.push(`COMMENT ON TABLE ${table} IS ${sqlStr(DATASETS[dataset].description)}`);
    for (const c of cols) out.push(`COMMENT ON COLUMN ${table}.${q(c.name)} IS ${sqlStr(c.description)}`);
  }
  return out;
}

/** Postgres upsert from one JSON array parameter. */
export function buildPostgresUpsert(config: PostgresConfig, dataset: DatasetKey, rowsJson: string): Statement {
  const q = (n: string) => quoteIdent("postgres", n);
  const cols = allColumns(dataset).map((c) => c.name);
  const table = `${q(config.schema)}.${q(dataset)}`;
  const list = cols.map(q).join(", ");
  const set = cols.filter((c) => c !== "id").map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ");
  return {
    sql: `INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, ?::jsonb) ON CONFLICT (${q("id")}) DO UPDATE SET ${set}`,
    params: [rowsJson],
  };
}

const SF_CAST: Record<ColumnType, (path: string) => string> = {
  uuid: (p) => `${p}::VARCHAR`,
  text: (p) => `${p}::VARCHAR`,
  integer: (p) => `${p}::NUMBER(38,0)`,
  number: (p) => `${p}::NUMBER(38,6)`,
  boolean: (p) => `${p}::BOOLEAN`,
  timestamp: (p) => `TO_TIMESTAMP_TZ(${p}::VARCHAR)`,
  date: (p) => `TO_DATE(${p}::VARCHAR)`,
  json: (p) => p,
};

/** Snowflake MERGE from one JSON array bound as TEXT. */
export function buildSnowflakeMerge(config: SnowflakeConfig, dataset: DatasetKey, rowsJson: string): Statement {
  const q = (n: string) => quoteIdent("snowflake", n);
  const cols = allColumns(dataset);
  const table = `${q(config.database)}.${q(config.schema)}.${q(dataset)}`;
  const projected = cols.map((c) => `${SF_CAST[c.type](`value:"${c.name}"`)} AS ${q(c.name)}`).join(", ");
  const list = cols.map((c) => q(c.name)).join(", ");
  const set = cols.filter((c) => c.name !== "id").map((c) => `t.${q(c.name)} = s.${q(c.name)}`).join(", ");
  const vals = cols.map((c) => `s.${q(c.name)}`).join(", ");
  return {
    sql: `MERGE INTO ${table} AS t USING (SELECT ${projected} FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?)))) AS s ON t.${q("id")} = s.${q("id")} WHEN MATCHED THEN UPDATE SET ${set} WHEN NOT MATCHED THEN INSERT (${list}) VALUES (${vals})`,
    params: [rowsJson],
  };
}

/** BigQuery MERGE from a staging table that a load job just filled. */
export function buildBigQueryMerge(config: BigQueryConfig, dataset: DatasetKey, stagingTable: string): string {
  if (!isSafeIdent(stagingTable)) throw new Error("Unsafe staging table name.");
  const q = (n: string) => quoteIdent("bigquery", n);
  const cols = allColumns(dataset).map((c) => c.name);
  const target = `\`${config.project_id}.${config.dataset}.${dataset}\``;
  const staging = `\`${config.project_id}.${config.dataset}.${stagingTable}\``;
  const set = cols.filter((c) => c !== "id").map((c) => `${q(c)} = s.${q(c)}`).join(", ");
  return `MERGE ${target} AS t USING ${staging} AS s ON t.${q("id")} = s.${q("id")} WHEN MATCHED THEN UPDATE SET ${set} WHEN NOT MATCHED THEN INSERT (${cols.map(q).join(", ")}) VALUES (${cols.map((c) => `s.${q(c)}`).join(", ")})`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks rows of THIS account that a full refresh did not see as deleted. Values are validated and
 * inlined (a UUID and an ISO instant), so one builder serves all three dialects.
 */
export function buildMarkDeleted(config: WarehouseConfig, dataset: DatasetKey, accountId: string, beforeIso: string): string {
  if (!UUID_RE.test(accountId)) throw new Error("Invalid account id.");
  const t = Date.parse(beforeIso);
  if (!Number.isFinite(t)) throw new Error("Invalid timestamp.");
  const iso = new Date(t).toISOString();
  const q = (n: string) => quoteIdent(config.kind, n);
  const table =
    config.kind === "bigquery" ? `\`${config.project_id}.${config.dataset}.${dataset}\``
    : config.kind === "snowflake" ? `${q(config.database)}.${q(config.schema)}.${q(dataset)}`
    : `${q(config.schema)}.${q(dataset)}`;
  const ts = config.kind === "bigquery" ? `TIMESTAMP '${iso}'` : config.kind === "snowflake" ? `TO_TIMESTAMP_TZ('${iso}')` : `'${iso}'::timestamptz`;
  const acct = `'${accountId.toLowerCase()}'`;
  const notDeleted = config.kind === "postgres" ? `NOT ${q("_vireek_deleted")}` : `${q("_vireek_deleted")} = FALSE`;
  return `UPDATE ${table} SET ${q("_vireek_deleted")} = TRUE WHERE ${q("account_id")} = ${acct} AND ${q("_vireek_synced_at")} < ${ts} AND ${notDeleted}`;
}

// ============================================================
// Incremental cursor
// ============================================================

export interface Cursor { ts: string; id: string }
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** Re-read this much before the stored watermark: a transaction that commits late must not be missed. */
export const OVERLAP_MS = 5 * 60_000;
export const BATCH_SIZE = 1000;

export function startCursor(watermark: string | null | undefined, opts: { full: boolean }): Cursor {
  const w = watermark ? Date.parse(watermark) : NaN;
  if (opts.full || !Number.isFinite(w)) return { ts: "1970-01-01T00:00:00.000Z", id: NIL_UUID };
  return { ts: new Date(w - OVERLAP_MS).toISOString(), id: NIL_UUID };
}

/** PostgREST `or` filter: rows strictly after the cursor in (updated_at, id) order. */
export function cursorFilter(c: Cursor): string {
  return `updated_at.gt.${c.ts},and(updated_at.eq.${c.ts},id.gt.${c.id})`;
}

export function advanceCursor(rows: readonly { updated_at?: unknown; id?: unknown }[], prev: Cursor): Cursor {
  const last = rows[rows.length - 1];
  return last && typeof last.updated_at === "string" && typeof last.id === "string" ? { ts: last.updated_at, id: last.id } : prev;
}

export function maxTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? (b as string) : null;
  if (!Number.isFinite(tb)) return a as string;
  return tb > ta ? (b as string) : (a as string);
}

// ============================================================
// Retry policy
// ============================================================

export type FailureKind = "retryable" | "auth" | "config" | "unknown";

export function classifyFailure(status: number | null, message: string): FailureKind {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || /permission|denied|unauthori[sz]ed|authentication|invalid (jwt|token|password)|not authorized|access denied/.test(m)) return "auth";
  if (status === 429 || (status !== null && status >= 500) || /timeout|timed out|econnreset|econnrefused|temporar|rate limit|quota exceeded|try again|unavailable/.test(m)) return "retryable";
  if (status === 400 || status === 404 || /not found|does not exist|invalid|unknown (column|table)/.test(m)) return "config";
  return "unknown";
}

/** Exponential backoff with full jitter. attempt starts at 1. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  return Math.floor(rand() * Math.min(30_000, 500 * 2 ** (attempt - 1)));
}

/** Short fingerprint of a dataset's warehouse schema; DDL only re-runs when it changes. */
export function schemaHash(dataset: DatasetKey): string {
  const text = allColumns(dataset).map((c) => `${c.name}:${c.type}:${c.description}`).join("|");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${dataset}:${(h >>> 0).toString(16)}`;
}
