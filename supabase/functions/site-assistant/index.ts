// supabase/functions/site-assistant/index.ts
//
// Public, unauthenticated endpoint powering the site-wide "Ask Vireek"
// help widget (every marketing page, not just the /pricing or homepage
// "Talk to Sarah" demo). Routed through the Vireek AI Core with task
// "general": no receptionist roleplay, just a real answer about the
// product — grounded in supabase/functions/_shared/ai-core/knowledge.ts
// — with the same Gemini -> Groq -> Cerebras -> Cloudflare -> OpenRouter
// automatic fallback as every other AI feature on the site.
//
// Deliberately its own function + its own rate-limit table
// (site_assistant_rate_limit) rather than reusing demo-chat: that
// endpoint is purpose-built for the "Sarah" receptionist roleplay and
// throttled separately on purpose, so a burst of real product questions
// never eats into (or gets eaten by) someone testing the phone demo.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi, safeFallbackMessage } from "../_shared/ai-core/index.ts";
import type { ChatMessage } from "../_shared/ai-core/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_REQUESTS_PER_HOUR = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_TURNS = 6;

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("cf-connecting-ip") ??
      "unknown";
    const ipHash = await hashIp(ip);

    const { data: existing } = await supabase
      .from("site_assistant_rate_limit")
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
            "You've hit the question limit for now — please try again in a bit, or reach out through the Contact page.",
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await supabase.from("site_assistant_rate_limit").upsert({
      ip_hash: ipHash,
      window_start: windowExpired ? new Date(now).toISOString() : existing?.window_start ?? new Date(now).toISOString(),
      request_count: currentCount + 1,
    });

    const trimmedHistory: ChatMessage[] = history.slice(-MAX_HISTORY_TURNS * 2).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, MAX_MESSAGE_LENGTH),
    }));

    try {
      const result = await askVireekAi({
        task: "general",
        messages: [...trimmedHistory, { role: "user", content: message }],
        maxTokens: 320,
        extraInstructions:
          "You are the 'Ask Vireek' help widget shown on every public marketing page — a visitor may be stuck, confused, or just curious, about anything from pricing to how a specific feature works to which page covers a topic. Answer directly and completely using the reference knowledge below when relevant. Keep replies conversational (short paragraphs or a tight list, not a wall of text). If something genuinely isn't covered in your reference knowledge (an exact number, a legal specifics, account-specific detail), say so plainly and point them to the right page (Pricing, Contact, Help Center) rather than guessing.",
      });

      console.log(
        `[site-assistant] provider=${result.meta.provider} model=${result.meta.model} ` +
          `latencyMs=${result.meta.latencyMs} fallback=${result.meta.wasFallback} ` +
          `attempts=${JSON.stringify(result.meta.attempts)}`,
      );

      return new Response(JSON.stringify({ reply: result.text || "Sorry, could you rephrase that?" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[site-assistant] AI Core error (all providers failed):", err);
      return new Response(JSON.stringify({ error: safeFallbackMessage(err) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (err) {
    console.error("site-assistant error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
