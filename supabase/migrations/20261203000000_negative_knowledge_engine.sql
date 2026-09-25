/*
  # Negative Knowledge Engine

  Learns from failures. Actions that end badly (an offer declined, a script that
  triggers opt-outs, a technician whose visits need callbacks, a time slot where
  jobs get cancelled) are stored as events. Rules are derived in code
  (src/lib/negativeKnowledge.ts) and stored here so the owner can see and dismiss them.

  - negative_events: append-only history. No update or delete policies.
  - negative_rules: derived, explainable rules. Dismissal survives refreshes.

  RLS: account-scoped via get_account_owner_id(), same as job_outcomes.
*/

CREATE TABLE IF NOT EXISTS negative_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  action_kind text NOT NULL
    CHECK (action_kind IN ('offer', 'script', 'technician', 'schedule')),
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 200),
  outcome text NOT NULL
    CHECK (outcome IN ('converted', 'completed', 'declined', 'opted_out', 'callback', 'cancelled')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negative_events_user_kind
  ON negative_events(user_id, action_kind, subject_key, recorded_at DESC);

CREATE TABLE IF NOT EXISTS negative_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  facet text NOT NULL,
  action_kind text NOT NULL
    CHECK (action_kind IN ('offer', 'script', 'technician', 'schedule')),
  subject_key text NOT NULL,
  scope text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('caution', 'avoid')),
  title text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, facet)
);

CREATE INDEX IF NOT EXISTS idx_negative_rules_user_status
  ON negative_rules(user_id, status, updated_at DESC);

-- RLS: events are append-only (select + insert). Rules are fully managed by the owner.

ALTER TABLE negative_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_negative_events ON negative_events;
CREATE POLICY select_own_negative_events ON negative_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_negative_events ON negative_events;
CREATE POLICY insert_own_negative_events ON negative_events
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

ALTER TABLE negative_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_negative_rules ON negative_rules;
CREATE POLICY select_own_negative_rules ON negative_rules
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS insert_own_negative_rules ON negative_rules;
CREATE POLICY insert_own_negative_rules ON negative_rules
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS update_own_negative_rules ON negative_rules;
CREATE POLICY update_own_negative_rules ON negative_rules
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS delete_own_negative_rules ON negative_rules;
CREATE POLICY delete_own_negative_rules ON negative_rules
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
