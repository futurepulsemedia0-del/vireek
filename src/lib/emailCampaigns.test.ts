import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  bounceRate,
  clickRate,
  extractLinks,
  formatPct,
  isoToLocalInput,
  localInputToIso,
  openRate,
  previewEmail,
  progress,
  renderEmail,
  validateDraft,
  validateSchedule,
} from './emailCampaigns';
import { analyzeAudience } from '../../supabase/functions/_shared/email-campaigns/audience';
import { fillTemplate, escapeHtml, singleLine } from '../../supabase/functions/_shared/email-campaigns/render';
import { signSvix, verifySvix } from '../../supabase/functions/_shared/email-campaigns/svix';

const base = {
  name: 'Spring tune-up',
  subject: 'Hi {{first_name}}',
  body: 'Book now: https://example.com/book?x=1&y=2.',
  sender_address: '1 Main St, Austin TX 78701',
  reply_to: null,
  audience: 'all_opted_in' as const,
  segment_id: null,
};

describe('renderEmail', () => {
  const render = (over: Partial<Parameters<typeof renderEmail>[0]> = {}) =>
    renderEmail({
      subject: base.subject,
      body: base.body,
      vars: { name: 'Ada Lovelace', first_name: 'Ada', company_name: 'Acme HVAC' },
      companyName: 'Acme HVAC',
      senderAddress: base.sender_address,
      unsubscribeUrl: 'https://app.test/email/unsubscribe/abc',
      ...over,
    });

  it('personalises subject and body, always includes company, address and unsubscribe', () => {
    const r = render();
    expect(r.subject).toBe('Hi Ada');
    expect(r.html).toContain('Acme HVAC');
    expect(r.html).toContain('1 Main St, Austin TX 78701');
    expect(r.html).toContain('https://app.test/email/unsubscribe/abc');
    expect(r.text).toContain('Unsubscribe: https://app.test/email/unsubscribe/abc');
  });

  it('escapes HTML in recipient data and template (no injection via a customer name)', () => {
    const r = render({ subject: 'x', body: 'Hello {{name}} <script>alert(1)</script>', vars: { name: '<img src=x onerror=1>', first_name: 'x', company_name: 'c' } });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('strips CR/LF from the subject (header injection)', () => {
    expect(render({ subject: 'Hi\r\nBcc: evil@x.com' }).subject).toBe('Hi Bcc: evil@x.com');
  });

  it('rewrites known links to tracked URLs, keeps trailing punctuation outside the link', () => {
    const url = 'https://example.com/book?x=1&y=2';
    const r = render({ trackedLinks: new Map([[url, 'https://fn.test/email-track?t=T&l=L']]) });
    expect(r.html).toContain('href="https://fn.test/email-track?t=T&amp;l=L"');
    expect(r.html).toContain('</a>.');
    expect(r.text).toContain(url);
  });

  it('adds the open pixel only when asked, and the hidden preheader when set', () => {
    expect(render().html).not.toContain('<img');
    const r = render({ openPixelUrl: 'https://fn.test/email-track?t=T&k=o', preheader: 'Preview {{first_name}}' });
    expect(r.html).toContain('width="1" height="1"');
    expect(r.html).toContain('Preview Ada');
  });

  it('previewEmail uses the same renderer', () => {
    expect(previewEmail({ subject: 'S', preheader: null, body: 'B', sender_address: 'addr' }, 'Co').html).toContain('Unsubscribe');
  });
});

describe('helpers', () => {
  it('extractLinks finds distinct http(s) links and ignores punctuation', () => {
    expect(extractLinks('a https://a.com/x. b https://a.com/x c (https://b.com) javascript:alert(1)')).toEqual(['https://a.com/x', 'https://b.com']);
  });
  it('fillTemplate blanks unknown keys; escapeHtml/singleLine behave', () => {
    expect(fillTemplate('{{ a }}-{{b}}', { a: '1' })).toBe('1-');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    expect(singleLine(' a\n\n b ')).toBe('a b');
  });
});

describe('validateDraft / validateSchedule', () => {
  it('accepts a complete draft', () => expect(validateDraft(base)).toEqual([]));
  it('reports every missing piece', () => {
    const errs = validateDraft({ ...base, name: '', subject: ' ', body: '', sender_address: 'x', reply_to: 'nope', audience: 'segment', segment_id: null });
    expect(errs).toHaveLength(6);
  });
  it('enforces the schedule window', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(validateSchedule('garbage', now)).toMatch(/valid/);
    expect(validateSchedule('2026-01-01T00:00:30Z', now)).toMatch(/minute/);
    expect(validateSchedule('2028-01-01T00:00:00Z', now)).toMatch(/year/);
    expect(validateSchedule('2026-01-02T00:00:00Z', now)).toBeNull();
  });
  it('round-trips datetime-local values', () => {
    const iso = '2027-03-04T09:30:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });
});

describe('stats', () => {
  const c = { sent_count: 200, unique_opens: 50, unique_clicks: 10, bounce_count: 4, failed_count: 0, recipient_count: 400 };
  it('computes rates safely (no divide-by-zero)', () => {
    expect(openRate(c)).toBe(0.25);
    expect(clickRate(c)).toBe(0.05);
    expect(bounceRate(c)).toBe(0.02);
    expect(openRate({ unique_opens: 0, sent_count: 0 })).toBe(0);
    expect(progress(c)).toBe(0.5);
    expect(formatPct(0.256)).toBe('26%');
    expect(formatPct(0.0456)).toBe('4.6%');
    expect(formatPct(0)).toBe('0%');
  });
});

describe('analyzeAudience (consent + suppression gate)', () => {
  it('only emails opted-in, non-suppressed customers, once per address', () => {
    const a = analyzeAudience(
      [
        { customer_id: 'c1', email: 'Ann@x.com', name: 'Ann' },
        { customer_id: 'c2', email: 'ann@x.com', name: 'Ann dup' },
        { customer_id: 'c3', email: 'bob@x.com', name: 'Bob' }, // not opted in
        { customer_id: 'c4', email: 'sue@x.com', name: 'Sue' }, // suppressed
        { customer_id: 'c5', email: null, name: 'No Email' },
        { customer_id: 'c6', email: 'not-an-email', name: 'Bad' },
        { lead_id: 'l1', email: 'lead@x.com', name: 'Lead' },
      ],
      new Set(['sue@x.com']),
      new Set(['c1', 'c2', 'c4', 'c5', 'c6']),
    );
    expect(a.eligible.map((e) => e.email)).toEqual(['ann@x.com']);
    expect(a.excluded).toEqual({ no_email: 1, invalid_email: 1, suppressed: 1, not_opted_in: 1, lead_no_consent: 1, duplicate: 1 });
    expect(a.total).toBe(7);
  });
});

describe('verifySvix (Resend webhook signature)', () => {
  const secret = 'whsec_' + btoa('super-secret-key-bytes');
  const body = '{"type":"email.bounced"}';
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  it('accepts a valid signature, including among multiple', async () => {
    const sig = await signSvix(secret, 'msg_1', ts, body);
    expect(await verifySvix(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(true);
    expect(await verifySvix(secret, { id: 'msg_1', timestamp: ts, signature: `v1,bogus v1,${sig}` }, body, now)).toBe(true);
  });
  it('rejects tampered bodies, wrong ids, missing headers and stale timestamps', async () => {
    const sig = await signSvix(secret, 'msg_1', ts, body);
    expect(await verifySvix(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body + ' ', now)).toBe(false);
    expect(await verifySvix(secret, { id: 'msg_2', timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await verifySvix(secret, { id: null, timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await verifySvix(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body, now + 10 * 60_000)).toBe(false);
  });
});
