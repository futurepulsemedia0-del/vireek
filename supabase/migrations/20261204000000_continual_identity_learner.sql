/*
  # Continual Identity Learner

  ## Why
  Every other AI layer in this project (Decision Engine, Causal
  Simulator, Regret Console) answers "what should I do." This one
  answers a different question: "who is this business owner, right
  now, based on what they actually DO — not what they said once at
  onboarding." Stated preferences go stale; revealed preferences
  (which recommendations they approve, whether they actually implement
  a simulated decision, how reversible the option they pick under
  uncertainty is, whether they trust automation enough to turn it on)
  don't go stale, and they drift as the owner themselves changes.

  ## Design
  - identity_observations: an append-style log of individual, already
    -scored signals extracted from real rows elsewhere in the product
    (business_decisions, causal_outcome_tracking, regret_console_decisions,
    business_decision_settings). Each row is one deterministic fact —
    never an AI guess — on a -100..100 scale for one of five
    dimensions. The UNIQUE constraint lets the scanning edge function
    upsert idempotently: re-running the scan never double-counts the
    same real event.
  - identity_drift_alerts: written only when a dimension's recent
    window (last 14 days) diverges from its own longer baseline
    window (previous ~90 days) by more than the drift threshold, with
    enough samples in both windows to mean something. This is where
    "the owner is not who they were" becomes a fact the product can
    show, not just a number.

  ## Security
  Same tenant-isolation pattern as every other feature here:
  `public.get_account_owner_id()` on every RLS policy.
  identity_observations is written only by the identity-signal-scan
  edge function's service-role client (RLS has no insert policy for
  authenticated, so a client could never fabricate its own signal).
  identity_drift_alerts allows the owner to update status (to
  acknowledge/dismiss an alert) but never to insert or backdate one.
*/

CREATE TABLE IF NOT EXISTS identity_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  source_type text NOT NULL CHECK (source_type IN (
    'business_decision', 'causal_outcome', 'regret_console', 'autonomy_setting'
  )),
  source_id text NOT NULL,
  dimension text NOT NULL CHECK (dimension IN (
    'growth_vs_stability', 'risk_tolerance', 'price_position', 'automation_trust', 'speed_vs_quality'
  )),

  signal numeric(6,2) NOT NULL,
  weight numeric(4,2) NOT NULL DEFAULT 1,
  note text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, source_type, source_id, dimension)
);

CREATE INDEX IF NOT EXISTS idx_identity_observations_user_dim_time
  ON identity_observations(user_id, dimension, observed_at DESC);

ALTER TABLE identity_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_identity_observations" ON identity_observations
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No insert/update/delete policy: only identity-signal-scan (service
-- role) ever writes here, so re-running the scan is the only way new
-- rows appear, and a client can never inject a fake signal.

CREATE TABLE IF NOT EXISTS identity_drift_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  dimension text NOT NULL CHECK (dimension IN (
    'growth_vs_stability', 'risk_tolerance', 'price_position', 'automation_trust', 'speed_vs_quality'
  )),
  baseline_value numeric(6,2) NOT NULL,
  recent_value numeric(6,2) NOT NULL,
  shift_magnitude numeric(6,2) NOT NULL,

  title text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'dismissed')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identity_drift_user_created
  ON identity_drift_alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_drift_user_status
  ON identity_drift_alerts(user_id, status);

ALTER TABLE identity_drift_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_identity_drift_alerts" ON identity_drift_alerts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_identity_drift_alerts" ON identity_drift_alerts
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
-- No insert/delete policy for authenticated: only identity-signal-scan
-- (service role) creates alerts — the owner may only acknowledge or
-- dismiss one that already exists, never plant or erase one.
