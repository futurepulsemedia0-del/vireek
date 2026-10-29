// "Suggest reply" for the Unified Inbox (Telegram / Messenger): drafts a reply from the tenant's
// Knowledge Base for a HUMAN to review. It never sends anything.
//
// Reuses the platform's AI stack exactly like sms/email auto-replies do:
//   searchKnowledge (audience "ai": internal team-only articles can never be quoted) +
//   epistemic boundary (no coverage => holding reply, never a guess) + routeChat (provider fallback) +
//   input / output guardrails.
// Handled outcomes return HTTP 200 { ok, ... } so the UI can show the reason.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { classifyEpistemicBoundary, recordEpistemicBoundary } from "../_shared/ai-core/epistemicBoundary.ts";
import { runInputGuardrails, runOutputGuardrails } from "../_shared/ai-core/guardrails.ts";
import { routeChat } from "../_shared/ai-core/router.ts";
import { searchKnowledge } from "../_shared/knowledge/search.ts";
import type { DmChannel } from "../_shared/dmChannels/protocol.ts";
import { buildSuggestSystemPrompt, buildSuggestUserPrompt, cleanDraft, selectHistory, type HistoryRow } from "../_shared/dmChannels/suggest.ts";

const TASK = "inbound_auto_reply" as const; // same task => same provider routing / budget as auto-replies

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (code: string, message: string) => json({ ok: false, code, message });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  const { conversationId } = await req.json().catch(() => ({})) as { conversationId?: string };
  if (!conversationId) return json({ error: "conversationId is required" }, 400);

  try {
    const { data: conv } = await admin.from("dm_conversations")
      .select("id, channel, customer_name").eq("id", conversationId).eq("user_id", userId).maybeSingle();
    if (!conv) return fail("not_found", "Conversation not found.");
    if (conv.channel !== "telegram" && conv.channel !== "messenger") return fail("unsupported_channel", "Suggestions aren't available for this channel yet.");
    const channel = conv.channel as DmChannel;

    const { data: rows } = await admin.from("dm_messages")
      .select("direction, body").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(20);
    const history = selectHistory(((rows ?? []) as HistoryRow[]).reverse());
    const lastInbound = [...history].reverse().find((m) => m.direction === "inbound");
    if (!lastInbound) return fail("no_inbound", "There is no customer message to reply to yet.");

    const { data: profile } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
    const businessName = (profile?.company_name as string | null)?.trim() || "our team";

    const kb = await searchKnowledge(admin, userId, lastInbound.body, { audience: "ai", limit: 3 });
    const boundary = classifyEpistemicBoundary(kb, kb.semantic);
    await recordEpistemicBoundary(admin, userId, lastInbound.body, boundary, "chat", null);
    const grounded = boundary.tier === "confident";
    const knowledge = kb.hits.map((h) => `• ${h.title}: ${(h.summary || h.body).trim().slice(0, 700)}`).join("\n");

    const ctx = { task: TASK as never };
    const messages = runInputGuardrails([{
      role: "user",
      content: buildSuggestUserPrompt({ customerName: conv.customer_name, history, knowledge: boundary.tier === "no_coverage" ? "" : knowledge }),
    }], ctx);
    const res = await routeChat(TASK as never, {
      system: buildSuggestSystemPrompt({ businessName, channel, grounded }),
      messages, maxTokens: 400, temperature: 0.3, timeoutMs: 20000,
    });

    if (runOutputGuardrails(res.response.text, ctx).blocked) return fail("blocked", "The draft was blocked by safety checks. Please write this reply yourself.");
    const draft = cleanDraft(res.response.text, channel);
    if (!draft) return fail("empty", "The assistant could not draft a reply. Please write this one yourself.");

    return json({ ok: true, draft, grounded });
  } catch (error) {
    console.error(JSON.stringify({ event: "dm_suggest_failed", error: error instanceof Error ? error.message : String(error) }));
    return fail("failed", "The assistant is unavailable right now. Please try again.");
  }
});
