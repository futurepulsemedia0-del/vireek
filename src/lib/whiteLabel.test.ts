import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import {
  effectiveShowVireek,
  findVendorLeaks,
  hexToTriplet,
  isCustomerRoute,
  planAllowsWhiteLabel,
  portalDocumentTitle,
  tailwindBrandVars,
} from './whiteLabel';

describe('white-label entitlement', () => {
  it('only business and enterprise are entitled', () => {
    expect(planAllowsWhiteLabel('business')).toBe(true);
    expect(planAllowsWhiteLabel('enterprise')).toBe(true);
    for (const p of ['free', 'starter', 'professional', '', null, undefined]) expect(planAllowsWhiteLabel(p)).toBe(false);
  });

  it('a non-entitled account always shows Vireek, even if the stored switch is off (downgrade-safe)', () => {
    expect(effectiveShowVireek(false, false)).toBe(true);
    expect(effectiveShowVireek(false, true)).toBe(false);
    expect(effectiveShowVireek(true, true)).toBe(true);
  });
});

describe('helpers', () => {
  it('keeps customer routes reachable on a custom domain, nothing else', () => {
    expect(isCustomerRoute('/portal/abc')).toBe(true);
    expect(isCustomerRoute('/pay-result')).toBe(true);
    expect(isCustomerRoute('/dashboard')).toBe(false);
    expect(isCustomerRoute('/login')).toBe(false);
  });

  it('converts hex to tailwind triplets', () => {
    expect(hexToTriplet('#15803D')).toBe('21 128 61');
    expect(hexToTriplet('nope')).toBeNull();
    expect(tailwindBrandVars('#000000', '#FFFFFF')).toEqual({ '--accent-primary': '0 0 0', '--accent-secondary': '255 255 255' });
  });

  it('never puts the vendor in the portal title', () => {
    expect(findVendorLeaks(portalDocumentTitle('Acme HVAC'))).toEqual([]);
    expect(findVendorLeaks(portalDocumentTitle(null))).toEqual([]);
  });
});
