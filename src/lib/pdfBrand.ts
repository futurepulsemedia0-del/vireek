import { fetchBrandSettings, logoPublicUrl, type BrandSettings } from '@/lib/branding';
import { effectiveShowVireek, fetchBrandEntitlements, hexToRgbTuple } from '@/lib/whiteLabel';

/**
 * Brand used by every tenant-facing PDF. Builders read it synchronously through
 * getPdfBrand(); <PdfBrandSync /> keeps it current for the signed-in account.
 * Default = the original Vireek look, so nothing changes for accounts that never customize.
 */
export type Rgb = [number, number, number];

export interface PdfBrand {
  wordmark: string;
  tagline: string;
  site: string;
  /** "Generated with Vireek" or null when branding is hidden. */
  attribution: string | null;
  /** How documents refer to the platform in running text. */
  productName: string;
  primary: Rgb;
  accent: Rgb;
  logo: { dataUrl: string; aspect: number } | null;
  isVireek: boolean;
}

export const VIREEK_PDF_BRAND: PdfBrand = {
  wordmark: 'Vireek',
  tagline: 'AI Voice Receptionist for Home Service Businesses',
  site: 'vireek.com',
  attribution: 'Generated with Vireek',
  productName: 'Vireek',
  primary: [32, 58, 216],
  accent: [214, 88, 42],
  logo: null,
  isVireek: true,
};

export function buildPdfBrand(input: {
  businessName: string | null;
  settings: Pick<BrandSettings, 'primary_color' | 'accent_color' | 'portal_show_powered_by'> | null;
  whiteLabel: boolean;
  logo: PdfBrand['logo'];
}): PdfBrand {
  const { settings } = input;
  if (!settings) return VIREEK_PDF_BRAND;
  const showVireek = effectiveShowVireek(settings.portal_show_powered_by, input.whiteLabel);
  const name = input.businessName?.trim() || '';
  return {
    wordmark: name || (showVireek ? 'Vireek' : 'Your business'),
    tagline: '',
    site: '',
    attribution: showVireek ? 'Generated with Vireek' : null,
    productName: showVireek ? 'Vireek' : 'the platform',
    primary: hexToRgbTuple(settings.primary_color) ?? VIREEK_PDF_BRAND.primary,
    accent: hexToRgbTuple(settings.accent_color) ?? VIREEK_PDF_BRAND.accent,
    logo: input.logo,
    isVireek: false,
  };
}

/** jsPDF can't embed WebP, so every logo is re-encoded as PNG through a canvas. */
async function loadLogo(url: string): Promise<PdfBrand['logo']> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const scale = Math.min(1, 600 / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return { dataUrl: canvas.toDataURL('image/png'), aspect: w / h };
  } catch {
    return null;
  }
}

export async function loadPdfBrand(ownerId: string, fallbackName: string | null): Promise<PdfBrand> {
  try {
    const [settings, ent] = await Promise.all([fetchBrandSettings(ownerId), fetchBrandEntitlements()]);
    if (!settings) return VIREEK_PDF_BRAND;
    const url = logoPublicUrl(settings.logo_path);
    const logo = url ? await loadLogo(url) : null;
    return buildPdfBrand({
      businessName: ent.business_name ?? fallbackName,
      settings,
      whiteLabel: ent.known ? ent.white_label : false, // unknown → fail closed: keep attribution
      logo,
    });
  } catch {
    return VIREEK_PDF_BRAND;
  }
}

let active: PdfBrand = VIREEK_PDF_BRAND;
export const getPdfBrand = (): PdfBrand => active;
export const setPdfBrand = (brand: PdfBrand | null): void => {
  active = brand ?? VIREEK_PDF_BRAND;
};

export const BRAND_CHANGED_EVENT = 'brand:changed';
export const notifyBrandChanged = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BRAND_CHANGED_EVENT));
};
