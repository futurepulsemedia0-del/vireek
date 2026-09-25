/*
  # Economic Autopilot

  ## Why
  Vireek already has many single-purpose economic tools (margin guardrails,
  underpriced-job detection, capacity/demand control, cash flow forecast,
  revenue recovery). This is the layer above them: a continuous loop that
  reads the company's core economic signals (revenue, cost, margin,
  capacity utilization, cash runway, overdue receivables), scores overall
  economic health, and — same rule-based, explainable philosophy as
  check_constitution() — turns threshold breaches into concrete,
  dollar-quantified recommended actions. Nothing executes itself; every
  action is approved by the owner and, once acted on in the real world,
  can be marked implemented with its *realized* impact, turning this into
  a running ledger of predicted vs. actual economic decisions.

  ## Loop
  log signals (economic_signals, fed by the owner or other systems) ->
  run_economic_autopilot() aggregates the last 30 days, computes a 0-100
  health score and a snapshot (economic_snapshots), and fires a fixed set
  of deterministic rules to produce economic_actions -> owner approves or
  dismisses (decide_economic_action) -> once acted on, mark_action_implemented
  records what actually happened.
*/

CREATE TABLE IF NOT EXISTS economic_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  signal_type text NOT NULL CHECK (signal_type IN (
    'revenue_cents', 'cost_cents', 'margin_pct', 'capacity_utilization_pct',
    'cash_runway_days', 'overdue_receivables_cents', 'discretionary_spend_cents'
  )),
  value numeric NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_es_user ON economic_signals(user_id, signal_type, recorded_at DESC);
ALTER TABLE economic_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_economic_signals" ON economic_signals;
CREATE POLICY "manage_own_economic_signals" ON economic_signals FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS economic_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  computed_at timestamptz NOT NULL DEFAULT now(),
  revenue_cents bigint,
  cost_cents bigint,
  margin_pct numeric,
  capacity_utilization_pct numeric,
  cash_runway_days numeric,
  overdue_receivables_cents bigint,
  health_score integer CHECK (health_score BETWEEN 0 AND 100),
  signals_used integer NOT NULL DEFAULT 0,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_esn_user ON economic_snapshots(user_id, computed_at DESC);
ALTER TABLE economic_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_economic_snapshots" ON economic_snapshots;
CREATE POLICY "select_own_economic_snapshots" ON economic_snapshots FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT — only run_economic_autopilot() writes here.

CREATE TABLE IF NOT EXISTS economic_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  snapshot_id uuid NOT NULL REFERENCES economic_snapshots(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('pricing', 'capacity', 'spend', 'collections', 'margin')),
  title text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  estimated_impact_cents bigint NOT NULL DEFAULT 0,
  urgency text NOT NULL CHECK (urgency IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed', 'implemented')),
  decision_reason text,
  decided_at timestamptz,
  implemented_at timestamptz,
  realized_impact_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ea_user ON economic_actions(user_id, status, created_at DESC);
ALTER TABLE economic_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_economic_actions" ON economic_actions;
CREATE POLICY "select_own_economic_actions" ON economic_actions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE — only run_economic_autopilot() / decide_economic_action() /
-- mark_action_implemented() below.

-- =============================================================
-- Log a signal (the "observe" step) — cents for money, plain numbers for %/days
-- =============================================================
CREATE OR REPLACE FUNCTION public.log_economic_signal(
  p_signal_type text, p_value numeric, p_period_start date, p_period_end date, p_source text DEFAULT 'manual'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  INSERT INTO economic_signals (user_id, signal_type, value, period_start, period_end, source)
  VALUES (v_owner, p_signal_type, p_value, p_period_start, p_period_end, p_source)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_economic_signal(text, numeric, date, date, text) TO authenticated, service_role;

-- =============================================================
-- THE AUTOPILOT: score health, then fire deterministic rules.
-- Every threshold lives here, in one place, so it can be read top to bottom.
-- =============================================================
CREATE OR REPLACE FUNCTION public.run_economic_autopilot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_snapshot_id uuid;
  v_revenue numeric; v_cost numeric; v_margin numeric; v_capacity numeric;
  v_runway numeric; v_overdue numeric; v_signal_count integer;
  v_score integer;
  v_actions_created integer := 0;
BEGIN
  SELECT
    max(value) FILTER (WHERE signal_type = 'revenue_cents'),
    max(value) FILTER (WHERE signal_type = 'cost_cents'),
    avg(value) FILTER (WHERE signal_type = 'margin_pct'),
    avg(value) FILTER (WHERE signal_type = 'capacity_utilization_pct'),
    avg(value) FILTER (WHERE signal_type = 'cash_runway_days'),
    max(value) FILTER (WHERE signal_type = 'overdue_receivables_cents'),
    count(*)
  INTO v_revenue, v_cost, v_margin, v_capacity, v_runway, v_overdue, v_signal_count
  FROM economic_signals
  WHERE user_id = v_owner AND recorded_at > now() - interval '30 days';

  -- Deterministic 0-100 health score: 4 components, 25 points each, only
  -- scored when that signal is present (missing signals don't drag the score).
  v_score := 0;
  DECLARE v_parts integer := 0;
  BEGIN
    IF v_margin IS NOT NULL THEN
      v_score := v_score + LEAST(25, GREATEST(0, round(v_margin / 40 * 25)));
      v_parts := v_parts + 1;
    END IF;
    IF v_capacity IS NOT NULL THEN
      -- Best near 80-85% utilization; too low wastes capacity, too high risks burnout/SLA.
      v_score := v_score + GREATEST(0, 25 - round(abs(v_capacity - 82) / 82 * 25 * 2));
      v_parts := v_parts + 1;
    END IF;
    IF v_runway IS NOT NULL THEN
      v_score := v_score + LEAST(25, GREATEST(0, round(v_runway / 90 * 25)));
      v_parts := v_parts + 1;
    END IF;
    IF v_revenue IS NOT NULL AND v_overdue IS NOT NULL AND v_revenue > 0 THEN
      v_score := v_score + GREATEST(0, 25 - round((v_overdue / v_revenue) * 100));
      v_parts := v_parts + 1;
    END IF;
    IF v_parts > 0 THEN v_score := round(v_score * 4.0 / v_parts); END IF;
    v_score := LEAST(100, GREATEST(0, COALESCE(v_score, 0)));
  END;

  INSERT INTO economic_snapshots (
    user_id, revenue_cents, cost_cents, margin_pct, capacity_utilization_pct,
    cash_runway_days, overdue_receivables_cents, health_score, signals_used,
    notes
  ) VALUES (
    v_owner, v_revenue, v_cost, v_margin, v_capacity, v_runway, v_overdue,
    v_score, COALESCE(v_signal_count, 0),
    format('Computed from %s signal(s) logged in the last 30 days.', COALESCE(v_signal_count, 0))
  ) RETURNING id INTO v_snapshot_id;

  -- Rule: margin below floor -> margin action
  IF v_margin IS NOT NULL AND v_margin < 18 THEN
    INSERT INTO economic_actions (user_id, snapshot_id, category, title, rationale, evidence, estimated_impact_cents, urgency)
    VALUES (v_owner, v_snapshot_id, 'margin', 'Margin is below a healthy floor',
      format('Average margin over the last 30 days is %s%%, below the 18%% floor. Review discounting and underpriced job types before volume grows further.', round(v_margin, 1)),
      jsonb_build_object('margin_pct', round(v_margin, 1), 'floor_pct', 18),
      COALESCE(round(v_revenue * (18 - v_margin) / 100), 0), 'high');
    v_actions_created := v_actions_created + 1;
  END IF;

  -- Rule: capacity overloaded -> capacity action
  IF v_capacity IS NOT NULL AND v_capacity > 92 THEN
    INSERT INTO economic_actions (user_id, snapshot_id, category, title, rationale, evidence, estimated_impact_cents, urgency)
    VALUES (v_owner, v_snapshot_id, 'capacity', 'Technician capacity is overloaded',
      format('Utilization is averaging %s%%, above the 92%% safe ceiling — SLA and burnout risk. Consider overtime, a contractor pull-in, or pausing demand campaigns.', round(v_capacity, 1)),
      jsonb_build_object('capacity_utilization_pct', round(v_capacity, 1), 'ceiling_pct', 92), 0, 'high');
    v_actions_created := v_actions_created + 1;
  END IF;

  -- Rule: capacity underused -> pricing/demand action
  IF v_capacity IS NOT NULL AND v_capacity < 55 THEN
    INSERT INTO economic_actions (user_id, snapshot_id, category, title, rationale, evidence, estimated_impact_cents, urgency)
    VALUES (v_owner, v_snapshot_id, 'pricing', 'Spare capacity is going unbooked',
      format('Utilization is averaging %s%%, below the 55%% floor. Demand campaigns or a short-term price incentive could convert idle hours into revenue.', round(v_capacity, 1)),
      jsonb_build_object('capacity_utilization_pct', round(v_capacity, 1), 'floor_pct', 55), 0, 'medium');
    v_actions_created := v_actions_created + 1;
  END IF;

  -- Rule: cash runway short -> collections action
  IF v_runway IS NOT NULL AND v_runway < 30 THEN
    INSERT INTO economic_actions (user_id, snapshot_id, category, title, rationale, evidence, estimated_impact_cents, urgency)
    VALUES (v_owner, v_snapshot_id, 'collections', 'Cash runway is under 30 days',
      format('Runway is averaging %s days. Prioritize collections and hold discretionary spend until this recovers.', round(v_runway, 1)),
      jsonb_build_object('cash_runway_days', round(v_runway, 1), 'floor_days', 30), 0, 'high');
    v_actions_created := v_actions_created + 1;
  END IF;

  -- Rule: overdue receivables are a large share of revenue -> collections action
  IF v_revenue IS NOT NULL AND v_revenue > 0 AND v_overdue IS NOT NULL AND (v_overdue / v_revenue) > 0.08 THEN
    INSERT INTO economic_actions (user_id, snapshot_id, category, title, rationale, evidence, estimated_impact_cents, urgency)
    VALUES (v_owner, v_snapshot_id, 'collections', 'Overdue receivables are eating into cash',
      format('Overdue receivables are %s%% of revenue (above the 8%% threshold). Chasing these recovers cash without any new sales.', round((v_overdue / v_revenue) * 100, 1)),
      jsonb_build_object('overdue_receivables_cents', v_overdue, 'revenue_cents', v_revenue, 'pct_of_revenue', round((v_overdue / v_revenue) * 100, 1)),
      round(v_overdue), 'medium');
    v_actions_created := v_actions_created + 1;
  END IF;

  RETURN jsonb_build_object('snapshot_id', v_snapshot_id, 'health_score', v_score, 'actions_created', v_actions_created, 'signals_used', COALESCE(v_signal_count, 0));
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_economic_autopilot() TO authenticated;

-- =============================================================
-- Human decision on a recommended action (always logged)
-- =============================================================
CREATE OR REPLACE FUNCTION public.decide_economic_action(p_action_id uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF p_decision NOT IN ('approved', 'dismissed') THEN
    RAISE EXCEPTION 'Decision must be approved or dismissed';
  END IF;

  UPDATE economic_actions SET status = p_decision, decision_reason = p_reason, decided_at = now()
  WHERE id = p_action_id AND user_id = v_owner AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found, not authorized, or already decided';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_economic_action(uuid, text, text) TO authenticated;

-- =============================================================
-- Close the loop: record what actually happened once the owner acted on it
-- =============================================================
CREATE OR REPLACE FUNCTION public.mark_action_implemented(p_action_id uuid, p_realized_impact_cents bigint DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  UPDATE economic_actions SET status = 'implemented', implemented_at = now(), realized_impact_cents = p_realized_impact_cents
  WHERE id = p_action_id AND user_id = v_owner AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action not found, not authorized, or not yet approved';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_action_implemented(uuid, bigint) TO authenticated;
