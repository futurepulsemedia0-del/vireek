// supabase/functions/_shared/usage-alerts/ports.ts
// Deno-only adapters (Supabase client, Resend, Twilio) behind the AlertPorts / SweepPorts interfaces.
// Reuses: notify/deliver.ts sendEmail (Resend), messaging/sendSms.ts sendCompliantSms (A2P + opt-out + quiet hours),
// and the existing notifications triggers (push + notification-router).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../notify/deliver.ts";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import type { ChannelMap } from "./core.ts";
import type { AlertPorts, SmsOutcome } from "./dispatch.ts";
import type { SweepAccount, SweepPorts } from "./sweep.ts";
import { notifyLimitReached } from "./notifyLimitReached.ts";
import type { LimitKind } from "./core.ts";

const IN_CHUNK = 100; // keeps `in.(...)` filters well under URL length limits

export function createAlertPorts(admin: SupabaseClient): AlertPorts {
  return {
    async claim(userId, periodKey, kind) {
      const { data, error } = await admin.rpc("claim_usage_alert", { p_user_id: userId, p_period_key: periodKey, p_kind: kind });
      if (error) throw new Error(`claim_failed:${error.code ?? "rpc"}`);
      const row = Array.isArray(data) ? data[0] : data;
      return row?.event_id ? { eventId: String(row.event_id), channels: (row.channels ?? {}) as ChannelMap } : null;
    },
    async saveChannels(eventId, patch, done, release) {
      const { error } = await admin.rpc("complete_usage_alert", { p_event_id: eventId, p_patch: patch, p_done: done, p_release: release });
      if (error) throw new Error(`save_failed:${error.code ?? "rpc"}`);
    },
    async hasInsight(userId, title) {
      const { data, error } = await admin.from("ai_insights").select("id").eq("user_id", userId).eq("title", title).limit(1);
      if (error) throw new Error("insight_lookup_failed");
      return (data?.length ?? 0) > 0;
    },
    async insertInsight(userId, i) {
      const { error } = await admin.from("ai_insights").insert({
        user_id: userId, insight_type: "alert", title: i.title, description: i.description, priority: i.priority,
      });
      if (error) throw new Error("insight_insert_failed");
    },
    async insertNotification(userId, n) {
      const { error } = await admin.from("notifications").insert({
        user_id: userId, type: n.type, title: n.title, message: n.message, action_url: n.actionUrl,
      });
      if (error) throw new Error("notification_insert_failed");
    },
    async sendEmail(to, mail) {
      return await sendEmail(to, mail.subject, mail.html, mail.text);
    },
    async sendSms(userId, to, body, dedupeKey): Promise<SmsOutcome> {
      const r = await sendCompliantSms(admin, userId, to, body, { purpose: "service", source: "usage-alert", dedupeKey, onQuiet: "queue" });
      if (r.ok) return r.deferred ? { status: "deferred" } : { status: "sent" };
      // Missing consent/approval or unconfigured Twilio are terminal (nothing to retry); transport errors are retried.
      if (r.reason === "A2P_NOT_APPROVED" || r.reason === "OPTED_OUT" || r.reason === "NOT_CONFIGURED") return { status: "skipped", reason: r.reason.toLowerCase() };
      return { status: "failed", reason: r.reason.toLowerCase() };
    },
    async hasActiveRoutingRules(userId) {
      const { count, error } = await admin.from("notification_routing_rules").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("is_active", true);
      if (error) throw new Error("routing_rules_lookup_failed");
      return (count ?? 0) > 0;
    },
  };
}

export function createSweepPorts(admin: SupabaseClient): SweepPorts {
  return {
    ...createAlertPorts(admin),
    async fetchPage(afterId, limit) {
      let q = admin
        .from("profiles")
        .select("id, email, full_name, company_name, phone, plan, status, minutes_used_this_month, minutes_included")
        .eq("role", "owner")
        .gt("minutes_used_this_month", 0)
        .order("id", { ascending: true })
        .limit(limit);
      if (afterId) q = q.gt("id", afterId);
      const { data, error } = await q;
      if (error) throw new Error(`profiles_page_failed:${error.code ?? "query"}`);
      return (data ?? []) as SweepAccount[];
    },
    async loadCompleted(periodKey, userIds) {
      const out = new Map<string, Set<string>>();
      for (let i = 0; i < userIds.length; i += IN_CHUNK) {
        const { data, error } = await admin
          .from("usage_alert_events").select("user_id, kind")
          .eq("period_key", periodKey).not("completed_at", "is", null).in("user_id", userIds.slice(i, i + IN_CHUNK));
        if (error) throw new Error("completed_lookup_failed");
        for (const r of (data ?? []) as { user_id: string; kind: string }[]) {
          (out.get(r.user_id) ?? out.set(r.user_id, new Set()).get(r.user_id)!).add(r.kind);
        }
      }
      return out;
    },
  };
}

/** One-call helper for the entitlements work: loads the owner, then notifies (once per month per kind). Never throws. */
export async function notifyLimitReachedForOwner(
  admin: SupabaseClient, ownerId: string, kind: LimitKind, current: number, limit: number,
): Promise<void> {
  try {
    const { data } = await admin.from("profiles").select("id, email, plan").eq("id", ownerId).maybeSingle();
    if (!data) return;
    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    await notifyLimitReached(createAlertPorts(admin), data, kind, current, limit, { siteUrl });
  } catch (e) {
    console.error(JSON.stringify({ event: "notify_limit_reached_failed", kind, error: e instanceof Error ? e.name : "error" }));
  }
}
