/*
  # Service Risk Intelligence (pre-job risk + coverage decision)

  ## Why
  Before a technician is dispatched, Vireek scores every job on five risk
  dimensions (Property, Technician, Job Liability, Parts, Warranty) using data
  it already holds, then attaches a coverage decision to the workflow
  (clear / conditions / manager_review / refer_to_insurer / hold).

  The scoring itself is deterministic and lives in code
  (src/lib/riskIntelligence.ts) so it is unit-tested and explainable. The
  database stores the evidence trail insurers and enterprise buyers ask for:

  - risk_policies: per-account thresholds (liability limit, high-value job
    threshold, extra high-risk service types) and an OPT-IN switch that
    requires a named human to acknowledge a high-risk job before dispatch.
  - job_risk_assessments: append-only snapshots of every computed assessment
    (scores, levels, flags, coverage decision). Never updated or deleted by
    users, so the history is an audit trail.
  - job_risk_acknowledgements: append-only record of who accepted a flagged
    job, when, and why.
  - trg_enforce_job_risk_ack: BEFORE UPDATE OF job_status on jobs. Only does
    anything when the account turned require_ack_for_high_risk ON, the job is
    moving to en_route / in_progress, and the latest recorded assessment
    requires acknowledgement and has none. Default is OFF, so nothing changes
    for existing accounts until an owner enables it.

  ## Security
  RLS scoped with public.get_account_owner_id(), same as every tenant table.
  Assessments and acknowledgements are select + insert only.
*/

-- =============================================================
-- RISK_POLICIES (one row per account)
-- =============================================================

CREATE TABLE IF NOT EXISTS risk_policies (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  liability_limit_cents bigint
    CHECK (liability_limit_cents IS NULL OR liability_limit_cents > 0),
  high_value_job_cents bigint NOT NULL DEFAULT 1000000
    CHECK (high_value_job_cents > 0),
  high_risk_service_types text[] NOT NULL DEFAULT '{}',
  require_ack_for_high_risk boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_risk_policies_updated_at ON risk_policies;
CREATE TRIGGER trg_risk_policies_updated_at
  BEFORE UPDATE ON risk_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE risk_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_risk_policies ON risk_policies;
CREATE POLICY select_own_risk_policies ON risk_policies
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_risk_policies ON risk_policies;
CREATE POLICY insert_own_risk_policies ON risk_policies
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS update_own_risk_policies ON risk_policies;
CREATE POLICY update_own_risk_policies ON risk_policies
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB_RISK_ASSESSMENTS (append-only audit trail)
-- =============================================================

CREATE TABLE IF NOT EXISTS job_risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  engine_version text NOT NULL,

  overall_score smallint NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  overall_level text NOT NULL CHECK (overall_level IN ('low', 'medium', 'high')),

  property_score smallint NOT NULL CHECK (property_score BETWEEN 0 AND 100),
  property_level text NOT NULL CHECK (property_level IN ('low', 'medium', 'high')),
  technician_score smallint NOT NULL CHECK (technician_score BETWEEN 0 AND 100),
  technician_level text NOT NULL CHECK (technician_level IN ('low', 'medium', 'high')),
  liability_score smallint NOT NULL CHECK (liability_score BETWEEN 0 AND 100),
  liability_level text NOT NULL CHECK (liability_level IN ('low', 'medium', 'high')),
  parts_score smallint NOT NULL CHECK (parts_score BETWEEN 0 AND 100),
  parts_level text NOT NULL CHECK (parts_level IN ('low', 'medium', 'high')),
  warranty_score smallint NOT NULL CHECK (warranty_score BETWEEN 0 AND 100),
  warranty_level text NOT NULL CHECK (warranty_level IN ('low', 'medium', 'high')),

  coverage_decision text NOT NULL
    CHECK (coverage_decision IN ('clear', 'conditions', 'manager_review', 'refer_to_insurer', 'hold')),
  requires_ack boolean NOT NULL DEFAULT false,
  data_coverage numeric(4,3) NOT NULL CHECK (data_coverage BETWEEN 0 AND 1),

  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_risk_assessments_job
  ON job_risk_assessments(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_risk_assessments_user_created
  ON job_risk_assessments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_risk_assessments_needs_ack
  ON job_risk_assessments(user_id, created_at DESC) WHERE requires_ack = true;

ALTER TABLE job_risk_assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_job_risk_assessments ON job_risk_assessments;
CREATE POLICY select_own_job_risk_assessments ON job_risk_assessments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_job_risk_assessments ON job_risk_assessments;
CREATE POLICY insert_own_job_risk_assessments ON job_risk_assessments
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- JOB_RISK_ACKNOWLEDGEMENTS (append-only)
-- =============================================================

CREATE TABLE IF NOT EXISTS job_risk_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES job_risk_assessments(id) ON DELETE CASCADE,
  acknowledged_by uuid NOT NULL DEFAULT auth.uid(),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_risk_acks_job
  ON job_risk_acknowledgements(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_risk_acks_assessment
  ON job_risk_acknowledgements(assessment_id);

ALTER TABLE job_risk_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_job_risk_acks ON job_risk_acknowledgements;
CREATE POLICY select_own_job_risk_acks ON job_risk_acknowledgements
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_job_risk_acks ON job_risk_acknowledgements;
CREATE POLICY insert_own_job_risk_acks ON job_risk_acknowledgements
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND acknowledged_by = auth.uid()
  );

-- =============================================================
-- OPT-IN WORKFLOW GATE
-- =============================================================
-- SECURITY DEFINER so the check also works when the status change comes
-- from a technician session that cannot read the risk tables directly.

CREATE OR REPLACE FUNCTION public.enforce_job_risk_acknowledgement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_require boolean;
  v_assessment_id uuid;
  v_requires_ack boolean;
BEGIN
  IF NEW.job_status NOT IN ('en_route', 'in_progress')
     OR NEW.job_status IS NOT DISTINCT FROM OLD.job_status THEN
    RETURN NEW;
  END IF;

  SELECT require_ack_for_high_risk INTO v_require
  FROM risk_policies WHERE user_id = NEW.user_id;

  IF NOT COALESCE(v_require, false) THEN
    RETURN NEW;
  END IF;

  SELECT id, requires_ack INTO v_assessment_id, v_requires_ack
  FROM job_risk_assessments
  WHERE job_id = NEW.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_assessment_id IS NULL OR NOT v_requires_ack THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM job_risk_acknowledgements WHERE assessment_id = v_assessment_id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'JOB_RISK_ACK_REQUIRED: This job carries a flagged risk and needs a manager acknowledgement before dispatch. Open the Risk panel on the job and acknowledge it.';
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_job_risk_ack ON jobs;
CREATE TRIGGER trg_enforce_job_risk_ack
  BEFORE UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_job_risk_acknowledgement();
