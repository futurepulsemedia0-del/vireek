// supabase/functions/knowledge-search/index.ts
//
// The dashboard's "ask it something a caller would ask" harness.
//
// It runs the SAME code path the phone assistant runs — same hybrid
// search, same audience filter, same voice formatting — so what an owner
// reads here is what a caller hears. Anything less than that is a demo,
// not a test.
//
// Auth: the caller's own JWT. The search RPC is SECURITY INVOKER, so RLS
// decides which tenant's articles are visible; this function never takes a
// user_id from the request body. Query embedding happens here because it
// needs a server-side API key.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  formatKnowledgeForVoice,
  recordKnowledgeGap,
  searchKnowledge,
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !anonKey) return json({ error: "Server is not configured." }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  let body: { question?: string; audience?: string; record_gap?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const question = (body.question ?? "").trim();
  if (!question) return json({ error: "A question is required." }, 400);
  if (question.length > 500) return json({ error: "That question is too long." }, 400);

  // The user's own client: every query below runs under their RLS.
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user) return json({ error: "Unauthorized" }, 401);

  // Team members search their account owner's knowledge, not their own id.
  const { data: ownerId, error: ownerError } = await client.rpc("get_account_owner_id");
  if (ownerError || !ownerId) return json({ error: "Could not resolve the account." }, 403);

  const audience = body.audience === "customer" || body.audience === "team" ? body.audience : "ai";

  const result = await searchKnowledge(client, ownerId as string, question, {
    audience: audience as "ai" | "customer" | "team",
    limit: 3,
    touch: false,
  });

  // Off by default: a test query is not a caller asking, and logging it
  // would pollute the gap queue the owner is trying to clear.
  if (result.hits.length === 0 && body.record_gap === true) {
    await recordKnowledgeGap(client, ownerId as string, question, "dashboard", null);
  }

  return json({
    answer: formatKnowledgeForVoice(result, question),
    hits: result.hits,
    semantic: result.semantic,
  });
});
