/*
  # AI Reliability & Governance Engine

  ## Why
  Vireek makes real decisions (dispatch, pricing, estimates, follow-ups, ...).
  For every AI decision this engine permanently records:
    why it was made (reasoning + weighted factors), what data was used,
    how confident the AI was, which model/agent decided, which policies were
    applied, whether a human approved / rejected / overrode it, what the real
    outcome was, whether the AI was wrong, and if so why.

  That is the base of:  AI Audit -> AI Evaluation -> AI Governance -> Continuous Learning.

  ## What this adds (all additive — no existing table is altered)
  1. ai_governance_settings     : per-account policy (confidence threshold, kill switch, ...).
  2. ai_decision_records        : one row per AI decision. Core fields are IMMUTABLE and sealed in a
                                  per-account SHA-256 hash chain (tamper-evident audit trail).
  3. ai_decision_events         : append-only lifecycle timeline (review, execution, outcome, violations).
  4. ai_governance_suggestions  : deterministic, explainable "continuous learning" suggestions.
                                  Nothing is ever applied automatically — a human accepts or dismisses.
  5. RPCs:
       record_ai_decision / mark_ai_decision_executed        (service role — edge functions)
       record_ai_decision_outcome                             (service role AND dashboard)
       review_ai_decision, get/upsert_ai_governance_settings,
       get_ai_reliability_metrics, verify_ai_decision_chain,
       refresh_ai_governance_suggestions, decide_ai_governance_suggestion   (dashboard)
  6. Automatic bridges (each guarded — skipped if the source table does not exist, and a bridge
     failure can NEVER block the underlying business operation):
       agent_action_log      -> every governed agent action appears in the AI decision log
       agent_action_outcomes -> its real outcome is copied over
       jobs                  -> dispatch decisions get their outcome when the job completes / cancels

  RLS mirrors the existing governance tables: whole-account SELECT via get_account_owner_id(),
  no client INSERT/UPDATE/DELETE anywhere — every write goes through a SECURITY DEFINER function.
*/

-- =============================================================
-- HELPER: may the current user manage AI governance?
-- (owner, team admin, or a member with can_manage_security)
-- =============================================================

CREATE OR REPLACE FUNCTION public.ai_gov_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    auth.uid() = public.get_account_owner_id()
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND lower(tm.member_email) = lower((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()))
        AND (tm.role = 'admin' OR COALESCE((tm.permissions ->> 'can_manage_security')::boolean, false))
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.ai_gov_can_manage() TO authenticated;

-- =============================================================
-- 1. SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_governance_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Decisions with confidence below this need human review (0-100).
  min_confidence_auto numeric(5, 2) NOT NULL DEFAULT 75 CHECK (min_confidence_auto BETWEEN 0 AND 100),
  -- When true, a decision that carries no confidence score always needs review.
  require_confidence boolean NOT NULL DEFAULT false,
  -- Decisions worth at least this much always need review. NULL = rule off.
  require_review_amount_cents integer CHECK (require_review_amount_cents IS NULL OR require_review_amount_cents >= 0),
  always_review_types text[] NOT NULL DEFAULT '{}',
  -- Kill switch: decisions of these types are blocked.
  blocked_types text[] NOT NULL DEFAULT '{}',
  -- Per decision type override: { "dispatch": { "min_confidence_auto": 85 } }
  type_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_governance_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_governance_settings" ON public.ai_governance_settings;
CREATE POLICY "select_own_ai_governance_settings" ON public.ai_governance_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. DECISION RECORDS (immutable core + hash chain)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_decision_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  decision_type text NOT NULL CHECK (decision_type IN (
    'dispatch', 'pricing', 'estimate', 'diagnosis', 'triage', 'scheduling',
    'followup', 'campaign', 'financing', 'communication', 'agent_action', 'other'
  )),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  decision text NOT NULL DEFAULT '',                       -- what was decided
  reasoning text NOT NULL DEFAULT '',                      -- why
  reason_factors jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{ factor, weight, value }]
  data_used jsonb NOT NULL DEFAULT '[]'::jsonb,            -- [{ source, ref, fields }]
  confidence numeric(5, 2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),

  agent_source text NOT NULL,                              -- edge function / agent name
  engine_kind text NOT NULL DEFAULT 'llm' CHECK (engine_kind IN ('llm', 'rules', 'hybrid', 'human')),
  model_provider text,
  model_name text,
  model_version text,                                      -- prompt / ruleset version

  subject_table text,
  subject_id text,
  amount_cents integer,
  correlation_id text,

  policies_applied jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{ policy, result: pass|flag|block|skip, detail }]
  enforcement text NOT NULL DEFAULT 'pre_execution' CHECK (enforcement IN ('pre_execution', 'post_execution')),
  governance_action text NOT NULL CHECK (governance_action IN ('auto_approved', 'review_required', 'blocked')),

  /* Mutable lifecycle (changed only through the functions below / the bridges) */
  review_status text NOT NULL DEFAULT 'not_required'
    CHECK (review_status IN ('not_required', 'pending', 'approved', 'rejected', 'overridden')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  override_value jsonb,

  executed boolean NOT NULL DEFAULT false,
  executed_at timestamptz,
  execution_error text,

  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'successful', 'partial', 'failed', 'no_effect')),
  outcome_recorded_at timestamptz,
  outcome_notes text,
  financial_impact_cents integer,
  ai_was_wrong boolean,
  error_category text CHECK (error_category IS NULL OR error_category IN (
    'bad_data', 'wrong_reasoning', 'hallucination', 'policy_gap', 'stale_context',
    'external_change', 'human_error', 'other'
  )),
  error_explanation text,

  linked_action_log_id uuid,                               -- bridge to agent_action_log (no FK on purpose)

  /* Tamper-evident chain */
  chain_pos bigint NOT NULL DEFAULT 0,
  prev_hash text,
  record_hash text NOT NULL DEFAULT '',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_decision_chain_pos ON public.ai_decision_records (user_id, chain_pos);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_decision_linked_action ON public.ai_decision_records (linked_action_log_id)
  WHERE linked_action_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_decision_user_created ON public.ai_decision_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decision_user_type ON public.ai_decision_records (user_id, decision_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decision_pending_review ON public.ai_decision_records (user_id, created_at DESC)
  WHERE review_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ai_decision_subject ON public.ai_decision_records (user_id, subject_table, subject_id)
  WHERE subject_id IS NOT NULL;

ALTER TABLE public.ai_decision_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_decision_records" ON public.ai_decision_records;
CREATE POLICY "select_own_ai_decision_records" ON public.ai_decision_records
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Canonical hash of the immutable core of a record.
CREATE OR REPLACE FUNCTION public.ai_decision_hash(r public.ai_decision_records)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    COALESCE(r.prev_hash, ''),
    r.user_id::text,
    r.chain_pos::text,
    r.decision_type,
    r.title,
    r.decision,
    r.reasoning,
    r.reason_factors::text,
    r.data_used::text,
    to_char(COALESCE(r.confidence, -1), 'FM999990.00'),
    r.agent_source,
    r.engine_kind,
    COALESCE(r.model_provider, ''),
    COALESCE(r.model_name, ''),
    COALESCE(r.model_version, ''),
    r.enforcement,
    r.governance_action,
    r.policies_applied::text,
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

-- BEFORE INSERT: serialize per account, link to the previous record, seal with a hash.
CREATE OR REPLACE FUNCTION public.ai_decision_records_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_decision_chain:' || NEW.user_id::text, 0));

  SELECT record_hash, chain_pos INTO v_prev
  FROM public.ai_decision_records
  WHERE user_id = NEW.user_id
  ORDER BY chain_pos DESC
  LIMIT 1;

  IF FOUND THEN
    NEW.prev_hash := v_prev.record_hash;
    NEW.chain_pos := v_prev.chain_pos + 1;
  ELSE
    NEW.prev_hash := NULL;
    NEW.chain_pos := 1;
  END IF;

  NEW.record_hash := public.ai_decision_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_decision_records_before_insert ON public.ai_decision_records;
CREATE TRIGGER trg_ai_decision_records_before_insert
  BEFORE INSERT ON public.ai_decision_records
  FOR EACH ROW EXECUTE FUNCTION public.ai_decision_records_before_insert();

-- BEFORE UPDATE: the sealed core can never change, for anyone (service role included).
CREATE OR REPLACE FUNCTION public.ai_decision_records_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
       NEW.user_id, NEW.chain_pos, NEW.decision_type, NEW.title, NEW.decision, NEW.reasoning,
       NEW.reason_factors, NEW.data_used, NEW.confidence, NEW.agent_source, NEW.engine_kind,
       NEW.model_provider, NEW.model_name, NEW.model_version, NEW.subject_table, NEW.subject_id,
       NEW.amount_cents, NEW.enforcement, NEW.governance_action, NEW.policies_applied,
       NEW.prev_hash, NEW.record_hash, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.user_id, OLD.chain_pos, OLD.decision_type, OLD.title, OLD.decision, OLD.reasoning,
       OLD.reason_factors, OLD.data_used, OLD.confidence, OLD.agent_source, OLD.engine_kind,
       OLD.model_provider, OLD.model_name, OLD.model_version, OLD.subject_table, OLD.subject_id,
       OLD.amount_cents, OLD.enforcement, OLD.governance_action, OLD.policies_applied,
       OLD.prev_hash, OLD.record_hash, OLD.created_at
     )
  THEN
    RAISE EXCEPTION 'ai_decision_records: the sealed decision fields are immutable' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_decision_records_guard_update ON public.ai_decision_records;
CREATE TRIGGER trg_ai_decision_records_guard_update
  BEFORE UPDATE ON public.ai_decision_records
  FOR EACH ROW EXECUTE FUNCTION public.ai_decision_records_guard_update();

-- =============================================================
-- 3. EVENTS (append-only timeline)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid REFERENCES public.ai_decision_records(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'recorded', 'review_requested', 'approved', 'rejected', 'overridden', 'executed',
    'execution_failed', 'rolled_back', 'outcome_recorded', 'error_flagged', 'violation',
    'settings_changed', 'suggestion_accepted', 'suggestion_dismissed'
  )),
  actor_id uuid,                                           -- NULL = system
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_decision_events_record ON public.ai_decision_events (record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_decision_events_user ON public.ai_decision_events (user_id, created_at DESC);

ALTER TABLE public.ai_decision_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_decision_events" ON public.ai_decision_events;
CREATE POLICY "select_own_ai_decision_events" ON public.ai_decision_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. SUGGESTIONS (continuous learning — always human-approved)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.ai_governance_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('always_review', 'raise_confidence_threshold', 'lower_confidence_threshold')),
  title text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_min_confidence numeric(5, 2) CHECK (proposed_min_confidence IS NULL OR proposed_min_confidence BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_gov_suggestion_open
  ON public.ai_governance_suggestions (user_id, decision_type, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_ai_gov_suggestion_user ON public.ai_governance_suggestions (user_id, status, created_at DESC);

ALTER TABLE public.ai_governance_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ai_governance_suggestions" ON public.ai_governance_suggestions;
CREATE POLICY "select_own_ai_governance_suggestions" ON public.ai_governance_suggestions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Defense in depth: Supabase grants table privileges to these roles by default.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.ai_governance_settings,
  public.ai_decision_records,
  public.ai_decision_events,
  public.ai_governance_suggestions
FROM anon, authenticated;

-- =============================================================
-- CORE: _ai_gov_record — evaluates policy and writes one sealed record.
-- Internal only (called by record_ai_decision and by the bridges).
-- =============================================================

CREATE OR REPLACE FUNCTION public._ai_gov_record(
  p_user_id uuid,
  p_decision_type text,
  p_title text,
  p_decision text,
  p_reasoning text,
  p_agent_source text,
  p_confidence numeric,
  p_reason_factors jsonb,
  p_data_used jsonb,
  p_engine_kind text,
  p_model_provider text,
  p_model_name text,
  p_model_version text,
  p_subject_table text,
  p_subject_id text,
  p_amount_cents integer,
  p_correlation_id text,
  p_enforcement text,
  p_extra_policies jsonb,
  p_apply_settings boolean,
  p_executed boolean,
  p_linked_action_log_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_types constant text[] := ARRAY['dispatch','pricing','estimate','diagnosis','triage','scheduling','followup','campaign','financing','communication','agent_action','other'];
  v_type text;
  v_settings public.ai_governance_settings%ROWTYPE;
  v_min numeric := 75;
  v_require_conf boolean := false;
  v_amount integer := NULL;
  v_always text[] := '{}';
  v_blocked text[] := '{}';
  v_override numeric;
  v_policies jsonb := '[]'::jsonb;
  v_flag boolean := false;
  v_block boolean := false;
  v_action text;
  v_review text;
  v_id uuid;
  v_existing public.ai_decision_records%ROWTYPE;
  v_elem jsonb;
  v_result text;
  v_reason_factors jsonb := COALESCE(p_reason_factors, '[]'::jsonb);
  v_data_used jsonb := COALESCE(p_data_used, '[]'::jsonb);
  v_extra jsonb := COALESCE(p_extra_policies, '[]'::jsonb);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id is required'; END IF;
  IF COALESCE(btrim(p_agent_source), '') = '' THEN RAISE EXCEPTION 'agent_source is required'; END IF;
  IF COALESCE(btrim(p_title), '') = '' THEN RAISE EXCEPTION 'title is required'; END IF;
  IF p_confidence IS NOT NULL AND (p_confidence < 0 OR p_confidence > 100) THEN
    RAISE EXCEPTION 'confidence must be between 0 and 100';
  END IF;
  IF p_enforcement NOT IN ('pre_execution', 'post_execution') THEN
    RAISE EXCEPTION 'enforcement must be pre_execution or post_execution';
  END IF;
  IF p_engine_kind NOT IN ('llm', 'rules', 'hybrid', 'human') THEN
    RAISE EXCEPTION 'invalid engine_kind';
  END IF;
  IF jsonb_typeof(v_reason_factors) <> 'array' OR jsonb_typeof(v_data_used) <> 'array' OR jsonb_typeof(v_extra) <> 'array' THEN
    RAISE EXCEPTION 'reason_factors, data_used and extra_policies must be JSON arrays';
  END IF;

  -- Idempotency for bridged records.
  IF p_linked_action_log_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.ai_decision_records WHERE linked_action_log_id = p_linked_action_log_id LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('record_id', v_existing.id, 'governance_action', v_existing.governance_action,
                                'review_status', v_existing.review_status, 'existing', true);
    END IF;
  END IF;

  v_type := CASE WHEN p_decision_type = ANY (v_types) THEN p_decision_type ELSE 'other' END;

  IF p_apply_settings THEN
    SELECT * INTO v_settings FROM public.ai_governance_settings WHERE user_id = p_user_id;
    IF FOUND THEN
      v_min := v_settings.min_confidence_auto;
      v_require_conf := v_settings.require_confidence;
      v_amount := v_settings.require_review_amount_cents;
      v_always := v_settings.always_review_types;
      v_blocked := v_settings.blocked_types;
      v_override := (v_settings.type_overrides -> v_type ->> 'min_confidence_auto')::numeric;
      IF v_override IS NOT NULL THEN v_min := v_override; END IF;
    END IF;

    -- Kill switch
    IF v_type = ANY (v_blocked) THEN
      v_block := true;
      v_policies := v_policies || jsonb_build_object('policy', 'kill_switch', 'result', 'block',
        'detail', 'This decision type is disabled by an administrator.');
    ELSE
      v_policies := v_policies || jsonb_build_object('policy', 'kill_switch', 'result', 'pass', 'detail', NULL);
    END IF;

    -- Always-review types
    IF v_type = ANY (v_always) THEN
      v_flag := true;
      v_policies := v_policies || jsonb_build_object('policy', 'mandatory_review', 'result', 'flag',
        'detail', 'This decision type always requires human review.');
    END IF;

    -- Confidence threshold
    IF p_confidence IS NULL THEN
      IF v_require_conf THEN
        v_flag := true;
        v_policies := v_policies || jsonb_build_object('policy', 'confidence_threshold', 'result', 'flag',
          'detail', 'No confidence score was supplied and the policy requires one.');
      ELSE
        v_policies := v_policies || jsonb_build_object('policy', 'confidence_threshold', 'result', 'skip',
          'detail', 'No confidence score supplied; rule not applicable.');
      END IF;
    ELSIF p_confidence < v_min THEN
      v_flag := true;
      v_policies := v_policies || jsonb_build_object('policy', 'confidence_threshold', 'result', 'flag',
        'detail', format('Confidence %s%% is below the %s%% auto-approval threshold.', p_confidence, v_min));
    ELSE
      v_policies := v_policies || jsonb_build_object('policy', 'confidence_threshold', 'result', 'pass',
        'detail', format('Confidence %s%% meets the %s%% threshold.', p_confidence, v_min));
    END IF;

    -- Financial impact
    IF v_amount IS NOT NULL THEN
      IF p_amount_cents IS NOT NULL AND p_amount_cents >= v_amount THEN
        v_flag := true;
        v_policies := v_policies || jsonb_build_object('policy', 'high_value_review', 'result', 'flag',
          'detail', format('Amount %s cents is at or above the %s cent review limit.', p_amount_cents, v_amount));
      ELSIF p_amount_cents IS NULL THEN
        v_policies := v_policies || jsonb_build_object('policy', 'high_value_review', 'result', 'skip',
          'detail', 'No amount supplied; rule not applicable.');
      ELSE
        v_policies := v_policies || jsonb_build_object('policy', 'high_value_review', 'result', 'pass', 'detail', NULL);
      END IF;
    END IF;
  END IF;

  -- Policies contributed by the caller (e.g. Agent Governance, Business Constitution).
  FOR v_elem IN SELECT value FROM jsonb_array_elements(v_extra) LOOP
    v_result := CASE WHEN (v_elem ->> 'result') IN ('pass', 'flag', 'block', 'skip') THEN v_elem ->> 'result' ELSE 'skip' END;
    IF v_result = 'block' THEN v_block := true; END IF;
    IF v_result = 'flag' THEN v_flag := true; END IF;
    v_policies := v_policies || jsonb_build_object(
      'policy', COALESCE(NULLIF(v_elem ->> 'policy', ''), 'unnamed_policy'),
      'result', v_result,
      'detail', v_elem ->> 'detail'
    );
  END LOOP;

  v_action := CASE WHEN v_block THEN 'blocked' WHEN v_flag THEN 'review_required' ELSE 'auto_approved' END;
  v_review := CASE WHEN v_action = 'review_required' THEN 'pending' ELSE 'not_required' END;

  BEGIN
    INSERT INTO public.ai_decision_records (
      user_id, decision_type, title, decision, reasoning, reason_factors, data_used, confidence,
      agent_source, engine_kind, model_provider, model_name, model_version,
      subject_table, subject_id, amount_cents, correlation_id,
      policies_applied, enforcement, governance_action, review_status,
      executed, executed_at, linked_action_log_id
    ) VALUES (
      p_user_id, v_type, left(btrim(p_title), 200), COALESCE(p_decision, ''), COALESCE(p_reasoning, ''),
      v_reason_factors, v_data_used, p_confidence,
      left(btrim(p_agent_source), 120), p_engine_kind, p_model_provider, p_model_name, p_model_version,
      p_subject_table, p_subject_id, p_amount_cents, p_correlation_id,
      v_policies, p_enforcement, v_action, v_review,
      COALESCE(p_executed, false), CASE WHEN COALESCE(p_executed, false) THEN now() ELSE NULL END,
      p_linked_action_log_id
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF p_linked_action_log_id IS NULL THEN RAISE; END IF;
    SELECT * INTO v_existing FROM public.ai_decision_records WHERE linked_action_log_id = p_linked_action_log_id LIMIT 1;
    RETURN jsonb_build_object('record_id', v_existing.id, 'governance_action', v_existing.governance_action,
                              'review_status', v_existing.review_status, 'existing', true);
  END;

  INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
  VALUES (v_id, p_user_id, 'recorded', NULL,
          jsonb_build_object('governance_action', v_action, 'enforcement', p_enforcement, 'agent_source', p_agent_source));
  IF v_review = 'pending' THEN
    INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
    VALUES (v_id, p_user_id, 'review_requested', NULL, jsonb_build_object('policies', v_policies));
  END IF;

  RETURN jsonb_build_object('record_id', v_id, 'governance_action', v_action, 'review_status', v_review,
                            'policies', v_policies, 'existing', false);
END;
$$;

REVOKE ALL ON FUNCTION public._ai_gov_record(uuid, text, text, text, text, text, numeric, jsonb, jsonb, text, text, text, text, text, text, integer, text, text, jsonb, boolean, boolean, uuid)
  FROM PUBLIC, anon, authenticated;

-- =============================================================
-- RPC (service role): record_ai_decision
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_ai_decision(
  p_user_id uuid,
  p_decision_type text,
  p_title text,
  p_decision text,
  p_reasoning text,
  p_agent_source text,
  p_confidence numeric DEFAULT NULL,
  p_reason_factors jsonb DEFAULT '[]'::jsonb,
  p_data_used jsonb DEFAULT '[]'::jsonb,
  p_engine_kind text DEFAULT 'llm',
  p_model_provider text DEFAULT NULL,
  p_model_name text DEFAULT NULL,
  p_model_version text DEFAULT NULL,
  p_subject_table text DEFAULT NULL,
  p_subject_id text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL,
  p_correlation_id text DEFAULT NULL,
  p_enforcement text DEFAULT 'pre_execution',
  p_extra_policies jsonb DEFAULT '[]'::jsonb,
  p_executed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public._ai_gov_record(
    p_user_id, p_decision_type, p_title, p_decision, p_reasoning, p_agent_source, p_confidence,
    p_reason_factors, p_data_used, p_engine_kind, p_model_provider, p_model_name, p_model_version,
    p_subject_table, p_subject_id, p_amount_cents, p_correlation_id, p_enforcement,
    p_extra_policies, true, p_executed, NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_decision(uuid, text, text, text, text, text, numeric, jsonb, jsonb, text, text, text, text, text, text, integer, text, text, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_decision(uuid, text, text, text, text, text, numeric, jsonb, jsonb, text, text, text, text, text, text, integer, text, text, jsonb, boolean)
  TO service_role;

-- =============================================================
-- RPC (service role): mark_ai_decision_executed
-- =============================================================

CREATE OR REPLACE FUNCTION public.mark_ai_decision_executed(
  p_record_id uuid,
  p_success boolean DEFAULT true,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ai_decision_records%ROWTYPE;
BEGIN
  UPDATE public.ai_decision_records
  SET executed = COALESCE(p_success, true),
      executed_at = CASE WHEN COALESCE(p_success, true) THEN now() ELSE executed_at END,
      execution_error = CASE WHEN COALESCE(p_success, true) THEN NULL ELSE left(COALESCE(p_error, 'Execution failed'), 1000) END
  WHERE id = p_record_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
  VALUES (v_row.id, v_row.user_id,
          CASE WHEN COALESCE(p_success, true) THEN 'executed' ELSE 'execution_failed' END, NULL,
          jsonb_build_object('error', v_row.execution_error));

  -- Governance breach: a gated (pre-execution) decision was executed without an approval.
  IF COALESCE(p_success, true)
     AND v_row.enforcement = 'pre_execution'
     AND (v_row.governance_action = 'blocked' OR v_row.review_status IN ('pending', 'rejected'))
  THEN
    INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
    VALUES (v_row.id, v_row.user_id, 'violation', NULL,
            jsonb_build_object('reason', 'Executed while blocked, awaiting review or rejected',
                               'governance_action', v_row.governance_action, 'review_status', v_row.review_status));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_ai_decision_executed(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ai_decision_executed(uuid, boolean, text) TO service_role;

-- =============================================================
-- RPC (service role AND dashboard): record_ai_decision_outcome
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_ai_decision_outcome(
  p_record_id uuid,
  p_outcome text,
  p_financial_impact_cents integer DEFAULT NULL,
  p_ai_was_wrong boolean DEFAULT NULL,
  p_error_category text DEFAULT NULL,
  p_error_explanation text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.ai_decision_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ai_decision_records%ROWTYPE;
  v_actor uuid := auth.uid();
  v_wrong boolean := p_ai_was_wrong;
  v_category text := p_error_category;
  v_explanation text := NULLIF(btrim(p_error_explanation), '');
BEGIN
  IF p_outcome NOT IN ('successful', 'partial', 'failed', 'no_effect') THEN
    RAISE EXCEPTION 'Invalid outcome';
  END IF;

  SELECT * INTO v_row FROM public.ai_decision_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Decision record not found'; END IF;

  -- Dashboard callers may only touch their own account; service role (no auth.uid()) may touch any.
  IF v_actor IS NOT NULL AND v_row.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Decision record not found';
  END IF;

  IF v_row.review_status = 'pending' THEN
    RAISE EXCEPTION 'Review this decision before recording its outcome';
  END IF;

  IF v_wrong IS NULL AND p_outcome = 'successful' THEN v_wrong := false; END IF;

  IF v_wrong IS TRUE THEN
    IF v_category IS NULL OR v_category NOT IN ('bad_data', 'wrong_reasoning', 'hallucination', 'policy_gap', 'stale_context', 'external_change', 'human_error', 'other') THEN
      RAISE EXCEPTION 'An error category is required when the AI was wrong';
    END IF;
  ELSE
    v_category := NULL;
    v_explanation := NULL;
  END IF;

  UPDATE public.ai_decision_records
  SET outcome = p_outcome,
      outcome_recorded_at = now(),
      outcome_notes = NULLIF(btrim(p_notes), ''),
      financial_impact_cents = p_financial_impact_cents,
      ai_was_wrong = v_wrong,
      error_category = v_category,
      error_explanation = v_explanation
  WHERE id = p_record_id
  RETURNING * INTO v_row;

  INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
  VALUES (v_row.id, v_row.user_id, 'outcome_recorded', v_actor,
          jsonb_build_object('outcome', p_outcome, 'financial_impact_cents', p_financial_impact_cents, 'ai_was_wrong', v_wrong));

  IF v_wrong IS TRUE THEN
    INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
    VALUES (v_row.id, v_row.user_id, 'error_flagged', v_actor,
            jsonb_build_object('category', v_category, 'explanation', v_explanation));
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_decision_outcome(uuid, text, integer, boolean, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_ai_decision_outcome(uuid, text, integer, boolean, text, text, text) TO authenticated, service_role;

-- =============================================================
-- RPC (dashboard): review_ai_decision
-- =============================================================

CREATE OR REPLACE FUNCTION public.review_ai_decision(
  p_record_id uuid,
  p_verdict text,
  p_notes text DEFAULT NULL,
  p_override_value jsonb DEFAULT NULL
)
RETURNS public.ai_decision_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.ai_decision_records%ROWTYPE;
  v_notes text := NULLIF(btrim(p_notes), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'You do not have permission to review AI decisions'; END IF;
  IF p_verdict NOT IN ('approve', 'reject', 'override') THEN RAISE EXCEPTION 'Invalid verdict'; END IF;

  SELECT * INTO v_row FROM public.ai_decision_records WHERE id = p_record_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Decision record not found'; END IF;
  IF v_row.review_status <> 'pending' THEN
    RAISE EXCEPTION 'Only decisions awaiting review can be reviewed (current: %)', v_row.review_status;
  END IF;
  IF p_verdict IN ('reject', 'override') AND v_notes IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject or override a decision';
  END IF;

  -- Agent actions are decided in Agent Governance (single source of truth); the bridge mirrors the result back.
  IF v_row.linked_action_log_id IS NOT NULL THEN
    IF p_verdict = 'override' THEN
      RAISE EXCEPTION 'Overrides are not available for agent actions — approve or reject instead';
    END IF;
    PERFORM public.decide_agent_action(v_row.linked_action_log_id, p_verdict = 'approve', v_notes);
    SELECT * INTO v_row FROM public.ai_decision_records WHERE id = p_record_id;
    RETURN v_row;
  END IF;

  UPDATE public.ai_decision_records
  SET review_status = CASE p_verdict WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'overridden' END,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = v_notes,
      override_value = CASE WHEN p_verdict = 'override' THEN p_override_value ELSE NULL END
  WHERE id = p_record_id
  RETURNING * INTO v_row;

  INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
  VALUES (v_row.id, v_row.user_id,
          CASE p_verdict WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'overridden' END,
          auth.uid(), jsonb_build_object('notes', v_notes));

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.review_ai_decision(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_ai_decision(uuid, text, text, jsonb) TO authenticated;

-- =============================================================
-- RPC (dashboard): settings
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_ai_governance_settings()
RETURNS public.ai_governance_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.ai_governance_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  INSERT INTO public.ai_governance_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.ai_governance_settings WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_governance_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ai_governance_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_ai_governance_settings(
  p_min_confidence_auto numeric,
  p_require_confidence boolean,
  p_require_review_amount_cents integer,
  p_always_review_types text[],
  p_blocked_types text[],
  p_type_overrides jsonb DEFAULT NULL
)
RETURNS public.ai_governance_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_types constant text[] := ARRAY['dispatch','pricing','estimate','diagnosis','triage','scheduling','followup','campaign','financing','communication','agent_action','other'];
  v_old public.ai_governance_settings%ROWTYPE;
  v_row public.ai_governance_settings%ROWTYPE;
  v_always text[];
  v_blocked text[];
  v_overrides jsonb;
  v_key text;
  v_val jsonb;
  v_n numeric;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'You do not have permission to change AI governance settings'; END IF;
  IF p_min_confidence_auto IS NULL OR p_min_confidence_auto < 0 OR p_min_confidence_auto > 100 THEN
    RAISE EXCEPTION 'Minimum confidence must be between 0 and 100';
  END IF;
  IF p_require_review_amount_cents IS NOT NULL AND p_require_review_amount_cents < 0 THEN
    RAISE EXCEPTION 'Review amount cannot be negative';
  END IF;

  v_always := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_always_review_types, '{}')) AS t);
  v_blocked := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_blocked_types, '{}')) AS t);
  IF NOT (v_always <@ v_types) OR NOT (v_blocked <@ v_types) THEN
    RAISE EXCEPTION 'Unknown decision type in policy';
  END IF;

  INSERT INTO public.ai_governance_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_old FROM public.ai_governance_settings WHERE user_id = v_owner FOR UPDATE;

  v_overrides := v_old.type_overrides;
  IF p_type_overrides IS NOT NULL THEN
    IF jsonb_typeof(p_type_overrides) <> 'object' THEN RAISE EXCEPTION 'type_overrides must be a JSON object'; END IF;
    v_overrides := '{}'::jsonb;
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_type_overrides) LOOP
      IF NOT (v_key = ANY (v_types)) THEN RAISE EXCEPTION 'Unknown decision type in overrides'; END IF;
      IF COALESCE(jsonb_typeof(v_val), '') <> 'object' OR COALESCE(jsonb_typeof(v_val -> 'min_confidence_auto'), '') <> 'number' THEN
        RAISE EXCEPTION 'Each override needs a numeric min_confidence_auto';
      END IF;
      v_n := (v_val ->> 'min_confidence_auto')::numeric;
      IF v_n < 0 OR v_n > 100 THEN RAISE EXCEPTION 'Override confidence must be between 0 and 100'; END IF;
      v_overrides := v_overrides || jsonb_build_object(v_key, jsonb_build_object('min_confidence_auto', v_n));
    END LOOP;
  END IF;

  UPDATE public.ai_governance_settings
  SET min_confidence_auto = p_min_confidence_auto,
      require_confidence = COALESCE(p_require_confidence, false),
      require_review_amount_cents = p_require_review_amount_cents,
      always_review_types = v_always,
      blocked_types = v_blocked,
      type_overrides = v_overrides,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;

  INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
  VALUES (NULL, v_owner, 'settings_changed', auth.uid(),
          jsonb_build_object('before', to_jsonb(v_old) - 'updated_by', 'after', to_jsonb(v_row) - 'updated_by'));

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ai_governance_settings(numeric, boolean, integer, text[], text[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_ai_governance_settings(numeric, boolean, integer, text[], text[], jsonb) TO authenticated;

-- =============================================================
-- RPC (dashboard): get_ai_reliability_metrics
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_ai_reliability_metrics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := greatest(1, least(COALESCE(p_days, 30), 365));
  v_since timestamptz;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_since := now() - make_interval(days => v_days);

  WITH base AS (
    SELECT * FROM public.ai_decision_records WHERE user_id = v_owner AND created_at >= v_since
  ),
  scored AS (
    SELECT b.*,
           CASE b.outcome WHEN 'successful' THEN 1.0 WHEN 'partial' THEN 0.5 WHEN 'failed' THEN 0.0 END AS score
    FROM base b
  ),
  totals AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE governance_action = 'auto_approved') AS auto_approved,
      count(*) FILTER (WHERE governance_action = 'review_required') AS review_required,
      count(*) FILTER (WHERE governance_action = 'blocked') AS blocked,
      count(*) FILTER (WHERE review_status = 'pending') AS pending_reviews,
      count(*) FILTER (WHERE review_status = 'approved') AS approved,
      count(*) FILTER (WHERE review_status = 'rejected') AS rejected,
      count(*) FILTER (WHERE review_status = 'overridden') AS overridden,
      count(*) FILTER (WHERE executed) AS executed,
      count(*) FILTER (WHERE outcome <> 'pending') AS outcomes_recorded,
      count(*) FILTER (WHERE outcome = 'successful') AS successful,
      count(*) FILTER (WHERE outcome = 'partial') AS partial,
      count(*) FILTER (WHERE outcome = 'failed') AS failed,
      count(*) FILTER (WHERE outcome = 'no_effect') AS no_effect,
      count(*) FILTER (WHERE ai_was_wrong IS TRUE) AS wrong,
      count(*) FILTER (WHERE outcome = 'failed' AND ai_was_wrong IS NULL) AS unattributed_failures,
      round(avg(confidence), 1) AS avg_confidence,
      COALESCE(sum(financial_impact_cents), 0) AS net_impact_cents
    FROM base
  ),
  calibration AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'bin_start', bin * 10, 'count', n, 'avg_confidence', avg_conf, 'success_rate', succ
           ) ORDER BY bin), '[]'::jsonb) AS v
    FROM (
      SELECT least(floor(confidence / 10)::int, 9) AS bin,
             count(*) AS n,
             round(avg(confidence), 1) AS avg_conf,
             round(avg(score)::numeric, 3) AS succ
      FROM scored
      WHERE confidence IS NOT NULL AND score IS NOT NULL
      GROUP BY 1
    ) c
  ),
  by_type AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'decision_type', decision_type, 'total', n, 'pending_reviews', pend, 'avg_confidence', avg_conf,
             'success_rate', succ, 'scored', scored_n, 'wrong', wrong_n
           ) ORDER BY n DESC), '[]'::jsonb) AS v
    FROM (
      SELECT decision_type,
             count(*) AS n,
             count(*) FILTER (WHERE review_status = 'pending') AS pend,
             round(avg(confidence), 1) AS avg_conf,
             round(avg(score)::numeric, 3) AS succ,
             count(score) AS scored_n,
             count(*) FILTER (WHERE ai_was_wrong IS TRUE) AS wrong_n
      FROM scored
      GROUP BY decision_type
    ) t
  ),
  by_model AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'model', model, 'engine_kind', engine_kind, 'total', n, 'avg_confidence', avg_conf,
             'success_rate', succ, 'scored', scored_n, 'wrong', wrong_n
           ) ORDER BY n DESC), '[]'::jsonb) AS v
    FROM (
      SELECT COALESCE(model_name, agent_source) AS model,
             engine_kind,
             count(*) AS n,
             round(avg(confidence), 1) AS avg_conf,
             round(avg(score)::numeric, 3) AS succ,
             count(score) AS scored_n,
             count(*) FILTER (WHERE ai_was_wrong IS TRUE) AS wrong_n
      FROM scored
      GROUP BY 1, 2
    ) m
  ),
  errs AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('category', error_category, 'count', n) ORDER BY n DESC), '[]'::jsonb) AS v
    FROM (
      SELECT error_category, count(*) AS n
      FROM base
      WHERE ai_was_wrong IS TRUE AND error_category IS NOT NULL
      GROUP BY error_category
    ) e
  )
  SELECT jsonb_build_object(
    'window_days', v_days,
    'totals', to_jsonb(totals),
    'calibration', calibration.v,
    'by_type', by_type.v,
    'by_model', by_model.v,
    'error_categories', errs.v
  )
  INTO v_result
  FROM totals, calibration, by_type, by_model, errs;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_reliability_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ai_reliability_metrics(integer) TO authenticated;

-- =============================================================
-- RPC (dashboard): verify_ai_decision_chain
-- =============================================================

CREATE OR REPLACE FUNCTION public.verify_ai_decision_chain(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_limit integer := greatest(1, least(COALESCE(p_limit, 5000), 50000));
  r public.ai_decision_records%ROWTYPE;
  v_prev_hash text := NULL;
  v_prev_pos bigint := NULL;
  v_checked integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Verify the most recent v_limit records, oldest first. The first record is the anchor
  -- (its predecessor may have been removed by a retention sweep), but its own seal is still checked.
  FOR r IN
    SELECT * FROM (
      SELECT * FROM public.ai_decision_records WHERE user_id = v_owner ORDER BY chain_pos DESC LIMIT v_limit
    ) recent
    ORDER BY chain_pos ASC
  LOOP
    v_checked := v_checked + 1;

    IF v_prev_pos IS NOT NULL AND r.chain_pos <> v_prev_pos + 1 THEN
      RETURN jsonb_build_object('verified', false, 'checked', v_checked, 'broken_at_position', r.chain_pos,
                                'broken_record_id', r.id, 'reason', 'A record is missing from the chain');
    END IF;
    IF v_prev_hash IS NOT NULL AND r.prev_hash IS DISTINCT FROM v_prev_hash THEN
      RETURN jsonb_build_object('verified', false, 'checked', v_checked, 'broken_at_position', r.chain_pos,
                                'broken_record_id', r.id, 'reason', 'Chain link does not match the previous record');
    END IF;
    IF r.record_hash IS DISTINCT FROM public.ai_decision_hash(r) THEN
      RETURN jsonb_build_object('verified', false, 'checked', v_checked, 'broken_at_position', r.chain_pos,
                                'broken_record_id', r.id, 'reason', 'Record content does not match its seal');
    END IF;

    v_prev_hash := r.record_hash;
    v_prev_pos := r.chain_pos;
  END LOOP;

  RETURN jsonb_build_object('verified', true, 'checked', v_checked, 'broken_at_position', NULL,
                            'broken_record_id', NULL, 'reason', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_ai_decision_chain(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_ai_decision_chain(integer) TO authenticated;

-- =============================================================
-- RPC (dashboard): continuous-learning suggestions
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_ai_governance_suggestions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_settings public.ai_governance_settings%ROWTYPE;
  v_t record;
  r record;
  v_min numeric;
  v_inserted integer := 0;
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage AI governance'; END IF;

  INSERT INTO public.ai_governance_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_settings FROM public.ai_governance_settings WHERE user_id = v_owner;

  FOR v_t IN
    SELECT decision_type
    FROM public.ai_decision_records
    WHERE user_id = v_owner
      AND created_at >= now() - interval '90 days'
      AND confidence IS NOT NULL
      AND outcome IN ('successful', 'partial', 'failed')
    GROUP BY decision_type
    HAVING count(*) >= 15
  LOOP
    v_min := COALESCE((v_settings.type_overrides -> v_t.decision_type ->> 'min_confidence_auto')::numeric, v_settings.min_confidence_auto);

    -- Rule A: decisions the AI was confident about still fail too often -> always review this type.
    SELECT count(*) AS n, avg(s) AS s INTO r FROM (
      SELECT CASE outcome WHEN 'successful' THEN 1.0 WHEN 'partial' THEN 0.5 ELSE 0.0 END AS s
      FROM public.ai_decision_records
      WHERE user_id = v_owner AND decision_type = v_t.decision_type
        AND created_at >= now() - interval '90 days'
        AND confidence >= v_min AND outcome IN ('successful', 'partial', 'failed')
    ) x;
    IF r.n >= 10 AND r.s < 0.80 AND NOT (v_t.decision_type = ANY (v_settings.always_review_types)) THEN
      INSERT INTO public.ai_governance_suggestions (user_id, decision_type, kind, title, rationale, evidence)
      VALUES (v_owner, v_t.decision_type, 'always_review',
              'Require human review for every ' || v_t.decision_type || ' decision',
              format('Even above the %s%% confidence threshold, only %s%% of %s recent %s decisions succeeded. Confidence is not predicting quality here.',
                     v_min, round(r.s * 100), r.n, v_t.decision_type),
              jsonb_build_object('sample', r.n, 'success_rate', round(r.s::numeric, 3), 'threshold', v_min))
      ON CONFLICT (user_id, decision_type, kind) WHERE status = 'open' DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_inserted := v_inserted + v_n;
    END IF;

    -- Rule C: just above the threshold the AI fails too often -> raise the threshold.
    SELECT count(*) AS n, avg(s) AS s INTO r FROM (
      SELECT CASE outcome WHEN 'successful' THEN 1.0 WHEN 'partial' THEN 0.5 ELSE 0.0 END AS s
      FROM public.ai_decision_records
      WHERE user_id = v_owner AND decision_type = v_t.decision_type
        AND created_at >= now() - interval '90 days'
        AND confidence >= v_min AND confidence < v_min + 10
        AND outcome IN ('successful', 'partial', 'failed')
    ) x;
    IF r.n >= 8 AND r.s < 0.75 AND v_min + 10 <= 95 THEN
      INSERT INTO public.ai_governance_suggestions (user_id, decision_type, kind, title, rationale, evidence, proposed_min_confidence)
      VALUES (v_owner, v_t.decision_type, 'raise_confidence_threshold',
              'Raise the ' || v_t.decision_type || ' auto-approval threshold to ' || (v_min + 10) || '%',
              format('Decisions with confidence between %s%% and %s%% succeeded only %s%% of the time (%s samples).',
                     v_min, v_min + 10, round(r.s * 100), r.n),
              jsonb_build_object('sample', r.n, 'success_rate', round(r.s::numeric, 3), 'current_threshold', v_min),
              v_min + 10)
      ON CONFLICT (user_id, decision_type, kind) WHERE status = 'open' DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_inserted := v_inserted + v_n;
    END IF;

    -- Rule B: humans keep approving decisions just below the threshold and they succeed -> lower it.
    SELECT count(*) AS n, avg(s) AS s INTO r FROM (
      SELECT CASE outcome WHEN 'successful' THEN 1.0 WHEN 'partial' THEN 0.5 ELSE 0.0 END AS s
      FROM public.ai_decision_records
      WHERE user_id = v_owner AND decision_type = v_t.decision_type
        AND created_at >= now() - interval '90 days'
        AND confidence < v_min AND confidence >= v_min - 10
        AND review_status = 'approved'
        AND outcome IN ('successful', 'partial', 'failed')
    ) x;
    IF r.n >= 8 AND r.s >= 0.95 AND v_min - 5 >= 50 THEN
      INSERT INTO public.ai_governance_suggestions (user_id, decision_type, kind, title, rationale, evidence, proposed_min_confidence)
      VALUES (v_owner, v_t.decision_type, 'lower_confidence_threshold',
              'Lower the ' || v_t.decision_type || ' auto-approval threshold to ' || (v_min - 5) || '%',
              format('Humans approved %s decisions between %s%% and %s%% confidence and %s%% of them succeeded. Review effort here is likely wasted.',
                     r.n, v_min - 10, v_min, round(r.s * 100)),
              jsonb_build_object('sample', r.n, 'success_rate', round(r.s::numeric, 3), 'current_threshold', v_min),
              v_min - 5)
      ON CONFLICT (user_id, decision_type, kind) WHERE status = 'open' DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_inserted := v_inserted + v_n;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_ai_governance_suggestions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_ai_governance_suggestions() TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_ai_governance_suggestion(p_id uuid, p_accept boolean)
RETURNS public.ai_governance_suggestions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_s public.ai_governance_suggestions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.ai_gov_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage AI governance'; END IF;

  SELECT * INTO v_s FROM public.ai_governance_suggestions WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Suggestion not found'; END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'Suggestion was already decided'; END IF;

  IF p_accept THEN
    INSERT INTO public.ai_governance_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
    IF v_s.kind = 'always_review' THEN
      UPDATE public.ai_governance_settings
      SET always_review_types = array_append(array_remove(always_review_types, v_s.decision_type), v_s.decision_type),
          updated_by = auth.uid(), updated_at = now()
      WHERE user_id = v_owner;
    ELSE
      UPDATE public.ai_governance_settings
      SET type_overrides = jsonb_set(COALESCE(type_overrides, '{}'::jsonb), ARRAY[v_s.decision_type],
                                     jsonb_build_object('min_confidence_auto', v_s.proposed_min_confidence), true),
          updated_by = auth.uid(), updated_at = now()
      WHERE user_id = v_owner;
    END IF;
  END IF;

  UPDATE public.ai_governance_suggestions
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'dismissed' END,
      decided_by = auth.uid(),
      decided_at = now()
  WHERE id = p_id
  RETURNING * INTO v_s;

  INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
  VALUES (NULL, v_owner, CASE WHEN p_accept THEN 'suggestion_accepted' ELSE 'suggestion_dismissed' END, auth.uid(),
          jsonb_build_object('suggestion_id', v_s.id, 'kind', v_s.kind, 'decision_type', v_s.decision_type,
                             'proposed_min_confidence', v_s.proposed_min_confidence));

  RETURN v_s;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_ai_governance_suggestion(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_ai_governance_suggestion(uuid, boolean) TO authenticated;

-- =============================================================
-- BRIDGE 1: agent_action_log -> ai_decision_records
-- A failure here is swallowed (WARNING only): governance bookkeeping must never block an agent.
-- =============================================================

CREATE OR REPLACE FUNCTION public.ai_gov_mirror_agent_action()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text;
  v_rec public.ai_decision_records%ROWTYPE;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      SELECT label INTO v_label FROM public.agent_action_catalog WHERE slug = NEW.action_slug;

      PERFORM public._ai_gov_record(
        NEW.user_id,
        'agent_action',
        COALESCE(v_label, NEW.action_slug),
        'Proposed agent action: ' || COALESCE(v_label, NEW.action_slug),
        COALESCE(NULLIF(btrim(NEW.reasoning), ''), 'The agent did not supply a reason.'),
        NEW.agent_source,
        NULL,
        '[]'::jsonb,
        CASE WHEN NEW.target_table IS NULL THEN '[]'::jsonb
             ELSE jsonb_build_array(jsonb_build_object('source', NEW.target_table, 'ref', NEW.target_id)) END,
        'hybrid',
        NULL, NULL, NULL,
        NEW.target_table,
        NEW.target_id,
        NEW.amount_cents,
        NEW.correlation_id,
        'pre_execution',
        jsonb_build_array(jsonb_build_object(
          'policy', 'agent_governance',
          'result', CASE NEW.status WHEN 'pending_approval' THEN 'flag' WHEN 'rejected' THEN 'block' ELSE 'pass' END,
          'detail', 'Agent Governance status: ' || NEW.status)),
        false,
        false,
        NEW.id
      );

    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
      SELECT * INTO v_rec FROM public.ai_decision_records WHERE linked_action_log_id = NEW.id;
      IF NOT FOUND THEN RETURN NEW; END IF; -- action predates the governance engine

      IF NEW.status = 'approved' AND OLD.status = 'pending_approval' THEN
        UPDATE public.ai_decision_records
        SET review_status = 'approved', reviewed_by = NEW.decided_by,
            reviewed_at = COALESCE(NEW.decided_at, now()), review_notes = NEW.decision_reason
        WHERE id = v_rec.id;
        INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
        VALUES (v_rec.id, v_rec.user_id, 'approved', NEW.decided_by, jsonb_build_object('notes', NEW.decision_reason));

      ELSIF NEW.status = 'rejected' AND OLD.status = 'pending_approval' THEN
        UPDATE public.ai_decision_records
        SET review_status = 'rejected', reviewed_by = NEW.decided_by,
            reviewed_at = COALESCE(NEW.decided_at, now()), review_notes = NEW.decision_reason
        WHERE id = v_rec.id;
        INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
        VALUES (v_rec.id, v_rec.user_id, 'rejected', NEW.decided_by, jsonb_build_object('notes', NEW.decision_reason));

      ELSIF NEW.status = 'executed' THEN
        UPDATE public.ai_decision_records
        SET executed = true, executed_at = COALESCE(NEW.executed_at, now()), execution_error = NULL
        WHERE id = v_rec.id;
        INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
        VALUES (v_rec.id, v_rec.user_id, 'executed', NULL, '{}'::jsonb);

      ELSIF NEW.status = 'failed' THEN
        UPDATE public.ai_decision_records
        SET execution_error = left(COALESCE(NEW.error, 'Execution failed'), 1000)
        WHERE id = v_rec.id;
        INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
        VALUES (v_rec.id, v_rec.user_id, 'execution_failed', NULL, jsonb_build_object('error', NEW.error));

      ELSIF NEW.status = 'rolled_back' THEN
        INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
        VALUES (v_rec.id, v_rec.user_id, 'rolled_back', NEW.rolled_back_by, '{}'::jsonb);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ai_gov_mirror_agent_action failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_gov_mirror_agent_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out text;
  v_id uuid;
  v_user uuid;
BEGIN
  BEGIN
    v_out := CASE NEW.outcome
      WHEN 'success' THEN 'successful'
      WHEN 'partial' THEN 'partial'
      WHEN 'failure' THEN 'failed'
      WHEN 'no_effect' THEN 'no_effect'
      ELSE NULL END;
    IF v_out IS NULL THEN RETURN NEW; END IF;

    UPDATE public.ai_decision_records
    SET outcome = v_out,
        outcome_recorded_at = now(),
        financial_impact_cents = NEW.financial_outcome_cents,
        outcome_notes = left(NEW.notes, 1000),
        ai_was_wrong = CASE WHEN v_out = 'successful' THEN false ELSE ai_was_wrong END
    WHERE linked_action_log_id = NEW.log_id
    RETURNING id, user_id INTO v_id, v_user;

    IF v_id IS NOT NULL THEN
      INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
      VALUES (v_id, v_user, 'outcome_recorded', NULL,
              jsonb_build_object('outcome', v_out, 'source', 'agent_action_outcomes',
                                 'financial_impact_cents', NEW.financial_outcome_cents));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ai_gov_mirror_agent_outcome failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- =============================================================
-- BRIDGE 2: jobs -> outcome of dispatch decisions
-- Completed job  => the latest dispatch decision for it was successful.
-- Cancelled job  => no_effect (a cancellation is not automatically the AI's fault).
-- Earlier, superseded assignments of the same job => no_effect.
-- =============================================================

CREATE OR REPLACE FUNCTION public.ai_gov_mirror_job_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.job_status IS DISTINCT FROM OLD.job_status AND NEW.job_status IN ('completed', 'cancelled') THEN
      WITH upd AS (
        UPDATE public.ai_decision_records r
        SET outcome = CASE
              WHEN NEW.job_status = 'completed'
                   AND r.chain_pos = (SELECT max(x.chain_pos) FROM public.ai_decision_records x
                                      WHERE x.user_id = r.user_id AND x.decision_type = 'dispatch'
                                        AND x.subject_table = 'jobs' AND x.subject_id = r.subject_id)
                THEN 'successful'
              ELSE 'no_effect' END,
            outcome_recorded_at = now(),
            outcome_notes = CASE
              WHEN NEW.job_status = 'completed' THEN 'Auto-recorded: job completed'
              ELSE 'Auto-recorded: job cancelled' END,
            ai_was_wrong = CASE
              WHEN NEW.job_status = 'completed'
                   AND r.chain_pos = (SELECT max(x.chain_pos) FROM public.ai_decision_records x
                                      WHERE x.user_id = r.user_id AND x.decision_type = 'dispatch'
                                        AND x.subject_table = 'jobs' AND x.subject_id = r.subject_id)
                THEN false
              ELSE r.ai_was_wrong END
        WHERE r.decision_type = 'dispatch'
          AND r.subject_table = 'jobs'
          AND r.subject_id = NEW.id::text
          AND r.outcome = 'pending'
          AND r.executed = true
          AND r.review_status <> 'pending'
        RETURNING r.id, r.user_id, r.outcome
      )
      INSERT INTO public.ai_decision_events (record_id, user_id, event_type, actor_id, detail)
      SELECT id, user_id, 'outcome_recorded', NULL,
             jsonb_build_object('outcome', outcome, 'source', 'jobs.job_status', 'job_status', NEW.job_status)
      FROM upd;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ai_gov_mirror_job_outcome failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_gov_mirror_agent_action() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_gov_mirror_agent_outcome() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_gov_mirror_job_outcome() FROM PUBLIC, anon, authenticated;

-- Attach the bridges only where the source table exists.
DO $$
BEGIN
  IF to_regclass('public.agent_action_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_ai_gov_mirror_agent_action ON public.agent_action_log;
    CREATE TRIGGER trg_ai_gov_mirror_agent_action
      AFTER INSERT OR UPDATE ON public.agent_action_log
      FOR EACH ROW EXECUTE FUNCTION public.ai_gov_mirror_agent_action();
  END IF;

  IF to_regclass('public.agent_action_outcomes') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_ai_gov_mirror_agent_outcome ON public.agent_action_outcomes;
    CREATE TRIGGER trg_ai_gov_mirror_agent_outcome
      AFTER INSERT OR UPDATE ON public.agent_action_outcomes
      FOR EACH ROW EXECUTE FUNCTION public.ai_gov_mirror_agent_outcome();
  END IF;

  IF to_regclass('public.jobs') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_ai_gov_mirror_job_outcome ON public.jobs;
    CREATE TRIGGER trg_ai_gov_mirror_job_outcome
      AFTER UPDATE OF job_status ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.ai_gov_mirror_job_outcome();
  END IF;
END;
$$;

COMMENT ON TABLE public.ai_decision_records IS
  'One row per AI decision: why, data used, confidence, model, policies, human review, outcome, error attribution. Sealed core + per-account SHA-256 hash chain.';
COMMENT ON TABLE public.ai_decision_events IS
  'Append-only lifecycle timeline for AI decisions (review, execution, outcome, governance violations, settings changes).';
COMMENT ON TABLE public.ai_governance_suggestions IS
  'Deterministic, explainable governance-tuning suggestions derived from real outcomes. Never applied automatically.';
