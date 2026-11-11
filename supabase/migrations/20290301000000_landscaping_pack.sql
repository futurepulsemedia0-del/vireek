/*
  Landscaping pack (Trade Pack #3)

  GATED: feature flag `landscaping_pack` (seeded OFF, rollout 0) AND account entitlement `packs:landscaping`
  (granted per tenant by Vireek staff). With either missing, every landscaping table is invisible/unwritable
  to tenants, every landscaping RPC raises `landscaping_not_enabled`, and installing the pack is refused.
  No existing table, policy, function or trigger is modified.

  Adds
    1. account_entitlements (+ append-only events) — generic per-account module entitlement
    2. gate helpers + install guard on trade_pack_installs
    3. properties & service areas, crews, equipment assignments
    4. recurring maintenance contracts, pauses, add-ons, visits, visit tasks
    5. route-change audit, contract events (append-only), billing records
    6. recurrence planner / generator, day-of re-route, weather skip, snow events
    7. visit lifecycle (tasks, before/after-photo gate), batch billing with idempotency, pause/resume

  Money is integer cents. All timestamps timestamptz. All tenant keys = get_account_owner_id().

  ROLLBACK (data-destroying; run only on a database where the pack was never used, or after exporting):
    DROP TRIGGER IF EXISTS trg_landscape_install_guard ON trade_pack_installs;
    DROP TABLE IF EXISTS landscape_billing_records, landscape_route_changes, landscape_contract_events,
      landscape_visit_tasks, landscape_visits, landscape_addons, landscape_contract_pauses, landscape_contracts,
      landscape_equipment_assignments, landscape_crews, landscape_property_areas, landscape_properties CASCADE;
    DROP TABLE IF EXISTS account_entitlement_events, account_entitlements CASCADE;
    DELETE FROM trade_pack_installs WHERE pack_key = 'landscaping';
    DELETE FROM trade_packs WHERE pack_key = 'landscaping';
    DELETE FROM feature_flags WHERE key = 'landscaping_pack';
    DROP FUNCTION IF EXISTS <every public.landscape_* / public._landscape_* / has_account_entitlement /
      get_my_entitlements / staff_set_account_entitlement function created below>;
  Safe, non-destructive "off switch": set the flag off or revoke the entitlement — data stays, access stops.
*/

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =============================================================
-- 1. ACCOUNT ENTITLEMENTS (generic; first user: packs:landscaping)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.account_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL CHECK (entitlement_key ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$' AND char_length(entitlement_key) <= 64),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_entitlements_active
  ON public.account_entitlements (user_id, entitlement_key) WHERE revoked_at IS NULL;

ALTER TABLE public.account_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_entitlements" ON public.account_entitlements;
CREATE POLICY "select_own_entitlements" ON public.account_entitlements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies: only staff_set_account_entitlement() writes.

CREATE TABLE IF NOT EXISTS public.account_entitlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entitlement_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'revoke')),
  actor uuid,
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.account_entitlement_events ENABLE ROW LEVEL SECURITY; -- no policies: staff RPC / service role only
REVOKE ALL ON public.account_entitlement_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public._landscape_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_entitlement_events_immutable ON public.account_entitlement_events;
CREATE TRIGGER trg_entitlement_events_immutable BEFORE UPDATE OR DELETE ON public.account_entitlement_events
  FOR EACH ROW EXECUTE FUNCTION public._landscape_append_only();

CREATE OR REPLACE FUNCTION public.has_account_entitlement(p_owner uuid, p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_entitlements e
    WHERE e.user_id = p_owner AND e.entitlement_key = p_key
      AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())
  );
$$;
REVOKE ALL ON FUNCTION public.has_account_entitlement(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_account_entitlement(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_my_entitlements()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(e.entitlement_key ORDER BY e.entitlement_key), ARRAY[]::text[])
  FROM public.account_entitlements e
  WHERE e.user_id = public.get_account_owner_id()
    AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now());
$$;
REVOKE ALL ON FUNCTION public.get_my_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_entitlements() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_set_account_entitlement(p_tenant uuid, p_key text, p_enabled boolean, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid entitlement key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_tenant AND role = 'owner') THEN
    RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_enabled THEN
    INSERT INTO public.account_entitlements (user_id, entitlement_key, granted_by, note)
    VALUES (p_tenant, p_key, auth.uid(), left(p_note, 500))
    ON CONFLICT (user_id, entitlement_key) WHERE revoked_at IS NULL DO NOTHING;
  ELSE
    UPDATE public.account_entitlements SET revoked_at = now()
    WHERE user_id = p_tenant AND entitlement_key = p_key AND revoked_at IS NULL;
  END IF;
  INSERT INTO public.account_entitlement_events (user_id, entitlement_key, action, actor, note)
  VALUES (p_tenant, p_key, CASE WHEN p_enabled THEN 'grant' ELSE 'revoke' END, auth.uid(), left(p_note, 500));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_account_entitlement(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_account_entitlement(uuid, text, boolean, text) TO authenticated;

-- =============================================================
-- 2. FLAG + GATE + INSTALL GUARD
-- =============================================================

INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('landscaping_pack', 'Landscaping pack',
        'Landscaping & lawn-care module (contracts, crews, routes, visit checklists, add-ons, batch invoicing). Also requires the account entitlement packs:landscaping.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.landscape_pack_allowed(p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_owner IS NOT NULL
     AND COALESCE(public.flag_evaluate('landscaping_pack', p_owner), false)
     AND public.has_account_entitlement(p_owner, 'packs:landscaping');
$$;
REVOKE ALL ON FUNCTION public.landscape_pack_allowed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_pack_allowed(uuid) TO authenticated, service_role;

-- Resolves the caller's tenant or raises. `p_manage` additionally requires the owner/admin-level permission
-- already used by the Trade Pack framework.
CREATE OR REPLACE FUNCTION public._landscape_require(p_manage boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.landscape_pack_allowed(v_owner) THEN
    RAISE EXCEPTION 'landscaping_not_enabled' USING ERRCODE = '42501';
  END IF;
  IF p_manage AND NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_require(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._landscape_require(boolean) TO authenticated;

INSERT INTO public.trade_packs (pack_key, name, industry_slug) VALUES ('landscaping', 'Landscaping & Lawn Care', 'lawn-care')
  ON CONFLICT (pack_key) DO UPDATE SET name = EXCLUDED.name, industry_slug = EXCLUDED.industry_slug;

CREATE OR REPLACE FUNCTION public._landscape_install_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.pack_key = 'landscaping' AND NEW.enabled AND NOT public.landscape_pack_allowed(NEW.user_id) THEN
    RAISE EXCEPTION 'landscaping_not_enabled' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_landscape_install_guard ON public.trade_pack_installs;
CREATE TRIGGER trg_landscape_install_guard BEFORE INSERT OR UPDATE ON public.trade_pack_installs
  FOR EACH ROW EXECUTE FUNCTION public._landscape_install_guard();

-- =============================================================
-- 3. VALIDATORS (pure helpers, mirrored by validateSchedule / validateWeatherPolicy in TS)
-- =============================================================

CREATE OR REPLACE FUNCTION public._landscape_month_in_window(m int, f int, t int)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN f <= t THEN m BETWEEN f AND t ELSE (m >= f OR m <= t) END;
$$;

CREATE OR REPLACE FUNCTION public._landscape_valid_seasons(j jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb; seen int[] := ARRAY[]::int[]; m int; f int; t int; w int;
BEGIN
  IF j IS NULL OR jsonb_typeof(j) <> 'array' OR jsonb_array_length(j) NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(j) LOOP
    IF jsonb_typeof(r) <> 'object'
       OR jsonb_typeof(r->'fromMonth') <> 'number' OR jsonb_typeof(r->'toMonth') <> 'number' OR jsonb_typeof(r->'intervalWeeks') <> 'number' THEN
      RETURN false;
    END IF;
    f := (r->>'fromMonth')::numeric::int; t := (r->>'toMonth')::numeric::int; w := (r->>'intervalWeeks')::numeric::int;
    IF (r->>'fromMonth')::numeric <> f OR (r->>'toMonth')::numeric <> t OR (r->>'intervalWeeks')::numeric <> w THEN RETURN false; END IF;
    IF f NOT BETWEEN 1 AND 12 OR t NOT BETWEEN 1 AND 12 OR w NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
    FOR m IN 1..12 LOOP
      IF public._landscape_month_in_window(m, f, t) THEN
        IF m = ANY(seen) THEN RETURN false; END IF;
        seen := seen || m;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public._landscape_valid_weather_policy(j jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb; k jsonb;
BEGIN
  IF j IS NULL OR jsonb_typeof(j) <> 'object' OR octet_length(j::text) > 4000 THEN RETURN false; END IF;
  IF COALESCE(j->>'makeup', '') NOT IN ('next_workday', 'none') THEN RETURN false; END IF;
  IF jsonb_typeof(j->'rules') <> 'array' OR jsonb_array_length(j->'rules') > 8 THEN RETURN false; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(j->'rules') LOOP
    IF jsonb_typeof(r) <> 'object' OR COALESCE(r->>'kind', '') NOT IN ('rain_prob_pct','rain_mm','snow_cm','wind_kph','freeze_c','heat_c','alert_keyword') THEN RETURN false; END IF;
    IF r->>'kind' = 'alert_keyword' THEN
      IF jsonb_typeof(r->'keywords') <> 'array' OR jsonb_array_length(r->'keywords') NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
      FOR k IN SELECT * FROM jsonb_array_elements(r->'keywords') LOOP
        IF jsonb_typeof(k) <> 'string' OR char_length(btrim(k #>> '{}')) < 3 OR char_length(k #>> '{}') > 40 THEN RETURN false; END IF;
      END LOOP;
    ELSE
      IF jsonb_typeof(r->'threshold') <> 'number' THEN RETURN false; END IF;
      IF r->>'kind' = 'rain_prob_pct' AND ((r->>'threshold')::numeric < 0 OR (r->>'threshold')::numeric > 100) THEN RETURN false; END IF;
      IF r->>'kind' IN ('rain_mm','snow_cm','wind_kph') AND (r->>'threshold')::numeric < 0 THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public._landscape_valid_checklist(j jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb; keys text[] := ARRAY[]::text[];
BEGIN
  IF j IS NULL OR jsonb_typeof(j) <> 'array' OR jsonb_array_length(j) > 40 THEN RETURN false; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(j) LOOP
    IF jsonb_typeof(r) <> 'object' OR jsonb_typeof(r->'key') <> 'string' OR (r->>'key') !~ '^[a-z0-9_]{1,40}$'
       OR jsonb_typeof(r->'label') <> 'string' OR char_length(btrim(r->>'label')) NOT BETWEEN 1 AND 120
       OR jsonb_typeof(r->'required') <> 'boolean' OR (r->>'key') = ANY(keys) THEN
      RETURN false;
    END IF;
    keys := keys || (r->>'key');
  END LOOP;
  RETURN true;
END;
$$;

-- =============================================================
-- 4. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.landscape_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  address text CHECK (address IS NULL OR char_length(address) <= 300),
  lat numeric(9,6) CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng numeric(9,6) CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  lot_sqft numeric(12,1) CHECK (lot_sqft IS NULL OR lot_sqft BETWEEN 0 AND 5000000000),
  turf_sqft numeric(12,1) CHECK (turf_sqft IS NULL OR turf_sqft BETWEEN 0 AND 5000000000),
  bed_sqft numeric(12,1) CHECK (bed_sqft IS NULL OR bed_sqft BETWEEN 0 AND 5000000000),
  hardscape_sqft numeric(12,1) CHECK (hardscape_sqft IS NULL OR hardscape_sqft BETWEEN 0 AND 5000000000),
  edge_ft numeric(10,1) CHECK (edge_ft IS NULL OR edge_ft BETWEEN 0 AND 10000000),
  slope text CHECK (slope IS NULL OR slope IN ('flat', 'gentle', 'steep')),
  access_notes text CHECK (access_notes IS NULL OR char_length(access_notes) <= 2000),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landscape_properties_user ON public.landscape_properties (user_id, customer_id);

CREATE TABLE IF NOT EXISTS public.landscape_property_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  property_id uuid NOT NULL REFERENCES public.landscape_properties(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  area_type text NOT NULL DEFAULT 'turf' CHECK (area_type IN ('turf','bed','hardscape','tree','hedge','driveway','walkway','other')),
  sqft numeric(12,1) CHECK (sqft IS NULL OR sqft BETWEEN 0 AND 5000000000),
  linear_ft numeric(10,1) CHECK (linear_ft IS NULL OR linear_ft BETWEEN 0 AND 10000000),
  measured_via text NOT NULL DEFAULT 'manual' CHECK (measured_via IN ('manual','satellite','wheel','plan')),
  measured_on date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landscape_areas_property ON public.landscape_property_areas (property_id);

CREATE TABLE IF NOT EXISTS public.landscape_crews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  lead_technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  member_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[] CHECK (cardinality(member_ids) <= 11),
  default_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_landscape_crews_name ON public.landscape_crews (user_id, lower(name));

CREATE TABLE IF NOT EXISTS public.landscape_equipment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  service_date date NOT NULL,
  crew_id uuid NOT NULL REFERENCES public.landscape_crews(id) ON DELETE CASCADE,
  asset_kind text NOT NULL CHECK (asset_kind IN ('vehicle', 'tool')),
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  tool_item_id uuid REFERENCES public.tool_crib_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((asset_kind = 'vehicle' AND vehicle_id IS NOT NULL AND tool_item_id IS NULL)
      OR (asset_kind = 'tool' AND tool_item_id IS NOT NULL AND vehicle_id IS NULL))
);
-- An asset can be on only one crew per day (mirrors equipmentConflicts() in TS).
CREATE UNIQUE INDEX IF NOT EXISTS uq_landscape_equip_vehicle_day ON public.landscape_equipment_assignments (user_id, service_date, vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_landscape_equip_tool_day ON public.landscape_equipment_assignments (user_id, service_date, tool_item_id) WHERE tool_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_landscape_equip_crew_day ON public.landscape_equipment_assignments (crew_id, service_date);

CREATE TABLE IF NOT EXISTS public.landscape_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  property_id uuid REFERENCES public.landscape_properties(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  service_type text NOT NULL DEFAULT 'Lawn maintenance' CHECK (char_length(btrim(service_type)) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  start_date date NOT NULL,
  end_date date,
  seasons jsonb NOT NULL DEFAULT '[{"fromMonth":1,"toMonth":12,"intervalWeeks":1}]'::jsonb CHECK (public._landscape_valid_seasons(seasons)),
  holiday_policy text NOT NULL DEFAULT 'shift_next' CHECK (holiday_policy IN ('shift_next', 'shift_prev', 'skip', 'ignore')),
  holiday_set text NOT NULL DEFAULT 'us_core' CHECK (holiday_set IN ('none', 'us_core')),
  extra_holidays date[] NOT NULL DEFAULT ARRAY[]::date[] CHECK (cardinality(extra_holidays) <= 60),
  workdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[]
    CHECK (cardinality(workdays) BETWEEN 1 AND 7 AND workdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  -- 05:00–20:59 keeps the twice-a-year DST gap/overlap hour out of play.
  preferred_time time NOT NULL DEFAULT '09:00' CHECK (preferred_time >= time '05:00' AND preferred_time < time '21:00'),
  timezone text NOT NULL DEFAULT 'America/Chicago',
  duration_minutes integer NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 10 AND 480),
  default_crew_id uuid REFERENCES public.landscape_crews(id) ON DELETE SET NULL,
  billing_mode text NOT NULL DEFAULT 'per_visit' CHECK (billing_mode IN ('per_visit', 'monthly_flat')),
  visit_price_cents integer NOT NULL DEFAULT 0 CHECK (visit_price_cents BETWEEN 0 AND 100000000),
  monthly_fee_cents integer NOT NULL DEFAULT 0 CHECK (monthly_fee_cents BETWEEN 0 AND 100000000),
  tax_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 100),
  weather_policy jsonb NOT NULL DEFAULT '{"rules":[],"makeup":"next_workday"}'::jsonb CHECK (public._landscape_valid_weather_policy(weather_policy)),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (public._landscape_valid_checklist(checklist)),
  require_photos boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_landscape_contracts_user ON public.landscape_contracts (user_id, status);
CREATE INDEX IF NOT EXISTS idx_landscape_contracts_customer ON public.landscape_contracts (customer_id);

CREATE TABLE IF NOT EXISTS public.landscape_contract_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  contract_id uuid NOT NULL REFERENCES public.landscape_contracts(id) ON DELETE CASCADE,
  from_date date NOT NULL,
  to_date date,                       -- inclusive; NULL = until resumed
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date IS NULL OR to_date >= from_date),
  -- Pause windows of one contract never overlap, so billing day-counts and visit skipping stay unambiguous.
  EXCLUDE USING gist (contract_id WITH =, daterange(from_date, COALESCE(to_date, 'infinity'::date), '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_landscape_pauses_contract ON public.landscape_contract_pauses (contract_id);

CREATE TABLE IF NOT EXISTS public.landscape_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  contract_id uuid NOT NULL REFERENCES public.landscape_contracts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('snow', 'fertilization', 'cleanup', 'other')),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  billing text NOT NULL DEFAULT 'per_visit' CHECK (billing IN ('per_visit', 'per_event', 'one_time')),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents BETWEEN 0 AND 100000000),
  duration_minutes integer NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 10 AND 480),
  season_from_month smallint NOT NULL DEFAULT 1 CHECK (season_from_month BETWEEN 1 AND 12),
  season_to_month smallint NOT NULL DEFAULT 12 CHECK (season_to_month BETWEEN 1 AND 12),
  round_months smallint[] NOT NULL DEFAULT ARRAY[]::smallint[] CHECK (cardinality(round_months) <= 12 AND round_months <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  snow_trigger_cm numeric(5,1) CHECK (snow_trigger_cm IS NULL OR snow_trigger_cm BETWEEN 0.5 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'snow' OR snow_trigger_cm IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_landscape_addons_contract ON public.landscape_addons (contract_id);

CREATE TABLE IF NOT EXISTS public.landscape_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  contract_id uuid NOT NULL REFERENCES public.landscape_contracts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('maintenance', 'addon', 'makeup')),
  occurrence_n integer,
  addon_id uuid REFERENCES public.landscape_addons(id) ON DELETE SET NULL,
  event_key text CHECK (event_key IS NULL OR char_length(event_key) <= 60),
  makeup_for uuid REFERENCES public.landscape_visits(id) ON DELETE SET NULL,
  original_date date NOT NULL,
  visit_date date NOT NULL,
  scheduled_at timestamptz NOT NULL,
  crew_id uuid REFERENCES public.landscape_crews(id) ON DELETE SET NULL,
  crew_size integer NOT NULL DEFAULT 1 CHECK (crew_size BETWEEN 1 AND 12),
  route_position integer CHECK (route_position IS NULL OR route_position >= 1),
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'skipped', 'cancelled')),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason IN ('holiday', 'paused', 'weather', 'manual', 'contract_ended', 'crew_unavailable')),
  weather jsonb CHECK (weather IS NULL OR (jsonb_typeof(weather) = 'object' AND octet_length(weather::text) <= 4000)),
  attention text CHECK (attention IS NULL OR char_length(attention) <= 300),
  planned_minutes integer NOT NULL DEFAULT 45 CHECK (planned_minutes BETWEEN 5 AND 600),
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents BETWEEN 0 AND 100000000),
  billed_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  billed_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'maintenance' AND occurrence_n IS NOT NULL) OR kind <> 'maintenance'),
  CHECK ((kind = 'addon' AND addon_id IS NOT NULL AND event_key IS NOT NULL) OR kind <> 'addon')
);
-- Idempotency keys: generating (or re-generating) never duplicates a visit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_landscape_visit_occurrence ON public.landscape_visits (contract_id, occurrence_n) WHERE kind = 'maintenance';
CREATE UNIQUE INDEX IF NOT EXISTS uq_landscape_visit_addon_event ON public.landscape_visits (contract_id, addon_id, event_key) WHERE kind = 'addon';
CREATE UNIQUE INDEX IF NOT EXISTS uq_landscape_visit_makeup ON public.landscape_visits (makeup_for) WHERE makeup_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_landscape_visits_day ON public.landscape_visits (user_id, visit_date, crew_id, route_position);
CREATE INDEX IF NOT EXISTS idx_landscape_visits_contract ON public.landscape_visits (contract_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_landscape_visits_job ON public.landscape_visits (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_landscape_visits_unbilled ON public.landscape_visits (contract_id) WHERE status = 'completed' AND billed_invoice_id IS NULL;

CREATE TABLE IF NOT EXISTS public.landscape_visit_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  visit_id uuid NOT NULL REFERENCES public.landscape_visits(id) ON DELETE CASCADE,
  task_key text NOT NULL CHECK (task_key ~ '^[a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  required boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'todo' CHECK (state IN ('todo', 'done', 'na')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  done_by uuid,
  done_at timestamptz,
  UNIQUE (visit_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_landscape_tasks_visit ON public.landscape_visit_tasks (visit_id);

CREATE TABLE IF NOT EXISTS public.landscape_contract_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  contract_id uuid NOT NULL REFERENCES public.landscape_contracts(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (char_length(event) <= 40),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 4000),
  actor uuid DEFAULT auth.uid(),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landscape_events_contract ON public.landscape_contract_events (contract_id, at DESC);

CREATE TABLE IF NOT EXISTS public.landscape_route_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  crew_id uuid,
  route_date date NOT NULL,
  before_order uuid[] NOT NULL,
  after_order uuid[] NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 300),
  changed_by uuid DEFAULT auth.uid(),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landscape_route_changes_day ON public.landscape_route_changes (user_id, route_date);

CREATE TABLE IF NOT EXISTS public.landscape_billing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  contract_id uuid NOT NULL REFERENCES public.landscape_contracts(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents integer NOT NULL CHECK (tax_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  visit_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  run_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- THE idempotency key: one billing record per contract and month.
  UNIQUE (contract_id, period)
);
CREATE INDEX IF NOT EXISTS idx_landscape_billing_user_period ON public.landscape_billing_records (user_id, period);

DROP TRIGGER IF EXISTS trg_landscape_events_immutable ON public.landscape_contract_events;
CREATE TRIGGER trg_landscape_events_immutable BEFORE UPDATE OR DELETE ON public.landscape_contract_events
  FOR EACH ROW EXECUTE FUNCTION public._landscape_append_only();
DROP TRIGGER IF EXISTS trg_landscape_route_changes_immutable ON public.landscape_route_changes;
CREATE TRIGGER trg_landscape_route_changes_immutable BEFORE UPDATE OR DELETE ON public.landscape_route_changes
  FOR EACH ROW EXECUTE FUNCTION public._landscape_append_only();

-- updated_at
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['landscape_properties','landscape_property_areas','landscape_crews','landscape_contracts','landscape_addons','landscape_visits']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- =============================================================
-- 5. CROSS-TENANT REFERENCE GUARD, STATUS MACHINE, AUDIT TRIGGERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._landscape_validate_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable' USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME = 'landscape_properties' THEN
    IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'customer not found' USING ERRCODE = '23503';
    END IF;

  ELSIF TG_TABLE_NAME = 'landscape_property_areas' THEN
    IF NOT EXISTS (SELECT 1 FROM landscape_properties p WHERE p.id = NEW.property_id AND p.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'property not found' USING ERRCODE = '23503';
    END IF;

  ELSIF TG_TABLE_NAME = 'landscape_crews' THEN
    IF NEW.lead_technician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.id = NEW.lead_technician_id AND t.account_owner_id = NEW.user_id) THEN
      RAISE EXCEPTION 'crew lead is not on this team' USING ERRCODE = '23503';
    END IF;
    IF cardinality(NEW.member_ids) > 0 AND (SELECT count(*) FROM team_members t WHERE t.id = ANY(NEW.member_ids) AND t.account_owner_id = NEW.user_id) <> (SELECT count(DISTINCT m) FROM unnest(NEW.member_ids) m) THEN
      RAISE EXCEPTION 'crew member is not on this team' USING ERRCODE = '23503';
    END IF;
    IF NEW.default_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = NEW.default_vehicle_id AND v.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'vehicle not found' USING ERRCODE = '23503';
    END IF;

  ELSIF TG_TABLE_NAME = 'landscape_equipment_assignments' THEN
    IF NOT EXISTS (SELECT 1 FROM landscape_crews c WHERE c.id = NEW.crew_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'crew not found' USING ERRCODE = '23503';
    END IF;
    IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = NEW.vehicle_id AND v.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'vehicle not found' USING ERRCODE = '23503';
    END IF;
    IF NEW.tool_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tool_crib_items i WHERE i.id = NEW.tool_item_id AND i.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'tool not found' USING ERRCODE = '23503';
    END IF;

  ELSIF TG_TABLE_NAME = 'landscape_addons' THEN
    IF NOT EXISTS (SELECT 1 FROM landscape_contracts c WHERE c.id = NEW.contract_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'contract not found' USING ERRCODE = '23503';
    END IF;

  ELSIF TG_TABLE_NAME = 'landscape_contracts' THEN
    IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'customer not found' USING ERRCODE = '23503';
    END IF;
    IF NEW.property_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM landscape_properties p WHERE p.id = NEW.property_id AND p.user_id = NEW.user_id AND p.customer_id = NEW.customer_id) THEN
      RAISE EXCEPTION 'property does not belong to this customer' USING ERRCODE = '23503';
    END IF;
    IF NEW.default_crew_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM landscape_crews c WHERE c.id = NEW.default_crew_id AND c.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'crew not found' USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = NEW.timezone) THEN
      RAISE EXCEPTION 'unknown timezone' USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'draft'  AND NEW.status IN ('active', 'ended'))
        OR (OLD.status = 'active' AND NEW.status IN ('paused', 'ended'))
        OR (OLD.status = 'paused' AND NEW.status IN ('active', 'ended'))) THEN
        RAISE EXCEPTION 'invalid_status_transition' USING ERRCODE = '22023';
      END IF;
      -- Occurrence numbers are counted from start_date; moving it after visits exist would orphan or collide them.
      IF NEW.start_date IS DISTINCT FROM OLD.start_date AND EXISTS (SELECT 1 FROM landscape_visits v WHERE v.contract_id = OLD.id) THEN
        RAISE EXCEPTION 'start_date_locked' USING ERRCODE = '22023';
      END IF;
      IF NEW.billing_mode IS DISTINCT FROM OLD.billing_mode AND EXISTS (SELECT 1 FROM landscape_billing_records r WHERE r.contract_id = OLD.id) THEN
        RAISE EXCEPTION 'billing_mode_locked' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF NEW.status = 'active' AND NEW.billing_mode = 'monthly_flat' AND NEW.monthly_fee_cents <= 0 THEN
      RAISE EXCEPTION 'monthly fee required' USING ERRCODE = '22023';
    END IF;
    v_today := (now() AT TIME ZONE NEW.timezone)::date;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['landscape_properties','landscape_property_areas','landscape_crews','landscape_equipment_assignments','landscape_addons','landscape_contracts']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_validate ON public.%1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_validate BEFORE INSERT OR UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public._landscape_validate_refs()', t);
  END LOOP;
END $$;

-- Audit + stale-schedule cleanup after contract changes.
CREATE OR REPLACE FUNCTION public._landscape_contract_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE NEW.timezone)::date; v_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
    VALUES (NEW.user_id, NEW.id, 'created', jsonb_build_object('status', NEW.status));
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
    VALUES (NEW.user_id, NEW.id, 'status_changed', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  IF NEW.visit_price_cents IS DISTINCT FROM OLD.visit_price_cents OR NEW.monthly_fee_cents IS DISTINCT FROM OLD.monthly_fee_cents
     OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode OR NEW.tax_percent IS DISTINCT FROM OLD.tax_percent THEN
    INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
    VALUES (NEW.user_id, NEW.id, 'pricing_changed', jsonb_build_object(
      'visit_price_cents', jsonb_build_array(OLD.visit_price_cents, NEW.visit_price_cents),
      'monthly_fee_cents', jsonb_build_array(OLD.monthly_fee_cents, NEW.monthly_fee_cents),
      'billing_mode', jsonb_build_array(OLD.billing_mode, NEW.billing_mode),
      'tax_percent', jsonb_build_array(OLD.tax_percent, NEW.tax_percent)));
  END IF;

  -- Schedule-affecting edits: drop FUTURE, untouched maintenance / round visits so regeneration applies the new rules.
  IF NEW.status IN ('active', 'paused') AND (
       NEW.seasons IS DISTINCT FROM OLD.seasons OR NEW.holiday_policy IS DISTINCT FROM OLD.holiday_policy
    OR NEW.holiday_set IS DISTINCT FROM OLD.holiday_set OR NEW.extra_holidays IS DISTINCT FROM OLD.extra_holidays
    OR NEW.workdays IS DISTINCT FROM OLD.workdays OR NEW.preferred_time IS DISTINCT FROM OLD.preferred_time
    OR NEW.timezone IS DISTINCT FROM OLD.timezone OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
    OR NEW.default_crew_id IS DISTINCT FROM OLD.default_crew_id OR NEW.visit_price_cents IS DISTINCT FROM OLD.visit_price_cents
    OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.checklist IS DISTINCT FROM OLD.checklist) THEN
    SELECT array_agg(v.id) INTO v_ids FROM landscape_visits v
    WHERE v.contract_id = NEW.id AND v.status = 'scheduled' AND v.started_at IS NULL AND v.billed_invoice_id IS NULL
      AND v.visit_date > v_today AND (v.kind = 'maintenance' OR (v.kind = 'addon' AND v.event_key LIKE 'round:%'));
    IF v_ids IS NOT NULL THEN
      UPDATE jobs SET job_status = 'cancelled' WHERE id IN (SELECT job_id FROM landscape_visits WHERE id = ANY(v_ids) AND job_id IS NOT NULL) AND job_status = 'scheduled';
      DELETE FROM landscape_visits WHERE id = ANY(v_ids);
      INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
      VALUES (NEW.user_id, NEW.id, 'schedule_rebuilt', jsonb_build_object('visits_dropped', cardinality(v_ids)));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_landscape_contract_after ON public.landscape_contracts;
CREATE TRIGGER trg_landscape_contract_after AFTER INSERT OR UPDATE ON public.landscape_contracts
  FOR EACH ROW EXECUTE FUNCTION public._landscape_contract_after();

-- =============================================================
-- 6. ROW LEVEL SECURITY (every policy re-checks the flag + entitlement gate)
-- =============================================================

DO $$
DECLARE
  t text;
  gate text := '(SELECT public.landscape_pack_allowed((SELECT public.get_account_owner_id())))';
  own  text := 'user_id = (SELECT public.get_account_owner_id())';
BEGIN
  -- config tables: members read, trade-pack managers write
  FOREACH t IN ARRAY ARRAY['landscape_properties','landscape_property_areas','landscape_crews','landscape_equipment_assignments','landscape_contracts','landscape_addons']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "ls_select" ON public.%I', t);
    EXECUTE format('CREATE POLICY "ls_select" ON public.%I FOR SELECT TO authenticated USING (%s AND %s)', t, own, gate);
    EXECUTE format('DROP POLICY IF EXISTS "ls_insert" ON public.%I', t);
    EXECUTE format('CREATE POLICY "ls_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (%s AND %s AND (SELECT public.can_manage_trade_packs()))', t, own, gate);
    EXECUTE format('DROP POLICY IF EXISTS "ls_update" ON public.%I', t);
    EXECUTE format('CREATE POLICY "ls_update" ON public.%I FOR UPDATE TO authenticated USING (%s AND %s AND (SELECT public.can_manage_trade_packs())) WITH CHECK (%s AND %s AND (SELECT public.can_manage_trade_packs()))', t, own, gate, own, gate);
  END LOOP;
  -- deletable config (contracts are ended, never deleted)
  FOREACH t IN ARRAY ARRAY['landscape_properties','landscape_property_areas','landscape_crews','landscape_equipment_assignments','landscape_addons']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "ls_delete" ON public.%I', t);
    EXECUTE format('CREATE POLICY "ls_delete" ON public.%I FOR DELETE TO authenticated USING (%s AND %s AND (SELECT public.can_manage_trade_packs()))', t, own, gate);
  END LOOP;
  -- read-only for tenants: written exclusively by SECURITY DEFINER RPCs
  FOREACH t IN ARRAY ARRAY['landscape_contract_pauses','landscape_visits','landscape_visit_tasks','landscape_contract_events','landscape_route_changes','landscape_billing_records']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "ls_select" ON public.%I', t);
    EXECUTE format('CREATE POLICY "ls_select" ON public.%I FOR SELECT TO authenticated USING (%s AND %s)', t, own, gate);
  END LOOP;
END $$;

-- Table privileges: RLS already blocks writes to RPC-only tables; revoke anyway (defence in depth).
REVOKE INSERT, UPDATE, DELETE ON public.landscape_contract_pauses, public.landscape_visits, public.landscape_visit_tasks,
  public.landscape_contract_events, public.landscape_route_changes, public.landscape_billing_records FROM anon, authenticated;
REVOKE ALL ON public.landscape_properties, public.landscape_property_areas, public.landscape_crews, public.landscape_equipment_assignments,
  public.landscape_contracts, public.landscape_addons, public.landscape_contract_pauses, public.landscape_visits, public.landscape_visit_tasks,
  public.landscape_contract_events, public.landscape_route_changes, public.landscape_billing_records FROM anon;

-- =============================================================
-- 7. RECURRENCE PLANNER  (mirror of src/lib/tradePacks/landscaping/recurrence.ts + calendar.ts)
-- =============================================================

CREATE OR REPLACE FUNCTION public._landscape_observed(d date)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE extract(dow FROM d)::int WHEN 6 THEN d - 1 WHEN 0 THEN d + 1 ELSE d END;
$$;

-- Holiday name for one date ('us_core' = New Year's, Memorial, Independence, Labor, Thanksgiving, Christmas — observed dates).
CREATE OR REPLACE FUNCTION public._landscape_holiday_name(d date, p_set text, p_extra date[])
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE y int := extract(year FROM d)::int; x date;
BEGIN
  IF p_extra IS NOT NULL AND d = ANY (p_extra) THEN RETURN 'Company closure'; END IF;
  IF p_set IS DISTINCT FROM 'us_core' THEN RETURN NULL; END IF;
  IF d = public._landscape_observed(make_date(y, 1, 1)) OR d = public._landscape_observed(make_date(y + 1, 1, 1)) THEN RETURN 'New Year''s Day'; END IF;
  x := make_date(y, 5, 31);  IF d = x - ((extract(dow FROM x)::int - 1 + 7) % 7) THEN RETURN 'Memorial Day'; END IF;
  IF d = public._landscape_observed(make_date(y, 7, 4)) THEN RETURN 'Independence Day'; END IF;
  x := make_date(y, 9, 1);   IF d = x + ((1 - extract(dow FROM x)::int + 7) % 7) THEN RETURN 'Labor Day'; END IF;
  x := make_date(y, 11, 1);  IF d = x + ((4 - extract(dow FROM x)::int + 7) % 7) + 21 THEN RETURN 'Thanksgiving'; END IF;
  IF d = public._landscape_observed(make_date(y, 12, 25)) THEN RETURN 'Christmas Day'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._landscape_season_interval(p_seasons jsonb, p_month int)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT (s->>'intervalWeeks')::int
  FROM jsonb_array_elements(p_seasons) s
  WHERE public._landscape_month_in_window(p_month, (s->>'fromMonth')::int, (s->>'toMonth')::int)
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._landscape_is_paused(p_contract uuid, d date)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.landscape_contract_pauses p
                 WHERE p.contract_id = p_contract AND d >= p.from_date AND d <= COALESCE(p.to_date, 'infinity'::date));
$$;

CREATE OR REPLACE FUNCTION public.landscape_plan_visits(p_contract_id uuid, p_from date, p_to date)
RETURNS TABLE (o_n int, o_original_date date, o_visit_date date, o_status text, o_reason text, o_holiday_name text, o_shifted boolean, o_interval_weeks int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c landscape_contracts; k int; first_n int; od date; vd date; iv int; hname text; max_shift int; i int; dir int; cand date; moved date;
BEGIN
  SELECT * INTO c FROM landscape_contracts WHERE id = p_contract_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023'; END IF;

  first_n := GREATEST(0, floor((p_from - c.start_date) / 7.0)::int);
  FOR k IN first_n .. first_n + 60 LOOP
    od := c.start_date + k * 7;
    EXIT WHEN od > p_to;
    CONTINUE WHEN od < p_from;
    EXIT WHEN c.end_date IS NOT NULL AND od > c.end_date;

    iv := public._landscape_season_interval(c.seasons, extract(month FROM od)::int);
    CONTINUE WHEN iv IS NULL OR k % iv <> 0;

    o_n := k; o_original_date := od; o_interval_weeks := iv; o_shifted := false; o_holiday_name := NULL; o_reason := NULL;

    IF public._landscape_is_paused(c.id, od) THEN
      o_visit_date := od; o_status := 'skipped'; o_reason := 'paused'; RETURN NEXT; CONTINUE;
    END IF;

    hname := public._landscape_holiday_name(od, c.holiday_set, c.extra_holidays);
    vd := od;
    IF hname IS NOT NULL AND c.holiday_policy <> 'ignore' THEN
      o_holiday_name := hname;
      IF c.holiday_policy = 'skip' THEN
        o_visit_date := od; o_status := 'skipped'; o_reason := 'holiday'; RETURN NEXT; CONTINUE;
      END IF;
      max_shift := LEAST(6, iv * 7 - 1);
      dir := CASE WHEN c.holiday_policy = 'shift_next' THEN 1 ELSE -1 END;
      moved := NULL;
      FOR i IN 1 .. max_shift LOOP
        cand := od + dir * i;
        IF extract(dow FROM cand)::int = ANY (c.workdays) AND public._landscape_holiday_name(cand, c.holiday_set, c.extra_holidays) IS NULL THEN
          moved := cand; EXIT;
        END IF;
      END LOOP;
      IF moved IS NULL THEN
        o_visit_date := od; o_status := 'skipped'; o_reason := 'holiday'; RETURN NEXT; CONTINUE;
      END IF;
      vd := moved; o_shifted := true;
    ELSIF hname IS NOT NULL THEN
      o_holiday_name := hname;
    END IF;

    o_visit_date := vd;
    IF c.end_date IS NOT NULL AND vd > c.end_date THEN
      o_status := 'skipped'; o_reason := 'contract_ended';
    ELSIF public._landscape_is_paused(c.id, vd) THEN
      o_status := 'skipped'; o_reason := 'paused';
    ELSE
      o_status := 'scheduled'; o_reason := NULL;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_plan_visits(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landscape_plan_visits(uuid, date, date) TO service_role;

-- =============================================================
-- 8. JOB PLACEMENT + VISIT GENERATION (idempotent)
-- =============================================================

-- Creates the dispatch job for a scheduled visit. The jobs table forbids a technician being double-booked, so a
-- route day's stops are placed one after another: on a clash the start slides in 15-minute steps (max 6 h).
-- invoice_amount is deliberately NULL: landscaping bills through landscape_run_billing(), never per job.
CREATE OR REPLACE FUNCTION public._landscape_place_job(p_visit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v landscape_visits; c landscape_contracts; cust customers; prop landscape_properties; crew landscape_crews;
  v_try timestamptz; v_job uuid; i int;
BEGIN
  SELECT * INTO v FROM landscape_visits WHERE id = p_visit_id FOR UPDATE;
  IF NOT FOUND OR v.job_id IS NOT NULL OR v.status <> 'scheduled' THEN RETURN; END IF;
  SELECT * INTO c FROM landscape_contracts WHERE id = v.contract_id;
  SELECT * INTO cust FROM customers WHERE id = c.customer_id;
  IF c.property_id IS NOT NULL THEN SELECT * INTO prop FROM landscape_properties WHERE id = c.property_id; END IF;
  IF v.crew_id IS NOT NULL THEN SELECT * INTO crew FROM landscape_crews WHERE id = v.crew_id; END IF;

  v_try := v.scheduled_at;
  FOR i IN 0 .. 23 LOOP
    BEGIN
      INSERT INTO jobs (user_id, customer_id, customer_name, customer_phone, service_type, address,
                        scheduled_datetime, duration_minutes, assigned_technician_id, job_status, dispatch_note)
      VALUES (v.user_id, cust.id, cust.name, cust.phone, c.service_type, COALESCE(prop.address, cust.address),
              v_try, v.planned_minutes, crew.lead_technician_id, 'scheduled',
              'Landscaping: ' || c.title || CASE v.kind WHEN 'addon' THEN ' (add-on)' WHEN 'makeup' THEN ' (make-up)' ELSE '' END)
      RETURNING id INTO v_job;
      UPDATE landscape_visits SET job_id = v_job, scheduled_at = v_try, attention = NULL WHERE id = v.id;
      RETURN;
    EXCEPTION WHEN exclusion_violation THEN
      v_try := v_try + interval '15 minutes';
    END;
  END LOOP;
  UPDATE landscape_visits SET attention = 'No free slot for this crew within 6 hours of the planned time. Re-route or reassign.' WHERE id = v.id;
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_place_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_place_job(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._landscape_seed_tasks(p_visit_id uuid, p_user uuid, p_checklist jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO landscape_visit_tasks (user_id, visit_id, task_key, label, required)
  SELECT p_user, p_visit_id, t->>'key', t->>'label', (t->>'required')::boolean
  FROM jsonb_array_elements(p_checklist) t
  ON CONFLICT (visit_id, task_key) DO NOTHING;
$$;
REVOKE ALL ON FUNCTION public._landscape_seed_tasks(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_seed_tasks(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public._landscape_crew_size(p_crew uuid)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(1, COALESCE((SELECT (CASE WHEN lead_technician_id IS NULL THEN 0 ELSE 1 END) + cardinality(member_ids) FROM landscape_crews WHERE id = p_crew), 1));
$$;
REVOKE ALL ON FUNCTION public._landscape_crew_size(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_crew_size(uuid) TO service_role;

-- Generates (idempotently) the visits for one contract from today through today + p_lookahead days.
CREATE OR REPLACE FUNCTION public._landscape_generate_contract(p_contract_id uuid, p_lookahead int DEFAULT 14)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c landscape_contracts; r record; a landscape_addons; m landscape_visits;
  v_today date; v_vid uuid; v_created int := 0; v_size int; v_at timestamptz; v_key text;
BEGIN
  SELECT * INTO c FROM landscape_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('active', 'paused') THEN RETURN 0; END IF;
  IF NOT public.landscape_pack_allowed(c.user_id) THEN RETURN 0; END IF;
  p_lookahead := LEAST(GREATEST(COALESCE(p_lookahead, 14), 1), 60);
  v_today := (now() AT TIME ZONE c.timezone)::date;
  v_size := public._landscape_crew_size(c.default_crew_id);

  FOR r IN SELECT * FROM public.landscape_plan_visits(c.id, GREATEST(v_today, c.start_date), v_today + p_lookahead) LOOP
    CONTINUE WHEN r.o_reason IN ('paused', 'contract_ended');   -- never stored: they would block regeneration after a resume
    v_at := (r.o_visit_date + c.preferred_time) AT TIME ZONE c.timezone;
    v_vid := NULL;
    INSERT INTO landscape_visits (user_id, contract_id, kind, occurrence_n, original_date, visit_date, scheduled_at,
                                  crew_id, crew_size, status, skip_reason, planned_minutes, price_cents)
    VALUES (c.user_id, c.id, 'maintenance', r.o_n, r.o_original_date, r.o_visit_date, v_at,
            c.default_crew_id, v_size, CASE WHEN r.o_status = 'skipped' THEN 'skipped' ELSE 'scheduled' END, r.o_reason,
            c.duration_minutes, c.visit_price_cents)
    ON CONFLICT (contract_id, occurrence_n) WHERE kind = 'maintenance' DO NOTHING
    RETURNING id INTO v_vid;
    IF v_vid IS NOT NULL AND r.o_status = 'scheduled' THEN
      PERFORM public._landscape_seed_tasks(v_vid, c.user_id, c.checklist);
      PERFORM public._landscape_place_job(v_vid);
      v_created := v_created + 1;
    END IF;
  END LOOP;

  -- Seasonal rounds (fertilization / cleanup / other): ride along with the first maintenance visit of each listed month.
  FOR a IN SELECT * FROM landscape_addons WHERE contract_id = c.id AND active AND kind <> 'snow' AND cardinality(round_months) > 0 LOOP
    FOR m IN
      SELECT DISTINCT ON (date_trunc('month', v.visit_date)) v.*
      FROM landscape_visits v
      WHERE v.contract_id = c.id AND v.kind = 'maintenance' AND v.status = 'scheduled'
        AND v.visit_date BETWEEN v_today AND v_today + p_lookahead
      ORDER BY date_trunc('month', v.visit_date), v.visit_date
    LOOP
      CONTINUE WHEN NOT (extract(month FROM m.visit_date)::int = ANY (a.round_months));
      CONTINUE WHEN NOT public._landscape_month_in_window(extract(month FROM m.visit_date)::int, a.season_from_month, a.season_to_month);
      v_key := 'round:' || to_char(m.visit_date, 'YYYY-MM');
      v_vid := NULL;
      INSERT INTO landscape_visits (user_id, contract_id, kind, addon_id, event_key, original_date, visit_date, scheduled_at,
                                    crew_id, crew_size, status, planned_minutes, price_cents)
      VALUES (c.user_id, c.id, 'addon', a.id, v_key, m.visit_date, m.visit_date, m.scheduled_at + make_interval(mins => m.planned_minutes),
              m.crew_id, m.crew_size, 'scheduled', a.duration_minutes, a.price_cents)
      ON CONFLICT (contract_id, addon_id, event_key) WHERE kind = 'addon' DO NOTHING
      RETURNING id INTO v_vid;
      IF v_vid IS NOT NULL THEN
        PERFORM public._landscape_place_job(v_vid);
        v_created := v_created + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_generate_contract(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_generate_contract(uuid, int) TO service_role;

-- Keeps contracts.status honest: paused while a pause covers today, active otherwise; ended past end_date.
CREATE OR REPLACE FUNCTION public._landscape_reconcile_contract(p_contract_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c landscape_contracts; v_today date; v_paused boolean;
BEGIN
  SELECT * INTO c FROM landscape_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('active', 'paused') THEN RETURN; END IF;
  v_today := (now() AT TIME ZONE c.timezone)::date;
  IF c.end_date IS NOT NULL AND c.end_date < v_today THEN
    UPDATE landscape_contracts SET status = 'ended' WHERE id = c.id;
    RETURN;
  END IF;
  v_paused := public._landscape_is_paused(c.id, v_today);
  IF v_paused AND c.status = 'active' THEN UPDATE landscape_contracts SET status = 'paused' WHERE id = c.id;
  ELSIF NOT v_paused AND c.status = 'paused' THEN UPDATE landscape_contracts SET status = 'active' WHERE id = c.id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_reconcile_contract(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_reconcile_contract(uuid) TO service_role;

-- Cron entry point (service role): reconcile + generate for every allowed tenant. One bad contract never stops the batch.
CREATE OR REPLACE FUNCTION public.landscape_cron_tick(p_lookahead int DEFAULT 14)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_created int := 0; v_n int; v_errors int := 0; v_contracts int := 0;
BEGIN
  FOR r IN SELECT id FROM landscape_contracts WHERE status IN ('active', 'paused') ORDER BY id LOOP
    BEGIN
      PERFORM public._landscape_reconcile_contract(r.id);
      v_n := public._landscape_generate_contract(r.id, p_lookahead);
      v_created := v_created + COALESCE(v_n, 0);
      v_contracts := v_contracts + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'landscape_cron_tick: contract % failed: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object('contracts', v_contracts, 'visits_created', v_created, 'errors', v_errors);
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_cron_tick(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landscape_cron_tick(int) TO service_role;

-- Tenant-callable: generate now for one contract (after activating / editing it) or for all of the tenant's contracts.
CREATE OR REPLACE FUNCTION public.landscape_generate_my_visits(p_contract_id uuid DEFAULT NULL, p_lookahead int DEFAULT 28)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(false); r record; v_total int := 0;
BEGIN
  FOR r IN SELECT id FROM landscape_contracts WHERE user_id = v_owner AND status IN ('active', 'paused') AND (p_contract_id IS NULL OR id = p_contract_id) ORDER BY id LOOP
    PERFORM public._landscape_reconcile_contract(r.id);
    v_total := v_total + public._landscape_generate_contract(r.id, p_lookahead);
  END LOOP;
  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_generate_my_visits(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_generate_my_visits(uuid, int) TO authenticated;

-- =============================================================
-- 9. PAUSE / RESUME
-- =============================================================

CREATE OR REPLACE FUNCTION public.landscape_pause_contract(p_contract_id uuid, p_from date, p_to date DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(true); c landscape_contracts; v_id uuid;
BEGIN
  SELECT * INTO c FROM landscape_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found' USING ERRCODE = 'P0002'; END IF;
  IF c.status NOT IN ('active', 'paused') THEN RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023'; END IF;
  IF p_from IS NULL OR (p_to IS NOT NULL AND p_to < p_from) THEN RAISE EXCEPTION 'invalid_dates' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 500 THEN RAISE EXCEPTION 'reason too long' USING ERRCODE = '22023'; END IF;

  BEGIN
    INSERT INTO landscape_contract_pauses (user_id, contract_id, from_date, to_date, reason)
    VALUES (v_owner, c.id, p_from, p_to, p_reason) RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'pause_overlaps' USING ERRCODE = '23P01';
  END;

  -- Visits already generated inside the window are cancelled (jobs too) so crews are not sent.
  UPDATE jobs SET job_status = 'cancelled'
  WHERE job_status = 'scheduled' AND id IN (
    SELECT job_id FROM landscape_visits
    WHERE contract_id = c.id AND job_id IS NOT NULL AND status = 'scheduled' AND started_at IS NULL
      AND visit_date >= p_from AND visit_date <= COALESCE(p_to, 'infinity'::date));
  UPDATE landscape_visits SET status = 'cancelled', skip_reason = 'paused'
  WHERE contract_id = c.id AND status = 'scheduled' AND started_at IS NULL
    AND visit_date >= p_from AND visit_date <= COALESCE(p_to, 'infinity'::date);

  PERFORM public._landscape_reconcile_contract(c.id);
  INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
  VALUES (v_owner, c.id, 'paused', jsonb_build_object('from', p_from, 'to', p_to, 'reason', p_reason));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.landscape_resume_contract(p_contract_id uuid, p_resume_date date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(true); c landscape_contracts; p landscape_contract_pauses; v_resume date;
BEGIN
  SELECT * INTO c FROM landscape_contracts WHERE id = p_contract_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract_not_found' USING ERRCODE = 'P0002'; END IF;
  v_resume := COALESCE(p_resume_date, (now() AT TIME ZONE c.timezone)::date);

  SELECT * INTO p FROM landscape_contract_pauses
  WHERE contract_id = c.id AND from_date < v_resume AND (to_date IS NULL OR to_date >= v_resume)
  ORDER BY from_date DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_paused' USING ERRCODE = '22023'; END IF;

  UPDATE landscape_contract_pauses SET to_date = v_resume - 1 WHERE id = p.id;

  -- Visits that an (open-ended) pause cancelled at/after the resume date come back through regeneration.
  DELETE FROM landscape_visits
  WHERE contract_id = c.id AND status = 'cancelled' AND skip_reason = 'paused' AND visit_date >= v_resume AND billed_invoice_id IS NULL;

  PERFORM public._landscape_reconcile_contract(c.id);
  PERFORM public._landscape_generate_contract(c.id, 28);
  INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
  VALUES (v_owner, c.id, 'resumed', jsonb_build_object('resume_date', v_resume, 'pause_id', p.id));
END;
$$;

-- A pause that has not started yet can simply be withdrawn.
CREATE OR REPLACE FUNCTION public.landscape_cancel_pause(p_pause_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(true); p landscape_contract_pauses; c landscape_contracts;
BEGIN
  SELECT * INTO p FROM landscape_contract_pauses WHERE id = p_pause_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'pause_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO c FROM landscape_contracts WHERE id = p.contract_id FOR UPDATE;
  IF p.from_date <= (now() AT TIME ZONE c.timezone)::date THEN RAISE EXCEPTION 'pause_already_started' USING ERRCODE = '22023'; END IF;
  DELETE FROM landscape_contract_pauses WHERE id = p.id;
  DELETE FROM landscape_visits WHERE contract_id = c.id AND status = 'cancelled' AND skip_reason = 'paused' AND visit_date >= p.from_date AND visit_date <= COALESCE(p.to_date, 'infinity'::date) AND billed_invoice_id IS NULL;
  PERFORM public._landscape_generate_contract(c.id, 28);
  INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
  VALUES (v_owner, c.id, 'pause_cancelled', jsonb_build_object('from', p.from_date, 'to', p.to_date));
END;
$$;

REVOKE ALL ON FUNCTION public.landscape_pause_contract(uuid, date, date, text), public.landscape_resume_contract(uuid, date), public.landscape_cancel_pause(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_pause_contract(uuid, date, date, text), public.landscape_resume_contract(uuid, date), public.landscape_cancel_pause(uuid) TO authenticated;

-- =============================================================
-- 10. DAY-OF RE-ROUTING  (validation mirrors validateManualOrder() in routing.ts)
-- =============================================================

/*
  The jobs table has a NON-deferrable exclusion constraint (a technician can't overlap themselves). Re-ordering a
  route day moves several of that technician's jobs at once, so a naive UPDATE can trip over a stop that hasn't
  moved yet. Two phases inside one transaction avoid it: (1) park the affected jobs 1000 years ahead (a constant
  shift keeps them mutually disjoint), (2) write the final back-to-back times. If something else genuinely
  clashes, the whole call rolls back with `slot_conflict`.
*/
CREATE OR REPLACE FUNCTION public.landscape_reorder_day(p_crew_id uuid, p_date date, p_visit_ids uuid[], p_reason text DEFAULT NULL, p_buffer_minutes int DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._landscape_require(false);
  v_cur uuid[]; v_locked uuid[]; v_planned uuid[]; v_k int; v_tz text;
  v_cursor timestamptz; v_i int; v_id uuid; v_job uuid; v_minutes int;
BEGIN
  IF p_buffer_minutes IS NULL OR p_buffer_minutes NOT BETWEEN 0 AND 60 THEN RAISE EXCEPTION 'invalid_buffer' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 300 THEN RAISE EXCEPTION 'reason too long' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM landscape_crews WHERE id = p_crew_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'crew_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Lock the whole day in a stable order (id) so two dispatchers can't interleave.
  PERFORM 1 FROM landscape_visits
  WHERE user_id = v_owner AND crew_id = p_crew_id AND visit_date = p_date AND status <> 'cancelled'
  ORDER BY id FOR UPDATE;

  SELECT COALESCE(array_agg(id ORDER BY route_position NULLS LAST, scheduled_at, id), ARRAY[]::uuid[]) INTO v_cur
  FROM landscape_visits WHERE user_id = v_owner AND crew_id = p_crew_id AND visit_date = p_date AND status <> 'cancelled';

  IF p_visit_ids IS NULL OR cardinality(p_visit_ids) <> cardinality(v_cur)
     OR (SELECT count(DISTINCT x) FROM unnest(p_visit_ids) x) <> cardinality(p_visit_ids)
     OR NOT (p_visit_ids <@ v_cur) THEN
    RAISE EXCEPTION 'invalid_order' USING ERRCODE = '22023', DETAIL = 'List every visit of the crew day exactly once.';
  END IF;

  -- Finished / in-progress / skipped stops keep their positions at the head.
  SELECT COALESCE(array_agg(u.id ORDER BY u.ord), ARRAY[]::uuid[]) INTO v_locked
  FROM unnest(v_cur) WITH ORDINALITY u(id, ord) JOIN landscape_visits v ON v.id = u.id
  WHERE v.status IN ('completed', 'skipped', 'in_progress');
  v_k := cardinality(v_locked);
  IF v_k > 0 AND p_visit_ids[1:v_k] IS DISTINCT FROM v_locked THEN
    RAISE EXCEPTION 'locked_stops_cannot_move' USING ERRCODE = '22023';
  END IF;

  IF p_visit_ids = v_cur THEN
    RETURN jsonb_build_object('changed', false, 'order', to_jsonb(v_cur));
  END IF;

  v_planned := p_visit_ids[v_k + 1 : cardinality(p_visit_ids)];

  SELECT c.timezone INTO v_tz FROM landscape_visits v JOIN landscape_contracts c ON c.id = v.contract_id WHERE v.id = p_visit_ids[1];
  IF v_k > 0 THEN
    SELECT max(COALESCE(v.completed_at, v.started_at + make_interval(mins => v.planned_minutes), v.scheduled_at + make_interval(mins => v.planned_minutes)))
      INTO v_cursor FROM landscape_visits v WHERE v.id = ANY (v_locked);
    v_cursor := v_cursor + make_interval(mins => p_buffer_minutes);
  ELSE
    SELECT min(scheduled_at) INTO v_cursor FROM landscape_visits WHERE id = ANY (v_planned);
  END IF;
  IF p_date = (now() AT TIME ZONE COALESCE(v_tz, 'UTC'))::date THEN v_cursor := GREATEST(v_cursor, date_trunc('minute', now()) + interval '1 minute'); END IF;

  BEGIN
    -- Phase 1: park the movable scheduled jobs far ahead.
    UPDATE jobs SET scheduled_datetime = scheduled_datetime + interval '1000 years'
    WHERE job_status = 'scheduled' AND id IN (SELECT job_id FROM landscape_visits WHERE id = ANY (v_planned) AND job_id IS NOT NULL);

    -- Positions for the locked head.
    FOR v_i IN 1 .. v_k LOOP
      UPDATE landscape_visits SET route_position = v_i WHERE id = v_locked[v_i];
    END LOOP;

    -- Phase 2: back-to-back final times in the new order.
    FOR v_i IN 1 .. cardinality(v_planned) LOOP
      v_id := v_planned[v_i];
      SELECT job_id, planned_minutes INTO v_job, v_minutes FROM landscape_visits WHERE id = v_id;
      UPDATE landscape_visits SET route_position = v_k + v_i, scheduled_at = v_cursor WHERE id = v_id;
      IF v_job IS NOT NULL THEN UPDATE jobs SET scheduled_datetime = v_cursor WHERE id = v_job AND job_status = 'scheduled'; END IF;
      v_cursor := v_cursor + make_interval(mins => v_minutes + p_buffer_minutes);
    END LOOP;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'slot_conflict' USING ERRCODE = '23P01', DETAIL = 'Another job for this technician overlaps the new times.';
  END;

  INSERT INTO landscape_route_changes (user_id, crew_id, route_date, before_order, after_order, reason)
  VALUES (v_owner, p_crew_id, p_date, v_cur, p_visit_ids, p_reason);
  RETURN jsonb_build_object('changed', true, 'order', to_jsonb(p_visit_ids));
END;
$$;

-- Crew out (breakdown, sick day): hand planned visits to another crew; they join the END of its route that day.
CREATE OR REPLACE FUNCTION public.landscape_reassign_visits(p_visit_ids uuid[], p_to_crew uuid, p_reason text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._landscape_require(false);
  crew landscape_crews; v landscape_visits; v_cursor timestamptz; v_pos int; v_moved int := 0; v_before uuid[]; v_after uuid[];
BEGIN
  IF p_visit_ids IS NULL OR cardinality(p_visit_ids) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_visits' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 300 THEN RAISE EXCEPTION 'reason too long' USING ERRCODE = '22023'; END IF;
  SELECT * INTO crew FROM landscape_crews WHERE id = p_to_crew AND user_id = v_owner AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'crew_not_found' USING ERRCODE = 'P0002'; END IF;

  FOR v IN SELECT * FROM landscape_visits WHERE id = ANY (p_visit_ids) AND user_id = v_owner ORDER BY visit_date, route_position NULLS LAST, id FOR UPDATE LOOP
    CONTINUE WHEN v.status <> 'scheduled' OR v.started_at IS NOT NULL OR v.crew_id IS NOT DISTINCT FROM p_to_crew;

    SELECT COALESCE(array_agg(id ORDER BY route_position NULLS LAST, scheduled_at, id), ARRAY[]::uuid[]) INTO v_before
    FROM landscape_visits WHERE user_id = v_owner AND crew_id = p_to_crew AND visit_date = v.visit_date AND status <> 'cancelled';

    SELECT max(scheduled_at + make_interval(mins => planned_minutes + 10)), COALESCE(max(route_position), 0)
      INTO v_cursor, v_pos
    FROM landscape_visits WHERE user_id = v_owner AND crew_id = p_to_crew AND visit_date = v.visit_date AND status <> 'cancelled';
    v_cursor := GREATEST(COALESCE(v_cursor, v.scheduled_at), v.scheduled_at);

    BEGIN
      UPDATE landscape_visits SET crew_id = p_to_crew, crew_size = public._landscape_crew_size(p_to_crew),
             route_position = v_pos + 1, scheduled_at = v_cursor WHERE id = v.id;
      IF v.job_id IS NOT NULL THEN
        UPDATE jobs SET assigned_technician_id = crew.lead_technician_id, scheduled_datetime = v_cursor
        WHERE id = v.job_id AND job_status = 'scheduled';
      END IF;
    EXCEPTION WHEN exclusion_violation THEN
      RAISE EXCEPTION 'slot_conflict' USING ERRCODE = '23P01';
    END;

    v_after := v_before || v.id;
    INSERT INTO landscape_route_changes (user_id, crew_id, route_date, before_order, after_order, reason)
    VALUES (v_owner, p_to_crew, v.visit_date, v_before, v_after, COALESCE(p_reason, 'reassigned'));
    v_moved := v_moved + 1;
  END LOOP;
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.landscape_reorder_day(uuid, date, uuid[], text, int), public.landscape_reassign_visits(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_reorder_day(uuid, date, uuid[], text, int), public.landscape_reassign_visits(uuid[], uuid, text) TO authenticated;

-- =============================================================
-- 11. WEATHER SKIPS + SNOW EVENTS
-- =============================================================

CREATE OR REPLACE FUNCTION public._landscape_apply_weather(p_visit_id uuid, p_skip boolean, p_reasons text[], p_forecast jsonb, p_makeup_date date, p_source text, p_owner uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v landscape_visits; c landscape_contracts; v_snapshot jsonb; v_new uuid;
BEGIN
  SELECT * INTO v FROM landscape_visits WHERE id = p_visit_id AND (p_owner IS NULL OR user_id = p_owner) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.landscape_pack_allowed(v.user_id) THEN RAISE EXCEPTION 'landscaping_not_enabled' USING ERRCODE = '42501'; END IF;
  IF v.status = 'skipped' AND v.skip_reason = 'weather' THEN RETURN 'already_skipped'; END IF;   -- idempotent
  IF v.status <> 'scheduled' OR v.started_at IS NOT NULL THEN RETURN 'not_skippable'; END IF;

  v_snapshot := jsonb_build_object('source', COALESCE(left(p_source, 40), 'unknown'), 'decision', CASE WHEN p_skip THEN 'skip' ELSE 'proceed' END,
                                   'reasons', to_jsonb(COALESCE(p_reasons, ARRAY[]::text[])), 'forecast', COALESCE(p_forecast, '{}'::jsonb), 'at', now());
  IF octet_length(v_snapshot::text) > 3500 THEN v_snapshot := v_snapshot - 'forecast'; END IF;

  IF NOT p_skip THEN
    UPDATE landscape_visits SET weather = v_snapshot WHERE id = v.id;
    RETURN 'kept';
  END IF;

  UPDATE landscape_visits SET status = 'skipped', skip_reason = 'weather', weather = v_snapshot WHERE id = v.id;
  IF v.job_id IS NOT NULL THEN UPDATE jobs SET job_status = 'cancelled' WHERE id = v.job_id AND job_status = 'scheduled'; END IF;

  SELECT * INTO c FROM landscape_contracts WHERE id = v.contract_id;
  IF p_makeup_date IS NOT NULL AND p_makeup_date > v.visit_date AND p_makeup_date <= v.visit_date + 14
     AND c.weather_policy->>'makeup' = 'next_workday' AND v.kind <> 'makeup'
     AND (c.end_date IS NULL OR p_makeup_date <= c.end_date) AND NOT public._landscape_is_paused(c.id, p_makeup_date) THEN
    INSERT INTO landscape_visits (user_id, contract_id, kind, makeup_for, original_date, visit_date, scheduled_at, crew_id, crew_size,
                                  status, planned_minutes, price_cents, addon_id)
    VALUES (v.user_id, v.contract_id, 'makeup', v.id, v.original_date, p_makeup_date,
            (p_makeup_date + c.preferred_time) AT TIME ZONE c.timezone, v.crew_id, v.crew_size, 'scheduled', v.planned_minutes, v.price_cents, NULL)
    ON CONFLICT (makeup_for) WHERE makeup_for IS NOT NULL DO NOTHING
    RETURNING id INTO v_new;
    IF v_new IS NOT NULL THEN
      PERFORM public._landscape_seed_tasks(v_new, v.user_id, c.checklist);
      PERFORM public._landscape_place_job(v_new);
    END IF;
  END IF;
  RETURN 'skipped';
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_apply_weather(uuid, boolean, text[], jsonb, date, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_apply_weather(uuid, boolean, text[], jsonb, date, text, uuid) TO service_role;

-- Cron: the decision comes from the TS engine + weather adapter; the database only applies it.
CREATE OR REPLACE FUNCTION public.landscape_apply_weather_decision(p_visit_id uuid, p_skip boolean, p_reasons text[], p_forecast jsonb, p_makeup_date date, p_source text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._landscape_apply_weather(p_visit_id, p_skip, p_reasons, p_forecast, p_makeup_date, p_source, NULL);
$$;
REVOKE ALL ON FUNCTION public.landscape_apply_weather_decision(uuid, boolean, text[], jsonb, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landscape_apply_weather_decision(uuid, boolean, text[], jsonb, date, text) TO service_role;

-- Dispatcher decides by hand ("rained out, push to Thursday").
CREATE OR REPLACE FUNCTION public.landscape_skip_for_weather(p_visit_id uuid, p_reason text DEFAULT NULL, p_makeup_date date DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(false);
BEGIN
  IF p_reason IS NOT NULL AND char_length(p_reason) > 200 THEN RAISE EXCEPTION 'reason too long' USING ERRCODE = '22023'; END IF;
  RETURN public._landscape_apply_weather(p_visit_id, true, ARRAY[COALESCE(NULLIF(btrim(p_reason), ''), 'Dispatcher decision')], NULL, p_makeup_date, 'manual', v_owner);
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_skip_for_weather(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_skip_for_weather(uuid, text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.landscape_visits_for_weather(p_date date)
RETURNS TABLE (visit_id uuid, user_id uuid, contract_id uuid, visit_date date, lat numeric, lng numeric, weather_policy jsonb,
               workdays int[], holiday_set text, extra_holidays date[], occupied date[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.user_id, v.contract_id, v.visit_date, p.lat, p.lng, c.weather_policy,
         c.workdays::int[], c.holiday_set, c.extra_holidays,
         ARRAY(SELECT o.visit_date FROM landscape_visits o
               WHERE o.contract_id = v.contract_id AND o.status IN ('scheduled', 'in_progress') AND o.visit_date BETWEEN p_date AND p_date + 8)
  FROM landscape_visits v
  JOIN landscape_contracts c ON c.id = v.contract_id
  LEFT JOIN landscape_properties p ON p.id = c.property_id
  WHERE v.visit_date = p_date AND v.status = 'scheduled' AND v.started_at IS NULL AND v.kind <> 'addon'
    AND c.status = 'active' AND jsonb_array_length(c.weather_policy->'rules') > 0
    AND public.landscape_pack_allowed(v.user_id);
$$;
REVOKE ALL ON FUNCTION public.landscape_visits_for_weather(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landscape_visits_for_weather(date) TO service_role;

-- Snow: one event per (contract, add-on, date); re-recording the same storm is a no-op.
CREATE OR REPLACE FUNCTION public._landscape_snow_event(p_owner uuid, p_date date, p_snow_cm numeric)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_vid uuid; v_n int := 0;
BEGIN
  IF p_snow_cm IS NULL OR p_snow_cm < 0.5 OR p_snow_cm > 200 THEN RAISE EXCEPTION 'invalid_snow_depth' USING ERRCODE = '22023'; END IF;
  IF p_date IS NULL OR p_date < current_date - 7 OR p_date > current_date + 3 THEN RAISE EXCEPTION 'invalid_event_date' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT ad.id AS addon_id, ad.price_cents AS addon_price, ad.duration_minutes AS addon_minutes, c.*
    FROM landscape_addons ad JOIN landscape_contracts c ON c.id = ad.contract_id
    WHERE c.user_id = p_owner AND c.status = 'active' AND ad.active AND ad.kind = 'snow'
      AND ad.snow_trigger_cm <= p_snow_cm AND p_date >= c.start_date AND (c.end_date IS NULL OR p_date <= c.end_date)
      AND public._landscape_month_in_window(extract(month FROM p_date)::int, ad.season_from_month, ad.season_to_month)
      AND NOT public._landscape_is_paused(c.id, p_date)
    ORDER BY c.id
  LOOP
    v_vid := NULL;
    INSERT INTO landscape_visits (user_id, contract_id, kind, addon_id, event_key, original_date, visit_date, scheduled_at, crew_id, crew_size,
                                  status, planned_minutes, price_cents)
    VALUES (p_owner, r.id, 'addon', r.addon_id, 'snow:' || to_char(p_date, 'YYYY-MM-DD'), p_date, p_date,
            (p_date + r.preferred_time) AT TIME ZONE r.timezone, r.default_crew_id, public._landscape_crew_size(r.default_crew_id),
            'scheduled', r.addon_minutes, r.addon_price)
    ON CONFLICT (contract_id, addon_id, event_key) WHERE kind = 'addon' DO NOTHING
    RETURNING id INTO v_vid;
    IF v_vid IS NOT NULL THEN
      PERFORM public._landscape_seed_tasks(v_vid, p_owner, r.checklist);
      PERFORM public._landscape_place_job(v_vid);
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_snow_event(uuid, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_snow_event(uuid, date, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.landscape_record_snow_event(p_date date, p_snow_cm numeric)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(false);
BEGIN
  RETURN public._landscape_snow_event(v_owner, p_date, p_snow_cm);
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_record_snow_event(date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_record_snow_event(date, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.landscape_record_snow_event_for(p_owner uuid, p_date date, p_snow_cm numeric)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.landscape_pack_allowed(p_owner) THEN RETURN 0; END IF;
  RETURN public._landscape_snow_event(p_owner, p_date, p_snow_cm);
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_record_snow_event_for(uuid, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landscape_record_snow_event_for(uuid, date, numeric) TO service_role;

-- =============================================================
-- 12. VISIT LIFECYCLE: start, checklist, skip, complete (before/after photo gate)
-- =============================================================

CREATE OR REPLACE FUNCTION public.landscape_start_visit(p_visit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(false); v landscape_visits;
BEGIN
  SELECT * INTO v FROM landscape_visits WHERE id = p_visit_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v.status = 'in_progress' THEN RETURN; END IF;
  IF v.status <> 'scheduled' THEN RAISE EXCEPTION 'visit_closed' USING ERRCODE = '22023'; END IF;
  UPDATE landscape_visits SET status = 'in_progress', started_at = COALESCE(started_at, now()) WHERE id = v.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.landscape_set_task(p_visit_id uuid, p_task_key text, p_state text, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(false); v landscape_visits;
BEGIN
  IF p_state NOT IN ('todo', 'done', 'na') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE = '22023'; END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN RAISE EXCEPTION 'note too long' USING ERRCODE = '22023'; END IF;
  IF p_state = 'na' AND char_length(btrim(COALESCE(p_note, ''))) < 3 THEN RAISE EXCEPTION 'note_required_for_na' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM landscape_visits WHERE id = p_visit_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v.status NOT IN ('scheduled', 'in_progress') THEN RAISE EXCEPTION 'visit_closed' USING ERRCODE = '22023'; END IF;
  UPDATE landscape_visit_tasks
  SET state = p_state, note = NULLIF(btrim(p_note), ''),
      done_by = CASE WHEN p_state = 'todo' THEN NULL ELSE auth.uid() END,
      done_at = CASE WHEN p_state = 'todo' THEN NULL ELSE now() END
  WHERE visit_id = v.id AND task_key = p_task_key AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.landscape_skip_visit(p_visit_id uuid, p_reason text DEFAULT 'manual', p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._landscape_require(false); v landscape_visits;
BEGIN
  IF p_reason NOT IN ('manual', 'crew_unavailable') THEN RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023'; END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 2000 THEN RAISE EXCEPTION 'note too long' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v FROM landscape_visits WHERE id = p_visit_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v.status = 'skipped' THEN RETURN; END IF;
  IF v.status NOT IN ('scheduled', 'in_progress') THEN RAISE EXCEPTION 'visit_closed' USING ERRCODE = '22023'; END IF;
  UPDATE landscape_visits SET status = 'skipped', skip_reason = p_reason, notes = COALESCE(NULLIF(btrim(p_note), ''), notes) WHERE id = v.id;
  IF v.job_id IS NOT NULL THEN UPDATE jobs SET job_status = 'cancelled' WHERE id = v.job_id AND job_status IN ('scheduled', 'en_route'); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.landscape_complete_visit(p_visit_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._landscape_require(false); v landscape_visits; c landscape_contracts;
  v_open int; v_before int; v_after int; v_job_status text;
BEGIN
  SELECT * INTO v FROM landscape_visits WHERE id = p_visit_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v.status = 'completed' THEN RETURN jsonb_build_object('status', 'already_completed'); END IF;   -- idempotent
  IF v.status NOT IN ('scheduled', 'in_progress') THEN RAISE EXCEPTION 'visit_closed' USING ERRCODE = '22023'; END IF;

  SELECT count(*) INTO v_open FROM landscape_visit_tasks WHERE visit_id = v.id AND required AND state = 'todo';
  IF v_open > 0 THEN RAISE EXCEPTION 'required_tasks_open' USING ERRCODE = '22023', DETAIL = v_open || ' required task(s) still open'; END IF;

  SELECT * INTO c FROM landscape_contracts WHERE id = v.contract_id;
  IF c.require_photos THEN
    IF v.job_id IS NULL THEN RAISE EXCEPTION 'job_missing' USING ERRCODE = '22023', DETAIL = 'This visit has no job to attach photos to.'; END IF;
    SELECT count(*) FILTER (WHERE kind = 'before'), count(*) FILTER (WHERE kind = 'after') INTO v_before, v_after
    FROM job_photos WHERE job_id = v.job_id AND user_id = v_owner;
    IF v_before < 1 OR v_after < 1 THEN
      RAISE EXCEPTION 'photos_required' USING ERRCODE = '22023', DETAIL = format('before=%s after=%s', v_before, v_after);
    END IF;
  END IF;

  UPDATE landscape_visits SET status = 'completed', completed_at = now(), completed_by = auth.uid() WHERE id = v.id;
  IF v.job_id IS NOT NULL THEN
    SELECT job_status INTO v_job_status FROM jobs WHERE id = v.job_id FOR UPDATE;
    IF v_job_status = 'scheduled' OR v_job_status = 'en_route' THEN UPDATE jobs SET job_status = 'in_progress' WHERE id = v.job_id; END IF;
    IF v_job_status IS NOT NULL AND v_job_status <> 'cancelled' AND v_job_status <> 'completed' THEN UPDATE jobs SET job_status = 'completed' WHERE id = v.job_id; END IF;
  END IF;
  RETURN jsonb_build_object('status', 'completed');
END;
$$;

REVOKE ALL ON FUNCTION public.landscape_start_visit(uuid), public.landscape_set_task(uuid, text, text, text),
  public.landscape_skip_visit(uuid, text, text), public.landscape_complete_visit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_start_visit(uuid), public.landscape_set_task(uuid, text, text, text),
  public.landscape_skip_visit(uuid, text, text), public.landscape_complete_visit(uuid) TO authenticated;

-- =============================================================
-- 13. BATCH RECURRING INVOICING  (mirror of billing.ts; drafts only, no payment provider involved)
-- =============================================================

-- Days of `p_period` (YYYY-MM) on which the contract is in force and not paused.
CREATE OR REPLACE FUNCTION public._landscape_active_days(p_contract uuid, p_period text)
RETURNS TABLE (active_days int, total_days int) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE c landscape_contracts; v_start date := to_date(p_period || '-01', 'YYYY-MM-DD'); v_end date; v_from date; v_to date;
BEGIN
  v_end := (v_start + interval '1 month' - interval '1 day')::date;
  total_days := v_end - v_start + 1;
  SELECT * INTO c FROM landscape_contracts WHERE id = p_contract;
  v_from := GREATEST(c.start_date, v_start);
  v_to := LEAST(COALESCE(c.end_date, v_end), v_end);
  IF v_to < v_from THEN active_days := 0; RETURN NEXT; RETURN; END IF;
  SELECT count(*)::int INTO active_days
  FROM generate_series(v_from, v_to, interval '1 day') g(d)
  WHERE NOT public._landscape_is_paused(p_contract, g.d::date);
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public._landscape_active_days(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_active_days(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.landscape_run_billing(p_period text, p_contract_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public._landscape_require(true);
  v_end date; c landscape_contracts; cust customers; v landscape_visits; rec record;
  v_lines jsonb; v_ids uuid[]; v_sub bigint; v_tax bigint; v_total bigint; v_amount bigint; v_inv uuid;
  v_active int; v_days int; v_label text;
  n_created int := 0; n_existing int := 0; n_nothing int := 0; n_skipped int := 0; v_sum bigint := 0; v_invoices jsonb := '[]'::jsonb;
BEGIN
  IF p_period IS NULL OR p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023'; END IF;
  v_end := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date;
  IF v_end > current_date + 31 THEN RAISE EXCEPTION 'period_in_future' USING ERRCODE = '22023'; END IF;

  -- Serialise concurrent runs for the same tenant+period (double-click, two dispatchers, retried request).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':landscape_billing:' || p_period, 0));

  -- A voided invoice releases its period so it can be billed again.
  FOR rec IN
    SELECT b.id, b.invoice_id FROM landscape_billing_records b JOIN invoices i ON i.id = b.invoice_id
    WHERE b.user_id = v_owner AND b.period = p_period AND i.status = 'void'
      AND (p_contract_ids IS NULL OR b.contract_id = ANY (p_contract_ids))
  LOOP
    UPDATE landscape_visits SET billed_invoice_id = NULL, billed_at = NULL WHERE billed_invoice_id = rec.invoice_id;
    DELETE FROM landscape_billing_records WHERE id = rec.id;
  END LOOP;

  FOR c IN SELECT * FROM landscape_contracts WHERE user_id = v_owner AND status <> 'draft' AND (p_contract_ids IS NULL OR id = ANY (p_contract_ids)) ORDER BY id LOOP
    IF EXISTS (SELECT 1 FROM landscape_billing_records WHERE contract_id = c.id AND period = p_period) THEN
      n_existing := n_existing + 1; CONTINUE;
    END IF;

    v_lines := '[]'::jsonb; v_ids := ARRAY[]::uuid[];

    IF c.billing_mode = 'monthly_flat' THEN
      SELECT a.active_days, a.total_days INTO v_active, v_days FROM public._landscape_active_days(c.id, p_period) a;
      v_amount := CASE WHEN v_active = v_days THEN c.monthly_fee_cents ELSE round(c.monthly_fee_cents::numeric * v_active / v_days) END;
      IF v_active > 0 AND v_amount > 0 THEN
        v_label := c.title || ' — ' || to_char(to_date(p_period || '-01', 'YYYY-MM-DD'), 'FMMonth YYYY')
                   || CASE WHEN v_active = v_days THEN '' ELSE format(' (%s of %s days)', v_active, v_days) END;
        v_lines := v_lines || jsonb_build_object('description', v_label, 'quantity', 1, 'unit_price_cents', v_amount);
      END IF;
    END IF;

    FOR v IN
      SELECT * FROM landscape_visits
      WHERE contract_id = c.id AND status = 'completed' AND billed_invoice_id IS NULL AND visit_date <= v_end AND price_cents > 0
      ORDER BY visit_date, id FOR UPDATE
    LOOP
      IF c.billing_mode = 'monthly_flat' AND v.kind IN ('maintenance', 'makeup') THEN
        v_ids := v_ids || v.id;              -- covered by the flat fee: mark billed, don't itemise
      ELSE
        v_lines := v_lines || jsonb_build_object('description',
          c.title || ' — ' || CASE WHEN v.kind = 'addon' THEN 'add-on, ' ELSE 'visit, ' END || to_char(v.visit_date, 'Dy, Mon FMDD'),
          'quantity', 1, 'unit_price_cents', v.price_cents);
        v_ids := v_ids || v.id;
      END IF;
    END LOOP;

    IF jsonb_array_length(v_lines) = 0 THEN n_nothing := n_nothing + 1; CONTINUE; END IF;

    SELECT COALESCE(sum((l->>'quantity')::int * (l->>'unit_price_cents')::bigint), 0) INTO v_sub FROM jsonb_array_elements(v_lines) l;
    v_tax := CASE WHEN c.tax_percent > 0 THEN round(v_sub::numeric * c.tax_percent / 100) ELSE 0 END;
    v_total := v_sub + v_tax;

    SELECT * INTO cust FROM customers WHERE id = c.customer_id AND user_id = v_owner;
    IF NOT FOUND THEN n_skipped := n_skipped + 1; CONTINUE; END IF;

    BEGIN
      INSERT INTO invoices (user_id, customer_id, customer_name, customer_email, customer_phone, line_items, tax_percent, notes, status)
      VALUES (v_owner, cust.id, cust.name, cust.email, cust.phone, v_lines, c.tax_percent,
              'Landscaping contract "' || c.title || '" — ' || p_period, 'draft')
      RETURNING id INTO v_inv;
      INSERT INTO landscape_billing_records (user_id, contract_id, period, invoice_id, subtotal_cents, tax_cents, total_cents, visit_ids)
      VALUES (v_owner, c.id, p_period, v_inv, v_sub, v_tax, v_total, v_ids);
      UPDATE landscape_visits SET billed_invoice_id = v_inv, billed_at = now() WHERE id = ANY (v_ids);
      INSERT INTO landscape_contract_events (user_id, contract_id, event, detail)
      VALUES (v_owner, c.id, 'billed', jsonb_build_object('period', p_period, 'invoice_id', v_inv, 'total_cents', v_total));
      n_created := n_created + 1; v_sum := v_sum + v_total;
      v_invoices := v_invoices || jsonb_build_object('contract_id', c.id, 'invoice_id', v_inv, 'total_cents', v_total);
    EXCEPTION WHEN unique_violation THEN
      n_existing := n_existing + 1;        -- lost a race: the other run's invoice stands, ours rolled back
    END;
  END LOOP;

  RETURN jsonb_build_object('period', p_period, 'created', n_created, 'skipped_existing', n_existing, 'nothing_to_bill', n_nothing,
                            'skipped_no_customer', n_skipped, 'total_cents', v_sum, 'invoices', v_invoices);
END;
$$;
REVOKE ALL ON FUNCTION public.landscape_run_billing(text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landscape_run_billing(text, uuid[]) TO authenticated;

COMMENT ON TABLE public.landscape_visits IS 'Landscaping pack: one row per generated visit. Written only by SECURITY DEFINER RPCs; unique keys make generation idempotent.';
COMMENT ON TABLE public.landscape_billing_records IS 'Landscaping pack: UNIQUE (contract_id, period) is the batch-invoicing idempotency key.';

-- =============================================================
-- 14. PRIVILEGE HARDENING
-- =============================================================
-- Trigger functions and internal helpers are never called by clients. (The IMMUTABLE _landscape_valid_* /
-- _landscape_month_in_window / _landscape_observed / _landscape_holiday_name / _landscape_season_interval helpers
-- stay executable: CHECK constraints run them with the caller's privileges.)
REVOKE ALL ON FUNCTION public._landscape_append_only(), public._landscape_install_guard(), public._landscape_validate_refs(),
  public._landscape_contract_after(), public._landscape_is_paused(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landscape_is_paused(uuid, date) TO service_role;
