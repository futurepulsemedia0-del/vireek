// supabase/functions/_shared/review-shield/reply.ts
//
// Linter for PUBLIC replies to suspicious reviews. Templates themselves live in the i18n
// locale files (user-facing strings); this checks any text — template, edited or AI-drafted —
// before the owner can approve it. It only ever BLOCKS or WARNS; it never rewrites.

import { normalizeText } from "./text.ts";
import { redactText } from "./redact.ts";

export type ReplyIssue =
  | "legal_threat" // sue / lawyer / legal action — never in a public reply
  | "accusation" // fake / liar / fraud / scammer aimed at the reviewer
  | "pressure" // asks the reviewer to remove/change the review in exchange for something
  | "customer_data" // contact details, or a known customer value, in public text
  | "too_long"
  | "empty";

const RULES: { issue: Exclude<ReplyIssue, "customer_data" | "too_long" | "empty">; re: RegExp }[] = [
  { issue: "legal_threat", re: /\b(?:sue|suing|lawsuit|lawyers?|attorneys?|legal action|legal proceedings|defamation|libel|slander|court|police|report you)\b/ },
  { issue: "accusation", re: /\b(?:fake|fraud(?:ulent)?|liar|lying|lied|scam(?:mer)?|extort(?:ion|ing|ionist)?|blackmail|criminal)\b/ },
  { issue: "pressure", re: /\b(?:(?:remove|delete|change|edit|update|withdraw)\b[^.!?]{0,30}\b(?:review|rating)|in exchange|we(?:'ll| will) (?:refund|compensate|pay)[^.!?]{0,30}\b(?:if|when|once) you)\b/ },
];

export const REPLY_MAX_CHARS = 1500; // well under the 4096 DB cap; short public replies read better

export interface ReplyLint {
  ok: boolean;
  /** Hard blockers: the owner cannot approve until they are fixed. */
  issues: ReplyIssue[];
}

export function lintReply(text: string, knownCustomerValues: string[] = []): ReplyLint {
  const issues: ReplyIssue[] = [];
  const raw = String(text ?? "");
  if (!raw.trim()) return { ok: false, issues: ["empty"] };
  if (raw.length > REPLY_MAX_CHARS) issues.push("too_long");
  const norm = normalizeText(raw);
  for (const r of RULES) if (r.re.test(norm)) issues.push(r.issue);
  const red = redactText(raw, { knownValues: knownCustomerValues });
  if (red.counts.email + red.counts.phone + red.counts.address + red.counts.known + red.counts.number > 0) issues.push("customer_data");
  return { ok: issues.length === 0, issues };
}
