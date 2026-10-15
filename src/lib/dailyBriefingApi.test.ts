import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['select', 'order', 'limit', 'update', 'eq', 'insert'])
    chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn();
  return { chain, from: vi.fn(() => chain), invoke: vi.fn() };
});
vi.mock('@/lib/supabase', () => ({
  supabase: { from: mocks.from, functions: { invoke: mocks.invoke } },
}));

import {
  fetchLatestBriefing,
  refreshBriefing,
  savePrefs,
  syncBrowserTimezone,
  browserTimezone,
  type PrefRecord,
} from './dailyBriefingApi';
import { DEFAULT_PREFS } from './dailyBriefing';

const NOW = Date.UTC(2026, 9, 12, 12, 0);
beforeEach(() => {
  vi.clearAllMocks();
  Object.values(mocks.chain).forEach((f) => f.mockImplementation?.(() => mocks.chain));
});

describe('fetchLatestBriefing', () => {
  const row = (d: string) => ({
    data: { briefing_date: d, payload: { version: 1, headline: 'h' } },
    error: null,
  });
  it('returns today’s or yesterday’s briefing, never a stale one', async () => {
    const tz = browserTimezone();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(NOW));
    mocks.chain.maybeSingle.mockResolvedValueOnce(row(today));
    expect(await fetchLatestBriefing(NOW)).toMatchObject({ headline: 'h' });
    mocks.chain.maybeSingle.mockResolvedValueOnce(row('2026-10-01'));
    expect(await fetchLatestBriefing(NOW)).toBeNull();
  });
  it('returns null on error or no row', async () => {
    mocks.chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    expect(await fetchLatestBriefing(NOW)).toBeNull();
  });
});

describe('refreshBriefing', () => {
  it('asks the function for a self build and reports success only on ok:true', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: { ok: true }, error: null });
    expect(await refreshBriefing()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('daily-briefing', { body: { mode: 'self' } });
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('x') });
    expect(await refreshBriefing()).toBe(false);
  });
});

describe('savePrefs', () => {
  it('maps UI fields to columns, validates, and always bumps updated_at', async () => {
    mocks.chain.eq.mockResolvedValueOnce({ error: null });
    await savePrefs('r1', {
      sendHour: 99,
      channels: { push: false, email: true, inApp: true },
      sections: ['actions'],
    });
    const patch = mocks.chain.update.mock.calls[0][0];
    expect(patch).toMatchObject({
      send_hour: 7,
      channel_push: false,
      channel_email: true,
      channel_in_app: true,
      sections: ['actions'],
    });
    expect(patch.updated_at).toBeTruthy();
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('last_sent_on');
  });
  it('throws when the update fails', async () => {
    mocks.chain.eq.mockResolvedValueOnce({ error: new Error('rls') });
    await expect(savePrefs('r1', { enabled: false })).rejects.toThrow('rls');
  });
});

describe('syncBrowserTimezone', () => {
  const rec = (over: Partial<PrefRecord>): PrefRecord => ({
    id: 'r1',
    teamMemberId: null,
    createdAt: 't',
    updatedAt: 't',
    prefs: { ...DEFAULT_PREFS, timezone: 'Pacific/Kiritimati' },
    ...over,
  });
  it('adopts the browser timezone once, for a never-edited row', async () => {
    mocks.chain.eq.mockResolvedValueOnce({ error: null });
    await syncBrowserTimezone([rec({})], 'r1');
    expect(mocks.chain.update).toHaveBeenCalledTimes(1);
    expect(mocks.chain.update.mock.calls[0][0].timezone).toBe(browserTimezone());
  });
  it('never overwrites a row the user already saved', async () => {
    await syncBrowserTimezone([rec({ updatedAt: 'later' })], 'r1');
    expect(mocks.chain.update).not.toHaveBeenCalled();
  });
});
