// supabase/functions/_shared/ai-core/siteKnowledge.ts
//
// PUBLIC knowledge retrieval for "Ask Vireek": hybrid (vector + keyword,
// fused with RRF inside Postgres) over `site_kb_chunks`.
//
// - Reads only through the anon key + RLS: the table holds public site
//   content only, so this module can never see account/internal data.
// - Soft-fails: returns `{ available: false }` when embeddings are not
//   configured, the RPC is missing (migration not applied) or times out.
//   Callers then fall back to the legacy path, so nothing regresses.
// - Caches per isolate (5 min, 200 entries): repeated questions skip the
//   embedding call + RPC entirely — and index.ts's own lookup for the
//   same question (via searchBrandKnowledge) is served from this cache,
//   so the question is embedded once per request, not twice.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { EMBEDDING_ADAPTER } from "./registry.ts";
import { GROUNDED_MIN_SIMILARITY, isGrounded, type RetrievedChunk } from "./siteAssistantLogic.ts";

export interface SiteKbMatch {
  id: string;
  title: string;
  content: string;
  url: string | null;
  topic: string;
  plans: string[];
  status: "live" | "beta" | "planned";
  score: number;
  similarity: number;
  keywordHit: boolean;
}

export interface SiteRetrieval {
  available: boolean;
  matches: SiteKbMatch[];
  grounded: boolean;
  topSimilarity: number;
  fromCache: boolean;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const EMBED_TIMEOUT_MS = 1_500; // first-token budget: never let retrieval eat it
const MATCH_COUNT = 5;

const cache = new Map<string, { at: number; value: SiteRetrieval }>();

function cacheGet(key: string): SiteRetrieval | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { ...hit.value, fromCache: true };
}

function cacheSet(key: string, value: SiteRetrieval) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

const UNAVAILABLE: SiteRetrieval = { available: false, matches: [], grounded: false, topSimilarity: 0, fromCache: false };

function client() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false },
  });
}

export function toRetrievedChunks(matches: SiteKbMatch[]): RetrievedChunk[] {
  return matches.map((m) => ({ title: m.title, url: m.url, similarity: m.similarity, keywordHit: m.keywordHit }));
}

/**
 * Hybrid retrieval for one question. `question` must be the raw latest
 * user turn (same string index.ts passes to searchBrandKnowledge) so the
 * cache key lines up.
 */
export async function retrieveSiteKnowledge(question: string): Promise<SiteRetrieval> {
  const q = question.trim();
  if (!q) return UNAVAILABLE;

  const key = q.toLowerCase().replace(/\s+/g, " ").slice(0, 300);
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!EMBEDDING_ADAPTER.isConfigured()) {
    // Keyword-only is still useful (English); run the RPC without a vector.
    return await callRpc(key, q, null);
  }

  try {
    const emb = await EMBEDDING_ADAPTER.embed({ input: [q], inputType: "search_query", timeoutMs: EMBED_TIMEOUT_MS });
    const vec = emb.vectors[0];
    return await callRpc(key, q, vec && vec.length ? vec : null);
  } catch (err) {
    console.error("[siteKnowledge] embed failed, trying keyword-only:", err instanceof Error ? err.message : err);
    return await callRpc(key, q, null);
  }
}

async function callRpc(key: string, q: string, vec: number[] | null): Promise<SiteRetrieval> {
  try {
    const { data, error } = await client().rpc("match_site_kb", {
      // pgvector accepts the JSON-array text form; null => keyword-only.
      query_embedding: vec ? JSON.stringify(vec) : null,
      query_text: q,
      match_count: MATCH_COUNT,
      min_vector_similarity: GROUNDED_MIN_SIMILARITY - 0.07,
    });
    if (error) {
      // Most likely: migration not applied yet. Soft-fail, do NOT cache.
      console.error("[siteKnowledge] match_site_kb error:", error.message);
      return UNAVAILABLE;
    }
    const matches: SiteKbMatch[] = (data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      content: String(r.content ?? ""),
      url: (r.url as string | null) ?? null,
      topic: String(r.topic ?? ""),
      plans: Array.isArray(r.plans) ? (r.plans as string[]) : [],
      status: (r.status as SiteKbMatch["status"]) ?? "live",
      score: Number(r.score ?? 0),
      similarity: Number(r.similarity ?? 0),
      keywordHit: r.kw_rank != null,
    }));
    const value: SiteRetrieval = {
      available: true,
      matches,
      grounded: isGrounded(toRetrievedChunks(matches)),
      topSimilarity: matches.reduce((m, x) => Math.max(m, x.similarity), 0),
      fromCache: false,
    };
    cacheSet(key, value);
    return value;
  } catch (err) {
    console.error("[siteKnowledge] rpc failed:", err instanceof Error ? err.message : err);
    return UNAVAILABLE;
  }
}

/** Prompt-ready block; beta/planned chunks are labelled so the model can say so. */
export function formatSiteMatches(matches: SiteKbMatch[]): string {
  return matches
    .map((m) => {
      const label = m.status === "live" ? "" : ` [${m.status.toUpperCase()}]`;
      const plans = m.plans.length ? ` (plans: ${m.plans.join(", ")})` : "";
      return `[${m.title}${label}${m.url ? ` — ${m.url}` : ""}${plans}]\n${m.content}`;
    })
    .join("\n\n");
}
