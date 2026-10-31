// supabase/functions/_shared/bi/export.ts
//
// Scheduled file exports (S3 / SFTP). Pure logic + an injectable runner, so it is fully unit-tested
// with in-memory fakes. The edge function only wires real Supabase / S3 / SFTP into it.
//
// Layout (Hive-style, loads directly into BigQuery, Snowflake, Athena, Spark, DuckDB):
//   <prefix><dataset>/dt=YYYY-MM-DD/run=<run>/part-00001.csv.gz
//   <prefix>_manifests/<run>.json     what a run wrote (only when it wrote files)
//   <prefix>_manifests/latest.json    status of the most recent run (freshness heartbeat)
// A run is complete only when its manifest says "complete": true.

import { DATASETS, DEFAULT_DATASETS, PII_MODES, allColumns, isDatasetKey, type DatasetKey, type PiiMode } from "../data-platform/catalog.ts";
import { BATCH_SIZE, advanceCursor, backoffMs, classifyFailure, isPublicHost, maxTimestamp, startCursor, type Validation } from "../data-platform/warehouse.ts";
import type { Check } from "../data-platform/adapters/types.ts";
import { normalizePrefix } from "./s3.ts";
import { encodeFile, FILE_FORMATS, type FileColumn, type FileFormat } from "./serialize.ts";
import { sha256Hex } from "./access.ts";
import { createShaper, readRows } from "./reader.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export const EXPORT_KINDS = ["s3", "sftp"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_INTERVALS = [60, 360, 1440, 10080] as const;
export const ROWS_PER_FILE_OPTIONS = [5_000, 20_000, 50_000] as const;
export const EXPORT_BUDGET_MS = 110_000;

export const EXPORT_META: Record<ExportKind, { label: string; blurb: string }> = {
  s3: { label: "Amazon S3 / S3-compatible", blurb: "AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, Spaces." },
  sftp: { label: "SFTP", blurb: "Any SFTP server. The host key is pinned so nobody can impersonate it." },
};

export interface SftpConfig { kind: "sftp"; host: string; port: number; username: string; remote_path: string; host_key_sha256: string }
export type ExportConfig = import("./s3.ts").S3Config | SftpConfig;

export interface ExportSettings {
  datasets: DatasetKey[];
  pii_mode: PiiMode;
  format: FileFormat;
  compress: boolean;
  mode: "incremental" | "snapshot";
  rows_per_file: number;
}

export function normalizeSettings(raw: Record<string, unknown>): ExportSettings {
  const ds = Array.isArray(raw.datasets) ? raw.datasets.filter(isDatasetKey) : [];
  const rpf = Number(raw.rows_per_file);
  return {
    datasets: ds.length ? [...new Set(ds)] : [...DEFAULT_DATASETS],
    pii_mode: (PII_MODES as readonly unknown[]).includes(raw.pii_mode) ? (raw.pii_mode as PiiMode) : "hashed",
    format: (FILE_FORMATS as readonly unknown[]).includes(raw.format) ? (raw.format as FileFormat) : "csv",
    compress: raw.compress !== false,
    mode: raw.mode === "snapshot" ? "snapshot" : "incremental",
    rows_per_file: (ROWS_PER_FILE_OPTIONS as readonly number[]).includes(rpf) ? rpf : 20_000,
  };
}

export function validateSftpConfig(raw: unknown): Validation<SftpConfig> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const host = typeof r.host === "string" ? r.host.trim().toLowerCase() : "";
  if (!isPublicHost(host)) errors.host = "Enter a public hostname or IP address (private and internal addresses are not allowed).";
  const port = r.port === undefined || r.port === "" ? 22 : Number(r.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "Use a port between 1 and 65535.";
  const username = typeof r.username === "string" ? r.username.trim() : "";
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) errors.username = "Enter the SFTP username.";
  const rp = typeof r.remote_path === "string" ? r.remote_path.trim() : "";
  const abs = rp.startsWith("/");
  const norm = rp === "" ? "" : normalizePrefix(abs ? rp.slice(1) : rp);
  const remote = norm === null ? null : (abs ? "/" : "") + norm;
  if (remote === null) errors.remote_path = "Use letters, digits and . _ - = / only (no “..”).";
  const fp = typeof r.host_key_sha256 === "string" ? r.host_key_sha256.trim() : "";
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fp)) errors.host_key_sha256 = "Detect the host key and confirm it matches your provider.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { kind: "sftp", host, port, username, remote_path: remote as string, host_key_sha256: fp } };
}

export function validateSftpCredentials(raw: unknown): Validation<{ password?: string; private_key?: string; passphrase?: string }> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const password = typeof r.password === "string" ? r.password : "";
  const key = typeof r.private_key === "string" ? r.private_key.trim() : "";
  const passphrase = typeof r.passphrase === "string" ? r.passphrase : "";
  if (!password && !key) return { ok: false, errors: { password: "Enter a password or paste a private key." } };
  if (key && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) return { ok: false, errors: { private_key: "Paste the whole private key, including the BEGIN and END lines." } };
  if (password.length > 512 || key.length > 8192 || passphrase.length > 512) return { ok: false, errors: { password: "Credential is too long." } };
  return { ok: true, value: { ...(password ? { password } : {}), ...(key ? { private_key: key } : {}), ...(passphrase ? { passphrase } : {}) } };
}

// ---------------- layout ----------------

/** Sortable, human-readable, unique: 20271215T031500Z-3fa9c1 */
export function makeRunLabel(now: Date, rand: () => number = Math.random): string {
  return `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}-${Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0")}`;
}

export function partPath(base: string, dataset: DatasetKey, run: string, n: number, ext: string): string {
  return `${base}${dataset}/dt=${run.slice(0, 4)}-${run.slice(4, 6)}-${run.slice(6, 8)}/run=${run}/part-${String(n).padStart(5, "0")}.${ext}`;
}
export const manifestPath = (base: string, run: string) => `${base}_manifests/${run}.json`;
export const latestPath = (base: string) => `${base}_manifests/latest.json`;

export function exportColumns(dataset: DatasetKey): FileColumn[] {
  return allColumns(dataset).filter((c) => c.name !== "_vireek_deleted").map((c) => ({ name: c.name, type: c.type }));
}

// ---------------- runner ----------------

export interface Transport {
  put(path: string, data: Uint8Array, contentType: string): Promise<void>;
  test(): Promise<Check[]>;
}

export interface ExportTarget {
  id: string;
  user_id: string;
  kind: ExportKind;
  name: string;
  settings: Record<string, unknown>;
}

export interface ExportRunResult { status: "success" | "partial" | "failed"; stats: Record<string, unknown>; error: string | null; manifest_key: string | null }

export interface FileRecord { path: string; rows: number; bytes: number; sha256: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { status?: number | null; message?: string };
      if (i >= attempts || classifyFailure(err.status ?? null, err.message ?? "") !== "retryable") throw e;
      await sleep(backoffMs(i));
    }
  }
}

export interface RunDeps {
  db: Db;
  transport: Transport;
  encryptionKey: string;
  /** Destination folder / key prefix ("" or ending with "/"). */
  base: string;
  now?: () => Date;
}

export async function runExport(deps: RunDeps, target: ExportTarget, opts: { full: boolean; deadline: number }): Promise<ExportRunResult> {
  const now = deps.now ?? (() => new Date());
  const settings = normalizeSettings(target.settings);
  const started = now();
  const run = makeRunLabel(started);
  const snapshot = settings.mode === "snapshot";
  const stats: Record<string, unknown> = { datasets: {} };
  const perDataset = stats.datasets as Record<string, { rows: number; files: number; done: boolean }>;
  const manifestDatasets: Record<string, unknown> = {};
  let totalFiles = 0;
  let totalBytes = 0;
  let partial = false;

  try {
    const shaper = await createShaper(deps.encryptionKey, target.user_id, settings.pii_mode, now);
    const { data: stateRows } = await deps.db.from("bi_export_state").select("dataset,watermark,rows_total").eq("target_id", target.id);
    const state = new Map<string, { watermark: string | null; rows_total: number }>((stateRows ?? []).map((r: { dataset: string; watermark: string | null; rows_total: number }) => [r.dataset, r]));

    for (const dataset of settings.datasets) {
      const prev = state.get(dataset);
      const full = opts.full || snapshot || !prev?.watermark;
      let cursor = startCursor(prev?.watermark, { full });
      let watermark = full ? null : prev?.watermark ?? null;
      let rowsTotal = full ? 0 : Number(prev?.rows_total ?? 0);
      const files: FileRecord[] = [];
      let buffer: Record<string, unknown>[] = [];
      let bufferWatermark: string | null = watermark;
      let rowsOut = 0;
      let finished = false;
      const columns = exportColumns(dataset);

      const flush = async () => {
        if (!buffer.length) return;
        const file = await encodeFile(settings.format, settings.compress, columns, buffer);
        const path = partPath(deps.base, dataset, run, files.length + 1, file.extension);
        await withRetry(() => deps.transport.put(path, file.bytes, file.contentType));
        files.push({ path, rows: buffer.length, bytes: file.bytes.length, sha256: await sha256Hex(file.bytes) });
        rowsOut += buffer.length;
        rowsTotal += buffer.length;
        buffer = [];
        watermark = bufferWatermark;
        if (!snapshot) {
          await deps.db.from("bi_export_state").upsert({ target_id: target.id, dataset, user_id: target.user_id, watermark, rows_total: rowsTotal, last_exported_at: now().toISOString() });
        }
      };

      while (true) {
        if (Date.now() > opts.deadline) {
          if (snapshot) throw new Error(`“${DATASETS[dataset].label}” is too large to export as a full snapshot within the time limit. Switch this target to incremental mode.`);
          partial = true;
          break;
        }
        const page = await readRows(deps.db, { ownerId: target.user_id, dataset, read: { mode: "keyset", cursor }, limit: BATCH_SIZE });
        if (!page.length) { finished = true; break; }
        for (const r of page) buffer.push(await shaper.shape(dataset, r, true));
        cursor = advanceCursor(page as { updated_at?: unknown; id?: unknown }[], cursor);
        bufferWatermark = maxTimestamp(bufferWatermark, cursor.ts);
        if (buffer.length >= settings.rows_per_file) await flush();
        if (page.length < BATCH_SIZE) { finished = true; break; }
      }
      await flush();
      if (snapshot && finished) {
        await deps.db.from("bi_export_state").upsert({ target_id: target.id, dataset, user_id: target.user_id, watermark, rows_total: rowsTotal, last_exported_at: now().toISOString() });
      }
      perDataset[dataset] = { rows: rowsOut, files: files.length, done: finished };
      manifestDatasets[dataset] = { rows: rowsOut, done: finished, watermark, columns, files };
      totalFiles += files.length;
      totalBytes += files.reduce((a, f) => a + f.bytes, 0);
      if (partial) break;
    }

    const manifest = {
      version: 1,
      run,
      target: target.name,
      account_id: target.user_id,
      generated_at: now().toISOString(),
      mode: opts.full ? "full" : settings.mode,
      complete: !partial,
      pii_mode: settings.pii_mode,
      format: settings.format,
      compressed: settings.compress,
      datasets: manifestDatasets,
    };
    const body = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    let manifestKey: string | null = null;
    if (totalFiles > 0) {
      manifestKey = manifestPath(deps.base, run);
      await withRetry(() => deps.transport.put(manifestKey!, body, "application/json"));
    }
    await withRetry(() => deps.transport.put(latestPath(deps.base), body, "application/json"));
    Object.assign(stats, { files: totalFiles, bytes: totalBytes, run });
    return { status: partial ? "partial" : "success", stats, error: null, manifest_key: manifestKey };
  } catch (e) {
    Object.assign(stats, { files: totalFiles, bytes: totalBytes, run });
    return { status: "failed", stats, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), manifest_key: null };
  }
}
