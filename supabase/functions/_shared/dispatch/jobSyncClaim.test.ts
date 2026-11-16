import { describe, expect, it } from 'vitest';
import { claimJobSync, decideClaim } from './jobSyncClaim';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('decideClaim', () => {
  it('inserts when nothing exists', () => expect(decideClaim(null, NOW)).toBe('insert'));
  it('skips an already synced job (no duplicate in the FSM)', () => expect(decideClaim({ status: 'synced', updated_at: iso(1e9) }, NOW)).toBe('skip_synced'));
  it('skips a fresh pending job, takes over a stale one', () => {
    expect(decideClaim({ status: 'pending', updated_at: iso(10_000) }, NOW)).toBe('skip_inflight');
    expect(decideClaim({ status: 'pending', updated_at: iso(10 * 60_000) }, NOW)).toBe('takeover');
  });
  it('retries errors and not_connected', () => {
    expect(decideClaim({ status: 'error', updated_at: iso(1000) }, NOW)).toBe('takeover');
    expect(decideClaim({ status: 'not_connected', updated_at: iso(1000) }, NOW)).toBe('takeover');
  });
});

/** Tiny in-memory job_external_syncs with unique(job_id, provider) and a CAS-capable update. */
function fakeDb(initial: Array<Record<string, any>> = []) {
  const rows = [...initial];
  const find = (f: Record<string, any>) => rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
  return {
    rows,
    from() {
      const filters: Record<string, any> = {};
      let op: 'select' | 'update' = 'select';
      let patch: any = null;
      const b: any = {
        select: () => b,
        eq: (k: string, v: any) => ((filters[k] = v), b),
        update: (p: any) => ((op = 'update'), (patch = p), b),
        maybeSingle: async () => ({ data: find(filters)[0] ?? null, error: null }),
        insert: async (row: any) => {
          if (find({ job_id: row.job_id, provider: row.provider }).length) return { error: { code: '23505' } };
          rows.push({ ...row, id: String(rows.length + 1), updated_at: new Date(NOW).toISOString() });
          return { error: null };
        },
        then: (res: any) => {
          const hit = find(filters);
          if (op === 'update') hit.forEach((r) => Object.assign(r, patch, { updated_at: new Date(NOW + 1).toISOString() }));
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(res);
        },
      };
      return b;
    },
  };
}

describe('claimJobSync', () => {
  it('first caller wins, replay is rejected', async () => {
    const db = fakeDb();
    expect(await claimJobSync(db, 'u', 'j1', 'jobber', NOW)).toBe(true);
    expect(await claimJobSync(db, 'u', 'j1', 'jobber', NOW)).toBe(false);
    expect(await claimJobSync(db, 'u', 'j1', 'service_titan', NOW)).toBe(true);
  });
  it('never re-pushes a synced job', async () => {
    const db = fakeDb([{ id: '1', job_id: 'j1', provider: 'jobber', status: 'synced', updated_at: iso(5e6) }]);
    expect(await claimJobSync(db, 'u', 'j1', 'jobber', NOW)).toBe(false);
  });
  it('retries a failed job exactly once under a stale observation (CAS)', async () => {
    const db = fakeDb([{ id: '1', job_id: 'j1', provider: 'jobber', status: 'error', updated_at: iso(5000) }]);
    expect(await claimJobSync(db, 'u', 'j1', 'jobber', NOW)).toBe(true);
    expect(db.rows[0].status).toBe('pending');
  });
  it('fails closed when the database throws', async () => {
    const boom = { from: () => { throw new Error('db down'); } };
    expect(await claimJobSync(boom, 'u', 'j1', 'jobber', NOW)).toBe(false);
  });
});
