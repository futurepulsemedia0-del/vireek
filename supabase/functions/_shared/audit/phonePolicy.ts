// supabase/functions/_shared/audit/phonePolicy.ts
//
// Pure policy for WHICH numbers the audit may ever send a code to or dial. Fail closed: anything unrecognised is refused.
// NOT LEGAL ADVICE. NANPA is the source of truth for area codes; the lists below are static and must be reviewed.

import { cleanText, parseNanpPhone } from "../speed-to-lead/core.ts";

export type PhoneRejection =
  | "invalid_phone"
  | "unsupported_region"
  | "emergency_number"
  | "premium_number"
  | "non_geographic"
  | "fictional_number"
  | "region_not_allowed";

export type PhoneAssessment =
  | { ok: true; e164: string; npa: string; country: "US" | "CA" | "TOLL_FREE"; tollFree: boolean }
  | { ok: false; reason: PhoneRejection };

/** Emergency and N11 service codes, in every shape a person might type them (911, +1 911, 1-911, 112, 999, ...). */
const SERVICE_CODES = new Set([
  "911", "1911", "112", "999", "000", "110", "119", "988", "1988",
  "211", "311", "411", "511", "611", "711", "811",
  "1211", "1311", "1411", "1511", "1611", "1711", "1811",
]);

/** Premium-rate and carrier-billed area codes: never code, never dial. */
const PREMIUM_NPAS = new Set(["900", "976"]);
/** Personal-communication, carrier-services and government-emergency (710) non-geographic codes. */
const NON_GEOGRAPHIC_NPAS = new Set(["500", "533", "544", "566", "577", "588", "600", "622", "700", "710"]);
export const TOLL_FREE_NPAS = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/** NANP numbers outside the US and Canada (Caribbean / Pacific): different rules and a known toll-fraud risk. */
export const NON_US_CA_NPAS = new Set([
  "242", "246", "264", "268", "284", "340", "345", "441", "473", "649", "658", "664", "670", "671", "684",
  "721", "758", "767", "784", "787", "809", "829", "849", "868", "869", "876", "939",
]);

/** Canadian area codes. Best-effort classification only; used solely to honour a country allowlist. */
export const CA_NPAS = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354", "365", "367", "368", "382", "403",
  "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519", "548", "579", "581", "584",
  "587", "604", "613", "639", "647", "672", "683", "705", "709", "742", "753", "778", "780", "782", "807", "819",
  "825", "867", "873", "879", "902", "905",
]);

export interface PhoneOptions {
  allowedCountries?: readonly string[];
}

export function assessBusinessPhone(raw: unknown, opts: PhoneOptions = {}): PhoneAssessment {
  const allowed = opts.allowedCountries ?? ["US", "CA"];
  const text = cleanText(raw, 40);
  const digits = text.replace(/\D/g, "");

  // Emergency / service codes are refused BEFORE any other parsing, whatever the formatting.
  if (SERVICE_CODES.has(digits) || /^\+?1?[\s().-]*911\D*$/.test(text)) return { ok: false, reason: "emergency_number" };

  const parsed = parseNanpPhone(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const e164 = parsed.e164;
  const npa = e164.slice(2, 5);
  const nxx = e164.slice(5, 8);

  if (npa === "710") return { ok: false, reason: "emergency_number" };
  if (PREMIUM_NPAS.has(npa)) return { ok: false, reason: "premium_number" };
  if (NON_GEOGRAPHIC_NPAS.has(npa)) return { ok: false, reason: "non_geographic" };
  if (nxx === "555") return { ok: false, reason: "fictional_number" };
  if (NON_US_CA_NPAS.has(npa)) return { ok: false, reason: "region_not_allowed" };

  const tollFree = TOLL_FREE_NPAS.has(npa);
  const country = tollFree ? "TOLL_FREE" : CA_NPAS.has(npa) ? "CA" : "US";
  const permitted = country === "TOLL_FREE" ? allowed.includes("US") || allowed.includes("CA") : allowed.includes(country);
  if (!permitted) return { ok: false, reason: "region_not_allowed" };
  return { ok: true, e164, npa, country, tollFree };
}

/** Line types a lookup provider may report; only these are ever acceptable. */
export const BLOCKED_LINE_TYPES = new Set(["premium", "sharedCost", "uan", "pager", "voicemail"]);
/** Line types that cannot receive a text, so the code goes by voice. */
export const VOICE_ONLY_LINE_TYPES = new Set(["landline", "tollFree", "fixedVoip"]);

export function channelFor(assessment: Extract<PhoneAssessment, { ok: true }>, requested: "sms" | "voice", lineType?: string | null): "sms" | "voice" {
  if (assessment.tollFree) return "voice";
  if (lineType && VOICE_ONLY_LINE_TYPES.has(lineType)) return "voice";
  return requested;
}

export const REJECTION_MESSAGES: Record<PhoneRejection, string> = {
  invalid_phone: "Enter a full 10-digit US or Canadian business phone number.",
  unsupported_region: "We can only test US and Canadian numbers right now.",
  emergency_number: "That looks like an emergency or service number. We never call those.",
  premium_number: "We can't test premium-rate numbers.",
  non_geographic: "We can't test this kind of number. Use your regular business line.",
  fictional_number: "That number isn't a real, callable number.",
  region_not_allowed: "We can only test US and Canadian numbers right now.",
};

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export type EmailRejection = "invalid_email" | "disposable_email" | "blocked_email_domain";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "throwawaymail.com",
  "maildrop.cc", "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com", "tempinbox.com",
]);

export function assessEmail(raw: unknown, blockedDomains: ReadonlySet<string> = new Set()):
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: EmailRejection } {
  const email = cleanText(raw, 254).toLowerCase();
  if (email.length < 6 || email.length > 254 || !/^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[a-z]{2,}$/.test(email)) {
    return { ok: false, reason: "invalid_email" };
  }
  const at = email.lastIndexOf("@");
  if (at < 1 || email.slice(0, at).length > 64) return { ok: false, reason: "invalid_email" };
  const domain = email.slice(at + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) return { ok: false, reason: "disposable_email" };
  if (blockedDomains.has(domain)) return { ok: false, reason: "blocked_email_domain" };
  return { ok: true, email, domain };
}

/** Business name is spoken to a stranger and put in a prompt: allow a conservative character set only. */
export function cleanBusinessName(raw: unknown): string {
  return cleanText(raw, 120).replace(/[^A-Za-z0-9 &'.,+\-/]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export const TRADES = [
  "hvac", "plumbing", "electrical", "roofing", "landscaping", "cleaning", "pest_control", "garage_doors",
  "appliance_repair", "restoration", "painting", "handyman", "other",
] as const;
export type Trade = (typeof TRADES)[number];
export const isTrade = (v: unknown): v is Trade => typeof v === "string" && (TRADES as readonly string[]).includes(v);
