// supabase/functions/knowledge-embed/index.ts
//
// Re-embeds knowledge articles whose content changed.
//
// `knowledge_articles.embedding_stale` is flipped to true by a database
// trigger on every content edit, so this job never has to diff anything —
// it just drains the stale queue in batches.
//
// Two ways to run it:
//   1. From the dashboard right after a save (POST { user_id }), so the
//      author sees semantic search working on their new article within a
//      second or two.
//   2. On a schedule for everything else (POST {} with the service-role
//      key, or a pg_cron job hitting this URL), which catches bulk imports
//      and anything that failed the first time.
//
// Without COHERE_API_KEY it exits cleanly with skipped: true. Search still
// works — it falls back to lexical-only — so a missing key degrades
// quality, never availability.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  embedTexts,
  embeddingModelName,
  embeddingProviderConfigured,
} from "../_shared/knowledge/search.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Cohere's batch ceiling is 96; 32 keeps each request comfortably inside
 *  the edge function's CPU/time budget even with long article bodies. */
const BATCH_SIZE = 32;
const MAX_BATCHES_PER_RUN = 8;

/** What actually gets embedded. Title and keywords are repeated because
 *  they carry the most retrieval signal, and the body is capped so one
 *  enormous article can't dominate its own vector. */
function buildEmbeddingInput(article: {
  title: string;
  summary: string;
  body: string;
  keywords: string[] | null;
  category: string | null;
}): string {
  const keywords = (article.keywords ?? []).join(", ");
  return [
    article.title,
    article.category ?? "",
    keywords,
    article.summary,
    article.body.slice(0, 4000),
  ]
    .filter(Boolean)
    .join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Server is not configured." }, 500);
  }

  if (!embeddingProviderConfigured()) {
    // Not an error: lexical search covers the gap.
    return json({ skipped: true, reason: "no_embedding_provider", embedded: 0 });
  }

  let body: { user_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const model = embeddingModelName();

  let embedded = 0;
  let failed = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    let query = admin
      .from("knowledge_articles")
      .select("id, title, summary, body, keywords, category")
      .eq("embedding_stale", true)
      .neq("status", "archived")
      .order("updated_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (body.user_id) query = query.eq("user_id", body.user_id);

    const { data: articles, error } = await query;

    if (error) {
      console.error(JSON.stringify({ event: "knowledge_embed_fetch_failed", error: error.message }));
      return json({ error: "Could not read the queue." }, 500);
    }
    if (!articles || articles.length === 0) break;

    const vectors = await embedTexts(articles.map(buildEmbeddingInput), "search_document", 20_000);

    if (!vectors) {
      // Provider is down or rate-limiting. Leave the rows stale so the next
      // run retries them; do not write half a batch.
      failed += articles.length;
      break;
    }

    const results = await Promise.all(
      articles.map((article, i) =>
        admin
          .from("knowledge_articles")
          .update({
            embedding: vectors[i],
            embedding_model: model,
            embedded_at: new Date().toISOString(),
            embedding_stale: false,
          })
          .eq("id", article.id),
      ),
    );

    for (const r of results) {
      if (r.error) failed++;
      else embedded++;
    }

    if (articles.length < BATCH_SIZE) break;
  }

  console.log(JSON.stringify({ event: "knowledge_embed_done", embedded, failed, model }));
  return json({ embedded, failed, model });
});
