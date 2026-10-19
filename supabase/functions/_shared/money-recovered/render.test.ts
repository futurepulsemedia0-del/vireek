import { describe, it, expect } from 'vitest';
import { computeStatement, weekWindowFor, type LedgerEvent } from './engine';
import { EMAIL_MAX_ROWS, callUrl, escapeHtml, renderStatementEmail } from './render';

const window = weekWindowFor('2026-10-05', 'UTC')!;
const now = new Date('2026-10-12T08:00:00Z');
const CALL_ID = '11111111-2222-3333-4444-555555555555';

const ev = (over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: 'e1', source_type: 'missed_call', call_id: CALL_ID, customer_name: 'Pat Lee',
  occurred_at: '2026-10-06T15:00:00Z', estimated_value_cents: 50_000, status: 'recovered',
  recovery_method: 'callback', recovered_amount_cents: 40_000, follow_up_count: 1,
  last_follow_up_at: '2026-10-07T15:00:00Z', resolved_at: '2026-10-08T15:00:00Z', ...over,
});
const baseline = { monthly_leak_cents: 600_000, source: 'leak_report', captured_at: '2026-03-01T00:00:00Z', label: null };

describe('renderStatementEmail', () => {
  const st = computeStatement({
    events: [ev(), ev({ id: 'e2', call_id: null, recovery_method: 'manual', customer_name: '<img src=x onerror=alert(1)>' })],
    calls: [{ id: CALL_ID, summary: 'Needs <b>urgent</b> AC repair', has_recording: true }],
    baseline, window, now,
  });

  it('puts the recovered amount and period in the subject, with no header injection', () => {
    const m = renderStatementEmail({ companyName: 'Acme\r\nBcc: evil@x.com HVAC', statement: st, siteUrl: 'https://app.vireek.com' });
    expect(m.subject).toContain('$400.00 recovered');
    expect(m.subject).toContain('Oct 5 – Oct 11, 2026');
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it('escapes caller-controlled text (names and summaries) in HTML', () => {
    const m = renderStatementEmail({ companyName: 'Acme', statement: st, siteUrl: 'https://app.vireek.com' });
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).not.toContain('<b>urgent</b>');
    expect(m.html).toContain('&lt;img src=x');
    expect(m.html).toContain('&lt;b&gt;urgent&lt;/b&gt;');
  });

  it('links each rescued call into the app, never to a raw recording URL', () => {
    const m = renderStatementEmail({ companyName: 'Acme', statement: st, siteUrl: 'https://app.vireek.com/' });
    expect(m.html).toContain(`https://app.vireek.com/dashboard/calls/${CALL_ID}`);
    expect(m.text).toContain(`https://app.vireek.com/dashboard/calls/${CALL_ID}`);
    expect(m.html).toContain('Listen &amp; view call');
  });

  it('explains the conservative method and shows the baseline comparison', () => {
    const m = renderStatementEmail({ companyName: 'Acme', statement: st, siteUrl: 'https://app.vireek.com' });
    expect(m.html).toContain('How we count (conservative attribution)');
    expect(m.text).toContain('A logged follow-up is required');
    expect(m.html).toContain('Compared with your baseline Leak Report');
    expect(m.html).toContain('Not claimed');
  });

  it('prompts for a baseline when none is recorded', () => {
    const none = computeStatement({ events: [ev()], calls: [], baseline: null, window, now });
    const m = renderStatementEmail({ companyName: 'Acme', statement: none, siteUrl: 'https://app.vireek.com' });
    expect(m.html).toContain('No baseline has been recorded yet');
    expect(m.html).toContain('No call linked');
  });

  it('renders a calm statement when nothing happened and prefixes test sends', () => {
    const empty = computeStatement({ events: [], calls: [], baseline: null, window, now });
    const m = renderStatementEmail({ companyName: 'Acme', statement: empty, siteUrl: 'https://app.vireek.com', subjectPrefix: '[Test] ' });
    expect(m.subject.startsWith('[Test] ')).toBe(true);
    expect(m.html).toContain('No recoveries or active follow-ups this week.');
    expect(m.text).toContain('Recovered by Vireek: $0.00');
  });

  it('caps the rows shown and says how many more are in the full statement', () => {
    const many = computeStatement({ events: Array.from({ length: EMAIL_MAX_ROWS + 5 }, (_, i) => ev({ id: `m${i}`, call_id: null })), calls: [], baseline: null, window, now });
    const m = renderStatementEmail({ companyName: 'Acme', statement: many, siteUrl: 'https://app.vireek.com' });
    expect(m.html).toContain('+ 5 more');
  });
});

describe('helpers', () => {
  it('only builds call links for real UUIDs', () => {
    expect(callUrl('https://x.test', CALL_ID)).toBe(`https://x.test/dashboard/calls/${CALL_ID}`);
    expect(callUrl('https://x.test', '../../admin')).toBeNull();
    expect(callUrl('https://x.test', null)).toBeNull();
  });
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
