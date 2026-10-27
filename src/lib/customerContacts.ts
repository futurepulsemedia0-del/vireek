/**
 * Customer contacts — pure domain logic (no I/O): roles, validation, routing, coverage.
 * Data access: customerContactsApi.ts · Schema: 20271210000000_customer_contacts.sql
 *
 * The routing rules in `contactsForPurpose` mirror the SQL function customer_contact_recipients() — keep them
 * in sync (the unit tests pin the behaviour of this side).
 */

export const CONTACT_ROLES = ['billing', 'site', 'emergency', 'tenant'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export type ContactChannel = 'any' | 'email' | 'sms' | 'phone';
export type ContactPurpose = 'invoice' | 'service' | 'emergency' | 'portal' | 'general';
export type ContactLanguage = 'en' | 'es' | 'fr' | 'de' | 'ar' | 'fa';

export const ROLE_META: Record<ContactRole, { label: string; description: string; routes: string }> = {
  billing: {
    label: 'Billing',
    description: 'Receives invoices, receipts and payment reminders.',
    routes: 'Invoices & reminders',
  },
  site: {
    label: 'Site',
    description: 'On location. Receives arrival windows and visit updates.',
    routes: 'Arrival & visit updates',
  },
  emergency: {
    label: 'Emergency',
    description: 'Reached first for urgent or after-hours issues.',
    routes: 'Urgent issues',
  },
  tenant: {
    label: 'Tenant',
    description: 'Lives or works at the property. Gets access and visit notices.',
    routes: 'Access & visit notices',
  },
};

export const CHANNEL_LABELS: Record<ContactChannel, string> = {
  any: 'Any channel',
  email: 'Email',
  sms: 'Text message',
  phone: 'Phone call',
};

export const CONTACT_LANGUAGES: { code: ContactLanguage; native: string }[] = [
  { code: 'en', native: 'English' },
  { code: 'es', native: 'Español' },
  { code: 'fr', native: 'Français' },
  { code: 'de', native: 'Deutsch' },
  { code: 'ar', native: 'العربية' },
  { code: 'fa', native: 'فارسی' },
];

export const PURPOSE_META: { purpose: Exclude<ContactPurpose, 'general'>; label: string }[] = [
  { purpose: 'invoice', label: 'Invoices & reminders' },
  { purpose: 'service', label: 'Arrival & visit updates' },
  { purpose: 'emergency', label: 'Urgent issues' },
  { purpose: 'portal', label: 'Portal link' },
];

export interface CustomerContact {
  id: string;
  customerId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  roles: ContactRole[];
  isPrimary: boolean;
  siteLabel: string | null;
  preferredChannel: ContactChannel;
  language: ContactLanguage | null;
  portalAccess: boolean;
  notes: string | null;
  createdAt: string;
}

/** What the form edits — all strings so inputs stay controlled. */
export interface ContactDraft {
  fullName: string;
  jobTitle: string;
  email: string;
  phone: string;
  roles: ContactRole[];
  isPrimary: boolean;
  siteLabel: string;
  preferredChannel: ContactChannel;
  language: ContactLanguage | '';
  portalAccess: boolean;
  notes: string;
}

export type DraftField = 'fullName' | 'jobTitle' | 'email' | 'phone' | 'siteLabel' | 'notes' | 'contact';
export type DraftErrors = Partial<Record<DraftField, string>>;

export interface ContactRecipient {
  contactId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  language: ContactLanguage | null;
  isFallback: boolean;
}

export const LIMITS = { name: 120, title: 120, email: 254, phone: 40, site: 120, notes: 1000 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[0-9]{7,15}$/;

export const emptyDraft = (): ContactDraft => ({
  fullName: '',
  jobTitle: '',
  email: '',
  phone: '',
  roles: [],
  isPrimary: false,
  siteLabel: '',
  preferredChannel: 'any',
  language: '',
  portalAccess: false,
  notes: '',
});

export const draftFromContact = (c: CustomerContact): ContactDraft => ({
  fullName: c.fullName,
  jobTitle: c.jobTitle ?? '',
  email: c.email ?? '',
  phone: c.phone ?? '',
  roles: [...c.roles],
  isPrimary: c.isPrimary,
  siteLabel: c.siteLabel ?? '',
  preferredChannel: c.preferredChannel,
  language: c.language ?? '',
  portalAccess: c.portalAccess,
  notes: c.notes ?? '',
});

// ------------------------------------------------------------------ normalisation

export function normalizeEmail(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase();
  return t === '' ? null : t;
}

/** Same rules as SQL cc_normalize_phone(): digits only, 10 digits => US (+1), otherwise "+" + digits. */
export function normalizePhone(v: string | null | undefined): string | null {
  const raw = (v ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return null;
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/** Display-only formatting: US numbers as (512) 555-0123, everything else left as typed. */
export function formatPhone(v: string | null | undefined): string {
  const e164 = normalizePhone(v);
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (v ?? '').trim();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

// ------------------------------------------------------------------ validation

export type ValidationResult =
  | { ok: true; value: ContactDraft; errors: Record<string, never> }
  | { ok: false; errors: DraftErrors };

export function validateDraft(draft: ContactDraft, existing: CustomerContact[], editingId?: string | null): ValidationResult {
  const errors: DraftErrors = {};
  const name = draft.fullName.trim();
  const email = normalizeEmail(draft.email);
  const phoneRaw = draft.phone.trim();
  const phone = normalizePhone(phoneRaw);
  const others = existing.filter((c) => c.id !== editingId);

  if (!name) errors.fullName = 'Enter a name.';
  else if (name.length > LIMITS.name) errors.fullName = `Keep the name under ${LIMITS.name} characters.`;

  if (draft.jobTitle.trim().length > LIMITS.title) errors.jobTitle = `Keep the title under ${LIMITS.title} characters.`;
  if (draft.siteLabel.trim().length > LIMITS.site) errors.siteLabel = `Keep this under ${LIMITS.site} characters.`;
  if (draft.notes.trim().length > LIMITS.notes) errors.notes = `Keep notes under ${LIMITS.notes} characters.`;

  if (email) {
    if (email.length > LIMITS.email || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
    else if (others.some((c) => normalizeEmail(c.email) === email)) errors.email = 'Another contact already uses this email.';
  }

  if (phoneRaw) {
    if (phoneRaw.length > LIMITS.phone || !phone || !E164_RE.test(phone)) errors.phone = 'Enter a valid phone number.';
    else if (others.some((c) => normalizePhone(c.phone) === phone)) errors.phone = 'Another contact already uses this number.';
  }

  if (!email && !phoneRaw) errors.contact = 'Add an email or a phone number so we can reach this person.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: {},
    value: {
      ...draft,
      fullName: name,
      jobTitle: draft.jobTitle.trim(),
      email: email ?? '',
      phone: phoneRaw,
      roles: CONTACT_ROLES.filter((r) => draft.roles.includes(r)),
      siteLabel: draft.siteLabel.trim(),
      notes: draft.notes.trim(),
    },
  };
}

// ------------------------------------------------------------------ parsing DB rows

const isRole = (v: unknown): v is ContactRole => typeof v === 'string' && (CONTACT_ROLES as readonly string[]).includes(v);
const isChannel = (v: unknown): v is ContactChannel => v === 'any' || v === 'email' || v === 'sms' || v === 'phone';
const isLanguage = (v: unknown): v is ContactLanguage => CONTACT_LANGUAGES.some((l) => l.code === v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export function normalizeContactRow(raw: unknown): CustomerContact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const customerId = str(r.customer_id);
  const fullName = str(r.full_name);
  if (!id || !customerId || !fullName) return null;
  return {
    id,
    customerId,
    fullName,
    jobTitle: str(r.job_title),
    email: str(r.email),
    phone: str(r.phone),
    roles: Array.isArray(r.roles) ? CONTACT_ROLES.filter((role) => (r.roles as unknown[]).some((x) => isRole(x) && x === role)) : [],
    isPrimary: r.is_primary === true,
    siteLabel: str(r.site_label),
    preferredChannel: isChannel(r.preferred_channel) ? r.preferred_channel : 'any',
    language: isLanguage(r.language) ? r.language : null,
    portalAccess: r.portal_access === true,
    notes: str(r.notes),
    createdAt: str(r.created_at) ?? '',
  };
}

export function sortContacts(list: CustomerContact[]): CustomerContact[] {
  return [...list].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const t = a.createdAt.localeCompare(b.createdAt);
    return t !== 0 ? t : a.fullName.localeCompare(b.fullName);
  });
}

// ------------------------------------------------------------------ routing + coverage

const toRecipient = (c: CustomerContact, isFallback: boolean): ContactRecipient => ({
  contactId: c.id,
  name: c.fullName,
  email: c.email,
  phone: c.phone,
  language: c.language,
  isFallback,
});

const matchesPurpose = (c: CustomerContact, purpose: ContactPurpose): boolean => {
  const reachable = c.email !== null || c.phone !== null;
  switch (purpose) {
    case 'invoice':
      return c.roles.includes('billing') && c.email !== null;
    case 'service':
      return (c.roles.includes('site') || c.roles.includes('tenant')) && reachable;
    case 'emergency':
      return c.roles.includes('emergency') && reachable;
    case 'portal':
      return c.portalAccess && c.email !== null;
    default:
      return c.isPrimary && reachable;
  }
};

export function contactsForPurpose(
  contacts: CustomerContact[],
  purpose: ContactPurpose,
  customer?: { name: string; email: string | null; phone: string | null } | null,
): ContactRecipient[] {
  const sorted = sortContacts(contacts);
  const matched = sorted.filter((c) => matchesPurpose(c, purpose));
  if (matched.length > 0) return matched.map((c) => toRecipient(c, false));

  const needsEmail = purpose === 'invoice' || purpose === 'portal';
  const usable = (email: string | null, phone: string | null) => (needsEmail ? email !== null : email !== null || phone !== null);

  const primary = sorted.find((c) => c.isPrimary && usable(c.email, c.phone));
  if (primary) return [toRecipient(primary, true)];

  if (customer && usable(str(customer.email), str(customer.phone))) {
    return [{ contactId: null, name: customer.name, email: str(customer.email), phone: str(customer.phone), language: null, isFallback: true }];
  }
  return [];
}

export interface RoleCoverage {
  role: ContactRole;
  count: number;
  covered: boolean;
}

export function roleCoverage(contacts: CustomerContact[]): RoleCoverage[] {
  return CONTACT_ROLES.map((role) => {
    const count = contacts.filter((c) => c.roles.includes(role)).length;
    return { role, count, covered: count > 0 };
  });
}

export function bestChannel(c: Pick<CustomerContact, 'email' | 'phone' | 'preferredChannel'>): 'email' | 'sms' | 'phone' | null {
  const { email, phone, preferredChannel: p } = c;
  if (p === 'email' && email) return 'email';
  if ((p === 'sms' || p === 'phone') && phone) return p;
  if (phone) return 'sms';
  if (email) return 'email';
  return null;
}

export function describeContactError(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  const msg = err?.message ?? '';
  if (err?.code === '23505') {
    if (/phone/i.test(msg)) return 'Another contact already uses this phone number.';
    if (/email/i.test(msg)) return 'Another contact already uses this email.';
    return 'This contact already exists.';
  }
  if (err?.code === '23514' || err?.code === '23502') return 'Please check the details and try again.';
  if (err?.code === '42501' || /row-level security/i.test(msg)) return "You don't have permission to change this customer's contacts.";
  return msg || 'Something went wrong. Please try again.';
}
