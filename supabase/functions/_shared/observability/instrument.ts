// supabase/functions/_shared/observability/instrument.ts
//
// One wrapper that gives ANY edge function: a W3C trace (inbound `traceparent` honoured), a stable request id,
// a server span (sampled OTLP export), PII-free structured logs for errors/slow/sampled requests, Sentry capture of
// thrown errors, and `x-request-id` / `traceparent` response headers. Handler behaviour is unchanged:
// the same Response is returned and thrown errors are rethrown exactly as before.

import { captureException } from "./sentry.ts";
import { SpanCollector, otlpConfigFromEnv, shouldSample } from "./otlp.ts";
import { newSpanId, parseTraceparent, newTraceId, formatTraceparent } from "./traceContext.ts";
import { bindTrace, releaseTrace } from "./requestTrace.ts";
import { runInBackground } from "./recorder.ts";

export type Handler = (req: Request) => Response | Promise<Response>;
export interface InstrumentDeps { getEnv: (k: string) => string | undefined; log: (line: string) => void; now: () => number }

const SLOW_MS = 3000;
const REQ_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function pathOf(url: string): string {
  try { return new URL(url).pathname.slice(0, 120); } catch { return "/"; }
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  try {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  } catch {
    // Immutable headers (e.g. a Response from fetch): rebuild without touching the body stream.
    try {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    } catch { return res; }
  }
}

export function instrument(name: string, handler: Handler, deps?: Partial<InstrumentDeps>): Handler {
  const d: InstrumentDeps = {
    getEnv: deps?.getEnv ?? ((k) => (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k)),
    log: deps?.log ?? ((l) => console.log(l)),
    now: deps?.now ?? Date.now,
  };
  return async (req: Request): Promise<Response> => {
    const startedAt = d.now();
    const inbound = parseTraceparent(req.headers.get("traceparent"));
    const traceId = inbound?.traceId ?? newTraceId();
    const hdrReq = req.headers.get("x-request-id");
    const requestId = hdrReq && REQ_ID_RE.test(hdrReq) ? hdrReq : crypto.randomUUID();
    bindTrace(requestId, traceId);
    const collector = new SpanCollector(traceId, inbound?.spanId ?? null);
    const span = collector.start(`${req.method} ${name}`, { "http.method": req.method, "http.route": pathOf(req.url), "faas.name": name, "request.id": requestId }, "server");
    const sampledHint = inbound?.sampled ?? false;

    const finish = (status: number, err?: unknown): void => {
      const ms = d.now() - startedAt;
      const failed = status >= 500 || err !== undefined;
      span.end(!failed, { "http.status_code": status, "duration_ms": ms }, failed ? (err instanceof Error ? err.name : `http ${status}`) : undefined);
      const cfg = otlpConfigFromEnv(d.getEnv);
      const keepLog = failed || ms > SLOW_MS || shouldSample(traceId, 0.01, sampledHint);
      if (keepLog) d.log(JSON.stringify({ event: "http_request", fn: name, status, ms, traceId, requestId, ...(err !== undefined ? { error: err instanceof Error ? err.name : "error" } : {}) }));
      runInBackground(collector.flush(cfg, { forceKeep: failed || sampledHint }));
      if (err !== undefined) runInBackground(captureException({ fn: name, error: err, traceId, requestId }, d.getEnv));
      releaseTrace(requestId);
    };

    try {
      const res = await handler(req);
      finish(res.status);
      return withHeaders(res, { "x-request-id": requestId, traceparent: formatTraceparent(traceId, newSpanId(), sampledHint) });
    } catch (e) {
      finish(500, e);
      throw e;
    }
  };
}
