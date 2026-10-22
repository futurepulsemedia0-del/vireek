/*
  # Employee onboarding & HR basics — /dashboard/hr

  ## What this adds
    hr_onboarding_templates       — reusable onboarding checklists ("Field technician", "Office / dispatcher")
    hr_onboarding_template_items  — checklist lines: paperwork, tools, uniform, vehicle, training, other
    hr_onboardings                — one onboarding run per employee (start date + chosen template)
    hr_onboarding_tasks           — assigned tasks with due dates (copied from the template, editable)
    hr_documents                  — document collection (W-4, I-9, licence, certifications ...) + private file storage
    hr_reviews                    — 30/60/90-day reviews (auto-scheduled) + annual / ad-hoc reviews with ratings & notes

  ## Security — OWNER ONLY
  HR data is sensitive (IDs, tax forms, performance notes). Every table is readable and writable ONLY by the
  account owner (profiles.role = 'owner' and user_id = auth.uid()). Team members — including admins and anyone
  with can_manage_team / can_view_billing — get nothing, on purpose. Child rows must reference an employee
  that belongs to the same owner (checked in the policies, so one account can never attach rows to another).
  Documents live in the PRIVATE storage bucket `hr-documents`, folder = owner id, owner-only as well.

  ## Behaviour enforced in the database (the UI only mirrors it)
  - hr_start_onboarding(): one atomic call creates the onboarding, copies the template into dated tasks,
    creates "requested" document rows for template lines that need a document, and schedules the
    30/60/90-day reviews. Only one ACTIVE onboarding per employee (unique index).
  - Receiving / verifying a document auto-completes the task it belongs to.
  - When the last required task is done or skipped the onboarding becomes 'completed'; re-opening a task re-activates it.
  - Review ratings must be whole numbers 1-5; a completed review needs an overall rating and a review date.
  - hr_notify_due_reviews(): idempotent in-app reminder (notifications table) for reviews due within 7 days or overdue.
  - hr_seed_starter_templates(): creates two starter templates, only when the owner has none.

  Uses employees (Payroll -> Employees) from 20261204000000_payroll.sql as the employee record.
*/

-- =============================================================
-- HELPER — owner check (SECURITY DEFINER so it can read profiles under RLS)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hr_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner');
$$;

REVOKE ALL ON FUNCTION public.hr_is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_is_owner() TO authenticated;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS hr_onboarding_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_templates_name ON hr_onboarding_templates (user_id, lower(btrim(name))) WHERE active;

CREATE TABLE IF NOT EXISTS hr_onboarding_template_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES hr_onboarding_templates(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  category text NOT NULL DEFAULT 'paperwork' CHECK (category IN ('paperwork', 'tools', 'uniform', 'vehicle', 'training', 'other')),
  due_offset_days integer NOT NULL DEFAULT 0 CHECK (due_offset_days BETWEEN 0 AND 365),
  required boolean NOT NULL DEFAULT true,
  document_type text CHECK (document_type IS NULL OR document_type IN ('w4', 'i9', 'direct_deposit', 'license', 'insurance', 'certification', 'contract', 'handbook_ack', 'other')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_template_items_template ON hr_onboarding_template_items (template_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_onboardings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  template_id uuid REFERENCES hr_onboarding_templates(id) ON DELETE SET NULL,
  template_name text,
  start_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  completed_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_onboardings_one_active ON hr_onboardings (employee_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_hr_onboardings_owner ON hr_onboardings (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL REFERENCES hr_onboardings(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('paperwork', 'tools', 'uniform', 'vehicle', 'training', 'other')),
  due_date date,
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  completed_at timestamptz,
  completed_by uuid,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  document_type text CHECK (document_type IS NULL OR document_type IN ('w4', 'i9', 'direct_deposit', 'license', 'insurance', 'certification', 'contract', 'handbook_ack', 'other')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_tasks_onboarding ON hr_onboarding_tasks (onboarding_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_hr_tasks_open_due ON hr_onboarding_tasks (user_id, due_date) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS hr_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  onboarding_id uuid REFERENCES hr_onboardings(id) ON DELETE SET NULL,
  task_id uuid REFERENCES hr_onboarding_tasks(id) ON DELETE SET NULL,
  doc_type text NOT NULL DEFAULT 'other' CHECK (doc_type IN ('w4', 'i9', 'direct_deposit', 'license', 'insurance', 'certification', 'contract', 'handbook_ack', 'other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'received', 'verified')),
  expires_on date,
  storage_path text CHECK (storage_path IS NULL OR char_length(storage_path) <= 400),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 200),
  mime_type text CHECK (mime_type IS NULL OR char_length(mime_type) <= 100),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  received_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_documents_requested_has_no_file CHECK (status <> 'requested' OR storage_path IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_hr_documents_employee ON hr_documents (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_documents_expiry ON hr_documents (user_id, expires_on) WHERE expires_on IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  onboarding_id uuid REFERENCES hr_onboardings(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('day_30', 'day_60', 'day_90', 'annual', 'ad_hoc')),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'skipped')),
  reviewed_on date,
  overall_rating smallint CHECK (overall_rating IS NULL OR overall_rating BETWEEN 1 AND 5),
  ratings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ratings) = 'object'),
  strengths text CHECK (strengths IS NULL OR char_length(strengths) <= 2000),
  improvements text CHECK (improvements IS NULL OR char_length(improvements) <= 2000),
  goals text CHECK (goals IS NULL OR char_length(goals) <= 2000),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  reviewer_id uuid,
  completed_at timestamptz,
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_reviews_completed_has_rating CHECK (status <> 'completed' OR (overall_rating IS NOT NULL AND reviewed_on IS NOT NULL))
);
-- At most one 30/60/90 review per employee (annual and ad-hoc reviews can repeat).
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_reviews_milestone ON hr_reviews (employee_id, kind) WHERE kind IN ('day_30', 'day_60', 'day_90');
CREATE INDEX IF NOT EXISTS idx_hr_reviews_employee ON hr_reviews (employee_id, due_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_reviews_open_due ON hr_reviews (user_id, due_date) WHERE status = 'scheduled';

-- =============================================================
-- ROW LEVEL SECURITY — owner only
-- =============================================================

ALTER TABLE hr_onboarding_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_onboarding_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_onboardings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_owner_all" ON hr_onboarding_templates;
CREATE POLICY "hr_owner_all" ON hr_onboarding_templates FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.hr_is_owner())
  WITH CHECK (user_id = auth.uid() AND public.hr_is_owner());

-- Child tables: the parent must also be visible to (= owned by) the caller.
DROP POLICY IF EXISTS "hr_owner_all" ON hr_onboarding_template_items;
CREATE POLICY "hr_owner_all" ON hr_onboarding_template_items FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.hr_is_owner())
  WITH CHECK (
    user_id = auth.uid() AND public.hr_is_owner()
    AND EXISTS (SELECT 1 FROM hr_onboarding_templates t WHERE t.id = template_id AND t.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "hr_owner_all" ON hr_onboardings;
CREATE POLICY "hr_owner_all" ON hr_onboardings FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.hr_is_owner())
  WITH CHECK (
    user_id = auth.uid() AND public.hr_is_owner()
    AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "hr_owner_all" ON hr_onboarding_tasks;
CREATE POLICY "hr_owner_all" ON hr_onboarding_tasks FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.hr_is_owner())
  WITH CHECK (
    user_id = auth.uid() AND public.hr_is_owner()
    AND EXISTS (SELECT 1 FROM hr_onboardings o WHERE o.id = onboarding_id AND o.user_id = auth.uid() AND o.employee_id = hr_onboarding_tasks.employee_id)
  );

DROP POLICY IF EXISTS "hr_owner_all" ON hr_documents;
CREATE POLICY "hr_owner_all" ON hr_documents FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.hr_is_owner())
  WITH CHECK (
    user_id = auth.uid() AND public.hr_is_owner()
    AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
    AND (task_id IS NULL OR EXISTS (SELECT 1 FROM hr_onboarding_tasks k WHERE k.id = task_id AND k.user_id = auth.uid() AND k.employee_id = hr_documents.employee_id))
  );

DROP POLICY IF EXISTS "hr_owner_all" ON hr_reviews;
CREATE POLICY "hr_owner_all" ON hr_reviews FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.hr_is_owner())
  WITH CHECK (
    user_id = auth.uid() AND public.hr_is_owner()
    AND EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
  );

-- =============================================================
-- TRIGGERS
-- =============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_onboarding_templates', 'hr_onboarding_template_items', 'hr_onboardings', 'hr_onboarding_tasks', 'hr_documents', 'hr_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', t, t);
  END LOOP;
END $$;

-- Task: stamp completion, never allow a task to be re-parented to another employee/onboarding.
CREATE OR REPLACE FUNCTION public.hr_task_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.onboarding_id := OLD.onboarding_id;
    NEW.employee_id := OLD.employee_id;
  END IF;
  IF NEW.status = 'pending' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF OLD.status = 'pending' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_task_guard ON hr_onboarding_tasks;
CREATE TRIGGER trg_hr_task_guard BEFORE INSERT OR UPDATE ON hr_onboarding_tasks
  FOR EACH ROW EXECUTE FUNCTION public.hr_task_guard();

-- Onboarding completes itself when the last REQUIRED task is done/skipped, and re-opens if one is added/re-opened.
CREATE OR REPLACE FUNCTION public.hr_sync_onboarding_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_id := OLD.onboarding_id; ELSE v_id := NEW.onboarding_id; END IF;
  IF EXISTS (SELECT 1 FROM hr_onboarding_tasks WHERE onboarding_id = v_id AND required AND status = 'pending') THEN
    UPDATE hr_onboardings o SET status = 'active', completed_at = NULL
     WHERE o.id = v_id AND o.status = 'completed'
       AND NOT EXISTS (SELECT 1 FROM hr_onboardings x WHERE x.employee_id = o.employee_id AND x.status = 'active');
  ELSE
    UPDATE hr_onboardings SET status = 'completed', completed_at = now() WHERE id = v_id AND status = 'active';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_sync_onboarding_status ON hr_onboarding_tasks;
CREATE TRIGGER trg_hr_sync_onboarding_status AFTER INSERT OR DELETE OR UPDATE OF status, required ON hr_onboarding_tasks
  FOR EACH ROW EXECUTE FUNCTION public.hr_sync_onboarding_status();

-- Document: stamp received/verified times; going back to "requested" clears them.
CREATE OR REPLACE FUNCTION public.hr_document_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.employee_id := OLD.employee_id;
  END IF;
  IF NEW.status = 'requested' THEN
    NEW.received_at := NULL;
    NEW.verified_at := NULL;
  ELSE
    NEW.received_at := COALESCE(NEW.received_at, now());
    IF NEW.status = 'verified' THEN NEW.verified_at := COALESCE(NEW.verified_at, now()); ELSE NEW.verified_at := NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_document_guard ON hr_documents;
CREATE TRIGGER trg_hr_document_guard BEFORE INSERT OR UPDATE ON hr_documents
  FOR EACH ROW EXECUTE FUNCTION public.hr_document_guard();

-- Receiving or verifying a document completes the checklist task it belongs to.
CREATE OR REPLACE FUNCTION public.hr_document_completes_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NEW.status IN ('received', 'verified') THEN
    UPDATE hr_onboarding_tasks SET status = 'done' WHERE id = NEW.task_id AND status = 'pending';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_document_completes_task ON hr_documents;
CREATE TRIGGER trg_hr_document_completes_task AFTER INSERT OR UPDATE OF status ON hr_documents
  FOR EACH ROW EXECUTE FUNCTION public.hr_document_completes_task();

-- Review: ratings must be whole numbers 1-5; stamp completion.
CREATE OR REPLACE FUNCTION public.hr_review_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.employee_id := OLD.employee_id;
    NEW.kind := OLD.kind;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(NEW.ratings) e
     WHERE jsonb_typeof(e.value) <> 'number' OR e.value::text !~ '^[1-5]$'
  ) THEN
    RAISE EXCEPTION 'hr_invalid_rating' USING ERRCODE = '22023';
  END IF;
  IF NEW.status = 'completed' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    NEW.reviewer_id := COALESCE(NEW.reviewer_id, auth.uid());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_review_guard ON hr_reviews;
CREATE TRIGGER trg_hr_review_guard BEFORE INSERT OR UPDATE ON hr_reviews
  FOR EACH ROW EXECUTE FUNCTION public.hr_review_guard();

-- =============================================================
-- RPC: start an onboarding (atomic)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hr_start_onboarding(p_employee_id uuid, p_template_id uuid, p_start_date date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tpl hr_onboarding_templates%ROWTYPE;
  v_onb uuid;
  v_task uuid;
  it record;
BEGIN
  IF v_uid IS NULL OR NOT public.hr_is_owner() THEN RAISE EXCEPTION 'hr_forbidden' USING ERRCODE = '42501'; END IF;
  IF p_start_date IS NULL OR p_start_date < current_date - 366 OR p_start_date > current_date + 366 THEN
    RAISE EXCEPTION 'hr_invalid_start_date' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'hr_employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_tpl FROM hr_onboarding_templates WHERE id = p_template_id AND user_id = v_uid AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'hr_template_not_found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM hr_onboardings WHERE employee_id = p_employee_id AND status = 'active') THEN
    RAISE EXCEPTION 'hr_onboarding_exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO hr_onboardings (user_id, employee_id, template_id, template_name, start_date)
  VALUES (v_uid, p_employee_id, v_tpl.id, v_tpl.name, p_start_date)
  RETURNING id INTO v_onb;

  FOR it IN
    SELECT * FROM hr_onboarding_template_items WHERE template_id = v_tpl.id AND user_id = v_uid ORDER BY sort_order, created_at
  LOOP
    INSERT INTO hr_onboarding_tasks (user_id, onboarding_id, employee_id, title, description, category, due_date, required, document_type, sort_order)
    VALUES (v_uid, v_onb, p_employee_id, it.title, it.description, it.category, p_start_date + it.due_offset_days, it.required, it.document_type, it.sort_order)
    RETURNING id INTO v_task;
    IF it.document_type IS NOT NULL THEN
      INSERT INTO hr_documents (user_id, employee_id, onboarding_id, task_id, doc_type, title)
      VALUES (v_uid, p_employee_id, v_onb, v_task, it.document_type, left(it.title, 120));
    END IF;
  END LOOP;

  INSERT INTO hr_reviews (user_id, employee_id, onboarding_id, kind, due_date)
  VALUES (v_uid, p_employee_id, v_onb, 'day_30', p_start_date + 30),
         (v_uid, p_employee_id, v_onb, 'day_60', p_start_date + 60),
         (v_uid, p_employee_id, v_onb, 'day_90', p_start_date + 90)
  ON CONFLICT DO NOTHING;

  RETURN v_onb;
END;
$$;

REVOKE ALL ON FUNCTION public.hr_start_onboarding(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_start_onboarding(uuid, uuid, date) TO authenticated;

-- =============================================================
-- RPC: in-app reminders for reviews due within 7 days (or overdue). Idempotent.
-- =============================================================

CREATE OR REPLACE FUNCTION public.hr_notify_due_reviews()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer := 0;
  r record;
BEGIN
  IF v_uid IS NULL OR NOT public.hr_is_owner() THEN RAISE EXCEPTION 'hr_forbidden' USING ERRCODE = '42501'; END IF;
  FOR r IN
    SELECT v.id, v.kind, v.due_date, e.full_name
      FROM hr_reviews v JOIN employees e ON e.id = v.employee_id
     WHERE v.user_id = v_uid AND v.status = 'scheduled' AND v.reminder_sent_at IS NULL
       AND v.due_date <= current_date + 7 AND e.active
     ORDER BY v.due_date
     LIMIT 50
  LOOP
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      v_uid, 'hr_review_due',
      CASE r.kind WHEN 'day_30' THEN '30-day review due' WHEN 'day_60' THEN '60-day review due' WHEN 'day_90' THEN '90-day review due'
                  WHEN 'annual' THEN 'Annual review due' ELSE 'Performance review due' END,
      r.full_name || CASE WHEN r.due_date < current_date THEN ' · was due ' ELSE ' · due ' END || to_char(r.due_date, 'Mon DD'),
      '/dashboard/hr?tab=reviews'
    );
    UPDATE hr_reviews SET reminder_sent_at = now() WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.hr_notify_due_reviews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_notify_due_reviews() TO authenticated;

-- =============================================================
-- RPC: starter templates (only when the owner has none)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hr_seed_starter_templates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tpl uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.hr_is_owner() THEN RAISE EXCEPTION 'hr_forbidden' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM hr_onboarding_templates WHERE user_id = v_uid) THEN RETURN 0; END IF;

  INSERT INTO hr_onboarding_templates (user_id, name, description)
  VALUES (v_uid, 'Field technician', 'Paperwork, tools, uniform, vehicle and safety training for a new service technician.')
  RETURNING id INTO v_tpl;

  INSERT INTO hr_onboarding_template_items (user_id, template_id, title, category, due_offset_days, required, document_type, sort_order, description)
  SELECT v_uid, v_tpl, i.title, i.category, i.due, i.req, i.doc::text, i.ord, i.descr
    FROM (VALUES
      ('Sign offer letter & employment agreement', 'paperwork', 0, true, 'contract', 10, 'Signed copy goes in the employee file.'),
      ('Complete W-4 tax withholding form', 'paperwork', 0, true, 'w4', 20, NULL),
      ('Verify work eligibility (Form I-9)', 'paperwork', 3, true, 'i9', 30, 'Must be completed within 3 business days of the start date.'),
      ('Set up direct deposit', 'paperwork', 3, true, 'direct_deposit', 40, NULL),
      ('Copy of driver''s licence', 'paperwork', 1, true, 'license', 50, 'Required before the service vehicle is assigned.'),
      ('Acknowledge employee handbook & safety policy', 'paperwork', 7, true, 'handbook_ack', 60, NULL),
      ('Invite to Vireek (Team page) & confirm login', 'tools', 0, true, NULL, 70, NULL),
      ('Install the mobile app & test a clock-in', 'tools', 1, true, NULL, 80, NULL),
      ('Issue phone / tablet', 'tools', 1, false, NULL, 90, NULL),
      ('Issue tool kit & PPE', 'tools', 2, true, NULL, 100, NULL),
      ('Issue uniforms & boots (record sizes)', 'uniform', 2, true, NULL, 110, NULL),
      ('Issue ID badge', 'uniform', 2, false, NULL, 120, NULL),
      ('Assign service vehicle & fuel card', 'vehicle', 3, true, NULL, 130, NULL),
      ('Vehicle walk-through & key handoff', 'vehicle', 3, true, NULL, 140, NULL),
      ('Safety orientation (ladders, electrical, PPE)', 'training', 5, true, NULL, 150, NULL),
      ('Vireek app & dispatch training', 'training', 7, true, NULL, 160, NULL),
      ('Ride-along with a senior technician', 'training', 14, true, NULL, 170, NULL),
      ('Certifications on file (EPA 608 / state licence)', 'training', 30, false, 'certification', 180, NULL)
    ) AS i(title, category, due, req, doc, ord, descr);

  INSERT INTO hr_onboarding_templates (user_id, name, description)
  VALUES (v_uid, 'Office / dispatcher', 'Paperwork, accounts and training for office staff, dispatchers and CSRs.')
  RETURNING id INTO v_tpl;

  INSERT INTO hr_onboarding_template_items (user_id, template_id, title, category, due_offset_days, required, document_type, sort_order, description)
  SELECT v_uid, v_tpl, i.title, i.category, i.due, i.req, i.doc::text, i.ord, i.descr
    FROM (VALUES
      ('Sign offer letter & employment agreement', 'paperwork', 0, true, 'contract', 10, NULL),
      ('Complete W-4 tax withholding form', 'paperwork', 0, true, 'w4', 20, NULL),
      ('Verify work eligibility (Form I-9)', 'paperwork', 3, true, 'i9', 30, 'Must be completed within 3 business days of the start date.'),
      ('Set up direct deposit', 'paperwork', 3, true, 'direct_deposit', 40, NULL),
      ('Acknowledge employee handbook', 'paperwork', 7, true, 'handbook_ack', 50, NULL),
      ('Create Vireek account & set permissions', 'tools', 0, true, NULL, 60, NULL),
      ('Issue laptop / headset', 'tools', 1, true, NULL, 70, NULL),
      ('Call handling & booking script training', 'training', 5, true, NULL, 80, NULL),
      ('Shadow a dispatcher for a day', 'training', 10, true, NULL, 90, NULL)
    ) AS i(title, category, due, req, doc, ord, descr);

  RETURN 2;
END;
$$;

REVOKE ALL ON FUNCTION public.hr_seed_starter_templates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_seed_starter_templates() TO authenticated;

-- =============================================================
-- STORAGE — private bucket, owner only, folder = owner id
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'hr-documents',
  'hr-documents',
  false,
  10485760, -- 10 MB
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "hr_documents_owner_all" ON storage.objects;
CREATE POLICY "hr_documents_owner_all" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'hr-documents' AND (storage.foldername(name))[1] = auth.uid()::text AND public.hr_is_owner())
  WITH CHECK (bucket_id = 'hr-documents' AND (storage.foldername(name))[1] = auth.uid()::text AND public.hr_is_owner());
