import { describe, expect, it } from 'vitest';
import { getStoreLinks, sanitizeStoreUrl } from './appLinks';

describe('appLinks', () => {
  it('accepts only https links on the official store host', () => {
    expect(sanitizeStoreUrl('https://apps.apple.com/us/app/vireek/id1', 'ios')).not.toBeNull();
    expect(sanitizeStoreUrl('https://play.google.com/store/apps/details?id=com.vireek.field', 'android')).not.toBeNull();
  });

  it('rejects other hosts, http, javascript: and the wrong store', () => {
    expect(sanitizeStoreUrl('http://apps.apple.com/x', 'ios')).toBeNull();
    expect(sanitizeStoreUrl('https://evil.example/x', 'ios')).toBeNull();
    expect(sanitizeStoreUrl('javascript:alert(1)', 'android')).toBeNull();
    expect(sanitizeStoreUrl('https://play.google.com/x', 'ios')).toBeNull();
    expect(sanitizeStoreUrl(null, 'ios')).toBeNull();
    expect(sanitizeStoreUrl('not a url', 'ios')).toBeNull();
  });

  it('returns no links until real URLs are configured', () => {
    expect(getStoreLinks()).toEqual([]);
  });
});
