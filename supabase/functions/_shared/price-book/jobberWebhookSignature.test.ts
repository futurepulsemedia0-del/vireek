import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { timingSafeEqualStr, verifyJobberWebhook } from './jobberWebhookSignature';

const SECRET = 'test-client-secret';
const BODY = '{"data":{"webHookEvent":{"topic":"CLIENT_CREATE"}}}';
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('base64');

describe('verifyJobberWebhook', () => {
  it('accepts a correct signature', async () => {
    expect(await verifyJobberWebhook(BODY, sign(BODY), SECRET)).toBe(true);
  });
  it('rejects a tampered body', async () => {
    expect(await verifyJobberWebhook(BODY + ' ', sign(BODY), SECRET)).toBe(false);
  });
  it('rejects a signature made with another secret', async () => {
    expect(await verifyJobberWebhook(BODY, sign(BODY, 'other'), SECRET)).toBe(false);
  });
  it('rejects missing header or missing secret', async () => {
    expect(await verifyJobberWebhook(BODY, null, SECRET)).toBe(false);
    expect(await verifyJobberWebhook(BODY, sign(BODY), '')).toBe(false);
  });
});

describe('timingSafeEqualStr', () => {
  it('compares correctly', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});
