/*
  # Business Locations, Brands & Organization Switcher

  ## Why
  A growing service business is rarely one storefront: it is several branches, sometimes under
  several brands (e.g. "Acme HVAC" + "Acme Plumbing"), each with its own phone line, timezone,
  hours, tax rate and after-hours call handling. Until now the whole account was one flat unit.

  This is NOT the same as `customer_sites` (20261112000000): that models the physical sites of a
  *customer*. These tables model the *business's own* branches.

  ## Model
    business_brands        - optional brand umbrella (name, website, brand color)
    business_locations     - a branch: address, timezone, currency, tax, hours, call handling, status
    location_members       - which team members work at which location (+ manager flag)
    location_preferences   - each user's currently selected ("active") location (organization switcher)

  Purely additive: no existing table or column is touched, nothing needs backfilling.

  ## Security (same idiom as the rest of the schema)
  - Every row carries `user_id` = the ACCOUNT OWNER id (`public.get_account_owner_id()`), so owner
    and team members share one tenant. Reads: any member of the account.
  - Writes: only the owner or a member with `can_edit_business_profile` (directly or via a custom
    role) - `public.can_manage_business_locations()`.
  - Foreign ids are ownership-checked inside the policies (a brand/member from another account can
    never be attached).
  - `location_preferences` is strictly per-user (`user_id = auth.uid()`).

  ## Server-enforced rules (not just UI)
  - The first non-archived location becomes primary automatically; exactly one primary at a time.
  - The primary location can only change through `set_primary_location()` (atomic swap).
  - The primary location cannot be archived; only ARCHIVED locations can be deleted.
  - Location codes are unique per account (case-insensitive); brand names too.
  - Every create/update/archive/restore/primary-change/delete is written to `audit_log`.
*/

-- =============================================================
-- PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_business_locations()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND (tm.user_id = auth.uid()
             OR tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()))
        AND (
          COALESCE(tm.permissions ->> 'can_edit_business_profile', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_edit_business_profile', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_business_locations() TO authenticated;

-- =============================================================
-- BUSINESS_BRANDS
-- =============================================================

CREATE TABLE IF NOT EXISTS business_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  website_url text CHECK (website_url IS NULL OR website_url ~* '^https?://\S+$'),
  primary_color text CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_brands_user_id ON business_brands(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_brands_name_unique
  ON business_brands(user_id, lower(btrim(name)));

-- =============================================================
-- BUSINESS_LOCATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS business_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  brand_id uuid REFERENCES business_brands(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  code text CHECK (code IS NULL OR code ~ '^[A-Za-z0-9_-]{1,20}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  is_primary boolean NOT NULL DEFAULT false,
  phone text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()\-.]{7,20}$'),
  email text CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text NOT NULL DEFAULT 'US' CHECK (country ~ '^[A-Z]{2}$'),
  timezone text NOT NULL DEFAULT 'America/New_York' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_percent numeric(6,3) NOT NULL DEFAULT 0 CHECK (tax_rate_percent BETWEEN 0 AND 30),
  service_radius_miles integer CHECK (service_radius_miles IS NULL OR service_radius_miles BETWEEN 0 AND 500),
  business_hours jsonb NOT NULL DEFAULT '{
    "mon":{"closed":false,"open":"08:00","close":"17:00"},
    "tue":{"closed":false,"open":"08:00","close":"17:00"},
    "wed":{"closed":false,"open":"08:00","close":"17:00"},
    "thu":{"closed":false,"open":"08:00","close":"17:00"},
    "fri":{"closed":false,"open":"08:00","close":"17:00"},
    "sat":{"closed":true,"open":"08:00","close":"17:00"},
    "sun":{"closed":true,"open":"08:00","close":"17:00"}
  }'::jsonb CHECK (jsonb_typeof(business_hours) = 'object'),
  booking_enabled boolean NOT NULL DEFAULT true,
  after_hours_mode text NOT NULL DEFAULT 'ai_answer' CHECK (after_hours_mode IN ('ai_answer', 'voicemail', 'forward')),
  forwarding_number text CHECK (forwarding_number IS NULL OR forwarding_number ~ '^\+?[0-9 ()\-.]{7,20}$'),
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_locations_forward_needs_number
    CHECK (after_hours_mode <> 'forward' OR forwarding_number IS NOT NULL),
  CONSTRAINT business_locations_primary_not_archived
    CHECK (NOT (is_primary AND status = 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_business_locations_user_status ON business_locations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_business_locations_brand_id ON business_locations(brand_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_locations_one_primary
  ON business_locations(user_id) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_locations_code_unique
  ON business_locations(user_id, lower(code)) WHERE code IS NOT NULL;

-- =============================================================
-- LOCATION_MEMBERS
-- =============================================================

CREATE TABLE IF NOT EXISTS location_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  location_id uuid NOT NULL REFERENCES business_locations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  is_manager boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_location_members_user_id ON location_members(user_id);
CREATE INDEX IF NOT EXISTS idx_location_members_member_id ON location_members(member_id);

-- =============================================================
-- LOCATION_PREFERENCES  (per-user active location = org switcher)
-- =============================================================

CREATE TABLE IF NOT EXISTS location_preferences (
  user_id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  active_location_id uuid REFERENCES business_locations(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- TRIGGERS: guard rules, updated_at, audit
-- =============================================================

CREATE OR REPLACE FUNCTION public.business_brands_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_brands_touch ON business_brands;
CREATE TRIGGER trg_business_brands_touch BEFORE UPDATE ON business_brands
  FOR EACH ROW EXECUTE FUNCTION public.business_brands_touch();

CREATE OR REPLACE FUNCTION public.business_locations_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_swap boolean := COALESCE(current_setting('app.location_primary_swap', true), 'off') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'archived' THEN
      NEW.archived_at := COALESCE(NEW.archived_at, now());
      NEW.is_primary := false;
    ELSIF EXISTS (SELECT 1 FROM public.business_locations l WHERE l.user_id = NEW.user_id AND l.is_primary) THEN
      NEW.is_primary := false;
    ELSE
      NEW.is_primary := true;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A location cannot be moved to another account.';
  END IF;

  IF NEW.is_primary IS DISTINCT FROM OLD.is_primary AND NOT v_swap THEN
    RAISE EXCEPTION 'Use "Make primary" to change the primary location.';
  END IF;

  IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    IF OLD.is_primary THEN
      RAISE EXCEPTION 'Make another location primary before archiving this one.';
    END IF;
    NEW.archived_at := now();
  ELSIF NEW.status <> 'archived' AND OLD.status = 'archived' THEN
    NEW.archived_at := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_locations_guard ON business_locations;
CREATE TRIGGER trg_business_locations_guard BEFORE INSERT OR UPDATE ON business_locations
  FOR EACH ROW EXECUTE FUNCTION public.business_locations_guard();

CREATE OR REPLACE FUNCTION public.business_locations_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_action text;
  v_row public.business_locations;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'location_created'; v_row := NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'location_deleted'; v_row := OLD;
  ELSE
    v_row := NEW;
    IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN v_action := 'location_archived';
    ELSIF OLD.status = 'archived' AND NEW.status <> 'archived' THEN v_action := 'location_restored';
    ELSIF NEW.is_primary AND NOT OLD.is_primary THEN v_action := 'location_primary_changed';
    ELSE v_action := 'location_updated';
    END IF;
  END IF;

  -- An audit hiccup must never block a legitimate save.
  BEGIN
    PERFORM public.log_audit_event(v_row.user_id, v_action, 'business_locations', v_row.id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'business_locations audit failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_locations_audit ON business_locations;
CREATE TRIGGER trg_business_locations_audit AFTER INSERT OR UPDATE OR DELETE ON business_locations
  FOR EACH ROW EXECUTE FUNCTION public.business_locations_audit();

-- =============================================================
-- RPCs (SECURITY INVOKER: RLS still applies; explicit permission check for clear errors)
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_primary_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
BEGIN
  IF NOT public.can_manage_business_locations() THEN
    RAISE EXCEPTION 'You do not have permission to change locations.';
  END IF;
  SELECT status INTO v_status FROM business_locations WHERE id = p_location_id AND user_id = v_owner;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Location not found.'; END IF;
  IF v_status = 'archived' THEN RAISE EXCEPTION 'Restore this location before making it primary.'; END IF;

  PERFORM set_config('app.location_primary_swap', 'on', true);
  UPDATE business_locations SET is_primary = false
    WHERE user_id = v_owner AND is_primary AND id <> p_location_id;
  UPDATE business_locations SET is_primary = true
    WHERE id = p_location_id AND user_id = v_owner;
  PERFORM set_config('app.location_primary_swap', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_business_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.can_manage_business_locations() THEN
    RAISE EXCEPTION 'You do not have permission to change locations.';
  END IF;
  UPDATE business_locations SET status = 'archived'
    WHERE id = p_location_id AND user_id = v_owner AND status <> 'archived';
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found or already archived.'; END IF;
  UPDATE location_preferences SET active_location_id = NULL, updated_at = now()
    WHERE user_id = auth.uid() AND active_location_id = p_location_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_location_members(
  p_location_id uuid,
  p_member_ids uuid[],
  p_manager_ids uuid[] DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_members uuid[] := COALESCE(p_member_ids, '{}');
  v_managers uuid[] := COALESCE(p_manager_ids, '{}');
BEGIN
  IF NOT public.can_manage_business_locations() THEN
    RAISE EXCEPTION 'You do not have permission to change locations.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Location not found.';
  END IF;

  DELETE FROM location_members
    WHERE location_id = p_location_id AND user_id = v_owner AND NOT (member_id = ANY (v_members));

  INSERT INTO location_members (user_id, location_id, member_id, is_manager)
  SELECT v_owner, p_location_id, tm.id, (tm.id = ANY (v_managers))
  FROM team_members tm
  WHERE tm.account_owner_id = v_owner AND tm.id = ANY (v_members)
  ON CONFLICT (location_id, member_id) DO UPDATE SET is_manager = EXCLUDED.is_manager;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_primary_location(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_business_location(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_location_members(uuid, uuid[], uuid[]) TO authenticated;

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

ALTER TABLE business_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_preferences ENABLE ROW LEVEL SECURITY;

-- business_brands
DROP POLICY IF EXISTS "select_own_business_brands" ON business_brands;
CREATE POLICY "select_own_business_brands" ON business_brands FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_brands" ON business_brands;
CREATE POLICY "insert_own_business_brands" ON business_brands FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_business_locations());
DROP POLICY IF EXISTS "update_own_business_brands" ON business_brands;
CREATE POLICY "update_own_business_brands" ON business_brands FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_business_locations())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_business_brands" ON business_brands;
CREATE POLICY "delete_own_business_brands" ON business_brands FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_business_locations());

-- business_locations
DROP POLICY IF EXISTS "select_own_business_locations" ON business_locations;
CREATE POLICY "select_own_business_locations" ON business_locations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_business_locations" ON business_locations;
CREATE POLICY "insert_own_business_locations" ON business_locations FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.can_manage_business_locations()
    AND (brand_id IS NULL OR EXISTS (
      SELECT 1 FROM business_brands b WHERE b.id = brand_id AND b.user_id = public.get_account_owner_id()))
  );
DROP POLICY IF EXISTS "update_own_business_locations" ON business_locations;
CREATE POLICY "update_own_business_locations" ON business_locations FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_business_locations())
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (brand_id IS NULL OR EXISTS (
      SELECT 1 FROM business_brands b WHERE b.id = brand_id AND b.user_id = public.get_account_owner_id()))
  );
DROP POLICY IF EXISTS "delete_archived_business_locations" ON business_locations;
CREATE POLICY "delete_archived_business_locations" ON business_locations FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_business_locations() AND status = 'archived');

-- location_members
DROP POLICY IF EXISTS "select_own_location_members" ON location_members;
CREATE POLICY "select_own_location_members" ON location_members FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_location_members" ON location_members;
CREATE POLICY "insert_own_location_members" ON location_members FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.can_manage_business_locations()
    AND EXISTS (SELECT 1 FROM business_locations l WHERE l.id = location_id AND l.user_id = public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = member_id AND tm.account_owner_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "update_own_location_members" ON location_members;
CREATE POLICY "update_own_location_members" ON location_members FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_business_locations())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_location_members" ON location_members;
CREATE POLICY "delete_own_location_members" ON location_members FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_business_locations());

-- location_preferences (strictly per user)
DROP POLICY IF EXISTS "select_own_location_preferences" ON location_preferences;
CREATE POLICY "select_own_location_preferences" ON location_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_location_preferences" ON location_preferences;
CREATE POLICY "insert_own_location_preferences" ON location_preferences FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (active_location_id IS NULL OR EXISTS (
      SELECT 1 FROM business_locations l WHERE l.id = active_location_id AND l.user_id = public.get_account_owner_id()))
  );
DROP POLICY IF EXISTS "update_own_location_preferences" ON location_preferences;
CREATE POLICY "update_own_location_preferences" ON location_preferences FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND (active_location_id IS NULL OR EXISTS (
      SELECT 1 FROM business_locations l WHERE l.id = active_location_id AND l.user_id = public.get_account_owner_id()))
  );
DROP POLICY IF EXISTS "delete_own_location_preferences" ON location_preferences;
CREATE POLICY "delete_own_location_preferences" ON location_preferences FOR DELETE TO authenticated
  USING (user_id = auth.uid());
