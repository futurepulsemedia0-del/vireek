/**
 * Vireek Service Catalog — data access.
 * Every call is scoped to the ACCOUNT OWNER's id (`ownerId`), never the
 * logged-in user's own id. Inserts never send `user_id` (DB default).
 */

import { supabase } from '@/lib/supabase';
import {
  CATEGORY_COLUMNS,
  ITEM_COLUMNS,
  normalizeCatalogCategory,
  normalizeCatalogItem,
  type CatalogCategory,
  type CatalogItem,
  type CatalogItemPayload,
} from '@/lib/serviceCatalog';

const ITEMS = 'service_catalog_items';
const CATEGORIES = 'service_catalog_categories';
const MAX_ROWS = 2000;
/** RLS filters rows silently: a delete that matched nothing means "no access or already gone". */
const NOT_AFFECTED = { code: 'PGRST116', message: 'No rows affected' };

export async function fetchCatalog(ownerId: string): Promise<{ categories: CatalogCategory[]; items: CatalogItem[] }> {
  const [cats, items] = await Promise.all([
    supabase.from(CATEGORIES).select(CATEGORY_COLUMNS).eq('user_id', ownerId).order('sort_order').order('name').limit(200),
    supabase.from(ITEMS).select(ITEM_COLUMNS).eq('user_id', ownerId).order('sort_order').order('name').limit(MAX_ROWS),
  ]);
  if (cats.error) throw cats.error;
  if (items.error) throw items.error;
  return {
    categories: ((cats.data as Record<string, unknown>[] | null) ?? []).map(normalizeCatalogCategory),
    items: ((items.data as Record<string, unknown>[] | null) ?? []).map(normalizeCatalogItem),
  };
}

export async function createItem(payload: CatalogItemPayload): Promise<CatalogItem> {
  const { data, error } = await supabase.from(ITEMS).insert(payload).select(ITEM_COLUMNS).single();
  if (error) throw error;
  return normalizeCatalogItem(data as Record<string, unknown>);
}

export async function updateItem(ownerId: string, id: string, payload: CatalogItemPayload): Promise<CatalogItem> {
  const { data, error } = await supabase
    .from(ITEMS)
    .update(payload)
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(ITEM_COLUMNS)
    .single();
  if (error) throw error;
  return normalizeCatalogItem(data as Record<string, unknown>);
}

export async function setItemBookable(ownerId: string, id: string, bookable: boolean): Promise<void> {
  const { error } = await supabase.from(ITEMS).update({ bookable }).eq('id', id).eq('user_id', ownerId).select('id').single();
  if (error) throw error;
}

export async function deleteItem(ownerId: string, id: string): Promise<void> {
  const { data, error } = await supabase.from(ITEMS).delete().eq('id', id).eq('user_id', ownerId).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw NOT_AFFECTED;
}

export async function createCategory(name: string): Promise<CatalogCategory> {
  const { data, error } = await supabase.from(CATEGORIES).insert({ name: name.trim() }).select(CATEGORY_COLUMNS).single();
  if (error) throw error;
  return normalizeCatalogCategory(data as Record<string, unknown>);
}

export async function renameCategory(ownerId: string, id: string, name: string): Promise<CatalogCategory> {
  const { data, error } = await supabase
    .from(CATEGORIES)
    .update({ name: name.trim() })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(CATEGORY_COLUMNS)
    .single();
  if (error) throw error;
  return normalizeCatalogCategory(data as Record<string, unknown>);
}

/** Services in the category are kept and become uncategorized (ON DELETE SET NULL). */
export async function deleteCategory(ownerId: string, id: string): Promise<void> {
  const { data, error } = await supabase.from(CATEGORIES).delete().eq('id', id).eq('user_id', ownerId).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw NOT_AFFECTED;
}
