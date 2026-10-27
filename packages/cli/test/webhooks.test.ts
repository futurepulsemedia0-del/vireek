// @vitest-environment node
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_EVENTS,
  buildEnvelope,
  createWebhookListener,
  sampleData,
  sendTestDelivery,
  signPayload,
  validateEventName,
  validateTargetUrl,
  verifySignature,
  type ReceivedDelivery,
} from '../src/webhooks.js';

const SECRET = 'whsec_0123456789abcdef0123456789abcdef0123456789abcdef';

describe('signing', () => {
  it('matches the RFC 4231 HMAC-SHA256 test vector', () => {
    expect(signPayload('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('is identical to the production dispatcher algorithm (utf8 secret as key, hex digest)', () => {
    const body = JSON.stringify({ id: 'x', event: 'job.created', created_at: 't', data: null });
    expect(signPayload(SECRET, body)).toBe(createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(body).digest('hex'));
  });

  it('verifies, and rejects tampering, wrong secrets and malformed signatures', () => {
    const body = '{"a":1}';
    const sig = signPayload(SECRET, body);
    expect(verifySignature(SECRET, body, sig)).toBe(true);
    expect(verifySignature(SECRET, body, sig.toUpperCase())).toBe(true);
    expect(verifySignature(SECRET, '{"a":2}', sig)).toBe(false);
    expect(verifySignature('whsec_other', body, sig)).toBe(false);
    expect(verifySignature(SECRET, body, 'abc')).toBe(false);
    expect(verifySignature(SECRET, body, '')).toBe(false);
  });

  it('signs raw bytes, so re-serialised JSON would fail verification', () => {
    const raw = '{ "a" : 1 }';
    const sig = signPayload(SECRET, raw);
    expect(verifySignature(SECRET, JSON.stringify(JSON.parse(raw)), sig)).toBe(false);
    expect(verifySignature(SECRET, Buffer.from(raw), sig)).toBe(true);
  });
});

describe('envelope & fixtures', () => {
  it('keeps the production field order', () => {
    const body = JSON.stringify(buildEnvelope('job.created', { a: 1 }, 'id-1', new Date('2026-10-26T00:00:00Z')));
    expect(body).toBe('{"id":"id-1","event":"job.created","created_at":"2026-10-26T00:00:00.000Z","data":{"a":1}}');
  });

  it('has a sample record for every known event', () => {
    for (const event of KNOWN_EVENTS) expect(sampleData(event)).toMatchObject({ id: expect.any(String) });
    expect(sampleData('call.emergency')).toMatchObject({ is_emergency: true });
    expect(sampleData('job.completed')).toMatchObject({ job_status: 'completed' });
  });

  it('validates event names', () => {
    expect(validateEventName('job.completed')).toBe('job.completed');
    expect(() => validateEventName('JobCompleted')).toThrow(/Invalid event name/);
    expect(() => validateEventName('')).toThrow(/Invalid event name/);
  });
});

describe('validateTargetUrl', () => {
  it('allows https and loopback http only', () => {
    expect(validateTargetUrl('https://example.com/hook').hostname).toBe('example.com');
    expect(validateTargetUrl('http://localhost:3000/hook').port).toBe('3000');
    expect(validateTargetUrl('http://127.0.0.1:3000').hostname).toBe('127.0.0.1');
    expect(() => validateTargetUrl('http://example.com/hook')).toThrow(/non-https/);
    expect(validateTargetUrl('http://example.com/hook', true).protocol).toBe('http:');
    expect(() => validateTargetUrl('ftp://example.com')).toThrow(/http\(s\)/);
    expect(() => validateTargetUrl('https://user:pw@example.com')).toThrow(/credentials/);
  });
});

describe('sendTestDelivery', () => {
  it('posts a signed envelope with the production headers', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      captured = { url: url.toString(), init };
      return new Response('{"received":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendTestDelivery({
      url: new URL('https://example.com/hook'),
      secret: SECRET,
      event: 'job.created',
      data: { id: 1 },
      fetchImpl,
      deliveryId: 'delivery-1',
      now: new Date('2026-10-26T00:00:00Z'),
    });
    const headers = new Headers(captured?.init.headers);
    expect(result).toMatchObject({ ok: true, status: 200, deliveryId: 'delivery-1' });
    expect(headers.get('x-vireek-delivery-id')).toBe('delivery-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(verifySignature(SECRET, captured?.init.body as string, headers.get('x-vireek-signature') as string)).toBe(true);
  });

  it('reports non-2xx and network failures without throwing', async () => {
    const base = { url: new URL('https://example.com/hook'), secret: SECRET, event: 'job.created', data: {} };
    const rejected = await sendTestDelivery({ ...base, fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch });
    expect(rejected).toMatchObject({ ok: false, status: 500, responseSnippet: 'nope' });
    const failed = await sendTestDelivery({
      ...base,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(failed).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('createWebhookListener', () => {
  async function withListener(secret: string | undefined, run: (url: string, seen: ReceivedDelivery[]) => Promise<void>) {
    const seen: ReceivedDelivery[] = [];
    const server = createWebhookListener({ secret, onDelivery: (d) => void seen.push(d), maxBodyBytes: 2048 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const delivery = (id = 'd-1') => JSON.stringify(buildEnvelope('lead.created', { id: 'l1' }, id));

  it('accepts a correctly signed delivery and flags duplicates', async () => {
    await withListener(SECRET, async (url, seen) => {
      const body = delivery();
      const headers = { 'Content-Type': 'application/json', 'X-Vireek-Signature': signPayload(SECRET, body) };
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200);
      expect(seen.map((s) => [s.event, s.signature, s.duplicate])).toEqual([
        ['lead.created', 'valid', false],
        ['lead.created', 'valid', true],
      ]);
    });
  });

  it('rejects wrong or missing signatures with 401', async () => {
    await withListener(SECRET, async (url, seen) => {
      const body = delivery();
      const bad = await fetch(url, { method: 'POST', body, headers: { 'X-Vireek-Signature': 'f'.repeat(64) } });
      const missing = await fetch(url, { method: 'POST', body });
      expect([bad.status, missing.status]).toEqual([401, 401]);
      expect(seen.map((s) => s.signature)).toEqual(['invalid', 'missing']);
    });
  });

  it('runs unchecked without a secret, and rejects bad JSON, big bodies and other methods', async () => {
    await withListener(undefined, async (url, seen) => {
      expect((await fetch(url, { method: 'POST', body: delivery('d-2') })).status).toBe(200);
      expect(seen[0]?.signature).toBe('unchecked');
      expect((await fetch(url, { method: 'POST', body: 'not json' })).status).toBe(400);
      expect((await fetch(url, { method: 'POST', body: 'x'.repeat(4096) })).status).toBe(413);
      expect((await fetch(url, { method: 'PUT', body: '{}' })).status).toBe(405);
      expect((await fetch(`${url}/health`)).status).toBe(200);
    });
  });
});
