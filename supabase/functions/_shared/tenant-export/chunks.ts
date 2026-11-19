// supabase/functions/_shared/tenant-export/chunks.ts
//
// Chunked, resumable tenant export ("vireek-export/2"). Pure code: no Deno, no I/O, no framework.
//
// Why it exists: v1 held every row of every table in memory in one request and capped each table at
// 100 000 rows. v2 moves the data in bounded chunks that a client pulls one request at a time:
//
//   plan      -> exact per-table row counts at a fixed snapshot instant
//   chunk     -> up to N rows of ONE table, keyset-paginated by `id` (stable, no OFFSET), with a sha256
//   finalize  -> the server re-counts the snapshot and verifies the chunk list; only a COMPLETE set
//                gets a manifest. Anything missing, duplicated, reordered, corrupt or short is an error.
//
// Resumable: a chunk is identified by (table, after-id). A client that lost its connection repeats the
// last request; nothing server-side has to be remembered. Completeness is never assumed: the manifest is
// only produced when sum(chunk rows) === exact row count of the snapshot, per table.

import {
  MAX_ROWS_PER_TABLE,
  TABLES,
  parseBundle,
  sha256Hex,
  toExportRow,
  type ParseResult,
  type Row,
  type TableName,
} from "./bundle.ts";

export const CHUNK_FORMAT = "vireek-export/2";
export const CHUNK_DEFAULT_ROWS = 5_000;
export const CHUNK_MAX_ROWS = 10_000;
/** Soft byte budget per chunk (a chunk always holds at least one row, so one huge row can exceed it). */
export const CHUNK_MAX_BYTES = 6 * 1024 * 1024;
/** Rows requested from the database per round trip. Must not exceed PostgREST's `max_rows` (default 1000). */
export const PAGE_ROWS = 1_000;
/** Upper bound on chunks per table accepted at finalize (5 000 rows each => 500 M rows). */
export const MAX_CHUNKS_PER_TABLE = 100_000;
/** A snapshot older than this is refused so a stale session cannot pin an arbitrary point in history. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_MAX_SKEW_MS = 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

export const isCanonicalUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
/** Code-point comparison. Equals Postgres' uuid ordering for canonical lowercase uuids; never locale-dependent. */
export const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const chunkFileName = (table: TableName, seq: number): string => `${table}.${String(seq).padStart(6, "0")}.ndjson`;

/** The database returned something that would make the export silently wrong. Never recoverable by retrying blindly. */
export class ExportIntegrityError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`export_integrity:${code}`);
    this.name = "ExportIntegrityError";
    this.code = code;
  }
}

/** The chunk set does not prove the export is complete. */
export class ExportIncompleteError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`export_incomplete:${problems[0] ?? "unknown"}`);
    this.name = "ExportIncompleteError";
    this.problems = problems;
  }
}

// ------------------------------------------------------------------ chunk assembly (server side)

export type FetchPage = (after: string | null, limit: number) => Promise<Row[]>;

export interface AssembledChunk {
  /** NDJSON lines of export rows (user_id and credential-like keys already stripped, keys sorted). */
  lines: string[];
  firstId: string | null;
  lastId: string | null;
  hasMore: boolean;
  bytes: number;
}

/**
 * Read one chunk of one table through `fetchPage` (keyset: rows with id > after, ordered by id ascending).
 * `hasMore` is proven, not guessed: it is true only when a row beyond the chunk was actually seen (or probed).
 */
export async function assembleChunk(opts: {
  after: string | null;
  maxRows: number;
  maxBytes: number;
  fetchPage: FetchPage;
}): Promise<AssembledChunk> {
  const { maxRows, maxBytes, fetchPage } = opts;
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new ExportIntegrityError("bad_max_rows");
  const lines: string[] = [];
  let bytes = 0;
  let firstId: string | null = null;
  let lastId: string | null = null;
  let cursor = opts.after;

  const result = (hasMore: boolean): AssembledChunk => ({ lines, firstId, lastId, hasMore, bytes });

  for (;;) {
    const want = Math.min(PAGE_ROWS, maxRows - lines.length + 1);
    const page = await fetchPage(cursor, want);
    if (page.length > want) throw new ExportIntegrityError("page_overflow");

    let prev = cursor;
    for (let i = 0; i < page.length; i++) {
      const id = page[i].id;
      if (!isCanonicalUuid(id)) throw new ExportIntegrityError("invalid_id");
      if (prev !== null && cmpId(id, prev) <= 0) throw new ExportIntegrityError("order_violation");
      prev = id;

      if (lines.length >= maxRows) return result(true); // the extra row proves more data exists
      const line = JSON.stringify(toExportRow(page[i]));
      lines.push(line);
      bytes += enc.encode(line).length + 1;
      firstId ??= id;
      lastId = id;
      cursor = id;

      if (bytes >= maxBytes) {
        if (i < page.length - 1) return result(true);
        if (page.length < want) return result(false); // a short page already proves the table is exhausted
        const probe = await fetchPage(cursor, 1);
        return result(probe.length > 0);
      }
    }
    if (page.length < want) return result(false);
  }
}

export interface ChunkMeta {
  rows: number;
  bytes: number;
  sha256: string;
  firstId: string | null;
  lastId: string | null;
  hasMore: boolean;
}

export async function encodeChunk(a: AssembledChunk): Promise<{ body: string; meta: ChunkMeta }> {
  const body = a.lines.length ? a.lines.join("\n") + "\n" : "";
  const bytes = enc.encode(body).length;
  return { body, meta: { rows: a.lines.length, bytes, sha256: await sha256Hex(body), firstId: a.firstId, lastId: a.lastId, hasMore: a.hasMore } };
}

// ------------------------------------------------------------------ descriptors & completeness

export interface ChunkDescriptor extends ChunkMeta {
  table: TableName;
  /** 1-based position of this chunk within its table. */
  seq: number;
  /** Cursor this chunk was requested with (null for the first chunk of a table). */
  after: string | null;
}

export interface ManifestV2Chunk { seq: number; file: string; rows: number; bytes: number; sha256: string; firstId: string | null; lastId: string | null }
export interface ManifestV2 {
  format: typeof CHUNK_FORMAT;
  /** Always true: a manifest is only ever produced for a verified-complete export. */
  complete: true;
  exportedAt: string;
  snapshotAt: string;
  tables: { name: TableName; rows: number; chunks: ManifestV2Chunk[] }[];
  totalRows: number;
  /** sha256 over "<file>\t<sha256>\n" for every chunk in table/seq order: one fingerprint for the whole export. */
  rootSha256: string;
}

export type Expected = Record<TableName, number>;

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
}

/** Validate an untrusted snapshot instant (ISO-8601 UTC with milliseconds, e.g. 2026-11-18T10:00:00.000Z). */
export function validateSnapshot(v: unknown, now: Date): { ok: true; snapshotAt: string } | { ok: false; error: string } {
  if (!isIso(v)) return { ok: false, error: "invalid_snapshot" };
  const t = Date.parse(v);
  if (t > now.getTime() + SNAPSHOT_MAX_SKEW_MS) return { ok: false, error: "snapshot_in_future" };
  if (t < now.getTime() - SNAPSHOT_MAX_AGE_MS) return { ok: false, error: "snapshot_expired" };
  return { ok: true, snapshotAt: v };
}

/** Shape-check descriptors sent by a client at finalize. Never trusts types, ranges or table names. */
export function parseChunkDescriptors(raw: unknown): { ok: true; chunks: ChunkDescriptor[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "chunks_not_array" };
  if (raw.length > TABLES.length * MAX_CHUNKS_PER_TABLE) return { ok: false, error: "too_many_chunks" };
  const out: ChunkDescriptor[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, error: "invalid_chunk" };
    const r = c as Record<string, unknown>;
    if (typeof r.table !== "string" || !(TABLES as readonly string[]).includes(r.table)) return { ok: false, error: "unknown_table" };
    const intIn = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
    if (!Number.isInteger(r.seq) || (r.seq as number) < 1 || (r.seq as number) > MAX_CHUNKS_PER_TABLE) return { ok: false, error: "invalid_seq" };
    if (!intIn(r.rows, CHUNK_MAX_ROWS)) return { ok: false, error: "invalid_rows" };
    if (!intIn(r.bytes, 2 ** 40)) return { ok: false, error: "invalid_bytes" };
    if (typeof r.sha256 !== "string" || !SHA_RE.test(r.sha256)) return { ok: false, error: "invalid_sha256" };
    for (const k of ["after", "firstId", "lastId"] as const) {
      if (r[k] !== null && !isCanonicalUuid(r[k])) return { ok: false, error: `invalid_${k}` };
    }
    if (typeof r.hasMore !== "boolean") return { ok: false, error: "invalid_has_more" };
    out.push({
      table: r.table as TableName, seq: r.seq as number, after: r.after as string | null, rows: r.rows as number, bytes: r.bytes as number,
      sha256: r.sha256, firstId: r.firstId as string | null, lastId: r.lastId as string | null, hasMore: r.hasMore,
    });
  }
  return { ok: true, chunks: out };
}

async function rootHash(chunks: readonly ChunkDescriptor[]): Promise<string> {
  const ordered = [...chunks].sort((a, b) => TABLES.indexOf(a.table) - TABLES.indexOf(b.table) || a.seq - b.seq);
  return sha256Hex(ordered.map((c) => `${chunkFileName(c.table, c.seq)}\t${c.sha256}\n`).join(""));
}

/**
 * The completeness gate. Returns a manifest ONLY if every table is present exactly once as a gap-free,
 * ordered chain of chunks (first chunk starts at the beginning, each chunk starts where the previous one
 * ended, the last chunk says there is nothing more) AND the chain holds exactly `expected[table]` rows.
 * Otherwise returns every problem found (capped) — callers must treat that as a hard failure.
 */
export async function verifyCompleteness(input: {
  snapshotAt: string;
  exportedAt: string;
  chunks: readonly ChunkDescriptor[];
  expected: Expected;
}): Promise<{ ok: true; manifest: ManifestV2 } | { ok: false; problems: string[] }> {
  const problems: string[] = [];
  const add = (p: string) => { if (problems.length < 50) problems.push(p); };
  const tables: ManifestV2["tables"] = [];
  let total = 0;

  for (const name of TABLES) {
    const list = input.chunks.filter((c) => c.table === name).sort((a, b) => a.seq - b.seq);
    if (list.length === 0) { add(`table_missing:${name}`); continue; }
    if (list.length > MAX_CHUNKS_PER_TABLE) { add(`too_many_chunks:${name}`); continue; }

    let rows = 0;
    let prevLast: string | null = null;
    let broken = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.seq !== i + 1) { add(`chunk_gap:${name}:${i + 1}`); broken = true; break; }
      if (c.after !== prevLast) { add(`chunk_discontinuity:${name}:${c.seq}`); broken = true; break; }
      if (c.rows === 0 && (c.firstId !== null || c.lastId !== null)) { add(`chunk_inconsistent:${name}:${c.seq}`); broken = true; break; }
      if (c.rows > 0 && (c.firstId === null || c.lastId === null || (c.rows === 1 ? c.firstId !== c.lastId : cmpId(c.firstId, c.lastId) >= 0))) {
        add(`chunk_inconsistent:${name}:${c.seq}`); broken = true; break;
      }
      if (c.rows > 0 && c.after !== null && cmpId(c.firstId as string, c.after) <= 0) { add(`chunk_order_violation:${name}:${c.seq}`); broken = true; break; }
      if (c.rows === 0 && c.hasMore) { add(`chunk_empty_but_more:${name}:${c.seq}`); broken = true; break; }
      const isLast = i === list.length - 1;
      if (!isLast && !c.hasMore) { add(`chunk_ended_early:${name}:${c.seq}`); broken = true; break; }
      if (isLast && c.hasMore) { add(`export_truncated:${name}`); broken = true; break; }
      if (c.rows > 0) prevLast = c.lastId;
      rows += c.rows;
    }
    if (broken) continue;

    if (rows !== input.expected[name]) add(`row_count_mismatch:${name}:exported=${rows}:expected=${input.expected[name]}`);
    total += rows;
    tables.push({
      name, rows,
      chunks: list.map((c) => ({ seq: c.seq, file: chunkFileName(name, c.seq), rows: c.rows, bytes: c.bytes, sha256: c.sha256, firstId: c.firstId, lastId: c.lastId })),
    });
  }
  const unknown = input.chunks.filter((c) => !(TABLES as readonly string[]).includes(c.table));
  if (unknown.length) add("unknown_table");
  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    manifest: {
      format: CHUNK_FORMAT, complete: true, exportedAt: input.exportedAt, snapshotAt: input.snapshotAt,
      tables, totalRows: total, rootSha256: await rootHash(input.chunks),
    },
  };
}

// ------------------------------------------------------------------ v2 bundle parser (import / offline verification)

export interface ParseV2Options {
  /** Single-request import keeps v1's per-table cap. Ignored when `verifyOnly` is set. */
  maxRowsPerTable?: number;
  /** Validate everything (checksums, counts, ordering, completeness) without holding rows in memory or applying the cap. */
  verifyOnly?: boolean;
}
export type ParseResultV2 = { ok: true; rows: Record<TableName, Row[]>; manifest: ManifestV2 } | { ok: false; error: string };

export async function parseBundleV2(files: ReadonlyMap<string, string>, opts: ParseV2Options = {}): Promise<ParseResultV2> {
  const cap = opts.verifyOnly ? Infinity : (opts.maxRowsPerTable ?? MAX_ROWS_PER_TABLE);
  const mRaw = files.get("manifest.json");
  if (!mRaw) return { ok: false, error: "manifest_missing" };
  let m: ManifestV2;
  try { m = JSON.parse(mRaw); } catch { return { ok: false, error: "manifest_invalid" }; }
  if (!m || m.format !== CHUNK_FORMAT || !Array.isArray(m.tables)) return { ok: false, error: "unsupported_format" };
  if (m.complete !== true) return { ok: false, error: "bundle_incomplete" };

  const names = m.tables.map((t) => t?.name);
  if (names.length !== TABLES.length || TABLES.some((t, i) => names[i] !== t)) return { ok: false, error: "tables_mismatch" };

  const expectedFiles = new Set<string>(["manifest.json"]);
  const rows = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]])) as Record<TableName, Row[]>;
  const fingerprints: ChunkDescriptor[] = [];
  let total = 0;

  for (const t of m.tables) {
    if (!Array.isArray(t.chunks) || t.chunks.length === 0 || t.chunks.length > MAX_CHUNKS_PER_TABLE) return { ok: false, error: `chunks_invalid:${t.name}` };
    let prev: string | null = null;
    let tableRows = 0;
    for (let i = 0; i < t.chunks.length; i++) {
      const c = t.chunks[i];
      const label = `${t.name}:${i + 1}`;
      if (c.seq !== i + 1 || c.file !== chunkFileName(t.name, i + 1)) return { ok: false, error: `bad_chunk_entry:${label}` };
      if (typeof c.sha256 !== "string" || !SHA_RE.test(c.sha256)) return { ok: false, error: `bad_chunk_entry:${label}` };
      const body = files.get(c.file);
      if (body === undefined) return { ok: false, error: `file_missing:${c.file}` };
      expectedFiles.add(c.file);
      if ((await sha256Hex(body)) !== c.sha256) return { ok: false, error: `checksum_mismatch:${c.file}` };
      if (enc.encode(body).length !== c.bytes) return { ok: false, error: `byte_count_mismatch:${c.file}` };
      const lines = body.split("\n").filter((l) => l.length > 0);
      if (lines.length !== c.rows) return { ok: false, error: `row_count_mismatch:${c.file}` };
      tableRows += lines.length;
      if (tableRows > cap) return { ok: false, error: `too_many_rows:${t.name}` };

      let first: string | null = null;
      for (const line of lines) {
        let r: Row;
        try { r = JSON.parse(line); } catch { return { ok: false, error: `invalid_json:${c.file}` }; }
        if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: `invalid_row:${c.file}` };
        if (!isCanonicalUuid(r.id)) return { ok: false, error: `invalid_id:${t.name}` };
        if ("user_id" in r) return { ok: false, error: `user_id_not_allowed:${t.name}` };
        if (prev !== null && cmpId(r.id, prev) <= 0) return { ok: false, error: `order_or_duplicate_id:${t.name}` };
        prev = r.id; first ??= r.id;
        if (!opts.verifyOnly) rows[t.name].push(r);
      }
      if ((c.firstId ?? null) !== first || (c.rows > 0 ? c.lastId : null) !== (c.rows > 0 ? prev : null)) return { ok: false, error: `id_range_mismatch:${c.file}` };
      fingerprints.push({ table: t.name, seq: c.seq, after: null, rows: c.rows, bytes: c.bytes, sha256: c.sha256, firstId: c.firstId, lastId: c.lastId, hasMore: false });
    }
    if (t.rows !== tableRows) return { ok: false, error: `table_total_mismatch:${t.name}` };
    total += tableRows;
  }
  if (m.totalRows !== total) return { ok: false, error: "total_mismatch" };
  if (m.rootSha256 !== (await rootHash(fingerprints))) return { ok: false, error: "root_checksum_mismatch" };
  for (const name of files.keys()) if (!expectedFiles.has(name)) return { ok: false, error: `unexpected_file:${name.slice(0, 60)}` };
  return { ok: true, rows, manifest: m };
}

/** Importer entry point: accepts v1 and v2 bundles, refuses anything that is not provably complete. */
export async function parseAnyBundle(files: ReadonlyMap<string, string>, opts: ParseV2Options = {}): Promise<ParseResultV2 | ParseResult> {
  const raw = files.get("manifest.json");
  if (raw) {
    try { if ((JSON.parse(raw) as { format?: unknown })?.format === CHUNK_FORMAT) return parseBundleV2(files, opts); } catch { /* fall through to v1 error */ }
  }
  return parseBundle(files);
}
