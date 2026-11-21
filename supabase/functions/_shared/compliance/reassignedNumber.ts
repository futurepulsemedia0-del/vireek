// supabase/functions/_shared/compliance/reassignedNumber.ts
//
// Provider-agnostic "has this phone number been reassigned since consent was captured?" check.
//
// NOT LEGAL ADVICE. [COUNSEL] Whether a reassigned-numbers lookup is required, and which
// consent date it must be run against, is a legal question; see
// docs/compliance/speed-to-lead-assumptions.md (section 4, item 4). This module only provides the
// mechanism, and it is deliberately vendor-neutral: no vendor name, URL or key lives in code.
//
// Design rules (read before editing):
//   1. FAIL CLOSED. Anything other than an explicit, fresh "not reassigned" answer blocks contact.
//      Unconfigured provider, timeout, HTTP error, malformed body, unknown status => "block".
//   2. Pure + injectable. All I/O (HTTP, clock) is passed in, so decisions are unit-testable.
//   3. The adapter contract is tiny so any vendor can be wrapped in ~20 lines (see `httpJsonAdapter`).
//   4. Nothing here touches the database; persistence is done by consentChecks.ts.
//
// Env (all optional; absence means "check unavailable" => fail closed when the check is required):
//   REASSIGNED_NUMBER_CHECK_MODE   "required" (default) | "off"
//   REASSIGNED_NUMBER_ADAPTER      adapter name, default "http-json"
//   REASSIGNED_NUMBER_API_URL      endpoint for the generic http-json adapter
//   REASSIGNED_NUMBER_API_KEY      bearer token for the generic http-json adapter
//   REASSIGNED_NUMBER_TIMEOUT_MS   per-call timeout, default 4000 (clamped 500..15000)
//   REASSIGNED_NUMBER_MAX_AGE_HOURS  how long a "clear" result stays valid, default 24 (clamped 1..720)

export type ReassignedStatus = "not_reassigned" | "reassigned" | "unknown";

export interface ReassignedLookup {
  /** E.164 number to check. */
  phoneE164: string;
  /** When the consent being relied on was captured (ISO 8601). Most RND-style products need this. */
  consentCapturedAt: string;
}

export interface ReassignedAnswer {
  status: ReassignedStatus;
  /** Opaque vendor reference, stored in the log for audit/disputes. Never a secret. */
  reference?: string | null;
  /** Free-form, short, non-sensitive detail (e.g. disconnect date). */
  detail?: string | null;
}

/** What a vendor wrapper must implement. Throwing is allowed and is treated as "unavailable". */
export interface ReassignedNumberAdapter {
  readonly name: string;
  check(req: ReassignedLookup, opts: { signal: AbortSignal }): Promise<ReassignedAnswer>;
}

export type CheckMode = "required" | "off";

export interface ReassignedConfig {
  mode: CheckMode;
  adapterName: string;
  apiUrl: string | null;
  apiKey: string | null;
  timeoutMs: number;
  maxAgeHours: number;
}

export type BlockReason =
  | "REASSIGNED"
  | "CHECK_UNAVAILABLE"
  | "CHECK_NOT_CONFIGURED"
  | "CHECK_TIMEOUT"
  | "CHECK_INVALID_RESPONSE"
  | "CHECK_UNKNOWN_STATUS"
  | "INVALID_INPUT";

export type ReassignedDecision =
  | { allow: true; source: "provider" | "cache" | "mode_off"; adapter: string; status: ReassignedStatus; reference: string | null }
  | { allow: false; reason: BlockReason; adapter: string; status: ReassignedStatus; retryable: boolean; reference: string | null; detail: string };

type EnvGetter = (key: string) => string | undefined;

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function loadReassignedConfig(getEnv: EnvGetter): ReassignedConfig {
  const rawMode = (getEnv("REASSIGNED_NUMBER_CHECK_MODE") ?? "required").trim().toLowerCase();
  return {
    // Anything that is not exactly "off" is "required": a typo must never silently disable the check.
    mode: rawMode === "off" ? "off" : "required",
    adapterName: (getEnv("REASSIGNED_NUMBER_ADAPTER") ?? "http-json").trim().toLowerCase() || "http-json",
    apiUrl: (getEnv("REASSIGNED_NUMBER_API_URL") ?? "").trim() || null,
    apiKey: (getEnv("REASSIGNED_NUMBER_API_KEY") ?? "").trim() || null,
    timeoutMs: clampInt(getEnv("REASSIGNED_NUMBER_TIMEOUT_MS"), 4000, 500, 15000),
    maxAgeHours: clampInt(getEnv("REASSIGNED_NUMBER_MAX_AGE_HOURS"), 24, 1, 720),
  };
}

// ---------------------------------------------------------------------------
// Generic HTTP adapter (vendor-neutral)
// ---------------------------------------------------------------------------
//
// Contract the configured endpoint must satisfy (a vendor that does not match it needs a small
// proxy or a custom adapter registered via `registerAdapter`):
//   POST <REASSIGNED_NUMBER_API_URL>
//   Authorization: Bearer <REASSIGNED_NUMBER_API_KEY>
//   body:  { "phone": "+15551234567", "consent_date": "2026-11-01T12:00:00Z" }
//   reply: { "status": "reassigned" | "not_reassigned" | "unknown", "reference"?: string, "detail"?: string }

export function httpJsonAdapter(cfg: Pick<ReassignedConfig, "apiUrl" | "apiKey">, fetchImpl: typeof fetch = fetch): ReassignedNumberAdapter | null {
  if (!cfg.apiUrl || !cfg.apiKey) return null;
  const url = cfg.apiUrl;
  const key = cfg.apiKey;
  return {
    name: "http-json",
    async check(req, { signal }) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ phone: req.phoneE164, consent_date: req.consentCapturedAt }),
        signal,
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const body: unknown = await res.json();
      return parseAnswer(body);
    },
  };
}

/** Strict parse: anything unexpected becomes a thrown error => "invalid response" => block. */
export function parseAnswer(body: unknown): ReassignedAnswer {
  if (!body || typeof body !== "object") throw new Error("invalid_body");
  const o = body as Record<string, unknown>;
  const status = o.status;
  if (status !== "reassigned" && status !== "not_reassigned" && status !== "unknown") throw new Error("invalid_status");
  const ref = typeof o.reference === "string" ? o.reference.slice(0, 120) : null;
  const detail = typeof o.detail === "string" ? o.detail.slice(0, 200) : null;
  return { status, reference: ref, detail };
}

// ---------------------------------------------------------------------------
// Adapter registry (no vendor is registered here; deployments may add their own)
// ---------------------------------------------------------------------------

type AdapterFactory = (cfg: ReassignedConfig) => ReassignedNumberAdapter | null;
const registry = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name.trim().toLowerCase(), factory);
}

export function resolveAdapter(cfg: ReassignedConfig, fetchImpl?: typeof fetch): ReassignedNumberAdapter | null {
  if (cfg.adapterName === "http-json") return httpJsonAdapter(cfg, fetchImpl);
  const f = registry.get(cfg.adapterName);
  return f ? f(cfg) : null;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export const E164_RE = /^\+[1-9]\d{7,14}$/;

export interface CachedResult {
  status: ReassignedStatus;
  adapter: string;
  reference: string | null;
  checkedAt: Date;
  /** The consent timestamp the cached answer was computed against. */
  consentCapturedAt: string;
}

export interface CheckDeps {
  adapter: ReassignedNumberAdapter | null;
  config: ReassignedConfig;
  now: Date;
  /** Latest stored result for this number, if any. Only a "not_reassigned" within maxAge, for the SAME consent, is reused. */
  cached?: CachedResult | null;
}

function block(reason: BlockReason, adapter: string, status: ReassignedStatus, retryable: boolean, detail: string, reference: string | null = null): ReassignedDecision {
  return { allow: false, reason, adapter, status, retryable, reference, detail };
}

export async function decideReassigned(input: ReassignedLookup, deps: CheckDeps): Promise<ReassignedDecision> {
  const { config, now } = deps;
  const adapterName = deps.adapter?.name ?? config.adapterName;

  if (!E164_RE.test(input.phoneE164) || Number.isNaN(Date.parse(input.consentCapturedAt))) {
    return block("INVALID_INPUT", adapterName, "unknown", false, "phone is not E.164 or consent timestamp is not a date");
  }
  if (config.mode === "off") {
    // Explicit operator choice, recorded in the log so the audit trail shows the check was skipped by config.
    return { allow: true, source: "mode_off", adapter: "none", status: "unknown", reference: null };
  }

  const c = deps.cached;
  if (
    c && c.status === "not_reassigned" && c.consentCapturedAt === input.consentCapturedAt &&
    now.getTime() - c.checkedAt.getTime() < config.maxAgeHours * 3_600_000 && now.getTime() >= c.checkedAt.getTime()
  ) {
    return { allow: true, source: "cache", adapter: c.adapter, status: "not_reassigned", reference: c.reference };
  }

  if (!deps.adapter) {
    return block("CHECK_NOT_CONFIGURED", adapterName, "unknown", true, "no reassigned-number provider is configured");
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.timeoutMs);
  try {
    const ans = await deps.adapter.check(input, { signal: ctl.signal });
    const ref = ans.reference ?? null;
    if (ans.status === "not_reassigned") {
      return { allow: true, source: "provider", adapter: deps.adapter.name, status: "not_reassigned", reference: ref };
    }
    if (ans.status === "reassigned") {
      return block("REASSIGNED", deps.adapter.name, "reassigned", false, ans.detail ?? "number reassigned after consent", ref);
    }
    return block("CHECK_UNKNOWN_STATUS", deps.adapter.name, "unknown", true, ans.detail ?? "provider could not determine status", ref);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (ctl.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
      return block("CHECK_TIMEOUT", deps.adapter.name, "unknown", true, `timeout after ${config.timeoutMs}ms`);
    }
    if (msg === "invalid_body" || msg === "invalid_status") {
      return block("CHECK_INVALID_RESPONSE", deps.adapter.name, "unknown", true, msg);
    }
    return block("CHECK_UNAVAILABLE", deps.adapter.name, "unknown", true, msg.slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}
