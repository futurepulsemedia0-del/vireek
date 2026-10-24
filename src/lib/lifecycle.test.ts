import { describe, it, expect } from 'vitest';
import {
  TOUCH_TYPES,
  buildMonthGrid,
  deliveryState,
  emptyProfileForm,
  gridRange,
  groupByDate,
  maxDayOfMonth,
  missingDataWarnings,
  profileToForm,
  relativeDayLabel,
  shiftMonth,
  toggleTouch,
  touchTitle,
  validateProfileForm,
  validateSettingsDraft,
  parseEquipmentTypes,
  renderTemplate,
  sampleVars,
  type CalendarRow,
  type LifecycleProfile,
} from './lifecycle';
import { renderTemplate as coreRender } from '../../supabase/functions/_shared/lifecycle/lifecycleCore';

const row = (over: Partial<CalendarRow> = {}): CalendarRow => ({
  touch_type: 'birthday', customer_id: 'c1', customer_name: 'Sara', equipment_id: null, equipment_label: null,
  occurrence_date: '2026-10-21', occurrence_year: 2026, years_count: null, opted_in: true, email_consent: true, sms_consent: false,
  delivery: {}, ...over,
});

describe('month grid', () => {
  it('always has 42 cells starting on a Sunday and covering the month', () => {
    const g = buildMonthGrid(2026, 10); // Oct 1 2026 is a Thursday
    expect(g).toHaveLength(42);
    expect(g[0].iso).toBe('2026-09-27');
    expect(g.filter((c) => c.inMonth)).toHaveLength(31);
    expect(g.find((c) => c.iso === '2026-10-01')?.inMonth).toBe(true);
    expect(gridRange(g)).toEqual({ from: '2026-09-27', to: '2026-11-07' });
  });
  it('handles a month that starts on Sunday and leap February', () => {
    expect(buildMonthGrid(2026, 2)[0].iso).toBe('2026-02-01');
    expect(buildMonthGrid(2028, 2).filter((c) => c.inMonth)).toHaveLength(29);
  });
  it('shifts months across years', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 6, 0)).toEqual({ year: 2026, month: 6 });
  });
});

describe('calendar rows', () => {
  it('groups by date', () => {
    const m = groupByDate([row(), row({ customer_id: 'c2' }), row({ occurrence_date: '2026-10-22' })]);
    expect(m.get('2026-10-21')).toHaveLength(2);
    expect(m.get('2026-10-22')).toHaveLength(1);
  });
  it('derives delivery state with the right precedence', () => {
    expect(deliveryState(row())).toBe('scheduled');
    expect(deliveryState(row({ opted_in: false }))).toBe('not_opted_in');
    expect(deliveryState(row({ delivery: { email: { status: 'sent', reason: null } } }))).toBe('sent');
    expect(deliveryState(row({ delivery: { email: { status: 'sent', reason: null }, sms: { status: 'failed', reason: null } } }))).toBe('sent');
    expect(deliveryState(row({ delivery: { sms: { status: 'failed', reason: null } } }))).toBe('failed');
    expect(deliveryState(row({ delivery: { email: { status: 'deferred', reason: 'quiet_hours' } } }))).toBe('pending');
    expect(deliveryState(row({ delivery: { sms: { status: 'skipped', reason: 'no_contact' } } }))).toBe('skipped');
  });
  it('labels days relative to today', () => {
    expect(relativeDayLabel('2026-10-22', '2026-10-22')).toBe('Today');
    expect(relativeDayLabel('2026-10-22', '2026-10-23')).toBe('Tomorrow');
    expect(relativeDayLabel('2026-10-22', '2026-10-21')).toBe('Yesterday');
    expect(relativeDayLabel('2026-10-22', '2026-10-29')).toBe('In 7 days');
    expect(relativeDayLabel('2026-10-22', '2026-10-19')).toBe('3 days ago');
  });
  it('titles anniversaries with years and equipment', () => {
    expect(touchTitle(row())).toBe('Birthday');
    expect(touchTitle(row({ touch_type: 'equipment_install_anniversary', years_count: 5, equipment_label: 'Carrier furnace' }))).toBe('Carrier furnace · Equipment-install anniversary · 5 yr');
    expect(touchTitle(row({ touch_type: 'first_service_anniversary', years_count: 2 }))).toBe('First-service anniversary · 2 yr');
  });
});

describe('consent form', () => {
  const today = '2026-10-22';
  const ok = { ...emptyProfileForm(), touches: ['birthday' as const], email: true, source: 'verbal' as const, birthMonth: '2', birthDay: '29' };
  it('accepts an empty form (no consent, no data)', () => {
    expect(validateProfileForm(emptyProfileForm(), today)).toEqual({});
  });
  it('accepts a complete opt-in including Feb 29', () => {
    expect(validateProfileForm(ok, today)).toEqual({});
  });
  it('requires month and day together and a real day', () => {
    expect(validateProfileForm({ ...ok, birthDay: '' }, today).birthday).toBeTruthy();
    expect(validateProfileForm({ ...ok, birthMonth: '4', birthDay: '31' }, today).birthday).toBeTruthy();
    expect(validateProfileForm({ ...ok, birthMonth: '13', birthDay: '1' }, today).birthday).toBeTruthy();
  });
  it('validates the purchase date', () => {
    expect(validateProfileForm({ ...ok, homePurchaseDate: '2026-10-23' }, today).homePurchaseDate).toBeTruthy();
    expect(validateProfileForm({ ...ok, homePurchaseDate: '2026-02-30' }, today).homePurchaseDate).toBeTruthy();
    expect(validateProfileForm({ ...ok, homePurchaseDate: '1899-12-31' }, today).homePurchaseDate).toBeTruthy();
    expect(validateProfileForm({ ...ok, homePurchaseDate: '2019-06-15' }, today).homePurchaseDate).toBeUndefined();
  });
  it('never allows a touch without a channel and a consent source', () => {
    const e = validateProfileForm({ ...ok, email: false, sms: false, source: '' }, today);
    expect(e.channels).toBeTruthy();
    expect(e.source).toBeTruthy();
  });
  it('round-trips a stored profile', () => {
    const p: LifecycleProfile = { customer_id: 'c', birth_month: 3, birth_day: 9, home_purchase_date: '2019-06-15', opted_in_touches: ['birthday'], email_consent: true, sms_consent: false, consent_source: 'written', consent_at: null, consent_withdrawn_at: null };
    const f = profileToForm(p);
    expect(f).toMatchObject({ birthMonth: '3', birthDay: '9', homePurchaseDate: '2019-06-15', email: true, sms: false, source: 'written' });
    expect(profileToForm(null)).toEqual(emptyProfileForm());
  });
  it('warns when an opted-in touch has no data', () => {
    const f = { ...emptyProfileForm(), touches: [...TOUCH_TYPES] };
    expect(missingDataWarnings(f, false)).toHaveLength(3);
    expect(missingDataWarnings({ ...f, birthMonth: '1', birthDay: '1', homePurchaseDate: '2020-01-01' }, true)).toHaveLength(0);
  });
  it('toggles touches in a stable order', () => {
    expect(toggleTouch([], 'first_service_anniversary')).toEqual(['first_service_anniversary']);
    expect(toggleTouch(['first_service_anniversary'], 'birthday')).toEqual(['birthday', 'first_service_anniversary']);
    expect(toggleTouch(['birthday'], 'birthday')).toEqual([]);
  });
  it('knows month lengths', () => {
    expect([1, 2, 4, 12].map(maxDayOfMonth)).toEqual([31, 29, 30, 31]);
  });
});

describe('preview parity with the sender', () => {
  it('renders with the very same function the edge function uses', () => {
    expect(renderTemplate).toBe(coreRender);
    expect(renderTemplate('Hi {{name}}', sampleVars('birthday', 'Acme', false))).toBe('Hi Sara');
  });
});

describe('settings draft validation', () => {
  const base = { lead_days: 0, send_hour: 9, min_years: 1, max_years: 25, offer_enabled: false, offer_type: 'percent_off' as const, offer_value: null, offer_title: null, offer_valid_days: 30 };
  it('accepts sane defaults', () => {
    expect(validateSettingsDraft(base)).toEqual({});
  });
  it('rejects out-of-range timing and inverted year windows', () => {
    expect(Object.keys(validateSettingsDraft({ ...base, lead_days: 31, send_hour: 24, min_years: 0 })).sort()).toEqual(['lead_days', 'min_years', 'send_hour']);
    expect(validateSettingsDraft({ ...base, min_years: 5, max_years: 3 }).max_years).toBeTruthy();
    expect(validateSettingsDraft({ ...base, lead_days: 1.5 }).lead_days).toBeTruthy();
  });
  it('only validates the offer when it is enabled', () => {
    expect(validateSettingsDraft({ ...base, offer_title: '' })).toEqual({});
    const on = { ...base, offer_enabled: true };
    expect(Object.keys(validateSettingsDraft(on)).sort()).toEqual(['offer_title', 'offer_value']);
    expect(validateSettingsDraft({ ...on, offer_title: 'any repair', offer_value: 10 })).toEqual({});
    expect(validateSettingsDraft({ ...on, offer_title: 'x', offer_value: 150 }).offer_value).toBeTruthy();
    expect(validateSettingsDraft({ ...on, offer_type: 'free_service', offer_title: 'Free tune-up' })).toEqual({});
    expect(validateSettingsDraft({ ...on, offer_type: 'amount_off', offer_title: 'x', offer_value: 0 }).offer_value).toBeTruthy();
    expect(validateSettingsDraft({ ...on, offer_title: 'x', offer_value: 5, offer_valid_days: 400 }).offer_valid_days).toBeTruthy();
  });
  it('normalises equipment types', () => {
    expect(parseEquipmentTypes(' Furnace, AC ,furnace,, ')).toEqual(['furnace', 'ac']);
    expect(parseEquipmentTypes('')).toEqual([]);
  });
});
