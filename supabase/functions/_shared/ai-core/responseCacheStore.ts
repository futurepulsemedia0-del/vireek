// supabase/functions/_shared/ai-core/responseCacheStore.ts
//
// Postgres implementation of ResponseCacheStore. Service-role only (the table has no tenant policy).
// Reads go through public.ai_response_cache_get (atomic hit counter, expired rows invisible).
// Writes upsert on (account_id, cache_key); a concurrent identical write just refreshes the same row.

import type { CachedResponse, ResponseCacheStore } from "./responseCache.ts";

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** The slice of the supabase-js client this store needs (keeps it injectable and testable). */
export interface CacheDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  from(table: string): {
    upsert(row: Record<string, unknown>, opts: { onConflict: string }): PromiseLike<{ error: { message: string } | null }>;
  };
}

export function createSupabaseResponseCacheStore(db: CacheDbClient, now: () => number = Date.now): ResponseCacheStore {
  return {
    async get(accountId, key) {
      const { data, error } = await db.rpc("ai_response_cache_get", { p_account: accountId, p_key: key });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      if (typeof r.response_text !== "string") return null;
      const out: CachedResponse = {
        text: r.response_text,
        provider: String(r.provider ?? "cache"),
        model: String(r.model ?? ""),
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
      };
      return out;
    },
    async put(accountId, key, task, value, ttlSeconds) {
      const { error } = await db.from("ai_response_cache").upsert(
        {
          account_id: accountId,
          cache_key: key,
          task,
          response_text: value.text,
          provider: value.provider,
          model: value.model,
          input_tokens: value.inputTokens,
          output_tokens: value.outputTokens,
          expires_at: new Date(now() + ttlSeconds * 1000).toISOString(),
        },
        { onConflict: "account_id,cache_key" },
      );
      if (error) throw new Error(error.message);
    },
  };
}
