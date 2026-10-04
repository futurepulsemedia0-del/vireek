/*
  # Organizational Learning Compiler

  Experience -> Observation -> Pattern -> Rule -> Playbook -> Agent policy
  -> Workflow blueprint -> Evaluation.

  The pipeline itself is pure code (src/lib/learningCompiler.ts). This migration
  stores only what needs a human decision and an audit trail:

  - learned_policies: compiled proposals. Nothing becomes active without the
    account owner approving it. Clients can only READ; every write goes through
    the SECURITY DEFINER functions below.
  - learned_policy_events: append-only audit trail of every state change.

  RLS: account-scoped via get_account_owner_id(), same as job_outcomes.
*/

CREATE TABLE IF NOT EXISTS learned_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  facet text NOT NULL CHECK (char_length(facet) BETWEEN 3 AND 500),
  job_type_key text NOT NULL CHECK (char_length(job_type_key) BETWEEN 1 AND 200),
  dimension text NOT NULL
    CHECK (dimension IN ('technician', 'root_cause', 'part', 'checklist_incomplete')),
  dimension_value text NOT NULL CHECK (char_length(dimension_value) BETWEEN 1 AND 200),
  kind text NOT NULL
    CHECK (kind IN ('dispatch_review', 'dispatch_prefer', 'parts_precheck', 'checklist_gate', 'diagnosis_review')),
  severity text NOT NULL CHECK (severity IN ('info', 'caution', 'avoid')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 1200),
  playbook jsonb NOT NULL DEFAULT '[]'::jsonb,
  workflow_blueprint jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  backtest jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'rejected', 'retired', 'superseded')),
  enforcement text NOT NULL DEFAULT 'advise' CHECK (enforcement IN ('advise', 'require_approval')),
  decided_at timestamptz,
  decided_by uuid,
  decision_note text,
  activated_at timestamptz,
  retired_at timestamptz,
  evaluation jsonb,
  evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, facet)
);

CREATE INDEX IF NOT EXISTS idx_learned_policies_user_status
  ON learned_policies(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS learned_policy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  policy_id uuid NOT NULL REFERENCES learned_policies(id) ON DELETE CASCADE,
  event text NOT NULL
    CHECK (event IN ('proposed', 'approved', 'rejected', 'retired', 'evaluated')),
  actor uuid,
  note text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learned_policy_events_policy
  ON learned_policy_events(policy_id, created_at DESC);

-- RLS: read-only for clients. All writes go through the functions below.

ALTER TABLE learned_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_learned_policies ON learned_policies;
CREATE POLICY select_own_learned_policies ON learned_policies
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

ALTER TABLE learned_policy_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_own_learned_policy_events ON learned_policy_events;
CREATE POLICY select_own_learned_policy_events ON learned_policy_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- record_learning_run: upserts compiled proposals.
--  - New facets are inserted as 'proposed'.
--  - Facets still proposed/superseded are refreshed with the newest evidence.
--  - Active / rejected / retired policies are never touched (a human decided).
--  - Proposed policies the data no longer supports become 'superseded'.
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_learning_run(
  p_policies jsonb,
  p_supported_facets text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_item jsonb;
  v_id uuid;
  v_inserted boolean;
  v_new integer := 0;
  v_refreshed integer := 0;
  v_superseded integer := 0;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can run the learning compiler';
  END IF;
  IF p_policies IS NULL OR jsonb_typeof(p_policies) <> 'array' THEN
    RAISE EXCEPTION 'p_policies must be a JSON array';
  END IF;
  IF jsonb_array_length(p_policies) > 100 THEN
    RAISE EXCEPTION 'Too many policies in one run';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_policies)
  LOOP
    v_id := NULL;
    INSERT INTO learned_policies (
      user_id, facet, job_type_key, dimension, dimension_value, kind, severity,
      title, rationale, playbook, workflow_blueprint, evidence, backtest
    ) VALUES (
      v_owner,
      v_item->>'facet',
      v_item->>'job_type_key',
      v_item->>'dimension',
      v_item->>'dimension_value',
      v_item->>'kind',
      v_item->>'severity',
      v_item->>'title',
      v_item->>'rationale',
      COALESCE(v_item->'playbook', '[]'::jsonb),
      CASE WHEN jsonb_typeof(v_item->'workflow_blueprint') = 'object' THEN v_item->'workflow_blueprint' ELSE NULL END,
      COALESCE(v_item->'evidence', '{}'::jsonb),
      COALESCE(v_item->'backtest', '{}'::jsonb)
    )
    ON CONFLICT (user_id, facet) DO UPDATE SET
      kind = EXCLUDED.kind,
      severity = EXCLUDED.severity,
      title = EXCLUDED.title,
      rationale = EXCLUDED.rationale,
      playbook = EXCLUDED.playbook,
      workflow_blueprint = EXCLUDED.workflow_blueprint,
      evidence = EXCLUDED.evidence,
      backtest = EXCLUDED.backtest,
      status = 'proposed',
      updated_at = now()
    WHERE learned_policies.status IN ('proposed', 'superseded')
    RETURNING id, (xmax = 0) INTO v_id, v_inserted;

    IF v_id IS NOT NULL THEN
      IF v_inserted THEN
        v_new := v_new + 1;
        INSERT INTO learned_policy_events (user_id, policy_id, event, actor, payload)
        VALUES (v_owner, v_id, 'proposed', auth.uid(), COALESCE(v_item->'evidence', '{}'::jsonb));
      ELSE
        v_refreshed := v_refreshed + 1;
      END IF;
    END IF;
  END LOOP;

  UPDATE learned_policies
  SET status = 'superseded', updated_at = now()
  WHERE user_id = v_owner
    AND status = 'proposed'
    AND NOT (facet = ANY (COALESCE(p_supported_facets, ARRAY[]::text[])));
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_new, 'refreshed', v_refreshed, 'superseded', v_superseded);
END;
$$;

-- =============================================================
-- decide_learned_policy: the human-review gate.
--  approve: proposed -> active (owner picks advise / require_approval)
--  reject : proposed -> rejected
--  retire : active   -> retired
-- =============================================================

CREATE OR REPLACE FUNCTION public.decide_learned_policy(
  p_id uuid,
  p_decision text,
  p_enforcement text DEFAULT 'advise',
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row learned_policies;
  v_enforcement text := COALESCE(p_enforcement, 'advise');
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can decide on a learned policy';
  END IF;
  IF p_decision NOT IN ('approve', 'reject', 'retire') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;
  IF v_enforcement NOT IN ('advise', 'require_approval') THEN
    RAISE EXCEPTION 'Invalid enforcement';
  END IF;

  SELECT * INTO v_row FROM learned_policies WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Policy not found';
  END IF;

  IF p_decision = 'approve' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only a proposed policy can be approved';
    END IF;
    IF v_row.kind = 'dispatch_prefer' THEN
      v_enforcement := 'advise';
    END IF;
    UPDATE learned_policies
    SET status = 'active', enforcement = v_enforcement, activated_at = now(),
        decided_at = now(), decided_by = auth.uid(), decision_note = left(p_note, 500),
        evaluation = NULL, evaluated_at = NULL, updated_at = now()
    WHERE id = p_id;
    INSERT INTO learned_policy_events (user_id, policy_id, event, actor, note, payload)
    VALUES (v_owner, p_id, 'approved', auth.uid(), left(p_note, 500), jsonb_build_object('enforcement', v_enforcement));
  ELSIF p_decision = 'reject' THEN
    IF v_row.status <> 'proposed' THEN
      RAISE EXCEPTION 'Only a proposed policy can be rejected';
    END IF;
    UPDATE learned_policies
    SET status = 'rejected', decided_at = now(), decided_by = auth.uid(),
        decision_note = left(p_note, 500), updated_at = now()
    WHERE id = p_id;
    INSERT INTO learned_policy_events (user_id, policy_id, event, actor, note)
    VALUES (v_owner, p_id, 'rejected', auth.uid(), left(p_note, 500));
  ELSE
    IF v_row.status <> 'active' THEN
      RAISE EXCEPTION 'Only an active policy can be retired';
    END IF;
    UPDATE learned_policies
    SET status = 'retired', retired_at = now(), decided_at = now(), decided_by = auth.uid(),
        decision_note = left(p_note, 500), updated_at = now()
    WHERE id = p_id;
    INSERT INTO learned_policy_events (user_id, policy_id, event, actor, note)
    VALUES (v_owner, p_id, 'retired', auth.uid(), left(p_note, 500));
  END IF;
END;
$$;

-- =============================================================
-- record_policy_evaluation: stores the measured effect of an active policy.
-- The verdict is advisory; only a human retires a policy.
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_policy_evaluation(
  p_id uuid,
  p_evaluation jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can record a policy evaluation';
  END IF;
  IF p_evaluation IS NULL OR jsonb_typeof(p_evaluation) <> 'object' THEN
    RAISE EXCEPTION 'p_evaluation must be a JSON object';
  END IF;

  SELECT status INTO v_status FROM learned_policies WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Policy not found';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Only an active policy can be evaluated';
  END IF;

  UPDATE learned_policies
  SET evaluation = p_evaluation, evaluated_at = now(), updated_at = now()
  WHERE id = p_id;
  INSERT INTO learned_policy_events (user_id, policy_id, event, actor, payload)
  VALUES (v_owner, p_id, 'evaluated', auth.uid(), p_evaluation);
END;
$$;

REVOKE ALL ON FUNCTION public.record_learning_run(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_learned_policy(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_policy_evaluation(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_learning_run(jsonb, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_learned_policy(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_policy_evaluation(uuid, jsonb) TO authenticated;
