/*
  # Dispatch Intelligence — decision audit trail

  ## Why
  The AI Dispatch plan (src/lib/dispatchIntelligence.ts) is computed in code so
  it is deterministic, unit-tested and explainable. Actual assignment still goes
  through the existing public.assign_technician_to_job() RPC, which keeps
  enforcing capacity and the compliance gate on the server.

  What was missing is the evidence trail enterprise buyers and insurers ask for:
  "why was this technician sent, what did the system expect, and who approved it?"

  ## What this adds
  - dispatch_decisions: append-only record written each time a person applies an
    AI recommendation (score, per-factor breakdown, planned arrival, travel time,
    SLA outcome, risk level/decision at that moment, who applied it).
    Select + insert only: no update, no delete for users.

  ## Security
  RLS scoped with public.get_account_owner_id(), same as every tenant table.
  Nothing here changes assignment behaviour or existing tables.
*/

CREATE TABLE IF NOT EXISTS dispatch_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  engine_version text NOT NULL,
  source text NOT NULL DEFAULT 'ai_plan' CHECK (source IN ('ai_plan', 'ai_plan_bulk')),

  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  planned_arrival_at timestamptz,
  travel_minutes numeric(7,1),
  route_sequence smallint,
  sla_breach boolean NOT NULL DEFAULT false,

  risk_level text CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  risk_decision text
    CHECK (risk_decision IS NULL OR risk_decision IN ('clear', 'conditions', 'manager_review', 'refer_to_insurer', 'hold')),

  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_job
  ON dispatch_decisions(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_user_created
  ON dispatch_decisions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_technician
  ON dispatch_decisions(technician_id, created_at DESC);

ALTER TABLE dispatch_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_dispatch_decisions ON dispatch_decisions;
CREATE POLICY select_own_dispatch_decisions ON dispatch_decisions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_dispatch_decisions ON dispatch_decisions;
CREATE POLICY insert_own_dispatch_decisions ON dispatch_decisions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND applied_by = auth.uid()
  );
