import { describe, it, expect } from 'vitest';
import {
  EMPTY_SALES_FORM,
  buildPayload,
  classifyLead,
  formatDayChip,
  formatTime,
  groupSlotsByDay,
  interpretResponse,
  isValidPhone,
  readUtm,
  validateSalesForm,
  type SalesFormValues,
} from './contactSales';

const valid = (over: Partial<SalesFormValues> = {}): SalesFormValues => ({
  ...EMPTY_SALES_FORM,
  fullName: 'Sara Lee',
  workEmail: 'sara@acme.com',
  companyName: 'Acme HVAC',
  teamSize: '16-50',
  locations: '2-5',
  ...over,
});

const noUtm = { utmSource: '', utmMedium: '', utmCampaign: '' };

describe('validateSalesForm', () => {
  it('accepts a complete minimal form (free-mail addresses are fine for trades)', () => {
    expect(validateSalesForm(valid())).toEqual({});
    expect(validateSalesForm(valid({ workEmail: 'owner@gmail.com' }))).toEqual({});
  });

  it('reports required fields in DOM order, so the first key is the first field to focus', () => {
    expect(Object.keys(validateSalesForm(EMPTY_SALES_FORM))).toEqual([
      'fullName',
      'workEmail',
      'companyName',
      'teamSize',
      'locations',
    ]);
  });

  it('validates email, phone and message length', () => {
    expect(validateSalesForm(valid({ workEmail: 'not-an-email' })).workEmail).toBeDefined();
    expect(validateSalesForm(valid({ phone: 'abc' })).phone).toBeDefined();
    expect(validateSalesForm(valid({ phone: '123' })).phone).toBeDefined();
    expect(validateSalesForm(valid({ phone: '+1 (650) 910-6703' }))).toEqual({});
    expect(validateSalesForm(valid({ message: 'x'.repeat(1501) })).message).toBeDefined();
  });

  it('requires a phone number before accepting SMS consent', () => {
    expect(validateSalesForm(valid({ smsConsent: true })).smsConsent).toBeDefined();
    expect(validateSalesForm(valid({ smsConsent: true, phone: '6509106703' }))).toEqual({});
  });

  it('checks phone shape', () => {
    expect(isValidPhone('(650) 910-6703')).toBe(true);
    expect(isValidPhone('12345678901234567')).toBe(false);
    expect(isValidPhone('555-CALL-NOW')).toBe(false);
  });
});

describe('classifyLead (mirrors the database routing)', () => {
  it('routes by team size and locations', () => {
    expect(classifyLead('1-5', '1')).toEqual({ segment: 'smb', priority: 'low' });
    expect(classifyLead('6-15', '1')).toEqual({ segment: 'smb', priority: 'low' });
    expect(classifyLead('16-50', '1')).toEqual({ segment: 'mid_market', priority: 'normal' });
    expect(classifyLead('1-5', '2-5')).toEqual({ segment: 'mid_market', priority: 'normal' });
    expect(classifyLead('51-200', '1')).toEqual({ segment: 'enterprise', priority: 'high' });
    expect(classifyLead('200+', '1')).toEqual({ segment: 'enterprise', priority: 'high' });
    expect(classifyLead('1-5', '6-20')).toEqual({ segment: 'enterprise', priority: 'high' });
    expect(classifyLead('16-50', '21+')).toEqual({ segment: 'enterprise', priority: 'high' });
  });
  it('treats missing answers as the lowest tier', () => {
    expect(classifyLead('', '')).toEqual({ segment: 'smb', priority: 'low' });
  });
});

describe('buildPayload and attribution', () => {
  it('trims, lowercases the email and serializes the slot', () => {
    const slot = new Date('2026-10-12T16:00:00Z');
    const p = buildPayload(
      valid({ fullName: '  Sara Lee ', workEmail: '  Sara@Acme.COM ', message: '  hi  ' }),
      { slotStart: slot, source: 'contact-sales', ...noUtm },
    );
    expect(p.fullName).toBe('Sara Lee');
    expect(p.workEmail).toBe('sara@acme.com');
    expect(p.message).toBe('hi');
    expect(p.slotStart).toBe('2026-10-12T16:00:00.000Z');
    expect(buildPayload(valid(), { slotStart: null, source: 'x', ...noUtm }).slotStart).toBeNull();
  });
  it('reads UTM params safely', () => {
    expect(readUtm('?utm_source=google&utm_medium=cpc&utm_campaign=spring')).toEqual({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
    });
    expect(readUtm('').utmSource).toBe('');
    expect(readUtm(`utm_source=${'a'.repeat(300)}`).utmSource).toHaveLength(100);
    expect(readUtm('utm_source=a%00b%0Ac').utmSource).toBe('abc');
  });
});

describe('interpretResponse', () => {
  it('maps a successful booking', () => {
    const r = interpretResponse(200, {
      ok: true,
      inquiryId: 'i1',
      duplicate: false,
      booking: { slotStart: '2026-10-12T16:00:00Z', slotEnd: '2026-10-12T16:30:00Z' },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.booking?.start.toISOString()).toBe('2026-10-12T16:00:00.000Z');
      expect(r.inquiryId).toBe('i1');
    }
  });
  it('maps a request without a booking', () => {
    const r = interpretResponse(200, { ok: true, inquiryId: 'i1', duplicate: false, booking: null });
    expect(r.kind === 'ok' && r.booking).toBeNull();
  });
  it('maps each failure mode', () => {
    expect(interpretResponse(409, { error: 'slot_taken' }).kind).toBe('slot_taken');
    expect(interpretResponse(429, { error: 'rate_limited', message: 'Slow down' })).toEqual({
      kind: 'rate_limited',
      message: 'Slow down',
    });
    expect(interpretResponse(400, { error: 'invalid', message: 'Please enter a valid email address.' })).toEqual({
      kind: 'invalid',
      message: 'Please enter a valid email address.',
    });
    expect(interpretResponse(500, null).kind).toBe('error');
    expect(interpretResponse(200, 'garbage').kind).toBe('error');
  });
});

describe('slot display', () => {
  const at = (day: number, hour: number, minute = 0) => {
    const start = new Date(2026, 9, day, hour, minute);
    return { start, end: new Date(start.getTime() + 30 * 60_000) };
  };
  it('groups slots by local day in chronological order', () => {
    const groups = groupSlotsByDay([at(13, 9), at(12, 14, 30), at(12, 9)]);
    expect(groups.map((g) => g.slots.length)).toEqual([2, 1]);
    expect(groups[0].slots[0].start.getHours()).toBe(9);
    expect(groups[0].key).toBe('2026-10-12');
  });
  it('formats days and times', () => {
    expect(formatDayChip(new Date(2026, 9, 12))).toBe('Mon, Oct 12');
    expect(formatTime(new Date(2026, 9, 12, 14, 30))).toBe('2:30 PM');
    expect(formatTime(new Date(2026, 9, 12, 9, 0))).toBe('9:00 AM');
  });
});
