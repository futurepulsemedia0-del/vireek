// Caret-safe input masks. Pure functions: no React, no DOM.
//
// A Mask turns whatever the user typed/pasted into:
//   display - what the <input> shows (formatted, Latin digits)
//   value   - the canonical text stored in form state
// `computeNext` keeps the caret next to the character the user just
// typed, even when formatting inserts or removes separators before it.

import { cleanPasted, toLatinDigits } from './text';

export interface MaskResult {
  display: string;
  value: string;
}

export interface Mask {
  inputMode: 'text' | 'numeric' | 'decimal' | 'tel';
  /** A localized example, suitable for a placeholder (never a label). */
  example?: string;
  /** Maximum useful display length (used for maxLength). */
  maxLength?: number;
  format(raw: string): MaskResult;
  /** Display text for a stored canonical value (reset / draft restore). */
  fromValue(value: string): string;
  /** Characters that carry information; everything else is decoration. */
  isSignificant(ch: string): boolean;
  /** Optional tidy-up on blur (e.g. pad decimals). */
  finalize?(display: string): MaskResult;
  /** Optional paste-only normalization applied to the clipboard text before it is inserted. */
  normalizePaste?(text: string): string;
}

/* ------------------------------------------------------------------ */
/*  Caret engine                                                       */
/* ------------------------------------------------------------------ */

export type DeleteDirection = 'backward' | 'forward' | false;

export interface NextInput extends MaskResult {
  caret: number;
}

export function countSignificant(mask: Mask, text: string): number {
  let n = 0;
  for (const ch of text) if (mask.isSignificant(ch)) n++;
  return n;
}

export function computeNext(
  mask: Mask,
  p: { prevDisplay: string; rawInput: string; caret: number; deleting?: DeleteDirection },
): NextInput {
  let raw = p.rawInput;
  let caret = Math.max(0, Math.min(p.caret, raw.length));

  // Deleting only decoration (a ")" or a space) would be undone by
  // re-formatting and the caret would appear stuck: delete the nearest
  // significant character instead.
  if (p.deleting && countSignificant(mask, mask.format(raw).display) === countSignificant(mask, p.prevDisplay)) {
    if (p.deleting === 'backward') {
      let i = caret - 1;
      while (i >= 0 && !mask.isSignificant(raw.charAt(i))) i--;
      if (i >= 0) {
        raw = raw.slice(0, i) + raw.slice(i + 1);
        caret = i;
      }
    } else {
      let i = caret;
      while (i < raw.length && !mask.isSignificant(raw.charAt(i))) i++;
      if (i < raw.length) raw = raw.slice(0, i) + raw.slice(i + 1);
    }
  }

  // How many *accepted* significant chars sit before the caret?
  const sigBefore = countSignificant(mask, mask.format(raw.slice(0, caret)).display);
  const { display, value } = mask.format(raw);

  let out = 0;
  if (sigBefore > 0) {
    let seen = 0;
    out = display.length;
    for (let i = 0; i < display.length; i++) {
      if (mask.isSignificant(display.charAt(i)) && ++seen === sigBefore) {
        out = i + 1;
        break;
      }
    }
  }
  return { display, value, caret: out };
}

/* ------------------------------------------------------------------ */
/*  Pattern masks  (# digit · A letter · * letter-or-digit · literal)  */
/* ------------------------------------------------------------------ */

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isLetter = (ch: string) => /^\p{L}$/u.test(ch);
const isAlnum = (ch: string) => isDigit(ch) || isLetter(ch);
const isSlot = (ch: string) => ch === '#' || ch === 'A' || ch === '*';

function slotAccepts(slot: string, ch: string): boolean {
  if (slot === '#') return isDigit(ch);
  if (slot === 'A') return isLetter(ch);
  return isAlnum(ch);
}

interface PatternOptions {
  upper?: boolean;
  example?: string;
  inputMode?: Mask['inputMode'];
  /** 'display' keeps literals in the stored value (postal codes); 'raw' drops them. */
  canonical?: 'display' | 'raw';
}

export function patternMask(pattern: string, opts: PatternOptions = {}): Mask {
  const canonical = opts.canonical ?? 'display';
  const format = (input: string): MaskResult => {
    const text = toLatinDigits(cleanPasted(input));
    let display = '';
    let raw = '';
    let pending = '';
    let pi = 0;
    for (const original of text) {
      while (pi < pattern.length && !isSlot(pattern.charAt(pi))) {
        pending += pattern.charAt(pi);
        pi++;
      }
      if (pi >= pattern.length) break;
      const ch = opts.upper ? original.toUpperCase() : original;
      if (!slotAccepts(pattern.charAt(pi), ch)) continue;
      display += pending + ch;
      raw += ch;
      pending = '';
      pi++;
    }
    return { display, value: canonical === 'display' ? display : raw };
  };
  return {
    inputMode: opts.inputMode ?? 'text',
    example: opts.example,
    maxLength: pattern.length,
    format,
    fromValue: (v) => format(v).display,
    isSignificant: (ch) => isAlnum(toLatinDigits(ch)),
  };
}

/** Free-form uppercase alphanumeric mask (license / permit / policy numbers). */
export function licenseMask(opts: { maxLength?: number; example?: string } = {}): Mask {
  const max = opts.maxLength ?? 24;
  const format = (input: string): MaskResult => {
    const text = toLatinDigits(cleanPasted(input)).toUpperCase();
    let out = '';
    for (const ch of text) {
      if ((isAlnum(ch) || ch === '-') && out.length < max) out += ch;
    }
    out = out.replace(/-{2,}/g, '-');
    return { display: out, value: out };
  };
  return {
    inputMode: 'text',
    example: opts.example,
    maxLength: max,
    format,
    fromValue: (v) => format(v).display,
    isSignificant: (ch) => isAlnum(toLatinDigits(ch)),
  };
}

/* ------------------------------------------------------------------ */
/*  Postal / ZIP codes                                                 */
/* ------------------------------------------------------------------ */

function ukPostalMask(): Mask {
  const format = (input: string): MaskResult => {
    const compact = toLatinDigits(cleanPasted(input))
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 7);
    const display = compact.length > 3 ? `${compact.slice(0, compact.length - 3)} ${compact.slice(-3)}` : compact;
    return { display, value: display };
  };
  return {
    inputMode: 'text',
    example: 'SW1A 1AA',
    maxLength: 8,
    format,
    fromValue: (v) => format(v).display,
    isSignificant: (ch) => isAlnum(toLatinDigits(ch)),
  };
}

export function postalMask(country: string): Mask {
  switch (country.toUpperCase()) {
    case 'US':
      return patternMask('#####-####', { inputMode: 'numeric', example: '90210' });
    case 'CA':
      return patternMask('A#A #A#', { upper: true, example: 'K1A 0B1' });
    case 'GB':
      return ukPostalMask();
    case 'NL':
      return patternMask('#### AA', { upper: true, example: '1011 AB' });
    case 'DE':
    case 'FR':
    case 'ES':
    case 'IT':
      return patternMask('#####', { inputMode: 'numeric', example: '10115' });
    case 'AU':
      return patternMask('####', { inputMode: 'numeric', example: '2000' });
    default:
      return licenseMask({ maxLength: 10 });
  }
}

/* ------------------------------------------------------------------ */
/*  Decimal / currency / percent                                       */
/* ------------------------------------------------------------------ */

function baseLocale(locale: string): string {
  return locale.split('-u-')[0] || 'en-US';
}

function safeLocale(locale: string): string {
  try {
    return Intl.NumberFormat.supportedLocalesOf(`${baseLocale(locale)}-u-nu-latn`)[0] ?? 'en-US-u-nu-latn';
  } catch {
    return 'en-US-u-nu-latn';
  }
}

export interface DecimalMaskOptions {
  /** Max digits after the decimal separator (0 for JPY-like currencies). */
  maxFractionDigits: number;
  /** Digits always shown after blur (currency: 2). Defaults to 0. */
  minFractionDigits?: number;
  maxIntegerDigits?: number;
  example?: string;
}

export function decimalMask(locale: string, opts: DecimalMaskOptions): Mask {
  const nfLocale = safeLocale(locale);
  const parts = new Intl.NumberFormat(nfLocale).formatToParts(1234.5);
  const decSep = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const nf = new Intl.NumberFormat(nfLocale, { maximumFractionDigits: 0, useGrouping: true });
  const maxInt = opts.maxIntegerDigits ?? 12;
  const minFrac = opts.minFractionDigits ?? 0;
  const otherSep = decSep === '.' ? ',' : '.';

  const build = (intDigits: string, frac: string, hasDecimal: boolean): MaskResult => {
    if (intDigits === '' && !hasDecimal) return { display: '', value: '' };
    const intNorm = (intDigits.replace(/^0+(?=\d)/, '') || '0').slice(0, maxInt);
    const grouped = nf.format(BigInt(intNorm));
    const f = frac.slice(0, opts.maxFractionDigits);
    const display = `${grouped}${hasDecimal && opts.maxFractionDigits > 0 ? decSep + f : ''}`;
    const value = f.length > 0 ? `${intNorm}.${f}` : intNorm;
    return { display, value };
  };

  const format = (input: string): MaskResult => {
    const text = toLatinDigits(cleanPasted(input)).replace(/\s/g, '');
    let intDigits = '';
    let frac = '';
    let hasDecimal = false;
    for (const ch of text) {
      if (isDigit(ch)) {
        if (hasDecimal) frac += ch;
        else intDigits += ch;
      } else if (ch === decSep && !hasDecimal && opts.maxFractionDigits > 0) {
        hasDecimal = true;
      }
    }
    return build(intDigits, frac, hasDecimal);
  };

  return {
    inputMode: opts.maxFractionDigits > 0 ? 'decimal' : 'numeric',
    example: opts.example,
    format,
    fromValue: (v) => {
      const [i = '', f = ''] = toLatinDigits(v).split('.');
      return build(i.replace(/\D/g, ''), f.replace(/\D/g, ''), f.length > 0).display;
    },
    isSignificant: (ch) => isDigit(toLatinDigits(ch)) || ch === decSep,
    // Clipboard heuristic (NOT applied while typing, or "1,234" + Backspace would become 1.23):
    // a lone "other" separator followed by 1-2 digits and no real decimal separator
    // is a decimal point, e.g. "1234.5" pasted into a "," locale.
    normalizePaste: (pasted) => {
      const text = toLatinDigits(cleanPasted(pasted)).replace(/\s/g, '');
      if (text.split(otherSep).length === 2 && !text.includes(decSep)) {
        const tail = text.slice(text.indexOf(otherSep) + 1);
        if (/^\d{1,2}$/.test(tail)) return text.replace(otherSep, decSep);
      }
      return text;
    },
    finalize: (display) => {
      const r = format(display);
      if (r.value === '' || minFrac === 0) return r;
      const [i = '0', f = ''] = r.value.split('.');
      return build(i, f.padEnd(minFrac, '0'), true);
    },
  };
}

export function currencyMask(locale: string, currency: string): Mask {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat(safeLocale(locale), { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* unknown currency code: assume 2 */
  }
  return decimalMask(locale, { maxFractionDigits: digits, minFractionDigits: digits });
}

export function percentMask(locale: string): Mask {
  return decimalMask(locale, { maxFractionDigits: 2, maxIntegerDigits: 3 });
}

/* ------------------------------------------------------------------ */
/*  Dates                                                              */
/* ------------------------------------------------------------------ */

export function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Canonical value is ISO `YYYY-MM-DD` once the date is complete and real; otherwise the partial display. */
export function dateMask(locale: string): Mask {
  const dtf = new Intl.DateTimeFormat(safeLocale(locale), { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' });
  const order: Array<'day' | 'month' | 'year'> = [];
  const seps: string[] = [];
  for (const p of dtf.formatToParts(new Date(Date.UTC(2024, 2, 15)))) {
    if (p.type === 'day' || p.type === 'month' || p.type === 'year') order.push(p.type);
    else if (p.type === 'literal') seps.push(p.value.trim() || '/');
  }
  const sizes = { day: 2, month: 2, year: 4 } as const;
  const pattern = order.map((t, i) => '#'.repeat(sizes[t]) + (i < order.length - 1 ? (seps[i] ?? '/') : '')).join('');
  const inner = patternMask(pattern, { inputMode: 'numeric' });

  const toIso = (display: string): string | null => {
    const digits = display.replace(/\D/g, '');
    if (digits.length !== 8) return null;
    let at = 0;
    const got: Record<string, number> = {};
    for (const t of order) {
      got[t] = Number(digits.slice(at, at + sizes[t]));
      at += sizes[t];
    }
    if (!isValidCalendarDate(got.year ?? 0, got.month ?? 0, got.day ?? 0)) return null;
    return `${String(got.year).padStart(4, '0')}-${String(got.month).padStart(2, '0')}-${String(got.day).padStart(2, '0')}`;
  };

  const fromIso = (iso: string): string | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const map = { year: m[1] ?? '', month: m[2] ?? '', day: m[3] ?? '' };
    return inner.format(order.map((t) => map[t]).join('')).display;
  };

  return {
    inputMode: 'numeric',
    example: dtf.format(new Date(Date.UTC(2024, 2, 15))),
    maxLength: pattern.length,
    format: (raw) => {
      const { display } = inner.format(raw);
      return { display, value: toIso(display) ?? display };
    },
    fromValue: (v) => fromIso(v) ?? inner.format(v).display,
    isSignificant: inner.isSignificant,
  };
}
