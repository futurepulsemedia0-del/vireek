// supabase/functions/_shared/fraud/destinationPolicy.ts
//
// THE single decision point for "may this platform place a call / send an SMS to this number?".
// Every outbound, transfer, forwarding and OTP path must call evaluateDestination() (directly or via
// guard.ts) with a destination that was resolved SERVER-SIDE.
//
// Rules, in order:
//   1. Emergency numbers (911, 112, 999) are always allowed and never counted.
//   2. Input must be a clean E.164 number. Pause/DTMF characters (',', ';', '#', '*', 'w', 'p'),
//      letters, and anything that is not a plausible numbering-plan number are rejected, so a
//      "+15551234567,,,9011..." value can never smuggle digits into <Number> / sendDigits.
//   3. Never-routable codes, NANP premium area codes and premium national prefixes are always denied.
//   4. Unknown calling codes are denied (fail closed).
//   5. The country must be allowed for the plan: domestic (US/CA) by default; "standard" countries only
//      when international is unlocked (verification); "extended" only via an explicit per-org
//      allowlist; "high_cost" only via an explicit per-org allowlist (staff-approved).

import {
  NANP_PREMIUM_AREA_CODES,
  NEVER_ROUTABLE_CODES,
  PREMIUM_NATIONAL_PREFIXES,
  lookupCountry,
  type CountryTier,
} from "./countries.ts";

export type DenyReason =
  | "INVALID_NUMBER"
  | "NEVER_ROUTABLE"
  | "PREMIUM_RATE"
  | "UNKNOWN_DESTINATION"
  | "COUNTRY_NOT_ALLOWED"
  | "INTERNATIONAL_LOCKED";

export type DestinationDecision =
  | { allowed: true; e164: string; country: string; tier: CountryTier; emergency: boolean }
  | { allowed: false; reason: DenyReason; e164?: string; country?: string; tier?: CountryTier };

export interface DestinationContext {
  /** True once the org has passed business verification (international unlock). */
  internationalUnlocked: boolean;
  /** Explicit ISO country allowlist for this org (staff-managed). May include extended / high_cost countries. */
  allowedCountries?: readonly string[];
}

const EMERGENCY = new Set(["911", "112", "999"]);

/** Countries any plan may call without unlocking international: US and Canada only. */
const DOMESTIC_ISO = new Set(["US", "CA"]);

export function isEmergencyNumber(raw: string): boolean {
  return EMERGENCY.has(String(raw ?? "").trim());
}

/**
 * Returns a normalized "+<digits>" or null. Accepts a leading "+" or "00", and cosmetic spaces,
 * dashes, dots and parentheses. Rejects everything else. 10-digit and 11-digit "1..." US numbers are
 * accepted as NANP for convenience (matching existing toE164 helpers in the codebase).
 */
export function normalizeE164Strict(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  if (!/^\+?[0-9 ().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/[^0-9]/g, "");
  if (trimmed.startsWith("+")) {
    // keep as is
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.length === 10) {
    digits = `1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    // already NANP with country code
  } else {
    return null; // a bare national number of unknown country is ambiguous
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return `+${digits}`;
}

function nanpShapeOk(digits: string): boolean {
  // +1 NXX NXX XXXX with N = 2-9 for area code and exchange, 11 digits total.
  return digits.length === 11 && /^1[2-9][0-9]{2}[2-9][0-9]{6}$/.test(digits);
}

export function evaluateDestination(raw: string, ctx: DestinationContext): DestinationDecision {
  if (isEmergencyNumber(raw)) {
    return { allowed: true, e164: String(raw).trim(), country: "EMERGENCY", tier: "domestic", emergency: true };
  }
  const e164 = normalizeE164Strict(raw);
  if (!e164) return { allowed: false, reason: "INVALID_NUMBER" };
  const digits = e164.slice(1);

  if (NEVER_ROUTABLE_CODES.some((c) => digits.startsWith(c))) {
    return { allowed: false, reason: "NEVER_ROUTABLE", e164 };
  }

  if (digits.startsWith("1")) {
    if (!nanpShapeOk(digits)) return { allowed: false, reason: "INVALID_NUMBER", e164 };
    if (NANP_PREMIUM_AREA_CODES.has(digits.slice(1, 4))) return { allowed: false, reason: "PREMIUM_RATE", e164 };
  }

  const info = lookupCountry(digits);
  if (!info) return { allowed: false, reason: "UNKNOWN_DESTINATION", e164 };

  const premium = PREMIUM_NATIONAL_PREFIXES[info.callingCode];
  if (premium && premium.some((p) => info.national.startsWith(p))) {
    return { allowed: false, reason: "PREMIUM_RATE", e164, country: info.iso, tier: info.tier };
  }

  const explicit = (ctx.allowedCountries ?? []).includes(info.iso);
  const base = { e164, country: info.iso, tier: info.tier } as const;

  if (DOMESTIC_ISO.has(info.iso)) return { allowed: true, ...base, emergency: false };

  // Everything below is international or NANP-non-domestic (Caribbean) traffic.
  if (info.tier === "high_cost") {
    return explicit ? { allowed: true, ...base, emergency: false } : { allowed: false, reason: "COUNTRY_NOT_ALLOWED", ...base };
  }
  if (!ctx.internationalUnlocked) return { allowed: false, reason: "INTERNATIONAL_LOCKED", ...base };
  if (info.tier === "standard") return { allowed: true, ...base, emergency: false };
  // extended: needs an explicit org allowlist entry even when international is unlocked
  return explicit ? { allowed: true, ...base, emergency: false } : { allowed: false, reason: "COUNTRY_NOT_ALLOWED", ...base };
}
