/*
  # Workforce Equilibrium Engine

  ## Why
  Every home-service business either loses jobs to no available
  technician (missed revenue) or pays idle payroll (wasted cash) —
  usually both, in different skills, in the same month. This migration
  adds only the run log + action tracking. All supply/demand numbers
  are computed in the edge function directly from `team_members` and
  `jobs` — no new source-of-truth table.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project.
*/

CREATE TABLE IF NOT EXISTS workforce_equilibrium_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  horizon_weeks smallint NOT NULL DEFAULT 4,
  skill_gaps jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL DEFAULT '[]',
  ai_summary text NOT NULL DEFAULT '',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workforce_equilibrium_runs_user_created
  ON workforce_equilibrium_runs(user_id, created_at DESC);

ALTER TABLE workforce_equilibrium_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_workforce_equilibrium_runs" ON workforce_equilibrium_runs
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_workforce_equilibrium_runs" ON workforce_equilibrium_runs
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_workforce_equilibrium_runs" ON workforce_equilibrium_runs
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS workforce_equilibrium_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  run_id uuid NOT NULL REFERENCES workforce_equilibrium_runs(id) ON DELETE CASCADE,
  action_index smallint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dismissed')),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (run_id, action_index)
);

ALTER TABLE workforce_equilibrium_action_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_workforce_equilibrium_action_log" ON workforce_equilibrium_action_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_workforce_equilibrium_action_log" ON workforce_equilibrium_action_log
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_workforce_equilibrium_action_log" ON workforce_equilibrium_action_log
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
