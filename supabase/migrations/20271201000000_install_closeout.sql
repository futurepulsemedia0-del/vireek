/*
  # Install Closeout

  One deadline-driven closeout workflow per major install:
    permit -> inspection -> warranty registration -> rebate claim -> customer documents

  Design
  - Program rules are DATA (closeout_programs): deadline, anchor, required evidence,
    enrollment requirements, pre-approval flag, source URL + last-verified date.
    An ACTIVE program MUST have a source URL and a verified date (DB constraint).
  - Clients cannot write any closeout table. Every change goes through a validated
    SECURITY DEFINER RPC (state machine + guards) that appends to closeout_events
    and the account audit_log.
  - Office/owner roles only (public.is_office_member()). Technicians have no access.
  - NOTHING is ever sent to a manufacturer / utility / government portal by this system.
    "submitted" is a human attestation recorded with approver + timestamp.
  - Eligibility is never promised: values are unknown | likely_verify | not_likely.
  - Not legal advice.

  Purely additive. Reuses get_account_owner_id(), is_office_member(), log_audit_event().
*/

-- 0) Authorization helper ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.get_account_owner_id() IS NOT NULL
     AND public.is_office_member();
$$;

REVOKE ALL ON FUNCTION public.closeout_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.closeout_can_manage() TO authenticated, service_role;

-- 1) Tenant settings (escalation thresholds) ------------------------------------------

CREATE TABLE IF NOT EXISTS closeout_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  technician_days integer NOT NULL DEFAULT 7 CHECK (technician_days BETWEEN 1 AND 90),
  office_days integer NOT NULL DEFAULT 3 CHECK (office_days BETWEEN 0 AND 60),
  owner_days integer NOT NULL DEFAULT 0 CHECK (owner_days BETWEEN -30 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closeout_settings_order CHECK (technician_days >= office_days AND office_days >= owner_days)
);

-- 2) Programs = editable rules ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS closeout_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  step_key text NOT NULL CHECK (step_key IN ('permit', 'inspection', 'warranty', 'rebate', 'customer_docs')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 160),
  administrator text CHECK (administrator IS NULL OR char_length(administrator) <= 160),
  anchor text NOT NULL DEFAULT 'install_date'
    CHECK (anchor IN ('install_date', 'permit_completed', 'inspection_completed', 'job_complete')),
  deadline_days integer CHECK (deadline_days IS NULL OR deadline_days BETWEEN 0 AND 1095),
  requires_pre_approval boolean NOT NULL DEFAULT false,
  required_evidence text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(required_evidence) <= 20 AND required_evidence <@ ARRAY[
      'serial_number', 'model_number', 'install_date', 'photo', 'permit_number', 'certificate',
      'invoice', 'inspection_report', 'warranty_confirmation', 'rebate_form', 'customer_document', 'other'
    ]::text[]),
  enrollment_requirements text[] NOT NULL DEFAULT '{}' CHECK (cardinality(enrollment_requirements) <= 20),
  estimated_value_cents integer CHECK (estimated_value_cents IS NULL OR estimated_value_cents >= 0),
  incentive_program_id uuid REFERENCES incentive_programs(id) ON DELETE SET NULL,
  auto_attach boolean NOT NULL DEFAULT false,
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://[^[:space:]]+$'),
  last_verified_on date,
  reverify_days integer NOT NULL DEFAULT 180 CHECK (reverify_days BETWEEN 30 AND 730),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  is_active boolean NOT NULL DEFAULT false,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closeout_programs_active_needs_source
    CHECK (NOT is_active OR (source_url IS NOT NULL AND last_verified_on IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_closeout_programs_name
  ON closeout_programs(user_id, step_key, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_closeout_programs_user ON closeout_programs(user_id, step_key, is_active);

-- 3) Cases (one per job) --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS closeout_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  install_project_id uuid REFERENCES install_projects(id) ON DELETE SET NULL,
  install_date date,
  job_complete_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_closeout_case_job UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_closeout_cases_user ON closeout_cases(user_id, status, created_at DESC);

-- 4) Steps ------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS closeout_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES closeout_cases(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_key text NOT NULL CHECK (step_key IN ('permit', 'inspection', 'warranty', 'rebate', 'customer_docs')),
  program_id uuid REFERENCES closeout_programs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'ready_for_approval', 'submitted',
                      'completed', 'rejected', 'missed', 'not_applicable')),
  assignee_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  deadline_on date,
  deadline_manual boolean NOT NULL DEFAULT false,
  estimated_value_cents integer CHECK (estimated_value_cents IS NULL OR estimated_value_cents >= 0),
  rebate_application_id uuid REFERENCES rebate_applications(id) ON DELETE SET NULL,
  eligibility text NOT NULL DEFAULT 'unknown' CHECK (eligibility IN ('unknown', 'likely_verify', 'not_likely')),
  pre_approval_required boolean NOT NULL DEFAULT false,
  pre_approval_status text NOT NULL DEFAULT 'not_required'
    CHECK (pre_approval_status IN ('not_required', 'pending', 'requested', 'approved', 'denied')),
  pre_approval_reference text CHECK (pre_approval_reference IS NULL OR char_length(pre_approval_reference) <= 120),
  pre_approval_at timestamptz,
  pre_approval_by uuid,
  reference_number text CHECK (reference_number IS NULL OR char_length(reference_number) <= 120),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  na_reason text CHECK (na_reason IS NULL OR char_length(na_reason) <= 500),
  approved_by uuid,
  approved_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  missed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A step can only sit in "submitted" if a person approved it.
  CONSTRAINT closeout_steps_submitted_needs_human
    CHECK (status <> 'submitted' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND submitted_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_closeout_steps_case_key_program
  ON closeout_steps(case_id, step_key, COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_closeout_steps_user_status ON closeout_steps(user_id, status, deadline_on);
CREATE INDEX IF NOT EXISTS idx_closeout_steps_job ON closeout_steps(job_id);
CREATE INDEX IF NOT EXISTS idx_closeout_steps_case ON closeout_steps(case_id);
CREATE INDEX IF NOT EXISTS idx_closeout_steps_deadline_open ON closeout_steps(deadline_on)
  WHERE status IN ('pending', 'in_progress', 'ready_for_approval', 'rejected', 'missed');

-- 5) Evidence ------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS closeout_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES closeout_cases(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES closeout_steps(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'serial_number', 'model_number', 'install_date', 'photo', 'permit_number', 'certificate',
    'invoice', 'inspection_report', 'warranty_confirmation', 'rebate_form', 'customer_document', 'other')),
  label text CHECK (label IS NULL OR char_length(label) <= 160),
  value text CHECK (value IS NULL OR char_length(value) <= 500),
  job_photo_id uuid REFERENCES job_photos(id) ON DELETE SET NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  added_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closeout_evidence_step ON closeout_evidence(step_id);
CREATE INDEX IF NOT EXISTS idx_closeout_evidence_user ON closeout_evidence(user_id);

-- 6) Immutable audit log (survives job deletion: no FK to cases/steps) ------------------------------

CREATE TABLE IF NOT EXISTS closeout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  case_id uuid,
  step_id uuid,
  job_id uuid,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid,
  actor_email text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (char_length(detail::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closeout_events_user ON closeout_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_closeout_events_case ON closeout_events(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_closeout_events_step ON closeout_events(step_id, created_at DESC);

-- 7) Escalations (dedupe + email delivery queue) ---------------------------------------------------

CREATE TABLE IF NOT EXISTS closeout_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES closeout_steps(id) ON DELETE CASCADE,
  tier smallint NOT NULL CHECK (tier IN (1, 2, 3)),
  deadline_on date NOT NULL,
  days_left integer NOT NULL,
  missing_count integer NOT NULL DEFAULT 0,
  attempts smallint NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  delivery_note text CHECK (delivery_note IS NULL OR char_length(delivery_note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_closeout_escalation UNIQUE (step_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_closeout_escalations_pending ON closeout_escalations(created_at) WHERE delivered_at IS NULL;

-- 8) RLS: read-only for office/owner of the same account; all writes via RPC -----------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['closeout_settings', 'closeout_programs', 'closeout_cases', 'closeout_steps',
                           'closeout_evidence', 'closeout_events', 'closeout_escalations']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "office_select_%s" ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY "office_select_%s" ON public.%I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id() AND public.closeout_can_manage())',
      t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- 9) Pure helpers (mirrored in src/lib/installCloseoutLogic.ts) ----------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_transition_allowed(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM (VALUES
      ('pending', 'in_progress'), ('pending', 'not_applicable'),
      ('in_progress', 'ready_for_approval'), ('in_progress', 'not_applicable'), ('in_progress', 'pending'),
      ('ready_for_approval', 'submitted'), ('ready_for_approval', 'in_progress'),
      ('submitted', 'completed'), ('submitted', 'rejected'),
      ('rejected', 'in_progress'),
      ('missed', 'in_progress'), ('missed', 'not_applicable'),
      ('not_applicable', 'pending')
    ) AS t(f, x) WHERE t.f = p_from AND t.x = p_to
  );
$$;

CREATE OR REPLACE FUNCTION public.closeout_step_dependencies(p_key text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_key
    WHEN 'inspection' THEN ARRAY['permit']
    WHEN 'rebate' THEN ARRAY['inspection']
    WHEN 'customer_docs' THEN ARRAY['permit', 'inspection', 'warranty', 'rebate']
    ELSE ARRAY[]::text[]
  END;
$$;

-- Required evidence kinds with nothing usable attached.
CREATE OR REPLACE FUNCTION public.closeout_missing_evidence(p_step_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(r.req ORDER BY r.req), ARRAY[]::text[])
  FROM (
    SELECT DISTINCT unnest(p.required_evidence) AS req
      FROM closeout_steps s
      JOIN closeout_programs p ON p.id = s.program_id
     WHERE s.id = p_step_id
  ) r
  WHERE NOT EXISTS (
    SELECT 1 FROM closeout_evidence e
     WHERE e.step_id = p_step_id
       AND e.kind = r.req
       AND (btrim(coalesce(e.value, '')) <> '' OR e.job_photo_id IS NOT NULL OR e.document_id IS NOT NULL)
  );
$$;

CREATE OR REPLACE FUNCTION public.closeout_unmet_dependencies(p_case_id uuid, p_key text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT d), ARRAY[]::text[])
  FROM unnest(public.closeout_step_dependencies(p_key)) AS d
  WHERE EXISTS (
    SELECT 1 FROM closeout_steps s
     WHERE s.case_id = p_case_id AND s.step_key = d
       AND s.status NOT IN ('completed', 'not_applicable')
  );
$$;

-- Internal audit writer (not callable by clients).
CREATE OR REPLACE FUNCTION public.closeout_log(
  p_owner uuid, p_case uuid, p_step uuid, p_job uuid,
  p_type text, p_from text, p_to text, p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  END IF;
  INSERT INTO closeout_events (user_id, case_id, step_id, job_id, event_type, from_status, to_status, actor_id, actor_email, detail)
  VALUES (p_owner, p_case, p_step, p_job, p_type, p_from, p_to, auth.uid(), v_email, COALESCE(p_detail, '{}'::jsonb));
  PERFORM public.log_audit_event(p_owner, 'closeout.' || p_type, 'closeout_steps', COALESCE(p_step, p_case)::text);
END;
$$;

-- Recompute computed deadlines (manual deadlines are never touched).
CREATE OR REPLACE FUNCTION public.closeout_recompute_deadlines(p_case_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c closeout_cases%ROWTYPE;
  r record;
  v_anchor date;
  v_new date;
BEGIN
  SELECT * INTO c FROM closeout_cases WHERE id = p_case_id;
  IF NOT FOUND THEN RETURN; END IF;

  FOR r IN
    SELECT s.id, s.deadline_on, p.anchor, p.deadline_days
      FROM closeout_steps s
      JOIN closeout_programs p ON p.id = s.program_id
     WHERE s.case_id = p_case_id AND NOT s.deadline_manual AND p.deadline_days IS NOT NULL
  LOOP
    v_anchor := NULL;
    IF r.anchor = 'install_date' THEN
      v_anchor := c.install_date;
    ELSIF r.anchor = 'job_complete' THEN
      v_anchor := c.job_complete_date;
    ELSIF r.anchor = 'permit_completed' THEN
      SELECT max(s2.completed_at)::date INTO v_anchor FROM closeout_steps s2
       WHERE s2.case_id = p_case_id AND s2.step_key = 'permit' AND s2.status = 'completed';
    ELSIF r.anchor = 'inspection_completed' THEN
      SELECT max(s2.completed_at)::date INTO v_anchor FROM closeout_steps s2
       WHERE s2.case_id = p_case_id AND s2.step_key = 'inspection' AND s2.status = 'completed';
    END IF;

    v_new := CASE WHEN v_anchor IS NULL THEN NULL ELSE v_anchor + r.deadline_days END;
    IF v_new IS DISTINCT FROM r.deadline_on THEN
      UPDATE closeout_steps SET deadline_on = v_new, updated_at = now() WHERE id = r.id;
      DELETE FROM closeout_escalations WHERE step_id = r.id;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_refresh_case_status(p_case_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c closeout_cases%ROWTYPE;
  v_open integer;
BEGIN
  SELECT * INTO c FROM closeout_cases WHERE id = p_case_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO v_open FROM closeout_steps
   WHERE case_id = p_case_id AND status NOT IN ('completed', 'not_applicable');
  IF v_open = 0 AND c.status = 'open' THEN
    UPDATE closeout_cases SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = p_case_id;
    PERFORM public.closeout_log(c.user_id, c.id, NULL, c.job_id, 'case_closed', 'open', 'closed', '{}'::jsonb);
  ELSIF v_open > 0 AND c.status = 'closed' THEN
    UPDATE closeout_cases SET status = 'open', closed_at = NULL, updated_at = now() WHERE id = p_case_id;
    PERFORM public.closeout_log(c.user_id, c.id, NULL, c.job_id, 'case_reopened', 'closed', 'open', '{}'::jsonb);
  END IF;
END;
$$;

-- 10) Open a case (internal + public wrapper) ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_open_case_internal(p_owner uuid, p_job_id uuid, p_install_date date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_case uuid;
  v_key text;
  p record;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found.' USING ERRCODE = 'P0002'; END IF;

  SELECT id INTO v_case FROM closeout_cases WHERE job_id = p_job_id;
  IF v_case IS NOT NULL THEN RETURN v_case; END IF;

  INSERT INTO closeout_cases (user_id, job_id, install_date)
  VALUES (p_owner, p_job_id, p_install_date)
  RETURNING id INTO v_case;

  -- one step per auto-attach active program
  FOR p IN
    SELECT * FROM closeout_programs WHERE user_id = p_owner AND is_active AND auto_attach ORDER BY step_key, name
  LOOP
    INSERT INTO closeout_steps (user_id, case_id, job_id, step_key, program_id, estimated_value_cents,
                                pre_approval_required, pre_approval_status)
    VALUES (p_owner, v_case, p_job_id, p.step_key, p.id, p.estimated_value_cents,
            p.requires_pre_approval, CASE WHEN p.requires_pre_approval THEN 'pending' ELSE 'not_required' END)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- baseline step for every key that still has none, so the board always shows all five
  FOREACH v_key IN ARRAY ARRAY['permit', 'inspection', 'warranty', 'rebate', 'customer_docs']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM closeout_steps WHERE case_id = v_case AND step_key = v_key) THEN
      INSERT INTO closeout_steps (user_id, case_id, job_id, step_key) VALUES (p_owner, v_case, p_job_id, v_key);
    END IF;
  END LOOP;

  PERFORM public.closeout_recompute_deadlines(v_case);
  PERFORM public.closeout_log(p_owner, v_case, NULL, p_job_id, 'case_opened', NULL, 'open',
    jsonb_build_object('install_date', p_install_date));
  RETURN v_case;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_open_case(p_job_id uuid, p_install_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_case uuid;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  v_case := public.closeout_open_case_internal(v_owner, p_job_id, p_install_date);
  RETURN (SELECT to_jsonb(c) FROM closeout_cases c WHERE c.id = v_case);
END;
$$;

-- 11) Case / step updates ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_update_case(p_case_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c closeout_cases%ROWTYPE;
  v_bad text;
  v_proj uuid;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid update.' USING ERRCODE = '22023';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('install_date', 'job_complete_date', 'notes', 'install_project_id') LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Unsupported field.' USING ERRCODE = '22023'; END IF;

  SELECT * INTO c FROM closeout_cases WHERE id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout case not found.' USING ERRCODE = 'P0002'; END IF;

  v_proj := c.install_project_id;
  IF p_patch ? 'install_project_id' THEN
    v_proj := NULLIF(p_patch ->> 'install_project_id', '')::uuid;
    IF v_proj IS NOT NULL AND NOT EXISTS (SELECT 1 FROM install_projects WHERE id = v_proj AND user_id = v_owner) THEN
      RAISE EXCEPTION 'Unknown install project.' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE closeout_cases SET
    install_date = CASE WHEN p_patch ? 'install_date' THEN NULLIF(p_patch ->> 'install_date', '')::date ELSE install_date END,
    job_complete_date = CASE WHEN p_patch ? 'job_complete_date' THEN NULLIF(p_patch ->> 'job_complete_date', '')::date ELSE job_complete_date END,
    notes = CASE WHEN p_patch ? 'notes' THEN NULLIF(left(btrim(coalesce(p_patch ->> 'notes', '')), 2000), '') ELSE notes END,
    install_project_id = v_proj,
    updated_at = now()
  WHERE id = p_case_id;

  PERFORM public.closeout_recompute_deadlines(p_case_id);
  PERFORM public.closeout_log(v_owner, p_case_id, NULL, c.job_id, 'case_updated', c.status, c.status, p_patch);
  RETURN (SELECT to_jsonb(x) FROM closeout_cases x WHERE x.id = p_case_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_update_step(p_step_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
  v_bad text;
  v_assignee uuid;
  v_manual boolean;
  v_deadline date;
  v_value integer;
  v_elig text;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid update.' USING ERRCODE = '22023';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('assignee_member_id', 'deadline_on', 'reset_deadline', 'estimated_value_cents',
                   'eligibility', 'note', 'reference_number') LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Unsupported field.' USING ERRCODE = '22023'; END IF;

  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;
  IF s.status IN ('completed', 'not_applicable') THEN
    RAISE EXCEPTION 'This step is closed.' USING ERRCODE = '22023';
  END IF;

  v_assignee := s.assignee_member_id;
  IF p_patch ? 'assignee_member_id' THEN
    v_assignee := NULLIF(p_patch ->> 'assignee_member_id', '')::uuid;
    IF v_assignee IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM team_members WHERE id = v_assignee AND account_owner_id = v_owner
    ) THEN RAISE EXCEPTION 'Unknown team member.' USING ERRCODE = '22023'; END IF;
  END IF;

  v_manual := s.deadline_manual;
  v_deadline := s.deadline_on;
  IF p_patch ? 'deadline_on' THEN
    v_deadline := NULLIF(p_patch ->> 'deadline_on', '')::date;
    v_manual := v_deadline IS NOT NULL;
  END IF;
  IF p_patch ? 'reset_deadline' AND (p_patch ->> 'reset_deadline')::boolean THEN
    v_manual := false;
  END IF;

  v_value := s.estimated_value_cents;
  IF p_patch ? 'estimated_value_cents' THEN
    v_value := NULLIF(p_patch ->> 'estimated_value_cents', '')::integer;
    IF v_value IS NOT NULL AND v_value < 0 THEN RAISE EXCEPTION 'Invalid value.' USING ERRCODE = '22023'; END IF;
  END IF;

  v_elig := s.eligibility;
  IF p_patch ? 'eligibility' THEN
    v_elig := p_patch ->> 'eligibility';
    IF v_elig NOT IN ('unknown', 'likely_verify', 'not_likely') THEN
      RAISE EXCEPTION 'Invalid eligibility value.' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE closeout_steps SET
    assignee_member_id = v_assignee,
    deadline_on = v_deadline,
    deadline_manual = v_manual,
    estimated_value_cents = v_value,
    eligibility = v_elig,
    note = CASE WHEN p_patch ? 'note' THEN NULLIF(left(btrim(coalesce(p_patch ->> 'note', '')), 500), '') ELSE note END,
    reference_number = CASE WHEN p_patch ? 'reference_number'
      THEN NULLIF(left(btrim(coalesce(p_patch ->> 'reference_number', '')), 120), '') ELSE reference_number END,
    updated_at = now()
  WHERE id = p_step_id;

  IF v_deadline IS DISTINCT FROM s.deadline_on THEN
    DELETE FROM closeout_escalations WHERE step_id = p_step_id;
  END IF;
  IF p_patch ? 'reset_deadline' THEN PERFORM public.closeout_recompute_deadlines(s.case_id); END IF;

  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'step_updated', s.status, s.status, p_patch);
  RETURN (SELECT to_jsonb(x) FROM closeout_steps x WHERE x.id = p_step_id);
END;
$$;

-- 12) Pre-approval (human-recorded) -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_set_pre_approval(
  p_step_id uuid, p_status text, p_reference text DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
  v_ref text := NULLIF(left(btrim(coalesce(p_reference, '')), 120), '');
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('pending', 'requested', 'approved', 'denied') THEN
    RAISE EXCEPTION 'Invalid pre-approval status.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;
  IF NOT s.pre_approval_required THEN
    RAISE EXCEPTION 'This step does not require pre-approval.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'approved' AND v_ref IS NULL THEN
    RAISE EXCEPTION 'Enter the approval or confirmation number you received.' USING ERRCODE = '22023';
  END IF;

  UPDATE closeout_steps SET
    pre_approval_status = p_status,
    pre_approval_reference = COALESCE(v_ref, pre_approval_reference),
    pre_approval_at = CASE WHEN p_status = 'approved' THEN now() ELSE NULL END,
    pre_approval_by = CASE WHEN p_status = 'approved' THEN auth.uid() ELSE NULL END,
    updated_at = now()
  WHERE id = p_step_id;

  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'pre_approval_' || p_status,
    s.pre_approval_status, p_status,
    jsonb_build_object('reference', v_ref, 'note', NULLIF(left(btrim(coalesce(p_note, '')), 300), '')));
  RETURN (SELECT to_jsonb(x) FROM closeout_steps x WHERE x.id = p_step_id);
END;
$$;

-- 13) State machine ----------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_transition_step(
  p_step_id uuid, p_to text, p_note text DEFAULT NULL, p_reference text DEFAULT NULL, p_attest boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
  v_note text := NULLIF(left(btrim(coalesce(p_note, '')), 500), '');
  v_ref text := NULLIF(left(btrim(coalesce(p_reference, '')), 120), '');
  v_missing text[];
  v_deps text[];
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;

  IF NOT public.closeout_transition_allowed(s.status, p_to) THEN
    RAISE EXCEPTION 'CLOSEOUT_INVALID_TRANSITION: % -> %', s.status, p_to USING ERRCODE = '22023';
  END IF;

  IF p_to = 'not_applicable' AND char_length(coalesce(v_note, '')) < 5 THEN
    RAISE EXCEPTION 'CLOSEOUT_NOTE_REQUIRED: explain why this step is not applicable' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'rejected' AND char_length(coalesce(v_note, '')) < 3 THEN
    RAISE EXCEPTION 'CLOSEOUT_NOTE_REQUIRED: enter the rejection reason' USING ERRCODE = '22023';
  END IF;

  IF p_to IN ('ready_for_approval', 'submitted') THEN
    v_missing := public.closeout_missing_evidence(p_step_id);
    IF cardinality(v_missing) > 0 THEN
      RAISE EXCEPTION 'CLOSEOUT_MISSING_EVIDENCE: %', array_to_string(v_missing, ',') USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_to = 'submitted' THEN
    IF p_attest IS NOT TRUE THEN
      RAISE EXCEPTION 'CLOSEOUT_HUMAN_APPROVAL_REQUIRED: a person must approve and submit this externally' USING ERRCODE = '22023';
    END IF;
    IF v_ref IS NULL AND v_note IS NULL AND s.reference_number IS NULL THEN
      RAISE EXCEPTION 'CLOSEOUT_REFERENCE_REQUIRED: record the confirmation/reference number or a note' USING ERRCODE = '22023';
    END IF;
    IF s.pre_approval_required AND s.pre_approval_status <> 'approved' THEN
      RAISE EXCEPTION 'CLOSEOUT_PRE_APPROVAL_NOT_RECORDED: pre-approval has not been recorded' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_to IN ('submitted', 'completed') THEN
    v_deps := public.closeout_unmet_dependencies(s.case_id, s.step_key);
    IF cardinality(v_deps) > 0 THEN
      RAISE EXCEPTION 'CLOSEOUT_DEPENDENCY: finish first: %', array_to_string(v_deps, ',') USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE closeout_steps SET
    status = p_to,
    reference_number = CASE WHEN v_ref IS NOT NULL THEN v_ref ELSE reference_number END,
    note = CASE WHEN v_note IS NOT NULL AND p_to NOT IN ('not_applicable') THEN v_note ELSE note END,
    na_reason = CASE WHEN p_to = 'not_applicable' THEN v_note WHEN p_to = 'pending' THEN NULL ELSE na_reason END,
    approved_by = CASE WHEN p_to = 'submitted' THEN auth.uid() ELSE approved_by END,
    approved_at = CASE WHEN p_to = 'submitted' THEN now() ELSE approved_at END,
    submitted_at = CASE WHEN p_to = 'submitted' THEN now() ELSE submitted_at END,
    completed_at = CASE WHEN p_to = 'completed' THEN now() ELSE completed_at END,
    updated_at = now()
  WHERE id = p_step_id;

  IF p_to IN ('completed', 'not_applicable', 'pending') THEN
    PERFORM public.closeout_recompute_deadlines(s.case_id);
  END IF;
  PERFORM public.closeout_refresh_case_status(s.case_id);
  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'step_' || p_to, s.status, p_to,
    jsonb_build_object('reference', v_ref, 'note', v_note, 'human_attested', p_to = 'submitted',
                       'late', (s.deadline_on IS NOT NULL AND s.deadline_on < current_date AND p_to IN ('submitted', 'completed'))));
  RETURN (SELECT to_jsonb(x) FROM closeout_steps x WHERE x.id = p_step_id);
END;
$$;

-- 14) Attach program / link rebate ------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_attach_program(p_case_id uuid, p_program_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c closeout_cases%ROWTYPE;
  p closeout_programs%ROWTYPE;
  v_step uuid;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM closeout_cases WHERE id = p_case_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout case not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO p FROM closeout_programs WHERE id = p_program_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Program not found.' USING ERRCODE = 'P0002'; END IF;
  IF NOT p.is_active THEN
    RAISE EXCEPTION 'This program is not active (it needs a source URL and a verified date).' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM closeout_steps WHERE case_id = p_case_id AND program_id = p_program_id) THEN
    RAISE EXCEPTION 'This program is already attached to the job.' USING ERRCODE = '23505';
  END IF;

  -- reuse an untouched baseline step of the same kind instead of creating a second one
  SELECT s.id INTO v_step FROM closeout_steps s
   WHERE s.case_id = p_case_id AND s.step_key = p.step_key AND s.program_id IS NULL
     AND s.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM closeout_evidence e WHERE e.step_id = s.id)
   LIMIT 1 FOR UPDATE;

  IF v_step IS NOT NULL THEN
    UPDATE closeout_steps SET
      program_id = p.id,
      estimated_value_cents = p.estimated_value_cents,
      pre_approval_required = p.requires_pre_approval,
      pre_approval_status = CASE WHEN p.requires_pre_approval THEN 'pending' ELSE 'not_required' END,
      updated_at = now()
    WHERE id = v_step;
  ELSE
    INSERT INTO closeout_steps (user_id, case_id, job_id, step_key, program_id, estimated_value_cents,
                                pre_approval_required, pre_approval_status)
    VALUES (v_owner, p_case_id, c.job_id, p.step_key, p.id, p.estimated_value_cents,
            p.requires_pre_approval, CASE WHEN p.requires_pre_approval THEN 'pending' ELSE 'not_required' END)
    RETURNING id INTO v_step;
  END IF;

  PERFORM public.closeout_recompute_deadlines(p_case_id);
  PERFORM public.closeout_refresh_case_status(p_case_id);
  PERFORM public.closeout_log(v_owner, p_case_id, v_step, c.job_id, 'program_attached', NULL, NULL,
    jsonb_build_object('program_id', p.id, 'program', p.name));
  RETURN (SELECT to_jsonb(x) FROM closeout_steps x WHERE x.id = v_step);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_link_rebate(p_step_id uuid, p_rebate_application_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
  r rebate_applications%ROWTYPE;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;
  IF s.step_key <> 'rebate' THEN RAISE EXCEPTION 'Only rebate steps can be linked.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM rebate_applications WHERE id = p_rebate_application_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rebate application not found.' USING ERRCODE = 'P0002'; END IF;

  UPDATE closeout_steps SET rebate_application_id = r.id, estimated_value_cents = r.estimated_cents, updated_at = now()
   WHERE id = p_step_id;
  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'rebate_linked', NULL, NULL,
    jsonb_build_object('rebate_application_id', r.id, 'estimated_cents', r.estimated_cents));
  RETURN (SELECT to_jsonb(x) FROM closeout_steps x WHERE x.id = p_step_id);
END;
$$;

-- 15) Evidence ---------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_add_evidence(
  p_step_id uuid, p_kind text, p_label text DEFAULT NULL, p_value text DEFAULT NULL,
  p_job_photo_id uuid DEFAULT NULL, p_document_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
  v_value text := NULLIF(left(btrim(coalesce(p_value, '')), 500), '');
  v_id uuid;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('serial_number', 'model_number', 'install_date', 'photo', 'permit_number', 'certificate',
                    'invoice', 'inspection_report', 'warranty_confirmation', 'rebate_form', 'customer_document', 'other') THEN
    RAISE EXCEPTION 'Invalid evidence type.' USING ERRCODE = '22023';
  END IF;
  IF v_value IS NULL AND p_job_photo_id IS NULL AND p_document_id IS NULL THEN
    RAISE EXCEPTION 'Add a value, a photo or a document.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;
  IF s.status IN ('submitted', 'completed', 'not_applicable') THEN
    RAISE EXCEPTION 'Evidence is locked once a step is submitted or closed.' USING ERRCODE = '22023';
  END IF;

  IF p_job_photo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_photos WHERE id = p_job_photo_id AND user_id = v_owner AND job_id = s.job_id
  ) THEN RAISE EXCEPTION 'Photo not found on this job.' USING ERRCODE = '22023'; END IF;
  IF p_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents WHERE id = p_document_id AND user_id = v_owner
  ) THEN RAISE EXCEPTION 'Document not found.' USING ERRCODE = '22023'; END IF;

  INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, value, job_photo_id, document_id)
  VALUES (v_owner, s.case_id, s.id, p_kind, NULLIF(left(btrim(coalesce(p_label, '')), 160), ''),
          v_value, p_job_photo_id, p_document_id)
  RETURNING id INTO v_id;

  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'evidence_added', s.status, s.status,
    jsonb_build_object('kind', p_kind));
  RETURN (SELECT to_jsonb(e) FROM closeout_evidence e WHERE e.id = v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_remove_evidence(p_evidence_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  e closeout_evidence%ROWTYPE;
  s closeout_steps%ROWTYPE;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM closeout_evidence WHERE id = p_evidence_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM closeout_steps WHERE id = e.step_id FOR UPDATE;
  IF s.status IN ('submitted', 'completed', 'not_applicable') THEN
    RAISE EXCEPTION 'Evidence is locked once a step is submitted or closed.' USING ERRCODE = '22023';
  END IF;

  DELETE FROM closeout_evidence WHERE id = p_evidence_id;

  IF s.status = 'ready_for_approval' AND cardinality(public.closeout_missing_evidence(s.id)) > 0 THEN
    UPDATE closeout_steps SET status = 'in_progress', updated_at = now() WHERE id = s.id;
  END IF;
  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'evidence_removed', s.status, s.status,
    jsonb_build_object('kind', e.kind));
END;
$$;

-- Pull facts that already exist in the system (equipment, permit, inspection, photos).
CREATE OR REPLACE FUNCTION public.closeout_autocollect_evidence(p_step_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
  v_added integer := 0;
  v_n integer;
  q record;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;
  IF s.status IN ('submitted', 'completed', 'not_applicable') THEN
    RAISE EXCEPTION 'Evidence is locked once a step is submitted or closed.' USING ERRCODE = '22023';
  END IF;

  -- equipment: serial / model / install date
  FOR q IN
    SELECT eq.serial_number, eq.make, eq.model, eq.install_date
      FROM job_equipment je JOIN equipment eq ON eq.id = je.equipment_id
     WHERE je.job_id = s.job_id AND eq.user_id = v_owner
  LOOP
    IF btrim(coalesce(q.serial_number, '')) <> '' AND NOT EXISTS (
      SELECT 1 FROM closeout_evidence WHERE step_id = s.id AND kind = 'serial_number' AND value = btrim(q.serial_number)
    ) THEN
      INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, value, source)
      VALUES (v_owner, s.case_id, s.id, 'serial_number', 'From equipment record', left(btrim(q.serial_number), 500), 'auto');
      v_added := v_added + 1;
    END IF;
    IF btrim(coalesce(q.model, '')) <> '' AND NOT EXISTS (
      SELECT 1 FROM closeout_evidence WHERE step_id = s.id AND kind = 'model_number' AND value = btrim(q.model)
    ) THEN
      INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, value, source)
      VALUES (v_owner, s.case_id, s.id, 'model_number', 'From equipment record', left(btrim(q.model), 500), 'auto');
      v_added := v_added + 1;
    END IF;
    IF q.install_date IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM closeout_evidence WHERE step_id = s.id AND kind = 'install_date' AND value = q.install_date::text
    ) THEN
      INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, value, source)
      VALUES (v_owner, s.case_id, s.id, 'install_date', 'From equipment record', q.install_date::text, 'auto');
      v_added := v_added + 1;
    END IF;
  END LOOP;

  -- permit number
  FOR q IN
    SELECT permit_number FROM permit_applications
     WHERE job_id = s.job_id AND user_id = v_owner AND btrim(coalesce(permit_number, '')) <> ''
  LOOP
    IF NOT EXISTS (SELECT 1 FROM closeout_evidence WHERE step_id = s.id AND kind = 'permit_number' AND value = btrim(q.permit_number)) THEN
      INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, value, source)
      VALUES (v_owner, s.case_id, s.id, 'permit_number', 'From permit application', left(btrim(q.permit_number), 500), 'auto');
      v_added := v_added + 1;
    END IF;
  END LOOP;

  -- passed inspections as a recorded fact
  FOR q IN
    SELECT i.id, coalesce(i.label, i.kind) AS lbl, i.completed_at
      FROM permit_inspections i JOIN permit_applications a ON a.id = i.application_id
     WHERE a.job_id = s.job_id AND i.user_id = v_owner AND i.status = 'passed'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM closeout_evidence WHERE step_id = s.id AND kind = 'inspection_report' AND label = 'Passed: ' || q.lbl) THEN
      INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, value, source)
      VALUES (v_owner, s.case_id, s.id, 'inspection_report', 'Passed: ' || left(q.lbl, 140),
              'Passed ' || coalesce(q.completed_at::date::text, ''), 'auto');
      v_added := v_added + 1;
    END IF;
  END LOOP;

  -- up to 6 job photos (after first)
  FOR q IN
    SELECT id FROM job_photos
     WHERE job_id = s.job_id AND user_id = v_owner
     ORDER BY (kind = 'after') DESC, taken_at DESC LIMIT 6
  LOOP
    IF NOT EXISTS (SELECT 1 FROM closeout_evidence WHERE step_id = s.id AND job_photo_id = q.id) THEN
      INSERT INTO closeout_evidence (user_id, case_id, step_id, kind, label, job_photo_id, source)
      VALUES (v_owner, s.case_id, s.id, 'photo', 'From job photos', q.id, 'auto');
      v_added := v_added + 1;
    END IF;
  END LOOP;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'evidence_autocollected', s.status, s.status,
    jsonb_build_object('added', v_added));
  RETURN v_added;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_log_packet(p_step_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s closeout_steps%ROWTYPE;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM closeout_steps WHERE id = p_step_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closeout step not found.' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.closeout_log(v_owner, s.case_id, s.id, s.job_id, 'packet_generated', s.status, s.status,
    jsonb_build_object('missing', public.closeout_missing_evidence(s.id)));
END;
$$;

-- 16) Programs (rules as data) ----------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_save_program(p_id uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_bad text;
  v_old closeout_programs%ROWTYPE;
  v_id uuid := p_id;
  v_step_key text;
  v_name text;
  v_anchor text;
  v_days integer;
  v_evidence text[];
  v_enroll text[];
  v_value integer;
  v_incentive uuid;
  v_url text;
  v_verified date;
  v_reverify integer;
  v_active boolean;
  v_auto boolean;
  v_pre boolean;
  v_case uuid;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'Invalid program.' USING ERRCODE = '22023';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(p) AS k
   WHERE k NOT IN ('step_key', 'name', 'administrator', 'anchor', 'deadline_days', 'requires_pre_approval',
                   'required_evidence', 'enrollment_requirements', 'estimated_value_cents', 'incentive_program_id',
                   'auto_attach', 'source_url', 'last_verified_on', 'reverify_days', 'notes', 'is_active') LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Unsupported field.' USING ERRCODE = '22023'; END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM closeout_programs WHERE id = v_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Program not found.' USING ERRCODE = 'P0002'; END IF;
  END IF;

  v_step_key := COALESCE(p ->> 'step_key', v_old.step_key);
  IF v_id IS NOT NULL AND v_step_key IS DISTINCT FROM v_old.step_key THEN
    RAISE EXCEPTION 'A program''s step cannot be changed. Create a new program instead.' USING ERRCODE = '22023';
  END IF;
  IF v_step_key IS NULL OR v_step_key NOT IN ('permit', 'inspection', 'warranty', 'rebate', 'customer_docs') THEN
    RAISE EXCEPTION 'Choose a valid step.' USING ERRCODE = '22023';
  END IF;

  v_name := COALESCE(NULLIF(btrim(p ->> 'name'), ''), v_old.name);
  IF v_name IS NULL OR char_length(v_name) < 2 OR char_length(v_name) > 160 THEN
    RAISE EXCEPTION 'Enter a program name (2-160 characters).' USING ERRCODE = '22023';
  END IF;

  v_anchor := COALESCE(p ->> 'anchor', v_old.anchor, 'install_date');
  IF v_anchor NOT IN ('install_date', 'permit_completed', 'inspection_completed', 'job_complete') THEN
    RAISE EXCEPTION 'Invalid deadline anchor.' USING ERRCODE = '22023';
  END IF;

  IF p ? 'deadline_days' THEN v_days := NULLIF(p ->> 'deadline_days', '')::integer; ELSE v_days := v_old.deadline_days; END IF;
  IF v_days IS NOT NULL AND (v_days < 0 OR v_days > 1095) THEN
    RAISE EXCEPTION 'Deadline must be 0-1095 days.' USING ERRCODE = '22023';
  END IF;

  IF p ? 'required_evidence' THEN
    IF jsonb_typeof(p -> 'required_evidence') <> 'array' THEN RAISE EXCEPTION 'Invalid required documents.' USING ERRCODE = '22023'; END IF;
    SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::text[]) INTO v_evidence FROM jsonb_array_elements_text(p -> 'required_evidence') AS x;
  ELSE
    v_evidence := COALESCE(v_old.required_evidence, ARRAY[]::text[]);
  END IF;

  IF p ? 'enrollment_requirements' THEN
    IF jsonb_typeof(p -> 'enrollment_requirements') <> 'array' THEN RAISE EXCEPTION 'Invalid enrollment requirements.' USING ERRCODE = '22023'; END IF;
    SELECT COALESCE(array_agg(left(btrim(x), 200)), ARRAY[]::text[]) INTO v_enroll
      FROM jsonb_array_elements_text(p -> 'enrollment_requirements') AS x WHERE btrim(x) <> '';
  ELSE
    v_enroll := COALESCE(v_old.enrollment_requirements, ARRAY[]::text[]);
  END IF;

  IF p ? 'estimated_value_cents' THEN v_value := NULLIF(p ->> 'estimated_value_cents', '')::integer; ELSE v_value := v_old.estimated_value_cents; END IF;
  IF v_value IS NOT NULL AND v_value < 0 THEN RAISE EXCEPTION 'Invalid value.' USING ERRCODE = '22023'; END IF;

  IF p ? 'incentive_program_id' THEN
    v_incentive := NULLIF(p ->> 'incentive_program_id', '')::uuid;
    IF v_incentive IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM incentive_programs WHERE id = v_incentive AND (owner_user_id IS NULL OR owner_user_id = v_owner)
    ) THEN RAISE EXCEPTION 'Unknown incentive program.' USING ERRCODE = '22023'; END IF;
  ELSE
    v_incentive := v_old.incentive_program_id;
  END IF;

  IF p ? 'source_url' THEN v_url := NULLIF(btrim(p ->> 'source_url'), ''); ELSE v_url := v_old.source_url; END IF;
  IF v_url IS NOT NULL AND v_url !~* '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'The source URL must start with http:// or https://.' USING ERRCODE = '22023';
  END IF;

  IF p ? 'last_verified_on' THEN v_verified := NULLIF(p ->> 'last_verified_on', '')::date; ELSE v_verified := v_old.last_verified_on; END IF;
  IF v_verified IS NOT NULL AND v_verified > current_date + 1 THEN
    RAISE EXCEPTION 'The verified date cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  v_reverify := COALESCE(NULLIF(p ->> 'reverify_days', '')::integer, v_old.reverify_days, 180);
  v_active := COALESCE((p ->> 'is_active')::boolean, v_old.is_active, false);
  v_auto := COALESCE((p ->> 'auto_attach')::boolean, v_old.auto_attach, false);
  v_pre := COALESCE((p ->> 'requires_pre_approval')::boolean, v_old.requires_pre_approval, false);

  IF v_active AND (v_url IS NULL OR v_verified IS NULL) THEN
    RAISE EXCEPTION 'CLOSEOUT_PROGRAM_NEEDS_SOURCE: add the source URL and the date you last verified it before activating this rule' USING ERRCODE = '22023';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO closeout_programs (user_id, step_key, name, administrator, anchor, deadline_days, requires_pre_approval,
      required_evidence, enrollment_requirements, estimated_value_cents, incentive_program_id, auto_attach,
      source_url, last_verified_on, reverify_days, notes, is_active)
    VALUES (v_owner, v_step_key, v_name, NULLIF(left(btrim(coalesce(p ->> 'administrator', '')), 160), ''), v_anchor, v_days, v_pre,
      v_evidence, v_enroll, v_value, v_incentive, v_auto, v_url, v_verified, v_reverify,
      NULLIF(left(btrim(coalesce(p ->> 'notes', '')), 2000), ''), v_active)
    RETURNING id INTO v_id;
    PERFORM public.closeout_log(v_owner, NULL, NULL, NULL, 'program_created', NULL, NULL,
      jsonb_build_object('program_id', v_id, 'name', v_name));
  ELSE
    UPDATE closeout_programs SET
      name = v_name,
      administrator = CASE WHEN p ? 'administrator' THEN NULLIF(left(btrim(coalesce(p ->> 'administrator', '')), 160), '') ELSE administrator END,
      anchor = v_anchor, deadline_days = v_days, requires_pre_approval = v_pre,
      required_evidence = v_evidence, enrollment_requirements = v_enroll,
      estimated_value_cents = v_value, incentive_program_id = v_incentive, auto_attach = v_auto,
      source_url = v_url, last_verified_on = v_verified, reverify_days = v_reverify,
      notes = CASE WHEN p ? 'notes' THEN NULLIF(left(btrim(coalesce(p ->> 'notes', '')), 2000), '') ELSE notes END,
      is_active = v_active, updated_at = now()
    WHERE id = v_id;

    -- Propagate to OPEN steps: pre-approval flag + deadlines.
    UPDATE closeout_steps SET
      pre_approval_required = v_pre,
      pre_approval_status = CASE
        WHEN v_pre AND pre_approval_status = 'not_required' THEN 'pending'
        WHEN NOT v_pre AND pre_approval_status <> 'approved' THEN 'not_required'
        ELSE pre_approval_status END,
      updated_at = now()
    WHERE program_id = v_id AND status NOT IN ('completed', 'not_applicable');
    FOR v_case IN SELECT DISTINCT case_id FROM closeout_steps WHERE program_id = v_id AND status NOT IN ('completed', 'not_applicable')
    LOOP
      PERFORM public.closeout_recompute_deadlines(v_case);
    END LOOP;

    PERFORM public.closeout_log(v_owner, NULL, NULL, NULL, 'program_updated', NULL, NULL,
      jsonb_build_object('program_id', v_id, 'name', v_name, 'verified_on', v_verified, 'source_url', v_url));
  END IF;

  RETURN (SELECT to_jsonb(x) FROM closeout_programs x WHERE x.id = v_id);
END;
$$;

-- "I re-checked the source today."
CREATE OR REPLACE FUNCTION public.closeout_verify_program(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row closeout_programs%ROWTYPE;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM closeout_programs WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Program not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_row.source_url IS NULL THEN
    RAISE EXCEPTION 'CLOSEOUT_PROGRAM_NEEDS_SOURCE: add a source URL first' USING ERRCODE = '22023';
  END IF;
  UPDATE closeout_programs SET last_verified_on = current_date, updated_at = now() WHERE id = p_id;
  PERFORM public.closeout_log(v_owner, NULL, NULL, NULL, 'program_verified', NULL, NULL,
    jsonb_build_object('program_id', p_id, 'name', v_row.name));
  RETURN (SELECT to_jsonb(x) FROM closeout_programs x WHERE x.id = p_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_save_settings(p_technician integer, p_office integer, p_owner integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;
  IF p_technician < p_office OR p_office < p_owner THEN
    RAISE EXCEPTION 'Escalation days must go technician >= office >= owner.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO closeout_settings (user_id, technician_days, office_days, owner_days)
  VALUES (v_owner, p_technician, p_office, p_owner)
  ON CONFLICT (user_id) DO UPDATE
    SET technician_days = EXCLUDED.technician_days, office_days = EXCLUDED.office_days,
        owner_days = EXCLUDED.owner_days, updated_at = now();
  PERFORM public.closeout_log(v_owner, NULL, NULL, NULL, 'settings_saved', NULL, NULL,
    jsonb_build_object('technician_days', p_technician, 'office_days', p_office, 'owner_days', p_owner));
  RETURN (SELECT to_jsonb(x) FROM closeout_settings x WHERE x.user_id = v_owner);
END;
$$;

-- 17) Monthly summary ----------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_monthly_summary(p_month date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_totals jsonb;
  v_by_step jsonb;
  v_opened integer;
BEGIN
  IF NOT public.closeout_can_manage() THEN
    RAISE EXCEPTION 'Only office or owner roles can manage closeout.' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_opened FROM closeout_cases
   WHERE user_id = v_owner AND created_at >= v_from AND created_at < v_to;

  WITH due AS (
    SELECT s.*,
      (s.status = 'completed' AND (s.deadline_on IS NULL OR s.completed_at::date <= s.deadline_on)) AS on_time,
      (s.status = 'completed' AND s.deadline_on IS NOT NULL AND s.completed_at::date > s.deadline_on) AS late,
      (s.missed_at IS NOT NULL AND s.status <> 'completed' AND s.status <> 'not_applicable') AS missed_open
    FROM closeout_steps s
    WHERE s.user_id = v_owner AND s.deadline_on >= v_from AND s.deadline_on < v_to AND s.status <> 'not_applicable'
  )
  SELECT
    jsonb_build_object(
      'steps_due', count(*),
      'completed_on_time', count(*) FILTER (WHERE on_time),
      'completed_late', count(*) FILTER (WHERE late),
      'missed_open', count(*) FILTER (WHERE missed_open),
      'still_open', count(*) FILTER (WHERE status NOT IN ('completed', 'missed') AND NOT missed_open),
      'estimated_cents_completed_on_time', COALESCE(sum(estimated_value_cents) FILTER (WHERE on_time), 0),
      'estimated_cents_missed', COALESCE(sum(estimated_value_cents) FILTER (WHERE missed_open), 0)),
    COALESCE(jsonb_agg(DISTINCT step_key), '[]'::jsonb)
  INTO v_totals, v_by_step
  FROM due;

  RETURN jsonb_build_object(
    'month', v_from,
    'cases_opened', v_opened,
    'totals', v_totals,
    'by_step', (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
        SELECT s.step_key,
          count(*) AS due,
          count(*) FILTER (WHERE s.status = 'completed' AND (s.deadline_on IS NULL OR s.completed_at::date <= s.deadline_on)) AS on_time,
          count(*) FILTER (WHERE s.status = 'completed' AND s.deadline_on IS NOT NULL AND s.completed_at::date > s.deadline_on) AS late,
          count(*) FILTER (WHERE s.missed_at IS NOT NULL AND s.status NOT IN ('completed', 'not_applicable')) AS missed
        FROM closeout_steps s
        WHERE s.user_id = v_owner AND s.deadline_on >= v_from AND s.deadline_on < v_to AND s.status <> 'not_applicable'
        GROUP BY s.step_key ORDER BY s.step_key
      ) t),
    'estimate_note', 'Estimates use the values your team entered on each step. Not a guarantee of payment.'
  );
END;
$$;

-- 18) Gate: block job START until pre-approval is recorded --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_closeout_pre_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_names text;
BEGIN
  IF NEW.job_status IN ('en_route', 'in_progress')
     AND OLD.job_status IS DISTINCT FROM NEW.job_status
     AND OLD.job_status NOT IN ('en_route', 'in_progress') THEN
    SELECT string_agg(COALESCE(p.name, s.step_key), '||' ORDER BY COALESCE(p.name, s.step_key))
      INTO v_names
      FROM closeout_steps s
      LEFT JOIN closeout_programs p ON p.id = s.program_id
     WHERE s.job_id = NEW.id
       AND s.pre_approval_required
       AND s.pre_approval_status <> 'approved'
       AND s.status <> 'not_applicable';
    IF v_names IS NOT NULL THEN
      RAISE EXCEPTION 'CLOSEOUT_PRE_APPROVAL_REQUIRED: %', v_names USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_closeout_pre_approval ON jobs;
CREATE TRIGGER trg_enforce_closeout_pre_approval
  BEFORE UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_closeout_pre_approval();

-- When a job completes, anchor "job_complete" deadlines. Never blocks the job update.
CREATE OR REPLACE FUNCTION public.closeout_on_job_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case uuid;
BEGIN
  IF NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed' THEN
    BEGIN
      UPDATE closeout_cases SET job_complete_date = current_date, updated_at = now()
       WHERE job_id = NEW.id AND job_complete_date IS NULL;
      FOR v_case IN SELECT id FROM closeout_cases WHERE job_id = NEW.id LOOP
        PERFORM public.closeout_recompute_deadlines(v_case);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'closeout_on_job_completed failed: %', SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_closeout_on_job_completed ON jobs;
CREATE TRIGGER trg_closeout_on_job_completed
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.closeout_on_job_completed();

-- 19) Daily deadline engine (service role / pg_cron only) --------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.closeout_engine_tick(p_today date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_missed integer := 0;
  v_esc integer := 0;
  v_rows integer;
  v_days integer;
  v_tech integer;
  v_office integer;
  v_owner_d integer;
  v_tier integer;
  v_missing integer;
  v_title text;
  v_msg text;
  v_label text;
BEGIN
  -- 1) mark newly missed deadlines (once per step; people can reopen, the miss stays on record)
  FOR r IN
    SELECT id, user_id, case_id, job_id, status FROM closeout_steps
     WHERE deadline_on IS NOT NULL AND deadline_on < p_today AND missed_at IS NULL
       AND status IN ('pending', 'in_progress', 'ready_for_approval', 'rejected')
     ORDER BY deadline_on LIMIT 5000
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE closeout_steps SET status = 'missed', missed_at = now(), updated_at = now() WHERE id = r.id;
    PERFORM public.closeout_log(r.user_id, r.case_id, r.id, r.job_id, 'step_missed', r.status, 'missed',
      jsonb_build_object('engine', true, 'today', p_today));
    v_missed := v_missed + 1;
  END LOOP;

  -- 2) escalations: technician -> office -> owner, each tier once per step/deadline
  FOR r IN
    SELECT s.id, s.user_id, s.case_id, s.job_id, s.step_key, s.deadline_on, s.status,
           j.customer_name, p.name AS program_name,
           COALESCE(cs.technician_days, 7) AS tech_d, COALESCE(cs.office_days, 3) AS office_d,
           COALESCE(cs.owner_days, 0) AS owner_d
      FROM closeout_steps s
      JOIN jobs j ON j.id = s.job_id
      LEFT JOIN closeout_programs p ON p.id = s.program_id
      LEFT JOIN closeout_settings cs ON cs.user_id = s.user_id
     WHERE s.deadline_on IS NOT NULL
       AND s.status IN ('pending', 'in_progress', 'ready_for_approval', 'rejected', 'missed')
     LIMIT 20000
  LOOP
    v_days := r.deadline_on - p_today;
    v_tier := CASE WHEN v_days <= r.owner_d THEN 3 WHEN v_days <= r.office_d THEN 2 WHEN v_days <= r.tech_d THEN 1 ELSE 0 END;
    CONTINUE WHEN v_tier = 0;

    v_missing := cardinality(public.closeout_missing_evidence(r.id));
    INSERT INTO closeout_escalations (user_id, step_id, tier, deadline_on, days_left, missing_count)
    VALUES (r.user_id, r.id, v_tier, r.deadline_on, v_days, v_missing)
    ON CONFLICT (step_id, tier) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    CONTINUE WHEN v_rows = 0;

    v_label := COALESCE(r.program_name, CASE r.step_key
      WHEN 'permit' THEN 'Permit' WHEN 'inspection' THEN 'Inspection' WHEN 'warranty' THEN 'Warranty registration'
      WHEN 'rebate' THEN 'Rebate claim' ELSE 'Customer documents' END);
    v_title := CASE WHEN v_days < 0 THEN 'Closeout deadline missed' ELSE 'Closeout deadline approaching' END;
    v_msg := v_label || ' for ' || r.customer_name || ' — ' ||
      CASE WHEN v_days < 0 THEN 'overdue by ' || abs(v_days) || ' day(s)'
           WHEN v_days = 0 THEN 'due today'
           ELSE 'due in ' || v_days || ' day(s)' END ||
      CASE WHEN v_missing > 0 THEN '. ' || v_missing || ' required item(s) missing.' ELSE '.' END ||
      ' Escalated to ' || CASE v_tier WHEN 1 THEN 'technician' WHEN 2 THEN 'office' ELSE 'owner' END || '.';

    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (r.user_id, 'closeout_deadline', v_title, v_msg, '/dashboard/install-closeout?step=' || r.id::text);

    PERFORM public.closeout_log(r.user_id, r.case_id, r.id, r.job_id, 'escalated', r.status, r.status,
      jsonb_build_object('tier', v_tier, 'days_left', v_days, 'missing', v_missing, 'engine', true));
    v_esc := v_esc + 1;
  END LOOP;

  RETURN jsonb_build_object('missed', v_missed, 'escalations', v_esc, 'today', p_today);
END;
$$;

-- 20) Grants -------------------------------------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.closeout_transition_allowed(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_step_dependencies(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_missing_evidence(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_unmet_dependencies(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_log(uuid, uuid, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_recompute_deadlines(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_refresh_case_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_open_case_internal(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_engine_tick(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_closeout_pre_approval() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_on_job_completed() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.closeout_transition_allowed(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.closeout_missing_evidence(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.closeout_open_case_internal(uuid, uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.closeout_engine_tick(date) TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'closeout_open_case(uuid, date)',
    'closeout_update_case(uuid, jsonb)',
    'closeout_update_step(uuid, jsonb)',
    'closeout_set_pre_approval(uuid, text, text, text)',
    'closeout_transition_step(uuid, text, text, text, boolean)',
    'closeout_attach_program(uuid, uuid)',
    'closeout_link_rebate(uuid, uuid)',
    'closeout_add_evidence(uuid, text, text, text, uuid, uuid)',
    'closeout_remove_evidence(uuid)',
    'closeout_autocollect_evidence(uuid)',
    'closeout_log_packet(uuid)',
    'closeout_save_program(uuid, jsonb)',
    'closeout_verify_program(uuid)',
    'closeout_save_settings(integer, integer, integer)',
    'closeout_monthly_summary(date)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

-- 21) Schedule (optional extensions) --------------------------------------------------------------------------------------------------------------
-- The tick is pure SQL, so it only needs pg_cron. Emails are delivered by the closeout-deadline-engine
-- edge function (it also runs the tick, idempotently). If pg_cron is not enabled, call that function daily instead.

CREATE OR REPLACE FUNCTION public.dispatch_closeout_engine()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.closeout_cron_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'closeout emails not dispatched: app.settings.edge_function_base_url / closeout_cron_secret not set';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base_url || '/closeout-deadline-engine',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-closeout-secret', v_secret),
    body := '{}'::jsonb
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_closeout_engine() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-closeout-tick', '10 5 * * *', 'select public.closeout_engine_tick()');
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
      PERFORM cron.schedule('vireek-closeout-emails', '25 5 * * *', 'select public.dispatch_closeout_engine()');
    END IF;
  ELSE
    RAISE NOTICE 'pg_cron not enabled: invoke the closeout-deadline-engine edge function daily from an external scheduler.';
  END IF;
END $$;
