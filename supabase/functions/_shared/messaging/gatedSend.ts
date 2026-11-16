// supabase/functions/_shared/messaging/gatedSend.ts
//
// Quiet-hours-aware wrappers around the plain senders in ../notify/deliver.ts, for
// CUSTOMER-facing messages that don't go through sendCompliantSms (payment links,
// signature requests, financing offers, membership renewals, self-healing updates...).
// Return shape is a superset of deliver.ts's { ok, error } so call sites change by one line.
//
// Internal alerts to the owner / technicians / on-call staff are NOT customer messaging and
// should keep calling deliver.ts directly.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail, sendSms } from "../notify/deliver.ts";
import { gateAndDefer, type Purpose } from "./quietHours.ts";
import { asFraudDb, gateCustomerOutbound, type BlockedSend } from "../fraud/outboundGate.ts";

export interface GatedOptions {
  purpose?: Purpose;
  customerId?: string | null;
  address?: string | null;
  override?: { reason: string } | null;
  source?: string;
  dedupeKey?: string;
}

export interface GatedResult {
  ok: boolean;
  error?: string;
  /** true = held by quiet hours and queued (ok is true: it will be delivered). */
  deferred?: boolean;
  sendAt?: string;
  /**
   * Set when the fraud / abuse guard refused the send (nothing reached the provider). Do NOT retry in a loop:
   * if blocked.retryable reschedule at blocked.retryAt, otherwise stop. `error` carries the owner-safe message.
   */
  blocked?: BlockedSend;
}

export interface GuardedSmsOptions {
  /** "service" (default): transactional customer messages. "marketing" for promotions. "emergency" for dispatch alerts. */
  purpose?: Purpose;
  /** Calling function name for the fraud audit trail. */
  source: string;
}

export interface GuardedSmsDeps {
  /** Injected in tests; defaults to the Twilio sender in ../notify/deliver.ts. */
  sendSms?: (to: string, body: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Customer-facing SMS that is NOT quiet-hours gated (payment links, refunds, signature requests, financing offers,
 * membership renewals, recurring invoices) — the same plain Twilio sender as before, behind the fraud guard.
 * Use sendGatedSms() when quiet hours also apply. Never use deliver.ts sendSms() for a customer number.
 */
export async function sendGuardedSms(
  admin: SupabaseClient,
  userId: string,
  to: string,
  body: string,
  opts: GuardedSmsOptions,
  deps: GuardedSmsDeps = {},
): Promise<GatedResult> {
  const gate = await gateCustomerOutbound(asFraudDb(admin), { userId, kind: "sms", to, purpose: opts.purpose ?? "service", source: opts.source });
  if (!gate.allowed) return { ok: false, error: gate.blocked.message, blocked: gate.blocked };
  return (deps.sendSms ?? sendSms)(to, body);
}

export async function sendGatedSms(
  admin: SupabaseClient,
  userId: string,
  to: string,
  body: string,
  opts: GatedOptions = {},
): Promise<GatedResult> {
  const gate = await gateAndDefer(
    admin,
    userId,
    { channel: "sms", to, purpose: opts.purpose, customerId: opts.customerId, address: opts.address, override: opts.override, source: opts.source },
    { bodyText: body, dedupeKey: opts.dedupeKey, transport: "plain" },
  );
  // Quiet hours passed: the fraud guard runs now, at the real send moment (a deferred message is guarded again by
  // deferred-message-dispatcher when it is finally sent, so budget is reserved exactly once).
  if (gate.proceed) return sendGuardedSms(admin, userId, to, body, { purpose: opts.purpose, source: opts.source ?? "sendGatedSms" });
  return gate.result.queued ? { ok: true, deferred: true, sendAt: gate.sendAt } : { ok: false, error: `Could not queue message: ${gate.result.error}` };
}

export async function sendGatedEmail(
  admin: SupabaseClient,
  userId: string,
  to: string,
  subject: string,
  html: string,
  text: string,
  opts: GatedOptions = {},
): Promise<GatedResult> {
  const gate = await gateAndDefer(
    admin,
    userId,
    { channel: "email", to, purpose: opts.purpose, customerId: opts.customerId, address: opts.address, override: opts.override, source: opts.source },
    { subject, bodyText: text, bodyHtml: html, dedupeKey: opts.dedupeKey, transport: "plain" },
  );
  if (gate.proceed) return sendEmail(to, subject, html, text);
  return gate.result.queued ? { ok: true, deferred: true, sendAt: gate.sendAt } : { ok: false, error: `Could not queue message: ${gate.result.error}` };
}
