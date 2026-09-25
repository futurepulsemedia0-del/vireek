/*
  # Agent Autonomy Readiness Score

  ## Why
  20261121000000_ai_agent_governance.sql gives every autonomous agent a
  shared checkpoint (permission, spend limit, approval queue, audit
  trail) but no answer to "is this action type actually ready to run
  without a human in the loop?" This migration scores each row of
  agent_action_catalog against its own agent_action_log history and
  current agent_permissions policy, and places it on the same ladder
  Vireek uses everywhere else in its autonomy story:

    Observe  ->  Recommend  ->  Execute  ->  Autonomous

  ## What this adds
  1. `get_agent_autonomy_readiness()` — SECURITY DEFINER RPC, scoped to
     the caller's own account via get_account_owner_id(). Computes a
     live 0-100 score + tier + blockers per action_slug from the last
     30 days of agent_action_log, joined to agent_action_catalog and
     agent_permissions. No new table needed for the live view.
  2. `agent_autonomy_score_snapshots` — one row per (account,
     action_slug, day), so the dashboard can chart the score over time
     instead of only showing "right now".
  3. `capture_my_agent_autonomy_snapshot()` — SECURITY DEFINER RPC the
     dashboard (or a future per-account cron tick) calls to persist
     today's score for the caller's account. Kept account-scoped like
     the rest of this file's RPCs; a fleet-wide nightly sweep can call
     it once per account from a service-role edge function later,
     mirroring workflow-engine-executor's cron pattern.

  RLS mirrors 20261121000000_ai_agent_governance.sql: whole-account
  SELECT via get_account_owner_id(), no client INSERT/UPDATE/DELETE —
  the only write path is capture_my_agent_autonomy_snapshot().
*/

-- =============================================================
-- AGENT_AUTONOMY_SCORE_SNAPSHOTS
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_autonomy_score_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT current_date,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier text NOT NULL CHECK (tier IN ('observe', 'recommend', 'execute', 'autonomous')),
  total_actions_30d integer NOT NULL DEFAULT 0,
  failure_rate numeric NOT NULL DEFAULT 0,
  override_rate numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_autonomy_snapshot_day
  ON agent_autonomy_score_snapshots(user_id, action_slug, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_agent_autonomy_snapshot_user_date
  ON agent_autonomy_score_snapshots(user_id, action_slug, snapshot_date DESC);

ALTER TABLE agent_autonomy_score_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_autonomy_snapshots" ON agent_autonomy_score_snapshots;
CREATE POLICY "select_own_agent_autonomy_snapshots" ON agent_autonomy_score_snapshots FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client write policy — inserts only via capture_my_agent_autonomy_snapshot().

-- =============================================================
-- RPC: get_agent_autonomy_readiness — live score per action_slug
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_agent_autonomy_readiness()
RETURNS TABLE (
  action_slug text,
  agent_source text,
  label text,
  category text,
  is_reversible boolean,
  has_cost boolean,
  enabled boolean,
  requires_approval boolean,
  auto_approve_max_cents integer,
  total_actions_30d integer,
  executed_30d integer,
  failed_30d integer,
  rejected_30d integer,
  rolled_back_30d integer,
  failure_rate numeric,
  override_rate numeric,
  days_since_last_incident integer,
  score integer,
  tier text,
  blockers text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := public.get_account_owner_id();

  RETURN QUERY
  WITH stats AS (
    SELECT
      l.action_slug,
      count(*) FILTER (WHERE l.created_at >= now() - interval '30 days') AS total_30d,
      count(*) FILTER (WHERE l.created_at >= now() - interval '30 days' AND l.status = 'executed') AS executed_30d,
      count(*) FILTER (WHERE l.created_at >= now() - interval '30 days' AND l.status = 'failed') AS failed_30d,
      count(*) FILTER (WHERE l.created_at >= now() - interval '30 days' AND l.status = 'rejected') AS rejected_30d,
      count(*) FILTER (WHERE l.created_at >= now() - interval '30 days' AND l.status = 'rolled_back') AS rolled_back_30d,
      max(l.created_at) FILTER (
        WHERE l.status IN ('failed', 'rejected', 'rolled_back')
      ) AS last_incident_at
    FROM agent_action_log l
    WHERE l.user_id = v_user_id
    GROUP BY l.action_slug
  ),
  scored AS (
    SELECT
      c.slug,
      c.agent_source,
      c.label,
      c.category,
      c.is_reversible,
      c.has_cost,
      coalesce(p.enabled, true) AS enabled,
      coalesce(p.requires_approval, c.default_requires_approval) AS requires_approval,
      p.auto_approve_max_cents,
      coalesce(s.total_30d, 0)::integer AS total_actions_30d,
      coalesce(s.executed_30d, 0)::integer AS executed_30d,
      coalesce(s.failed_30d, 0)::integer AS failed_30d,
      coalesce(s.rejected_30d, 0)::integer AS rejected_30d,
      coalesce(s.rolled_back_30d, 0)::integer AS rolled_back_30d,
      CASE WHEN coalesce(s.executed_30d, 0) + coalesce(s.failed_30d, 0) = 0 THEN 0
        ELSE round(s.failed_30d::numeric / (s.executed_30d + s.failed_30d), 4)
      END AS failure_rate,
      CASE WHEN coalesce(s.total_30d, 0) = 0 THEN 0
        ELSE round((coalesce(s.rejected_30d, 0) + coalesce(s.rolled_back_30d, 0))::numeric / s.total_30d, 4)
      END AS override_rate,
      CASE WHEN s.last_incident_at IS NULL THEN NULL
        ELSE extract(day FROM now() - s.last_incident_at)::integer
      END AS days_since_last_incident
    FROM agent_action_catalog c
    LEFT JOIN agent_permissions p ON p.user_id = v_user_id AND p.action_slug = c.slug
    LEFT JOIN stats s ON s.action_slug = c.slug
  ),
  components AS (
    SELECT
      *,
      -- Evidence (0-25): volume of activity in the last 30 days, target 30 actions
      round(least(total_actions_30d::numeric / 30, 1) * 25) AS pt_volume,
      -- Reliability (0-35): inverse of failure rate
      round((1 - failure_rate) * 35) AS pt_reliability,
      -- Trust (0-25): inverse of human override/rollback rate
      round((1 - override_rate) * 25) AS pt_trust,
      -- Policy (0-15): how much autonomy the account has already granted
      CASE
        WHEN NOT enabled THEN 0
        WHEN requires_approval THEN 5
        WHEN auto_approve_max_cents IS NOT NULL THEN 10
        ELSE 15
      END AS pt_policy
    FROM scored
  ),
  gated AS (
    SELECT
      *,
      (pt_volume + pt_reliability + pt_trust + pt_policy) AS raw_score,
      -- Autonomous tier additionally requires sustained, clean history —
      -- a high raw score alone cannot buy past this gate.
      (
        total_actions_30d >= 20
        AND failure_rate <= 0.02
        AND override_rate = 0
        AND coalesce(days_since_last_incident, 999) >= 14
        AND enabled AND NOT requires_approval
      ) AS autonomous_gate_passed
    FROM components
  )
  SELECT
    g.slug,
    g.agent_source,
    g.label,
    g.category,
    g.is_reversible,
    g.has_cost,
    g.enabled,
    g.requires_approval,
    g.auto_approve_max_cents,
    g.total_actions_30d,
    g.executed_30d,
    g.failed_30d,
    g.rejected_30d,
    g.rolled_back_30d,
    g.failure_rate,
    g.override_rate,
    g.days_since_last_incident,
    LEAST(g.raw_score, CASE WHEN g.autonomous_gate_passed THEN 100 ELSE 79 END)::integer AS score,
    CASE
      WHEN NOT g.autonomous_gate_passed AND g.raw_score >= 80 THEN 'execute'
      WHEN g.raw_score >= 80 THEN 'autonomous'
      WHEN g.raw_score >= 50 THEN 'execute'
      WHEN g.raw_score >= 25 THEN 'recommend'
      ELSE 'observe'
    END AS tier,
    array_remove(ARRAY[
      CASE WHEN g.total_actions_30d < 20 THEN format('needs %s more actions in 30d (has %s)', 20 - g.total_actions_30d, g.total_actions_30d) END,
      CASE WHEN g.failure_rate > 0.02 THEN format('failure rate %s%% is above the 2%% bar', round(g.failure_rate * 100, 1)) END,
      CASE WHEN g.override_rate > 0 THEN format('%s%% of actions were rejected or rolled back', round(g.override_rate * 100, 1)) END,
      CASE WHEN g.requires_approval THEN 'still requires human approval per policy' END,
      CASE WHEN NOT g.enabled THEN 'disabled for this account' END,
      CASE WHEN coalesce(g.days_since_last_incident, 999) < 14 THEN format('last incident was %s day(s) ago (need 14+)', g.days_since_last_incident) END
    ], NULL) AS blockers
  FROM gated g
  ORDER BY score DESC, g.label;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_autonomy_readiness() TO authenticated;

-- =============================================================
-- RPC: capture_my_agent_autonomy_snapshot — persist today's scores
-- =============================================================

CREATE OR REPLACE FUNCTION public.capture_my_agent_autonomy_snapshot()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_count integer;
BEGIN
  v_user_id := public.get_account_owner_id();

  INSERT INTO agent_autonomy_score_snapshots (
    user_id, action_slug, snapshot_date, score, tier, total_actions_30d, failure_rate, override_rate
  )
  SELECT v_user_id, r.action_slug, current_date, r.score, r.tier, r.total_actions_30d, r.failure_rate, r.override_rate
  FROM public.get_agent_autonomy_readiness() r
  ON CONFLICT (user_id, action_slug, snapshot_date) DO UPDATE SET
    score = EXCLUDED.score,
    tier = EXCLUDED.tier,
    total_actions_30d = EXCLUDED.total_actions_30d,
    failure_rate = EXCLUDED.failure_rate,
    override_rate = EXCLUDED.override_rate;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.capture_my_agent_autonomy_snapshot() TO authenticated;
