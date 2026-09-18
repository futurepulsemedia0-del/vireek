/*
  # Financial Cash-Flow Forecasting

  ## Why
  No table in this project tracks fixed/recurring overhead (rent,
  insurance, payroll base, software) — everything else (jobs, payment
  requests, memberships, quotes) already exists and is reused as-is.
  This migration adds ONLY what's missing: a manual fixed-expense
  ledger, per-account forecasting settings, and a snapshot log so a
  computed 13-week forecast can be reloaded instantly instead of
  recomputed on every page visit.

  ## Security
  RLS scoped with `public.get_account_owner_id()`, matching every other
  tenant-scoped table in this project.
*/

CREATE TABLE IF NOT EXISTS cash_flow_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),

  starting_cash_balance numeric(12,2) NOT NULL DEFAULT 0,
  default_cost_ratio numeric(5,2) NOT NULL DEFAULT 55,   -- % of committed inflow assumed as variable cost, used only when job_profitability data is insufficient
  quote_win_rate numeric(5,2) NOT NULL DEFAULT 25,        -- % applied to open quotes for the "optimistic" pipeline line

  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cash_flow_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_cash_flow_settings" ON cash_flow_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_cash_flow_settings" ON cash_flow_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_cash_flow_settings" ON cash_flow_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS cash_flow_fixed_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  name text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  frequency text NOT NULL CHECK (frequency IN ('one_time', 'weekly', 'biweekly', 'monthly')),
  next_due_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_expenses_user_active
  ON cash_flow_fixed_expenses(user_id, active);

ALTER TABLE cash_flow_fixed_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_cash_flow_expenses" ON cash_flow_fixed_expenses
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_cash_flow_expenses" ON cash_flow_fixed_expenses
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "update_own_cash_flow_expenses" ON cash_flow_fixed_expenses
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_cash_flow_expenses" ON cash_flow_fixed_expenses
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS cash_flow_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  starting_balance numeric(12,2) NOT NULL,
  weeks jsonb NOT NULL,       -- array of 13 { week_index, week_start, week_end, committed_inflow, pipeline_inflow, fixed_outflow, variable_outflow, net_committed, projected_balance_committed, projected_balance_optimistic }
  narrative jsonb NOT NULL DEFAULT '[]', -- AI-generated risk/opportunity flags, grounded strictly in the weeks above
  cost_ratio_used numeric(5,2),
  cost_ratio_source text NOT NULL DEFAULT 'default' CHECK (cost_ratio_source IN ('actual', 'default')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_snapshots_user_created
  ON cash_flow_snapshots(user_id, created_at DESC);

ALTER TABLE cash_flow_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_cash_flow_snapshots" ON cash_flow_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
CREATE POLICY "insert_own_cash_flow_snapshots" ON cash_flow_snapshots
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
CREATE POLICY "delete_own_cash_flow_snapshots" ON cash_flow_snapshots
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
