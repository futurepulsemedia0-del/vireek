// supabase/functions/_shared/knowledge/search.ts
//
// Vireek — Knowledge Layer (tenant side).
//
// NOTE: this is NOT _shared/ai-core/knowledge.ts. That file holds facts
// about Vireek itself for the marketing site assistant. This one searches
// the KNOWLEDGE BASE OF THE BUSINESS ON THE CALL — their warranty, their
// service area, their after-hours policy — out of `knowledge_articles`.
//
// Deliberately dependency-free: it talks to Postgres through the caller's
// Supabase client and to Cohere through plain fetch. It does not import
// from ai-core, because ai-core's provider registry is chat-routed and
// this path must keep working (lexical-only) when no embedding key exists
// at all. If ai-core later exposes a routed `embed()`, replace
// `embedQuery()` below and nothing else changes.
//
// Optional secret: COHERE_API_KEY (+ COHERE_EMBED_MODEL, default
// embed-english-v3.0 / 1024 dims). Without it, search silently runs in
// lexical-only mode — never an error, never a broken call.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { classifyEpistemicBoundary, recordEpistemicBoundary, type EpistemicTier } from "../ai-core/epistemicBoundary.ts";

export const EMBEDDING_DIMENSIONS = 1024;

export interface KnowledgeHit {
  id: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  audience: string;
  score: number;
  lexical_rank: number | null;
  semantic_rank: number | null;
  semantic_similarity: number;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** True when the query was embedded and semantic recall was in play. */
  semantic: boolean;
}

// ---------------------------------------------------------------------------
// Embeddings (optional)
// ---------------------------------------------------------------------------

export function embeddingProviderConfigured(): boolean {
  return Boolean(Deno.env.get("COHERE_API_KEY"));
}

export function embeddingModelName(): string {
  return Deno.env.get("COHERE_EMBED_MODEL") || "embed-english-v3.0";
}

/**
 * Embeds one or more texts. `inputType` matters for Cohere's asymmetric
 * models: documents and queries are embedded into the same space but with
 * different prefixes, and mixing them up measurably hurts recall.
 *
 * Returns null on ANY failure — no key, timeout, rate limit, bad response.
 * Callers treat null as "run lexical-only", never as an error to surface.
 */
export async function embedTexts(
  texts: string[],
  inputType: "search_query" | "search_document",
  timeoutMs = 8000,
): Promise<number[][] | null> {
  const apiKey = Deno.env.get("COHERE_API_KEY");
  if (!apiKey || texts.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.cohere.com/v2/embed", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: embeddingModelName(),
        texts: texts.map((t) => t.slice(0, 8000)),
        input_type: inputType,
        embedding_types: ["float"],
      }),
    });

    if (!res.ok) {
      console.error(JSON.stringify({ event: "knowledge_embed_failed", status: res.status }));
      return null;
    }

    const data = await res.json();
    const vectors: number[][] | undefined = data?.embeddings?.float ?? data?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
    return vectors;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "knowledge_embed_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function embedQuery(question: string): Promise<number[] | null> {
  const vectors = await embedTexts([question], "search_query");
  return vectors?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchKnowledge(
  admin: SupabaseClient,
  userId: string,
  question: string,
  opts: { audience?: "ai" | "customer" | "team"; limit?: number; touch?: boolean } = {},
): Promise<KnowledgeSearchResult> {
  const query = question.trim();
  if (!query) return { hits: [], semantic: false };

  const embedding = await embedQuery(query);

  const { data, error } = await admin.rpc("search_knowledge_articles", {
    p_user_id: userId,
    p_query: query,
    p_embedding: embedding,
    p_audience: opts.audience ?? null,
    p_limit: opts.limit ?? 3,
  });

  if (error) {
    console.error(JSON.stringify({ event: "knowledge_search_failed", error: error.message }));
    return { hits: [], semantic: Boolean(embedding) };
  }

  const hits = (data ?? []) as KnowledgeHit[];

  // Fire-and-forget: usage counts drive the "most-asked" view in the
  // dashboard and must never delay a live call. Skipped for dashboard test
  // queries — an owner trying wording shouldn't look like caller demand.
  if (hits.length > 0 && opts.touch !== false) {
    void admin.rpc("touch_knowledge_articles", { p_ids: hits.map((h) => h.id) });
  }

  return { hits, semantic: Boolean(embedding) };
}

export async function recordKnowledgeGap(
  admin: SupabaseClient,
  userId: string,
  question: string,
  source: "voice" | "chat" | "dashboard" | "sms" = "voice",
  callId: string | null = null,
): Promise<void> {
  const { error } = await admin.rpc("record_knowledge_gap", {
    p_user_id: userId,
    p_question: question,
    p_source: source,
    p_call_id: callId,
  });
  if (error) {
    console.error(JSON.stringify({ event: "knowledge_gap_failed", error: error.message }));
  }
}

// ---------------------------------------------------------------------------
// Voice formatting
// ---------------------------------------------------------------------------

/**
 * Turns hits into something an assistant can say out loud.
 *
 * Two rules the wording enforces:
 *  - The assistant gets the FACT, not an instruction to read a document.
 *    Long bodies are trimmed to the summary so it doesn't monologue.
 *  - On a miss it is told explicitly not to guess. A confidently invented
 *    warranty length is far more expensive than "let me have someone
 *    confirm that for you."
 */
export function formatKnowledgeForVoice(
  result: KnowledgeSearchResult,
  question: string,
  tier: EpistemicTier = result.hits.length === 0 ? "no_coverage" : "confident",
): string {
  if (result.hits.length === 0) {
    return (
      `Nothing in this business's knowledge base answers "${question}". ` +
      `Do not guess or invent an answer — tell the caller you'll have someone confirm it and continue the call. ` +
      `The question has been logged for the business to answer.`
    );
  }

  const [best, ...rest] = result.hits;
  const primary = (best.summary || best.body).trim().slice(0, 600);

  if (tier === "weak_match") {
    return (
      `The closest match in this business's knowledge base is "${best.title}": ${primary} ` +
      `This is NOT a confident match — treat it as a possible lead, not a stated fact. ` +
      `Tell the caller you believe that's right but you'll have someone confirm the exact details, ` +
      `rather than stating it outright. This near-miss has been logged for the business to review.`
    );
  }

  let out = `Answer from this business's own knowledge base — "${best.title}": ${primary}`;

  if (rest.length > 0) {
    const extras = rest
      .slice(0, 2)
      .map((h) => `"${h.title}": ${(h.summary || h.body).trim().slice(0, 240)}`)
      .join(" ");
    out += ` Related, only if the caller asks: ${extras}`;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The Vapi tool
// ---------------------------------------------------------------------------

/**
 * `search_knowledge` tool handler for supabase/functions/vapi-webhook.
 *
 * Audience is hard-coded to "ai": articles a business marks 'team' (cost
 * floors, vendor pricing, "never promise same-day in August") are excluded
 * at the SQL level, so an internal note cannot be read out to a caller
 * even if it is the best semantic match.
 */
export async function toolSearchKnowledge(
  admin: SupabaseClient,
  tenant: { userId: string },
  args: Record<string, unknown>,
  callRowId: string | null = null,
): Promise<string> {
  const question =
    typeof args.question === "string" ? args.question :
    typeof args.query === "string" ? args.query :
    typeof args.topic === "string" ? args.topic : "";

  if (!question.trim()) {
    return "I need the caller's actual question before I can look it up.";
  }

  const result = await searchKnowledge(admin, tenant.userId, question, { audience: "ai", limit: 3 });
  const classification = classifyEpistemicBoundary(result, result.semantic);
  await recordEpistemicBoundary(admin, tenant.userId, question, classification, "voice", callRowId);

  return formatKnowledgeForVoice(result, question.trim(), classification.tier);
}
