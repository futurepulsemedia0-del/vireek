/*
  # Getting Started — per-person checklist + product-tour state

  ## Why
  /dashboard/getting-started shows a setup checklist whose completion is
  AUTO-DETECTED from real account data (profile, numbers, customers, jobs...).
  The only thing that cannot be derived is per-person intent: has THIS person
  finished/skipped the first-run tour, dismissed the checklist, or chosen to
  skip an optional step. That is what this table stores.

  ## What this does
  Adds ONE new table. Purely additive — no existing table, column, policy or
  function is touched. The client falls back to localStorage if this migration
  has not been applied yet, so the feature never breaks.

  ## Security
  One row per signed-in person (user_id = auth.uid()), so a team member's tour
  progress never overwrites the owner's. account_owner_id is stamped from
  public.get_account_owner_id() for reporting. RLS lets a person read and write
  only their own row; there is deliberately no DELETE policy.
*/

CREATE TABLE IF NOT EXISTS getting_started_progress (
  user_id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  tour_completed_at timestamptz,
  checklist_dismissed_at timestamptz,
  skipped_steps text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT getting_started_skipped_len CHECK (cardinality(skipped_steps) <= 30)
);

CREATE INDEX IF NOT EXISTS idx_getting_started_progress_owner
  ON getting_started_progress (account_owner_id);

ALTER TABLE getting_started_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_getting_started" ON getting_started_progress;
CREATE POLICY "select_own_getting_started" ON getting_started_progress
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_getting_started" ON getting_started_progress;
CREATE POLICY "insert_own_getting_started" ON getting_started_progress
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_getting_started" ON getting_started_progress;
CREATE POLICY "update_own_getting_started" ON getting_started_progress
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

GRANT EXECUTE ON FUNCTION public.get_account_owner_id() TO authenticated;

COMMENT ON TABLE getting_started_progress IS
  'Per-person state for /dashboard/getting-started: tour completion, checklist dismissal, skipped optional steps. Step completion itself is detected from live account data, never stored.';
