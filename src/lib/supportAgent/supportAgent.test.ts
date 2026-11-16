import { beforeEach, describe, expect, it } from 'vitest';
import { __resetForTests, classifyIssue, getIssues, recordIssue, redact, summarizeIssues } from './errorBuffer';
import { analyze, buildReport, collectEvidence, summarizeForAi, type EvidenceDeps } from './diagnostics';
import { __resetCooldowns, createHealingBudget, isValidEmail, runAction, type ActionDeps } from './actions';

const NOW = 1_000_000_000_000;
const baseEvidenceDeps = (over: Partial<EvidenceDeps> = {}): EvidenceDeps => ({
  now: () => NOW, isOnline: () => true, configured: true,
  ping: async () => ({ ok: true, ms: 40, serverDate: new Date(NOW).toUTCString() }),
  getSession: async () => null, storageWorks: () => true, secureContext: true,
  countServiceWorkers: async () => 1, countCaches: async () => 2, issues: () => [], ...over,
});
const ids = async (over: Partial<EvidenceDeps>) => analyze(await collectEvidence(baseEvidenceDeps(over))).map((f) => f.id);

describe('errorBuffer', () => {
  beforeEach(() => __resetForTests());
  it('redacts emails, tokens, long ids and URL queries', () => {
    expect(redact('a.b@x.com eyJhbGciOi.abcdefgh.ijklmnop https://x.io/p?q=secret#h')).toBe('[email] [token] https://x.io/p');
    expect(redact('id 0123456789abcdef0123')).toBe('id [id]');
  });
  it('classifies, with chunk errors checked before generic network errors', () => {
    expect(classifyIssue('Failed to fetch dynamically imported module: /a.js')).toBe('chunk_load');
    expect(classifyIssue('TypeError: Failed to fetch')).toBe('network');
    expect(classifyIssue('Email not confirmed')).toBe('auth_email_unconfirmed');
    expect(classifyIssue('Invalid login credentials')).toBe('auth_invalid_credentials');
    expect(classifyIssue('email rate limit exceeded')).toBe('auth_rate_limited');
    expect(classifyIssue('JWT expired')).toBe('auth_session_expired');
    expect(classifyIssue('x is not a function')).toBeNull();
  });
  it('dedupes bursts, ignores ResizeObserver noise and caps the ring at 20', () => {
    recordIssue('Failed to fetch', { fallback: 'script_error', now: 1000 });
    recordIssue('Failed to fetch', { fallback: 'script_error', now: 2000 });
    expect(getIssues()).toHaveLength(1);
    expect(getIssues()[0].count).toBe(2);
    expect(recordIssue('ResizeObserver loop limit exceeded', { fallback: 'script_error' })).toBeNull();
    for (let i = 0; i < 30; i += 1) recordIssue(`err ${i}`, { fallback: 'script_error', now: 10_000 + i * 10_000 });
    expect(getIssues()).toHaveLength(20);
  });
  it('summarizes by kind', () => {
    expect(summarizeIssues([{ at: 1, kind: 'network', message: 'a', count: 2 }, { at: 2, kind: 'network', message: 'b', count: 1 }])).toEqual([{ kind: 'network', count: 3 }]);
  });
});

describe('diagnostics', () => {
  it('reports healthy when nothing is wrong', async () => expect(await ids({})).toEqual(['healthy']));
  it('offline suppresses every downstream finding (root cause only)', async () => expect(await ids({ isOnline: () => false })).toEqual(['offline']));
  it('detects unreachable and misconfigured backends, including a throwing ping', async () => {
    expect((await ids({ ping: async () => ({ ok: false, ms: 4000, serverDate: null }) }))[0]).toBe('backend_unreachable');
    expect((await ids({ ping: async () => { throw new Error('x'); } }))[0]).toBe('backend_unreachable');
    expect((await ids({ configured: false }))[0]).toBe('backend_misconfigured');
  });
  it('detects expired / expiring sessions and offers the refresh action', async () => {
    const expired = analyze(await collectEvidence(baseEvidenceDeps({ getSession: async () => ({ expiresAtSec: NOW / 1000 - 10, emailConfirmed: true }) })));
    expect(expired.find((f) => f.id === 'session_expired')?.actions).toContain('refresh_session');
    expect(await ids({ getSession: async () => ({ expiresAtSec: NOW / 1000 + 60, emailConfirmed: true }) })).toContain('session_expiring');
  });
  it('detects clock skew, blocked storage, stale app and failed sign-ins', async () => {
    expect(await ids({ ping: async () => ({ ok: true, ms: 1, serverDate: new Date(NOW - 600_000).toUTCString() }) })).toContain('clock_skew');
    expect(await ids({ storageWorks: () => false })).toContain('storage_blocked');
    const out = await ids({ issues: () => [{ kind: 'chunk_load', count: 1 }, { kind: 'auth_invalid_credentials', count: 1 }] });
    expect(out).toEqual(expect.arrayContaining(['stale_app', 'invalid_credentials']));
  });
  it('sorts critical before warning', async () => {
    const f = analyze(await collectEvidence(baseEvidenceDeps({ issues: () => [{ kind: 'network', count: 3 }], ping: async () => ({ ok: false, ms: 1, serverDate: null }) })));
    expect(f[0].severity).toBe('critical');
  });
  it('never puts an email or token in the report, and keeps the AI summary short', async () => {
    const ev = await collectEvidence(baseEvidenceDeps({ issues: () => [{ kind: 'network', count: 3 }] }));
    const f = analyze(ev);
    const report = buildReport(ev, f, { incidentId: 'INC-AAAA-BBBB', timeIso: 't', path: '/login', userAgent: 'UA' });
    expect(report).toContain('INC-AAAA-BBBB');
    expect(report).not.toContain('@');
    expect(summarizeForAi(ev, f).length).toBeLessThanOrEqual(600);
  });
});

describe('actions policy gate', () => {
  let calls: string[];
  let expiry: number | null;
  let deps: ActionDeps;
  beforeEach(() => {
    __resetCooldowns();
    calls = [];
    expiry = 1000;
    deps = {
      now: () => 2_000_000,
      refreshSession: async () => { expiry = 2_000_000 / 1000 + 3600; return {}; },
      getSessionExpiry: async () => expiry,
      resendSignup: async (e) => { calls.push(`resend:${e}`); return {}; },
      resetPassword: async (e) => { calls.push(`reset:${e}`); return {}; },
      clearCaches: async () => ({ caches: 1 }),
      reload: () => { calls.push('reload'); },
      openLiveChat: () => { calls.push('chat'); },
      markPendingVerify: (id) => { calls.push(`pending:${id}`); },
    };
  });
  it('lets ONLY autonomous-flagged actions run without the user', async () => {
    expect((await runAction('refresh_session', deps, { origin: 'autonomous' })).status).toBe('verified');
    expect((await runAction('send_password_reset', deps, { origin: 'autonomous', email: 'a@b.co' })).status).toBe('blocked');
    expect((await runAction('clear_app_cache', deps, { origin: 'autonomous' })).status).toBe('blocked');
    expect(calls).toEqual([]);
  });
  it('validates email, reports "accepted" (not "verified") and enforces a cooldown', async () => {
    expect((await runAction('send_password_reset', deps, { origin: 'user', email: 'bad' })).status).toBe('blocked');
    expect((await runAction('send_password_reset', deps, { origin: 'user', email: 'a@b.co' })).status).toBe('accepted');
    expect((await runAction('send_password_reset', deps, { origin: 'user', email: 'a@b.co' })).status).toBe('blocked');
    expect(calls.filter((c) => c.startsWith('reset:'))).toHaveLength(1);
  });
  it('verifies a session refresh by re-reading state, not by trusting the call', async () => {
    expiry = 5;
    deps.refreshSession = async () => ({});
    expect((await runAction('refresh_session', deps, { origin: 'user' })).status).toBe('failed');
    deps.refreshSession = async () => ({ error: 'refresh_token_not_found' });
    expect((await runAction('refresh_session', deps, { origin: 'user' })).status).toBe('failed');
    expiry = null;
    expect((await runAction('refresh_session', deps, { origin: 'user' })).status).toBe('failed');
  });
  it('maps rate limits to a friendly message and swallows thrown errors', async () => {
    deps.resendSignup = async () => ({ error: 'email rate limit exceeded' });
    expect((await runAction('resend_verification', deps, { origin: 'user', email: 'a@b.co' })).message).toMatch(/Too many/);
    deps.clearCaches = async () => { throw new Error('boom'); };
    expect((await runAction('clear_app_cache', deps, { origin: 'user' })).status).toBe('failed');
  });
  it('marks pending verification BEFORE reloading', async () => {
    await runAction('clear_app_cache', deps, { origin: 'user' });
    expect(calls).toEqual(['pending:clear_app_cache', 'reload']);
  });
  it('caps autonomous retries (no healing loops)', () => {
    const b = createHealingBudget(3, 600_000);
    expect([0, 1, 2].every((t) => b.tryConsume('refresh_session', t))).toBe(true);
    expect(b.tryConsume('refresh_session', 3)).toBe(false);
    expect(b.tryConsume('refresh_session', 700_000)).toBe(true);
  });
  it('validates emails', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.de')).toBe(false);
  });
});

describe('client summary vs server grammar', () => {
  it('produces the exact closed-grammar string the server accepts', async () => {
    const ev = await collectEvidence(baseEvidenceDeps());
    expect(summarizeForAi(ev, analyze(ev))).toMatch(/^online=true; backend=reachable; session=none; storage=ok; findings=healthy$/);
  });
});
