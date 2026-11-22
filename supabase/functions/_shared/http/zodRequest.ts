// _shared/http/zodRequest.ts — uniform request parsing for Edge Functions.
// Framework-free (no zod import): accepts anything with safeParse, so zod schemas from ./zod.ts plug in and
// Vitest can run it. Every failure is an HttpError, rendered by errorResponse() as:
//   400 { error: { code: "bad_request", message, details: [{ path, code, message }], request_id } }
//   413 { error: { code: "payload_too_large", ... } }
import { errorResponse, HttpError, newRequestId, type Json } from "./core.ts";

export const DEFAULT_MAX_BODY_BYTES = 64_000;
export const MAX_ISSUES = 10;
const MAX_QUERY_PARAMS = 20;
const MAX_QUERY_KEY = 64;
const MAX_QUERY_VALUE = 2_000;

export interface IssueLike { path: ReadonlyArray<string | number>; message: string; code?: string; keys?: string[] }
export interface SchemaLike<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<IssueLike> } };
}
export interface ParseBodyOptions {
  maxBytes?: number;
  /** Treat an empty body as `{}` (cron callers). Default false: empty body fails validation. */
  allowEmpty?: boolean;
}

// Codes whose default zod message would echo attacker-controlled input ("received 'xyz'").
const OPAQUE_CODES = new Set(["invalid_enum_value", "invalid_literal", "invalid_union", "invalid_union_discriminator"]);

export function formatIssues(issues: ReadonlyArray<IssueLike>, max = MAX_ISSUES): Json {
  return issues.slice(0, max).map((i) => {
    const path = i.path.map(String).join(".").slice(0, 120);
    const code = i.code ?? "invalid";
    if (code === "unrecognized_keys") {
      return { path, code, message: `Unknown field(s): ${(i.keys ?? []).slice(0, 10).map((k) => String(k).slice(0, 64)).join(", ")}` };
    }
    return { path, code, message: OPAQUE_CODES.has(code) ? "Invalid value." : String(i.message).slice(0, 200) };
  });
}

export function parseOrThrow<T>(schema: SchemaLike<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new HttpError("bad_request", "Request validation failed.", formatIssues(r.error.issues));
}

/** Streams the body and aborts at the cap, so a chunked/unknown-length upload never buffers unbounded memory. */
async function readBoundedText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError("payload_too_large", "Payload too large.");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError("payload_too_large", "Payload too large.");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

export async function parseBody<T>(req: Request, schema: SchemaLike<T>, opts: ParseBodyOptions = {}): Promise<T> {
  const raw = await readBoundedText(req, opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
  if (raw.trim().length === 0) return parseOrThrow(schema, opts.allowEmpty ? {} : undefined);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new HttpError("bad_request", "Body is not valid JSON."); }
  return parseOrThrow(schema, json);
}

/** Query string -> object. Repeated keys (parameter pollution) and oversized params are rejected, not merged. */
export function parseQuery<T>(source: Request | URL, schema: SchemaLike<T>): T {
  const url = source instanceof URL ? source : new URL(source.url);
  const obj: Record<string, string> = Object.create(null);
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (++n > MAX_QUERY_PARAMS) throw new HttpError("bad_request", "Too many query parameters.");
    if (k.length > MAX_QUERY_KEY || v.length > MAX_QUERY_VALUE) throw new HttpError("bad_request", "Query parameter too long.");
    if (Object.hasOwn(obj, k)) throw new HttpError("bad_request", "Repeated query parameter.", [{ path: k.slice(0, 64), code: "duplicate", message: "Parameter given more than once." }]);
    obj[k] = v;
  }
  return parseOrThrow(schema, obj);
}

export interface GuardOptions {
  /** Keep the pre-existing `{ error: "<message>" }` body for third-party clients that parse it. Default: standard envelope. */
  legacy?: boolean;
  logSink?: (line: string) => void;
}

function failureResponse(e: unknown, requestId: string, headers: Record<string, string>, o: GuardOptions): Response {
  const err = e instanceof HttpError ? e : (() => {
    (o.logSink ?? ((l: string) => console.error(l)))(JSON.stringify({ event: "request_failed", request_id: requestId, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return new HttpError("internal", "Internal error.");
  })();
  if (!o.legacy) return errorResponse(err, requestId, headers);
  const std = errorResponse(err, requestId, headers);
  return new Response(JSON.stringify({ error: err.message, code: err.code, details: err.details ?? null, request_id: requestId }), { status: std.status, headers: std.headers });
}

/** Wraps a legacy `Deno.serve` body: HttpError -> standard JSON error; anything else -> opaque 500 (never leaks e.message). */
export async function withErrorHandling(
  req: Request,
  run: (requestId: string) => Promise<Response>,
  extraHeaders: Record<string, string> = {},
  logSink: (line: string) => void = (l) => console.error(l),
): Promise<Response> {
  const requestId = newRequestId(req);
  try {
    return await run(requestId);
  } catch (e) {
    return failureResponse(e, requestId, extraHeaders, { logSink });
  }
}

/**
 * Drop-in guard for the top of a legacy handler (no tail edits needed):
 *   const g = await tryGuard(req, cors, async () => { await enforceRateLimit(...); return parseBody(req, SCHEMA); });
 *   if (!g.ok) return g.response;   // 400 / 413 / 429 / 401 already rendered
 *   const input = g.value;
 */
export async function tryGuard<T>(
  req: Request,
  headers: Record<string, string>,
  fn: () => Promise<T>,
  opts: GuardOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const requestId = newRequestId(req);
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, response: failureResponse(e, requestId, headers, opts) };
  }
}
