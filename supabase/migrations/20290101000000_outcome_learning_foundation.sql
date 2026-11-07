/*
  # Outcome Learning Foundation (Part 1)

  Extends 20261203000000_agent_outcome_learning_loop.sql WITHOUT destructive change:

  1. outcome_learning_settings      — per-account feature flag (default OFF).
  2. agent_action_outcomes (+cols)  — attribution_rule/version, conflict, dq flags,
                                      excluded_from_learning, measurement window.
  3. agent_outcome_watch            — lifecycle pending -> measured -> final.
                                      Timeouts resolve to 'unknown', never 'success'.
  4. enroll_outcome_watches()       — service-role: enrolls executed governed actions
                                      whose target_table has an attribution rule.
  5. finalize_outcome_watch()       — service-role: idempotent; writes the final row via
                                      the existing record_agent_action_business_outcome().
  6. refresh_agent_action_learning_stats() — re-created; identical behaviour unless the
                                      account enabled capture (strict mode excludes
                                      unknown / conflicted / low-quality outcomes).
  7. Views outcome_data_quality_v, outcome_coverage_v (security_invoker => RLS applies).

  Attribution decisions are made in supabase/functions/_shared/outcomes/attribution.ts
  (pure, unit-tested) and applied by the outcome-reconciler edge function.

  Rollback (manual): DROP VIEW outcome_coverage_v, outcome_data_quality_v;
  DROP TABLE agent_outcome_watch, outcome_learning_settings; re-apply the original
  refresh_agent_action_learning_stats() from 20261203000000. Added columns are harmless.
*/

CREATE TABLE IF NOT EXISTS outcome_learning_settings (
  user_id uuid PRIMARY KEY,
  capture_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outcome_learning_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_outcome_learning_settings" ON outcome_learning_settings;
CREATE POLICY "select_own_outcome_learning_settings" ON outcome_learning_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.set_outcome_capture_enabled(p_enabled boolean)
RETURNS outcome_learning_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row outcome_learning_settings;
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the account owner can change outcome learning settings.';
  END IF;
  INSERT INTO outcome_learning_settings (user_id, capture_enabled, updated_at)
  VALUES (auth.uid(), COALESCE(p_enabled, false), now())
  ON CONFLICT (user_id) DO UPDATE SET capture_enabled = EXCLUDED.capture_enabled, updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.set_outcome_capture_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_outcome_capture_enabled(boolean) TO authenticated, service_role;

ALTER TABLE agent_action_outcomes
  ADD COLUMN IF NOT EXISTS observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS measurement_window_hours integer,
  ADD COLUMN IF NOT EXISTS attribution_rule text,
  ADD COLUMN IF NOT EXISTS attribution_version text,
  ADD COLUMN IF NOT EXISTS attribution_conflict boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dq_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS excluded_from_learning boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS agent_outcome_watch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  log_id uuid NOT NULL REFERENCES agent_action_log(id) ON DELETE CASCADE,
  action_slug text NOT NULL REFERENCES agent_action_catalog(slug),
  rule_key text NOT NULL CHECK (rule_key IN ('booking_after_sms', 'financing_offer_acceptance', 'invoice_paid_after_action')),
  rule_version text NOT NULL DEFAULT 'v1',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'measured', 'final')),
  executed_at_observed timestamptz,
  window_start timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('success', 'partial', 'failure', 'no_effect', 'unknown')),
  conflict boolean NOT NULL DEFAULT false,
  excluded boolean NOT NULL DEFAULT false,
  dq_flags text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  measured_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (log_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_outcome_watch_open
  ON agent_outcome_watch(state, window_ends_at) WHERE state <> 'final';
CREATE INDEX IF NOT EXISTS idx_agent_outcome_watch_user
  ON agent_outcome_watch(user_id, action_slug, state);

ALTER TABLE agent_outcome_watch ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_agent_outcome_watch" ON agent_outcome_watch;
CREATE POLICY "select_own_agent_outcome_watch" ON agent_outcome_watch FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client write policy — written only by the service-role RPCs below.

CREATE OR REPLACE FUNCTION public.enroll_outcome_watches(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  WITH cand AS (
    SELECT l.id, l.user_id, l.action_slug, l.target_table, l.executed_at,
           COALESCE(l.executed_at, l.created_at) AS wstart
    FROM agent_action_log l
    JOIN outcome_learning_settings s ON s.user_id = l.user_id AND s.capture_enabled
    WHERE l.status = 'executed'
      AND l.target_id IS NOT NULL
      AND l.target_table IN ('workflow_runs', 'financing_offers', 'invoices')
      AND NOT EXISTS (SELECT 1 FROM agent_outcome_watch w WHERE w.log_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM agent_action_outcomes o WHERE o.log_id = l.id)
    ORDER BY l.created_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 5000))
  )
  INSERT INTO agent_outcome_watch (
    user_id, log_id, action_slug, rule_key, executed_at_observed, window_start, window_ends_at, dq_flags
  )
  SELECT
    c.user_id, c.id, c.action_slug,
    CASE c.target_table
      WHEN 'workflow_runs' THEN 'booking_after_sms'
      WHEN 'financing_offers' THEN 'financing_offer_acceptance'
      ELSE 'invoice_paid_after_action' END,
    c.executed_at, c.wstart,
    c.wstart + (CASE c.target_table
      WHEN 'workflow_runs' THEN interval '72 hours'
      WHEN 'financing_offers' THEN interval '336 hours'
      ELSE interval '720 hours' END),
    CASE WHEN c.executed_at IS NULL THEN ARRAY['executed_at_missing'] ELSE '{}'::text[] END
  FROM cand c
  ON CONFLICT (log_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.enroll_outcome_watches(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_outcome_watches(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_outcome_watch(
  p_watch_id uuid,
  p_state text,
  p_outcome text,
  p_financial_cents integer DEFAULT NULL,
  p_confidence numeric DEFAULT 1.0,
  p_evidence jsonb DEFAULT '{}'::jsonb,
  p_flags text[] DEFAULT '{}',
  p_conflict boolean DEFAULT false
)
RETURNS agent_outcome_watch
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w agent_outcome_watch;
  v_existing agent_action_outcomes;
  v_excluded boolean;
  v_hours integer;
BEGIN
  IF p_state NOT IN ('measured', 'final') THEN
    RAISE EXCEPTION 'Invalid state: %', p_state;
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('success', 'partial', 'failure', 'no_effect', 'unknown') THEN
    RAISE EXCEPTION 'Invalid outcome: %', p_outcome;
  END IF;

  SELECT * INTO w FROM agent_outcome_watch WHERE id = p_watch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outcome watch % not found.', p_watch_id;
  END IF;
  IF w.state = 'final' THEN
    RETURN w; -- idempotent replay
  END IF;

  IF p_state = 'measured' THEN
    UPDATE agent_outcome_watch
    SET state = 'measured', outcome = p_outcome, measured_at = now(),
        evidence = COALESCE(p_evidence, '{}'::jsonb), dq_flags = COALESCE(p_flags, '{}')
    WHERE id = p_watch_id RETURNING * INTO w;
    RETURN w;
  END IF;

  v_excluded := p_outcome = 'unknown' OR COALESCE(p_conflict, false)
    OR COALESCE(p_flags, '{}') && ARRAY[
      'executed_at_missing', 'executed_at_in_future', 'status_timestamp_invalid',
      'paid_at_invalid', 'unresolvable_target', 'outcome_preceded_action', 'invoice_void'];
  v_hours := round(extract(epoch FROM (w.window_ends_at - w.window_start)) / 3600);

  SELECT * INTO v_existing FROM agent_action_outcomes WHERE log_id = w.log_id;
  IF FOUND AND v_existing.recorded_by = 'human' THEN
    -- A human-recorded outcome is authoritative; never overwrite it.
    UPDATE agent_outcome_watch
    SET state = 'final', outcome = v_existing.outcome, finalized_at = now(),
        dq_flags = array_append(COALESCE(p_flags, '{}'), 'human_outcome_kept')
    WHERE id = p_watch_id RETURNING * INTO w;
    RETURN w;
  END IF;

  PERFORM public.record_agent_action_business_outcome(
    w.log_id, p_outcome, p_financial_cents, COALESCE(p_confidence, 1.0),
    COALESCE(p_evidence, '{}'::jsonb) || jsonb_build_object('attribution_version', w.rule_version, 'rule', w.rule_key),
    'Auto-attributed by outcome-reconciler (' || w.rule_key || ' ' || w.rule_version || ').',
    'system');

  UPDATE agent_action_outcomes
  SET observed_at = now(), measurement_window_hours = v_hours, attribution_rule = w.rule_key,
      attribution_version = w.rule_version, attribution_conflict = COALESCE(p_conflict, false),
      dq_flags = COALESCE(p_flags, '{}'), excluded_from_learning = v_excluded
  WHERE log_id = w.log_id;

  PERFORM public.refresh_agent_action_learning_stats(w.user_id, w.action_slug);

  UPDATE agent_outcome_watch
  SET state = 'final', outcome = p_outcome, conflict = COALESCE(p_conflict, false), excluded = v_excluded,
      dq_flags = COALESCE(p_flags, '{}'), evidence = COALESCE(p_evidence, '{}'::jsonb),
      measured_at = COALESCE(measured_at, now()), finalized_at = now()
  WHERE id = p_watch_id RETURNING * INTO w;
  RETURN w;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_outcome_watch(uuid, text, text, integer, numeric, jsonb, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_outcome_watch(uuid, text, text, integer, numeric, jsonb, text[], boolean) TO service_role;

-- Re-created with a strict-mode filter (see header). Same signature and grants.
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
  v_strict boolean;
BEGIN
  -- Strict mode (outcome-learning capture enabled for this account): unknown,
  -- conflicted and low-quality outcomes are EXCLUDED from learning stats.
  SELECT capture_enabled INTO v_strict FROM outcome_learning_settings WHERE user_id = p_user_id;
  v_strict := COALESCE(v_strict, false);
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
  WHERE user_id = p_user_id AND action_slug = p_action_slug
    AND (NOT v_strict OR (outcome <> 'unknown' AND NOT excluded_from_learning));

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
-- OBSERVABILITY VIEWS (security_invoker => caller's RLS applies)
-- =============================================================

CREATE OR REPLACE VIEW public.outcome_data_quality_v WITH (security_invoker = true) AS
SELECT
  w.user_id,
  w.action_slug,
  w.rule_key,
  count(*)::integer AS watched,
  count(*) FILTER (WHERE w.state = 'final')::integer AS final_count,
  count(*) FILTER (WHERE w.state <> 'final')::integer AS open_count,
  count(*) FILTER (WHERE w.state = 'final' AND w.outcome = 'unknown')::integer AS unknown_count,
  count(*) FILTER (WHERE w.state = 'final' AND w.conflict)::integer AS conflict_count,
  count(*) FILTER (WHERE w.state = 'final' AND NOT w.excluded)::integer AS learnable_count,
  round(count(*) FILTER (WHERE w.state = 'final' AND w.outcome = 'unknown')::numeric
        / NULLIF(count(*) FILTER (WHERE w.state = 'final'), 0), 4) AS unknown_rate,
  round(count(*) FILTER (WHERE w.state = 'final' AND w.conflict)::numeric
        / NULLIF(count(*) FILTER (WHERE w.state = 'final'), 0), 4) AS conflict_rate,
  round(100 * count(*) FILTER (WHERE w.state = 'final' AND NOT w.excluded)::numeric / NULLIF(count(*), 0), 1) AS quality_score
FROM agent_outcome_watch w
GROUP BY w.user_id, w.action_slug, w.rule_key;

CREATE OR REPLACE VIEW public.outcome_coverage_v WITH (security_invoker = true) AS
SELECT
  l.user_id,
  l.action_slug,
  count(*)::integer AS executed_actions,
  count(o.id)::integer AS with_outcome,
  count(*) FILTER (WHERE o.id IS NOT NULL AND o.outcome <> 'unknown')::integer AS with_known_outcome,
  round(100 * count(o.id)::numeric / NULLIF(count(*), 0), 1) AS coverage_pct
FROM agent_action_log l
LEFT JOIN agent_action_outcomes o ON o.log_id = l.id
WHERE l.status IN ('executed', 'rolled_back')
GROUP BY l.user_id, l.action_slug;

GRANT SELECT ON public.outcome_data_quality_v, public.outcome_coverage_v TO authenticated, service_role;
