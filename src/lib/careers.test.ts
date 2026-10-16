import { describe, it, expect } from 'vitest';
import {
  EMPTY_APPLICATION,
  buildJobPostingJsonLd,
  countByStatus,
  emptyPostingForm,
  filterApplications,
  formToPayload,
  formatSalary,
  isHttpUrl,
  postedAgo,
  slugify,
  splitLines,
  validateApplication,
  validatePostingForm,
  validateSlug,
  type JobApplication,
  type JobPosting,
  type PostingFormValues,
} from './careers';

const posting = (over: Partial<JobPosting> = {}): JobPosting => ({
  id: 'p1',
  slug: 'senior-engineer',
  title: 'Senior Engineer',
  department: 'Engineering',
  location: 'United States',
  location_type: 'remote',
  employment_type: 'full_time',
  summary: 'Build the AI receptionist for the trades.',
  description: 'Own features end to end.',
  responsibilities: ['Ship weekly'],
  requirements: ['5+ years'],
  salary_min: null,
  salary_max: null,
  salary_currency: 'USD',
  salary_period: 'year',
  status: 'open',
  published_at: '2026-10-01T10:00:00Z',
  closed_at: null,
  created_at: '2026-09-30T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  ...over,
});

const app = (over: Partial<JobApplication> = {}): JobApplication => ({
  id: 'a1', posting_id: 'p1', full_name: 'Sara Lee', email: 'sara@example.com', phone: null, location: null,
  linkedin_url: null, portfolio_url: null, resume_url: null, cover_note: null, referral_source: null,
  status: 'new', rating: null, staff_notes: null, created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  ...over,
});

const validForm = (over: Partial<PostingFormValues> = {}): PostingFormValues => ({
  ...emptyPostingForm(),
  title: 'Senior Engineer',
  slug: 'senior-engineer',
  department: 'Engineering',
  location: 'United States',
  summary: 'Build the AI receptionist for the trades.',
  description: 'Own features end to end across the stack.',
  ...over,
});

describe('slugs', () => {
  it('slugifies titles safely', () => {
    expect(slugify('Senior Full-Stack Engineer (Remote)!')).toBe('senior-full-stack-engineer-remote');
    expect(slugify('Café Manager')).toBe('cafe-manager');
    expect(slugify('   ')).toBe('');
    const long = slugify('a'.repeat(200) + ' b');
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
  });
  it('validates slug shape', () => {
    expect(validateSlug('ok-slug-1')).toBeNull();
    expect(validateSlug('ab')).not.toBeNull();
    expect(validateSlug('Bad_Slug')).not.toBeNull();
    expect(validateSlug('double--hyphen')).not.toBeNull();
  });
});

describe('splitLines', () => {
  it('trims, drops blanks and leading bullets', () => {
    expect(splitLines('  - one\n\n• two \n*three')).toEqual(['one', 'two', 'three']);
  });
});

describe('posting form', () => {
  it('accepts a minimal valid posting', () => {
    expect(validatePostingForm(validForm())).toEqual({});
  });
  it('reports each invalid field', () => {
    const e = validatePostingForm(validForm({ title: 'x', slug: 'Bad Slug', summary: 'short', salaryCurrency: 'US' }));
    expect(Object.keys(e).sort()).toEqual(['salaryCurrency', 'slug', 'summary', 'title']);
  });
  it('requires both salary bounds and min <= max', () => {
    expect(validatePostingForm(validForm({ salaryMin: '100000' })).salaryMin).toBeDefined();
    expect(validatePostingForm(validForm({ salaryMin: '150000', salaryMax: '100000' })).salaryMin).toMatch(/higher/);
    expect(validatePostingForm(validForm({ salaryMin: '100,000', salaryMax: '150000' }))).toEqual({});
  });
  it('caps list length', () => {
    const many = Array.from({ length: 21 }, (_, i) => `item ${i}`).join('\n');
    expect(validatePostingForm(validForm({ requirements: many })).requirements).toBeDefined();
  });
  it('builds a clean DB payload', () => {
    const p = formToPayload(validForm({ salaryMin: '100,000', salaryMax: '150000', salaryCurrency: 'eur', requirements: '- a\n- b' }));
    expect(p.salary_min).toBe(100000);
    expect(p.salary_max).toBe(150000);
    expect(p.salary_currency).toBe('EUR');
    expect(p.requirements).toEqual(['a', 'b']);
    expect(formToPayload(validForm()).salary_min).toBeNull();
  });
});

describe('application form', () => {
  const ok = { ...EMPTY_APPLICATION, fullName: 'Sara Lee', email: 'sara@example.com', consent: true };
  it('accepts a minimal valid application', () => {
    expect(validateApplication(ok)).toEqual({});
  });
  it('requires name, email and consent', () => {
    expect(Object.keys(validateApplication(EMPTY_APPLICATION))).toEqual(['fullName', 'email', 'consent']);
  });
  it('rejects non-http links (no javascript: URLs reach staff)', () => {
    expect(isHttpUrl('https://linkedin.com/in/sara')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('https://a.com/with space')).toBe(false);
    expect(validateApplication({ ...ok, resumeUrl: 'ftp://x.com/cv.pdf' }).resumeUrl).toBeDefined();
  });
  it('limits the cover note', () => {
    expect(validateApplication({ ...ok, coverNote: 'x'.repeat(3001) }).coverNote).toBeDefined();
  });
});

describe('formatting', () => {
  it('formats salary ranges or returns null', () => {
    expect(formatSalary(posting())).toBeNull();
    expect(formatSalary(posting({ salary_min: 100000, salary_max: 150000 }))).toBe('$100,000 – $150,000 per year');
  });
  it('describes how long ago a role was posted', () => {
    const now = new Date('2026-10-08T12:00:00Z').getTime();
    expect(postedAgo('2026-10-08T01:00:00Z', now)).toBe('Posted today');
    expect(postedAgo('2026-10-07T01:00:00Z', now)).toBe('Posted yesterday');
    expect(postedAgo('2026-10-01T12:00:00Z', now)).toBe('Posted 7 days ago');
  });
});

describe('JobPosting JSON-LD', () => {
  it('marks remote roles as telecommute with an applicant country', () => {
    const ld = buildJobPostingJsonLd(posting());
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.jobLocationType).toBe('TELECOMMUTE');
    expect(ld.applicantLocationRequirements).toEqual({ '@type': 'Country', name: 'United States' });
    expect(ld.jobLocation).toBeUndefined();
    expect(ld.url).toBe('https://vireek.com/careers/senior-engineer');
    expect(ld.directApply).toBe(true);
    expect(ld.datePosted).toBe('2026-10-01');
  });
  it('uses a postal address for on-site roles and maps employment types', () => {
    const ld = buildJobPostingJsonLd(posting({ location_type: 'onsite', location: 'Austin', employment_type: 'contract' }));
    expect(ld.jobLocation).toEqual({ '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Austin' } });
    expect(ld.employmentType).toBe('CONTRACTOR');
    expect(ld.jobLocationType).toBeUndefined();
  });
  it('includes baseSalary only when a range is set', () => {
    expect(buildJobPostingJsonLd(posting()).baseSalary).toBeUndefined();
    const ld = buildJobPostingJsonLd(posting({ salary_min: 50, salary_max: 70, salary_period: 'hour' }));
    expect(ld.baseSalary).toMatchObject({ currency: 'USD', value: { minValue: 50, maxValue: 70, unitText: 'HOUR' } });
  });
});

describe('applicant pipeline', () => {
  const apps = [
    app({ id: '1', full_name: 'Sara Lee', status: 'new' }),
    app({ id: '2', full_name: 'Omid K', status: 'interview', staff_notes: 'Strong on React' }),
    app({ id: '3', full_name: 'Zed', status: 'rejected' }),
  ];
  it('counts per status', () => {
    expect(countByStatus(apps)).toEqual({ all: 3, new: 1, reviewing: 0, interview: 1, offer: 0, hired: 0, rejected: 1 });
  });
  it('filters by status and searches names, email and notes', () => {
    expect(filterApplications(apps, { status: 'interview', query: '' }).map((a) => a.id)).toEqual(['2']);
    expect(filterApplications(apps, { status: 'all', query: ' react ' }).map((a) => a.id)).toEqual(['2']);
    expect(filterApplications(apps, { status: 'all', query: 'SARA@' }).map((a) => a.id)).toEqual(['1', '2', '3']);
  });
});
