// supabase/functions/_shared/exports/bi.ts
//
// BI export: pure building blocks (no database, no Deno/DOM APIs except WebCrypto + injected fetch).
//
//   catalog (data-platform)  -> which columns may leave the product, with their PII class
//   engine  (export-run)     -> CSV cell escaping + spreadsheet-formula neutralisation (reused)
//   this file                -> PII-aware column selection, CSV parts, signed manifests,
//                               AWS Signature V4 (S3 and Google Cloud Storage), storage PUT/DELETE
//
// Integrity rules:
//   1. Columns come ONLY from the Data Platform catalog. Personal columns are not merely blanked:
//      in "omit" mode they are not selected from the database and not written to the file at all.
//   2. Every delivered dataset ends with a signed manifest (HMAC-SHA256 over canonical JSON that
//      includes the SHA-256 of every part), so a consumer can prove a file is complete and untampered.
//   3. Storage hosts are fixed (amazonaws.com / storage.googleapis.com). A tenant can never point
//      the server at an arbitrary URL.

import {
  DATASETS,
  DATASET_KEYS,
  isDatasetKey,
  transformRow,
  type ColumnDef,
  type ColumnType,
  type DatasetKey,
  type PiiMode,
  type Pseudonymize,
} from "../data-platform/catalog.ts";
import { safeEqual } from "../data-platform/secrets.ts";
import { escapeCsvCell, neutralizeFormula } from "./engine.ts";

export { DATASETS, DATASET_KEYS, isDatasetKey };
export type { ColumnDef, DatasetKey, PiiMode };

// ============================================================
// CONSTANTS
// ============================================================

export type BiProvider = "s3" | "gcs";
export type BiMode = "snapshot" | "incremental";

export const BI_PROVIDERS: readonly BiProvider[] = ["s3", "gcs"];
export const BI_MODES: readonly BiMode[] = ["snapshot", "incremental"];
export const BI_PII_MODES: readonly PiiMode[] = ["omit", "hashed", "full"];
export const BI_INTERVALS: readonly number[] = [60, 360, 1440, 10080];

export const BI_PROVIDER_META: Record<BiProvider, { label: string; blurb: string }> = {
  s3: { label: "Amazon S3", blurb: "Write access to one bucket (s3:PutObject; add s3:DeleteObject for the connection test cleanup)." },
  gcs: { label: "Google Cloud Storage", blurb: "Use an HMAC key of a service account with Storage Object Creator on the bucket." },
};

export const BI_MODE_META: Record<BiMode, { label: string; description: string }> = {
  incremental: {
    label: "Incremental (changed rows)",
    description: "Each run delivers only rows changed since the last run (5 minute safety overlap). Upsert by id, keep the newest updated_at.",
  },
  snapshot: {
    label: "Full snapshot",
    description: "Each run delivers every current row, consistently, up to 500,000 rows per table. Replace your copy on each run.",
  },
};

export const BI_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 60, label: "Hourly" },
  { value: 360, label: "Every 6 hours" },
  { value: 1440, label: "Daily" },
  { value: 10080, label: "Weekly" },
];

export const BI_PII_MODE_META: Record<PiiMode, { label: string; description: string }> = {
  omit: {
    label: "No personal data (default)",
    description: "Names, phones, emails and addresses are not selected and not written. Files contain no personal columns at all.",
  },
  hashed: {
    label: "Pseudonymised identifiers",
    description: "Phones and emails become stable keyed hashes (columns end in _hash). Names and addresses are not written. Needs the “export personal data” permission.",
  },
  full: {
    label: "Full personal data",
    description: "Names, phones, emails and addresses are written as-is. Needs the “export personal data” permission. Only for storage approved for customer PII.",
  },
};

export const BI_PART_MAX_ROWS = 50_000;
export const BI_PART_MAX_BYTES = 24 * 1024 * 1024;
export const BI_SNAPSHOT_MAX_ROWS = 500_000;
export const BI_PAGE_SIZE = 1000;
export const BI_RUN_BUDGET_MS = 110_000;
export const BI_MAX_SCHEDULES = 20;
export const BI_MAX_TARGETS = 10;
export const BI_MAX_READERS = 5;
export const BI_MANIFEST_VERSION = 1;

/** Tables with soft delete: deleted rows are never delivered (matches the SQL views). */
export const BI_SOFT_DELETE: ReadonlySet<DatasetKey> = new Set<DatasetKey>(["customers", "leads"]);

// ============================================================
// COLUMNS + PII
// ============================================================

export function hasPii(dataset: DatasetKey): boolean {
  return DATASETS[dataset].columns.some((c) => !!c.pii);
}

/** Catalog columns that may appear in the file for this PII mode. */
export function biColumns(dataset: DatasetKey, piiMode: PiiMode): ColumnDef[] {
  return DATASETS[dataset].columns.filter(
    (c) => !c.pii || piiMode === "full" || (piiMode === "hashed" && c.pii === "identifier"),
  );
}

/** Name of a column in the delivered file. Hashed identifiers are renamed so nobody mistakes them for raw values. */
export function outputName(col: ColumnDef, piiMode: PiiMode): string {
  return col.pii === "identifier" && piiMode === "hashed" ? `${col.name}_hash` : col.name;
}

/** Columns to SELECT: only what the file needs, plus id + updated_at for paging. Personal columns are never read in "omit" mode. */
export function biSelectList(dataset: DatasetKey, piiMode: PiiMode): string {
  const names = new Set<string>(["id", "updated_at"]);
  for (const c of biColumns(dataset, piiMode)) names.add(c.name);
  return [...names].join(",");
}

export function biSchemaHash(dataset: DatasetKey, piiMode: PiiMode): string {
  const text = biColumns(dataset, piiMode).map((c) => `${outputName(c, piiMode)}:${c.type}`).join("|");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${dataset}:${(h >>> 0).toString(16)}`;
}

export interface BiRowContext {
  accountId: string;
  piiMode: PiiMode;
  pseudonymize: Pseudonymize;
  syncedAt: string;
}

/** Source row -> ordered cell values for the file (privacy applied by the catalog's own transform). */
export async function biRow(dataset: DatasetKey, raw: Record<string, unknown>, ctx: BiRowContext): Promise<unknown[]> {
  const t = await transformRow(dataset, raw, ctx);
  return biColumns(dataset, ctx.piiMode).map((c) => t[c.name]);
}

// ============================================================
// CSV  (machine-friendly: ISO timestamps, true/false, JSON text, no BOM)
// ============================================================

function cellText(type: ColumnType, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (type === "boolean") return v ? "true" : "false";
  if (type === "json") return typeof v === "string" ? v : JSON.stringify(v);
  return String(v);
}

export function csvHeader(dataset: DatasetKey, piiMode: PiiMode): string {
  return biColumns(dataset, piiMode).map((c) => escapeCsvCell(outputName(c, piiMode))).join(",");
}

export function csvLine(cols: readonly ColumnDef[], values: readonly unknown[]): string {
  return cols
    .map((c, i) => {
      const text = cellText(c.type, values[i]);
      const numeric = c.type === "integer" || c.type === "number";
      return escapeCsvCell(numeric ? text : neutralizeFormula(text));
    })
    .join(",");
}

const utf8 = new TextEncoder();

/** Accumulates CSV lines for one part file; full when row or byte budget is reached. */
export class CsvPart {
  private lines: string[];
  private size: number;
  rows = 0;
  constructor(header: string, private maxRows = BI_PART_MAX_ROWS, private maxBytes = BI_PART_MAX_BYTES) {
    this.lines = [header];
    this.size = utf8.encode(header).length + 2;
  }
  add(line: string): void {
    this.lines.push(line);
    this.size += utf8.encode(line).length + 2;
    this.rows++;
  }
  get full(): boolean {
    return this.rows >= this.maxRows || this.size >= this.maxBytes;
  }
  toBytes(): Uint8Array {
    return utf8.encode(this.lines.join("\r\n") + "\r\n");
  }
}

// ============================================================
// HASH + SIGNED MANIFEST
// ============================================================

const hex = (buf: ArrayBuffer | Uint8Array): string =>
  [...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmacRaw(key: Uint8Array | string, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? utf8.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? utf8.encode(data) : data));
}

export async function hmacSha256Hex(key: Uint8Array | string, data: string): Promise<string> {
  return hex(await hmacRaw(key, data));
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. What the signature covers. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Short public id of a signing secret (so rotation is visible in manifests without revealing the secret). */
export async function signingKeyId(secret: string): Promise<string> {
  return (await sha256Hex(`vireek-bi-key-id:${secret}`)).slice(0, 8);
}

export interface BiManifestPart {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface BiManifestBody {
  version: number;
  format: "csv";
  run_id: string;
  account_id: string;
  dataset: string;
  mode: BiMode;
  pii_mode: PiiMode;
  generated_at: string;
  /** Incremental only: the watermark this run started from / advanced to. */
  since: string | null;
  watermark: string | null;
  /** false = incremental run stopped at its time budget; the next run continues from `watermark`. */
  complete: boolean;
  schema_hash: string;
  columns: { name: string; type: ColumnType; pii?: string }[];
  row_count: number;
  parts: BiManifestPart[];
}

export interface BiManifest extends BiManifestBody {
  signature: { alg: "HMAC-SHA256"; key_id: string; value: string };
}

export async function signManifest(body: BiManifestBody, secret: string): Promise<BiManifest> {
  const value = await hmacSha256Hex(secret, canonicalJson(body));
  return { ...body, signature: { alg: "HMAC-SHA256", key_id: await signingKeyId(secret), value } };
}

export async function verifyManifest(m: BiManifest, secret: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!m?.signature || m.signature.alg !== "HMAC-SHA256") return { ok: false, reason: "Missing or unsupported signature." };
  const { signature, ...body } = m;
  const expected = await hmacSha256Hex(secret, canonicalJson(body));
  return safeEqual(expected, signature.value) ? { ok: true } : { ok: false, reason: "Signature does not match (wrong secret or manifest was modified)." };
}

/** Checks one downloaded part against its manifest entry. */
export async function verifyPart(bytes: Uint8Array, entry: BiManifestPart): Promise<boolean> {
  return bytes.length === entry.bytes && safeEqual(await sha256Hex(bytes), entry.sha256);
}

// ============================================================
// OBJECT KEYS
// ============================================================

export function datasetDir(dataset: string, mode: BiMode, day: string, runId: string): string {
  return `${dataset}/${mode}/dt=${day}/run=${runId.replace(/-/g, "").slice(0, 8)}`;
}
export const partName = (n: number): string => `part-${String(n).padStart(4, "0")}.csv`;
export const latestKey = (dataset: string, mode: BiMode): string => `${dataset}/${mode}/_latest.json`;

// ============================================================
// VALIDATION
// ============================================================

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string; errors?: Record<string, string> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function validatePrefix(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const p = raw.trim().replace(/^\/+|\/+$/g, "");
  if (p.length > 128) return null;
  if (p === "") return "";
  if (!/^[A-Za-z0-9._=\-/]+$/.test(p) || p.includes("//") || p.split("/").some((s) => s === "." || s === "..")) return null;
  return p;
}

export function isValidBucket(provider: BiProvider, bucket: string): boolean {
  if (provider === "s3") {
    return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(bucket);
  }
  return /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket) && !bucket.includes("..");
}

export function isValidRegion(region: string): boolean {
  return /^[a-z]{2}(-[a-z]+)+-\d$/.test(region);
}

export interface TargetInput {
  name: string;
  provider: BiProvider;
  bucket: string;
  region: string;
  prefix: string;
  access_key_id: string;
  /** undefined while editing = keep the stored secret. */
  secret_access_key?: string;
}

export function validateTargetInput(b: Record<string, unknown>, opts: { requireSecret: boolean }): Validation<TargetInput> {
  const errors: Record<string, string> = {};
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > 80) errors.name = "Enter a name (1 to 80 characters).";

  const provider = b.provider;
  if (provider !== "s3" && provider !== "gcs") errors.provider = "Choose Amazon S3 or Google Cloud Storage.";

  const bucket = typeof b.bucket === "string" ? b.bucket.trim() : "";
  if (provider === "s3" || provider === "gcs") {
    if (!isValidBucket(provider, bucket)) errors.bucket = "That does not look like a valid bucket name.";
  }

  let region = typeof b.region === "string" ? b.region.trim() : "";
  if (provider === "gcs") region = "auto";
  else if (provider === "s3" && !isValidRegion(region)) errors.region = "Enter an AWS region such as eu-central-1.";

  const prefix = validatePrefix(b.prefix);
  if (prefix === null) errors.prefix = "Use letters, digits and . _ - = / only (max 128 characters, no “..”).";

  const accessKey = typeof b.access_key_id === "string" ? b.access_key_id.trim() : "";
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(accessKey)) errors.access_key_id = "Enter the access key id (8 to 128 characters).";

  let secret: string | undefined;
  if (typeof b.secret_access_key === "string" && b.secret_access_key !== "") {
    secret = b.secret_access_key.trim();
    if (!/^[\x21-\x7e]{16,128}$/.test(secret)) errors.secret_access_key = "The secret looks malformed (16 to 128 visible characters).";
  } else if (opts.requireSecret) {
    errors.secret_access_key = "Enter the secret access key.";
  }

  if (Object.keys(errors).length) return { ok: false, error: "Please fix the highlighted fields.", errors };
  return {
    ok: true,
    value: { name, provider: provider as BiProvider, bucket, region, prefix: prefix as string, access_key_id: accessKey, ...(secret ? { secret_access_key: secret } : {}) },
  };
}

export interface ScheduleInput {
  name: string;
  target_id: string;
  datasets: DatasetKey[];
  mode: BiMode;
  pii_mode: PiiMode;
  interval_minutes: number;
  enabled: boolean;
}

export function validateScheduleInput(b: Record<string, unknown>): Validation<ScheduleInput> {
  const errors: Record<string, string> = {};
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > 80) errors.name = "Enter a name (1 to 80 characters).";
  if (!isUuid(b.target_id)) errors.target_id = "Choose a destination.";

  const ds = Array.isArray(b.datasets) ? b.datasets.filter(isDatasetKey) : [];
  const datasets = [...new Set(ds)];
  if (!datasets.length || datasets.length !== (Array.isArray(b.datasets) ? new Set(b.datasets).size : 0)) {
    errors.datasets = "Choose at least one table (unknown tables are not allowed).";
  }
  const mode = b.mode;
  if (mode !== "snapshot" && mode !== "incremental") errors.mode = "Choose snapshot or incremental.";
  const pii = b.pii_mode === undefined ? "omit" : b.pii_mode;
  if (pii !== "omit" && pii !== "hashed" && pii !== "full") errors.pii_mode = "Choose a personal data option.";
  const interval = Number(b.interval_minutes);
  if (!BI_INTERVALS.includes(interval)) errors.interval_minutes = "Choose hourly, every 6 hours, daily or weekly.";

  if (Object.keys(errors).length) return { ok: false, error: "Please fix the highlighted fields.", errors };
  return {
    ok: true,
    value: {
      name,
      target_id: b.target_id as string,
      datasets,
      mode: mode as BiMode,
      pii_mode: pii as PiiMode,
      interval_minutes: interval,
      enabled: b.enabled !== false,
    },
  };
}

// ============================================================
// AWS SIGNATURE V4  (works for Amazon S3 and for Google Cloud Storage HMAC interoperability)
// ============================================================

export function awsUriEncode(s: string, encodeSlash = true): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? e : e.replace(/%2F/g, "/");
}

export function amzDateOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface SigV4Input {
  method: string;
  /** Already URI-encoded absolute path, e.g. "/bucket/dir/file.csv". */
  path: string;
  /** Already canonical query string ("" when none). */
  query?: string;
  /** Every header that must be signed (names case-insensitive). Must include host and x-amz-date. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
}

export async function signAwsV4(i: SigV4Input): Promise<{ authorization: string; signedHeaders: string; canonicalRequest: string }> {
  const names = Object.keys(i.headers).map((k) => k.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [i.method, i.path, i.query ?? "", canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${i.amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
  const kDate = await hmacRaw(`AWS4${i.secretAccessKey}`, day);
  const kRegion = await hmacRaw(kDate, i.region);
  const kService = await hmacRaw(kRegion, i.service);
  const kSigning = await hmacRaw(kService, "aws4_request");
  const signature = hex(await hmacRaw(kSigning, stringToSign));
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    signedHeaders,
    canonicalRequest,
  };
}

// ============================================================
// STORAGE  (PUT / DELETE with retries and plain-English errors)
// ============================================================

export interface StorageTarget {
  provider: BiProvider;
  bucket: string;
  region: string;
  prefix: string;
}
export interface StorageCreds {
  accessKeyId: string;
  secretAccessKey: string;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<{ status: number; text(): Promise<string> }>;

export function fullKey(t: Pick<StorageTarget, "prefix">, rel: string): string {
  return t.prefix ? `${t.prefix}/${rel}` : rel;
}

export function objectLocation(t: StorageTarget, rel: string): { url: string; host: string; path: string; signRegion: string } {
  const key = fullKey(t, rel);
  const encKey = key.split("/").map((s) => awsUriEncode(s)).join("/");
  if (t.provider === "gcs") {
    const path = `/${t.bucket}/${encKey}`;
    return { url: `https://storage.googleapis.com${path}`, host: "storage.googleapis.com", path, signRegion: "auto" };
  }
  if (!t.bucket.includes(".")) {
    const host = `${t.bucket}.s3.${t.region}.amazonaws.com`;
    const path = `/${encKey}`;
    return { url: `https://${host}${path}`, host, path, signRegion: t.region };
  }
  const host = `s3.${t.region}.amazonaws.com`;
  const path = `/${t.bucket}/${encKey}`;
  return { url: `https://${host}${path}`, host, path, signRegion: t.region };
}

export class BiStorageError extends Error {
  constructor(message: string, public status: number | null, public retryable: boolean) {
    super(message);
  }
}

export function describeStorageFailure(status: number | null, body: string, provider: BiProvider): { message: string; retryable: boolean } {
  const code = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? "";
  const where = provider === "s3" ? "S3" : "Google Cloud Storage";
  if (status === null) return { message: `Could not reach ${where}. Check the bucket region and name.`, retryable: true };
  if (status === 429 || status >= 500 || code === "SlowDown" || code === "RequestTimeout") return { message: `${where} is busy (${status}). It will be retried.`, retryable: true };
  if (code === "SignatureDoesNotMatch") return { message: "The access key or secret is wrong (signature mismatch). Edit the destination and re-enter the secret.", retryable: false };
  if (code === "InvalidAccessKeyId") return { message: "The access key id is not recognised by the provider.", retryable: false };
  if (code === "NoSuchBucket" || status === 404) return { message: "The bucket was not found. Check the bucket name and region.", retryable: false };
  if (code === "AccessDenied" || status === 403) return { message: "Access denied. The key needs permission to write objects in this bucket (and prefix).", retryable: false };
  if (code === "AuthorizationHeaderMalformed" || code === "PermanentRedirect" || code === "IllegalLocationConstraintException") {
    return { message: "The bucket is in a different region than the one you entered.", retryable: false };
  }
  return { message: `${where} rejected the upload (${status}${code ? ` ${code}` : ""}).`, retryable: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function storageCall(
  method: "PUT" | "DELETE",
  t: StorageTarget,
  creds: StorageCreds,
  rel: string,
  body: Uint8Array | undefined,
  contentType: string | undefined,
  fetchFn: FetchLike,
  now: () => Date,
): Promise<void> {
  const loc = objectLocation(t, rel);
  const payload = body ?? new Uint8Array(0);
  const payloadHash = await sha256Hex(payload);
  let last: BiStorageError | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const amzDate = amzDateOf(now());
    const headers: Record<string, string> = { host: loc.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (contentType) headers["content-type"] = contentType;
    const { authorization } = await signAwsV4({
      method, path: loc.path, headers, payloadHash, region: loc.signRegion, service: "s3",
      accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, amzDate,
    });
    const { host: _host, ...sendHeaders } = headers;
    try {
      const res = await fetchFn(loc.url, { method, headers: { ...sendHeaders, Authorization: authorization }, ...(method === "PUT" ? { body: payload } : {}) });
      if (res.status >= 200 && res.status < 300) return;
      const text = await res.text().catch(() => "");
      const d = describeStorageFailure(res.status, text, t.provider);
      last = new BiStorageError(d.message, res.status, d.retryable);
    } catch {
      const d = describeStorageFailure(null, "", t.provider);
      last = new BiStorageError(d.message, null, true);
    }
    if (!last.retryable || attempt === 3) break;
    await sleep(400 * 2 ** (attempt - 1));
  }
  throw last ?? new BiStorageError("Upload failed.", null, false);
}

export const putObject = (t: StorageTarget, c: StorageCreds, rel: string, bytes: Uint8Array, contentType: string, fetchFn: FetchLike = fetch as unknown as FetchLike, now: () => Date = () => new Date()) =>
  storageCall("PUT", t, c, rel, bytes, contentType, fetchFn, now);

export const deleteObject = (t: StorageTarget, c: StorageCreds, rel: string, fetchFn: FetchLike = fetch as unknown as FetchLike, now: () => Date = () => new Date()) =>
  storageCall("DELETE", t, c, rel, undefined, undefined, fetchFn, now);

// ============================================================
// SHARED UI/SERVER HELPERS
// ============================================================

/** View names of the read-only Postgres contract (docs/BI_EXPORT.md). Must match the migration (enforced by a test). */
export const biViewName = (d: DatasetKey): string => `bi_${d}`;
export const biPiiViewName = (d: DatasetKey): string | null => (hasPii(d) ? `bi_pii_${d}` : null);
export const BI_VIEW_NAMES: string[] = DATASET_KEYS.flatMap((d) => [biViewName(d), ...(biPiiViewName(d) ? [biPiiViewName(d) as string] : [])]);

export function nextRunAt(now: Date, intervalMinutes: number, failures = 0): Date {
  const factor = failures > 0 ? 2 ** Math.min(failures, 5) : 1;
  return new Date(now.getTime() + Math.min(intervalMinutes * factor, 10080) * 60_000);
}
