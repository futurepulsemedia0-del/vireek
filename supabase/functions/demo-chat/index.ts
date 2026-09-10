// supabase/functions/demo-chat/index.ts
//
// Public, unauthenticated endpoint powering the "Talk to Sarah" widget on
// the marketing site. Now routed through the Vireek AI Core instead of
// calling Anthropic directly — provider selection, fallback, and identity
// are fully centralized. Rate limiting, CORS, and validation are UNCHANGED
// from the original implementation.
//
// Required secrets (set at least one provider's key):
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase secrets set GEMINI_API_KEY=...
//   supabase secrets set GROQ_API_KEY=...
//   (see _shared/ai-core/registry.ts for the full demo_chat fallback chain)
//
// Deploy:
//   supabase functions deploy demo-chat

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi, safeFallbackMessage } from "../_shared/ai-core/index.ts";
import type { ChatMessage } from "../_shared/ai-core/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_REQUESTS_PER_HOUR = 20;
const MAX_MESSAGE_LENGTH = 400;
const MAX_HISTORY_TURNS = 6;

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const history: ChatMessage[] = Array.isArray(body?.history) ? body.history : [];

    if (!message) {
      return new Response(JSON.stringify({ error: "Message is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // --- Rate limiting (per IP, 1-hour sliding window) — unchanged ---------
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("cf-connecting-ip") ??
      "unknown";
    const ipHash = await hashIp(ip);

    const { data: existing } = await supabase
      .from("demo_chat_rate_limit")
      .select("window_start, request_count")
      .eq("ip_hash", ipHash)
      .maybeSingle();

    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const windowStart = existing ? new Date(existing.window_start).getTime() : now;
    const windowExpired = now - windowStart > windowMs;
    const currentCount = windowExpired ? 0 : existing?.request_count ?? 0;

    if (currentCount >= MAX_REQUESTS_PER_HOUR) {
      return new Response(
        JSON.stringify({
          error:
            "You've hit the demo message limit for now — please try again in a bit, or start your free trial to keep chatting with the real thing.",
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await supabase.from("demo_chat_rate_limit").upsert({
      ip_hash: ipHash,
      window_start: windowExpired ? new Date(now).toISOString() : existing?.window_start ?? new Date(now).toISOString(),
      request_count: currentCount + 1,
    });

    // --- Build bounded conversation and route through the AI Core ----------
    const trimmedHistory: ChatMessage[] = history.slice(-MAX_HISTORY_TURNS * 2).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, MAX_MESSAGE_LENGTH),
    }));

    try {
      const result = await askVireekAi({
        task: "demo_chat",
        messages: [...trimmedHistory, { role: "user", content: message }],
        maxTokens: 220,
        useFullKnowledgeBrief: true,
      });

      // Observability only — no user content, no secrets. Safe to leave on.
      console.log(
        `[demo-chat] provider=${result.meta.provider} model=${result.meta.model} ` +
          `latencyMs=${result.meta.latencyMs} fallback=${result.meta.wasFallback}`,
      );

      return new Response(JSON.stringify({ reply: result.text || "Sorry, could you say that again?" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[demo-chat] AI Core error:", err);
      return new Response(JSON.stringify({ error: safeFallbackMessage(err) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    console.error("demo-chat error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
