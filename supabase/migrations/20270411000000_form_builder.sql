/*
  # Form Builder (on field_form_templates)

  ## Why
  field_form_templates (20270215000000) already ships system templates and the
  technician-side offline engine, but the office had no way to author forms.
  This migration adds the write side:

  - schema v2 field types: photo, signature, pass_fail (+ numeric min/max/unit,
    conditional visibility via `show_if`) — all stored inside the existing
    `schema` jsonb, so the table, the get_field_form_templates() RPC and the
    device cache keep working unchanged and old clients simply ignore what
    they do not understand.
  - field_form_schema_error(): one server-side validator for the whole schema
    (types, unique ids, select options, numeric bounds, and that a `show_if`
    only references EARLIER fields, which makes cycles impossible).
  - can_manage_field_forms(): owner, or a team member whose role grants
    can_edit_business_profile. Enforced in the database, not only the UI.
  - save_field_form_template(): publishing ALWAYS creates a new immutable
    version (previous versions are deactivated, never edited) so every
    submission a technician already made stays tied to the version they filled in.
  - set_field_form_active() / delete_field_form_template(): archive, restore
    and delete a whole template (all versions) for the caller's account.

  ## Override semantics (unchanged from 20270215000000)
  An account template with the same slug as a system template overrides it.
  Archiving or deleting the account template makes the system default visible
  to technicians again.

  ## Depends on
  20270215000000_field_form_templates.sql
  20261212000000_technician_mobile_os.sql (get_account_owner_id)
  20261103000000_enterprise_identity_security.sql (custom_roles)
*/

-- =============================================================
-- 1. PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_field_forms()
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
      WHERE (
          tm.user_id = auth.uid()
          OR tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        )
        AND tm.invite_status = 'active'
        AND (
          COALESCE(tm.permissions ->> 'can_edit_business_profile', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_edit_business_profile', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_field_forms() TO authenticated;

-- =============================================================
-- 2. SCHEMA VALIDATOR (returns NULL when valid, else a short message)
-- =============================================================

CREATE OR REPLACE FUNCTION public.field_form_schema_error(p_schema jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_fields jsonb;
  v_field jsonb;
  v_cond jsonb;
  v_idx integer := 0;
  v_seen text[] := ARRAY[]::text[];
  v_id text;
  v_type text;
  v_src_type text;
  v_types text[] := ARRAY['text','textarea','number','checkbox','select','yes_no','pass_fail','photo','signature'];
  v_ops text[] := ARRAY['equals','not_equals','greater_than','less_than','is_filled','is_empty'];
  v_min numeric;
  v_max numeric;
  v_opt jsonb;
  v_types_by_id jsonb := '{}'::jsonb;
BEGIN
  IF p_schema IS NULL OR jsonb_typeof(p_schema) <> 'object' THEN
    RETURN 'schema must be an object';
  END IF;
  v_fields := p_schema -> 'fields';
  IF v_fields IS NULL OR jsonb_typeof(v_fields) <> 'array' THEN
    RETURN 'schema.fields must be an array';
  END IF;
  IF jsonb_array_length(v_fields) < 1 THEN
    RETURN 'a form needs at least one field';
  END IF;
  IF jsonb_array_length(v_fields) > 100 THEN
    RETURN 'a form can have at most 100 fields';
  END IF;

  FOR v_field IN SELECT value FROM jsonb_array_elements(v_fields) LOOP
    v_idx := v_idx + 1;
    IF jsonb_typeof(v_field) <> 'object' THEN
      RETURN format('field %s must be an object', v_idx);
    END IF;

    v_id := v_field ->> 'id';
    v_type := v_field ->> 'type';

    IF v_id IS NULL OR v_id !~ '^[a-z0-9_]{1,40}$' THEN
      RETURN format('field %s has an invalid id (use a-z, 0-9, _; max 40)', v_idx);
    END IF;
    IF v_id = ANY (v_seen) THEN
      RETURN format('duplicate field id "%s"', v_id);
    END IF;
    IF v_type IS NULL OR NOT (v_type = ANY (v_types)) THEN
      RETURN format('field "%s" has an unknown type', v_id);
    END IF;
    IF v_field ->> 'label' IS NULL OR char_length(btrim(v_field ->> 'label')) NOT BETWEEN 1 AND 200 THEN
      RETURN format('field "%s" needs a label (1-200 characters)', v_id);
    END IF;
    IF v_field ->> 'help' IS NOT NULL AND char_length(v_field ->> 'help') > 500 THEN
      RETURN format('field "%s" help text is too long', v_id);
    END IF;

    IF v_type = 'select' THEN
      IF jsonb_typeof(v_field -> 'options') IS DISTINCT FROM 'array' THEN
        RETURN format('select "%s" needs between 1 and 30 options', v_id);
      END IF;
      IF jsonb_array_length(v_field -> 'options') NOT BETWEEN 1 AND 30 THEN
        RETURN format('select "%s" needs between 1 and 30 options', v_id);
      END IF;
      FOR v_opt IN SELECT value FROM jsonb_array_elements(v_field -> 'options') LOOP
        IF jsonb_typeof(v_opt) <> 'string' OR char_length(btrim(v_opt #>> '{}')) NOT BETWEEN 1 AND 100 THEN
          RETURN format('select "%s" has an invalid option', v_id);
        END IF;
      END LOOP;
    END IF;

    IF v_type = 'number' THEN
      IF v_field ? 'min' AND jsonb_typeof(v_field -> 'min') <> 'number' THEN
        RETURN format('number "%s" min must be a number', v_id);
      END IF;
      IF v_field ? 'max' AND jsonb_typeof(v_field -> 'max') <> 'number' THEN
        RETURN format('number "%s" max must be a number', v_id);
      END IF;
      IF (v_field ? 'min') AND (v_field ? 'max')
         AND (v_field ->> 'min')::numeric > (v_field ->> 'max')::numeric THEN
        RETURN format('number "%s" min is greater than max', v_id);
      END IF;
      IF v_field ? 'unit' AND char_length(v_field ->> 'unit') > 20 THEN
        RETURN format('number "%s" unit is too long', v_id);
      END IF;
    END IF;

    IF v_type = 'photo' THEN
      IF (v_field ? 'min_photos' AND jsonb_typeof(v_field -> 'min_photos') <> 'number')
         OR (v_field ? 'max_photos' AND jsonb_typeof(v_field -> 'max_photos') <> 'number') THEN
        RETURN format('photo "%s" limits must be numbers', v_id);
      END IF;
      v_min := COALESCE((v_field ->> 'min_photos')::numeric, 0);
      v_max := COALESCE((v_field ->> 'max_photos')::numeric, 10);
      IF v_min < 0 OR v_max > 10 OR v_min > v_max OR v_max < 1 THEN
        RETURN format('photo "%s" must allow 1-10 photos with min <= max', v_id);
      END IF;
    END IF;

    IF v_field ? 'show_if' THEN
      IF jsonb_typeof(v_field -> 'show_if') <> 'object'
         OR NOT COALESCE((v_field -> 'show_if' ->> 'match') = ANY (ARRAY['all','any']), false)
         OR jsonb_typeof(v_field -> 'show_if' -> 'conditions') IS DISTINCT FROM 'array' THEN
        RETURN format('field "%s" has an invalid show_if', v_id);
      END IF;
      IF jsonb_array_length(v_field -> 'show_if' -> 'conditions') NOT BETWEEN 1 AND 10 THEN
        RETURN format('field "%s" has an invalid show_if', v_id);
      END IF;
      FOR v_cond IN SELECT value FROM jsonb_array_elements(v_field -> 'show_if' -> 'conditions') LOOP
        IF jsonb_typeof(v_cond) <> 'object' THEN
          RETURN format('field "%s" has an invalid show_if', v_id);
        END IF;
        IF NOT COALESCE((v_cond ->> 'field') = ANY (v_seen), false) THEN
          RETURN format('field "%s" can only depend on fields placed before it', v_id);
        END IF;
        IF NOT COALESCE((v_cond ->> 'op') = ANY (v_ops), false) THEN
          RETURN format('field "%s" has an unknown condition operator', v_id);
        END IF;
        v_src_type := v_types_by_id ->> (v_cond ->> 'field');
        IF v_src_type IN ('photo', 'signature') THEN
          RETURN format('field "%s" cannot depend on a photo or signature', v_id);
        END IF;
        IF (v_cond ->> 'op') IN ('equals','not_equals','greater_than','less_than')
           AND NOT (v_cond ? 'value') THEN
          RETURN format('field "%s" has a condition without a value', v_id);
        END IF;
      END LOOP;
    END IF;

    v_seen := array_append(v_seen, v_id);
    v_types_by_id := v_types_by_id || jsonb_build_object(v_id, v_type);
  END LOOP;

  RETURN NULL;
END;
$$;

-- Defence in depth for any direct owner insert/update: NOT VALID skips the
-- (already valid) seeded rows but checks every new or changed row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'field_form_templates_schema_valid'
  ) THEN
    ALTER TABLE field_form_templates
      ADD CONSTRAINT field_form_templates_schema_valid
      CHECK (public.field_form_schema_error(schema) IS NULL) NOT VALID;
  END IF;
END;
$$;

-- =============================================================
-- 3. RPC: save_field_form_template  (publish = new immutable version)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_field_form_template(
  p_slug text,
  p_title text,
  p_description text,
  p_trade text,
  p_schema jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_title text := btrim(COALESCE(p_title, ''));
  v_desc text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_trade text := NULLIF(btrim(COALESCE(p_trade, '')), '');
  v_err text;
  v_version integer;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_field_forms() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'invalid_slug';
  END IF;
  IF char_length(v_title) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'invalid_title';
  END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 500 THEN
    RAISE EXCEPTION 'invalid_description';
  END IF;
  IF v_trade IS NOT NULL AND v_trade NOT IN ('hvac', 'plumbing', 'electrical', 'general') THEN
    RAISE EXCEPTION 'invalid_trade';
  END IF;

  v_err := public.field_form_schema_error(p_schema);
  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_schema: %', v_err;
  END IF;

  -- Serialise concurrent publishes of the same slug for this account.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':' || p_slug, 0));

  SELECT COALESCE(max(version), 0) + 1 INTO v_version
  FROM field_form_templates
  WHERE owner_id = v_owner AND slug = p_slug;

  UPDATE field_form_templates
  SET is_active = false, updated_at = now()
  WHERE owner_id = v_owner AND slug = p_slug AND is_active;

  INSERT INTO field_form_templates (owner_id, slug, title, description, trade, version, schema, is_active)
  VALUES (v_owner, p_slug, v_title, v_desc, v_trade, v_version, p_schema, true)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'slug', p_slug, 'version', v_version);
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_field_form_template(text, text, text, text, jsonb) TO authenticated;

-- =============================================================
-- 4. RPC: set_field_form_active  (archive / restore a whole template)
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_field_form_active(p_slug text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_latest integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_field_forms() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT max(version) INTO v_latest
  FROM field_form_templates WHERE owner_id = v_owner AND slug = p_slug;
  IF v_latest IS NULL THEN
    RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE field_form_templates
  SET is_active = (p_active AND version = v_latest), updated_at = now()
  WHERE owner_id = v_owner AND slug = p_slug;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_field_form_active(text, boolean) TO authenticated;

-- =============================================================
-- 5. RPC: delete_field_form_template  (all versions, account rows only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_field_form_template(p_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_deleted integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_field_forms() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  DELETE FROM field_form_templates WHERE owner_id = v_owner AND slug = p_slug;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_field_form_template(text) TO authenticated;
