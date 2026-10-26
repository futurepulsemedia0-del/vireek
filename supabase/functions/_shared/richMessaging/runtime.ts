// supabase/functions/_shared/richMessaging/runtime.ts
//
// Real implementations of the injected dependencies (Supabase, Sinch, sendCompliantSms,
// quiet-hours gate). Reuses, does not duplicate:
//   * sendCompliantSms  -> A2P + STOP/DNC + quiet-hours gates for every SMS (incl. fallback)
//   * dnc_suppressions  -> the ONE opt-out list shared by SMS, RCS, Apple and calls
//   * gateOutbound      -> the same quiet-hours rules as SMS
//   * recordLanguageFromMessage -> same language detection sms-webhook runs
// Same split as _shared/autoReply: engine (pure, tested) + runtime (wiring, this file).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed } from "../compliance/dncCheck.ts";
import { recordLanguageFromMessage } from "../i18n/customerLanguage.ts";
import { gateOutbound } from "../messaging/quietHours.ts";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import { expiryFor } from "./capability.ts";
import type { InboundDeps } from "./inbound.ts";
import { sendRich, type MessagePatch, type NewOutbound, type PatchCondition, type RichMessageStore, type RichSendDeps } from "./send.ts";
import { SinchClient, sinchConfigFromEnv } from "./sinch.ts";
import type {
  CapabilityRecord, ProviderSendResult, RichAccount, RichChannel, RichContent, RichConversationRef, RichProvider, StoredMessage,
} from "./types.ts";

type Row = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- row mappers -----------------------------------------------------------------------

export function mapAccount(r: Row): RichAccount {
  return {
    userId: r.user_id as string,
    provider: "sinch",
    providerAppId: (r.provider_app_id as string | null) ?? null,
    providerRegion: ((r.provider_region as string) ?? "us") as RichAccount["providerRegion"],
    rcsStatus: r.rcs_status as RichAccount["rcsStatus"],
    rcsAgentId: (r.rcs_agent_id as string | null) ?? null,
    ambStatus: r.amb_status as RichAccount["ambStatus"],
    ambBusinessId: (r.amb_business_id as string | null) ?? null,
    rcsEnabled: r.rcs_enabled === true,
    ambEnabled: r.amb_enabled === true,
    brandName: (r.brand_name as string | null) ?? null,
    brandLogoUrl: (r.brand_logo_url as string | null) ?? null,
    brandColor: (r.brand_color as string | null) ?? null,
    verifiedSenderName: (r.verified_sender_name as string | null) ?? null,
    fallbackToSms: r.fallback_to_sms !== false,
    fallbackAfterSeconds: Number(r.fallback_after_seconds ?? 45),
    attemptOnUnknown: r.attempt_on_unknown !== false,
  };
}

export function mapConversation(r: Row): RichConversationRef {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    channel: r.channel as RichChannel,
    identity: r.customer_identity as string,
    phone: (r.customer_phone as string | null) ?? null,
    name: (r.customer_name as string | null) ?? null,
    optedOutAt: (r.opted_out_at as string | null) ?? null,
    customerClosedAt: (r.customer_closed_at as string | null) ?? null,
  };
}

export function mapMessage(r: Row): StoredMessage {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    conversationId: r.conversation_id as string,
    direction: r.direction as StoredMessage["direction"],
    status: r.status as StoredMessage["status"],
    fallbackState: r.fallback_state as StoredMessage["fallbackState"],
    fallbackDeadline: (r.fallback_deadline as string | null) ?? null,
    fallbackText: (r.fallback_text as string | null) ?? null,
    fallbackPhone: (r.fallback_phone as string | null) ?? null,
    purpose: r.purpose as StoredMessage["purpose"],
    customerId: (r.customer_id as string | null) ?? null,
    providerMessageId: (r.provider_message_id as string | null) ?? null,
    content: (r.content as RichContent | null) ?? null,
    scheduledFor: (r.scheduled_for as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    sentBy: (r.sent_by as StoredMessage["sentBy"]) ?? "system",
    dedupeKey: (r.dedupe_key as string | null) ?? null,
    deliveredAt: (r.delivered_at as string | null) ?? null,
    readAt: (r.read_at as string | null) ?? null,
  };
}

// ---- provider ------------------------------------------------------------------------------

const unconfigured: RichProvider = {
  send: async (): Promise<ProviderSendResult> => ({ ok: false, error: "Messaging provider credentials are not configured", code: "NOT_CONFIGURED", retryable: false }),
  queryCapability: async () => false,
};

let cachedClient: SinchClient | null = null;

export function getProvider(): RichProvider {
  if (cachedClient) return cachedClient;
  const cfg = sinchConfigFromEnv((k) => Deno.env.get(k));
  if (!cfg) return unconfigured;
  cachedClient = new SinchClient(cfg);
  return cachedClient;
}

// ---- store ----------------------------------------------------------------------------------

function createStore(admin: SupabaseClient): RichMessageStore {
  return {
    async insertOutbound(row: NewOutbound) {
      const { data, error } = await admin.from("rich_messages").insert({
        user_id: row.userId,
        conversation_id: row.conversationId,
        direction: "outbound",
        kind: row.content.kind === "card" ? "card" : "text",
        body: row.body,
        content: row.content,
        status: row.status,
        sent_by: row.sentBy,
        source: row.source,
        purpose: row.purpose,
        customer_id: row.customerId,
        dedupe_key: row.dedupeKey,
        scheduled_for: row.scheduledFor,
        fallback_state: row.fallbackState,
        fallback_deadline: row.fallbackDeadline,
        fallback_text: row.fallbackText,
        fallback_phone: row.fallbackPhone,
      }).select("id").single();

      if (error) {
        if (error.code === "23505" && row.dedupeKey) {
          const { data: existing } = await admin.from("rich_messages").select("id")
            .eq("conversation_id", row.conversationId).eq("dedupe_key", row.dedupeKey).maybeSingle();
          if (existing) return { id: existing.id as string, duplicate: true };
        }
        throw new Error(`rich_messages insert failed: ${error.message}`);
      }
      return { id: data.id as string, duplicate: false };
    },

    async get(id) {
      const { data } = await admin.from("rich_messages").select("*").eq("id", id).maybeSingle();
      return data ? mapMessage(data) : null;
    },

    async findForReceipt(correlationId, providerMessageId) {
      if (correlationId && UUID_RE.test(correlationId)) {
        const { data } = await admin.from("rich_messages").select("*").eq("id", correlationId).maybeSingle();
        if (data) return mapMessage(data);
      }
      const { data } = await admin.from("rich_messages").select("*")
        .eq("provider_message_id", providerMessageId).eq("direction", "outbound").limit(1).maybeSingle();
      return data ? mapMessage(data) : null;
    },

    async patch(id: string, p: MessagePatch, when?: PatchCondition) {
      const set: Row = {};
      if (p.status !== undefined) set.status = p.status;
      if (p.providerMessageId !== undefined) set.provider_message_id = p.providerMessageId;
      if (p.failureReason !== undefined) set.failure_reason = p.failureReason;
      if (p.fallbackState !== undefined) set.fallback_state = p.fallbackState;
      if (p.fallbackSmsSid !== undefined) set.fallback_sms_sid = p.fallbackSmsSid;
      if (p.scheduledFor !== undefined) set.scheduled_for = p.scheduledFor;
      if (p.deliveredAt !== undefined) set.delivered_at = p.deliveredAt;
      if (p.readAt !== undefined) set.read_at = p.readAt;
      if (Object.keys(set).length === 0) return false;

      let q = admin.from("rich_messages").update(set).eq("id", id);
      if (when?.status) q = q.in("status", when.status);
      if (when?.fallbackState) q = q.in("fallback_state", when.fallbackState);
      const { data, error } = await q.select("id");
      if (error) throw new Error(`rich_messages update failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
  };
}

// ---- shared helpers ---------------------------------------------------------------------------

async function ensureConversation(admin: SupabaseClient, p: {
  userId: string; channel: RichChannel; identity: string; phone: string | null; name: string | null;
}): Promise<RichConversationRef> {
  const find = () => admin.from("rich_conversations").select("*")
    .eq("user_id", p.userId).eq("channel", p.channel).eq("customer_identity", p.identity).maybeSingle();

  const { data: existing } = await find();
  if (existing) {
    await admin.from("rich_conversations").update({
      last_message_at: new Date().toISOString(),
      ...(p.phone && !existing.customer_phone ? { customer_phone: p.phone } : {}),
      ...(p.name && !existing.customer_name ? { customer_name: p.name } : {}),
    }).eq("id", existing.id);
    return mapConversation(existing);
  }
  const { data, error } = await admin.from("rich_conversations").insert({
    user_id: p.userId, channel: p.channel, customer_identity: p.identity, customer_phone: p.phone,
    customer_name: p.name, unread: false, last_message_at: new Date().toISOString(),
  }).select("*").single();
  if (error) {
    const { data: raced } = await find(); // lost an insert race on the unique key
    if (raced) return mapConversation(raced);
    throw new Error(`rich_conversations insert failed: ${error.message}`);
  }
  return mapConversation(data);
}

// ---- wiring ------------------------------------------------------------------------------------

export type RichRuntime = RichSendDeps & InboundDeps;

export function createRichDeps(admin: SupabaseClient, provider: RichProvider = getProvider()): RichRuntime {
  const deps: RichRuntime = {
    now: () => new Date(),
    provider,
    messages: createStore(admin),

    async loadAccount(userId) {
      const { data } = await admin.from("rich_messaging_accounts").select("*").eq("user_id", userId).maybeSingle();
      return data ? mapAccount(data) : null;
    },
    async resolveAccount(appId) {
      const { data } = await admin.from("rich_messaging_accounts").select("*").eq("provider_app_id", appId).maybeSingle();
      return data ? mapAccount(data) : null;
    },

    upsertConversation: (p) => ensureConversation(admin, p),
    async getConversation(id) {
      const { data } = await admin.from("rich_conversations").select("*").eq("id", id).maybeSingle();
      return data ? mapConversation(data) : null;
    },
    async findConversation(userId, channel, identity) {
      const { data } = await admin.from("rich_conversations").select("*")
        .eq("user_id", userId).eq("channel", channel).eq("customer_identity", identity).maybeSingle();
      return data ? mapConversation(data) : null;
    },
    async upsertInboundConversation(p) {
      const { data, error } = await admin.from("rich_conversations").upsert({
        user_id: p.userId, channel: p.channel, customer_identity: p.identity, customer_phone: p.phone,
        ...(p.contactId ? { provider_contact_id: p.contactId } : {}),
        ...(p.providerConversationId ? { provider_conversation_id: p.providerConversationId } : {}),
        unread: true, last_message_at: p.at, last_inbound_at: p.at, customer_closed_at: null,
      }, { onConflict: "user_id,channel,customer_identity" }).select("*").single();
      if (error || !data) throw new Error(`rich_conversations upsert failed: ${error?.message}`);
      return mapConversation(data);
    },

    async insertInbound(row) {
      const { error } = await admin.from("rich_messages").insert({
        user_id: row.userId, conversation_id: row.conversationId, direction: "inbound", kind: row.kind,
        body: row.body, content: row.content, status: "received", provider_message_id: row.providerMessageId,
        created_at: row.createdAt,
      });
      if (!error) return { duplicate: false };
      if (error.code === "23505") return { duplicate: true };
      throw new Error(`rich_messages inbound insert failed: ${error.message}`);
    },

    async getCapability(userId, channel, identity): Promise<CapabilityRecord | null> {
      const { data } = await admin.from("rich_capabilities").select("status, checked_at, expires_at")
        .eq("user_id", userId).eq("channel", channel).eq("identity", identity).maybeSingle();
      return data ? { status: data.status, checkedAt: data.checked_at, expiresAt: data.expires_at } : null;
    },
    async putCapability(userId, channel, identity, status, features) {
      const now = new Date();
      const { error } = await admin.from("rich_capabilities").upsert({
        user_id: userId, channel, identity, status, features: features ?? null,
        checked_at: now.toISOString(), expires_at: expiryFor(status, now),
      }, { onConflict: "user_id,channel,identity" });
      if (error) throw new Error(`rich_capabilities upsert failed: ${error.message}`);
    },

    isSuppressed: (userId, phone) => isDncSuppressed(admin, userId, phone),

    async gateQuietHours(userId, i) {
      const outcome = await gateOutbound(admin, userId, {
        channel: "sms", to: i.to, purpose: i.purpose, customerId: i.customerId, override: i.override, source: i.source,
      });
      return outcome.proceed ? { proceed: true } : { proceed: false, sendAt: outcome.sendAt };
    },

    async sendSms(userId, to, body, o) {
      const r = await sendCompliantSms(admin, userId, to, body, {
        purpose: o.purpose, customerId: o.customerId, source: o.source, dedupeKey: o.dedupeKey, override: o.override,
      });
      if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
      return "deferred" in r && r.deferred ? { ok: true, sid: r.sid, deferred: true, sendAt: r.sendAt } : { ok: true, sid: r.sid };
    },

    async logSmsThread(userId, phone, body, sid) {
      try {
        const { data: existing } = await admin.from("sms_conversations").select("id")
          .eq("user_id", userId).eq("customer_phone", phone).maybeSingle();
        let id = existing?.id as string | undefined;
        if (id) {
          await admin.from("sms_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", id);
        } else {
          const { data } = await admin.from("sms_conversations")
            .insert({ user_id: userId, customer_phone: phone, unread: false }).select("id").single();
          id = data?.id as string | undefined;
        }
        if (id) await admin.from("sms_messages").insert({ conversation_id: id, direction: "outbound", body, provider_sid: sid });
      } catch (e) {
        console.error(JSON.stringify({ event: "rich_sms_thread_log_failed", error: String(e) }));
      }
    },

    async recordOptOut(userId, conversationId, phone) {
      if (phone) {
        const { error } = await admin.from("dnc_suppressions")
          .upsert({ user_id: userId, phone_number: phone, reason: "customer_opt_out" }, { onConflict: "user_id,phone_number" });
        if (error) throw new Error(`dnc_suppressions upsert failed: ${error.message}`);
      }
      const { error } = await admin.from("rich_conversations").update({ opted_out_at: new Date().toISOString() }).eq("id", conversationId);
      if (error) throw new Error(`opt-out stamp failed: ${error.message}`);
    },
    async recordOptIn(userId, conversationId, phone) {
      if (phone) {
        // Only lifts the customer's own STOP; manual / national-registry suppressions stay.
        const { error } = await admin.from("dnc_suppressions").delete()
          .eq("user_id", userId).eq("phone_number", phone).eq("reason", "customer_opt_out");
        if (error) throw new Error(`dnc_suppressions delete failed: ${error.message}`);
      }
      const { error } = await admin.from("rich_conversations").update({ opted_out_at: null }).eq("id", conversationId);
      if (error) throw new Error(`opt-in stamp failed: ${error.message}`);
    },
    async markClosedByCustomer(_userId, conversationId) {
      const { error } = await admin.from("rich_conversations").update({ customer_closed_at: new Date().toISOString() }).eq("id", conversationId);
      if (error) throw new Error(`closed stamp failed: ${error.message}`);
    },

    async recordLanguage(userId, phone, text) {
      try {
        await recordLanguageFromMessage(admin, userId, { phone }, text);
      } catch (e) {
        console.error(JSON.stringify({ event: "rich_language_record_failed", error: String(e) }));
      }
    },

    async sendConsentReply(conversation, text) {
      try {
        await sendRich(deps, {
          userId: conversation.userId, conversation, phone: conversation.phone, content: { kind: "text", text },
          purpose: "service", source: "rich-consent-reply", sentBy: "system", isConsentReply: true,
        });
      } catch (e) {
        console.error(JSON.stringify({ event: "rich_consent_reply_failed", error: String(e) }));
      }
    },
  };
  return deps;
}

/** Brand shown on cards / SMS fallback: tenant brand, else company name, else a neutral default. */
export async function loadBrandName(admin: SupabaseClient, userId: string, account: RichAccount | null): Promise<string> {
  const explicit = account?.brandName?.trim() || account?.verifiedSenderName?.trim();
  if (explicit) return explicit;
  const { data } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
  return (data?.company_name as string | undefined)?.trim() || "Your service team";
}
