/* ------------------------------------------------------------------ */
/*  format — locale-aware number / currency / date / relative-time     */
/*                                                                      */
/*  Single source of truth for every user-visible number and date.      */
/*  The active locale comes from react-i18next (which AccessibilityContext*/
/*  keeps in sync with the Account → Language switcher), so these work  */
/*  from plain modules as well as from components.                      */
/*                                                                      */
/*  Policy (change in ONE place):                                       */
/*   - Calendar: Gregorian everywhere, so dates always match the         */
/*     Calendar page and the database. To show Persian (Jalali) dates   */
/*     for fa, set CALENDAR_OVERRIDES.fa = 'persian'.                   */
/*   - Digits: fa → Persian digits, ar → Latin digits (the norm in      */
/*     Arabic-language business software), everything else → native.    */
/* ------------------------------------------------------------------ */

import i18n from '@/i18n';
import { DEFAULT_LANGUAGE, LOCALE_TAGS, type LanguageCode } from '@/lib/i18n';
import { getActiveRegional } from '@/lib/regional';

export const CALENDAR_OVERRIDES: Partial<Record<LanguageCode, string>> = {};
export const NUMBERING_OVERRIDES: Partial<Record<LanguageCode, string>> = {
  ar: 'latn',
  fa: 'arabext',
};

export type DateInput = Date | number | string | null | undefined;
export const EMPTY_VALUE = '—';

function toBaseLanguage(lang?: string | null): LanguageCode {
  const base = (lang ?? '').slice(0, 2).toLowerCase() as LanguageCode;
  return base in LOCALE_TAGS ? base : DEFAULT_LANGUAGE;
}

/** Full BCP-47 tag (with calendar + numbering extensions) for `lang`. */
export function resolveLocale(lang?: string | null): string {
  const base = toBaseLanguage(lang ?? i18n.resolvedLanguage ?? i18n.language);
  const ext = [
    `ca-${CALENDAR_OVERRIDES[base] ?? 'gregory'}`,
    NUMBERING_OVERRIDES[base] ? `nu-${NUMBERING_OVERRIDES[base]}` : null,
  ]
    .filter(Boolean)
    .join('-');
  return `${LOCALE_TAGS[base]}-u-${ext}`;
}

/** The locale tag to pass to any native Intl / toLocale*String call. */
export function getActiveLocale(): string {
  return resolveLocale();
}

/* ---- Intl instance cache (constructing Intl objects is expensive) ---- */

const nfCache = new Map<string, Intl.NumberFormat>();
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getNumberFormat(locale: string, options?: Intl.NumberFormatOptions) {
  const key = `${locale}|${JSON.stringify(options ?? {})}`;
  let nf = nfCache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, options);
    nfCache.set(key, nf);
  }
  return nf;
}

/** Applies the organization's clock style (12h/24h) unless the caller chose one. */
function withOrgDefaults(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions | undefined {
  if (!options || options.hour12 !== undefined || options.hourCycle !== undefined) return options;
  if (!options.timeStyle && !options.hour) return options;
  const cycle = getActiveRegional().hourCycle;
  if (cycle === '12h') return { ...options, hourCycle: 'h12' };
  if (cycle === '24h') return { ...options, hourCycle: 'h23' };
  return options;
}

function getDateTimeFormat(locale: string, rawOptions?: Intl.DateTimeFormatOptions) {
  const options = withOrgDefaults(rawOptions);
  const key = `${locale}|${JSON.stringify(options ?? {})}`;
  let dtf = dtfCache.get(key);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(locale, options);
    dtfCache.set(key, dtf);
  }
  return dtf;
}

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ---- Numbers ---- */

export function formatNumber(
  value: number | null | undefined,
  options?: Intl.NumberFormatOptions,
  lang?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_VALUE;
  return getNumberFormat(resolveLocale(lang), options).format(value);
}

/** `ratio` is a fraction: 0.684 → "68%". */
export function formatPercent(
  ratio: number | null | undefined,
  options?: Intl.NumberFormatOptions,
  lang?: string,
): string {
  return formatNumber(ratio, { style: 'percent', maximumFractionDigits: 0, ...options }, lang);
}

export function formatCompact(value: number | null | undefined, lang?: string): string {
  return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 }, lang);
}

/** `amount` is already in `currency` (no FX conversion). */
export function formatCurrency(
  amount: number | null | undefined,
  currency = 'USD',
  options?: Intl.NumberFormatOptions,
  lang?: string,
): string {
  try {
    return formatNumber(amount, { style: 'currency', currency, ...options }, lang);
  } catch {
    return formatNumber(amount, options, lang);
  }
}

/* ---- Dates & times ---- */

export type DatePreset = 'short' | 'medium' | 'long' | 'full';

function dateOptions(style: DatePreset | Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  return typeof style === 'string' ? { dateStyle: style } : style;
}

export function formatDate(
  value: DateInput,
  style: DatePreset | Intl.DateTimeFormatOptions = 'medium',
  lang?: string,
): string {
  const d = toDate(value);
  return d ? getDateTimeFormat(resolveLocale(lang), dateOptions(style)).format(d) : EMPTY_VALUE;
}

export function formatTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { timeStyle: 'short' },
  lang?: string,
): string {
  const d = toDate(value);
  return d ? getDateTimeFormat(resolveLocale(lang), options).format(d) : EMPTY_VALUE;
}

export function formatDateTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  lang?: string,
): string {
  const d = toDate(value);
  return d ? getDateTimeFormat(resolveLocale(lang), options).format(d) : EMPTY_VALUE;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/** "2 hours ago" / "in 3 days", localized. */
export function formatRelativeTime(value: DateInput, now: number = Date.now(), lang?: string): string {
  const d = toDate(value);
  if (!d) return EMPTY_VALUE;
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  const [unit, secs] = RELATIVE_UNITS.find(([, s]) => abs >= s) ?? ['second', 1];
  return new Intl.RelativeTimeFormat(resolveLocale(lang), { numeric: 'auto' }).format(
    Math.round(diffSec / secs),
    unit,
  );
}

export type ListType = 'conjunction' | 'disjunction' | 'unit';

type ListFormatCtor = new (
  locale: string,
  options: { style: 'long'; type: ListType },
) => { format(items: string[]): string };

/** "A, B, and C" / "A, B und C" — Intl.ListFormat is not in every TS lib target, so it is feature-detected. */
export function formatList(items: string[], type: ListType = 'conjunction', lang?: string): string {
  const Ctor = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  if (!Ctor) return items.join(', ');
  return new Ctor(resolveLocale(lang), { style: 'long', type }).format(items);
}
/* ---- Relative time with an absolute-date cutoff ---- */

export interface RelativeOptions {
  now?: number;
  lang?: string;
  /** Show an absolute date once the gap is this large or larger. Default: 7 days. */
  absoluteAfterMs?: number;
  absoluteStyle?: DatePreset;
}

const DEFAULT_ABSOLUTE_AFTER_MS = 7 * 86_400_000;
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

/**
 * "now" / "5 minutes ago" / "in 3 hours", switching to "Oct 11, 2026" after the cutoff.
 * Pair with <RelativeTime> for live updates and an exact-time tooltip.
 */
export function formatRelative(value: DateInput, options: RelativeOptions = {}): string {
  const d = toDate(value);
  if (!d) return EMPTY_VALUE;
  const now = options.now ?? Date.now();
  const diff = d.getTime() - now;
  if (Math.abs(diff) >= (options.absoluteAfterMs ?? DEFAULT_ABSOLUTE_AFTER_MS)) {
    return formatDate(d, options.absoluteStyle ?? 'medium', options.lang);
  }
  if (Math.abs(diff) < 45_000) {
    const locale = resolveLocale(options.lang);
    let rtf = rtfCache.get(locale);
    if (!rtf) {
      rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      rtfCache.set(locale, rtf);
    }
    return rtf.format(0, 'second');
  }
  return formatRelativeTime(d, now, options.lang);
}

/* ---- Durations ---- */

export interface DurationOptions {
  style?: 'narrow' | 'short' | 'long';
  /** Largest N non-zero units to show (truncates, never rounds up). Default 2. */
  maxUnits?: number;
  lang?: string;
}

const DURATION_UNITS: ['day' | 'hour' | 'minute' | 'second', number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/** 4500 → "1 hr, 15 min" (localized). Negative values clamp to 0. */
export function formatDuration(seconds: number | null | undefined, options: DurationOptions = {}): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EMPTY_VALUE;
  const style = options.style ?? 'short';
  const max = Math.max(1, options.maxUnits ?? 2);
  let rest = Math.max(0, Math.round(seconds));
  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 && parts.length < max) {
      parts.push(formatNumber(n, { style: 'unit', unit, unitDisplay: style, maximumFractionDigits: 0 }, options.lang));
    }
  }
  if (parts.length === 0) {
    return formatNumber(0, { style: 'unit', unit: 'second', unitDisplay: style }, options.lang);
  }
  return formatList(parts, 'unit', options.lang);
}

/* ---- Phone numbers ---- */

/**
 * US/Canada (NANP) numbers → "(415) 555-0132". Every other number is returned as
 * normalized "+digits" — no guessed grouping, because wrong grouping is worse than none.
 * Input with letters, extensions or symbols is returned as typed. In RTL UIs render
 * the result inside <Bidi> so the digits keep their order.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return EMPTY_VALUE;
  const text = raw.trim();
  if (/[A-Za-z#*]/.test(text)) return text;
  const digits = text.replace(/\D/g, '');
  const plus = text.startsWith('+');
  if (digits.length < 7) return text;
  const national =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : !plus && digits.length === 10 ? digits : null;
  if (national) return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  return plus ? `+${digits}` : digits;
}
