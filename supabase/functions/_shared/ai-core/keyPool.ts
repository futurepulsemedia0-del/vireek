// supabase/functions/_shared/ai-core/keyPool.ts
//
// Credential pool for platform-level AI provider keys (Gemini, Groq, ...). Pure logic, no network, no DB.
//
// POLICY (deliberate, provider-ToS-safe):
//   * Keys are ORDERED and STICKY: the first usable key is always used. No round-robin, no spreading load.
//   * AUTH failure (401/403)  -> that key is quarantined; the NEXT key may be used (the key itself is broken).
//   * RATE_LIMIT (429/quota)  -> quota is account/project-level, so we NEVER switch to a sibling key.
//                                The pool reports "rate_limited" until the cool-down ends and the caller
//                                falls through to the next PROVIDER in the route chain.
//   * Other errors             -> no key switch (a different key does not fix an outage).
//
// ENV FORMAT (per provider prefix, e.g. GEMINI):
//   GEMINI_API_KEY   legacy single key. Always FIRST, so existing deployments behave exactly as before.
//   GEMINI_API_KEYS  optional, comma/newline separated. Each entry is `label=secret` or a bare secret.
//
// Secrets are never logged, never returned by any public API of this module except `acquire()` (which
// hands the secret only to the adapter making the call). Only labels are exposed for observability.

import { AiCoreError } from "./types.ts";
import type { ProviderId } from "./types.ts";

export interface PooledKey {
  label: string;
  secret: string;
}

export type FailureKind = "AUTH" | "RATE_LIMIT" | "OTHER";

export type AcquireResult =
  | { ok: true; key: PooledKey }
  | { ok: false; reason: "no_keys" | "all_quarantined" | "rate_limited"; retryAfterMs: number };

export interface KeyEvent {
  provider: ProviderId;
  label: string;
  kind: "success" | FailureKind;
  at: number;
  cooldownUntil: number | null;
}

export interface PoolOptions {
  now?: () => number;
  authCooldownMs?: number;
  defaultRateLimitCooldownMs?: number;
  maxRateLimitCooldownMs?: number;
  onEvent?: (e: KeyEvent) => void;
}

const LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_SECRET_LEN = 8;

export function parseKeyEntries(multi: string | undefined, legacy: string | undefined): PooledKey[] {
  const out: PooledKey[] = [];
  const seen = new Set<string>();
  const push = (label: string, secret: string) => {
    const s = secret.trim();
    if (s.length < MIN_SECRET_LEN || seen.has(s)) return;
    seen.add(s);
    out.push({ label, secret: s });
  };

  if (legacy && legacy.trim()) push("default", legacy);

  let idx = 0;
  for (const raw of (multi ?? "").split(/[\n,]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    idx += 1;
    const eq = entry.indexOf("=");
    if (eq > 0 && LABEL_RE.test(entry.slice(0, eq).trim()) && entry.length - eq - 1 >= MIN_SECRET_LEN) {
      push(entry.slice(0, eq).trim(), entry.slice(eq + 1));
    } else {
      push(`k${idx}`, entry);
    }
  }

  // Labels must be unique (they key the health state).
  const labels = new Set<string>();
  return out.map((k, i) => {
    let label = k.label;
    if (labels.has(label)) label = `${label}_${i + 1}`;
    labels.add(label);
    return { label, secret: k.secret };
  });
}

interface KeyState {
  quarantinedUntil: number;
  rateLimitedUntil: number;
}

export interface KeyPool {
  readonly provider: ProviderId;
  size(): number;
  acquire(): AcquireResult;
  reportSuccess(label: string): void;
  reportFailure(label: string, kind: FailureKind, retryAfterMs?: number): void;
  /** Observability only: never includes secrets. */
  snapshot(): { label: string; quarantinedUntil: number; rateLimitedUntil: number }[];
}

export function createKeyPool(provider: ProviderId, keys: readonly PooledKey[], opts: PoolOptions = {}): KeyPool {
  const now = opts.now ?? (() => Date.now());
  const authCooldown = opts.authCooldownMs ?? 10 * 60_000;
  const defaultRl = opts.defaultRateLimitCooldownMs ?? 30_000;
  const maxRl = opts.maxRateLimitCooldownMs ?? 5 * 60_000;
  const state = new Map<string, KeyState>(keys.map((k) => [k.label, { quarantinedUntil: 0, rateLimitedUntil: 0 }]));

  const emit = (label: string, kind: KeyEvent["kind"], cooldownUntil: number | null) => {
    try {
      opts.onEvent?.({ provider, label, kind, at: now(), cooldownUntil });
    } catch {
      /* observability must never break a request */
    }
  };

  return {
    provider,
    size: () => keys.length,

    acquire(): AcquireResult {
      if (keys.length === 0) return { ok: false, reason: "no_keys", retryAfterMs: 0 };
      const t = now();
      for (const key of keys) {
        const st = state.get(key.label)!;
        if (st.quarantinedUntil > t) continue; // broken key: skip to the next one
        if (st.rateLimitedUntil > t) {
          // Quota is shared across keys of one provider: do NOT fall through to a sibling key.
          return { ok: false, reason: "rate_limited", retryAfterMs: st.rateLimitedUntil - t };
        }
        return { ok: true, key };
      }
      let soonest = Infinity;
      for (const st of state.values()) soonest = Math.min(soonest, st.quarantinedUntil - t);
      return { ok: false, reason: "all_quarantined", retryAfterMs: Number.isFinite(soonest) ? Math.max(0, soonest) : 0 };
    },

    reportSuccess(label) {
      const st = state.get(label);
      if (!st) return;
      st.rateLimitedUntil = 0;
      emit(label, "success", null);
    },

    reportFailure(label, kind, retryAfterMs) {
      const st = state.get(label);
      if (!st) return;
      const t = now();
      if (kind === "AUTH") {
        st.quarantinedUntil = t + authCooldown;
        emit(label, "AUTH", st.quarantinedUntil);
      } else if (kind === "RATE_LIMIT") {
        const wait = Math.min(maxRl, Math.max(1_000, retryAfterMs ?? defaultRl));
        st.rateLimitedUntil = t + wait;
        emit(label, "RATE_LIMIT", st.rateLimitedUntil);
      } else {
        emit(label, "OTHER", null);
      }
    },

    snapshot: () => keys.map((k) => ({ label: k.label, ...state.get(k.label)! })),
  };
}

export function classifyAiError(err: unknown): FailureKind {
  if (err instanceof AiCoreError) {
    if (err.code === "AUTH") return "AUTH";
    if (err.code === "RATE_LIMIT") return "RATE_LIMIT";
  }
  return "OTHER";
}

/**
 * Runs `fn` with the best key. Retries with the next key ONLY after an AUTH failure of the previous key.
 * Bounded by pool size, so a fully revoked pool fails fast instead of looping.
 */
export async function withKeyFailover<T>(
  pool: KeyPool,
  providerId: ProviderId,
  fn: (secret: string) => Promise<T>,
  retryAfterOf?: (err: unknown) => number | undefined,
): Promise<T> {
  let lastAuth: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, pool.size()); attempt++) {
    const got = pool.acquire();
    if (!got.ok) {
      if (got.reason === "rate_limited") {
        throw new AiCoreError("RATE_LIMIT", `${pool.provider}: cooling down after a rate-limit response.`, providerId);
      }
      if (lastAuth) throw lastAuth;
      if (got.reason === "all_quarantined") {
        throw new AiCoreError("AUTH", `${pool.provider}: all configured keys were rejected recently.`, providerId);
      }
      throw new AiCoreError("NOT_CONFIGURED", `${pool.provider}: no API key configured.`, providerId);
    }
    try {
      const result = await fn(got.key.secret);
      pool.reportSuccess(got.key.label);
      return result;
    } catch (err) {
      const kind = classifyAiError(err);
      pool.reportFailure(got.key.label, kind, kind === "RATE_LIMIT" ? retryAfterOf?.(err) : undefined);
      if (kind !== "AUTH") throw err;
      lastAuth = err;
    }
  }
  throw lastAuth ?? new AiCoreError("AUTH", `${pool.provider}: no usable key.`, providerId);
}

const SUCCESS_THROTTLE_MS = 5 * 60_000;
const FAILURE_THROTTLE_MS = 10_000;

/** Pure throttle for health persistence: successes at most every 5 min, failures every 10 s per key+kind. */
export function shouldPersist(e: KeyEvent, last: number | undefined): boolean {
  const gap = e.kind === "success" ? SUCCESS_THROTTLE_MS : FAILURE_THROTTLE_MS;
  return last === undefined || e.at - last >= gap;
}
