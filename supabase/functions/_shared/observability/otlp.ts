// supabase/functions/_shared/observability/otlp.ts
//
// Minimal, dependency-free OpenTelemetry (OTLP/HTTP JSON) trace exporter for Deno edge functions.
// Why not the OTel SDK: the Node/Deno SDK adds cold-start cost and Node-only APIs in an edge runtime;
// OTLP/JSON is a stable wire format that every backend (Grafana Tempo/Cloud, Honeycomb, SigNoz, Datadog
// via collector, Jaeger) accepts, so this stays vendor neutral. Best effort: export NEVER throws and
// never delays a webhook response beyond `timeoutMs`.

import { toSafeAttributes, type AttrValue } from "./redact.ts";
import { newSpanId } from "./traceContext.ts";

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind?: "internal" | "server" | "client";
  startMs: number;
  endMs: number;
  ok: boolean;
  statusMessage?: string;
  attributes?: Record<string, unknown>;
}

const KIND = { internal: 1, server: 2, client: 3 } as const;

function otlpAttr(key: string, v: AttrValue) {
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  if (typeof v === "number") return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: v } };
}
const nano = (ms: number): string => `${Math.round(ms)}000000`;

export interface OtlpResource { serviceName: string; environment: string; version?: string }

export function buildOtlpTraces(spans: SpanData[], res: OtlpResource) {
  return {
    resourceSpans: [{
      resource: { attributes: [
        otlpAttr("service.name", res.serviceName), otlpAttr("deployment.environment", res.environment),
        ...(res.version ? [otlpAttr("service.version", res.version)] : []),
      ] },
      scopeSpans: [{
        scope: { name: "vireek.voice" },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name.slice(0, 128), kind: KIND[s.kind ?? "internal"],
          startTimeUnixNano: nano(s.startMs), endTimeUnixNano: nano(Math.max(s.endMs, s.startMs)),
          // Attributes are PII-scrubbed here, at the single exit point, regardless of caller discipline.
          attributes: Object.entries(toSafeAttributes(s.attributes ?? {})).map(([k, v]) => otlpAttr(k, v)),
          status: s.ok ? { code: 1 } : { code: 2, message: (s.statusMessage ?? "error").slice(0, 200) },
        })),
      }],
    }],
  };
}

/**
 * Cost-aware head sampling, deterministic per trace (every service makes the same decision without
 * coordination). Errors, flagged calls and slow traces are ALWAYS kept (tail rule applied by caller).
 */
export function shouldSample(traceId: string, ratio: number, force = false): boolean {
  if (force) return true;
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const n = parseInt(traceId.slice(-8), 16);
  return Number.isFinite(n) && n / 0xffffffff < ratio;
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface OtlpConfig { endpoint: string; headers: Record<string, string>; ratio: number; resource: OtlpResource }

/** Reads standard OTEL_* env. Returns null (telemetry disabled) when no endpoint is configured. */
export function otlpConfigFromEnv(get: (k: string) => string | undefined): OtlpConfig | null {
  const endpoint = get("OTEL_EXPORTER_OTLP_ENDPOINT")?.trim().replace(/\/$/, "");
  if (!endpoint || !/^https:\/\//.test(endpoint)) return null; // https only: telemetry must not leave in clear text
  const ratio = Number(get("OTEL_TRACES_SAMPLE_RATIO") ?? "0.1");
  return {
    endpoint,
    headers: parseHeaders(get("OTEL_EXPORTER_OTLP_HEADERS")),
    ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.1,
    resource: { serviceName: get("OTEL_SERVICE_NAME") ?? "vireek-edge", environment: get("OTEL_ENVIRONMENT") ?? (get("DENO_DEPLOYMENT_ID") ? "production" : "development"), version: get("OTEL_SERVICE_VERSION") },
  };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export async function exportSpans(spans: SpanData[], cfg: OtlpConfig, opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<{ ok: boolean; status: number | null; exported: number }> {
  if (!spans.length) return { ok: true, status: null, exported: 0 };
  const f: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const body = JSON.stringify(buildOtlpTraces(spans, cfg.resource));
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 1500);
    try {
      const res = await f(`${cfg.endpoint}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json", ...cfg.headers }, body, signal: ctl.signal });
      if (res.ok) return { ok: true, status: res.status, exported: spans.length };
      if (res.status < 500 && res.status !== 429) return { ok: false, status: res.status, exported: 0 }; // 4xx: retrying cannot help
    } catch { /* timeout / network: one retry */ } finally { clearTimeout(timer); }
  }
  return { ok: false, status: null, exported: 0 };
}

/** Collects spans for one request and flushes after the response via EdgeRuntime.waitUntil when present. */
export class SpanCollector {
  readonly spans: SpanData[] = [];
  readonly traceId: string;
  private readonly parentSpanId: string | null;
  constructor(traceId: string, parentSpanId: string | null = null) {
    this.traceId = traceId;
    this.parentSpanId = parentSpanId;
  }

  start(name: string, attributes: Record<string, unknown> = {}, kind: SpanData["kind"] = "internal") {
    const spanId = newSpanId();
    const startMs = Date.now();
    let done = false;
    return {
      spanId,
      end: (ok = true, extra: Record<string, unknown> = {}, statusMessage?: string) => {
        if (done) return;
        done = true;
        this.spans.push({ traceId: this.traceId, spanId, parentSpanId: this.parentSpanId, name, kind, startMs, endMs: Date.now(), ok, statusMessage, attributes: { ...attributes, ...extra } });
      },
    };
  }

  /** Whole-span helper: records error status and rethrows. */
  async run<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const s = this.start(name, attributes);
    try { const r = await fn(); s.end(true); return r; }
    catch (e) { s.end(false, {}, e instanceof Error ? e.name : "error"); throw e; }
  }

  hasError(): boolean { return this.spans.some((s) => !s.ok); }

  flush(cfg: OtlpConfig | null, opts: { slowMs?: number; forceKeep?: boolean } = {}): Promise<unknown> {
    if (!cfg || !this.spans.length) return Promise.resolve();
    const slow = this.spans.some((s) => s.endMs - s.startMs > (opts.slowMs ?? 3000));
    if (!shouldSample(this.traceId, cfg.ratio, this.hasError() || slow || opts.forceKeep === true)) return Promise.resolve();
    const p = exportSpans(this.spans, cfg).catch(() => undefined);
    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (rt?.waitUntil) { rt.waitUntil(p); return Promise.resolve(); }
    return p;
  }
}
