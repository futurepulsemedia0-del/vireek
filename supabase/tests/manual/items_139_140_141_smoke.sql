-- Manual smoke test for migrations 20290312..20290314. Needs no tenant data. Runs in a transaction and ROLLS BACK.
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/manual/items_139_140_141_smoke.sql
BEGIN;
DO $$
DECLARE r public.cost_index_releases%ROWTYPE; v_ok boolean;
BEGIN
  -- 139: transition matrix + sandbox guard
  ASSERT public.fin_protection_transition('requested', 'quoted') = 'apply';
  ASSERT public.fin_protection_transition('quoted', 'active') = 'reject';
  ASSERT public.fin_protection_transition('active', 'canceled') = 'reject';
  ASSERT public.fin_protection_transition('accepted', 'expired') = 'reject';
  ASSERT public.fin_protection_transition('quoted', 'quoted') = 'noop';
  ASSERT public.fin_is_sandbox_partner('protection_stub') AND public.fin_is_sandbox_partner('mock');
  ASSERT NOT (public.fin_gate(gen_random_uuid(), 'service_protection') ->> 'allowed')::boolean, 'gate must fail closed';
  ASSERT (public.fin_gate(gen_random_uuid(), 'service_protection') ->> 'reason') IN ('flag_off', 'not_entitled');
  ASSERT (SELECT enabled FROM public.feature_flags WHERE key = 'service_protection') = false, 'flag default OFF';
  ASSERT public.fin_record_commission('mock', 'e1', 'service_protection', 'r1', 'accrual', 100, 'USD') ->> 'outcome' = 'sandbox_partner';
  ASSERT public.fin_record_commission('acme', 'e1', 'service_protection', 'r1', 'accrual', -1, 'USD') ->> 'outcome' = 'invalid';
  ASSERT public.fin_record_commission('acme', 'e1', 'service_protection', 'r1', 'accrual', 100, 'USD') ->> 'outcome' = 'unknown_reference';

  -- 140: rounding steps, service key, and the CHECK floor on cells
  ASSERT public.cost_index_step_cents(99999) = 1000 AND public.cost_index_step_cents(100000) = 5000 AND public.cost_index_step_cents(1000000) = 10000;
  ASSERT public.cost_index_service_key(' AC  Repair_Visit ') = 'ac-repair-visit';
  ASSERT public.cost_index_service_key('x') IS NULL;
  INSERT INTO public.cost_index_releases (slug, period_key, release_seq, title, period_start, period_end, as_of, method_version, cells_hash, thresholds, document)
  VALUES ('cost-index-smoke-r1', '2026-Q3', 99, 't', '2026-07-01', '2026-09-30', now(), 'x', repeat('a', 64), '{}', '{}') RETURNING * INTO r;
  INSERT INTO public.cost_index_cells (release_id, job_kind, trade, region, period_key, suppressed, n_orgs, n_jobs, p25_cents, p50_cents, p75_cents)
  VALUES (r.id, 'repair', 'hvac', 'south', '2026-Q3', false, 10, 100, 31000, 43000, 59000);   -- exactly at the floor: allowed
  FOREACH v_ok IN ARRAY ARRAY[false] LOOP
    BEGIN INSERT INTO public.cost_index_cells VALUES (r.id, 'repair', 'hvac', 'west', '2026-Q3', false, NULL, 9, 100, 31000, 43000, 59000); RAISE EXCEPTION 'k=9 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.cost_index_cells VALUES (r.id, 'repair', 'hvac', 'west', '2026-Q3', false, NULL, 12, 99, 31000, 43000, 59000); RAISE EXCEPTION 'volume 99 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.cost_index_cells VALUES (r.id, 'repair', 'hvac', 'west', '2026-Q3', false, NULL, 12, 100, 31000, 43001, 59000); RAISE EXCEPTION 'unrounded price accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.cost_index_cells VALUES (r.id, 'repair', 'hvac', 'west', '2026-Q3', false, NULL, NULL, NULL, 1, 1, 1, 1); RAISE EXCEPTION 'null counts accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.cost_index_cells VALUES (r.id, 'repair', 'hvac', '10001', '2026-Q3', true, 'k_anonymity', NULL, NULL, NULL, NULL, NULL); RAISE EXCEPTION 'ZIP region accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.cost_index_cells VALUES (r.id, 'repair', 'hvac', 'midwest', '2026-Q3', true, 'k_anonymity', NULL, 5, NULL, NULL, NULL); RAISE EXCEPTION 'suppressed with numbers accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;
  BEGIN PERFORM public.cost_index_publish_release(r.id, repeat('a', 64), 'smoke'); RAISE EXCEPTION 'published without review'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;

  -- 141: partnership cannot be signed/live without an agreement reference
  BEGIN INSERT INTO public.utility_partnerships (utility_name, status) VALUES ('Smoke Utility', 'live'); RAISE EXCEPTION 'live without agreement'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
SELECT 'items 139/140/141 smoke test passed' AS result;
