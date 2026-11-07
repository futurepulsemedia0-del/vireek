// supabase/functions/_shared/review-shield/patterns.ts
//
// Text patterns CONSISTENT WITH extortion / review-bombing demands. English only for now
// (other languages are NOT covered and the UI must say so). Matching is a prompt for the
// owner to read the message — never a finding, and never an input to an appeal on its own.

import { normalizeText } from "./text.ts";

export type ExtortionCode =
  | "payment_for_removal" // pay / send money and the review goes away
  | "threat_more_reviews" // will keep posting / flood reviews
  | "conditional_threat" // "unless/until you pay/refund/give me ..."
  | "reputation_threat"; // "I'll ruin / destroy your business / reputation"

export type Channel = "review" | "reply" | "email" | "dm" | "voicemail" | "sms";

interface Rule {
  code: ExtortionCode;
  re: RegExp;
}

const MONEY = String.raw`(?:\$\s?\d|\d+\s?(?:dollars|usd|bucks)|money|cash|payment|fee|bitcoin|btc|crypto|gift ?cards?|zelle|venmo|cashapp|paypal|wire)`;
const REMOVE = String.raw`(?:remove|delete|take (?:it |that |the review )?(?:down|off)|retract|pull|withdraw|change|edit|update)`;
const REVIEW = String.raw`(?:reviews?|ratings?|stars?|posts?|comments?)`;

const RULES: Rule[] = [
  { code: "payment_for_removal", re: new RegExp(String.raw`\b(?:pay|send|give|wire|transfer)\b[^.!?\n]{0,60}${MONEY}?[^.!?\n]{0,60}\b${REMOVE}\b[^.!?\n]{0,40}\b${REVIEW}\b`) },
  { code: "payment_for_removal", re: new RegExp(String.raw`\b${REMOVE}\b[^.!?\n]{0,40}\b${REVIEW}\b[^.!?\n]{0,60}\b(?:for|if you|when you|once you|after you)\b[^.!?\n]{0,40}${MONEY}`) },
  { code: "payment_for_removal", re: new RegExp(String.raw`${MONEY}[^.!?\n]{0,50}\b(?:to|and i(?:'| wi)ll|and we(?:'| wi)ll)\b[^.!?\n]{0,20}\b${REMOVE}\b[^.!?\n]{0,30}\b${REVIEW}\b`) },
  { code: "threat_more_reviews", re: new RegExp(String.raw`\b(?:i(?:'| wi)ll|i am going to|i'm going to|we(?:'| wi)ll|going to|gonna)\b[^.!?\n]{0,30}\b(?:keep|continue|post|leave|write|flood|bomb|spam)\b[^.!?\n]{0,30}\b${REVIEW}\b`) },
  { code: "threat_more_reviews", re: /\b(?:more|many|hundreds of|dozens of)\b[^.!?\n]{0,15}\b(?:1[- ]?star|one[- ]?star|bad|negative|fake)\b[^.!?\n]{0,15}\b(?:reviews?|ratings?)\b[^.!?\n]{0,40}\b(?:coming|will follow|on the way)\b/ },
  { code: "conditional_threat", re: /\b(?:unless|until|if you (?:don'?t|do not|won'?t|refuse))\b[^.!?\n]{0,60}\b(?:pay|refund|compensat\w*|give me|send me|wire)\b/ },
  { code: "reputation_threat", re: /\b(?:ruin|destroy|wreck|tank|sink|kill)\b[^.!?\n]{0,25}\b(?:your|the)\b[^.!?\n]{0,20}\b(?:business|reputation|rating|company|name)\b/ },
];

export interface PatternHit {
  code: ExtortionCode;
  channel: Channel;
  /** Character offsets in the NORMALISED text — used to highlight, never to quote at length. */
  index: number;
}

/** Scan one message. Returns [] for ordinary complaints ("I want a refund" alone is not a hit). */
export function scanForExtortionPatterns(text: string | null | undefined, channel: Channel): PatternHit[] {
  const norm = normalizeText(text);
  if (norm.length < 12) return [];
  const hits: PatternHit[] = [];
  const seen = new Set<ExtortionCode>();
  for (const rule of RULES) {
    if (seen.has(rule.code)) continue;
    const m = rule.re.exec(norm);
    if (m) {
      seen.add(rule.code);
      hits.push({ code: rule.code, channel, index: m.index });
    }
  }
  return hits;
}
