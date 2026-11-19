// src/lib/tenantExport.ts
//
// Client side of the chunked "vireek-export/2" protocol (server: supabase/functions/tenant-export).
// Pulls one table chunk at a time, re-verifies every chunk (sha256, byte/row counts, id ordering,
// cursor continuity) before accepting it, retries transient failures with back-off, and writes a
// tar entry per chunk. The archive only gets its manifest.json — and the end-of-archive marker — after
// the server's completeness gate (finalize) has confirmed that every row is accounted for. Nothing here
// ever turns an incomplete export into something that looks complete.
//
// Resumable: all progress lives in an `ExportSession`. If a run throws, call `runChunkedExport` again with
// the same session and sink and it continues from the last verified chunk. Pure logic, no React.

import { TABLES, TAR_END, sha256Hex, tarEntryParts, type TableName } from '../../supabase/functions/_shared/tenant-export/bundle.ts';
import {
  CHUNK_DEFAULT_ROWS, chunkFileName, cmpId, isCanonicalUuid,
  type ChunkDescriptor, type ChunkMeta, type ManifestV2,
} from '../../supabase/functions/_shared/tenant-export/chunks.ts';

export type { ManifestV2 } from '../../supabase/functions/_shared/tenant-export/chunks.ts';

export type ExportErrorCode =
  | 'auth' | 'forbidden' | 'network' | 'server' | 'integrity' | 'incomplete' | 'protocol' | 'aborted' | 'sink' | 'retries_exhausted';

export class TenantExportError extends Error {
  readonly code: ExportErrorCode;
  readonly retryable: boolean;
  readonly problems: string[];
  readonly status: number | null;
  constructor(code: ExportErrorCode, opts: { retryable?: boolean; problems?: string[]; status?: number | null; cause?: unknown } = {}) {
    super(`tenant_export:${code}`);
    this.name = 'TenantExportError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.problems = opts.problems ?? [];
    this.status = opts.status ?? null;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export interface ExportPlan { snapshotAt: string; chunkRows: number; chunkMaxRows: number; tables: { name: TableName; rows: number }[]; totalRows: number }
export interface ChunkResult { meta: ChunkMeta; body: Uint8Array }

export interface ExportTransport {
  plan(signal?: AbortSignal): Promise<ExportPlan>;
  chunk(req: { table: TableName; after: string | null; snapshotAt: string; limit: number }, signal?: AbortSignal): Promise<ChunkResult>;
  finalize(req: { snapshotAt: string; chunks: ChunkDescriptor[] }, signal?: AbortSignal): Promise<ManifestV2>;
}

// ------------------------------------------------------------------ HTTP transport

export function createHttpTransport(cfg: {
  baseUrl: string;
  getToken: () => Promise<string>;
  anonKey?: string;
  fetchImpl?: typeof fetch;
}): ExportTransport {
  const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/functions/v1/tenant-export`;
  const doFetch = cfg.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const token = await cfg.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) };
    if (cfg.anonKey) headers.apikey = cfg.anonKey;
    let res: Response;
    try {
      res = await doFetch(url, { ...init, headers, signal });
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw new TenantExportError('aborted');
      throw new TenantExportError('network', { retryable: true, cause: e });
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: unknown; code?: string };
    if (res.status === 403) throw new TenantExportError('forbidden', { status: 403 });
    if (res.status === 401) throw new TenantExportError('auth', { status: 401, retryable: true });
    if (res.status === 409 && body.error === 'export_incomplete') {
      throw new TenantExportError('incomplete', { status: 409, problems: Array.isArray(body.problems) ? body.problems.map(String).slice(0, 50) : [] });
    }
    if (body.error === 'export_integrity_failed') throw new TenantExportError('integrity', { status: res.status, problems: [String(body.code ?? '')] });
    if (res.status === 429 || res.status >= 500) throw new TenantExportError('server', { status: res.status, retryable: true });
    throw new TenantExportError('protocol', { status: res.status, problems: [String(body.error ?? res.status)] });
  }

  return {
    async plan(signal) {
      const res = await call(`${endpoint}?mode=plan`, { method: 'GET' }, signal);
      return (await res.json()) as ExportPlan;
    },
    async chunk(r, signal) {
      const q = new URLSearchParams({ mode: 'chunk', table: r.table, snapshot: r.snapshotAt, limit: String(r.limit) });
      if (r.after) q.set('after', r.after);
      const res = await call(`${endpoint}?${q}`, { method: 'GET' }, signal);
      const h = res.headers;
      const num = (k: string) => Number(h.get(k));
      const meta: ChunkMeta = {
        rows: num('X-Chunk-Rows'), bytes: num('X-Chunk-Bytes'), sha256: h.get('X-Chunk-Sha256') ?? '',
        firstId: h.get('X-Chunk-First-Id') || null, lastId: h.get('X-Chunk-Last-Id') || null, hasMore: h.get('X-Chunk-Has-More') === '1',
      };
      return { meta, body: new Uint8Array(await res.arrayBuffer()) };
    },
    async finalize(r, signal) {
      const res = await call(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'finalize', ...r }) }, signal);
      return ((await res.json()) as { manifest: ManifestV2 }).manifest;
    },
  };
}

// ------------------------------------------------------------------ sinks

export interface ExportSink { write(part: Uint8Array): Promise<void> | void }

export function createMemorySink() {
  const parts: Uint8Array[] = [];
  let size = 0;
  return {
    write(part: Uint8Array) { parts.push(part); size += part.length; },
    get size() { return size; },
    toBlob(): Blob { return new Blob(parts as BlobPart[], { type: 'application/x-tar' }); },
    parts,
  };
}

// ------------------------------------------------------------------ session & runner

export interface ExportSession {
  plan: ExportPlan | null;
  /** Verified chunks so far, in order. */
  chunks: ChunkDescriptor[];
  tableIndex: number;
  after: string | null;
  seq: number;
  rows: number;
  bytes: number;
  /** Set when the sink failed mid-write: the archive is no longer trustworthy, so resuming is refused. */
  poisoned: boolean;
  manifest: ManifestV2 | null;
}

export const newSession = (): ExportSession => ({ plan: null, chunks: [], tableIndex: 0, after: null, seq: 1, rows: 0, bytes: 0, poisoned: false, manifest: null });

export interface ExportProgress {
  phase: 'planning' | 'downloading' | 'verifying' | 'done';
  table: TableName | null;
  tableIndex: number;
  tableCount: number;
  rowsDone: number;
  totalRows: number;
  chunksDone: number;
  bytesDone: number;
}

export interface RunOptions {
  session: ExportSession;
  sink: ExportSink;
  transport: ExportTransport;
  chunkRows?: number;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = new TextEncoder();

async function withRetry<T>(fn: () => Promise<T>, o: { maxRetries: number; sleep: (ms: number) => Promise<void>; signal?: AbortSignal }): Promise<T> {
  let attempt = 0;
  for (;;) {
    if (o.signal?.aborted) throw new TenantExportError('aborted');
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof TenantExportError)) throw e;
      if (!e.retryable) throw e;
      if (attempt >= o.maxRetries) throw new TenantExportError('retries_exhausted', { problems: [e.code], status: e.status, cause: e });
      const delay = Math.min(8000, 500 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      attempt++;
      await o.sleep(delay);
    }
  }
}

/** Re-verify a chunk exactly as the server describes it. Any mismatch is a retryable integrity failure (transport damage). */
async function verifyChunk(table: TableName, after: string | null, r: ChunkResult, limit: number): Promise<void> {
  const bad = (why: string) => new TenantExportError('integrity', { retryable: true, problems: [`${table}:${why}`] });
  const { meta, body } = r;
  if (!Number.isInteger(meta.rows) || meta.rows < 0 || meta.rows > limit) throw bad('rows_header');
  if (body.length !== meta.bytes) throw bad('byte_count');
  const text = new TextDecoder().decode(body);
  if ((await sha256Hex(body)) !== meta.sha256) throw bad('sha256');
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length !== meta.rows) throw bad('row_count');
  let prev = after;
  let first: string | null = null;
  for (const line of lines) {
    let id: unknown;
    try { id = (JSON.parse(line) as { id?: unknown }).id; } catch { throw bad('json'); }
    if (!isCanonicalUuid(id)) throw bad('id');
    if (prev !== null && cmpId(id, prev) <= 0) throw bad('order');
    prev = id;
    first ??= id;
  }
  if (meta.firstId !== first || meta.lastId !== (lines.length ? prev : null)) throw bad('id_range');
  if (meta.rows === 0 && meta.hasMore) throw bad('empty_but_more');
}

function entry(name: string, body: Uint8Array, mtime: number): Uint8Array {
  const parts = tarEntryParts(name, body, mtime);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Run (or resume) a chunked export. Resolves with the verified manifest once the archive is complete.
 * Throws TenantExportError otherwise; the session stays valid for another call unless `session.poisoned`.
 */
export async function runChunkedExport(o: RunOptions): Promise<ManifestV2> {
  const { session: s, sink, transport } = o;
  const maxRetries = o.maxRetries ?? 4;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? (() => new Date());
  const retry = { maxRetries, sleep, signal: o.signal };
  if (s.poisoned) throw new TenantExportError('sink', { problems: ['session_poisoned'] });
  if (s.manifest) return s.manifest;

  const emit = (phase: ExportProgress['phase']) => o.onProgress?.({
    phase, table: TABLES[s.tableIndex] ?? null, tableIndex: s.tableIndex, tableCount: TABLES.length,
    rowsDone: s.rows, totalRows: s.plan?.totalRows ?? 0, chunksDone: s.chunks.length, bytesDone: s.bytes,
  });
  const mtime = Math.floor(now().getTime() / 1000);
  const write = async (bytes: Uint8Array) => {
    try { await sink.write(bytes); } catch (e) { s.poisoned = true; throw new TenantExportError('sink', { cause: e }); }
  };

  if (!s.plan) {
    emit('planning');
    s.plan = await withRetry(() => transport.plan(o.signal), retry);
  }
  const plan = s.plan;
  const limit = Math.max(1, Math.min(o.chunkRows ?? plan.chunkRows ?? CHUNK_DEFAULT_ROWS, plan.chunkMaxRows ?? CHUNK_DEFAULT_ROWS));

  while (s.tableIndex < TABLES.length) {
    const table = TABLES[s.tableIndex];
    emit('downloading');
    const res = await withRetry(async () => {
      const r = await transport.chunk({ table, after: s.after, snapshotAt: plan.snapshotAt, limit }, o.signal);
      await verifyChunk(table, s.after, r, limit);
      return r;
    }, retry);

    // verifyChunk guarantees every accepted chunk advances the cursor (ids strictly ascend), so this loop always terminates.
    await write(entry(chunkFileName(table, s.seq), res.body, mtime));
    s.chunks.push({ table, seq: s.seq, after: s.after, ...res.meta });
    s.rows += res.meta.rows;
    s.bytes += res.body.length;
    if (res.meta.hasMore) { s.after = res.meta.lastId; s.seq += 1; } else { s.tableIndex += 1; s.after = null; s.seq = 1; }
  }

  emit('verifying');
  const manifest = await withRetry(() => transport.finalize({ snapshotAt: plan.snapshotAt, chunks: s.chunks }, o.signal), retry);
  if (manifest.complete !== true || manifest.totalRows !== s.rows) throw new TenantExportError('incomplete', { problems: ['manifest_mismatch'] });

  await write(entry('manifest.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'), mtime));
  await write(TAR_END);
  s.manifest = manifest;
  emit('done');
  return manifest;
}
