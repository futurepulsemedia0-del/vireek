// supabase/functions/_shared/fraud/otpFlow.ts
//
// The two halves of the SMS-pumping defence as injectable functions, so the edge functions stay thin and the
// whole flow (including attack simulations) is unit-tested.
//
//   processOtpRequest  - runs inside otp-request: limits per phone / IP / prefix / global, issues a single-use ticket,
//                        then asks Supabase Auth to send the code.
//   processSmsHook     - runs inside auth-send-sms-hook: sends ONLY when it can consume a ticket for that phone.
//
// Neither function ever reveals (to the caller) why nothing was sent.

import type { FraudDb } from "./guard.ts";
import { decideOtp, precheckOtpDestination } from "./otpPolicy.ts";
import { hashKey, normalizeHookPhone } from "./hooks.ts";

export interface OtpSettings {
  kill: boolean;
  allowedCountries: readonly string[];
}

interface ConsumeRow { attempts: number; seconds_since_last?: number }

async function consume(db: FraudDb, scope: "phone" | "ip" | "prefix" | "global", keyHash: string, windowSeconds: number): Promise<ConsumeRow> {
  const { data, error } = await db.rpc("fraud_otp_consume", { p_scope: scope, p_key_hash: keyHash, p_window_seconds: windowSeconds });
  const row = Array.isArray(data) ? (data[0] as ConsumeRow | undefined) : undefined;
  if (error || !row) throw new Error("counter failure");
  return row;
}

async function logBlocked(db: FraudDb, code: string, source: string, country: string | null): Promise<void> {
  try {
    await db.from("fraud_events").insert({ kind: "otp_blocked", code, source, country, detail: {} });
  } catch { /* logging never changes the outcome */ }
}

export interface OtpRequestDeps {
  db: FraudDb;
  pepper: string;
  settings: OtpSettings;
  ip: string;
  phone: string;
  /** Asks Supabase Auth to send the code (it will call the Send-SMS hook). */
  callAuth: (e164: string) => Promise<{ ok: boolean; status: number }>;
}

export type OtpRequestOutcome = "requested" | "dropped" | "error";

export async function processOtpRequest(d: OtpRequestDeps): Promise<OtpRequestOutcome> {
  const phone = normalizeHookPhone(d.phone);
  try {
    const first = precheckOtpDestination(phone, d.settings.allowedCountries, d.settings.kill);
    if (!first.ok) { await logBlocked(d.db, first.reason, "otp-request", null); return "dropped"; }

    // Compute every hash BEFORE starting any counter call: an `await` between starting promises would let an early
    // rejection go unhandled (Promise.all has not attached its handlers yet) when the store is down.
    const [phoneHash, ipHash, prefixHash, globalHash] = await Promise.all([
      hashKey(d.pepper, "phone", first.e164),
      hashKey(d.pepper, "ip", d.ip),
      hashKey(d.pepper, "prefix", first.prefix),
      hashKey(d.pepper, "global", "otp"),
    ]);
    const [ph, ip, pf, gl] = await Promise.all([
      consume(d.db, "phone", phoneHash, 3600),
      consume(d.db, "ip", ipHash, 3600),
      consume(d.db, "prefix", prefixHash, 3600),
      consume(d.db, "global", globalHash, 60),
    ]);
    const decision = decideOtp({
      phone, allowedCountries: d.settings.allowedCountries, killSwitch: d.settings.kill,
      counters: {
        phoneAttempts1h: ph.attempts, phoneSecondsSinceLast: ph.seconds_since_last ?? 1e9,
        ipAttempts1h: ip.attempts, prefixAttempts1h: pf.attempts, globalAttempts1min: gl.attempts,
      },
    });
    if (!decision.send) { await logBlocked(d.db, decision.reason, "otp-request", first.country); return "dropped"; }

    const { error } = await d.db.rpc("fraud_otp_ticket_issue", { p_phone_hash: phoneHash, p_ip_hash: ipHash, p_ttl_seconds: 120 });
    if (error) throw new Error("ticket failure");

    const res = await d.callAuth(decision.e164);
    if (!res.ok) await logBlocked(d.db, res.status === 400 || res.status === 422 ? "CAPTCHA_OR_AUTH_REJECTED" : "AUTH_ERROR", "otp-request", first.country);
    return "requested";
  } catch {
    return "error"; // fail closed: nothing was sent unless a ticket + Auth call both happened
  }
}

export interface SmsHookDeps {
  db: FraudDb;
  pepper: string;
  settings: OtpSettings;
  phone: string;
  send: (e164: string) => Promise<boolean>;
}

export type SmsHookOutcome = "sent" | "dropped" | "send_failed" | "error";

export async function processSmsHook(d: SmsHookDeps): Promise<SmsHookOutcome> {
  try {
    const pre = precheckOtpDestination(normalizeHookPhone(d.phone), d.settings.allowedCountries, d.settings.kill);
    if (!pre.ok) { await logBlocked(d.db, pre.reason, "auth-send-sms-hook", null); return "dropped"; }

    const { data, error } = await d.db.rpc("fraud_otp_ticket_consume", { p_phone_hash: await hashKey(d.pepper, "phone", pre.e164) });
    if (error) throw new Error("ticket check failed");
    if (data !== true) { await logBlocked(d.db, "NO_TICKET", "auth-send-sms-hook", pre.country); return "dropped"; }

    return (await d.send(pre.e164)) ? "sent" : "send_failed";
  } catch {
    return "error";
  }
}
