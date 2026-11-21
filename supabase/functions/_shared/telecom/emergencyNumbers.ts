// supabase/functions/_shared/telecom/emergencyNumbers.ts
//
// THE single place that decides "is this destination an emergency number, and may the platform dial it?".
// Pure (no Deno or network imports) so it can be unit-tested and imported by every dial path.
//
// Vireek does NOT provide emergency calling. Until it does, any attempt to dial an emergency number through the
// platform (softphone, click-to-call, outbound dialer, transfers, bridges) is refused with a clear notice, and the
// refusal is never relaxed by shadow/rollout switches or by a failing fraud store.
//
// EMERGENCY_CALLING_SUPPORTED must stay false until ALL of docs/compliance/telecom-status.md section 5 is true
// (carrier E911 provisioning, dispatchable-location handling per number, counsel sign-off). [COUNSEL]
// Flipping this constant alone does not create 911 support; it only stops the platform from blocking.

export const EMERGENCY_CALLING_SUPPORTED: boolean = false;

/** Shown to people in the UI / API responses. Keep in sync with the `emergencyBlocked` strings in the locale files. */
export const EMERGENCY_BLOCK_MESSAGE =
  "Vireek cannot place emergency calls. If this is an emergency, hang up and dial your local emergency number (for example 911, 112 or 999) directly from a phone.";

/** Spoken on a TwiML leg. Short, no jargon. */
export const EMERGENCY_BLOCK_SPOKEN =
  "This phone system cannot place emergency calls. Please hang up and dial your local emergency number directly from another phone.";

export type EmergencyCode = "911" | "112" | "999";

/**
 * Exact dialled forms, after normalisation, that mean "emergency service X". Prefix forms are listed per code on
 * purpose: "9"+911 is the dial-out-prefix habit on business phone systems, but "9"+112 or "1"+112 would collide with
 * legitimate four-digit internal extensions (9112, 1112), so those are NOT treated as emergency.
 */
const FORMS: Readonly<Record<EmergencyCode, readonly string[]>> = {
  "911": ["911", "+911", "1911", "+1911", "9911", "00911", "001911"],
  "112": ["112", "+112", "00112"],
  "999": ["999", "+999", "00999"],
};

const FORM_TO_CODE: ReadonlyMap<string, EmergencyCode> = new Map(
  (Object.keys(FORMS) as EmergencyCode[]).flatMap((c) => FORMS[c].map((f) => [f, c] as const)),
);

/** Arabic-Indic (U+0660..0669) and Persian / Extended Arabic-Indic (U+06F0..06F9) digits to ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const cp = ch.charCodeAt(0);
    return String(cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660);
  });
}

/**
 * Reduces whatever a user, a CSV, a contact record or a URI typed to "+?digits", or null when it is not made of
 * digits and cosmetic separators. Handles: tel:/sip:/sips: URIs (host and parameters dropped), full-width and
 * Persian/Arabic digits, spaces, dots, dashes, slashes, parentheses, a leading * or #, and trailing pause / DTMF characters.
 */
export function normalizeDialed(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  let s = asciiDigits(raw.normalize("NFKC")).trim().toLowerCase();
  s = s.replace(/^(?:tel|sips?):/, "");
  s = s.replace(/@.*$/, "").replace(/;.*$/, "");
  s = s.replace(/^[*#]+/, "").replace(/[,#*pw]+$/, "");
  s = s.replace(/[\s().\-_/\u2010-\u2015]/g, "");
  return /^\+?[0-9]+$/.test(s) ? s : null;
}

export type EmergencyDecision =
  | { kind: "none" }
  | { kind: "blocked"; code: EmergencyCode; message: string }
  | { kind: "allowed"; code: EmergencyCode };

/** Which emergency service, if any, the dialled value addresses. Independent of whether dialling is permitted. */
export function detectEmergencyDestination(raw: unknown): EmergencyCode | null {
  const n = normalizeDialed(raw);
  return n ? FORM_TO_CODE.get(n) ?? null : null;
}

/** The decision every dial path must apply. `supported` exists for tests; production callers omit it. */
export function emergencyDestinationDecision(raw: unknown, supported: boolean = EMERGENCY_CALLING_SUPPORTED): EmergencyDecision {
  const code = detectEmergencyDestination(raw);
  if (!code) return { kind: "none" };
  return supported ? { kind: "allowed", code } : { kind: "blocked", code, message: EMERGENCY_BLOCK_MESSAGE };
}

/** Convenience for call sites that only need a yes/no. */
export const isEmergencyDialBlocked = (raw: unknown): boolean => emergencyDestinationDecision(raw).kind === "blocked";
