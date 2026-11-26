// Redaction rules for the PUBLIC AI incident log. Pure code (no React, no Supabase).
// The automated rules mirror public.ai_incident_public_lint() in
// supabase/migrations/20290312000000_transparency_report.sql: keep the two in step. The database is the authority;
// this file only gives fast feedback and a preview. It is NOT a PII scanner: names, addresses and company details are
// caught only by the human redaction check listed in MANUAL_REDACTION_RULES.

export type RedactionRule = 'email' | 'url' | 'uuid' | 'ip_address' | 'phone_or_long_number';

export interface RedactionIssue {
  rule: RedactionRule;
  match: string;
}

const ISO_DATE = /[0-9]{4}-[0-9]{2}-[0-9]{2}/g;

const PATTERNS: ReadonlyArray<{ rule: RedactionRule; re: RegExp }> = [
  { rule: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { rule: 'url', re: /(?:https?:\/\/|www\.)[^\s]+/gi },
  { rule: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { rule: 'ip_address', re: /(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])/g },
  // Seven or more digits, optionally separated by space, dot, dash or brackets. ISO dates are removed first.
  { rule: 'phone_or_long_number', re: /(?:[0-9][ ().-]?){7,}/g },
];

/** Automated rules, in the order the database applies them. Used to render the rule list next to the form. */
export const AUTOMATED_REDACTION_RULES: readonly RedactionRule[] = PATTERNS.map((p) => p.rule);

/** Rules only a person can apply. Shown to the reviewer before they confirm the redaction check. */
export const MANUAL_REDACTION_RULES = [
  'no_names',
  'no_addresses',
  'no_business_identifiers',
  'no_internal_ids',
  'no_transcript_quotes',
  'no_security_detail',
  'no_speculation',
] as const;
export type ManualRedactionRule = (typeof MANUAL_REDACTION_RULES)[number];

/** All issues found in one text, one entry per match. ISO dates (2026-03-14) are never reported as numbers. */
export function findRedactionIssues(text: string): RedactionIssue[] {
  const issues: RedactionIssue[] = [];
  for (const { rule, re } of PATTERNS) {
    const haystack = rule === 'phone_or_long_number' ? text.replace(ISO_DATE, ' ') : text;
    for (const m of haystack.matchAll(re)) issues.push({ rule, match: m[0].trim() });
  }
  return issues;
}

/** First rule that matches, or null. Same contract as the SQL function. */
export function firstRedactionRule(text: string): RedactionRule | null {
  return findRedactionIssues(text)[0]?.rule ?? null;
}

/** Preview for the reviewer: matches replaced by [rule]. Never used to publish automatically. */
export function redactionPreview(text: string): string {
  let out = text;
  for (const { rule, re } of PATTERNS) {
    if (rule === 'phone_or_long_number') {
      out = out.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}|(?:[0-9][ ().-]?){7,}/g, (m) => (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(m) ? m : `[${rule}]`));
    } else {
      out = out.replace(re, `[${rule}]`);
    }
  }
  return out;
}
