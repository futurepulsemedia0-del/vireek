import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  brandingStyle,
  contrastWithWhite,
  generateSlots,
  isSlotFree,
  sanitizeBranding,
  settingsFromRow,
  settingsToPayload,
  validateIntakeAnswers,
  validateSettings,
  type BookingSettings,
  type BusyInterval,
  type HoursMap,
  type SlotPolicy,
} from './bookingPolicy';

// Wednesday 2026-10-07 08:00 local time
const NOW = new Date(2026, 9, 7, 8, 0, 0, 0);
const WEEKDAYS: HoursMap = Object.fromEntries(
  (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((d) => [d, { open: '09:00', close: '12:00' }]),
);

const policy = (over: Partial<SlotPolicy> = {}): SlotPolicy => ({
  hours: WEEKDAYS, holidays: [], durationMinutes: 60, leadTimeHours: 0, windowDays: 7,
  bufferBefore: 0, bufferAfter: 0, ...over,
});
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m, 0, 0);
const today = (slots: Date[]) => slots.filter((s) => s.getDate() === 7).map((s) => s.getHours());
const settings = (over: Partial<BookingSettings> = {}): BookingSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe('generateSlots', () => {
  it('fills open hours on a duration grid and skips closed days', () => {
    const slots = generateSlots(policy(), [], NOW);
    expect(slots.slice(0, 3).map((s) => s.getHours())).toEqual([9, 10, 11]);
    expect(slots.some((s) => s.getDay() === 0 || s.getDay() === 6)).toBe(false);
  });

  it('respects lead time', () => {
    const slots = generateSlots(policy({ leadTimeHours: 3 }), [], NOW); // earliest = 11:00 today
    expect(slots[0]).toEqual(at(7, 11));
  });

  it('skips holidays', () => {
    const slots = generateSlots(policy({ holidays: ['2026-10-07'] }), [], NOW);
    expect(slots[0]).toEqual(at(8, 9));
  });

  it('removes a booked slot even with no buffers', () => {
    const busy: BusyInterval[] = [{ start: at(7, 10), durationMinutes: 60 }];
    expect(today(generateSlots(policy({ windowDays: 1 }), busy, NOW))).toEqual([9, 11]);
  });

  it('blocks neighbouring slots when buffers are set', () => {
    const busy: BusyInterval[] = [{ start: at(7, 10), durationMinutes: 60 }];
    const slots = generateSlots(policy({ windowDays: 1, bufferBefore: 15, bufferAfter: 15 }), busy, NOW);
    expect(today(slots)).toEqual([]); // 9:00 ends flush against 10:00 (needs 15 min), 11:00 starts flush after
  });

  it('only counts the buffer on the side it applies to', () => {
    const busy: BusyInterval[] = [{ start: at(7, 10), durationMinutes: 60 }];
    const afterOnly = generateSlots(policy({ windowDays: 1, bufferAfter: 15 }), busy, NOW);
    expect(today(afterOnly)).toEqual([11]); // 9:00 blocked: its +15 buffer runs into 10:00
    const beforeOnly = generateSlots(policy({ windowDays: 1, bufferBefore: 15 }), busy, NOW);
    expect(today(beforeOnly)).toEqual([9]); // 11:00 blocked: needs 15 min after the 10:00 job ends
  });

  it('returns nothing without hours and honours maxSlots', () => {
    expect(generateSlots(policy({ hours: null }), [], NOW)).toEqual([]);
    expect(generateSlots(policy(), [], NOW, 4)).toHaveLength(4);
  });

  it('never offers a time beyond the booking window', () => {
    const slots = generateSlots(policy({ windowDays: 1 }), [], NOW);
    expect(slots.every((s) => s.getTime() <= NOW.getTime() + 24 * 3600 * 1000)).toBe(true);
  });
});

describe('isSlotFree', () => {
  it('treats back-to-back jobs as free when buffers are zero', () => {
    const busy: BusyInterval[] = [{ start: at(7, 9), durationMinutes: 60 }];
    expect(isSlotFree(at(7, 10), { durationMinutes: 60, bufferBefore: 0, bufferAfter: 0 }, busy)).toBe(true);
  });
});

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(settings())).toEqual({});
  });

  it('requires a link to enable booking and validates its format', () => {
    expect(validateSettings(settings({ enabled: true })).slug).toBeTruthy();
    expect(validateSettings(settings({ slug: 'ab' })).slug).toBeTruthy();
    expect(validateSettings(settings({ slug: 'acme-plumbing', enabled: true })).slug).toBeUndefined();
  });

  it('range-checks scheduling numbers', () => {
    const e = validateSettings(settings({ durationMinutes: 5, leadTimeHours: -1, windowDays: 0, bufferBefore: 999, bufferAfter: 1.5 }));
    expect(Object.keys(e).sort()).toEqual(['bufferAfter', 'bufferBefore', 'duration', 'leadTime', 'window']);
  });

  it('validates custom hours only when they are in use', () => {
    const bad: HoursMap = { mon: { open: '17:00', close: '09:00' }, tue: { open: '09:00', close: '09:30' } };
    expect(validateSettings(settings({ useBusinessHours: true, hours: bad }))).toEqual({});
    const e = validateSettings(settings({ useBusinessHours: false, hours: bad }));
    expect(e['hours.mon']).toBeTruthy();
    expect(e['hours.tue']).toBeTruthy(); // 30 min window < 60 min appointment
    expect(validateSettings(settings({ useBusinessHours: false, hours: {} })).hours).toBeTruthy();
  });

  it('validates deposit bounds', () => {
    expect(validateSettings(settings({ depositCents: -1 })).deposit).toBeTruthy();
    expect(validateSettings(settings({ depositCents: 5000 })).deposit).toBeUndefined();
  });

  it('validates intake questions', () => {
    const q = (over = {}) => ({ id: 'q1', label: 'Gate code?', type: 'text' as const, required: false, options: [], ...over });
    expect(validateSettings(settings({ intake: [q()] }))).toEqual({});
    expect(validateSettings(settings({ intake: [q({ label: '  ' })] }))['intake.q1']).toBeTruthy();
    expect(validateSettings(settings({ intake: [q({ type: 'select', options: ['Only one', ' only one '] })] }))['intake.q1']).toBeTruthy();
    expect(validateSettings(settings({ intake: [q({ type: 'select', options: ['A', 'B'] })] }))).toEqual({});
  });

  it('rejects unreadable brand colours and insecure logos', () => {
    const brand = (over = {}) => ({ ...DEFAULT_SETTINGS.branding, ...over });
    expect(validateSettings(settings({ branding: brand({ accent_color: '#ffff00' }) })).accent).toBeTruthy();
    expect(validateSettings(settings({ branding: brand({ accent_color: 'red' }) })).accent).toBeTruthy();
    expect(validateSettings(settings({ branding: brand({ accent_color: '#1f3ad8' }) })).accent).toBeUndefined();
    expect(validateSettings(settings({ branding: brand({ logo_url: 'http://x.com/a.png' }) })).logo).toBeTruthy();
    expect(validateSettings(settings({ branding: brand({ logo_url: 'https://x.com/a.png' }) })).logo).toBeUndefined();
  });
});

describe('validateIntakeAnswers', () => {
  const questions = [
    { id: 'a', label: 'Describe it', type: 'longtext' as const, required: true, options: [] },
    { id: 'b', label: 'Pets?', type: 'yesno' as const, required: false, options: [] },
    { id: 'c', label: 'Floor', type: 'select' as const, required: false, options: ['1st', '2nd'] },
  ];
  it('flags missing required and invalid answers only', () => {
    expect(validateIntakeAnswers(questions, { b: 'maybe', c: '3rd' })).toEqual({
      a: expect.any(String), b: expect.any(String), c: expect.any(String),
    });
    expect(validateIntakeAnswers(questions, { a: 'Leaking', b: 'yes', c: '2nd' })).toEqual({});
  });
});

describe('row mapping', () => {
  it('maps a row to settings and back without losing data', () => {
    const row = {
      booking_slug: 'acme', booking_enabled: true, booking_default_duration_minutes: 90, booking_lead_time_hours: 4,
      booking_window_days: 30, booking_buffer_before_minutes: 10, booking_buffer_after_minutes: 20,
      booking_hours: { mon: { open: '08:00', close: '16:00' } }, booking_hidden_services: ['Old', 'Gone'],
      booking_deposit_cents: 7500, booking_deposit_policy: ' Refundable ',
      booking_intake_questions: [{ id: 'q1', label: ' Gate? ', type: 'select', required: true, options: ['A', ' ', 'a', 'B'] }],
      booking_branding: { accent_color: '#1F3AD8', logo_url: 'javascript:alert(1)', headline: ' Hi ' },
      business_hours: { tue: { open: '09:00', close: '17:00' } },
    };
    const s = settingsFromRow(row);
    expect(s.useBusinessHours).toBe(false);
    expect(s.hours).toEqual({ mon: { open: '08:00', close: '16:00' } });
    expect(s.branding.logo_url).toBeNull();
    expect(s.branding.accent_color).toBe('#1f3ad8');

    const p = settingsToPayload(s, ['Old', 'New']);
    expect(p.booking_hidden_services).toEqual(['Old']);
    expect(p.booking_deposit_policy).toBe('Refundable');
    expect(p.booking_intake_questions[0]).toMatchObject({ label: 'Gate?', options: ['A', 'B'] });
    expect(p.booking_hours).toEqual(row.booking_hours);
  });

  it('follows business hours when no custom hours are stored', () => {
    const s = settingsFromRow({ booking_hours: null, business_hours: { tue: { open: '09:00', close: '17:00' } } });
    expect(s.useBusinessHours).toBe(true);
    expect(s.hours.tue).toEqual({ open: '09:00', close: '17:00' });
    expect(settingsToPayload(s, []).booking_hours).toBeNull();
  });

  it('falls back to defaults when there is no row', () => {
    expect(settingsFromRow(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('branding', () => {
  it('emits css variables only for a valid, readable colour', () => {
    expect(brandingStyle({ ...sanitizeBranding({}), accent_color: '#1f3ad8' })).toEqual({
      '--accent-primary': '31 58 216', '--accent-secondary': '31 58 216',
    });
    expect(brandingStyle({ ...sanitizeBranding({}), accent_color: '#ffff00' })).toBeUndefined();
    expect(brandingStyle(null)).toBeUndefined();
  });
  it('computes contrast against white', () => {
    expect(contrastWithWhite('#000000')).toBeGreaterThan(20);
    expect(contrastWithWhite('#ffffff')).toBeLessThan(1.1);
  });
});
