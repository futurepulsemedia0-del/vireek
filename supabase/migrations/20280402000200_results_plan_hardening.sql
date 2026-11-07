/*
  # Results Plan — Phase 3: hardening (run AFTER the two earlier Results Plan migrations)

  - proof_ledger: new event 'rejected' (a job that failed qualification for a deterministic reason is never re-evaluated;
    otherwise a prior job closing later could flip an "existing work" booking into a billable one)
  - results_plan_flags: new code 'fair_use_minutes'
  - terms: fair_use_minutes, guarantee_minutes_cap, confirmed_fallback_days (approved terms stay immutable, new columns included)
  - accounts: confirmed_fallback_days (copied from the terms at enrollment)
  - charges: billed_at_level, via_fallback (disputes judge a charge against the level it was ACTUALLY billed at)
  - rp_staff_approve_terms: refuses terms without a monthly cap, guarantee cap (when a guarantee exists) or fair-use minutes

  ## Rollback (before data exists)
    ALTER TABLE results_plan_charges DROP COLUMN IF EXISTS billed_at_level, DROP COLUMN IF EXISTS via_fallback;
    ALTER TABLE results_plan_accounts DROP COLUMN IF EXISTS confirmed_fallback_days;
    ALTER TABLE results_plan_pricing_terms DROP COLUMN IF EXISTS fair_use_minutes, DROP COLUMN IF EXISTS guarantee_minutes_cap, DROP COLUMN IF EXISTS confirmed_fallback_days;
*/

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'public.proof_ledger'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%event_type%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.proof_ledger DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE public.proof_ledger ADD CONSTRAINT proof_ledger_event_type_check CHECK (event_type IN (
    'qualified', 'confirmed', 'completed', 'paid', 'voided', 'charge_posted', 'credited', 'disputed', 'dispute_resolved', 'rejected'));

  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'public.results_plan_flags'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%completion_marking_drop%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.results_plan_flags DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE public.results_plan_flags ADD CONSTRAINT results_plan_flags_code_check CHECK (code IN (
    'completion_marking_drop', 'relabel_after_charge', 'qualification_spike', 'fair_use_minutes'));
END $$;

ALTER TABLE results_plan_pricing_terms
  ADD COLUMN IF NOT EXISTS fair_use_minutes integer CHECK (fair_use_minutes IS NULL OR fair_use_minutes BETWEEN 1 AND 1000000),
  ADD COLUMN IF NOT EXISTS guarantee_minutes_cap integer CHECK (guarantee_minutes_cap IS NULL OR guarantee_minutes_cap BETWEEN 1 AND 1000000),
  ADD COLUMN IF NOT EXISTS confirmed_fallback_days integer CHECK (confirmed_fallback_days IS NULL OR confirmed_fallback_days BETWEEN 1 AND 90);

ALTER TABLE results_plan_accounts
  ADD COLUMN IF NOT EXISTS confirmed_fallback_days integer CHECK (confirmed_fallback_days IS NULL OR confirmed_fallback_days BETWEEN 1 AND 90);

ALTER TABLE results_plan_charges
  ADD COLUMN IF NOT EXISTS billed_at_level text CHECK (billed_at_level IS NULL OR billed_at_level IN ('booked', 'confirmed', 'completed', 'paid')),
  ADD COLUMN IF NOT EXISTS via_fallback boolean NOT NULL DEFAULT false;

-- Approved terms stay immutable, now including the new columns.
CREATE OR REPLACE FUNCTION public.rp_terms_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'approved' THEN RAISE EXCEPTION 'approved terms cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NOT (NEW.status = 'retired' AND
      ROW(NEW.name, NEW.model, NEW.currency, NEW.base_fee_cents, NEW.per_job_cents, NEW.tier_price_cents, NEW.monthly_floor_cents, NEW.monthly_cap_cents,
          NEW.guarantee_days, NEW.guarantee_cap_cents, NEW.trial_days, NEW.rule_version, NEW.is_public, NEW.fair_use_minutes, NEW.guarantee_minutes_cap, NEW.confirmed_fallback_days)
      IS NOT DISTINCT FROM
      ROW(OLD.name, OLD.model, OLD.currency, OLD.base_fee_cents, OLD.per_job_cents, OLD.tier_price_cents, OLD.monthly_floor_cents, OLD.monthly_cap_cents,
          OLD.guarantee_days, OLD.guarantee_cap_cents, OLD.trial_days, OLD.rule_version, OLD.is_public, OLD.fair_use_minutes, OLD.guarantee_minutes_cap, OLD.confirmed_fallback_days)) THEN
    RAISE EXCEPTION 'approved terms are immutable (retire them and create a new row)';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- Approval gate: no approval without a hard cap, a guarantee cap and a fair-use allowance.
CREATE OR REPLACE FUNCTION public.rp_staff_approve_terms(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t results_plan_pricing_terms%ROWTYPE;
BEGIN
  PERFORM public.rp_staff_guard();
  SELECT * INTO t FROM results_plan_pricing_terms WHERE id = p_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_A_DRAFT'; END IF;
  IF t.monthly_cap_cents IS NULL THEN RAISE EXCEPTION 'CAP_REQUIRED'; END IF;
  IF t.guarantee_days > 0 AND (t.guarantee_cap_cents IS NULL OR t.guarantee_minutes_cap IS NULL) THEN RAISE EXCEPTION 'GUARANTEE_CAPS_REQUIRED'; END IF;
  IF t.fair_use_minutes IS NULL THEN RAISE EXCEPTION 'FAIR_USE_REQUIRED'; END IF;
  UPDATE results_plan_pricing_terms SET status = 'approved', approved_at = now(), approved_by = auth.uid() WHERE id = p_id;
END $$;

-- Disputes judge a charge against the level it was actually billed at (the confirmed fallback bills at 'confirmed').
CREATE OR REPLACE FUNCTION public.rp_open_dispute(p_charge uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  c results_plan_charges%ROWTYPE; a results_plan_accounts%ROWTYPE; j jobs%ROWTYPE;
  v_owner uuid := public.get_account_owner_id();
  v_dispute uuid; v_has_call boolean; v_q jsonb; v_reasons text[]; v_completion boolean; v_confirmation boolean;
  v_reason text := btrim(COALESCE(p_reason, '')); v_auto boolean := false; v_why text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN RAISE EXCEPTION 'REASON_LENGTH'; END IF;
  SELECT * INTO c FROM results_plan_charges WHERE id = p_charge AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF c.status NOT IN ('pending', 'posted') THEN RAISE EXCEPTION 'CHARGE_NOT_DISPUTABLE'; END IF;
  IF now() - COALESCE(c.posted_at, c.created_at) > interval '14 days' THEN RAISE EXCEPTION 'DISPUTE_WINDOW_CLOSED'; END IF;
  IF EXISTS (SELECT 1 FROM results_plan_disputes WHERE charge_id = c.id) THEN RAISE EXCEPTION 'ALREADY_DISPUTED'; END IF;
  SELECT * INTO a FROM results_plan_accounts WHERE user_id = v_owner;

  INSERT INTO results_plan_disputes (user_id, charge_id, reason) VALUES (v_owner, c.id, v_reason) RETURNING id INTO v_dispute;
  PERFORM public.proof_ledger_append(v_owner, c.job_id, 'disputed', 'dispute-open:' || v_dispute::text, a.rule_version,
    jsonb_build_object('dispute_id', v_dispute, 'charge_id', c.id));

  SELECT * INTO j FROM jobs WHERE id = c.job_id AND user_id = v_owner;
  v_has_call := FOUND AND j.call_id IS NOT NULL AND EXISTS (SELECT 1 FROM calls WHERE id = j.call_id AND user_id = v_owner);
  SELECT evidence INTO v_q FROM proof_ledger WHERE user_id = v_owner AND job_id = c.job_id AND event_type = 'qualified' ORDER BY seq DESC LIMIT 1;
  v_reasons := COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_q -> 'reasons', '[]'::jsonb))), '{}');
  v_completion := EXISTS (SELECT 1 FROM proof_ledger WHERE user_id = v_owner AND job_id = c.job_id AND event_type = 'completed');
  v_confirmation := EXISTS (SELECT 1 FROM proof_ledger WHERE user_id = v_owner AND job_id = c.job_id AND event_type IN ('confirmed', 'completed'));

  IF NOT v_has_call THEN v_auto := true; v_why := 'No call/text/chat record supports first contact by Sarah.';
  ELSIF j.id IS NULL THEN v_auto := true; v_why := 'No booking record exists for this job.';
  ELSIF v_q IS NULL OR cardinality(v_reasons) > 0 THEN v_auto := true; v_why := 'Rule check failed or was never recorded.';
  ELSIF COALESCE(c.billed_at_level, a.billing_level) IN ('completed', 'paid') AND NOT v_completion THEN v_auto := true; v_why := 'Billing level requires completion and no completion event exists.';
  ELSIF COALESCE(c.billed_at_level, a.billing_level) = 'confirmed' AND NOT v_confirmation THEN v_auto := true; v_why := 'Billing level requires confirmation and none exists.';
  END IF;

  IF v_auto THEN
    UPDATE results_plan_disputes SET status = 'auto_credited', decision_note = v_why, resolved_at = now() WHERE id = v_dispute;
    UPDATE results_plan_charges SET status = CASE WHEN c.status = 'posted' THEN 'credited' ELSE 'voided' END, updated_at = now() WHERE id = c.id;
    PERFORM public.proof_ledger_append(v_owner, c.job_id, 'credited', 'credit:' || c.id::text, a.rule_version,
      jsonb_build_object('charge_id', c.id, 'amount_cents', c.amount_cents, 'auto', true, 'why', v_why));
    PERFORM public.proof_ledger_append(v_owner, c.job_id, 'dispute_resolved', 'dispute-resolved:' || v_dispute::text, a.rule_version,
      jsonb_build_object('dispute_id', v_dispute, 'outcome', 'auto_credited', 'why', v_why));
    RETURN jsonb_build_object('dispute_id', v_dispute, 'outcome', 'auto_credited', 'why', v_why);
  END IF;
  RETURN jsonb_build_object('dispute_id', v_dispute, 'outcome', 'in_review');
END $$;
REVOKE ALL ON FUNCTION public.rp_open_dispute(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rp_open_dispute(uuid, text) TO authenticated;
