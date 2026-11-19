// supabase/functions/_shared/tenant-export/handler.ts
//
// Request handling for the `tenant-export` edge function, separated from Deno/Supabase so that routing,
// validation and the fail-loud rules are unit-tested. index.ts only wires the real database in.
//
//   GET                                   v1 single-shot tar. Refuses (413) instead of truncating.
//   GET  ?mode=plan                       v2: exact row counts at a fresh snapshot instant
//   GET  ?mode=chunk&table=&snapshot=&after=&limit=
//                                         v2: one NDJSON chunk + integrity headers
//   POST {mode:"finalize", snapshotAt, chunks:[...]}
//                                         v2: completeness gate; 200 + manifest, or 409 export_incomplete
//
// Every query is scoped by the server-resolved owner id. Nothing the client sends names a column or an owner.

import { ExportTruncatedError, MAX_ROWS_PER_TABLE, TABLES, buildBundle, tarPack, type Row, type TableName } from "./bundle.ts";
import {
  CHUNK_DEFAULT_ROWS, CHUNK_FORMAT, CHUNK_MAX_BYTES, CHUNK_MAX_ROWS, ExportIntegrityError, assembleChunk, encodeChunk, isCanonicalUuid,
  parseChunkDescriptors, validateSnapshot, verifyCompleteness, type Expected,
} from "./chunks.ts";
import { CORS, jsonRes } from "./http.ts";

/** Everything the handler needs from the database. Implemented over supabase-js in index.ts, faked in tests. */
export interface ExportDb {
  /** Exact number of the owner's rows; with snapshotAt, only rows whose created_at <= snapshotAt. */
  count(table: TableName, ownerId: string, snapshotAt: string | null): Promise<number>;
  /** Owner's rows with id > after (when set), created_at <= snapshotAt (when set), ordered by id ascending, at most `limit`. */
  page(table: TableName, ownerId: string, snapshotAt: string | null, after: string | null, limit: number): Promise<Row[]>;
}

export type Authorized = { ok: true; ownerId: string; actorId: string; db: ExportDb } | { ok: false; res: Response };

export interface HandlerDeps {
  authorize: (req: Request) => Promise<Authorized>;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

/** v1 keeps everything in memory, so it also has a byte budget (an OOM crash would be a silent failure of a different kind). */
export const LEGACY_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const FINALIZE_MAX_BODY_BYTES = 8 * 1024 * 1024;

const noStore = { "Cache-Control": "no-store" };

export async function handleExport(req: Request, deps: HandlerDeps): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405);

  const a = await deps.authorize(req);
  if (!a.ok) return a.res;

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");

  try {
    if (req.method === "POST") {
      if (mode !== null && mode !== "finalize") return jsonRes({ error: "invalid_mode" }, 400);
      return await finalize(req, a, now, log);
    }
    if (mode === null) return await legacyTar(a, now, log);
    if (mode === "plan") return await plan(a, now);
    if (mode === "chunk") return await chunk(url, a, now, log);
    return jsonRes({ error: "invalid_mode" }, 400);
  } catch (e) {
    if (e instanceof ExportIntegrityError) {
      log({ event: "tenant_export_integrity_failed", owner: a.ownerId, code: e.code });
      return jsonRes({ error: "export_integrity_failed", code: e.code }, 500);
    }
    log({ event: "tenant_export_failed", owner: a.ownerId, error: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
    return jsonRes({ error: "export_failed" }, 500);
  }
}

// ------------------------------------------------------------------ v2: plan

async function counts(a: Extract<Authorized, { ok: true }>, snapshotAt: string | null): Promise<Expected> {
  const entries = await Promise.all(TABLES.map(async (t) => [t, await a.db.count(t, a.ownerId, snapshotAt)] as const));
  return Object.fromEntries(entries) as Expected;
}

async function plan(a: Extract<Authorized, { ok: true }>, now: () => Date): Promise<Response> {
  const snapshotAt = now().toISOString();
  const c = await counts(a, snapshotAt);
  return jsonRes({
    format: CHUNK_FORMAT, snapshotAt, chunkRows: CHUNK_DEFAULT_ROWS, chunkMaxRows: CHUNK_MAX_ROWS,
    tables: TABLES.map((name) => ({ name, rows: c[name] })), totalRows: TABLES.reduce((n, t) => n + c[t], 0),
  });
}

// ------------------------------------------------------------------ v2: chunk

async function chunk(url: URL, a: Extract<Authorized, { ok: true }>, now: () => Date, log: (e: Record<string, unknown>) => void): Promise<Response> {
  const table = url.searchParams.get("table") ?? "";
  if (!(TABLES as readonly string[]).includes(table)) return jsonRes({ error: "invalid_table" }, 400);
  const snap = validateSnapshot(url.searchParams.get("snapshot"), now());
  if (!snap.ok) return jsonRes({ error: snap.error }, 400);
  const afterRaw = url.searchParams.get("after") ?? "";
  if (afterRaw !== "" && !isCanonicalUuid(afterRaw)) return jsonRes({ error: "invalid_after" }, 400);
  const after = afterRaw === "" ? null : afterRaw;
  const limitRaw = url.searchParams.get("limit");
  let limit = CHUNK_DEFAULT_ROWS;
  if (limitRaw !== null) {
    if (!/^\d{1,5}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > CHUNK_MAX_ROWS) return jsonRes({ error: "invalid_limit" }, 400);
    limit = Number(limitRaw);
  }
  const t = table as TableName;
  const assembled = await assembleChunk({ after, maxRows: limit, maxBytes: CHUNK_MAX_BYTES, fetchPage: (cur, n) => a.db.page(t, a.ownerId, snap.snapshotAt, cur, n) });
  const { body, meta } = await encodeChunk(assembled);
  log({ event: "tenant_export_chunk", owner: a.ownerId, actor: a.actorId, table: t, rows: meta.rows, bytes: meta.bytes, has_more: meta.hasMore });
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS, ...noStore, "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Chunk-Rows": String(meta.rows), "X-Chunk-Bytes": String(meta.bytes), "X-Chunk-Sha256": meta.sha256,
      "X-Chunk-First-Id": meta.firstId ?? "", "X-Chunk-Last-Id": meta.lastId ?? "", "X-Chunk-Has-More": meta.hasMore ? "1" : "0",
    },
  });
}

// ------------------------------------------------------------------ v2: finalize (the completeness gate)

async function finalize(req: Request, a: Extract<Authorized, { ok: true }>, now: () => Date, log: (e: Record<string, unknown>) => void): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? "0") > FINALIZE_MAX_BODY_BYTES) return jsonRes({ error: "payload_too_large" }, 413);
  const text = await req.text();
  if (text.length > FINALIZE_MAX_BODY_BYTES) return jsonRes({ error: "payload_too_large" }, 413);
  let body: { mode?: unknown; snapshotAt?: unknown; chunks?: unknown };
  try { body = JSON.parse(text); } catch { return jsonRes({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object" || body.mode !== "finalize") return jsonRes({ error: "invalid_mode" }, 400);
  const snap = validateSnapshot(body.snapshotAt, now());
  if (!snap.ok) return jsonRes({ error: snap.error }, 400);
  const parsed = parseChunkDescriptors(body.chunks);
  if (!parsed.ok) return jsonRes({ error: "invalid_chunks", detail: parsed.error }, 400);

  // The truth comes from the database NOW, for the same snapshot instant — never from the client.
  const expected = await counts(a, snap.snapshotAt);
  const exportedAt = now().toISOString();
  const verdict = await verifyCompleteness({ snapshotAt: snap.snapshotAt, exportedAt, chunks: parsed.chunks, expected });
  if (!verdict.ok) {
    log({ event: "tenant_export_incomplete", owner: a.ownerId, actor: a.actorId, problems: verdict.problems.slice(0, 10) });
    return jsonRes({ error: "export_incomplete", problems: verdict.problems, expected }, 409);
  }
  log({ event: "tenant_export_complete", owner: a.ownerId, actor: a.actorId, total_rows: verdict.manifest.totalRows, root_sha256: verdict.manifest.rootSha256 });
  return jsonRes({ manifest: verdict.manifest });
}

// ------------------------------------------------------------------ v1: single-shot tar (small tenants only)

async function legacyTar(a: Extract<Authorized, { ok: true }>, now: () => Date, log: (e: Record<string, unknown>) => void): Promise<Response> {
  const tooLarge = (table: string, reason: string, rows?: number) =>
    jsonRes({ error: "export_too_large", table, reason, rows, limit: MAX_ROWS_PER_TABLE, hint: "Use the chunked export (mode=plan, mode=chunk, mode=finalize)." }, 413);

  const c = await counts(a, null);
  for (const t of TABLES) if (c[t] > MAX_ROWS_PER_TABLE) return tooLarge(t, "row_limit", c[t]);

  const rows: Partial<Record<TableName, Row[]>> = {};
  let budget = LEGACY_MAX_TOTAL_BYTES;
  for (const t of TABLES) {
    // Allow one row more than the cap so rows that appeared after the count are detected, not dropped.
    const got = await assembleChunk({ after: null, maxRows: MAX_ROWS_PER_TABLE + 1, maxBytes: budget, fetchPage: (cur, n) => a.db.page(t, a.ownerId, null, cur, n) });
    if (got.hasMore || got.lines.length > MAX_ROWS_PER_TABLE) return tooLarge(t, got.bytes >= budget ? "byte_limit" : "row_limit");
    budget -= got.bytes;
    rows[t] = got.lines.map((l) => JSON.parse(l) as Row);
  }
  const exportedAt = now().toISOString();
  let tar: Uint8Array;
  try {
    tar = tarPack(await buildBundle(rows, exportedAt), Math.floor(now().getTime() / 1000));
  } catch (e) {
    if (e instanceof ExportTruncatedError) return tooLarge(e.table, "row_limit", e.rows);
    throw e;
  }
  log({ event: "tenant_export", owner: a.ownerId, actor: a.actorId, bytes: tar.length });
  return new Response(tar as unknown as BodyInit, {
    status: 200,
    headers: { ...CORS, ...noStore, "Content-Type": "application/x-tar", "Content-Disposition": `attachment; filename="vireek-export-${exportedAt.slice(0, 10)}.tar"` },
  });
}
