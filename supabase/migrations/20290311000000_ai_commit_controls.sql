/*
  # AI commit controls — thresholds above which the AI cannot commit a price or a time

  ## Why
  The voice assistant can speak a price (lookup_price) and put a job on the schedule (book_appointment).
  Agent Governance (20261121000000_ai_agent_governance.sql) already gates *agent actions* with on/off,
  spend caps and an approval queue, but it has no notion of "this price is too large for the AI to state"
  or "this time is too soon / too far / too long for the AI to promise". Its `auto_approve_max_cents` is an
  allow-ceiling for costs, not a hold-above-threshold for commitments, and it never sees what the AI told
  the customer. This migration adds only that missing piece and reuses the rest.

  ## What this adds
  1. `ai_commit_policies`        — one row per account: mode (off / shadow / enforce), price threshold,
                                    schedule thresholds, optional customer-facing disclosure text.
  2. `ai_commit_policy_changes`  — append-only history of every policy change (who, when, old, new), so
                                    "what limits applied on the day of the call?" is answerable.
  3. Two catalog slugs in `agent_action_catalog` (`ai_commit_price`, `ai_commit_schedule`) so every
     evaluation lands in the EXISTING `agent_action_log` audit trail and every held commitment appears in
     the EXISTING approval queue (decide_agent_action works on them unchanged).
  4. `upsert_ai_commit_policy()`    — account OWNER only (same rule decide_agent_action already has).
  5. `record_ai_commit_decision()`  — service role only; idempotent writer used by the edge functions.

  ## Decision logic
  The yes/no decision itself lives in supabase/functions/_shared/governance/commitThresholds.ts (a pure,
  unit-tested function). SQL stores the policy and the audit/approval record; it does not re-implement the
  comparison, so the two cannot disagree. The column defaults below MUST equal DEFAULT_POLICY in that file
  (a unit test reads this file and fails if they drift).

  ## Deliberate choices
  * The price is stored in agent_action_log.payload, NOT in amount_cents. evaluate_agent_action() sums
    amount_cents across ALL actions for global spending limits; a quoted price is not spend, and putting it
    there would silently exhaust those limits.
  * Default mode is 'shadow': decisions are audited ("would have required approval") but nothing is held.
    Deploying this migration therefore changes no customer-facing behaviour until an owner (or a later
    migration, after review) sets 'enforce'.
  * No data is deleted or rewritten; every statement is idempotent.

  ## Rollback / recovery
  Forward-only. To stop using it: set every row's mode to 'off' (UPDATE ai_commit_policies SET mode='off').
  The tables are additive; dropping them is safe only after the edge-function change is reverted.
*/

-- =============================================================
-- AI_COMMIT_POLICIES
-- =============================================================

CREATE TABLE IF NOT EXISTS ai_commit_policies (
  user_id uuid PRIMARY KEY,
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('off', 'shadow', 'enforce')),
  -- Prices are integer minor units (cents) of the account's own currency. Above this, the AI may not state a price.
  price_threshold_cents integer NOT NULL DEFAULT 100000 CHECK (price_threshold_cents >= 0 AND price_threshold_cents <= 100000000),
  -- 0 = rule off. Otherwise a visit sooner than this many minutes from now needs a human.
  schedule_min_notice_minutes integer NOT NULL DEFAULT 0 CHECK (schedule_min_notice_minutes >= 0 AND schedule_min_notice_minutes <= 10080),
  -- A visit further out than this many days needs a human.
  schedule_max_days_ahead integer NOT NULL DEFAULT 60 CHECK (schedule_max_days_ahead >= 0 AND schedule_max_days_ahead <= 730),
  -- A visit expected to take longer than this many minutes needs a human.
  schedule_max_duration_minutes integer NOT NULL DEFAULT 480 CHECK (schedule_max_duration_minutes > 0 AND schedule_max_duration_minutes <= 10080),
  -- What the assistant tells the customer when it cannot confirm. NULL = built-in text. [COUNSEL] reviews the built-in.
  disclosure_text text CHECK (disclosure_text IS NULL OR char_length(disclosure_text) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE ai_commit_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_commit_policies" ON ai_commit_policies;
CREATE POLICY "select_own_ai_commit_policies" ON ai_commit_policies FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

-- No client INSERT/UPDATE/DELETE policy: writes go through upsert_ai_commit_policy() only.

-- =============================================================
-- AI_COMMIT_POLICY_CHANGES — append-only history
-- =============================================================

CREATE TABLE IF NOT EXISTS ai_commit_policy_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  old_values jsonb,
  new_values jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_commit_policy_changes_user_time
  ON ai_commit_policy_changes(user_id, changed_at DESC);

ALTER TABLE ai_commit_policy_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_commit_policy_changes" ON ai_commit_policy_changes;
CREATE POLICY "select_own_ai_commit_policy_changes" ON ai_commit_policy_changes FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

CREATE OR REPLACE FUNCTION public.log_ai_commit_policy_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO ai_commit_policy_changes (user_id, changed_by, old_values, new_values)
    VALUES (NEW.user_id, NEW.updated_by, to_jsonb(OLD) - 'updated_at', to_jsonb(NEW) - 'updated_at');
  ELSE
    INSERT INTO ai_commit_policy_changes (user_id, changed_by, old_values, new_values)
    VALUES (NEW.user_id, NEW.updated_by, NULL, to_jsonb(NEW) - 'updated_at');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_commit_policy_change_log ON ai_commit_policies;
CREATE TRIGGER trg_ai_commit_policy_change_log
  AFTER INSERT OR UPDATE ON ai_commit_policies
  FOR EACH ROW EXECUTE FUNCTION public.log_ai_commit_policy_change();

-- =============================================================
-- CATALOG — reuse the existing audit trail and approval queue
-- =============================================================

INSERT INTO agent_action_catalog (slug, agent_source, label, category, is_reversible, has_cost, default_requires_approval) VALUES
  ('ai_commit_price', 'vapi-webhook', 'AI stated a price to a customer', 'financial', false, false, false),
  ('ai_commit_schedule', 'vapi-webhook', 'AI committed a visit time to a customer', 'other', false, false, false)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- RPC: upsert_ai_commit_policy — account owner only
-- NULL argument = keep the current value (or the column default on first save).
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_ai_commit_policy(
  p_mode text DEFAULT NULL,
  p_price_threshold_cents integer DEFAULT NULL,
  p_schedule_min_notice_minutes integer DEFAULT NULL,
  p_schedule_max_days_ahead integer DEFAULT NULL,
  p_schedule_max_duration_minutes integer DEFAULT NULL,
  p_disclosure_text text DEFAULT NULL,
  p_clear_disclosure boolean DEFAULT false
)
RETURNS ai_commit_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row ai_commit_policies;
  v_disclosure text := NULLIF(btrim(p_disclosure_text), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;
  -- Same rule as decide_agent_action(): only the account owner changes governance.
  IF v_uid IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Only the account owner can change AI commit limits.';
  END IF;
  IF p_mode IS NOT NULL AND p_mode NOT IN ('off', 'shadow', 'enforce') THEN
    RAISE EXCEPTION 'Invalid mode: %', p_mode;
  END IF;

  INSERT INTO ai_commit_policies AS p (
    user_id, mode, price_threshold_cents, schedule_min_notice_minutes,
    schedule_max_days_ahead, schedule_max_duration_minutes, disclosure_text, updated_by
  ) VALUES (
    v_uid,
    COALESCE(p_mode, 'shadow'),
    COALESCE(p_price_threshold_cents, 100000),
    COALESCE(p_schedule_min_notice_minutes, 0),
    COALESCE(p_schedule_max_days_ahead, 60),
    COALESCE(p_schedule_max_duration_minutes, 480),
    CASE WHEN p_clear_disclosure THEN NULL ELSE v_disclosure END,
    v_uid
  )
  ON CONFLICT (user_id) DO UPDATE SET
    mode = COALESCE(p_mode, p.mode),
    price_threshold_cents = COALESCE(p_price_threshold_cents, p.price_threshold_cents),
    schedule_min_notice_minutes = COALESCE(p_schedule_min_notice_minutes, p.schedule_min_notice_minutes),
    schedule_max_days_ahead = COALESCE(p_schedule_max_days_ahead, p.schedule_max_days_ahead),
    schedule_max_duration_minutes = COALESCE(p_schedule_max_duration_minutes, p.schedule_max_duration_minutes),
    disclosure_text = CASE WHEN p_clear_disclosure THEN NULL WHEN v_disclosure IS NOT NULL THEN v_disclosure ELSE p.disclosure_text END,
    updated_at = now(),
    updated_by = v_uid
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ai_commit_policy(text, integer, integer, integer, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_ai_commit_policy(text, integer, integer, integer, integer, text, boolean) TO authenticated;

-- =============================================================
-- RPC: record_ai_commit_decision — service role only, idempotent
-- p_decision: 'auto_approved' (inside the limits, or shadow mode) | 'pending_approval' (held for a human)
-- Re-sending the same (user, kind, correlation id) returns the first row, never a second one.
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_ai_commit_decision(
  p_user_id uuid,
  p_kind text,
  p_agent_source text,
  p_decision text,
  p_correlation_id text,
  p_reasoning text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
  v_existing agent_action_log;
  v_log agent_action_log;
BEGIN
  IF p_kind NOT IN ('price', 'schedule') THEN
    RAISE EXCEPTION 'Invalid commit kind: %', p_kind;
  END IF;
  IF p_decision NOT IN ('auto_approved', 'pending_approval') THEN
    RAISE EXCEPTION 'Invalid commit decision: %', p_decision;
  END IF;
  IF p_user_id IS NULL OR p_correlation_id IS NULL OR btrim(p_correlation_id) = '' THEN
    RAISE EXCEPTION 'user and correlation id are required.';
  END IF;

  v_slug := 'ai_commit_' || p_kind;

  -- Serialise concurrent retries of the same tool call.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || v_slug || '|' || p_correlation_id, 0));

  SELECT * INTO v_existing FROM agent_action_log
    WHERE user_id = p_user_id AND action_slug = v_slug AND correlation_id = p_correlation_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('decision', v_existing.status, 'log_id', v_existing.id, 'existing', true);
  END IF;

  INSERT INTO agent_action_log (
    user_id, action_slug, agent_source, target_table, target_id,
    reasoning, payload, status, correlation_id, decision_reason
  ) VALUES (
    p_user_id, v_slug, COALESCE(NULLIF(p_agent_source, ''), 'vapi-webhook'), 'ai_tool_call', p_correlation_id,
    p_reasoning, COALESCE(p_payload, '{}'::jsonb), p_decision, p_correlation_id,
    CASE WHEN p_decision = 'pending_approval' THEN 'Held for human approval: the AI assistant may not commit this on its own.' ELSE NULL END
  ) RETURNING * INTO v_log;

  RETURN jsonb_build_object('decision', v_log.status, 'log_id', v_log.id, 'existing', false);
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_commit_decision(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_commit_decision(uuid, text, text, text, text, text, jsonb) TO service_role;
