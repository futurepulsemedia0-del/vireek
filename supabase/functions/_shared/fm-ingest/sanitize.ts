// supabase/functions/_shared/fm-ingest/sanitize.ts
//
// Pure inbound-content hygiene for the FM-portal ingestion paths (forwarded email, PDF text).
// No imports, no I/O: runs unchanged in Deno (edge functions), Vitest and the browser.
//
// Everything that arrives from outside is treated as hostile DATA:
//   * HTML is reduced to plain text (active elements dropped WITH their content); nothing here ever
//     returns markup, so a stored value can never become script when rendered by React.
//   * bidi overrides, zero-width and control characters are removed (spoofing / log forging / hidden text).
//   * sizes are capped; the caller must still enforce transport limits before reading a body.

export const MAX_TEXT_CHARS = 200_000; // same ceiling as the pasted-email path in ImportPanel
export const MAX_SUBJECT_CHARS = 300;
export const MAX_ADDRESS_CHARS = 254;

export interface SanitizeStats {
  controlChars: number;
  bidiChars: number;
  invisibleChars: number;
  htmlStripped: boolean;
}
export interface SanitizeResult { text: string; truncated: boolean; stats: SanitizeStats }

const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const INVISIBLE_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
// C0 controls except TAB (09) / LF (0A) / CR (0D), DEL and C1 controls.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const DROP_WITH_CONTENT = /<(script|style|head|template|noscript|iframe|object|embed|svg|math|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>/g;
const BLOCK_BREAK_RE = /<\/?(br|p|div|tr|li|ul|ol|table|h[1-6]|blockquote|section|article|pre|hr)\b[^>]*>/gi;
const CELL_BREAK_RE = /<\/(td|th)\s*>/gi;
const ANY_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const LOOKS_LIKE_HTML_RE = /<\/?[A-Za-z!][^>]*>/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', copy: '(c)', reg: '(R)', trade: '(TM)',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject NUL, controls, surrogates and out-of-range values rather than guessing.
      if (!Number.isInteger(code) || code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** HTML -> plain text. Output never contains angle-bracketed markup that was in the input. */
export function htmlToText(html: string): string {
  let s = html.replace(DROP_WITH_CONTENT, ' ').replace(COMMENT_RE, ' ');
  s = s.replace(CELL_BREAK_RE, '  ').replace(BLOCK_BREAK_RE, '\n').replace(ANY_TAG_RE, ' ');
  // A stray "<" that never closed (truncated message) is dropped with the rest of the line so it cannot hide text.
  s = s.replace(/<[A-Za-z/!][^\n]*$/gm, ' ');
  return decodeEntities(s);
}

/**
 * Cleans untrusted text for storage and display. `maxChars` is enforced AFTER cleaning so that
 * stripped markup does not count against the owner, and BEFORE any regex-heavy work on huge inputs.
 */
export function sanitizeInboundText(raw: unknown, opts: { maxChars?: number; html?: boolean } = {}): SanitizeResult {
  const maxChars = opts.maxChars ?? MAX_TEXT_CHARS;
  const stats: SanitizeStats = { controlChars: 0, bidiChars: 0, invisibleChars: 0, htmlStripped: false };
  if (typeof raw !== 'string' || raw.length === 0) return { text: '', truncated: false, stats };

  // Hard pre-cap (x4) keeps regex work bounded even for multi-megabyte bodies.
  const preCapped = raw.length > maxChars * 4;
  let s = preCapped ? raw.slice(0, maxChars * 4) : raw;

  if (opts.html === true || (opts.html !== false && LOOKS_LIKE_HTML_RE.test(s))) {
    s = htmlToText(s);
    stats.htmlStripped = true;
  }
  s = s.normalize('NFC');
  s = s.replace(BIDI_RE, () => { stats.bidiChars += 1; return ''; });
  s = s.replace(INVISIBLE_RE, () => { stats.invisibleChars += 1; return ''; });
  s = s.replace(CONTROL_RE, () => { stats.controlChars += 1; return ''; });
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t\u00A0]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  let truncated = preCapped;
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    // Do not leave half of a surrogate pair at the cut.
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    truncated = true;
  }
  return { text: s, truncated, stats };
}

/** Single-line header-style value (subject, display name): no line breaks, controls or bidi tricks. */
export function sanitizeHeaderValue(raw: unknown, maxChars = MAX_SUBJECT_CHARS): string {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, maxChars * 2).replace(BIDI_RE, '').replace(INVISIBLE_RE, '').replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** "Name <a@b.com>" or "a@b.com" -> lower-cased a@b.com, or null when it is not a plain, single address. */
export function extractEmailAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 600) return null;
  // Exactly one address: a second '@' or a second angle group means a list / smuggled recipient.
  if ((raw.match(/@/g) ?? []).length !== 1 || (raw.match(/</g) ?? []).length > 1) return null;
  const angle = raw.match(/<([^<>]+)>\s*$/);
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase();
  if (candidate.length > MAX_ADDRESS_CHARS || /[\s,;<>"()\\]/.test(candidate)) return null;
  return ADDRESS_RE.test(candidate) ? candidate : null;
}

/** Display-safe file name: no path, no control characters, ASCII-only allow-list, never empty. */
export function sanitizeFileName(raw: unknown, fallback = 'upload'): string {
  if (typeof raw !== 'string') return fallback;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.normalize('NFKD').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[.\s_-]+/, '').trim().slice(0, 100);
  return cleaned || fallback;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
