// supabase/functions/_shared/usage-alerts/dispatch.ts
// Delivers ONE alert (account x period x kind) through its channels, exactly once per period.
// All I/O goes through `AlertPorts`, so this file has no Deno/npm imports and is unit-tested with fakes.

import { toEmail, toSms } from "../email-kit/notification.ts";
import type { AlertAccount, AlertContent } from "./copy.ts";
import { CHANNEL_PLAN, isTerminalStatus, pendingChannels, type ChannelMap, type ChannelName, type UsageAlertKind } from "./core.ts";

export type SmsOutcome =
  | { status: "sent" }
  | { status: "deferred" } // held by quiet hours; the deferred-message dispatcher sends it later
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface AlertPorts {
  /** Atomic claim with a lease (claim_usage_alert RPC). null = already done, leased elsewhere, or out of attempts. */
  claim(userId: string, periodKey: string, kind: UsageAlertKind): Promise<{ eventId: string; channels: ChannelMap } | null>;
  /** Merge per-channel outcomes (complete_usage_alert RPC). `done` completes the event, `release` frees the lease. */
  saveChannels(eventId: string, patch: ChannelMap, done: boolean, release: boolean): Promise<void>;
  hasInsight(userId: string, title: string): Promise<boolean>;
  insertInsight(userId: string, insight: { title: string; description: string; priority: number }): Promise<void>;
  /** Inserting a notifications row also triggers the existing push + notification-router pipelines. */
  insertNotification(userId: string, n: { type: string; title: string; message: string; actionUrl: string }): Promise<void>;
  sendEmail(to: string, mail: { subject: string; html: string; text: string }): Promise<{ ok: boolean; error?: string }>;
  sendSms(userId: string, to: string, body: string, dedupeKey: string): Promise<SmsOutcome>;
  /** True when the owner configured notification_routing_rules: those are their channel preferences. */
  hasActiveRoutingRules(userId: string): Promise<boolean>;
}

export interface DeliveryContext {
  periodKey: string;
  siteUrl: string;
}

export type DeliveryResult =
  | { status: "not_claimed" }
  | { status: "delivered" | "partial"; channels: ChannelMap };

const reasonOf = (e: unknown): string => (e instanceof Error ? e.name : "error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "error";

async function runChannel(
  ch: ChannelName,
  ports: AlertPorts,
  acct: AlertAccount,
  kind: UsageAlertKind,
  content: AlertContent,
  ctx: DeliveryContext,
): Promise<string> {
  const n = content.notification;
  switch (ch) {
    case "in_app": {
      if (!content.insight) return "skipped:no_insight";
      if (await ports.hasInsight(acct.id, content.insight.title)) return "sent"; // legacy/guardrail row for same period
      await ports.insertInsight(acct.id, content.insight);
      return "sent";
    }
    case "email": {
      if (!acct.email) return "skipped:no_email";
      const mail = toEmail(n, { siteUrl: ctx.siteUrl, subject: n.title });
      const res = await ports.sendEmail(acct.email, { subject: mail.subject, html: mail.html, text: mail.text });
      return res.ok ? "sent" : "failed:email";
    }
    case "push": {
      await ports.insertNotification(acct.id, {
        type: content.notificationType,
        title: n.title,
        message: n.body,
        actionUrl: n.action?.url ?? "/dashboard/billing",
      });
      return "sent";
    }
    case "sms": {
      if (!acct.phone) return "skipped:no_phone";
      if (await ports.hasActiveRoutingRules(acct.id)) return "skipped:owner_routing_rules";
      const out = await ports.sendSms(acct.id, acct.phone, toSms(n, ctx.siteUrl), `usage-alert:${acct.id}:${ctx.periodKey}:${kind}:sms`);
      return out.status === "sent" || out.status === "deferred" ? out.status : `${out.status}:${out.reason}`;
    }
  }
}

export async function deliverAlert(
  ports: AlertPorts,
  acct: AlertAccount,
  kind: UsageAlertKind,
  content: AlertContent,
  ctx: DeliveryContext,
): Promise<DeliveryResult> {
  const claim = await ports.claim(acct.id, ctx.periodKey, kind);
  if (!claim) return { status: "not_claimed" };

  const channels: ChannelMap = { ...claim.channels };
  const pending = pendingChannels(kind, channels);

  if (pending.length === 0) {
    await ports.saveChannels(claim.eventId, {}, true, true);
    return { status: "delivered", channels };
  }

  for (const ch of pending) {
    let status: string;
    try {
      status = await runChannel(ch, ports, acct, kind, content, ctx);
    } catch (e) {
      status = `failed:${reasonOf(e)}`;
    }
    channels[ch] = status;
    const done = CHANNEL_PLAN[kind].every((c) => isTerminalStatus(channels[c]));
    const last = ch === pending[pending.length - 1];
    await ports.saveChannels(claim.eventId, { [ch]: status }, done && last, last);
  }
  return { status: CHANNEL_PLAN[kind].every((c) => isTerminalStatus(channels[c])) ? "delivered" : "partial", channels };
}

/** Record a lower threshold crossed in the same run as a higher one: done, nothing sent. */
export async function recordSuperseded(ports: AlertPorts, userId: string, kind: UsageAlertKind, periodKey: string): Promise<boolean> {
  const claim = await ports.claim(userId, periodKey, kind);
  if (!claim) return false;
  const patch: ChannelMap = {};
  for (const c of CHANNEL_PLAN[kind]) patch[c] = "skipped:superseded";
  await ports.saveChannels(claim.eventId, patch, true, true);
  return true;
}
