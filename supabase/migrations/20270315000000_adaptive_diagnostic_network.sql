/*
  # VIREEK Adaptive Diagnostic Network (ADN)

  A diagnostic loop that (1) picks the next question/test with the highest expected
  information gain, (2) recomputes cause probabilities after every technician answer,
  (3) ends in diagnosis -> repair -> verified outcome, and (4) feeds every verified
  outcome back into the model as training data.

  Learning is Bayesian (Dirichlet pseudo-counts):
    effective count = expert seed count + weighted verified counts
      (this account + optional anonymous network pool, by equipment family and make).

  Purely additive. Touches no existing table. Depends on: jobs, customers, equipment,
  public.get_account_owner_id().

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- =============================================================
-- 1) Knowledge base (global, read-only for clients)
-- =============================================================
CREATE TABLE IF NOT EXISTS adn_symptoms (
  key text PRIMARY KEY,
  label text NOT NULL,
  family text NOT NULL,
  trade text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  mandatory_test_keys text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS adn_causes (
  key text PRIMARY KEY,
  label text NOT NULL,
  family text NOT NULL,
  safety_critical boolean NOT NULL DEFAULT false,
  summary text,
  repair_steps jsonb NOT NULL DEFAULT '[]',
  parts jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_adn_causes_family ON adn_causes(family);

CREATE TABLE IF NOT EXISTS adn_tests (
  key text PRIMARY KEY,
  label text NOT NULL,
  question text NOT NULL,
  tool_needed text,
  effort smallint NOT NULL DEFAULT 1 CHECK (effort BETWEEN 1 AND 5),
  kind text NOT NULL DEFAULT 'inspection' CHECK (kind IN ('question', 'inspection', 'measurement')),
  safety_note text,
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'array' AND jsonb_array_length(answers) >= 2)
);

CREATE TABLE IF NOT EXISTS adn_seed_priors (
  symptom_key text NOT NULL REFERENCES adn_symptoms(key) ON DELETE CASCADE,
  cause_key text NOT NULL REFERENCES adn_causes(key) ON DELETE CASCADE,
  weight numeric NOT NULL CHECK (weight > 0),
  PRIMARY KEY (symptom_key, cause_key)
);

CREATE TABLE IF NOT EXISTS adn_seed_likelihoods (
  test_key text NOT NULL REFERENCES adn_tests(key) ON DELETE CASCADE,
  cause_key text NOT NULL REFERENCES adn_causes(key) ON DELETE CASCADE,
  answer_key text NOT NULL,
  weight numeric NOT NULL CHECK (weight >= 0),
  PRIMARY KEY (test_key, cause_key, answer_key)
);

-- =============================================================
-- 2) Learned counts (written ONLY by SECURITY DEFINER functions)
--    scope_user_id = account owner, or the nil UUID for the anonymous network pool.
--    make '' = all makes for that family.
-- =============================================================
CREATE TABLE IF NOT EXISTS adn_learned_priors (
  scope_user_id uuid NOT NULL,
  family text NOT NULL,
  make text NOT NULL DEFAULT '',
  symptom_key text NOT NULL REFERENCES adn_symptoms(key) ON DELETE CASCADE,
  cause_key text NOT NULL REFERENCES adn_causes(key) ON DELETE CASCADE,
  n numeric NOT NULL DEFAULT 0 CHECK (n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_user_id, family, make, symptom_key, cause_key)
);

CREATE TABLE IF NOT EXISTS adn_learned_likelihoods (
  scope_user_id uuid NOT NULL,
  family text NOT NULL,
  make text NOT NULL DEFAULT '',
  cause_key text NOT NULL REFERENCES adn_causes(key) ON DELETE CASCADE,
  test_key text NOT NULL REFERENCES adn_tests(key) ON DELETE CASCADE,
  answer_key text NOT NULL,
  n numeric NOT NULL DEFAULT 0 CHECK (n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_user_id, family, make, cause_key, test_key, answer_key)
);

-- =============================================================
-- 3) Account settings, sessions, steps
-- =============================================================
CREATE TABLE IF NOT EXISTS adn_settings (
  user_id uuid PRIMARY KEY,
  share_anonymous_learning boolean NOT NULL DEFAULT true,
  verify_after_days integer NOT NULL DEFAULT 14 CHECK (verify_after_days BETWEEN 3 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adn_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  technician_id uuid NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  equipment_label text,
  make text NOT NULL DEFAULT '',
  model text,
  symptom_key text NOT NULL REFERENCES adn_symptoms(key),
  family text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'diagnosed', 'confirmed', 'repaired', 'verified', 'abandoned')),
  step_count integer NOT NULL DEFAULT 0,
  posterior jsonb NOT NULL DEFAULT '[]',
  entropy_bits numeric,
  stop_reason text,
  suggested_cause_key text REFERENCES adn_causes(key),
  suggested_probability numeric,
  initial_cause_key text REFERENCES adn_causes(key),
  confirmed_cause_key text REFERENCES adn_causes(key),
  repair_notes text,
  outcome text CHECK (outcome IN ('success', 'partial', 'failed')),
  outcome_source text CHECK (outcome_source IN ('technician', 'auto')),
  needs_review boolean NOT NULL DEFAULT false,
  learned_cause_key text,
  learned_weight numeric NOT NULL DEFAULT 0,
  learned_shared boolean NOT NULL DEFAULT false,
  engine_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  concluded_at timestamptz,
  confirmed_at timestamptz,
  repaired_at timestamptz,
  verify_due_at timestamptz,
  outcome_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adn_sessions_user_created ON adn_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adn_sessions_user_status ON adn_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_adn_sessions_technician_created ON adn_sessions(technician_id, created_at DESC);

CREATE TABLE IF NOT EXISTS adn_session_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES adn_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  step_no integer NOT NULL,
  test_key text NOT NULL REFERENCES adn_tests(key),
  answer_key text NOT NULL,
  information_gain_bits numeric,
  entropy_before numeric,
  entropy_after numeric,
  top_cause_key text,
  top_probability numeric,
  answered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, test_key),
  UNIQUE (session_id, step_no)
);

-- =============================================================
-- 4) RLS
-- =============================================================
ALTER TABLE adn_symptoms ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_causes ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_seed_priors ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_seed_likelihoods ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_learned_priors ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_learned_likelihoods ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE adn_session_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adn_read_symptoms" ON adn_symptoms;
CREATE POLICY "adn_read_symptoms" ON adn_symptoms FOR SELECT TO authenticated USING (active);
DROP POLICY IF EXISTS "adn_read_causes" ON adn_causes;
CREATE POLICY "adn_read_causes" ON adn_causes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "adn_read_tests" ON adn_tests;
CREATE POLICY "adn_read_tests" ON adn_tests FOR SELECT TO authenticated USING (true);
-- seed priors/likelihoods and learned counts: no client policies (service role / definer functions only).

DROP POLICY IF EXISTS "adn_settings_select" ON adn_settings;
CREATE POLICY "adn_settings_select" ON adn_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "adn_settings_insert" ON adn_settings;
CREATE POLICY "adn_settings_insert" ON adn_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "adn_settings_update" ON adn_settings;
CREATE POLICY "adn_settings_update" ON adn_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "adn_sessions_select" ON adn_sessions;
CREATE POLICY "adn_sessions_select" ON adn_sessions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "adn_steps_select" ON adn_session_steps;
CREATE POLICY "adn_steps_select" ON adn_session_steps FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies on sessions/steps: only the adaptive-diagnostics Edge
-- Function (service role) and the SECURITY DEFINER functions below write, so probabilities,
-- outcomes and learning can never be forged from the browser.

-- =============================================================
-- 5) Learning core (internal)
-- =============================================================
CREATE OR REPLACE FUNCTION public.adn_learn_session(
  p_session_id uuid, p_cause_key text, p_weight numeric, p_shared boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s adn_sessions%ROWTYPE;
  v_nil constant uuid := '00000000-0000-0000-0000-000000000000';
  v_scope uuid;
  v_makes text[];
BEGIN
  SELECT * INTO s FROM adn_sessions WHERE id = p_session_id;
  IF NOT FOUND OR p_weight = 0 OR p_cause_key IS NULL THEN RETURN; END IF;
  v_makes := CASE WHEN s.make = '' THEN ARRAY[''] ELSE ARRAY['', s.make] END;

  FOR v_scope IN SELECT x FROM unnest(CASE WHEN p_shared THEN ARRAY[s.user_id, v_nil] ELSE ARRAY[s.user_id] END) AS x LOOP
    INSERT INTO adn_learned_priors AS lp (scope_user_id, family, make, symptom_key, cause_key, n)
    SELECT v_scope, s.family, m, s.symptom_key, p_cause_key, GREATEST(p_weight, 0)
    FROM unnest(v_makes) AS m
    ON CONFLICT (scope_user_id, family, make, symptom_key, cause_key)
    DO UPDATE SET n = GREATEST(0, lp.n + p_weight), updated_at = now();

    INSERT INTO adn_learned_likelihoods AS ll (scope_user_id, family, make, cause_key, test_key, answer_key, n)
    SELECT v_scope, s.family, m, p_cause_key, st.test_key, st.answer_key, GREATEST(p_weight, 0)
    FROM adn_session_steps st CROSS JOIN unnest(v_makes) AS m
    WHERE st.session_id = p_session_id AND st.answer_key <> '__skip__'
    ON CONFLICT (scope_user_id, family, make, cause_key, test_key, answer_key)
    DO UPDATE SET n = GREATEST(0, ll.n + p_weight), updated_at = now();
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.adn_apply_outcome(
  p_session_id uuid, p_outcome text, p_corrected_cause_key text, p_source text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s adn_sessions%ROWTYPE;
  v_cause text;
  v_weight numeric;
  v_shared boolean;
BEGIN
  SELECT * INTO s FROM adn_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  IF s.learned_weight <> 0 AND s.learned_cause_key IS NOT NULL THEN
    PERFORM public.adn_learn_session(s.id, s.learned_cause_key, -s.learned_weight, s.learned_shared);
  END IF;

  v_cause := COALESCE(p_corrected_cause_key, s.confirmed_cause_key);
  v_weight := CASE p_outcome
    WHEN 'success' THEN 1
    WHEN 'partial' THEN 0.5
    ELSE CASE WHEN p_corrected_cause_key IS NOT NULL THEN 1 ELSE 0 END
  END;
  IF p_source = 'auto' THEN v_weight := v_weight * 0.6; END IF;
  v_shared := COALESCE((SELECT share_anonymous_learning FROM adn_settings WHERE user_id = s.user_id), true);

  IF v_weight > 0 AND v_cause IS NOT NULL THEN
    PERFORM public.adn_learn_session(s.id, v_cause, v_weight, v_shared);
  ELSE
    v_weight := 0;
  END IF;

  UPDATE adn_sessions SET
    status = 'verified', outcome = p_outcome, outcome_source = p_source, needs_review = false,
    confirmed_cause_key = v_cause,
    learned_cause_key = CASE WHEN v_weight > 0 THEN v_cause ELSE NULL END,
    learned_weight = v_weight, learned_shared = v_shared,
    outcome_at = now(), updated_at = now()
  WHERE id = s.id;

  RETURN jsonb_build_object('session_id', s.id, 'outcome', p_outcome, 'learned_weight', v_weight);
END;
$$;

REVOKE ALL ON FUNCTION public.adn_learn_session(uuid, text, numeric, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.adn_apply_outcome(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6) Client-callable lifecycle RPCs (ownership checked inside)
-- =============================================================
CREATE OR REPLACE FUNCTION public.adn_confirm_cause(p_session_id uuid, p_cause_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s adn_sessions%ROWTYPE;
  c adn_causes%ROWTYPE;
BEGIN
  SELECT * INTO s FROM adn_sessions WHERE id = p_session_id AND user_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  IF s.status NOT IN ('active', 'diagnosed', 'confirmed') THEN
    RAISE EXCEPTION 'This session can no longer change its confirmed cause';
  END IF;
  SELECT * INTO c FROM adn_causes WHERE key = p_cause_key AND family = s.family;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown cause for this equipment family'; END IF;

  UPDATE adn_sessions SET
    status = 'confirmed', confirmed_cause_key = c.key,
    initial_cause_key = COALESCE(initial_cause_key, c.key),
    confirmed_at = now(), concluded_at = COALESCE(concluded_at, now()), updated_at = now()
  WHERE id = s.id;

  RETURN jsonb_build_object(
    'key', c.key, 'label', c.label, 'safety_critical', c.safety_critical, 'summary', c.summary,
    'repair_steps', c.repair_steps, 'parts', c.parts);
END;
$$;

CREATE OR REPLACE FUNCTION public.adn_complete_repair(p_session_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s adn_sessions%ROWTYPE;
  v_days integer;
  v_due timestamptz;
BEGIN
  SELECT * INTO s FROM adn_sessions WHERE id = p_session_id AND user_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  IF s.status <> 'confirmed' THEN RAISE EXCEPTION 'Confirm the root cause before completing the repair'; END IF;
  v_days := COALESCE((SELECT verify_after_days FROM adn_settings WHERE user_id = s.user_id), 14);
  v_due := now() + make_interval(days => v_days);
  UPDATE adn_sessions SET
    status = 'repaired', repair_notes = NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), ''),
    repaired_at = now(), verify_due_at = v_due, needs_review = false, updated_at = now()
  WHERE id = s.id;
  RETURN jsonb_build_object('session_id', s.id, 'verify_due_at', v_due);
END;
$$;

CREATE OR REPLACE FUNCTION public.adn_record_outcome(
  p_session_id uuid, p_outcome text, p_corrected_cause_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s adn_sessions%ROWTYPE;
  v_corrected text := NULLIF(btrim(COALESCE(p_corrected_cause_key, '')), '');
BEGIN
  IF p_outcome NOT IN ('success', 'partial', 'failed') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
  SELECT * INTO s FROM adn_sessions WHERE id = p_session_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Session not found'; END IF;
  IF s.status NOT IN ('repaired', 'verified') THEN RAISE EXCEPTION 'Complete the repair before recording the outcome'; END IF;
  IF v_corrected IS NOT NULL AND NOT EXISTS (SELECT 1 FROM adn_causes WHERE key = v_corrected AND family = s.family) THEN
    RAISE EXCEPTION 'Unknown cause for this equipment family';
  END IF;
  RETURN public.adn_apply_outcome(s.id, p_outcome, v_corrected, 'technician');
END;
$$;

CREATE OR REPLACE FUNCTION public.adn_abandon_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE adn_sessions SET status = 'abandoned', updated_at = now()
  WHERE id = p_session_id AND user_id = public.get_account_owner_id() AND status IN ('active', 'diagnosed');
END;
$$;

-- Auto-verify: a repaired session whose verification date has passed AND whose customer
-- has no newer job counts as a (lower-weight) success. Anything ambiguous goes to a human.
CREATE OR REPLACE FUNCTION public.adn_sweep_my_due_verifications()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s adn_sessions%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR s IN
    SELECT * FROM adn_sessions
    WHERE user_id = v_owner AND status = 'repaired' AND needs_review = false AND verify_due_at <= now()
    ORDER BY verify_due_at LIMIT 50
  LOOP
    IF s.customer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.user_id = v_owner AND j.customer_id = s.customer_id
        AND j.created_at > s.repaired_at AND j.id IS DISTINCT FROM s.job_id
    ) THEN
      PERFORM public.adn_apply_outcome(s.id, 'success', NULL, 'auto');
      v_count := v_count + 1;
    ELSE
      UPDATE adn_sessions SET needs_review = true, updated_at = now() WHERE id = s.id;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.adn_my_stats()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH o AS (SELECT public.get_account_owner_id() AS id),
  agg AS (
    SELECT
      count(*) AS sessions_total,
      count(*) FILTER (WHERE status IN ('active', 'diagnosed', 'confirmed')) AS in_progress,
      count(*) FILTER (WHERE status = 'repaired') AS awaiting_verification,
      count(*) FILTER (WHERE status = 'verified') AS verified,
      count(*) FILTER (WHERE outcome IN ('success', 'partial')) AS fixed,
      count(*) FILTER (WHERE outcome IN ('success', 'partial') AND suggested_cause_key IS NOT NULL) AS scored,
      count(*) FILTER (WHERE outcome IN ('success', 'partial') AND suggested_cause_key IS NOT NULL
                         AND suggested_cause_key = confirmed_cause_key) AS top1_hits,
      avg(step_count) FILTER (WHERE status <> 'active' AND step_count > 0) AS avg_questions
    FROM adn_sessions WHERE user_id = (SELECT id FROM o)
  )
  SELECT jsonb_build_object(
    'sessions_total', agg.sessions_total,
    'in_progress', agg.in_progress,
    'awaiting_verification', agg.awaiting_verification,
    'verified', agg.verified,
    'fix_rate', CASE WHEN agg.verified > 0 THEN round(agg.fixed::numeric / agg.verified, 3) END,
    'top1_accuracy', CASE WHEN agg.scored > 0 THEN round(agg.top1_hits::numeric / agg.scored, 3) END,
    'avg_questions', round(agg.avg_questions, 1),
    'account_learned_outcomes', COALESCE((SELECT sum(n) FROM adn_learned_priors
        WHERE scope_user_id = (SELECT id FROM o) AND make = ''), 0),
    'network_learned_outcomes', COALESCE((SELECT sum(n) FROM adn_learned_priors
        WHERE scope_user_id = '00000000-0000-0000-0000-000000000000' AND make = ''), 0)
  ) FROM agg;
$$;

REVOKE ALL ON FUNCTION public.adn_confirm_cause(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adn_complete_repair(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adn_record_outcome(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adn_abandon_session(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adn_sweep_my_due_verifications() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adn_my_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adn_confirm_cause(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adn_complete_repair(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adn_record_outcome(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adn_abandon_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adn_sweep_my_due_verifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.adn_my_stats() TO authenticated;

-- =============================================================
-- 7) Context loader for the Edge Function (service role only).
--    Returns everything the engine needs as ONE jsonb document, so a growing knowledge
--    base can never be truncated by the API row limit.
-- =============================================================
CREATE OR REPLACE FUNCTION public.adn_load_context(p_owner uuid, p_symptom_key text, p_make text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_nil constant uuid := '00000000-0000-0000-0000-000000000000';
  v_family text;
  v_makes text[];
BEGIN
  SELECT family INTO v_family FROM adn_symptoms WHERE key = p_symptom_key AND active;
  IF v_family IS NULL THEN RETURN NULL; END IF;
  v_makes := CASE WHEN COALESCE(p_make, '') = '' THEN ARRAY[''] ELSE ARRAY['', p_make] END;

  RETURN jsonb_build_object(
    'symptom', (SELECT jsonb_build_object('key', key, 'label', label, 'family', family, 'mandatory_test_keys', mandatory_test_keys)
                FROM adn_symptoms WHERE key = p_symptom_key),
    'causes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', key, 'label', label, 'safety_critical', safety_critical)), '[]'::jsonb)
               FROM adn_causes WHERE family = v_family),
    'tests', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'key', t.key, 'label', t.label, 'question', t.question, 'tool_needed', t.tool_needed,
                'effort', t.effort, 'kind', t.kind, 'safety_note', t.safety_note, 'answers', t.answers)), '[]'::jsonb)
              FROM adn_tests t
              WHERE t.key IN (SELECT sl.test_key FROM adn_seed_likelihoods sl JOIN adn_causes c ON c.key = sl.cause_key WHERE c.family = v_family)
                 OR t.key IN (SELECT unnest(mandatory_test_keys) FROM adn_symptoms WHERE key = p_symptom_key)),
    'seed_priors', (SELECT COALESCE(jsonb_agg(jsonb_build_object('cause_key', cause_key, 'weight', weight)), '[]'::jsonb)
                    FROM adn_seed_priors WHERE symptom_key = p_symptom_key),
    'learned_priors', (SELECT COALESCE(jsonb_agg(jsonb_build_object('scope_user_id', scope_user_id, 'make', make, 'cause_key', cause_key, 'n', n)), '[]'::jsonb)
                       FROM adn_learned_priors
                       WHERE family = v_family AND symptom_key = p_symptom_key
                         AND scope_user_id IN (p_owner, v_nil) AND make = ANY (v_makes) AND n > 0),
    'seed_likelihoods', (SELECT COALESCE(jsonb_agg(jsonb_build_object('test_key', sl.test_key, 'cause_key', sl.cause_key, 'answer_key', sl.answer_key, 'weight', sl.weight)), '[]'::jsonb)
                         FROM adn_seed_likelihoods sl JOIN adn_causes c ON c.key = sl.cause_key WHERE c.family = v_family),
    'learned_likelihoods', (SELECT COALESCE(jsonb_agg(jsonb_build_object('scope_user_id', scope_user_id, 'make', make, 'cause_key', cause_key, 'test_key', test_key, 'answer_key', answer_key, 'n', n)), '[]'::jsonb)
                            FROM adn_learned_likelihoods
                            WHERE family = v_family AND scope_user_id IN (p_owner, v_nil) AND make = ANY (v_makes) AND n > 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.adn_load_context(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adn_load_context(uuid, text, text) TO service_role;
