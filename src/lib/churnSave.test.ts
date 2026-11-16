import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { draftToPayload, emptyDraft, fetchChurnSaveOverview, offerToDraft, parseOverview, pct, saveOffer, saveSettings, validateDraft } from './churnSave';

beforeEach(() => rpc.mockReset());

describe('validateDraft (mirrors the DB ceilings)', () => {
  const valid = { ...emptyDraft('discount'), name: 'Spring 20%' };
  it('accepts a valid discount', () => expect(validateDraft(valid)).toEqual({}));
  it('rejects discount above 50%, longer than 6 months, bad name', () => {
    expect(validateDraft({ ...valid, discount_percent: '51' }).discount_percent).toBe('percent');
    expect(validateDraft({ ...valid, discount_percent: '0' }).discount_percent).toBe('percent');
    expect(validateDraft({ ...valid, discount_months: '7' }).discount_months).toBe('discountMonths');
    expect(validateDraft({ ...valid, name: 'ab' }).name).toBe('name');
  });
  it('rejects pause > 3 months, per-account cap > 3, bad window and dates', () => {
    expect(validateDraft({ ...emptyDraft('pause'), name: 'Pause', pause_months: '4' }).pause_months).toBe('pauseMonths');
    expect(validateDraft({ ...valid, max_per_account: '4' }).max_per_account).toBe('perAccount');
    expect(validateDraft({ ...valid, cap_total: '0' }).cap_total).toBe('capTotal');
    expect(validateDraft({ ...valid, cap_window_days: '400' }).cap_window_days).toBe('window');
    expect(validateDraft({ ...valid, starts_at: '2026-02-01T00:00', ends_at: '2026-01-01T00:00' }).ends_at).toBe('dates');
  });
  it('only allows lower plans for downgrade', () => {
    expect(validateDraft({ ...emptyDraft('downgrade'), name: 'Down', downgrade_plan: 'business' }).downgrade_plan).toBe('plan');
  });
});

describe('draftToPayload', () => {
  it('sends only the fields of the chosen kind', () => {
    const p = draftToPayload({ ...emptyDraft('pause'), name: ' Pause 2 ', pause_months: '2' });
    expect(p).toMatchObject({ kind: 'pause', name: 'Pause 2', pause_months: 2, discount_percent: null, downgrade_plan: null, cap_total: null });
    expect('id' in p).toBe(false);
  });
});

describe('parseOverview', () => {
  it('survives garbage', () => {
    const o = parseOverview(null);
    expect(o.offers).toEqual([]);
    expect(o.settings.enabled).toBe(true);
  });
  it('normalises numbers and round-trips into a draft', () => {
    const o = parseOverview({ offers: [{ id: 'a', kind: 'discount', name: 'N', enabled: true, discount_percent: '20.00', discount_months: 3, accepted: '2', cap_total: null }] });
    expect(o.offers[0].discount_percent).toBe(20);
    expect(o.offers[0].accepted).toBe(2);
    expect(offerToDraft(o.offers[0]).discount_percent).toBe('20');
  });
});

describe('pct', () => {
  it('never fakes a rate', () => {
    expect(pct(1, 0)).toBeNull();
    expect(pct(1, 3)).toBe(33);
  });
});

describe('rpc wrappers', () => {
  it('calls the audited RPCs', async () => {
    rpc.mockResolvedValue({ data: { offers: [] }, error: null });
    await fetchChurnSaveOverview(30);
    await saveSettings(false, 60);
    await saveOffer({ ...emptyDraft('pause'), name: 'Pause 1' });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['staff_churn_save_overview', 'staff_churn_save_set_settings', 'staff_churn_save_upsert_offer']);
    expect(rpc.mock.calls[1][1]).toEqual({ p_enabled: false, p_global_cooldown_days: 60 });
  });
  it('refuses to call the server with an invalid draft', async () => {
    await expect(saveOffer({ ...emptyDraft('discount'), name: 'x', discount_percent: '90' })).rejects.toThrow('invalid_offer');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('surfaces rpc errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden' } });
    await expect(fetchChurnSaveOverview()).rejects.toThrow('forbidden');
  });
});
