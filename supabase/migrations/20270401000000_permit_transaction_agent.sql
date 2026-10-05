/*
  # Permit Transaction Agent

  Turns the Permit / Compliance Engine ("which permit is probably needed") into
  a managed permit TRANSACTION per job:

    Scope -> Permit needed? -> AHJ -> Form -> Application -> Submit -> Track
    -> Inspection -> Passed -> Close

  Design principles
  - Vireek never fabricates AHJ data (forms, fees, portals). The AHJ directory
    is tenant-curated; the AI only drafts scope text / checklists and labels
    them as drafts.
  - Clients cannot write applications, events or inspections directly. Every
    change goes through a validated SECURITY DEFINER RPC (state machine +
    guards), so status/timestamps/permit numbers cannot be forged.
  - Every change appends to permit_application_events (immutable timeline)
    and to the account audit_log.
  - Purely additive. Reuses get_account_owner_id(), log_audit_event() and the
    existing consume_compliance_review_quota() for the AI quota.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) AHJ directory (tenant-curated) ------------------------------------------------

CREATE TABLE IF NOT EXISTS permit_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  state text,
  city text,
  county text,
  portal_system text NOT NULL DEFAULT 'other'
    CHECK (portal_system IN ('accela', 'energov', 'cityview', 'opengov', 'email', 'in_person', 'mail', 'other')),
  submission_method text NOT NULL DEFAULT 'portal'
    CHECK (submission_method IN ('portal', 'email', 'in_person', 'mail')),
  portal_url text CHECK (portal_url IS NULL OR portal_url ~* '^https?://'),
  phone text,
  email text,
  typical_turnaround_days integer CHECK (typical_turnaround_days IS NULL OR typical_turnaround_days BETWEEN 0 AND 365),
  fee_notes text,
  notes text,
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permit_authorities_user ON permit_authorities(user_id);

ALTER TABLE permit_authorities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_permit_authorities" ON permit_authorities;
CREATE POLICY "select_own_permit_authorities" ON permit_authorities FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_permit_authorities" ON permit_authorities;
CREATE POLICY "insert_own_permit_authorities" ON permit_authorities FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_permit_authorities" ON permit_authorities;
CREATE POLICY "update_own_permit_authorities" ON permit_authorities FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_permit_authorities" ON permit_authorities;
CREATE POLICY "delete_own_permit_authorities" ON permit_authorities FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

GRANT ALL ON permit_authorities TO service_role;

-- 2) Applications (written ONLY by RPCs / service role) -----------------------------

CREATE TABLE IF NOT EXISTS permit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  review_id uuid REFERENCES job_compliance_reviews(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  authority_id uuid REFERENCES permit_authorities(id) ON DELETE SET NULL,

  permit_type text NOT NULL
    CHECK (permit_type IN ('electrical', 'plumbing', 'mechanical', 'gas', 'building', 'roofing', 'other')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready_to_file', 'submitted', 'in_review', 'corrections_required',
                      'issued', 'in_inspection', 'passed', 'closed', 'rejected', 'withdrawn', 'expired')),

  form_name text CHECK (form_name IS NULL OR char_length(form_name) <= 160),
  scope_description text CHECK (scope_description IS NULL OR char_length(scope_description) <= 2000),
  application_data jsonb NOT NULL DEFAULT '{}',
  readiness jsonb NOT NULL DEFAULT '{"score":0,"missing":[]}',

  reference_number text CHECK (reference_number IS NULL OR char_length(reference_number) <= 80),
  permit_number text CHECK (permit_number IS NULL OR char_length(permit_number) <= 80),
  fee_amount numeric CHECK (fee_amount IS NULL OR fee_amount >= 0),
  fee_paid_at timestamptz,

  submitted_at timestamptz,
  issued_at timestamptz,
  expires_at date,
  closed_at timestamptz,
  next_follow_up_at date,

  -- AI / deterministic preparation output (service role only). A DRAFT, never authoritative.
  agent_packet jsonb,
  agent_generated_at timestamptz,

  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permit_apps_user_status ON permit_applications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_permit_apps_job ON permit_applications(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permit_active_per_job_type
  ON permit_applications(job_id, permit_type)
  WHERE status NOT IN ('withdrawn', 'rejected', 'expired', 'closed');

ALTER TABLE permit_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_permit_applications" ON permit_applications;
CREATE POLICY "select_own_permit_applications" ON permit_applications FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: writes go through the RPCs below.
GRANT ALL ON permit_applications TO service_role;

-- 3) Immutable timeline ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS permit_application_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  application_id uuid NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid DEFAULT auth.uid(),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permit_events_app ON permit_application_events(application_id, created_at DESC);

ALTER TABLE permit_application_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_permit_events" ON permit_application_events;
CREATE POLICY "select_own_permit_events" ON permit_application_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
GRANT ALL ON permit_application_events TO service_role;

-- 4) Inspections -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS permit_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  application_id uuid NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('rough', 'final', 'other')),
  label text CHECK (label IS NULL OR char_length(label) <= 120),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'scheduled', 'passed', 'failed', 'cancelled')),
  scheduled_for timestamptz,
  inspector_name text CHECK (inspector_name IS NULL OR char_length(inspector_name) <= 120),
  result_note text CHECK (result_note IS NULL OR char_length(result_note) <= 500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permit_inspections_app ON permit_inspections(application_id, created_at);

ALTER TABLE permit_inspections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_permit_inspections" ON permit_inspections;
CREATE POLICY "select_own_permit_inspections" ON permit_inspections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
GRANT ALL ON permit_inspections TO service_role;

-- 5) Internal helpers (not callable by clients) -------------------------------------

CREATE OR REPLACE FUNCTION public.permit_transition_allowed(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM (VALUES
      ('draft', 'ready_to_file'), ('draft', 'withdrawn'),
      ('ready_to_file', 'draft'), ('ready_to_file', 'submitted'), ('ready_to_file', 'withdrawn'),
      ('submitted', 'in_review'), ('submitted', 'corrections_required'), ('submitted', 'issued'),
      ('submitted', 'rejected'), ('submitted', 'withdrawn'),
      ('in_review', 'corrections_required'), ('in_review', 'issued'),
      ('in_review', 'rejected'), ('in_review', 'withdrawn'),
      ('corrections_required', 'submitted'), ('corrections_required', 'withdrawn'),
      ('issued', 'in_inspection'), ('issued', 'expired'), ('issued', 'withdrawn'),
      ('in_inspection', 'passed'), ('in_inspection', 'expired'),
      ('passed', 'closed'),
      ('rejected', 'draft'), ('expired', 'ready_to_file')
    ) AS t(f, x) WHERE t.f = p_from AND t.x = p_to
  );
$$;

-- Missing application inputs, by stable key. Mirrored in src/lib/permitTransactions.ts.
CREATE OR REPLACE FUNCTION public.permit_missing_inputs(p_app_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app permit_applications%ROWTYPE;
  v_addr text;
  v_missing text[] := '{}';
BEGIN
  SELECT * INTO v_app FROM permit_applications WHERE id = p_app_id;
  IF NOT FOUND THEN RETURN v_missing; END IF;
  SELECT address INTO v_addr FROM jobs WHERE id = v_app.job_id;

  IF v_app.authority_id IS NULL THEN v_missing := v_missing || 'authority'; END IF;
  IF char_length(btrim(coalesce(v_app.scope_description, ''))) < 20 THEN v_missing := v_missing || 'scope'; END IF;
  IF btrim(coalesce(v_addr, '')) = '' THEN v_missing := v_missing || 'address'; END IF;
  IF btrim(coalesce(v_app.application_data ->> 'owner_name', '')) = '' THEN v_missing := v_missing || 'owner_name'; END IF;
  IF btrim(coalesce(v_app.application_data ->> 'contractor_license', '')) = '' THEN v_missing := v_missing || 'contractor_license'; END IF;
  IF btrim(coalesce(v_app.application_data ->> 'job_valuation', '')) = '' THEN v_missing := v_missing || 'job_valuation'; END IF;
  RETURN v_missing;
END;
$$;

CREATE OR REPLACE FUNCTION public.permit_refresh_readiness(p_app_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_missing text[] := public.permit_missing_inputs(p_app_id);
BEGIN
  UPDATE permit_applications
     SET readiness = jsonb_build_object(
           'score', round(((6 - cardinality(v_missing))::numeric / 6) * 100),
           'missing', to_jsonb(v_missing))
   WHERE id = p_app_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.permit_log_event(
  p_owner uuid, p_app_id uuid, p_type text, p_from text, p_to text, p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO permit_application_events (user_id, application_id, event_type, from_status, to_status, note)
  VALUES (p_owner, p_app_id, p_type, p_from, p_to, NULLIF(left(btrim(coalesce(p_note, '')), 500), ''));
  PERFORM public.log_audit_event(p_owner, 'permit.' || p_type, 'permit_applications', p_app_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.permit_transition_allowed(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.permit_missing_inputs(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.permit_refresh_readiness(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.permit_log_event(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.permit_transition_allowed(text, text) TO service_role;

-- 6) RPC: create -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_permit_application(
  p_job_id uuid,
  p_permit_type text,
  p_authority_id uuid DEFAULT NULL,
  p_scope text DEFAULT NULL,
  p_form_name text DEFAULT NULL,
  p_review_id uuid DEFAULT NULL,
  p_quote_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF p_permit_type NOT IN ('electrical', 'plumbing', 'mechanical', 'gas', 'building', 'roofing', 'other') THEN
    RAISE EXCEPTION 'Invalid permit type.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found.' USING ERRCODE = 'P0002'; END IF;

  IF p_authority_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM permit_authorities WHERE id = p_authority_id AND user_id = v_owner
  ) THEN RAISE EXCEPTION 'Unknown authority.' USING ERRCODE = '22023'; END IF;

  IF p_review_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_compliance_reviews WHERE id = p_review_id AND job_id = p_job_id AND user_id = v_owner
  ) THEN RAISE EXCEPTION 'Unknown compliance review.' USING ERRCODE = '22023'; END IF;

  IF p_quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quotes WHERE id = p_quote_id AND user_id = v_owner
  ) THEN RAISE EXCEPTION 'Unknown quote.' USING ERRCODE = '22023'; END IF;

  IF EXISTS (
    SELECT 1 FROM permit_applications
     WHERE job_id = p_job_id AND permit_type = p_permit_type
       AND status NOT IN ('withdrawn', 'rejected', 'expired', 'closed')
  ) THEN RAISE EXCEPTION 'An active permit of this type already exists for this job.' USING ERRCODE = '23505'; END IF;

  INSERT INTO permit_applications (
    user_id, job_id, review_id, quote_id, authority_id, permit_type,
    form_name, scope_description, application_data
  ) VALUES (
    v_owner, p_job_id, p_review_id, p_quote_id, p_authority_id, p_permit_type,
    NULLIF(left(btrim(coalesce(p_form_name, '')), 160), ''),
    NULLIF(left(btrim(coalesce(p_scope, '')), 2000), ''),
    jsonb_build_object('owner_name', coalesce(v_job.customer_name, ''), 'site_address', coalesce(v_job.address, ''))
  ) RETURNING id INTO v_id;

  PERFORM public.permit_refresh_readiness(v_id);
  PERFORM public.permit_log_event(v_owner, v_id, 'created', NULL, 'draft', NULL);
  RETURN (SELECT to_jsonb(a) FROM permit_applications a WHERE a.id = v_id);
END;
$$;

-- 7) RPC: update (whitelisted fields only) -------------------------------------------

CREATE OR REPLACE FUNCTION public.update_permit_application(p_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app permit_applications%ROWTYPE;
  v_bad text;
  v_data jsonb;
  v_authority uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Invalid update.' USING ERRCODE = '22023';
  END IF;

  SELECT k INTO v_bad FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('authority_id', 'form_name', 'scope_description', 'application_data', 'fee_amount',
                   'fee_paid', 'reference_number', 'permit_number', 'expires_at', 'next_follow_up_at')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'Unsupported field.' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_app FROM permit_applications WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permit application not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_app.status IN ('closed', 'withdrawn') THEN
    RAISE EXCEPTION 'This permit application is closed.' USING ERRCODE = '22023';
  END IF;

  v_data := v_app.application_data;
  IF p_patch ? 'application_data' THEN
    IF jsonb_typeof(p_patch -> 'application_data') <> 'object'
       OR length((p_patch -> 'application_data')::text) > 6000 THEN
      RAISE EXCEPTION 'Invalid application data.' USING ERRCODE = '22023';
    END IF;
    v_data := v_data || (p_patch -> 'application_data');
  END IF;

  v_authority := v_app.authority_id;
  IF p_patch ? 'authority_id' THEN
    v_authority := NULLIF(p_patch ->> 'authority_id', '')::uuid;
    IF v_authority IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM permit_authorities WHERE id = v_authority AND user_id = v_owner
    ) THEN RAISE EXCEPTION 'Unknown authority.' USING ERRCODE = '22023'; END IF;
  END IF;

  UPDATE permit_applications SET
    authority_id = v_authority,
    application_data = v_data,
    form_name = CASE WHEN p_patch ? 'form_name'
      THEN NULLIF(left(btrim(coalesce(p_patch ->> 'form_name', '')), 160), '') ELSE form_name END,
    scope_description = CASE WHEN p_patch ? 'scope_description'
      THEN NULLIF(left(btrim(coalesce(p_patch ->> 'scope_description', '')), 2000), '') ELSE scope_description END,
    reference_number = CASE WHEN p_patch ? 'reference_number'
      THEN NULLIF(left(btrim(coalesce(p_patch ->> 'reference_number', '')), 80), '') ELSE reference_number END,
    permit_number = CASE WHEN p_patch ? 'permit_number'
      THEN NULLIF(left(btrim(coalesce(p_patch ->> 'permit_number', '')), 80), '') ELSE permit_number END,
    fee_amount = CASE WHEN p_patch ? 'fee_amount'
      THEN NULLIF(p_patch ->> 'fee_amount', '')::numeric ELSE fee_amount END,
    fee_paid_at = CASE
      WHEN p_patch ? 'fee_paid' AND (p_patch ->> 'fee_paid')::boolean THEN coalesce(fee_paid_at, now())
      WHEN p_patch ? 'fee_paid' THEN NULL
      ELSE fee_paid_at END,
    expires_at = CASE WHEN p_patch ? 'expires_at'
      THEN NULLIF(p_patch ->> 'expires_at', '')::date ELSE expires_at END,
    next_follow_up_at = CASE WHEN p_patch ? 'next_follow_up_at'
      THEN NULLIF(p_patch ->> 'next_follow_up_at', '')::date ELSE next_follow_up_at END,
    updated_at = now()
  WHERE id = p_id;

  PERFORM public.permit_refresh_readiness(p_id);
  PERFORM public.permit_log_event(v_owner, p_id, 'updated', v_app.status, v_app.status, NULL);
  RETURN (SELECT to_jsonb(a) FROM permit_applications a WHERE a.id = p_id);
END;
$$;

-- 8) RPC: state machine ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_permit_application(
  p_id uuid, p_to text, p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app permit_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_app FROM permit_applications WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permit application not found.' USING ERRCODE = 'P0002'; END IF;

  IF NOT public.permit_transition_allowed(v_app.status, p_to) THEN
    RAISE EXCEPTION 'That status change is not allowed from the current status.' USING ERRCODE = '22023';
  END IF;

  IF p_to = 'ready_to_file' AND cardinality(public.permit_missing_inputs(p_id)) > 0 THEN
    RAISE EXCEPTION 'Complete the missing application details first.' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'issued' AND btrim(coalesce(v_app.permit_number, '')) = '' THEN
    RAISE EXCEPTION 'Enter the permit number before marking it issued.' USING ERRCODE = '22023';
  END IF;
  IF p_to = 'passed' AND NOT EXISTS (
    SELECT 1 FROM permit_inspections WHERE application_id = p_id AND kind = 'final' AND status = 'passed'
  ) THEN RAISE EXCEPTION 'Record a passed final inspection first.' USING ERRCODE = '22023'; END IF;

  UPDATE permit_applications SET
    status = p_to,
    submitted_at = CASE WHEN p_to = 'submitted' THEN coalesce(submitted_at, now()) ELSE submitted_at END,
    issued_at = CASE WHEN p_to = 'issued' THEN now() ELSE issued_at END,
    closed_at = CASE WHEN p_to IN ('closed', 'withdrawn') THEN now() ELSE closed_at END,
    updated_at = now()
  WHERE id = p_id;

  PERFORM public.permit_log_event(
    v_owner, p_id,
    CASE WHEN v_app.status = 'corrections_required' AND p_to = 'submitted' THEN 'resubmitted' ELSE p_to END,
    v_app.status, p_to, p_note);
  RETURN (SELECT to_jsonb(a) FROM permit_applications a WHERE a.id = p_id);
END;
$$;

-- 9) RPC: inspections -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_permit_inspection(
  p_application_id uuid, p_kind text, p_label text DEFAULT NULL, p_scheduled_for timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_app permit_applications%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('rough', 'final', 'other') THEN
    RAISE EXCEPTION 'Invalid inspection type.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_app FROM permit_applications WHERE id = p_application_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permit application not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_app.status NOT IN ('issued', 'in_inspection') THEN
    RAISE EXCEPTION 'Inspections can be added once the permit is issued.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO permit_inspections (user_id, application_id, kind, label, status, scheduled_for)
  VALUES (v_owner, p_application_id, p_kind, NULLIF(left(btrim(coalesce(p_label, '')), 120), ''),
          CASE WHEN p_scheduled_for IS NULL THEN 'requested' ELSE 'scheduled' END, p_scheduled_for)
  RETURNING id INTO v_id;

  IF v_app.status = 'issued' THEN
    UPDATE permit_applications SET status = 'in_inspection', updated_at = now() WHERE id = p_application_id;
    PERFORM public.permit_log_event(v_owner, p_application_id, 'in_inspection', 'issued', 'in_inspection', NULL);
  END IF;
  PERFORM public.permit_log_event(v_owner, p_application_id, 'inspection_added', v_app.status, v_app.status, p_kind);
  RETURN (SELECT to_jsonb(i) FROM permit_inspections i WHERE i.id = v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_permit_inspection_result(
  p_inspection_id uuid,
  p_status text,
  p_note text DEFAULT NULL,
  p_inspector text DEFAULT NULL,
  p_scheduled_for timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_insp permit_inspections%ROWTYPE;
  v_app permit_applications%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('scheduled', 'passed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid inspection status.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_insp FROM permit_inspections WHERE id = p_inspection_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inspection not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_app FROM permit_applications WHERE id = v_insp.application_id FOR UPDATE;
  IF v_app.status NOT IN ('issued', 'in_inspection') THEN
    RAISE EXCEPTION 'This permit is no longer in inspection.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'scheduled' AND coalesce(p_scheduled_for, v_insp.scheduled_for) IS NULL THEN
    RAISE EXCEPTION 'Pick a date to schedule the inspection.' USING ERRCODE = '22023';
  END IF;

  UPDATE permit_inspections SET
    status = p_status,
    scheduled_for = coalesce(p_scheduled_for, scheduled_for),
    inspector_name = coalesce(NULLIF(left(btrim(coalesce(p_inspector, '')), 120), ''), inspector_name),
    result_note = coalesce(NULLIF(left(btrim(coalesce(p_note, '')), 500), ''), result_note),
    completed_at = CASE WHEN p_status IN ('passed', 'failed') THEN now() ELSE NULL END
  WHERE id = p_inspection_id;

  PERFORM public.permit_log_event(v_owner, v_app.id, 'inspection_' || p_status, v_app.status, v_app.status, v_insp.kind);

  -- A passed FINAL inspection completes the permit automatically.
  IF p_status = 'passed' AND v_insp.kind = 'final' AND v_app.status = 'in_inspection' THEN
    UPDATE permit_applications SET status = 'passed', updated_at = now() WHERE id = v_app.id;
    PERFORM public.permit_log_event(v_owner, v_app.id, 'passed', 'in_inspection', 'passed', 'Final inspection passed');
  END IF;
  RETURN (SELECT to_jsonb(i) FROM permit_inspections i WHERE i.id = p_inspection_id);
END;
$$;

-- 10) RPC: job-close check (read-only) ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.permit_close_status(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_open jsonb;
  v_total integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_total FROM permit_applications WHERE job_id = p_job_id AND user_id = v_owner;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'permit_type', permit_type, 'status', status)), '[]'::jsonb)
    INTO v_open FROM permit_applications
   WHERE job_id = p_job_id AND user_id = v_owner
     AND status NOT IN ('passed', 'closed', 'withdrawn', 'rejected', 'expired');
  RETURN jsonb_build_object('has_permits', v_total > 0, 'open', v_open, 'needs_attention', jsonb_array_length(v_open) > 0);
END;
$$;

-- 11) Grants ------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_permit_application(uuid, text, uuid, text, text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_permit_application(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transition_permit_application(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_permit_inspection(uuid, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_permit_inspection_result(uuid, text, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.permit_close_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_permit_application(uuid, text, uuid, text, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_permit_application(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_permit_application(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_permit_inspection(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_permit_inspection_result(uuid, text, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.permit_close_status(uuid) TO authenticated;
