// supabase/functions/_shared/observability/traceContext.ts
//
// One correlation ID per phone call. Every webhook request Vapi sends for a call
// is a separate HTTP request with its own x-request-id, so the call trace id is
// DERIVED from the Vapi call id (SHA-256) instead of being stored: any function,
// on any isolate, computes the same W3C trace id for the same call with no lookup.
// Pure + Web Crypto only: runs in Deno, Node 20+ and the browser.

export const TRACE_ID_RE = /^[0-9a-f]{32}$/;
export const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic 32-hex W3C trace id for a telephony call id. */
export async function deriveTraceId(callId: string): Promise<string> {
  const id = sha256Hex(`vireek:call:${callId.trim()}`);
  const hex = (await id).slice(0, 32);
  return hex === ZERO_TRACE ? "0".repeat(31) + "1" : hex;
}

/** Deterministic 16-hex span id so a retried write of the same event is idempotent. */
export async function deriveSpanId(traceId: string, key: string): Promise<string> {
  const hex = (await sha256Hex(`${traceId}:${key}`)).slice(0, 16);
  return hex === ZERO_SPAN ? "0".repeat(15) + "1" : hex;
}

export function newSpanId(): string {
  const h = randomHex(8);
  return h === ZERO_SPAN ? "0".repeat(15) + "1" : h;
}

export function newTraceId(): string {
  const h = randomHex(16);
  return h === ZERO_TRACE ? "0".repeat(31) + "1" : h;
}

export interface ParsedTraceparent { traceId: string; spanId: string; sampled: boolean }

/** Strict W3C parse (version 00, lowercase hex, non-zero ids). Anything else -> null. */
export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === ZERO_TRACE || m[2] === ZERO_SPAN) return null;
  return { traceId: m[1], spanId: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  if (!TRACE_ID_RE.test(traceId) || !SPAN_ID_RE.test(spanId)) throw new Error("invalid trace/span id");
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

export interface ResolvedTrace { traceId: string; parentSpanId: string | null; source: "call" | "header" | "new" }

/**
 * Precedence: call id (always wins, so the whole call shares one trace) >
 * inbound traceparent (internal function-to-function hops) > fresh id.
 */
export async function resolveTrace(callId: string | null | undefined, traceparent?: string | null): Promise<ResolvedTrace> {
  const inbound = parseTraceparent(traceparent);
  if (callId && callId.trim()) {
    return { traceId: await deriveTraceId(callId), parentSpanId: inbound?.spanId ?? null, source: "call" };
  }
  if (inbound) return { traceId: inbound.traceId, parentSpanId: inbound.spanId, source: "header" };
  return { traceId: newTraceId(), parentSpanId: null, source: "new" };
}

/** Headers to add to an OUTBOUND call so the next hop joins the same trace. */
export function outboundTraceHeaders(traceId: string, sampled: boolean): Record<string, string> {
  return { traceparent: formatTraceparent(traceId, newSpanId(), sampled) };
}
