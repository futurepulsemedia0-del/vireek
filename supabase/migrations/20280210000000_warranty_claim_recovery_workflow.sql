/*
  # Warranty Claim Recovery — detect, review, packet, approve, reconcile

  Builds ON the existing Warranty Claim Recovery feature (20261121000000, 20270416000000,
  20271110000000). Nothing is replaced; no page or table concept is added except one
  small detection log.

  ## What this adds
  1. warranty_claims.status gains `needs_review`, `ready`, `expired` (ADDITIVE: every old value stays valid,
     because supplier audit, OEM graph, home graph and protection plans read them).
     "Paid" is stored as the existing `credit_received` (shown as "Paid" in the UI).
  2. warranty_claims: detection_source / detected_at / detection_basis / ready_approved_at / ready_approved_by.
  3. profiles.warranty_claim_window_days: the tenant's own filing window. Manufacturer filing windows are NOT in
     oem_warranty_terms, so Vireek never invents a deadline: unset -> claim_deadline stays NULL and the packet flags it.
  4. warranty_recovery_detection_log: one row per (job, unit) the detector created a claim for, or could NOT decide
     because data was missing (skip + log). Tenant-scoped RLS, read-only for clients.
  5. warranty_recovery_detect(): service-role-only, idempotent detector (+ expiry sweep). Called by the
     detect-warranty-claims edge function and pg_cron.
  6. warranty_claim_packet(): compiles the packet LIVE from source records and flags what is missing. No AI, no guesses.
  7. warranty_claim_transition() / warranty_claim_record_payment(): the ONLY client write path for status and money.
     Human approval is explicit; nothing is ever sent to a manufacturer from here.
  8. Guard trigger (state machine, manufacturer claims only) + audit trigger (every status change -> audit_log).
  9. revenue_recovery_events accepts source_type `warranty_claim_recovered` / source_table `warranty_claims`.

  ## Security
  - All new reads/writes are scoped by get_account_owner_id(); RPCs also require warranty_recovery_can_manage()
    (account owner or office member; technicians are refused).
  - Detector / sweep / log helpers are executable by service_role ONLY.
  - Protection-plan claims (claim_type = 'protection_plan') are never touched by the new guard.

  ## Rollback
  Additive. To roll back: drop the new triggers/functions/table, then re-add the original status CHECK
  (only valid once no row uses needs_review/ready/expired). Columns can stay unused.

  ## Schedule
  Run detection BEFORE check-warranty-claim-deadlines each day (detection 05:30 UTC below).
  Auto-expiry happens 7 days after claim_deadline, after the daily overdue alert has had time to fire.
*/

-- 1) Status set (additive) ------------------------------------------------------------
ALTER TABLE public.warranty_claims DROP CONSTRAINT IF EXISTS warranty_claims_status_check;
ALTER TABLE public.warranty_claims ADD CONSTRAINT warranty_claims_status_check
  CHECK (status IN ('eligible', 'packet_pending', 'submitted', 'approved', 'denied', 'credit_received', 'closed',
                    'needs_review', 'ready', 'expired'));

-- 2) New columns (inherit the table's account-owner RLS) ---------------------------------
ALTER TABLE public.warranty_claims
  ADD COLUMN IF NOT EXISTS detection_source text NOT NULL DEFAULT 'manual'
    CHECK (detection_source IN ('manual', 'auto')),
  ADD COLUMN IF NOT EXISTS detected_at timestamptz,
  ADD COLUMN IF NOT EXISTS detection_basis jsonb
    CHECK (detection_basis IS NULL OR jsonb_typeof(detection_basis) = 'object'),
  ADD COLUMN IF NOT EXISTS ready_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS ready_approved_by uuid;

-- Idempotency backstop: at most one AUTO claim per (tenant, job, unit), even under concurrent runs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_claims_auto_job_equipment
  ON public.warranty_claims (user_id, job_id, equipment_id)
  WHERE detection_source = 'auto' AND job_id IS NOT NULL AND equipment_id IS NOT NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS warranty_claim_window_days integer
    CHECK (warranty_claim_window_days IS NULL OR warranty_claim_window_days BETWEEN 1 AND 730);

-- 3) Authorization helper (same shape as closeout_can_manage) -----------------------------
CREATE OR REPLACE FUNCTION public.warranty_recovery_can_manage()
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
REVOKE ALL ON FUNCTION public.warranty_recovery_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warranty_recovery_can_manage() TO authenticated, service_role;

-- 4) Detection log (skip + log) -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.warranty_recovery_detection_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('created', 'skipped')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 120),
  claim_id uuid REFERENCES public.warranty_claims(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  run_count integer NOT NULL DEFAULT 1,
  UNIQUE (user_id, job_id, equipment_id)
);
CREATE INDEX IF NOT EXISTS idx_wr_detect_log_user ON public.warranty_recovery_detection_log (user_id, outcome, last_seen_at DESC);

ALTER TABLE public.warranty_recovery_detection_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warranty_recovery_detection_log FROM anon, authenticated;
GRANT SELECT ON public.warranty_recovery_detection_log TO authenticated;
GRANT ALL ON public.warranty_recovery_detection_log TO service_role;

DROP POLICY IF EXISTS "select_own_warranty_detection_log" ON public.warranty_recovery_detection_log;
CREATE POLICY "select_own_warranty_detection_log" ON public.warranty_recovery_detection_log
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.warranty_recovery_can_manage());
-- No client INSERT/UPDATE/DELETE policy: written only by the detector.

-- 5) State machine ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.warranty_claim_transition_allowed(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_from
    WHEN 'needs_review'     THEN p_to IN ('ready', 'expired', 'closed')
    WHEN 'eligible'         THEN p_to IN ('needs_review', 'ready', 'expired', 'closed')       -- legacy
    WHEN 'packet_pending'   THEN p_to IN ('needs_review', 'ready', 'expired', 'closed')       -- legacy
    WHEN 'ready'            THEN p_to IN ('needs_review', 'submitted', 'expired', 'closed')
    WHEN 'submitted'        THEN p_to IN ('credit_received', 'denied', 'expired')
    WHEN 'approved'         THEN p_to IN ('credit_received', 'denied', 'expired', 'closed')   -- legacy
    WHEN 'credit_received'  THEN p_to IN ('closed')
    WHEN 'denied'           THEN p_to IN ('closed')
    WHEN 'expired'          THEN p_to IN ('closed')
    ELSE false
  END;
$$;
GRANT EXECUTE ON FUNCTION public.warranty_claim_transition_allowed(text, text) TO authenticated, service_role;

-- Guard: manufacturer claims only. Status and recovered money change ONLY through the RPCs below
-- (they set vireek.warranty_rpc) or the service role (auth.uid() IS NULL: detector / sweep).
CREATE OR REPLACE FUNCTION public.warranty_claims_workflow_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bypass boolean := COALESCE(current_setting('vireek.warranty_rpc', true), '') = 'on' OR auth.uid() IS NULL;
BEGIN
  IF NEW.claim_type IS DISTINCT FROM 'manufacturer' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_bypass THEN
      IF NEW.status NOT IN ('needs_review', 'eligible') THEN
        RAISE EXCEPTION 'WARRANTY_INITIAL_STATUS_INVALID' USING ERRCODE = '42501';
      END IF;
      IF NEW.detection_source IS DISTINCT FROM 'manual'
         OR NEW.detected_at IS NOT NULL OR NEW.detection_basis IS NOT NULL
         OR NEW.ready_approved_at IS NOT NULL OR NEW.ready_approved_by IS NOT NULL
         OR NEW.credit_received_cents IS NOT NULL OR NEW.credit_received_at IS NOT NULL THEN
        RAISE EXCEPTION 'WARRANTY_PROTECTED_FIELDS' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT v_bypass THEN
      RAISE EXCEPTION 'WARRANTY_STATUS_VIA_RPC_ONLY' USING ERRCODE = '42501';
    END IF;
    IF NOT public.warranty_claim_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'WARRANTY_INVALID_TRANSITION: % -> %', OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NOT v_bypass AND (
       NEW.credit_received_cents IS DISTINCT FROM OLD.credit_received_cents
    OR NEW.credit_received_at IS DISTINCT FROM OLD.credit_received_at
    OR NEW.detection_source IS DISTINCT FROM OLD.detection_source
    OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
    OR NEW.detection_basis IS DISTINCT FROM OLD.detection_basis
    OR NEW.ready_approved_at IS DISTINCT FROM OLD.ready_approved_at
    OR NEW.ready_approved_by IS DISTINCT FROM OLD.ready_approved_by
    OR NEW.claim_type IS DISTINCT FROM OLD.claim_type
    OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'WARRANTY_PROTECTED_FIELDS' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warranty_claims_workflow_guard ON public.warranty_claims;
CREATE TRIGGER trg_warranty_claims_workflow_guard
  BEFORE INSERT OR UPDATE ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.warranty_claims_workflow_guard();

-- Audit: every creation and every status change of a manufacturer claim.
CREATE OR REPLACE FUNCTION public.warranty_claims_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_type IS DISTINCT FROM 'manufacturer' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_audit_event(
      NEW.user_id,
      CASE WHEN NEW.detection_source = 'auto' THEN 'warranty_claim.auto_detected' ELSE 'warranty_claim.created' END,
      'warranty_claims', NEW.id::text,
      jsonb_build_object('changes', jsonb_build_object('status', jsonb_build_object('from', NULL, 'to', NEW.status))));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.log_audit_event(
      NEW.user_id, 'warranty_claim.status_changed', 'warranty_claims', NEW.id::text,
      jsonb_build_object('changes', jsonb_build_object('status', jsonb_build_object('from', OLD.status, 'to', NEW.status))));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warranty_claims_audit ON public.warranty_claims;
CREATE TRIGGER trg_warranty_claims_audit
  AFTER INSERT OR UPDATE OF status ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.warranty_claims_audit();

-- 6) Ledger: allow the new source (full list = every value defined by earlier migrations + new) ----
ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;
ALTER TABLE public.revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job',
    'quote_financing_stalled', 'quote_accepted_unbooked',
    'job_completed_unbilled', 'invoice_overdue',
    'membership_cancelled', 'membership_churned',
    'job_parts_unbilled', 'payment_failed',
    'warranty_claim_recovered'
  ));

ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_table_check;
ALTER TABLE public.revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_table_check
  CHECK (source_table IN ('calls', 'quotes', 'jobs', 'payment_requests', 'memberships', 'warranty_claims'));

-- 7) Detection log helper (internal) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._warranty_detect_log(
  p_user uuid, p_job uuid, p_equipment uuid, p_outcome text, p_reason text, p_claim uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.warranty_recovery_detection_log AS l
    (user_id, job_id, equipment_id, outcome, reason, claim_id)
  VALUES (p_user, p_job, p_equipment, p_outcome, left(p_reason, 120), p_claim)
  ON CONFLICT (user_id, job_id, equipment_id) DO UPDATE SET
    outcome = CASE WHEN l.outcome = 'created' THEN 'created' ELSE EXCLUDED.outcome END,
    reason = CASE WHEN l.outcome = 'created' THEN l.reason ELSE EXCLUDED.reason END,
    claim_id = COALESCE(EXCLUDED.claim_id, l.claim_id),
    last_seen_at = now(),
    run_count = l.run_count + 1;
END;
$$;
REVOKE ALL ON FUNCTION public._warranty_detect_log(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._warranty_detect_log(uuid, uuid, uuid, text, text, uuid) TO service_role;

-- 8) Detector -------------------------------------------------------------------------------------
-- Coverage is decided ONLY from recorded data:
--   a) oem_warranty_terms (parts / labor) matched to the unit by oem_match_equipment(); model-level terms are
--      used only for 'linked'/'exact' matches (never for fuzzy 'family' matches), start date = equipment.install_date,
--      else the owner's registration install/purchase date; registered_months applies only when a tenant-verified
--      registration exists and was made inside registration_window_days.
--   b) otherwise equipment.warranty_expires_at (the field the existing eligibility view already trusts).
-- Out of warranty -> nothing. Cannot decide (no install date, no basis, error) -> skipped + logged. Never guessed.
CREATE OR REPLACE FUNCTION public.warranty_recovery_detect(
  p_owner uuid DEFAULT NULL,
  p_lookback_days integer DEFAULT 180,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  reg record;
  t record;
  v_has_reg boolean;
  m jsonb;
  v_method text;
  v_mfr uuid;
  v_model uuid;
  v_start date;
  v_start_src text;
  v_done date;
  v_months integer;
  v_comp_end date;
  v_end date;
  v_components text[];
  v_terms_found integer;
  v_used_reg boolean;
  v_source text;
  v_covered boolean;
  v_reason text;
  v_basis jsonb;
  v_window integer;
  v_deadline date;
  v_part_desc text;
  v_part_cost bigint;
  v_part_null integer;
  v_claim uuid;
  n_scanned integer := 0;
  n_created integer := 0;
  n_skipped integer := 0;
  n_existing integer := 0;
  n_expired integer := 0;
BEGIN
  IF p_lookback_days IS NULL OR p_lookback_days < 1 OR p_lookback_days > 730 THEN p_lookback_days := 180; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2000 THEN p_limit := 500; END IF;

  -- One run at a time (a concurrent run simply reports locked; the unique index is the hard backstop).
  IF NOT pg_try_advisory_xact_lock(hashtext('vireek.warranty_recovery_detect')) THEN
    RETURN jsonb_build_object('ok', true, 'locked', true);
  END IF;
  PERFORM set_config('vireek.warranty_rpc', 'on', true);

  FOR r IN
    SELECT j.id AS job_id, j.user_id, j.customer_name, j.customer_phone, j.address AS property_address,
           j.completed_at,
           e.id AS equipment_id, e.equipment_type, e.make, e.model, e.serial_number, e.install_date,
           e.warranty_expires_at
    FROM public.job_equipment je
    JOIN public.jobs j ON j.id = je.job_id
    JOIN public.equipment e ON e.id = je.equipment_id AND e.user_id = j.user_id
    LEFT JOIN public.warranty_recovery_detection_log l
      ON l.user_id = j.user_id AND l.job_id = j.id AND l.equipment_id = e.id
    WHERE j.job_status = 'completed'
      AND j.completed_at IS NOT NULL
      AND j.completed_at >= now() - make_interval(days => p_lookback_days)
      AND (p_owner IS NULL OR j.user_id = p_owner)
      AND l.outcome IS DISTINCT FROM 'created'           -- never resurrect a claim a human deleted
      AND NOT EXISTS (SELECT 1 FROM public.warranty_claims wc WHERE wc.job_id = j.id AND wc.equipment_id = e.id)
    ORDER BY l.last_seen_at NULLS FIRST, j.completed_at DESC
    LIMIT p_limit
  LOOP
    n_scanned := n_scanned + 1;
    BEGIN
      v_reason := NULL;
      v_covered := false;
      v_end := NULL;
      v_components := ARRAY[]::text[];
      v_terms_found := 0;
      v_used_reg := false;
      v_source := NULL;
      v_done := r.completed_at::date;

      -- Tenant-verified owner registration for THIS unit (same verification rule as wr_link_claim).
      SELECT wr.purchase_date, wr.install_date AS reg_install, wr.created_at::date AS reg_on
      INTO reg
      FROM public.equipment_passport_links l
      JOIN public.warranty_registrations wr ON wr.passport_id = l.passport_id
      WHERE l.equipment_id = r.equipment_id AND l.user_id = r.user_id
        AND l.status = 'active' AND l.verified
      ORDER BY wr.created_at DESC
      LIMIT 1;
      v_has_reg := FOUND;

      IF r.install_date IS NOT NULL THEN
        v_start := r.install_date; v_start_src := 'equipment_install_date';
      ELSIF v_has_reg AND reg.reg_install IS NOT NULL THEN
        v_start := reg.reg_install; v_start_src := 'registration_install_date';
      ELSIF v_has_reg AND reg.purchase_date IS NOT NULL THEN
        v_start := reg.purchase_date; v_start_src := 'registration_purchase_date';
      ELSE
        v_start := NULL; v_start_src := NULL;
      END IF;

      m := public.oem_match_equipment(r.equipment_id, r.make, r.model);
      v_method := m ->> 'method';
      v_mfr := nullif(m ->> 'manufacturer_id', '')::uuid;
      v_model := CASE WHEN v_method IN ('linked', 'exact') THEN nullif(m ->> 'model_id', '')::uuid ELSE NULL END;

      IF v_mfr IS NOT NULL AND v_start IS NOT NULL THEN
        FOR t IN
          SELECT DISTINCT ON (w.component) w.component, w.months, w.registered_months, w.registration_window_days
          FROM public.oem_warranty_terms w
          WHERE w.manufacturer_id = v_mfr
            AND w.component IN ('parts', 'labor')
            AND ((v_model IS NOT NULL AND w.model_id = v_model)
                 OR (w.model_id IS NULL
                     AND (w.equipment_type IS NULL
                          OR lower(w.equipment_type) = lower(btrim(coalesce(r.equipment_type, ''))))))
          ORDER BY w.component, (w.model_id IS NULL), (w.equipment_type IS NULL)
        LOOP
          v_terms_found := v_terms_found + 1;
          v_months := t.months;
          IF v_has_reg AND t.registered_months IS NOT NULL
             AND (t.registration_window_days IS NULL OR reg.reg_on <= v_start + t.registration_window_days) THEN
            v_months := t.registered_months;
            v_used_reg := true;
          END IF;
          v_comp_end := (v_start + make_interval(months => v_months))::date;
          IF v_done <= v_comp_end THEN
            v_components := v_components || t.component;
            v_end := greatest(coalesce(v_end, v_comp_end), v_comp_end);
          END IF;
        END LOOP;
      END IF;

      IF v_start IS NOT NULL AND v_start > v_done THEN
        v_reason := 'install_after_job';
      ELSIF v_terms_found > 0 THEN
        v_source := 'oem_warranty_terms';
        v_covered := cardinality(v_components) > 0;
      ELSIF r.warranty_expires_at IS NOT NULL THEN
        v_source := 'equipment_warranty_expires_at';
        v_covered := v_done <= r.warranty_expires_at;
        v_end := r.warranty_expires_at;
      ELSIF v_start IS NULL THEN
        v_reason := 'missing_install_date';
      ELSE
        v_reason := 'no_warranty_basis';
      END IF;

      IF v_reason IS NOT NULL THEN
        PERFORM public._warranty_detect_log(r.user_id, r.job_id, r.equipment_id, 'skipped', v_reason, NULL);
        n_skipped := n_skipped + 1;
        CONTINUE;
      END IF;

      IF NOT v_covered THEN
        CONTINUE;   -- definitively out of warranty: not a data problem, nothing to log
      END IF;

      -- Parts actually used on the job (recorded inventory usage). Cost only if EVERY usage row has a cost.
      SELECT string_agg(DISTINCT p.name, ', '),
             sum((-it.quantity_delta)::bigint * it.unit_cost_cents::bigint),
             count(*) FILTER (WHERE it.unit_cost_cents IS NULL)
      INTO v_part_desc, v_part_cost, v_part_null
      FROM public.inventory_transactions it
      JOIN public.inventory_parts p ON p.id = it.part_id
      WHERE it.job_id = r.job_id AND it.user_id = r.user_id AND it.transaction_type = 'usage';
      IF coalesce(v_part_null, 0) > 0 OR v_part_cost IS NULL OR v_part_cost < 0 OR v_part_cost > 2147483647 THEN
        v_part_cost := NULL;
      END IF;

      SELECT pr.warranty_claim_window_days INTO v_window FROM public.profiles pr WHERE pr.id = r.user_id;
      v_deadline := CASE WHEN v_window IS NOT NULL THEN v_done + v_window ELSE NULL END;

      v_basis := jsonb_build_object(
        'source', v_source,
        'components', to_jsonb(v_components),
        'coverage_start', v_start,
        'coverage_start_source', v_start_src,
        'coverage_end', v_end,
        'oem_match_method', v_method,
        'used_registered_months', v_used_reg,
        'registration_found', v_has_reg,
        'job_completed_on', v_done,
        'deadline_basis', CASE WHEN v_window IS NOT NULL THEN 'tenant_window_days:' || v_window ELSE 'unset' END);

      v_claim := NULL;
      INSERT INTO public.warranty_claims
        (user_id, job_id, equipment_id, claim_type, customer_name, customer_phone, property_address,
         manufacturer, model_number, serial_number, part_description, install_date, warranty_expires_at,
         claim_deadline, status, part_cost_cents, detection_source, detected_at, detection_basis)
      VALUES
        (r.user_id, r.job_id, r.equipment_id, 'manufacturer',
         coalesce(nullif(btrim(r.customer_name), ''), 'Unknown customer'), r.customer_phone, r.property_address,
         nullif(btrim(r.make), ''), nullif(btrim(r.model), ''), nullif(btrim(r.serial_number), ''),
         v_part_desc, v_start, v_end,
         v_deadline, 'needs_review', v_part_cost::integer, 'auto', now(), v_basis)
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_claim;

      IF v_claim IS NULL THEN
        n_existing := n_existing + 1;           -- lost a race / already there: idempotent
      ELSE
        PERFORM public._warranty_detect_log(r.user_id, r.job_id, r.equipment_id, 'created', NULL, v_claim);
        n_created := n_created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad record never stops the run, and never leaks row data into the log (SQLSTATE only).
      PERFORM public._warranty_detect_log(r.user_id, r.job_id, r.equipment_id, 'skipped', 'error_' || SQLSTATE, NULL);
      n_skipped := n_skipped + 1;
    END;
  END LOOP;

  -- Expiry sweep: unsubmitted claims 7 days past their deadline (the overdue alert has fired by then).
  UPDATE public.warranty_claims
  SET status = 'expired'
  WHERE claim_type = 'manufacturer'
    AND status IN ('needs_review', 'ready', 'eligible', 'packet_pending')
    AND claim_deadline IS NOT NULL
    AND claim_deadline < current_date - 7
    AND (p_owner IS NULL OR user_id = p_owner);
  GET DIAGNOSTICS n_expired = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'scanned', n_scanned, 'created', n_created, 'skipped_logged', n_skipped,
                            'already_present', n_existing, 'expired', n_expired);
END;
$$;
REVOKE ALL ON FUNCTION public.warranty_recovery_detect(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.warranty_recovery_detect(uuid, integer, integer) TO service_role;

-- 9) Packet builder (internal) + client RPC ------------------------------------------------------------
-- Compiled LIVE from records. Missing data is reported, never filled in.
CREATE OR REPLACE FUNCTION public._warranty_packet_build(c public.warranty_claims)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e record;
  j record;
  v_make text;
  v_model text;
  v_serial text;
  v_install date;
  v_notes_job text;
  v_notes_outcome text;
  v_failure text;
  v_parts jsonb;
  v_photos jsonb;
  v_hours numeric;
  v_entries integer;
  v_reg jsonb;
  v_items jsonb;
  v_missing jsonb;
  v_blocking jsonb;
BEGIN
  SELECT eq.make, eq.model, eq.serial_number, eq.install_date, eq.warranty_expires_at
  INTO e FROM public.equipment eq WHERE eq.id = c.equipment_id AND eq.user_id = c.user_id;

  SELECT jb.completed_at, jb.service_type, jb.notes
  INTO j FROM public.jobs jb WHERE jb.id = c.job_id AND jb.user_id = c.user_id;

  v_make := coalesce(nullif(btrim(c.manufacturer), ''), nullif(btrim(e.make), ''));
  v_model := coalesce(nullif(btrim(c.model_number), ''), nullif(btrim(e.model), ''));
  v_serial := coalesce(nullif(btrim(c.serial_number), ''), nullif(btrim(e.serial_number), ''));
  v_install := coalesce(c.install_date, e.install_date);

  v_notes_job := nullif(btrim(j.notes), '');
  SELECT nullif(btrim(o.notes), '') INTO v_notes_outcome
  FROM public.job_outcomes o WHERE o.job_id = c.job_id AND o.user_id = c.user_id
  ORDER BY o.recorded_at DESC LIMIT 1;
  v_failure := coalesce(nullif(btrim(c.failure_description), ''), v_notes_outcome, v_notes_job);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', p.name, 'part_number', p.part_number,
           'quantity', (-it.quantity_delta), 'unit_cost_cents', it.unit_cost_cents) ORDER BY it.created_at), '[]'::jsonb)
  INTO v_parts
  FROM public.inventory_transactions it
  JOIN public.inventory_parts p ON p.id = it.part_id
  WHERE it.job_id = c.job_id AND it.user_id = c.user_id AND it.transaction_type = 'usage';

  SELECT sum(ts.regular_hours + ts.overtime_hours), count(*)::integer
  INTO v_hours, v_entries
  FROM public.timesheets ts
  WHERE ts.job_id = c.job_id AND ts.user_id = c.user_id AND ts.status = 'approved';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', ph.id, 'kind', ph.kind, 'caption', ph.caption, 'file_name', ph.file_name, 'taken_at', ph.taken_at)
         ORDER BY ph.taken_at), '[]'::jsonb)
  INTO v_photos
  FROM (SELECT * FROM public.job_photos x WHERE x.job_id = c.job_id AND x.user_id = c.user_id
        ORDER BY x.taken_at LIMIT 20) ph;

  SELECT jsonb_build_object('registered', true, 'purchase_date', wr.purchase_date, 'install_date', wr.install_date,
                            'registered_on', wr.created_at::date)
  INTO v_reg
  FROM public.equipment_passport_links l
  JOIN public.warranty_registrations wr ON wr.passport_id = l.passport_id
  WHERE l.equipment_id = c.equipment_id AND l.user_id = c.user_id AND l.status = 'active' AND l.verified
  ORDER BY wr.created_at DESC LIMIT 1;
  v_reg := coalesce(v_reg, jsonb_build_object('registered', false));

  v_items := jsonb_build_array(
    jsonb_build_object('key', 'manufacturer',   'label', 'Manufacturer',            'present', v_make IS NOT NULL,   'blocking', true),
    jsonb_build_object('key', 'model_number',   'label', 'Model number',            'present', v_model IS NOT NULL,  'blocking', true),
    jsonb_build_object('key', 'serial_number',  'label', 'Serial number',           'present', v_serial IS NOT NULL, 'blocking', true),
    jsonb_build_object('key', 'install_date',   'label', 'Install date',            'present', v_install IS NOT NULL,'blocking', true),
    jsonb_build_object('key', 'failure_notes',  'label', 'Failure / diagnosis notes','present', v_failure IS NOT NULL,'blocking', true),
    jsonb_build_object('key', 'claim_deadline', 'label', 'Filing deadline confirmed','present', c.claim_deadline IS NOT NULL, 'blocking', true),
    jsonb_build_object('key', 'parts',          'label', 'Parts used',              'present', jsonb_array_length(v_parts) > 0, 'blocking', false),
    jsonb_build_object('key', 'labor_hours',    'label', 'Labor hours (approved timesheets)', 'present', v_hours IS NOT NULL, 'blocking', false),
    jsonb_build_object('key', 'photos',         'label', 'Job photos',              'present', jsonb_array_length(v_photos) > 0, 'blocking', false)
  );

  SELECT coalesce(jsonb_agg(i ->> 'key'), '[]'::jsonb) INTO v_missing
  FROM jsonb_array_elements(v_items) i WHERE (i ->> 'present')::boolean IS NOT TRUE;
  SELECT coalesce(jsonb_agg(i ->> 'key'), '[]'::jsonb) INTO v_blocking
  FROM jsonb_array_elements(v_items) i
  WHERE (i ->> 'present')::boolean IS NOT TRUE AND (i ->> 'blocking')::boolean IS TRUE;

  RETURN jsonb_build_object(
    'claim_id', c.id,
    'status', c.status,
    'customer_name', c.customer_name,
    'property_address', c.property_address,
    'unit', jsonb_build_object('manufacturer', v_make, 'model_number', v_model, 'serial_number', v_serial,
                               'install_date', v_install, 'warranty_expires_at', coalesce(c.warranty_expires_at, e.warranty_expires_at),
                               'registration', v_reg),
    'job', jsonb_build_object('id', c.job_id, 'completed_at', j.completed_at, 'service_type', j.service_type),
    'failure_notes', jsonb_build_object('text', v_failure,
        'source', CASE WHEN nullif(btrim(c.failure_description), '') IS NOT NULL THEN 'claim'
                       WHEN v_notes_outcome IS NOT NULL THEN 'job_outcome' WHEN v_notes_job IS NOT NULL THEN 'job_notes' ELSE NULL END),
    'parts', v_parts,
    'labor', jsonb_build_object('hours', v_hours, 'entries', coalesce(v_entries, 0), 'source', 'approved_timesheets'),
    'photos', v_photos,
    'claim_deadline', c.claim_deadline,
    'detection_basis', c.detection_basis,
    'checklist', c.packet_checklist,
    'items', v_items,
    'missing', v_missing,
    'blocking_missing', v_blocking,
    'complete', jsonb_array_length(v_blocking) = 0);
END;
$$;
REVOKE ALL ON FUNCTION public._warranty_packet_build(public.warranty_claims) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._warranty_packet_build(public.warranty_claims) TO service_role;

CREATE OR REPLACE FUNCTION public.warranty_claim_packet(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.warranty_claims;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.warranty_recovery_can_manage() THEN
    RAISE EXCEPTION 'WARRANTY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM public.warranty_claims
  WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'manufacturer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WARRANTY_CLAIM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN public._warranty_packet_build(c);
END;
$$;
REVOKE ALL ON FUNCTION public.warranty_claim_packet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warranty_claim_packet(uuid) TO authenticated;

-- 10) Status transition (human approval gate) ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.warranty_claim_transition(
  p_claim_id uuid,
  p_to text,
  p_ref text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_confirm boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.warranty_claims;
  v_packet jsonb;
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.warranty_recovery_can_manage() THEN
    RAISE EXCEPTION 'WARRANTY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.warranty_claims
  WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'manufacturer'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WARRANTY_CLAIM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_to = 'credit_received' THEN
    RAISE EXCEPTION 'WARRANTY_USE_RECORD_PAYMENT' USING ERRCODE = '22023';
  END IF;
  IF p_to IS NULL OR NOT public.warranty_claim_transition_allowed(c.status, p_to) THEN
    RAISE EXCEPTION 'WARRANTY_INVALID_TRANSITION: % -> %', c.status, coalesce(p_to, 'null') USING ERRCODE = '22023';
  END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 120 THEN
    RAISE EXCEPTION 'WARRANTY_REF_TOO_LONG' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'WARRANTY_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vireek.warranty_rpc', 'on', true);

  IF p_to = 'ready' THEN
    IF p_confirm IS NOT TRUE THEN
      RAISE EXCEPTION 'WARRANTY_HUMAN_APPROVAL_REQUIRED' USING ERRCODE = '22023';
    END IF;
    v_packet := public._warranty_packet_build(c);
    IF jsonb_array_length(v_packet -> 'blocking_missing') > 0 THEN
      RAISE EXCEPTION 'WARRANTY_PACKET_INCOMPLETE: %',
        (SELECT string_agg(x, ',') FROM jsonb_array_elements_text(v_packet -> 'blocking_missing') x)
        USING ERRCODE = '22023';
    END IF;
    UPDATE public.warranty_claims
    SET status = 'ready', ready_approved_at = now(), ready_approved_by = auth.uid()
    WHERE id = c.id;

  ELSIF p_to = 'submitted' THEN
    IF p_confirm IS NOT TRUE THEN
      RAISE EXCEPTION 'WARRANTY_HUMAN_APPROVAL_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF v_ref IS NULL THEN
      RAISE EXCEPTION 'WARRANTY_REF_REQUIRED' USING ERRCODE = '22023';
    END IF;
    UPDATE public.warranty_claims
    SET status = 'submitted', claim_number = v_ref, submitted_at = now()
    WHERE id = c.id;

  ELSIF p_to = 'denied' THEN
    UPDATE public.warranty_claims
    SET status = 'denied', denial_reason = coalesce(v_note, denial_reason)
    WHERE id = c.id;

  ELSIF p_to = 'needs_review' THEN
    UPDATE public.warranty_claims
    SET status = 'needs_review', ready_approved_at = NULL, ready_approved_by = NULL
    WHERE id = c.id;

  ELSE   -- expired, closed
    UPDATE public.warranty_claims SET status = p_to WHERE id = c.id;
  END IF;

  RETURN jsonb_build_object('id', c.id, 'status', p_to);
END;
$$;
REVOKE ALL ON FUNCTION public.warranty_claim_transition(uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warranty_claim_transition(uuid, text, text, text, boolean) TO authenticated;

-- 11) Reconcile: record the amount actually paid -> recovered $ -> revenue_recovery_events -------------------
CREATE OR REPLACE FUNCTION public.warranty_claim_record_payment(
  p_claim_id uuid,
  p_amount_cents bigint,
  p_received_on date DEFAULT NULL,
  p_method text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.warranty_claims;
  v_on date := coalesce(p_received_on, current_date);
  v_method text := nullif(btrim(coalesce(p_method, '')), '');
  v_estimate integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.warranty_recovery_can_manage() THEN
    RAISE EXCEPTION 'WARRANTY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 2147483647 THEN
    RAISE EXCEPTION 'WARRANTY_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_on > current_date + 1 THEN
    RAISE EXCEPTION 'WARRANTY_DATE_IN_FUTURE' USING ERRCODE = '22023';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('account_credit', 'check', 'ach', 'other') THEN
    RAISE EXCEPTION 'WARRANTY_METHOD_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO c FROM public.warranty_claims
  WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'manufacturer'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WARRANTY_CLAIM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- submitted/approved -> paid; paid -> paid is an amount correction (same ledger row is updated).
  IF c.status NOT IN ('submitted', 'approved', 'credit_received') THEN
    RAISE EXCEPTION 'WARRANTY_INVALID_TRANSITION: % -> credit_received', c.status USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vireek.warranty_rpc', 'on', true);

  UPDATE public.warranty_claims
  SET status = 'credit_received',
      credit_received_cents = p_amount_cents::integer,
      credit_received_at = v_on,
      credit_method = coalesce(v_method, credit_method)
  WHERE id = c.id;

  v_estimate := greatest(coalesce(c.claimed_amount_cents, 0), 0);

  INSERT INTO public.revenue_recovery_events AS e
    (user_id, source_type, source_table, source_id, customer_name, customer_phone, occurred_at,
     estimated_value_cents, estimated_value_basis, status, recovery_method, recovered_amount_cents,
     notes, resolved_at, resolved_by)
  VALUES
    (v_owner, 'warranty_claim_recovered', 'warranty_claims', c.id,
     coalesce(nullif(btrim(c.customer_name), ''), 'Unknown customer'), c.customer_phone, now(),
     v_estimate, CASE WHEN v_estimate > 0 THEN 'manual' ELSE 'none' END, 'recovered', 'manual',
     p_amount_cents::integer, 'Manufacturer warranty credit recorded by you.', now(), auth.uid())
  ON CONFLICT (source_table, source_id) DO UPDATE SET
    recovered_amount_cents = EXCLUDED.recovered_amount_cents,
    estimated_value_cents = EXCLUDED.estimated_value_cents,
    estimated_value_basis = EXCLUDED.estimated_value_basis,
    status = 'recovered',
    recovery_method = 'manual',
    resolved_at = now(),
    resolved_by = auth.uid();

  PERFORM public.log_audit_event(
    v_owner, 'warranty_claim.payment_recorded', 'warranty_claims', c.id::text,
    jsonb_build_object('changes', jsonb_build_object(
      'credit_received_cents', jsonb_build_object('from', c.credit_received_cents, 'to', p_amount_cents))));

  RETURN jsonb_build_object(
    'id', c.id, 'status', 'credit_received',
    'recovered_cents', p_amount_cents,
    'claimed_cents', c.claimed_amount_cents,
    'shortfall_cents', CASE WHEN c.claimed_amount_cents IS NULL THEN NULL
                            ELSE greatest(c.claimed_amount_cents - p_amount_cents, 0) END);
END;
$$;
REVOKE ALL ON FUNCTION public.warranty_claim_record_payment(uuid, bigint, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warranty_claim_record_payment(uuid, bigint, date, text) TO authenticated;

-- 12) Schedule (optional extensions; same pattern as dispatch_closeout_engine) ---------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_warranty_detection()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.warranty_cron_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'warranty detection not dispatched: app.settings.edge_function_base_url / warranty_cron_secret not set';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base_url || '/detect-warranty-claims',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-warranty-secret', v_secret),
    body := '{}'::jsonb
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_warranty_detection() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule('vireek-warranty-detection', '30 5 * * *', 'select public.dispatch_warranty_detection()');
  ELSE
    RAISE NOTICE 'pg_cron/pg_net not enabled: call the detect-warranty-claims edge function daily from an external scheduler.';
  END IF;
END $$;
