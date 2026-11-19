// supabase/functions/_shared/ai-core/batchClient.ts
//
// The ONLY place that talks to the provider's batch endpoints (lives inside ai-core so the
// check:direct-llm ratchet stays satisfied and the API key is read in one module). Fetch is injectable
// for tests. Wire format: see batch.ts. Never logs prompts, results or the key.

import { buildAnthropicBatchBody, parseAnthropicBatchResults, type BatchOutcome, type BatchRow } from "./batch.ts";

const API = "https://api.anthropic.com/v1/messages/batches";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BatchClient {
  submit(rows: readonly BatchRow[], model: string): Promise<{ batchId: string }>;
  /** `null` while the provider is still processing; otherwise the parsed outcomes. */
  collect(batchId: string): Promise<BatchOutcome[] | null>;
}

export function getAnthropicBatchKey(): string | undefined {
  return Deno.env.get("ANTHROPIC_API_KEY") || undefined;
}

export function createAnthropicBatchClient(apiKey: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): BatchClient {
  const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  return {
    async submit(rows, model) {
      const res = await fetchFn(API, { method: "POST", headers, body: JSON.stringify(buildAnthropicBatchBody(rows, model)), signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`submit ${res.status}`);
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id) throw new Error("no batch id");
      return { batchId: body.id };
    },
    async collect(batchId) {
      const st = await fetchFn(`${API}/${encodeURIComponent(batchId)}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!st.ok) throw new Error(`status ${st.status}`);
      const meta = (await st.json()) as { processing_status?: string; results_url?: string | null };
      if (meta.processing_status !== "ended" || !meta.results_url) return null;
      const res = await fetchFn(meta.results_url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`results ${res.status}`);
      return parseAnthropicBatchResults(await res.text());
    },
  };
}
