// supabase/functions/_shared/lead-marketplace/runtime.ts
//
// Production wiring for ingest.ts (Deno only — not unit-tested; all logic that
// matters lives in the pure modules). Mirrors existing conventions:
//   SMS   -> sendCompliantSms (A2P gate + STOP suppression, same as every text)
//   Email -> Resend, same env vars and reply-to alias as email-send
//   AI    -> askVireekAi (task "general" + strict extraInstructions; output is
//            validated by validateAiSms and falls back to the template)

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import type {
  EventPatch, EventRow, IngestStore, NewEvent, NewFailedEvent, NewLead, Responders, SendResult, SourceRow, TenantInfo,
} from "./types.ts";
import type { IngestDeps } from "./ingest.ts";

const SOURCE_COLS = "id,user_id,provider,enabled,auto_respond_enabled,default_cost_cents,booking_url,timezone,sms_quiet_hours";
const EVENT_COLS = "id,user_id,provider,lead_id,status,auto_respond_status,attempt_count,received_at,parsed";

export function createStore(admin: SupabaseClient): IngestStore {
  return {
    async getSourceByToken(token) {
      const { data } = await admin.from("lead_marketplace_sources").select(SOURCE_COLS).eq("webhook_token", token).eq("enabled", true).maybeSingle();
      return (data as SourceRow | null) ?? null;
    },
    async getSource(userId, provider) {
      const { data } = await admin.from("lead_marketplace_sources").select(SOURCE_COLS).eq("user_id", userId).eq("provider", provider).maybeSingle();
      return (data as SourceRow | null) ?? null;
    },
    async getTenant(userId): Promise<TenantInfo> {
      const { data } = await admin.from("profiles").select("company_name, inbound_email_token").eq("id", userId).maybeSingle();
      const domain = Deno.env.get("INBOUND_EMAIL_DOMAIN");
      return {
        companyName: (data?.company_name as string | null) ?? null,
        replyToAlias: domain && data?.inbound_email_token ? `${data.inbound_email_token}@${domain}` : null,
      };
    },
    async insertEvent(row: NewEvent) {
      const { data, error } = await admin.from("lead_marketplace_events").insert(row).select(EVENT_COLS).single();
      if (!error && data) return { created: true, event: data as EventRow };
      if (error?.code === "23505" && row.dedupe_key) {
        const { data: existing } = await admin
          .from("lead_marketplace_events").select(EVENT_COLS).eq("user_id", row.user_id).eq("dedupe_key", row.dedupe_key).single();
        if (existing) return { created: false, event: existing as EventRow };
      }
      throw new Error(`insert_event_failed: ${error?.message ?? "unknown"}`);
    },
    async insertFailedEvent(row: NewFailedEvent) {
      await admin.from("lead_marketplace_events").insert({ ...row, status: "parse_failed", auto_respond_status: "not_applicable" });
    },
    async updateEvent(id: string, patch: EventPatch) {
      const { error } = await admin.from("lead_marketplace_events").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    async claimEvent(id: string, expected: number) {
      const { data } = await admin
        .from("lead_marketplace_events").update({ attempt_count: expected + 1 }).eq("id", id).eq("attempt_count", expected).select("id");
      return Boolean(data && data.length);
    },
    async insertLead(row: NewLead) {
      const { data, error } = await admin.from("leads").insert(row).select("id").single();
      if (error || !data) throw new Error(`insert_lead_failed: ${error?.message ?? "unknown"}`);
      return data.id as string;
    },
    async markLeadResponded(leadId: string, atIso: string) {
      await admin.from("leads").update({ first_response_at: atIso }).eq("id", leadId).is("first_response_at", null);
    },
    async listRetryable(nowMs: number, limit: number) {
      const olderThan = new Date(nowMs - 90_000).toISOString();
      const since = new Date(nowMs - 24 * 3600_000).toISOString();
      const { data } = await admin
        .from("lead_marketplace_events")
        .select(EVENT_COLS)
        .eq("status", "lead_created")
        .gte("received_at", since)
        .lt("attempt_count", 3)
        .or(`auto_respond_status.in.(failed,deferred_quiet_hours),and(auto_respond_status.eq.pending,received_at.lt.${olderThan})`)
        .order("received_at", { ascending: true })
        .limit(limit);
      return (data as EventRow[] | null) ?? [];
    },
    async purgeRawPayloads(olderThanIso: string) {
      await admin.from("lead_marketplace_events").update({ raw_payload: null }).lt("received_at", olderThanIso).not("raw_payload", "is", null);
    },
  };
}

async function sendResendEmail(admin: SupabaseClient, a: Parameters<Responders["sendEmail"]>[0]): Promise<SendResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { ok: false, reason: "NOT_CONFIGURED", detail: "RESEND_API_KEY missing" };
  const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  const bareFrom = fromAddress.includes("<") ? fromAddress.split("<").pop()!.replace(">", "") : fromAddress;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: a.fromName ? `${a.fromName.replace(/[<>"]/g, "")} <${bareFrom}>` : fromAddress,
      to: [a.to],
      reply_to: a.replyTo ?? undefined,
      subject: a.subject,
      text: a.text,
    }),
  });
  if (!res.ok) return { ok: false, reason: "PROVIDER_ERROR", detail: (await res.text()).slice(0, 200) };

  // Best effort: thread the outbound auto-reply into the Unified Inbox so the
  // customer's reply lands in the same conversation. Never blocks/affects the send.
  try {
    const { data: conv } = await admin
      .from("email_conversations")
      .upsert({ user_id: a.userId, customer_email: a.to, subject: a.subject, last_message_at: new Date().toISOString() }, { onConflict: "user_id,customer_email" })
      .select("id").single();
    if (conv) await admin.from("email_messages").insert({ conversation_id: conv.id, direction: "outbound", subject: a.subject, body_text: a.text });
  } catch { /* inbox logging is optional */ }
  return { ok: true };
}

export function createResponders(admin: SupabaseClient): Responders {
  return {
    async sendSms(userId, to, body) {
      const r = await sendCompliantSms(admin, userId, to, body);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, detail: r.detail };
    },
    sendEmail: (a) => sendResendEmail(admin, a),
    async composeAiSms({ extraInstructions, userContent, timeoutMs }) {
      const { askVireekAi } = await import("../ai-core/index.ts");
      const result = await askVireekAi({
        task: "general",
        messages: [{ role: "user", content: userContent }],
        maxTokens: 160,
        temperature: 0.4,
        timeoutMs,
        extraInstructions,
      });
      return result.text;
    },
    now: () => Date.now(),
  };
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export function createDeps(admin: SupabaseClient): IngestDeps {
  return {
    store: createStore(admin),
    responders: createResponders(admin),
    schedule: (work) => {
      const guarded = work.catch((e) => console.error(JSON.stringify({ event: "lead_marketplace_respond_failed", error: String(e) })));
      try {
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(guarded);
      } catch { /* fire-and-forget fallback */ }
    },
  };
}
