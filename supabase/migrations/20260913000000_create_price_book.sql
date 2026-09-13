/*
  # Live Price Book (feature 45)

  - price_book_items: per-tenant service/price list the AI receptionist
    quotes from during live calls via the `lookup_price` Vapi tool
    (see supabase/functions/vapi-webhook/index.ts) and that the business
    manages from /dashboard/price-book.
  - RLS scoped to auth.uid(), same pattern as membership_plans.
  - keywords[] lets a business map how customers actually say a service
    ("clogged drain") to the catalog entry ("Drain Cleaning") so the voice
    tool can match loosely, not just on the exact service name.
*/

CREATE TABLE IF NOT EXISTS price_book_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  service_name text NOT NULL,
  category text,
  pricing_model text NOT NULL DEFAULT 'flat'
    CHECK (pricing_model IN ('flat', 'starting_at', 'range', 'hourly')),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  price_max_cents integer CHECK (price_max_cents IS NULL OR price_max_cents >= price_cents),
  unit_label text,
  keywords text[] NOT NULL DEFAULT '{}',
  description text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_book_items_user_id ON price_book_items(user_id);
CREATE INDEX IF NOT EXISTS idx_price_book_items_user_active ON price_book_items(user_id, active);

ALTER TABLE price_book_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_price_book_items" ON price_book_items;
CREATE POLICY "select_own_price_book_items" ON price_book_items FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_price_book_items" ON price_book_items;
CREATE POLICY "insert_own_price_book_items" ON price_book_items FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_price_book_items" ON price_book_items;
CREATE POLICY "update_own_price_book_items" ON price_book_items FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_price_book_items" ON price_book_items;
CREATE POLICY "delete_own_price_book_items" ON price_book_items FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION set_price_book_items_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_price_book_items_updated_at ON price_book_items;
CREATE TRIGGER trg_price_book_items_updated_at
  BEFORE UPDATE ON price_book_items
  FOR EACH ROW EXECUTE FUNCTION set_price_book_items_updated_at();
