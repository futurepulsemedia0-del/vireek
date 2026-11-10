import { describe, it, expect } from 'vitest';
import { DEFAULT_REGIONAL, normalizeRegional } from '../regional';
import { effectiveRegionForCapabilities, parseEntitledModules, resolveRegionAccess } from './gate';

describe('resolveRegionAccess', () => {
  it('US is always allowed, whatever the flag/entitlement (zero change for existing accounts)', () => {
    for (const flagEnabled of [true, false, null, undefined]) for (const moduleEntitled of [true, false, null, undefined]) {
      expect(resolveRegionAccess({ country: 'US', flagEnabled, moduleEntitled })).toEqual({ allowed: true, reason: 'default_region' });
    }
    expect(resolveRegionAccess({ country: undefined, flagEnabled: false, moduleEntitled: false }).allowed).toBe(true);
    expect(resolveRegionAccess({ country: ' us ', flagEnabled: false, moduleEntitled: false }).allowed).toBe(true);
  });
  it('non-default regions need BOTH flag and entitlement (default OFF, fail closed)', () => {
    expect(resolveRegionAccess({ country: 'DE', flagEnabled: false, moduleEntitled: true })).toEqual({ allowed: false, reason: 'flag_off' });
    expect(resolveRegionAccess({ country: 'DE', flagEnabled: true, moduleEntitled: false })).toEqual({ allowed: false, reason: 'not_entitled' });
    expect(resolveRegionAccess({ country: 'DE', flagEnabled: undefined, moduleEntitled: undefined }).allowed).toBe(false);
    expect(resolveRegionAccess({ country: 'DE', flagEnabled: true, moduleEntitled: true })).toEqual({ allowed: true, reason: 'enabled' });
    expect(resolveRegionAccess({ country: 'DE', flagEnabled: 'yes' as never, moduleEntitled: true }).allowed).toBe(false); // truthy ≠ true
  });
});

describe('effectiveRegionForCapabilities', () => {
  const de = normalizeRegional({ country: 'DE' });
  it('hides a non-default region from new capabilities until enabled', () => {
    expect(effectiveRegionForCapabilities(de, { allowed: false, reason: 'flag_off' })).toBe(DEFAULT_REGIONAL);
    expect(effectiveRegionForCapabilities(de, { allowed: true, reason: 'enabled' })).toBe(de);
  });
});

describe('parseEntitledModules', () => {
  it('accepts strings and rows, drops junk', () => {
    expect([...parseEntitledModules(['regional_config', { module_key: 'other_mod' }, 'BAD KEY', 5, null, { module_key: 7 }])].sort()).toEqual(['other_mod', 'regional_config']);
    expect(parseEntitledModules(null).size).toBe(0);
    expect(parseEntitledModules({}).size).toBe(0);
  });
});
