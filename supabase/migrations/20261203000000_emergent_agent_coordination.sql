/*
  # Emergent Agent Coordination

  ## Why
  Vireek runs several independent, cron-scheduled agents
  (service-recovery-agent, followup-agent-dispatcher,
  membership-lifecycle-agent, marketing dispatchers, ...) that each
  decide, with no knowledge of the others, whether to contact a given
  customer. Nothing currently stops two agents from contacting the
  same lead/job within minutes of each other.

  This migration adds a decentralized arbitration layer: agents post
  a bid (their own locally-computed urgency score) for a
  (target, action_category) slot instead of acting unconditionally.
  Arbitration happens the instant a bid lands, against whatever other
  bids already exist for that exact slot — no agent knows this
  ranking in advance, and no central table hardcodes agent priority.
  A bounded, reinforcement-updated reputation_weight (0.4-2.5x) lets
  agents whose contacts actually work earn a larger share of future
  contested slots over time, purely from repeated local interactions.

  This sits IN FRONT OF agent_action_governance
  (20261121000000_ai_agent_governance.sql): an agent should only call
  authorizeAgentAction() / actually contact the customer AFTER it has
  won a coordination bid here. The two layers answer different
  questions — this one answers "whose turn is it", governance answers
  "is this specific action allowed".

  ## What this adds
  1. `agent_coordination_bids` — one row per bid; the live/historical
     record of who claimed what, and who deferred to whom.
  2. `agent_coordination_reputation` — per (account, agent, category)
     running win/deferral/outcome counters and the derived weight.
  3. RPCs, both SECURITY DEFINER, called from edge functions via the
     service-role client (same pattern as evaluate_agent_action()):
     - submit_coordination_bid()     — post a bid, get instant arbitration
     - record_coordination_outcome() — close the loop, update reputation

  RLS mirrors 20261121000000_ai_agent_governance.sql: whole-account
  SELECT via get_account_owner_id(), no direct client
  INSERT/UPDATE/DELETE policies — all writes go through the two
  SECURITY DEFINER RPCs above.
*/

-- =============================================================
-- AGENT_COORDINATION_BIDS
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_coordination_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_category text NOT NULL,
  target_table text NOT NULL,
  target_id text NOT NULL,
  agent_source text NOT NULL,
  contact_channel text,
  base_score numeric NOT NULL,
  weighted_score numeric NOT NULL,
  reasoning text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'won', 'deferred', 'executed', 'expired')),
  claim_window_ends_at timestamptz NOT NULL,
  defer_until timestamptz,
  outcome text CHECK (outcome IN ('success', 'no_response', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_coordination_bids_target
  ON agent_coordination_bids (user_id, target_table, target_id, action_category, status);

ALTER TABLE agent_coordination_bids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_coordination_bids" ON agent_coordination_bids;
CREATE POLICY "select_own_agent_coordination_bids" ON agent_coordination_bids FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- AGENT_COORDINATION_REPUTATION
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_coordination_reputation (
  user_id uuid NOT NULL,
  agent_source text NOT NULL,
  action_category text NOT NULL,
  wins integer NOT NULL DEFAULT 0,
  deferrals integer NOT NULL DEFAULT 0,
  outcomes_total integer NOT NULL DEFAULT 0,
  outcomes_success integer NOT NULL DEFAULT 0,
  reputation_weight numeric NOT NULL DEFAULT 1.0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_source, action_category)
);

ALTER TABLE agent_coordination_reputation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_coordination_reputation" ON agent_coordination_reputation;
CREATE POLICY "select_own_agent_coordination_reputation" ON agent_coordination_reputation FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- RPC: submit_coordination_bid — post a bid, get instant arbitration
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_coordination_bid(
  p_user_id uuid,
  p_agent_source text,
  p_action_category text,
  p_target_table text,
  p_target_id text,
  p_base_score numeric,
  p_reasoning text DEFAULT NULL,
  p_contact_channel text DEFAULT NULL,
  p_window_minutes integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rep agent_coordination_reputation;
  v_weight numeric := 1.0;
  v_bid agent_coordination_bids;
  v_incumbent agent_coordination_bids;
  v_now timestamptz := now();
BEGIN
  -- A crashed/timed-out agent shouldn't permanently squat a slot.
  UPDATE agent_coordination_bids
    SET status = 'expired'
    WHERE user_id = p_user_id AND target_table = p_target_table AND target_id = p_target_id
      AND action_category = p_action_category AND status IN ('open', 'won')
      AND claim_window_ends_at < v_now;

  SELECT * INTO v_rep FROM agent_coordination_reputation
    WHERE user_id = p_user_id AND agent_source = p_agent_source AND action_category = p_action_category;
  IF FOUND THEN v_weight := v_rep.reputation_weight; END IF;

  INSERT INTO agent_coordination_bids (
    user_id, action_category, target_table, target_id, agent_source, contact_channel,
    base_score, weighted_score, reasoning, status, claim_window_ends_at
  ) VALUES (
    p_user_id, p_action_category, p_target_table, p_target_id, p_agent_source, p_contact_channel,
    p_base_score, p_base_score * v_weight, p_reasoning, 'open', v_now + make_interval(mins => p_window_minutes)
  ) RETURNING * INTO v_bid;

  -- Arbitration: highest weighted_score currently alive for this exact
  -- slot wins; ties keep the earlier bid (created_at ASC) so a fresh
  -- bid can't casually displace an equally-urgent incumbent.
  SELECT * INTO v_incumbent FROM agent_coordination_bids
    WHERE user_id = p_user_id AND target_table = p_target_table AND target_id = p_target_id
      AND action_category = p_action_category AND status IN ('open', 'won')
      AND claim_window_ends_at >= v_now
    ORDER BY weighted_score DESC, created_at ASC
    LIMIT 1;

  IF v_incumbent.id = v_bid.id THEN
    UPDATE agent_coordination_bids SET status = 'won' WHERE id = v_bid.id;
    -- Demote every other still-live bid on this exact slot, including a
    -- previous winner this new bid just outranked.
    UPDATE agent_coordination_bids
      SET status = 'deferred'
      WHERE user_id = p_user_id AND target_table = p_target_table AND target_id = p_target_id
        AND action_category = p_action_category AND status IN ('open', 'won') AND id <> v_bid.id;

    INSERT INTO agent_coordination_reputation (user_id, agent_source, action_category, wins)
      VALUES (p_user_id, p_agent_source, p_action_category, 1)
      ON CONFLICT (user_id, agent_source, action_category)
      DO UPDATE SET wins = agent_coordination_reputation.wins + 1, updated_at = v_now;

    RETURN jsonb_build_object('decision', 'won', 'bid_id', v_bid.id);
  ELSE
    INSERT INTO agent_coordination_reputation (user_id, agent_source, action_category, deferrals)
      VALUES (p_user_id, p_agent_source, p_action_category, 1)
      ON CONFLICT (user_id, agent_source, action_category)
      DO UPDATE SET deferrals = agent_coordination_reputation.deferrals + 1, updated_at = v_now
      RETURNING * INTO v_rep;

    UPDATE agent_coordination_bids
      SET status = 'deferred',
          defer_until = v_now + make_interval(mins => LEAST(240, 20 * (1 + v_rep.deferrals)))
      WHERE id = v_bid.id
      RETURNING * INTO v_bid;

    RETURN jsonb_build_object(
      'decision', 'deferred', 'bid_id', v_bid.id,
      'defer_until', v_bid.defer_until, 'incumbent_agent', v_incumbent.agent_source
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_coordination_bid(uuid, text, text, text, text, numeric, text, text, integer) TO service_role, authenticated;

-- =============================================================
-- RPC: record_coordination_outcome — close the loop, update reputation
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_coordination_outcome(
  p_bid_id uuid,
  p_outcome text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bid agent_coordination_bids;
  v_success_delta integer := 0;
BEGIN
  IF p_outcome NOT IN ('success', 'no_response', 'failed') THEN
    RAISE EXCEPTION 'Invalid coordination outcome: %', p_outcome;
  END IF;

  UPDATE agent_coordination_bids SET status = 'executed', outcome = p_outcome
    WHERE id = p_bid_id RETURNING * INTO v_bid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bid not found');
  END IF;

  IF p_outcome = 'success' THEN v_success_delta := 1; END IF;

  INSERT INTO agent_coordination_reputation (user_id, agent_source, action_category, outcomes_total, outcomes_success)
    VALUES (v_bid.user_id, v_bid.agent_source, v_bid.action_category, 1, v_success_delta)
    ON CONFLICT (user_id, agent_source, action_category) DO UPDATE SET
      outcomes_total = agent_coordination_reputation.outcomes_total + 1,
      outcomes_success = agent_coordination_reputation.outcomes_success + v_success_delta,
      -- Bounded 0.4x-2.5x so no agent is ever fully silenced or fully
      -- dominant purely from a losing/winning streak.
      reputation_weight = GREATEST(0.4, LEAST(2.5,
        0.5 + 1.5 * ((agent_coordination_reputation.outcomes_success + v_success_delta)::numeric
                      / (agent_coordination_reputation.outcomes_total + 1))
      )),
      updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_coordination_outcome(uuid, text) TO service_role, authenticated;
