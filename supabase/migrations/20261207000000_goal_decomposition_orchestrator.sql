/*
  # Goal Decomposition Orchestrator

  Vision → Execution, with nothing dropped: a tenant states one high-level
  goal in plain language; goal-decomposition-orchestrator (edge function)
  calls the shared Vireek AI router to break it into concrete Strategies,
  each holding concrete Actions — and every Action is a real, owned,
  due-dated row from the moment it's created (never a paragraph of advice
  that quietly goes nowhere).

  Three levels, same ownership pattern as business_roadmap_goals/
  business_roadmap_milestones (get_account_owner_id(), FOR ALL policies —
  the user is the author/editor of record even though the initial content
  is AI-generated, same posture as that feature):
    strategic_goals -> goal_strategies -> goal_actions

  progress_pct on strategic_goals is denormalized (kept current by a
  trigger on goal_actions) so the dashboard never has to compute a rollup
  join just to show a progress bar.
*/

CREATE TABLE IF NOT EXISTS strategic_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  vision text NOT NULL,
  target_metric text,
  target_value numeric,
  horizon_days integer NOT NULL DEFAULT 90 CHECK (horizon_days BETWEEN 7 AND 730),

  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  progress_pct numeric NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategic_goals_user ON strategic_goals(user_id, status);

ALTER TABLE strategic_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_strategic_goals" ON strategic_goals;
CREATE POLICY "manage_own_strategic_goals" ON strategic_goals FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS goal_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  goal_id uuid NOT NULL REFERENCES strategic_goals(id) ON DELETE CASCADE,

  title text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  sort_order integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_strategies_goal ON goal_strategies(goal_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_goal_strategies_user ON goal_strategies(user_id);

ALTER TABLE goal_strategies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_goal_strategies" ON goal_strategies;
CREATE POLICY "manage_own_goal_strategies" ON goal_strategies FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS goal_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  strategy_id uuid NOT NULL REFERENCES goal_strategies(id) ON DELETE CASCADE,

  title text NOT NULL,
  description text,
  action_type text NOT NULL DEFAULT 'human_task' CHECK (action_type IN ('human_task', 'workflow_enrollment', 'marketing_campaign')),
  execution_config jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. { "workflow_slug": "..." } when action_type isn't human_task

  owner_name text,
  due_at timestamptz,

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'blocked')),
  is_auto_generated boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_actions_strategy ON goal_actions(strategy_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_goal_actions_user ON goal_actions(user_id, status, due_at);

ALTER TABLE goal_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_goal_actions" ON goal_actions;
CREATE POLICY "manage_own_goal_actions" ON goal_actions FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- ---------------------------------------------------------------------
-- Progress rollup: % of a goal's actions that are 'done', recomputed
-- straight onto strategic_goals whenever a goal_actions row changes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_recompute_goal_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_goal_id uuid;
  v_total integer;
  v_done integer;
BEGIN
  SELECT goal_id INTO v_goal_id FROM goal_strategies WHERE id = COALESCE(NEW.strategy_id, OLD.strategy_id);
  IF v_goal_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT count(*), count(*) FILTER (WHERE a.status = 'done')
    INTO v_total, v_done
    FROM goal_actions a
    JOIN goal_strategies s ON s.id = a.strategy_id
    WHERE s.goal_id = v_goal_id;

  UPDATE strategic_goals
    SET progress_pct = CASE WHEN v_total = 0 THEN 0 ELSE round(100.0 * v_done / v_total, 1) END,
        updated_at = now()
    WHERE id = v_goal_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_goal_actions_progress ON goal_actions;
CREATE TRIGGER trg_goal_actions_progress
  AFTER INSERT OR UPDATE OF status OR DELETE ON goal_actions
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_goal_progress();
