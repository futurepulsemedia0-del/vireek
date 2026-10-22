import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const maybeSingle = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ select: () => ({ maybeSingle: () => maybeSingle() }) }),
  },
}));

import { loadRescueCases, loadRescueEvents, loadRescueSettings, saveRescueSettings } from './rescueLoopData';

beforeEach(() => {
  rpc.mockReset();
  maybeSingle.mockReset();
});

describe('loadRescueCases', () => {
  it('maps rows and drops invalid ones', async () => {
    rpc.mockResolvedValue({
      data: [
        { rc_call_id: 'c1', rc_call_at: '2026-10-19T15:00:00Z', rc_clock_start: '2026-10-19T15:00:00Z', rc_sla_status: 'met' },
        { rc_call_id: null },
      ],
      error: null,
    });
    const cases = await loadRescueCases(7, 50);
    expect(cases).toHaveLength(1);
    expect(cases[0].slaStatus).toBe('met');
    expect(rpc).toHaveBeenCalledWith('rescue_loop_cases', expect.objectContaining({ p_limit: 50 }));
  });
  it('throws a readable error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(loadRescueCases()).rejects.toThrow('Could not load missed calls: boom');
  });
});

describe('loadRescueEvents', () => {
  it('skips the network for an empty list and de-duplicates ids', async () => {
    expect(await loadRescueEvents([])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: [], error: null });
    await loadRescueEvents(['a', 'a', 'b']);
    expect(rpc).toHaveBeenCalledWith('rescue_loop_events', { p_call_ids: ['a', 'b'] });
  });
});

describe('settings', () => {
  it('falls back to defaults when no row exists', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await loadRescueSettings()).firstResponseLimitSeconds).toBe(60);
  });
  it('clamps before saving and surfaces server errors', async () => {
    rpc.mockResolvedValue({ error: null });
    await saveRescueSettings({ firstResponseLimitSeconds: 1, alertsEnabled: true, excuseQuietHours: false });
    expect(rpc).toHaveBeenCalledWith('rescue_save_sla_settings', { p_limit_seconds: 10, p_alerts_enabled: true, p_excuse_quiet_hours: false });
    rpc.mockResolvedValue({ error: { message: 'Only the account owner can change SLA settings' } });
    await expect(saveRescueSettings({ firstResponseLimitSeconds: 60, alertsEnabled: true, excuseQuietHours: true })).rejects.toThrow('account owner');
  });
});
