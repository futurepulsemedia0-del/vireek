// ============================================================
// Types
// ============================================================

export type LocationType = 'remote' | 'hybrid' | 'onsite';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship';
export type PostingStatus = 'draft' | 'open' | 'closed';
export type SalaryPeriod = 'year' | 'hour';
export type ApplicationStatus = 'new' | 'reviewing' | 'interview' | 'offer' | 'hired' | 'rejected';

export interface JobPosting {
  id: string;
  slug: string;
  title: string;
  department: string;
  location: string;
  location_type: LocationType;
  employment_type: EmploymentType;
  summary: string;
  description: string;
  responsibilities: string[];
  requirements: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: SalaryPeriod;
  status: PostingStatus;
  published_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobApplication {
  id: string;
  posting_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  portfolio_url: string | null;
  resume_url: string | null;
  cover_note: string | null;
  referral_source: string | null;
  status: ApplicationStatus;
  rating: number | null;
  staff_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostingStats {
  posting_id: string;
  applicants_total: number;
  applicants_new: number;
}

export type FormErrors<K extends string> = Partial<Record<K, string>>;

// ============================================================
// Labels / options
// ============================================================

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
};
export const SALARY_PERIOD_LABELS: Record<SalaryPeriod, string> = { year: 'per year', hour: 'per hour' };
export const POSTING_STATUS_LABELS: Record<PostingStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  closed: 'Closed',
};
export const POSTING_STATUS_COLORS: Record<PostingStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  open: 'bg-success-500/10 text-success-500',
  closed: 'bg-warning-500/10 text-warning-500',
};

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  'new',
  'reviewing',
  'interview',
  'offer',
  'hired',
  'rejected',
];
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  new: 'New',
  reviewing: 'Reviewing',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
};
export const APPLICATION_STATUS_COLORS: Record<ApplicationStatus, string> = {
  new: 'bg-accent/10 text-accent',
  reviewing: 'bg-bg-tertiary text-text-secondary',
  interview: 'bg-warning-500/10 text-warning-500',
  offer: 'bg-success-500/10 text-success-500',
  hired: 'bg-success-500/10 text-success-500',
  rejected: 'bg-danger/10 text-danger',
};

export const REFERRAL_SOURCES = ['LinkedIn', 'Referral', 'Job board', 'Social media', 'Company website', 'Other'];

function toOptions<T extends string>(labels: Record<T, string>): [T, string][] {
  return (Object.keys(labels) as T[]).map((k) => [k, labels[k]]);
}
export const LOCATION_TYPE_OPTIONS = toOptions(LOCATION_TYPE_LABELS);
export const EMPLOYMENT_TYPE_OPTIONS = toOptions(EMPLOYMENT_TYPE_LABELS);
export const SALARY_PERIOD_OPTIONS = toOptions(SALARY_PERIOD_LABELS);

export const LIMITS = {
  title: 120,
  department: 60,
  location: 100,
  summary: 300,
  description: 10000,
  line: 300,
  lines: 20,
  name: 120,
  phone: 40,
  coverNote: 3000,
  url: 500,
} as const;

// ============================================================
// Slugs + text helpers
// ============================================================

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function validateSlug(slug: string): string | null {
  if (slug.length < 3 || slug.length > 80) return 'Use 3 to 80 characters.';
  if (!SLUG_PATTERN.test(slug)) return 'Use lowercase letters, numbers and single hyphens.';
  return null;
}

/** One item per line; leading bullets and blank lines are dropped. */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[\s•*-]+/, '').trim())
    .filter(Boolean);
}

// ============================================================
// Posting form
// ============================================================

export interface PostingFormValues {
  title: string;
  slug: string;
  department: string;
  location: string;
  locationType: LocationType;
  employmentType: EmploymentType;
  summary: string;
  description: string;
  responsibilities: string;
  requirements: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  salaryPeriod: SalaryPeriod;
}
export type PostingErrors = FormErrors<keyof PostingFormValues & string>;

export interface PostingPayload {
  slug: string;
  title: string;
  department: string;
  location: string;
  location_type: LocationType;
  employment_type: EmploymentType;
  summary: string;
  description: string;
  responsibilities: string[];
  requirements: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: SalaryPeriod;
}

export function emptyPostingForm(): PostingFormValues {
  return {
    title: '',
    slug: '',
    department: '',
    location: '',
    locationType: 'remote',
    employmentType: 'full_time',
    summary: '',
    description: '',
    responsibilities: '',
    requirements: '',
    salaryMin: '',
    salaryMax: '',
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
  };
}

export function postingToForm(p: JobPosting): PostingFormValues {
  return {
    title: p.title,
    slug: p.slug,
    department: p.department,
    location: p.location,
    locationType: p.location_type,
    employmentType: p.employment_type,
    summary: p.summary,
    description: p.description,
    responsibilities: p.responsibilities.join('\n'),
    requirements: p.requirements.join('\n'),
    salaryMin: p.salary_min === null ? '' : String(p.salary_min),
    salaryMax: p.salary_max === null ? '' : String(p.salary_max),
    salaryCurrency: p.salary_currency,
    salaryPeriod: p.salary_period,
  };
}

function parseSalary(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, '');
  return /^\d{1,9}$/.test(cleaned) ? Number(cleaned) : null;
}

function lineProblem(label: string, text: string): string | null {
  const lines = splitLines(text);
  if (lines.length > LIMITS.lines) return `${label}: at most ${LIMITS.lines} items.`;
  if (lines.some((l) => l.length > LIMITS.line)) return `${label}: keep each item under ${LIMITS.line} characters.`;
  return null;
}

export function validatePostingForm(v: PostingFormValues): PostingErrors {
  const e: PostingErrors = {};
  const len = (s: string) => s.trim().length;
  if (len(v.title) < 3 || len(v.title) > LIMITS.title) e.title = `Title needs 3 to ${LIMITS.title} characters.`;
  const slugProblem = validateSlug(v.slug);
  if (slugProblem) e.slug = slugProblem;
  if (len(v.department) < 2 || len(v.department) > LIMITS.department) {
    e.department = `Department needs 2 to ${LIMITS.department} characters.`;
  }
  if (len(v.location) < 2 || len(v.location) > LIMITS.location) {
    e.location = `Location needs 2 to ${LIMITS.location} characters.`;
  }
  if (len(v.summary) < 10 || len(v.summary) > LIMITS.summary) {
    e.summary = `Summary needs 10 to ${LIMITS.summary} characters.`;
  }
  if (len(v.description) < 20 || len(v.description) > LIMITS.description) {
    e.description = `Description needs 20 to ${LIMITS.description} characters.`;
  }
  const respProblem = lineProblem('Responsibilities', v.responsibilities);
  if (respProblem) e.responsibilities = respProblem;
  const reqProblem = lineProblem('Requirements', v.requirements);
  if (reqProblem) e.requirements = reqProblem;

  const hasMin = v.salaryMin.trim() !== '';
  const hasMax = v.salaryMax.trim() !== '';
  if (hasMin || hasMax) {
    const min = parseSalary(v.salaryMin);
    const max = parseSalary(v.salaryMax);
    if (min === null || max === null || min <= 0) e.salaryMin = 'Enter both a minimum and a maximum, as whole numbers.';
    else if (min > max) e.salaryMin = 'Minimum cannot be higher than the maximum.';
  }
  if (!/^[A-Za-z]{3}$/.test(v.salaryCurrency.trim())) e.salaryCurrency = 'Use a 3-letter code, e.g. USD.';
  return e;
}

export function formToPayload(v: PostingFormValues): PostingPayload {
  const hasSalary = v.salaryMin.trim() !== '' && v.salaryMax.trim() !== '';
  return {
    slug: v.slug.trim(),
    title: v.title.trim(),
    department: v.department.trim(),
    location: v.location.trim(),
    location_type: v.locationType,
    employment_type: v.employmentType,
    summary: v.summary.trim(),
    description: v.description.trim(),
    responsibilities: splitLines(v.responsibilities),
    requirements: splitLines(v.requirements),
    salary_min: hasSalary ? parseSalary(v.salaryMin) : null,
    salary_max: hasSalary ? parseSalary(v.salaryMax) : null,
    salary_currency: v.salaryCurrency.trim().toUpperCase(),
    salary_period: v.salaryPeriod,
  };
}

// ============================================================
// Application form
// ============================================================

export interface ApplicationFormValues {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  portfolioUrl: string;
  resumeUrl: string;
  coverNote: string;
  referralSource: string;
  consent: boolean;
  /** Honeypot: hidden from people, bots fill it in. */
  website: string;
}
export type ApplicationErrors = FormErrors<
  'fullName' | 'email' | 'phone' | 'linkedinUrl' | 'portfolioUrl' | 'resumeUrl' | 'coverNote' | 'consent'
>;

export const EMPTY_APPLICATION: ApplicationFormValues = {
  fullName: '',
  email: '',
  phone: '',
  location: '',
  linkedinUrl: '',
  portfolioUrl: '',
  resumeUrl: '',
  coverNote: '',
  referralSource: '',
  consent: false,
  website: '',
};

export function isHttpUrl(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > LIMITS.url || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Insertion order matches the form order, so the first key is the first field to focus. */
export function validateApplication(v: ApplicationFormValues): ApplicationErrors {
  const e: ApplicationErrors = {};
  const name = v.fullName.trim();
  if (name.length < 2 || name.length > LIMITS.name) e.fullName = 'Please enter your full name.';
  const email = v.email.trim();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) e.email = 'Please enter a valid email address.';
  if (v.phone.trim().length > LIMITS.phone) e.phone = 'That phone number is too long.';
  const urlMessage = 'Enter a full link starting with https://';
  if (v.linkedinUrl.trim() && !isHttpUrl(v.linkedinUrl)) e.linkedinUrl = urlMessage;
  if (v.portfolioUrl.trim() && !isHttpUrl(v.portfolioUrl)) e.portfolioUrl = urlMessage;
  if (v.resumeUrl.trim() && !isHttpUrl(v.resumeUrl)) e.resumeUrl = urlMessage;
  if (v.coverNote.length > LIMITS.coverNote) e.coverNote = `Please keep your note under ${LIMITS.coverNote} characters.`;
  if (!v.consent) e.consent = 'Please confirm to continue.';
  return e;
}

// ============================================================
// Formatting + structured data
// ============================================================

export function formatSalary(
  p: Pick<JobPosting, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>,
): string | null {
  if (p.salary_min === null || p.salary_max === null) return null;
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: p.salary_currency,
    maximumFractionDigits: 0,
  });
  return `${fmt.format(p.salary_min)} – ${fmt.format(p.salary_max)} ${SALARY_PERIOD_LABELS[p.salary_period]}`;
}

export function postedAgo(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days < 30) return `Posted ${days} days ago`;
  return `Posted ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const SCHEMA_EMPLOYMENT: Record<EmploymentType, string> = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
};

export function postingPlainText(p: JobPosting): string {
  const parts = [p.summary, p.description];
  if (p.responsibilities.length) parts.push(`Responsibilities:\n${p.responsibilities.map((r) => `- ${r}`).join('\n')}`);
  if (p.requirements.length) parts.push(`Requirements:\n${p.requirements.map((r) => `- ${r}`).join('\n')}`);
  return parts.join('\n\n');
}

/** schema.org JobPosting, eligible for Google for Jobs. */
export function buildJobPostingJsonLd(p: JobPosting, siteUrl = 'https://vireek.com'): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: p.title,
    description: postingPlainText(p),
    datePosted: (p.published_at ?? p.created_at).slice(0, 10),
    employmentType: SCHEMA_EMPLOYMENT[p.employment_type],
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Vireek',
      sameAs: siteUrl,
      logo: `${siteUrl}/apple-touch-icon.png`,
    },
    directApply: true,
    url: `${siteUrl}/careers/${p.slug}`,
  };
  if (p.location_type === 'remote') {
    ld.jobLocationType = 'TELECOMMUTE';
    ld.applicantLocationRequirements = { '@type': 'Country', name: p.location };
  } else {
    ld.jobLocation = {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: p.location },
    };
  }
  if (p.salary_min !== null && p.salary_max !== null) {
    ld.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: p.salary_currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue: p.salary_min,
        maxValue: p.salary_max,
        unitText: p.salary_period === 'year' ? 'YEAR' : 'HOUR',
      },
    };
  }
  return ld;
}

// ============================================================
// Applicant pipeline helpers
// ============================================================

export function countByStatus(apps: Pick<JobApplication, 'status'>[]): Record<ApplicationStatus | 'all', number> {
  const counts = { all: apps.length, new: 0, reviewing: 0, interview: 0, offer: 0, hired: 0, rejected: 0 };
  for (const a of apps) counts[a.status] += 1;
  return counts;
}

export function filterApplications(
  apps: JobApplication[],
  { status, query }: { status: ApplicationStatus | 'all'; query: string },
): JobApplication[] {
  const q = query.trim().toLowerCase();
  return apps.filter((a) => {
    if (status !== 'all' && a.status !== status) return false;
    if (!q) return true;
    return [a.full_name, a.email, a.location, a.cover_note, a.staff_notes].some((v) => v?.toLowerCase().includes(q));
  });
}
