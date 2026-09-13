import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { NormalizedPriceItem } from "./types.ts";

export async function upsertPriceBookItems(
  admin: SupabaseClient,
  userId: string,
  source: "service_titan" | "jobber",
  items: NormalizedPriceItem[],
): Promise<{ synced: number; error?: string }> {
  if (items.length === 0) return { synced: 0 };

  const nowIso = new Date().toISOString();
  const rows = items.map((item) => ({
    user_id: userId,
    source,
    external_id: item.external_id,
    service_name: item.service_name,
    category: item.category,
    pricing_model: "flat",
    price_cents: item.price_cents,
    active: item.active,
    synced_at: nowIso,
  }));

  const { error } = await admin.from("price_book_items").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) return { synced: 0, error: error.message };
  return { synced: rows.length };
}
