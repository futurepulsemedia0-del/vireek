import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature, webhookTenants } from './engine';

const KEY = 'test-webhook-key';
const BODY = '{"events":[]}';
const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64');

describe('xero webhook signature (constant-time HMAC)', () => {
  it('accepts a correct signature', async () => {
    expect(await verifyWebhookSignature(BODY, sign(BODY, KEY), KEY)).toBe(true);
  });
  it('rejects a wrong key, a tampered body, a missing header and an empty key', async () => {
    expect(await verifyWebhookSignature(BODY, sign(BODY, 'other-key'), KEY)).toBe(false);
    expect(await verifyWebhookSignature(BODY + ' ', sign(BODY, KEY), KEY)).toBe(false);
    expect(await verifyWebhookSignature(BODY, null, KEY)).toBe(false);
    expect(await verifyWebhookSignature(BODY, sign(BODY, KEY), '')).toBe(false);
  });
  it('treats an empty events list as a valid intent-to-receive probe', () => {
    expect(webhookTenants({ events: [] })).toEqual([]);
  });
});
