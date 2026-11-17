import { describe, expect, it } from 'vitest';
import { getNextSupportOpening } from './supportHours';

describe('getNextSupportOpening', () => {
  it('is null while the team is inside its window', () => {
    expect(getNextSupportOpening(new Date('2026-11-17T15:00:00Z'))).toBeNull(); // Tue 10:00 ET
  });
  it('says "today" before opening on a working day', () => {
    expect(getNextSupportOpening(new Date('2026-11-17T12:00:00Z'))).toBe('today at 9am EST'); // Tue 07:00
  });
  it('says "tomorrow" after closing on a working day', () => {
    expect(getNextSupportOpening(new Date('2026-11-17T23:00:00Z'))).toBe('tomorrow at 9am EST'); // Tue 18:00
  });
  it('skips the weekend after Friday closing and on Saturday', () => {
    expect(getNextSupportOpening(new Date('2026-11-20T23:30:00Z'))).toBe('Monday at 9am EST'); // Fri 18:30
    expect(getNextSupportOpening(new Date('2026-11-21T15:00:00Z'))).toBe('Monday at 9am EST'); // Sat
  });
  it('says "tomorrow" on Sunday (Monday is the next day)', () => {
    expect(getNextSupportOpening(new Date('2026-11-22T15:00:00Z'))).toBe('tomorrow at 9am EST');
  });
  it('uses the daylight-saving zone label in summer', () => {
    expect(getNextSupportOpening(new Date('2026-07-14T10:00:00Z'))).toBe('today at 9am EDT'); // Tue 06:00 EDT
  });
});
