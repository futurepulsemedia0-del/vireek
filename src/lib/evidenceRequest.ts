/**
 * Evidence-request form — validation and submission (no React).
 *
 * Submits to the same already-working submit-form.com endpoint as ContactPage /
 * EnterprisePage / SignupForm, tagged with `source` so the team can route it.
 */

export const EVIDENCE_FORM_ENDPOINT = 'https://submit-form.com/USdWD1urW';
export const EVIDENCE_SOURCE = 'compliance-evidence-request';
export const SUBMIT_TIMEOUT_MS = 15_000;

export const REQUEST_TYPES = [
  { id: 'questionnaire', label: 'Security questionnaire or vendor assessment' },
  { id: 'dpa', label: 'Data Processing Agreement (DPA)' },
  { id: 'architecture', label: 'Architecture and data-flow documentation' },
  { id: 'subprocessors', label: 'Sub-processor and data-location details' },
  { id: 'compliance', label: 'A question about SOC 2, HIPAA or PCI DSS' },
  { id: 'other', label: 'Something else' },
] as const;

export const FRAMEWORK_OPTIONS = [
  { id: 'soc2', label: 'SOC 2' },
  { id: 'hipaa', label: 'HIPAA' },
  { id: 'pci', label: 'PCI DSS' },
  { id: 'other', label: 'Other' },
] as const;

export type RequestTypeId = (typeof REQUEST_TYPES)[number]['id'];
export type FrameworkOptionId = (typeof FRAMEWORK_OPTIONS)[number]['id'];

export const LIMITS = {
  nameMin: 2,
  nameMax: 100,
  emailMax: 254,
  companyMin: 2,
  companyMax: 120,
  titleMax: 100,
  messageMax: 1500,
  maxDaysAhead: 730,
} as const;

export interface EvidenceFormState {
  fullName: string;
  email: string;
  companyName: string;
  jobTitle: string;
  requestTypes: RequestTypeId[];
  frameworks: FrameworkOptionId[];
  neededBy: string;
  message: string;
}

export const EMPTY_EVIDENCE_FORM: EvidenceFormState = {
  fullName: '',
  email: '',
  companyName: '',
  jobTitle: '',
  requestTypes: [],
  frameworks: [],
  neededBy: '',
  message: '',
};

export type EvidenceFormErrors = Partial<Record<keyof EvidenceFormState, string>>;

export interface EvidencePayload {
  source: typeof EVIDENCE_SOURCE;
  page: string;
  fullName: string;
  email: string;
  companyName: string;
  jobTitle: string;
  requestTypes: string;
  frameworks: string;
  neededBy: string;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date as YYYY-MM-DD (not UTC, so late-evening users get the right day). */
export function localISODate(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return localISODate(new Date(y, m - 1, d + days));
}

export function validateEvidenceRequest(
  form: EvidenceFormState,
  today: string = localISODate(),
): { errors: EvidenceFormErrors; payload: EvidencePayload | null } {
  const errors: EvidenceFormErrors = {};
  const fullName = form.fullName.trim();
  const email = form.email.trim();
  const companyName = form.companyName.trim();
  const jobTitle = form.jobTitle.trim();
  const message = form.message.trim();
  const neededBy = form.neededBy.trim();

  if (fullName.length < LIMITS.nameMin) errors.fullName = 'Enter your full name.';
  else if (fullName.length > LIMITS.nameMax) errors.fullName = `Keep your name under ${LIMITS.nameMax} characters.`;

  if (!EMAIL_RE.test(email) || email.length > LIMITS.emailMax) errors.email = 'Enter a valid work email address.';

  if (companyName.length < LIMITS.companyMin) errors.companyName = 'Enter your company name.';
  else if (companyName.length > LIMITS.companyMax) errors.companyName = `Keep this under ${LIMITS.companyMax} characters.`;

  if (jobTitle.length > LIMITS.titleMax) errors.jobTitle = `Keep this under ${LIMITS.titleMax} characters.`;

  const types = REQUEST_TYPES.filter((t) => form.requestTypes.includes(t.id));
  if (types.length === 0) errors.requestTypes = 'Choose at least one thing you need.';

  const frameworks = FRAMEWORK_OPTIONS.filter((f) => form.frameworks.includes(f.id));

  if (neededBy) {
    if (!DATE_RE.test(neededBy)) errors.neededBy = 'Enter a valid date.';
    else if (neededBy < today) errors.neededBy = 'Choose today or a later date.';
    else if (neededBy > addDaysISO(today, LIMITS.maxDaysAhead)) errors.neededBy = 'Choose a date within the next two years.';
  }

  if (message.length > LIMITS.messageMax) errors.message = `Keep your message under ${LIMITS.messageMax} characters.`;

  if (Object.keys(errors).length > 0) return { errors, payload: null };

  return {
    errors,
    payload: {
      source: EVIDENCE_SOURCE,
      page: '/trust/compliance',
      fullName,
      email,
      companyName,
      jobTitle,
      requestTypes: types.map((t) => t.label).join('; '),
      frameworks: frameworks.map((f) => f.label).join(', '),
      neededBy,
      message,
    },
  };
}

/** A real visitor never fills the hidden "website" field; bots usually do. */
export function isHoneypotTripped(value: string): boolean {
  return value.trim() !== '';
}

export type SubmitResult = { ok: true } | { ok: false; reason: 'network' | 'server' };

export async function submitEvidenceRequest(
  payload: EvidencePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(EVIDENCE_FORM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok ? { ok: true } : { ok: false, reason: 'server' };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
