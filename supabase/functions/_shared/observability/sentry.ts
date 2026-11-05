// supabase/functions/_shared/observability/sentry.ts
//
// Edge-function error reporting to Sentry WITHOUT the SDK (the browser SDK in src/lib/sentry.ts does not run in
// Deno edge functions, and the Node SDK adds cold-start cost). Uses the documented envelope endpoint.
// Best effort, bounded, PII-scrubbed, deduplicated. Disabled when SENTRY_DSN is not set.
// UNVERIFIED against a live Sentry project (no network in the build environment): verify with the test event in the runbook.

import { scrubString } from "./redact.ts";

export interface SentryDsn { key: string; host: string; projectId: string; protocol: string }

export function parseDsn(dsn: string | undefined): SentryDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, "").split("/").pop() ?? "";
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(projectId)) return null;
    return { key: u.username, host: u.host, projectId, protocol: u.protocol };
  } catch { return null; }
}

export interface ErrorReport {
  fn: string;
  error: unknown;
  traceId?: string;
  requestId?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, string>;
}

/** Stable, PII-free grouping key: function + error name + first stack frame location (no message text). */
export function fingerprintOf(fn: string, error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const frame = error instanceof Error ? (error.stack ?? "").split("\n").find((l) => /at /.test(l)) ?? "" : "";
  return `${fn}|${name}|${scrubString(frame.trim(), 160)}`;
}

export function buildEnvelope(dsn: SentryDsn, r: ErrorReport, eventId: string, nowMs: number): string {
  const e = r.error instanceof Error ? r.error : new Error(typeof r.error === "string" ? r.error : "non-error thrown");
  const event = {
    event_id: eventId,
    timestamp: nowMs / 1000,
    platform: "javascript",
    level: "error",
    logger: "vireek.edge",
    server_name: r.fn,
    environment: r.environment ?? "production",
    ...(r.release ? { release: r.release } : {}),
    fingerprint: [fingerprintOf(r.fn, r.error)],
    tags: { function: r.fn, ...(r.traceId ? { trace_id: r.traceId } : {}), ...(r.requestId ? { request_id: r.requestId } : {}), ...(r.tags ?? {}) },
    exception: { values: [{ type: e.name.slice(0, 80), value: scrubString(e.message, 500), stacktrace: undefined }] },
    extra: { stack: scrubString(e.stack ?? "", 4000) },
  };
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date(nowMs).toISOString() });
  return `${header}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

const recent = new Map<string, number>();
const DEDUPE_MS = 60_000;
const MAX_PER_MINUTE = 20;
let windowStart = 0;
let windowCount = 0;

/** Returns true if this error should be sent now (dedupe per fingerprint + per-isolate rate cap). */
export function admit(fp: string, nowMs: number): boolean {
  if (nowMs - windowStart > 60_000) { windowStart = nowMs; windowCount = 0; }
  if (windowCount >= MAX_PER_MINUTE) return false;
  const last = recent.get(fp);
  if (last !== undefined && nowMs - last < DEDUPE_MS) return false;
  if (recent.size > 200) recent.clear();
  recent.set(fp, nowMs);
  windowCount++;
  return true;
}
export function __resetAdmit(): void { recent.clear(); windowStart = 0; windowCount = 0; }

export type SentryFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean }>;

export async function captureException(r: ErrorReport, getEnv: (k: string) => string | undefined, fetchImpl?: SentryFetch, nowMs = Date.now()): Promise<boolean> {
  try {
    const dsn = parseDsn(getEnv("SENTRY_DSN"));
    if (!dsn || !admit(fingerprintOf(r.fn, r.error), nowMs)) return false;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const body = buildEnvelope(dsn, { ...r, environment: r.environment ?? getEnv("SENTRY_ENVIRONMENT") ?? getEnv("OTEL_ENVIRONMENT"), release: r.release ?? getEnv("SENTRY_RELEASE") }, eventId, nowMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    try {
      const f: SentryFetch = fetchImpl ?? ((url, init) => fetch(url, init));
      const res = await f(`https://${dsn.host}/api/${dsn.projectId}/envelope/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=vireek-edge/1.0` },
        body, signal: ctl.signal,
      });
      return res.ok;
    } finally { clearTimeout(timer); }
  } catch { return false; }
}
