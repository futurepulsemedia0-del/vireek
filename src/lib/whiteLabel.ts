import { supabase } from '@/lib/supabase';

/**
 * White-label entitlement + helpers shared by the portal, PDFs and Branding page.
 * The plan list MUST match public.brand_plan_is_white_label() (SQL) and
 * supabase/functions/_shared/branding/brand.ts.
 */
export const WHITE_LABEL_PLANS: readonly string[] = ['business', 'enterprise'];
export const WHITE_LABEL_PLAN_LABEL = 'Business';

export function planAllowsWhiteLabel(plan: string | null | undefined): boolean {
  return typeof plan === 'string' && WHITE_LABEL_PLANS.includes(plan);
}

/** Stored switch OR not entitled → Vireek branding must be shown. */
export function effectiveShowVireek(stored: boolean, whiteLabelAllowed: boolean): boolean {
  return stored || !whiteLabelAllowed;
}

export interface BrandEntitlements {
  plan: string | null;
  white_label: boolean;
  business_name: string | null;
  /** false = the lookup failed. */
  known: boolean;
}

const UNKNOWN: BrandEntitlements = { plan: null, white_label: true, business_name: null, known: false };

/**
 * UI only: fails OPEN so a network blip never locks the form. The database
 * trigger is what actually enforces the plan. Surfaces that RENDER branding
 * (PDFs) must treat `known: false` as not entitled.
 */
export async function fetchBrandEntitlements(): Promise<BrandEntitlements> {
  try {
    const { data, error } = await supabase.rpc('get_brand_entitlements');
    if (error || !data || typeof data !== 'object') return UNKNOWN;
    const d = data as { plan?: string | null; white_label?: boolean; business_name?: string | null };
    return {
      plan: d.plan ?? null,
      white_label: d.white_label === true,
      business_name: d.business_name ?? null,
      known: true,
    };
  } catch {
    return UNKNOWN;
  }
}

/** Public customer-facing routes: they must keep working on a customer's own domain. */
export const CUSTOMER_ROUTE_PREFIXES = [
  '/portal/',
  '/review/',
  '/reschedule/',
  '/track/',
  '/book/',
  '/pay/',
  '/pay-share/',
  '/pay-result',
  '/quote/',
  '/sign/',
  '/invoice/',
] as const;

export function isCustomerRoute(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return CUSTOMER_ROUTE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function hexToRgbTuple(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Tailwind colors in this app are "R G B" triplets (rgb(var(--accent-primary) / <alpha>)). */
export function hexToTriplet(hex: string): string | null {
  const t = hexToRgbTuple(hex);
  return t ? t.join(' ') : null;
}

export function tailwindBrandVars(primary: string, accent: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const p = hexToTriplet(primary);
  const a = hexToTriplet(accent);
  if (p) vars['--accent-primary'] = p;
  if (a) vars['--accent-secondary'] = a;
  return vars;
}

export function portalDocumentTitle(businessName: string | null | undefined): string {
  const n = businessName?.trim();
  return n ? `${n} · Customer portal` : 'Customer portal';
}

/** Returns every match of the vendor name — used by the leak tests. */
export function findVendorLeaks(text: string): string[] {
  return text.match(/vireek/gi) ?? [];
}
