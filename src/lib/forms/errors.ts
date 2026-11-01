// i18n-aware validation messages.
//
// Zod / RHF only carry a plain string per error, so schemas emit a message
// KEY (optionally with params) and <TextField> translates it at render time.
// That keeps schemas free of React/i18n and shareable with edge functions.

import type { ZodErrorMap } from 'zod';

export interface FormMessage {
  key: string;
  params?: Record<string, string | number>;
}

/** Separator unlikely to appear in an i18n key. */
const SEP = '\u241E';

export function msg(key: string, params?: Record<string, string | number>): string {
  return params && Object.keys(params).length > 0 ? `${key}${SEP}${JSON.stringify(params)}` : key;
}

export function parseMsg(raw: string): FormMessage {
  const i = raw.indexOf(SEP);
  if (i < 0) return { key: raw };
  const key = raw.slice(0, i);
  try {
    const parsed: unknown = JSON.parse(raw.slice(i + 1));
    if (parsed && typeof parsed === 'object') {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') params[k] = v;
      }
      return { key, params };
    }
  } catch {
    /* fall through to key-only */
  }
  return { key };
}

/**
 * Default zod error map: every built-in issue becomes an actionable,
 * localizable key. Never falls back to zod's English "Invalid input".
 */
export const formErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case 'invalid_type':
      return {
        message:
          ctx.data === undefined || ctx.data === null || ctx.data === ''
            ? msg('forms.errors.required')
            : msg('forms.errors.checkAndRetry'),
      };
    case 'too_small':
      if (issue.type === 'string') {
        return {
          message:
            Number(issue.minimum) <= 1
              ? msg('forms.errors.required')
              : msg('forms.errors.tooShort', { min: Number(issue.minimum) }),
        };
      }
      return { message: msg('forms.errors.tooSmall', { min: Number(issue.minimum) }) };
    case 'too_big':
      if (issue.type === 'string') return { message: msg('forms.errors.tooLong', { max: Number(issue.maximum) }) };
      return { message: msg('forms.errors.tooBig', { max: Number(issue.maximum) }) };
    case 'invalid_string':
      if (issue.validation === 'email') return { message: msg('forms.errors.email') };
      return { message: msg('forms.errors.checkAndRetry') };
    default:
      return { message: msg('forms.errors.checkAndRetry') };
  }
};

/** Flattens react-hook-form's nested FieldErrors into `[{ name: "a.b", message }]` in object order. */
export function flattenFieldErrors(errors: unknown, prefix = ''): Array<{ name: string; message: string }> {
  if (!errors || typeof errors !== 'object') return [];
  const out: Array<{ name: string; message: string }> = [];
  for (const [k, v] of Object.entries(errors as Record<string, unknown>)) {
    if (k === 'ref' || k === 'types') continue;
    const name = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') {
      out.push({ name, message: (v as { message: string }).message });
    } else {
      out.push(...flattenFieldErrors(v, name));
    }
  }
  return out;
}

/** Thrown from an onSubmit handler to map a server-side 4xx onto fields (values are message keys). */
export class FormSubmitError extends Error {
  readonly fieldErrors: Record<string, string>;
  readonly messageKey: string | null;
  constructor(opts: { fieldErrors?: Record<string, string>; messageKey?: string } = {}) {
    super(opts.messageKey ?? 'form submit error');
    this.name = 'FormSubmitError';
    this.fieldErrors = opts.fieldErrors ?? {};
    this.messageKey = opts.messageKey ?? null;
  }
}
