// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// In-memory FakeDb + mocked adapters. Nothing here talks to a real provider ("not live-verified").
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDb } from '../testing/fakeSupabase.ts';
import { computeBackoffMs, type ErasureOutcome, type ProviderErasureAdapter, type ProviderName } from './providerAdapters.ts';
import { collectErasureSubjects, eraseProviderDataQueued, planJobUpdate, processDueProviderErasureJobs, readProviderEnv, runErasureJobs } from './providerErasureQueue.ts';

const ACC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2030-01-01T00:00:00.000Z');
const clock = { now: () => NOW, rand: () => 0.5 };
const RE = 'RE' + 'c'.repeat(32);
const CA = 'CA' + 'a'.repeat(32);

let db: FakeDb;
let admin: any;
const proof = (p: ProviderName) => ({ provider: p, adapter: 't', endpoint: 'e', at: NOW.toISOString(), attempted: 1, deleted: 1, alreadyGone: 0, invalid: 0, failed: [], liveVerified: false as const });
const outcome = (status: ErasureOutcome['status'], retryable = false, error?: string): ((p: ProviderName) => ErasureOutcome) => (p) => ({ status, retryable, error, proof: proof(p) });

function adapters(by: Partial<Record<ProviderName, (p: ProviderName) => ErasureOutcome>>, seen: string[] = []) {
  const mk = (p: ProviderName): ProviderErasureAdapter => ({ provider: p, erase: async (s) => { seen.push(`${p}:${JSON.stringify(s.resources)}`); return (by[p] ?? outcome('erased'))(p); } });
  return { vapi: mk('vapi'), twilio: mk('twilio'), elevenlabs: mk('elevenlabs'), resend: mk('resend') };
}

beforeEach(() => {
  db = new FakeDb();
  db.rpcHandlers['claim_provider_erasure_jobs'] = (a: any, d: FakeDb) => {
    const rows = d.rows('provider_erasure_jobs').filter((r) => r.status === 'pending' && new Date(r.next_attempt_at ?? 0).getTime() <= Date.now() + 1000
      && (!r.locked_until || new Date(r.locked_until) < new Date()) && (!a.p_subject || r.subject_account_id === a.p_subject));
    for (const r of rows) r.locked_until = new Date(Date.now() + 300_000).toISOString();
    return rows.slice(0, a.p_limit).map((r) => ({ ...r }));
  };
  db.defaults = { provider_erasure_jobs: () => ({ status: 'pending', attempts: 0, max_attempts: 8, next_attempt_at: new Date(0).toISOString(), locked_until: null, last_error: null }) };
  db.seed('calls', [
    { id: 'c1', user_id: ACC, vapi_call_id: 'call-aaaa1111' }, { id: 'c2', user_id: ACC, vapi_call_id: 'call-bbbb2222' },
    { id: 'c3', user_id: ACC, vapi_call_id: null }, { id: 'c4', user_id: OTHER, vapi_call_id: 'call-zzzz9999' },
  ]);
  db.seed('business_profile', [{ id: 'b1', user_id: ACC, custom_voice_id: 'voice_abc123' }]);
  db.seed('pbx_recordings', [{ id: 'r1', account_owner_id: ACC, recording_sid: RE }]);
  db.seed('pbx_calls', [{ id: 'p1', account_owner_id: ACC, call_sid: CA }]);
  admin = db.createClient('http://db.test', 'svc');
});

describe('collectErasureSubjects', () => {
  it('snapshots only the account\'s own identifiers (tenant isolation) and always adds the resend documentation row', async () => {
    const s = await collectErasureSubjects(admin, ACC, null);
    expect(s.complete).toBe(true);
    const all = JSON.stringify(s.jobs);
    expect(all).toContain('call-aaaa1111');
    expect(all).not.toContain('call-zzzz9999');
    expect(s.jobs.map((j) => j.provider).sort()).toEqual(['elevenlabs', 'resend', 'twilio', 'twilio', 'vapi']);
  });
  it('is stable: same data gives the same dedupe keys', async () => {
    const a = (await collectErasureSubjects(admin, ACC, null)).jobs.map((j) => j.dedupeKey);
    const b = (await collectErasureSubjects(admin, ACC, null)).jobs.map((j) => j.dedupeKey);
    expect(a).toEqual(b);
  });
  it('a read error makes the snapshot incomplete (never silently "nothing to delete")', async () => {
    const broken: any = { ...admin, from: (t: string) => (t === 'calls' ? { select: () => ({ eq: () => ({ not: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: 'XX000', message: 'x' } }) }) }) }) }) } : admin.from(t)) };
    const s = await collectErasureSubjects(broken, ACC, null);
    expect(s.complete).toBe(false);
    expect(s.problems[0]).toContain('calls.vapi_call_id');
  });
  it('a missing optional table (not migrated) counts as empty', async () => {
    const noPbx: any = { ...admin, from: (t: string) => (t.startsWith('pbx_') ? { select: () => ({ eq: () => ({ not: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: '42P01', message: 'x' } }) }) }) }) }) } : admin.from(t)) };
    expect((await collectErasureSubjects(noPbx, ACC, null)).complete).toBe(true);
  });
});

describe('eraseProviderDataQueued', () => {
  it('all adapters succeed: jobs erased, proof stored per job, resend is unsupported but not a failure', async () => {
    const seen: string[] = [];
    const r = await eraseProviderDataQueued(admin, ACC, {}, { adapters: adapters({ resend: outcome('unsupported') }, seen), clock });
    expect(r.ok).toBe(true);
    expect(r.snapshotOk).toBe(true);
    expect(r.unsupported).toEqual(['resend']);
    const rows = db.rows('provider_erasure_jobs');
    expect(rows).toHaveLength(5);
    expect(rows.filter((x) => x.status === 'erased')).toHaveLength(4);
    expect(rows.every((x) => x.proof && x.proof.liveVerified === false)).toBe(true);
    expect(rows.every((x) => x.subject_account_id === ACC)).toBe(true);
  });
  it('a transient failure leaves the job pending with backoff and an error; ok=false', async () => {
    const r = await eraseProviderDataQueued(admin, ACC, {}, { adapters: adapters({ vapi: outcome('failed', true, '1_of_2_failed:http_500') }), clock });
    expect(r.ok).toBe(false);
    expect(r.failed).toContain('vapi:pending_retry');
    const j = db.rows('provider_erasure_jobs').find((x) => x.provider === 'vapi')!;
    expect(j.status).toBe('pending');
    expect(j.attempts).toBe(1);
    expect(j.last_error).toContain('http_500');
    expect(new Date(j.next_attempt_at).getTime()).toBe(NOW.getTime() + computeBackoffMs(1, () => 0.5));
  });
  it('a permanent failure goes dead', async () => {
    const r = await eraseProviderDataQueued(admin, ACC, {}, { adapters: adapters({ elevenlabs: outcome('failed', false, 'http_400') }), clock });
    expect(r.failed).toContain('elevenlabs:dead');
  });
  it('is idempotent: running the same request twice does not duplicate jobs or re-delete finished ones', async () => {
    const seen: string[] = [];
    await eraseProviderDataQueued(admin, ACC, {}, { adapters: adapters({}, seen), clock });
    const first = seen.length;
    await eraseProviderDataQueued(admin, ACC, {}, { adapters: adapters({}, seen), clock });
    expect(db.rows('provider_erasure_jobs')).toHaveLength(5);
    expect(seen.length).toBe(first);
  });
  it('incomplete snapshot: nothing is enqueued and snapshotOk=false (caller must stop before deleting rows)', async () => {
    const broken: any = { ...admin, from: (t: string) => (t === 'business_profile' ? { select: () => ({ eq: () => ({ not: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: 'XX000' } }) }) }) }) }) } : admin.from(t)) };
    const r = await eraseProviderDataQueued(broken, ACC, {}, { adapters: adapters({}), clock });
    expect(r.snapshotOk).toBe(false);
    expect(db.rows('provider_erasure_jobs')).toHaveLength(0);
  });
  it('a request id is recorded on every job', async () => {
    await eraseProviderDataQueued(admin, ACC, {}, { requestId: 'req-1', adapters: adapters({}), clock });
    expect(db.rows('provider_erasure_jobs').every((x) => x.request_id === 'req-1')).toBe(true);
  });
});

describe('runErasureJobs / retry behaviour', () => {
  it('a later sweep retries a pending job from its stored snapshot even though local rows are gone', async () => {
    await eraseProviderDataQueued(admin, ACC, {}, { adapters: adapters({ vapi: outcome('failed', true, 'http_500') }), clock });
    db.rows('calls').splice(0); // simulate delete-account having removed the local rows
    db.rows('provider_erasure_jobs').forEach((j) => { j.next_attempt_at = new Date(0).toISOString(); j.locked_until = null; });
    const seen: string[] = [];
    const s = await processDueProviderErasureJobs(admin, {}, { adapters: adapters({}, seen), clock });
    expect(s.erased).toBe(1);
    expect(seen[0]).toContain('call-aaaa1111');
    expect(db.rows('provider_erasure_jobs').find((x) => x.provider === 'vapi')!.status).toBe('erased');
  });
  it('gives up (dead) after max_attempts', () => {
    const p = planJobUpdate({ attempts: 7, max_attempts: 8 }, { status: 'failed', retryable: true, error: 'x', proof: proof('vapi') }, clock);
    expect(p.status).toBe('dead');
  });
  it('an adapter that throws does not stall the queue', async () => {
    await eraseProviderDataQueued(admin, ACC, {}, { adapters: { ...adapters({}), vapi: { provider: 'vapi', erase: async () => { throw new Error('bug'); } } }, clock });
    const j = db.rows('provider_erasure_jobs').find((x) => x.provider === 'vapi')!;
    expect(j.status).toBe('pending');
    expect(j.last_error).toContain('adapter_exception');
  });
  it('out of time: remaining claimed jobs are deferred and their lease released', async () => {
    const jobs = (await collectErasureSubjects(admin, ACC, null)).jobs;
    db.seed('provider_erasure_jobs', jobs.map((j, i) => ({ id: `j${i}`, subject_account_id: ACC, provider: j.provider, dedupe_key: j.dedupeKey, subject: j.subject, status: 'pending', attempts: 0, max_attempts: 8, next_attempt_at: new Date(0).toISOString() })));
    let t = NOW.getTime();
    const ticking = { now: () => new Date((t += 10_000)), rand: () => 0.5 };
    const s = await runErasureJobs(admin, { adapters: adapters({}), clock: ticking, deadlineMs: 15_000 });
    expect(s.deferred).toBeGreaterThan(0);
    expect(db.rows('provider_erasure_jobs').filter((r) => r.status === 'pending').every((r) => !r.locked_until)).toBe(true);
  });
  it('processDue never throws: a claim error is returned as a summary error', async () => {
    db.rpcHandlers['claim_provider_erasure_jobs'] = () => ({ error: { code: '42883', message: 'missing' } });
    const s = await processDueProviderErasureJobs(admin, {}, { adapters: adapters({}), clock });
    expect(s.error).toContain('claim_provider_erasure_jobs');
  });
});

describe('readProviderEnv', () => {
  it('maps the documented env names', () => {
    const e = readProviderEnv((k) => ({ VAPI_PRIVATE_KEY: 'v', ELEVENLABS_API_KEY: 'e', TWILIO_ACCOUNT_SID: 's', TWILIO_AUTH_TOKEN: 't', RESEND_API_KEY: 'r' } as Record<string, string>)[k]);
    expect(e).toEqual({ vapiKey: 'v', elevenLabsKey: 'e', twilioAccountSid: 's', twilioAuthToken: 't', resendKey: 'r' });
  });
});
