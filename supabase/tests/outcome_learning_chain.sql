-- supabase/tests/outcome_learning_chain.sql
-- Executed-SQL half of the outcome-learning chain verification (docs/intelligence/vrn-verification.md).
-- The TypeScript half is supabase/functions/_shared/outcomes/outcomeLearningChain.test.mjs.
--
-- Run on a SCRATCH / staging database AFTER 20290101000000 and 20290102000000:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/outcome_learning_chain.sql
-- Everything is one transaction that ends in ROLLBACK; each check prints NOTICE 'PASS: ...'.
-- Fixtures use random user ids, the predictor names vrn_* and the action slug vrn_chain_action, so they
-- cannot collide with real rows. refresh_predictor_status() and build_outcome_aggregates() are global
-- by design (they scan every tenant): that is why this is not meant for production data.
--
-- Chain covered here:  prediction_log -> predictor_calibration_v (bins/ECE) -> refresh_predictor_status
--   -> demotion + alert + weight 0 -> rollback_learning_change (+ alert, idempotent)
--   -> low-quality outcomes excluded from aggregates -> cohort < 5 tenants suppressed, 5 published.

BEGIN;

INSERT INTO agent_action_catalog (slug, agent_source, label, category)
VALUES ('vrn_chain_action', 'vrn-test', 'VRN chain test action', 'messaging')
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- A. calibration -> ECE breach -> demotion -> alert -> weight 0
-- =============================================================
DO $$
DECLARE
  u uuid := gen_random_uuid();
  v_status text; v_weight numeric; v_ece numeric; v_n integer; v_alerts integer; v_w numeric;
BEGIN
  -- bad: always says 90%, never happens (60 resolved) -> ECE 0.9
  INSERT INTO prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob, predicted_at, outcome, outcome_at)
  SELECT u, 'vrn_bad', 'v1', 'vrn_subject', 's' || g, 0.9, now() - interval '10 days', false, now() - interval '9 days'
  FROM generate_series(1, 60) g;
  -- good: says 50%, happens half the time -> ECE 0, skill 0
  INSERT INTO prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob, predicted_at, outcome, outcome_at)
  SELECT u, 'vrn_good', 'v1', 'vrn_subject', 's' || g, 0.5, now() - interval '10 days', (g % 2 = 0), now() - interval '9 days'
  FROM generate_series(1, 60) g;
  -- few: as wrong as bad, but only 10 outcomes -> must NOT be demoted
  INSERT INTO prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob, predicted_at, outcome, outcome_at)
  SELECT u, 'vrn_few', 'v1', 'vrn_subject', 's' || g, 0.9, now() - interval '10 days', false, now() - interval '9 days'
  FROM generate_series(1, 10) g;
  -- drift: calibrated 60 days ago, badly broken in the last 5 days (both windows n >= 50)
  INSERT INTO prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob, predicted_at, outcome, outcome_at)
  SELECT u, 'vrn_drift', 'v1', 'vrn_subject', 'p' || g, 0.5, now() - interval '60 days', (g % 2 = 0), now() - interval '59 days'
  FROM generate_series(1, 60) g;
  INSERT INTO prediction_log (user_id, predictor, model_version, subject_table, subject_id, predicted_prob, predicted_at, outcome, outcome_at)
  SELECT u, 'vrn_drift', 'v1', 'vrn_subject', 'r' || g, 0.9, now() - interval '5 days', false, now() - interval '4 days'
  FROM generate_series(1, 60) g;

  -- 1. bins/ECE come from the view
  SELECT ece, n INTO v_ece, v_n FROM predictor_calibration_v WHERE user_id = u AND predictor = 'vrn_bad';
  IF v_n <> 60 OR abs(v_ece - 0.9) > 1e-9 THEN RAISE EXCEPTION 'FAIL: vrn_bad calibration view wrong (n=%, ece=%)', v_n, v_ece; END IF;
  SELECT ece INTO v_ece FROM predictor_calibration_v WHERE user_id = u AND predictor = 'vrn_good';
  IF v_ece IS NULL OR v_ece > 1e-9 THEN RAISE EXCEPTION 'FAIL: vrn_good ECE should be 0 (got %)', v_ece; END IF;
  RAISE NOTICE 'PASS: reliability bins / ECE computed by predictor_calibration_v';

  PERFORM public.refresh_predictor_status();

  -- 2. ECE breach -> demote, weight 0
  SELECT status, weight INTO v_status, v_weight FROM predictor_status WHERE user_id = u AND predictor = 'vrn_bad';
  IF v_status IS DISTINCT FROM 'demote' OR v_weight IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL: vrn_bad not demoted (%, %)', v_status, v_weight; END IF;
  RAISE NOTICE 'PASS: ECE breach demotes the predictor (weight 0)';

  -- 3. well calibrated -> ok ; too little data -> insufficient_data (never demoted)
  SELECT status INTO v_status FROM predictor_status WHERE user_id = u AND predictor = 'vrn_good';
  IF v_status IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'FAIL: vrn_good status % (want ok)', v_status; END IF;
  SELECT status, weight INTO v_status, v_weight FROM predictor_status WHERE user_id = u AND predictor = 'vrn_few';
  IF v_status IS DISTINCT FROM 'insufficient_data' OR v_weight <> 1 THEN RAISE EXCEPTION 'FAIL: vrn_few status %, weight %', v_status, v_weight; END IF;
  RAISE NOTICE 'PASS: calibrated predictor stays ok; n < 50 is insufficient_data with weight 1';

  -- 4. alert raised for the demotion only
  SELECT count(*) INTO v_alerts FROM outcome_alerts
   WHERE user_id = u AND alert_key = 'demoted:vrn_bad:v1' AND kind = 'predictor_demoted' AND resolved_at IS NULL;
  IF v_alerts <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 open predictor_demoted alert, got %', v_alerts; END IF;
  SELECT count(*) INTO v_alerts FROM outcome_alerts
   WHERE user_id = u AND alert_key IN ('demoted:vrn_good:v1', 'demoted:vrn_few:v1');
  IF v_alerts <> 0 THEN RAISE EXCEPTION 'FAIL: alert raised for a non-demoted predictor'; END IF;
  RAISE NOTICE 'PASS: demotion raises exactly one predictor_demoted alert';

  -- 5. drift alert
  SELECT count(*) INTO v_alerts FROM outcome_alerts
   WHERE user_id = u AND alert_key = 'drift:vrn_drift:v1' AND kind = 'predictor_drift';
  IF v_alerts <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 predictor_drift alert, got %', v_alerts; END IF;
  RAISE NOTICE 'PASS: calibration drift (recent vs prior 30-90d window) raises predictor_drift';

  -- 6. decision code reads weight 0 for the demoted predictor, 1 otherwise / when unknown
  v_w := public.get_predictor_weight(u, 'vrn_bad');
  IF v_w <> 0 THEN RAISE EXCEPTION 'FAIL: get_predictor_weight(vrn_bad) = %', v_w; END IF;
  IF public.get_predictor_weight(u, 'vrn_good') <> 1 OR public.get_predictor_weight(u, 'vrn_unknown') <> 1 THEN
    RAISE EXCEPTION 'FAIL: get_predictor_weight default is not 1';
  END IF;
  RAISE NOTICE 'PASS: get_predictor_weight returns 0 for demoted, 1 for ok/unknown';

  -- 7. idempotent: a second refresh neither duplicates the alert nor changes the status
  PERFORM public.refresh_predictor_status();
  SELECT count(*) INTO v_alerts FROM outcome_alerts WHERE user_id = u AND alert_key = 'demoted:vrn_bad:v1';
  IF v_alerts <> 1 THEN RAISE EXCEPTION 'FAIL: second refresh duplicated the alert (%)', v_alerts; END IF;
  RAISE NOTICE 'PASS: refresh_predictor_status is idempotent';
END $$;

-- =============================================================
-- B. automatic rollback of a learning change (the SQL half; the decision rule is tested in the .mjs file)
-- =============================================================
DO $$
DECLARE
  u uuid := gen_random_uuid(); v_id uuid; c learning_policy_changes; v_req boolean; v_alerts integer;
BEGIN
  INSERT INTO agent_permissions (user_id, action_slug, enabled, requires_approval)
  VALUES (u, 'vrn_chain_action', true, false);          -- state AFTER the auto-applied change
  INSERT INTO learning_policy_changes (user_id, action_slug, kind, risk_class, before_state, after_state,
                                       baseline_k, baseline_n, monitor_until)
  VALUES (u, 'vrn_chain_action', 'relax_approval', 'low',
          jsonb_build_object('row_existed', true, 'requires_approval', true),
          jsonb_build_object('requires_approval', false),
          90, 100, now() + interval '14 days')
  RETURNING id INTO v_id;

  c := public.rollback_learning_change(v_id, 'outcomes_degraded');
  IF c.status <> 'rolled_back' OR c.resolution_reason <> 'outcomes_degraded' THEN RAISE EXCEPTION 'FAIL: change not rolled back (%)', c.status; END IF;
  SELECT requires_approval INTO v_req FROM agent_permissions WHERE user_id = u AND action_slug = 'vrn_chain_action';
  IF v_req IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: requires_approval not restored to before_state (%)', v_req; END IF;
  RAISE NOTICE 'PASS: rollback restores the pre-change approval setting';

  SELECT count(*) INTO v_alerts FROM outcome_alerts
   WHERE user_id = u AND alert_key = 'rollback:' || v_id::text AND kind = 'policy_rolled_back';
  IF v_alerts <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 policy_rolled_back alert, got %', v_alerts; END IF;
  RAISE NOTICE 'PASS: rollback raises a policy_rolled_back alert';

  c := public.rollback_learning_change(v_id, 'second call');   -- idempotent: no second alert, reason unchanged
  IF c.resolution_reason <> 'outcomes_degraded' THEN RAISE EXCEPTION 'FAIL: second rollback rewrote the reason'; END IF;
  SELECT count(*) INTO v_alerts FROM outcome_alerts WHERE user_id = u AND alert_key = 'rollback:' || v_id::text;
  IF v_alerts <> 1 THEN RAISE EXCEPTION 'FAIL: second rollback duplicated the alert'; END IF;
  RAISE NOTICE 'PASS: rollback_learning_change is idempotent';

  -- a confirmed change can no longer be rolled back
  INSERT INTO learning_policy_changes (user_id, action_slug, kind, risk_class, before_state, after_state,
                                       baseline_k, baseline_n, monitor_until, status, resolved_at)
  VALUES (u, 'vrn_chain_action', 'tighten_approval', 'low', '{"requires_approval": false}', '{"requires_approval": true}',
          90, 100, now(), 'confirmed', now())
  RETURNING id INTO v_id;
  c := public.rollback_learning_change(v_id, 'late');
  IF c.status <> 'confirmed' THEN RAISE EXCEPTION 'FAIL: a confirmed change was rolled back'; END IF;
  RAISE NOTICE 'PASS: a confirmed change is never rolled back';
END $$;

-- =============================================================
-- C. low-quality outcomes excluded; cohort < 5 tenants suppressed
-- =============================================================
DO $$
DECLARE
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); t3 uuid := gen_random_uuid();
  t4 uuid := gen_random_uuid(); t5 uuid := gen_random_uuid(); t6 uuid := gen_random_uuid();  -- t6: not opted in
  v_key constant text := 'vrn_chain_action|booking_after_sms';
  v_made integer; v_cnt integer; a outcome_cross_tenant_aggregates; v_refs integer;
BEGIN
  INSERT INTO outcome_learning_settings (user_id, capture_enabled, share_cross_tenant)
  VALUES (t1, true, true), (t2, true, true), (t3, true, true), (t4, true, true), (t5, true, true), (t6, true, false);

  -- t1..t4: 20 learnable outcomes each (15 success, 5 failure)
  WITH ins AS (
    INSERT INTO agent_action_log (user_id, action_slug, agent_source, status, executed_at)
    SELECT x.u, 'vrn_chain_action', 'vrn-test', 'executed', now() - interval '5 days'
    FROM unnest(ARRAY[t1, t2, t3, t4]) AS x(u) CROSS JOIN generate_series(1, 20)
    RETURNING id, user_id
  )
  INSERT INTO agent_action_outcomes (user_id, log_id, action_slug, outcome, recorded_by, attribution_rule, attribution_version, excluded_from_learning)
  SELECT user_id, id, 'vrn_chain_action',
         CASE WHEN row_number() OVER (PARTITION BY user_id ORDER BY id) % 4 = 0 THEN 'failure' ELSE 'success' END,
         'system', 'booking_after_sms', 'v1', false
  FROM ins;

  -- t1: +10 LOW-QUALITY outcomes (unknown, excluded) that must never count
  WITH ins AS (
    INSERT INTO agent_action_log (user_id, action_slug, agent_source, status, executed_at)
    SELECT t1, 'vrn_chain_action', 'vrn-test', 'executed', now() - interval '5 days' FROM generate_series(1, 10)
    RETURNING id, user_id
  )
  INSERT INTO agent_action_outcomes (user_id, log_id, action_slug, outcome, recorded_by, attribution_rule, attribution_version, excluded_from_learning, dq_flags)
  SELECT user_id, id, 'vrn_chain_action', 'unknown', 'system', 'booking_after_sms', 'v1', true, ARRAY['unresolvable_target'] FROM ins;

  -- t5: 20 outcomes, ALL low quality -> t5 must not count towards the 5-tenant floor
  WITH ins AS (
    INSERT INTO agent_action_log (user_id, action_slug, agent_source, status, executed_at)
    SELECT t5, 'vrn_chain_action', 'vrn-test', 'executed', now() - interval '5 days' FROM generate_series(1, 20)
    RETURNING id, user_id
  )
  INSERT INTO agent_action_outcomes (user_id, log_id, action_slug, outcome, recorded_by, attribution_rule, attribution_version, excluded_from_learning, dq_flags)
  SELECT user_id, id, 'vrn_chain_action', 'success', 'system', 'booking_after_sms', 'v1', true, ARRAY['outcome_preceded_action'] FROM ins;

  -- t6: NOT opted in, 200 outcomes: would dominate the cohort if it were (wrongly) counted
  WITH ins AS (
    INSERT INTO agent_action_log (user_id, action_slug, agent_source, status, executed_at)
    SELECT t6, 'vrn_chain_action', 'vrn-test', 'executed', now() - interval '5 days' FROM generate_series(1, 200)
    RETURNING id, user_id
  )
  INSERT INTO agent_action_outcomes (user_id, log_id, action_slug, outcome, recorded_by, attribution_rule, attribution_version, excluded_from_learning)
  SELECT user_id, id, 'vrn_chain_action', 'success', 'system', 'booking_after_sms', 'v1', false FROM ins;

  -- 1. only 4 tenants have learnable, consented data -> suppressed (even though raw rows exist for 6 tenants)
  v_made := public.build_outcome_aggregates();
  SELECT count(*) INTO v_cnt FROM outcome_cross_tenant_aggregates WHERE signal_key = v_key;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: cohort of 4 learnable tenants was published'; END IF;
  RAISE NOTICE 'PASS: cohort under 5 tenants suppressed (low-quality-only and non-consenting tenants do not count)';

  -- 1b. the arguments cannot lower the floors
  PERFORM public.build_outcome_aggregates(1, 1.0, 1);
  SELECT count(*) INTO v_cnt FROM outcome_cross_tenant_aggregates WHERE signal_key = v_key;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: lowering floors via arguments published a 4-tenant cohort'; END IF;
  RAISE NOTICE 'PASS: floors cannot be lowered through build_outcome_aggregates arguments';

  -- 2. t5's outcomes become learnable -> 5 tenants -> published with the exact expected numbers
  UPDATE agent_action_outcomes SET excluded_from_learning = false, dq_flags = '{}' WHERE user_id = t5;
  PERFORM public.build_outcome_aggregates();
  SELECT * INTO a FROM outcome_cross_tenant_aggregates WHERE signal_key = v_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: a 5-tenant cohort was not published'; END IF;
  IF a.tenant_count <> 5 THEN RAISE EXCEPTION 'FAIL: tenant_count % (want 5; non-consenting tenant must not count)', a.tenant_count; END IF;
  -- t1..t4: 20 each (15 success; the 10 excluded rows of t1 are ignored); t5: 20 'success' -> 100 rows, 4*15 + 20 = 80 successes
  IF a.sample_n <> 100 THEN RAISE EXCEPTION 'FAIL: sample_n % (want 100; excluded/unconsented rows leaked in)', a.sample_n; END IF;
  IF a.success_n <> 80 THEN RAISE EXCEPTION 'FAIL: success_n % (want 80)', a.success_n; END IF;
  IF a.max_tenant_share > 0.5 THEN RAISE EXCEPTION 'FAIL: dominance share % published', a.max_tenant_share; END IF;
  RAISE NOTICE 'PASS: 5 consenting tenants publish; excluded and unconsented rows are not in the counts';

  -- 3. audit trail is hashed: 5 contribution rows, none equal to a raw tenant id, none for the non-consenting tenant
  SELECT count(*) INTO v_refs FROM outcome_aggregate_contributions WHERE aggregate_id = a.id;
  IF v_refs <> 5 THEN RAISE EXCEPTION 'FAIL: % contribution rows (want 5)', v_refs; END IF;
  IF EXISTS (SELECT 1 FROM outcome_aggregate_contributions c WHERE c.aggregate_id = a.id
             AND c.tenant_ref IN (t1::text, t2::text, t3::text, t4::text, t5::text, t6::text)) THEN
    RAISE EXCEPTION 'FAIL: raw tenant id stored in contributions';
  END IF;
  RAISE NOTICE 'PASS: contributions are salted hashes, one per consenting tenant';

  -- 4. dominance: one tenant above 50% of the cohort is suppressed (t1 now has 300 learnable rows)
  DELETE FROM outcome_cross_tenant_aggregates WHERE signal_key = v_key;
  WITH ins AS (
    INSERT INTO agent_action_log (user_id, action_slug, agent_source, status, executed_at)
    SELECT t1, 'vrn_chain_action', 'vrn-test', 'executed', now() - interval '5 days' FROM generate_series(1, 300)
    RETURNING id, user_id
  )
  INSERT INTO agent_action_outcomes (user_id, log_id, action_slug, outcome, recorded_by, attribution_rule, attribution_version, excluded_from_learning)
  SELECT user_id, id, 'vrn_chain_action', 'success', 'system', 'booking_after_sms', 'v1', false FROM ins;
  PERFORM public.build_outcome_aggregates();
  SELECT count(*) INTO v_cnt FROM outcome_cross_tenant_aggregates WHERE signal_key = v_key;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL: a cohort dominated by one tenant was published'; END IF;
  RAISE NOTICE 'PASS: dominant-tenant cohort (>50%%) suppressed';
END $$;

ROLLBACK;
