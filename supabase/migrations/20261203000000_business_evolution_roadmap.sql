/*
  # Business Evolution Roadmap

  Turns a single 12-month goal into a concrete, trackable roadmap across the
  seven levers that actually determine whether a service business can grow
  into that goal: organizational capability, capacity, data & systems,
  process maturity, technician skill, cash buffer, and customer mix.

  Design notes (read before wiring the UI):
  - This feature is intentionally self-contained. It does NOT read from
    fleet_economics / capacity_demand_control / technician_performance_os /
    cash_flow_forecast tables, because those table/column names are exactly
    the kind of thing that drifts between installs. Instead it ships a
    curated, editable milestone library that is seeded once per goal and
    then fully owned (edited/completed/re-ordered) by the user, the same
    way a playbook or checklist would be. Zero fragile cross-table joins.
  - One ACTIVE goal per account at a time (partial unique index). Setting a
    new goal archives the old one; history is kept, nothing is deleted.
  - Milestones are plain user-owned rows (direct RLS CRUD), unlike
    `commitments` in this codebase which are system-extracted and therefore
    RPC-only. Here the user is the author, so normal FOR ALL policies apply.
*/

-- =============================================================
-- GOALS
-- =============================================================
CREATE TABLE IF NOT EXISTS business_roadmap_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  title text NOT NULL,
  target_metric text,
  horizon_months integer NOT NULL DEFAULT 12 CHECK (horizon_months BETWEEN 3 AND 36),
  start_date date NOT NULL DEFAULT current_date,

  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
  archived_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only one active goal per account
CREATE UNIQUE INDEX IF NOT EXISTS idx_roadmap_goals_one_active
  ON business_roadmap_goals(user_id) WHERE (status = 'active');

CREATE INDEX IF NOT EXISTS idx_roadmap_goals_user ON business_roadmap_goals(user_id, status);

ALTER TABLE business_roadmap_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_roadmap_goals" ON business_roadmap_goals;
CREATE POLICY "manage_own_roadmap_goals" ON business_roadmap_goals FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- MILESTONES
-- =============================================================
CREATE TABLE IF NOT EXISTS business_roadmap_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  goal_id uuid NOT NULL REFERENCES business_roadmap_goals(id) ON DELETE CASCADE,

  dimension text NOT NULL CHECK (dimension IN (
    'org_capability', 'capacity', 'data_systems', 'process',
    'technician_skill', 'cash_buffer', 'customer_mix'
  )),
  quarter integer NOT NULL CHECK (quarter BETWEEN 1 AND 4),

  title text NOT NULL,
  description text,
  success_metric text,

  owner_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  owner_name text,

  status text NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'in_progress', 'done', 'at_risk', 'blocked'
  )),
  target_date date,
  completed_at timestamptz,

  is_auto_generated boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roadmap_milestones_goal ON business_roadmap_milestones(goal_id, quarter, sort_order);
CREATE INDEX IF NOT EXISTS idx_roadmap_milestones_user ON business_roadmap_milestones(user_id, status);
CREATE INDEX IF NOT EXISTS idx_roadmap_milestones_dimension ON business_roadmap_milestones(user_id, dimension);

ALTER TABLE business_roadmap_milestones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_roadmap_milestones" ON business_roadmap_milestones;
CREATE POLICY "manage_own_roadmap_milestones" ON business_roadmap_milestones FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.trg_touch_roadmap_milestone()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    NEW.completed_at := now();
  ELSIF NEW.status <> 'done' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_roadmap_milestone_touch ON business_roadmap_milestones;
CREATE TRIGGER trg_roadmap_milestone_touch BEFORE UPDATE ON business_roadmap_milestones
  FOR EACH ROW EXECUTE FUNCTION public.trg_touch_roadmap_milestone();

-- =============================================================
-- Curated milestone library — seeded once per new goal, fully editable
-- after that. One flagship milestone per dimension per quarter (28 rows).
-- =============================================================
CREATE OR REPLACE FUNCTION public.generate_roadmap_milestones(p_goal_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_count integer := 0;
  v_row record;
BEGIN
  SELECT user_id INTO v_user_id FROM business_roadmap_goals
    WHERE id = p_goal_id AND user_id = public.get_account_owner_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Goal not found or not authorized';
  END IF;

  FOR v_row IN
    SELECT * FROM (VALUES
      ('org_capability', 1, 'Define ownership for every core function', 'Name a single accountable owner for dispatch, sales, technician development, and finance — even if one person wears two hats today.', 'Every core function has one named owner, documented and communicated to the team'),
      ('org_capability', 2, 'Stand up a weekly leadership rhythm', 'A recurring 30-minute leadership sync covering pipeline, cash, capacity, and open risks — not ad hoc conversations.', '8+ consecutive weekly syncs held with notes captured'),
      ('org_capability', 3, 'Promote or hire your first layer of management', 'Identify the highest-leverage role to add or promote (ops manager, lead CSR, field supervisor) before growth outruns your own bandwidth.', 'Role filled and handling day-to-day decisions without escalation'),
      ('org_capability', 4, 'Document decision rights', 'Write down who can approve discounts, refunds, hires, and purchases above what threshold, so growth does not bottleneck on one person.', 'Decision-rights doc exists and is followed for 90% of relevant decisions'),

      ('capacity', 1, 'Baseline true available capacity', 'Measure real billable hours per technician per week against scheduled hours, not assumed capacity.', 'Utilization baseline documented for every technician'),
      ('capacity', 2, 'Close the biggest capacity gap', 'Add headcount, subcontractor coverage, or route efficiency to close the single largest gap between demand and capacity identified in Q1.', 'Capacity gap closed by a measured, targeted amount'),
      ('capacity', 3, 'Build a surge plan', 'A written plan for handling demand spikes (weather events, seasonal peaks) using overtime, mutual aid, or contractor network before you need it.', 'Surge plan documented and tested at least once'),
      ('capacity', 4, 'Right-size the fleet/crew for next year''s demand', 'Use this year''s actual demand curve to plan headcount and vehicle additions for the next 12 months, not gut feel.', 'Next-year capacity plan approved with a headcount/fleet number attached'),

      ('data_systems', 1, 'Get one source of truth for revenue and jobs', 'Every job and every dollar lives in one system — no parallel spreadsheets deciding what "real" numbers are.', 'Zero material discrepancies between reported and system-of-record numbers'),
      ('data_systems', 2, 'Automate your weekly numbers', 'Revenue, jobs completed, and cash position are visible without anyone manually compiling a report.', 'Weekly numbers available with zero manual spreadsheet work'),
      ('data_systems', 3, 'Close the biggest data gap you can name', 'Fix the one dataset everyone complains is unreliable (job costing, technician hours, marketing attribution — pick one).', 'That dataset is trusted enough to make a pricing or staffing decision from it'),
      ('data_systems', 4, 'Set up a monthly business review deck', 'A recurring, mostly-automated report the owner reviews monthly: revenue, margin, capacity, customer mix, cash.', 'Monthly review held for 3 consecutive months using the same template'),

      ('process', 1, 'Write down your top 3 SOPs', 'Document the three processes that break most often when someone new does them (dispatch, estimate follow-up, job closeout).', '3 SOPs written, shared, and used by someone other than the author'),
      ('process', 2, 'Reduce hand-off failures', 'Fix the single most common place a job stalls between booking and completion (missing info, no confirmation, no follow-up).', 'Measured reduction in jobs stalling at that hand-off point'),
      ('process', 3, 'Standardize estimate-to-close', 'One consistent process for turning a lead into a signed, scheduled job — same steps regardless of who runs it.', 'Estimate-to-close cycle time and close rate both improve or hold steady while volume grows'),
      ('process', 4, 'Build a new-hire onboarding checklist', 'A written first-30-days checklist so a new technician or CSR ramps predictably instead of learning by osmosis.', 'Checklist used for every new hire this quarter'),

      ('technician_skill', 1, 'Baseline skill by technician', 'Know, per technician, what job types they can run solo vs. need support on.', 'Skill baseline documented for every technician'),
      ('technician_skill', 2, 'Close your #1 skill gap', 'Pick the single skill gap most limiting revenue (a certification, a job type, a diagnostic skill) and close it via training or hiring.', 'At least one technician newly qualified in that gap area'),
      ('technician_skill', 3, 'Stand up a coaching loop', 'A recurring, lightweight way to give technicians feedback on quality, speed, or upsell — not just a performance review once a year.', 'Coaching touchpoint delivered to every technician at least monthly'),
      ('technician_skill', 4, 'Build a bench for your highest-risk role', 'Identify the one role that would hurt most if the current person left, and have a credible second person who could step in.', 'A named backup exists and has shadowed the role at least once'),

      ('cash_buffer', 1, 'Know your real runway', 'Calculate actual months of operating expenses covered by current cash, not a guess.', 'Runway number calculated and reviewed monthly'),
      ('cash_buffer', 2, 'Set a minimum cash buffer target', 'Decide the minimum cash balance you will not let the business fall below, based on seasonality.', 'Target documented and tracked against actual balance'),
      ('cash_buffer', 3, 'Shorten cash conversion cycle', 'Reduce the time between job completion and cash in hand — faster invoicing, deposits, or collections follow-up.', 'Average days-to-payment measurably shorter than Q1 baseline'),
      ('cash_buffer', 4, 'Reach the buffer target', 'Hit the minimum cash buffer set in Q2 through a combination of margin, collections, and controlled growth pace.', 'Cash buffer at or above target for 2 consecutive months'),

      ('customer_mix', 1, 'Segment your current customer base', 'Break down revenue by customer type (residential/commercial, one-time/recurring, membership/non-membership).', 'Customer mix breakdown documented with current percentages'),
      ('customer_mix', 2, 'Set a target mix for the next 12 months', 'Decide, deliberately, whether you want more recurring revenue, more commercial accounts, or more of your highest-margin segment.', 'Target mix percentages documented and shared with sales/marketing'),
      ('customer_mix', 3, 'Shift acquisition toward the target mix', 'Adjust marketing spend, sales scripts, or membership offers to start moving the mix toward the Q2 target.', 'Measurable movement toward target mix vs. Q1 baseline'),
      ('customer_mix', 4, 'Review customer concentration risk', 'Check whether too much revenue depends on too few customers or too narrow a segment, and have a plan if that is true.', 'Concentration risk assessed and documented, with a mitigation plan if needed')
    ) AS m(dimension, quarter, title, description, success_metric)
  LOOP
    INSERT INTO business_roadmap_milestones (
      user_id, goal_id, dimension, quarter, title, description, success_metric,
      is_auto_generated, sort_order
    )
    VALUES (
      v_user_id, p_goal_id, v_row.dimension, v_row.quarter, v_row.title, v_row.description, v_row.success_metric,
      true, v_row.quarter * 10
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_roadmap_milestones(uuid) TO authenticated;

-- =============================================================
-- Set (or replace) the active goal, and auto-seed its roadmap
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_active_roadmap_goal(
  p_title text,
  p_target_metric text DEFAULT NULL,
  p_horizon_months integer DEFAULT 12
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := public.get_account_owner_id();
  v_goal_id uuid;
BEGIN
  IF trim(coalesce(p_title, '')) = '' THEN
    RAISE EXCEPTION 'Goal title is required';
  END IF;

  UPDATE business_roadmap_goals
    SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE user_id = v_user_id AND status = 'active';

  INSERT INTO business_roadmap_goals (user_id, title, target_metric, horizon_months)
  VALUES (v_user_id, p_title, p_target_metric, p_horizon_months)
  RETURNING id INTO v_goal_id;

  PERFORM public.generate_roadmap_milestones(v_goal_id);

  RETURN v_goal_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_active_roadmap_goal(text, text, integer) TO authenticated;

-- =============================================================
-- Update milestone status (RPC wrapper kept for symmetry; direct table
-- UPDATE also works under the FOR ALL policy above)
-- =============================================================
CREATE OR REPLACE FUNCTION public.update_roadmap_milestone_status(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('not_started', 'in_progress', 'done', 'at_risk', 'blocked') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  UPDATE business_roadmap_milestones
    SET status = p_status
    WHERE id = p_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Milestone not found or not authorized';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_roadmap_milestone_status(uuid, text) TO authenticated;

-- =============================================================
-- Dimension + overall scores for the active goal
-- Score = % done, with an at-risk penalty for overdue, unfinished
-- milestones (target_date passed and status not 'done').
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_roadmap_dimension_scores(p_user_id uuid)
RETURNS TABLE (
  dimension text,
  total_count bigint,
  done_count bigint,
  at_risk_count bigint,
  score numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_account_owner_id() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;

  RETURN QUERY
  SELECT
    m.dimension,
    count(*),
    count(*) FILTER (WHERE m.status = 'done'),
    count(*) FILTER (WHERE m.status <> 'done' AND m.target_date IS NOT NULL AND m.target_date < current_date),
    round(
      GREATEST(
        0,
        (100.0 * count(*) FILTER (WHERE m.status = 'done') / NULLIF(count(*), 0))
        - (10.0 * count(*) FILTER (WHERE m.status <> 'done' AND m.target_date IS NOT NULL AND m.target_date < current_date))
      ), 1
    )
  FROM business_roadmap_milestones m
  JOIN business_roadmap_goals g ON g.id = m.goal_id
  WHERE m.user_id = p_user_id AND g.status = 'active'
  GROUP BY m.dimension;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_roadmap_dimension_scores(uuid) TO authenticated;
