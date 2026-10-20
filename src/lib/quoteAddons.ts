/**
 * Optional quote line items ("add-ons") — shared domain logic.
 * Server counterpart: supabase/migrations/20271020000000_quote_optional_items.sql
 * `addonTotals()` mirrors `accept_quote_with_addons_by_token()` exactly
 * (tax is applied to the add-on subtotal and rounded once).
 */

import { supabase } from '@/lib/supabase';

export interface QuoteOptionalItem {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  /** Empty = offered with every option. */
  option_ids: string[];
  /** Optional inventory part — becomes a job_parts_required row. Never sent to customers. */
  part_id?: string | null;
}

export type PublicQuoteAddon = Omit<QuoteOptionalItem, 'part_id'>;

export interface AddonTotals {
  count: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export type AcceptWithAddonsResult =
  | { ok: true; addonsTotalCents: number; totalCents: number }
  | { ok: false; reason: 'invalid_items' | 'unavailable' | 'error' };

export const MAX_OPTIONAL_ITEMS = 12;
export const MAX_ADDON_QUANTITY = 99;
export const MAX_ADDON_PRICE_CENTS = 10_000_000;

export const ADDON_SUGGESTIONS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'Extended warranty', description: 'Extra coverage for parts and labour beyond the standard warranty.' },
  { name: 'Filter upgrade', description: 'Higher-grade filter for better air quality and longer service life.' },
  { name: 'Surge protector', description: 'Protects the new equipment from power surges and spikes.' },
];

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createOptionalItem(seed: Partial<Pick<QuoteOptionalItem, 'name' | 'description'>> = {}): QuoteOptionalItem {
  return {
    id: newId(),
    name: seed.name ?? '',
    description: seed.description ?? '',
    quantity: 1,
    unit_price_cents: 0,
    option_ids: [],
    part_id: null,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normaliseOptionalItems(raw: unknown): QuoteOptionalItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QuoteOptionalItem[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 120) : '';
    if (!name) continue;

    let id = typeof e.id === 'string' && e.id.trim() ? e.id.trim().slice(0, 64) : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);

    out.push({
      id,
      name,
      description: typeof e.description === 'string' ? e.description.trim().slice(0, 400) : '',
      quantity: clampInt(e.quantity, 1, MAX_ADDON_QUANTITY, 1),
      unit_price_cents: clampInt(e.unit_price_cents, 0, MAX_ADDON_PRICE_CENTS, 0),
      option_ids: Array.isArray(e.option_ids)
        ? Array.from(new Set(e.option_ids.filter((o): o is string => typeof o === 'string' && o.length > 0)))
        : [],
      part_id: typeof e.part_id === 'string' && e.part_id ? e.part_id : null,
    });

    if (out.length >= MAX_OPTIONAL_ITEMS) break;
  }
  return out;
}

export function parsePublicAddons(raw: unknown): PublicQuoteAddon[] {
  return normaliseOptionalItems(raw).map(({ part_id: _partId, ...rest }) => rest);
}

export function validateOptionalItems(items: QuoteOptionalItem[], optionIds: string[]): string[] {
  const errors: string[] = [];
  const filled = items.filter((i) => i.name.trim());
  const known = new Set(optionIds);

  if (filled.length > MAX_OPTIONAL_ITEMS) errors.push(`Add-ons are limited to ${MAX_OPTIONAL_ITEMS} per quote.`);

  filled.forEach((item, idx) => {
    const label = item.name.trim() || `Add-on ${idx + 1}`;
    if (!Number.isFinite(item.unit_price_cents) || item.unit_price_cents <= 0) {
      errors.push(`"${label}" needs a price above $0 — a free add-on is just part of the job.`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ADDON_QUANTITY) {
      errors.push(`"${label}" needs a quantity between 1 and ${MAX_ADDON_QUANTITY}.`);
    }
    if (item.option_ids.some((id) => !known.has(id))) {
      errors.push(`"${label}" is limited to an option that no longer exists — pick the options it applies to.`);
    }
  });

  return errors;
}

export function addonsForOption(addons: PublicQuoteAddon[], optionId: string | null): PublicQuoteAddon[] {
  return addons.filter((a) => a.option_ids.length === 0 || (optionId !== null && a.option_ids.includes(optionId)));
}

export function reconcileSelection(selectedIds: readonly string[], available: PublicQuoteAddon[]): string[] {
  const wanted = new Set(selectedIds);
  return available.filter((a) => wanted.has(a.id)).map((a) => a.id);
}

export function addonLineCents(addon: Pick<PublicQuoteAddon, 'quantity' | 'unit_price_cents'>): number {
  return Math.max(0, addon.quantity || 0) * Math.max(0, addon.unit_price_cents || 0);
}

export function addonTotals(
  available: PublicQuoteAddon[],
  selectedIds: readonly string[],
  taxPercent: number
): AddonTotals {
  const chosen = new Set(selectedIds);
  const picked = available.filter((a) => chosen.has(a.id));
  const subtotalCents = picked.reduce((sum, a) => sum + addonLineCents(a), 0);
  const taxCents = Math.round((subtotalCents * (taxPercent || 0)) / 100);
  return { count: picked.length, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function grandTotalCents(baseTotalCents: number, addons: AddonTotals): number {
  return baseTotalCents + addons.totalCents;
}

/** Never throws: a missing RPC (migration not applied) or network error simply means "no add-ons". */
export async function fetchQuoteAddons(token: string): Promise<PublicQuoteAddon[]> {
  try {
    const { data, error } = await supabase.rpc('get_quote_optional_items_for_token', { p_token: token });
    if (error) return [];
    return parsePublicAddons(data);
  } catch {
    return [];
  }
}

export async function acceptQuoteWithAddons(
  token: string,
  optionId: string | null,
  itemIds: readonly string[]
): Promise<AcceptWithAddonsResult> {
  try {
    const { data, error } = await supabase.rpc('accept_quote_with_addons_by_token', {
      p_token: token,
      p_option_id: optionId,
      p_item_ids: Array.from(new Set(itemIds)),
    });
    if (error || !data || typeof data !== 'object') return { ok: false, reason: 'error' };

    const r = data as { accepted?: boolean; reason?: string; addons_total_cents?: number; total_cents?: number };
    if (r.accepted) {
      return { ok: true, addonsTotalCents: Number(r.addons_total_cents) || 0, totalCents: Number(r.total_cents) || 0 };
    }
    return { ok: false, reason: r.reason === 'invalid_items' ? 'invalid_items' : 'unavailable' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

export function acceptErrorMessage(reason: 'invalid_items' | 'unavailable' | 'error'): string {
  switch (reason) {
    case 'invalid_items':
      return 'One of the add-ons you chose is no longer available. Please review your selection and try again.';
    case 'unavailable':
      return 'This quote can no longer be accepted — it may have already been answered or expired.';
    default:
      return 'Something went wrong sending your response. Please try again.';
  }
}
