import { describe, it, expect } from 'vitest';
import { enqueueBatchJob, type BatchDbClient } from './batchQueue.ts';

const req = { system: 'S', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 300 };

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  let n = 0;
  const db: BatchDbClient = {
    from: () => ({
      upsert: async (row, opts) => {
        const k = `${row.account_id}|${row.idempotency_key}`;
        if (!(rows.has(k) && opts.ignoreDuplicates)) rows.set(k, { ...row, id: `id-${++n}`, status: 'pending' });
        return { error: null };
      },
      select: () => ({
        eq: (_c1: string, a: string) => ({
          eq: (_c2: string, key: string) => ({ maybeSingle: async () => ({ data: rows.get(`${a}|${key}`) ?? null, error: null }) }),
        }),
      }),
    }),
  };
  return { db, rows };
}

describe('enqueueBatchJob', () => {
  const base = { accountId: 'A', task: 'job_autopsy' as const, idempotencyKey: 'k1', request: req, enabled: true };
  it('is a no-op when AI_BATCH_MODE is off', async () => {
    const { db, rows } = fakeDb();
    expect(await enqueueBatchJob(db, { ...base, enabled: false })).toEqual({ ok: false, reason: 'batch_mode_off' });
    expect(rows.size).toBe(0);
  });
  it('rejects ineligible tasks and missing scope before touching the database', async () => {
    const { db, rows } = fakeDb();
    expect(await enqueueBatchJob(db, { ...base, task: 'remote_resolution' })).toEqual({ ok: false, reason: 'task_not_batch_eligible' });
    expect(await enqueueBatchJob(db, { ...base, accountId: '' })).toEqual({ ok: false, reason: 'no_account_scope' });
    expect(await enqueueBatchJob(db, { ...base, idempotencyKey: '' })).toEqual({ ok: false, reason: 'bad_idempotency_key' });
    expect(rows.size).toBe(0);
  });
  it('is idempotent per (account, key) and isolated per tenant', async () => {
    const { db, rows } = fakeDb();
    const a1 = await enqueueBatchJob(db, base);
    const a2 = await enqueueBatchJob(db, base);
    const b1 = await enqueueBatchJob(db, { ...base, accountId: 'B' });
    expect(a1.ok && a2.ok && b1.ok).toBe(true);
    if (a1.ok && a2.ok && b1.ok) {
      expect(a2.job.id).toBe(a1.job.id);
      expect(b1.job.id).not.toBe(a1.job.id);
    }
    expect(rows.size).toBe(2);
  });
});
