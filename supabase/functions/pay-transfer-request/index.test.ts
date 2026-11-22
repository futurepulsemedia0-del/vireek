// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// staff-impersonate: audited "sign in as customer". The audit trail must exist BEFORE the link does, and the link must never be logged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { authed, BASE_ENV, captureLogs, fakeJwt, ID, seedUser } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const NOW = '2026-11-17T12:00:00.000Z';
const LINK = 'https://app.vireek.test/auth/v1/verify?token=ONE-TIME-SECRET';
const REASON = 'Customer cannot see their invoices, reproducing the issue';
let db: FakeDb; let handler: Handler; let logs: ReturnType<typeof captureLogs>; let generateLink: ReturnType<typeof vi.fn>;
let staffJwt: string;
const call = (body: unknown, token: string | null = staffJwt) => handler(authed(body, token));
const start = (o: Record<string, unknown> = {}) => call({ action: 'start', accountId: ID.ownerA, reason: REASON, ...o });
const audit = () => db.rows('staff_audit_log');

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  staffJwt = fakeJwt({ aal: 'aal2', sub: ID.staff });
  seedUser(db, staffJwt, ID.staff); db.users[staffJwt].email = 'support@vireek.test';
  seedUser(db, 'tok-cust', ID.ownerB);
  db.seed('profiles', [
    { id: ID.staff, email: 'support@vireek.test', is_staff: true, role: 'owner' },
    { id: ID.ownerA, email: 'owner-a@x.test', is_staff: false, role: 'owner' },
    { id: ID.ownerB, email: 'b@x.test', is_staff: false, role: 'owner' },
    { id: ID.tech, email: 't@x.test', is_staff: false, role: 'technician' },
    { id: ID.admin, email: 'other-staff@vireek.test', is_staff: true, role: 'owner' },
  ]);
  generateLink = vi.fn(async () => ({ data: { properties: { action_link: LINK } }, error: null }));
  sb.create = (...a: unknown[]) => { const c = (db.createClient as any)(...a); c.auth.admin = { generateLink }; return c; };
  logs = captureLogs();
  handler = await loadHandler(() => import('./index.ts'), { ...BASE_ENV, SITE_URL: 'https://app.vireek.test/' });
});
afterEach(() => { vi.useRealTimers(); });

describe('staff-impersonate: who may start', () => {
  it('preflight / method / no JWT / bad JWT / bad JSON', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect((await call({ action: 'start' }, null)).status).toBe(401);
    expect((await call({ action: 'start' }, 'garbage')).status).toBe(401);
    expect((await handler(new Request('http://edge.test/fn', { method: 'POST', headers: { Authorization: `Bearer ${staffJwt}` }, body: '{oops' }))).status).toBe(400);
  });
  it('a non-staff user is 403, the attempt is audited as impersonation_denied, and no link is generated', async () => {
    const res = await call({ action: 'start', accountId: ID.ownerA, reason: REASON }, 'tok-cust');
    expect(res.status).toBe(403);
    expect(audit()[0]).toMatchObject({ staff_id: ID.ownerB, action: 'impersonation_denied', target_account_id: ID.ownerA, metadata: { why: 'not_staff' } });
    expect(generateLink).not.toHaveBeenCalled();
    expect(db.rows('staff_impersonation_sessions')).toHaveLength(0);
  });
  it('once MFA enforcement is on, a non-AAL2 staff session is refused (and audited); AAL2 passes', async () => {
    db.seed('mfa_enforcement_policy', [{ enforce_from: '2026-01-01T00:00:00Z' }]);
    const weak = fakeJwt({ aal: 'aal1' });
    seedUser(db, weak, ID.staff);
    const res = await call({ action: 'start', accountId: ID.ownerA, reason: REASON }, weak);
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).code).toBe('mfa_required');
    expect(audit()[0].metadata).toEqual({ why: 'mfa_required' });
    expect((await start()).status).toBe(200);
  });
  it('MFA policy read failure fails CLOSED for a non-AAL2 session', async () => {
    const weak = fakeJwt({ aal: 'aal1' });
    seedUser(db, weak, ID.staff);
    db.failOn({ table: 'mfa_enforcement_policy' });
    expect((await call({ action: 'start', accountId: ID.ownerA, reason: REASON }, weak)).status).toBe(403);
  });
});

describe('staff-impersonate: start', () => {
  it.each([[{ accountId: 'not-a-uuid' }], [{ reason: 'too short' }], [{ ticketRef: 'bad ref!!' }], [{ action: 'teleport' }]])('rejects %j with 400 and writes nothing', async (o) => {
    expect((await start(o)).status).toBe(400);
    expect(db.rows('staff_impersonation_sessions')).toHaveLength(0);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it('only customer OWNER accounts are targets: technician accounts and unknown ids are 404', async () => {
    expect((await start({ accountId: ID.tech })).status).toBe(404);
    expect((await start({ accountId: '99999999-9999-4999-8999-999999999999' })).status).toBe(404);
  });
  it('staff targets and self-targets are denied with an audit row', async () => {
    expect((await start({ accountId: ID.admin })).status).toBe(403);
    expect(audit()[0].metadata).toEqual({ why: 'Staff accounts cannot be impersonated.' });
    expect((await start({ accountId: ID.staff })).status).toBe(403);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it('rate limit: the 11th session in an hour is 429', async () => {
    db.seed('staff_impersonation_sessions', Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, staff_id: ID.staff, started_at: '2026-11-17T11:30:00.000Z' })));
    expect((await start()).status).toBe(429);
    db.rows('staff_impersonation_sessions').forEach((s) => { s.started_at = '2026-11-17T09:00:00.000Z'; });
    expect((await start()).status).toBe(200);
  });
  it('writes session + BOTH audit trails before generating the link, then returns the link once', async () => {
    generateLink.mockImplementationOnce(async () => {
      expect(db.rows('staff_impersonation_sessions')).toHaveLength(1);                 // session first
      expect(audit().some((a) => a.action === 'impersonation_start')).toBe(true);      // staff audit first
      expect(db.rows('audit_log').some((a) => a.action === 'staff_impersonation_started' && a.user_id === ID.ownerA)).toBe(true); // customer-visible audit first
      return { data: { properties: { action_link: LINK } }, error: null };
    });
    const res = await start({ ticketRef: 'ZD-1042' });
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.link).toBe(LINK);
    expect(body.expiresAt).toBe('2026-11-17T12:30:00.000Z');
    expect(db.rows('staff_impersonation_sessions')[0]).toMatchObject({ staff_id: ID.staff, target_account_id: ID.ownerA, ticket_ref: 'ZD-1042' });
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: 'magiclink', email: 'owner-a@x.test' }));
    expect(logs.text()).not.toContain('ONE-TIME-SECRET');
  });
  it('if the audit write fails, NO link is generated (never un-audited access)', async () => {
    db.failOn({ table: 'staff_audit_log', op: 'insert', when: (c) => c.payload?.action === 'impersonation_start' });
    expect((await start()).status).toBe(500);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it('a link-generation failure closes the session, is audited, and returns 502 without a link', async () => {
    generateLink.mockResolvedValueOnce({ data: null, error: { message: 'smtp down' } });
    const res = await start();
    expect(res.status).toBe(502);
    expect(JSON.stringify(await jsonOf(res))).not.toContain('http');
    expect(db.rows('staff_impersonation_sessions')[0].ended_at).toBe(NOW);
    expect(audit().at(-1)).toMatchObject({ action: 'impersonation_end', metadata: { why: 'link_generation_failed' } });
  });
});

describe('staff-impersonate: end', () => {
  beforeEach(() => db.seed('staff_impersonation_sessions', [
    { id: '11111111-1111-4111-8111-111111111111', staff_id: ID.staff, target_account_id: ID.ownerA, ended_at: null },
    { id: '22222222-2222-4222-8222-222222222222', staff_id: ID.admin, target_account_id: ID.ownerA, ended_at: null },
  ]));
  it('ends only the caller\'s own open session and audits both trails; another staffer\'s session is untouched', async () => {
    expect((await call({ action: 'end', sessionId: 'nope' })).status).toBe(400);
    expect((await call({ action: 'end', sessionId: '22222222-2222-4222-8222-222222222222' })).status).toBe(200);
    expect(db.rows('staff_impersonation_sessions')[1].ended_at).toBeNull();
    expect(audit()).toHaveLength(0);
    expect((await call({ action: 'end', sessionId: '11111111-1111-4111-8111-111111111111' })).status).toBe(200);
    expect(db.rows('staff_impersonation_sessions')[0].ended_at).toBe(NOW);
    expect(audit()[0].action).toBe('impersonation_end');
    expect(db.rows('audit_log')[0]).toMatchObject({ user_id: ID.ownerA, action: 'staff_impersonation_ended' });
  });
});
