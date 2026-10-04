/*
  Vireek Operational Experimentation Platform

  Adds: ops_experiments, ops_experiment_assignments.
  Purely additive. Access is limited to owners/admins/billing managers because
  experiments compare technician and job performance.

  Integrity guarantees enforced in the database (not just the UI):
   - the design (metric, effect size, groups, duration...) is locked once an experiment starts;
   - status only moves forward: draft -> running -> concluded -> archived;
   - concluding requires a decision and a written learning;
   - the stored result snapshot cannot be edited after the experiment is concluded;
   - randomized job arms are assigned by the server from a hash, never chosen by the client.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

CREATE OR REPLACE FUNCTION public.ops_experiments_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.ops_experiments_is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_experiments_is_manager() TO authenticated;

-- 1) Experiments ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 140),
  category text NOT NULL CHECK (category IN ('dispatch', 'quality', 'pricing', 'parts', 'training', 'customer_experience', 'operations')),
  hypothesis text NOT NULL CHECK (char_length(btrim(hypothesis)) BETWEEN 10 AND 1000),
  intervention text NOT NULL CHECK (char_length(btrim(intervention)) BETWEEN 10 AND 1000),
  comparison_desc text NOT NULL DEFAULT '' CHECK (char_length(comparison_desc) <= 1000),
  design text NOT NULL CHECK (design IN ('randomized', 'comparison')),
  primary_metric text NOT NULL CHECK (primary_metric IN ('ftf_rate', 'callback_rate', 'completion_rate', 'sla_met_rate', 'avg_revenue')),
  guardrail_metric text CHECK (guardrail_metric IN ('ftf_rate', 'callback_rate', 'completion_rate', 'sla_met_rate', 'avg_revenue')),
  guardrail_tolerance numeric CHECK (guardrail_tolerance >= 0),
  min_detectable_effect numeric NOT NULL CHECK (min_detectable_effect > 0),
  alpha numeric NOT NULL DEFAULT 0.05 CHECK (alpha IN (0.01, 0.05, 0.10)),
  duration_days smallint NOT NULL DEFAULT 28 CHECK (duration_days BETWEEN 7 AND 180),
  treatment_share smallint NOT NULL DEFAULT 50 CHECK (treatment_share BETWEEN 10 AND 90),
  service_types text[] NOT NULL DEFAULT '{}',
  maturity_days smallint NOT NULL DEFAULT 14 CHECK (maturity_days BETWEEN 0 AND 60),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'concluded', 'archived')),
  started_at timestamptz,
  concluded_at timestamptz,
  decision text CHECK (decision IN ('adopt', 'iterate', 'reject')),
  learning text CHECK (char_length(learning) <= 2000),
  result_snapshot jsonb,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_experiments_guardrail_pair CHECK ((guardrail_metric IS NULL) = (guardrail_tolerance IS NULL)),
  CONSTRAINT ops_experiments_guardrail_differs CHECK (guardrail_metric IS NULL OR guardrail_metric <> primary_metric),
  CONSTRAINT ops_experiments_started CHECK (status IN ('draft', 'archived') OR started_at IS NOT NULL),
  CONSTRAINT ops_experiments_concluded CHECK (
    status <> 'concluded'
    OR (decision IS NOT NULL AND char_length(btrim(coalesce(learning, ''))) >= 10 AND concluded_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_ops_experiments_owner ON ops_experiments (account_owner_id, status, created_at DESC);

-- 2) Assignments (who is in which arm) -----------------------------------------
CREATE TABLE IF NOT EXISTS ops_experiment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES ops_experiments(id) ON DELETE CASCADE,
  unit_type text NOT NULL CHECK (unit_type IN ('job', 'technician')),
  unit_id uuid NOT NULL,
  arm text NOT NULL CHECK (arm IN ('control', 'treatment')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, unit_type, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_experiment_assignments_exp ON ops_experiment_assignments (experiment_id, arm);

-- Triggers --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_experiments_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF new.account_owner_id IS DISTINCT FROM old.account_owner_id THEN
      RAISE EXCEPTION 'Experiment owner cannot change';
    END IF;

    IF old.status <> 'draft' AND (
      new.design IS DISTINCT FROM old.design
      OR new.primary_metric IS DISTINCT FROM old.primary_metric
      OR new.guardrail_metric IS DISTINCT FROM old.guardrail_metric
      OR new.guardrail_tolerance IS DISTINCT FROM old.guardrail_tolerance
      OR new.min_detectable_effect IS DISTINCT FROM old.min_detectable_effect
      OR new.alpha IS DISTINCT FROM old.alpha
      OR new.duration_days IS DISTINCT FROM old.duration_days
      OR new.treatment_share IS DISTINCT FROM old.treatment_share
      OR new.service_types IS DISTINCT FROM old.service_types
      OR new.maturity_days IS DISTINCT FROM old.maturity_days
      OR new.hypothesis IS DISTINCT FROM old.hypothesis
      OR new.intervention IS DISTINCT FROM old.intervention
      OR new.started_at IS DISTINCT FROM old.started_at
    ) THEN
      RAISE EXCEPTION 'The experiment design is locked once it has started';
    END IF;

    IF new.status IS DISTINCT FROM old.status THEN
      IF NOT (
        (old.status = 'draft' AND new.status IN ('running', 'archived'))
        OR (old.status = 'running' AND new.status IN ('concluded', 'archived'))
        OR (old.status = 'concluded' AND new.status = 'archived')
      ) THEN
        RAISE EXCEPTION 'Invalid status change from % to %', old.status, new.status;
      END IF;
      IF new.status = 'running' THEN
        new.started_at := now();
      ELSIF new.status = 'concluded' THEN
        new.concluded_at := now();
      END IF;
    END IF;

    IF old.status = 'concluded' AND (
      new.result_snapshot IS DISTINCT FROM old.result_snapshot
      OR new.decision IS DISTINCT FROM old.decision
      OR new.concluded_at IS DISTINCT FROM old.concluded_at
    ) THEN
      RAISE EXCEPTION 'A concluded experiment result cannot be changed';
    END IF;
  ELSE
    -- New experiments always start as drafts with no result.
    new.status := 'draft';
    new.started_at := NULL;
    new.concluded_at := NULL;
    new.decision := NULL;
    new.result_snapshot := NULL;
  END IF;

  new.updated_at := now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_experiments_guard ON ops_experiments;
CREATE TRIGGER trg_ops_experiments_guard
  BEFORE INSERT OR UPDATE ON ops_experiments
  FOR EACH ROW EXECUTE FUNCTION public.ops_experiments_guard();

-- Randomized job arms are decided by the server, deterministically, from a hash.
CREATE OR REPLACE FUNCTION public.ops_experiment_assign_arm()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  share smallint;
BEGIN
  IF new.unit_type = 'job' THEN
    SELECT e.treatment_share INTO share FROM ops_experiments e WHERE e.id = new.experiment_id;
    IF share IS NULL THEN
      RAISE EXCEPTION 'Experiment not found';
    END IF;
    new.arm := CASE
      WHEN ((hashtextextended(new.experiment_id::text || ':' || new.unit_id::text, 0) & 2147483647) % 100) < share
        THEN 'treatment'
      ELSE 'control'
    END;
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_experiment_assign_arm ON ops_experiment_assignments;
CREATE TRIGGER trg_ops_experiment_assign_arm
  BEFORE INSERT ON ops_experiment_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ops_experiment_assign_arm();

-- RLS -------------------------------------------------------------------------
ALTER TABLE ops_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_experiment_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ops_experiments_read" ON ops_experiments;
CREATE POLICY "ops_experiments_read" ON ops_experiments FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ops_experiments_is_manager());

DROP POLICY IF EXISTS "ops_experiments_insert" ON ops_experiments;
CREATE POLICY "ops_experiments_insert" ON ops_experiments FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.ops_experiments_is_manager());

DROP POLICY IF EXISTS "ops_experiments_update" ON ops_experiments;
CREATE POLICY "ops_experiments_update" ON ops_experiments FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ops_experiments_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.ops_experiments_is_manager());

-- Only drafts can be deleted; started experiments are kept as a scientific record.
DROP POLICY IF EXISTS "ops_experiments_delete" ON ops_experiments;
CREATE POLICY "ops_experiments_delete" ON ops_experiments FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ops_experiments_is_manager() AND status = 'draft');

DROP POLICY IF EXISTS "ops_experiment_assignments_read" ON ops_experiment_assignments;
CREATE POLICY "ops_experiment_assignments_read" ON ops_experiment_assignments FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ops_experiments_is_manager());

-- Job arms: only while the randomized experiment is running. Technician groups: only while drafting.
DROP POLICY IF EXISTS "ops_experiment_assignments_insert" ON ops_experiment_assignments;
CREATE POLICY "ops_experiment_assignments_insert" ON ops_experiment_assignments FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.ops_experiments_is_manager()
    AND (
      (
        unit_type = 'job'
        AND EXISTS (
          SELECT 1 FROM ops_experiments e
          WHERE e.id = experiment_id AND e.account_owner_id = public.get_account_owner_id()
            AND e.design = 'randomized' AND e.status = 'running'
        )
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = unit_id AND j.user_id = public.get_account_owner_id())
      )
      OR (
        unit_type = 'technician'
        AND EXISTS (
          SELECT 1 FROM ops_experiments e
          WHERE e.id = experiment_id AND e.account_owner_id = public.get_account_owner_id()
            AND e.design = 'comparison' AND e.status = 'draft'
        )
        AND EXISTS (SELECT 1 FROM team_members m WHERE m.id = unit_id AND m.account_owner_id = public.get_account_owner_id())
      )
    )
  );

DROP POLICY IF EXISTS "ops_experiment_assignments_delete" ON ops_experiment_assignments;
CREATE POLICY "ops_experiment_assignments_delete" ON ops_experiment_assignments FOR DELETE TO authenticated
  USING (
    account_owner_id = public.get_account_owner_id()
    AND public.ops_experiments_is_manager()
    AND EXISTS (SELECT 1 FROM ops_experiments e WHERE e.id = experiment_id AND e.status = 'draft')
  );
