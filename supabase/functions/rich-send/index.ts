// Sends from the Unified Communications Inbox's RCS / Apple Messages pane, and sends rich
// cards (booking confirmation, technician ETA, pay-now, reschedule) on behalf of a signed-in user.
//
// Every send goes through sendRich(): consent (STOP/DNC) -> per-recipient capability routing ->
// quiet hours -> aggregator, with automatic SMS fallback through sendCompliantSms()
// (A2P + opt-out + quiet-hours). Nothing here can bypass those gates.
//
// POST (Authorization: Bearer <user JWT>)
//   { conversationId, text }                       reply inside an RCS / Apple thread
//   { conversationId?, to?, card: { template, ... } }   rich card (to = E.164 when there is no thread yet)
//   optional: overrideReason (quiet-hours manual override, audited), dedupeKey
//
// Server-side flows (cron workers, webhooks) import sendRich()/buildCard() directly instead of calling this.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { normalizePhone } from "../_shared/compliance/dncCheck.ts";
import { buildCard, CARD_TEMPLATES, CardError, type CardTemplate } from "../_shared/richMessaging/cards.ts";
import { createRichDeps, loadBrandName, mapConversation } from "../_shared/richMessaging/runtime.ts";
import { sendRich } from "../_shared/richMessaging/send.ts";
import type { RichContent } from "../_shared/richMessaging/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  const payload = await req.json().catch(() => ({}));
  const { conversationId, to, text, card, overrideReason, dedupeKey } = payload as {
    conversationId?: string; to?: string; text?: string; card?: CardTemplate & { phone?: string }; overrideReason?: string; dedupeKey?: string;
  };

  // Resolve the recipient: an existing rich thread (owned by the caller) or a raw phone number.
  let conversation = null;
  if (conversationId) {
    const { data } = await admin.from("rich_conversations").select("*").eq("id", conversationId).eq("user_id", userId).maybeSingle();
    if (!data) return json({ error: "Conversation not found" }, 404);
    conversation = mapConversation(data);
  } else if (!to?.trim()) {
    return json({ error: "conversationId or to is required" }, 400);
  }

  const deps = createRichDeps(admin);

  let content: RichContent;
  if (card) {
    if (!(CARD_TEMPLATES as readonly string[]).includes(card.template)) return json({ error: "Unknown card template" }, 400);
    const account = await deps.loadAccount(userId);
    try {
      content = buildCard(card, {
        name: await loadBrandName(admin, userId, account),
        logoUrl: account?.brandLogoUrl ?? null,
        phone: typeof card.phone === "string" ? card.phone : null,
      });
    } catch (e) {
      if (e instanceof CardError) return json({ error: "INVALID_CARD", detail: e.message }, 400);
      throw e;
    }
  } else if (typeof text === "string" && text.trim()) {
    content = { kind: "text", text: text.trim() };
  } else {
    return json({ error: "text or card is required" }, 400);
  }

  const result = await sendRich(deps, {
    userId,
    conversation,
    phone: to ? normalizePhone(to) : null,
    content,
    purpose: "service",
    source: "rich-send",
    sentBy: "human",
    dedupeKey: typeof dedupeKey === "string" && dedupeKey ? dedupeKey.slice(0, 120) : undefined,
    override: typeof overrideReason === "string" && overrideReason.trim() ? { reason: overrideReason.trim() } : null,
  });

  if (!result.ok) return json({ error: result.reason, detail: result.detail }, 422);
  if (conversation) {
    await admin.from("rich_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversation.id);
  }
  return json({
    route: result.route,
    messageId: "messageId" in result ? result.messageId ?? null : null,
    status: "status" in result ? result.status : "sent",
    deferred: ("status" in result && result.status === "deferred") || ("deferred" in result && result.deferred === true),
    sendAt: "sendAt" in result ? result.sendAt ?? null : null,
  });
});
