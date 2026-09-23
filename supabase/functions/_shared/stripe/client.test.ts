import { describe, it, expect } from 'vitest';
import { verifyStripeSignature } from './client';

const SECRET = 'whsec_test_secret';

async function signPayload(payload: string, timestamp: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyStripeSignature', () => {
  it('accepts a correctly signed, fresh payload', async () => {
    const payload = JSON.stringify({ id: 'evt_123', type: 'invoice.paid' });
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signPayload(payload, timestamp, SECRET);
    const header = `t=${timestamp},v1=${sig}`;

    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(true);
  });

  it('rejects a payload that was tampered with after signing', async () => {
    const originalPayload = JSON.stringify({ id: 'evt_123', amount: 100 });
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signPayload(originalPayload, timestamp, SECRET);
    const header = `t=${timestamp},v1=${sig}`;

    const tamperedPayload = JSON.stringify({ id: 'evt_123', amount: 100000 });
    expect(await verifyStripeSignature(tamperedPayload, header, SECRET)).toBe(false);
  });

  it('rejects a signature produced with the wrong secret (forged webhook)', async () => {
    const payload = JSON.stringify({ id: 'evt_123' });
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signPayload(payload, timestamp, 'whsec_attacker_guess');
    const header = `t=${timestamp},v1=${sig}`;

    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  it('rejects a stale timestamp, even with a correct signature (replay protection)', async () => {
    const payload = JSON.stringify({ id: 'evt_123' });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes old
    const sig = await signPayload(payload, staleTimestamp, SECRET);
    const header = `t=${staleTimestamp},v1=${sig}`;

    expect(await verifyStripeSignature(payload, header, SECRET, 300)).toBe(false);
  });

  it('rejects a header missing the timestamp or signature parts', async () => {
    expect(await verifyStripeSignature('{}', 'v1=abc', SECRET)).toBe(false);
    expect(await verifyStripeSignature('{}', 't=123', SECRET)).toBe(false);
    expect(await verifyStripeSignature('{}', '', SECRET)).toBe(false);
  });
});
