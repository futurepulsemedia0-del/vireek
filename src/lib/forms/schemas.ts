// Shared zod building blocks. Imports only zod + libphonenumber-js + pure helpers,
// so the same schemas can run in Vite and (via npm: specifiers) in Supabase edge functions.
// Messages are i18n KEYS (see errors.ts); the UI translates them.

import { z } from 'zod';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { msg } from './errors';
import { isValidCalendarDate } from './masks';
import { toLatinDigits } from './text';

type Req = { required?: boolean };

const blank = (v: string) => v.trim() === '';

export function textField(o: Req & { min?: number; max?: number; requiredKey?: string } = {}) {
  const max = o.max ?? 200;
  return z
    .string()
    .trim()
    .max(max, msg('forms.errors.tooLong', { max }))
    .superRefine((v, ctx) => {
      if (blank(v) && o.required !== false) ctx.addIssue({ code: 'custom', message: msg(o.requiredKey ?? 'forms.errors.required') });
      else if (!blank(v) && o.min && v.length < o.min) ctx.addIssue({ code: 'custom', message: msg('forms.errors.tooShort', { min: o.min }) });
    });
}

export function emailField(o: Req = {}) {
  return z
    .string()
    .trim()
    .toLowerCase()
    .superRefine((v, ctx) => {
      if (blank(v)) {
        if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.emailRequired') });
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) ctx.addIssue({ code: 'custom', message: msg('forms.errors.email') });
    });
}

/** Output is E.164 ("+15551234567"), or "" when optional and empty. */
export function phoneField(o: Req & { defaultCountry: CountryCode }) {
  return z.string().transform((raw, ctx) => {
    const v = toLatinDigits(raw).trim();
    if (v === '' || v === '+') {
      if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.phoneRequired') });
      return '';
    }
    const parsed = parsePhoneNumberFromString(v, o.defaultCountry);
    if (parsed?.isValid()) return parsed.number;
    const digits = v.replace(/\D/g, '');
    ctx.addIssue({ code: 'custom', message: msg(digits.length < 7 ? 'forms.errors.phoneTooShort' : 'forms.errors.phoneInvalid') });
    return '';
  });
}

/** Input "1234.5" (canonical decimal text) -> integer minor units (123450 cents). */
export function moneyField(o: Req & { min?: number; max?: number; fractionDigits?: number } = {}) {
  const digits = o.fractionDigits ?? 2;
  return z.string().transform((raw, ctx) => {
    const v = raw.trim();
    if (v === '') {
      if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.amountRequired') });
      return 0;
    }
    const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(v);
    if (!m) {
      ctx.addIssue({ code: 'custom', message: msg('forms.errors.amountInvalid') });
      return 0;
    }
    const minor = Number(m[1]) * 10 ** digits + Number((m[2] ?? '').padEnd(digits, '0').slice(0, digits) || '0');
    if (o.min !== undefined && minor < o.min) ctx.addIssue({ code: 'custom', message: msg('forms.errors.amountTooSmall', { min: o.min / 10 ** digits }) });
    if (o.max !== undefined && minor > o.max) ctx.addIssue({ code: 'custom', message: msg('forms.errors.amountTooBig', { max: o.max / 10 ** digits }) });
    return minor;
  });
}

export function percentField(o: Req & { min?: number; max?: number } = {}) {
  const min = o.min ?? 0;
  const max = o.max ?? 100;
  return z.string().transform((raw, ctx) => {
    const v = raw.trim();
    if (v === '') {
      if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.percentRequired') });
      return 0;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: msg('forms.errors.percentRange', { min, max }) });
      return 0;
    }
    return n;
  });
}

/** Input is the date mask's canonical value (ISO once complete). Output is the ISO string. */
export function dateField(o: Req & { min?: string; max?: string } = {}) {
  return z.string().transform((raw, ctx) => {
    const v = raw.trim();
    if (v === '') {
      if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.dateRequired') });
      return '';
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) {
      ctx.addIssue({ code: 'custom', message: msg('forms.errors.dateIncomplete') });
      return '';
    }
    if (!isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
      ctx.addIssue({ code: 'custom', message: msg('forms.errors.dateInvalid') });
      return '';
    }
    if (o.min && v < o.min) ctx.addIssue({ code: 'custom', message: msg('forms.errors.dateTooEarly', { date: o.min }) });
    if (o.max && v > o.max) ctx.addIssue({ code: 'custom', message: msg('forms.errors.dateTooLate', { date: o.max }) });
    return v;
  });
}

const POSTAL: Record<string, RegExp> = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Z]\d[A-Z] \d[A-Z]\d$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/,
  NL: /^\d{4} [A-Z]{2}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  ES: /^\d{5}$/,
  IT: /^\d{5}$/,
  AU: /^\d{4}$/,
};

export function postalField(country: string, o: Req = {}) {
  const re = POSTAL[country.toUpperCase()];
  return z.string().superRefine((raw, ctx) => {
    const v = toLatinDigits(raw).trim().toUpperCase();
    if (v === '') {
      if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.postalRequired') });
    } else if (re ? !re.test(v) : v.length < 3 || v.length > 10) {
      ctx.addIssue({ code: 'custom', message: msg('forms.errors.postalInvalid') });
    }
  });
}

export function licenseField(o: Req & { min?: number; max?: number } = {}) {
  const min = o.min ?? 4;
  const max = o.max ?? 24;
  return z.string().superRefine((raw, ctx) => {
    const v = raw.trim();
    if (v === '') {
      if (o.required !== false) ctx.addIssue({ code: 'custom', message: msg('forms.errors.licenseRequired') });
    } else if (!/^[A-Z0-9-]+$/.test(v) || v.length < min || v.length > max) {
      ctx.addIssue({ code: 'custom', message: msg('forms.errors.licenseInvalid', { min, max }) });
    }
  });
}

export const consentField = (key = 'forms.errors.consentRequired') =>
  z.boolean().refine((v) => v === true, { message: msg(key) });
