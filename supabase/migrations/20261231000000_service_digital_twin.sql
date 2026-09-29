/*
  # Service Digital Twin — a live model of the SERVICE PROCESS itself

  ## Why
  The Property Digital Twin (digitalTwin.ts) models the building. This models
  the Job as it runs: what SHOULD happen (Expected) vs what IS happening
  (Actual), so Vireek can see a job leave the plan while the technician is
  still on site and intervene BEFORE it closes — not audit it afterwards.

      Expected: 2.0h · $480 cost · FTF 91%
      Actual:   3.2h · $620 cost · FTF at risk   ->  intervention raised

  ## Design (same philosophy as job_quality_gate)
  The database is the single source of truth. All math lives in
  _service_twin_compute(); the UI only renders its output, and the periodic
  scan uses the exact same function, so client and server can never disagree.

  ## Objects
  - service_twins               one row per job: frozen PLAN baseline (set the
                                first time the job is live) + final snapshot
                                when the job closes (learning data).
  - service_twin_interventions  deduped, escalating alerts with a recommended
                                action. One open row per (job, kind).
  - service_twin_evaluate(job)  RPC: compute + persist + return (UI polls it).
  - service_twin_portfolio()    RPC: read-only live view of every active job.
  - service_twin_scan()         service-role only; run every 5 min by pg_cron
                                (scheduled at the bottom if pg_cron exists).

  ## Depends on (all pre-existing in this repo)
  jobs (started_at, arrived_at, expected_duration_minutes, is_rework),
  job_profitability view, team_members.hourly_cost_rate_cents,
  technician_scorecards, job_mission_briefs, job_quality_gate_report(),
  notifications, public.get_account_owner_id().

  ## Tunables (every threshold is visible in _service_twin_compute)
  watch >10% over plan · off-plan >25% time / >20% cost · critical >50% / >40%
  or projected loss. Edit the constants in one place.
*/

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS service_twins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  baseline jsonb NOT NULL,
  final_snapshot jsonb,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_service_twins_user ON service_twins(user_id, frozen_at DESC);

ALTER TABLE service_twins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_twins" ON service_twins;
CREATE POLICY "select_own_service_twins" ON service_twins
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client writes: only the SECURITY DEFINER functions below write.

CREATE TABLE IF NOT EXISTS service_twin_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('time_overrun', 'cost_overrun', 'margin_erosion', 'ftf_risk', 'parts_gap')),
  severity text NOT NULL CHECK (severity IN ('watch', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  headline text NOT NULL,
  recommended_action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  resolution text,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- One live alert per (job, kind): re-scans update it instead of spamming.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_twin_iv_active
  ON service_twin_interventions(job_id, kind) WHERE status IN ('open', 'acknowledged');
CREATE INDEX IF NOT EXISTS idx_service_twin_iv_user_open
  ON service_twin_interventions(user_id, status, severity) WHERE status IN ('open', 'acknowledged');

ALTER TABLE service_twin_interventions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_twin_iv" ON service_twin_interventions;
CREATE POLICY "select_own_service_twin_iv" ON service_twin_interventions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_service_twin_iv" ON service_twin_interventions;
CREATE POLICY "update_own_service_twin_iv" ON service_twin_interventions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- Clients may only change the workflow status (acknowledge / dismiss).
REVOKE UPDATE ON service_twin_interventions FROM authenticated;
GRANT UPDATE (status) ON service_twin_interventions TO authenticated;

-- ============================================================
-- BASELINE — what SHOULD happen. Precedence for each figure:
--   duration: job plan -> own history (n>=5) -> mission brief -> booked slot -> 90 min
--   cost:     own history (n>=5, median) -> labor + 12% materials model
--   FTF:      technician scorecard -> 85%
-- ============================================================

CREATE OR REPLACE FUNCTION public._service_twin_baseline(j public.jobs)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_default_minutes constant integer := 90;
  c_default_revenue constant integer := 45000;
  c_default_hourly constant integer := 3500;
  c_default_ftf constant numeric := 85;
  c_parts_ratio constant numeric := 0.12;
  v_hourly integer;
  v_mb job_mission_briefs%ROWTYPE;
  v_hist_n integer;
  v_hist_dur numeric;
  v_cost_n integer;
  v_hist_cost numeric;
  v_duration integer;
  v_source text;
  v_revenue integer;
  v_cost integer;
  v_cost_source text;
  v_ftf numeric;
  v_ftf_source text := 'default';
BEGIN
  SELECT hourly_cost_rate_cents INTO v_hourly FROM team_members WHERE id = j.assigned_technician_id;
  v_hourly := COALESCE(v_hourly, c_default_hourly);

  SELECT * INTO v_mb FROM job_mission_briefs WHERE job_id = j.id;

  SELECT count(*), percentile_cont(0.5) WITHIN GROUP (
           ORDER BY extract(epoch FROM (x.completed_at - x.started_at)) / 60)
    INTO v_hist_n, v_hist_dur
  FROM jobs x
  WHERE x.user_id = j.user_id AND x.id <> j.id AND j.service_type IS NOT NULL
    AND x.service_type = j.service_type AND x.job_status = 'completed'
    AND x.started_at IS NOT NULL AND x.completed_at IS NOT NULL
    AND x.completed_at - x.started_at BETWEEN interval '5 minutes' AND interval '24 hours';

  IF j.expected_duration_minutes IS NOT NULL THEN
    v_duration := j.expected_duration_minutes; v_source := 'job_plan';
  ELSIF v_hist_n >= 5 THEN
    v_duration := round(v_hist_dur); v_source := 'history';
  ELSIF v_mb.estimated_duration_minutes IS NOT NULL THEN
    v_duration := v_mb.estimated_duration_minutes; v_source := 'mission_brief';
  ELSIF j.duration_minutes IS NOT NULL THEN
    v_duration := j.duration_minutes; v_source := 'scheduled_slot';
  ELSE
    v_duration := c_default_minutes; v_source := 'model';
  END IF;
  v_duration := GREATEST(v_duration, 15);

  v_revenue := COALESCE(
    NULLIF(round(COALESCE(j.invoice_amount, 0)::numeric * 100), 0),
    round(v_mb.estimated_value * 100),
    c_default_revenue
  )::integer;

  SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY p.total_cost_cents)
    INTO v_cost_n, v_hist_cost
  FROM job_profitability p JOIN jobs x ON x.id = p.job_id
  WHERE x.user_id = j.user_id AND x.id <> j.id AND j.service_type IS NOT NULL
    AND x.service_type = j.service_type AND x.job_status = 'completed' AND p.total_cost_cents > 0;

  IF v_cost_n >= 5 THEN
    v_cost := round(v_hist_cost); v_cost_source := 'history';
  ELSE
    v_cost := round(v_duration / 60.0 * v_hourly + v_revenue * c_parts_ratio); v_cost_source := 'model';
  END IF;

  SELECT first_time_fix_rate INTO v_ftf FROM technician_scorecards
  WHERE technician_id = j.assigned_technician_id AND first_time_fix_rate IS NOT NULL
  ORDER BY period_end DESC LIMIT 1;
  IF v_ftf IS NOT NULL THEN v_ftf_source := 'scorecard'; END IF;
  v_ftf := COALESCE(v_ftf, c_default_ftf);

  RETURN jsonb_build_object(
    'duration_minutes', v_duration,
    'revenue_cents', v_revenue,
    'cost_cents', v_cost,
    'hourly_cost_cents', v_hourly,
    'ftf_pct', v_ftf,
    'duration_source', v_source,
    'cost_source', v_cost_source,
    'ftf_source', v_ftf_source
  );
END;
$$;

-- ============================================================
-- COMPUTE — the one place all Expected-vs-Actual math lives (read-only).
-- ============================================================

CREATE OR REPLACE FUNCTION public._service_twin_compute(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- ---- tunables -------------------------------------------------------
  c_watch_ratio constant numeric := 1.10;
  c_high_time constant numeric := 1.25;
  c_crit_time constant numeric := 1.50;
  c_high_cost constant numeric := 1.20;
  c_crit_cost constant numeric := 1.40;
  c_margin_drop_pts constant numeric := 10;
  c_missing_part_cents constant integer := 1500;
  c_tail_share constant numeric := 0.20;
  -- ---------------------------------------------------------------------
  j jobs%ROWTYPE;
  b jsonb;
  v_now timestamptz := now();
  v_phase text;
  v_exp_dur numeric; v_exp_cost numeric; v_exp_rev numeric; v_exp_ftf numeric; v_hourly numeric;
  v_exp_labor numeric; v_exp_nonlabor numeric;
  v_elapsed numeric := 0;
  v_rec_total numeric; v_rec_labor numeric; v_accrued numeric;
  v_actual_cost numeric;
  v_gate jsonb; v_gaps integer := 0; v_cl_total integer := 0; v_cl_done integer := 0;
  v_parts_gap integer := 0;
  v_proj_dur numeric; v_proj_cost numeric;
  v_exp_margin numeric; v_proj_margin numeric;
  v_time_ratio numeric := 1; v_cost_ratio numeric := 1;
  v_ftf numeric; v_drivers jsonb := '[]'::jsonb;
  v_iv jsonb := '[]'::jsonb;
  v_status text := 'on_plan';
  v_sev text;
  v_over integer;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_phase := CASE
    WHEN j.job_status = 'completed' THEN 'closed'
    WHEN j.job_status IN ('cancelled', 'no_show') THEN 'cancelled'
    WHEN j.job_status = 'in_progress' THEN 'live'
    ELSE 'planned'
  END;

  SELECT baseline INTO b FROM service_twins WHERE job_id = p_job_id;
  IF b IS NULL THEN b := public._service_twin_baseline(j); END IF;

  v_exp_dur := (b->>'duration_minutes')::numeric;
  v_exp_cost := (b->>'cost_cents')::numeric;
  v_exp_rev := (b->>'revenue_cents')::numeric;
  v_exp_ftf := (b->>'ftf_pct')::numeric;
  v_hourly := (b->>'hourly_cost_cents')::numeric;
  v_exp_labor := round(v_exp_dur / 60.0 * v_hourly);
  v_exp_nonlabor := GREATEST(v_exp_cost - v_exp_labor, 0);

  IF j.started_at IS NOT NULL THEN
    v_elapsed := GREATEST(extract(epoch FROM (
      COALESCE(CASE WHEN v_phase = 'closed' THEN j.completed_at END, v_now) - j.started_at)) / 60, 0);
  END IF;

  SELECT total_cost_cents, labor_cost_cents INTO v_rec_total, v_rec_labor
  FROM job_profitability WHERE job_id = p_job_id;
  v_rec_total := COALESCE(v_rec_total, 0);
  v_rec_labor := COALESCE(v_rec_labor, 0);
  v_accrued := round(v_elapsed / 60.0 * v_hourly);
  -- Recorded labor entries and live accrual describe the same hours: never add both.
  v_actual_cost := (v_rec_total - v_rec_labor) + GREATEST(v_rec_labor, v_accrued);

  BEGIN
    v_gate := public.job_quality_gate_report(p_job_id);
    v_gaps := COALESCE(jsonb_array_length(v_gate->'gaps'), 0);
    v_cl_total := COALESCE((v_gate->'categories'->'checklist'->>'total')::integer, 0);
    v_cl_done := COALESCE((v_gate->'categories'->'checklist'->>'done')::integer, 0);
  EXCEPTION WHEN OTHERS THEN
    v_gate := NULL; -- e.g. service-role scan without a user context: degrade gracefully
  END;

  SELECT count(*) INTO v_parts_gap
  FROM job_mission_briefs mb, jsonb_array_elements(mb.parts) p
  WHERE mb.job_id = p_job_id AND p->>'necessity' = 'likely'
    AND COALESCE((p->>'in_van_stock')::boolean, false) = false;

  -- ---- projection ------------------------------------------------------
  IF v_phase = 'closed' THEN
    v_proj_dur := v_elapsed;
    v_proj_cost := v_actual_cost;
  ELSIF v_phase = 'live' THEN
    v_proj_dur := GREATEST(v_exp_dur, v_elapsed);
    IF v_elapsed > v_exp_dur THEN
      v_proj_dur := v_elapsed + GREATEST(10, round(v_exp_dur * c_tail_share));
    END IF;
    -- Checklist velocity only counts with >= 2 items done, and never projects past 3x plan.
    IF v_cl_total > 0 AND v_cl_done >= 2 AND v_cl_done < v_cl_total THEN
      v_proj_dur := GREATEST(v_proj_dur, LEAST(v_elapsed * v_cl_total / v_cl_done, v_exp_dur * 3));
    END IF;
    v_proj_cost := GREATEST(v_rec_total - v_rec_labor, v_exp_nonlabor)
                 + GREATEST(v_rec_labor, v_accrued)
                 + round(GREATEST(v_proj_dur - v_elapsed, 0) / 60.0 * v_hourly)
                 + v_parts_gap * c_missing_part_cents;
  ELSE
    v_proj_dur := v_exp_dur;
    v_proj_cost := v_exp_cost;
  END IF;

  v_exp_margin := CASE WHEN v_exp_rev > 0 THEN round((v_exp_rev - v_exp_cost) / v_exp_rev * 100, 1) END;
  v_proj_margin := CASE WHEN v_exp_rev > 0 THEN round((v_exp_rev - v_proj_cost) / v_exp_rev * 100, 1) END;
  v_time_ratio := round(v_proj_dur / NULLIF(v_exp_dur, 0), 3);
  v_cost_ratio := round(v_proj_cost / NULLIF(v_exp_cost, 0), 3);
  v_time_ratio := COALESCE(v_time_ratio, 1);
  v_cost_ratio := COALESCE(v_cost_ratio, 1);

  -- ---- live first-time-fix probability --------------------------------
  v_ftf := v_exp_ftf;
  IF v_phase = 'live' THEN
    IF v_time_ratio > c_crit_time THEN
      v_ftf := v_ftf - 20; v_drivers := v_drivers || jsonb_build_object('driver', 'Severe time overrun', 'points', -20);
    ELSIF v_time_ratio > c_high_time THEN
      v_ftf := v_ftf - 10; v_drivers := v_drivers || jsonb_build_object('driver', 'Time overrun', 'points', -10);
    END IF;
    IF v_parts_gap > 0 THEN
      v_over := LEAST(v_parts_gap * 8, 24);
      v_ftf := v_ftf - v_over;
      v_drivers := v_drivers || jsonb_build_object('driver', v_parts_gap || ' likely part(s) not on the van', 'points', -v_over);
    END IF;
    IF v_gate IS NOT NULL AND v_gaps > 0 AND v_elapsed >= 0.8 * v_exp_dur THEN
      v_over := LEAST(v_gaps * 4, 16);
      v_ftf := v_ftf - v_over;
      v_drivers := v_drivers || jsonb_build_object('driver', v_gaps || ' closing requirement(s) still open', 'points', -v_over);
    END IF;
    IF j.is_rework THEN
      v_ftf := v_ftf - 15; v_drivers := v_drivers || jsonb_build_object('driver', 'This job is already a rework', 'points', -15);
    END IF;
    v_ftf := GREATEST(v_ftf, 5);
  END IF;

  -- ---- interventions (live jobs only) ---------------------------------
  IF v_phase = 'live' THEN
    v_sev := CASE WHEN v_time_ratio > c_crit_time THEN 'critical' WHEN v_time_ratio > c_high_time THEN 'high'
                  WHEN v_time_ratio > c_watch_ratio THEN 'watch' END;
    IF v_sev IS NOT NULL THEN
      v_iv := v_iv || jsonb_build_object('kind', 'time_overrun', 'severity', v_sev,
        'headline', format('Projected %s min vs %s min planned (%s%% of plan)',
                           round(v_proj_dur), round(v_exp_dur), round(v_time_ratio * 100)),
        'action', 'Call the technician now: confirm the blocker, and decide whether to send a second technician or start a remote expert session before the overrun compounds.',
        'detail', jsonb_build_object('projected_minutes', round(v_proj_dur), 'expected_minutes', round(v_exp_dur), 'elapsed_minutes', round(v_elapsed)));
    END IF;

    v_sev := CASE WHEN v_cost_ratio > c_crit_cost THEN 'critical' WHEN v_cost_ratio > c_high_cost THEN 'high'
                  WHEN v_cost_ratio > c_watch_ratio THEN 'watch' END;
    IF v_sev IS NOT NULL THEN
      v_iv := v_iv || jsonb_build_object('kind', 'cost_overrun', 'severity', v_sev,
        'headline', format('Projected cost %s%% of plan',  round(v_cost_ratio * 100)),
        'action', 'Review costs booked so far. If scope grew, present the customer an additional-work estimate before more labor or parts are consumed.',
        'detail', jsonb_build_object('projected_cost_cents', round(v_proj_cost), 'expected_cost_cents', round(v_exp_cost), 'actual_cost_cents', round(v_actual_cost)));
    END IF;

    v_sev := CASE WHEN v_proj_margin IS NULL THEN NULL
                  WHEN v_proj_margin < 0 THEN 'critical'
                  WHEN v_exp_margin IS NOT NULL AND v_proj_margin < v_exp_margin - c_margin_drop_pts THEN 'high' END;
    IF v_sev IS NOT NULL THEN
      v_iv := v_iv || jsonb_build_object('kind', 'margin_erosion', 'severity', v_sev,
        'headline', format('Projected margin %s%% vs %s%% planned', v_proj_margin, COALESCE(v_exp_margin::text, 'n/a')),
        'action', 'This job is on track to earn less than planned. Decide now: change order, price adjustment, or accept the loss knowingly.',
        'detail', jsonb_build_object('projected_margin_pct', v_proj_margin, 'expected_margin_pct', v_exp_margin));
    END IF;

    v_sev := CASE WHEN v_ftf < 40 THEN 'critical' WHEN v_ftf < 60 THEN 'high' WHEN v_ftf < v_exp_ftf - 10 THEN 'watch' END;
    IF v_sev IS NOT NULL THEN
      v_iv := v_iv || jsonb_build_object('kind', 'ftf_risk', 'severity', v_sev,
        'headline', format('First-time-fix probability %s%% (planned %s%%)', round(v_ftf), round(v_exp_ftf)),
        'action', 'Secure what is missing while the technician is still on site (parts runner, expert assist, or a booked follow-up) instead of discovering the callback later.',
        'detail', jsonb_build_object('ftf_pct', round(v_ftf), 'expected_ftf_pct', round(v_exp_ftf), 'drivers', v_drivers));
    END IF;

    IF v_parts_gap > 0 THEN
      v_iv := v_iv || jsonb_build_object('kind', 'parts_gap', 'severity', CASE WHEN v_parts_gap >= 2 THEN 'critical' ELSE 'high' END,
        'headline', v_parts_gap || ' likely part(s) are not on the technician''s van',
        'action', 'Dispatch a parts runner or nearest-van transfer now; a second trip is the most common cause of a failed first-time fix.',
        'detail', jsonb_build_object('missing_likely_parts', v_parts_gap));
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_iv) e WHERE e->>'severity' = 'critical') THEN v_status := 'critical';
    ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_iv) e WHERE e->>'severity' = 'high') THEN v_status := 'off_plan';
    ELSIF jsonb_array_length(v_iv) > 0 THEN v_status := 'watch';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'job_id', j.id,
    'job', jsonb_build_object('customer_name', j.customer_name, 'service_type', j.service_type,
                              'address', j.address, 'technician_id', j.assigned_technician_id,
                              'job_status', j.job_status, 'started_at', j.started_at),
    'phase', v_phase,
    'status', v_status,
    'computed_at', v_now,
    'baseline', b,
    'expected', jsonb_build_object('duration_minutes', round(v_exp_dur), 'cost_cents', round(v_exp_cost),
                                   'revenue_cents', round(v_exp_rev), 'margin_pct', v_exp_margin, 'ftf_pct', round(v_exp_ftf)),
    'actual', jsonb_build_object('elapsed_minutes', round(v_elapsed), 'cost_cents', round(v_actual_cost),
                                 'ftf_pct', CASE WHEN v_phase = 'live' THEN round(v_ftf) END),
    'projected', jsonb_build_object('duration_minutes', round(v_proj_dur), 'cost_cents', round(v_proj_cost),
                                    'margin_pct', v_proj_margin, 'ftf_pct', round(v_ftf)),
    'variance', jsonb_build_object('time_ratio', v_time_ratio, 'cost_ratio', v_cost_ratio,
                                   'margin_delta_pts', round(COALESCE(v_proj_margin, 0) - COALESCE(v_exp_margin, 0), 1),
                                   'ftf_delta_pts', round(v_ftf - v_exp_ftf, 1)),
    'ftf_drivers', v_drivers,
    'interventions', v_iv
  );
END;
$$;

-- ============================================================
-- APPLY — compute + persist baseline + upsert/escalate/resolve interventions
-- ============================================================

CREATE OR REPLACE FUNCTION public._service_twin_apply(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
  iv jsonb;
  j jobs%ROWTYPE;
  v_kinds text[] := ARRAY[]::text[];
  v_old text;
  v_new_rank integer;
  v_old_rank integer;
BEGIN
  v := public._service_twin_compute(p_job_id);
  IF v IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO j FROM jobs WHERE id = p_job_id;

  IF v->>'phase' IN ('live', 'closed') THEN
    INSERT INTO service_twins (user_id, job_id, baseline)
    VALUES (j.user_id, j.id, v->'baseline')
    ON CONFLICT (job_id) DO NOTHING;
  END IF;

  FOR iv IN SELECT * FROM jsonb_array_elements(v->'interventions') LOOP
    v_kinds := v_kinds || (iv->>'kind');
    v_old := NULL;
    SELECT severity INTO v_old FROM service_twin_interventions
    WHERE job_id = p_job_id AND kind = iv->>'kind' AND status IN ('open', 'acknowledged');

    INSERT INTO service_twin_interventions (user_id, job_id, kind, severity, headline, recommended_action, detail)
    VALUES (j.user_id, p_job_id, iv->>'kind', iv->>'severity', iv->>'headline', iv->>'action', iv->'detail')
    ON CONFLICT (job_id, kind) WHERE status IN ('open', 'acknowledged') DO UPDATE SET
      severity = EXCLUDED.severity,
      headline = EXCLUDED.headline,
      recommended_action = EXCLUDED.recommended_action,
      detail = EXCLUDED.detail,
      last_detected_at = now(),
      -- a worsening situation re-opens an acknowledged alert
      status = CASE
        WHEN (CASE EXCLUDED.severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 ELSE 1 END)
           > (CASE service_twin_interventions.severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 ELSE 1 END)
        THEN 'open' ELSE service_twin_interventions.status END;

    v_new_rank := CASE iv->>'severity' WHEN 'critical' THEN 3 WHEN 'high' THEN 2 ELSE 1 END;
    v_old_rank := CASE v_old WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'watch' THEN 1 ELSE 0 END;
    IF v_new_rank >= 2 AND v_new_rank > v_old_rank THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (j.user_id, 'service_twin',
              CASE WHEN v_new_rank = 3 THEN 'Job critically off plan: ' ELSE 'Job off plan: ' END || COALESCE(j.customer_name, 'Job'),
              iv->>'headline' || '. ' || (iv->>'action'),
              '/dashboard/service-twin?job=' || j.id);
    END IF;
  END LOOP;

  UPDATE service_twin_interventions
  SET status = 'resolved', resolved_at = now(),
      resolution = CASE WHEN v->>'phase' = 'live' THEN 'back_on_plan' ELSE 'job_closed' END
  WHERE job_id = p_job_id AND status IN ('open', 'acknowledged')
    AND (v->>'phase' <> 'live' OR NOT (kind = ANY (v_kinds)));

  IF v->>'phase' = 'closed' THEN
    UPDATE service_twins SET final_snapshot = v - 'interventions', finalized_at = now()
    WHERE job_id = p_job_id AND final_snapshot IS NULL;
  END IF;

  RETURN v;
END;
$$;

-- ============================================================
-- PUBLIC RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION public.service_twin_evaluate(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = public.get_account_owner_id()) THEN
    RAISE EXCEPTION 'service_twin: job not found';
  END IF;
  RETURN public._service_twin_apply(p_job_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.service_twin_portfolio()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(public._service_twin_compute(id)), '[]'::jsonb)
  FROM (
    SELECT id FROM jobs
    WHERE user_id = public.get_account_owner_id() AND job_status IN ('en_route', 'in_progress')
    ORDER BY started_at DESC NULLS LAST, scheduled_datetime DESC NULLS LAST
    LIMIT 100
  ) live;
$$;

CREATE OR REPLACE FUNCTION public.service_twin_scan()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM jobs WHERE job_status = 'in_progress'
    UNION
    SELECT t.job_id FROM service_twins t WHERE t.finalized_at IS NULL
      AND EXISTS (SELECT 1 FROM jobs x WHERE x.id = t.job_id AND x.job_status IN ('completed', 'cancelled', 'no_show'))
    LIMIT 1000
  LOOP
    BEGIN
      PERFORM public._service_twin_apply(r.id);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'service_twin_scan: job % failed: %', r.id, SQLERRM; -- one bad job never blocks the rest
    END;
  END LOOP;
  RETURN n;
END;
$$;

-- ============================================================
-- PERMISSIONS
-- ============================================================

REVOKE ALL ON FUNCTION public._service_twin_baseline(public.jobs) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._service_twin_compute(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._service_twin_apply(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_twin_scan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_twin_evaluate(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_twin_portfolio() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_twin_evaluate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_twin_portfolio() TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_twin_scan() TO service_role;

-- ============================================================
-- SCHEDULE — every 5 minutes, only if pg_cron is installed
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('service-twin-scan', '*/5 * * * *', 'select public.service_twin_scan()');
  ELSE
    RAISE NOTICE 'pg_cron not installed: Service Twin still updates live while the job page or Live Twins page is open. Enable pg_cron (Database > Extensions) for unattended monitoring.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'service-twin-scan schedule skipped: %', SQLERRM;
END $$;
