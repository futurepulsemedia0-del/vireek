// supabase/functions/_shared/ai-core/responseCache.ts
//
// Response cache for DETERMINISTIC prompts. Design rules (each one is a security or correctness decision):
//   1. Opt-in per call site: a request is cached only when the caller passes `cache: { ttlSeconds }` AND
//      temperature === 0. Nothing is cached implicitly, so a creative / conversational task can never be
//      served a stale answer by accident.
//   2. Tenant isolation: the cache key and the row are both scoped to accountId. A request without an
//      accountId is never cached (no shared "platform" namespace => no cross-tenant leakage path).
//   3. The key covers EVERYTHING that influences the output: task, final system prompt, messages,
//      maxTokens, temperature, jsonMode and the provider/model chain. Change any of them => new key.
//   4. Requests that carry the AI Security vault (`security`) are never cached: their prompt holds
//      per-call tokens that are re-hydrated into real values after the model answers.
//   5. Streaming is never cached. Failures are never cached. Output guardrails run again on every hit.
//   6. The store is best-effort: any read/write error is swallowed and the call goes to the provider.

import type { ChatMessage, RouteEntry, TaskType } from "./types.ts";

export const RESPONSE_CACHE_KEY_VERSION = 1;
export const MIN_TTL_SECONDS = 30;
export const MAX_TTL_SECONDS = 7 * 24 * 3600;
/** Responses larger than this are not stored (bounded row size). */
export const MAX_CACHED_CHARS = 64_000;

export interface ResponseCacheOptions {
  /** How long a stored answer stays valid. Clamped to [MIN_TTL_SECONDS, MAX_TTL_SECONDS]. */
  ttlSeconds: number;
}

export interface CacheKeyInput {
  accountId: string;
  task: TaskType;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
  route: readonly Pick<RouteEntry, "provider" | "model">[];
}

/** Deterministic JSON: object keys sorted recursively, so key order can never change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildCacheKey(input: CacheKeyInput): Promise<string> {
  return sha256Hex(
    stableStringify({
      v: RESPONSE_CACHE_KEY_VERSION,
      account: input.accountId,
      task: input.task,
      system: input.system,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      jsonMode: input.jsonMode,
      route: input.route.map((r) => ({ provider: r.provider, model: r.model })),
    }),
  );
}

export function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return MIN_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)));
}

export interface EligibilityInput {
  flagOn: boolean;
  cache?: ResponseCacheOptions;
  accountId?: string;
  temperature?: number;
  hasSecurityContext: boolean;
  streaming: boolean;
}

export type Eligibility = { ok: true; ttlSeconds: number } | { ok: false; reason: string };

export function cacheEligibility(i: EligibilityInput): Eligibility {
  if (!i.flagOn) return { ok: false, reason: "flag_off" };
  if (!i.cache) return { ok: false, reason: "not_opted_in" };
  if (i.streaming) return { ok: false, reason: "streaming" };
  if (!i.accountId) return { ok: false, reason: "no_account_scope" };
  if (i.hasSecurityContext) return { ok: false, reason: "security_vault" };
  if (i.temperature !== 0) return { ok: false, reason: "not_deterministic" };
  return { ok: true, ttlSeconds: clampTtl(i.cache.ttlSeconds) };
}

export interface CachedResponse {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Storage port. The Supabase implementation lives in responseCacheStore.ts; tests use an in-memory one. */
export interface ResponseCacheStore {
  get(accountId: string, key: string): Promise<CachedResponse | null>;
  put(accountId: string, key: string, task: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
}

export async function cacheLookup(store: ResponseCacheStore, accountId: string, key: string): Promise<CachedResponse | null> {
  try {
    const hit = await store.get(accountId, key);
    if (!hit || typeof hit.text !== "string" || hit.text.length === 0) return null;
    return hit;
  } catch (err) {
    console.error("[ai-core] response cache read failed, calling provider:", err);
    return null;
  }
}

export async function cacheStore(
  store: ResponseCacheStore,
  accountId: string,
  key: string,
  task: string,
  value: CachedResponse,
  ttlSeconds: number,
): Promise<void> {
  if (!value.text || value.text.length > MAX_CACHED_CHARS) return;
  try {
    await store.put(accountId, key, task, value, clampTtl(ttlSeconds));
  } catch (err) {
    console.error("[ai-core] response cache write failed:", err);
  }
}
