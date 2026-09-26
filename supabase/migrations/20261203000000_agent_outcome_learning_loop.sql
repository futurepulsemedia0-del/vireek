/*
  # Outcome-Based AI Learning Loop

  ## Why
  20261121000000_ai_agent_governance.sql already gives every autonomous
  agent a shared checkpoint (evaluate_agent_action / record_agent_action_outcome)
  and captures the Human Override half of the loop: agent_action_log.status
  ('approved' | 'rejected' | 'rolled_back') plus decided_by/decision_reason.

  What it does NOT capture is whether an approved-and-executed action was
  actually GOOD for the business: did the SMS lead to a booked job, did the
  financing offer get accepted, did the marketing send produce revenue — and
  what that was worth in dollars. Without that, "governance" can toggle
  actions on/off but the system never learns from real results.

  This migration closes the loop:
    AI decision -> Human Override (already in agent_action_log)
                -> Real Outcome (agent_action_outcomes)
                -> Financial Outcome (agent_action_outcomes.financial_outcome_cents)
                -> Learning (agent_action_learning_stats, agent_learning_suggestions)

  1. agent_action_outcomes — one row per agent_action_log row (1:1), the
     real-world result: success/partial/failure/no_effect/unknown, signed
     dollar impact, evidence, and whether a human or the system recorded it.
  2. agent_action_learning_stats — rolling per (account, action_slug)
     aggregates, recomputed by refresh_agent_action_learning_stats()
     every time an outcome is recorded.
  3. agent_learning_suggestions — deterministic, explainable "relax
     approval" / "tighten approval" suggestions once there's enough
     evidence (>=15 outcomes). Nothing is ever applied automatically —
     mirrors the accept/dismiss idiom already used by
     playbook_learning_suggestions in 20261126000000_trade_playbooks_outcome_learning.sql.
  4. A trigger on agent_action_log: when a human rolls an executed action
     back, that IS a real outcome (a bad one) — auto-recorded as a
     'failure' with a negative financial_outcome_cents, so the loop closes
     even if the calling agent never explicitly reports a business result.

  RLS mirrors 20261121000000_ai_agent_governance.sql exactly: whole-account
  SELECT via get_account_owner_id(), no direct client INSERT/UPDATE/DELETE
  policies — every write goes through a SECURITY DEFINER RPC below.
*/

-- =============================================================
-- AGENT_ACTION_OUTCOMES — the real-world result of one agent_action_log row
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_action_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES agent_action_log(id) ON DELETE CASCADE,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug),
  outcome text NOT NULL CHECK (outcome IN ('success', 'partial', 'failure', 'no_effect', 'unknown')),
  -- Signed: positive = revenue gained / cost avoided, negative = cost incurred / value lost.
  financial_outcome_cents integer,
  -- 1.0 = deterministically measured (e.g. matched to a paid invoice); lower
  -- for estimated/heuristic measurements. Lets learning stats weight evidence later.
  confidence numeric NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  recorded_by text NOT NULL DEFAULT 'system' CHECK (recorded_by IN ('system', 'human')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (log_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_action_outcomes_user_slug
  ON agent_action_outcomes(user_id, action_slug, recorded_at DESC);

ALTER TABLE agent_action_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_action_outcomes" ON agent_action_outcomes;
CREATE POLICY "select_own_agent_action_outcomes" ON agent_action_outcomes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client write policy — inserts/updates only via
-- record_agent_action_business_outcome() below.

-- =============================================================
-- AGENT_ACTION_LEARNING_STATS — rolling per (account, action) aggregates
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_action_learning_stats (
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug) ON DELETE CASCADE,
  total_decided integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  rolled_back_count integer NOT NULL DEFAULT 0,
  executed_count integer NOT NULL DEFAULT 0,
  outcomes_recorded integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  partial_count integer NOT NULL DEFAULT 0,
  -- share of decided proposals a human rejected or later rolled back
  human_override_rate numeric,
  -- share of recorded outcomes that were 'success'
  outcome_success_rate numeric,
  avg_financial_impact_cents integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, action_slug)
);

ALTER TABLE agent_action_learning_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_action_learning_stats" ON agent_action_learning_stats;
CREATE POLICY "select_own_agent_action_learning_stats" ON agent_action_learning_stats FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client write policy — written only by refresh_agent_action_learning_stats().

-- =============================================================
-- AGENT_LEARNING_SUGGESTIONS — deterministic, explainable, opt-in
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_learning_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug) ON DELETE CASCADE,
  suggestion_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('relax_approval', 'tighten_approval')),
  title text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (user_id, suggestion_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_learning_suggestions_status
  ON agent_learning_suggestions(user_id, status, created_at DESC);

ALTER TABLE agent_learning_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_learning_suggestions" ON agent_learning_suggestions;
CREATE POLICY "select_own_agent_learning_suggestions" ON agent_learning_suggestions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client write policy — inserted by refresh_agent_action_learning_stats(),
-- decided only via decide_agent_learning_suggestion() below.

-- =============================================================
-- RPC: refresh_agent_action_learning_stats — internal, recomputes + suggests
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_agent_action_learning_stats(
  p_user_id uuid,
  p_action_slug text
)
RETURNS agent_action_learning_stats
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_action_learning_stats;
  v_catalog agent_action_catalog;
  v_perm agent_permissions;
  v_total_decided integer;
  v_rejected integer;
  v_rolled_back integer;
  v_executed integer;
  v_outcomes_recorded integer;
  v_success integer;
  v_failure integer;
  v_partial integer;
  v_avg_financial numeric;
  v_override_rate numeric;
  v_success_rate numeric;
  v_requires_approval boolean;
BEGIN
  SELECT * INTO v_catalog FROM agent_action_catalog WHERE slug = p_action_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown agent action slug: %', p_action_slug;
  END IF;

  SELECT
    count(*) FILTER (WHERE status IN ('approved', 'rejected', 'auto_approved', 'executed', 'failed', 'rolled_back')),
    count(*) FILTER (WHERE status = 'rejected'),
    count(*) FILTER (WHERE status = 'rolled_back'),
    count(*) FILTER (WHERE status IN ('executed', 'rolled_back'))
  INTO v_total_decided, v_rejected, v_rolled_back, v_executed
  FROM agent_action_log
  WHERE user_id = p_user_id AND action_slug = p_action_slug;

  SELECT
    count(*),
    count(*) FILTER (WHERE outcome = 'success'),
    count(*) FILTER (WHERE outcome = 'failure'),
    count(*) FILTER (WHERE outcome = 'partial'),
    AVG(financial_outcome_cents) FILTER (WHERE financial_outcome_cents IS NOT NULL)
  INTO v_outcomes_recorded, v_success, v_failure, v_partial, v_avg_financial
  FROM agent_action_outcomes
  WHERE user_id = p_user_id AND action_slug = p_action_slug;

  v_override_rate := CASE WHEN v_total_decided > 0
    THEN ROUND((v_rejected + v_rolled_back)::numeric / v_total_decided, 4) ELSE NULL END;
  v_success_rate := CASE WHEN v_outcomes_recorded > 0
    THEN ROUND(v_success::numeric / v_outcomes_recorded, 4) ELSE NULL END;

  INSERT INTO agent_action_learning_stats (
    user_id, action_slug, total_decided, rejected_count, rolled_back_count, executed_count,
    outcomes_recorded, success_count, failure_count, partial_count,
    human_override_rate, outcome_success_rate, avg_financial_impact_cents, updated_at
  ) VALUES (
    p_user_id, p_action_slug, v_total_decided, v_rejected, v_rolled_back, v_executed,
    v_outcomes_recorded, v_success, v_failure, v_partial,
    v_override_rate, v_success_rate,
    CASE WHEN v_avg_financial IS NOT NULL THEN ROUND(v_avg_financial) ELSE NULL END,
    now()
  )
  ON CONFLICT (user_id, action_slug) DO UPDATE SET
    total_decided = EXCLUDED.total_decided,
    rejected_count = EXCLUDED.rejected_count,
    rolled_back_count = EXCLUDED.rolled_back_count,
    executed_count = EXCLUDED.executed_count,
    outcomes_recorded = EXCLUDED.outcomes_recorded,
    success_count = EXCLUDED.success_count,
    failure_count = EXCLUDED.failure_count,
    partial_count = EXCLUDED.partial_count,
    human_override_rate = EXCLUDED.human_override_rate,
    outcome_success_rate = EXCLUDED.outcome_success_rate,
    avg_financial_impact_cents = EXCLUDED.avg_financial_impact_cents,
    updated_at = now()
  RETURNING * INTO v_row;

  -- Deterministic, explainable, opt-in suggestions — only once there's
  -- enough evidence, and only one open suggestion per direction per
  -- sample-size checkpoint (suggestion_key includes the sample size, so a
  -- dismissed suggestion doesn't come back until MORE evidence arrives).
  SELECT * INTO v_perm FROM agent_permissions WHERE user_id = p_user_id AND action_slug = p_action_slug;
  v_requires_approval := COALESCE(v_perm.requires_approval, v_catalog.default_requires_approval);

  IF v_outcomes_recorded >= 15 THEN
    IF v_success_rate >= 0.9 AND COALESCE(v_override_rate, 0) <= 0.1 AND v_requires_approval THEN
      INSERT INTO agent_learning_suggestions (user_id, action_slug, suggestion_key, kind, title, rationale, evidence)
      VALUES (
        p_user_id, p_action_slug,
        p_action_slug || ':relax:' || v_outcomes_recorded, 'relax_approval',
        'Auto-approve "' || v_catalog.label || '"',
        format('%s%% of the last %s recorded outcomes were successful and only %s%% of proposals were overridden by a human. This action type has earned auto-approval.',
               round(v_success_rate * 100), v_outcomes_recorded, round(COALESCE(v_override_rate, 0) * 100)),
        jsonb_build_object('success_rate', v_success_rate, 'override_rate', v_override_rate, 'sample_size', v_outcomes_recorded)
      )
      ON CONFLICT (user_id, suggestion_key) DO NOTHING;
    ELSIF (v_success_rate <= 0.5 OR COALESCE(v_override_rate, 0) >= 0.4) AND NOT v_requires_approval THEN
      INSERT INTO agent_learning_suggestions (user_id, action_slug, suggestion_key, kind, title, rationale, evidence)
      VALUES (
        p_user_id, p_action_slug,
        p_action_slug || ':tighten:' || v_outcomes_recorded, 'tighten_approval',
        'Require approval for "' || v_catalog.label || '"',
        format('Only %s%% of the last %s recorded outcomes were successful, and %s%% of proposals were overridden by a human. This action type should require approval.',
               round(v_success_rate * 100), v_outcomes_recorded, round(COALESCE(v_override_rate, 0) * 100)),
        jsonb_build_object('success_rate', v_success_rate, 'override_rate', v_override_rate, 'sample_size', v_outcomes_recorded)
      )
      ON CONFLICT (user_id, suggestion_key) DO NOTHING;
    END IF;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_agent_action_learning_stats(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_agent_action_learning_stats(uuid, text) TO service_role;

-- =============================================================
-- RPC: record_agent_action_business_outcome — the actual learning input
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_agent_action_business_outcome(
  p_log_id uuid,
  p_outcome text,
  p_financial_impact_cents integer DEFAULT NULL,
  p_confidence numeric DEFAULT 1.0,
  p_evidence jsonb DEFAULT '{}'::jsonb,
  p_notes text DEFAULT NULL,
  p_recorded_by text DEFAULT 'system'
)
RETURNS agent_action_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log agent_action_log;
  v_row agent_action_outcomes;
BEGIN
  IF p_outcome NOT IN ('success', 'partial', 'failure', 'no_effect', 'unknown') THEN
    RAISE EXCEPTION 'Invalid outcome: %', p_outcome;
  END IF;
  IF p_recorded_by NOT IN ('system', 'human') THEN
    RAISE EXCEPTION 'Invalid recorded_by: %', p_recorded_by;
  END IF;
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN
    RAISE EXCEPTION 'confidence must be between 0 and 1';
  END IF;

  SELECT * INTO v_log FROM agent_action_log WHERE id = p_log_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent action log % not found.', p_log_id;
  END IF;

  -- Service-role callers (edge functions) have auth.uid() = NULL and are
  -- trusted; dashboard callers may only record outcomes for their own account.
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_log.user_id THEN
    RAISE EXCEPTION 'Not authorized to record an outcome for this action.';
  END IF;

  IF v_log.status NOT IN ('executed', 'failed', 'rolled_back') THEN
    RAISE EXCEPTION 'Outcome can only be recorded for an executed, failed, or rolled-back action (current status: %).', v_log.status;
  END IF;

  INSERT INTO agent_action_outcomes (
    user_id, log_id, action_slug, outcome, financial_outcome_cents, confidence, evidence, notes, recorded_by
  ) VALUES (
    v_log.user_id, p_log_id, v_log.action_slug, p_outcome, p_financial_impact_cents, p_confidence,
    p_evidence, p_notes, p_recorded_by
  )
  ON CONFLICT (log_id) DO UPDATE SET
    outcome = EXCLUDED.outcome,
    financial_outcome_cents = EXCLUDED.financial_outcome_cents,
    confidence = EXCLUDED.confidence,
    evidence = EXCLUDED.evidence,
    notes = EXCLUDED.notes,
    recorded_by = EXCLUDED.recorded_by,
    recorded_at = now()
  RETURNING * INTO v_row;

  PERFORM public.refresh_agent_action_learning_stats(v_log.user_id, v_log.action_slug);

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: decide_agent_learning_suggestion — human accepts/dismisses
-- =============================================================

CREATE OR REPLACE FUNCTION public.decide_agent_learning_suggestion(
  p_suggestion_id uuid,
  p_accept boolean
)
RETURNS agent_learning_suggestions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row agent_learning_suggestions;
BEGIN
  SELECT * INTO v_row FROM agent_learning_suggestions WHERE id = p_suggestion_id AND user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Suggestion not found or not owned by this account.';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending suggestions can be decided (current status: %).', v_row.status;
  END IF;

  IF p_accept THEN
    IF v_row.kind = 'relax_approval' THEN
      PERFORM public.upsert_agent_permission(v_row.action_slug, NULL, false);
    ELSIF v_row.kind = 'tighten_approval' THEN
      PERFORM public.upsert_agent_permission(v_row.action_slug, NULL, true);
    END IF;
  END IF;

  UPDATE agent_learning_suggestions
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'dismissed' END,
      decided_at = now()
  WHERE id = p_suggestion_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- TRIGGER: a rollback IS a real (bad) outcome — close the loop automatically
-- =============================================================

CREATE OR REPLACE FUNCTION public.agent_action_log_record_rollback_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'rolled_back' AND OLD.status IS DISTINCT FROM 'rolled_back' THEN
    PERFORM public.record_agent_action_business_outcome(
      NEW.id,
      'failure',
      CASE WHEN NEW.amount_cents IS NOT NULL THEN -NEW.amount_cents ELSE NULL END,
      1.0,
      jsonb_build_object('reason', 'auto_recorded_on_rollback'),
      'Auto-recorded: a human rolled this action back.',
      'system'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_action_log_rollback_outcome ON agent_action_log;
CREATE TRIGGER trg_agent_action_log_rollback_outcome
  AFTER UPDATE OF status ON agent_action_log
  FOR EACH ROW EXECUTE FUNCTION public.agent_action_log_record_rollback_outcome();
