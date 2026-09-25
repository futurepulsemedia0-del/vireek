/*
  # Self-Evolving Company Operating Model

  ## Why
  Every other AI surface in this codebase (constitution, decision engine,
  regret console, outcome learning) answers "what should we do right now?"
  This one closes the loop over time: it watches whether policies (pricing,
  staffing, marketing, process, SLA) are actually hitting their targets, and
  — the same philosophy as outcomeLearning.ts — proposes a small, bounded,
  fully-explained adjustment when evidence is strong enough. Nothing is
  applied automatically; every proposal is a human decision, logged either
  way, which is what makes this an audit trail instead of an autopilot.

  ## Loop
  observe (operating_policy_observations, fed by the owner or other
  systems) -> learn (run_evolution_cycle, deterministic, no LLM) ->
  propose (evolution_proposals) -> decide (decide_evolution_proposal) ->
  apply (operating_policies.current_value moves, evolution_count++).

  ## Guardrails
  - A proposal only fires when sample_size clears MIN_SAMPLES and the
    deviation from target clears MIN_DEVIATION_PCT — small samples produce
    no proposal at all, never a shaky one.
  - The proposed step is capped at policy.step_pct and always clamped to
    [guardrail_min, guardrail_max].
  - Every proposal carries its evidence (observed vs target, sample size,
    period) so the owner can inspect the "why", not just the "what".
*/

CREATE TABLE IF NOT EXISTS operating_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  domain text NOT NULL CHECK (domain IN ('pricing', 'staffing', 'marketing', 'process', 'sla')),
  key text NOT NULL,
  label text NOT NULL,
  description text,
  current_value numeric NOT NULL,
  unit text NOT NULL DEFAULT 'pct',
  guardrail_min numeric NOT NULL,
  guardrail_max numeric NOT NULL,
  step_pct numeric NOT NULL DEFAULT 10,
  evolution_count integer NOT NULL DEFAULT 0,
  last_evolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_op_user ON operating_policies(user_id, domain);
ALTER TABLE operating_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_operating_policies" ON operating_policies;
CREATE POLICY "manage_own_operating_policies" ON operating_policies FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS operating_policy_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  policy_id uuid NOT NULL REFERENCES operating_policies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  observed_metric numeric NOT NULL,
  target_metric numeric NOT NULL,
  sample_size integer NOT NULL DEFAULT 1 CHECK (sample_size > 0),
  source text NOT NULL DEFAULT 'manual',
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opo_policy ON operating_policy_observations(policy_id, recorded_at DESC);
ALTER TABLE operating_policy_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "manage_own_operating_observations" ON operating_policy_observations;
CREATE POLICY "manage_own_operating_observations" ON operating_policy_observations FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS evolution_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  policies_reviewed integer NOT NULL DEFAULT 0,
  proposals_created integer NOT NULL DEFAULT 0,
  summary text
);

CREATE INDEX IF NOT EXISTS idx_ec_user ON evolution_cycles(user_id, started_at DESC);
ALTER TABLE evolution_cycles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_evolution_cycles" ON evolution_cycles;
CREATE POLICY "select_own_evolution_cycles" ON evolution_cycles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT — only run_evolution_cycle() writes here.

CREATE TABLE IF NOT EXISTS evolution_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  cycle_id uuid NOT NULL REFERENCES evolution_cycles(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES operating_policies(id) ON DELETE CASCADE,
  current_value_snapshot numeric NOT NULL,
  proposed_value numeric NOT NULL,
  direction text NOT NULL CHECK (direction IN ('increase', 'decrease')),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ep_user ON evolution_proposals(user_id, status, created_at DESC);
ALTER TABLE evolution_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_evolution_proposals" ON evolution_proposals;
CREATE POLICY "select_own_evolution_proposals" ON evolution_proposals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE — only run_evolution_cycle() / decide_evolution_proposal() below.

-- =============================================================
-- Seed a starter policy set (idempotent — safe to call every load)
-- =============================================================
CREATE OR REPLACE FUNCTION public.seed_default_operating_policies()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  INSERT INTO operating_policies (user_id, domain, key, label, description, current_value, unit, guardrail_min, guardrail_max, step_pct)
  VALUES
    (v_owner, 'pricing', 'quote_price_multiplier', 'Quote price multiplier', 'Multiplier applied over catalog cost when quoting jobs.', 1.00, 'x', 0.85, 1.35, 5),
    (v_owner, 'staffing', 'technician_buffer_pct', 'Technician capacity buffer', 'Spare capacity held back from same-day booking.', 15, 'pct', 5, 30, 10),
    (v_owner, 'marketing', 'demand_campaign_budget_pct', 'Demand campaign budget share', 'Share of marketing budget spent on demand-generation campaigns.', 40, 'pct', 10, 70, 10),
    (v_owner, 'process', 'callback_followup_hours', 'Callback follow-up window', 'Hours allowed before a flagged callback risk must be followed up.', 24, 'hours', 4, 72, 15),
    (v_owner, 'sla', 'first_response_minutes', 'SLA first-response target', 'Target minutes to first response on a new job or claim.', 30, 'minutes', 5, 120, 15)
  ON CONFLICT (user_id, key) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_operating_policies() TO authenticated;

-- =============================================================
-- Log an observed outcome against a policy's target (the "observe" step)
-- =============================================================
CREATE OR REPLACE FUNCTION public.log_operating_observation(
  p_policy_id uuid, p_observed_metric numeric, p_target_metric numeric,
  p_sample_size integer, p_period_start date, p_period_end date, p_source text DEFAULT 'manual'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM operating_policies WHERE id = p_policy_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Policy not found or not authorized';
  END IF;

  INSERT INTO operating_policy_observations (user_id, policy_id, period_start, period_end, observed_metric, target_metric, sample_size, source)
  VALUES (v_owner, p_policy_id, p_period_start, p_period_end, p_observed_metric, p_target_metric, GREATEST(p_sample_size, 1), p_source)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_operating_observation(uuid, numeric, numeric, integer, date, date, text) TO authenticated, service_role;

-- =============================================================
-- THE LEARNING STEP: deterministic, explainable, bounded.
-- Aggregates observations from the last 60 days per policy; proposes a
-- capped nudge only when sample size and deviation both clear thresholds.
-- =============================================================
CREATE OR REPLACE FUNCTION public.run_evolution_cycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cycle_id uuid;
  v_policy record;
  v_avg_observed numeric; v_avg_target numeric; v_samples integer;
  v_deviation_pct numeric; v_direction text; v_confidence text;
  v_step numeric; v_proposed numeric;
  v_reviewed integer := 0; v_created integer := 0;
  MIN_SAMPLES CONSTANT integer := 5;
  MIN_DEVIATION_PCT CONSTANT numeric := 8;
BEGIN
  INSERT INTO evolution_cycles (user_id, policies_reviewed, proposals_created)
  VALUES (v_owner, 0, 0) RETURNING id INTO v_cycle_id;

  FOR v_policy IN SELECT * FROM operating_policies WHERE user_id = v_owner LOOP
    v_reviewed := v_reviewed + 1;

    SELECT avg(observed_metric), avg(target_metric), sum(sample_size)
      INTO v_avg_observed, v_avg_target, v_samples
      FROM operating_policy_observations
      WHERE policy_id = v_policy.id AND user_id = v_owner
        AND recorded_at > now() - interval '60 days';

    IF v_samples IS NULL OR v_samples < MIN_SAMPLES OR v_avg_target = 0 THEN
      CONTINUE;
    END IF;

    v_deviation_pct := ((v_avg_observed - v_avg_target) / abs(v_avg_target)) * 100;

    IF abs(v_deviation_pct) < MIN_DEVIATION_PCT THEN
      CONTINUE;
    END IF;

    -- Missing target (observed < target, e.g. SLA minutes running over,
    -- capacity buffer too thin) -> loosen the policy upward; overshooting
    -- -> tighten it back down. Step is capped by the policy's own step_pct
    -- and shrunk for samples that are strong-but-not-huge.
    v_direction := CASE WHEN v_avg_observed < v_avg_target THEN 'increase' ELSE 'decrease' END;
    v_confidence := CASE WHEN v_samples >= MIN_SAMPLES * 4 THEN 'high' WHEN v_samples >= MIN_SAMPLES * 2 THEN 'medium' ELSE 'low' END;
    v_step := v_policy.step_pct * (CASE v_confidence WHEN 'high' THEN 1 WHEN 'medium' THEN 0.66 ELSE 0.4 END) / 100;

    v_proposed := CASE WHEN v_direction = 'increase'
      THEN v_policy.current_value * (1 + v_step)
      ELSE v_policy.current_value * (1 - v_step)
    END;
    v_proposed := LEAST(GREATEST(v_proposed, v_policy.guardrail_min), v_policy.guardrail_max);

    IF round(v_proposed, 4) = round(v_policy.current_value, 4) THEN
      CONTINUE;
    END IF;

    INSERT INTO evolution_proposals (
      user_id, cycle_id, policy_id, current_value_snapshot, proposed_value, direction, confidence, rationale, evidence
    ) VALUES (
      v_owner, v_cycle_id, v_policy.id, v_policy.current_value, round(v_proposed, 4), v_direction, v_confidence,
      format(
        '%s observations over the last 60 days average %s vs a target of %s (%s%% deviation) — proposing to %s "%s" from %s to %s %s.',
        v_samples, round(v_avg_observed, 2), round(v_avg_target, 2), round(v_deviation_pct, 1),
        v_direction, v_policy.label, v_policy.current_value, round(v_proposed, 4), v_policy.unit
      ),
      jsonb_build_object(
        'sample_size', v_samples, 'avg_observed', round(v_avg_observed, 4), 'avg_target', round(v_avg_target, 4),
        'deviation_pct', round(v_deviation_pct, 2), 'window_days', 60
      )
    );
    v_created := v_created + 1;
  END LOOP;

  UPDATE evolution_cycles
    SET completed_at = now(), policies_reviewed = v_reviewed, proposals_created = v_created,
        summary = format('Reviewed %s polic%s, proposed %s adjustment%s.', v_reviewed, CASE WHEN v_reviewed = 1 THEN 'y' ELSE 'ies' END, v_created, CASE WHEN v_created = 1 THEN '' ELSE 's' END)
    WHERE id = v_cycle_id;

  RETURN jsonb_build_object('cycle_id', v_cycle_id, 'policies_reviewed', v_reviewed, 'proposals_created', v_created);
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_evolution_cycle() TO authenticated;

-- =============================================================
-- Human decision (always logged; approving is the only path that moves
-- operating_policies.current_value — this is the "apply" step)
-- =============================================================
CREATE OR REPLACE FUNCTION public.decide_evolution_proposal(p_proposal_id uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_proposal record;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected';
  END IF;

  SELECT * INTO v_proposal FROM evolution_proposals WHERE id = p_proposal_id AND user_id = v_owner AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal not found, not authorized, or already decided';
  END IF;

  UPDATE evolution_proposals SET status = p_decision, decision_reason = p_reason, decided_at = now() WHERE id = p_proposal_id;

  IF p_decision = 'approved' THEN
    UPDATE operating_policies
      SET current_value = v_proposal.proposed_value, evolution_count = evolution_count + 1, last_evolved_at = now()
      WHERE id = v_proposal.policy_id AND user_id = v_owner;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_evolution_proposal(uuid, text, text) TO authenticated;
