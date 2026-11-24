/**
 * Customer PO-format patterns (PURE). The same text is evaluated by Postgres (`~`, POSIX ARE) in the
 * database gate and by JavaScript in the UI preview, so only a PORTABLE subset is accepted:
 * literals, `.`, `^ $`, `[]` classes, `\d \w \s`, `* + ? {m,n}`, `|`, plain groups.
 * Rejected: lookaround / flags `(?`, back-references, POSIX classes `[[:`, and nested quantifiers (ReDoS shape).
 */
export const MAX_PO_REGEX_LENGTH = 120;

export type RegexIssue = 'empty' | 'too_long' | 'unsupported_syntax' | 'nested_quantifier' | 'invalid';
export type RegexCheck = { ok: true } | { ok: false; issue: RegexIssue };

export function validatePoRegex(src: string): RegexCheck {
  if (src.trim().length === 0) return { ok: false, issue: 'empty' };
  if (src.length > MAX_PO_REGEX_LENGTH) return { ok: false, issue: 'too_long' };
  if (/\(\?/.test(src) || /\\[1-9]/.test(src) || /\[\[:/.test(src) || /\\[pPkK]/.test(src)) return { ok: false, issue: 'unsupported_syntax' };
  // a quantified group that itself contains a quantifier, e.g. (a+)+ or (a*)* or (a|b+){2,}
  if (/\([^()]*(?:[+*]|\{\d+,?\d*\})[^()]*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(src)) return { ok: false, issue: 'nested_quantifier' };
  try {
    new RegExp(src);
  } catch {
    return { ok: false, issue: 'invalid' };
  }
  return { ok: true };
}

/** Unanchored search, like Postgres `~`. An invalid or unsafe pattern never matches AND never throws. */
export function matchesPoFormat(po: string, src: string): boolean | null {
  if (!validatePoRegex(src).ok) return null;
  return new RegExp(src).test(po);
}
