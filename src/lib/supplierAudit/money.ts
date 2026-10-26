/** Integer-cent money + calendar-date helpers. No floats leak into stored values. */

/** Round-half-away-from-zero to integer cents (stable for negatives). */
export function roundCents(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** cents × basis-points / 10_000, rounded once at the end. */
export function mulBps(cents: number, bps: number): number {
  return roundCents((cents * bps) / 10000);
}

export function formatMoney(cents: number, currency = 'USD', locale = 'en-US'): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(safe / 100);
  } catch {
    return `${(safe / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Parses a money string to integer cents, or null when it cannot be read with certainty.
 * Never guesses: "12,5" (ambiguous) and "1.2.3" return null. Parentheses / trailing "-" mean negative.
 */
export function parseMoneyToCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? roundCents(raw * 100) : null;
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg ? true : neg; s = s.slice(1); }
  s = s.replace(/[A-Za-z$€£\s]/g, '');
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart: string; let frac = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    const thou = dec === lastDot ? ',' : '.';
    const decChar = dec === lastDot ? '.' : ',';
    if (s.split(decChar).length !== 2) return null;
    intPart = s.slice(0, dec).split(thou).join('');
    frac = s.slice(dec + 1);
    if (/[.,]/.test(intPart)) return null;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const ch = lastDot >= 0 ? '.' : ',';
    const parts = s.split(ch);
    if (parts.length === 2 && (parts[1].length === 2 || (ch === '.' && parts[1].length === 1))) { intPart = parts[0]; frac = parts[1]; }
    else if (parts.length >= 2 && parts.slice(1).every((p) => p.length === 3) && parts[0].length >= 1 && parts[0].length <= 3) {
      intPart = parts.join(''); // thousands separators only
    } else return null;
  } else intPart = s;
  if (!/^[0-9]+$/.test(intPart) || (frac && !/^[0-9]{1,2}$/.test(frac))) return null;
  const cents = Number(intPart) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

// ---------- calendar dates (timezone-safe: only YYYY-MM-DD strings, UTC arithmetic) ----------
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = YMD.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtcDay(ymd: string): number {
  const m = YMD.exec(ymd)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000;
}

/** Whole days from a to b (b - a). Both must be valid YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round(toUtcDay(b) - toUtcDay(a));
}

export function addDays(ymd: string, n: number): string {
  const t = new Date((toUtcDay(ymd) + n) * 86_400_000);
  return t.toISOString().slice(0, 10);
}

export function addMonths(ymd: string, n: number): string {
  const m = YMD.exec(ymd)!;
  const total = +m[1] * 12 + (+m[2] - 1) + n;
  const y = Math.floor(total / 12); const mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(+m[3], last);
  return `${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Today's calendar date in the account's time zone (deadlines are end-of-day LOCAL, never UTC). */
export function todayInZone(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const g = (t: string) => parts.find((p) => p.type === t)!.value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Stable, order-independent FNV-1a hash (used for finding fingerprints; not security-relevant). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Invoice number normalisation: case/space/punctuation-insensitive, leading zeros dropped. */
export function normInvoiceNo(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=[A-Z0-9])/, '');
}

export function normName(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|ltd|co|corp|company|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
