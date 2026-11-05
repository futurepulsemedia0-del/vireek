// supabase/functions/_shared/http/retry.ts
//
// Shared outbound-HTTP resilience for partner APIs: timeout, bounded retries with exponential backoff + full jitter,
// Retry-After support (seconds or HTTP-date), and Jobber GraphQL "THROTTLED" handling (HTTP 200 + errors[].extensions.code).
//
// Safety rules (idempotency):
//  - 429 and 503 are always retried: the server declined to process the request.
//  - 500/502/504 and network errors/timeouts are retried only for reads (GET/HEAD, or `idempotent: true`),
//    because a write may already have been applied.
//  - Never retries 4xx other than 429.
// `sleep`/`now`/`fetchImpl`/`random` are injectable so behaviour is deterministic in tests.

export interface RetryOptions {
  maxAttempts?: number; // total tries, default 4
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // cap for any single wait, default 20_000
  timeoutMs?: number; // per attempt, default 15_000
  idempotent?: boolean; // treat the call as a read even if it is a POST (e.g. GraphQL query)
}

export interface RetryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 20_000, timeoutMs: 15_000 };
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds, or null. */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** Exponential backoff with full jitter: random in [0, min(cap, base * 2^attempt)). */
export function backoffMs(attempt: number, base: number, cap: number, random: () => number): number {
  return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
}

function isRead(method: string | undefined, idempotent: boolean | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return idempotent === true || m === "GET" || m === "HEAD";
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
  deps: RetryDeps = {},
): Promise<Response> {
  const o = { ...DEFAULTS, ...opts };
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const read = isRead(init.method, opts.idempotent);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < o.maxAttempts; attempt++) {
    const last = attempt === o.maxAttempts - 1;
    let res: Response | null = null;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (!read || last) throw err;
      await sleep(backoffMs(attempt, o.baseDelayMs, o.maxDelayMs, random));
      continue;
    }
    const retryable = res.status === 429 || res.status === 503 || (read && (res.status === 500 || res.status === 502 || res.status === 504));
    if (!retryable || last) return res;
    const wait = Math.min(o.maxDelayMs, retryAfterMs(res.headers.get("Retry-After"), now()) ?? backoffMs(attempt, o.baseDelayMs, o.maxDelayMs, random));
    await res.body?.cancel().catch(() => undefined);
    await sleep(wait);
  }
  throw lastErr instanceof Error ? lastErr : new Error("retry_exhausted");
}

// ---------------------------------------------------------------------------------------------
// GraphQL (Jobber): throttling is reported as HTTP 200 with errors[].extensions.code === "THROTTLED".
// ---------------------------------------------------------------------------------------------

interface GraphQlError {
  message?: string;
  extensions?: { code?: string };
}
export interface GraphQlBody<T = unknown> {
  data?: T;
  errors?: GraphQlError[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}

export function isThrottled(body: GraphQlBody<unknown>): boolean {
  return Array.isArray(body.errors) && body.errors.some((e) => e?.extensions?.code === "THROTTLED");
}

/** Time until enough query-cost budget has refilled, when the API reports it; otherwise null. */
export function throttleWaitMs(body: GraphQlBody<unknown>): number | null {
  const c = body.extensions?.cost;
  const need = c?.requestedQueryCost;
  const have = c?.throttleStatus?.currentlyAvailable;
  const rate = c?.throttleStatus?.restoreRate;
  if (typeof need !== "number" || typeof have !== "number" || typeof rate !== "number" || rate <= 0) return null;
  return Math.max(0, Math.ceil(((need - have) / rate) * 1000));
}

export async function graphqlWithRetry<T = unknown>(
  req: { url: string; headers: Record<string, string>; query: string; variables?: Record<string, unknown> },
  opts: RetryOptions = {},
  deps: RetryDeps = {},
): Promise<GraphQlBody<T>> {
  const o = { ...DEFAULTS, ...opts };
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  for (let attempt = 0; attempt < o.maxAttempts; attempt++) {
    const res = await fetchWithRetry(
      req.url,
      { method: "POST", headers: { "Content-Type": "application/json", ...req.headers }, body: JSON.stringify({ query: req.query, variables: req.variables ?? {} }) },
      { ...opts, idempotent: opts.idempotent ?? false },
      deps,
    );
    if (!res.ok) throw new Error(`graphql_http_${res.status}`);
    const body = (await res.json()) as GraphQlBody<T>;
    if (!isThrottled(body)) return body;
    if (attempt === o.maxAttempts - 1) throw new Error("graphql_throttled");
    await sleep(Math.min(o.maxDelayMs, throttleWaitMs(body) ?? backoffMs(attempt, o.baseDelayMs, o.maxDelayMs, random)));
  }
  throw new Error("graphql_throttled");
}
