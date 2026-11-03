// supabase/functions/_shared/agent-callers/safety.ts
// Pure safety layer for the AI-agent-caller protocol:
//   - prompt-injection / data-exfiltration detection on caller-supplied text
//   - emergency detection (emergency rules ALWAYS win over the quote flow)
//   - "never discuss" topic matching
//   - abuse / price-scraping assessment from counted history
//   - channel validation + minimal-data summary guard
// Nothing here calls a model: all decisions are deterministic and unit-tested.

import type { AgentCallerSettings } from "./settings.ts";

// ---- text hygiene -----------------------------------------------------------------------------------------------

/** Strips control chars / zero-width / bidi overrides, collapses whitespace, caps length. Output is data, never instructions. */
export function sanitizeCallerText(v: unknown, max = 160): string {
  if (typeof v !== "string") return "";
  return v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---- injection / exfiltration -----------------------------------------------------------------------------------

const INJECTION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "override_instructions", re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|your|the)\b[^.]{0,30}\b(?:instruction|prompt|rule|polic|guideline|constraint)/i },
  { id: "reveal_prompt", re: /\b(?:reveal|show|print|repeat|output|tell me|read (?:out|back))\b[^.]{0,40}\b(?:system prompt|your (?:prompt|instructions|rules)|hidden (?:prompt|instructions)|initial instructions)/i },
  { id: "role_reassignment", re: /\b(?:you are now|from now on you|act as|pretend (?:to be|you are)|new role|developer mode|jailbreak|dan mode)\b/i },
  { id: "tool_or_api_manipulation", re: /\b(?:call|invoke|run|execute|use)\s+(?:the\s+)?(?:tool|function|api|webhook)\b[^.]{0,40}\b(?:with|using|and)\b/i },
  { id: "price_override", re: /\b(?:set|change|update|lower|reduce|apply|use)\b[^.]{0,30}\b(?:price|rate|fee|discount|quote)\b[^.]{0,30}\b(?:to|of|at|by)\b\s*\$?\d/i },
  { id: "claims_authority", re: /\b(?:i am|i'm|this is)\b[^.]{0,25}\b(?:the owner|your (?:developer|admin|administrator|boss|manager)|from (?:anthropic|openai|vireek|google) (?:security|support|engineering)|system administrator)\b/i },
  { id: "markup_injection", re: /(?:<\/?(?:system|assistant|tool|instructions?)>|\[\/?(?:system|inst)\]|###\s*(?:system|instruction))/i },
];

const EXFIL_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "customer_data", re: /\b(?:customer|client)s?\b[^.]{0,25}\b(?:list|names?|numbers?|addresses|emails?|records?|history|database)\b/i },
  { id: "technician_data", re: /\b(?:technician|tech|employee|staff|driver)s?\b[^.]{0,25}\b(?:names?|numbers?|schedule|home|address|location|where)\b/i },
  { id: "owner_data", re: /\b(?:owner|manager|boss)(?:'s)?\b[^.]{0,25}\b(?:name|cell|mobile|personal|home|email|number)\b/i },
  { id: "other_jobs", re: /\b(?:other|another|previous|today's|tomorrow's)\s+(?:jobs?|appointments?|bookings?|customers?)\b/i },
  { id: "internal_data", re: /\b(?:cost|margin|markup|profit|wholesale|internal|supplier)\b[^.]{0,20}\b(?:price|cost|rate|number|data|sheet)\b/i },
  { id: "bulk_price_dump", re: /\b(?:entire|full|whole|complete|every|all)\b[^.]{0,20}\b(?:price ?(?:book|list)|rate card|pricing)\b/i },
];

export interface SafetyFlags {
  injection: string[];
  exfiltration: string[];
  /** True if either list is non-empty. */
  flagged: boolean;
}

export function scanCallerText(...texts: (string | null | undefined)[]): SafetyFlags {
  const joined = texts.filter((t): t is string => typeof t === "string").join(" \n ").slice(0, 8000);
  const injection = INJECTION_PATTERNS.filter((p) => p.re.test(joined)).map((p) => p.id);
  const exfiltration = EXFIL_PATTERNS.filter((p) => p.re.test(joined)).map((p) => p.id);
  return { injection, exfiltration, flagged: injection.length + exfiltration.length > 0 };
}

// ---- emergencies ------------------------------------------------------------------------------------------------

const EMERGENCY_RE = /\b(?:gas (?:leak|smell)|smell(?:s|ing)? (?:gas|smoke|burning)|carbon monoxide|\bco alarm|burst (?:pipe|water)|flood(?:ed|ing)?|sewage (?:backup|overflow)|no (?:heat|power|electricity) (?:and|in) (?:freezing|winter)|sparking|smoking (?:outlet|panel|wire)|electrical fire|fire\b|water (?:pouring|gushing|everywhere)|ceiling (?:collapse|caving)|roof (?:collapse|caved)|locked out (?:of )?(?:my )?(?:child|baby|kid)|emergency|urgent(?:ly)? (?:repair|help)|right now)\b/i;

/** Emergency rules win: an emergency never gets the quote/hold protocol, it goes to the existing emergency flow. */
export function isEmergencyText(...texts: (string | null | undefined)[]): boolean {
  return EMERGENCY_RE.test(texts.filter((t): t is string => typeof t === "string").join(" ").slice(0, 4000));
}

// ---- never-discuss ----------------------------------------------------------------------------------------------

export function matchNeverDiscuss(settings: Pick<AgentCallerSettings, "neverDiscuss">, ...texts: (string | null | undefined)[]): string | null {
  const hay = texts.filter((t): t is string => typeof t === "string").join(" ").toLowerCase();
  if (!hay) return null;
  return settings.neverDiscuss.find((p) => hay.includes(p)) ?? null;
}

// ---- abuse / scraping -------------------------------------------------------------------------------------------

export interface AbuseCounts {
  /** quote_given events for this caller key in the last 24 h. */
  callerQuotes24h: number;
  /** distinct matched services across those quotes. */
  callerDistinctServices24h: number;
  /** distinct ZIPs across those quotes (price-by-zip scraping). */
  callerDistinctZips24h: number;
  /** quote_given events for the whole business in the last hour. */
  tenantQuotes1h: number;
  /** injection/exfiltration flags raised on THIS call so far. */
  callFlags: number;
}

export type AbuseVerdict =
  | { allow: true }
  | { allow: false; reason: "rate_limited" | "scrape_suspected" | "tenant_busy" | "adversarial"; /** Safe to say to the caller. Never reveals thresholds. */ spoken: string };

const DEFER = "I can't finish that quote by phone — a team member will follow up with pricing.";

export function assessAbuse(c: AbuseCounts, s: Pick<AgentCallerSettings, "maxQuotesPerCallerPerDay" | "maxDistinctServicesPerCallerPerDay" | "maxQuotesPerHourTenant">): AbuseVerdict {
  if (c.callFlags >= 2) return { allow: false, reason: "adversarial", spoken: DEFER };
  if (c.callerDistinctServices24h >= s.maxDistinctServicesPerCallerPerDay || c.callerDistinctZips24h >= s.maxDistinctServicesPerCallerPerDay * 2) {
    return { allow: false, reason: "scrape_suspected", spoken: DEFER };
  }
  if (c.callerQuotes24h >= s.maxQuotesPerCallerPerDay) return { allow: false, reason: "rate_limited", spoken: DEFER };
  if (c.tenantQuotes1h >= s.maxQuotesPerHourTenant) return { allow: false, reason: "tenant_busy", spoken: DEFER };
  return { allow: true };
}

// ---- summary channel validation --------------------------------------------------------------------------------

const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}$/;

export type SummaryChannel = { channel: "sms"; destination: string } | { channel: "email"; destination: string };

/** Spoken digits ("five five five…") are NOT parsed: a wrong digit would text a stranger. The agent must supply E.164/email. */
export function parseSummaryChannel(channel: unknown, destination: unknown, allow: Pick<AgentCallerSettings, "allowSmsSummary" | "allowEmailSummary">): { ok: true; value: SummaryChannel } | { ok: false; reason: "unsupported" | "invalid" | "disabled" } {
  if (channel !== "sms" && channel !== "email") return { ok: false, reason: "unsupported" };
  const raw = typeof destination === "string" ? destination.trim() : "";
  const dest = channel === "sms" ? raw.replace(/[\s().-]/g, "") : raw;
  if (channel === "sms") {
    if (!allow.allowSmsSummary) return { ok: false, reason: "disabled" };
    // Premium-rate (900 / 976) and toll-free-looking N11 area codes are never valid summary destinations.
    const premium = /^\+1(?:900|\d{3}976|[2-9]11)/.test(dest);
    return NANP_E164.test(dest) && !premium ? { ok: true, value: { channel, destination: dest } } : { ok: false, reason: "invalid" };
  }
  if (!allow.allowEmailSummary) return { ok: false, reason: "disabled" };
  return EMAIL_RE.test(dest) && dest.length <= 120 ? { ok: true, value: { channel, destination: dest.toLowerCase() } } : { ok: false, reason: "invalid" };
}

/** Hash for rate-limit keys, so counting callers never needs the raw number stored in the agent tables. */
export async function callerKey(userId: string, number: string | null | undefined): Promise<string> {
  const digits = (number ?? "").replace(/\D/g, "");
  const material = `${userId}|${digits || "anonymous"}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
