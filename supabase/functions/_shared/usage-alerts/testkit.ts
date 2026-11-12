// supabase/functions/_shared/usage-alerts/testkit.ts
// In-memory SweepPorts used only by the unit tests. Mirrors claim_usage_alert() semantics (unique key, attempts, done).

import type { ChannelMap } from "./core.ts";
import type { SmsOutcome } from "./dispatch.ts";
import type { SweepAccount, SweepPorts } from "./sweep.ts";

export interface FakeOptions {
  accounts: SweepAccount[];
  maxRows?: number;           // simulate PostgREST max-rows below the requested page size
  emailFails?: () => boolean;
  smsOutcome?: () => SmsOutcome;
  routingRules?: boolean;
  failClaimFor?: string;      // user id whose claim throws
}

export function makeFake(o: FakeOptions) {
  const events = new Map<string, { id: string; channels: ChannelMap; done: boolean; attempts: number }>();
  const calls = { emails: [] as { to: string; subject: string }[], sms: [] as string[], notifications: [] as string[], insights: [] as string[], pages: [] as (string | null)[] };
  const insightKeys = new Set<string>();
  let seq = 0;

  const ports: SweepPorts = {
    async claim(userId, periodKey, kind) {
      if (userId === o.failClaimFor) throw new Error("claim_failed:boom");
      const key = `${userId}|${periodKey}|${kind}`;
      let e = events.get(key);
      if (!e) { e = { id: `evt${++seq}`, channels: {}, done: false, attempts: 0 }; events.set(key, e); }
      if (e.done || e.attempts >= 5) return null;
      e.attempts++;
      return { eventId: e.id, channels: { ...e.channels } };
    },
    async saveChannels(eventId, patch, done) {
      for (const e of events.values()) if (e.id === eventId) { e.channels = { ...e.channels, ...patch }; if (done) e.done = true; }
    },
    async hasInsight(userId, title) { return insightKeys.has(`${userId}|${title}`); },
    async insertInsight(userId, i) { insightKeys.add(`${userId}|${i.title}`); calls.insights.push(i.title); },
    async insertNotification(userId, n) { calls.notifications.push(`${userId}|${n.type}`); },
    async sendEmail(to, mail) {
      if (o.emailFails?.()) return { ok: false, error: "x" };
      calls.emails.push({ to, subject: mail.subject });
      return { ok: true };
    },
    async sendSms(userId, to, body, dedupeKey) {
      const out = o.smsOutcome?.() ?? { status: "sent" as const };
      if (out.status === "sent" || out.status === "deferred") calls.sms.push(dedupeKey);
      return out;
    },
    async hasActiveRoutingRules() { return o.routingRules ?? false; },
    async fetchPage(afterId, limit) {
      calls.pages.push(afterId);
      const sorted = [...o.accounts].sort((a, b) => (a.id < b.id ? -1 : 1));
      return sorted.filter((a) => (afterId ? a.id > afterId : true)).slice(0, Math.min(limit, o.maxRows ?? limit));
    },
    async loadCompleted(periodKey, ids) {
      const out = new Map<string, Set<string>>();
      for (const [key, e] of events) {
        const [uid, pk, kind] = key.split("|");
        if (pk === periodKey && e.done && ids.includes(uid)) (out.get(uid) ?? out.set(uid, new Set()).get(uid)!).add(kind);
      }
      return out;
    },
  };
  return { ports, calls, events };
}

export const acct = (id: string, used: number, included = 400, over: Partial<SweepAccount> = {}): SweepAccount => ({
  id, email: `${id}@example.com`, full_name: "Pat", company_name: "Acme HVAC", phone: "+15555550100",
  plan: "starter", status: "active", minutes_used_this_month: used, minutes_included: included, ...over,
});
