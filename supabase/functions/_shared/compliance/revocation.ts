// supabase/functions/_shared/compliance/revocation.ts
//
// Pure revocation parsing for every inbound channel (SMS, voice transcript, email reply).
// No I/O. Persistence + fan-out live in consentChecks.ts and the SQL function
// public.consent_record_revocation().
//
// NOT LEGAL ADVICE. [COUNSEL] FCC rules treat any reasonable expression of "stop" as a revocation,
// and the "revoke-all" provision (a revocation applies to every robocall/text from the caller)
// had its effective date delayed to 2027-01-31 as of the last order found [VERIFY]. We implement the
// strictest reading by default: a revocation on ANY channel suppresses ALL channels for that
// number/email within the configured window.
//
// Bias: this parser leans toward detecting revocation. A false positive costs one suppressed
// contact (a human can reinstate); a false negative can cost a TCPA violation.

import { customerLines } from "../speed-to-lead/core.ts";

export type RevocationChannel = "sms" | "voice" | "email";
export type RevocationScope = "all_channels" | "this_channel";
export type MatchKind = "keyword" | "phrase" | "structured";

export interface RevocationSignal {
  revoked: boolean;
  matchKind: MatchKind | null;
  /** Short matched fragment for the audit log (max 80 chars, from the customer's own words). */
  matched: string | null;
  /** The customer says we have the wrong person; consent itself is void, not just revoked. */
  wrongNumber: boolean;
  /** True when the customer re-subscribes (START). Never auto-applied for voice/email. */
  reinstate: boolean;
}

const NONE: RevocationSignal = { revoked: false, matchKind: null, matched: null, wrongNumber: false, reinstate: false };

// Exact one-word keywords (carrier standard + common variants). Matched against the whole trimmed message.
const KEYWORDS = new Set([
  "STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT OUT", "REMOVE", "REVOKE",
  "ARRET", "ARRÊT", "BASTA", "PARAR", "ALTO",
]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES START"]);

// Natural-language phrases, evaluated on the customer's words only.
const PHRASES: RegExp[] = [
  /\b(stop|quit|cease|end)\s+(all\s+)?(calling|texting|messaging|emailing|contacting|phoning|sending)\b/i,
  /\b(stop|quit)\s+(the\s+)?(calls?|texts?|messages?|emails?)\b/i,
  /\bdo\s*n[o']?t\s+(call|text|message|email|e-mail|contact|phone)\b/i,
  /\bdon'?t\s+(ever\s+)?(call|text|message|email|contact)\s+(me|us)\b/i,
  /\bnever\s+(call|text|message|email|contact)\s+(me\s+)?(again|anymore)\b/i,
  /\b(take|remove|delete|drop)\s+(me|my\s+(number|name|email|info))\b.*\b(list|calls?|texts?|database|contact)\b/i,
  /\bremove\s+me\b/i,
  /\bopt(ed|ing)?[\s-]*out\b/i,
  /\bunsubscribe\b/i,
  /\bleave\s+me\s+alone\b/i,
  /\bno\s+more\s+(calls?|texts?|messages?|emails?)\b/i,
  /\brevoke\b.*\bconsent\b/i,
  /\bput\s+me\s+on\s+(your|the|a)\s+(do\s*not\s*(call|contact|text)|dnc)\b/i,
];

// If one of these appears the same sentence is NOT a revocation ("don't stop", "can't stop thinking").
const NEGATIONS: RegExp[] = [
  /\b(don'?t|do\s+not|never|please\s+don'?t)\s+stop\b/i,
  /\bcan'?t\s+stop\b/i,
  /\b(didn'?t|did\s+not)\s+(say|ask)\s+(to\s+)?stop\b/i,
];

const WRONG_NUMBER = /\bwrong\s+(number|person)\b|\b(no\s+one|nobody)\s+(here\s+)?by\s+that\s+name\b|\bnot\s+(him|her|the\s+person|my\s+(name|number))\b|\bthis\s+(isn'?t|is\s+not)\s+(his|her|their)\s+(number|phone)\b/i;

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]+/g, "").replace(/\s+/g, " ").trim();
}

/** Remove quoted reply history and signatures so we only read what the customer just wrote. */
export function stripEmailQuoting(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^>/.test(t)) continue;
    if (/^on .{5,120} wrote:?$/i.test(t)) break;
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(t)) break;
    if (/^--\s*$/.test(t)) break; // signature delimiter
    out.push(line);
  }
  return out.join("\n");
}

function firstPhraseMatch(text: string): string | null {
  // Evaluate sentence-by-sentence so a negation in one sentence cannot mask a revocation in another.
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    if (NEGATIONS.some((n) => n.test(s))) continue;
    for (const p of PHRASES) {
      const m = p.exec(s);
      if (m) return m[0].slice(0, 80);
    }
  }
  return null;
}

export interface ParseInput {
  channel: RevocationChannel;
  /** SMS body, voice transcript (labelled or not), or email text body. */
  text: string | null | undefined;
  /** Provider-structured flags (e.g. Vapi structuredData). */
  structured?: Record<string, unknown> | null;
  /** Email subject (unsubscribe replies often carry the intent only there). */
  subject?: string | null;
}

export function parseRevocation(input: ParseInput): RevocationSignal {
  const s = input.structured ?? null;
  const structuredRevoke = !!s && (s.do_not_call === true || s.dnc === true || s.opt_out === true || s.revoke_consent === true || s.unsubscribe === true);
  const structuredWrong = !!s && s.wrong_number === true;

  let scanned = "";
  if (input.channel === "voice") scanned = customerLines(input.text ?? "");
  else if (input.channel === "email") scanned = [input.subject ?? "", stripEmailQuoting(input.text ?? "")].join("\n");
  else scanned = input.text ?? "";
  scanned = scanned.trim();

  if (!scanned && !structuredRevoke && !structuredWrong) return NONE;

  const norm = normalize(scanned);
  const upperWhole = norm.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toUpperCase();

  if (input.channel === "sms" && START_KEYWORDS.has(upperWhole)) {
    return { ...NONE, reinstate: true, matchKind: "keyword", matched: upperWhole };
  }

  const wrongNumber = structuredWrong || WRONG_NUMBER.test(norm);

  if (structuredRevoke) return { revoked: true, matchKind: "structured", matched: "structured_flag", wrongNumber, reinstate: false };

  if (norm.length > 0 && norm.length <= 40 && KEYWORDS.has(upperWhole)) {
    return { revoked: true, matchKind: "keyword", matched: upperWhole, wrongNumber, reinstate: false };
  }

  const phrase = norm ? firstPhraseMatch(norm) : null;
  if (phrase) return { revoked: true, matchKind: "phrase", matched: phrase, wrongNumber, reinstate: false };

  // A wrong-number report voids consent for this subject even without the word "stop".
  if (wrongNumber) return { revoked: true, matchKind: "phrase", matched: "wrong_number", wrongNumber: true, reinstate: false };

  return NONE;
}

// ---------------------------------------------------------------------------
// Configurable window
// ---------------------------------------------------------------------------
//
// Enforcement is IMMEDIATE (every gate reads the revocation row before every contact). The window
// is the outer bound by which every slower downstream effect (queued jobs, campaigns, scheduled
// sequences, third-party syncs) must have been cancelled; the sweeper flags revocations whose
// fan-out is incomplete after this many hours. 0 = "must be complete in the same transaction".
// Default 24 h; hard cap 240 h (10 days) [COUNSEL][VERIFY: FCC outer limit is expressed in business days].

export interface RevocationConfig {
  scope: RevocationScope;
  windowHours: number;
}

export function loadRevocationConfig(getEnv: (k: string) => string | undefined): RevocationConfig {
  const n = Number.parseInt(getEnv("REVOCATION_WINDOW_HOURS") ?? "", 10);
  const windowHours = Number.isFinite(n) ? Math.min(240, Math.max(0, n)) : 24;
  const scopeRaw = (getEnv("REVOCATION_SCOPE") ?? "all_channels").trim().toLowerCase();
  return { scope: scopeRaw === "this_channel" ? "this_channel" : "all_channels", windowHours };
}

export function revocationDeadline(receivedAt: Date, cfg: RevocationConfig): Date {
  return new Date(receivedAt.getTime() + cfg.windowHours * 3_600_000);
}
