/**
 * Smart defaults for the onboarding "Services & prices" step. Pure (no I/O): reads the curated trade playbook catalog
 * (src/lib/tradePlaybookCatalog.ts), the same source installTradePlaybook() uses, so what the owner previews is exactly
 * what gets added to their Price Book. Nothing here invents prices.
 */
import { getTradePlaybook, type TradeSlug } from '@/lib/tradePlaybookCatalog';

export const SUPPORTED_TRADES: readonly TradeSlug[] = ['hvac', 'plumbing', 'electrical'];

/** Industry value (INDUSTRY_OPTIONS in onboarding/types.ts) → playbook slug; null when no curated playbook exists. */
export function tradeSlugFor(industry: string | null | undefined): TradeSlug | null {
  const v = (industry ?? '').trim().toLowerCase();
  return (SUPPORTED_TRADES as readonly string[]).includes(v) ? (v as TradeSlug) : null;
}

export const PRICE_LEVELS = [
  { value: 0.85, label: 'Below typical' },
  { value: 1, label: 'Typical' },
  { value: 1.2, label: 'Above typical' },
  { value: 1.5, label: 'Premium' },
] as const;
export const DEFAULT_PRICE_LEVEL = 1;

export interface SeedPreview { serviceName: string; category: string; priceCents: number; priceMaxCents: number | null }

/** Same rounding as installTradePlaybook(): scaled, then rounded to whole dollars. */
const scale = (cents: number, mult: number) => Math.round((cents * mult) / 100) * 100;

export function previewSeeds(slug: TradeSlug | null, multiplier: number): SeedPreview[] {
  const playbook = getTradePlaybook(slug);
  if (!playbook) return [];
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : DEFAULT_PRICE_LEVEL;
  return playbook.jobTypes.map((jt) => ({
    serviceName: jt.price.serviceName,
    category: jt.price.category,
    priceCents: scale(jt.price.priceCents, m),
    priceMaxCents: jt.price.priceMaxCents === undefined ? null : scale(jt.price.priceMaxCents, m),
  }));
}

export function formatSeedPrice(s: Pick<SeedPreview, 'priceCents' | 'priceMaxCents'>): string {
  const usd = (c: number) => `$${(c / 100).toLocaleString('en-US')}`;
  return s.priceMaxCents && s.priceMaxCents > s.priceCents ? `${usd(s.priceCents)}–${usd(s.priceMaxCents)}` : usd(s.priceCents);
}

/** Short service names for business_profile.services_offered (what the AI says it offers). */
export function defaultServiceNames(slug: TradeSlug | null): string[] {
  return getTradePlaybook(slug)?.jobTypes.map((jt) => jt.label) ?? [];
}

export const DEFAULT_HOURS: Record<string, { open: string; close: string }> = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, { open: '08:00', close: '17:00' }]),
);
