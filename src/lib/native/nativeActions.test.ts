import { describe, expect, it } from 'vitest';
import { buildMapsUrl, buildSmsUrl, buildTelUrl } from './nativeActions';

describe('native action URLs', () => {
  it('normalizes phone numbers', () => expect(buildTelUrl('+1 (555) 123-4567')).toBe('tel:+15551234567'));
  it('rejects non-numeric input', () => {
    expect(buildTelUrl('javascript:alert(1)')).toBeNull();
    expect(buildTelUrl('12')).toBeNull();
    expect(buildTelUrl(null)).toBeNull();
  });
  it('builds sms links', () => expect(buildSmsUrl('555 123 4567')).toBe('sms:5551234567'));
  it('builds per-platform maps links', () => {
    expect(buildMapsUrl('12 Main St', 'ios')).toContain('maps.apple.com');
    expect(buildMapsUrl('12 Main St', 'android')).toBe('geo:0,0?q=12%20Main%20St');
    expect(buildMapsUrl('12 Main St', null)).toContain('google.com/maps');
    expect(buildMapsUrl('  ', 'ios')).toBeNull();
  });
});
