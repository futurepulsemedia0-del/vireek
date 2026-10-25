/*
  # Trade Pack framework + Pack 1 (Pest control) + Pack 2 (Pool service)

  ## Why
  Trades need different operational records: pest control must log every chemical
  application and keep restricted-use product records; pool service lives on
  chemistry readings, dosing and equipment history, run on weekly routes. Packs make
  that OPTIONAL per tenant, without forking the product per trade.

  ## What this adds (reuses what already exists)
  - Reuses `custom_field_definitions`  → a pack seeds its fields (keys prefixed `pest_` / `pool_`).
  - Reuses `field_form_templates`      → a pack seeds forms + checklists (slug prefixed likewise);
                                         tenant edits are never overwritten.
  - Reuses `recurring_agreements`      → plan templates create normal agreements (no new scheduler).
  - Reuses `technician_credentials`    → applicator licences gate chemical logging.
  - Reuses `equipment`, `jobs`, `team_members`, `log_audit_event()`, `get_account_owner_id()`.
  - NEW: trade_packs / trade_log_types (global reference, seeded below, generated from the
         TypeScript manifests in src/lib/tradePacks/), trade_pack_installs (per tenant opt-in),
         trade_regulated_products (tenant product register), trade_log_entries (append-only,
         server-validated compliance ledger), trade_routes + trade_route_stops.

  ## Safety model
  - Nothing happens for a tenant until `install_trade_pack()` is called by an owner / admin /
    business-profile editor. Disabling keeps all records.
  - `trade_log_entries` is append-only. A BEFORE INSERT guard (cannot be bypassed from the
    client) checks: pack enabled, entry type, data shape, tenant ownership of job / unit /
    technician / product, label-rate limit, technician licence on the date of work, and
    snapshots names + licence numbers so the record survives later edits and deletions.
    Mistakes are voided (owner only, reason required, audited) — never edited or deleted.
  - Retention is stamped per row (`retain_until`).
  - Records support, but never replace, local regulation: retention defaults are conservative.

  ## Depends on
  20260821101104 (team_members), 20260918000000 (customers), 20260927000001 (equipment),
  20261122000000 (technician_credentials), 20270215000000 + 20270411000000 (forms),
  20270403000000 (recurring_agreements, set_updated_at), 20270502000000 (custom fields).
*/

-- =============================================================
-- 1. REFERENCE TABLES (global, read-only for clients)
-- =============================================================

CREATE TABLE IF NOT EXISTS trade_packs (
  pack_key text PRIMARY KEY CHECK (pack_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL,
  industry_slug text NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_log_types (
  pack_key text NOT NULL REFERENCES trade_packs(pack_key) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL,
  requires_job boolean NOT NULL,
  requires_technician boolean NOT NULL,
  requires_equipment boolean NOT NULL,
  uses_product boolean NOT NULL,
  required_credentials text[] NOT NULL DEFAULT ARRAY[]::text[],
  restricted_credentials text[] NOT NULL DEFAULT ARRAY[]::text[],
  retention_years integer NOT NULL CHECK (retention_years BETWEEN 1 AND 15),
  spec jsonb NOT NULL,
  PRIMARY KEY (pack_key, entry_type)
);

ALTER TABLE trade_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_log_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_trade_packs" ON trade_packs;
CREATE POLICY "read_trade_packs" ON trade_packs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "read_trade_log_types" ON trade_log_types;
CREATE POLICY "read_trade_log_types" ON trade_log_types FOR SELECT TO authenticated USING (true);

-- =============================================================
-- 2. SEED (generated from src/lib/tradePacks/*.ts — keep in sync via tests)
-- =============================================================

INSERT INTO trade_packs (pack_key, name, industry_slug) VALUES ('pest_control', 'Pest Control', 'pest-control')
  ON CONFLICT (pack_key) DO UPDATE SET name = EXCLUDED.name, industry_slug = EXCLUDED.industry_slug;
INSERT INTO trade_packs (pack_key, name, industry_slug) VALUES ('pool_service', 'Pool Service', 'pool-service')
  ON CONFLICT (pack_key) DO UPDATE SET name = EXCLUDED.name, industry_slug = EXCLUDED.industry_slug;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pest_control', 'chemical_application', 'Chemical application', true, true, false, true, ARRAY['pesticide_applicator','pesticide_applicator_restricted']::text[], ARRAY['pesticide_applicator_restricted']::text[], 3,
  '{"fields":[{"key":"amount","type":"number","required":true,"min":0.0001,"max":100000},{"key":"amount_unit","type":"select","required":true,"options":["oz","fl_oz","lb","gal","qt","g","kg","ml","l","each"]},{"key":"area_sqft","type":"number","required":false,"min":1,"max":10000000},{"key":"dilution","type":"text","required":false},{"key":"method","type":"select","required":true,"options":["Spray","Dust","Bait placement","Fog / ULV","Granular","Injection","Trench / drench"]},{"key":"application_site","type":"select","required":true,"options":["Interior","Exterior","Perimeter only","Crawlspace","Attic","Lawn / yard","Commercial kitchen"]},{"key":"target_pests","type":"multiselect","required":true,"options":["Ants","Cockroaches","Rodents","Termites","Bed bugs","Mosquitoes","Spiders","Wasps / bees","Fleas / ticks","Wildlife","Other"]},{"key":"wind_mph","type":"number","required":false,"min":0,"max":100},{"key":"temp_f","type":"number","required":false,"min":-20,"max":130},{"key":"ppe_used","type":"boolean","required":true},{"key":"customer_notified","type":"boolean","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pest_control', 'treatment', 'Treatment / inspection', true, true, false, false, ARRAY[]::text[], ARRAY[]::text[], 3,
  '{"fields":[{"key":"treatment_type","type":"select","required":true,"options":["Initial","Recurring","Callback","Inspection only","Exclusion","Monitoring"]},{"key":"areas_serviced","type":"multiselect","required":false,"options":["Interior","Exterior","Perimeter only","Crawlspace","Attic","Lawn / yard","Commercial kitchen"]},{"key":"pest_activity","type":"number","required":true,"min":0,"max":5},{"key":"bait_stations_checked","type":"number","required":false,"min":0,"max":1000},{"key":"findings","type":"textarea","required":false},{"key":"conducive_conditions","type":"textarea","required":false},{"key":"recommendations","type":"textarea","required":false},{"key":"customer_present","type":"boolean","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pest_control', 'regulated_product', 'Regulated-product record', false, true, false, true, ARRAY[]::text[], ARRAY['pesticide_applicator_restricted']::text[], 3,
  '{"fields":[{"key":"action","type":"select","required":true,"options":["Received","Transferred out","Disposed","Count"]},{"key":"quantity","type":"number","required":true,"min":0,"max":1000000},{"key":"unit","type":"select","required":true,"options":["oz","fl_oz","lb","gal","qt","g","kg","ml","l","each"]},{"key":"lot_number","type":"text","required":false},{"key":"supplier","type":"text","required":false},{"key":"reference","type":"text","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pool_service', 'chemistry_reading', 'Chemistry reading', true, true, false, false, ARRAY[]::text[], ARRAY[]::text[], 2,
  '{"fields":[{"key":"fc","type":"number","required":false,"min":0,"max":100},{"key":"tc","type":"number","required":false,"min":0,"max":100},{"key":"ph","type":"number","required":false,"min":5,"max":9.5},{"key":"ta","type":"number","required":false,"min":0,"max":600},{"key":"cya","type":"number","required":false,"min":0,"max":400},{"key":"ch","type":"number","required":false,"min":0,"max":2000},{"key":"salt","type":"number","required":false,"min":0,"max":10000},{"key":"temp_f","type":"number","required":false,"min":32,"max":120},{"key":"filter_psi","type":"number","required":false,"min":0,"max":100},{"key":"clarity","type":"select","required":false,"options":["Clear","Hazy","Cloudy","Green","Black spot / mustard"]}],"at_least_one_of":["fc","tc","ph","ta","cya","ch","salt"]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pool_service', 'dosing', 'Chemical dosing', true, true, false, true, ARRAY[]::text[], ARRAY[]::text[], 2,
  '{"fields":[{"key":"amount","type":"number","required":true,"min":0.0001,"max":100000},{"key":"amount_unit","type":"select","required":true,"options":["oz","fl_oz","lb","gal","qt","g","kg","ml","l","each"]},{"key":"target","type":"select","required":true,"options":["Raise chlorine","Lower pH","Raise pH","Raise alkalinity","Raise stabilizer","Raise calcium","Add salt","Shock / oxidize","Algae treatment","Clarify","Other"]},{"key":"method","type":"select","required":false,"options":["Broadcast","Pre-dissolved","Feeder / floater","Through skimmer","Automated dosing"]}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('pool_service', 'equipment_service', 'Equipment service', true, true, true, false, ARRAY[]::text[], ARRAY[]::text[], 2,
  '{"fields":[{"key":"component","type":"select","required":true,"options":["Pump","Filter","Heater","Salt cell","Chlorinator / feeder","Controller","Cleaner","Cover","Light","Plumbing / valves","Other"]},{"key":"action","type":"select","required":true,"options":["Inspected","Cleaned / backwashed","Adjusted","Repaired","Replaced","Calibrated","Winterized","Opened for season"]},{"key":"runtime_hours","type":"number","required":false,"min":0,"max":200000},{"key":"pressure_psi","type":"number","required":false,"min":0,"max":100},{"key":"finding","type":"textarea","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

-- =============================================================
-- 3. PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_trade_packs()
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
      WHERE (tm.user_id = auth.uid()
             OR tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()))
        AND tm.invite_status = 'active'
        AND (
          tm.role = 'admin'
          OR COALESCE(tm.permissions ->> 'can_edit_business_profile', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_edit_business_profile', 'false') = 'true'
        )
    );
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_trade_packs() TO authenticated;

-- =============================================================
-- 4. PER-TENANT INSTALLS (opt-in)
-- =============================================================

CREATE TABLE IF NOT EXISTS trade_pack_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  pack_key text NOT NULL REFERENCES trade_packs(pack_key) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  -- When true, logging a regulated entry without a valid licence is blocked; when false it is
  -- recorded with an empty licence snapshot so the gap is visible in the ledger.
  enforce_credentials boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 16000),
  installed_by uuid DEFAULT auth.uid(),
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, pack_key)
);

ALTER TABLE trade_pack_installs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_trade_pack_installs" ON trade_pack_installs;
CREATE POLICY "select_trade_pack_installs" ON trade_pack_installs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Writes only through install_trade_pack() / update_trade_pack().

DROP TRIGGER IF EXISTS trg_trade_pack_installs_updated_at ON trade_pack_installs;
CREATE TRIGGER trg_trade_pack_installs_updated_at BEFORE UPDATE ON trade_pack_installs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- 5. REGULATED-PRODUCT REGISTER (tenant-owned)
-- =============================================================

CREATE TABLE IF NOT EXISTS trade_regulated_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  pack_key text NOT NULL REFERENCES trade_packs(pack_key) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('insecticide','rodenticide','herbicide','bait','repellent','sanitizer','ph_adjuster','alkalinity','stabilizer','algaecide','clarifier','salt','other')),
  unit text NOT NULL CHECK (unit IN ('oz','fl_oz','lb','gal','qt','g','kg','ml','l','each')),
  epa_reg_number text CHECK (epa_reg_number IS NULL OR epa_reg_number ~ '^\d{1,6}-\d{1,6}(-\d{1,6})?$'),
  epa_exempt_25b boolean NOT NULL DEFAULT false,
  active_ingredient text CHECK (active_ingredient IS NULL OR char_length(active_ingredient) <= 200),
  restricted_use boolean NOT NULL DEFAULT false,
  signal_word text CHECK (signal_word IS NULL OR signal_word IN ('danger','warning','caution')),
  -- Label maximum per 1,000 sq ft, in `unit`. NULL = no limit enforced.
  label_max_rate numeric(10,4) CHECK (label_max_rate IS NULL OR label_max_rate > 0),
  reentry_hours numeric(6,2) CHECK (reentry_hours IS NULL OR reentry_hours BETWEEN 0 AND 720),
  sds_url text CHECK (sds_url IS NULL OR (char_length(sds_url) <= 500 AND sds_url ~* '^https?://')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_products_active_name
  ON trade_regulated_products (user_id, pack_key, lower(btrim(name))) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trade_products_user_pack ON trade_regulated_products (user_id, pack_key);

CREATE OR REPLACE FUNCTION public.trade_product_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.pack_key <> OLD.pack_key) THEN
    RAISE EXCEPTION 'trade_product_invalid: owner and pack cannot change' USING ERRCODE = '22023';
  END IF;
  IF NEW.pack_key = 'pest_control'
     AND NEW.kind IN ('insecticide','rodenticide','herbicide','bait','repellent')
     AND NEW.epa_reg_number IS NULL AND NOT NEW.epa_exempt_25b THEN
    RAISE EXCEPTION 'trade_product_invalid: a pesticide needs an EPA registration number (or mark it 25(b) exempt)' USING ERRCODE = '23514';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_product_guard ON trade_regulated_products;
CREATE TRIGGER trg_trade_product_guard BEFORE INSERT OR UPDATE ON trade_regulated_products
  FOR EACH ROW EXECUTE FUNCTION public.trade_product_guard();

ALTER TABLE trade_regulated_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_trade_products" ON trade_regulated_products;
CREATE POLICY "select_trade_products" ON trade_regulated_products FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_trade_products" ON trade_regulated_products;
CREATE POLICY "insert_trade_products" ON trade_regulated_products FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs());
DROP POLICY IF EXISTS "update_trade_products" ON trade_regulated_products;
CREATE POLICY "update_trade_products" ON trade_regulated_products FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs());
-- No DELETE: archive instead (log rows keep their own snapshots).

-- =============================================================
-- 6. COMPLIANCE LEDGER (append-only)
-- =============================================================

CREATE TABLE IF NOT EXISTS trade_log_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  pack_key text NOT NULL,
  entry_type text NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  product_id uuid REFERENCES trade_regulated_products(id) ON DELETE SET NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  -- Snapshots (filled by the guard; survive edits / deletion of the source rows)
  site_address text,
  technician_name text,
  equipment_label text,
  equipment_serial text,
  product_name text,
  product_epa_reg text,
  product_restricted boolean,
  reentry_until timestamptz,
  credential_id uuid REFERENCES technician_credentials(id) ON DELETE SET NULL,
  credential_type text,
  credential_number text,
  retain_until date NOT NULL DEFAULT (now() + interval '3 years')::date,
  -- Voiding (the only permitted mutation)
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (pack_key, entry_type) REFERENCES trade_log_types(pack_key, entry_type),
  CONSTRAINT trade_log_void_consistent CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND char_length(btrim(coalesce(void_reason, ''))) >= 5)
  )
);

CREATE INDEX IF NOT EXISTS idx_trade_log_user_pack ON trade_log_entries (user_id, pack_key, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_job ON trade_log_entries (job_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_equipment ON trade_log_entries (equipment_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_product ON trade_log_entries (product_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_customer ON trade_log_entries (customer_id, performed_at DESC);

ALTER TABLE trade_log_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_trade_log" ON trade_log_entries;
CREATE POLICY "select_trade_log" ON trade_log_entries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_trade_log" ON trade_log_entries;
CREATE POLICY "insert_trade_log" ON trade_log_entries FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
-- Intentionally NO update / delete policies: the ledger is append-only.

-- ---- data validator (mirrors validateLogData() in src/lib/tradePacks/framework.ts) ----

CREATE OR REPLACE FUNCTION public.trade_log_data_error(p_entry_type text, p_spec jsonb, p_data jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  f jsonb;
  v jsonb;
  k text;
  t text;
  n numeric;
  known text[];
  el jsonb;
  any_ok boolean := false;
BEGIN
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RETURN 'data must be an object';
  END IF;
  IF octet_length(p_data::text) > 8000 THEN
    RETURN 'entry is too large';
  END IF;

  SELECT array_agg(x.value ->> 'key') INTO known FROM jsonb_array_elements(p_spec -> 'fields') AS x(value);
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF NOT (k = ANY (COALESCE(known, ARRAY[]::text[]))) THEN
      RETURN format('unknown field "%s"', k);
    END IF;
  END LOOP;

  FOR f IN SELECT * FROM jsonb_array_elements(p_spec -> 'fields') LOOP
    k := f ->> 'key';
    t := f ->> 'type';
    v := p_data -> k;

    IF v IS NULL OR v = 'null'::jsonb OR v = '""'::jsonb OR v = '[]'::jsonb THEN
      IF COALESCE((f ->> 'required')::boolean, false) THEN
        RETURN format('%s is required', k);
      END IF;
      CONTINUE;
    END IF;

    IF t = 'number' THEN
      IF jsonb_typeof(v) <> 'number' THEN RETURN format('%s must be a number', k); END IF;
      n := (v #>> '{}')::numeric;
      IF f ? 'min' AND n < (f ->> 'min')::numeric THEN RETURN format('%s is below the minimum', k); END IF;
      IF f ? 'max' AND n > (f ->> 'max')::numeric THEN RETURN format('%s is above the maximum', k); END IF;
    ELSIF t = 'boolean' THEN
      IF jsonb_typeof(v) <> 'boolean' THEN RETURN format('%s must be yes or no', k); END IF;
    ELSIF t = 'select' THEN
      IF jsonb_typeof(v) <> 'string' OR NOT ((f -> 'options') ? (v #>> '{}')) THEN
        RETURN format('%s has an invalid choice', k);
      END IF;
    ELSIF t = 'multiselect' THEN
      IF jsonb_typeof(v) <> 'array' THEN RETURN format('%s must be a list', k); END IF;
      FOR el IN SELECT * FROM jsonb_array_elements(v) LOOP
        IF jsonb_typeof(el) <> 'string' OR NOT ((f -> 'options') ? (el #>> '{}')) THEN
          RETURN format('%s has an invalid choice', k);
        END IF;
      END LOOP;
    ELSE
      IF jsonb_typeof(v) <> 'string' OR char_length(v #>> '{}') > 1000 THEN
        RETURN format('%s must be text up to 1000 characters', k);
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(COALESCE(p_spec -> 'at_least_one_of', '[]'::jsonb)) > 0 THEN
    FOR el IN SELECT * FROM jsonb_array_elements(p_spec -> 'at_least_one_of') LOOP
      v := p_data -> (el #>> '{}');
      IF v IS NOT NULL AND v <> 'null'::jsonb AND v <> '""'::jsonb THEN any_ok := true; END IF;
    END LOOP;
    IF NOT any_ok THEN RETURN 'enter at least one reading'; END IF;
  END IF;

  IF p_entry_type = 'regulated_product'
     AND (p_data ->> 'action') IS DISTINCT FROM 'Count'
     AND jsonb_typeof(p_data -> 'quantity') = 'number'
     AND (p_data ->> 'quantity')::numeric <= 0 THEN
    RETURN 'quantity must be greater than 0';
  END IF;
  RETURN NULL;
END;
$$;

-- ---- guard: BEFORE INSERT ----

CREATE OR REPLACE FUNCTION public.trade_log_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inst record;
  v_type record;
  v_job record;
  v_eq record;
  v_tech record;
  v_prod record;
  v_cred record;
  v_err text;
  v_need text[];
  v_area numeric;
  v_amount numeric;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'trade_log: not authenticated' USING ERRCODE = '42501';
  END IF;
  NEW.user_id := v_owner;

  SELECT * INTO v_inst FROM trade_pack_installs WHERE user_id = v_owner AND pack_key = NEW.pack_key AND enabled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trade_pack_not_enabled: turn this pack on first' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_type FROM trade_log_types WHERE pack_key = NEW.pack_key AND entry_type = NEW.entry_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trade_log_invalid: unknown entry type' USING ERRCODE = '22023';
  END IF;

  IF NEW.performed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'trade_log_invalid: performed_at cannot be in the future' USING ERRCODE = '22007';
  END IF;

  NEW.data := COALESCE(NEW.data, '{}'::jsonb);
  v_err := public.trade_log_data_error(NEW.entry_type, v_type.spec, NEW.data);
  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'trade_log_invalid: %', v_err USING ERRCODE = '22023';
  END IF;

  -- Job
  IF v_type.requires_job AND NEW.job_id IS NULL THEN
    RAISE EXCEPTION 'trade_log_invalid: a job is required' USING ERRCODE = '23502';
  END IF;
  IF NEW.job_id IS NOT NULL THEN
    SELECT j.id, j.address, j.customer_id INTO v_job FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'trade_log_invalid: job not found' USING ERRCODE = '42501'; END IF;
    NEW.site_address := v_job.address;
    NEW.customer_id := v_job.customer_id;
  END IF;

  -- Equipment
  IF v_type.requires_equipment AND NEW.equipment_id IS NULL THEN
    RAISE EXCEPTION 'trade_log_invalid: equipment is required' USING ERRCODE = '23502';
  END IF;
  IF NEW.equipment_id IS NOT NULL THEN
    SELECT e.id, e.equipment_type, e.make, e.model, e.serial_number INTO v_eq
    FROM equipment e WHERE e.id = NEW.equipment_id AND e.user_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'trade_log_invalid: equipment not found' USING ERRCODE = '42501'; END IF;
    NEW.equipment_serial := v_eq.serial_number;
    NEW.equipment_label := NULLIF(btrim(concat_ws(' ', v_eq.make, v_eq.model, v_eq.equipment_type)), '');
  END IF;

  -- Technician
  IF v_type.requires_technician AND NEW.technician_id IS NULL THEN
    RAISE EXCEPTION 'trade_log_invalid: a technician is required' USING ERRCODE = '23502';
  END IF;
  IF NEW.technician_id IS NOT NULL THEN
    SELECT tm.id, tm.member_name INTO v_tech FROM team_members tm
    WHERE tm.id = NEW.technician_id AND tm.account_owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'trade_log_invalid: technician not found' USING ERRCODE = '42501'; END IF;
    NEW.technician_name := v_tech.member_name;
  END IF;

  -- Product
  IF v_type.uses_product THEN
    IF NEW.product_id IS NULL THEN
      RAISE EXCEPTION 'trade_log_invalid: choose a product from the register' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_prod FROM trade_regulated_products
    WHERE id = NEW.product_id AND user_id = v_owner AND pack_key = NEW.pack_key AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'trade_log_invalid: product not found or archived' USING ERRCODE = '42501'; END IF;
    NEW.product_name := v_prod.name;
    NEW.product_epa_reg := v_prod.epa_reg_number;
    NEW.product_restricted := v_prod.restricted_use;

    -- Label-rate limit (per 1,000 sq ft, same unit as the product)
    IF v_prod.label_max_rate IS NOT NULL AND NEW.data ? 'amount' THEN
      IF jsonb_typeof(NEW.data -> 'area_sqft') IS DISTINCT FROM 'number'
         OR (NEW.data ->> 'amount_unit') IS DISTINCT FROM v_prod.unit THEN
        RAISE EXCEPTION 'trade_label_rate: enter the treated area and use the product unit (%) so the label rate can be checked', v_prod.unit
          USING ERRCODE = '23514';
      END IF;
      v_area := (NEW.data ->> 'area_sqft')::numeric;
      v_amount := (NEW.data ->> 'amount')::numeric;
      IF v_area > 0 AND (v_amount / (v_area / 1000)) > v_prod.label_max_rate THEN
        RAISE EXCEPTION 'trade_label_rate: applied rate % per 1,000 sq ft exceeds the label maximum of %', round(v_amount / (v_area / 1000), 2), v_prod.label_max_rate
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.entry_type = 'chemical_application' AND v_prod.reentry_hours IS NOT NULL AND v_prod.reentry_hours > 0 THEN
      NEW.reentry_until := NEW.performed_at + make_interval(secs => (v_prod.reentry_hours * 3600)::double precision);
    END IF;
  ELSE
    IF NEW.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'trade_log_invalid: this entry type does not use a product' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Licence gate (technician must hold a valid credential on the date of work)
  v_need := CASE
    WHEN COALESCE(NEW.product_restricted, false) AND COALESCE(array_length(v_type.restricted_credentials, 1), 0) > 0
      THEN v_type.restricted_credentials
    ELSE v_type.required_credentials
  END;
  IF COALESCE(array_length(v_need, 1), 0) > 0 AND NEW.technician_id IS NOT NULL THEN
    SELECT tc.id, tc.credential_type, tc.credential_number INTO v_cred
    FROM technician_credentials tc
    WHERE tc.technician_id = NEW.technician_id
      AND tc.credential_type = ANY (v_need)
      AND tc.status = 'active'
      AND (tc.expires_at IS NULL OR tc.expires_at >= (NEW.performed_at AT TIME ZONE 'UTC')::date)
    ORDER BY tc.expires_at DESC NULLS FIRST
    LIMIT 1;
    IF NOT FOUND AND v_inst.enforce_credentials THEN
      RAISE EXCEPTION 'trade_cert_required: % has no valid applicator licence on file for this work',
        COALESCE(v_tech.member_name, 'technician') USING ERRCODE = '42501';
    END IF;
    IF FOUND THEN
      NEW.credential_id := v_cred.id;
      NEW.credential_type := v_cred.credential_type;
      NEW.credential_number := v_cred.credential_number;
    END IF;
  END IF;

  NEW.notes := NULLIF(btrim(COALESCE(NEW.notes, '')), '');
  NEW.retain_until := ((NEW.performed_at AT TIME ZONE 'UTC')::date + make_interval(years => v_type.retention_years))::date;
  NEW.voided_at := NULL;
  NEW.voided_by := NULL;
  NEW.void_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_log_before_insert ON trade_log_entries;
CREATE TRIGGER trg_trade_log_before_insert BEFORE INSERT ON trade_log_entries
  FOR EACH ROW EXECUTE FUNCTION public.trade_log_before_insert();

-- ---- guard: BEFORE UPDATE (append-only; allow void + FK detach) ----

CREATE OR REPLACE FUNCTION public.trade_log_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.pack_key, NEW.entry_type, NEW.performed_at, NEW.data, NEW.notes,
      NEW.site_address, NEW.technician_name, NEW.equipment_label, NEW.equipment_serial,
      NEW.product_name, NEW.product_epa_reg, NEW.product_restricted, NEW.reentry_until,
      NEW.credential_type, NEW.credential_number, NEW.retain_until, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.pack_key, OLD.entry_type, OLD.performed_at, OLD.data, OLD.notes,
      OLD.site_address, OLD.technician_name, OLD.equipment_label, OLD.equipment_serial,
      OLD.product_name, OLD.product_epa_reg, OLD.product_restricted, OLD.reentry_until,
      OLD.credential_type, OLD.credential_number, OLD.retain_until, OLD.created_at)
  THEN
    RAISE EXCEPTION 'trade_log entries are immutable; void the entry instead' USING ERRCODE = '42501';
  END IF;

  IF (NEW.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
     OR (NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     OR (NEW.equipment_id IS NOT NULL AND NEW.equipment_id IS DISTINCT FROM OLD.equipment_id)
     OR (NEW.technician_id IS NOT NULL AND NEW.technician_id IS DISTINCT FROM OLD.technician_id)
     OR (NEW.product_id IS NOT NULL AND NEW.product_id IS DISTINCT FROM OLD.product_id)
     OR (NEW.credential_id IS NOT NULL AND NEW.credential_id IS DISTINCT FROM OLD.credential_id)
  THEN
    RAISE EXCEPTION 'trade_log links cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF OLD.voided_at IS NOT NULL
     AND (NEW.voided_at, NEW.voided_by, NEW.void_reason) IS DISTINCT FROM (OLD.voided_at, OLD.voided_by, OLD.void_reason)
  THEN
    RAISE EXCEPTION 'trade_log entry is already voided' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_log_before_update ON trade_log_entries;
CREATE TRIGGER trg_trade_log_before_update BEFORE UPDATE ON trade_log_entries
  FOR EACH ROW EXECUTE FUNCTION public.trade_log_before_update();

-- ---- audit: AFTER INSERT ----

CREATE OR REPLACE FUNCTION public.trade_log_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_audit_event(NEW.user_id, 'trade_log.' || NEW.pack_key || '.' || NEW.entry_type, 'trade_log_entries', NEW.id::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_log_after_insert ON trade_log_entries;
CREATE TRIGGER trg_trade_log_after_insert AFTER INSERT ON trade_log_entries
  FOR EACH ROW EXECUTE FUNCTION public.trade_log_after_insert();

-- ---- void RPC (owner only) ----

CREATE OR REPLACE FUNCTION public.void_trade_log_entry(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_owner IS NULL OR NOT public.is_account_owner() THEN
    RAISE EXCEPTION 'Only the account owner can void compliance entries' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required' USING ERRCODE = '22023';
  END IF;

  UPDATE trade_log_entries
  SET voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
  WHERE id = p_id AND user_id = v_owner AND voided_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found or already voided' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'trade_log.void', 'trade_log_entries', p_id::text);
END;
$$;
GRANT EXECUTE ON FUNCTION public.void_trade_log_entry(uuid, text) TO authenticated;

-- =============================================================
-- 7. ROUTES
-- =============================================================

CREATE TABLE IF NOT EXISTS trade_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  pack_key text NOT NULL REFERENCES trade_packs(pack_key) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  start_time time NOT NULL DEFAULT '08:00',
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_routes_name ON trade_routes (user_id, pack_key, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_trade_routes_user_pack ON trade_routes (user_id, pack_key, weekday);

CREATE TABLE IF NOT EXISTS trade_route_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  route_id uuid NOT NULL REFERENCES trade_routes(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  agreement_id uuid REFERENCES recurring_agreements(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 160),
  address text CHECK (address IS NULL OR char_length(address) <= 300),
  lat numeric(9,6) CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng numeric(9,6) CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  est_minutes integer NOT NULL DEFAULT 30 CHECK (est_minutes BETWEEN 5 AND 480),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_route_stops_geo_pair CHECK ((lat IS NULL) = (lng IS NULL)),
  CONSTRAINT trade_route_stops_position UNIQUE (route_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_route_stops_agreement ON trade_route_stops (route_id, agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_route_stops_route ON trade_route_stops (route_id, position);

CREATE OR REPLACE FUNCTION public.trade_route_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501'; END IF;
  NEW.user_id := v_owner;
  IF TG_TABLE_NAME = 'trade_routes' THEN
    NEW.name := btrim(NEW.name);
    NEW.updated_at := now();
    IF NEW.technician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = NEW.technician_id AND tm.account_owner_id = v_owner) THEN
      RAISE EXCEPTION 'technician not found' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM trade_routes r WHERE r.id = NEW.route_id AND r.user_id = v_owner) THEN
      RAISE EXCEPTION 'route not found' USING ERRCODE = '42501';
    END IF;
    IF NEW.agreement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recurring_agreements a WHERE a.id = NEW.agreement_id AND a.user_id = v_owner) THEN
      RAISE EXCEPTION 'plan not found' USING ERRCODE = '42501';
    END IF;
    IF NEW.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = v_owner) THEN
      RAISE EXCEPTION 'customer not found' USING ERRCODE = '42501';
    END IF;
    NEW.label := btrim(NEW.label);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_routes_guard ON trade_routes;
CREATE TRIGGER trg_trade_routes_guard BEFORE INSERT OR UPDATE ON trade_routes
  FOR EACH ROW EXECUTE FUNCTION public.trade_route_guard();
DROP TRIGGER IF EXISTS trg_trade_route_stops_guard ON trade_route_stops;
CREATE TRIGGER trg_trade_route_stops_guard BEFORE INSERT OR UPDATE ON trade_route_stops
  FOR EACH ROW EXECUTE FUNCTION public.trade_route_guard();

ALTER TABLE trade_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_route_stops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_trade_routes" ON trade_routes;
CREATE POLICY "select_trade_routes" ON trade_routes FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "write_trade_routes" ON trade_routes;
CREATE POLICY "write_trade_routes" ON trade_routes FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs());

DROP POLICY IF EXISTS "select_trade_route_stops" ON trade_route_stops;
CREATE POLICY "select_trade_route_stops" ON trade_route_stops FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "write_trade_route_stops" ON trade_route_stops;
CREATE POLICY "write_trade_route_stops" ON trade_route_stops FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_trade_packs());

-- Atomic reorder (positions are DEFERRABLE-unique, so a full rewrite is safe in one statement).
CREATE OR REPLACE FUNCTION public.reorder_trade_route_stops(p_route_id uuid, p_stop_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count integer;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_routes WHERE id = p_route_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'route not found' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_count FROM trade_route_stops WHERE route_id = p_route_id AND user_id = v_owner;
  IF v_count <> COALESCE(array_length(p_stop_ids, 1), 0)
     OR (SELECT count(DISTINCT s) FROM unnest(p_stop_ids) s) <> v_count
     OR EXISTS (SELECT 1 FROM unnest(p_stop_ids) s WHERE NOT EXISTS (SELECT 1 FROM trade_route_stops x WHERE x.id = s AND x.route_id = p_route_id)) THEN
    RAISE EXCEPTION 'stop list does not match the route' USING ERRCODE = '22023';
  END IF;
  UPDATE trade_route_stops x SET position = o.ord - 1
  FROM unnest(p_stop_ids) WITH ORDINALITY AS o(id, ord)
  WHERE x.id = o.id AND x.route_id = p_route_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.reorder_trade_route_stops(uuid, uuid[]) TO authenticated;

-- =============================================================
-- 8. INSTALL / CONFIGURE RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.install_trade_pack(p_pack text, p_fields jsonb, p_forms jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_prefix text := split_part(p_pack, '_', 1) || '_';
  f jsonb;
  v_i integer := 0;
  v_n integer;
  v_added integer := 0;
  v_skipped integer := 0;
  v_forms integer := 0;
  v_err text;
  v_entity text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_packs WHERE pack_key = p_pack) THEN
    RAISE EXCEPTION 'unknown_pack' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_fields, '[]'::jsonb)) <> 'array' OR jsonb_typeof(COALESCE(p_forms, '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(p_fields, '[]'::jsonb)) > 30 OR jsonb_array_length(COALESCE(p_forms, '[]'::jsonb)) > 20 THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':pack:' || p_pack, 0));

  INSERT INTO trade_pack_installs (user_id, pack_key, enabled) VALUES (v_owner, p_pack, true)
  ON CONFLICT (user_id, pack_key) DO UPDATE SET enabled = true;

  -- Custom fields (keys must carry the pack prefix; a full tenant cap or a duplicate label just skips that field)
  FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) LOOP
    v_i := v_i + 1;
    v_entity := f ->> 'entity';
    IF v_entity NOT IN ('customer', 'job') OR (f ->> 'key') IS NULL OR left(f ->> 'key', length(v_prefix)) <> v_prefix THEN
      RAISE EXCEPTION 'invalid_field: %', COALESCE(f ->> 'key', '?') USING ERRCODE = '22023';
    END IF;
    BEGIN
      INSERT INTO custom_field_definitions (user_id, entity, key, label, field_type, options, required, show_in_table, show_in_filters, sort_order)
      VALUES (v_owner, v_entity, f ->> 'key', f ->> 'label', f ->> 'field_type', COALESCE(f -> 'options', '[]'::jsonb),
              COALESCE((f ->> 'required')::boolean, false), COALESCE((f ->> 'show_in_table')::boolean, false),
              COALESCE((f ->> 'show_in_filters')::boolean, false), 1000 + v_i)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_added := v_added + v_n;
      v_skipped := v_skipped + (1 - v_n);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  -- Forms + checklists (never overwrite a tenant's own template with the same slug)
  FOR f IN SELECT * FROM jsonb_array_elements(COALESCE(p_forms, '[]'::jsonb)) LOOP
    IF (f ->> 'slug') IS NULL OR (f ->> 'slug') !~ '^[a-z0-9_]{2,60}$' OR left(f ->> 'slug', length(v_prefix)) <> v_prefix THEN
      RAISE EXCEPTION 'invalid_form: %', COALESCE(f ->> 'slug', '?') USING ERRCODE = '22023';
    END IF;
    v_err := public.field_form_schema_error(jsonb_build_object('fields', f -> 'fields'));
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_schema: % (%)', v_err, f ->> 'slug' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM field_form_templates WHERE owner_id = v_owner AND slug = f ->> 'slug') THEN
      INSERT INTO field_form_templates (owner_id, slug, title, description, trade, version, schema, is_active)
      VALUES (v_owner, f ->> 'slug', left(btrim(f ->> 'title'), 120), left(NULLIF(btrim(COALESCE(f ->> 'description', '')), ''), 500),
              NULL, 1, jsonb_build_object('fields', f -> 'fields'), true);
      v_forms := v_forms + 1;
    END IF;
  END LOOP;

  PERFORM public.log_audit_event(v_owner, 'trade_pack.install', 'trade_pack_installs', p_pack);
  RETURN jsonb_build_object('pack', p_pack, 'fields_added', v_added, 'fields_skipped', v_skipped, 'forms_added', v_forms);
END;
$$;
GRANT EXECUTE ON FUNCTION public.install_trade_pack(text, jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_trade_pack(
  p_pack text,
  p_enabled boolean DEFAULT NULL,
  p_enforce_credentials boolean DEFAULT NULL,
  p_config jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023';
  END IF;
  -- Switching off the licence gate is an owner decision.
  IF p_enforce_credentials IS NOT NULL AND p_enforce_credentials = false AND NOT public.is_account_owner() THEN
    RAISE EXCEPTION 'Only the account owner can turn off licence enforcement' USING ERRCODE = '42501';
  END IF;

  UPDATE trade_pack_installs
  SET enabled = COALESCE(p_enabled, enabled),
      enforce_credentials = COALESCE(p_enforce_credentials, enforce_credentials),
      config = COALESCE(p_config, config)
  WHERE user_id = v_owner AND pack_key = p_pack;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pack_not_installed' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'trade_pack.update', 'trade_pack_installs', p_pack);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_trade_pack(text, boolean, boolean, jsonb) TO authenticated;
