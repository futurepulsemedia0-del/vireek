// _shared/http/core.ts — framework-free building blocks (no Deno/npm imports, so Vitest can run them).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Constant-time string comparison. Length mismatch returns false without comparing contents. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * FAIL-CLOSED shared-secret check. An unset/empty expected secret rejects every request
 * (the legacy `if (secret && provided !== secret)` pattern silently opens the endpoint).
 */
export function checkSharedSecret(expected: string | null | undefined, provided: string | null | undefined): boolean {
  if (!expected || !provided) return false;
  return constantTimeEqual(provided, expected);
}

export function newRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
}

// ------------------------------------------------------------------ CORS (allowlist, never "*")
export interface CorsOptions {
  allowedOrigins: readonly string[];
  methods?: readonly string[];
  headers?: readonly string[];
}

export function corsHeadersFor(req: Request, opts: CorsOptions): Record<string, string> {
  const origin = req.headers.get("origin");
  const h: Record<string, string> = { Vary: "Origin" };
  if (origin && opts.allowedOrigins.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = (opts.methods ?? ["POST", "OPTIONS"]).join(", ");
    h["Access-Control-Allow-Headers"] = (opts.headers ?? ["Content-Type", "Authorization", "X-Client-Info", "Apikey", "X-Request-Id"]).join(", ");
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

// ------------------------------------------------------------------ standardized errors
export type ErrorCode =
  | "bad_request" | "unauthorized" | "forbidden" | "not_found" | "method_not_allowed" | "payload_too_large"
  | "unprocessable" | "rate_limited" | "conflict" | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, method_not_allowed: 405, payload_too_large: 413,
  unprocessable: 422, rate_limited: 429, conflict: 409, internal: 500,
};

/** Thrown by handlers/strategies; converted to a standard JSON error. Messages are client-safe by construction. */
export class HttpError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: Json, public headers?: Record<string, string>) {
    super(message);
  }
}

export function errorResponse(e: HttpError, requestId: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details ?? null, request_id: requestId } }), {
    status: STATUS[e.code],
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...extra, ...(e.headers ?? {}) },
  });
}

// ------------------------------------------------------------------ structured logging with PII redaction
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[_-]?key|cookie|ssn|card|cvv|iban|email|phone|to_number|from_number|address|dob|name|transcript|body|payload)/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGITS_RE = /(?<!\w)\+?\d[\d\s().-]{8,}\d\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (typeof value === "string") return value.replace(EMAIL_RE, "[email]").replace(LONG_DIGITS_RE, "[number]").slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export function makeLogger(fn: string, requestId: string, sink: (line: string) => void = (l) => console.log(l)): LogFn {
  return (event, fields = {}) => sink(JSON.stringify({ ts: new Date().toISOString(), fn, request_id: requestId, event, ...(redact(fields) as object) }));
}

// ------------------------------------------------------------------ bounded body + validation
export async function readJsonBody(req: Request, maxBytes: number): Promise<{ raw: string; json: unknown }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError("payload_too_large", "Payload too large.");
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > maxBytes) throw new HttpError("payload_too_large", "Payload too large.");
  if (raw.length === 0) return { raw, json: undefined };
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    throw new HttpError("bad_request", "Body is not valid JSON.");
  }
}

/** Zod-compatible: anything with safeParse works (zod, valibot adapters, hand-written parsers). */
export interface Parser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues?: ReadonlyArray<{ path?: ReadonlyArray<string | number>; message?: string }> } };
}

export function validate<T>(parser: Parser<T>, input: unknown): T {
  const r = parser.safeParse(input);
  if (r.success) return r.data;
  const issues = (r.error.issues ?? []).slice(0, 10).map((i) => ({ path: (i.path ?? []).join("."), message: String(i.message ?? "invalid") }));
  throw new HttpError("unprocessable", "Request validation failed.", issues as unknown as Json);
}
