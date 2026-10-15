/**
 * Customer communication preferences — pure domain logic (no I/O) for the public /preferences/:token page.
 * Data access: communicationPreferencesApi.ts · Schema: 20270411000000_customer_communication_preferences.sql
 */

export type PreferenceLanguage = 'en' | 'es' | 'fr' | 'de' | 'ar' | 'fa';
export type PreferenceFrequency = 'all' | 'weekly' | 'monthly' | 'essential';

export interface PreferenceForm {
  sms: boolean;
  email: boolean;
  voice: boolean;
  reminders: boolean;
  surveys: boolean;
  marketing: boolean;
  language: PreferenceLanguage;
  frequency: PreferenceFrequency;
  unsubscribeAll: boolean;
}

/** Shape returned by the get_customer_preferences RPC. */
export interface PreferenceRow {
  business_name: string | null;
  customer_first_name: string;
  masked_phone: string | null;
  masked_email: string | null;
  sms_enabled: boolean;
  email_enabled: boolean;
  voice_enabled: boolean;
  reminders_enabled: boolean;
  surveys_enabled: boolean;
  marketing_enabled: boolean;
  language: PreferenceLanguage;
  frequency: PreferenceFrequency;
  unsubscribed_all: boolean;
  sms_blocked_by_stop: boolean;
}

export const LANGUAGES: { code: PreferenceLanguage; native: string; english: string; rtl: boolean }[] = [
  { code: 'en', native: 'English', english: 'English', rtl: false },
  { code: 'es', native: 'Español', english: 'Spanish', rtl: false },
  { code: 'fr', native: 'Français', english: 'French', rtl: false },
  { code: 'de', native: 'Deutsch', english: 'German', rtl: false },
  { code: 'ar', native: 'العربية', english: 'Arabic', rtl: true },
  { code: 'fa', native: 'فارسی', english: 'Persian', rtl: true },
];

export const FREQUENCIES: { key: PreferenceFrequency; label: string; description: string }[] = [
  { key: 'all', label: 'As they happen', description: 'Reminders, updates and offers whenever there is something useful.' },
  { key: 'weekly', label: 'Weekly at most', description: 'No more than one optional message a week.' },
  { key: 'monthly', label: 'Monthly at most', description: 'No more than one optional message a month.' },
  { key: 'essential', label: 'Essential only', description: 'Only appointment, invoice and safety messages — no offers or surveys.' },
];

export const CHANNEL_KEYS = ['sms', 'email', 'voice'] as const;
export const CATEGORY_KEYS = ['reminders', 'surveys', 'marketing'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined | null): v is string => !!v && UUID_RE.test(v);

export function formFromRow(r: PreferenceRow): PreferenceForm {
  return {
    sms: r.sms_enabled,
    email: r.email_enabled,
    voice: r.voice_enabled,
    reminders: r.reminders_enabled,
    surveys: r.surveys_enabled,
    marketing: r.marketing_enabled,
    language: r.language,
    frequency: r.frequency,
    unsubscribeAll: r.unsubscribed_all,
  };
}

export function isDirty(a: PreferenceForm, b: PreferenceForm): boolean {
  return (Object.keys(a) as (keyof PreferenceForm)[]).some((k) => a[k] !== b[k]);
}

/** What "unsubscribe from everything optional" means. Mirrors the SQL function exactly. */
export function applyUnsubscribeAll(f: PreferenceForm): PreferenceForm {
  return {
    ...f,
    sms: false,
    email: false,
    voice: false,
    reminders: false,
    surveys: false,
    marketing: false,
    frequency: 'essential',
    unsubscribeAll: true,
  };
}

/** Re-subscribing restores sensible defaults rather than leaving a fully-muted form. */
export function resubscribe(f: PreferenceForm, available: { phone: boolean; email: boolean }): PreferenceForm {
  return {
    ...f,
    sms: available.phone,
    voice: available.phone,
    email: available.email,
    reminders: true,
    surveys: true,
    marketing: true,
    frequency: 'all',
    unsubscribeAll: false,
  };
}

export function isValidForm(f: PreferenceForm): boolean {
  return (
    LANGUAGES.some((l) => l.code === f.language) &&
    FREQUENCIES.some((q) => q.key === f.frequency) &&
    [...CHANNEL_KEYS, ...CATEGORY_KEYS, 'unsubscribeAll' as const].every((k) => typeof f[k] === 'boolean')
  );
}

/** One plain-language sentence describing what the customer will receive — shown above the Save button. */
export function summarize(f: PreferenceForm): string {
  if (f.unsubscribeAll) return 'You will only receive essential messages (appointments, invoices and safety notices).';
  const channels = [f.sms && 'text', f.email && 'email', f.voice && 'phone calls'].filter(Boolean) as string[];
  const topics = [f.reminders && 'reminders', f.surveys && 'feedback requests', f.marketing && 'offers'].filter(Boolean) as string[];
  if (channels.length === 0 || topics.length === 0) {
    return 'You will only receive essential messages (appointments, invoices and safety notices).';
  }
  const join = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  return `You will get ${join(topics)} by ${join(channels)}${f.frequency === 'weekly' ? ', at most weekly' : f.frequency === 'monthly' ? ', at most monthly' : ''}.`;
}

export type SubmitOutcome = 'ok' | 'not_found' | 'invalid';

export function describeOutcome(o: SubmitOutcome): string {
  if (o === 'not_found') return 'This link is no longer valid. Please use the latest link from your message.';
  if (o === 'invalid') return 'One of your choices could not be saved. Please review and try again.';
  return '';
}
