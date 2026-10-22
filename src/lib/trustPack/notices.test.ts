import { describe, it, expect } from 'vitest';
import {
  DAY_MS, criticalRemediationRate, diffProcessors, emptyCounts, escapeHtml, normalizeCounts, noticePhase, openFindings,
  renderNoticeEmail, totalFindings, validateNoticeInput, validatePentestInput, type NoticeInput, type SubprocessorNotice,
} from './notices';

const NOW = Date.parse('2026-10-20T00:00:00Z');
const input = (o: Partial<NoticeInput> = {}): NoticeInput => ({
  processor_name: 'Acme AI', change_type: 'add', purpose: 'Speech recognition', location: 'Ireland', data_types: 'Call audio',
  summary: 'We are adding Acme AI for transcription.', effective_at: new Date(NOW + 31 * DAY_MS).toISOString(), emergency: false, ...o,
});

describe('validateNoticeInput', () => {
  it('accepts a complete notice with a 30+ day window', () => {
    expect(validateNoticeInput(input(), NOW)).toEqual({});
  });
  it('requires the 30-day window unless it is an emergency', () => {
    const soon = new Date(NOW + 5 * DAY_MS).toISOString();
    expect(validateNoticeInput(input({ effective_at: soon }), NOW).effective_at).toContain('30 days');
    expect(validateNoticeInput(input({ effective_at: soon, emergency: true }), NOW)).toEqual({});
  });
  it('flags missing fields and replace without a name', () => {
    const e = validateNoticeInput(input({ processor_name: '', change_type: 'replace', replaces_name: '', summary: 'short' }), NOW);
    expect(Object.keys(e).sort()).toEqual(['processor_name', 'replaces_name', 'summary']);
    expect(validateNoticeInput(input({ change_type: 'bogus' }), NOW).change_type).toBeTruthy();
    expect(validateNoticeInput(input({ effective_at: 'nope' }), NOW).effective_at).toBeTruthy();
  });
});

describe('noticePhase', () => {
  it('moves from objection window to effective, unless withdrawn', () => {
    expect(noticePhase({ effective_at: new Date(NOW + DAY_MS).toISOString(), withdrawn_at: null }, NOW)).toBe('objection_open');
    expect(noticePhase({ effective_at: new Date(NOW - DAY_MS).toISOString(), withdrawn_at: null }, NOW)).toBe('effective');
    expect(noticePhase({ effective_at: new Date(NOW + DAY_MS).toISOString(), withdrawn_at: 'x' }, NOW)).toBe('withdrawn');
  });
});

describe('diffProcessors', () => {
  const p = (name: string, location = 'United States', purpose = 'p', dataTypes = 'd') => ({ name, purpose, location, dataTypes });
  it('detects additions, removals and changes', () => {
    const d = diffProcessors([p('A'), p('B'), p('C')], [p('A'), p('C', 'Ireland'), p('D')]);
    expect(d.map((x) => `${x.change_type}:${x.processor_name}`).sort()).toEqual(['add:D', 'change:C', 'remove:B']);
    expect(d.find((x) => x.processor_name === 'C')?.detail).toContain('United States → Ireland');
  });
  it('returns nothing when identical', () => {
    expect(diffProcessors([p('A')], [p('A')])).toEqual([]);
  });
});

describe('renderNoticeEmail', () => {
  const n: SubprocessorNotice = {
    id: '1', processor_name: 'Acme <b>AI</b>', change_type: 'replace', replaces_name: 'Old Co', purpose: 'p', location: 'Ireland', data_types: 'audio',
    summary: 'We "switch" <script>x</script>', posted_at: '', effective_at: '2026-12-01T00:00:00Z', emergency: false, withdrawn_at: null,
  };
  it('escapes HTML and links to the portal', () => {
    const m = renderNoticeEmail(n, { siteUrl: 'https://vireek.com/', unsubscribeUrl: 'https://vireek.com/u?x=1&y=2' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;b&gt;AI');
    expect(m.html).toContain('https://vireek.com/trust/security#subprocessor-notices');
    expect(m.html).toContain('x=1&amp;y=2');
    expect(m.subject).toBe('Sub-processor replacement: Acme <b>AI</b> (effective 2026-12-01)');
    expect(m.text).toContain('replaces Old Co');
  });
  it('omits unsubscribe for account owners', () => {
    expect(renderNoticeEmail(n, { siteUrl: 'https://vireek.com', unsubscribeUrl: null }).text).not.toContain('Unsubscribe');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('pentest helpers', () => {
  it('normalizes counts defensively', () => {
    expect(normalizeCounts({ critical: 2, high: -1, medium: 1.5, low: 'x' })).toEqual({ critical: 2, high: 0, medium: 0, low: 0, info: 0 });
    expect(normalizeCounts(null)).toEqual(emptyCounts());
  });
  it('computes remediation and open findings', () => {
    const found = { critical: 1, high: 3, medium: 5, low: 2, info: 0 };
    const rem = { critical: 1, high: 2, medium: 9, low: 0, info: 0 };
    expect(criticalRemediationRate(found, rem)).toBe(75);
    expect(criticalRemediationRate(emptyCounts(), emptyCounts())).toBeNull();
    expect(openFindings(found, rem)).toEqual({ critical: 0, high: 1, medium: 0, low: 2, info: 0 });
    expect(totalFindings(found)).toBe(11);
  });
  const good = { title: 'Annual test 2026', tester: 'Acme Security', performed_on: '2026-09-01', scope: 'Web app and API', methodology: 'OWASP ASVS grey-box',
    summary: 'No critical issues; two high issues fixed within SLA.', found: { critical: 0, high: 2, medium: 1, low: 0, info: 0 }, remediated: { critical: 0, high: 2, medium: 0, low: 0, info: 0 } };
  it('validates pentest input', () => {
    expect(validatePentestInput(good, NOW)).toEqual({});
    expect(validatePentestInput({ ...good, performed_on: '2027-01-01' }, NOW).performed_on).toContain('future');
    expect(validatePentestInput({ ...good, performed_on: '09/01/2026' }, NOW).performed_on).toBeTruthy();
    expect(validatePentestInput({ ...good, remediated: { ...good.remediated, high: 3 } }, NOW).remediated).toContain('high');
    expect(validatePentestInput({ ...good, title: '' }, NOW).title).toBeTruthy();
  });
});
