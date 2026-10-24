/*
  # AI Takeoff & Estimating

  Upload plans / blueprints / photos -> the AI extracts rooms, fixtures and
  quantities with a confidence per line -> quantities are priced from the
  Price Book and the supplier catalog (inventory_part_vendors) -> staff correct
  anything uncertain -> the takeoff converts to a tiered (Good/Better/Best)
  DRAFT quote. Nothing is ever sent to a customer by the AI.

  ## Tables
  - takeoff_projects      one per set of plans: files, settings (markup, labor rate,
                          tax), analysis summary/assumptions, link to the quote.
  - takeoff_rooms         rooms the AI (or staff) identified, with dimensions.
  - takeoff_items         priced line items. Keeps the AI's ORIGINAL quantity
                          (ai_quantity) next to the human-corrected one, so every
                          correction is measurable.
  - takeoff_item_changes  append-only audit trail of human edits, written only by a
                          trigger (clients cannot forge or erase it).
  - takeoff_usage         per-user hourly quota counter (service-role only).

  ## Security
  - Same account model as the rest of the app: every row is scoped to
    get_account_owner_id(), so owners AND their staff can work a takeoff, and
    nobody can see another tenant's.
  - Cross-tenant references (price book item, part, vendor, room) are rejected
    by takeoff_refs_ok() in the INSERT/UPDATE policies.
  - Plans live in a PRIVATE bucket, folder-scoped to the account owner id.
  - takeoff_replace_ai_results() is SECURITY INVOKER: RLS still applies, and it
    swaps the AI lines atomically (staff-added lines are preserved).
  - Cost / margin columns are hidden in the UI unless the viewer is the owner or
    has can_view_billing. (Costs are readable by account staff at the database
    level, exactly like inventory_parts costs already are.)

  NOTE: keep this file's timestamp AFTER your newest migration.
*/


-- 0. Preflight ---------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads', 'quotes', 'price_book_items', 'inventory_parts', 'inventory_vendors'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Table public.% is missing: run the migration that creates it first.', t;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.takeoff_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 1) takeoff_projects
-- =============================================================
CREATE TABLE IF NOT EXISTS takeoff_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),

  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  trade text CHECK (trade IS NULL OR length(trade) <= 60),
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),

  customer_name text NOT NULL DEFAULT '' CHECK (length(customer_name) <= 160),
  customer_phone text CHECK (customer_phone IS NULL OR length(customer_phone) <= 40),
  customer_email text CHECK (customer_email IS NULL OR length(customer_email) <= 200),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'analyzing', 'review', 'converted', 'failed')),
  source_files jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- analysis output (summary level; the detail lives in rooms/items)
  ai_summary text,
  plan_quality text CHECK (plan_quality IS NULL OR plan_quality IN ('clear', 'fair', 'poor')),
  scale_note text,
  overall_confidence numeric(3, 2) CHECK (overall_confidence IS NULL OR overall_confidence BETWEEN 0 AND 1),
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_info jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  analysis_error text,
  analysis_started_at timestamptz,
  analyzed_at timestamptz,

  -- pricing settings (editable by staff)
  markup_percent numeric(6, 2) NOT NULL DEFAULT 30 CHECK (markup_percent BETWEEN 0 AND 500),
  labor_rate_cents integer NOT NULL DEFAULT 0 CHECK (labor_rate_cents >= 0),
  labor_cost_rate_cents integer CHECK (labor_cost_rate_cents IS NULL OR labor_cost_rate_cents >= 0),
  tax_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 100),
  labor_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail_level text NOT NULL DEFAULT 'itemized' CHECK (detail_level IN ('itemized', 'summary')),

  -- human sign-off + conversion
  approved_by uuid,
  approved_at timestamptz,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  converted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT takeoff_projects_files_is_array CHECK (jsonb_typeof(source_files) = 'array' AND jsonb_array_length(source_files) <= 12),
  CONSTRAINT takeoff_projects_assumptions_is_array CHECK (jsonb_typeof(assumptions) = 'array'),
  CONSTRAINT takeoff_projects_missing_is_array CHECK (jsonb_typeof(missing_info) = 'array'),
  CONSTRAINT takeoff_projects_warnings_is_array CHECK (jsonb_typeof(warnings) = 'array'),
  CONSTRAINT takeoff_projects_overrides_is_object CHECK (jsonb_typeof(labor_overrides) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_takeoff_projects_owner ON takeoff_projects (account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_takeoff_projects_quote ON takeoff_projects (quote_id) WHERE quote_id IS NOT NULL;

-- =============================================================
-- 2) takeoff_rooms
-- =============================================================
CREATE TABLE IF NOT EXISTS takeoff_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES takeoff_projects(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,

  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  room_type text NOT NULL DEFAULT 'other',
  level text NOT NULL DEFAULT 'Main',
  length_ft numeric(8, 2) CHECK (length_ft IS NULL OR length_ft > 0),
  width_ft numeric(8, 2) CHECK (width_ft IS NULL OR width_ft > 0),
  height_ft numeric(6, 2) CHECK (height_ft IS NULL OR height_ft > 0),
  area_sqft numeric(10, 1) CHECK (area_sqft IS NULL OR area_sqft > 0),
  confidence numeric(3, 2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  evidence text NOT NULL DEFAULT '',
  source_ref text,
  flags text[] NOT NULL DEFAULT '{}',
  created_by_human boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_rooms_project ON takeoff_rooms (project_id, sort_order);

-- =============================================================
-- 3) takeoff_items
-- =============================================================
CREATE TABLE IF NOT EXISTS takeoff_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES takeoff_projects(id) ON DELETE CASCADE,
  room_id uuid REFERENCES takeoff_rooms(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,

  kind text NOT NULL DEFAULT 'material' CHECK (kind IN ('fixture', 'material', 'labor', 'fee')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 160),
  category text NOT NULL DEFAULT 'General' CHECK (length(category) <= 40),
  unit text NOT NULL DEFAULT 'ea' CHECK (length(unit) <= 12),

  net_quantity numeric(12, 2) NOT NULL CHECK (net_quantity >= 0),
  waste_percent numeric(5, 1) NOT NULL DEFAULT 0 CHECK (waste_percent BETWEEN 0 AND 100),
  quantity integer NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
  ai_quantity numeric(12, 2),

  basis text NOT NULL DEFAULT 'inferred' CHECK (basis IN ('counted', 'measured', 'inferred', 'assumed', 'manual')),
  confidence numeric(3, 2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  evidence text NOT NULL DEFAULT '',
  source_ref text,
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'human')),
  tier_scope text NOT NULL DEFAULT 'all' CHECK (tier_scope IN ('all', 'better_plus', 'best_only')),

  labor_hours_each numeric(8, 3) CHECK (labor_hours_each IS NULL OR labor_hours_each >= 0),
  labor_included boolean NOT NULL DEFAULT false,

  price_source text NOT NULL DEFAULT 'none' CHECK (price_source IN ('price_book', 'supplier_catalog', 'ai_estimate', 'manual', 'none')),
  price_locked boolean NOT NULL DEFAULT false,
  price_book_item_id uuid REFERENCES price_book_items(id) ON DELETE SET NULL,
  inventory_part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES inventory_vendors(id) ON DELETE SET NULL,
  vendor_name text,
  vendor_sku text,
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  unit_cost_cents integer CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  unit_price_cents integer CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  price_confidence numeric(3, 2) NOT NULL DEFAULT 0 CHECK (price_confidence BETWEEN 0 AND 1),
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'ambiguous', 'unmatched', 'manual')),
  match_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  flags text[] NOT NULL DEFAULT '{}',

  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'confirmed', 'edited', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT takeoff_items_candidates_is_array CHECK (jsonb_typeof(match_candidates) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_takeoff_items_project ON takeoff_items (project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_takeoff_items_room ON takeoff_items (room_id) WHERE room_id IS NOT NULL;

-- =============================================================
-- 4) takeoff_item_changes — append-only audit trail
-- =============================================================
CREATE TABLE IF NOT EXISTS takeoff_item_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES takeoff_projects(id) ON DELETE CASCADE,
  item_id uuid NOT NULL, -- deliberately no FK: the trail outlives the line
  field text NOT NULL,
  old_value text,
  new_value text,
  changed_by uuid DEFAULT auth.uid(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_takeoff_item_changes_project ON takeoff_item_changes (project_id, changed_at DESC);

-- =============================================================
-- 5) takeoff_usage + atomic quota (service role only)
-- =============================================================
CREATE TABLE IF NOT EXISTS takeoff_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE takeoff_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the takeoff-analyze Edge Function (service role) touches it.

CREATE OR REPLACE FUNCTION public.consume_takeoff_quota(
  p_user_id uuid,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO takeoff_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_takeoff_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_takeoff_quota(uuid, integer, integer) TO service_role;

-- =============================================================
-- 6) Link: one quote per takeoff
-- =============================================================
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS takeoff_project_id uuid REFERENCES takeoff_projects(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_takeoff_project
  ON quotes (takeoff_project_id) WHERE takeoff_project_id IS NOT NULL;

COMMENT ON COLUMN quotes.takeoff_project_id IS
  'Set when the quote was created from an AI Takeoff (always a human-reviewed draft). Not exposed by get_quote_for_token().';

-- =============================================================
-- 7) Cross-tenant reference guard
-- =============================================================
CREATE OR REPLACE FUNCTION public.takeoff_row_owner_ok(p_row jsonb, p_owner uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- Tables in the wild name their tenant column differently (user_id / owner_id / account_owner_id / account_id).
  -- Reading it through jsonb never fails on a missing column. A row with no tenant column at all is shared.
  SELECT CASE
    WHEN p_row ?| ARRAY['user_id', 'owner_id', 'account_owner_id', 'account_id']
      THEN COALESCE(p_row ->> 'user_id', p_row ->> 'owner_id', p_row ->> 'account_owner_id', p_row ->> 'account_id') = p_owner::text
    ELSE true
  END;
$$;

CREATE OR REPLACE FUNCTION public.takeoff_refs_ok(
  p_project uuid,
  p_room uuid,
  p_book_item uuid,
  p_part uuid,
  p_vendor uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM takeoff_projects p WHERE p.id = p_project AND p.account_owner_id = public.get_account_owner_id())
    AND (p_room IS NULL OR EXISTS (SELECT 1 FROM takeoff_rooms r WHERE r.id = p_room AND r.project_id = p_project))
    AND (p_book_item IS NULL OR EXISTS (
          SELECT 1 FROM price_book_items b
          WHERE b.id = p_book_item AND public.takeoff_row_owner_ok(to_jsonb(b), public.get_account_owner_id())))
    AND (p_part IS NULL OR EXISTS (
          SELECT 1 FROM inventory_parts ip
          WHERE ip.id = p_part AND public.takeoff_row_owner_ok(to_jsonb(ip), public.get_account_owner_id())))
    AND (p_vendor IS NULL OR EXISTS (
          SELECT 1 FROM inventory_vendors v
          WHERE v.id = p_vendor AND public.takeoff_row_owner_ok(to_jsonb(v), public.get_account_owner_id())));
$$;

REVOKE ALL ON FUNCTION public.takeoff_row_owner_ok(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.takeoff_row_owner_ok(jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.takeoff_refs_ok(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.takeoff_refs_ok(uuid, uuid, uuid, uuid, uuid) TO authenticated;

-- =============================================================
-- 8) RLS
-- =============================================================
ALTER TABLE takeoff_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE takeoff_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE takeoff_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE takeoff_item_changes ENABLE ROW LEVEL SECURITY;

-- projects
DROP POLICY IF EXISTS "takeoff_projects_select" ON takeoff_projects;
CREATE POLICY "takeoff_projects_select" ON takeoff_projects FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "takeoff_projects_insert" ON takeoff_projects;
CREATE POLICY "takeoff_projects_insert" ON takeoff_projects FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND created_by = auth.uid());
DROP POLICY IF EXISTS "takeoff_projects_update" ON takeoff_projects;
CREATE POLICY "takeoff_projects_update" ON takeoff_projects FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id())
  WITH CHECK (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "takeoff_projects_delete" ON takeoff_projects;
CREATE POLICY "takeoff_projects_delete" ON takeoff_projects FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- rooms
DROP POLICY IF EXISTS "takeoff_rooms_select" ON takeoff_rooms;
CREATE POLICY "takeoff_rooms_select" ON takeoff_rooms FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "takeoff_rooms_insert" ON takeoff_rooms;
CREATE POLICY "takeoff_rooms_insert" ON takeoff_rooms FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.takeoff_refs_ok(project_id, NULL, NULL, NULL, NULL));
DROP POLICY IF EXISTS "takeoff_rooms_update" ON takeoff_rooms;
CREATE POLICY "takeoff_rooms_update" ON takeoff_rooms FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.takeoff_refs_ok(project_id, NULL, NULL, NULL, NULL));
DROP POLICY IF EXISTS "takeoff_rooms_delete" ON takeoff_rooms;
CREATE POLICY "takeoff_rooms_delete" ON takeoff_rooms FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- items
DROP POLICY IF EXISTS "takeoff_items_select" ON takeoff_items;
CREATE POLICY "takeoff_items_select" ON takeoff_items FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "takeoff_items_insert" ON takeoff_items;
CREATE POLICY "takeoff_items_insert" ON takeoff_items FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.takeoff_refs_ok(project_id, room_id, price_book_item_id, inventory_part_id, vendor_id)
  );
DROP POLICY IF EXISTS "takeoff_items_update" ON takeoff_items;
CREATE POLICY "takeoff_items_update" ON takeoff_items FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id())
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.takeoff_refs_ok(project_id, room_id, price_book_item_id, inventory_part_id, vendor_id)
  );
DROP POLICY IF EXISTS "takeoff_items_delete" ON takeoff_items;
CREATE POLICY "takeoff_items_delete" ON takeoff_items FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- audit trail: read-only to clients; rows are written by the trigger below
DROP POLICY IF EXISTS "takeoff_item_changes_select" ON takeoff_item_changes;
CREATE POLICY "takeoff_item_changes_select" ON takeoff_item_changes FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- =============================================================
-- 9) Triggers: updated_at, review stamp, audit trail
-- =============================================================
DROP TRIGGER IF EXISTS trg_takeoff_projects_updated_at ON takeoff_projects;
CREATE TRIGGER trg_takeoff_projects_updated_at BEFORE UPDATE ON takeoff_projects
  FOR EACH ROW EXECUTE FUNCTION public.takeoff_set_updated_at();
DROP TRIGGER IF EXISTS trg_takeoff_rooms_updated_at ON takeoff_rooms;
CREATE TRIGGER trg_takeoff_rooms_updated_at BEFORE UPDATE ON takeoff_rooms
  FOR EACH ROW EXECUTE FUNCTION public.takeoff_set_updated_at();

-- Stamp WHO decided and WHEN, on the server, so the client cannot fake a reviewer.
CREATE OR REPLACE FUNCTION public.takeoff_items_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NEW.review_status <> 'pending' THEN
    NEW.reviewed_by = auth.uid();
    NEW.reviewed_at = now();
  ELSIF NEW.review_status = 'pending' THEN
    NEW.reviewed_by = NULL;
    NEW.reviewed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_takeoff_items_before_update ON takeoff_items;
CREATE TRIGGER trg_takeoff_items_before_update BEFORE UPDATE ON takeoff_items
  FOR EACH ROW EXECUTE FUNCTION public.takeoff_items_before_update();

CREATE OR REPLACE FUNCTION public.takeoff_items_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_field text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- bulk AI replacement sets takeoff.bulk and is not a human decision
    IF coalesce(current_setting('takeoff.bulk', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    INSERT INTO takeoff_item_changes (account_owner_id, project_id, item_id, field, old_value, new_value)
    VALUES (OLD.account_owner_id, OLD.project_id, OLD.id, 'deleted', OLD.description, NULL);
    RETURN OLD;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH v_field IN ARRAY ARRAY[
    'description', 'kind', 'net_quantity', 'waste_percent', 'quantity', 'unit_price_cents',
    'price_source', 'tier_scope', 'review_status'
  ] LOOP
    IF v_old -> v_field IS DISTINCT FROM v_new -> v_field THEN
      INSERT INTO takeoff_item_changes (account_owner_id, project_id, item_id, field, old_value, new_value)
      VALUES (NEW.account_owner_id, NEW.project_id, NEW.id, v_field, v_old ->> v_field, v_new ->> v_field);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_takeoff_items_audit ON takeoff_items;
CREATE TRIGGER trg_takeoff_items_audit AFTER UPDATE OR DELETE ON takeoff_items
  FOR EACH ROW EXECUTE FUNCTION public.takeoff_items_audit();

-- =============================================================
-- 10) Atomic swap of the AI's results (SECURITY INVOKER: RLS applies)
-- =============================================================
CREATE OR REPLACE FUNCTION public.takeoff_replace_ai_results(
  p_project_id uuid,
  p_project jsonb,
  p_rooms jsonb,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_room jsonb;
  v_room_id uuid;
  v_map jsonb := '{}'::jsonb;
  v_rooms integer := 0;
  v_items integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM takeoff_projects WHERE id = p_project_id AND account_owner_id = v_owner AND status <> 'converted'
  ) THEN
    RAISE EXCEPTION 'takeoff project not found or already converted' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('takeoff.bulk', 'on', true);

  -- Staff-added lines and rooms survive a re-analysis; AI output is replaced.
  DELETE FROM takeoff_items WHERE project_id = p_project_id AND source = 'ai';
  DELETE FROM takeoff_rooms WHERE project_id = p_project_id AND created_by_human = false;

  FOR v_room IN SELECT * FROM jsonb_array_elements(coalesce(p_rooms, '[]'::jsonb))
  LOOP
    INSERT INTO takeoff_rooms (
      account_owner_id, project_id, sort_order, name, room_type, level,
      length_ft, width_ft, height_ft, area_sqft, confidence, evidence, source_ref, flags
    ) VALUES (
      v_owner, p_project_id, coalesce((v_room ->> 'sort_order')::integer, 0),
      v_room ->> 'name', coalesce(v_room ->> 'room_type', 'other'), coalesce(v_room ->> 'level', 'Main'),
      (v_room ->> 'length_ft')::numeric, (v_room ->> 'width_ft')::numeric, (v_room ->> 'height_ft')::numeric,
      (v_room ->> 'area_sqft')::numeric, coalesce((v_room ->> 'confidence')::numeric, 0.5),
      coalesce(v_room ->> 'evidence', ''), v_room ->> 'source_ref',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(v_room -> 'flags', '[]'::jsonb)))
    ) RETURNING id INTO v_room_id;

    v_map := v_map || jsonb_build_object(v_room ->> 'ref', v_room_id);
    v_rooms := v_rooms + 1;
  END LOOP;

  INSERT INTO takeoff_items (
    account_owner_id, project_id, room_id, sort_order, kind, description, category, unit,
    net_quantity, waste_percent, quantity, ai_quantity, basis, confidence, evidence, source_ref, source,
    tier_scope, labor_hours_each, labor_included, price_source, price_locked,
    price_book_item_id, inventory_part_id, vendor_id, vendor_name, vendor_sku, lead_time_days,
    unit_cost_cents, unit_price_cents, price_confidence, match_status, match_candidates, flags, review_status
  )
  SELECT
    v_owner, p_project_id,
    CASE WHEN i ->> 'room_ref' IS NULL THEN NULL ELSE (v_map ->> (i ->> 'room_ref'))::uuid END,
    coalesce((i ->> 'sort_order')::integer, 0),
    i ->> 'kind', i ->> 'description', coalesce(i ->> 'category', 'General'), coalesce(i ->> 'unit', 'ea'),
    (i ->> 'net_quantity')::numeric, coalesce((i ->> 'waste_percent')::numeric, 0), (i ->> 'quantity')::integer,
    (i ->> 'ai_quantity')::numeric, i ->> 'basis', (i ->> 'confidence')::numeric,
    coalesce(i ->> 'evidence', ''), i ->> 'source_ref', 'ai',
    coalesce(i ->> 'tier_scope', 'all'), (i ->> 'labor_hours_each')::numeric,
    coalesce((i ->> 'labor_included')::boolean, false), coalesce(i ->> 'price_source', 'none'), false,
    (i ->> 'price_book_item_id')::uuid, (i ->> 'inventory_part_id')::uuid, (i ->> 'vendor_id')::uuid,
    i ->> 'vendor_name', i ->> 'vendor_sku', (i ->> 'lead_time_days')::integer,
    (i ->> 'unit_cost_cents')::integer, (i ->> 'unit_price_cents')::integer,
    coalesce((i ->> 'price_confidence')::numeric, 0), coalesce(i ->> 'match_status', 'unmatched'),
    coalesce(i -> 'match_candidates', '[]'::jsonb),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(i -> 'flags', '[]'::jsonb))),
    'pending'
  FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) AS i;

  GET DIAGNOSTICS v_items = ROW_COUNT;

  UPDATE takeoff_projects SET
    status = 'review',
    ai_summary = p_project ->> 'ai_summary',
    plan_quality = p_project ->> 'plan_quality',
    scale_note = p_project ->> 'scale_note',
    overall_confidence = (p_project ->> 'overall_confidence')::numeric,
    assumptions = coalesce(p_project -> 'assumptions', '[]'::jsonb),
    missing_info = coalesce(p_project -> 'missing_info', '[]'::jsonb),
    warnings = coalesce(p_project -> 'warnings', '[]'::jsonb),
    model = p_project ->> 'model',
    labor_rate_cents = coalesce((p_project ->> 'labor_rate_cents')::integer, labor_rate_cents),
    labor_cost_rate_cents = coalesce((p_project ->> 'labor_cost_rate_cents')::integer, labor_cost_rate_cents),
    analysis_error = NULL,
    analyzed_at = now(),
    approved_by = NULL,
    approved_at = NULL
  WHERE id = p_project_id;

  RETURN jsonb_build_object('rooms', v_rooms, 'items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.takeoff_replace_ai_results(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.takeoff_replace_ai_results(uuid, jsonb, jsonb, jsonb) TO authenticated;

-- =============================================================
-- 11) Private bucket for plans (folder = account owner id)
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'takeoff-plans',
  'takeoff-plans',
  false,
  26214400, -- 25 MB per file
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "takeoff_plans_account_access" ON storage.objects;
CREATE POLICY "takeoff_plans_account_access"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'takeoff-plans' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text)
WITH CHECK (bucket_id = 'takeoff-plans' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
