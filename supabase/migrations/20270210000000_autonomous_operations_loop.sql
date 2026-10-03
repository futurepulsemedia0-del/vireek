/*
  # Vireek Autonomous Operations Loop (umbrella)

  OBSERVE -> UNDERSTAND -> PREDICT -> DECIDE -> ACT -> MEASURE -> LEARN
  -> UPDATE POLICY -> ACT BETTER (repeat)

  ## Why
  Vireek already owns the engines of this loop (Evidence Chain, Outcome
  Assurance, Agent Governance, Job Outcomes, Continuous Improvement). What was
  missing is the umbrella: one record per job that proves how far that job
  travelled through the loop, and one ledger that proves whether policy updates
  actually made operations better. Every job becomes a TRAINING EVENT.

  ## Tables
  - ops_loop_events        : one row per job (UNIQUE job_id) = its training event.
                             A derived projection, rebuilt idempotently from the
                             source engines. Never invented: a stage is only
                             marked reached when a real row proves it.
  - ops_policy_changes     : append-only ledger of every policy update (today:
                             approved / reverted learned corrections, captured by
                             a trigger). Carries a per-account epoch so results
                             can be compared before vs. after each update.

  ## Stage evidence (job level)
    observe    job_evidence_chain_entries row exists
    understand job_assurance_snapshots.factors is a non-empty array
    predict    job_assurance_snapshots row exists
    decide     job_assurance_interventions row OR agent_action_log row targeting the job
    act        jobs.job_status = 'completed'
    measure    job_outcomes row exists
    learn      improvement_variances row exists
  UPDATE POLICY / ACT BETTER are account-level (see get_ops_loop_snapshot).

  ## Honesty rules
  - Policy impact is OBSERVATIONAL (before/after), labelled as such, and shown
    only when both sides have >= 8 variances. Otherwise 'insufficient'.
  - Clients can only SELECT. Writes go through SECURITY DEFINER functions.

  ## Depends on
  jobs, team_members, job_evidence_chain_entries, job_assurance_snapshots,
  job_assurance_interventions, agent_action_log, job_outcomes,
  improvement_variances, improvement_corrections, public.get_account_owner_id().
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS ops_loop_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  job_type_key text CHECK (job_type_key IS NULL OR char_length(job_type_key) <= 120),
  observed boolean NOT NULL DEFAULT false,
  understood boolean NOT NULL DEFAULT false,
  predicted boolean NOT NULL DEFAULT false,
  decided boolean NOT NULL DEFAULT false,
  acted boolean NOT NULL DEFAULT false,
  measured boolean NOT NULL DEFAULT false,
  learned boolean NOT NULL DEFAULT false,
  predicted_probability numeric(5, 1) CHECK (predicted_probability IS NULL OR predicted_probability BETWEEN 0 AND 100),
  predicted_minutes integer CHECK (predicted_minutes IS NULL OR predicted_minutes BETWEEN 0 AND 10080),
  actual_minutes integer CHECK (actual_minutes IS NULL OR actual_minutes BETWEEN 0 AND 100000),
  first_time_fix boolean,
  primary_cause text CHECK (primary_cause IS NULL OR char_length(primary_cause) <= 40),
  policy_epoch bigint NOT NULL DEFAULT 0,
  stages_reached smallint NOT NULL DEFAULT 0 CHECK (stages_reached BETWEEN 0 AND 7),
  training_value smallint NOT NULL DEFAULT 0 CHECK (training_value BETWEEN 0 AND 100),
  job_completed_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_loop_events_user_synced
  ON ops_loop_events(user_id, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_loop_events_user_value
  ON ops_loop_events(user_id, training_value DESC);

CREATE TABLE IF NOT EXISTS ops_policy_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 1),
  policy_kind text NOT NULL CHECK (policy_kind IN ('duration_correction')),
  change_type text NOT NULL CHECK (change_type IN ('activated', 'reverted', 'superseded')),
  source_table text NOT NULL CHECK (char_length(source_table) <= 60),
  source_id uuid NOT NULL,
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 300),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  decided_by uuid,
  effective_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, epoch),
  UNIQUE (source_table, source_id, change_type)
);

CREATE INDEX IF NOT EXISTS idx_ops_policy_changes_user_effective
  ON ops_policy_changes(user_id, effective_at DESC);

-- =============================================================
-- RLS (read-only for clients)
-- =============================================================

ALTER TABLE ops_loop_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_policy_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ops_loop_events" ON ops_loop_events;
CREATE POLICY "select_own_ops_loop_events" ON ops_loop_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_ops_policy_changes" ON ops_policy_changes;
CREATE POLICY "select_own_ops_policy_changes" ON ops_policy_changes
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- The policy ledger is evidence: append-only.
CREATE OR REPLACE FUNCTION public.prevent_ops_policy_change_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_policy_changes_immutable ON ops_policy_changes;
CREATE TRIGGER trg_ops_policy_changes_immutable
  BEFORE UPDATE OR DELETE ON ops_policy_changes
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ops_policy_change_mutation();

-- =============================================================
-- UPDATE POLICY capture: every approved / reverted / superseded correction
-- =============================================================

CREATE OR REPLACE FUNCTION public.capture_ops_policy_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_epoch bigint;
  v_target text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'active' THEN
    v_type := 'activated';
  ELSIF OLD.status = 'active' AND NEW.status = 'reverted' THEN
    v_type := 'reverted';
  ELSIF OLD.status = 'active' AND NEW.status = 'superseded' THEN
    v_type := 'superseded';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ops_policy:' || NEW.user_id::text, 0));
  SELECT COALESCE(MAX(epoch), 0) + 1 INTO v_epoch FROM ops_policy_changes WHERE user_id = NEW.user_id;

  v_target := CASE WHEN NEW.scope = 'job_type'
                   THEN COALESCE(NEW.job_type_key, 'job type')
                   ELSE 'technician ' || COALESCE(NEW.technician_id::text, '?') END;

  INSERT INTO ops_policy_changes (
    user_id, epoch, policy_kind, change_type, source_table, source_id, summary, params, decided_by
  ) VALUES (
    NEW.user_id, v_epoch, 'duration_correction', v_type, 'improvement_corrections', NEW.id,
    left('Duration correction x' || NEW.factor::text || ' for ' || v_target || ' ' || v_type, 300),
    jsonb_build_object(
      'scope', NEW.scope, 'factor', NEW.factor, 'sample_size', NEW.sample_size,
      'job_type_key', NEW.job_type_key, 'technician_id', NEW.technician_id
    ),
    NEW.decided_by
  )
  ON CONFLICT (source_table, source_id, change_type) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_ops_policy_change ON improvement_corrections;
CREATE TRIGGER trg_capture_ops_policy_change
  AFTER UPDATE OF status ON improvement_corrections
  FOR EACH ROW EXECUTE FUNCTION public.capture_ops_policy_change();

-- =============================================================
-- SYNC: rebuild training events from the real engines (idempotent)
-- =============================================================

CREATE OR REPLACE FUNCTION public.sync_ops_loop_events(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 90), 1), 365);
  v_epoch bigint;
  v_rows integer;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ops_sync:' || v_owner::text, 0));

  SELECT COALESCE(MAX(epoch), 0) INTO v_epoch FROM ops_policy_changes WHERE user_id = v_owner;

  WITH base AS (
    SELECT
      j.id AS job_id,
      j.assigned_technician_id AS tech_id,
      j.service_type,
      j.job_status,
      j.scheduled_datetime,
      snap.probability, snap.expected_minutes, snap.factors,
      o.job_type_key AS outcome_type, o.duration_minutes AS actual_minutes,
      o.resolution,
      EXISTS (SELECT 1 FROM job_evidence_chain_entries e WHERE e.job_id = j.id) AS has_evidence,
      EXISTS (SELECT 1 FROM job_assurance_interventions i WHERE i.job_id = j.id)
        OR EXISTS (SELECT 1 FROM agent_action_log a
                   WHERE a.user_id = v_owner AND a.target_table = 'jobs' AND a.target_id = j.id::text) AS has_decision,
      (SELECT v.primary_cause FROM improvement_variances v
        WHERE v.job_id = j.id ORDER BY (v.metric = 'duration') DESC LIMIT 1) AS cause,
      EXISTS (SELECT 1 FROM improvement_variances v WHERE v.job_id = j.id) AS has_variance
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT s.probability, s.expected_minutes, s.factors
      FROM job_assurance_snapshots s
      WHERE s.job_id = j.id
      ORDER BY s.created_at DESC LIMIT 1
    ) snap ON true
    LEFT JOIN job_outcomes o ON o.job_id = j.id
    WHERE j.user_id = v_owner
      AND j.job_status <> 'cancelled'
      AND COALESCE(j.scheduled_datetime, j.created_at) >= now() - make_interval(days => v_days)
  ),
  calc AS (
    SELECT
      b.*,
      (b.factors IS NOT NULL AND jsonb_typeof(b.factors) = 'array' AND jsonb_array_length(b.factors) > 0) AS f_understood,
      (b.probability IS NOT NULL) AS f_predicted,
      (b.job_status = 'completed') AS f_acted,
      (b.resolution IS NOT NULL) AS f_measured
    FROM base b
  )
  INSERT INTO ops_loop_events (
    user_id, job_id, technician_id, job_type_key,
    observed, understood, predicted, decided, acted, measured, learned,
    predicted_probability, predicted_minutes, actual_minutes, first_time_fix, primary_cause,
    policy_epoch, stages_reached, training_value, job_completed_at, synced_at
  )
  SELECT
    v_owner, c.job_id, c.tech_id, left(lower(btrim(COALESCE(c.outcome_type, c.service_type))), 120),
    c.has_evidence, c.f_understood, c.f_predicted, c.has_decision, c.f_acted, c.f_measured, c.has_variance,
    c.probability, c.expected_minutes, c.actual_minutes,
    CASE WHEN c.resolution IS NULL THEN NULL ELSE c.resolution = 'fixed_first_visit' END,
    c.cause,
    v_epoch,
    (c.has_evidence::int + c.f_understood::int + c.f_predicted::int + c.has_decision::int
      + c.f_acted::int + c.f_measured::int + c.has_variance::int)::smallint,
    -- Training value: a lesson needs a prediction, a measured reality and an explained gap.
    LEAST(100,
      (CASE WHEN c.f_predicted THEN 30 ELSE 0 END)
      + (CASE WHEN c.f_measured THEN 30 ELSE 0 END)
      + (CASE WHEN c.has_variance THEN 20 ELSE 0 END)
      + (CASE WHEN c.cause IS NOT NULL AND c.cause <> 'unexplained' THEN 10 ELSE 0 END)
      + (CASE WHEN c.has_evidence THEN 10 ELSE 0 END)
    )::smallint,
    CASE WHEN c.f_acted THEN COALESCE(c.scheduled_datetime, now()) ELSE NULL END,
    now()
  FROM calc c
  ON CONFLICT (job_id) DO UPDATE SET
    technician_id = EXCLUDED.technician_id,
    job_type_key = EXCLUDED.job_type_key,
    observed = EXCLUDED.observed,
    understood = EXCLUDED.understood,
    predicted = EXCLUDED.predicted,
    decided = EXCLUDED.decided,
    acted = EXCLUDED.acted,
    measured = EXCLUDED.measured,
    learned = EXCLUDED.learned,
    predicted_probability = EXCLUDED.predicted_probability,
    predicted_minutes = EXCLUDED.predicted_minutes,
    actual_minutes = EXCLUDED.actual_minutes,
    first_time_fix = EXCLUDED.first_time_fix,
    primary_cause = EXCLUDED.primary_cause,
    -- The epoch is stamped once, when the event is first created; later syncs keep it.
    policy_epoch = ops_loop_events.policy_epoch,
    stages_reached = EXCLUDED.stages_reached,
    training_value = EXCLUDED.training_value,
    job_completed_at = EXCLUDED.job_completed_at,
    synced_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

-- =============================================================
-- SNAPSHOT: everything the dashboard shows, in one call
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_ops_loop_snapshot(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 90), 1), 365);
  v_since timestamptz := now() - make_interval(days => v_days);
  v_stages jsonb;
  v_totals jsonb;
  v_impact jsonb;
  v_recent jsonb;
  v_last_sync timestamptz;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT max(synced_at) INTO v_last_sync FROM ops_loop_events WHERE user_id = v_owner;

  SELECT jsonb_build_object(
    'jobs', count(*),
    'completed', count(*) FILTER (WHERE acted),
    'closed_loop', count(*) FILTER (WHERE stages_reached = 7),
    'training_events', count(*) FILTER (WHERE training_value >= 80),
    'avg_training_value', COALESCE(round(avg(training_value)::numeric, 1), 0),
    'observed', count(*) FILTER (WHERE observed),
    'understood', count(*) FILTER (WHERE understood),
    'predicted', count(*) FILTER (WHERE predicted),
    'decided', count(*) FILTER (WHERE decided),
    'acted', count(*) FILTER (WHERE acted),
    'measured', count(*) FILTER (WHERE measured),
    'learned', count(*) FILTER (WHERE learned)
  ) INTO v_totals
  FROM ops_loop_events
  WHERE user_id = v_owner AND COALESCE(job_completed_at, synced_at) >= v_since;

  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'created_at') DESC), '[]'::jsonb) INTO v_recent
  FROM (
    SELECT jsonb_build_object(
      'job_id', e.job_id, 'customer_name', j.customer_name, 'job_type_key', e.job_type_key,
      'stages_reached', e.stages_reached, 'training_value', e.training_value,
      'observed', e.observed, 'understood', e.understood, 'predicted', e.predicted,
      'decided', e.decided, 'acted', e.acted, 'measured', e.measured, 'learned', e.learned,
      'primary_cause', e.primary_cause, 'created_at', COALESCE(e.job_completed_at, e.synced_at)
    ) AS r
    FROM ops_loop_events e JOIN jobs j ON j.id = e.job_id
    WHERE e.user_id = v_owner AND COALESCE(e.job_completed_at, e.synced_at) >= v_since
    ORDER BY COALESCE(e.job_completed_at, e.synced_at) DESC
    LIMIT 40
  ) q;

  -- Policy impact: mean absolute duration error (minutes) of variances recorded
  -- 30 days before vs 30 days after each change. Observational only; >= 8 per side.
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.effective_at DESC), '[]'::jsonb) INTO v_impact
  FROM (
    SELECT
      p.id, p.epoch, p.change_type, p.summary, p.effective_at, p.params,
      pre.n AS n_before, post.n AS n_after,
      CASE WHEN pre.n >= 8 AND post.n >= 8 THEN round(pre.mae, 1) END AS mae_before,
      CASE WHEN pre.n >= 8 AND post.n >= 8 THEN round(post.mae, 1) END AS mae_after,
      CASE
        WHEN pre.n < 8 OR post.n < 8 THEN 'insufficient'
        WHEN post.mae <= pre.mae * 0.95 THEN 'improved'
        WHEN post.mae >= pre.mae * 1.05 THEN 'worsened'
        ELSE 'flat'
      END AS verdict
    FROM ops_policy_changes p
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, COALESCE(avg(abs(v.error_value)), 0) AS mae
      FROM improvement_variances v
      WHERE v.user_id = v_owner AND v.metric = 'duration'
        AND v.created_at < p.effective_at AND v.created_at >= p.effective_at - interval '30 days'
    ) pre
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, COALESCE(avg(abs(v.error_value)), 0) AS mae
      FROM improvement_variances v
      WHERE v.user_id = v_owner AND v.metric = 'duration'
        AND v.created_at >= p.effective_at AND v.created_at < p.effective_at + interval '30 days'
    ) post
    WHERE p.user_id = v_owner AND p.change_type = 'activated'
    ORDER BY p.effective_at DESC
    LIMIT 20
  ) t;

  SELECT jsonb_build_object(
    'policy_changes_total', (SELECT count(*) FROM ops_policy_changes WHERE user_id = v_owner),
    'policy_changes_window', (SELECT count(*) FROM ops_policy_changes WHERE user_id = v_owner AND effective_at >= v_since),
    'pending_proposals', (SELECT count(*) FROM improvement_corrections WHERE user_id = v_owner AND status = 'proposed'),
    'active_policies', (SELECT count(*) FROM improvement_corrections WHERE user_id = v_owner AND status = 'active')
  ) INTO v_stages;

  RETURN jsonb_build_object(
    'window_days', v_days,
    'last_sync', v_last_sync,
    'totals', v_totals,
    'policy', v_stages,
    'impact', v_impact,
    'recent', v_recent
  );
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.sync_ops_loop_events(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_ops_loop_snapshot(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.capture_ops_policy_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_ops_policy_change_mutation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ops_loop_events(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ops_loop_snapshot(integer) TO authenticated;
