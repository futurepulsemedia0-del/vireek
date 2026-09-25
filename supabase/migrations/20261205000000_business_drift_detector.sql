/*
  # Business Drift Detector

  ## Why
  Revenue can look fine for months while the underlying model quietly
  erodes — discounts creep up, jobs run long, evidence quality slips,
  callbacks tick up, the customer mix shifts toward low-margin work,
  dispatchers keep manually overriding assignments. Individually each
  looks like noise. This compares the last 30 days against the prior 90
  days across 7 signals, ALL computed from data this project already
  has (job_evidence_checks, callback_root_cause_analyses, quotes
  discount fields, job_technician_assignments, job_profitability) — and
  only asks AI to explain flagged signals, never to detect them.

  ## Table
  - business_drift_snapshots — one row per scan run (append-only, so the
    drift_score itself becomes a trend line over time — the whole point
    is to see this BEFORE the monthly P&L does).
*/

CREATE TABLE IF NOT EXISTS business_drift_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  period_start date NOT NULL,
  period_end date NOT NULL,
  baseline_start date NOT NULL,
  baseline_end date NOT NULL,

  metrics jsonb NOT NULL DEFAULT '{}',
  flagged_count integer NOT NULL DEFAULT 0,
  drift_score integer NOT NULL DEFAULT 0 CHECK (drift_score >= 0 AND drift_score <= 100),

  insights jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bds_metrics_is_object') THEN
    ALTER TABLE business_drift_snapshots
      ADD CONSTRAINT bds_metrics_is_object CHECK (jsonb_typeof(metrics) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bds_insights_is_array') THEN
    ALTER TABLE business_drift_snapshots
      ADD CONSTRAINT bds_insights_is_array CHECK (jsonb_typeof(insights) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bds_user_created ON business_drift_snapshots(user_id, created_at DESC);

ALTER TABLE business_drift_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_business_drift_snapshots" ON business_drift_snapshots;
CREATE POLICY "select_own_business_drift_snapshots" ON business_drift_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT policy — only the business-drift-scan Edge Function
-- (service role) writes rows, same posture as capacity_demand_events.
