/*
  # Job Templates

  ## Why
  Dispatchers re-type the same service, parts list, checklist, duration and
  price every time a common job (e.g. "AC tune-up", "Water heater swap") is
  booked. A template captures that once; the New Job flow applies it in one
  step so the job starts fully scoped.

  ## Model
  - job_templates                 — one row per template (name, service_type,
                                    duration, quoted price, active flag, usage)
  - job_template_services         — line items (optionally linked to Price Book)
  - job_template_parts            — required parts (linked to inventory_parts)
  - job_template_checklist_items  — ordered checklist
  - jobs.job_template_id / job_template_snapshot / quoted_price_cents
                                  — provenance + immutable snapshot, so editing
                                    or deleting a template never rewrites history
  - job_checklist_items           — the per-job checklist copied from a template

  ## Security
  - Every table is keyed to public.get_account_owner_id(), so owners and their
    team members share one account scope (same posture as job_autopsy_reports).
  - READ: any member of the account (a dispatcher must be able to apply one).
  - WRITE: owner, or a team member whose role grants can_view_billing
    (templates carry prices) — enforced in the database by
    can_manage_job_templates(), not only in the UI.
  - Multi-row writes go through SECURITY DEFINER RPCs so they are atomic and
    re-validate ownership/permission on the server:
      save_job_template, duplicate_job_template, apply_job_template,
      set_job_checklist_item_done.

  ## Depends on
  20260821101104_create_profiles_and_team_members.sql (get_account_owner_id)
  20261212000000_technician_mobile_os.sql (get_account_owner_id fix, expected_duration_minutes)
  20260905140000_add_job_duration_minutes.sql (jobs.duration_minutes)
  20260913000000_create_price_book.sql (price_book_items)
  20260928000000_parts_inventory_availability.sql (inventory_parts, job_parts_required)
*/

-- =============================================================
-- 1. PERMISSION HELPER (mirrors can_manage_ai_security)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_job_templates()
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
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_job_templates() TO authenticated;

-- =============================================================
-- 2. TEMPLATES
-- =============================================================

CREATE TABLE IF NOT EXISTS job_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  service_type text CHECK (service_type IS NULL OR char_length(service_type) <= 120),
  expected_duration_minutes integer CHECK (expected_duration_minutes IS NULL OR expected_duration_minutes BETWEEN 5 AND 10080),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  times_used integer NOT NULL DEFAULT 0 CHECK (times_used >= 0),
  last_used_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_templates_user_name
  ON job_templates (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_job_templates_user_active
  ON job_templates (user_id, active, name);

ALTER TABLE job_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_templates" ON job_templates;
CREATE POLICY "select_own_job_templates" ON job_templates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_job_templates" ON job_templates;
CREATE POLICY "insert_own_job_templates" ON job_templates FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_job_templates());
DROP POLICY IF EXISTS "update_own_job_templates" ON job_templates;
CREATE POLICY "update_own_job_templates" ON job_templates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_templates())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_job_templates());
DROP POLICY IF EXISTS "delete_own_job_templates" ON job_templates;
CREATE POLICY "delete_own_job_templates" ON job_templates FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_templates());

CREATE OR REPLACE FUNCTION public.set_job_templates_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_templates_updated_at ON job_templates;
CREATE TRIGGER trg_job_templates_updated_at
  BEFORE UPDATE ON job_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_job_templates_updated_at();

-- =============================================================
-- 3. TEMPLATE CHILDREN (services / parts / checklist)
-- =============================================================

CREATE TABLE IF NOT EXISTS job_template_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES job_templates(id) ON DELETE CASCADE,
  service_name text NOT NULL CHECK (char_length(btrim(service_name)) BETWEEN 1 AND 120),
  price_book_item_id uuid REFERENCES price_book_items(id) ON DELETE SET NULL,
  quantity numeric(8, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents integer NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_template_services_template
  ON job_template_services (template_id, sort_order);

CREATE TABLE IF NOT EXISTS job_template_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES job_templates(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, part_id)
);
CREATE INDEX IF NOT EXISTS idx_job_template_parts_template ON job_template_parts (template_id);

CREATE TABLE IF NOT EXISTS job_template_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES job_templates(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_template_checklist_template
  ON job_template_checklist_items (template_id, sort_order);

ALTER TABLE job_template_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_template_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_template_checklist_items ENABLE ROW LEVEL SECURITY;

-- One policy set per child table; ownership is derived from the parent row.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_template_services', 'job_template_parts', 'job_template_checklist_items']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "select_own_%1$s" ON %1$I', t);
    EXECUTE format(
      'CREATE POLICY "select_own_%1$s" ON %1$I FOR SELECT TO authenticated
         USING (EXISTS (SELECT 1 FROM job_templates jt WHERE jt.id = template_id AND jt.user_id = public.get_account_owner_id()))', t);

    EXECUTE format('DROP POLICY IF EXISTS "insert_own_%1$s" ON %1$I', t);
    EXECUTE format(
      'CREATE POLICY "insert_own_%1$s" ON %1$I FOR INSERT TO authenticated
         WITH CHECK (public.can_manage_job_templates()
           AND EXISTS (SELECT 1 FROM job_templates jt WHERE jt.id = template_id AND jt.user_id = public.get_account_owner_id()))', t);

    EXECUTE format('DROP POLICY IF EXISTS "update_own_%1$s" ON %1$I', t);
    EXECUTE format(
      'CREATE POLICY "update_own_%1$s" ON %1$I FOR UPDATE TO authenticated
         USING (public.can_manage_job_templates()
           AND EXISTS (SELECT 1 FROM job_templates jt WHERE jt.id = template_id AND jt.user_id = public.get_account_owner_id()))
         WITH CHECK (public.can_manage_job_templates()
           AND EXISTS (SELECT 1 FROM job_templates jt WHERE jt.id = template_id AND jt.user_id = public.get_account_owner_id()))', t);

    EXECUTE format('DROP POLICY IF EXISTS "delete_own_%1$s" ON %1$I', t);
    EXECUTE format(
      'CREATE POLICY "delete_own_%1$s" ON %1$I FOR DELETE TO authenticated
         USING (public.can_manage_job_templates()
           AND EXISTS (SELECT 1 FROM job_templates jt WHERE jt.id = template_id AND jt.user_id = public.get_account_owner_id()))', t);
  END LOOP;
END;
$$;

-- =============================================================
-- 4. JOBS: provenance + snapshot, and the per-job checklist
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS job_template_id uuid REFERENCES job_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_template_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS quoted_price_cents integer CHECK (quoted_price_cents IS NULL OR quoted_price_cents >= 0);

CREATE INDEX IF NOT EXISTS idx_jobs_job_template ON jobs (job_template_id) WHERE job_template_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  sort_order integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_checklist_items_job ON job_checklist_items (job_id, sort_order);

ALTER TABLE job_checklist_items ENABLE ROW LEVEL SECURITY;

-- Read-only through the table; writes go through the RPCs below so a client
-- can never rewrite a label or complete an item on someone else's job.
DROP POLICY IF EXISTS "select_own_job_checklist_items" ON job_checklist_items;
CREATE POLICY "select_own_job_checklist_items" ON job_checklist_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.user_id = public.get_account_owner_id()));

-- =============================================================
-- 5. RPC: save_job_template  (atomic upsert + replace children)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_job_template(p_template_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_name text := btrim(COALESCE(p_payload ->> 'name', ''));
  v_services jsonb := COALESCE(p_payload -> 'services', '[]'::jsonb);
  v_parts jsonb := COALESCE(p_payload -> 'parts', '[]'::jsonb);
  v_checklist jsonb := COALESCE(p_payload -> 'checklist', '[]'::jsonb);
  v_part_count integer;
  v_part_valid integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_job_templates() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'name_required';
  END IF;
  IF jsonb_typeof(v_services) <> 'array' OR jsonb_typeof(v_parts) <> 'array' OR jsonb_typeof(v_checklist) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF jsonb_array_length(v_services) > 50 OR jsonb_array_length(v_parts) > 50 OR jsonb_array_length(v_checklist) > 100 THEN
    RAISE EXCEPTION 'too_many_lines';
  END IF;

  -- Every part must belong to this account (inventory_parts is account-owned).
  SELECT count(DISTINCT e ->> 'part_id') INTO v_part_count FROM jsonb_array_elements(v_parts) AS e;
  SELECT count(*) INTO v_part_valid
  FROM inventory_parts ip
  WHERE ip.user_id = v_owner
    AND ip.id IN (SELECT (e ->> 'part_id')::uuid FROM jsonb_array_elements(v_parts) AS e);
  IF v_part_valid <> v_part_count THEN
    RAISE EXCEPTION 'invalid_part';
  END IF;

  IF p_template_id IS NULL THEN
    INSERT INTO job_templates (user_id, name, description, service_type, expected_duration_minutes, price_cents)
    VALUES (
      v_owner,
      v_name,
      NULLIF(btrim(COALESCE(p_payload ->> 'description', '')), ''),
      NULLIF(btrim(COALESCE(p_payload ->> 'service_type', '')), ''),
      NULLIF(p_payload ->> 'expected_duration_minutes', '')::integer,
      COALESCE(NULLIF(p_payload ->> 'price_cents', '')::integer, 0)
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE job_templates SET
      name = v_name,
      description = NULLIF(btrim(COALESCE(p_payload ->> 'description', '')), ''),
      service_type = NULLIF(btrim(COALESCE(p_payload ->> 'service_type', '')), ''),
      expected_duration_minutes = NULLIF(p_payload ->> 'expected_duration_minutes', '')::integer,
      price_cents = COALESCE(NULLIF(p_payload ->> 'price_cents', '')::integer, 0)
    WHERE id = p_template_id AND user_id = v_owner
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM job_template_services WHERE template_id = v_id;
    DELETE FROM job_template_parts WHERE template_id = v_id;
    DELETE FROM job_template_checklist_items WHERE template_id = v_id;
  END IF;

  INSERT INTO job_template_services (template_id, service_name, price_book_item_id, quantity, unit_price_cents, sort_order)
  SELECT
    v_id,
    btrim(s.value ->> 'service_name'),
    (SELECT pb.id FROM price_book_items pb
      WHERE pb.id = NULLIF(s.value ->> 'price_book_item_id', '')::uuid AND pb.user_id = v_owner),
    COALESCE(NULLIF(s.value ->> 'quantity', '')::numeric, 1),
    COALESCE(NULLIF(s.value ->> 'unit_price_cents', '')::integer, 0),
    (s.ordinality - 1)::integer
  FROM jsonb_array_elements(v_services) WITH ORDINALITY AS s(value, ordinality);

  INSERT INTO job_template_parts (template_id, part_id, quantity)
  SELECT v_id, (e ->> 'part_id')::uuid, SUM(COALESCE(NULLIF(e ->> 'quantity', '')::integer, 1))::integer
  FROM jsonb_array_elements(v_parts) AS e
  GROUP BY (e ->> 'part_id')::uuid;

  INSERT INTO job_template_checklist_items (template_id, label, sort_order)
  SELECT v_id, btrim(c.value #>> '{}'), (c.ordinality - 1)::integer
  FROM jsonb_array_elements(v_checklist) WITH ORDINALITY AS c(value, ordinality);

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_job_template(uuid, jsonb) TO authenticated;

-- =============================================================
-- 6. RPC: duplicate_job_template
-- =============================================================

CREATE OR REPLACE FUNCTION public.duplicate_job_template(p_template_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_src job_templates%ROWTYPE;
  v_new uuid;
  v_name text;
  v_n integer := 1;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_job_templates() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_src FROM job_templates WHERE id = p_template_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_name := 'Copy of ' || left(v_src.name, 100);
  WHILE EXISTS (
    SELECT 1 FROM job_templates WHERE user_id = v_owner AND lower(btrim(name)) = lower(btrim(v_name))
  ) LOOP
    v_n := v_n + 1;
    v_name := 'Copy of ' || left(v_src.name, 95) || ' (' || v_n || ')';
  END LOOP;

  INSERT INTO job_templates (user_id, name, description, service_type, expected_duration_minutes, price_cents)
  VALUES (v_owner, v_name, v_src.description, v_src.service_type, v_src.expected_duration_minutes, v_src.price_cents)
  RETURNING id INTO v_new;

  INSERT INTO job_template_services (template_id, service_name, price_book_item_id, quantity, unit_price_cents, sort_order)
  SELECT v_new, service_name, price_book_item_id, quantity, unit_price_cents, sort_order
  FROM job_template_services WHERE template_id = v_src.id;

  INSERT INTO job_template_parts (template_id, part_id, quantity)
  SELECT v_new, part_id, quantity FROM job_template_parts WHERE template_id = v_src.id;

  INSERT INTO job_template_checklist_items (template_id, label, sort_order)
  SELECT v_new, label, sort_order FROM job_template_checklist_items WHERE template_id = v_src.id;

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION public.duplicate_job_template(uuid) TO authenticated;

-- =============================================================
-- 7. RPC: apply_job_template  (called right after the job is created)
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_job_template(p_job_id uuid, p_template_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_tpl job_templates%ROWTYPE;
  v_services jsonb;
  v_checklist_count integer := 0;
  v_parts_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.job_template_id IS NOT NULL THEN
    RAISE EXCEPTION 'template_already_applied';
  END IF;

  SELECT * INTO v_tpl FROM job_templates WHERE id = p_template_id AND user_id = v_owner AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'service_name', s.service_name,
      'quantity', s.quantity,
      'unit_price_cents', s.unit_price_cents,
      'price_book_item_id', s.price_book_item_id
    ) ORDER BY s.sort_order, s.created_at
  ), '[]'::jsonb)
  INTO v_services
  FROM job_template_services s WHERE s.template_id = v_tpl.id;

  UPDATE jobs SET
    job_template_id = v_tpl.id,
    service_type = COALESCE(NULLIF(btrim(service_type), ''), v_tpl.service_type),
    duration_minutes = COALESCE(v_tpl.expected_duration_minutes, duration_minutes),
    expected_duration_minutes = COALESCE(expected_duration_minutes, v_tpl.expected_duration_minutes),
    quoted_price_cents = v_tpl.price_cents,
    job_template_snapshot = jsonb_build_object(
      'template_id', v_tpl.id,
      'name', v_tpl.name,
      'description', v_tpl.description,
      'duration_minutes', v_tpl.expected_duration_minutes,
      'price_cents', v_tpl.price_cents,
      'services', v_services,
      'applied_at', now()
    )
  WHERE id = p_job_id;

  INSERT INTO job_checklist_items (job_id, label, sort_order)
  SELECT p_job_id, c.label, c.sort_order
  FROM job_template_checklist_items c WHERE c.template_id = v_tpl.id;
  GET DIAGNOSTICS v_checklist_count = ROW_COUNT;

  INSERT INTO job_parts_required (user_id, job_id, part_id, quantity_required, status)
  SELECT v_owner, p_job_id, p.part_id, p.quantity, 'needed'
  FROM job_template_parts p
  WHERE p.template_id = v_tpl.id
    AND EXISTS (SELECT 1 FROM inventory_parts ip WHERE ip.id = p.part_id AND ip.user_id = v_owner)
  ON CONFLICT (job_id, part_id) DO NOTHING;
  GET DIAGNOSTICS v_parts_count = ROW_COUNT;

  UPDATE job_templates
  SET times_used = times_used + 1, last_used_at = now()
  WHERE id = v_tpl.id;

  RETURN jsonb_build_object(
    'template_id', v_tpl.id,
    'checklist_items', v_checklist_count,
    'parts', v_parts_count,
    'services', jsonb_array_length(v_services)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_job_template(uuid, uuid) TO authenticated;

-- =============================================================
-- 8. RPC: set_job_checklist_item_done
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_job_checklist_item_done(p_item_id uuid, p_done boolean)
RETURNS job_checklist_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row job_checklist_items;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE job_checklist_items ci SET
    completed_at = CASE WHEN p_done THEN now() ELSE NULL END,
    completed_by = CASE WHEN p_done THEN auth.uid() ELSE NULL END
  FROM jobs j
  WHERE ci.id = p_item_id
    AND j.id = ci.job_id
    AND j.user_id = public.get_account_owner_id()
  RETURNING ci.* INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'item_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_job_checklist_item_done(uuid, boolean) TO authenticated;
