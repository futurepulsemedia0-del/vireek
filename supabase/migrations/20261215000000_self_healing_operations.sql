/*
  # Self-Healing Operations (Autonomous Service Recovery)

  ## Why
  service_recovery_signals (20261126000000) already DETECTS the four
  early warning signs of an unhappy customer. What happens next today
  is either fully manual, or a semi-autonomous workflow_definitions
  playbook that stops at a human_approval gate (see
  'service-recovery-eta-missed' / 'service-recovery-technician-delayed'
  in src/lib/workflowPlaybooks.ts) before it will actually text the
  customer.

  This migration adds the closed loop that runs WITHOUT waiting on a
  human for the two time-critical signals — a technician who is late
  or hasn't left yet:

    DETECT -> PREDICT -> DECIDE -> ACT -> VERIFY

  self_healing_incidents is one row per service_recovery_signals row
  that the self-healing-orchestrator Edge Function has taken ownership
  of. self_healing_actions is the append-only log of every concrete
  thing the orchestrator actually did (notify, reassign, reschedule,
  reserve parts, hand off to the contractor network) so a human can
  audit exactly what an autonomous agent did to their business and
  when.

  This is deliberately a SEPARATE table from
  operations_center_problems (20261207000000) — that table tracks
  human-owned problems with a human `owner_id` and free-text
  `action_plan`. This one tracks a fully machine-run loop with a
  structured, typed action log. Different shape for a different job;
  they are not meant to merge.

  ## Stage lifecycle (self_healing_incidents.stage)
  - detecting            — row just created from a signal, about to run predict/decide/act
  - acting               — predict + decide are recorded (risk_score, risk_tier,
                            predicted_impact, decision), actions are being executed
  - awaiting_verification — every planned action has been attempted; waiting
                            VERIFY_AFTER_MINUTES before checking the real outcome
  - resolved              — verify pass ran; outcome is set (recovered / partial / failed)

  ## Security
  Same posture as service_recovery_signals: RLS scoped to
  get_account_owner_id() for SELECT only. No INSERT/UPDATE policy for
  `authenticated` — rows are written exclusively by the
  self-healing-orchestrator Edge Function's service-role client, so a
  compromised client session can neither fabricate an incident nor
  rewrite what the agent actually did.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy self-healing-orchestrator --no-verify-jwt
    3. Point your existing cron at it too (same X-Cron-Secret / CRON_SECRET
       already used by service-recovery-agent), every 10 minutes.
    4. Apply the client-side edits delivered alongside this migration.
*/

-- =============================================================
-- 1. One small additive column jobs didn't have yet: a persisted
--    stop order so a route re-optimization actually sticks instead
--    of being recomputed differently every time the dashboard loads.
--    Nothing existing reads or depends on this yet — it's additive.
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS route_sequence integer;

-- =============================================================
-- 2. self_healing_incidents
-- =============================================================

CREATE TABLE IF NOT EXISTS self_healing_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  signal_id uuid NOT NULL REFERENCES service_recovery_signals(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,

  incident_type text NOT NULL CHECK (incident_type IN ('technician_delayed', 'eta_missed')),

  stage text NOT NULL DEFAULT 'detecting' CHECK (stage IN (
    'detecting', 'acting', 'awaiting_verification', 'resolved'
  )),

  -- PREDICT
  risk_score smallint CHECK (risk_score BETWEEN 0 AND 100),
  risk_tier text CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
  predicted_impact jsonb NOT NULL DEFAULT '{}',

  -- DECIDE
  decision jsonb NOT NULL DEFAULT '{}',
  coordination_bid_id uuid,

  -- VERIFY
  outcome text CHECK (outcome IN ('recovered', 'partial', 'failed')),
  outcome_note text,
  verified_at timestamptz,

  detected_at timestamptz NOT NULL DEFAULT now(),
  acted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (signal_id)
);

CREATE INDEX IF NOT EXISTS idx_self_healing_incidents_user_id ON self_healing_incidents(user_id);
CREATE INDEX IF NOT EXISTS idx_self_healing_incidents_stage ON self_healing_incidents(stage);
CREATE INDEX IF NOT EXISTS idx_self_healing_incidents_job_id ON self_healing_incidents(job_id);
CREATE INDEX IF NOT EXISTS idx_self_healing_incidents_detected_at ON self_healing_incidents(detected_at DESC);

ALTER TABLE self_healing_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_self_healing_incidents" ON self_healing_incidents;
CREATE POLICY "select_own_self_healing_incidents"
ON self_healing_incidents FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- No INSERT/UPDATE policy on purpose — only the self-healing-orchestrator
-- Edge Function (service role) writes these rows.

-- =============================================================
-- 3. self_healing_actions — append-only execution log
-- =============================================================

CREATE TABLE IF NOT EXISTS self_healing_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES self_healing_incidents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,

  action_type text NOT NULL CHECK (action_type IN (
    'notify_customer', 'reassign_technician', 'reoptimize_route',
    'reschedule_downstream', 'reserve_parts', 'activate_contractor_network',
    'offer_customer_options'
  )),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'skipped', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}',

  executed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_self_healing_actions_incident_id ON self_healing_actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_self_healing_actions_user_id ON self_healing_actions(user_id);

ALTER TABLE self_healing_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_self_healing_actions" ON self_healing_actions;
CREATE POLICY "select_own_self_healing_actions"
ON self_healing_actions FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- No INSERT/UPDATE policy on purpose — service role only.
