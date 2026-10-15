/*
  # Service Areas (zip / polygon zones)

  ## What this adds
  - `service_areas`: named zones defined by ZIP/postal codes OR a polygon
    (array of [lat, lng] pairs). Each zone carries a flat travel fee, an
    optional time-boxed surge multiplier, a priority (overlap tie-break) and
    an active flag. This is deliberately a NEW table: the existing
    `territories` table (circular zones used by Advanced Routing's balance
    view) is untouched.
  - `service_area_technicians`: which technicians cover which zone
    (many-to-many, with an `is_primary` flag used as the first-choice
    tie-break by the AI dispatcher).
  - `service_area_settings`: one row per account — what the AI receptionist
    does when a caller is OUTSIDE every active zone (decline / waitlist /
    transfer) and the exact message it should use.
  - `can_manage_service_areas()`: server-side permission gate for writes
    (owner, admin, or anyone with `can_manage_team`, including via a custom
    role). The UI gate is a convenience; this is the real enforcement.

  ## Security
  RLS on every table is scoped with `public.get_account_owner_id()` — the same
  boundary as every other tenant table. A team member's own auth.uid() is
  never used as the tenant key. Writes additionally require
  `can_manage_service_areas()`. Cross-tenant references (a technician or area
  from another account) are rejected in the WITH CHECK clauses.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_service_areas()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.invite_status = 'active'
        AND (
          tm.role = 'admin'
          OR COALESCE((tm.permissions ->> 'can_manage_team')::boolean, false)
          OR COALESCE((cr.permissions ->> 'can_manage_team')::boolean, false)
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_service_areas() TO authenticated;

-- =============================================================
-- SERVICE AREAS
-- =============================================================

CREATE TABLE IF NOT EXISTS service_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT '#3b82f6' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  zone_type text NOT NULL CHECK (zone_type IN ('zip', 'polygon')),
  zip_codes text[] NOT NULL DEFAULT '{}',
  polygon jsonb,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 1000),
  travel_fee_cents integer NOT NULL DEFAULT 0 CHECK (travel_fee_cents BETWEEN 0 AND 1000000),
  surge_enabled boolean NOT NULL DEFAULT false,
  surge_multiplier numeric(4,2) NOT NULL DEFAULT 1.00 CHECK (surge_multiplier BETWEEN 1.00 AND 5.00),
  surge_ends_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_areas_zip_has_codes
    CHECK (zone_type <> 'zip' OR cardinality(zip_codes) BETWEEN 1 AND 2000),
  CONSTRAINT service_areas_polygon_has_points
    CHECK (
      zone_type <> 'polygon'
      OR (polygon IS NOT NULL AND jsonb_typeof(polygon) = 'array' AND jsonb_array_length(polygon) BETWEEN 3 AND 500)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_areas_user_name ON service_areas (user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_service_areas_user_active ON service_areas (user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_service_areas_zip_codes ON service_areas USING gin (zip_codes);

DROP TRIGGER IF EXISTS trg_service_areas_updated_at ON service_areas;
CREATE TRIGGER trg_service_areas_updated_at
  BEFORE UPDATE ON service_areas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE service_areas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_service_areas" ON service_areas;
CREATE POLICY "select_service_areas" ON service_areas
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_service_areas" ON service_areas;
CREATE POLICY "insert_service_areas" ON service_areas
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

DROP POLICY IF EXISTS "update_service_areas" ON service_areas;
CREATE POLICY "update_service_areas" ON service_areas
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_service_areas())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

DROP POLICY IF EXISTS "delete_service_areas" ON service_areas;
CREATE POLICY "delete_service_areas" ON service_areas
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

-- =============================================================
-- TECHNICIAN ASSIGNMENT (many-to-many)
-- =============================================================

CREATE TABLE IF NOT EXISTS service_area_technicians (
  area_id uuid NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, technician_id)
);

CREATE INDEX IF NOT EXISTS idx_sat_user ON service_area_technicians (user_id);
CREATE INDEX IF NOT EXISTS idx_sat_technician ON service_area_technicians (technician_id);

ALTER TABLE service_area_technicians ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_service_area_technicians" ON service_area_technicians;
CREATE POLICY "select_service_area_technicians" ON service_area_technicians
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_service_area_technicians" ON service_area_technicians;
CREATE POLICY "insert_service_area_technicians" ON service_area_technicians
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.can_manage_service_areas()
    AND EXISTS (SELECT 1 FROM service_areas a WHERE a.id = service_area_technicians.area_id AND a.user_id = service_area_technicians.user_id)
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = service_area_technicians.technician_id AND tm.account_owner_id = service_area_technicians.user_id)
  );

DROP POLICY IF EXISTS "update_service_area_technicians" ON service_area_technicians;
CREATE POLICY "update_service_area_technicians" ON service_area_technicians
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_service_areas())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

DROP POLICY IF EXISTS "delete_service_area_technicians" ON service_area_technicians;
CREATE POLICY "delete_service_area_technicians" ON service_area_technicians
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

-- =============================================================
-- OUT-OF-AREA SETTINGS (one row per account)
-- =============================================================

CREATE TABLE IF NOT EXISTS service_area_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  out_of_area_mode text NOT NULL DEFAULT 'waitlist' CHECK (out_of_area_mode IN ('decline', 'waitlist', 'transfer')),
  out_of_area_message text CHECK (out_of_area_message IS NULL OR char_length(out_of_area_message) <= 600),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_service_area_settings_updated_at ON service_area_settings;
CREATE TRIGGER trg_service_area_settings_updated_at
  BEFORE UPDATE ON service_area_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE service_area_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_service_area_settings" ON service_area_settings;
CREATE POLICY "select_service_area_settings" ON service_area_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_service_area_settings" ON service_area_settings;
CREATE POLICY "insert_service_area_settings" ON service_area_settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

DROP POLICY IF EXISTS "update_service_area_settings" ON service_area_settings;
CREATE POLICY "update_service_area_settings" ON service_area_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_service_areas())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_service_areas());

COMMENT ON TABLE service_areas IS
  'Zip/postal or polygon service zones with travel fee, surge multiplier and priority. Separate from the circular `territories` table used by Advanced Routing.';
COMMENT ON TABLE service_area_technicians IS
  'Technician coverage per service area; is_primary marks the first-choice technician for AI dispatch.';
COMMENT ON TABLE service_area_settings IS
  'Per-account out-of-area behavior for the AI receptionist (decline / waitlist / transfer + custom message).';
