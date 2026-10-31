import { describe, it, expect } from 'vitest';
import {
  BOOKING_MIN_HOURS,
  COLLECTION_MIN_DAYS,
  FINANCING_MIN_HOURS,
  FINANCING_MIN_VALUE_CENTS,
  INVOICE_MIN_HOURS,
  PARTS_GAP_MIN_CENTS,
  riskScore,
} from './rules';
import { OVERDUE_AFTER_DAYS } from '../payment-reminders/window';

describe('riskScore', () => {
  it('is 0 with no stall and no value', () => expect(riskScore(0, 0)).toBe(0));
  it('adds 1 point per 4 stalled hours and 1 per $50', () => {
    expect(riskScore(72, 50000)).toBe(18 + 10);
    expect(riskScore(24, 1500)).toBe(6 + 0);
  });
  it('rounds half up at the component level', () => {
    expect(riskScore(2, 0)).toBe(1); // 0.5 -> 1
    expect(riskScore(1.9, 0)).toBe(0);
    expect(riskScore(0, 2500)).toBe(1); // 0.5 -> 1
    expect(riskScore(0, 2499)).toBe(0);
  });
  it('caps time at 60, value at 40 and the total at 100', () => {
    expect(riskScore(240, 0)).toBe(60);
    expect(riskScore(100000, 0)).toBe(60);
    expect(riskScore(0, 200000)).toBe(40);
    expect(riskScore(0, 1e9)).toBe(40);
    expect(riskScore(240, 200000)).toBe(100);
    expect(riskScore(1e9, 1e12)).toBe(100);
  });
  it('is monotonic in both inputs and always an integer in 0..100', () => {
    let prev = -1;
    for (let h = 0; h <= 400; h += 7) {
      const s = riskScore(h, 123456);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      prev = s;
    }
    prev = -1;
    for (let c = 0; c <= 400000; c += 9999) {
      const s = riskScore(30, c);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
  it('a collection case uses days*24 hours (14 days = 84 pts of time, capped at 60)', () => {
    expect(riskScore(COLLECTION_MIN_DAYS * 24, 0)).toBe(60);
  });
});

describe('thresholds', () => {
  it('keep their documented values (changing one is a deliberate, reviewed decision)', () => {
    expect(FINANCING_MIN_HOURS).toBe(72);
    expect(FINANCING_MIN_VALUE_CENTS).toBe(50000);
    expect(BOOKING_MIN_HOURS).toBe(24);
    expect(INVOICE_MIN_HOURS).toBe(24);
    expect(PARTS_GAP_MIN_CENTS).toBe(1500);
  });
  it('collection window matches send-payment-reminders overdue window (documented invariant)', () => {
    expect(COLLECTION_MIN_DAYS).toBe(OVERDUE_AFTER_DAYS);
  });
  it('money thresholds are whole cents', () => {
    expect(Number.isInteger(FINANCING_MIN_VALUE_CENTS)).toBe(true);
    expect(Number.isInteger(PARTS_GAP_MIN_CENTS)).toBe(true);
  });
});
