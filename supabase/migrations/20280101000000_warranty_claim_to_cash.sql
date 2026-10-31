/*
  # Warranty Claim-to-Cash

  Extends the EXISTING `warranty_claims` (20261121000000_warranty_claim_recovery_os.sql),
  `oem_warranty_terms` (20270401000000_oem_intelligence_graph.sql), `ar_invoices` and the QBO
  ledger path (20271011000000_quickbooks_sync.sql) and `revenue_recovery_events`.

  ## What this adds
  - oem_warranty_terms: nullable `labor_allowance_cents_per_hour`, `claim_window_days`
    (the table had NO money or filing-window data; NULL = unknown, never guessed).
  - warranty_claims: estimated_recovery_cents, estimate_basis, source, labor_hours, invoice_ref,
    ar_invoice_id, ar_payment_id, detected_at.
  - Status machine for claim_type = 'manufacturer' (protection-plan claims are untouched):
      needs_review > ready > submitted > approved | denied | expired > paid > closed
    Legacy values are mapped: eligible -> needs_review, packet_pending -> ready, credit_received -> paid.
    Invalid transitions and missing required data are rejected by a trigger, so the existing page's
    direct UPDATE can no longer skip steps.
  - warranty_claim_events: audit log of every status change (written only by trigger).
  - revenue_recovery_events: new source_type 'warranty_claim_paid' / source_table 'warranty_claims';
    written by the trigger when a claim becomes paid (idempotent upsert).
  - wcc_detect_claims(): cron detector (service_role only).
  - wcc_packet(): claim packet data + missing items.
  - wcc_create_ar_invoice() / wcc_apply_payment(): accounting handoff through qbo_create_ar_invoice /
    record_ar_payment. Never voids or edits an existing invoice.
  - warranty_claim_reconciliation view: variance, short-pay, aging.

  Run order: after 20271231120000. No manufacturer portal automation, no auto-submission.
*/

-- 1. oem_warranty_terms: optional money / filing window ------------------------------
ALTER TABLE public.oem_warranty_terms
  ADD COLUMN IF NOT EXISTS labor_allowance_cents_per_hour integer
    CHECK (labor_allowance_cents_per_hour IS NULL OR labor_allowance_cents_per_hour BETWEEN 0 AND 100000),
  ADD COLUMN IF NOT EXISTS claim_window_days integer
    CHECK (claim_window_days IS NULL OR claim_window_days BETWEEN 1 AND 3650);

-- 2. warranty_claims: new columns --------------------------------------------------------
ALTER TABLE public.warranty_claims
  ADD COLUMN IF NOT EXISTS estimated_recovery_cents integer CHECK (estimated_recovery_cents IS NULL OR estimated_recovery_cents >= 0),
  ADD COLUMN IF NOT EXISTS estimate_basis jsonb,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'detector')),
  ADD COLUMN IF NOT EXISTS labor_hours numeric CHECK (labor_hours IS NULL OR labor_hours >= 0),
  ADD COLUMN IF NOT EXISTS invoice_ref text CHECK (invoice_ref IS NULL OR char_length(invoice_ref) <= 120),
  ADD COLUMN IF NOT EXISTS ar_invoice_id uuid REFERENCES public.ar_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ar_payment_id uuid REFERENCES public.ar_payments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS detected_at timestamptz;

-- Widen the status CHECK (legacy values stay valid: protection-plan claims still use them).
ALTER TABLE public.warranty_claims DROP CONSTRAINT IF EXISTS warranty_claims_status_check;
ALTER TABLE public.warranty_claims
  ADD CONSTRAINT warranty_claims_status_check
  CHECK (status IN ('eligible', 'packet_pending', 'submitted', 'approved', 'denied', 'credit_received', 'closed',
                    'needs_review', 'ready', 'expired', 'paid'));

-- Move existing MANUFACTURER claims to the new names BEFORE the guard trigger exists.
UPDATE public.warranty_claims
SET status = CASE status WHEN 'eligible' THEN 'needs_review' WHEN 'packet_pending' THEN 'ready' ELSE 'paid' END
WHERE claim_type = 'manufacturer' AND status IN ('eligible', 'packet_pending', 'credit_received');

-- Idempotency backstop: one manufacturer claim per job + unit (skipped, with a warning, if old data has duplicates).
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_claims_job_equipment
    ON public.warranty_claims (job_id, equipment_id)
    WHERE claim_type = 'manufacturer' AND job_id IS NOT NULL AND equipment_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'uq_warranty_claims_job_equipment not created: duplicate manufacturer claims already exist';
END $$;

CREATE INDEX IF NOT EXISTS idx_warranty_claims_unpaid_aging
  ON public.warranty_claims (user_id, submitted_at)
  WHERE claim_type = 'manufacturer' AND status IN ('submitted', 'approved');

-- 3. Audit log -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.warranty_claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  claim_id uuid NOT NULL REFERENCES public.warranty_claims(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wce_claim ON public.warranty_claim_events (claim_id, created_at);
ALTER TABLE public.warranty_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warranty_claim_events FROM anon, authenticated;
GRANT SELECT ON public.warranty_claim_events TO authenticated;
DROP POLICY IF EXISTS "wce_select_own" ON public.warranty_claim_events;
CREATE POLICY "wce_select_own" ON public.warranty_claim_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client write policy: rows are written only by trg_wcc_after_write (SECURITY DEFINER).

-- 4. Status machine ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wcc_norm_status(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'eligible' THEN 'needs_review' WHEN 'packet_pending' THEN 'ready' WHEN 'credit_received' THEN 'paid' ELSE p END
$$;

CREATE OR REPLACE FUNCTION public.wcc_transition_ok(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE public.wcc_norm_status(p_from)
    WHEN 'needs_review' THEN p_to IN ('ready', 'expired', 'closed')
    WHEN 'ready'        THEN p_to IN ('needs_review', 'submitted', 'expired', 'closed')
    WHEN 'submitted'    THEN p_to IN ('approved', 'denied', 'expired')
    WHEN 'approved'     THEN p_to IN ('paid', 'closed')
    WHEN 'denied'       THEN p_to IN ('closed')
    WHEN 'expired'      THEN p_to IN ('closed')
    WHEN 'paid'         THEN p_to IN ('closed')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.wcc_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_from text;
  v_to text;
BEGIN
  IF NEW.claim_type IS DISTINCT FROM 'manufacturer' THEN RETURN NEW; END IF;
  v_to := public.wcc_norm_status(NEW.status);
  NEW.status := v_to;

  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  v_from := public.wcc_norm_status(OLD.status);

  IF v_from = 'paid' AND (
       NEW.claimed_amount_cents IS DISTINCT FROM OLD.claimed_amount_cents
    OR NEW.approved_amount_cents IS DISTINCT FROM OLD.approved_amount_cents
    OR NEW.credit_received_cents IS DISTINCT FROM OLD.credit_received_cents
    OR NEW.credit_received_at IS DISTINCT FROM OLD.credit_received_at) THEN
    RAISE EXCEPTION 'claim_paid_locked' USING ERRCODE = '23514';
  END IF;

  IF v_to = v_from THEN RETURN NEW; END IF;

  IF NOT public.wcc_transition_ok(v_from, v_to) THEN
    RAISE EXCEPTION 'invalid_claim_transition: % -> %', v_from, v_to USING ERRCODE = '23514';
  END IF;

  IF v_to = 'ready' AND (
       nullif(btrim(coalesce(NEW.manufacturer, '')), '') IS NULL
    OR nullif(btrim(coalesce(NEW.model_number, '')), '') IS NULL
    OR nullif(btrim(coalesce(NEW.serial_number, '')), '') IS NULL
    OR nullif(btrim(coalesce(NEW.failure_description, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'claim_packet_incomplete' USING ERRCODE = '23514';
  ELSIF v_to = 'submitted' THEN
    IF nullif(btrim(coalesce(NEW.claim_number, '')), '') IS NULL THEN
      RAISE EXCEPTION 'manufacturer_reference_required' USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := coalesce(NEW.submitted_at, now());
    IF NEW.submitted_at > now() + interval '1 day' THEN
      RAISE EXCEPTION 'submitted_date_in_future' USING ERRCODE = '23514';
    END IF;
  ELSIF v_to = 'approved' THEN
    IF NEW.approved_amount_cents IS NULL OR NEW.approved_amount_cents < 0 THEN
      RAISE EXCEPTION 'approved_amount_required' USING ERRCODE = '23514';
    END IF;
    NEW.decided_at := coalesce(NEW.decided_at, now());
  ELSIF v_to = 'denied' THEN
    IF nullif(btrim(coalesce(NEW.denial_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'denial_reason_required' USING ERRCODE = '23514';
    END IF;
    NEW.decided_at := coalesce(NEW.decided_at, now());
  ELSIF v_to = 'paid' THEN
    IF NEW.credit_received_cents IS NULL OR NEW.credit_received_cents < 0 THEN
      RAISE EXCEPTION 'paid_amount_required' USING ERRCODE = '23514';
    END IF;
    NEW.credit_received_at := coalesce(NEW.credit_received_at, current_date);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wcc_before_write ON public.warranty_claims;
CREATE TRIGGER trg_wcc_before_write
  BEFORE INSERT OR UPDATE ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.wcc_before_write();

-- Audit row + revenue_recovery_events when a claim becomes paid.
CREATE OR REPLACE FUNCTION public.wcc_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_type IS DISTINCT FROM 'manufacturer' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO warranty_claim_events (user_id, claim_id, from_status, to_status, actor, detail)
    VALUES (NEW.user_id, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status, auth.uid(),
            jsonb_strip_nulls(jsonb_build_object(
              'source', NEW.source, 'claim_number', NEW.claim_number, 'submitted_at', NEW.submitted_at,
              'approved_amount_cents', NEW.approved_amount_cents, 'credit_received_cents', NEW.credit_received_cents,
              'denial_reason', NEW.denial_reason)));
  END IF;

  IF NEW.status = 'paid' AND coalesce(NEW.credit_received_cents, 0) > 0
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'paid') THEN
    INSERT INTO revenue_recovery_events
      (user_id, source_type, source_table, source_id, customer_name, occurred_at,
       estimated_value_cents, estimated_value_basis, status, recovered_job_id, recovered_amount_cents,
       resolved_at, notes)
    VALUES
      (NEW.user_id, 'warranty_claim_paid', 'warranty_claims', NEW.id,
       coalesce(nullif(btrim(NEW.customer_name), ''), 'Unknown customer'), now(),
       coalesce(NEW.estimated_recovery_cents, NEW.claimed_amount_cents, 0),
       CASE WHEN coalesce(NEW.estimated_recovery_cents, NEW.claimed_amount_cents) IS NULL THEN 'none' ELSE 'manual' END,
       'recovered', NEW.job_id, NEW.credit_received_cents, now(),
       'Manufacturer warranty reimbursement' || coalesce(' (' || nullif(btrim(NEW.manufacturer), '') || ')', ''))
    ON CONFLICT (source_table, source_id) DO UPDATE
      SET recovered_amount_cents = EXCLUDED.recovered_amount_cents,
          status = 'recovered',
          resolved_at = EXCLUDED.resolved_at,
          updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wcc_after_write ON public.warranty_claims;
CREATE TRIGGER trg_wcc_after_write
  AFTER INSERT OR UPDATE ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.wcc_after_write();

-- 5. Recovery ledger: allow the new source -----------------------------------------------------
ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;
ALTER TABLE public.revenue_recovery_events
  ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job',
    'quote_financing_stalled', 'quote_accepted_unbooked',
    'job_completed_unbilled', 'invoice_overdue',
    'membership_cancelled', 'membership_churned',
    'job_parts_unbilled', 'payment_failed',
    'warranty_claim_paid'));

ALTER TABLE public.revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_table_check;
ALTER TABLE public.revenue_recovery_events
  ADD CONSTRAINT revenue_recovery_events_source_table_check
  CHECK (source_table IN ('calls', 'quotes', 'jobs', 'payment_requests', 'memberships', 'warranty_claims'));

-- 6. Reconciliation view ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.warranty_claim_reconciliation
WITH (security_invoker = true) AS
SELECT
  c.id AS claim_id, c.user_id, c.job_id, c.customer_name, c.manufacturer,
  public.wcc_norm_status(c.status) AS status,
  c.estimated_recovery_cents, c.claimed_amount_cents, c.approved_amount_cents, c.credit_received_cents,
  c.submitted_at, c.credit_received_at, c.ar_invoice_id,
  CASE WHEN c.credit_received_cents IS NOT NULL AND c.estimated_recovery_cents IS NOT NULL
       THEN c.credit_received_cents - c.estimated_recovery_cents END AS variance_vs_estimate_cents,
  CASE WHEN c.credit_received_cents IS NOT NULL AND c.approved_amount_cents IS NOT NULL
       THEN c.credit_received_cents - c.approved_amount_cents END AS variance_vs_approved_cents,
  (c.credit_received_cents IS NOT NULL AND c.approved_amount_cents IS NOT NULL
     AND c.credit_received_cents < c.approved_amount_cents) AS short_paid,
  CASE WHEN c.submitted_at IS NOT NULL AND public.wcc_norm_status(c.status) IN ('submitted', 'approved')
       THEN (current_date - c.submitted_at::date) END AS days_unpaid,
  CASE WHEN c.submitted_at IS NOT NULL AND c.credit_received_at IS NOT NULL
       THEN (c.credit_received_at - c.submitted_at::date) END AS days_to_pay
FROM public.warranty_claims c
WHERE c.claim_type = 'manufacturer';
GRANT SELECT ON public.warranty_claim_reconciliation TO authenticated;

-- 7. Claim packet (facts from the database only) ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wcc_packet(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.warranty_claims%ROWTYPE;
  v_parts jsonb;
  v_hours numeric;
  v_photo_count integer;
  v_photos jsonb;
  v_invoice text;
  v_reg jsonb;
  v_blocking text[] := '{}';
  v_missing text[] := '{}';
  k text;
BEGIN
  SELECT * INTO c FROM warranty_claims WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'manufacturer';
  IF NOT FOUND THEN RAISE EXCEPTION 'claim_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'part_number', ip.part_number, 'name', ip.name, 'quantity', jpr.quantity_required,
           'unit_cost_cents', ip.unit_cost_cents) ORDER BY ip.name), '[]'::jsonb)
    INTO v_parts
  FROM job_parts_required jpr
  JOIN inventory_parts ip ON ip.id = jpr.part_id AND ip.user_id = c.user_id
  WHERE jpr.job_id = c.job_id AND jpr.user_id = c.user_id AND jpr.status = 'installed';

  v_hours := coalesce(c.labor_hours, (
    SELECT nullif(sum(t.regular_hours + t.overtime_hours), 0)
    FROM timesheets t WHERE t.job_id = c.job_id AND t.user_id = c.user_id AND t.status = 'approved'));

  SELECT count(*) INTO v_photo_count FROM job_photos WHERE job_id = c.job_id AND user_id = c.user_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'storage_path', p.storage_path, 'caption', p.caption)), '[]'::jsonb)
    INTO v_photos
  FROM (SELECT id, kind, storage_path, caption FROM job_photos
        WHERE job_id = c.job_id AND user_id = c.user_id ORDER BY kind, id LIMIT 12) p;

  v_invoice := coalesce(nullif(btrim(coalesce(c.invoice_ref, '')), ''), (
    SELECT i.invoice_number FROM ar_invoices i
    WHERE i.job_id = c.job_id AND i.user_id = c.user_id AND i.id IS DISTINCT FROM c.ar_invoice_id
    ORDER BY i.created_at LIMIT 1));

  SELECT jsonb_build_object('confirmation_code', r.confirmation_code, 'purchase_date', r.purchase_date, 'install_date', r.install_date)
    INTO v_reg FROM warranty_registrations r WHERE r.id = c.registration_id;

  IF nullif(btrim(coalesce(c.manufacturer, '')), '') IS NULL THEN v_blocking := v_blocking || 'manufacturer'; END IF;
  IF nullif(btrim(coalesce(c.model_number, '')), '') IS NULL THEN v_blocking := v_blocking || 'model_number'; END IF;
  IF nullif(btrim(coalesce(c.serial_number, '')), '') IS NULL THEN v_blocking := v_blocking || 'serial_number'; END IF;
  IF nullif(btrim(coalesce(c.failure_description, '')), '') IS NULL THEN v_blocking := v_blocking || 'failure_description'; END IF;

  v_missing := v_blocking;
  IF c.install_date IS NULL THEN v_missing := v_missing || 'install_date'; END IF;
  IF jsonb_array_length(v_parts) = 0 AND nullif(btrim(coalesce(c.part_description, '')), '') IS NULL THEN v_missing := v_missing || 'parts'; END IF;
  IF v_hours IS NULL THEN v_missing := v_missing || 'labor_hours'; END IF;
  IF v_photo_count = 0 THEN v_missing := v_missing || 'photos'; END IF;
  IF v_invoice IS NULL THEN v_missing := v_missing || 'invoice_ref'; END IF;
  FOR k IN SELECT key FROM jsonb_each_text(coalesce(c.packet_checklist, '{}'::jsonb)) WHERE value <> 'true' ORDER BY key LOOP
    v_missing := v_missing || ('checklist:' || k);
  END LOOP;

  RETURN jsonb_build_object(
    'claim_id', c.id, 'status', public.wcc_norm_status(c.status),
    'customer_name', c.customer_name, 'property_address', c.property_address,
    'manufacturer', c.manufacturer, 'distributor', c.distributor,
    'model_number', c.model_number, 'serial_number', c.serial_number, 'install_date', c.install_date,
    'warranty_expires_at', c.warranty_expires_at, 'claim_deadline', c.claim_deadline,
    'failure_description', c.failure_description, 'part_description', c.part_description,
    'parts', v_parts, 'labor_hours', v_hours,
    'photo_count', v_photo_count, 'photos', v_photos,
    'invoice_ref', v_invoice, 'registration', v_reg,
    'estimated_recovery_cents', c.estimated_recovery_cents, 'estimate_basis', c.estimate_basis,
    'checklist', c.packet_checklist,
    'missing', to_jsonb(v_missing), 'blocking', to_jsonb(v_blocking),
    'ready_to_submit', coalesce(array_length(v_missing, 1), 0) = 0);
END;
$$;

-- 8. Detector (cron; service_role only) ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wcc_detect_claims(p_owner uuid DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_reg record;
  v_terms public.oem_warranty_terms%ROWTYPE;
  v_mfr uuid;
  v_model uuid;
  v_start date;
  v_end date;
  v_end_src text;
  v_months integer;
  v_parts bigint;
  v_parts_n integer;
  v_hours numeric;
  v_labor bigint;
  v_est bigint;
  v_deadline date;
  v_make_norm text;
  v_n integer;
  v_created integer := 0;
  v_scanned integer := 0;
  v_no_serial integer := 0;
  v_no_terms integer := 0;
  v_expired integer := 0;
  v_pre_install integer := 0;
  v_errors integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wcc_detect_claims'));
  p_limit := least(greatest(coalesce(p_limit, 500), 1), 5000);

  FOR r IN
    SELECT j.id AS job_id, j.user_id, j.customer_name, j.address, j.completed_at,
           e.id AS equipment_id, e.make, e.model, e.serial_number, e.install_date, e.warranty_expires_at, e.equipment_type
    FROM job_equipment je
    JOIN jobs j ON j.id = je.job_id
    JOIN equipment e ON e.id = je.equipment_id AND e.user_id = j.user_id
    WHERE j.job_status = 'completed' AND j.completed_at IS NOT NULL
      AND (p_owner IS NULL OR j.user_id = p_owner)
      AND NOT EXISTS (SELECT 1 FROM warranty_claims wc
                      WHERE wc.job_id = j.id AND wc.equipment_id = e.id AND wc.claim_type = 'manufacturer')
    ORDER BY j.completed_at DESC, j.id, e.id
    LIMIT p_limit
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      IF public.vp_serial_key(r.make, r.serial_number) IS NULL THEN v_no_serial := v_no_serial + 1; CONTINUE; END IF;

      -- Owner registration, only if THIS tenant has a verified link to the passport (no cross-tenant reads).
      SELECT reg.purchase_date, reg.install_date, reg.created_at INTO v_reg
      FROM warranty_registrations reg
      JOIN equipment_passport_links l ON l.passport_id = reg.passport_id AND l.status = 'active' AND l.verified AND l.user_id = r.user_id
      WHERE reg.serial_key = public.vp_serial_key(r.make, r.serial_number)
      ORDER BY reg.created_at DESC LIMIT 1;

      v_start := coalesce(r.install_date, v_reg.install_date, v_reg.purchase_date);

      v_make_norm := regexp_replace(lower(coalesce(r.make, '')), '[^a-z0-9]', '', 'g');
      v_mfr := NULL; v_model := NULL;
      IF v_make_norm <> '' THEN
        SELECT m.id INTO v_mfr FROM oem_manufacturers m
        WHERE regexp_replace(lower(m.name), '[^a-z0-9]', '', 'g') = v_make_norm OR lower(m.slug) = v_make_norm
        ORDER BY m.name LIMIT 1;
      END IF;
      IF v_mfr IS NOT NULL THEN
        SELECT mo.id INTO v_model FROM oem_equipment_models mo
        WHERE mo.manufacturer_id = v_mfr AND lower(mo.model_number) = lower(coalesce(r.model, '')) LIMIT 1;
      END IF;

      v_terms := NULL::public.oem_warranty_terms;
      IF v_mfr IS NOT NULL THEN
        SELECT t.* INTO v_terms FROM oem_warranty_terms t
        WHERE t.manufacturer_id = v_mfr AND t.component = 'parts'
          AND (t.model_id IS NULL OR t.model_id = v_model)
          AND (t.equipment_type IS NULL OR lower(t.equipment_type) = lower(coalesce(r.equipment_type, '')))
        ORDER BY (t.model_id IS NOT NULL) DESC, (t.equipment_type IS NOT NULL) DESC LIMIT 1;
      END IF;

      v_end := NULL; v_end_src := NULL;
      IF r.warranty_expires_at IS NOT NULL THEN
        v_end := r.warranty_expires_at; v_end_src := 'equipment';
      ELSIF v_terms.id IS NOT NULL AND v_start IS NOT NULL THEN
        v_months := v_terms.months;
        IF v_reg.created_at IS NOT NULL AND v_terms.registered_months IS NOT NULL
           AND v_terms.registration_window_days IS NOT NULL
           AND v_reg.created_at::date <= v_start + v_terms.registration_window_days THEN
          v_months := v_terms.registered_months;
        END IF;
        v_end := (v_start + make_interval(months => v_months))::date;
        v_end_src := 'oem_terms';
      END IF;

      IF v_end IS NULL THEN v_no_terms := v_no_terms + 1; CONTINUE; END IF;
      IF r.completed_at::date > v_end THEN v_expired := v_expired + 1; CONTINUE; END IF;
      IF v_start IS NOT NULL AND r.completed_at::date < v_start THEN v_pre_install := v_pre_install + 1; CONTINUE; END IF;

      SELECT sum(jpr.quantity_required::bigint * ip.unit_cost_cents), count(*) INTO v_parts, v_parts_n
      FROM job_parts_required jpr
      JOIN inventory_parts ip ON ip.id = jpr.part_id AND ip.user_id = r.user_id
      WHERE jpr.job_id = r.job_id AND jpr.user_id = r.user_id AND jpr.status = 'installed';
      IF v_parts_n = 0 THEN v_parts := NULL; END IF;

      SELECT nullif(sum(t.regular_hours + t.overtime_hours), 0) INTO v_hours
      FROM timesheets t WHERE t.job_id = r.job_id AND t.user_id = r.user_id AND t.status = 'approved';

      v_labor := NULL;
      IF v_terms.labor_allowance_cents_per_hour IS NOT NULL AND v_hours IS NOT NULL THEN
        v_labor := round(v_hours * v_terms.labor_allowance_cents_per_hour);
      END IF;

      v_est := NULL;
      IF v_parts IS NOT NULL OR v_labor IS NOT NULL THEN v_est := coalesce(v_parts, 0) + coalesce(v_labor, 0); END IF;
      IF v_est > 2147483647 THEN RAISE EXCEPTION 'estimate_out_of_range'; END IF;

      v_deadline := NULL;
      IF v_terms.claim_window_days IS NOT NULL THEN v_deadline := r.completed_at::date + v_terms.claim_window_days; END IF;

      INSERT INTO warranty_claims
        (user_id, job_id, equipment_id, customer_name, property_address, manufacturer, model_number, serial_number,
         install_date, warranty_expires_at, claim_deadline, status, claim_type, source, detected_at,
         part_cost_cents, labor_cost_cents, labor_hours, estimated_recovery_cents, estimate_basis)
      VALUES
        (r.user_id, r.job_id, r.equipment_id, coalesce(nullif(btrim(r.customer_name), ''), ''), r.address, r.make, r.model, r.serial_number,
         v_start, v_end, v_deadline, 'needs_review', 'manufacturer', 'detector', now(),
         v_parts::integer, v_labor::integer, v_hours, v_est::integer,
         jsonb_build_object('warranty_end_source', v_end_src, 'parts_cents', v_parts, 'labor_cents', v_labor,
                            'labor_hours', v_hours, 'labor_rate_cents_per_hour', v_terms.labor_allowance_cents_per_hour,
                            'terms_id', v_terms.id, 'registered', v_reg.created_at IS NOT NULL))
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_created := v_created + v_n;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'wcc_detect_claims skipped job % / equipment %: %', r.job_id, r.equipment_id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'created', v_created, 'skipped_missing_serial', v_no_serial,
    'skipped_unknown_terms', v_no_terms, 'skipped_expired', v_expired, 'skipped_before_install', v_pre_install, 'errors', v_errors);
END;
$$;

-- 9. Accounting handoff ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wcc_create_ar_invoice(p_claim_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.warranty_claims%ROWTYPE;
  v_name text;
  v_cust uuid;
  v_rev uuid;
  v_inv uuid;
BEGIN
  IF NOT public.has_account_permission('can_view_billing') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM warranty_claims WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'manufacturer' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim_not_found' USING ERRCODE = 'P0002'; END IF;
  IF c.ar_invoice_id IS NOT NULL THEN RETURN c.ar_invoice_id; END IF;   -- idempotent
  IF public.wcc_norm_status(c.status) NOT IN ('approved', 'paid') THEN RAISE EXCEPTION 'claim_not_approved' USING ERRCODE = '23514'; END IF;
  IF coalesce(c.approved_amount_cents, 0) <= 0 THEN RAISE EXCEPTION 'no_approved_amount' USING ERRCODE = '23514'; END IF;

  v_name := left(coalesce(nullif(btrim(c.manufacturer), ''), 'Manufacturer') || ' (warranty billing)', 120);
  SELECT id INTO v_cust FROM customers
  WHERE user_id = v_owner AND 'warranty-manufacturer' = ANY(tags) AND lower(name) = lower(v_name) LIMIT 1;
  IF v_cust IS NULL THEN
    INSERT INTO customers (user_id, name, customer_type, lifecycle_stage, tags, source, notes)
    VALUES (v_owner, v_name, 'commercial', 'active', ARRAY['warranty-manufacturer'], 'manual',
            'Created for manufacturer warranty reimbursement invoices')
    RETURNING id INTO v_cust;
  END IF;

  PERFORM public.ensure_default_chart_of_accounts();
  SELECT id INTO v_rev FROM chart_of_accounts WHERE user_id = v_owner AND code = '4900';

  v_inv := public.qbo_create_ar_invoice(
    v_owner, v_cust, current_date, current_date + 30, 0,
    jsonb_build_array(jsonb_build_object(
      'description', 'Manufacturer warranty reimbursement - claim ' || coalesce(nullif(btrim(c.claim_number), ''), c.id::text)
                     || ' (' || coalesce(nullif(btrim(c.serial_number), ''), 'no serial') || ')',
      'quantity', 1, 'unit_price_cents', c.approved_amount_cents, 'amount_cents', c.approved_amount_cents,
      'revenue_account_id', v_rev)));

  UPDATE ar_invoices SET job_id = c.job_id WHERE id = v_inv AND user_id = v_owner;   -- only the invoice we just created
  UPDATE warranty_claims SET ar_invoice_id = v_inv WHERE id = c.id;
  RETURN v_inv;
END;
$$;

CREATE OR REPLACE FUNCTION public.wcc_apply_payment(p_claim_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c public.warranty_claims%ROWTYPE;
  v_balance integer;
  v_amount integer;
  v_pay uuid;
BEGIN
  IF NOT public.has_account_permission('can_view_billing') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM warranty_claims WHERE id = p_claim_id AND user_id = v_owner AND claim_type = 'manufacturer' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim_not_found' USING ERRCODE = 'P0002'; END IF;
  IF c.ar_payment_id IS NOT NULL THEN RETURN c.ar_payment_id; END IF;   -- idempotent
  IF public.wcc_norm_status(c.status) <> 'paid' THEN RAISE EXCEPTION 'claim_not_paid' USING ERRCODE = '23514'; END IF;
  IF c.ar_invoice_id IS NULL THEN RAISE EXCEPTION 'no_invoice' USING ERRCODE = '23514'; END IF;

  SELECT total_cents - amount_paid_cents INTO v_balance FROM ar_invoices
  WHERE id = c.ar_invoice_id AND user_id = v_owner FOR UPDATE;
  v_amount := least(coalesce(c.credit_received_cents, 0), coalesce(v_balance, 0));
  IF v_amount <= 0 THEN RAISE EXCEPTION 'nothing_to_apply' USING ERRCODE = '23514'; END IF;

  v_pay := public.record_ar_payment(c.ar_invoice_id, v_amount,
             CASE c.credit_method WHEN 'check' THEN 'check' WHEN 'ach' THEN 'ach' ELSE 'other' END, NULL, NULL);
  UPDATE warranty_claims SET ar_payment_id = v_pay WHERE id = c.id;
  RETURN v_pay;
END;
$$;

-- 10. Grants ------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.wcc_detect_claims(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wcc_detect_claims(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.wcc_packet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wcc_packet(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.wcc_create_ar_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wcc_create_ar_invoice(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.wcc_apply_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wcc_apply_payment(uuid) TO authenticated;
