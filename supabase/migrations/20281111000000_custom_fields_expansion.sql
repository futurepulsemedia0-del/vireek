/*
  # Custom fields expansion (Phase 2)

  Builds on 20270502000000_custom_fields.sql WITHOUT changing the existing 5 types or 3 entities.

  ## New entities (value column: <table>.custom_data jsonb, partial GIN index on non-empty rows)
  estimate -> quotes, invoice -> invoices, equipment -> equipment, location -> business_locations,
  technician -> team_members (tenant column account_owner_id), vendor -> vendors

  ## New field types
  multi_select (array of options) · currency (number, max 2 decimals) · file (storage path string)
  lookup (uuid of a record of config.lookup_entity in the SAME account, checked on change)
  formula (computed by the database from number/currency fields; clients cannot write it)

  ## New definition columns
  config jsonb (currency, lookup_entity, formula AST, visible_when) · required_stages text[] (job canonical
  statuses; enforced by move_job_to_status) · read_roles / write_roles text[] · searchable · reportable

  ## Enforcement notes (be precise)
  - Write permission per field is enforced in the database for authenticated users with a role; service-role
    and server-side callers (auth.uid() IS NULL) are not restricted, like every other trigger in this schema.
  - read_roles is enforced by custom_field_filter() / custom_field_report() and by the UI. It is NOT a
    column-level security boundary: anyone allowed to SELECT the row can read custom_data. Do not store secrets.
  - visible_when is a UI rule only. "Required" stays UI + move_job_to_status() only (imports keep working).

  ## Rollback
  Additive. To stop using new types, archive those fields. Nothing here drops data.
*/

-- =============================================================
-- 1. Lookup helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.custom_table_for_entity(p_entity text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_entity
    WHEN 'customer' THEN 'customers' WHEN 'lead' THEN 'leads' WHEN 'job' THEN 'jobs'
    WHEN 'estimate' THEN 'quotes' WHEN 'invoice' THEN 'invoices' WHEN 'equipment' THEN 'equipment'
    WHEN 'location' THEN 'business_locations' WHEN 'technician' THEN 'team_members' WHEN 'vendor' THEN 'vendors'
  END;
$$;

CREATE OR REPLACE FUNCTION public.custom_owner_column_for_entity(p_entity text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_entity = 'technician' THEN 'account_owner_id' ELSE 'user_id' END;
$$;

CREATE OR REPLACE FUNCTION public.custom_entity_for_table(p_table text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_table
    WHEN 'customers' THEN 'customer' WHEN 'leads' THEN 'lead' WHEN 'jobs' THEN 'job'
    WHEN 'quotes' THEN 'estimate' WHEN 'invoices' THEN 'invoice' WHEN 'equipment' THEN 'equipment'
    WHEN 'business_locations' THEN 'location' WHEN 'team_members' THEN 'technician' WHEN 'vendors' THEN 'vendor'
  END;
$$;

CREATE OR REPLACE FUNCTION public.custom_value_is_blank(v jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NULL
      OR jsonb_typeof(v) = 'null'
      OR (jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') = '')
      OR (jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 0);
$$;

-- Role of the caller inside the account, or NULL for server-side calls (service role / no JWT).
CREATE OR REPLACE FUNCTION public.custom_caller_role(p_owner uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  IF v_uid = p_owner THEN RETURN 'owner'; END IF;
  SELECT tm.role INTO v_role FROM team_members tm
   WHERE tm.account_owner_id = p_owner AND tm.user_id = v_uid LIMIT 1;
  RETURN COALESCE(v_role, 'member');
END;
$$;

REVOKE ALL ON FUNCTION public.custom_caller_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.custom_caller_role(uuid) TO authenticated;

-- =============================================================
-- 2. Formula engine (JSON AST: {"c":n} | {"f":"key"} | {"op":"add|sub|mul|div","a":..,"b":..})
-- =============================================================
CREATE OR REPLACE FUNCTION public.custom_formula_refs(p_node jsonb, p_depth integer DEFAULT 0)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_depth > 8 OR jsonb_typeof(p_node) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid formula.' USING ERRCODE = '22023';
  END IF;
  IF p_node ? 'c' THEN
    IF jsonb_typeof(p_node -> 'c') <> 'number' THEN RAISE EXCEPTION 'Invalid formula.' USING ERRCODE = '22023'; END IF;
    RETURN '{}'::text[];
  END IF;
  IF p_node ? 'f' THEN
    IF jsonb_typeof(p_node -> 'f') <> 'string' OR (p_node ->> 'f') !~ '^[a-z][a-z0-9_]{0,39}$' THEN
      RAISE EXCEPTION 'Invalid formula.' USING ERRCODE = '22023';
    END IF;
    RETURN ARRAY[p_node ->> 'f'];
  END IF;
  IF COALESCE(p_node ->> 'op', '') NOT IN ('add', 'sub', 'mul', 'div') THEN
    RAISE EXCEPTION 'Invalid formula.' USING ERRCODE = '22023';
  END IF;
  RETURN public.custom_formula_refs(p_node -> 'a', p_depth + 1) || public.custom_formula_refs(p_node -> 'b', p_depth + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.custom_formula_eval(p_node jsonb, p_data jsonb, p_depth integer DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  a numeric; b numeric; v jsonb;
BEGIN
  IF p_depth > 8 OR jsonb_typeof(p_node) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  IF p_node ? 'c' THEN
    IF jsonb_typeof(p_node -> 'c') <> 'number' THEN RETURN NULL; END IF;
    RETURN (p_node ->> 'c')::numeric;
  ELSIF p_node ? 'f' THEN
    v := p_data -> (p_node ->> 'f');
    IF v IS NULL OR jsonb_typeof(v) <> 'number' THEN RETURN NULL; END IF;
    RETURN (v #>> '{}')::numeric;
  END IF;
  a := public.custom_formula_eval(p_node -> 'a', p_data, p_depth + 1);
  b := public.custom_formula_eval(p_node -> 'b', p_data, p_depth + 1);
  IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
  CASE p_node ->> 'op'
    WHEN 'add' THEN RETURN a + b;
    WHEN 'sub' THEN RETURN a - b;
    WHEN 'mul' THEN RETURN a * b;
    WHEN 'div' THEN
      IF b = 0 THEN RETURN NULL; END IF;
      RETURN a / b;
    ELSE RETURN NULL;
  END CASE;
END;
$$;

-- =============================================================
-- 3. Definitions: wider CHECKs + new columns
-- =============================================================
DO $do$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.custom_field_definitions'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) ~ '\mentity\M = ANY' OR pg_get_constraintdef(oid) ~ '\mfield_type\M = ANY')
  LOOP
    EXECUTE format('ALTER TABLE public.custom_field_definitions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$do$;

ALTER TABLE public.custom_field_definitions
  ADD CONSTRAINT cfd_entity_valid CHECK (entity IN ('customer', 'lead', 'job', 'estimate', 'invoice', 'equipment', 'location', 'technician', 'vendor'));
ALTER TABLE public.custom_field_definitions
  ADD CONSTRAINT cfd_field_type_valid CHECK (field_type IN ('text', 'number', 'select', 'date', 'boolean', 'multi_select', 'currency', 'file', 'lookup', 'formula'));

ALTER TABLE public.custom_field_definitions ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.custom_field_definitions ADD COLUMN IF NOT EXISTS required_stages text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.custom_field_definitions ADD COLUMN IF NOT EXISTS read_roles text[];
ALTER TABLE public.custom_field_definitions ADD COLUMN IF NOT EXISTS write_roles text[];
ALTER TABLE public.custom_field_definitions ADD COLUMN IF NOT EXISTS searchable boolean NOT NULL DEFAULT false;
ALTER TABLE public.custom_field_definitions ADD COLUMN IF NOT EXISTS reportable boolean NOT NULL DEFAULT false;

ALTER TABLE public.custom_field_definitions DROP CONSTRAINT IF EXISTS cfd_roles_valid;
ALTER TABLE public.custom_field_definitions ADD CONSTRAINT cfd_roles_valid CHECK (
  (read_roles IS NULL OR (cardinality(read_roles) BETWEEN 1 AND 4
     AND read_roles <@ ARRAY['owner','admin','member','technician']::text[]))
  AND (write_roles IS NULL OR (cardinality(write_roles) BETWEEN 1 AND 4
     AND write_roles <@ ARRAY['owner','admin','member','technician']::text[]))
);

ALTER TABLE public.custom_field_definitions DROP CONSTRAINT IF EXISTS cfd_config_valid;
ALTER TABLE public.custom_field_definitions ADD CONSTRAINT cfd_config_valid CHECK (
  jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 4096
);

CREATE OR REPLACE FUNCTION public.guard_custom_field_definition()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_opt jsonb;
  v_count integer;
  v_refs text[];
  v_ref text;
  v_vis jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.key <> OLD.key OR NEW.entity <> OLD.entity
       OR NEW.field_type <> OLD.field_type OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'A custom field''s key, entity and type cannot be changed.' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(NEW.config ->> 'lookup_entity', '') <> COALESCE(OLD.config ->> 'lookup_entity', '') THEN
      RAISE EXCEPTION 'A lookup field''s target cannot be changed.' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT count(*) INTO v_count FROM custom_field_definitions
     WHERE user_id = NEW.user_id AND entity = NEW.entity AND archived_at IS NULL;
    IF v_count >= 30 THEN
      RAISE EXCEPTION 'You can have at most 30 active custom fields per record type.' USING ERRCODE = '54000';
    END IF;
  END IF;

  IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'options must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF NEW.field_type IN ('select', 'multi_select') THEN
    IF jsonb_array_length(NEW.options) NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'A dropdown needs between 1 and 50 options.' USING ERRCODE = '22023';
    END IF;
    FOR v_opt IN SELECT * FROM jsonb_array_elements(NEW.options) LOOP
      IF jsonb_typeof(v_opt) <> 'string' OR char_length(btrim(v_opt #>> '{}')) NOT BETWEEN 1 AND 60 THEN
        RAISE EXCEPTION 'Each option must be 1-60 characters.' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  ELSE
    NEW.options := '[]'::jsonb;
  END IF;

  IF NEW.field_type = 'lookup' AND COALESCE(NEW.config ->> 'lookup_entity', '') NOT IN ('customer', 'lead', 'job', 'estimate', 'invoice', 'equipment', 'location', 'technician', 'vendor') THEN
    RAISE EXCEPTION 'A lookup field needs a valid target record type.' USING ERRCODE = '22023';
  END IF;
  IF NEW.field_type = 'currency' AND NEW.config ? 'currency' AND (NEW.config ->> 'currency') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'currency must be a 3-letter ISO code.' USING ERRCODE = '22023';
  END IF;

  IF NEW.field_type = 'formula' THEN
    IF NOT (NEW.config ? 'formula') THEN
      RAISE EXCEPTION 'A formula field needs a formula.' USING ERRCODE = '22023';
    END IF;
    v_refs := public.custom_formula_refs(NEW.config -> 'formula');
    FOREACH v_ref IN ARRAY v_refs LOOP
      IF NOT EXISTS (
        SELECT 1 FROM custom_field_definitions d
         WHERE d.user_id = NEW.user_id AND d.entity = NEW.entity AND d.key = v_ref
           AND d.field_type IN ('number', 'currency')
      ) THEN
        RAISE EXCEPTION 'The formula refers to an unknown or non-numeric field: %', v_ref USING ERRCODE = '22023';
      END IF;
    END LOOP;
    NEW.required := false;
    NEW.required_stages := '{}'::text[];
  END IF;

  IF NEW.config ? 'visible_when' THEN
    v_vis := NEW.config -> 'visible_when';
    IF jsonb_typeof(v_vis) <> 'object'
       OR COALESCE(v_vis ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$'
       OR (v_vis ->> 'key') = NEW.key
       OR COALESCE(v_vis ->> 'op', '') NOT IN ('eq', 'neq', 'in', 'set')
       OR NOT EXISTS (SELECT 1 FROM custom_field_definitions d
                       WHERE d.user_id = NEW.user_id AND d.entity = NEW.entity AND d.key = (v_vis ->> 'key')) THEN
      RAISE EXCEPTION 'Invalid visibility rule.' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF cardinality(NEW.required_stages) > 0 THEN
    IF NEW.entity <> 'job' OR NOT (NEW.required_stages <@ ARRAY['scheduled','en_route','in_progress','completed','cancelled','no_show','on_hold','waiting_on_parts','waiting_on_customer','needs_follow_up','return_visit_needed']::text[]) THEN
      RAISE EXCEPTION 'required_stages only applies to jobs and must be valid job statuses.' USING ERRCODE = '22023';
    END IF;
  END IF;

  NEW.label := btrim(NEW.label);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Schema-change audit
CREATE OR REPLACE FUNCTION public.custom_field_definitions_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  PERFORM public.log_audit_event(
    NEW.user_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'custom_field_created'
         WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN 'custom_field_archived'
         ELSE 'custom_field_updated' END,
    'custom_field_definitions', NEW.id::text,
    jsonb_build_object('entity', NEW.entity, 'key', NEW.key, 'field_type', NEW.field_type)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_custom_field_definitions_audit ON public.custom_field_definitions;
CREATE TRIGGER trg_custom_field_definitions_audit
  AFTER INSERT OR UPDATE ON public.custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION public.custom_field_definitions_audit();

-- =============================================================
-- 4. custom_data on the new entities (+ small partial GIN indexes)
-- =============================================================
ALTER TABLE public.quotes             ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.invoices           ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.equipment          ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.business_locations ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.team_members       ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.vendors            ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Indexing strategy: only rows that actually carry custom values are indexed, so the index stays tiny
-- on accounts that don't use the feature. jsonb_path_ops serves @> (equality / has-key-value) filters.
CREATE INDEX IF NOT EXISTS idx_quotes_custom_data             ON public.quotes             USING gin (custom_data jsonb_path_ops) WHERE custom_data <> '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_invoices_custom_data           ON public.invoices           USING gin (custom_data jsonb_path_ops) WHERE custom_data <> '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_equipment_custom_data          ON public.equipment          USING gin (custom_data jsonb_path_ops) WHERE custom_data <> '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_business_locations_custom_data ON public.business_locations USING gin (custom_data jsonb_path_ops) WHERE custom_data <> '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_team_members_custom_data       ON public.team_members       USING gin (custom_data jsonb_path_ops) WHERE custom_data <> '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_vendors_custom_data            ON public.vendors            USING gin (custom_data jsonb_path_ops) WHERE custom_data <> '{}'::jsonb;

-- =============================================================
-- 5. Value validation (replaces the Phase-1 version; same rules + new types)
-- =============================================================
CREATE OR REPLACE FUNCTION public.validate_custom_data()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entity text := public.custom_entity_for_table(TG_TABLE_NAME);
  v_owner uuid;
  v_role text;
  v_key text;
  v_val jsonb;
  v_old jsonb := '{}'::jsonb;
  v_changed boolean;
  v_text text;
  v_exists boolean;
  v_work jsonb;
  v_res numeric;
  d record;
  v_force boolean := COALESCE(current_setting('vireek.recompute_formulas', true), '') = '1';
BEGIN
  v_owner := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'team_members' THEN 'account_owner_id' ELSE 'user_id' END)::uuid;
  IF NEW.custom_data IS NULL THEN
    NEW.custom_data := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(NEW.custom_data) <> 'object' THEN
    RAISE EXCEPTION 'custom_data must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    v_old := COALESCE(OLD.custom_data, '{}'::jsonb);
  END IF;
  -- Untouched values (legacy rows, archived fields) are never re-judged.
  IF TG_OP = 'UPDATE' AND NEW.custom_data = v_old AND NOT v_force THEN
    RETURN NEW;
  END IF;
  IF octet_length(NEW.custom_data::text) > 16000 THEN
    RAISE EXCEPTION 'Custom field data is too large.' USING ERRCODE = '54000';
  END IF;
  v_role := public.custom_caller_role(v_owner);

  FOR v_key, v_val IN SELECT * FROM jsonb_each(NEW.custom_data) LOOP
    SELECT * INTO d FROM custom_field_definitions
     WHERE user_id = v_owner AND entity = v_entity AND key = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown custom field: %', v_key USING ERRCODE = '22023';
    END IF;

    v_changed := (v_old -> v_key) IS DISTINCT FROM v_val;

    IF d.field_type = 'formula' THEN
      -- Computed below for active formulas; an archived formula's stored value is read-only.
      IF d.archived_at IS NOT NULL AND v_changed THEN
        RAISE EXCEPTION 'Custom field "%" is computed and cannot be edited.', d.label USING ERRCODE = '22023';
      END IF;
      CONTINUE;
    END IF;

    IF v_changed AND d.write_roles IS NOT NULL AND v_role IS NOT NULL AND v_role <> 'owner'
       AND NOT (v_role = ANY (d.write_roles)) THEN
      RAISE EXCEPTION 'You don''t have permission to edit custom field "%"', d.label USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(v_val) = 'null' THEN
      CONTINUE;
    END IF;

    v_text := v_val #>> '{}';
    IF d.field_type = 'text' THEN
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_text) > 500 THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'number' THEN
      IF jsonb_typeof(v_val) <> 'number' THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'boolean' THEN
      IF jsonb_typeof(v_val) <> 'boolean' THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'select' THEN
      IF jsonb_typeof(v_val) <> 'string' OR NOT (d.options ? v_text) THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'date' THEN
      IF jsonb_typeof(v_val) <> 'string' OR v_text !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
      BEGIN
        PERFORM v_text::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END;
    ELSIF d.field_type = 'multi_select' THEN
      IF jsonb_typeof(v_val) <> 'array' OR jsonb_array_length(v_val) > 50
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_val) e
                     WHERE jsonb_typeof(e) <> 'string' OR NOT (d.options ? (e #>> '{}')))
         OR (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(v_val) e) <> jsonb_array_length(v_val) THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'currency' THEN
      IF jsonb_typeof(v_val) <> 'number' OR abs(v_text::numeric) > 1e12 OR v_text::numeric <> round(v_text::numeric, 2) THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'file' THEN
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_text) NOT BETWEEN 1 AND 500
         OR v_text ~ '(^/|\.\.|\\|[[:cntrl:]])' THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
    ELSIF d.field_type = 'lookup' THEN
      IF jsonb_typeof(v_val) <> 'string'
         OR v_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid value for custom field "%"', d.label USING ERRCODE = '22023';
      END IF;
      IF v_changed THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND %I = $2)',
                       public.custom_table_for_entity(d.config ->> 'lookup_entity'),
                       public.custom_owner_column_for_entity(d.config ->> 'lookup_entity'))
          INTO v_exists USING v_text::uuid, v_owner;
        IF NOT v_exists THEN
          RAISE EXCEPTION 'Invalid value for custom field "%": record not found', d.label USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Removing a value is a write too.
  IF v_role IS NOT NULL AND v_role <> 'owner' THEN
    FOR v_key IN SELECT jsonb_object_keys(v_old) LOOP
      IF NOT (NEW.custom_data ? v_key) THEN
        SELECT * INTO d FROM custom_field_definitions
         WHERE user_id = v_owner AND entity = v_entity AND key = v_key;
        IF FOUND AND d.field_type <> 'formula' AND d.write_roles IS NOT NULL AND NOT (v_role = ANY (d.write_roles)) THEN
          RAISE EXCEPTION 'You don''t have permission to edit custom field "%"', d.label USING ERRCODE = '42501';
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Computed fields: always derived from the final values, in sort order.
  v_work := NEW.custom_data;
  FOR d IN
    SELECT * FROM custom_field_definitions
     WHERE user_id = v_owner AND entity = v_entity AND field_type = 'formula' AND archived_at IS NULL
     ORDER BY sort_order, created_at
  LOOP
    v_res := public.custom_formula_eval(d.config -> 'formula', v_work);
    IF v_res IS NULL OR abs(v_res) > 1e15 THEN
      NEW.custom_data := NEW.custom_data - d.key;
    ELSE
      NEW.custom_data := jsonb_set(NEW.custom_data, ARRAY[d.key], to_jsonb(round(v_res, 6)));
    END IF;
    v_work := NEW.custom_data;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.quotes;
CREATE TRIGGER trg_validate_custom_data BEFORE INSERT OR UPDATE OF custom_data ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();
DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.invoices;
CREATE TRIGGER trg_validate_custom_data BEFORE INSERT OR UPDATE OF custom_data ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();
DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.equipment;
CREATE TRIGGER trg_validate_custom_data BEFORE INSERT OR UPDATE OF custom_data ON public.equipment
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();
DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.business_locations;
CREATE TRIGGER trg_validate_custom_data BEFORE INSERT OR UPDATE OF custom_data ON public.business_locations
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();
DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.team_members;
CREATE TRIGGER trg_validate_custom_data BEFORE INSERT OR UPDATE OF custom_data ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();
DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.vendors;
CREATE TRIGGER trg_validate_custom_data BEFORE INSERT OR UPDATE OF custom_data ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();

-- =============================================================
-- 6. Delete (now knows every entity, and refuses to orphan formulas / status rules)
-- =============================================================
CREATE OR REPLACE FUNCTION public.delete_custom_field(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d record;
BEGIN
  IF NOT public.can_manage_custom_fields() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO d FROM custom_field_definitions WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom field not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM custom_field_definitions f
     WHERE f.user_id = v_owner AND f.entity = d.entity AND f.field_type = 'formula'
       AND d.key = ANY (public.custom_formula_refs(f.config -> 'formula'))
  ) THEN
    RAISE EXCEPTION 'A formula uses this field. Edit or archive the formula first.' USING ERRCODE = '22023';
  END IF;
  IF d.entity = 'job' AND EXISTS (
    SELECT 1 FROM status_definitions s
     WHERE s.user_id = v_owner AND d.key = ANY (s.required_fields)
  ) THEN
    RAISE EXCEPTION 'A job status requires this field. Remove it from the status first.' USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'UPDATE public.%I SET custom_data = custom_data - $1::text WHERE %I = $2 AND custom_data ? $1::text',
    public.custom_table_for_entity(d.entity), public.custom_owner_column_for_entity(d.entity)
  ) USING d.key, v_owner;

  DELETE FROM custom_field_definitions WHERE id = p_id;

  PERFORM public.log_audit_event(v_owner, 'custom_field_deleted:' || d.entity || ':' || d.key,
                                 'custom_field_definitions', p_id::text);
END;
$$;

-- =============================================================
-- 7. Search / filter / report (SECURITY INVOKER: RLS on the entity table still applies)
-- =============================================================
CREATE OR REPLACE FUNCTION public.custom_field_filter(
  p_entity text, p_key text, p_op text, p_value jsonb, p_limit integer DEFAULT 100
)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_table text := public.custom_table_for_entity(p_entity);
  v_col text := public.custom_owner_column_for_entity(p_entity);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_role text;
  v_text text;
  d custom_field_definitions%ROWTYPE;
BEGIN
  IF v_table IS NULL OR v_owner IS NULL OR p_op NOT IN ('eq', 'has', 'contains', 'gte', 'lte') THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO d FROM custom_field_definitions
   WHERE user_id = v_owner AND entity = p_entity AND key = p_key AND archived_at IS NULL;
  IF NOT FOUND OR NOT (d.show_in_filters OR d.searchable) THEN
    RAISE EXCEPTION 'This field can''t be filtered.' USING ERRCODE = '22023';
  END IF;
  v_role := public.custom_caller_role(v_owner);
  IF d.read_roles IS NOT NULL AND v_role IS NOT NULL AND v_role <> 'owner' AND NOT (v_role = ANY (d.read_roles)) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' OR octet_length(p_value::text) > 200 THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  v_text := p_value #>> '{}';

  IF p_op = 'eq' THEN
    RETURN QUERY EXECUTE format(
      'SELECT id FROM public.%I WHERE %I = $1 AND custom_data @> jsonb_build_object($2::text, $3) LIMIT $4', v_table, v_col)
      USING v_owner, p_key, p_value, v_limit;
  ELSIF p_op = 'has' THEN
    RETURN QUERY EXECUTE format(
      'SELECT id FROM public.%I WHERE %I = $1 AND custom_data @> jsonb_build_object($2::text, jsonb_build_array($3::text)) LIMIT $4', v_table, v_col)
      USING v_owner, p_key, v_text, v_limit;
  ELSIF p_op = 'contains' THEN
    RETURN QUERY EXECUTE format(
      'SELECT id FROM public.%I WHERE %I = $1 AND (custom_data ->> $2::text) ILIKE $3 LIMIT $4', v_table, v_col)
      USING v_owner, p_key, '%' || replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%', v_limit;
  ELSE
    IF d.field_type IN ('number', 'currency', 'formula') THEN
      RETURN QUERY EXECUTE format(
        'SELECT id FROM public.%I WHERE %I = $1 AND jsonb_typeof(custom_data -> $2::text) = ''number'' AND (custom_data ->> $2::text)::numeric %s $3::numeric LIMIT $4',
        v_table, v_col, CASE p_op WHEN 'gte' THEN '>=' ELSE '<=' END)
        USING v_owner, p_key, v_text, v_limit;
    ELSIF d.field_type = 'date' THEN
      RETURN QUERY EXECUTE format(
        'SELECT id FROM public.%I WHERE %I = $1 AND (custom_data ->> $2::text) %s $3 LIMIT $4',
        v_table, v_col, CASE p_op WHEN 'gte' THEN '>=' ELSE '<=' END)
        USING v_owner, p_key, v_text, v_limit;
    ELSE
      RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_field_filter(text, text, text, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.custom_field_filter(text, text, text, jsonb, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.custom_field_report(p_entity text, p_key text)
RETURNS TABLE (bucket text, record_count bigint, total numeric)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_table text := public.custom_table_for_entity(p_entity);
  v_col text := public.custom_owner_column_for_entity(p_entity);
  v_role text;
  d custom_field_definitions%ROWTYPE;
BEGIN
  IF v_table IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO d FROM custom_field_definitions
   WHERE user_id = v_owner AND entity = p_entity AND key = p_key AND archived_at IS NULL;
  IF NOT FOUND OR NOT d.reportable THEN
    RAISE EXCEPTION 'This field isn''t available for reports.' USING ERRCODE = '22023';
  END IF;
  v_role := public.custom_caller_role(v_owner);
  IF d.read_roles IS NOT NULL AND v_role IS NOT NULL AND v_role <> 'owner' AND NOT (v_role = ANY (d.read_roles)) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  IF d.field_type IN ('number', 'currency', 'formula') THEN
    RETURN QUERY EXECUTE format(
      'SELECT ''all''::text, count(*), COALESCE(sum((custom_data ->> %L)::numeric), 0) FROM public.%I WHERE %I = $1 AND jsonb_typeof(custom_data -> %L) = ''number''',
      p_key, v_table, v_col, p_key) USING v_owner;
  ELSIF d.field_type = 'multi_select' THEN
    RETURN QUERY EXECUTE format(
      'SELECT e::text, count(*), NULL::numeric FROM public.%I t, jsonb_array_elements_text(t.custom_data -> %L) e WHERE t.%I = $1 AND jsonb_typeof(t.custom_data -> %L) = ''array'' GROUP BY 1 ORDER BY 2 DESC LIMIT 200',
      v_table, p_key, v_col, p_key) USING v_owner;
  ELSIF d.field_type = 'date' THEN
    RETURN QUERY EXECUTE format(
      'SELECT left(custom_data ->> %L, 7), count(*), NULL::numeric FROM public.%I WHERE %I = $1 AND custom_data ? %L GROUP BY 1 ORDER BY 1 DESC LIMIT 200',
      p_key, v_table, v_col, p_key) USING v_owner;
  ELSE
    RETURN QUERY EXECUTE format(
      'SELECT custom_data ->> %L, count(*), NULL::numeric FROM public.%I WHERE %I = $1 AND custom_data ? %L GROUP BY 1 ORDER BY 2 DESC LIMIT 200',
      p_key, v_table, v_col, p_key) USING v_owner;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_field_report(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.custom_field_report(text, text) TO authenticated;

-- After editing a formula, stored results are stale until their record is saved. This refreshes them.
CREATE OR REPLACE FUNCTION public.recompute_custom_formulas(p_entity text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_table text := public.custom_table_for_entity(p_entity);
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR v_table IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Invalid request' USING ERRCODE = '22023';
  END IF;
  IF NOT public.can_manage_custom_fields() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('vireek.recompute_formulas', '1', true);
  EXECUTE format('UPDATE public.%I SET custom_data = custom_data WHERE %I = $1 AND custom_data <> ''{}''::jsonb',
                 v_table, public.custom_owner_column_for_entity(p_entity)) USING v_owner;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('vireek.recompute_formulas', '0', true);
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_custom_formulas(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_custom_formulas(text) TO authenticated;

-- =============================================================
-- 8. Required-at-stage for jobs (used by move_job_to_status)
-- =============================================================
CREATE OR REPLACE FUNCTION public.job_stage_required_fields(p_owner uuid, p_canonical text)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(key ORDER BY key), '{}'::text[])
    FROM custom_field_definitions
   WHERE user_id = p_owner AND entity = 'job' AND archived_at IS NULL AND p_canonical = ANY (required_stages);
$$;

REVOKE ALL ON FUNCTION public.job_stage_required_fields(uuid, text) FROM PUBLIC;

-- Supersedes the 20281110000000 version: identical except the required-fields check now also
-- includes fields marked "required at this stage" and treats empty multi-selects as missing.
CREATE OR REPLACE FUNCTION public.move_job_to_status(
  p_job_id uuid,
  p_definition_id uuid,
  p_reason_code text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_expected_resume_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job jobs%ROWTYPE;
  v_def status_definitions%ROWTYPE;
  v_role text := 'owner';
  v_view_all boolean := false;
  v_member_id uuid;
  v_is_member boolean := false;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_cur_def_id uuid;
  v_rule_count integer;
  v_rule status_transitions%ROWTYPE;
  v_rule_found boolean := false;
  v_missing text[];
  v_res jsonb;
  v_prev_status text;
  v_required text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Note is too long (max 1000 characters).');
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Job not found.');
  END IF;
  IF v_job.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized for this job';
  END IF;

  IF v_uid IS DISTINCT FROM v_job.user_id THEN
    v_role := 'member';
    SELECT tm.role, COALESCE((tm.permissions->>'can_view_all_jobs')::boolean, false), tm.id, true
      INTO v_role, v_view_all, v_member_id, v_is_member
      FROM team_members tm
     WHERE tm.account_owner_id = v_job.user_id
       AND tm.member_email = (SELECT email FROM auth.users WHERE id = v_uid)
     LIMIT 1;
    IF v_is_member IS NOT TRUE THEN
      RAISE EXCEPTION 'Not authorized for this job';
    END IF;
    IF v_role = 'technician' AND v_view_all IS NOT TRUE
       AND v_job.assigned_technician_id IS DISTINCT FROM v_member_id THEN
      RETURN jsonb_build_object('status', 'forbidden', 'reason', 'You can only update jobs assigned to you.');
    END IF;
  END IF;

  SELECT * INTO v_def FROM status_definitions
   WHERE id = p_definition_id AND user_id = v_job.user_id AND scope = 'job';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Status not found.');
  END IF;
  IF v_def.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'archived', 'reason', 'This status is archived.');
  END IF;

  v_cur_def_id := COALESCE(
    v_job.custom_status_id,
    (SELECT id FROM status_definitions
      WHERE user_id = v_job.user_id AND scope = 'job' AND is_system AND key = v_job.job_status)
  );
  IF v_cur_def_id IS NOT DISTINCT FROM p_definition_id THEN
    RETURN jsonb_build_object('status', 'unchanged', 'reason', 'Job is already in this status.');
  END IF;

  -- Transition rules. No rules configured for the account = unrestricted (legacy behavior).
  SELECT count(*) INTO v_rule_count FROM status_transitions WHERE user_id = v_job.user_id AND scope = 'job';
  IF v_rule_count > 0 THEN
    SELECT t.* INTO v_rule
      FROM status_transitions t
     WHERE t.user_id = v_job.user_id AND t.scope = 'job'
       AND t.to_definition_id = p_definition_id
       AND (t.from_definition_id = v_cur_def_id OR t.from_definition_id IS NULL)
       AND (v_role = 'owner' OR v_role = ANY (t.allowed_roles))
     ORDER BY (t.from_definition_id IS NOT NULL) DESC
     LIMIT 1;
    v_rule_found := FOUND;
    IF NOT v_rule_found THEN
      RETURN jsonb_build_object('status', 'transition_not_allowed',
                                'reason', 'This move isn''t allowed for your role or from the current status.');
    END IF;
  END IF;

  IF (v_def.requires_note OR (v_rule_found AND v_rule.requires_note))
     AND (v_note IS NULL OR length(v_note) < 3) THEN
    RETURN jsonb_build_object('status', 'note_required', 'reason', 'Add a short note to make this move.');
  END IF;

  -- Required by the status definition itself AND by field definitions ("required at stage").
  v_required := ARRAY(
    SELECT DISTINCT x
      FROM unnest(v_def.required_fields || public.job_stage_required_fields(v_job.user_id, v_def.canonical_status)) AS x
  );
  IF cardinality(v_required) > 0 THEN
    SELECT COALESCE(array_agg(f ORDER BY f), '{}'::text[]) INTO v_missing
      FROM unnest(v_required) AS f
     WHERE public.custom_value_is_blank(COALESCE(v_job.custom_data, '{}'::jsonb) -> f);
    IF cardinality(v_missing) > 0 THEN
      RETURN jsonb_build_object('status', 'missing_fields', 'reason', 'Required fields are missing.',
                                'fields', to_jsonb(v_missing));
    END IF;
  END IF;

  v_prev_status := v_job.job_status;

  IF v_def.canonical_status <> v_job.job_status THEN
    IF public.is_job_workflow_status(v_def.canonical_status) THEN
      IF p_reason_code IS NULL THEN
        RETURN jsonb_build_object('status', 'reason_required', 'reason', 'Choose a reason for this status.');
      END IF;
      v_res := public.set_job_workflow_status(p_job_id, v_def.canonical_status, p_reason_code, v_note, p_expected_resume_at);
      IF v_res->>'status' NOT IN ('ok', 'unchanged') THEN
        RETURN v_res;
      END IF;
      IF v_def.sla_minutes IS NOT NULL THEN
        UPDATE job_holds
           SET sla_minutes = v_def.sla_minutes,
               sla_due_at = started_at + make_interval(mins => v_def.sla_minutes)
         WHERE job_id = p_job_id AND resolved_at IS NULL;
      END IF;
    ELSIF public.is_job_workflow_status(v_job.job_status)
          AND v_def.canonical_status IN ('scheduled', 'en_route', 'in_progress') THEN
      v_res := public.resume_job_from_workflow(p_job_id, v_def.canonical_status, v_note);
      IF v_res->>'status' <> 'ok' THEN
        RETURN v_res;
      END IF;
    ELSE
      UPDATE jobs SET job_status = v_def.canonical_status WHERE id = p_job_id;
      INSERT INTO job_status_events (job_id, technician_id, from_status, to_status, note)
      VALUES (p_job_id, v_job.assigned_technician_id, v_prev_status, v_def.canonical_status, v_note);
    END IF;
  END IF;

  -- System definitions are represented by NULL (the legacy shape); custom ones by their id.
  UPDATE jobs
     SET custom_status_id = CASE WHEN v_def.is_system THEN NULL ELSE v_def.id END
   WHERE id = p_job_id;

  PERFORM public.log_audit_event(
    v_job.user_id, 'job_status_moved', 'jobs', p_job_id::text,
    jsonb_build_object('definition_key', v_def.key, 'definition_version', v_def.version,
                       'from_status', v_prev_status, 'to_status', v_def.canonical_status)
  );

  RETURN jsonb_build_object('status', 'ok', 'job_status', v_def.canonical_status,
                            'definition_id', v_def.id, 'definition_version', v_def.version);
END;
$$;

REVOKE ALL ON FUNCTION public.move_job_to_status(uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_job_to_status(uuid, uuid, text, text, timestamptz) TO authenticated;
