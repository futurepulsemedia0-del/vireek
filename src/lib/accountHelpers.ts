/** Pure helpers for the My Account page. No React, no project imports — fully unit-testable. */

export function initialsFor(name: string | null | undefined, email: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length > 0) {
    const first = Array.from(parts[0])[0] ?? '';
    const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? '' : '';
    return (first + last).toLocaleUpperCase() || '?';
  }
  const e = (email ?? '').trim();
  return e ? (Array.from(e)[0] ?? '?').toLocaleUpperCase() : '?';
}

export function isValidEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Empty is valid (the field is optional). Otherwise 7–15 digits with common separators. */
export function isValidPhone(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (!/^\+?[\d\s().-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

export interface PasswordRule {
  id: 'length' | 'case' | 'number' | 'symbol' | 'personal';
  label: string;
  passed: boolean;
}

export interface PasswordCheck {
  /** 0 = too short, 1 = weak, 2 = fair, 3 = good, 4 = strong */
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Too short' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  rules: PasswordRule[];
}

const LABELS: PasswordCheck['label'][] = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
const BY_EXTRAS: Array<1 | 2 | 3 | 4> = [1, 2, 3, 4, 4];

export function checkPassword(password: string, email?: string | null): PasswordCheck {
  const local = (email ?? '').split('@')[0].toLowerCase();
  const personal = local.length < 3 || !password.toLowerCase().includes(local);
  const hasCase = /[a-z]/.test(password) && /[A-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const longEnough = password.length >= 8;

  const rules: PasswordRule[] = [
    { id: 'length', label: 'At least 8 characters', passed: longEnough },
    { id: 'case', label: 'Upper and lower case letters', passed: hasCase },
    { id: 'number', label: 'A number', passed: hasNumber },
    { id: 'symbol', label: 'A symbol', passed: hasSymbol },
    { id: 'personal', label: "Doesn't contain your email name", passed: personal },
  ];

  let score: PasswordCheck['score'] = 0;
  if (longEnough) {
    const extras = [password.length >= 12, hasCase, hasNumber, hasSymbol].filter(Boolean).length;
    score = BY_EXTRAS[extras];
    if (!personal) score = Math.min(score, 1) as PasswordCheck['score'];
  }
  return { score, label: LABELS[score], rules };
}

export function formatDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
}

export function timeAgo(iso: string, locale?: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  }
  const sec = Math.trunc((then - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.trunc(sec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.trunc(sec / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.trunc(sec / 86_400), 'day');
  return formatDate(iso, locale);
}

const PROVIDER_LABELS: Record<string, string> = {
  email: 'Email & password',
  google: 'Google',
  github: 'GitHub',
  azure: 'Microsoft',
  apple: 'Apple',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  linkedin_oidc: 'LinkedIn',
  phone: 'Phone',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
