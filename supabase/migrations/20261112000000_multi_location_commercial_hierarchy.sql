/*
  # Multi-Location Commercial Hierarchy

  ## Why
  A commercial customer (customer_type = 'commercial' on `customers`) is
  often not one address — it's a portfolio: a hospital network, a property
  management company, a restaurant group. Today `customers.address` is a
  single free-text field and `equipment.customer_id` is flat, so there is
  no way to say "this rooftop unit is on the 3rd floor of Building B at
  the Downtown Medical Plaza site" or to dispatch a job to the correct
  physical location within a multi-site account.

  ## What this does
  Adds a 4-level physical hierarchy under an existing `customers` row:

    customers (account)
      -> customer_sites        (a physical address/campus)
        -> customer_site_buildings
          -> customer_site_floors
            -> customer_site_rooms

  `equipment` (the existing "asset" table) gets a nullable `room_id` so an
  asset can optionally be pinned to an exact room without breaking any
  existing equipment row (everything stays valid with room_id = NULL,
  i.e. "not yet located"). `jobs` gets a nullable `site_id` so dispatch
  can record/filter which site of a multi-site account a job is for.

  This is purely additive — no existing column is renamed, retyped, or
  made required, and no existing row needs backfilling to keep working.

  ## RLS
  Same idiom as `equipment`/`customers`: every table carries its own
  `user_id` (defaulting to auth.uid()), and every policy checks it against
  `public.get_account_owner_id()` so team members (not just the owner)
  can manage locations on the account they belong to. Deleting higher
  levels cascades down (delete a site -> its buildings/floors/rooms go
  too); deleting a room just detaches equipment (room_id -> NULL), it
  never deletes the asset itself.

  ## Read helper
  `get_customer_site_hierarchy(p_customer_id)` returns the whole tree
  (sites -> buildings -> floors -> rooms, with each room's asset count)
  as one JSON document in a single round trip, instead of the client
  waterfalling 4 separate queries plus N asset-count queries.
*/

-- =============================================================
-- CUSTOMER_SITES  (a physical address / campus under an account)
-- =============================================================

CREATE TABLE IF NOT EXISTS customer_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name text NOT NULL,
  site_type text NOT NULL DEFAULT 'other'
    CHECK (site_type IN ('office', 'retail', 'medical', 'industrial', 'residential_complex', 'hospitality', 'education', 'other')),
  address text,
  city text,
  state text,
  postal_code text,
  is_primary boolean NOT NULL DEFAULT false,
  site_contact_name text,
  site_contact_phone text,
  access_notes text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_sites_user_id ON customer_sites(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_sites_customer_id ON customer_sites(customer_id);

-- Only one primary site per customer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_sites_one_primary
  ON customer_sites(customer_id) WHERE is_primary = true;

ALTER TABLE customer_sites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_customer_sites" ON customer_sites;
CREATE POLICY "select_own_customer_sites" ON customer_sites FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_customer_sites" ON customer_sites;
CREATE POLICY "insert_own_customer_sites" ON customer_sites FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_customer_sites" ON customer_sites;
CREATE POLICY "update_own_customer_sites" ON customer_sites FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_customer_sites" ON customer_sites;
CREATE POLICY "delete_own_customer_sites" ON customer_sites FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- CUSTOMER_SITE_BUILDINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS customer_site_buildings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  site_id uuid NOT NULL REFERENCES customer_sites(id) ON DELETE CASCADE,
  name text NOT NULL,
  building_code text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_buildings_user_id ON customer_site_buildings(user_id);
CREATE INDEX IF NOT EXISTS idx_site_buildings_site_id ON customer_site_buildings(site_id);

ALTER TABLE customer_site_buildings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_site_buildings" ON customer_site_buildings;
CREATE POLICY "select_own_site_buildings" ON customer_site_buildings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_site_buildings" ON customer_site_buildings;
CREATE POLICY "insert_own_site_buildings" ON customer_site_buildings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_site_buildings" ON customer_site_buildings;
CREATE POLICY "update_own_site_buildings" ON customer_site_buildings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_site_buildings" ON customer_site_buildings;
CREATE POLICY "delete_own_site_buildings" ON customer_site_buildings FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- CUSTOMER_SITE_FLOORS
-- =============================================================

CREATE TABLE IF NOT EXISTS customer_site_floors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  building_id uuid NOT NULL REFERENCES customer_site_buildings(id) ON DELETE CASCADE,
  name text NOT NULL,
  floor_number integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_floors_user_id ON customer_site_floors(user_id);
CREATE INDEX IF NOT EXISTS idx_site_floors_building_id ON customer_site_floors(building_id);

ALTER TABLE customer_site_floors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_site_floors" ON customer_site_floors;
CREATE POLICY "select_own_site_floors" ON customer_site_floors FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_site_floors" ON customer_site_floors;
CREATE POLICY "insert_own_site_floors" ON customer_site_floors FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_site_floors" ON customer_site_floors;
CREATE POLICY "update_own_site_floors" ON customer_site_floors FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_site_floors" ON customer_site_floors;
CREATE POLICY "delete_own_site_floors" ON customer_site_floors FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- CUSTOMER_SITE_ROOMS
-- =============================================================

CREATE TABLE IF NOT EXISTS customer_site_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  floor_id uuid NOT NULL REFERENCES customer_site_floors(id) ON DELETE CASCADE,
  name text NOT NULL,
  room_type text NOT NULL DEFAULT 'other'
    CHECK (room_type IN ('mechanical', 'office', 'storage', 'common_area', 'restroom', 'kitchen', 'server_room', 'rooftop', 'other')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_rooms_user_id ON customer_site_rooms(user_id);
CREATE INDEX IF NOT EXISTS idx_site_rooms_floor_id ON customer_site_rooms(floor_id);

ALTER TABLE customer_site_rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_site_rooms" ON customer_site_rooms;
CREATE POLICY "select_own_site_rooms" ON customer_site_rooms FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_site_rooms" ON customer_site_rooms;
CREATE POLICY "insert_own_site_rooms" ON customer_site_rooms FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_site_rooms" ON customer_site_rooms;
CREATE POLICY "update_own_site_rooms" ON customer_site_rooms FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_site_rooms" ON customer_site_rooms;
CREATE POLICY "delete_own_site_rooms" ON customer_site_rooms FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- LINK EXISTING TABLES INTO THE HIERARCHY (additive, nullable)
-- =============================================================

ALTER TABLE equipment ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES customer_site_rooms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_equipment_room_id ON equipment(room_id);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_site_id ON jobs(site_id);

-- updated_at auto-touch, reusing the existing trigger function
-- (public.update_updated_at, defined in 20260821101135_create_data_tables.sql).
DROP TRIGGER IF EXISTS set_customer_sites_updated_at ON customer_sites;
CREATE TRIGGER set_customer_sites_updated_at BEFORE UPDATE ON customer_sites
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS set_site_buildings_updated_at ON customer_site_buildings;
CREATE TRIGGER set_site_buildings_updated_at BEFORE UPDATE ON customer_site_buildings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS set_site_floors_updated_at ON customer_site_floors;
CREATE TRIGGER set_site_floors_updated_at BEFORE UPDATE ON customer_site_floors
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS set_site_rooms_updated_at ON customer_site_rooms;
CREATE TRIGGER set_site_rooms_updated_at BEFORE UPDATE ON customer_site_rooms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- RPC: get_customer_site_hierarchy
-- Whole tree (sites -> buildings -> floors -> rooms + asset_count per
-- room) for one customer, in a single round trip. SECURITY DEFINER so
-- it can join across the 4 tables in one statement, but it re-checks
-- ownership itself first — never trusts the caller's RLS context blindly.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_customer_site_hierarchy(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = v_owner
  ) THEN
    RAISE EXCEPTION 'Not authorized for this customer';
  END IF;

  SELECT COALESCE(jsonb_agg(site_row ORDER BY (site_row->>'is_primary')::boolean DESC, site_row->>'name'), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'site_type', s.site_type,
      'address', s.address,
      'city', s.city,
      'state', s.state,
      'postal_code', s.postal_code,
      'is_primary', s.is_primary,
      'site_contact_name', s.site_contact_name,
      'site_contact_phone', s.site_contact_phone,
      'access_notes', s.access_notes,
      'notes', s.notes,
      'buildings', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', b.id,
          'name', b.name,
          'building_code', b.building_code,
          'notes', b.notes,
          'floors', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'id', f.id,
              'name', f.name,
              'floor_number', f.floor_number,
              'notes', f.notes,
              'rooms', (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'id', r.id,
                  'name', r.name,
                  'room_type', r.room_type,
                  'notes', r.notes,
                  'asset_count', (SELECT count(*) FROM equipment eq WHERE eq.room_id = r.id)
                ) ORDER BY r.name), '[]'::jsonb)
                FROM customer_site_rooms r WHERE r.floor_id = f.id
              )
            ) ORDER BY f.floor_number NULLS LAST, f.name), '[]'::jsonb)
            FROM customer_site_floors f WHERE f.building_id = b.id
          )
        ) ORDER BY b.name), '[]'::jsonb)
        FROM customer_site_buildings b WHERE b.site_id = s.id
      )
    ) AS site_row
    FROM customer_sites s
    WHERE s.customer_id = p_customer_id
  ) sites;

  RETURN v_result;
END;
$$;
