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
  if (gate.proceed) return sendSms(to, body);
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
