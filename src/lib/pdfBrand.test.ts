import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));

import { VIREEK_PDF_BRAND, buildPdfBrand, getPdfBrand, setPdfBrand } from './pdfBrand';
import { findVendorLeaks } from './whiteLabel';

const settings = (powered: boolean) => ({ primary_color: '#15803D', accent_color: '#65A30D', portal_show_powered_by: powered });

describe('pdf brand', () => {
  it('defaults to the Vireek look and resets on sign-out', () => {
    expect(getPdfBrand()).toBe(VIREEK_PDF_BRAND);
    setPdfBrand(buildPdfBrand({ businessName: 'Acme', settings: settings(false), whiteLabel: true, logo: null }));
    setPdfBrand(null);
    expect(getPdfBrand()).toBe(VIREEK_PDF_BRAND);
  });

  it('entitled + badge off → no Vireek string in any field', () => {
    const b = buildPdfBrand({ businessName: 'Acme HVAC', settings: settings(false), whiteLabel: true, logo: null });
    expect(findVendorLeaks(JSON.stringify(b))).toEqual([]);
    expect(b.attribution).toBeNull();
    expect(b.wordmark).toBe('Acme HVAC');
    expect(b.primary).toEqual([21, 128, 61]);
  });

  it('not entitled → attribution stays even if the stored switch is off', () => {
    const b = buildPdfBrand({ businessName: 'Acme', settings: settings(false), whiteLabel: false, logo: null });
    expect(b.attribution).toBe('Generated with Vireek');
  });

  it('no business name and no badge never falls back to "Vireek"', () => {
    const b = buildPdfBrand({ businessName: null, settings: settings(false), whiteLabel: true, logo: null });
    expect(findVendorLeaks(JSON.stringify(b))).toEqual([]);
  });
});
