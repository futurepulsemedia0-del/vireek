import { supabase } from '@/lib/supabase';

/**
 * DMCA / copyright complaint intake — client library for /dmca.
 *
 * The same rules are re-enforced server-side by `submit_dmca_notice()`
 * (supabase/migrations/20270502000000_dmca_notices.sql). Everything here is
 * UX: fast, specific error messages. Never treat it as the trust boundary.
 */

// ============================================================
// DESIGNATED AGENT (17 U.S.C. § 512(c)(2))
// ============================================================

export interface DmcaAgent {
  company: string;
  contactName: string;
  email: string;
  /**
   * REQUIRED for DMCA safe-harbor eligibility: the agent's full mailing
   * address must be public AND registered with the U.S. Copyright Office
   * (dmca.copyright.gov). Fill this in before launch. When empty, the page
   * simply omits the line instead of rendering a blank.
   */
  mailingAddress: string;
  phone: string;
}

export const DMCA_AGENT: DmcaAgent = {
  company: 'Vireek',
  contactName: 'Copyright Agent',
  email: 'ali@vireek.com',
  mailingAddress: '',
  phone: '',
};

// ============================================================
// TYPES
// ============================================================

export type DmcaNoticeType = 'takedown' | 'counter';
export type DmcaCapacity = 'owner' | 'agent';

export interface DmcaFormValues {
  noticeType: DmcaNoticeType;
  fullName: string;
  organization: string;
  email: string;
  phone: string;
  address: string;
  capacity: DmcaCapacity;
  workDescription: string;
  workUrl: string;
  urlsText: string;
  originalReference: string;
  additionalInfo: string;
  statements: string[];
  signature: string;
  /** Honeypot — must stay empty. */
  website: string;
}

export type DmcaField =
  | 'fullName'
  | 'email'
  | 'phone'
  | 'address'
  | 'workDescription'
  | 'workUrl'
  | 'urls'
  | 'originalReference'
  | 'additionalInfo'
  | 'statements'
  | 'signature';

export type DmcaErrors = Partial<Record<DmcaField, string>>;

/** Top-to-bottom visual order — used to focus the first invalid field. */
export const DMCA_FIELD_ORDER: DmcaField[] = [
  'fullName',
  'email',
  'phone',
  'address',
  'workDescription',
  'workUrl',
  'urls',
  'originalReference',
  'additionalInfo',
  'statements',
  'signature',
];

export const DMCA_LIMITS = {
  name: { min: 2, max: 120 },
  email: 254,
  address: { min: 10, max: 500 },
  organization: 200,
  workDescription: { min: 20, max: 3000 },
  additionalInfo: 3000,
  url: 2000,
  urlCount: 20,
  originalReference: 64,
} as const;

export const DMCA_STATEMENTS: Record<DmcaNoticeType, { id: string; label: string }[]> = {
  takedown: [
    {
      id: 'good_faith',
      label:
        'I have a good faith belief that the use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.',
    },
    {
      id: 'accuracy_authority',
      label:
        'The information in this notice is accurate, and under penalty of perjury, I am the owner (or authorized to act on behalf of the owner) of an exclusive right that is allegedly infringed.',
    },
    {
      id: 'share_with_user',
      label:
        'I understand that Vireek may forward this notice, including my name and contact details, to the user who posted the material, and that knowingly misrepresenting that material is infringing may make me liable for damages under 17 U.S.C. § 512(f).',
    },
  ],
  counter: [
    {
      id: 'mistake',
      label:
        'Under penalty of perjury, I have a good faith belief that the material was removed or disabled as a result of mistake or misidentification of the material.',
    },
    {
      id: 'jurisdiction',
      label:
        'I consent to the jurisdiction of the Federal District Court for the judicial district where my address above is located, or, if my address is outside the United States, any judicial district in which Vireek may be found.',
    },
    {
      id: 'service',
      label: 'I will accept service of process from the person who submitted the original notice, or that person’s agent.',
    },
    {
      id: 'share_with_user',
      label:
        'I understand that Vireek will forward this counter-notification, including my name and contact details, to the person who submitted the original notice.',
    },
  ],
};

// ============================================================
// HELPERS
// ============================================================

export function emptyDmcaValues(noticeType: DmcaNoticeType = 'takedown'): DmcaFormValues {
  return {
    noticeType,
    fullName: '',
    organization: '',
    email: '',
    phone: '',
    address: '',
    capacity: 'owner',
    workDescription: '',
    workUrl: '',
    urlsText: '',
    originalReference: '',
    additionalInfo: '',
    statements: [],
    signature: '',
    website: '',
  };
}

/** Splits on whitespace, strips stray trailing punctuation, de-duplicates, keeps order. */
export function parseUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const url = raw.replace(/[,;]+$/, '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function isValidHttpUrl(value: string): boolean {
  if (value.length > DMCA_LIMITS.url || /\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d\s().-]{7,40}$/;

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ============================================================
// VALIDATION
// ============================================================

export function validateDmca(v: DmcaFormValues): DmcaErrors {
  const e: DmcaErrors = {};
  const isCounter = v.noticeType === 'counter';

  const name = v.fullName.trim();
  if (name.length < DMCA_LIMITS.name.min) e.fullName = 'Enter your full legal name.';
  else if (name.length > DMCA_LIMITS.name.max) e.fullName = `Keep this under ${DMCA_LIMITS.name.max} characters.`;

  const email = v.email.trim();
  if (!email) e.email = 'Enter your email address.';
  else if (!EMAIL_RE.test(email) || email.length > DMCA_LIMITS.email) e.email = 'Enter a valid email address.';

  const phone = v.phone.trim();
  if (!phone && isCounter) e.phone = 'A phone number is required for a counter-notification.';
  else if (phone && !PHONE_RE.test(phone)) e.phone = 'Enter a valid phone number, including country code if outside the US.';

  const address = v.address.trim();
  if (address.length < DMCA_LIMITS.address.min) e.address = 'Enter your full mailing address.';
  else if (address.length > DMCA_LIMITS.address.max) e.address = `Keep this under ${DMCA_LIMITS.address.max} characters.`;

  if (!isCounter) {
    const desc = v.workDescription.trim();
    if (desc.length < DMCA_LIMITS.workDescription.min) {
      e.workDescription = `Describe the copyrighted work (at least ${DMCA_LIMITS.workDescription.min} characters).`;
    } else if (desc.length > DMCA_LIMITS.workDescription.max) {
      e.workDescription = `Keep this under ${DMCA_LIMITS.workDescription.max} characters.`;
    }
  } else if (v.workDescription.trim().length > DMCA_LIMITS.workDescription.max) {
    e.workDescription = `Keep this under ${DMCA_LIMITS.workDescription.max} characters.`;
  }

  const workUrl = v.workUrl.trim();
  if (workUrl && !isValidHttpUrl(workUrl)) e.workUrl = 'Enter a full link starting with http:// or https://.';

  const urls = parseUrls(v.urlsText);
  if (urls.length === 0) {
    e.urls = isCounter ? 'List where the removed material appeared.' : 'List at least one link to the infringing material.';
  } else if (urls.length > DMCA_LIMITS.urlCount) {
    e.urls = `Please list no more than ${DMCA_LIMITS.urlCount} links per notice.`;
  } else {
    const bad = urls.find((u) => !isValidHttpUrl(u));
    if (bad) e.urls = `“${bad.length > 60 ? `${bad.slice(0, 57)}…` : bad}” is not a valid link. Use full http:// or https:// links, one per line.`;
  }

  if (v.originalReference.trim().length > DMCA_LIMITS.originalReference) e.originalReference = 'That reference number is too long.';
  if (v.additionalInfo.trim().length > DMCA_LIMITS.additionalInfo) {
    e.additionalInfo = `Keep this under ${DMCA_LIMITS.additionalInfo} characters.`;
  }

  const required = DMCA_STATEMENTS[v.noticeType].map((s) => s.id);
  if (!required.every((id) => v.statements.includes(id))) e.statements = 'You must confirm every statement above to continue.';

  const sig = v.signature.trim();
  if (!sig) e.signature = 'Type your full legal name as your electronic signature.';
  else if (!e.fullName && normalizeName(sig) !== normalizeName(name)) e.signature = 'Your signature must match your full legal name above.';

  return e;
}

// ============================================================
// SUBMISSION
// ============================================================

export function buildDmcaPayload(v: DmcaFormValues): Record<string, unknown> {
  const isCounter = v.noticeType === 'counter';
  const required = DMCA_STATEMENTS[v.noticeType].map((s) => s.id);
  return {
    notice_type: v.noticeType,
    full_name: v.fullName.trim(),
    organization: v.organization.trim(),
    email: v.email.trim(),
    phone: v.phone.trim(),
    address: v.address.trim(),
    capacity: isCounter ? '' : v.capacity,
    work_description: v.workDescription.trim(),
    work_url: isCounter ? '' : v.workUrl.trim(),
    urls: parseUrls(v.urlsText),
    original_reference: isCounter ? v.originalReference.trim() : '',
    additional_info: v.additionalInfo.trim(),
    statements: v.statements.filter((id) => required.includes(id)),
    signature: v.signature.trim(),
    website: v.website,
  };
}

export type DmcaSubmitError = 'rate_limited' | 'invalid' | 'unavailable';
export type DmcaSubmitResult = { ok: true; reference: string } | { ok: false; error: DmcaSubmitError };

export async function submitDmcaNotice(values: DmcaFormValues): Promise<DmcaSubmitResult> {
  try {
    const { data, error } = await supabase.rpc('submit_dmca_notice', { p_payload: buildDmcaPayload(values) });
    if (error || !data || typeof data !== 'object') return { ok: false, error: 'unavailable' };
    const res = data as { ok?: boolean; reference?: string; error?: string };
    if (res.ok && typeof res.reference === 'string') return { ok: true, reference: res.reference };
    if (res.error === 'rate_limited') return { ok: false, error: 'rate_limited' };
    if (res.error === 'invalid') return { ok: false, error: 'invalid' };
    return { ok: false, error: 'unavailable' };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

export const DMCA_ERROR_MESSAGES: Record<DmcaSubmitError, string> = {
  rate_limited: 'You have submitted several notices recently. Please wait a while, or email our copyright agent directly.',
  invalid: 'Some details were rejected. Please review the form and try again.',
  unavailable: 'We couldn’t send your notice. Please try again, or email our copyright agent directly.',
};
