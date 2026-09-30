/*
  # Vireek Continuous Improvement Loop

  ## Why
  Prediction -> Decision -> Action -> Outcome -> Compare expected vs actual
  -> Find error -> Learn -> Update model/workflow -> Repeat.

  Outcome Assurance already stores every pre-dispatch prediction
  (job_assurance_snapshots) and job_outcomes stores what really happened.
  This migration adds the missing half of the loop:

  ## Tables
  - improvement_variances  : append-only ledger of expected-vs-actual per job
                             and metric (duration, first_time_fix), with the
                             attributed causes. UNIQUE(job_id, metric) makes
                             every run idempotent.
  - improvement_corrections: learned duration corrections (job-type or
                             technician scope). A correction only reaches the
                             prediction engine after the account OWNER approves
                             it (status = 'active'). History is kept: superseded
                             and reverted rows stay, with activation windows, so
                             the engine can always recover what it predicted
                             BEFORE a correction (no feedback double-counting).

  ## Safety
  - Clients can only SELECT. Every write goes through a function.
  - Only the owner can approve / dismiss / revert a correction.
  - Correction factor is hard-bounded to [0.5, 2.0].
  - A proposal must carry a passing backtest (>= 5% MAE improvement).
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS improvement_variances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('duration', 'first_time_fix')),
  job_type_key text CHECK (job_type_key IS NULL OR char_length(job_type_key) <= 120),
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  expected numeric(10, 2) NOT NULL,
  actual numeric(10, 2) NOT NULL,
  error_value numeric(10, 2) NOT NULL,
  ratio numeric(8, 3),
  direction text NOT NULL CHECK (direction IN ('over', 'under', 'on_target')),
  primary_cause text CHECK (primary_cause IS NULL OR char_length(primary_cause) <= 40),
  causes jsonb NOT NULL DEFAULT '[]'::jsonb,
  predicted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, metric)
);

CREATE INDEX IF NOT EXISTS idx_improvement_variances_user_created
  ON improvement_variances(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_improvement_variances_user_cause
  ON improvement_variances(user_id, primary_cause) WHERE primary_cause IS NOT NULL;

CREATE TABLE IF NOT EXISTS improvement_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('job_type', 'technician')),
  job_type_key text CHECK (job_type_key IS NULL OR char_length(job_type_key) BETWEEN 1 AND 120),
  technician_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  factor numeric(5, 3) NOT NULL CHECK (factor BETWEEN 0.5 AND 2.0),
  sample_size integer NOT NULL CHECK (sample_size >= 1),
  backtest jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'superseded', 'reverted', 'dismissed')),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  activated_at timestamptz,
  deactivated_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500),
  CONSTRAINT improvement_corrections_scope_target CHECK (
    (scope = 'job_type' AND job_type_key IS NOT NULL AND technician_id IS NULL)
    OR (scope = 'technician' AND technician_id IS NOT NULL AND job_type_key IS NULL)
  )
);

-- At most one ACTIVE and one PROPOSED correction per target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_improvement_corr_active_jobtype
  ON improvement_corrections(user_id, job_type_key) WHERE status = 'active' AND scope = 'job_type';
CREATE UNIQUE INDEX IF NOT EXISTS uq_improvement_corr_active_tech
  ON improvement_corrections(user_id, technician_id) WHERE status = 'active' AND scope = 'technician';
CREATE UNIQUE INDEX IF NOT EXISTS uq_improvement_corr_proposed_jobtype
  ON improvement_corrections(user_id, job_type_key) WHERE status = 'proposed' AND scope = 'job_type';
CREATE UNIQUE INDEX IF NOT EXISTS uq_improvement_corr_proposed_tech
  ON improvement_corrections(user_id, technician_id) WHERE status = 'proposed' AND scope = 'technician';
CREATE INDEX IF NOT EXISTS idx_improvement_corrections_user_status
  ON improvement_corrections(user_id, status, proposed_at DESC);

-- =============================================================
-- RLS (read-only for clients; every write goes through a function)
-- =============================================================

ALTER TABLE improvement_variances ENABLE ROW LEVEL SECURITY;
ALTER TABLE improvement_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_improvement_variances" ON improvement_variances;
CREATE POLICY "select_own_improvement_variances" ON improvement_variances
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_improvement_corrections" ON improvement_corrections;
CREATE POLICY "select_own_improvement_corrections" ON improvement_corrections
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- The variance ledger is evidence: rows can only be appended.
CREATE OR REPLACE FUNCTION public.prevent_improvement_variance_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_improvement_variances_immutable ON improvement_variances;
CREATE TRIGGER trg_improvement_variances_immutable
  BEFORE UPDATE ON improvement_variances
  FOR EACH ROW EXECUTE FUNCTION public.prevent_improvement_variance_update();

-- A correction's target is fixed for life; its factor can only be refreshed
-- while it is still a proposal (never after a human has approved a number).
CREATE OR REPLACE FUNCTION public.guard_improvement_correction_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id
     OR NEW.scope <> OLD.scope
     OR NEW.job_type_key IS DISTINCT FROM OLD.job_type_key
     OR NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
    RAISE EXCEPTION 'A correction target cannot be changed';
  END IF;
  IF OLD.status <> 'proposed' AND NEW.factor <> OLD.factor THEN
    RAISE EXCEPTION 'An approved correction factor cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_improvement_corrections_guard ON improvement_corrections;
CREATE TRIGGER trg_improvement_corrections_guard
  BEFORE UPDATE ON improvement_corrections
  FOR EACH ROW EXECUTE FUNCTION public.guard_improvement_correction_update();

-- =============================================================
-- RECORD A LOOP RUN (variances + validated proposals)
-- =============================================================

/*
  p_variances: jsonb array of
    { job_id, metric, job_type_key, technician_id, expected, actual, error_value,
      ratio, direction, primary_cause, causes, predicted_at }
  p_proposals: jsonb array of
    { scope, job_type_key, technician_id, factor, sample_size, backtest, evidence }
  Returns { variances, proposals } = how many rows were newly written.
  Jobs / technicians that are not this account's are skipped silently.
*/
CREATE OR REPLACE FUNCTION public.record_improvement_run(p_variances jsonb, p_proposals jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item jsonb;
  v_job uuid;
  v_tech uuid;
  v_metric text;
  v_dir text;
  v_expected numeric;
  v_actual numeric;
  v_rows integer;
  v_var_count integer := 0;
  v_prop_count integer := 0;
  v_scope text;
  v_key text;
  v_factor numeric;
  v_n integer;
  v_improve numeric;
  v_active improvement_corrections;
  v_have_active boolean;
  v_prop_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF p_variances IS NULL OR jsonb_typeof(p_variances) <> 'array'
     OR p_proposals IS NULL OR jsonb_typeof(p_proposals) <> 'array' THEN
    RAISE EXCEPTION 'p_variances and p_proposals must be JSON arrays';
  END IF;
  IF jsonb_array_length(p_variances) > 500 THEN
    RAISE EXCEPTION 'Too many variances in one call (max 500)';
  END IF;
  IF jsonb_array_length(p_proposals) > 60 THEN
    RAISE EXCEPTION 'Too many proposals in one call (max 60)';
  END IF;

  -- ---- variances ------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_variances) LOOP
    v_job := (v_item->>'job_id')::uuid;
    v_metric := v_item->>'metric';
    v_dir := v_item->>'direction';
    v_expected := (v_item->>'expected')::numeric;
    v_actual := (v_item->>'actual')::numeric;

    IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job AND user_id = v_owner) THEN
      CONTINUE;
    END IF;
    IF v_metric NOT IN ('duration', 'first_time_fix')
       OR v_dir NOT IN ('over', 'under', 'on_target')
       OR v_expected IS NULL OR v_actual IS NULL
       OR v_expected NOT BETWEEN 0 AND 100000 OR v_actual NOT BETWEEN 0 AND 100000 THEN
      RAISE EXCEPTION 'Invalid variance for job %', v_job;
    END IF;

    v_tech := NULLIF(v_item->>'technician_id', '')::uuid;
    IF v_tech IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM team_members WHERE id = v_tech AND account_owner_id = v_owner
    ) THEN
      v_tech := NULL;
    END IF;

    INSERT INTO improvement_variances (
      user_id, job_id, metric, job_type_key, technician_id, expected, actual,
      error_value, ratio, direction, primary_cause, causes, predicted_at
    ) VALUES (
      v_owner, v_job, v_metric, left(NULLIF(v_item->>'job_type_key', ''), 120), v_tech,
      round(v_expected, 2), round(v_actual, 2),
      round(v_actual - v_expected, 2),
      round(NULLIF(v_item->>'ratio', '')::numeric, 3),
      v_dir,
      left(NULLIF(v_item->>'primary_cause', ''), 40),
      CASE WHEN jsonb_typeof(v_item->'causes') = 'array' AND jsonb_array_length(v_item->'causes') <= 12
           THEN v_item->'causes' ELSE '[]'::jsonb END,
      NULLIF(v_item->>'predicted_at', '')::timestamptz
    )
    ON CONFLICT (job_id, metric) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_var_count := v_var_count + v_rows;
  END LOOP;

  -- ---- proposals ------------------------------------------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_proposals) LOOP
    v_scope := v_item->>'scope';
    v_key := left(NULLIF(v_item->>'job_type_key', ''), 120);
    v_tech := NULLIF(v_item->>'technician_id', '')::uuid;
    v_factor := (v_item->>'factor')::numeric;
    v_n := (v_item->>'sample_size')::integer;
    v_improve := NULLIF(v_item->'backtest'->>'improvementPct', '')::numeric;

    IF v_scope NOT IN ('job_type', 'technician')
       OR v_factor IS NULL OR v_factor NOT BETWEEN 0.5 AND 2.0
       OR v_n IS NULL OR v_n < 1
       OR v_improve IS NULL OR v_improve < 5 THEN
      RAISE EXCEPTION 'Invalid or unvalidated correction proposal';
    END IF;
    IF (v_scope = 'job_type' AND (v_key IS NULL OR v_tech IS NOT NULL))
       OR (v_scope = 'technician' AND (v_tech IS NULL OR v_key IS NOT NULL)) THEN
      RAISE EXCEPTION 'Correction scope does not match its target';
    END IF;
    IF v_scope = 'technician' AND NOT EXISTS (
      SELECT 1 FROM team_members WHERE id = v_tech AND account_owner_id = v_owner
    ) THEN
      CONTINUE;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || v_scope || COALESCE(v_key, v_tech::text), 0));

    -- Skip when it barely differs from what is already active.
    SELECT * INTO v_active FROM improvement_corrections
    WHERE user_id = v_owner AND scope = v_scope AND status = 'active'
      AND job_type_key IS NOT DISTINCT FROM v_key AND technician_id IS NOT DISTINCT FROM v_tech
    LIMIT 1;
    v_have_active := FOUND;
    IF v_have_active AND abs(v_factor / v_active.factor - 1) < 0.05 THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_prop_id FROM improvement_corrections
    WHERE user_id = v_owner AND scope = v_scope AND status = 'proposed'
      AND job_type_key IS NOT DISTINCT FROM v_key AND technician_id IS NOT DISTINCT FROM v_tech
    LIMIT 1;

    IF v_prop_id IS NOT NULL THEN
      UPDATE improvement_corrections SET
        factor = round(v_factor, 3),
        sample_size = v_n,
        backtest = COALESCE(v_item->'backtest', '{}'::jsonb),
        evidence = COALESCE(v_item->'evidence', '{}'::jsonb),
        proposed_at = now()
      WHERE id = v_prop_id;
    ELSE
      INSERT INTO improvement_corrections (
        user_id, scope, job_type_key, technician_id, factor, sample_size, backtest, evidence
      ) VALUES (
        v_owner, v_scope, v_key, v_tech, round(v_factor, 3), v_n,
        COALESCE(v_item->'backtest', '{}'::jsonb), COALESCE(v_item->'evidence', '{}'::jsonb)
      );
      v_prop_count := v_prop_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('variances', v_var_count, 'proposals', v_prop_count);
END;
$$;

-- =============================================================
-- HUMAN DECISION (owner only): approve / dismiss / revert
-- =============================================================

CREATE OR REPLACE FUNCTION public.decide_improvement_correction(
  p_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row improvement_corrections;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can decide on a learned correction';
  END IF;
  IF p_decision NOT IN ('approve', 'dismiss', 'revert') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  SELECT * INTO v_row FROM improvement_corrections
  WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction not found';
  END IF;

  IF p_decision = 'approve' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only a proposed correction can be approved';
    END IF;
    UPDATE improvement_corrections
    SET status = 'superseded', deactivated_at = now()
    WHERE user_id = v_owner AND scope = v_row.scope AND status = 'active'
      AND job_type_key IS NOT DISTINCT FROM v_row.job_type_key
      AND technician_id IS NOT DISTINCT FROM v_row.technician_id;
    UPDATE improvement_corrections
    SET status = 'active', activated_at = now(), decided_at = now(), decided_by = auth.uid(),
        decision_reason = left(p_reason, 500)
    WHERE id = p_id;
  ELSIF p_decision = 'dismiss' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only a proposed correction can be dismissed';
    END IF;
    UPDATE improvement_corrections
    SET status = 'dismissed', decided_at = now(), decided_by = auth.uid(),
        decision_reason = left(p_reason, 500)
    WHERE id = p_id;
  ELSE
    IF v_row.status <> 'active' THEN
      RAISE EXCEPTION 'Only an active correction can be reverted';
    END IF;
    UPDATE improvement_corrections
    SET status = 'reverted', deactivated_at = now(), decided_at = now(), decided_by = auth.uid(),
        decision_reason = left(p_reason, 500)
    WHERE id = p_id;
  END IF;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.record_improvement_run(jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_improvement_correction(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_improvement_run(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_improvement_correction(uuid, text, text) TO authenticated;
