/*
# Custom Fields (text / number / select / date / boolean)

## What this migration does
Lets each account define its own fields per entity (customer, lead, job) and
store the values in a `custom_data jsonb` column on that entity's table.

- `custom_field_definitions`   one row per field an account defines
- `custom_data` (jsonb)        added to customers, leads, jobs (+ GIN index)
- `validate_custom_data()`     BEFORE INSERT/UPDATE trigger: the DATABASE
                               enforces keys + types, never just the UI
- `can_manage_custom_fields()` permission helper (owner, or team member /
                               custom role with can_edit_business_profile)
- `delete_custom_field(id)`    strips the key from every record, then deletes

## Security model
1. Tenant scoping: `user_id` = ACCOUNT OWNER id (`get_account_owner_id()`),
   same convention as every other data table.
2. Everyone in the account can READ definitions (forms/tables need them).
   Only owner / members with `can_edit_business_profile` can WRITE them.
3. A record can only hold keys that have a definition in ITS account and
   values of the right type. Select values must be one of the options.
   Payload is capped at 16 KB. Max 30 fields per entity.
4. `key`, `entity` and `field_type` are immutable after creation, so stored
   data can never silently become the wrong type.
5. "Required" is enforced in the UI only (never in the DB) so imports,
   automations and edge functions that don't know about custom fields keep
   working. Archived fields keep their data but disappear from forms.
*/

-- =============================================================
-- 1. PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_custom_fields()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = auth.uid())
      THEN EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    ELSE COALESCE((
      SELECT CASE
        WHEN cr.permissions ? 'can_edit_business_profile'
          THEN (cr.permissions ->> 'can_edit_business_profile') = 'true'
        ELSE COALESCE((tm.permissions ->> 'can_edit_business_profile') = 'true', false)
      END
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_custom_fields() TO authenticated;

-- =============================================================
-- 2. DEFINITIONS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  entity text NOT NULL CHECK (entity IN ('customer', 'lead', 'job')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  field_type text NOT NULL CHECK (field_type IN ('text', 'number', 'select', 'date', 'boolean')),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  required boolean NOT NULL DEFAULT false,
  show_in_table boolean NOT NULL DEFAULT true,
  show_in_filters boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entity, key)
);

-- Friendly duplicate-name protection among ACTIVE fields.
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_fields_active_label
  ON public.custom_field_definitions (user_id, entity, lower(btrim(label)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_custom_fields_user_entity
  ON public.custom_field_definitions (user_id, entity, sort_order);

-- Shape rules + per-entity cap + immutability.
CREATE OR REPLACE FUNCTION public.guard_custom_field_definition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_opt jsonb;
  v_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.key <> OLD.key OR NEW.entity <> OLD.entity
       OR NEW.field_type <> OLD.field_type OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'A custom field''s key, entity and type cannot be changed.' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT count(*) INTO v_count
    FROM custom_field_definitions
    WHERE user_id = NEW.user_id AND entity = NEW.entity AND archived_at IS NULL;
    IF v_count >= 30 THEN
      RAISE EXCEPTION 'You can have at most 30 active custom fields per record type.' USING ERRCODE = '54000';
    END IF;
  END IF;

  IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'options must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF NEW.field_type = 'select' THEN
    IF jsonb_array_length(NEW.options) NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'A select field needs between 1 and 50 options.' USING ERRCODE = '22023';
    END IF;
    FOR v_opt IN SELECT * FROM jsonb_array_elements(NEW.options) LOOP
      IF jsonb_typeof(v_opt) <> 'string'
         OR char_length(btrim(v_opt #>> '{}')) NOT BETWEEN 1 AND 60 THEN
        RAISE EXCEPTION 'Each option must be 1-60 characters.' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  ELSE
    NEW.options := '[]'::jsonb;
  END IF;

  NEW.label := btrim(NEW.label);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_custom_field_definition ON public.custom_field_definitions;
CREATE TRIGGER trg_guard_custom_field_definition
  BEFORE INSERT OR UPDATE ON public.custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_field_definition();

ALTER TABLE public.custom_field_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cfd_select" ON public.custom_field_definitions;
CREATE POLICY "cfd_select" ON public.custom_field_definitions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "cfd_insert" ON public.custom_field_definitions;
CREATE POLICY "cfd_insert" ON public.custom_field_definitions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_custom_fields());

DROP POLICY IF EXISTS "cfd_update" ON public.custom_field_definitions;
CREATE POLICY "cfd_update" ON public.custom_field_definitions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_custom_fields())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_custom_fields());

-- No DELETE policy on purpose: deletion goes through delete_custom_field(),
-- which also removes the stored values.

-- =============================================================
-- 3. custom_data COLUMNS
-- =============================================================

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.leads     ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.jobs      ADD COLUMN IF NOT EXISTS custom_data jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_customers_custom_data ON public.customers USING gin (custom_data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_leads_custom_data     ON public.leads     USING gin (custom_data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_jobs_custom_data      ON public.jobs      USING gin (custom_data jsonb_path_ops);

-- =============================================================
-- 4. VALUE VALIDATION (the database is the source of truth)
-- =============================================================

CREATE OR REPLACE FUNCTION public.custom_entity_for_table(p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_table
    WHEN 'customers' THEN 'customer'
    WHEN 'leads' THEN 'lead'
    WHEN 'jobs' THEN 'job'
  END;
$$;

CREATE OR REPLACE FUNCTION public.validate_custom_data()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entity text := public.custom_entity_for_table(TG_TABLE_NAME);
  v_key text;
  v_val jsonb;
  d record;
  v_text text;
BEGIN
  IF NEW.custom_data IS NULL THEN
    NEW.custom_data := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(NEW.custom_data) <> 'object' THEN
    RAISE EXCEPTION 'custom_data must be a JSON object' USING ERRCODE = '22023';
  END IF;
  -- Untouched values (e.g. legacy rows, archived fields) are never re-judged.
  IF TG_OP = 'UPDATE' AND NEW.custom_data = OLD.custom_data THEN
    RETURN NEW;
  END IF;
  IF octet_length(NEW.custom_data::text) > 16000 THEN
    RAISE EXCEPTION 'Custom field data is too large.' USING ERRCODE = '54000';
  END IF;

  FOR v_key, v_val IN SELECT * FROM jsonb_each(NEW.custom_data) LOOP
    SELECT * INTO d
    FROM custom_field_definitions
    WHERE user_id = NEW.user_id AND entity = v_entity AND key = v_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown custom field: %', v_key USING ERRCODE = '22023';
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
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.customers;
CREATE TRIGGER trg_validate_custom_data
  BEFORE INSERT OR UPDATE OF custom_data ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();

DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.leads;
CREATE TRIGGER trg_validate_custom_data
  BEFORE INSERT OR UPDATE OF custom_data ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();

DROP TRIGGER IF EXISTS trg_validate_custom_data ON public.jobs;
CREATE TRIGGER trg_validate_custom_data
  BEFORE INSERT OR UPDATE OF custom_data ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.validate_custom_data();

-- =============================================================
-- 5. HARD DELETE (removes stored values too)
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_custom_field(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  d record;
  v_table text;
BEGIN
  IF NOT public.can_manage_custom_fields() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO d FROM custom_field_definitions WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom field not found' USING ERRCODE = 'P0002';
  END IF;

  v_table := CASE d.entity
    WHEN 'customer' THEN 'customers'
    WHEN 'lead' THEN 'leads'
    WHEN 'job' THEN 'jobs'
  END;

  -- Strip the key from every record of this account, then drop the field.
  EXECUTE format(
    'UPDATE public.%I SET custom_data = custom_data - $1::text WHERE user_id = $2 AND custom_data ? $1::text',
    v_table
  ) USING d.key, v_owner;

  DELETE FROM custom_field_definitions WHERE id = p_id;

  PERFORM public.log_audit_event(v_owner, 'custom_field_deleted:' || d.entity || ':' || d.key,
                                 'custom_field_definitions', p_id::text);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_custom_field(uuid) TO authenticated;

COMMENT ON TABLE public.custom_field_definitions IS
  'Per-account custom field definitions for customers, leads and jobs. Values live in <table>.custom_data (jsonb), validated by validate_custom_data().';
