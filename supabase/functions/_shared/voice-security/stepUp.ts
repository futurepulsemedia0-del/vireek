// supabase/functions/_shared/voice-security/stepUp.ts
//
// Step-up verification primitives. Voice alone never unlocks account data or changes:
//   step_up = known details (>= 2 matched, 0 mismatched)  AND  one-time code sent to the number ON FILE
// Caller ID is a claim, not proof, so the code is sent to the customer record's own phone - a caller who
// merely spoofs the number never receives it. The model never sees the code or the record: it only learns
// "verified / not verified". Attempt counting and lockout live in SQL (migration) so they are atomic.

import type { CallSecurityState, VerificationLevel } from "./types.ts";

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const VERIFICATION_TTL_MS = 15 * 60_000;
export const MAX_OTP_ATTEMPTS = 3;
export const MAX_CHALLENGES_PER_CALL = 3;
export const MAX_CHALLENGES_PER_NUMBER_DAY = 5;
export const MAX_KNOWN_DETAIL_FAILS = 3;

/** Uniform 6-digit code via rejection sampling (no modulo bias). */
export function generateOtp(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = "";
  while (out.length < OTP_LENGTH) {
    for (const b of rand(8)) {
      if (b < 250 && out.length < OTP_LENGTH) out += String(b % 10); // 250 = largest multiple of 10 <= 256
    }
  }
  return out;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stored digest binds the code to tenant + call + customer so it cannot be replayed elsewhere. */
export function otpDigest(secret: string, b: { userId: string; callId: string; customerId: string; code: string }): Promise<string> {
  return hmacHex(secret, `otp|${b.userId}|${b.callId}|${b.customerId}|${b.code}`);
}

const WORD_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", tree: "3",
  four: "4", for: "4", fore: "4", five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9", niner: "9",
};

/**
 * Speech-to-text turns "four one oh two nine seven" into words. Returns the 6-digit code, or null when the
 * utterance does not contain exactly OTP_LENGTH digits (so a sentence with extra numbers never half-matches).
 */
export function normalizeSpokenCode(raw: string): string | null {
  const tokens = raw.toLowerCase().normalize("NFKC").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let digits = "";
  for (const t of tokens) {
    if (/^\d+$/.test(t)) digits += t;
    else if (t in WORD_DIGITS) digits += WORD_DIGITS[t];
    else if (t === "double" || t === "triple") continue; // ambiguous - require explicit digits instead of guessing
    else return null; // any other word: not a bare code
  }
  return digits.length === OTP_LENGTH ? digits : null;
}

// ---- known details --------------------------------------------------------------------------

export interface KnownDetailsInput { zip?: string; street_number?: string; last_name?: string }
export interface KnownDetailsRecord { name?: string | null; address?: string | null }
export interface KnownDetailsResult { passed: boolean; matched: number; mismatched: number }

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;
const STREET_NO_RE = /^\s*(\d{1,6})\b/;

const squash = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digitsOnly = (s: string) => s.replace(/\D/g, "");

export function matchKnownDetails(given: KnownDetailsInput, rec: KnownDetailsRecord): KnownDetailsResult {
  let matched = 0;
  let mismatched = 0;
  const tally = (provided: boolean, ok: boolean) => {
    if (!provided) return;
    if (ok) matched++;
    else mismatched++;
  };

  const recZip = rec.address?.match(ZIP_RE)?.[1] ?? null;
  const givenZip = given.zip ? digitsOnly(given.zip).slice(0, 5) : "";
  tally(givenZip.length === 5, !!recZip && recZip === givenZip);

  const recNo = rec.address?.match(STREET_NO_RE)?.[1] ?? null;
  const givenNo = given.street_number ? digitsOnly(given.street_number) : "";
  tally(givenNo.length > 0, !!recNo && recNo === givenNo);

  const recLast = rec.name ? squash(rec.name.trim().split(/\s+/).slice(-1)[0] ?? "") : "";
  const givenLast = given.last_name ? squash(given.last_name) : "";
  tally(givenLast.length > 0, recLast.length > 1 && recLast === givenLast);

  return { passed: matched >= 2 && mismatched === 0, matched, mismatched };
}

// ---- level ----------------------------------------------------------------------------------

/**
 * step_up requires BOTH factors, for the SAME customer, both fresh. A caller ID alone is at best "caller_id".
 */
export function computeLevel(state: CallSecurityState, callerNumber: string | null, nowMs: number): VerificationLevel {
  if (state.locked) return callerNumber ? "caller_id" : "none";
  const fresh = (t: number | null) => t !== null && nowMs - t <= VERIFICATION_TTL_MS && nowMs >= t - 5_000;
  if (state.customerId && fresh(state.kdPassedAt) && fresh(state.otpPassedAt)) return "step_up";
  return callerNumber ? "caller_id" : "none";
}
