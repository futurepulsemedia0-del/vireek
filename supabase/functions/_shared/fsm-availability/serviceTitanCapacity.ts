// ServiceTitan availability READ (Dispatch v2 Capacity).
//
// Verified against ServiceTitan's published Dispatch v2 OpenAPI (developer.servicetitan.io, fetched 2026-11-18):
//   POST https://api.servicetitan.io/dispatch/v2/tenant/{tenant}/capacity          (Integration: api-integration.servicetitan.io)
//   body     { startsOnOrAfter, endsOnOrBefore, businessUnitIds[], jobTypeId, skillBasedAvailability }
//   response { timeStamp, availabilities[{ start, end, startUtc, endUtc, businessUnitIds[], totalAvailability,
//              openAvailability, technicians[], isAvailable, isExceedingIdealBookingPercentage }] }
//   scope    tn.dis.capacity:w   (the scope is a write scope even though the call reads - request it explicitly)
//
// [VERIFY] against a live/integration tenant (BLOCKED: needs partner sandbox access):
//   - maximum date range per call (we chunk to CAPACITY_CHUNK_DAYS defensively),
//   - behaviour when jobTypeId is set and skillBasedAvailability is false,
//   - auth host for the Integration environment (auth-integration.servicetitan.io),
//   - access-token lifetime (we honour `expires_in` and refresh once on 401).
//
// Design rule: this module can only ever make Vireek offer FEWER slots. Any doubt => FsmAvailabilityError => the
// caller fails closed (publishes / confirms nothing).
import { fetchWithRetry } from "../http/retry.ts";

export interface ServiceTitanCapacityConfig {
  st_client_id: string;
  st_client_secret: string;
  st_app_key: string;
  st_tenant_id: string;
  st_business_unit_id: string;
  st_job_type_id: string;
}

export interface FsmWindow {
  startMs: number;
  endMs: number;
  /** isAvailable === true AND openAvailability > 0 */
  open: boolean;
  openHours: number;
  totalHours: number;
}

export type FsmErrorCode = "not_configured" | "auth" | "throttled" | "http" | "timeout" | "malformed";

export class FsmAvailabilityError extends Error {
  constructor(public readonly code: FsmErrorCode, detail = "") {
    super(`fsm_availability_${code}${detail ? `_${detail}` : ""}`);
    this.name = "FsmAvailabilityError";
  }
}

export interface CapacityDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** "integration" targets ServiceTitan's sandbox hosts. Default "production". */
  env?: "production" | "integration";
  timeoutMs?: number;
}

export const CAPACITY_CHUNK_DAYS = 7;
const DAY_MS = 86_400_000;
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_S = 900;

const HOSTS = {
  production: { auth: "https://auth.servicetitan.io", api: "https://api.servicetitan.io" },
  integration: { auth: "https://auth-integration.servicetitan.io", api: "https://api-integration.servicetitan.io" },
} as const;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export function clearServiceTitanTokenCache(): void {
  tokenCache.clear();
}

function assertConfig(c: ServiceTitanCapacityConfig): { businessUnitId: number; jobTypeId: number; tenant: string } {
  const bu = Number(c.st_business_unit_id);
  const jt = Number(c.st_job_type_id);
  if (
    !c.st_client_id || !c.st_client_secret || !c.st_app_key || !/^\d{1,18}$/.test(c.st_tenant_id ?? "") ||
    !Number.isSafeInteger(bu) || bu <= 0 || !Number.isSafeInteger(jt) || jt <= 0
  ) throw new FsmAvailabilityError("not_configured");
  return { businessUnitId: bu, jobTypeId: jt, tenant: c.st_tenant_id };
}

async function getToken(c: ServiceTitanCapacityConfig, d: CapacityDeps, force = false): Promise<string> {
  const now = (d.now ?? Date.now)();
  const key = `${d.env ?? "production"}:${c.st_tenant_id}:${c.st_client_id}`;
  const hit = tokenCache.get(key);
  if (!force && hit && hit.expiresAt > now) return hit.token;

  const host = HOSTS[d.env ?? "production"].auth;
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${host}/connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.st_client_id, client_secret: c.st_client_secret }),
      },
      { maxAttempts: 2, timeoutMs: d.timeoutMs ?? 6000, idempotent: true },
      { fetchImpl: d.fetchImpl, sleep: d.sleep, now: d.now },
    );
  } catch {
    throw new FsmAvailabilityError("timeout", "auth");
  }
  if (res.status === 429) throw new FsmAvailabilityError("throttled", "auth");
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new FsmAvailabilityError("auth");
  if (!res.ok) throw new FsmAvailabilityError("http", `auth_${res.status}`);
  let json: { access_token?: unknown; expires_in?: unknown };
  try { json = await res.json(); } catch { throw new FsmAvailabilityError("malformed", "auth"); }
  if (typeof json?.access_token !== "string" || json.access_token === "") throw new FsmAvailabilityError("malformed", "auth");
  const ttl = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : DEFAULT_TOKEN_TTL_S;
  tokenCache.set(key, { token: json.access_token, expiresAt: now + ttl * 1000 - TOKEN_SKEW_MS });
  return json.access_token;
}

/** Strict normaliser. Windows without a parseable UTC range are dropped (=> the time stays unavailable). */
export function normalizeCapacity(json: unknown): FsmWindow[] {
  const list = (json as { availabilities?: unknown })?.availabilities;
  if (!Array.isArray(list)) throw new FsmAvailabilityError("malformed", "availabilities");
  const out: FsmWindow[] = [];
  for (const raw of list) {
    const a = raw as Record<string, unknown> | null;
    if (!a || typeof a !== "object") continue;
    const startMs = typeof a.startUtc === "string" ? Date.parse(a.startUtc) : NaN;
    const endMs = typeof a.endUtc === "string" ? Date.parse(a.endUtc) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const openHours = typeof a.openAvailability === "number" && Number.isFinite(a.openAvailability) ? a.openAvailability : 0;
    const totalHours = typeof a.totalAvailability === "number" && Number.isFinite(a.totalAvailability) ? a.totalAvailability : 0;
    out.push({ startMs, endMs, open: a.isAvailable === true && openHours > 0, openHours, totalHours });
  }
  return out;
}

/** A slot is allowed only when its start falls inside a window ServiceTitan reports as open. */
export function slotAllowedByWindows(windows: readonly FsmWindow[], startMs: number): boolean {
  return windows.some((w) => w.open && startMs >= w.startMs && startMs < w.endMs);
}

async function fetchChunk(
  c: ServiceTitanCapacityConfig,
  ids: { businessUnitId: number; jobTypeId: number; tenant: string },
  fromMs: number,
  toMs: number,
  d: CapacityDeps,
): Promise<FsmWindow[]> {
  const url = `${HOSTS[d.env ?? "production"].api}/dispatch/v2/tenant/${ids.tenant}/capacity`;
  const body = JSON.stringify({
    startsOnOrAfter: new Date(fromMs).toISOString(),
    endsOnOrBefore: new Date(toMs).toISOString(),
    businessUnitIds: [ids.businessUnitId],
    jobTypeId: ids.jobTypeId,
    skillBasedAvailability: false,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(c, d, attempt > 0);
    let res: Response;
    try {
      res = await fetchWithRetry(
        url,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "ST-App-Key": c.st_app_key, "Content-Type": "application/json" }, body },
        { maxAttempts: 2, timeoutMs: d.timeoutMs ?? 6000, idempotent: true },
        { fetchImpl: d.fetchImpl, sleep: d.sleep, now: d.now },
      );
    } catch {
      throw new FsmAvailabilityError("timeout");
    }
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      await res.body?.cancel().catch(() => undefined);
      continue; // stale cached token: force-refresh once
    }
    if (res.status === 401 || res.status === 403) throw new FsmAvailabilityError("auth");
    if (res.status === 429) throw new FsmAvailabilityError("throttled");
    if (!res.ok) throw new FsmAvailabilityError("http", String(res.status));
    let json: unknown;
    try { json = await res.json(); } catch { throw new FsmAvailabilityError("malformed", "json"); }
    return normalizeCapacity(json);
  }
  throw new FsmAvailabilityError("auth");
}

/** Reads capacity for [fromMs, toMs). Chunked defensively; any chunk failure fails the whole read (fail closed). */
export async function fetchServiceTitanCapacity(
  config: ServiceTitanCapacityConfig,
  range: { fromMs: number; toMs: number },
  deps: CapacityDeps = {},
): Promise<FsmWindow[]> {
  const ids = assertConfig(config);
  if (!Number.isFinite(range.fromMs) || !Number.isFinite(range.toMs) || range.toMs <= range.fromMs) {
    throw new FsmAvailabilityError("malformed", "range");
  }
  const chunks: Array<[number, number]> = [];
  for (let s = range.fromMs; s < range.toMs; s += CAPACITY_CHUNK_DAYS * DAY_MS) {
    chunks.push([s, Math.min(range.toMs, s + CAPACITY_CHUNK_DAYS * DAY_MS)]);
  }
  if (chunks.length > 10) throw new FsmAvailabilityError("malformed", "range_too_large");
  const all: FsmWindow[] = [];
  for (const [from, to] of chunks) all.push(...(await fetchChunk(config, ids, from, to, deps)));
  return all;
}
