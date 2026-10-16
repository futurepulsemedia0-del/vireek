/*
  # Budgets — monthly budgets by category, budget-vs-actual variance, alerts

  ## Why
  Accounting (20261203000001_accounting_general_ledger.sql) records what was
  actually spent, but there is no way to say what *should* be spent. This
  migration adds monthly budgets per expense category (a category is an
  expense account in chart_of_accounts, so "actual" is always the real
  posted ledger — never a second source of truth).

  ## What this adds
  1. `budgets` — one row per (account, month): amount + warning threshold.
  2. `budget_alert_log` — dedupes alerts so each budget fires at most one
     'warning' and one 'over' notification until its amount/threshold changes.
  3. RPCs (SECURITY DEFINER, all scoped by get_account_owner_id()):
     upsert_budget, delete_budget, copy_budgets_from_previous_month,
     get_budget_variance, get_budget_trend, sync_budget_alerts.

  ## Permissions
  Viewing needs can_view_billing (owner always passes; custom role overrides
  the team member's base flags, same as the client AuthContext). Editing needs
  owner OR (can_view_billing AND can_edit_business_profile). Enforced in the
  database, not just the UI: the SELECT policy and every RPC check it.
  No client INSERT/UPDATE/DELETE policies — writes only via the RPCs.
*/

-- =============================================================
-- Permission helper (mirrors client-side effective permissions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.budget_has_permission(p_flag text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR COALESCE((
      SELECT COALESCE(
        (cr.permissions ->> p_flag)::boolean,
        (tm.permissions ->> p_flag)::boolean,
        false
      )
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    ), false);
$$;

GRANT EXECUTE ON FUNCTION public.budget_has_permission(text) TO authenticated;

CREATE OR REPLACE FUNCTION public._budget_owner(p_edit boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.budget_has_permission('can_view_billing') THEN
    RAISE EXCEPTION 'You do not have permission to view budgets' USING ERRCODE = '42501';
  END IF;
  IF p_edit
     AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
     AND NOT public.budget_has_permission('can_edit_business_profile') THEN
    RAISE EXCEPTION 'You do not have permission to edit budgets' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

-- Internal helper: not callable from the client.
REVOKE ALL ON FUNCTION public._budget_owner(boolean) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- BUDGETS
-- =============================================================
CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000000),
  warn_at_pct smallint NOT NULL DEFAULT 80 CHECK (warn_at_pct BETWEEN 1 AND 100),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_month, account_id)
);

CREATE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets(user_id, period_month);
CREATE INDEX IF NOT EXISTS idx_budgets_account ON budgets(account_id);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_budgets" ON budgets;
CREATE POLICY "select_own_budgets" ON budgets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.budget_has_permission('can_view_billing'));
-- No client INSERT/UPDATE/DELETE — only the RPCs below.

-- =============================================================
-- BUDGET_ALERT_LOG
-- =============================================================
CREATE TABLE IF NOT EXISTS budget_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('warning', 'over')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, level)
);

CREATE INDEX IF NOT EXISTS idx_budget_alert_log_user ON budget_alert_log(user_id);

ALTER TABLE budget_alert_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_budget_alert_log" ON budget_alert_log;
CREATE POLICY "select_own_budget_alert_log" ON budget_alert_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.budget_has_permission('can_view_billing'));

-- =============================================================
-- RPC: upsert_budget
-- =============================================================
CREATE OR REPLACE FUNCTION public.upsert_budget(
  p_month date,
  p_account_id uuid,
  p_amount_cents bigint,
  p_warn_at_pct integer DEFAULT 80,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._budget_owner(true);
  v_month date := date_trunc('month', COALESCE(p_month, current_date))::date;
  v_id uuid;
  v_old_amount bigint;
  v_old_pct smallint;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents < 0 THEN
    RAISE EXCEPTION 'Budget amount must be zero or greater';
  END IF;
  IF p_warn_at_pct IS NULL OR p_warn_at_pct NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Warning threshold must be between 1 and 100';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chart_of_accounts
    WHERE id = p_account_id AND user_id = v_owner AND type = 'expense' AND is_active
  ) THEN
    RAISE EXCEPTION 'Category must be an active expense account on this account';
  END IF;

  SELECT amount_cents, warn_at_pct INTO v_old_amount, v_old_pct
  FROM budgets WHERE user_id = v_owner AND period_month = v_month AND account_id = p_account_id;

  INSERT INTO budgets (user_id, period_month, account_id, amount_cents, warn_at_pct, notes, created_by, updated_by)
  VALUES (v_owner, v_month, p_account_id, p_amount_cents, p_warn_at_pct::smallint, NULLIF(btrim(p_notes), ''), auth.uid(), auth.uid())
  ON CONFLICT (user_id, period_month, account_id) DO UPDATE SET
    amount_cents = EXCLUDED.amount_cents,
    warn_at_pct = EXCLUDED.warn_at_pct,
    notes = EXCLUDED.notes,
    updated_by = auth.uid(),
    updated_at = now()
  RETURNING id INTO v_id;

  -- Changing the amount or threshold re-arms alerts for this budget.
  IF v_old_amount IS DISTINCT FROM p_amount_cents OR v_old_pct IS DISTINCT FROM p_warn_at_pct::smallint THEN
    DELETE FROM budget_alert_log WHERE budget_id = v_id;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_budget(date, uuid, bigint, integer, text) TO authenticated;

-- =============================================================
-- RPC: delete_budget
-- =============================================================
CREATE OR REPLACE FUNCTION public.delete_budget(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public._budget_owner(true);
BEGIN
  DELETE FROM budgets WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found or not authorized'; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_budget(uuid) TO authenticated;

-- =============================================================
-- RPC: copy_budgets_from_previous_month — never overwrites existing lines
-- =============================================================
CREATE OR REPLACE FUNCTION public.copy_budgets_from_previous_month(p_month date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._budget_owner(true);
  v_month date := date_trunc('month', COALESCE(p_month, current_date))::date;
  v_prev date := (date_trunc('month', COALESCE(p_month, current_date)) - interval '1 month')::date;
  v_count integer;
BEGIN
  INSERT INTO budgets (user_id, period_month, account_id, amount_cents, warn_at_pct, notes, created_by, updated_by)
  SELECT b.user_id, v_month, b.account_id, b.amount_cents, b.warn_at_pct, b.notes, auth.uid(), auth.uid()
  FROM budgets b
  JOIN chart_of_accounts c ON c.id = b.account_id AND c.is_active
  WHERE b.user_id = v_owner AND b.period_month = v_prev
  ON CONFLICT (user_id, period_month, account_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.copy_budgets_from_previous_month(date) TO authenticated;

-- =============================================================
-- RPC: get_budget_variance — budget vs posted-ledger actuals for a month.
-- Includes expense accounts with spend but no budget ('unbudgeted').
-- variance_cents = budget - actual (negative = overspent).
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_budget_variance(p_month date DEFAULT current_date)
RETURNS TABLE (
  budget_id uuid,
  account_id uuid,
  account_code text,
  account_name text,
  budget_cents bigint,
  actual_cents bigint,
  variance_cents bigint,
  pct_used numeric,
  warn_at_pct integer,
  status text,
  notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._budget_owner(false);
  v_start date := date_trunc('month', COALESCE(p_month, current_date))::date;
  v_end date := (date_trunc('month', COALESCE(p_month, current_date)) + interval '1 month - 1 day')::date;
BEGIN
  RETURN QUERY
  WITH actuals AS (
    SELECT jl.account_id AS acct, COALESCE(SUM(jl.debit_cents - jl.credit_cents), 0)::bigint AS spent
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
      AND je.status = 'posted' AND je.entry_date BETWEEN v_start AND v_end
    WHERE je.user_id = v_owner
    GROUP BY jl.account_id
  ),
  merged AS (
    SELECT b.id AS bid, b.account_id AS acct, b.amount_cents AS bud, b.warn_at_pct AS warn, b.notes AS nts
    FROM budgets b
    WHERE b.user_id = v_owner AND b.period_month = v_start
    UNION ALL
    SELECT NULL::uuid, a.acct, 0::bigint, 80::smallint, NULL::text
    FROM actuals a
    WHERE a.spent > 0
      AND NOT EXISTS (SELECT 1 FROM budgets b2
                      WHERE b2.user_id = v_owner AND b2.period_month = v_start AND b2.account_id = a.acct)
  )
  SELECT
    m.bid,
    c.id,
    c.code,
    c.name,
    m.bud,
    COALESCE(a.spent, 0)::bigint,
    (m.bud - COALESCE(a.spent, 0))::bigint,
    CASE WHEN m.bud > 0 THEN round(COALESCE(a.spent, 0) * 100.0 / m.bud, 1) ELSE NULL END,
    m.warn::integer,
    CASE
      WHEN m.bid IS NULL THEN 'unbudgeted'
      WHEN COALESCE(a.spent, 0) > m.bud THEN 'over'
      WHEN m.bud > 0 AND COALESCE(a.spent, 0) * 100.0 / m.bud >= m.warn THEN 'warning'
      ELSE 'on_track'
    END,
    m.nts
  FROM merged m
  JOIN chart_of_accounts c ON c.id = m.acct AND c.user_id = v_owner AND c.type = 'expense'
  LEFT JOIN actuals a ON a.acct = m.acct
  ORDER BY c.code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_budget_variance(date) TO authenticated;

-- =============================================================
-- RPC: get_budget_trend — totals per month for the trailing window
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_budget_trend(p_end_month date DEFAULT current_date, p_months integer DEFAULT 6)
RETURNS TABLE (period_month date, budget_cents bigint, actual_cents bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._budget_owner(false);
  v_end date := date_trunc('month', COALESCE(p_end_month, current_date))::date;
  v_n integer := LEAST(GREATEST(COALESCE(p_months, 6), 1), 24);
  v_first date;
BEGIN
  v_first := (v_end - make_interval(months => v_n - 1))::date;
  RETURN QUERY
  SELECT
    gs::date,
    COALESCE((SELECT SUM(b.amount_cents) FROM budgets b
              WHERE b.user_id = v_owner AND b.period_month = gs::date), 0)::bigint,
    COALESCE((SELECT SUM(jl.debit_cents - jl.credit_cents)
              FROM journal_lines jl
              JOIN journal_entries je ON je.id = jl.journal_entry_id
              JOIN chart_of_accounts c ON c.id = jl.account_id AND c.type = 'expense'
              WHERE je.user_id = v_owner AND je.status = 'posted'
                AND je.entry_date >= gs::date
                AND je.entry_date < (gs + interval '1 month')::date), 0)::bigint
  FROM generate_series(v_first::timestamp, v_end::timestamp, interval '1 month') AS gs
  ORDER BY 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_budget_trend(date, integer) TO authenticated;

-- =============================================================
-- RPC: sync_budget_alerts — raises a notification the first time a budget
-- crosses its warning threshold or goes over. Idempotent; safe to call on
-- every page load. Returns the number of notifications created.
-- =============================================================
CREATE OR REPLACE FUNCTION public.sync_budget_alerts(p_month date DEFAULT current_date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._budget_owner(false);
  v_month date := date_trunc('month', COALESCE(p_month, current_date))::date;
  r record;
  v_logged uuid;
  v_created integer := 0;
BEGIN
  -- Only the current month raises notifications (past/future views are read-only).
  IF v_month <> date_trunc('month', current_date)::date THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT v.budget_id, v.account_name, v.budget_cents, v.actual_cents, v.status, v.pct_used
    FROM public.get_budget_variance(v_month) v
    WHERE v.status IN ('warning', 'over') AND v.budget_id IS NOT NULL
  LOOP
    INSERT INTO budget_alert_log (user_id, budget_id, level)
    VALUES (v_owner, r.budget_id, r.status)
    ON CONFLICT (budget_id, level) DO NOTHING
    RETURNING id INTO v_logged;

    IF v_logged IS NOT NULL THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (
        v_owner,
        'budget_alert',
        CASE WHEN r.status = 'over' THEN r.account_name || ' is over budget' ELSE r.account_name || ' is nearing its budget' END,
        format('%s: $%s spent of $%s budget%s.',
               r.account_name,
               to_char(r.actual_cents / 100.0, 'FM999,999,999,990.00'),
               to_char(r.budget_cents / 100.0, 'FM999,999,999,990.00'),
               CASE WHEN r.pct_used IS NOT NULL THEN ' (' || r.pct_used::text || '%)' ELSE '' END),
        '/dashboard/budgets'
      );
      v_created := v_created + 1;
    END IF;
    v_logged := NULL;
  END LOOP;

  RETURN v_created;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_budget_alerts(date) TO authenticated;
