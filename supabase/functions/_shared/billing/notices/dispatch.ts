// supabase/functions/_shared/billing/notices/dispatch.ts
// I/O layer: loads the account owner, composes the notice, sends it exactly once.
// Transactional only: no marketing content, no unsubscribe link. Email always goes to the account OWNER.
// SMS is used ONLY for "service paused" and only with a phone number AND profiles.billing_sms_opt_in = true.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail, sendSms } from "../../notify/deliver.ts";
import {
  composeFraudNotice,
  composePaymentSuspended,
  composePriceChange,
  composeRenewal,
  type ComposedNotice,
  type PriceChangeData,
  type RenewalData,
} from "./compose.ts";
import { sendNoticeOnce, type NoticeClient, type NoticeKind, type NoticeOutcome, type SendResult } from "./noticeLog.ts";
import { safeTimeZone } from "./schedule.ts";

export interface OwnerProfile {
  id: string;
  email: string | null;
  name: string;
  language: string | null;
  timeZone: string;
  phone: string | null;
  smsOptIn: boolean;
  plan: string | null;
  status: string | null;
  subscriptionStatus: string | null;
  paymentFailedAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** select("*") + defensive reads: optional columns (timezone, phone, language) may differ between environments. */
export function toOwnerProfile(row: Record<string, unknown>): OwnerProfile {
  const full = str(row.full_name) ?? str(row.name) ?? "";
  return {
    id: String(row.id),
    email: str(row.email),
    name: full.split(" ")[0] || "there",
    language: str(row.preferred_language),
    timeZone: safeTimeZone(row.timezone),
    phone: str(row.phone),
    smsOptIn: row.billing_sms_opt_in === true,
    plan: str(row.plan),
    status: str(row.status),
    subscriptionStatus: str(row.subscription_status),
    paymentFailedAt: str(row.payment_failed_at),
    stripeCustomerId: str(row.stripe_customer_id),
    stripeSubscriptionId: str(row.stripe_subscription_id),
    createdAt: str(row.created_at),
  };
}

export async function loadOwner(admin: SupabaseClient, userId: string): Promise<OwnerProfile | null> {
  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw new Error(`loadOwner: ${error.message}`);
  return data ? toOwnerProfile(data as Record<string, unknown>) : null;
}

export const siteUrl = (): string => (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
export const supportEmail = (): string => Deno.env.get("SUPPORT_EMAIL") || "ali@vireek.com";
const asClient = (admin: SupabaseClient): NoticeClient => admin as unknown as NoticeClient;

async function deliverEmail(owner: OwnerProfile, n: ComposedNotice): Promise<SendResult> {
  if (!owner.email) return { ok: false, channels: [], error: "no_email" };
  const r = await sendEmail(owner.email, n.subject, n.html, n.text);
  return r.ok ? { ok: true, channels: ["email"] } : { ok: false, channels: [], error: r.error };
}

export function sendRenewalNotice(admin: SupabaseClient, owner: OwnerProfile, data: Omit<RenewalData, "name" | "siteUrl">, key: string): Promise<NoticeOutcome> {
  return sendNoticeOnce(asClient(admin), owner.id, "renewal_30d", key, () =>
    deliverEmail(owner, composeRenewal(owner.language, { ...data, name: owner.name, siteUrl: siteUrl() })),
  );
}

export function sendPriceChangeNotice(admin: SupabaseClient, owner: OwnerProfile, data: Omit<PriceChangeData, "name" | "siteUrl">, key: string): Promise<NoticeOutcome> {
  return sendNoticeOnce(asClient(admin), owner.id, "price_change", key, () =>
    deliverEmail(owner, composePriceChange(owner.language, { ...data, name: owner.name, siteUrl: siteUrl() })),
  );
}

/**
 * Payment suspension. Dedupe key = the failed-payment streak (payment_failed_at), so the webhook path,
 * the hourly sweep and the reconciliation pass can all call this and only ONE notice goes out.
 * Only sends while the account is actually suspended (guards against a payment that just recovered it).
 */
export async function notifyPaymentSuspended(admin: SupabaseClient, userId: string, fallbackKey?: string): Promise<NoticeOutcome | "skipped"> {
  const owner = await loadOwner(admin, userId);
  if (!owner || owner.subscriptionStatus !== "suspended") return "skipped";
  const key = `payment:${owner.paymentFailedAt ?? fallbackKey ?? "unknown"}`;
  return sendNoticeOnce(asClient(admin), owner.id, "payment_suspended", key, async () => {
    const n = composePaymentSuspended(owner.language, { name: owner.name, supportEmail: supportEmail(), siteUrl: siteUrl() });
    const email = await deliverEmail(owner, n);
    const channels = [...email.channels];
    if (owner.phone && owner.smsOptIn && n.sms) {
      const sms = await sendSms(owner.phone, n.sms);
      if (sms.ok) channels.push("sms");
      else console.error(JSON.stringify({ event: "billing_notice_sms_failed", error: sms.error }));
    }
    return { ok: email.ok || channels.includes("sms"), channels, error: email.error };
  });
}

/** Fraud throttle/suspend: neutral wording, email only. One notice per account, status and UTC day. */
export async function notifyFraudRestriction(admin: SupabaseClient, userId: string, status: "throttled" | "suspended", now: Date = new Date()): Promise<NoticeOutcome | "skipped"> {
  const owner = await loadOwner(admin, userId);
  if (!owner) return "skipped";
  const kind: NoticeKind = status === "suspended" ? "fraud_suspended" : "fraud_throttled";
  return sendNoticeOnce(asClient(admin), owner.id, kind, `fraud:${status}:${now.toISOString().slice(0, 10)}`, () =>
    deliverEmail(owner, composeFraudNotice(owner.language, { name: owner.name, status, supportEmail: supportEmail(), siteUrl: siteUrl() })),
  );
}
