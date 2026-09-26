/*
  # Business Immune System

  ## What this is
  A meta-layer above the individual "Intelligence" agents already in
  this project (Service Recovery, Margin Guardrail, etc.) that looks
  for deterministic, statistically-grounded anomalies across five
  categories:
    - revenue_shock          — booking volume collapses vs its own baseline
    - reputation_threat      — negative sentiment / critical service-recovery
                                signals spike
    - operational_overload   — missed-call rate spikes
    - financial_irregularity — margin-floor overrides spike
    - integration_failure    — a connected integration enters `error`

  No LLM call, no guesswork — same deterministic idiom as
  check-margin-guardrail / analyze-equipment-lifecycle: every threshold
  is a trailing baseline computed from the account's own history,
  tunable per-account via business_immune_settings.sensitivity.

  ## Does NOT build a parallel ledger
  Detectors read directly from jobs, calls, service_recovery_signals,
  margin_guardrail_checks and integrations. This migration only adds
  the signal queue itself, its audit trail, and per-account settings.

  ## Containment
  Soft containment (in-app notification + optional SMS page to the
  owner via the existing escalation_phone) fires automatically. Hard
  containment (pausing a specific automation in workflow_definitions)
  is always a one-click, human-confirmed action from the dashboard —
  this migration does not let the scanner mutate workflow_definitions
  on its own.

  ## IMPORTANT — read before applying
  This assumes `profiles`, `jobs`, `calls`, `service_recovery_signals`,
  `margin_guardrail_checks`, `integrations`, `workflow_definitions`,
  `notifications` and the `public.get_account_owner_id()` /
  `public.append_activity_event()` helpers already exist in your
  current database (they do, per every migration this project already
  shipped). If any of those have been renamed since the zip you gave
  me, adjust the references below before running.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy business-immune-scan --no-verify-jwt
    3. Point your existing external cron at business-immune-scan too,
       every 30-60 minutes — same header/secret convention you already
       use for your other scheduled functions.
    4. Apply the four code edits delivered alongside this migration.
*/

-- =============================================================
-- 1. Signal queue
-- =============================================================

CREATE TABLE IF NOT EXISTS business_immune_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  category text NOT NULL CHECK (category IN (
    'revenue_shock', 'reputation_threat', 'operational_overload',
    'financial_irregularity', 'integration_failure'
  )),
  detector text NOT NULL,

  severity_score smallint NOT NULL DEFAULT 50 CHECK (severity_score BETWEEN 0 AND 100),

  title text NOT NULL,
  detail text,
  metric_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb,

  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'acknowledged', 'contained', 'resolved', 'dismissed'
  )),
  resolved_outcome text CHECK (resolved_outcome IN ('true_positive', 'false_positive')),

  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  contained_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only one *active* signal per detector at a time — re-scans while a
-- threat is still open simply find it instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_immune_signals_active_detector
  ON business_immune_signals(user_id, detector)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_immune_signals_user_id ON business_immune_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_immune_signals_status ON business_immune_signals(status);
CREATE INDEX IF NOT EXISTS idx_immune_signals_detected_at ON business_immune_signals(detected_at DESC);

ALTER TABLE business_immune_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_immune_signals" ON business_immune_signals;
CREATE POLICY "select_own_immune_signals"
ON business_immune_signals FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_immune_signals" ON business_immune_signals;
CREATE POLICY "update_own_immune_signals"
ON business_immune_signals FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

-- No client INSERT policy: signals are created exclusively by the
-- business-immune-scan Edge Function (service role), so a compromised
-- client session can never fabricate a threat.

-- =============================================================
-- 2. Audit trail — every action taken against a signal, auto or manual
-- =============================================================

CREATE TABLE IF NOT EXISTS business_immune_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  signal_id uuid NOT NULL REFERENCES business_immune_signals(id) ON DELETE CASCADE,

  action_type text NOT NULL CHECK (action_type IN (
    'notified_owner', 'paged_owner_sms', 'automation_paused',
    'acknowledged', 'contained', 'resolved', 'dismissed', 'note_added'
  )),
  actor text NOT NULL DEFAULT 'system' CHECK (actor IN ('system', 'user')),
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_immune_actions_signal_id ON business_immune_actions(signal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_immune_actions_user_id ON business_immune_actions(user_id);

ALTER TABLE business_immune_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_immune_actions" ON business_immune_actions;
CREATE POLICY "select_own_immune_actions"
ON business_immune_actions FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_immune_actions" ON business_immune_actions;
CREATE POLICY "insert_own_immune_actions"
ON business_immune_actions FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id() AND actor = 'user');

-- =============================================================
-- 3. Per-account settings
-- =============================================================

CREATE TABLE IF NOT EXISTS business_immune_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  sensitivity text NOT NULL DEFAULT 'standard' CHECK (sensitivity IN ('low', 'standard', 'high')),
  notify_critical_via_sms boolean NOT NULL DEFAULT true,
  muted_categories text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_immune_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_immune_settings" ON business_immune_settings;
CREATE POLICY "manage_own_immune_settings"
ON business_immune_settings FOR ALL
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. Link notifications back to a signal (same idiom as every other
--    feature's nullable FK column on the shared notifications table)
-- =============================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS business_immune_signal_id uuid REFERENCES business_immune_signals(id) ON DELETE SET NULL;
