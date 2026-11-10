/* ------------------------------------------------------------------ */
/*  regionConfig/legalSlots — regional legal-document SLOTS             */
/*                                                                      */
/*  REQUIRES COUNSEL. Vireek ships NO legal text and makes NO claim     */
/*  that any document satisfies any law. A slot is an empty, typed      */
/*  place where the account owner attaches text THEIR lawyer approved.  */
/*  A slot can only become `published` with a named reviewer and a      */
/*  review date, and every version is immutable (see migration).        */
/* ------------------------------------------------------------------ */

export const REQUIRES_COUNSEL = true as const;
export const COUNSEL_NOTICE =
  'REQUIRES COUNSEL: Vireek does not provide legal advice or legal text. Have a qualified lawyer in the relevant jurisdiction review this document before publishing it.';

export type LegalSlotKey =
  | 'terms_of_service'
  | 'privacy_notice'
  | 'cookie_notice'
  | 'data_processing_agreement'
  | 'consumer_cancellation_notice'
  | 'marketing_consent_text'
  | 'warranty_terms';

export interface LegalSlotDef {
  key: LegalSlotKey;
  label: string;
  /** Descriptive only — a prompt for the owner/lawyer, NOT an assertion of what the law requires. */
  prompt: string;
  requiresCounsel: typeof REQUIRES_COUNSEL;
}

export const LEGAL_SLOTS: Readonly<Record<LegalSlotKey, LegalSlotDef>> = {
  terms_of_service: { key: 'terms_of_service', label: 'Terms of service', prompt: 'Customer-facing service terms for this country.', requiresCounsel: true },
  privacy_notice: { key: 'privacy_notice', label: 'Privacy notice', prompt: 'How you collect and use customer personal data in this country.', requiresCounsel: true },
  cookie_notice: { key: 'cookie_notice', label: 'Cookie notice', prompt: 'Cookie / tracking disclosure for public pages (booking, portal).', requiresCounsel: true },
  data_processing_agreement: { key: 'data_processing_agreement', label: 'Data processing agreement', prompt: 'Terms covering personal data you process for commercial customers.', requiresCounsel: true },
  consumer_cancellation_notice: { key: 'consumer_cancellation_notice', label: 'Consumer cancellation notice', prompt: 'Cancellation / cooling-off wording for consumer bookings, if any applies.', requiresCounsel: true },
  marketing_consent_text: { key: 'marketing_consent_text', label: 'Marketing consent text', prompt: 'Wording shown where a customer opts in to marketing.', requiresCounsel: true },
  warranty_terms: { key: 'warranty_terms', label: 'Warranty terms', prompt: 'Workmanship or parts warranty wording.', requiresCounsel: true },
};
export const LEGAL_SLOT_KEYS = Object.keys(LEGAL_SLOTS) as LegalSlotKey[];

export type LegalDocStatus = 'draft' | 'counsel_approved' | 'published' | 'retired';

export interface LegalDocVersion {
  slotKey: LegalSlotKey;
  country: string;
  locale: string;
  version: number;
  status: LegalDocStatus;
  title: string;
  /** Opaque text supplied by the account owner. Vireek never generates or edits it. */
  body: string;
  counselReviewer: string | null;
  counselReviewedOn: string | null; // ISO date
}

export interface LegalDocIssue { field: string; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_LEGAL_BODY = 200_000;

/** Pure validation mirrored by the DB CHECK/RPC. Returns [] when the version may be stored. */
export function validateLegalDocVersion(d: LegalDocVersion, today: string = new Date().toISOString().slice(0, 10)): LegalDocIssue[] {
  const issues: LegalDocIssue[] = [];
  if (!(d.slotKey in LEGAL_SLOTS)) issues.push({ field: 'slotKey', message: 'Unknown legal-document slot.' });
  if (!/^[A-Z]{2}$/.test(d.country)) issues.push({ field: 'country', message: 'Country must be an ISO 3166-1 alpha-2 code.' });
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(d.locale)) issues.push({ field: 'locale', message: 'Locale must be a BCP-47 tag.' });
  if (!Number.isInteger(d.version) || d.version < 1) issues.push({ field: 'version', message: 'Version must be a positive integer.' });
  if (!d.title.trim() || d.title.length > 200) issues.push({ field: 'title', message: 'Title is required (max 200 chars).' });
  if (d.body.length > MAX_LEGAL_BODY) issues.push({ field: 'body', message: 'Document text is too long.' });
  if (d.status === 'counsel_approved' || d.status === 'published') {
    if (!d.body.trim()) issues.push({ field: 'body', message: 'A document must have text before it can be approved or published.' });
    if (!d.counselReviewer?.trim()) issues.push({ field: 'counselReviewer', message: 'Name the lawyer or firm that reviewed this text. REQUIRES COUNSEL.' });
    if (!d.counselReviewedOn || !ISO_DATE.test(d.counselReviewedOn)) issues.push({ field: 'counselReviewedOn', message: 'Enter the date of counsel review (YYYY-MM-DD).' });
    else if (d.counselReviewedOn > today) issues.push({ field: 'counselReviewedOn', message: 'The review date cannot be in the future.' });
  }
  return issues;
}

/** Latest version wins; only `published` versions may ever be shown to customers. */
export function activeVersion(versions: readonly LegalDocVersion[], slotKey: LegalSlotKey, country: string, locale: string): LegalDocVersion | null {
  const same = versions.filter((v) => v.slotKey === slotKey && v.country === country.toUpperCase() && v.locale.toLowerCase() === locale.toLowerCase());
  if (same.length === 0) return null;
  const latest = same.reduce((a, b) => (b.version > a.version ? b : a));
  return latest.status === 'published' ? latest : null;
}

export interface SlotCoverage { slotKey: LegalSlotKey; status: LegalDocStatus | 'unconfigured'; published: boolean }

export function slotCoverage(versions: readonly LegalDocVersion[], country: string, locale: string): SlotCoverage[] {
  return LEGAL_SLOT_KEYS.map((slotKey) => {
    const same = versions.filter((v) => v.slotKey === slotKey && v.country === country.toUpperCase() && v.locale.toLowerCase() === locale.toLowerCase());
    if (same.length === 0) return { slotKey, status: 'unconfigured', published: false };
    const latest = same.reduce((a, b) => (b.version > a.version ? b : a));
    return { slotKey, status: latest.status, published: latest.status === 'published' };
  });
}
