import { describe, it, expect, vi } from 'vitest';
import { runSuspensionSweep, type SuspensionQueryClient } from './suspensionSweep';

function makeAdmin(rows: Array<{ id: string; email: string }>) {
  const select = vi.fn().mockResolvedValue({ data: rows, error: null });
  const lt = vi.fn().mockReturnValue({ select });
  const eq = vi.fn().mockReturnValue({ lt });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  return { admin: { from } as unknown as SuspensionQueryClient, from, update, eq, lt, select };
}

describe('runSuspensionSweep', () => {
  it('filters on subscription_status=past_due AND an expired grace period, together', async () => {
    const { admin, eq, lt } = makeAdmin([{ id: 'user-1', email: 'a@example.com' }]);
    const now = new Date('2026-09-24T12:00:00.000Z');

    await runSuspensionSweep(admin, now);

    expect(eq).toHaveBeenCalledWith('subscription_status', 'past_due');
    expect(lt).toHaveBeenCalledWith('payment_grace_period_ends_at', now.toISOString());
  });

  it('updates both subscription_status and status to suspended', async () => {
    const { admin, update } = makeAdmin([{ id: 'user-1', email: 'a@example.com' }]);
    await runSuspensionSweep(admin);
    expect(update).toHaveBeenCalledWith({ subscription_status: 'suspended', status: 'suspended' });
  });

  it('returns the suspended ids and count from the query result', async () => {
    const { admin } = makeAdmin([
      { id: 'user-1', email: 'a@example.com' },
      { id: 'user-2', email: 'b@example.com' },
    ]);
    const result = await runSuspensionSweep(admin);
    expect(result).toEqual({ suspendedCount: 2, suspendedIds: ['user-1', 'user-2'] });
  });

  it('returns zero/empty when nobody matches, without throwing', async () => {
    const { admin } = makeAdmin([]);
    const result = await runSuspensionSweep(admin);
    expect(result).toEqual({ suspendedCount: 0, suspendedIds: [] });
  });

  it('throws when the underlying query errors, instead of silently reporting zero suspensions', async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const admin = { from: () => ({ update: () => ({ eq: () => ({ lt: () => ({ select }) }) }) }) } as unknown as SuspensionQueryClient;

    await expect(runSuspensionSweep(admin)).rejects.toThrow('connection reset');
  });
});
