// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  boardConfigIssues, buildFeed, cdata, isFeedBoard, postingFeedIssues, salaryText, validateBoardSettings, xmlText,
  type FeedOptions, type FeedPosting,
} from './engine';

const posting = (over: Partial<FeedPosting> = {}): FeedPosting => ({
  id: '7b1c7d3e-0f6a-4d2e-9a52-1d9f0c1e2a33', slug: 'field-ops-manager', title: 'Field Ops Manager', department: 'Operations',
  location: 'Austin, TX', location_type: 'onsite', employment_type: 'full_time',
  summary: 'Run day-to-day field operations for our customers.',
  description: 'You will own scheduling quality across hundreds of service businesses.\n\nSecond paragraph with <b>markup</b> & symbols.',
  responsibilities: ['Coach dispatchers'], requirements: ['3+ years in field service'],
  salary_min: 90000, salary_max: 120000, salary_currency: 'USD', salary_period: 'year', status: 'open',
  published_at: '2026-10-01T10:00:00Z', created_at: '2026-09-30T10:00:00Z', updated_at: '2026-10-02T10:00:00Z',
  city: 'Austin', region: 'TX', country: 'US', postal_code: '78701', ...over,
});
const opts = (over: Partial<FeedOptions> = {}): FeedOptions => ({
  companyName: 'Vireek', siteUrl: 'https://vireek.com', linkedinCompanyId: '1234567', posterEmail: 'jobs@vireek.com',
  buildDate: new Date('2026-10-02T10:00:00Z'), ...over,
});

describe('xml safety', () => {
  it('escapes text and strips illegal control characters', () => {
    expect(xmlText(`a & b <c> "d" 'e'\u0007`)).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
  });
  it('cannot be broken out of CDATA', () => {
    expect(cdata('x]]><evil/>')).toBe('<![CDATA[x]]]]><![CDATA[><evil/>]]>');
  });
  it('knows the supported boards', () => {
    expect(isFeedBoard('indeed')).toBe(true);
    expect(isFeedBoard('glassdoor')).toBe(false);
  });
});

describe('Indeed / ZipRecruiter feed', () => {
  it('emits the classic job layout with stable ids and tracked URLs', () => {
    const { xml, included, skipped } = buildFeed('indeed', [posting()], opts());
    expect(included).toBe(1);
    expect(skipped).toEqual([]);
    expect(xml).toContain('<referencenumber><![CDATA[7b1c7d3e-0f6a-4d2e-9a52-1d9f0c1e2a33]]></referencenumber>');
    expect(xml).toContain('https://vireek.com/careers/field-ops-manager?utm_source=indeed&utm_medium=job_board&utm_campaign=syndication');
    expect(xml).toContain('<jobtype><![CDATA[fulltime]]></jobtype>');
    expect(xml).toContain('<salary><![CDATA[$90,000 - $120,000 per year]]></salary>');
    expect(xml).toContain('<lastBuildDate>Fri, 02 Oct 2026 10:00:00 GMT</lastBuildDate>');
    expect(xml).toContain('&lt;b&gt;markup&lt;/b&gt; &amp; symbols'); // user text is escaped inside the HTML description
  });
  it('is deterministic (stable ETag) and valid when empty', () => {
    expect(buildFeed('ziprecruiter', [posting()], opts()).xml).toBe(buildFeed('ziprecruiter', [posting()], opts()).xml);
    const empty = buildFeed('indeed', [], opts());
    expect(empty.included).toBe(0);
    expect(empty.xml.trim().endsWith('</source>')).toBe(true);
  });
  it('never publishes drafts or closed roles', () => {
    const { included } = buildFeed('indeed', [posting({ status: 'draft' }), posting({ status: 'closed' })], opts());
    expect(included).toBe(0);
  });
});

describe('LinkedIn feed', () => {
  it('maps workplace and job type, and reports the expected job count', () => {
    const { xml } = buildFeed('linkedin', [posting({ location_type: 'hybrid', employment_type: 'contract' })], opts());
    expect(xml).toContain('<workplaceTypes>Hybrid</workplaceTypes>');
    expect(xml).toContain('<jobtype>CONTRACT</jobtype>');
    expect(xml).toContain('<expectedJobCount>1</expectedJobCount>');
    expect(xml).toContain('<companyId>1234567</companyId>');
    expect(xml).toContain('<posterEmail>jobs@vireek.com</posterEmail>');
    expect(xml).toContain('<location><![CDATA[Austin, TX, United States]]></location>');
  });
  it('keeps the partner job id within LinkedIn\'s 40-character limit', () => {
    const id = /<partnerJobId><!\[CDATA\[(.*?)\]\]><\/partnerJobId>/.exec(buildFeed('linkedin', [posting()], opts()).xml)?.[1] ?? '';
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(40);
  });
  it('skips jobs that are too short for LinkedIn but keeps them for Indeed', () => {
    const thin = posting({ summary: 'Short summary here.', description: 'Tiny description text.', responsibilities: [], requirements: [] });
    expect(buildFeed('linkedin', [thin], opts()).skipped[0]?.reasons).toContain('Write at least 100 characters of description.');
    expect(buildFeed('indeed', [thin], opts()).included).toBe(1);
  });
});

describe('readiness', () => {
  it('blocks on-site jobs without a city or country, and tells the editor why', () => {
    const p = posting({ city: null, country: null });
    expect(postingFeedIssues(p, 'indeed').blocking).toEqual(["Add the job's city.", "Add the job's country."]);
    const feed = buildFeed('indeed', [p, posting({ id: 'ok' })], opts());
    expect(feed.included).toBe(1);
    expect(feed.skipped.map((s) => s.title)).toEqual(['Field Ops Manager']);
  });
  it('lets remote jobs through with a country only; LinkedIn insists on it', () => {
    const remote = posting({ location_type: 'remote', city: null, region: null, postal_code: null });
    expect(postingFeedIssues(remote, 'linkedin').blocking).toEqual([]);
    const noCountry = posting({ location_type: 'remote', city: null, country: null });
    expect(postingFeedIssues(noCountry, 'indeed').blocking).toEqual([]);
    expect(postingFeedIssues(noCountry, 'linkedin').blocking).toHaveLength(1);
  });
  it('warns (does not block) on missing pay', () => {
    const r = postingFeedIssues(posting({ salary_min: null, salary_max: null }), 'indeed');
    expect(r.blocking).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(salaryText(posting({ salary_min: null, salary_max: null }))).toBeNull();
  });
  it('validates board settings and LinkedIn account requirements', () => {
    expect(validateBoardSettings({ companyId: '12ab', posterEmail: 'nope' })).toEqual({
      companyId: 'Use the numeric company ID from your LinkedIn Page admin URL.', posterEmail: 'Enter a valid email address.',
    });
    expect(validateBoardSettings({ companyId: '', posterEmail: '' })).toEqual({});
    expect(boardConfigIssues('linkedin', { linkedinCompanyId: null, posterEmail: null })).toHaveLength(2);
    expect(boardConfigIssues('indeed', { linkedinCompanyId: null, posterEmail: null })).toEqual([]);
  });
});
