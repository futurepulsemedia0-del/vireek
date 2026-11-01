import { describe, expect, it } from 'vitest';
import { contextFromRow, isSecurityEvent, pickRecipient, planSecurityNotification, timingSafeEqual, type SecurityEventRow } from './securityDispatch';
import { buildSecurityNotification, type SecurityEvent } from './securityTemplates';
import { toEmail } from './notification';

const row = (over: Partial<SecurityEventRow> = {}): SecurityEventRow => ({
  id: '00000000-0000-0000-0000-000000000001',
  user_id: '00000000-0000-0000-0000-0000000000a1',
  event: 'api_key_created',
  occurred_at: '2027-04-02T10:15:30Z',
  meta: { key_name: 'Zapier', key_prefix: 'vrk_live_a1b2c', secret: 'DO-NOT-LEAK' },
  ...over,
});

describe('planSecurityNotification', () => {
  it('uses only whitelisted meta and never leaks extra fields', () => {
    const n = planSecurityNotification(row(), 'en');
    const mail = toEmail(n!, { siteUrl: 'https://app.vireek.com' });
    expect(n?.body).toContain('“Zapier”');
    expect(mail.html).not.toContain('DO-NOT-LEAK');
    expect(mail.text).not.toContain('vrk_live_a1b2c');
  });
  it('returns null for unknown events and survives bad timestamps / null meta', () => {
    expect(planSecurityNotification(row({ event: 'nope' }), 'en')).toBeNull();
    expect(isSecurityEvent('password_changed')).toBe(true);
    expect(isSecurityEvent('drop table')).toBe(false);
    const ctx = contextFromRow(row({ occurred_at: 'garbage', meta: null }));
    expect(Number.isNaN(ctx.whenUtc.getTime())).toBe(false);
    expect(ctx.keyName).toBeNull();
  });
  it('strips control characters and caps key names', () => {
    const ctx = contextFromRow(row({ meta: { key_name: `a\r\nBcc: evil@x.com${'z'.repeat(200)}` } }));
    expect(ctx.keyName).not.toMatch(/[\r\n]/);
    expect((ctx.keyName ?? '').length).toBeLessThanOrEqual(80);
  });
});

describe('pickRecipient', () => {
  it('sends email_changed to the previous address, everything else to the current one', () => {
    expect(pickRecipient('email_changed', 'new@x.com', 'old@x.com')).toBe('old@x.com');
    expect(pickRecipient('email_changed', 'new@x.com', undefined)).toBe('new@x.com');
    expect(pickRecipient('password_changed', 'cur@x.com', 'old@x.com')).toBe('cur@x.com');
  });
  it('rejects malformed or header-injecting addresses', () => {
    expect(pickRecipient('password_changed', 'a@b.co\nBcc: x@y.z', null)).toBeNull();
    expect(pickRecipient('password_changed', '<a@b.co>', null)).toBeNull();
    expect(pickRecipient('password_changed', null, null)).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  it('compares equal / unequal / different-length strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});

describe('Persian security copy', () => {
  const EVENTS: SecurityEvent[] = ['new_sign_in', 'password_changed', 'email_changed', 'mfa_enrolled', 'mfa_disabled', 'recovery_codes_regenerated', 'api_key_created', 'api_key_revoked'];
  it.each(EVENTS)('%s renders fully in Persian with RTL and no English leftovers in title/body', (ev) => {
    const n = buildSecurityNotification(ev, { whenUtc: new Date('2027-04-02T10:15:30Z'), keyName: 'Zapier', newEmailMasked: 'j***@x.com' }, 'fa');
    expect(n.title).toMatch(/[\u0600-\u06FF]/);
    expect(n.body).toMatch(/[\u0600-\u06FF]/);
    expect(n.body).not.toMatch(/\{[a-zA-Z]+\}/);
    const mail = toEmail(n, { siteUrl: 'https://app.vireek.com', locale: 'fa' });
    expect(mail.dir).toBe('rtl');
    expect(mail.html).toContain('dir="rtl"');
  });
  it('falls back to English copy for locales without translations', () => {
    expect(buildSecurityNotification('password_changed', { whenUtc: new Date() }, 'de').title).toBe('Your password was changed');
  });
});
