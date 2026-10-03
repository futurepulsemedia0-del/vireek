// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  allowedActions,
  checkEndpointShape,
  extractJsonObject,
  isPrivateIp,
  manifestLimits,
  parseAgentResponse,
  projectCustomer,
  projectJob,
  signRequest,
  validateAction,
} from './contract';

const UUID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const ALL = ['read:jobs', 'act:record_insight', 'act:create_task', 'act:send_sms'];

describe('validateAction', () => {
  it('accepts a valid insight', () => {
    const r = validateAction({ type: 'record_insight', reasoning: 'Compressor noise', params: { title: 'Check capacitor', body: 'Likely failing run capacitor.' } }, ALL);
    expect(r.ok).toBe(true);
  });

  it('rejects an action whose scope was not granted', () => {
    const r = validateAction({ type: 'send_sms', reasoning: 'Reminder', params: { customer_id: UUID, body: 'Hello' } }, ['act:record_insight']);
    expect(r).toEqual({ ok: false, error: 'Scope act:send_sms was not granted.' });
  });

  it('rejects prototype keys and unknown types', () => {
    expect(validateAction({ type: 'toString', reasoning: 'abc', params: {} }, ALL).ok).toBe(false);
    expect(validateAction({ type: 'delete_everything', reasoning: 'abc', params: {} }, ALL).ok).toBe(false);
  });

  it('blocks links in SMS (phishing guard)', () => {
    const base = { type: 'send_sms', reasoning: 'Reminder', params: { customer_id: UUID } };
    expect(validateAction({ ...base, params: { ...base.params, body: 'Pay at https://evil.example' } }, ALL).ok).toBe(false);
    expect(validateAction({ ...base, params: { ...base.params, body: 'Pay at evil.com now' } }, ALL).ok).toBe(false);
    expect(validateAction({ ...base, params: { ...base.params, body: 'Friendly reminder: invoice is open.' } }, ALL).ok).toBe(true);
  });

  it('requires entity_type and entity_id together', () => {
    const r = validateAction({ type: 'record_insight', reasoning: 'abc', params: { title: 'Title', body: 'Body text', entity_id: UUID } }, ALL);
    expect(r.ok).toBe(false);
  });

  it('rejects bad task_type and oversized payload', () => {
    expect(validateAction({ type: 'create_task', reasoning: 'abc', params: { task_type: 'Has Spaces' } }, ALL).ok).toBe(false);
    expect(validateAction({ type: 'create_task', reasoning: 'abc', params: { task_type: 'follow_up', payload: { x: 'a'.repeat(3000) } } }, ALL).ok).toBe(false);
  });
});

describe('parseAgentResponse', () => {
  it('caps actions at max_actions and reports rejects', () => {
    const action = { type: 'record_insight', reasoning: 'because', params: { title: 'Title', body: 'Body text' } };
    const out = parseAgentResponse({ summary: 'ok', actions: [action, action, action, { type: 'nope' }] }, ALL, 2);
    expect(out.actions).toHaveLength(2);
    expect(out.rejected.map((r) => r.index)).toEqual([2, 3]);
  });

  it('never throws on garbage', () => {
    expect(parseAgentResponse(null, ALL, 5).actions).toEqual([]);
    expect(parseAgentResponse('x', ALL, 5).actions).toEqual([]);
    expect(parseAgentResponse({ actions: 'nope' }, ALL, 5).actions).toEqual([]);
  });
});

describe('extractJsonObject', () => {
  it('parses fenced / prose-wrapped JSON', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('not json')).toBeNull();
  });
});

describe('data minimization', () => {
  const job = { id: 'j1', service_type: 'AC repair', customer_name: 'Jane', address: '1 Main St', invoice_amount: 500, invoice_status: 'sent', secret_note: 'x' };
  it('exposes only base job fields with read:jobs', () => {
    expect(projectJob(job, ['read:jobs'])).toEqual({ id: 'j1', service_type: 'AC repair' });
  });
  it('adds fields only when the matching scope is granted', () => {
    const p = projectJob(job, ['read:jobs', 'read:job_financials', 'read:customers', 'read:customer_contact']);
    expect(p).toMatchObject({ customer_name: 'Jane', address: '1 Main St', invoice_amount: 500 });
    expect(p).not.toHaveProperty('secret_note');
  });
  it('returns nothing without read:jobs', () => {
    expect(projectJob(job, ['read:customers'])).toEqual({});
  });
  it('hides contact details without read:customer_contact', () => {
    const c = { id: 'c1', name: 'Jane', phone: '+1555', email: 'a@b.co', notes: 'private' };
    expect(projectCustomer(c, ['read:customers'])).toEqual({ id: 'c1', name: 'Jane' });
    expect(projectCustomer(c, ['read:customers', 'read:customer_contact'])).toMatchObject({ phone: '+1555' });
  });
});

describe('endpoint safety', () => {
  it('accepts a public https endpoint', () => {
    expect(checkEndpointShape('https://agents.example.com/hook').ok).toBe(true);
  });
  it.each([
    'http://agents.example.com/hook',
    'https://localhost/hook',
    'https://127.0.0.1/hook',
    'https://2130706433/hook',
    'https://[::1]/hook',
    'https://user:pw@agents.example.com/hook',
    'https://agents.example.com:8443/hook',
    'https://service.internal/hook',
    'https://intranet/hook',
  ])('rejects %s', (u) => {
    expect(checkEndpointShape(u).ok).toBe(false);
  });
  it('flags private IPs', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('misc', () => {
  it('clamps manifest limits', () => {
    expect(manifestLimits({ scopes: [], triggers: [], limits: { timeout_ms: 999999, max_actions: 99 } })).toEqual({ timeoutMs: 15000, maxActions: 10 });
    expect(manifestLimits({ scopes: [], triggers: [] })).toEqual({ timeoutMs: 8000, maxActions: 5 });
  });
  it('derives allowed actions from granted scopes', () => {
    expect(allowedActions(['read:jobs', 'act:send_sms'])).toEqual(['send_sms']);
  });
  it('produces a stable, versioned HMAC signature', async () => {
    const a = await signRequest('whsec_test', 1700000000, '{"x":1}');
    const b = await signRequest('whsec_test', 1700000000, '{"x":1}');
    const c = await signRequest('whsec_test', 1700000001, '{"x":1}');
    expect(a).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
