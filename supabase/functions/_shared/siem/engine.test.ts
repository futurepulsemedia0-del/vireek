import { describe, it, expect } from 'vitest';
import {
  MAX_CONSECUTIVE_FAILURES,
  buildDatadogBody,
  buildRequest,
  buildSplunkBody,
  categorize,
  chunkBySize,
  classifyHttpStatus,
  datadogEndpoint,
  isBlockedHost,
  isValidSecret,
  meetsMinSeverity,
  nextAttemptDelayMs,
  redact,
  sanitizeError,
  statusAfterFailure,
  toSiemEvent,
  validateSplunkUrl,
  type AuditRow,
} from './engine';

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 'evt-1',
  created_at: '2027-12-31T10:00:00.123456+00:00',
  actor_id: 'u1',
  actor_email: 'owner@acme.com',
  action: 'mfa_disabled',
  target_table: 'profiles',
  target_id: 'u1',
  metadata: null,
  ...over,
});

describe('redact', () => {
  it('redacts secret-looking keys at any depth and leaves the rest', () => {
    const out = redact({ token: 'abc', nested: { apiKey: 'k', Authorization: 'Bearer x', ok: 1 }, list: [{ password: 'p' }] }) as any;
    expect(out.token).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.Authorization).toBe('[REDACTED]');
    expect(out.nested.ok).toBe(1);
    expect(out.list[0].password).toBe('[REDACTED]');
  });
});

describe('categorize', () => {
  it('maps security actions to category and severity', () => {
    expect(categorize('mfa_disabled')).toEqual({ category: 'authentication', severity: 'high' });
    expect(categorize('custom_role_created')).toEqual({ category: 'identity_access', severity: 'medium' });
    expect(categorize('security_policy_updated').severity).toBe('high');
    expect(categorize('something_unknown')).toEqual({ category: 'other', severity: 'info' });
  });
  it('orders severities', () => {
    expect(meetsMinSeverity('high', 'medium')).toBe(true);
    expect(meetsMinSeverity('low', 'medium')).toBe(false);
    expect(meetsMinSeverity('info', 'info')).toBe(true);
  });
});

describe('toSiemEvent', () => {
  it('builds a normalised, redacted event', () => {
    const e = toSiemEvent(row({ metadata: { token: 'secret', plan: 'business' } }), 'acct-1');
    expect(e.id).toBe('evt-1');
    expect(e.time).toBe('2027-12-31T10:00:00.123Z');
    expect(e.account_id).toBe('acct-1');
    expect(e.metadata).toEqual({ token: '[REDACTED]', plan: 'business' });
    expect(JSON.stringify(e)).not.toContain('secret');
  });
  it('uses null metadata when empty', () => {
    expect(toSiemEvent(row({ metadata: {} }), 'a').metadata).toBeNull();
  });
});

describe('URL validation (SSRF)', () => {
  it('accepts public https HEC URLs and normalises the path', () => {
    const a = validateSplunkUrl('https://http-inputs-acme.splunkcloud.com:443');
    expect(a).toEqual({ ok: true, url: 'https://http-inputs-acme.splunkcloud.com/services/collector/event' });
    const b = validateSplunkUrl('https://splunk.acme.com:8088/services/collector/');
    expect(b.ok && b.url).toBe('https://splunk.acme.com:8088/services/collector/event');
  });
  it.each([
    ['http://splunk.acme.com'],
    ['https://user:pw@splunk.acme.com'],
    ['https://127.0.0.1:8088'],
    ['https://10.1.2.3'],
    ['https://169.254.169.254'],
    ['https://192.168.1.10'],
    ['https://localhost:8088'],
    ['https://splunk.internal'],
    ['https://[::1]:8088'],
    ['https://splunk.acme.com:80'],
    ['not a url'],
    [''],
  ])('rejects %s', (url) => {
    expect(validateSplunkUrl(url).ok).toBe(false);
  });
  it('blocks private hosts only', () => {
    expect(isBlockedHost('172.20.0.1')).toBe(true);
    expect(isBlockedHost('172.32.0.1')).toBe(false);
    expect(isBlockedHost('splunk.acme.com')).toBe(false);
  });
  it('only builds Datadog endpoints from allow-listed sites', () => {
    expect(datadogEndpoint('datadoghq.eu')).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
    expect(datadogEndpoint('evil.com')).toBeNull();
    expect(datadogEndpoint('')).toBeNull();
  });
  it('validates secrets', () => {
    expect(isValidSecret('abcd1234')).toBe(true);
    expect(isValidSecret('short')).toBe(false);
    expect(isValidSecret('has space 1234')).toBe(false);
  });
});

describe('request building', () => {
  const ev = toSiemEvent(row(), 'acct-1');
  it('builds a Splunk HEC request (one JSON object per line, optional index)', () => {
    const req = buildRequest(
      { provider: 'splunk_hec', endpoint_url: 'https://splunk.acme.com:8088', datadog_site: null, splunk_index: 'security', splunk_sourcetype: null },
      'tok-12345678',
      [ev, ev],
    )!;
    expect(req.url).toBe('https://splunk.acme.com:8088/services/collector/event');
    expect(req.headers.Authorization).toBe('Splunk tok-12345678');
    const lines = req.body.split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ host: 'vireek', index: 'security', sourcetype: 'vireek:audit' });
    expect(lines[0].time).toBeCloseTo(1830247200.123, 3);
    expect(lines[0].event.id).toBe('evt-1');
  });
  it('builds a Datadog request with severity-mapped status and safe tags', () => {
    const req = buildRequest(
      { provider: 'datadog', endpoint_url: null, datadog_site: 'datadoghq.com', splunk_index: null, splunk_sourcetype: null },
      'dd-key-12345678',
      [ev],
    )!;
    expect(req.headers['DD-API-KEY']).toBe('dd-key-12345678');
    const [entry] = JSON.parse(req.body);
    expect(entry.status).toBe('error');
    expect(entry.ddtags).toContain('severity:high');
    expect(entry.usr.email).toBe('owner@acme.com');
    expect(entry.vireek.id).toBe('evt-1');
  });
  it('returns null for an invalid destination instead of sending', () => {
    expect(buildRequest({ provider: 'datadog', endpoint_url: null, datadog_site: 'evil.com', splunk_index: null, splunk_sourcetype: null }, 'x'.repeat(10), [ev])).toBeNull();
    expect(buildRequest({ provider: 'splunk_hec', endpoint_url: 'http://x.com', datadog_site: null, splunk_index: null, splunk_sourcetype: null }, 'x'.repeat(10), [ev])).toBeNull();
  });
  it('bodies are well-formed for empty input', () => {
    expect(buildSplunkBody([], { splunk_index: null, splunk_sourcetype: null })).toBe('');
    expect(buildDatadogBody([])).toBe('[]');
  });
});

describe('batching and retry policy', () => {
  it('chunks by count and bytes, preserving order', () => {
    const items = [1, 2, 3, 4, 5];
    expect(chunkBySize(items, () => 400_000, 200, 900_000).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunkBySize(items, () => 1, 2, 1000).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunkBySize(items, () => 1).flat()).toEqual(items);
    expect(chunkBySize([], () => 1)).toEqual([]);
  });
  it('classifies HTTP statuses', () => {
    expect(classifyHttpStatus(200)).toBe('ok');
    expect(classifyHttpStatus(202)).toBe('ok');
    expect(classifyHttpStatus(401)).toBe('auth');
    expect(classifyHttpStatus(403)).toBe('auth');
    expect(classifyHttpStatus(429)).toBe('retry');
    expect(classifyHttpStatus(503)).toBe('retry');
    expect(classifyHttpStatus(400)).toBe('permanent');
    expect(classifyHttpStatus(413)).toBe('permanent');
    expect(classifyHttpStatus(302)).toBe('permanent');
  });
  it('backs off exponentially up to one hour', () => {
    const mid = () => 0.5;
    expect(nextAttemptDelayMs(1, mid)).toBe(60_000);
    expect(nextAttemptDelayMs(2, mid)).toBe(120_000);
    expect(nextAttemptDelayMs(3, mid)).toBe(240_000);
    expect(nextAttemptDelayMs(50, mid)).toBe(3_600_000);
  });
  it('derives status after a failure', () => {
    expect(statusAfterFailure('auth', 1)).toBe('auth_failed');
    expect(statusAfterFailure('retry', 1)).toBe('degraded');
    expect(statusAfterFailure('retry', MAX_CONSECUTIVE_FAILURES)).toBe('failing');
  });
  it('strips the secret from error text', () => {
    expect(sanitizeError('bad token tok-12345678 here', 'tok-12345678')).toBe('bad token *** here');
    expect(sanitizeError('x'.repeat(500), '').length).toBe(300);
  });
});
