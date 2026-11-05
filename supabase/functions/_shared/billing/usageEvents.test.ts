import { describe, it, expect } from 'vitest';
import { estimateSmsSegments } from './usageEvents';

describe('estimateSmsSegments', () => {
  it('GSM-7 single and multipart', () => {
    expect(estimateSmsSegments('')).toBe(0);
    expect(estimateSmsSegments('a'.repeat(160))).toBe(1);
    expect(estimateSmsSegments('a'.repeat(161))).toBe(2);
    expect(estimateSmsSegments('a'.repeat(306))).toBe(2);
    expect(estimateSmsSegments('a'.repeat(307))).toBe(3);
  });
  it('extension characters count double', () => {
    expect(estimateSmsSegments('€'.repeat(80))).toBe(1);
    expect(estimateSmsSegments('€'.repeat(81))).toBe(2);
  });
  it('non-GSM text falls back to UCS-2 limits', () => {
    expect(estimateSmsSegments('سلام')).toBe(1);
    expect(estimateSmsSegments('س'.repeat(70))).toBe(1);
    expect(estimateSmsSegments('س'.repeat(71))).toBe(2);
  });
});
