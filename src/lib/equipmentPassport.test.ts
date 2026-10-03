import { describe, it, expect } from 'vitest';
import {
  buildJourney,
  formatPassportCode,
  isValidPassportCode,
  journeyCompleteness,
  maskSerial,
  normalizePassportCode,
  passportErrorMessage,
  passportUrl,
  warrantyState,
} from '@/lib/equipmentPassport';

describe('passport codes', () => {
  it('normalizes formatted, lowercase and ambiguous characters', () => {
    expect(normalizePassportCode('veq-abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizePassportCode('ABCD EFGH JKMN')).toBe('ABCDEFGHJKMN');
    expect(normalizePassportCode('0O1IL2345678')).toBe('001112345678');
  });

  it('extracts the code from a scanned URL', () => {
    expect(normalizePassportCode('https://vireek.com/e/VEQ-ABCD-EFGH-JKMN?utm=x')).toBe('ABCDEFGHJKMN');
    expect(normalizePassportCode('https://vireek.com/e/ABCDEFGHJKMN')).toBe('ABCDEFGHJKMN');
  });

  it('validates against the SQL alphabet', () => {
    expect(isValidPassportCode('VEQ-ABCD-EFGH-JKMN')).toBe(true);
    expect(isValidPassportCode('ABCDEFGHJKMN')).toBe(true);
    expect(isValidPassportCode('ABCDEFGHJKM')).toBe(false); // 11 chars
    expect(isValidPassportCode('ABCDEFGHJKMU')).toBe(false); // U is not in the alphabet
    expect(isValidPassportCode('')).toBe(false);
  });

  it('formats and builds URLs', () => {
    expect(formatPassportCode('abcdefghjkmn')).toBe('VEQ-ABCD-EFGH-JKMN');
    expect(passportUrl('VEQ-ABCD-EFGH-JKMN', 'https://vireek.com/')).toBe('https://vireek.com/e/ABCDEFGHJKMN');
  });
});

describe('maskSerial', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskSerial('1234567890')).toBe('••••7890');
    expect(maskSerial('AB12')).toBe('••••');
    expect(maskSerial(null)).toBe('—');
  });
});

describe('warrantyState', () => {
  const now = new Date('2026-06-01T12:00:00');
  it('classifies', () => {
    expect(warrantyState(null, now).state).toBe('unknown');
    expect(warrantyState('2026-05-01', now).state).toBe('expired');
    expect(warrantyState('2026-07-01', now).state).toBe('expiring');
    expect(warrantyState('2028-01-01', now).state).toBe('active');
  });
  it('counts the expiry day as still covered', () => {
    expect(warrantyState('2026-06-01', now).state).toBe('expiring');
  });
});

describe('journey', () => {
  it('lists the 7 stages in order and scores completeness', () => {
    const steps = buildJourney({
      diagnosis: 'No cooling',
      technician: 'Maria G.',
      parts: [{ name: 'Capacitor', qty: 2 }],
      photos: { count: 4, fingerprinted: 4 },
      warranty: { active_at_service: true },
      work: ['Replaced capacitor'],
      outcome: { resolution: 'fixed', first_time_fix: true },
    });
    expect(steps.map((s) => s.key)).toEqual(['diagnosis', 'technician', 'parts', 'photos', 'warranty', 'repair', 'outcome']);
    expect(steps[2].text).toBe('Capacitor ×2');
    expect(steps[6].text).toBe('Fixed · first-time fix');
    expect(journeyCompleteness(steps)).toBe(100);
  });

  it('handles an empty summary', () => {
    const steps = buildJourney({});
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(journeyCompleteness(steps)).toBe(0);
  });
});

describe('passportErrorMessage', () => {
  it('maps server codes to friendly copy', () => {
    expect(passportErrorMessage({ message: 'PASSPORT_NOT_FOUND' })).toMatch(/No passport/);
    expect(passportErrorMessage({ message: 'PASSPORT_INVALID: date is in the future' })).toBe('Not valid: date is in the future');
    expect(passportErrorMessage(new Error('boom'))).toMatch(/Something went wrong/);
  });
});
