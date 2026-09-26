import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  formatKnowledgeForVoice,
  searchKnowledge,
} from "../_shared/knowledge/search.ts";
import { classifyEpistemicBoundary, recordEpistemicBoundary } from "../_shared/ai-core/epistemicBoundary.ts";
import { searchBrandKnowledge } from "../_shared/ai-core/ragKnowledge.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_QUERY_LENGTH = 300;
const MAX_MATCH_COUNT = 10;
const DEFAULT_MATCH_COUNT = 6;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => null);

    if (
      body &&
      typeof body.query === "string" &&
      body.query.trim().length > 0
    ) {
      const query = body.query.trim();

      const requestedCount =
        typeof body.matchCount === "number"
          ? body.matchCount
          : DEFAULT_MATCH_COUNT;

      const matchCount = Math.min(
        Math.max(1, requestedCount),
        MAX_MATCH_COUNT,
      );

      if (query.length > MAX_QUERY_LENGTH) {
        return json(
          {
            error: `query is too long (max ${MAX_QUERY_LENGTH} characters).`,
          },
          400,
        );
      }

      const matches = await searchBrandKnowledge(query, matchCount);

      return json({ matches });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    if (!supabaseUrl || !anonKey) {
      return json({ error: "Server is not configured." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    let question = "";
    const audience =
      body?.audience === "customer" || body?.audience === "team"
        ? body.audience
        : "ai";

    question = typeof body?.question === "string"
      ? body.question.trim()
      : "";

    if (!question) {
      return json({ error: "A question is required." }, 400);
    }

    if (question.length > 500) {
      return json({ error: "That question is too long." }, 400);
    }

    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } =
      await client.auth.getUser();

    if (userError || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { data: ownerId, error: ownerError } =
      await client.rpc("get_account_owner_id");

    if (ownerError || !ownerId) {
      return json({ error: "Could not resolve the account." }, 403);
    }

    const result = await searchKnowledge(
      client,
      ownerId as string,
      question,
      {
        audience: audience as "ai" | "customer" | "team",
        limit: 3,
        touch: false,
      },
    );

    const classification = classifyEpistemicBoundary(result, result.semantic);
    if (body?.record_gap === true) {
      await recordEpistemicBoundary(client, ownerId as string, question, classification, "dashboard", null);
    }

    return json({
      answer: formatKnowledgeForVoice(result, question, classification.tier),
      hits: result.hits,
      semantic: result.semantic,
      epistemicTier: classification.tier,
    });
  } catch (err) {
    console.error("knowledge-search error:", err);
    return json(
      { error: "Something went wrong. Please try again." },
      500,
    );
  }
});
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  formatKnowledgeForVoice,
  searchKnowledge,
} from "../_shared/knowledge/search.ts";
import { classifyEpistemicBoundary, recordEpistemicBoundary } from "../_shared/ai-core/epistemicBoundary.ts";
import { searchBrandKnowledge } from "../_shared/ai-core/ragKnowledge.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_QUERY_LENGTH = 300;
const MAX_MATCH_COUNT = 10;
const DEFAULT_MATCH_COUNT = 6;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => null);

    if (
      body &&
      typeof body.query === "string" &&
      body.query.trim().length > 0
    ) {
      const query = body.query.trim();

      const requestedCount =
        typeof body.matchCount === "number"
          ? body.matchCount
          : DEFAULT_MATCH_COUNT;

      const matchCount = Math.min(
        Math.max(1, requestedCount),
        MAX_MATCH_COUNT,
      );

      if (query.length > MAX_QUERY_LENGTH) {
        return json(
          {
            error: `query is too long (max ${MAX_QUERY_LENGTH} characters).`,
          },
          400,
        );
      }

      const matches = await searchBrandKnowledge(query, matchCount);

      return json({ matches });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    if (!supabaseUrl || !anonKey) {
      return json({ error: "Server is not configured." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    let question = "";
    const audience =
      body?.audience === "customer" || body?.audience === "team"
        ? body.audience
        : "ai";

    question = typeof body?.question === "string"
      ? body.question.trim()
      : "";

    if (!question) {
      return json({ error: "A question is required." }, 400);
    }

    if (question.length > 500) {
      return json({ error: "That question is too long." }, 400);
    }

    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } =
      await client.auth.getUser();

    if (userError || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { data: ownerId, error: ownerError } =
      await client.rpc("get_account_owner_id");

    if (ownerError || !ownerId) {
      return json({ error: "Could not resolve the account." }, 403);
    }

    const result = await searchKnowledge(
      client,
      ownerId as string,
      question,
      {
        audience: audience as "ai" | "customer" | "team",
        limit: 3,
        touch: false,
      },
    );

    const classification = classifyEpistemicBoundary(result, result.semantic);
    if (body?.record_gap === true) {
      await recordEpistemicBoundary(client, ownerId as string, question, classification, "dashboard", null);
    }

    return json({
      answer: formatKnowledgeForVoice(result, question, classification.tier),
      hits: result.hits,
      semantic: result.semantic,
      epistemicTier: classification.tier,
    });
  } catch (err) {
    console.error("knowledge-search error:", err);
    return json(
      { error: "Something went wrong. Please try again." },
      500,
    );
  }
});
