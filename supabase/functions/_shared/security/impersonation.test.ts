import { describe, expect, it, vi } from 'vitest';
import { blockIfImpersonating, impersonationClaim, sessionIsLive } from './impersonation';

const SID = '00000000-0000-0000-0000-0000000d0001';
const STAFF = '00000000-0000-0000-0000-0000000b0001';
const OWNER = '00000000-0000-0000-0000-0000000b0002';
const tok = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

type Row = { id: string; staff_id: string; target_account_id: string; expires_at: string; ended_at: string | null } | null;

function fakeAdmin(row: Row, opts: { selectError?: string; insertError?: string } = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  const admin = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => (opts.selectError ? { data: null, error: { message: opts.selectError } } : { data: row, error: null }),
          }),
        }),
        insert: async (r: Record<string, unknown>) => {
          inserts.push({ table, row: r });
          return { error: opts.insertError ? { message: opts.insertError } : null };
        },
      };
    },
    rpc,
  };
  return { admin: admin as never, inserts, rpc };
}

describe('impersonationClaim', () => {
  it('reads a well-formed claim', () => {
    expect(impersonationClaim(tok({ imp: { sid: SID, staff: STAFF, exp: 123 } }))).toEqual({ sid: SID, staff: STAFF, exp: 123 });
  });
  it('is null without a claim, with a malformed sid, or for garbage', () => {
    expect(impersonationClaim(tok({ sub: 'x' }))).toBeNull();
    expect(impersonationClaim(tok({ imp: { sid: 'not-a-uuid' } }))).toBeNull();
    expect(impersonationClaim(tok({ imp: null }))).toBeNull();
    expect(impersonationClaim('garbage')).toBeNull();
    expect(impersonationClaim('')).toBeNull();
  });
});

describe('sessionIsLive', () => {
  const base = { id: SID, staff_id: STAFF, target_account_id: OWNER };
  it('is live only when not ended and not expired', () => {
    expect(sessionIsLive({ ...base, expires_at: future(), ended_at: null })).toBe(true);
    expect(sessionIsLive({ ...base, expires_at: past(), ended_at: null })).toBe(false);
    expect(sessionIsLive({ ...base, expires_at: future(), ended_at: past() })).toBe(false);
    expect(sessionIsLive({ ...base, expires_at: 'nonsense', ended_at: null })).toBe(false);
    expect(sessionIsLive(null)).toBe(false);
  });
});

describe('blockIfImpersonating', () => {
  const jwt = tok({ sub: OWNER, imp: { sid: SID, staff: STAFF, exp: 4102444800 } });

  it('lets a normal owner through without touching the database', async () => {
    const { admin, inserts } = fakeAdmin(null);
    expect(await blockIfImpersonating(admin, tok({ sub: OWNER }), 'issue-refund')).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it('blocks a live support session with 403 and audits to staff and customer', async () => {
    const { admin, inserts } = fakeAdmin({ id: SID, staff_id: STAFF, target_account_id: OWNER, expires_at: future(), ended_at: null });
    const res = await blockIfImpersonating(admin, jwt, 'issue-refund');
    expect(res?.status).toBe(403);
    expect((await res!.json()).code).toBe('impersonation_blocked');
    expect(inserts.map((i) => i.table).sort()).toEqual(['audit_log', 'staff_audit_log']);
    expect(inserts.find((i) => i.table === 'staff_audit_log')?.row).toMatchObject({ action: 'impersonation_blocked', staff_id: STAFF, target_account_id: OWNER });
  });

  it('still blocks when the audit insert fails (never turns into an allow)', async () => {
    const { admin } = fakeAdmin({ id: SID, staff_id: STAFF, target_account_id: OWNER, expires_at: future(), ended_at: null }, { insertError: 'boom' });
    const res = await blockIfImpersonating(admin, jwt, 'tenant-export');
    expect(res?.status).toBe(403);
  });

  it('refuses an expired session with 401 even though the JWT exp is far in the future, and closes it', async () => {
    const { admin, rpc } = fakeAdmin({ id: SID, staff_id: STAFF, target_account_id: OWNER, expires_at: past(), ended_at: null });
    const res = await blockIfImpersonating(admin, jwt, 'issue-refund');
    expect(res?.status).toBe(401);
    expect((await res!.json()).code).toBe('impersonation_expired');
    expect(rpc).toHaveBeenCalledWith('impersonation_close', { p_session: SID, p_reason: 'expired' });
  });

  it('refuses when the session row is missing', async () => {
    const { admin } = fakeAdmin(null);
    expect((await blockIfImpersonating(admin, jwt, 'issue-refund'))?.status).toBe(401);
  });

  it('fails closed (503) when the session cannot be verified', async () => {
    const { admin } = fakeAdmin(null, { selectError: 'db down' });
    expect((await blockIfImpersonating(admin, jwt, 'issue-refund'))?.status).toBe(503);
  });
});
