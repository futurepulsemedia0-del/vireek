// HMAC-SHA256 verification of X-Jobber-Hmac-SHA256 against the RAW body, using the recorded-shape webhook fixture.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyJobberWebhook } from './jobberWebhookSignature';
import { jobberEventKey, parseJobberWebhook } from './jobberWebhook';

const SECRET = 'test-client-secret';
const RAW = readFileSync(new URL('./__fixtures__/jobber-webhook-app-disconnect.json', import.meta.url), 'utf8').trimEnd();
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('base64');

describe('Jobber webhook fixture', () => {
  it('verifies, parses and produces a stable de-dupe key', async () => {
    expect(await verifyJobberWebhook(RAW, sign(RAW), SECRET)).toBe(true);
    const e = parseJobberWebhook(RAW)!;
    expect(e).toMatchObject({ topic: 'APP_DISCONNECT', accountId: 'Z2lkOi8vSm9iYmVyL0FjY291bnQvOTk5' });
    expect(await jobberEventKey(e)).toBe(await jobberEventKey(parseJobberWebhook(RAW)!));
  });
  it('signature covers the exact bytes: re-serialised or whitespace-altered JSON fails', async () => {
    const reserialised = JSON.stringify(JSON.parse(RAW)); // same JSON value, different bytes only if the source had spacing
    const spaced = RAW.replace('"topic":', '"topic": ');
    expect(await verifyJobberWebhook(spaced, sign(RAW), SECRET)).toBe(false);
    expect(await verifyJobberWebhook(reserialised, sign(RAW), SECRET)).toBe(reserialised === RAW);
  });
  it('handles non-ASCII bodies (UTF-8 bytes, not UTF-16 code units)', async () => {
    const body = RAW.replace('APP_DISCONNECT', 'APP_DISCONNECT_é✓');
    expect(await verifyJobberWebhook(body, sign(body), SECRET)).toBe(true);
  });
  it('rejects empty, truncated, padded-wrong and hex-encoded signatures', async () => {
    const good = sign(RAW);
    for (const bad of ['', good.slice(0, -4), `${good}A`, createHmac('sha256', SECRET).update(RAW).digest('hex')]) {
      expect(await verifyJobberWebhook(RAW, bad, SECRET)).toBe(false);
    }
  });
  it('tolerates surrounding whitespace in the header value only', async () => {
    expect(await verifyJobberWebhook(RAW, ` ${sign(RAW)} `, SECRET)).toBe(true);
  });
});
