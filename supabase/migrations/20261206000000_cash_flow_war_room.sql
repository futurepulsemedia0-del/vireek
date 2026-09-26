/*
  # Cash Flow War Room

  ## Why
  cash_flow_snapshots already computes a 13-week committed/optimistic
  forecast. This migration adds ONLY the "what do I do about it" layer:
  a generated battle-plan (severity, runway, ranked recovery actions)
  and a per-user log of which of those actions have been worked/dismissed.
  No existing table is altered.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project.
*/

CREATE TABLE IF NOT EXISTS cash_flow_war_room_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  snapshot_id uuid REFERENCES cash_flow_snapshots(id) ON DELETE SET NULL,

  severity text NOT NULL CHECK (severity IN ('safe', 'watch', 'critical')),
  runway_weeks smallint,
  shortfall_amount numeric(12,2) NOT NULL DEFAULT 0,
  ai_summary text NOT NULL DEFAULT '',
  actions jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_war_room_plans_user_created
  ON cash_flow_war_room_plans(user_id, created_at DESC);

ALTER TABLE cash_flow_war_room_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_cash_flow_war_room_plans" ON cash_flow_war_room_plans
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_cash_flow_war_room_plans" ON cash_flow_war_room_plans
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_cash_flow_war_room_plans" ON cash_flow_war_room_plans
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS cash_flow_war_room_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  plan_id uuid NOT NULL REFERENCES cash_flow_war_room_plans(id) ON DELETE CASCADE,
  action_index smallint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dismissed')),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (plan_id, action_index)
);

ALTER TABLE cash_flow_war_room_action_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_cash_flow_war_room_action_log" ON cash_flow_war_room_action_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_cash_flow_war_room_action_log" ON cash_flow_war_room_action_log
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_cash_flow_war_room_action_log" ON cash_flow_war_room_action_log
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
