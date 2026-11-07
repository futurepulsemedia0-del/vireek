-- supabase/tests/outcome_learning.sql
-- Plain-SQL assertions (no pgTAP). Run on a scratch/staging DB AFTER both outcome-learning
-- migrations:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/outcome_learning.sql
-- Everything runs in one transaction and is rolled back. Prints NOTICE 'PASS: ...' per check.

BEGIN;

DO $$
DECLARE
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  v_exp uuid; v_arm text; v_arm2 text; v_n integer; v_holdouts integer := 0; i integer;
BEGIN
  -- Fixtures (service-role context: auth.uid() is NULL)
  INSERT INTO outcome_learning_settings (user_id, capture_enabled, share_cross_tenant) VALUES (u1, true, true), (u2, true, false);

  -- 1. RLS enabled on every new table
  PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
     AND c.relname IN ('outcome_learning_settings','agent_outcome_watch','prediction_log','predictor_status',
       'outcome_experiments','outcome_experiment_assignments','learning_policy_changes','outcome_alerts',
       'outcome_cross_tenant_aggregates','outcome_aggregate_contributions','outcome_privacy_salt');
  IF FOUND THEN RAISE EXCEPTION 'FAIL: a new table has RLS disabled'; END IF;
  RAISE NOTICE 'PASS: RLS enabled on all new tables';

  -- 2. Service-only tables expose no policy to clients
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('outcome_aggregate_contributions','outcome_privacy_salt')) THEN
    RAISE EXCEPTION 'FAIL: audit/salt table has a client policy';
  END IF;
  RAISE NOTICE 'PASS: audit and salt tables have no client policies';

  -- 3. Aggregate table cannot hold unsafe rows (k-anonymity + dominance enforced by CHECK)
  BEGIN
    INSERT INTO outcome_cross_tenant_aggregates (signal_key, tenant_count, sample_n, success_n, success_rate, max_tenant_share)
    VALUES ('a|b', 4, 100, 50, 0.5, 0.3);
    RAISE EXCEPTION 'FAIL: tenant_count 4 accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: tenant_count < 5 rejected'; END;
  BEGIN
    INSERT INTO outcome_cross_tenant_aggregates (signal_key, tenant_count, sample_n, success_n, success_rate, max_tenant_share)
    VALUES ('a|b', 6, 100, 50, 0.5, 0.6);
    RAISE EXCEPTION 'FAIL: dominant tenant (60%) accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: tenant share > 50% rejected'; END;
  BEGIN
    INSERT INTO outcome_cross_tenant_aggregates (signal_key, tenant_count, sample_n, success_n, success_rate, max_tenant_share)
    VALUES ('Free Text With Spaces', 6, 100, 50, 0.5, 0.3);
    RAISE EXCEPTION 'FAIL: free-text signal_key accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: free-text signal_key rejected'; END;

  -- 4. No free-text / identifier columns in cross-tenant tables
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'outcome_cross_tenant_aggregates'
               AND column_name IN ('user_id','tenant_id','notes','evidence','customer_name','phone','email')) THEN
    RAISE EXCEPTION 'FAIL: aggregate table has an identifier/PII-like column';
  END IF;
  RAISE NOTICE 'PASS: aggregate table has no identifier columns';

  -- 5. Floors cannot be lowered through build_outcome_aggregates arguments (only 2 tenants opted in => nothing published)
  v_n := public.build_outcome_aggregates(1, 1.0, 1);
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL: aggregate published below the floors (%).', v_n; END IF;
  RAISE NOTICE 'PASS: floors cannot be lowered by arguments';

  -- 6. Dataset view is opted-in only and has no free-text columns
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'outcome_dataset_v1'
             AND column_name IN ('user_id','evidence','notes')) THEN
    RAISE EXCEPTION 'FAIL: dataset exposes user_id/evidence/notes';
  END IF;
  RAISE NOTICE 'PASS: dataset view exposes no identity or free text';

  -- 7. Experiment assignment is deterministic, idempotent and respects the holdout share (~10% +/- 3pt)
  INSERT INTO outcome_experiments (user_id, action_slug, name, holdout_pct, contact_rule_ack)
  SELECT u1, slug, 'test', 10, true FROM agent_action_catalog WHERE category IN ('messaging','marketing') LIMIT 1
  RETURNING id INTO v_exp;
  IF v_exp IS NULL THEN RAISE NOTICE 'SKIP: no messaging/marketing catalog row to test experiments'; ELSE
    v_arm := public.assign_experiment_arm(v_exp, 'subject-x');
    v_arm2 := public.assign_experiment_arm(v_exp, 'subject-x');
    IF v_arm <> v_arm2 THEN RAISE EXCEPTION 'FAIL: assignment not idempotent'; END IF;
    FOR i IN 1..5000 LOOP
      IF public.assign_experiment_arm(v_exp, 'case-' || i) = 'holdout' THEN v_holdouts := v_holdouts + 1; END IF;
    END LOOP;
    IF v_holdouts < 350 OR v_holdouts > 650 THEN RAISE EXCEPTION 'FAIL: holdout share off (% of 5000)', v_holdouts; END IF;
    RAISE NOTICE 'PASS: assignment idempotent, holdout share = % / 5000', v_holdouts;
    -- outcome before assignment is ignored
    IF public.resolve_experiment_outcome(v_exp, 'subject-x', true, now() - interval '1 day') <> 0 THEN
      RAISE EXCEPTION 'FAIL: outcome before assignment was credited';
    END IF;
    RAISE NOTICE 'PASS: experiment outcome preceding assignment ignored';
  END IF;

  -- 8. Prediction replay is idempotent and earlier outcomes are not credited
  IF NOT public.record_prediction(u1, 'lead_books', 'leads', 'L1', 0.7) THEN RAISE EXCEPTION 'FAIL: first prediction rejected'; END IF;
  IF public.record_prediction(u1, 'lead_books', 'leads', 'L1', 0.1) THEN RAISE EXCEPTION 'FAIL: replay rewrote prediction'; END IF;
  IF public.resolve_prediction(u1, 'lead_books', 'leads', 'L1', true, now() - interval '1 day') <> 0 THEN
    RAISE EXCEPTION 'FAIL: outcome before prediction credited';
  END IF;
  RAISE NOTICE 'PASS: prediction replay idempotent; earlier outcome ignored';

  -- 9. wilson_lower_bound sanity
  IF abs(public.wilson_lower_bound(50, 100) - 0.4038) > 0.001 THEN RAISE EXCEPTION 'FAIL: wilson_lower_bound'; END IF;
  RAISE NOTICE 'PASS: wilson_lower_bound matches the TypeScript implementation';
END $$;

ROLLBACK;
