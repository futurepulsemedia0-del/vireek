// src/lib/dsar.ts
//
// Pure client-side helpers for the public /data-request form: option
// catalogues, instant validation and display formatting. No network, no React
// — so it is trivially unit-testable (dsar.test.ts). Network calls live in
// dsarApi.ts. The server (supabase/functions/_shared/compliance/dsar.ts)
// re-validates everything; this copy only gives immediate feedback.

export type DsarKind = 'access' | 'delete' | 'correct';
export type DsarRelationship = 'account_holder' | 'customer_of_customer' | 'website_visitor' | 'other';
export type DsarRegion = 'eu_uk' | 'california' | 'other';
export type DsarOutcome = 'deletion_scheduled' | 'deletion_blocked' | 'queued';

export const DSAR_RESPONSE_DAYS = 30;
export const DSAR_LIMITS = { nameMin: 2, nameMax: 120, emailMax: 254, detailsMax: 2000, correctionMin: 10 } as const;

export interface DsarFormValues {
  kind: DsarKind | '';
  email: string;
  fullName: string;
  relationship: DsarRelationship | '';
  region: DsarRegion;
  details: string;
  confirmed: boolean;
}

export type DsarFieldErrors = Partial<Record<keyof DsarFormValues, string>>;

export const EMPTY_DSAR_FORM: DsarFormValues = {
  kind: '',
  email: '',
  fullName: '',
  relationship: '',
  region: 'other',
  details: '',
  confirmed: false,
};

export const KIND_OPTIONS: ReadonlyArray<{ value: DsarKind; title: string; description: string }> = [
  { value: 'access', title: 'Access my data', description: 'Get a copy of the personal data we hold about you.' },
  { value: 'delete', title: 'Delete my data', description: 'Ask us to erase your personal data.' },
  { value: 'correct', title: 'Correct my data', description: 'Fix information that is wrong or out of date.' },
];

export const RELATIONSHIP_OPTIONS: ReadonlyArray<{ value: DsarRelationship; label: string }> = [
  { value: 'account_holder', label: 'I have (or had) a Vireek account' },
  { value: 'customer_of_customer', label: 'I am a customer of a business that uses Vireek' },
  { value: 'website_visitor', label: 'I visited vireek.com or contacted Vireek' },
  { value: 'other', label: 'Something else' },
];

export const REGION_OPTIONS: ReadonlyArray<{ value: DsarRegion; label: string }> = [
  { value: 'eu_uk', label: 'European Economic Area or United Kingdom' },
  { value: 'california', label: 'California, USA' },
  { value: 'other', label: 'Somewhere else' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateDsarForm(v: DsarFormValues): DsarFieldErrors {
  const e: DsarFieldErrors = {};
  if (!v.kind) e.kind = 'Choose what you would like us to do.';

  const email = v.email.trim();
  if (!email) e.email = 'Enter the email address linked to your data.';
  else if (email.length > DSAR_LIMITS.emailMax || !EMAIL_RE.test(email)) e.email = 'Enter a valid email address.';

  const name = v.fullName.trim();
  if (name.length < DSAR_LIMITS.nameMin) e.fullName = 'Enter your full name.';
  else if (name.length > DSAR_LIMITS.nameMax) e.fullName = `Keep your name under ${DSAR_LIMITS.nameMax} characters.`;

  if (!v.relationship) e.relationship = 'Tell us how you relate to Vireek.';

  const details = v.details.trim();
  if (details.length > DSAR_LIMITS.detailsMax) e.details = `Keep this under ${DSAR_LIMITS.detailsMax} characters.`;
  else if (v.kind === 'correct' && details.length < DSAR_LIMITS.correctionMin) {
    e.details = 'Tell us what is wrong and what it should say instead.';
  }

  if (!v.confirmed) e.confirmed = 'Please confirm this request is about your own data.';
  return e;
}

export function formatDueDate(iso: string, locale = 'en-US'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function outcomeCopy(outcome: DsarOutcome, kind: DsarKind): { title: string; body: string } {
  if (outcome === 'deletion_scheduled') {
    return {
      title: 'Account erasure scheduled',
      body: 'We found your Vireek account. It will be erased after a 14-day grace period. To stop it, sign in and cancel the request under Data Governance settings.',
    };
  }
  if (outcome === 'deletion_blocked') {
    return {
      title: 'Needs a manual review',
      body: 'We found your account, but an active legal hold prevents automatic erasure. Our privacy team will review it and write to you.',
    };
  }
  const verb = kind === 'access' ? 'prepare your data copy' : kind === 'delete' ? 'review your erasure request' : 'review your correction';
  return {
    title: 'Request in progress',
    body: `Our privacy team will ${verb} and reply to the email address you verified. If your data is held by a business that uses Vireek, we will coordinate with that business.`,
  };
}
