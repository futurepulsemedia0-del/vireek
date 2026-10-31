/*
  # Pilot outcome measurement (extends money_recovered_* and warranty_claims)

  Tables
  - pilot_outcome_baselines   ONE immutable snapshot per tenant, captured at pilot start. Every number is
                              computed by the DB inside pilot_capture_baseline(); only admin hours is manual.
  - warranty_claim_actions    append-only log of actions on a claim (status change, packet exported,
                              reminder sent, credit recorded). Status/credit/reminder rows are written by a
                              trigger on warranty_claims, so a client cannot forge them.
  - pilot_attributions        append-only: each attributed recovered amount -> claim_id / invoice_id + the
                              preceding action. Written by the money-recovered-run edge function (service role).
                              No row here = the money is NOT counted.
  - pilot_outcome_settings    current manual admin hours, display-only fee (basis points), weekly-email
                              enable + the template version a human approved.
  - pilot_email_deliveries    per-recipient send log (prevents duplicate weekly emails).

  Not included: QuickBooks reconciliation findings. No such table exists in this repository snapshot, so the
  baseline stores NULL for those two columns (shown as "not available", never as 0).

  Requires: warranty_claims (20261121000000), job_equipment/equipment/jobs, invoices (20261205000000),
  revenue_recovery_events (20260922000000), reports_can_access (20270415000000), is_vireek_staff.
*/

-- =============================================================
-- 1. Shared append-only guard
-- =============================================================
CREATE OR REPLACE FUNCTION public.pilot_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Allow only the cascade that fires when the whole account is deleted.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- =============================================================
-- 2. Immutable baseline
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pilot_outcome_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  eligible_jobs_count integer NOT NULL CHECK (eligible_jobs_count >= 0),
  claims_filed_count integer NOT NULL CHECK (claims_filed_count >= 0),
  claims_paid_count integer NOT NULL CHECK (claims_paid_count >= 0),
  claims_paid_cents bigint NOT NULL CHECK (claims_paid_cents >= 0),
  unfiled_eligible_estimate_cents bigint NOT NULL CHECK (unfiled_eligible_estimate_cents >= 0),
  qb_findings_count integer CHECK (qb_findings_count IS NULL OR qb_findings_count >= 0),
  qb_findings_cents bigint CHECK (qb_findings_cents IS NULL OR qb_findings_cents >= 0),
  admin_hours_per_week numeric(6, 2) NOT NULL CHECK (admin_hours_per_week >= 0 AND admin_hours_per_week <= 168),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  CONSTRAINT pilot_baseline_window_ordered CHECK (window_end > window_start)
);

DROP TRIGGER IF EXISTS trg_pilot_baseline_append_only ON public.pilot_outcome_baselines;
CREATE TRIGGER trg_pilot_baseline_append_only
  BEFORE UPDATE OR DELETE ON public.pilot_outcome_baselines
  FOR EACH ROW EXECUTE FUNCTION public.pilot_append_only();

-- =============================================================
-- 3. Claim action log (append-only, trigger-fed)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.warranty_claim_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL, -- deliberately no FK: history outlives a deleted claim
  action_type text NOT NULL CHECK (action_type IN ('status_change', 'packet_exported', 'reminder_sent', 'credit_recorded')),
  from_status text,
  to_status text,
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor uuid DEFAULT auth.uid()
);

CREATE INDEX IF NOT EXISTS idx_warranty_claim_actions_claim ON public.warranty_claim_actions(claim_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_warranty_claim_actions_user ON public.warranty_claim_actions(user_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_warranty_claim_actions_append_only ON public.warranty_claim_actions;
CREATE TRIGGER trg_warranty_claim_actions_append_only
  BEFORE UPDATE OR DELETE ON public.warranty_claim_actions
  FOR EACH ROW EXECUTE FUNCTION public.pilot_append_only();

CREATE OR REPLACE FUNCTION public.log_warranty_claim_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO public.warranty_claim_actions (user_id, claim_id, action_type, from_status, to_status)
      VALUES (NEW.user_id, NEW.id, 'status_change', OLD.status, NEW.status);
    END IF;
    IF COALESCE(NEW.credit_received_cents, 0) > 0 AND COALESCE(OLD.credit_received_cents, 0) <= 0 THEN
      INSERT INTO public.warranty_claim_actions (user_id, claim_id, action_type, amount_cents)
      VALUES (NEW.user_id, NEW.id, 'credit_recorded', NEW.credit_received_cents);
    END IF;
    IF NEW.deadline_alert_sent_at IS NOT NULL
       AND NEW.deadline_alert_sent_at IS DISTINCT FROM OLD.deadline_alert_sent_at THEN
      INSERT INTO public.warranty_claim_actions (user_id, claim_id, action_type)
      VALUES (NEW.user_id, NEW.id, 'reminder_sent');
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.credit_received_cents, 0) > 0 THEN
      INSERT INTO public.warranty_claim_actions (user_id, claim_id, action_type, amount_cents)
      VALUES (NEW.user_id, NEW.id, 'credit_recorded', NEW.credit_received_cents);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warranty_claims_log_action ON public.warranty_claims;
CREATE TRIGGER trg_warranty_claims_log_action
  AFTER INSERT OR UPDATE ON public.warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.log_warranty_claim_action();

-- Called by the UI when the claim packet PDF is exported.
CREATE OR REPLACE FUNCTION public.log_claim_packet_export(p_claim uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.warranty_claims WHERE id = p_claim AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Claim not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.warranty_claim_actions (user_id, claim_id, action_type)
  VALUES (v_owner, p_claim, 'packet_exported');
END;
$$;

REVOKE ALL ON FUNCTION public.log_claim_packet_export(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_claim_packet_export(uuid) TO authenticated;

-- =============================================================
-- 4. Attributions (append-only, service-role writes)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pilot_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('warranty_claim', 'recovery_event')),
  source_id uuid NOT NULL,
  claim_id uuid,
  invoice_id uuid,
  job_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  action_type text NOT NULL CHECK (action_type IN ('packet_exported', 'status_change', 'reminder_sent', 'follow_up')),
  action_id uuid,
  action_at timestamptz NOT NULL,
  recovered_at timestamptz NOT NULL,
  method_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id),
  CONSTRAINT pilot_attr_needs_link CHECK (claim_id IS NOT NULL OR invoice_id IS NOT NULL),
  CONSTRAINT pilot_attr_action_first CHECK (action_at <= recovered_at)
);

CREATE INDEX IF NOT EXISTS idx_pilot_attributions_user ON public.pilot_attributions(user_id, recovered_at DESC);

DROP TRIGGER IF EXISTS trg_pilot_attributions_append_only ON public.pilot_attributions;
CREATE TRIGGER trg_pilot_attributions_append_only
  BEFORE UPDATE OR DELETE ON public.pilot_attributions
  FOR EACH ROW EXECUTE FUNCTION public.pilot_append_only();

-- =============================================================
-- 5. Settings + email deliveries
-- =============================================================
CREATE TABLE IF NOT EXISTS public.pilot_outcome_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_admin_hours_per_week numeric(6, 2)
    CHECK (current_admin_hours_per_week IS NULL OR (current_admin_hours_per_week >= 0 AND current_admin_hours_per_week <= 168)),
  fee_bps integer NOT NULL DEFAULT 0 CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  email_enabled boolean NOT NULL DEFAULT false,
  email_template_approved_version text CHECK (email_template_approved_version IS NULL OR char_length(email_template_approved_version) <= 40),
  email_template_approved_by uuid,
  email_template_approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_email_needs_approval CHECK (NOT email_enabled OR email_template_approved_version IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.pilot_email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  email text NOT NULL,
  template_version text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  attempts smallint NOT NULL DEFAULT 1,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start, email)
);

-- =============================================================
-- 6. RLS (reads: owner / billing access; writes: service role or RPC only)
-- =============================================================
ALTER TABLE public.pilot_outcome_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warranty_claim_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_outcome_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_email_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pob_select" ON public.pilot_outcome_baselines;
CREATE POLICY "pob_select" ON public.pilot_outcome_baselines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "wca_select" ON public.warranty_claim_actions;
CREATE POLICY "wca_select" ON public.warranty_claim_actions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "pa_select" ON public.pilot_attributions;
CREATE POLICY "pa_select" ON public.pilot_attributions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "pos_select" ON public.pilot_outcome_settings;
CREATE POLICY "pos_select" ON public.pilot_outcome_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "ped_select" ON public.pilot_email_deliveries;
CREATE POLICY "ped_select" ON public.pilot_email_deliveries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.pilot_outcome_baselines, public.warranty_claim_actions, public.pilot_attributions,
  public.pilot_outcome_settings, public.pilot_email_deliveries
FROM authenticated, anon;

-- =============================================================
-- 7. RPCs
-- =============================================================

-- Captures the baseline ONCE. All figures are computed here from the database; only admin hours is typed in.
-- Window = the 6 months before now. "Estimate" columns are labelled as such in the UI.
CREATE OR REPLACE FUNCTION public.pilot_capture_baseline(p_admin_hours numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_end timestamptz := now();
  v_start timestamptz := now() - interval '6 months';
  v_eligible integer;
  v_unfiled bigint;
  v_filed integer;
  v_paid_n integer;
  v_paid_c bigint;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can capture the pilot baseline' USING ERRCODE = '42501';
  END IF;
  IF p_admin_hours IS NULL OR p_admin_hours < 0 OR p_admin_hours > 168 THEN
    RAISE EXCEPTION 'Admin hours per week must be between 0 and 168' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_eligible
  FROM (
    SELECT DISTINCT j.id AS job_id, e.id AS equipment_id
    FROM public.job_equipment je
    JOIN public.jobs j ON j.id = je.job_id
    JOIN public.equipment e ON e.id = je.equipment_id
    WHERE j.user_id = v_owner
      AND j.job_status = 'completed'
      AND j.completed_at IS NOT NULL
      AND j.completed_at >= v_start AND j.completed_at < v_end
      AND e.warranty_expires_at IS NOT NULL
      AND j.completed_at::date <= e.warranty_expires_at
  ) s;

  -- Estimate: invoice value of completed, warranty-covered jobs with no claim yet (each job counted once).
  SELECT COALESCE(SUM(s.amt_cents), 0)::bigint INTO v_unfiled
  FROM (
    SELECT DISTINCT ON (j.id) j.id, GREATEST(0, round(COALESCE(j.invoice_amount, 0) * 100)) AS amt_cents
    FROM public.job_equipment je
    JOIN public.jobs j ON j.id = je.job_id
    JOIN public.equipment e ON e.id = je.equipment_id
    WHERE j.user_id = v_owner
      AND j.job_status = 'completed'
      AND j.completed_at IS NOT NULL
      AND j.completed_at >= v_start AND j.completed_at < v_end
      AND e.warranty_expires_at IS NOT NULL
      AND j.completed_at::date <= e.warranty_expires_at
      AND NOT EXISTS (
        SELECT 1 FROM public.warranty_claims wc WHERE wc.job_id = j.id AND wc.equipment_id = e.id
      )
    ORDER BY j.id
  ) s;

  SELECT count(*)::integer INTO v_filed
  FROM public.warranty_claims wc
  WHERE wc.user_id = v_owner
    AND wc.status IN ('submitted', 'approved', 'denied', 'credit_received', 'closed')
    AND COALESCE(wc.submitted_at, wc.created_at) >= v_start
    AND COALESCE(wc.submitted_at, wc.created_at) < v_end;

  SELECT count(*)::integer, COALESCE(SUM(wc.credit_received_cents), 0)::bigint INTO v_paid_n, v_paid_c
  FROM public.warranty_claims wc
  WHERE wc.user_id = v_owner
    AND COALESCE(wc.credit_received_cents, 0) > 0
    AND COALESCE(wc.credit_received_at::timestamptz, wc.created_at) >= v_start
    AND COALESCE(wc.credit_received_at::timestamptz, wc.created_at) < v_end;

  INSERT INTO public.pilot_outcome_baselines (
    user_id, captured_at, window_start, window_end, eligible_jobs_count, claims_filed_count,
    claims_paid_count, claims_paid_cents, unfiled_eligible_estimate_cents, admin_hours_per_week, created_by
  ) VALUES (
    v_owner, v_end, v_start, v_end, v_eligible, v_filed, v_paid_n, v_paid_c, v_unfiled, round(p_admin_hours, 2), auth.uid()
  )
  ON CONFLICT (user_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'A pilot baseline already exists for this account and cannot be changed' USING ERRCODE = '23505';
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pilot_capture_baseline(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pilot_capture_baseline(numeric) TO authenticated;

-- Owner-only: current admin hours (manual), weekly-email switch, and approval of the email template version.
CREATE OR REPLACE FUNCTION public.pilot_save_settings(
  p_hours numeric,
  p_email_enabled boolean,
  p_approve_template_version text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_version text := NULLIF(btrim(COALESCE(p_approve_template_version, '')), '');
  v_current text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change pilot settings' USING ERRCODE = '42501';
  END IF;
  IF p_hours IS NOT NULL AND (p_hours < 0 OR p_hours > 168) THEN
    RAISE EXCEPTION 'Admin hours per week must be between 0 and 168' USING ERRCODE = '22023';
  END IF;
  IF v_version IS NOT NULL AND char_length(v_version) > 40 THEN
    RAISE EXCEPTION 'Invalid template version' USING ERRCODE = '22023';
  END IF;

  SELECT email_template_approved_version INTO v_current FROM public.pilot_outcome_settings WHERE user_id = v_owner;
  IF COALESCE(p_email_enabled, false) AND COALESCE(v_version, v_current) IS NULL THEN
    RAISE EXCEPTION 'Approve the email template before enabling the weekly email' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.pilot_outcome_settings (
    user_id, current_admin_hours_per_week, email_enabled,
    email_template_approved_version, email_template_approved_by, email_template_approved_at
  ) VALUES (
    v_owner, round(p_hours, 2), COALESCE(p_email_enabled, false),
    v_version, CASE WHEN v_version IS NULL THEN NULL ELSE auth.uid() END,
    CASE WHEN v_version IS NULL THEN NULL ELSE now() END
  )
  ON CONFLICT (user_id) DO UPDATE SET
    current_admin_hours_per_week = EXCLUDED.current_admin_hours_per_week,
    email_enabled = EXCLUDED.email_enabled,
    email_template_approved_version = COALESCE(EXCLUDED.email_template_approved_version, public.pilot_outcome_settings.email_template_approved_version),
    email_template_approved_by = CASE WHEN EXCLUDED.email_template_approved_version IS NULL
      THEN public.pilot_outcome_settings.email_template_approved_by ELSE EXCLUDED.email_template_approved_by END,
    email_template_approved_at = CASE WHEN EXCLUDED.email_template_approved_version IS NULL
      THEN public.pilot_outcome_settings.email_template_approved_at ELSE EXCLUDED.email_template_approved_at END,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.pilot_save_settings(numeric, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pilot_save_settings(numeric, boolean, text) TO authenticated;

-- Staff-only: the display-only fee percentage (basis points). Nothing here ever charges anyone.
CREATE OR REPLACE FUNCTION public.staff_set_pilot_fee(p_tenant uuid, p_bps integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_bps IS NULL OR p_bps < 0 OR p_bps > 10000 THEN
    RAISE EXCEPTION 'Fee must be between 0 and 10000 basis points' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_tenant AND role = 'owner') THEN
    RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.pilot_outcome_settings (user_id, fee_bps) VALUES (p_tenant, p_bps)
  ON CONFLICT (user_id) DO UPDATE SET fee_bps = EXCLUDED.fee_bps, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.staff_set_pilot_fee(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_pilot_fee(uuid, integer) TO authenticated;
