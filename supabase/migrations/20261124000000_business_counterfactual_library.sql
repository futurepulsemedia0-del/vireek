/*
  # Business Counterfactual Library

  ## Why
  To answer "what if we'd done X instead", the system first needs a
  record that decision X actually happened. Nothing in this project
  previously logged technician (re)assignment or schedule changes as
  events — those columns just get overwritten on `jobs`. This migration
  adds two append-only capture tables, filled automatically by triggers,
  plus one column on `quotes` (financing_offered), then a computation
  layer that turns those captured decisions into counterfactual
  estimates using the business's OWN historical data — never a generic
  rule. Confidence starts low and rises as more decisions accumulate;
  that's intentional, not a bug.

  ## Tables
  - job_technician_assignments — every (re)assignment, auto-captured.
  - job_schedule_changes — every reschedule, auto-captured.
  - business_counterfactuals — the generated "what if" analyses.
*/

-- =============================================================
-- Quote payment-plan flag (set at send time, not computed)
-- =============================================================
ALTER TABLE quotes
ADD COLUMN IF NOT EXISTS financing_offered boolean NOT NULL DEFAULT false;

-- =============================================================
-- CAPTURE: technician assignment history (auto, via trigger)
-- =============================================================
CREATE TABLE IF NOT EXISTS job_technician_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  previous_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  service_type text,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jta_job ON job_technician_assignments(job_id);
CREATE INDEX IF NOT EXISTS idx_jta_user_service ON job_technician_assignments(user_id, service_type);

ALTER TABLE job_technician_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_job_technician_assignments" ON job_technician_assignments;
CREATE POLICY "select_own_job_technician_assignments" ON job_technician_assignments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT policy — rows only ever come from the trigger below.

CREATE OR REPLACE FUNCTION public.capture_job_technician_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_technician_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_technician_id IS DISTINCT FROM OLD.assigned_technician_id) THEN
    INSERT INTO job_technician_assignments (user_id, job_id, technician_id, previous_technician_id, service_type)
    VALUES (NEW.user_id, NEW.id, NEW.assigned_technician_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_technician_id ELSE NULL END, NEW.service_type);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_job_technician_assignment ON jobs;
CREATE TRIGGER trg_capture_job_technician_assignment
  AFTER INSERT OR UPDATE OF assigned_technician_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.capture_job_technician_assignment();

-- =============================================================
-- CAPTURE: schedule change history (auto, via trigger)
-- =============================================================
CREATE TABLE IF NOT EXISTS job_schedule_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  previous_scheduled_datetime timestamptz NOT NULL,
  new_scheduled_datetime timestamptz NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jsc_job ON job_schedule_changes(job_id);
CREATE INDEX IF NOT EXISTS idx_jsc_user ON job_schedule_changes(user_id, changed_at DESC);

ALTER TABLE job_schedule_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_job_schedule_changes" ON job_schedule_changes;
CREATE POLICY "select_own_job_schedule_changes" ON job_schedule_changes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.capture_job_schedule_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.scheduled_datetime IS NOT NULL AND NEW.scheduled_datetime IS DISTINCT FROM OLD.scheduled_datetime THEN
    INSERT INTO job_schedule_changes (user_id, job_id, previous_scheduled_datetime, new_scheduled_datetime)
    VALUES (NEW.user_id, NEW.id, OLD.scheduled_datetime, NEW.scheduled_datetime);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_job_schedule_change ON jobs;
CREATE TRIGGER trg_capture_job_schedule_change
  AFTER UPDATE OF scheduled_datetime ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.capture_job_schedule_change();

-- =============================================================
-- THE LIBRARY: computed "what if" analyses
-- =============================================================
CREATE TABLE IF NOT EXISTS business_counterfactuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  decision_type text NOT NULL CHECK (decision_type IN ('technician_dispatch', 'quote_financing', 'job_reschedule')),
  source_id uuid NOT NULL,
  question text NOT NULL,
  actual_outcome jsonb NOT NULL DEFAULT '{}',
  counterfactual_outcome jsonb NOT NULL DEFAULT '{}',
  estimated_impact jsonb NOT NULL DEFAULT '{}',
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  sample_size integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_bcf_user ON business_counterfactuals(user_id, created_at DESC);

ALTER TABLE business_counterfactuals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_counterfactuals" ON business_counterfactuals;
CREATE POLICY "select_own_counterfactuals" ON business_counterfactuals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy — only the three generator RPCs below write here.

-- Small helper: total cents of a quote's line_items ({description, quantity, unit_price_cents}[])
CREATE OR REPLACE FUNCTION public.quote_total_cents(p_line_items jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(sum(COALESCE((item->>'unit_price_cents')::bigint, 0) * COALESCE((item->>'quantity')::numeric, 1)), 0)::bigint
  FROM jsonb_array_elements(COALESCE(p_line_items, '[]'::jsonb)) AS item;
$$;

-- =============================================================
-- 1) "What if a different technician had been dispatched?"
-- =============================================================
CREATE OR REPLACE FUNCTION public.generate_technician_dispatch_counterfactual(p_assignment_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_assignment record;
  v_job record;
  v_actual_rating numeric;
  v_best record;
  v_bcf_id uuid;
  v_confidence text;
BEGIN
  SELECT * INTO v_assignment FROM job_technician_assignments
  WHERE id = p_assignment_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found or not authorized'; END IF;

  SELECT id, user_id, job_status, invoice_amount, refund_amount_cents, is_rework, service_type
  INTO v_job FROM jobs WHERE id = v_assignment.job_id;

  SELECT avg(rating) INTO v_actual_rating FROM review_requests
  WHERE job_id = v_job.id AND rating IS NOT NULL;

  -- Best alternative: another active technician's historical stats on the
  -- same service_type, last 180 days, ranked by callback rate then rating.
  SELECT tm.id AS technician_id, tm.member_name,
         count(j.id) AS jobs_count,
         CASE WHEN count(j.id) FILTER (WHERE j.job_status = 'completed') = 0 THEN NULL
           ELSE count(j.id) FILTER (WHERE j.is_rework)::numeric / count(j.id) FILTER (WHERE j.job_status = 'completed') END AS callback_rate,
         avg(rr.rating) AS avg_rating
  INTO v_best
  FROM team_members tm
  LEFT JOIN jobs j ON j.assigned_technician_id = tm.id AND j.service_type = v_job.service_type AND j.created_at > now() - interval '180 days'
  LEFT JOIN review_requests rr ON rr.job_id = j.id AND rr.rating IS NOT NULL
  WHERE tm.account_owner_id = v_job.user_id AND tm.invite_status = 'accepted' AND tm.id <> v_assignment.technician_id
  GROUP BY tm.id, tm.member_name
  HAVING count(j.id) > 0
  ORDER BY callback_rate ASC NULLS LAST, avg_rating DESC NULLS LAST
  LIMIT 1;

  v_confidence := CASE WHEN v_best.jobs_count >= 8 THEN 'high' WHEN v_best.jobs_count >= 3 THEN 'medium' ELSE 'low' END;

  INSERT INTO business_counterfactuals (user_id, decision_type, source_id, question, actual_outcome, counterfactual_outcome, estimated_impact, confidence, sample_size)
  VALUES (
    v_job.user_id, 'technician_dispatch', p_assignment_id,
    format('What if a different technician had been dispatched to this %s job?', COALESCE(v_job.service_type, 'service')),
    jsonb_build_object('technician_id', v_assignment.technician_id, 'is_rework', v_job.is_rework, 'rating', v_actual_rating, 'invoice_amount', v_job.invoice_amount),
    jsonb_build_object('technician_id', v_best.technician_id, 'technician_name', v_best.member_name, 'historical_callback_rate', round(v_best.callback_rate, 3), 'historical_avg_rating', round(v_best.avg_rating, 2)),
    jsonb_build_object('callback_risk_delta_pct', round((COALESCE(v_job.is_rework::int, 0) - COALESCE(v_best.callback_rate, 0)) * 100, 1), 'rating_delta', round(COALESCE(v_best.avg_rating, 0) - COALESCE(v_actual_rating, 0), 2)),
    v_confidence, COALESCE(v_best.jobs_count, 0)
  )
  ON CONFLICT (decision_type, source_id) DO UPDATE SET
    actual_outcome = EXCLUDED.actual_outcome, counterfactual_outcome = EXCLUDED.counterfactual_outcome,
    estimated_impact = EXCLUDED.estimated_impact, confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size, created_at = now()
  RETURNING id INTO v_bcf_id;

  RETURN v_bcf_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_technician_dispatch_counterfactual(uuid) TO authenticated;

-- =============================================================
-- 2) "What if this quote had been offered a payment plan?"
-- =============================================================
CREATE OR REPLACE FUNCTION public.generate_quote_financing_counterfactual(p_quote_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_total bigint;
  v_lo bigint; v_hi bigint;
  v_with_total integer; v_with_accepted integer;
  v_without_total integer; v_without_accepted integer;
  v_rate_with numeric; v_rate_without numeric;
  v_uplift numeric;
  v_bcf_id uuid;
  v_confidence text;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found or not authorized'; END IF;
  IF v_quote.status <> 'declined' OR v_quote.financing_offered THEN
    RAISE EXCEPTION 'This counterfactual only applies to declined quotes that did not already offer financing';
  END IF;

  v_total := public.quote_total_cents(v_quote.line_items);
  v_lo := round(v_total * 0.7); v_hi := round(v_total * 1.3);

  SELECT count(*) FILTER (WHERE status IN ('accepted', 'declined')), count(*) FILTER (WHERE status = 'accepted')
  INTO v_with_total, v_with_accepted
  FROM quotes WHERE user_id = v_quote.user_id AND financing_offered = true
    AND public.quote_total_cents(line_items) BETWEEN v_lo AND v_hi AND updated_at > now() - interval '365 days';

  SELECT count(*) FILTER (WHERE status IN ('accepted', 'declined')), count(*) FILTER (WHERE status = 'accepted')
  INTO v_without_total, v_without_accepted
  FROM quotes WHERE user_id = v_quote.user_id AND financing_offered = false AND id <> v_quote.id
    AND public.quote_total_cents(line_items) BETWEEN v_lo AND v_hi AND updated_at > now() - interval '365 days';

  v_rate_with := CASE WHEN v_with_total = 0 THEN NULL ELSE v_with_accepted::numeric / v_with_total END;
  v_rate_without := CASE WHEN v_without_total = 0 THEN NULL ELSE v_without_accepted::numeric / v_without_total END;
  v_uplift := GREATEST(COALESCE(v_rate_with, 0) - COALESCE(v_rate_without, 0), 0);

  v_confidence := CASE WHEN v_with_total >= 10 AND v_without_total >= 10 THEN 'high'
    WHEN v_with_total >= 5 AND v_without_total >= 5 THEN 'medium' ELSE 'low' END;

  INSERT INTO business_counterfactuals (user_id, decision_type, source_id, question, actual_outcome, counterfactual_outcome, estimated_impact, confidence, sample_size)
  VALUES (
    v_quote.user_id, 'quote_financing', p_quote_id,
    'What if this quote had been offered a payment plan?',
    jsonb_build_object('status', v_quote.status, 'quote_total_cents', v_total, 'financing_offered', false),
    jsonb_build_object('historical_accept_rate_with_financing', round(v_rate_with, 3), 'historical_accept_rate_without_financing', round(v_rate_without, 3)),
    jsonb_build_object('estimated_accept_probability_uplift_pct', round(v_uplift * 100, 1), 'estimated_revenue_at_risk_cents', round(v_total * v_uplift)),
    v_confidence, v_with_total + v_without_total
  )
  ON CONFLICT (decision_type, source_id) DO UPDATE SET
    actual_outcome = EXCLUDED.actual_outcome, counterfactual_outcome = EXCLUDED.counterfactual_outcome,
    estimated_impact = EXCLUDED.estimated_impact, confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size, created_at = now()
  RETURNING id INTO v_bcf_id;

  RETURN v_bcf_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_quote_financing_counterfactual(uuid) TO authenticated;

-- =============================================================
-- 3) "What if this job hadn't been rescheduled today?"
-- =============================================================
CREATE OR REPLACE FUNCTION public.generate_reschedule_counterfactual(p_schedule_change_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_change record;
  v_job record;
  v_contract record;
  v_delay_hours numeric;
  v_potential_penalty_cents bigint := 0;
  v_cancel_rate numeric;
  v_cancel_sample integer;
  v_revenue_at_risk_cents bigint := 0;
  v_confidence text := 'low';
  v_bcf_id uuid;
BEGIN
  SELECT * INTO v_change FROM job_schedule_changes WHERE id = p_schedule_change_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Schedule change not found or not authorized'; END IF;

  SELECT id, user_id, invoice_amount, job_status INTO v_job FROM jobs WHERE id = v_change.job_id;
  v_delay_hours := EXTRACT(epoch FROM (v_change.new_scheduled_datetime - v_change.previous_scheduled_datetime)) / 3600;

  SELECT contract_value_cents, penalty_percentage, penalty_cap_percentage, sla_resolution_hours
  INTO v_contract FROM commercial_contracts WHERE job_id = v_change.job_id LIMIT 1;

  IF v_contract.contract_value_cents IS NOT NULL AND v_delay_hours > COALESCE(v_contract.sla_resolution_hours, 24) THEN
    v_potential_penalty_cents := round(LEAST(v_contract.penalty_percentage, v_contract.penalty_cap_percentage) / 100.0 * v_contract.contract_value_cents);
    v_confidence := 'high'; -- a real, contracted SLA term, not a statistical estimate
  ELSE
    -- Fallback: this account's own historical cancel-after-reschedule rate
    SELECT count(*) FILTER (WHERE j2.job_status = 'cancelled'), count(*)
    INTO v_cancel_sample, v_cancel_sample
    FROM job_schedule_changes jsc JOIN jobs j2 ON j2.id = jsc.job_id
    WHERE jsc.user_id = v_job.user_id AND jsc.id <> p_schedule_change_id;

    SELECT CASE WHEN count(*) = 0 THEN NULL ELSE count(*) FILTER (WHERE j2.job_status = 'cancelled')::numeric / count(*) END,
           count(*)
    INTO v_cancel_rate, v_cancel_sample
    FROM job_schedule_changes jsc JOIN jobs j2 ON j2.id = jsc.job_id
    WHERE jsc.user_id = v_job.user_id AND jsc.id <> p_schedule_change_id;

    v_revenue_at_risk_cents := round(COALESCE(v_job.invoice_amount, 0) * 100 * COALESCE(v_cancel_rate, 0.1));
    v_confidence := CASE WHEN v_cancel_sample >= 20 THEN 'medium' WHEN v_cancel_sample >= 5 THEN 'low' ELSE 'low' END;
  END IF;

  INSERT INTO business_counterfactuals (user_id, decision_type, source_id, question, actual_outcome, counterfactual_outcome, estimated_impact, confidence, sample_size)
  VALUES (
    v_job.user_id, 'job_reschedule', p_schedule_change_id,
    'What if this job had not been moved?',
    jsonb_build_object('previous_scheduled_datetime', v_change.previous_scheduled_datetime, 'new_scheduled_datetime', v_change.new_scheduled_datetime, 'delay_hours', round(v_delay_hours, 1), 'job_status', v_job.job_status),
    jsonb_build_object('had_contract_sla', v_contract.contract_value_cents IS NOT NULL, 'historical_cancel_rate_after_reschedule', round(v_cancel_rate, 3)),
    jsonb_build_object('potential_sla_penalty_cents', v_potential_penalty_cents, 'estimated_revenue_at_risk_cents', v_revenue_at_risk_cents),
    v_confidence, COALESCE(v_cancel_sample, 0)
  )
  ON CONFLICT (decision_type, source_id) DO UPDATE SET
    actual_outcome = EXCLUDED.actual_outcome, counterfactual_outcome = EXCLUDED.counterfactual_outcome,
    estimated_impact = EXCLUDED.estimated_impact, confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size, created_at = now()
  RETURNING id INTO v_bcf_id;

  RETURN v_bcf_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_reschedule_counterfactual(uuid) TO authenticated;
