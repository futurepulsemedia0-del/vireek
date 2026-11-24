// @vitest-environment node
// Mock-only tests: no adapter here has been run against a live provider ("not live-verified").
import { describe, expect, it } from 'vitest';
import { chunk, computeBackoffMs, createAdapters, createResendAdapter, createTwilioAdapter, createVapiAdapter, MAX_BACKOFF_MS } from './providerAdapters.ts';

const CA = 'CA' + 'a'.repeat(32);
const CB = 'CA' + 'b'.repeat(32);
const RE = 'RE' + 'c'.repeat(32);
const AC = 'AC' + 'd'.repeat(32);
const NOW = () => new Date('2030-01-01T00:00:00.000Z');

function mockFetch(statusFor: (url: string) => number | 'throw', log: Array<{ url: string; method: string; headers: Record<string, string> }> = []) {
  const f = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
    log.push({ url, method: init.method, headers: init.headers });
    const s = statusFor(url);
    if (s === 'throw') throw new Error('boom');
    return { ok: s >= 200 && s < 300, status: s };
  }) as unknown as typeof fetch;
  return { f, log };
}
const subj = (resources: Record<string, string[]>) => ({ accountId: 'acc', resources });

describe('vapi adapter', () => {
  it('erases every call, deduplicated, with bearer auth and a proof', async () => {
    const { f, log } = mockFetch(() => 204);
    const o = await createVapiAdapter({ vapiKey: 'k' }, { fetchImpl: f, now: NOW }).erase(subj({ callIds: ['call-12345', 'call-12345', 'call-67890'] }));
    expect(o.status).toBe('erased');
    expect(o.proof.deleted).toBe(2);
    expect(o.proof.liveVerified).toBe(false);
    expect(log.every((l) => l.method === 'DELETE' && l.headers.Authorization === 'Bearer k')).toBe(true);
    expect(o.proof.at).toBe('2030-01-01T00:00:00.000Z');
  });
  it('treats 404 as already gone', async () => {
    const o = await createVapiAdapter({ vapiKey: 'k' }, { fetchImpl: mockFetch(() => 404).f }).erase(subj({ callIds: ['call-12345'] }));
    expect(o.status).toBe('erased');
    expect(o.proof.alreadyGone).toBe(1);
  });
  it('5xx, 429 and network errors are retryable failures', async () => {
    for (const s of [500, 429, 'throw' as const]) {
      const o = await createVapiAdapter({ vapiKey: 'k' }, { fetchImpl: mockFetch(() => s).f }).erase(subj({ callIds: ['call-12345'] }));
      expect(o.status).toBe('failed');
      expect(o.retryable).toBe(true);
    }
  });
  it('a 400 is permanent (not retryable)', async () => {
    const o = await createVapiAdapter({ vapiKey: 'k' }, { fetchImpl: mockFetch(() => 400).f }).erase(subj({ callIds: ['call-12345'] }));
    expect(o.status).toBe('failed');
    expect(o.retryable).toBe(false);
  });
  it('stops after the first 401 and reports the rest as not attempted', async () => {
    const { f, log } = mockFetch(() => 401);
    const o = await createVapiAdapter({ vapiKey: 'k' }, { fetchImpl: f, concurrency: 1 }).erase(subj({ callIds: ['call-00001', 'call-00002', 'call-00003'] }));
    expect(log).toHaveLength(1);
    expect(o.proof.failed).toHaveLength(3);
    expect(o.retryable).toBe(true);
  });
  it('without credentials: makes no request and fails retryably', async () => {
    const { f, log } = mockFetch(() => 204);
    const o = await createVapiAdapter({}, { fetchImpl: f }).erase(subj({ callIds: ['call-12345'] }));
    expect(log).toHaveLength(0);
    expect(o.status).toBe('failed');
    expect(o.retryable).toBe(true);
    expect(o.error).toContain('no_credentials');
  });
  it('nothing to delete is not_applicable; malformed ids never reach the network', async () => {
    const { f, log } = mockFetch(() => 204);
    const a = createVapiAdapter({ vapiKey: 'k' }, { fetchImpl: f });
    expect((await a.erase(subj({}))).status).toBe('not_applicable');
    const o = await a.erase(subj({ callIds: ['../../x', 'a b'] }));
    expect(log).toHaveLength(0);
    expect(o.status).toBe('failed');
    expect(o.retryable).toBe(false);
  });
});

describe('twilio adapter', () => {
  const env = { twilioAccountSid: AC, twilioAuthToken: 't' };
  it('deletes recordings and call logs with Basic auth on the account-scoped URLs', async () => {
    const { f, log } = mockFetch(() => 204);
    const o = await createTwilioAdapter(env, { fetchImpl: f, now: NOW }).erase(subj({ recordingSids: [RE], callSids: [CA, CB] }));
    expect(o.status).toBe('erased');
    expect(o.proof.deleted).toBe(3);
    expect(log[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${AC}/Recordings/${RE}.json`);
    expect(log.map((l) => l.url)).toContain(`https://api.twilio.com/2010-04-01/Accounts/${AC}/Calls/${CB}.json`);
    expect(log[0].headers.Authorization).toBe(`Basic ${btoa(`${AC}:t`)}`);
  });
  it('one failing kind makes the whole outcome failed, with failures listed in the proof', async () => {
    const { f } = mockFetch((u) => (u.includes('/Calls/') ? 500 : 204));
    const o = await createTwilioAdapter(env, { fetchImpl: f }).erase(subj({ recordingSids: [RE], callSids: [CA] }));
    expect(o.status).toBe('failed');
    expect(o.retryable).toBe(true);
    expect(o.proof.deleted).toBe(1);
    expect(o.proof.failed).toEqual([{ id: CA, reason: 'http_500' }]);
  });
  it('rejects an account SID that is not well formed (no request is sent)', async () => {
    const { f, log } = mockFetch(() => 204);
    const o = await createTwilioAdapter({ twilioAccountSid: 'x/../y', twilioAuthToken: 't' }, { fetchImpl: f }).erase(subj({ callSids: [CA] }));
    expect(log).toHaveLength(0);
    expect(o.error).toContain('no_credentials');
  });
});

describe('resend adapter', () => {
  it('is unsupported, terminal, makes no HTTP call, and says manual action is required', async () => {
    const { f, log } = mockFetch(() => 204);
    globalThis.fetch = f;
    const o = await createResendAdapter({ resendKey: 'k' }).erase();
    expect(o.status).toBe('unsupported');
    expect(o.retryable).toBe(false);
    expect(log).toHaveLength(0);
    expect(o.proof.note).toMatch(/manual/i);
  });
});

describe('registry, backoff, chunk', () => {
  it('createAdapters exposes all four providers behind the same interface', () => {
    const a = createAdapters({});
    expect(Object.keys(a).sort()).toEqual(['elevenlabs', 'resend', 'twilio', 'vapi']);
    for (const p of Object.values(a)) expect(typeof p.erase).toBe('function');
  });
  it('backoff grows, is jittered within +/-20 %, and is capped at 6 h', () => {
    expect(computeBackoffMs(1, () => 0.5)).toBe(60_000);
    expect(computeBackoffMs(2, () => 0.5)).toBe(120_000);
    expect(computeBackoffMs(1, () => 0)).toBe(48_000);
    expect(computeBackoffMs(1, () => 1)).toBe(72_000);
    expect(computeBackoffMs(40, () => 1)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffMs(Number.NaN, () => 0.5)).toBe(60_000);
  });
  it('chunk splits evenly and handles empty input', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
