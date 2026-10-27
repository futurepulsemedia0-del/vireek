// Pure phone detection / normalisation (no DOM, no chrome.*). Shared by content script, popup, tests.

const E164 = /^\+[1-9]\d{7,14}$/;

/** "+1 (555) 123-4567", "555.123.4567", "00 44 20 7946 0958" -> E.164 or null. */
export function toE164(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 40) return null;
  const d = t.replace(/\D/g, '');
  if (t.startsWith('+')) return E164.test(`+${d}`) ? `+${d}` : null;
  if (d.startsWith('00')) return E164.test(`+${d.slice(2)}`) ? `+${d.slice(2)}` : null;
  if (d.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return `+1${d}`;
  if (d.length === 11 && /^1[2-9]\d{2}[2-9]\d{6}$/.test(d)) return `+${d}`;
  return null;
}

export const formatPhone = (e164) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? '');
};

// Formatted candidates only: bare digit runs (ids, prices, dates) are never treated as phones.
const CANDIDATE =
  /(?<![\w@./-])(?:\+\d{1,3}[ . -]?)?(?:\(\d{2,4}\)|\d{2,4})[ . -]\d{2,4}(?:[ . -]\d{2,4}){1,3}(?![\w@-])/g;
const DATE_LIKE = /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/;

/** Returns [{ start, end, raw, e164 }] in text order, non-overlapping, max `limit`. */
export function findPhones(text, limit = 20) {
  if (typeof text !== 'string' || text.length < 7 || text.length > 20000) return [];
  const out = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[0].trim();
    if (DATE_LIKE.test(raw)) continue;
    const e164 = toE164(raw);
    if (!e164) continue;
    out.push({ start: m.index, end: m.index + m[0].length, raw, e164 });
    if (out.length >= limit) break;
  }
  return out;
}

export function phoneFromTelHref(href) {
  if (typeof href !== 'string' || !/^tel:/i.test(href)) return null;
  try {
    return toE164(decodeURIComponent(href.slice(4).split(/[;?,]/)[0]));
  } catch {
    return null;
  }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const findEmails = (text, limit = 5) =>
  [...new Set((typeof text === 'string' ? text.slice(0, 20000) : '').match(EMAIL) ?? [])].slice(
    0,
    limit,
  );
