/*
  # Door-to-door canvassing (/dashboard/marketing/canvassing)

  A lead map for field reps: territories (ZIP / postal-prefix based) assigned to a rep, one row per door,
  an append-only visit log with an outcome per knock, automatic lead creation for warm outcomes and a
  follow-up task (the existing public.tasks table, so reminders and /dashboard/tasks keep working).

  ## Tables
  canvass_territories  name, colour, zones (ZIP5 / Canadian FSA), assigned rep (auth user id)
  canvass_doors        one row per address, optional lat/lng, last outcome as `status`, linked lead + follow-up task
  canvass_visits       append-only log, one row per knock

  ## Security model (same as direct_mail / calendar_feeds)
  - Every table is SELECT-only for clients. Every write goes through a SECURITY DEFINER RPC that
    re-checks the caller (pinned search_path, 42501 on failure).
  - Managers (account owner, admin, can_manage_team incl. custom role) see and manage everything.
  - Any other account member is a rep: they only see territories assigned to them, the doors in them
    and their own visits, and can only log visits / add doors there.
  - Doors marked do_not_knock are locked for reps (compliance); only a manager can log on them.

  ## Rules enforced in the database (the UI mirrors them in src/lib/canvassing.ts)
  - interested / appointment_set / sold need a contact name and a phone or email -> a lead is created
    (or the existing lead is advanced; stages only ever move forward).
  - callback / appointment_set need a follow-up time; any follow-up must be within the next ~13 months.
  - sold / not_interested / do_not_knock close the open follow-up task.
  - A repeated identical submit within 20 seconds (flaky mobile network) is a no-op.

  Requires: profiles, team_members(user_id, account_owner_id, role, permissions, custom_role_id, member_name,
  member_email), custom_roles(permissions), leads, tasks (20270501000000_tasks.sql).
  Safe to run more than once.
*/

-- =============================================================
-- PURE HELPERS
-- =============================================================

-- US ZIP5 or Canadian FSA (first 3 characters of a postal code); NULL when the text is neither.
CREATE OR REPLACE FUNCTION public.canvass_zone_key(p_zip text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_zip, '')) ~ '^[0-9]{5}' THEN left(btrim(p_zip), 5)
    WHEN upper(btrim(coalesce(p_zip, ''))) ~ '^[A-Z][0-9][A-Z]' THEN left(upper(btrim(p_zip)), 3)
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.canvass_zones_valid(p_zones text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(p_zones) AS z WHERE z IS NULL OR z !~ '^([0-9]{5}|[A-Z][0-9][A-Z])$'
  );
$$;

-- MUST mirror addressKey() in src/lib/canvassing.ts
CREATE OR REPLACE FUNCTION public.canvass_address_key(p_line1 text, p_line2 text, p_zone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(lower(coalesce(p_line1, '') || ' ' || coalesce(p_line2, '')), '[^a-z0-9]', '', 'g')
         || '|' || coalesce(p_zone, '');
$$;

-- =============================================================
-- AUTHORIZATION HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.canvass_ctx(OUT owner_id uuid, OUT can_manage boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tm record;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT t.account_owner_id, t.role, t.permissions, cr.permissions AS role_permissions
    INTO tm
  FROM public.team_members t
  LEFT JOIN public.custom_roles cr ON cr.id = t.custom_role_id
  WHERE t.user_id = auth.uid()
  LIMIT 1;

  IF FOUND THEN
    owner_id := tm.account_owner_id;
    can_manage :=
      tm.role IN ('admin', 'owner')
      OR COALESCE(tm.permissions ->> 'can_manage_team', 'false') = 'true'
      OR COALESCE(tm.role_permissions ->> 'can_manage_team', 'false') = 'true';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()) THEN
    owner_id := auth.uid();
    can_manage := true;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.canvass_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.owner_id FROM public.canvass_ctx() c;
$$;

CREATE OR REPLACE FUNCTION public.canvass_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT c.can_manage FROM public.canvass_ctx() c), false);
$$;

-- Raises 42501 unless the caller belongs to an account; returns the account owner id.
CREATE OR REPLACE FUNCTION public.canvass_require_member()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

-- Raises 42501 unless the caller is a manager; returns the account owner id.
CREATE OR REPLACE FUNCTION public.canvass_require_manager()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM public.canvass_ctx();
  IF c.owner_id IS NULL OR NOT COALESCE(c.can_manage, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN c.owner_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.canvass_is_account_user(p_owner uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_uid IS NOT NULL AND (
    p_uid = p_owner
    OR EXISTS (SELECT 1 FROM public.team_members t WHERE t.user_id = p_uid AND t.account_owner_id = p_owner)
  );
$$;

CREATE OR REPLACE FUNCTION public.canvass_rep_name(p_owner uuid, p_uid uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email)
       FROM public.team_members t WHERE t.user_id = p_uid AND t.account_owner_id = p_owner LIMIT 1),
    (SELECT p.email FROM public.profiles p WHERE p.id = p_uid AND p.id = p_owner),
    'Team member'
  );
$$;

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.canvass_territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT '#2563EB' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  zip_codes text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(zip_codes) <= 200 AND public.canvass_zones_valid(zip_codes)),
  assigned_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canvass_territories_name
  ON public.canvass_territories (user_id, lower(btrim(name))) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_canvass_territories_user ON public.canvass_territories (user_id, status);
CREATE INDEX IF NOT EXISTS idx_canvass_territories_rep ON public.canvass_territories (assigned_user_id) WHERE assigned_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.canvass_doors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  territory_id uuid REFERENCES public.canvass_territories(id) ON DELETE SET NULL,
  line1 text NOT NULL CHECK (char_length(line1) BETWEEN 1 AND 160),
  line2 text CHECK (line2 IS NULL OR char_length(line2) <= 80),
  city text CHECK (city IS NULL OR char_length(city) <= 80),
  state text CHECK (state IS NULL OR char_length(state) <= 40),
  zip text CHECK (zip IS NULL OR zip ~ '^([0-9]{5}(-[0-9]{4})?|[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9])$'),
  zone text,
  address_key text NOT NULL,
  lat double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'no_answer', 'callback', 'not_interested', 'interested', 'appointment_set', 'sold', 'do_not_knock')),
  visit_count integer NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  last_visit_at timestamptz,
  contact_name text CHECK (contact_name IS NULL OR char_length(contact_name) <= 120),
  contact_phone text CHECK (contact_phone IS NULL OR char_length(contact_phone) <= 32),
  contact_email text CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  follow_up_at timestamptz,
  follow_up_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canvass_doors_point CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canvass_doors_address ON public.canvass_doors (user_id, address_key);
CREATE INDEX IF NOT EXISTS idx_canvass_doors_territory ON public.canvass_doors (user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_canvass_doors_status ON public.canvass_doors (user_id, status);
CREATE INDEX IF NOT EXISTS idx_canvass_doors_follow_up ON public.canvass_doors (user_id, follow_up_at) WHERE follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canvass_doors_lead ON public.canvass_doors (lead_id) WHERE lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.canvass_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  door_id uuid NOT NULL REFERENCES public.canvass_doors(id) ON DELETE CASCADE,
  territory_id uuid REFERENCES public.canvass_territories(id) ON DELETE SET NULL,
  rep_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('no_answer', 'callback', 'not_interested', 'interested', 'appointment_set', 'sold', 'do_not_knock')),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  contact_name text,
  contact_phone text,
  contact_email text,
  follow_up_at timestamptz,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  visited_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_canvass_visits_door ON public.canvass_visits (door_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvass_visits_user ON public.canvass_visits (user_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_canvass_visits_rep ON public.canvass_visits (rep_user_id, visited_at DESC) WHERE rep_user_id IS NOT NULL;

-- =============================================================
-- TRIGGERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.canvass_territories_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_canvass_territories_write ON public.canvass_territories;
CREATE TRIGGER trg_canvass_territories_write BEFORE INSERT OR UPDATE ON public.canvass_territories
  FOR EACH ROW EXECUTE FUNCTION public.canvass_territories_before_write();

-- Normalises the address and keeps zone / address_key consistent no matter who writes.
CREATE OR REPLACE FUNCTION public.canvass_doors_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.line1 := btrim(NEW.line1);
  NEW.line2 := NULLIF(btrim(coalesce(NEW.line2, '')), '');
  NEW.city := NULLIF(btrim(coalesce(NEW.city, '')), '');
  NEW.state := NULLIF(upper(btrim(coalesce(NEW.state, ''))), '');
  NEW.zip := NULLIF(upper(btrim(coalesce(NEW.zip, ''))), '');
  NEW.zone := public.canvass_zone_key(NEW.zip);
  NEW.address_key := public.canvass_address_key(NEW.line1, NEW.line2, NEW.zone);
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_canvass_doors_write ON public.canvass_doors;
CREATE TRIGGER trg_canvass_doors_write BEFORE INSERT OR UPDATE ON public.canvass_doors
  FOR EACH ROW EXECUTE FUNCTION public.canvass_doors_before_write();

-- =============================================================
-- RLS (SELECT only; managers see all, reps see their territories)
-- =============================================================
CREATE OR REPLACE FUNCTION public.canvass_my_territory_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id FROM public.canvass_territories t
  WHERE t.user_id = public.canvass_owner_id()
    AND t.status = 'active'
    AND t.assigned_user_id = auth.uid();
$$;

ALTER TABLE public.canvass_territories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvass_doors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvass_visits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.canvass_territories FROM anon, authenticated;
REVOKE ALL ON public.canvass_doors FROM anon, authenticated;
REVOKE ALL ON public.canvass_visits FROM anon, authenticated;
GRANT SELECT ON public.canvass_territories, public.canvass_doors, public.canvass_visits TO authenticated;

DROP POLICY IF EXISTS "canvass_territories_select" ON public.canvass_territories;
CREATE POLICY "canvass_territories_select" ON public.canvass_territories FOR SELECT TO authenticated
USING (
  user_id = (SELECT public.canvass_owner_id())
  AND ((SELECT public.canvass_is_manager()) OR (status = 'active' AND assigned_user_id = (SELECT auth.uid())))
);

DROP POLICY IF EXISTS "canvass_doors_select" ON public.canvass_doors;
CREATE POLICY "canvass_doors_select" ON public.canvass_doors FOR SELECT TO authenticated
USING (
  user_id = (SELECT public.canvass_owner_id())
  AND ((SELECT public.canvass_is_manager()) OR territory_id IN (SELECT public.canvass_my_territory_ids()))
);

DROP POLICY IF EXISTS "canvass_visits_select" ON public.canvass_visits;
CREATE POLICY "canvass_visits_select" ON public.canvass_visits FOR SELECT TO authenticated
USING (
  user_id = (SELECT public.canvass_owner_id())
  AND (
    (SELECT public.canvass_is_manager())
    OR rep_user_id = (SELECT auth.uid())
    OR territory_id IN (SELECT public.canvass_my_territory_ids())
  )
);

-- =============================================================
-- INTERNAL: lock a door the caller may act on (not callable by clients)
-- =============================================================
CREATE OR REPLACE FUNCTION public.canvass_lock_door(p_door_id uuid)
RETURNS public.canvass_doors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_member();
  v_mgr boolean := public.canvass_is_manager();
  d public.canvass_doors%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.canvass_doors WHERE id = p_door_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'door_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_mgr AND NOT EXISTS (
    SELECT 1 FROM public.canvass_territories t
    WHERE t.id = d.territory_id AND t.user_id = v_owner AND t.status = 'active' AND t.assigned_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN d;
END;
$$;

REVOKE ALL ON FUNCTION public.canvass_lock_door(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RPCs
-- =============================================================

-- People a territory can be assigned to (the owner and every active team member).
CREATE OR REPLACE FUNCTION public.canvass_reps()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_manager();
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.sort_name)
    FROM (
      SELECT jsonb_build_object('user_id', p.id, 'name', COALESCE(p.email, 'Account owner'), 'role', 'owner') AS j,
             lower(COALESCE(p.email, '')) AS sort_name
      FROM public.profiles p WHERE p.id = v_owner
      UNION ALL
      SELECT jsonb_build_object('user_id', t.user_id,
               'name', COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email, 'Team member'),
               'role', COALESCE(t.role, 'member')),
             lower(COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email, ''))
      FROM public.team_members t
      WHERE t.account_owner_id = v_owner AND t.user_id IS NOT NULL
    ) x
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.canvass_territory_save(
  p_id uuid, p_name text, p_color text, p_zip_codes text[], p_assigned_user_id uuid, p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_manager();
  v_name text := btrim(coalesce(p_name, ''));
  v_color text := COALESCE(NULLIF(btrim(p_color), ''), '#2563EB');
  v_notes text := NULLIF(btrim(coalesce(p_notes, '')), '');
  v_zones text[];
  v_raw_count integer;
  old public.canvass_territories%ROWTYPE;
  t public.canvass_territories%ROWTYPE;
  v_claimed integer := 0;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'name_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_color !~ '^#[0-9a-fA-F]{6}$' THEN
    RAISE EXCEPTION 'color_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'notes_too_long' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_raw_count FROM unnest(COALESCE(p_zip_codes, '{}'::text[])) z WHERE btrim(coalesce(z, '')) <> '';
  SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), '{}'::text[]) INTO v_zones
  FROM (SELECT public.canvass_zone_key(z) AS k FROM unnest(COALESCE(p_zip_codes, '{}'::text[])) z WHERE btrim(coalesce(z, '')) <> '') s
  WHERE k IS NOT NULL;
  IF v_raw_count > 0 AND (SELECT count(*) FROM (
       SELECT 1 FROM unnest(p_zip_codes) z WHERE btrim(coalesce(z, '')) <> '' AND public.canvass_zone_key(z) IS NULL) bad) > 0 THEN
    RAISE EXCEPTION 'zip_invalid' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_zones) > 200 THEN
    RAISE EXCEPTION 'too_many_zips' USING ERRCODE = '22023';
  END IF;

  IF p_assigned_user_id IS NOT NULL AND NOT public.canvass_is_account_user(v_owner, p_assigned_user_id) THEN
    RAISE EXCEPTION 'rep_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.canvass_territories (user_id, name, color, zip_codes, assigned_user_id, assigned_at, notes, created_by)
      VALUES (v_owner, v_name, v_color, v_zones, p_assigned_user_id,
              CASE WHEN p_assigned_user_id IS NULL THEN NULL ELSE now() END, v_notes, auth.uid())
      RETURNING * INTO t;
    ELSE
      SELECT * INTO old FROM public.canvass_territories WHERE id = p_id AND user_id = v_owner FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'territory_not_found' USING ERRCODE = 'P0002';
      END IF;
      IF old.status <> 'active' THEN
        RAISE EXCEPTION 'territory_archived' USING ERRCODE = '22023';
      END IF;
      UPDATE public.canvass_territories SET
        name = v_name, color = v_color, zip_codes = v_zones, notes = v_notes,
        assigned_user_id = p_assigned_user_id,
        assigned_at = CASE
          WHEN p_assigned_user_id IS NULL THEN NULL
          WHEN p_assigned_user_id IS DISTINCT FROM old.assigned_user_id THEN now()
          ELSE old.assigned_at END
      WHERE id = p_id
      RETURNING * INTO t;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'territory_name_taken' USING ERRCODE = '23505';
  END;

  -- Unassigned doors inside the territory's zones join it automatically.
  IF cardinality(t.zip_codes) > 0 THEN
    UPDATE public.canvass_doors d SET territory_id = t.id
    WHERE d.user_id = v_owner AND d.territory_id IS NULL AND d.zone = ANY (t.zip_codes);
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('territory', to_jsonb(t), 'claimed', v_claimed);
END;
$$;

CREATE OR REPLACE FUNCTION public.canvass_territory_set_archived(p_id uuid, p_archived boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_manager();
  t public.canvass_territories%ROWTYPE;
BEGIN
  BEGIN
    UPDATE public.canvass_territories
       SET status = CASE WHEN COALESCE(p_archived, true) THEN 'archived' ELSE 'active' END
     WHERE id = p_id AND user_id = v_owner
    RETURNING * INTO t;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'territory_name_taken' USING ERRCODE = '23505';
  END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'territory_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN to_jsonb(t);
END;
$$;

-- Adds up to 500 doors. Managers may leave the territory empty (matched by ZIP); reps must pick one of theirs.
CREATE OR REPLACE FUNCTION public.canvass_doors_add(p_doors jsonb, p_territory_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_member();
  v_mgr boolean := public.canvass_is_manager();
  v_uid uuid := auth.uid();
  rec jsonb;
  t public.canvass_territories%ROWTYPE;
  v_line1 text;
  v_line2 text;
  v_zip text;
  v_zone text;
  v_lat double precision;
  v_lng double precision;
  v_terr uuid;
  v_id uuid;
  v_key text;
  v_inserted integer := 0;
  v_dupes integer := 0;
  v_invalid integer := 0;
  v_ids uuid[] := '{}';
BEGIN
  IF p_doors IS NULL OR jsonb_typeof(p_doors) <> 'array' OR jsonb_array_length(p_doors) = 0 THEN
    RAISE EXCEPTION 'no_doors' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_doors) > 500 THEN
    RAISE EXCEPTION 'too_many_doors' USING ERRCODE = '22023';
  END IF;

  IF p_territory_id IS NOT NULL THEN
    SELECT * INTO t FROM public.canvass_territories WHERE id = p_territory_id AND user_id = v_owner AND status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'territory_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_mgr AND t.assigned_user_id IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT v_mgr THEN
    RAISE EXCEPTION 'territory_required' USING ERRCODE = '22023';
  END IF;

  FOR rec IN SELECT value FROM jsonb_array_elements(p_doors) LOOP
    IF jsonb_typeof(rec) <> 'object' THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;
    v_line1 := btrim(coalesce(rec ->> 'line1', ''));
    v_line2 := NULLIF(btrim(coalesce(rec ->> 'line2', '')), '');
    v_zip := NULLIF(upper(btrim(coalesce(rec ->> 'zip', ''))), '');

    BEGIN
      v_lat := NULLIF(btrim(coalesce(rec ->> 'lat', '')), '')::double precision;
      v_lng := NULLIF(btrim(coalesce(rec ->> 'lng', '')), '')::double precision;
    EXCEPTION WHEN others THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END;

    IF char_length(v_line1) NOT BETWEEN 1 AND 160
       OR (v_line2 IS NOT NULL AND char_length(v_line2) > 80)
       OR (v_zip IS NOT NULL AND v_zip !~ '^([0-9]{5}(-[0-9]{4})?|[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9])$')
       OR (v_lat IS NULL) <> (v_lng IS NULL)
       OR (v_lat IS NOT NULL AND (v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180))
       OR char_length(coalesce(rec ->> 'city', '')) > 80
       OR char_length(coalesce(rec ->> 'state', '')) > 40 THEN
      v_invalid := v_invalid + 1;
      CONTINUE;
    END IF;

    v_zone := public.canvass_zone_key(v_zip);
    v_terr := p_territory_id;
    IF v_terr IS NULL AND v_zone IS NOT NULL THEN
      SELECT x.id INTO v_terr FROM public.canvass_territories x
      WHERE x.user_id = v_owner AND x.status = 'active' AND v_zone = ANY (x.zip_codes)
      ORDER BY x.created_at, x.id LIMIT 1;
    END IF;

    INSERT INTO public.canvass_doors (user_id, territory_id, line1, line2, city, state, zip, lat, lng, created_by)
    VALUES (v_owner, v_terr, v_line1, v_line2, rec ->> 'city', rec ->> 'state', v_zip, v_lat, v_lng, v_uid)
    ON CONFLICT (user_id, address_key) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      v_inserted := v_inserted + 1;
      v_ids := v_ids || v_id;
    ELSE
      v_dupes := v_dupes + 1;
      v_key := public.canvass_address_key(v_line1, v_line2, v_zone);
      SELECT d.id INTO v_id FROM public.canvass_doors d
      WHERE d.user_id = v_owner AND d.address_key = v_key
        AND (v_mgr OR d.territory_id IN (SELECT public.canvass_my_territory_ids()));
      IF v_id IS NOT NULL THEN
        v_ids := v_ids || v_id;
      END IF;
    END IF;
    v_id := NULL;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'duplicates', v_dupes, 'invalid', v_invalid, 'door_ids', to_jsonb(v_ids));
END;
$$;

-- Managers: move doors between territories (NULL = unassign). Returns how many doors moved.
CREATE OR REPLACE FUNCTION public.canvass_doors_assign(p_door_ids uuid[], p_territory_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_manager();
  v_count integer;
BEGIN
  IF p_door_ids IS NULL OR cardinality(p_door_ids) = 0 OR cardinality(p_door_ids) > 2000 THEN
    RAISE EXCEPTION 'no_doors' USING ERRCODE = '22023';
  END IF;
  IF p_territory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.canvass_territories t WHERE t.id = p_territory_id AND t.user_id = v_owner AND t.status = 'active'
  ) THEN
    RAISE EXCEPTION 'territory_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.canvass_doors SET territory_id = p_territory_id
  WHERE user_id = v_owner AND id = ANY (p_door_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.canvass_visit_log(
  p_door_id uuid,
  p_outcome text,
  p_note text DEFAULT NULL,
  p_contact_name text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_follow_up_at timestamptz DEFAULT NULL,
  p_service text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  d public.canvass_doors%ROWTYPE;
  v_owner uuid;
  v_mgr boolean := public.canvass_is_manager();
  v_note text := NULLIF(btrim(coalesce(p_note, '')), '');
  v_name text;
  v_phone text;
  v_email text;
  v_service text := NULLIF(btrim(coalesce(p_service, '')), '');
  v_follow timestamptz := p_follow_up_at;
  v_follow_final timestamptz;
  v_task uuid;
  v_task_final uuid;
  v_lead uuid;
  v_visit uuid;
  v_address text;
  v_dup public.canvass_visits%ROWTYPE;
  v_closes boolean;
BEGIN
  d := public.canvass_lock_door(p_door_id);
  v_owner := d.user_id;

  IF p_outcome IS NULL OR p_outcome NOT IN
     ('no_answer', 'callback', 'not_interested', 'interested', 'appointment_set', 'sold', 'do_not_knock') THEN
    RAISE EXCEPTION 'outcome_invalid' USING ERRCODE = '22023';
  END IF;
  IF d.status = 'do_not_knock' AND NOT v_mgr THEN
    RAISE EXCEPTION 'door_do_not_knock' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'note_too_long' USING ERRCODE = '22023';
  END IF;
  IF v_service IS NOT NULL AND char_length(v_service) > 120 THEN
    RAISE EXCEPTION 'service_too_long' USING ERRCODE = '22023';
  END IF;

  -- A retried submit (lost response on a flaky connection) must not double-count the knock.
  SELECT * INTO v_dup FROM public.canvass_visits
  WHERE door_id = d.id AND rep_user_id IS NOT DISTINCT FROM v_uid AND outcome = p_outcome
    AND created_at > now() - interval '20 seconds'
  ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('door', to_jsonb(d), 'visit_id', v_dup.id, 'lead_id', d.lead_id,
                              'task_id', d.follow_up_task_id, 'duplicate', true);
  END IF;

  v_name := COALESCE(NULLIF(btrim(coalesce(p_contact_name, '')), ''), d.contact_name);
  v_phone := COALESCE(NULLIF(btrim(coalesce(p_contact_phone, '')), ''), d.contact_phone);
  v_email := COALESCE(NULLIF(lower(btrim(coalesce(p_contact_email, ''))), ''), d.contact_email);

  IF v_name IS NOT NULL AND char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'contact_name_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NOT NULL AND char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    RAISE EXCEPTION 'phone_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NOT NULL AND char_length(v_phone) > 32 THEN
    RAISE EXCEPTION 'phone_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NOT NULL AND (char_length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'email_invalid' USING ERRCODE = '22023';
  END IF;

  IF p_outcome IN ('interested', 'appointment_set', 'sold') THEN
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'contact_required' USING ERRCODE = '22023';
    END IF;
    IF v_phone IS NULL AND v_email IS NULL THEN
      RAISE EXCEPTION 'contact_method_required' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_closes := p_outcome IN ('sold', 'not_interested', 'do_not_knock');
  IF v_closes THEN
    v_follow := NULL;
  END IF;
  IF p_outcome IN ('callback', 'appointment_set') AND v_follow IS NULL THEN
    RAISE EXCEPTION 'follow_up_required' USING ERRCODE = '22023';
  END IF;
  IF v_follow IS NOT NULL AND (v_follow < now() - interval '5 minutes' OR v_follow > now() + interval '400 days') THEN
    RAISE EXCEPTION 'follow_up_invalid' USING ERRCODE = '22023';
  END IF;

  v_address := concat_ws(', ', d.line1, d.city);

  -- ---- Lead -----------------------------------------------------------------
  v_lead := d.lead_id;
  IF p_outcome IN ('interested', 'appointment_set', 'sold') THEN
    IF v_lead IS NULL THEN
      INSERT INTO public.leads (user_id, name, phone, email, service_interested, notes, stage)
      VALUES (v_owner, v_name, v_phone, v_email, v_service,
              left('Door-to-door visit at ' || v_address || COALESCE('. ' || v_note, ''), 2000),
              CASE p_outcome WHEN 'sold' THEN 'won' WHEN 'appointment_set' THEN 'contacted' ELSE 'new' END)
      RETURNING id INTO v_lead;
    ELSE
      UPDATE public.leads SET
        phone = COALESCE(phone, v_phone),
        email = COALESCE(email, v_email),
        service_interested = COALESCE(service_interested, v_service),
        stage = CASE
          WHEN p_outcome = 'sold' AND stage IN ('new', 'contacted', 'quoted') THEN 'won'
          WHEN p_outcome = 'appointment_set' AND stage = 'new' THEN 'contacted'
          ELSE stage END
      WHERE id = v_lead AND user_id = v_owner;
    END IF;
  END IF;

  -- ---- Follow-up task ---------------------------------------------------------
  v_follow_final := d.follow_up_at;
  v_task_final := d.follow_up_task_id;
  IF v_follow IS NOT NULL THEN
    v_follow_final := v_follow;
    IF d.follow_up_task_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tasks k WHERE k.id = d.follow_up_task_id AND k.user_id = v_owner AND k.status <> 'done'
    ) THEN
      UPDATE public.tasks SET
        due_at = v_follow,
        assigned_to = v_uid,
        assigned_to_name = public.canvass_rep_name(v_owner, v_uid),
        priority = CASE WHEN p_outcome = 'appointment_set' THEN 'high' ELSE priority END,
        description = left(COALESCE(v_note, description), 3500),
        lead_id = COALESCE(v_lead, lead_id)
      WHERE id = d.follow_up_task_id;
      v_task_final := d.follow_up_task_id;
    ELSE
      INSERT INTO public.tasks (user_id, created_by, assigned_to, assigned_to_name, title, description, priority, due_at, lead_id)
      VALUES (v_owner, v_uid, v_uid, public.canvass_rep_name(v_owner, v_uid),
              left(CASE p_outcome WHEN 'appointment_set' THEN 'Appointment: ' ELSE 'Follow up: ' END || v_address, 200),
              left(COALESCE(v_note, 'Door-to-door follow-up'), 3500),
              CASE WHEN p_outcome = 'appointment_set' THEN 'high' ELSE 'normal' END,
              v_follow, v_lead)
      RETURNING id INTO v_task;
      v_task_final := v_task;
    END IF;
  ELSIF v_closes THEN
    IF d.follow_up_task_id IS NOT NULL THEN
      UPDATE public.tasks SET status = 'done'
      WHERE id = d.follow_up_task_id AND user_id = v_owner AND status <> 'done';
    END IF;
    v_follow_final := NULL;
    v_task_final := NULL;
  END IF;

  -- ---- Visit + door -------------------------------------------------------------
  INSERT INTO public.canvass_visits (user_id, door_id, territory_id, rep_user_id, outcome, note,
                                     contact_name, contact_phone, contact_email, follow_up_at, lead_id, task_id)
  VALUES (v_owner, d.id, d.territory_id, v_uid, p_outcome, v_note,
          v_name, v_phone, v_email, v_follow, v_lead, v_task_final)
  RETURNING id INTO v_visit;

  UPDATE public.canvass_doors SET
    status = p_outcome,
    visit_count = visit_count + 1,
    last_visit_at = now(),
    contact_name = v_name,
    contact_phone = v_phone,
    contact_email = v_email,
    lead_id = v_lead,
    follow_up_at = v_follow_final,
    follow_up_task_id = v_task_final
  WHERE id = d.id
  RETURNING * INTO d;

  RETURN jsonb_build_object('door', to_jsonb(d), 'visit_id', v_visit, 'lead_id', v_lead,
                            'task_id', v_task_final, 'duplicate', false);
END;
$$;

-- Marks the door's open follow-up as done (also completes the linked task).
CREATE OR REPLACE FUNCTION public.canvass_followup_done(p_door_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.canvass_doors%ROWTYPE;
BEGIN
  d := public.canvass_lock_door(p_door_id);
  IF d.follow_up_task_id IS NOT NULL THEN
    UPDATE public.tasks SET status = 'done'
    WHERE id = d.follow_up_task_id AND user_id = d.user_id AND status <> 'done';
  END IF;
  UPDATE public.canvass_doors SET follow_up_at = NULL, follow_up_task_id = NULL
  WHERE id = d.id
  RETURNING * INTO d;
  RETURN to_jsonb(d);
END;
$$;

-- Funnel numbers for the last p_days days. Managers get everyone; reps only their own knocks.
CREATE OR REPLACE FUNCTION public.canvass_report(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_member();
  v_mgr boolean := public.canvass_is_manager();
  v_uid uuid := auth.uid();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since timestamptz;
  v_totals jsonb;
  v_reps jsonb;
  v_terrs jsonb;
BEGIN
  v_since := now() - make_interval(days => v_days);

  SELECT jsonb_build_object(
    'knocks', count(*),
    'doors', count(DISTINCT v.door_id),
    'contacts', count(*) FILTER (WHERE v.outcome <> 'no_answer'),
    'interested', count(*) FILTER (WHERE v.outcome = 'interested'),
    'appointments', count(*) FILTER (WHERE v.outcome = 'appointment_set'),
    'sold', count(*) FILTER (WHERE v.outcome = 'sold'),
    'do_not_knock', count(*) FILTER (WHERE v.outcome = 'do_not_knock'),
    'leads', count(DISTINCT v.lead_id)
  ) INTO v_totals
  FROM public.canvass_visits v
  WHERE v.user_id = v_owner AND v.visited_at >= v_since AND (v_mgr OR v.rep_user_id = v_uid);

  SELECT COALESCE(jsonb_agg(r.j ORDER BY r.knocks DESC, r.name), '[]'::jsonb) INTO v_reps
  FROM (
    SELECT v.rep_user_id,
           CASE WHEN v.rep_user_id IS NULL THEN 'Former team member' ELSE public.canvass_rep_name(v_owner, v.rep_user_id) END AS name,
           count(*) AS knocks,
           jsonb_build_object(
             'rep_user_id', v.rep_user_id,
             'name', CASE WHEN v.rep_user_id IS NULL THEN 'Former team member' ELSE public.canvass_rep_name(v_owner, v.rep_user_id) END,
             'knocks', count(*),
             'doors', count(DISTINCT v.door_id),
             'contacts', count(*) FILTER (WHERE v.outcome <> 'no_answer'),
             'interested', count(*) FILTER (WHERE v.outcome = 'interested'),
             'appointments', count(*) FILTER (WHERE v.outcome = 'appointment_set'),
             'sold', count(*) FILTER (WHERE v.outcome = 'sold')
           ) AS j
    FROM public.canvass_visits v
    WHERE v.user_id = v_owner AND v.visited_at >= v_since AND (v_mgr OR v.rep_user_id = v_uid)
    GROUP BY v.rep_user_id
  ) r;

  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.name), '[]'::jsonb) INTO v_terrs
  FROM (
    SELECT t.name,
           jsonb_build_object(
             'territory_id', t.id,
             'name', t.name,
             'color', t.color,
             'doors_total', (SELECT count(*) FROM public.canvass_doors d WHERE d.territory_id = t.id),
             'doors_unvisited', (SELECT count(*) FROM public.canvass_doors d WHERE d.territory_id = t.id AND d.status = 'new'),
             'knocks', (SELECT count(*) FROM public.canvass_visits v
                         WHERE v.territory_id = t.id AND v.visited_at >= v_since AND (v_mgr OR v.rep_user_id = v_uid)),
             'contacts', (SELECT count(*) FROM public.canvass_visits v
                           WHERE v.territory_id = t.id AND v.visited_at >= v_since AND v.outcome <> 'no_answer' AND (v_mgr OR v.rep_user_id = v_uid)),
             'interested', (SELECT count(*) FROM public.canvass_visits v
                             WHERE v.territory_id = t.id AND v.visited_at >= v_since AND v.outcome = 'interested' AND (v_mgr OR v.rep_user_id = v_uid)),
             'appointments', (SELECT count(*) FROM public.canvass_visits v
                               WHERE v.territory_id = t.id AND v.visited_at >= v_since AND v.outcome = 'appointment_set' AND (v_mgr OR v.rep_user_id = v_uid)),
             'sold', (SELECT count(*) FROM public.canvass_visits v
                       WHERE v.territory_id = t.id AND v.visited_at >= v_since AND v.outcome = 'sold' AND (v_mgr OR v.rep_user_id = v_uid))
           ) AS j
    FROM public.canvass_territories t
    WHERE t.user_id = v_owner AND t.status = 'active' AND (v_mgr OR t.assigned_user_id = v_uid)
  ) x;

  RETURN jsonb_build_object('days', v_days, 'totals', v_totals, 'by_rep', v_reps, 'by_territory', v_terrs);
END;
$$;

-- =============================================================
-- GRANTS (clients can only call the public RPCs)
-- =============================================================
REVOKE ALL ON FUNCTION public.canvass_ctx() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_owner_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_require_member() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_require_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_is_account_user(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_rep_name(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_my_territory_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.canvass_ctx() TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_owner_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_is_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_my_territory_ids() TO authenticated;

REVOKE ALL ON FUNCTION public.canvass_reps() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_territory_save(uuid, text, text, text[], uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_territory_set_archived(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_doors_add(jsonb, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_doors_assign(uuid[], uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_visit_log(uuid, text, text, text, text, text, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_followup_done(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.canvass_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.canvass_reps() TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_territory_save(uuid, text, text, text[], uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_territory_set_archived(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_doors_add(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_doors_assign(uuid[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_visit_log(uuid, text, text, text, text, text, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_followup_done(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.canvass_report(integer) TO authenticated;
