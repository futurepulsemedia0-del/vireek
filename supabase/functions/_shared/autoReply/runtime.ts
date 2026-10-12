// supabase/functions/_shared/autoReply/runtime.ts
//
// Real implementations of the engine's dependencies (Supabase, knowledge
// search, AI router, SMS/email delivery). Reuses — does not duplicate:
//   * knowledge-search's engine  → _shared/knowledge/search.ts + epistemicBoundary
//   * sms-webhook's compliance   → sendCompliantSms (A2P + STOP gates)
//   * ai-core                    → routeChat + guardrails (provider fallback chain)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { searchKnowledge } from "../knowledge/search.ts";
import { classifyEpistemicBoundary, recordEpistemicBoundary } from "../ai-core/epistemicBoundary.ts";
import { routeChat } from "../ai-core/router.ts";
import { runInputGuardrails, runOutputGuardrails } from "../ai-core/guardrails.ts";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import { parseModelOutput, sanitizeKeywords, type Channel } from "./decision.ts";
import {
  processInboundAutoReply,
  type AutoReplyDeps,
  type AutoReplyStore,
  type DeliverResult,
  type EngineSettings,
  type InboundInput,
} from "./engine.ts";

const TASK = "inbound_auto_reply" as const;

const TABLES = {
  sms: { conv: "sms_conversations", msg: "sms_messages", body: "body" },
  email: { conv: "email_conversations", msg: "email_messages", body: "body_text" },
} as const;

function mapSettings(r: Record<string, unknown>): EngineSettings {
  return {
    smsEnabled: r.sms_enabled === true,
    emailEnabled: r.email_enabled === true,
    mode: r.mode === "auto" ? "auto" : "approval",
    confidenceThreshold: Number(r.confidence_threshold ?? 0.8),
    escalationKeywords: sanitizeKeywords((r.escalation_keywords as string[]) ?? []),
    useDefaultKeywords: r.use_default_keywords !== false,
    scope: r.scope === "after_hours_only" ? "after_hours_only" : "always",
    timezone: String(r.timezone ?? "America/New_York"),
    shareBookingLink: r.share_booking_link !== false,
    sendEscalationAck: r.send_escalation_ack !== false,
    escalationAckMessage: (r.escalation_ack_message as string | null) ?? null,
    signature: (r.signature as string | null) ?? null,
    extraInstructions: (r.extra_instructions as string | null) ?? null,
    maxAutoRepliesPerDay: Number(r.max_auto_replies_per_day ?? 4),
    humanTakeoverMinutes: Number(r.human_takeover_minutes ?? 120),
  };
}

function createStore(admin: SupabaseClient): AutoReplyStore {
  return {
    async claim(i) {
      const { data, error } = await admin
        .from("auto_reply_log")
        .upsert(
          { user_id: i.userId, channel: i.channel, conversation_id: i.conversationId, inbound_message_id: i.inboundMessageId, status: "processing" },
          { onConflict: "channel,inbound_message_id", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw new Error(error.message);
      return data?.[0]?.id ?? null;
    },

    async getSettings(userId) {
      const { data } = await admin.from("auto_reply_settings").select("*").eq("user_id", userId).maybeSingle();
      return data ? mapSettings(data) : null;
    },

    async getConversationState(channel, conversationId) {
      const t = TABLES[channel];
      const { data: conv } = await admin.from(t.conv).select("ai_paused").eq("id", conversationId).maybeSingle();
      if (!conv) return null;
      const { count } = await admin
        .from(t.msg).select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId).eq("direction", "outbound").in("sent_by", ["ai", "ai_approved"]);
      const { data: human } = await admin
        .from(t.msg).select("created_at")
        .eq("conversation_id", conversationId).eq("direction", "outbound").eq("sent_by", "human")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      return { aiPaused: conv.ai_paused === true, priorAiMessages: count ?? 0, lastHumanReplyAt: human?.created_at ?? null };
    },

    async countRecentReplies(userId, channel, conversationId, sinceIso) {
      const { count } = await admin
        .from("auto_reply_log").select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("channel", channel).eq("conversation_id", conversationId)
        .in("status", ["sent", "pending_approval"]).gte("created_at", sinceIso);
      return count ?? 0;
    },

    async hasRecentEscalationAck(userId, channel, conversationId, sinceIso) {
      const { count } = await admin
        .from("auto_reply_log").select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("channel", channel).eq("conversation_id", conversationId)
        .eq("status", "escalated").not("outbound_message_id", "is", null).gte("created_at", sinceIso);
      return (count ?? 0) > 0;
    },

    async getBusiness(userId) {
      const [{ data: profile }, { data: bp }] = await Promise.all([
        admin.from("profiles").select("company_name").eq("id", userId).maybeSingle(),
        admin.from("business_profile")
          .select("services_offered, business_hours, holidays, booking_slug, booking_enabled, booking_default_duration_minutes, booking_lead_time_hours, booking_window_days")
          .eq("user_id", userId).maybeSingle(),
      ]);
      const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
      const canBook = bp?.booking_enabled === true && !!bp?.booking_slug && !!siteUrl;
      return {
        name: profile?.company_name || "our team",
        services: Array.isArray(bp?.services_offered) ? (bp!.services_offered as string[]) : [],
        hours: (bp?.business_hours as never) ?? null,
        holidays: (bp?.holidays as never) ?? null,
        bookingUrl: canBook ? `${siteUrl}/book/${bp!.booking_slug}` : null,
        bookingRules: canBook
          ? {
              leadTimeHours: bp!.booking_lead_time_hours ?? 2,
              windowDays: bp!.booking_window_days ?? 14,
              durationMinutes: bp!.booking_default_duration_minutes ?? 60,
            }
          : null,
      };
    },

    async getRecentMessages(channel, conversationId, limit, excludeMessageId) {
      const t = TABLES[channel];
      const { data } = await admin
        .from(t.msg).select(`id, direction, ${t.body}`)
        .eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(limit + 1);
      return (data ?? [])
        .filter((r: Record<string, unknown>) => r.id !== excludeMessageId)
        .slice(0, limit)
        .reverse()
        .map((r: Record<string, unknown>) => ({
          direction: r.direction === "outbound" ? ("outbound" as const) : ("inbound" as const),
          body: String(r[t.body] ?? ""),
        }));
    },

    async markNeedsHuman(channel, conversationId) {
      await admin.from(TABLES[channel].conv).update({ needs_human: true, unread: true }).eq("id", conversationId);
    },

    async finish(logId, p) {
      const { error } = await admin.from("auto_reply_log").update({
        status: p.status,
        reason: p.reason,
        matched_keyword: p.matchedKeyword ?? null,
        confidence: p.confidence ?? null,
        epistemic_tier: p.epistemicTier ?? null,
        kb_article_ids: p.articleIds ?? [],
        draft_body: p.draftBody ?? null,
        final_body: p.finalBody ?? null,
        provider: p.provider ?? null,
        model: p.model ?? null,
        latency_ms: p.latencyMs ?? null,
        outbound_message_id: p.outboundMessageId ?? null,
        resolved_at: p.status === "pending_approval" ? null : new Date().toISOString(),
      }).eq("id", logId);
      if (error) throw new Error(error.message);
    },
  };
}

// ---------------------------------------------------------------------------
// Delivery — shared by the engine (auto) and auto-reply-review (approved drafts)
// ---------------------------------------------------------------------------

export async function deliverReply(
  admin: SupabaseClient,
  req: { userId: string; channel: Channel; conversationId: string; body: string; sentBy: "ai" | "ai_approved" },
): Promise<DeliverResult> {
  const body = req.body.trim();
  if (!body) return { ok: false, reason: "EMPTY" };
  const now = new Date().toISOString();

  if (req.channel === "sms") {
    const { data: conv } = await admin.from("sms_conversations").select("customer_phone").eq("id", req.conversationId).eq("user_id", req.userId).maybeSingle();
    if (!conv) return { ok: false, reason: "NOT_FOUND" };
    const res = await sendCompliantSms(admin, req.userId, conv.customer_phone, body);
    if (!res.ok) return { ok: false, reason: res.reason };
    const { data: msg, error } = await admin.from("sms_messages")
      .insert({ conversation_id: req.conversationId, direction: "outbound", body, provider_sid: res.sid, sent_by: req.sentBy })
      .select("id").single();
    if (error || !msg) return { ok: false, reason: "LOG_FAILED" }; // message WAS sent; surfaced so a human checks
    await admin.from("sms_conversations").update({ last_message_at: now }).eq("id", req.conversationId);
    return { ok: true, messageId: msg.id };
  }

  const { data: conv } = await admin.from("email_conversations").select("customer_email, subject").eq("id", req.conversationId).eq("user_id", req.userId).maybeSingle();
  if (!conv) return { ok: false, reason: "NOT_FOUND" };
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { ok: false, reason: "NOT_CONFIGURED" };
  const { data: profile } = await admin.from("profiles").select("company_name, inbound_email_token").eq("id", req.userId).maybeSingle();
  const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  const inboundDomain = Deno.env.get("INBOUND_EMAIL_DOMAIN");
  const replyTo = inboundDomain && profile?.inbound_email_token ? `${profile.inbound_email_token}@${inboundDomain}` : undefined;
  const bareFrom = fromAddress.includes("<") ? (fromAddress.split("<").pop() ?? "").replace(">", "") : fromAddress;
  const subject = (conv.subject ?? "Your message").replace(/^(re:\s*)+/i, "");
  const finalSubject = `Re: ${subject}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: profile?.company_name ? `${profile.company_name} <${bareFrom}>` : fromAddress,
      to: [conv.customer_email],
      reply_to: replyTo,
      subject: finalSubject,
      text: body,
      headers: { "Auto-Submitted": "auto-replied" }, // stops mail loops with other auto-responders
    }),
  });
  if (!res.ok) return { ok: false, reason: "PROVIDER_ERROR" };
  const { data: msg, error } = await admin.from("email_messages")
    .insert({ conversation_id: req.conversationId, direction: "outbound", subject: finalSubject, body_text: body, sent_by: req.sentBy })
    .select("id").single();
  if (error || !msg) return { ok: false, reason: "LOG_FAILED" };
  await admin.from("email_conversations").update({ last_message_at: now }).eq("id", req.conversationId);
  return { ok: true, messageId: msg.id };
}

// ---------------------------------------------------------------------------

function createDeps(admin: SupabaseClient): AutoReplyDeps {
  return {
    store: createStore(admin),

    async searchKnowledge(userId, question, channel) {
      // audience "ai": articles marked 'team' (internal notes) can never be quoted to a customer.
      const result = await searchKnowledge(admin, userId, question, { audience: "ai", limit: 3 });
      const classification = classifyEpistemicBoundary(result, result.semantic);
      // knowledge_gaps.source has no 'email' value → email gaps are filed under 'chat'.
      await recordEpistemicBoundary(admin, userId, question, classification, channel === "sms" ? "sms" : "chat", null);
      return {
        tier: classification.tier,
        articleIds: result.hits.map((h) => h.id),
        contextText: result.hits.map((h) => `• ${h.title}: ${(h.summary || h.body).trim().slice(0, 700)}`).join("\n"),
        groundingText: result.hits.map((h) => `${h.title} ${h.summary} ${h.body}`).join(" "),
      };
    },

    async generate({ system, user }) {
      const ctx = { task: TASK as never };
      try {
        const messages = runInputGuardrails([{ role: "user", content: user }], ctx);
        const res = await routeChat(TASK as never, { system, messages, maxTokens: 600, temperature: 0.2, jsonMode: true, timeoutMs: 20000 });
        const output = parseModelOutput(res.response.text);
        // Only the identity-leak verdict is used: the redacted text is NOT, so business phone numbers stay intact.
        const blocked = output ? runOutputGuardrails(output.reply, ctx).blocked : false;
        return { output, outputBlocked: blocked, provider: res.response.provider, model: res.response.model, latencyMs: res.response.latencyMs };
      } catch (error) {
        console.error(JSON.stringify({ event: "auto_reply_generate_failed", error: error instanceof Error ? error.message : String(error) }));
        return { output: null, outputBlocked: false, provider: null, model: null, latencyMs: null };
      }
    },

    deliver: (req) => deliverReply(admin, req),

    async notifyOwner(userId, n) {
      await admin.from("notifications").insert({ user_id: userId, type: "ai_auto_reply", title: n.title, message: n.message, action_url: "/dashboard/inbox" });
    },

    now: () => new Date(),
    log: (event, data) => console.error(JSON.stringify({ event, ...data })),
  };
}

/**
 * Fire-and-forget entry point for webhooks. Responds to the provider
 * immediately; the AI work continues in the background (EdgeRuntime.waitUntil).
 * Never throws.
 */
export async function runAutoReplyInBackground(admin: SupabaseClient, input: InboundInput): Promise<void> {
  const work = processInboundAutoReply(createDeps(admin), input).then(
    (r) => console.log(JSON.stringify({ event: "auto_reply_result", channel: input.channel, status: r.status, reason: r.reason })),
    (e) => console.error(JSON.stringify({ event: "auto_reply_unhandled", error: e instanceof Error ? e.message : String(e) })),
  );
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(work);
    return;
  }
  await work; // local / non-Supabase runtime
}
