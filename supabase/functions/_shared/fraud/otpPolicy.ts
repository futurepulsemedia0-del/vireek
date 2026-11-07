// supabase/functions/_shared/fraud/otpPolicy.ts
//
// SMS-pumping defence for verification codes. Pure decision function; the auth-send-sms-hook edge
// function loads the counters (fraud_otp_consume RPC) and acts on the decision.
//
// Principle: a blocked request is DROPPED SILENTLY (the caller still sees success). The response is
// identical whether the number exists, is blocked, is rate-limited or was sent, so the endpoint can't be
// used to probe accounts or to learn which countries / limits are active.

import { evaluateDestination } from "./destinationPolicy.ts";

export type OtpDropReason =
  | "KILL_SWITCH"
  | "INVALID_OR_BLOCKED_DESTINATION"
  | "COUNTRY_NOT_ENABLED"
  | "COOLDOWN"
  | "PHONE_RATE"
  | "IP_RATE"
  | "PREFIX_RATE"
  | "GLOBAL_RATE";

export const OTP_LIMITS = {
  cooldownSeconds: 30,
  phonePerHour: 3,
  ipPerHour: 10,
  prefixPerHour: 20,
  globalPerMinute: 120,
} as const;

export interface OtpCounters {
  phoneAttempts1h: number;
  /** Seconds since the previous code to this number (large when none). */
  phoneSecondsSinceLast: number;
  ipAttempts1h: number;
  prefixAttempts1h: number;
  globalAttempts1min: number;
}

export interface OtpPolicyInput {
  phone: string;
  /** ISO codes with SMS enabled (fraud_settings.otp_allowed_countries). */
  allowedCountries: readonly string[];
  killSwitch: boolean;
  counters: OtpCounters;
}

export type OtpDecision = { send: true; e164: string; country: string; prefix: string } | { send: false; reason: OtpDropReason };

/** Country code + first digits of the national number: groups number ranges used in pumping runs. */
export function otpPrefix(e164: string): string {
  return e164.replace(/^\+/, "").slice(0, 7);
}

/** Static checks that need no counters. Returns the normalized destination or a drop reason. */
export function precheckOtpDestination(phone: string, allowedCountries: readonly string[], killSwitch: boolean):
  | { ok: true; e164: string; country: string; prefix: string }
  | { ok: false; reason: OtpDropReason } {
  if (killSwitch) return { ok: false, reason: "KILL_SWITCH" };
  const dest = evaluateDestination(phone, { internationalUnlocked: true, allowedCountries });
  if (!dest.allowed || dest.emergency) return { ok: false, reason: "INVALID_OR_BLOCKED_DESTINATION" };
  if (!allowedCountries.includes(dest.country)) return { ok: false, reason: "COUNTRY_NOT_ENABLED" };
  return { ok: true, e164: dest.e164, country: dest.country, prefix: otpPrefix(dest.e164) };
}

export function decideOtp(input: OtpPolicyInput): OtpDecision {
  const pre = precheckOtpDestination(input.phone, input.allowedCountries, input.killSwitch);
  if (!pre.ok) return { send: false, reason: pre.reason };
  const c = input.counters;
  if (c.phoneSecondsSinceLast < OTP_LIMITS.cooldownSeconds) return { send: false, reason: "COOLDOWN" };
  if (c.phoneAttempts1h > OTP_LIMITS.phonePerHour) return { send: false, reason: "PHONE_RATE" };
  if (c.ipAttempts1h > OTP_LIMITS.ipPerHour) return { send: false, reason: "IP_RATE" };
  if (c.prefixAttempts1h > OTP_LIMITS.prefixPerHour) return { send: false, reason: "PREFIX_RATE" };
  if (c.globalAttempts1min > OTP_LIMITS.globalPerMinute) return { send: false, reason: "GLOBAL_RATE" };
  return { send: true, e164: pre.e164, country: pre.country, prefix: pre.prefix };
}
