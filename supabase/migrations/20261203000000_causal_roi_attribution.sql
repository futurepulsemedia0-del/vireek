/*
  # Causal ROI Attribution

  ## Why
  Every "intelligence" feature in this app (Next Best Actions, Workflow
  Engine, ...) already tells the business an AI action happened. None of
  them tell the business what that action was actually WORTH — and a
  naive before/after or "treated vs everyone else" average is misleading:
  AI actions are not randomly assigned, they get pointed at the jobs most
  likely to need help, which biases a raw correlation in either direction.

  This migration adds a real (if lightweight) causal-inference layer:
  for every AI action taken, it builds a MATCHED CONTROL GROUP — other
  jobs from this same business, same service_type, similar ticket size,
  similar time window, that did NOT receive an AI action — and compares
  the treated job against that matched group (a standard quasi-experimental
  "Average Treatment effect on the Treated" estimator). It stores that
  causal estimate side-by-side with the naive, unmatched correlation
  estimate so the dashboard can show the gap between the two directly.

  ## Tables
  - ai_action_events        — append-only capture of "an AI action landed
                               on entity X", auto-populated by triggers on
                               next_best_actions (status -> done) and
                               workflow_runs (status -> completed). No new
                               instrumentation required anywhere else.
  - causal_roi_attributions — one row per (event, kpi_category) with both
                               estimates, confidence, and matched sample size.

  Purely additive. Nothing existing is altered except two new triggers.
*/

-- =============================================================
-- CAPTURE: unified AI action log (auto, via triggers below)
-- =============================================================
CREATE TABLE IF NOT EXISTS ai_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('next_best_action', 'workflow_run')),
  source_id uuid NOT NULL,
  action_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_aae_user ON ai_action_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_aae_entity ON ai_action_events(entity_type, entity_id);

ALTER TABLE ai_action_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_ai_action_events" ON ai_action_events;
CREATE POLICY "select_own_ai_action_events" ON ai_action_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT policy — rows only ever come from the two triggers below.

CREATE OR REPLACE FUNCTION public.capture_ai_action_event_from_nba()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done') THEN
    INSERT INTO ai_action_events (user_id, source, source_id, action_type, entity_type, entity_id, occurred_at)
    VALUES (NEW.user_id, 'next_best_action', NEW.id, NEW.category, NEW.entity_type, NEW.entity_id, now())
    ON CONFLICT (source, source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_ai_action_event_from_nba ON next_best_actions;
CREATE TRIGGER trg_capture_ai_action_event_from_nba
  AFTER INSERT OR UPDATE OF status ON next_best_actions
  FOR EACH ROW EXECUTE FUNCTION public.capture_ai_action_event_from_nba();

CREATE OR REPLACE FUNCTION public.capture_ai_action_event_from_workflow_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
BEGIN
  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    SELECT slug INTO v_slug FROM workflow_definitions WHERE id = NEW.workflow_id;
    INSERT INTO ai_action_events (user_id, source, source_id, action_type, entity_type, entity_id, occurred_at)
    VALUES (NEW.user_id, 'workflow_run', NEW.id, COALESCE(v_slug, 'workflow'), NEW.entity_type, NEW.entity_id, COALESCE(NEW.completed_at, now()))
    ON CONFLICT (source, source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_ai_action_event_from_workflow_run ON workflow_runs;
CREATE TRIGGER trg_capture_ai_action_event_from_workflow_run
  AFTER INSERT OR UPDATE OF status ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.capture_ai_action_event_from_workflow_run();

-- =============================================================
-- RESULTS: causal estimate vs naive correlation estimate
-- =============================================================
CREATE TABLE IF NOT EXISTS causal_roi_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  action_event_id uuid NOT NULL REFERENCES ai_action_events(id) ON DELETE CASCADE,
  kpi_category text NOT NULL CHECK (kpi_category IN ('revenue', 'retention', 'cost')),
  unit text NOT NULL CHECK (unit IN ('dollars', 'percentage_points')),
  correlation_estimate numeric NOT NULL,
  causal_estimate numeric NOT NULL,
  matched_sample_size integer NOT NULL DEFAULT 0,
  unmatched_sample_size integer NOT NULL DEFAULT 0,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  method text NOT NULL DEFAULT 'nearest_neighbor_matched_control',
  covariates_used text[] NOT NULL DEFAULT '{}',
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_event_id, kpi_category)
);

CREATE INDEX IF NOT EXISTS idx_cra_user ON causal_roi_attributions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cra_kpi ON causal_roi_attributions(user_id, kpi_category);

ALTER TABLE causal_roi_attributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_causal_roi_attributions" ON causal_roi_attributions;
CREATE POLICY "select_own_causal_roi_attributions" ON causal_roi_attributions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE policy — only compute_causal_roi_attribution() writes here.

-- =============================================================
-- Resolve an event to the job whose outcomes we measure
-- =============================================================
CREATE OR REPLACE FUNCTION public.resolve_ai_action_event_job(p_entity_type text, p_entity_id uuid, p_owner uuid, p_occurred_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_job_id uuid;
BEGIN
  IF p_entity_type = 'job' THEN
    SELECT id INTO v_job_id FROM jobs WHERE id = p_entity_id AND user_id = p_owner;
  ELSIF p_entity_type = 'customer' THEN
    SELECT id INTO v_job_id FROM jobs
    WHERE customer_id = p_entity_id AND user_id = p_owner
    ORDER BY (created_at >= p_occurred_at) DESC, abs(extract(epoch FROM (created_at - p_occurred_at))) ASC
    LIMIT 1;
  END IF;
  RETURN v_job_id;
END;
$$;

-- =============================================================
-- THE ESTIMATOR: matched-control causal effect vs naive correlation
-- =============================================================
CREATE OR REPLACE FUNCTION public.compute_causal_roi_attribution(p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event record;
  v_job record;
  v_owner uuid;
  v_matched_n integer;
  v_unmatched_n integer;
  v_ctrl_revenue numeric;
  v_all_revenue numeric;
  v_ctrl_retention numeric;
  v_all_retention numeric;
  v_ctrl_cost numeric;
  v_all_cost numeric;
  v_treated_retention numeric;
  v_confidence text;
  v_rows_written integer := 0;
BEGIN
  SELECT * INTO v_event FROM ai_action_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI action event not found'; END IF;
  v_owner := v_event.user_id;
  IF v_owner <> public.get_account_owner_id() THEN RAISE EXCEPTION 'Not authorized'; END IF;

  SELECT id, customer_id, service_type, invoice_amount, is_rework, refund_amount_cents, created_at
  INTO v_job
  FROM jobs
  WHERE id = public.resolve_ai_action_event_job(v_event.entity_type, v_event.entity_id, v_owner, v_event.occurred_at);

  IF v_job.id IS NULL THEN
    -- Nothing measurable (event points at a quote/call with no linked job) — skip quietly.
    RETURN 0;
  END IF;

  -- Matched control group: same business, same service_type, similar ticket
  -- size (+/- 40%), within a 60-day window, and NOT itself AI-treated.
  SELECT
    count(*),
    avg(j.invoice_amount),
    avg(CASE WHEN EXISTS (
      SELECT 1 FROM jobs j2 WHERE j2.customer_id = j.customer_id AND j2.user_id = v_owner
        AND j2.created_at > j.created_at AND j2.created_at <= j.created_at + interval '90 days'
    ) THEN 1 ELSE 0 END),
    avg(COALESCE(j.refund_amount_cents, 0) / 100.0 + (CASE WHEN j.is_rework THEN 1 ELSE 0 END))
  INTO v_matched_n, v_ctrl_revenue, v_ctrl_retention, v_ctrl_cost
  FROM jobs j
  WHERE j.user_id = v_owner
    AND j.id <> v_job.id
    AND j.service_type IS NOT DISTINCT FROM v_job.service_type
    AND j.created_at BETWEEN v_job.created_at - interval '60 days' AND v_job.created_at + interval '60 days'
    AND (v_job.invoice_amount IS NULL OR j.invoice_amount BETWEEN v_job.invoice_amount * 0.6 AND v_job.invoice_amount * 1.4)
    AND j.id NOT IN (SELECT entity_id FROM ai_action_events WHERE entity_type = 'job' AND entity_id IS NOT NULL);

  -- Naive population: every OTHER untreated job for this business, no
  -- matching at all — this is the "just compare averages" estimate that
  -- causal ROI attribution exists to correct.
  SELECT
    count(*),
    avg(j.invoice_amount),
    avg(CASE WHEN EXISTS (
      SELECT 1 FROM jobs j2 WHERE j2.customer_id = j.customer_id AND j2.user_id = v_owner
        AND j2.created_at > j.created_at AND j2.created_at <= j.created_at + interval '90 days'
    ) THEN 1 ELSE 0 END),
    avg(COALESCE(j.refund_amount_cents, 0) / 100.0 + (CASE WHEN j.is_rework THEN 1 ELSE 0 END))
  INTO v_unmatched_n, v_all_revenue, v_all_retention, v_all_cost
  FROM jobs j
  WHERE j.user_id = v_owner
    AND j.id <> v_job.id
    AND j.id NOT IN (SELECT entity_id FROM ai_action_events WHERE entity_type = 'job' AND entity_id IS NOT NULL);

  v_treated_retention := CASE WHEN EXISTS (
    SELECT 1 FROM jobs j2 WHERE j2.customer_id = v_job.customer_id AND j2.user_id = v_owner
      AND j2.created_at > v_job.created_at AND j2.created_at <= v_job.created_at + interval '90 days'
  ) THEN 1 ELSE 0 END;

  v_confidence := CASE WHEN COALESCE(v_matched_n, 0) >= 10 THEN 'high' WHEN COALESCE(v_matched_n, 0) >= 4 THEN 'medium' ELSE 'low' END;

  -- Revenue (dollars)
  INSERT INTO causal_roi_attributions (user_id, action_event_id, kpi_category, unit, correlation_estimate, causal_estimate, matched_sample_size, unmatched_sample_size, confidence, covariates_used, job_id)
  VALUES (v_owner, p_event_id, 'revenue', 'dollars',
    round(COALESCE(v_job.invoice_amount, 0) - COALESCE(v_all_revenue, 0), 2),
    round(COALESCE(v_job.invoice_amount, 0) - COALESCE(v_ctrl_revenue, 0), 2),
    COALESCE(v_matched_n, 0), COALESCE(v_unmatched_n, 0), v_confidence,
    ARRAY['service_type', 'ticket_size_band', 'time_window_60d'], v_job.id)
  ON CONFLICT (action_event_id, kpi_category) DO UPDATE SET
    correlation_estimate = EXCLUDED.correlation_estimate, causal_estimate = EXCLUDED.causal_estimate,
    matched_sample_size = EXCLUDED.matched_sample_size, unmatched_sample_size = EXCLUDED.unmatched_sample_size,
    confidence = EXCLUDED.confidence, created_at = now();
  v_rows_written := v_rows_written + 1;

  -- Retention (percentage points — repeat booking within 90 days)
  INSERT INTO causal_roi_attributions (user_id, action_event_id, kpi_category, unit, correlation_estimate, causal_estimate, matched_sample_size, unmatched_sample_size, confidence, covariates_used, job_id)
  VALUES (v_owner, p_event_id, 'retention', 'percentage_points',
    round((v_treated_retention - COALESCE(v_all_retention, 0)) * 100, 1),
    round((v_treated_retention - COALESCE(v_ctrl_retention, 0)) * 100, 1),
    COALESCE(v_matched_n, 0), COALESCE(v_unmatched_n, 0), v_confidence,
    ARRAY['service_type', 'ticket_size_band', 'time_window_60d'], v_job.id)
  ON CONFLICT (action_event_id, kpi_category) DO UPDATE SET
    correlation_estimate = EXCLUDED.correlation_estimate, causal_estimate = EXCLUDED.causal_estimate,
    matched_sample_size = EXCLUDED.matched_sample_size, unmatched_sample_size = EXCLUDED.unmatched_sample_size,
    confidence = EXCLUDED.confidence, created_at = now();
  v_rows_written := v_rows_written + 1;

  -- Cost (dollars — refund exposure + rework incidence; negative = cost avoided)
  INSERT INTO causal_roi_attributions (user_id, action_event_id, kpi_category, unit, correlation_estimate, causal_estimate, matched_sample_size, unmatched_sample_size, confidence, covariates_used, job_id)
  VALUES (v_owner, p_event_id, 'cost', 'dollars',
    round((COALESCE(v_job.refund_amount_cents, 0) / 100.0 + (CASE WHEN v_job.is_rework THEN 1 ELSE 0 END)) - COALESCE(v_all_cost, 0), 2),
    round((COALESCE(v_job.refund_amount_cents, 0) / 100.0 + (CASE WHEN v_job.is_rework THEN 1 ELSE 0 END)) - COALESCE(v_ctrl_cost, 0), 2),
    COALESCE(v_matched_n, 0), COALESCE(v_unmatched_n, 0), v_confidence,
    ARRAY['service_type', 'ticket_size_band', 'time_window_60d'], v_job.id)
  ON CONFLICT (action_event_id, kpi_category) DO UPDATE SET
    correlation_estimate = EXCLUDED.correlation_estimate, causal_estimate = EXCLUDED.causal_estimate,
    matched_sample_size = EXCLUDED.matched_sample_size, unmatched_sample_size = EXCLUDED.unmatched_sample_size,
    confidence = EXCLUDED.confidence, created_at = now();
  v_rows_written := v_rows_written + 1;

  RETURN v_rows_written;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_causal_roi_attribution(uuid) TO authenticated;

-- =============================================================
-- Pending events (not yet analyzed)
-- =============================================================
CREATE OR REPLACE FUNCTION public.find_unanalyzed_ai_action_events(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, source text, action_type text, entity_type text, entity_id uuid, occurred_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.source, e.action_type, e.entity_type, e.entity_id, e.occurred_at
  FROM ai_action_events e
  WHERE e.user_id = public.get_account_owner_id()
    AND NOT EXISTS (SELECT 1 FROM causal_roi_attributions c WHERE c.action_event_id = e.id)
  ORDER BY e.occurred_at DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.find_unanalyzed_ai_action_events(integer) TO authenticated;

-- =============================================================
-- Dashboard summary: causal vs correlation, per KPI category
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_causal_roi_summary()
RETURNS TABLE (
  kpi_category text,
  unit text,
  causal_total numeric,
  correlation_total numeric,
  analyzed_count integer,
  high_confidence_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    kpi_category,
    max(unit) AS unit,
    round(CASE WHEN max(unit) = 'percentage_points' THEN avg(causal_estimate) ELSE sum(causal_estimate) END, 2) AS causal_total,
    round(CASE WHEN max(unit) = 'percentage_points' THEN avg(correlation_estimate) ELSE sum(correlation_estimate) END, 2) AS correlation_total,
    count(*)::integer AS analyzed_count,
    count(*) FILTER (WHERE confidence = 'high')::integer AS high_confidence_count
  FROM causal_roi_attributions
  WHERE user_id = public.get_account_owner_id()
  GROUP BY kpi_category;
$$;

GRANT EXECUTE ON FUNCTION public.get_causal_roi_summary() TO authenticated;

-- =============================================================
-- Breakdown by action type (which AI actions actually move the needle)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_causal_roi_by_action_type()
RETURNS TABLE (
  action_type text,
  kpi_category text,
  unit text,
  avg_causal_estimate numeric,
  avg_correlation_estimate numeric,
  analyzed_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.action_type,
    c.kpi_category,
    max(c.unit) AS unit,
    round(avg(c.causal_estimate), 2) AS avg_causal_estimate,
    round(avg(c.correlation_estimate), 2) AS avg_correlation_estimate,
    count(*)::integer AS analyzed_count
  FROM causal_roi_attributions c
  JOIN ai_action_events e ON e.id = c.action_event_id
  WHERE c.user_id = public.get_account_owner_id()
  GROUP BY e.action_type, c.kpi_category
  ORDER BY c.kpi_category, avg_causal_estimate DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_causal_roi_by_action_type() TO authenticated;
