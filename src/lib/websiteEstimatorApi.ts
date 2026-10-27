/**
 * Price-estimator widget — API layer. Reads the account's price book so the owner can choose which services to publish.
 * Scoped by account_owner_id (RLS enforces it again server-side). Cost basis / margin / tax columns are never selected.
 */

import { supabase } from '@/lib/supabase';
import type { CatalogItem } from '@/lib/websiteEstimator';

const COLUMNS = 'id, service_name, category, pricing_model, price_cents, price_max_cents, unit_label, description, active';

/** Every price-book service of the account (active and inactive), in the price book's own order. */
export async function fetchPriceBookCatalog(accountOwnerId: string): Promise<CatalogItem[]> {
  const { data, error } = await supabase
    .from('price_book_items')
    .select(COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('sort_order', { ascending: true })
    .order('service_name', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as CatalogItem[]).map((c) => ({ ...c, id: String(c.id).toLowerCase() }));
}
