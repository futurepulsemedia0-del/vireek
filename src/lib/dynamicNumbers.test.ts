import { describe, it, expect } from 'vitest';
import {
  buildSnippet,
  formatPhone,
  friendlyError,
  normalizeE164,
  parseDomains,
  parseSignalsFromUrl,
  poolHealth,
  readinessIssues,
  slugifySourceKey,
  sourceLabel,
  sourceOptions,
  summarizePerformance,
  validateNumber,
  validateRule,
  validateSettings,
  type DniNumberRow,
  type DniPerformance,
  type DniRuleRow,
  type DniSettingsRow,
} from './dynamicNumbers';

const num = (over: Partial<DniNumberRow> = {}): DniNumberRow => ({
  id: 'n1', phone_e164: '+15559876543', vapi_phone_number_id: null, label: '', kind: 'pool', source_key: null, active: true, lease_until: null, ...over,
});
const settings = (over: Partial<DniSettingsRow> = {}): DniSettingsRow => ({
  account_owner_id: 'o1', public_key: 'dni_' + 'a'.repeat(32), enabled: true, default_number: '+15551234567',
  allowed_domains: [], lease_minutes: 30, last_seen_at: null, last_seen_host: null, ...over,
});
const perf = (over: Partial<DniPerformance> = {}): DniPerformance => ({
  days: 30, sources: [], pool: { pool_total: 4, pool_leased: 1, dedicated: 0 }, exhausted_events: 0, rate_limited_events: 0, ...over,
});

describe('phone numbers', () => {
  it('normalizes US/CA input to E.164', () => {
    expect(normalizeE164('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeE164('1-555-123-4567')).toBe('+15551234567');
    expect(normalizeE164('+44 20 7123 4567')).toBe('+442071234567');
    expect(normalizeE164('0044 20 7123 4567')).toBe('+442071234567');
  });
  it('rejects ambiguous or invalid input', () => {
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('12345')).toBeNull();
    expect(normalizeE164('442071234567')).toBeNull(); // no + and not a US length
    expect(normalizeE164('+0123456789')).toBeNull();
  });
  it('formats for display', () => {
    expect(formatPhone('+15551234567')).toBe('(555) 123-4567');
    expect(formatPhone('+442071234567')).toBe('+442071234567');
    expect(formatPhone(null)).toBe('—');
  });
});

describe('domains', () => {
  it('cleans protocol, path, port and www, and de-duplicates', () => {
    const { domains, invalid } = parseDomains('https://www.Acme.com/contact\nacme.com\nshop.acme.com:8080, bad_domain');
    expect(domains).toEqual(['acme.com', 'shop.acme.com']);
    expect(invalid).toEqual(['bad_domain']);
  });
});

describe('validation', () => {
  it('requires the normal number once tracking is enabled', () => {
    expect(validateSettings({ enabled: true, defaultNumber: '', domainsText: '', leaseMinutes: 30 }).defaultNumber).toBeTruthy();
    expect(validateSettings({ enabled: false, defaultNumber: '', domainsText: '', leaseMinutes: 30 })).toEqual({});
    expect(validateSettings({ enabled: false, defaultNumber: '', domainsText: '', leaseMinutes: 3 }).lease).toBeTruthy();
  });
  it('blocks duplicate numbers, the normal number and duplicate dedicated sources', () => {
    const existing = [num({ id: 'a', kind: 'source', source_key: 'google_ads' })];
    const draft = { kind: 'source' as const, phone: '(555) 987-6543', sourceKey: 'google_ads', label: '', vapiId: '' };
    const e = validateNumber(draft, existing, '+15551234567');
    expect(e.phone).toMatch(/already/);
    expect(e.sourceKey).toMatch(/already/);
    expect(validateNumber({ ...draft, phone: '(555) 123-4567' }, [], '+15551234567').phone).toMatch(/normal business number/);
    expect(validateNumber({ ...draft, phone: '(555) 222-3333', kind: 'pool' }, existing, null)).toEqual({});
  });
  it('validates rules', () => {
    const ok = { field: 'utm_campaign' as const, op: 'contains' as const, value: 'mailer', sourceLabel: 'Direct Mail', priority: 10 };
    expect(validateRule(ok, 0)).toEqual({});
    expect(validateRule({ ...ok, value: ' ' }, 0).value).toBeTruthy();
    expect(validateRule({ ...ok, op: 'present', value: '' }, 0)).toEqual({});
    expect(validateRule({ ...ok, sourceLabel: '!!!' }, 0).sourceLabel).toBeTruthy();
    expect(validateRule({ ...ok, priority: 0 }, 0).priority).toBeTruthy();
    expect(validateRule(ok, 50).sourceLabel).toMatch(/up to 50/);
  });
});

describe('sources', () => {
  it('slugs keys and labels sources', () => {
    expect(slugifySourceKey(' Spring Promo — Mailer! ')).toBe('spring_promo_mailer');
    expect(sourceLabel('google_ads')).toBe('Google Ads');
    expect(sourceLabel('utm_summer_sale')).toBe('Summer Sale');
  });
  it('adds custom rule sources to the dropdown once', () => {
    const rules = [{ source_key: 'direct_mail', source_label: 'Direct Mail' }, { source_key: 'google_ads', source_label: 'x' }] as DniRuleRow[];
    const keys = sourceOptions(rules).map((o) => o.key);
    expect(keys).toContain('direct_mail');
    expect(keys.filter((k) => k === 'google_ads')).toHaveLength(1);
  });
});

describe('install snippet', () => {
  const base = { origin: 'https://app.vireek.com/', publicKey: 'dni_abc', supabaseUrl: 'https://x.supabase.co/', supabaseAnonKey: 'anon"key' };
  it('builds an escaped, async script tag', () => {
    const s = buildSnippet({ ...base, requireConsent: false });
    expect(s).toContain('src="https://app.vireek.com/dni.js"');
    expect(s).toContain('data-api="https://x.supabase.co"');
    expect(s).toContain('data-anon="anon&quot;key"');
    expect(s).not.toContain('data-consent');
    expect(s).toContain('async');
  });
  it('adds the consent attribute when requested', () => {
    expect(buildSnippet({ ...base, requireConsent: true })).toContain('data-consent="required"');
  });
});

describe('parseSignalsFromUrl', () => {
  it('extracts UTM values, click id and path but never the raw query', () => {
    const r = parseSignalsFromUrl('www.acme.com/ac-repair?utm_source=google&utm_medium=cpc&gclid=abc&email=a@b.com', 'google.com')!;
    expect(r.host).toBe('acme.com');
    expect(r.signals).toMatchObject({ utm_source: 'google', utm_medium: 'cpc', click_id_type: 'gclid', click_id: 'abc', landing_path: '/ac-repair', referrer: 'https://google.com' });
    expect(JSON.stringify(r.signals)).not.toContain('a@b.com');
  });
  it('rejects things that are not addresses', () => {
    expect(parseSignalsFromUrl('hello', '')).toBeNull();
  });
});

describe('performance + health', () => {
  it('summarizes sessions, calls and rates; handles zero visits', () => {
    const s = summarizePerformance(perf({ sources: [
      { source_key: 'google_ads', source_label: 'Google Ads', sessions: 80, calls: 8, last_call_at: null },
      { source_key: 'direct', source_label: 'Direct', sessions: 20, calls: 0, last_call_at: null },
      { source_key: 'yelp', source_label: 'Yelp', sessions: 0, calls: 2, last_call_at: null },
    ] }));
    expect(s.sessions).toBe(100);
    expect(s.calls).toBe(10);
    expect(s.callRate).toBeCloseTo(0.1);
    expect(s.rows[0].callRate).toBeCloseTo(0.1);
    expect(s.rows[2].callRate).toBeNull();
    expect(summarizePerformance(null)).toEqual({ sessions: 0, calls: 0, callRate: null, rows: [] });
  });
  it('flags exhausted, busy and empty pools', () => {
    expect(poolHealth(null).level).toBe('info');
    expect(poolHealth(perf({ exhausted_events: 3 })).level).toBe('danger');
    expect(poolHealth(perf({ pool: { pool_total: 5, pool_leased: 4, dedicated: 0 } })).level).toBe('warn');
    expect(poolHealth(perf()).level).toBe('ok');
    expect(poolHealth(perf({ pool: { pool_total: 0, pool_leased: 0, dedicated: 0 } })).level).toBe('info');
  });
});

describe('readiness + errors', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z');
  it('lists what is missing', () => {
    expect(readinessIssues(null, [], NOW)).toHaveLength(2);
    expect(readinessIssues(settings(), [num()], NOW).join(' ')).toMatch(/not been seen/);
    expect(readinessIssues(settings({ last_seen_at: '2026-10-01T00:00:00Z' }), [num()], NOW).join(' ')).toMatch(/over 7 days/);
    expect(readinessIssues(settings({ last_seen_at: '2026-10-28T11:59:00Z' }), [num()], NOW)).toEqual([]);
  });
  it('maps database errors to friendly text', () => {
    expect(friendlyError({ message: 'duplicate key value violates unique constraint "idx_dni_numbers_phone"' })).toMatch(/already used/);
    expect(friendlyError({ message: 'DNI_LIMIT_NUMBERS' })).toMatch(/100/);
    expect(friendlyError({ message: 'new row violates row-level security policy' })).toMatch(/permission/);
    expect(friendlyError(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
