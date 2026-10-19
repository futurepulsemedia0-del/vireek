/*
  # Product tours + contextual tips — per-person progress

  Stores, per signed-in person, the state of each role tour (in_progress /
  completed / skipped, current step, replay count) and which contextual tips
  they dismissed (tour_id = 'tip:<id>').

  Purely additive: one new table. The client falls back to localStorage when
  this migration has not been applied, so the feature never breaks.

  Security: a person reads/writes only their own rows. Account owners may also
  READ their team's tour rows (never tips) for completion reporting.
*/

CREATE TABLE IF NOT EXISTS product_tour_progress (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  tour_id text NOT NULL,
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'in_progress',
  step_index integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  skipped_at timestamptz,
  replay_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tour_id),
  CONSTRAINT product_tour_status_valid CHECK (status IN ('in_progress', 'completed', 'skipped')),
  CONSTRAINT product_tour_step_range CHECK (step_index BETWEEN 0 AND 100),
  CONSTRAINT product_tour_replay_range CHECK (replay_count >= 0),
  CONSTRAINT product_tour_id_format CHECK (tour_id ~ '^[a-z0-9:._-]{1,80}$')
);

CREATE INDEX IF NOT EXISTS idx_product_tour_progress_owner
  ON product_tour_progress (account_owner_id);

ALTER TABLE product_tour_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_product_tour" ON product_tour_progress;
CREATE POLICY "select_own_product_tour" ON product_tour_progress
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "owner_select_team_product_tour" ON product_tour_progress;
CREATE POLICY "owner_select_team_product_tour" ON product_tour_progress
  FOR SELECT TO authenticated
  USING (account_owner_id = auth.uid() AND tour_id NOT LIKE 'tip:%');

DROP POLICY IF EXISTS "insert_own_product_tour" ON product_tour_progress;
CREATE POLICY "insert_own_product_tour" ON product_tour_progress
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_product_tour" ON product_tour_progress;
CREATE POLICY "update_own_product_tour" ON product_tour_progress
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_product_tour" ON product_tour_progress;
CREATE POLICY "delete_own_product_tour" ON product_tour_progress
  FOR DELETE TO authenticated USING (user_id = auth.uid());

COMMENT ON TABLE product_tour_progress IS
  'Per-person product tour state (tour_id = role) and dismissed contextual tips (tour_id = tip:<id>).';
