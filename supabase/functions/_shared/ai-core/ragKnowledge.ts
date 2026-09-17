// supabase/functions/_shared/ai-core/ragKnowledge.ts
//
// Vireek AI Core — Brand Knowledge RAG lookup.
//
// This is the piece that was missing: the `brand_knowledge` table + the
// `match_brand_knowledge()` RPC (see
// supabase/migrations/20260915010000_brand_knowledge_rag.sql) and the
// Cohere embedding adapter (see providers/cohere.ts) already existed,
// but nothing ever called them — `knowledge.ts` was still the only thing
// grounding the AI, with its small hand-maintained topic list.
//
// searchBrandKnowledge() embeds the user's actual question and returns
// the most similar chunks of REAL site content (help articles, pricing,
// industries, glossary, competitor comparisons, integrations, etc. —
// see scripts/ingest-brand-knowledge.mjs for what's been ingested).
//
// Designed to fail soft: if COHERE_API_KEY isn't set, the RPC errors, or
// nothing matches well enough, this returns an empty array rather than
// throwing — callers (ai-core/index.ts) fall back to the static
// knowledge.ts brief in that case, so brand grounding never goes to zero
// just because the RAG layer isn't configured yet.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { EMBEDDING_ADAPTER } from "./registry.ts";
import type { TaskType } from "./types.ts";

export interface BrandKnowledgeMatch {
  id: string;
  source: string;
  sourceUrl: string | null;
  title: string | null;
  content: string;
  similarity: number;
}

const DEFAULT_MATCH_COUNT = 6;
const DEFAULT_MIN_SIMILARITY = 0.3;

// A lightweight, unauthenticated client is enough here: `brand_knowledge`
// SELECT is public via RLS (see the migration) and `match_brand_knowledge`
// is GRANTed to anon — this never touches per-user data, so there's no
// reason to thread a caller's auth token through.
function getReadOnlyClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  return createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
}

/**
 * Embeds `question` and returns the top matching brand-knowledge chunks.
 * Returns `[]` (never throws) if embeddings aren't configured, the
 * embedding call fails, or the RPC call fails — see file header.
 */
export async function searchBrandKnowledge(
  question: string,
  matchCount: number = DEFAULT_MATCH_COUNT,
): Promise<BrandKnowledgeMatch[]> {
  const trimmed = question.trim();
  if (!trimmed) return [];
  if (!EMBEDDING_ADAPTER.isConfigured()) return [];

  try {
    const embedResult = await EMBEDDING_ADAPTER.embed({
      input: [trimmed],
      inputType: "search_query",
      timeoutMs: 6_000,
    });
    const queryEmbedding = embedResult.vectors[0];
    if (!queryEmbedding || queryEmbedding.length === 0) return [];

    const supabase = getReadOnlyClient();
    const { data, error } = await supabase.rpc("match_brand_knowledge", {
      query_embedding: queryEmbedding,
      match_count: matchCount,
      min_similarity: DEFAULT_MIN_SIMILARITY,
    });

    if (error) {
      console.error("[ragKnowledge] match_brand_knowledge RPC error:", error.message);
      return [];
    }

    return (data ?? []).map((row: {
      id: string;
      source: string;
      source_url: string | null;
      title: string | null;
      content: string;
      similarity: number;
    }) => ({
      id: row.id,
      source: row.source,
      sourceUrl: row.source_url,
      title: row.title,
      content: row.content,
      similarity: row.similarity,
    }));
  } catch (err) {
    console.error("[ragKnowledge] searchBrandKnowledge failed:", err);
    return [];
  }
}

/**
 * Formats matches into the block appended to the system prompt. Each
 * chunk carries its source page so the model can point a user to it
 * ("see vireek.com/security for more") instead of just asserting facts
 * with no trail back to the source.
 */
export function formatMatchesForPrompt(matches: BrandKnowledgeMatch[]): string {
  if (!matches.length) return "";
  return matches
    .map((m) => {
      const heading = m.title ? `${m.title}${m.sourceUrl ? ` (${m.sourceUrl})` : ""}` : m.source;
      return `[${heading}]\n${m.content}`;
    })
    .join("\n\n");
}

// Tasks worth spending an embedding call + RPC round-trip on. Same set
// as knowledge.ts's FULL_BRIEF_TASKS today — dashboard_answer answers
// strictly from pre-fetched account data (never brand/product facts) and
// intent_classify doesn't use prose knowledge at all, so both skip RAG
// entirely rather than paying the extra latency for nothing.
export const RAG_ELIGIBLE_TASKS = new Set<TaskType>(["demo_chat", "general"]);
