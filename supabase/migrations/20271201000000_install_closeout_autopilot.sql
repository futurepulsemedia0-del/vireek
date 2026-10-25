/*
  # Install Closeout Autopilot

  After a major install (HVAC / water heater) one deadline-driven workflow runs
  per job:  permit -> inspection -> warranty registration -> rebate claim
            -> customer documents -> done.

  Design
  - Purely additive. Reuses: jobs, equipment, job_equipment, job_photos,
    permit_applications, permit_inspections, rebate_applications,
    incentive_programs, notifications, team_members, custom_roles,
    get_account_owner_id(), update_updated_at(), log_audit_event().
  - Rules are DATA (closeout_rules): deadlines, required evidence, pre-approval,
    contractor enrolment, source URL and "last verified" date. Nothing hardcoded.
  - Clients cannot write closeouts/steps/events directly. Every change goes
    through a SECURITY DEFINER RPC (state machine + role + evidence + dependency
    guards) and appends to the immutable closeout_events timeline.
  - Vireek NEVER submits anything to a manufacturer, utility or government
    portal. "submitted" only records that an owner/office human approved and
    did it themselves.
  - Rebate pre-approval gating is enforced in the database: a trigger blocks
    moving a job to en_route / in_progress until the reservation is approved
    (or the rebate step is explicitly waived by owner/office, with a note).
  - Daily deadline engine (pg_cron, guarded) escalates tech -> office -> owner.
  - All functions are plpgsql (late-bound), so this file never fails on a
    column that differs in an older/newer local schema; it is idempotent.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- =============================================================
-- 0) PERMISSION HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.closeout_has_permission(p_flag text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE(
    public.get_account_owner_id() = auth.uid()
    OR COALESCE((
      SELECT CASE
        WHEN (cr.permissions ->> p_flag) IS NOT NULL THEN (cr.permissions ->> p_flag) = 'true'
        ELSE (tm.permissions ->> p_flag) = 'true'
      END
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false),
    false
  );
END;
$$;

-- Owner or office (admin role, or billing + business-profile permissions).
CREATE OR REPLACE FUNCTION public.closeout_can_submit()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE(
    auth.uid() IS NOT NULL AND (
      public.get_account_owner_id() = auth.uid()
      OR EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid() AND tm.role = 'admin')
      OR (public.closeout_has_permission('can_view_billing') AND public.closeout_has_permission('can_edit_business_profile'))
    ),
    false
  );
END;
$$;

-- =============================================================
-- 1) RULES AS DATA (tenant-editable, always with a source + verified date)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.closeout_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  step_kind text NOT NULL
    CHECK (step_kind IN ('permit', 'inspection', 'warranty', 'rebate', 'documents')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 160),
  equipment_type text CHECK (equipment_type IS NULL OR char_length(equipment_type) <= 80),
  manufacturer text CHECK (manufacturer IS NULL OR char_length(manufacturer) <= 80),
  program_id uuid REFERENCES public.incentive_programs(id) ON DELETE SET NULL,
  deadline_days integer CHECK (deadline_days IS NULL OR deadline_days BETWEEN 0 AND 1095),
  required_evidence text[] NOT NULL DEFAULT '{}'
    CHECK (required_evidence <@ ARRAY[
      'serial_number', 'model_number', 'install_date', 'photos', 'permit_number',
      'inspection_pass', 'ahri_certificate', 'invoice', 'customer_signature',
      'proof_of_purchase', 'rebate_preapproval', 'contractor_enrollment'
    ]::text[]),
  requires_pre_approval boolean NOT NULL DEFAULT false,
  requires_contractor_enrollment boolean NOT NULL DEFAULT false,
  default_owner_role text NOT NULL DEFAULT 'office'
    CHECK (default_owner_role IN ('technician', 'office', 'owner')),
  estimated_value_cents integer CHECK (estimated_value_cents IS NULL OR estimated_value_cents >= 0),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://'),
  last_verified_at date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closeout_rules_user_kind ON public.closeout_rules (user_id, step_kind) WHERE is_active;

ALTER TABLE public.closeout_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "closeout_rules_select" ON public.closeout_rules;
CREATE POLICY "closeout_rules_select" ON public.closeout_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "closeout_rules_insert" ON public.closeout_rules;
CREATE POLICY "closeout_rules_insert" ON public.closeout_rules FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.closeout_can_submit());
DROP POLICY IF EXISTS "closeout_rules_update" ON public.closeout_rules;
CREATE POLICY "closeout_rules_update" ON public.closeout_rules FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.closeout_can_submit())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.closeout_can_submit());
DROP POLICY IF EXISTS "closeout_rules_delete" ON public.closeout_rules;
CREATE POLICY "closeout_rules_delete" ON public.closeout_rules FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.closeout_can_submit());

DROP TRIGGER IF EXISTS trigger_closeout_rules_updated_at ON public.closeout_rules;
CREATE TRIGGER trigger_closeout_rules_updated_at
  BEFORE UPDATE ON public.closeout_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

GRANT ALL ON public.closeout_rules TO service_role;

-- =============================================================
-- 2) CLOSEOUT (one per job) + STEPS + MANUAL EVIDENCE + AUDIT TIMELINE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.closeout_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  permit_application_id uuid REFERENCES public.permit_applications(id) ON DELETE SET NULL,
  rebate_application_id uuid REFERENCES public.rebate_applications(id) ON DELETE SET NULL,
  install_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'cancelled')),
  completed_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closeout_jobs_user_status ON public.closeout_jobs (user_id, status);

CREATE TABLE IF NOT EXISTS public.closeout_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  closeout_id uuid NOT NULL REFERENCES public.closeout_jobs(id) ON DELETE CASCADE,
  step_kind text NOT NULL
    CHECK (step_kind IN ('permit', 'inspection', 'warranty', 'rebate', 'documents')),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'awaiting_approval', 'submitted', 'done', 'waived', 'missed')),
  owner_role text NOT NULL DEFAULT 'office' CHECK (owner_role IN ('technician', 'office', 'owner')),
  owner_user_id uuid,
  -- Snapshot of the rule used (so later rule edits never silently rewrite history)
  rule_id uuid REFERENCES public.closeout_rules(id) ON DELETE SET NULL,
  rule_name text,
  source_url text,
  rule_verified_at date,
  required_evidence text[] NOT NULL DEFAULT '{}',
  deadline date,
  estimated_value_cents integer NOT NULL DEFAULT 0 CHECK (estimated_value_cents >= 0),
  pre_approval_required boolean NOT NULL DEFAULT false,
  pre_approval_status text NOT NULL DEFAULT 'not_required'
    CHECK (pre_approval_status IN ('not_required', 'pending', 'approved', 'denied')),
  reference_number text CHECK (reference_number IS NULL OR char_length(reference_number) <= 120),
  escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 3),
  last_escalated_at timestamptz,
  submitted_at timestamptz,
  submitted_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  completed_at timestamptz,
  missed_at timestamptz,
  waive_reason text CHECK (waive_reason IS NULL OR char_length(waive_reason) <= 300),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closeout_steps_unique_kind UNIQUE (closeout_id, step_kind),
  CONSTRAINT closeout_steps_preapproval_only_rebate CHECK (pre_approval_required = false OR step_kind = 'rebate')
);

CREATE INDEX IF NOT EXISTS idx_closeout_steps_user_deadline ON public.closeout_steps (user_id, deadline)
  WHERE status NOT IN ('done', 'waived');
CREATE INDEX IF NOT EXISTS idx_closeout_steps_closeout ON public.closeout_steps (closeout_id);

CREATE TABLE IF NOT EXISTS public.closeout_evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  closeout_id uuid NOT NULL REFERENCES public.closeout_jobs(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('ahri_certificate', 'customer_signature', 'proof_of_purchase', 'contractor_enrollment')),
  ref text CHECK (ref IS NULL OR char_length(ref) <= 500),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  added_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closeout_evidence_unique_key UNIQUE (closeout_id, key)
);

CREATE TABLE IF NOT EXISTS public.closeout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  closeout_id uuid NOT NULL REFERENCES public.closeout_jobs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES public.closeout_steps(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (char_length(event_type) <= 60),
  from_status text,
  to_status text,
  actor_id uuid,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closeout_events_closeout ON public.closeout_events (closeout_id, created_at DESC);

ALTER TABLE public.closeout_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closeout_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closeout_evidence_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closeout_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "closeout_jobs_select" ON public.closeout_jobs;
CREATE POLICY "closeout_jobs_select" ON public.closeout_jobs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "closeout_steps_select" ON public.closeout_steps;
CREATE POLICY "closeout_steps_select" ON public.closeout_steps FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "closeout_evidence_select" ON public.closeout_evidence_items;
CREATE POLICY "closeout_evidence_select" ON public.closeout_evidence_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "closeout_events_select" ON public.closeout_events;
CREATE POLICY "closeout_events_select" ON public.closeout_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client writes at all: everything goes through the RPCs below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.closeout_jobs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.closeout_steps FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.closeout_evidence_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.closeout_events FROM anon, authenticated;

GRANT ALL ON public.closeout_jobs TO service_role;
GRANT ALL ON public.closeout_steps TO service_role;
GRANT ALL ON public.closeout_evidence_items TO service_role;
GRANT ALL ON public.closeout_events TO service_role;

DROP TRIGGER IF EXISTS trigger_closeout_jobs_updated_at ON public.closeout_jobs;
CREATE TRIGGER trigger_closeout_jobs_updated_at
  BEFORE UPDATE ON public.closeout_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_closeout_steps_updated_at ON public.closeout_steps;
CREATE TRIGGER trigger_closeout_steps_updated_at
  BEFORE UPDATE ON public.closeout_steps
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 3) PURE HELPERS (keep in sync with src/lib/installCloseout.ts)
-- =============================================================

CREATE OR REPLACE FUNCTION public.closeout_manual_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT ARRAY['ahri_certificate', 'customer_signature', 'proof_of_purchase', 'contractor_enrollment']::text[] $$;

CREATE OR REPLACE FUNCTION public.closeout_step_label(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_kind
    WHEN 'permit' THEN 'Permit'
    WHEN 'inspection' THEN 'Inspection'
    WHEN 'warranty' THEN 'Warranty registration'
    WHEN 'rebate' THEN 'Rebate claim'
    WHEN 'documents' THEN 'Customer documents'
    ELSE p_kind
  END
$$;

-- days left -> escalation level: 0 none, 1 technician (<=14d), 2 office (<=7d), 3 owner (<=3d or overdue)
CREATE OR REPLACE FUNCTION public.closeout_escalation_level(p_days_left integer)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_days_left IS NULL THEN 0
    WHEN p_days_left <= 3 THEN 3
    WHEN p_days_left <= 7 THEN 2
    WHEN p_days_left <= 14 THEN 1
    ELSE 0
  END::smallint
$$;

CREATE OR REPLACE FUNCTION public.closeout_step_transition_allowed(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM (VALUES
      ('not_started', 'in_progress'), ('not_started', 'blocked'), ('not_started', 'waived'),
      ('in_progress', 'not_started'), ('in_progress', 'blocked'), ('in_progress', 'awaiting_approval'), ('in_progress', 'waived'),
      ('blocked', 'in_progress'), ('blocked', 'waived'),
      ('awaiting_approval', 'in_progress'), ('awaiting_approval', 'submitted'), ('awaiting_approval', 'waived'),
      ('submitted', 'done'), ('submitted', 'in_progress'),
      ('missed', 'in_progress'), ('missed', 'submitted'), ('missed', 'waived')
    ) AS x(from_status, to_status) WHERE x.from_status = p_from AND x.to_status = p_to
  )
$$;

-- =============================================================
-- 4) INTERNAL HELPERS (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public.closeout_log(
  p_user uuid, p_closeout uuid, p_step uuid, p_type text,
  p_from text, p_to text, p_actor uuid, p_note text, p_meta jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.closeout_events (user_id, closeout_id, step_id, event_type, from_status, to_status, actor_id, note, metadata)
  VALUES (p_user, p_closeout, p_step, p_type, p_from, p_to, p_actor, left(p_note, 500), COALESCE(p_meta, '{}'::jsonb));

  -- Mirror into the account audit log. Never let auditing break the action.
  BEGIN
    IF p_actor IS NOT NULL THEN
      PERFORM public.log_audit_event(
        p_user, 'closeout.' || p_type, 'closeout_steps', COALESCE(p_step, p_closeout)::text,
        jsonb_build_object('from', p_from, 'to', p_to, 'note', left(COALESCE(p_note, ''), 200))
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_has_evidence(p_closeout_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cj record;
  v boolean := false;
BEGIN
  SELECT * INTO cj FROM public.closeout_jobs WHERE id = p_closeout_id;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_key = 'serial_number' THEN
    SELECT EXISTS (SELECT 1 FROM public.equipment e
      WHERE e.id = cj.equipment_id AND nullif(btrim(COALESCE(e.serial_number, '')), '') IS NOT NULL) INTO v;
  ELSIF p_key = 'model_number' THEN
    SELECT EXISTS (SELECT 1 FROM public.equipment e
      WHERE e.id = cj.equipment_id AND nullif(btrim(COALESCE(e.model, '')), '') IS NOT NULL) INTO v;
  ELSIF p_key = 'install_date' THEN
    v := cj.install_date IS NOT NULL;
  ELSIF p_key = 'photos' THEN
    SELECT EXISTS (SELECT 1 FROM public.job_photos p WHERE p.job_id = cj.job_id AND p.user_id = cj.user_id) INTO v;
  ELSIF p_key = 'permit_number' THEN
    SELECT EXISTS (SELECT 1 FROM public.permit_applications pa
      WHERE pa.job_id = cj.job_id AND pa.user_id = cj.user_id
        AND nullif(btrim(COALESCE(pa.permit_number, '')), '') IS NOT NULL
        AND pa.status NOT IN ('withdrawn', 'rejected', 'expired')) INTO v;
  ELSIF p_key = 'inspection_pass' THEN
    SELECT EXISTS (SELECT 1 FROM public.permit_inspections i
      JOIN public.permit_applications pa ON pa.id = i.application_id
      WHERE pa.job_id = cj.job_id AND pa.user_id = cj.user_id AND i.status = 'passed') INTO v;
  ELSIF p_key = 'invoice' THEN
    SELECT EXISTS (SELECT 1 FROM public.jobs j
      WHERE j.id = cj.job_id AND COALESCE(j.invoice_amount, 0) > 0 AND j.invoice_status IN ('sent', 'paid')) INTO v;
  ELSIF p_key = 'rebate_preapproval' THEN
    SELECT EXISTS (SELECT 1 FROM public.closeout_steps s
      WHERE s.closeout_id = cj.id AND s.step_kind = 'rebate'
        AND (s.pre_approval_required = false OR s.pre_approval_status = 'approved')) INTO v;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.closeout_evidence_items ei
      WHERE ei.closeout_id = cj.id AND ei.key = p_key) INTO v;
  END IF;

  RETURN COALESCE(v, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_missing_evidence(p_closeout_id uuid, p_required text[])
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text;
  out_keys text[] := '{}';
BEGIN
  FOREACH k IN ARRAY COALESCE(p_required, '{}'::text[]) LOOP
    IF NOT public.closeout_has_evidence(p_closeout_id, k) THEN
      out_keys := array_append(out_keys, k);
    END IF;
  END LOOP;
  RETURN out_keys;
END;
$$;

-- Best active rule for a step kind: most specific equipment match, then most recently verified.
CREATE OR REPLACE FUNCTION public.closeout_pick_rule(p_user uuid, p_kind text, p_equipment_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_make text;
  v_id uuid;
BEGIN
  IF p_equipment_id IS NOT NULL THEN
    SELECT lower(btrim(COALESCE(e.equipment_type, ''))), lower(btrim(COALESCE(e.make, '')))
      INTO v_type, v_make FROM public.equipment e WHERE e.id = p_equipment_id;
  END IF;

  SELECT r.id INTO v_id
  FROM public.closeout_rules r
  WHERE r.user_id = p_user AND r.step_kind = p_kind AND r.is_active
    AND (r.equipment_type IS NULL OR lower(btrim(r.equipment_type)) = COALESCE(v_type, ''))
    AND (r.manufacturer IS NULL OR lower(btrim(r.manufacturer)) = COALESCE(v_make, ''))
  ORDER BY (CASE WHEN r.equipment_type IS NOT NULL THEN 1 ELSE 0 END)
         + (CASE WHEN r.manufacturer IS NOT NULL THEN 2 ELSE 0 END) DESC,
           r.last_verified_at DESC NULLS LAST,
           r.created_at DESC
  LIMIT 1;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeout_apply_rule(p_step_id uuid, p_rule_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  cj record;
  r record;
  v_pre boolean;
  v_program_pre boolean := false;
BEGIN
  SELECT * INTO s FROM public.closeout_steps WHERE id = p_step_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO cj FROM public.closeout_jobs WHERE id = s.closeout_id;
  SELECT * INTO r FROM public.closeout_rules WHERE id = p_rule_id AND user_id = s.user_id AND step_kind = s.step_kind;
  IF NOT FOUND THEN RETURN; END IF;

  IF r.program_id IS NOT NULL THEN
    SELECT COALESCE(ip.requires_pre_approval, false) INTO v_program_pre
    FROM public.incentive_programs ip WHERE ip.id = r.program_id;
  END IF;
  v_pre := s.step_kind = 'rebate' AND (r.requires_pre_approval OR COALESCE(v_program_pre, false));

  UPDATE public.closeout_steps SET
    rule_id = r.id,
    rule_name = r.name,
    source_url = r.source_url,
    rule_verified_at = r.last_verified_at,
    required_evidence = (
      SELECT COALESCE(array_agg(DISTINCT k), '{}'::text[]) FROM unnest(
        r.required_evidence
        || CASE WHEN r.requires_contractor_enrollment THEN ARRAY['contractor_enrollment'] ELSE ARRAY[]::text[] END
        || CASE WHEN v_pre THEN ARRAY['rebate_preapproval'] ELSE ARRAY[]::text[] END
      ) AS k
    ),
    owner_role = r.default_owner_role,
    estimated_value_cents = COALESCE(r.estimated_value_cents, s.estimated_value_cents),
    pre_approval_required = v_pre,
    pre_approval_status = CASE
      WHEN NOT v_pre THEN 'not_required'
      WHEN s.pre_approval_status = 'not_required' THEN 'pending'
      ELSE s.pre_approval_status
    END,
    deadline = CASE
      WHEN cj.install_date IS NOT NULL AND r.deadline_days IS NOT NULL THEN cj.install_date + r.deadline_days
      ELSE s.deadline
    END
  WHERE id = s.id;
END;
$$;

-- Creates the closeout + the five steps (idempotent per job). Also used by the seed script.
CREATE OR REPLACE FUNCTION public.closeout_create_internal(
  p_owner uuid, p_job_id uuid, p_install_date date, p_equipment_id uuid,
  p_permit_id uuid, p_rebate_id uuid, p_actor uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j record;
  v_id uuid;
  v_equipment uuid := p_equipment_id;
  v_permit uuid := p_permit_id;
  v_rebate uuid := p_rebate_id;
  v_install date := p_install_date;
  v_kinds text[] := ARRAY['permit', 'inspection', 'warranty', 'rebate', 'documents'];
  v_roles text[] := ARRAY['office', 'technician', 'technician', 'office', 'office'];
  v_step uuid;
  v_rule uuid;
  v_est integer;
  i integer;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id AND user_id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found.'; END IF;

  SELECT id INTO v_id FROM public.closeout_jobs WHERE job_id = p_job_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  IF v_equipment IS NULL THEN
    SELECT je.equipment_id INTO v_equipment FROM public.job_equipment je
    WHERE je.job_id = p_job_id ORDER BY je.created_at DESC LIMIT 1;
  END IF;
  IF v_equipment IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.equipment e WHERE e.id = v_equipment AND e.user_id = p_owner
  ) THEN
    v_equipment := NULL;
  END IF;

  IF v_permit IS NULL THEN
    SELECT pa.id INTO v_permit FROM public.permit_applications pa
    WHERE pa.job_id = p_job_id AND pa.user_id = p_owner AND pa.status NOT IN ('withdrawn', 'rejected', 'expired')
    ORDER BY pa.created_at DESC LIMIT 1;
  END IF;
  IF v_rebate IS NULL THEN
    SELECT ra.id INTO v_rebate FROM public.rebate_applications ra
    WHERE ra.job_id = p_job_id AND ra.user_id = p_owner AND ra.status NOT IN ('denied', 'withdrawn')
    ORDER BY ra.created_at DESC LIMIT 1;
  END IF;

  IF v_install IS NULL AND v_equipment IS NOT NULL THEN
    SELECT e.install_date INTO v_install FROM public.equipment e WHERE e.id = v_equipment;
  END IF;
  v_install := COALESCE(v_install, j.scheduled_datetime::date, current_date);

  INSERT INTO public.closeout_jobs (user_id, job_id, equipment_id, permit_application_id, rebate_application_id, install_date, created_by)
  VALUES (p_owner, p_job_id, v_equipment, v_permit, v_rebate, v_install, p_actor)
  RETURNING id INTO v_id;

  FOR i IN 1..5 LOOP
    INSERT INTO public.closeout_steps (user_id, closeout_id, step_kind, position, owner_role)
    VALUES (p_owner, v_id, v_kinds[i], i, v_roles[i])
    RETURNING id INTO v_step;

    v_rule := public.closeout_pick_rule(p_owner, v_kinds[i], v_equipment);
    IF v_rule IS NOT NULL THEN
      PERFORM public.closeout_apply_rule(v_step, v_rule);
    END IF;

    IF v_kinds[i] = 'rebate' AND v_rebate IS NOT NULL THEN
      SELECT ra.estimated_cents INTO v_est FROM public.rebate_applications ra WHERE ra.id = v_rebate;
      IF COALESCE(v_est, 0) > 0 THEN
        UPDATE public.closeout_steps SET estimated_value_cents = v_est WHERE id = v_step;
      END IF;
    END IF;
  END LOOP;

  PERFORM public.closeout_log(p_owner, v_id, NULL, 'closeout_started', NULL, 'active', p_actor, NULL,
    jsonb_build_object('job_id', p_job_id, 'install_date', v_install));
  RETURN v_id;
END;
$$;

-- =============================================================
-- 5) JOB-START GATE: rebate pre-approval must be approved first
-- =============================================================

CREATE OR REPLACE FUNCTION public.closeout_guard_job_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job_status::text IS DISTINCT FROM OLD.job_status::text
     AND NEW.job_status::text IN ('en_route', 'in_progress') THEN
    IF EXISTS (
      SELECT 1
      FROM public.closeout_jobs cj
      JOIN public.closeout_steps s ON s.closeout_id = cj.id
      WHERE cj.job_id = NEW.id
        AND cj.status = 'active'
        AND s.step_kind = 'rebate'
        AND s.pre_approval_required
        AND s.pre_approval_status <> 'approved'
        AND s.status NOT IN ('waived', 'done')
    ) THEN
      RAISE EXCEPTION 'CLOSEOUT_PREAPPROVAL_REQUIRED: a rebate program on this job requires pre-approval before work starts. Get the reservation approved, or have the owner/office waive the rebate step.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_closeout_guard_job_start ON public.jobs;
CREATE TRIGGER trigger_closeout_guard_job_start
  BEFORE UPDATE OF job_status ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.closeout_guard_job_start();

-- =============================================================
-- 6) CLIENT RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.closeout_start(
  p_job_id uuid,
  p_install_date date DEFAULT NULL,
  p_equipment_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  RETURN public.closeout_create_internal(v_owner, p_job_id, p_install_date, p_equipment_id, NULL, NULL, auth.uid());
END;
$$;

-- Edit a step. Technicians may only edit notes; everything else is owner/office.
-- p_patch keys: deadline, owner_role, owner_user_id, estimated_value_cents, rule_id,
--               pre_approval_status, reference_number, notes
CREATE OR REPLACE FUNCTION public.closeout_set_step(p_step_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s record;
  k text;
  v_deadline date;
  v_role text;
  v_user uuid;
  v_est integer;
  v_pre text;
  v_ref text;
  v_notes text;
  v_rule uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE EXCEPTION 'Invalid patch.'; END IF;

  SELECT * INTO s FROM public.closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Step not found.'; END IF;

  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF k NOT IN ('deadline', 'owner_role', 'owner_user_id', 'estimated_value_cents', 'rule_id',
                 'pre_approval_status', 'reference_number', 'notes') THEN
      RAISE EXCEPTION 'Unknown field: %', k;
    END IF;
    IF k <> 'notes' AND NOT public.closeout_can_submit() THEN
      RAISE EXCEPTION 'Only the owner or office can change this field.';
    END IF;
  END LOOP;

  IF s.status = 'done' AND (SELECT count(*) FROM jsonb_object_keys(p_patch) x WHERE x <> 'notes') > 0 THEN
    RAISE EXCEPTION 'This step is done and can no longer be changed.';
  END IF;

  v_deadline := s.deadline; v_role := s.owner_role; v_user := s.owner_user_id;
  v_est := s.estimated_value_cents; v_pre := s.pre_approval_status;
  v_ref := s.reference_number; v_notes := s.notes; v_rule := s.rule_id;

  IF p_patch ? 'deadline' THEN
    IF jsonb_typeof(p_patch -> 'deadline') = 'null' THEN v_deadline := NULL;
    ELSE
      BEGIN
        v_deadline := (p_patch ->> 'deadline')::date;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid deadline date.';
      END;
    END IF;
  END IF;
  IF p_patch ? 'owner_role' THEN
    v_role := p_patch ->> 'owner_role';
    IF v_role NOT IN ('technician', 'office', 'owner') THEN RAISE EXCEPTION 'Invalid owner role.'; END IF;
  END IF;
  IF p_patch ? 'owner_user_id' THEN
    IF jsonb_typeof(p_patch -> 'owner_user_id') = 'null' THEN v_user := NULL;
    ELSE
      BEGIN
        v_user := (p_patch ->> 'owner_user_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid owner.';
      END;
    END IF;
  END IF;
  IF p_patch ? 'estimated_value_cents' THEN
    BEGIN
      v_est := GREATEST(0, COALESCE((p_patch ->> 'estimated_value_cents')::integer, 0));
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid estimated value.';
    END;
  END IF;
  IF p_patch ? 'pre_approval_status' THEN
    v_pre := p_patch ->> 'pre_approval_status';
    IF v_pre NOT IN ('not_required', 'pending', 'approved', 'denied') THEN RAISE EXCEPTION 'Invalid pre-approval status.'; END IF;
    IF NOT s.pre_approval_required THEN RAISE EXCEPTION 'This step does not require pre-approval.'; END IF;
    IF v_pre = 'not_required' THEN RAISE EXCEPTION 'Use the rule or waive the step instead.'; END IF;
  END IF;
  IF p_patch ? 'reference_number' THEN
    v_ref := nullif(btrim(COALESCE(p_patch ->> 'reference_number', '')), '');
    IF v_ref IS NOT NULL AND char_length(v_ref) > 120 THEN RAISE EXCEPTION 'Reference is too long.'; END IF;
  END IF;
  IF p_patch ? 'notes' THEN
    v_notes := nullif(btrim(COALESCE(p_patch ->> 'notes', '')), '');
    IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN RAISE EXCEPTION 'Notes are too long.'; END IF;
  END IF;
  IF p_patch ? 'rule_id' THEN
    IF jsonb_typeof(p_patch -> 'rule_id') = 'null' THEN v_rule := NULL;
    ELSE
      BEGIN
        v_rule := (p_patch ->> 'rule_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid rule.';
      END;
      IF NOT EXISTS (SELECT 1 FROM public.closeout_rules r
                     WHERE r.id = v_rule AND r.user_id = v_owner AND r.step_kind = s.step_kind) THEN
        RAISE EXCEPTION 'Rule not found for this step.';
      END IF;
    END IF;
  END IF;

  UPDATE public.closeout_steps SET
    deadline = v_deadline, owner_role = v_role, owner_user_id = v_user,
    estimated_value_cents = v_est, pre_approval_status = v_pre,
    reference_number = v_ref, notes = v_notes
  WHERE id = s.id;

  IF p_patch ? 'rule_id' AND v_rule IS NOT NULL AND v_rule IS DISTINCT FROM s.rule_id THEN
    PERFORM public.closeout_apply_rule(s.id, v_rule);
  ELSIF p_patch ? 'rule_id' AND v_rule IS NULL THEN
    UPDATE public.closeout_steps SET rule_id = NULL WHERE id = s.id;
  END IF;

  PERFORM public.closeout_log(v_owner, s.closeout_id, s.id,
    CASE WHEN p_patch ? 'pre_approval_status' THEN 'pre_approval_' || v_pre ELSE 'step_edited' END,
    s.status, s.status, auth.uid(), NULL,
    jsonb_build_object('fields', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_object_keys(p_patch) x)));
END;
$$;

-- Manual evidence (AHRI certificate, signature, proof of purchase, contractor enrolment).
CREATE OR REPLACE FUNCTION public.closeout_set_evidence(
  p_closeout_id uuid, p_key text, p_ref text DEFAULT NULL, p_note text DEFAULT NULL, p_present boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF p_key IS NULL OR NOT (p_key = ANY (public.closeout_manual_keys())) THEN
    RAISE EXCEPTION 'This evidence item is collected automatically.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.closeout_jobs WHERE id = p_closeout_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Closeout not found.';
  END IF;

  IF p_present THEN
    INSERT INTO public.closeout_evidence_items (user_id, closeout_id, key, ref, note)
    VALUES (v_owner, p_closeout_id, p_key, left(nullif(btrim(COALESCE(p_ref, '')), ''), 500), left(nullif(btrim(COALESCE(p_note, '')), ''), 300))
    ON CONFLICT (closeout_id, key) DO UPDATE
      SET ref = EXCLUDED.ref, note = EXCLUDED.note, added_by = auth.uid();
  ELSE
    DELETE FROM public.closeout_evidence_items WHERE closeout_id = p_closeout_id AND key = p_key;
  END IF;

  PERFORM public.closeout_log(v_owner, p_closeout_id, NULL,
    CASE WHEN p_present THEN 'evidence_added' ELSE 'evidence_removed' END,
    NULL, NULL, auth.uid(), p_key, '{}'::jsonb);
END;
$$;

-- The state machine. Submitting / completing / waiving is owner/office only and always a human decision.
CREATE OR REPLACE FUNCTION public.closeout_transition_step(
  p_step_id uuid, p_to text, p_note text DEFAULT NULL, p_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s record;
  cj record;
  v_missing text[];
  v_dep text;
  v_dep_status text;
  v_note text := nullif(btrim(COALESCE(p_note, '')), '');
  v_ref text := nullif(btrim(COALESCE(p_reference, '')), '');
  v_all_closed boolean;
  v_closeout_status text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;

  SELECT * INTO s FROM public.closeout_steps WHERE id = p_step_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Step not found.'; END IF;
  SELECT * INTO cj FROM public.closeout_jobs WHERE id = s.closeout_id;
  IF cj.status <> 'active' THEN RAISE EXCEPTION 'CLOSEOUT_INACTIVE: this closeout is no longer active.'; END IF;

  IF NOT public.closeout_step_transition_allowed(s.status, p_to) THEN
    RAISE EXCEPTION 'CLOSEOUT_TRANSITION: cannot move from % to %.', s.status, p_to;
  END IF;

  IF p_to IN ('submitted', 'done', 'waived') AND NOT public.closeout_can_submit() THEN
    RAISE EXCEPTION 'CLOSEOUT_FORBIDDEN: only the owner or office can submit, complete or waive a step.';
  END IF;
  IF p_to = 'waived' AND (v_note IS NULL OR char_length(v_note) < 5) THEN
    RAISE EXCEPTION 'CLOSEOUT_NOTE_REQUIRED: waiving a step needs a reason (at least 5 characters).';
  END IF;
  IF s.status = 'missed' AND (v_note IS NULL OR char_length(v_note) < 5) THEN
    RAISE EXCEPTION 'CLOSEOUT_NOTE_REQUIRED: this deadline was missed - add a note explaining the late action.';
  END IF;

  IF p_to IN ('awaiting_approval', 'submitted') THEN
    v_missing := public.closeout_missing_evidence(cj.id, s.required_evidence);
    IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
      RAISE EXCEPTION 'CLOSEOUT_EVIDENCE_MISSING: %', array_to_string(v_missing, ', ');
    END IF;
  END IF;

  IF p_to IN ('submitted', 'done') THEN
    v_dep := CASE s.step_kind
      WHEN 'inspection' THEN 'permit'
      WHEN 'rebate' THEN 'inspection'
      ELSE NULL END;
    IF v_dep IS NOT NULL THEN
      SELECT st.status INTO v_dep_status FROM public.closeout_steps st WHERE st.closeout_id = cj.id AND st.step_kind = v_dep;
      IF v_dep_status IS NULL OR v_dep_status NOT IN ('done', 'waived') THEN
        RAISE EXCEPTION 'CLOSEOUT_DEPENDENCY: finish "%" first.', public.closeout_step_label(v_dep);
      END IF;
    END IF;
    IF s.step_kind = 'documents' AND EXISTS (
      SELECT 1 FROM public.closeout_steps st
      WHERE st.closeout_id = cj.id AND st.step_kind <> 'documents' AND st.status NOT IN ('done', 'waived')
    ) THEN
      RAISE EXCEPTION 'CLOSEOUT_DEPENDENCY: finish every other step before the customer documents.';
    END IF;
  END IF;

  IF p_to = 'submitted' AND s.pre_approval_required AND s.pre_approval_status <> 'approved' THEN
    RAISE EXCEPTION 'CLOSEOUT_PREAPPROVAL_REQUIRED: the program pre-approval has not been approved.';
  END IF;

  UPDATE public.closeout_steps SET
    status = p_to,
    submitted_at = CASE WHEN p_to = 'submitted' THEN now() ELSE submitted_at END,
    submitted_by = CASE WHEN p_to = 'submitted' THEN auth.uid() ELSE submitted_by END,
    approved_at = CASE WHEN p_to = 'submitted' THEN now() ELSE approved_at END,
    approved_by = CASE WHEN p_to = 'submitted' THEN auth.uid() ELSE approved_by END,
    reference_number = CASE WHEN p_to = 'submitted' AND v_ref IS NOT NULL THEN left(v_ref, 120) ELSE reference_number END,
    completed_at = CASE WHEN p_to = 'done' THEN now() ELSE completed_at END,
    waive_reason = CASE WHEN p_to = 'waived' THEN left(v_note, 300) ELSE waive_reason END
  WHERE id = s.id;

  PERFORM public.closeout_log(v_owner, cj.id, s.id,
    CASE p_to WHEN 'submitted' THEN 'approved_and_submitted' WHEN 'waived' THEN 'waived' ELSE 'status_changed' END,
    s.status, p_to, auth.uid(), v_note,
    jsonb_build_object('late', s.status = 'missed', 'reference', v_ref));

  SELECT bool_and(st.status IN ('done', 'waived')) INTO v_all_closed
  FROM public.closeout_steps st WHERE st.closeout_id = cj.id;
  v_closeout_status := cj.status;
  IF COALESCE(v_all_closed, false) THEN
    UPDATE public.closeout_jobs SET status = 'done', completed_at = now() WHERE id = cj.id;
    v_closeout_status := 'done';
    PERFORM public.closeout_log(v_owner, cj.id, NULL, 'closeout_completed', 'active', 'done', auth.uid(), NULL, '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object('status', p_to, 'closeout_status', v_closeout_status);
END;
$$;

-- One call for the whole board.
CREATE OR REPLACE FUNCTION public.closeout_board(p_include_done boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;

  SELECT COALESCE(jsonb_agg(x.row_json ORDER BY x.sort_key, x.pos), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      jsonb_build_object(
        'step_id', s.id,
        'closeout_id', cj.id,
        'job_id', cj.job_id,
        'customer_name', j.customer_name,
        'address', j.address,
        'service_type', j.service_type,
        'job_status', j.job_status::text,
        'install_date', cj.install_date,
        'step_kind', s.step_kind,
        'status', s.status,
        'owner_role', s.owner_role,
        'deadline', s.deadline,
        'days_left', CASE WHEN s.deadline IS NULL THEN NULL ELSE (s.deadline - current_date) END,
        'escalation_level', s.escalation_level,
        'estimated_value_cents', s.estimated_value_cents,
        'pre_approval_required', s.pre_approval_required,
        'pre_approval_status', s.pre_approval_status,
        'missing_evidence', to_jsonb(public.closeout_missing_evidence(cj.id, s.required_evidence)),
        'source_url', s.source_url,
        'rule_name', s.rule_name,
        'rule_verified_at', s.rule_verified_at
      ) AS row_json,
      COALESCE(s.deadline, DATE '9999-12-31') AS sort_key,
      s.position AS pos
    FROM public.closeout_steps s
    JOIN public.closeout_jobs cj ON cj.id = s.closeout_id
    JOIN public.jobs j ON j.id = cj.job_id
    WHERE s.user_id = v_owner
      AND cj.status <> 'cancelled'
      AND (p_include_done OR cj.status = 'active')
    ORDER BY COALESCE(s.deadline, DATE '9999-12-31'), s.position
    LIMIT 1500
  ) x;

  RETURN v_result;
END;
$$;

-- Full detail for one job (checklist, evidence, timeline).
CREATE OR REPLACE FUNCTION public.closeout_job_detail(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;

  SELECT jsonb_build_object(
    'closeout', to_jsonb(cj),
    'steps', (
      SELECT COALESCE(jsonb_agg(
        to_jsonb(s) || jsonb_build_object(
          'days_left', CASE WHEN s.deadline IS NULL THEN NULL ELSE (s.deadline - current_date) END,
          'evidence', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'key', k,
              'present', public.closeout_has_evidence(cj.id, k),
              'manual', k = ANY (public.closeout_manual_keys()),
              'ref', (SELECT ei.ref FROM public.closeout_evidence_items ei WHERE ei.closeout_id = cj.id AND ei.key = k)
            )), '[]'::jsonb)
            FROM unnest(s.required_evidence) AS k
          )
        ) ORDER BY s.position
      ), '[]'::jsonb)
      FROM public.closeout_steps s WHERE s.closeout_id = cj.id
    ),
    'events', (
      SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.closeout_events ev WHERE ev.closeout_id = cj.id ORDER BY ev.created_at DESC LIMIT 40) e
    )
  ) INTO v
  FROM public.closeout_jobs cj
  WHERE cj.job_id = p_job_id AND cj.user_id = v_owner;

  RETURN v;
END;
$$;

-- Monthly summary: recovered (paid rebates), protected (completed non-rebate steps, estimate),
-- lost (missed, estimate) + what is at risk right now (estimate).
CREATE OR REPLACE FUNCTION public.closeout_monthly_summary(p_months integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_months integer := LEAST(GREATEST(COALESCE(p_months, 6), 1), 24);
  v_series jsonb;
  v_risk_cents bigint;
  v_risk_steps integer;
  v_overdue integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'month', to_char(m.month_start, 'YYYY-MM'),
    'recovered_cents', (
      SELECT COALESCE(sum(ra.paid_cents), 0) FROM public.closeout_jobs cj
      JOIN public.rebate_applications ra ON ra.id = cj.rebate_application_id
      WHERE cj.user_id = v_owner AND ra.paid_at >= m.month_start AND ra.paid_at < (m.month_start + interval '1 month')
    ),
    'protected_cents', (
      SELECT COALESCE(sum(s.estimated_value_cents), 0) FROM public.closeout_steps s
      WHERE s.user_id = v_owner AND s.status = 'done' AND s.step_kind <> 'rebate'
        AND s.completed_at >= m.month_start AND s.completed_at < (m.month_start + interval '1 month')
    ),
    'lost_cents', (
      SELECT COALESCE(sum(s.estimated_value_cents), 0) FROM public.closeout_steps s
      WHERE s.user_id = v_owner AND s.status = 'missed'
        AND s.missed_at >= m.month_start AND s.missed_at < (m.month_start + interval '1 month')
    ),
    'missed_steps', (
      SELECT count(*) FROM public.closeout_steps s
      WHERE s.user_id = v_owner AND s.missed_at >= m.month_start AND s.missed_at < (m.month_start + interval '1 month')
    )
  ) ORDER BY m.month_start), '[]'::jsonb) INTO v_series
  FROM (
    SELECT (date_trunc('month', current_date) - make_interval(months => g))::date AS month_start
    FROM generate_series(0, v_months - 1) AS g
  ) m;

  SELECT COALESCE(sum(s.estimated_value_cents), 0), count(*),
         count(*) FILTER (WHERE s.status = 'missed' OR s.deadline < current_date)
    INTO v_risk_cents, v_risk_steps, v_overdue
  FROM public.closeout_steps s
  JOIN public.closeout_jobs cj ON cj.id = s.closeout_id
  WHERE s.user_id = v_owner AND cj.status = 'active'
    AND s.status IN ('not_started', 'in_progress', 'blocked', 'awaiting_approval', 'missed')
    AND s.deadline IS NOT NULL AND (s.deadline - current_date) <= 14;

  RETURN jsonb_build_object(
    'months', v_series,
    'at_risk_cents', v_risk_cents,
    'at_risk_steps', v_risk_steps,
    'overdue_steps', v_overdue
  );
END;
$$;

-- =============================================================
-- 7) DEADLINE ENGINE (daily): escalate tech -> office -> owner, flag missed
-- =============================================================

CREATE OR REPLACE FUNCTION public.closeout_run_deadline_engine(p_user_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_days integer;
  v_level smallint;
  v_count integer := 0;
  v_missing text[];
  v_target text;
  v_title text;
  v_msg text;
  v_money text;
  v_label text;
BEGIN
  FOR r IN
    SELECT s.id AS step_id, s.user_id, s.closeout_id, s.step_kind, s.status, s.deadline,
           s.escalation_level, s.required_evidence, s.estimated_value_cents,
           j.customer_name
    FROM public.closeout_steps s
    JOIN public.closeout_jobs cj ON cj.id = s.closeout_id
    JOIN public.jobs j ON j.id = cj.job_id
    WHERE cj.status = 'active'
      AND s.deadline IS NOT NULL
      AND s.status IN ('not_started', 'in_progress', 'blocked', 'awaiting_approval', 'missed')
      AND (p_user_id IS NULL OR s.user_id = p_user_id)
  LOOP
    BEGIN
      v_days := r.deadline - current_date;
      v_level := public.closeout_escalation_level(v_days);
      v_label := public.closeout_step_label(r.step_kind);
      v_missing := public.closeout_missing_evidence(r.closeout_id, r.required_evidence);
      v_money := CASE WHEN r.estimated_value_cents > 0
        THEN ' Estimated at risk: $' || to_char(round(r.estimated_value_cents / 100.0), 'FM999,999,990') || ' (estimate).'
        ELSE '' END;

      IF v_days < 0 AND r.status <> 'missed' THEN
        UPDATE public.closeout_steps
          SET status = 'missed', missed_at = now(), escalation_level = 3, last_escalated_at = now()
          WHERE id = r.step_id;
        PERFORM public.closeout_log(r.user_id, r.closeout_id, r.step_id, 'deadline_missed',
          r.status, 'missed', NULL, NULL, jsonb_build_object('deadline', r.deadline));
        v_title := 'Closeout deadline missed: ' || v_label || ' - ' || COALESCE(r.customer_name, 'job');
        v_msg := '[Escalated to owner] The deadline passed on ' || to_char(r.deadline, 'YYYY-MM-DD')
          || '. Act now - late submission may still be accepted by some programs.' || v_money;
        INSERT INTO public.notifications (user_id, type, title, message, action_url)
        VALUES (r.user_id, 'closeout_missed', v_title, v_msg, '/dashboard/closeout');
        v_count := v_count + 1;

      ELSIF r.status <> 'missed' AND v_level > r.escalation_level THEN
        v_target := CASE v_level WHEN 1 THEN 'technician' WHEN 2 THEN 'office' ELSE 'owner' END;
        UPDATE public.closeout_steps
          SET escalation_level = v_level, last_escalated_at = now()
          WHERE id = r.step_id;
        PERFORM public.closeout_log(r.user_id, r.closeout_id, r.step_id, 'escalated',
          r.status, r.status, NULL, NULL,
          jsonb_build_object('level', v_level, 'target', v_target, 'days_left', v_days));
        v_title := 'Closeout due in ' || v_days || ' day(s): ' || v_label || ' - ' || COALESCE(r.customer_name, 'job');
        v_msg := '[Escalated to ' || v_target || '] Deadline ' || to_char(r.deadline, 'YYYY-MM-DD') || '.'
          || CASE WHEN COALESCE(array_length(v_missing, 1), 0) > 0
               THEN ' Missing evidence: ' || array_to_string(v_missing, ', ') || '.' ELSE '' END
          || v_money;
        INSERT INTO public.notifications (user_id, type, title, message, action_url)
        VALUES (r.user_id, 'closeout_deadline', v_title, v_msg, '/dashboard/closeout');
        v_count := v_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'closeout engine skipped step %: %', r.step_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Owner/office "run now" for their own account.
CREATE OR REPLACE FUNCTION public.closeout_refresh_deadlines()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated.'; END IF;
  IF NOT public.closeout_can_submit() THEN RAISE EXCEPTION 'Only the owner or office can run this.'; END IF;
  RETURN public.closeout_run_deadline_engine(v_owner);
END;
$$;

-- =============================================================
-- 8) PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.closeout_has_permission(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_can_submit() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_log(uuid, uuid, uuid, text, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_has_evidence(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_missing_evidence(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_pick_rule(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_apply_rule(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_create_internal(uuid, uuid, date, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_guard_job_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_run_deadline_engine(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.closeout_start(uuid, date, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_set_step(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_set_evidence(uuid, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_transition_step(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_board(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_job_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_monthly_summary(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.closeout_refresh_deadlines() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.closeout_has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_can_submit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_start(uuid, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_set_step(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_set_evidence(uuid, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_transition_step(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_board(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_job_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_monthly_summary(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.closeout_refresh_deadlines() TO authenticated;

GRANT EXECUTE ON FUNCTION public.closeout_create_internal(uuid, uuid, date, uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.closeout_run_deadline_engine(uuid) TO service_role;

-- =============================================================
-- 9) DAILY SCHEDULE (skipped quietly when pg_cron is not enabled)
-- =============================================================

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-closeout-deadline-engine', '10 6 * * *', 'select public.closeout_run_deadline_engine()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled: schedule closeout_run_deadline_engine() daily from the Supabase dashboard.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;
