// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createMockPartner } from './mock';
import { getPartner } from './registry';
import { hmacSha256Hex, parseSignatureHeader, sha256Hex, signWebhook, verifyWebhookSignature } from './signature';

const SECRET = 'test-secret-0123456789abcdef';
const env = (m: Record<string, string>) => (k: string) => m[k];

describe('webhook signature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'financing.status', reference: 'mock_app_x', status: 'approved' });

  it('accepts a correctly signed, fresh payload', async () => {
    const h = await signWebhook(body, SECRET);
    expect(await verifyWebhookSignature(body, h, SECRET)).toBe(true);
  });
  it('rejects a tampered body, wrong secret, missing header and weak secret', async () => {
    const h = await signWebhook(body, SECRET);
    expect(await verifyWebhookSignature(body + ' ', h, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(body, h, SECRET + 'x')).toBe(false);
    expect(await verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(body, h, undefined)).toBe(false);
    expect(await verifyWebhookSignature(body, await signWebhook(body, 'short'), 'short')).toBe(false);
  });
  it('rejects replays outside the tolerance window', async () => {
    const old = Date.now() - 10 * 60 * 1000;
    expect(await verifyWebhookSignature(body, await signWebhook(body, SECRET, old), SECRET)).toBe(false);
    expect(await verifyWebhookSignature(body, await signWebhook(body, SECRET, old), SECRET, { toleranceSeconds: 900 })).toBe(true);
  });
  it('parses headers defensively', () => {
    expect(parseSignatureHeader('garbage')).toBeNull();
    expect(parseSignatureHeader('t=abc,v1=ff')).toBeNull();
    expect(parseSignatureHeader(`t=${'1'.repeat(10)},v1=AB,v1=cd`)?.v1).toEqual(['ab', 'cd']);
  });
  it('sha256Hex and hmac are stable hex', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hmacSha256Hex('k', 'm')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('mock partner', () => {
  it('is unusable unless explicitly allowed (cannot serve prod by accident)', () => {
    expect(createMockPartner(env({})).isConfigured()).toBe(false);
    expect(createMockPartner(env({ FINANCING_PARTNER_ALLOW_MOCK: 'true' })).isConfigured()).toBe(true);
    expect(getPartner('mock')).toBeNull();
    expect(getPartner('Bad Key!')).toBeNull();
  });
  it('creates a deterministic, idempotent application with an https URL', async () => {
    const p = createMockPartner(env({ FINANCING_PARTNER_ALLOW_MOCK: 'true' }));
    const a = await p.createApplication({ referenceId: 'abc', amountCents: 50000, currency: 'USD', description: 'x', returnUrl: 'https://v.test' });
    const b = await p.createApplication({ referenceId: 'abc', amountCents: 50000, currency: 'USD', description: 'x', returnUrl: 'https://v.test' });
    expect(a).toEqual(b);
    expect(a.applicationUrl.startsWith('https://')).toBe(true);
  });
  it('verifies webhooks through the adapter and normalises events without PII', async () => {
    const p = createMockPartner(env({ FINANCING_PARTNER_ALLOW_MOCK: 'true', FINANCING_PARTNER_MOCK_WEBHOOK_SECRET: SECRET }));
    const raw = JSON.stringify({ id: 'e1', type: 'financing.status', reference: 'mock_app_1', status: 'funded', ssn: '000-00-0000' });
    const headers = new Headers({ 'X-Partner-Signature': await signWebhook(raw, SECRET) });
    expect(await p.verifyWebhook(raw, headers)).toBe(true);
    const ev = p.parseWebhook(raw);
    expect(ev).toEqual({ eventId: 'e1', kind: 'financing', partnerReference: 'mock_app_1', status: 'funded' });
    expect(JSON.stringify(ev)).not.toContain('000-00');
    expect(await p.verifyWebhook(raw, new Headers())).toBe(false);
  });
  it('rejects unknown statuses/types and oversize ids', () => {
    const p = createMockPartner(env({}));
    expect(p.parseWebhook('not json')).toBeNull();
    expect(p.parseWebhook(JSON.stringify({ id: 'e', type: 'financing.status', reference: 'r', status: 'weird' }))).toBeNull();
    expect(p.parseWebhook(JSON.stringify({ id: 'e', type: 'other', reference: 'r', status: 'funded' }))).toBeNull();
    expect(p.parseWebhook(JSON.stringify({ id: 'x'.repeat(200), type: 'financing.status', reference: 'r', status: 'funded' }))).toBeNull();
    expect(p.parseWebhook(JSON.stringify({ id: 'e', type: 'insurance.status', reference: 'r', status: 'bound' }))?.kind).toBe('insurance');
  });
});
