-- AI commit controls — structural + behavioural pgTAP checks. Run after migration 20290311000000.
BEGIN;
SELECT plan(23);

SELECT has_table('public', 'ai_commit_policies', 'policies table exists');
SELECT has_table('public', 'ai_commit_policy_changes', 'history table exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_commit_policies'::regclass), 'RLS on policies');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_commit_policy_changes'::regclass), 'RLS on history');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('ai_commit_policies', 'ai_commit_policy_changes') AND cmd <> 'SELECT'), 0, 'clients have no write policies');
SELECT is((SELECT count(*)::int FROM agent_action_catalog WHERE slug IN ('ai_commit_price', 'ai_commit_schedule')), 2, 'catalog slugs seeded');

SELECT ok(NOT has_function_privilege('authenticated', 'public.record_ai_commit_decision(uuid,text,text,text,text,text,jsonb)', 'EXECUTE'), 'authenticated cannot record decisions');
SELECT ok(NOT has_function_privilege('anon', 'public.record_ai_commit_decision(uuid,text,text,text,text,text,jsonb)', 'EXECUTE'), 'anon cannot record decisions');
SELECT ok(has_function_privilege('service_role', 'public.record_ai_commit_decision(uuid,text,text,text,text,text,jsonb)', 'EXECUTE'), 'service_role can record decisions');
SELECT ok(NOT has_function_privilege('anon', 'public.upsert_ai_commit_policy(text,integer,integer,integer,integer,text,boolean)', 'EXECUTE'), 'anon cannot change policy');

-- Fixture: a user id with no profile (so it is not an account owner).
SELECT throws_ok($$ SELECT public.upsert_ai_commit_policy('enforce') $$, 'Not authenticated.', 'policy change needs a session');

-- Defaults and constraints
INSERT INTO ai_commit_policies (user_id) VALUES ('00000000-0000-0000-0000-0000000000a1');
SELECT is((SELECT mode FROM ai_commit_policies WHERE user_id = '00000000-0000-0000-0000-0000000000a1'), 'shadow', 'default mode is shadow');
SELECT is((SELECT price_threshold_cents FROM ai_commit_policies WHERE user_id = '00000000-0000-0000-0000-0000000000a1'), 100000, 'default price threshold');
SELECT throws_ok($$ INSERT INTO ai_commit_policies (user_id, mode) VALUES ('00000000-0000-0000-0000-0000000000a2', 'yolo') $$, '23514', NULL, 'invalid mode rejected');
SELECT throws_ok($$ INSERT INTO ai_commit_policies (user_id, price_threshold_cents) VALUES ('00000000-0000-0000-0000-0000000000a3', -1) $$, '23514', NULL, 'negative threshold rejected');
SELECT throws_ok($$ INSERT INTO ai_commit_policies (user_id, schedule_max_duration_minutes) VALUES ('00000000-0000-0000-0000-0000000000a4', 0) $$, '23514', NULL, 'zero duration rejected');
SELECT is((SELECT count(*)::int FROM ai_commit_policy_changes WHERE user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'insert logged to history');

UPDATE ai_commit_policies SET mode = 'enforce' WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
SELECT is((SELECT count(*)::int FROM ai_commit_policy_changes WHERE user_id = '00000000-0000-0000-0000-0000000000a1'), 2, 'update logged to history');

-- record_ai_commit_decision: pending row, idempotent on correlation id, no amount_cents
SELECT is((public.record_ai_commit_decision('00000000-0000-0000-0000-0000000000a1', 'price', 'test', 'pending_approval', 'call1:price', 'r', '{"proposal":{"amount_cents":999}}'::jsonb))->>'decision', 'pending_approval', 'held decision recorded as pending');
SELECT is((public.record_ai_commit_decision('00000000-0000-0000-0000-0000000000a1', 'price', 'test', 'pending_approval', 'call1:price', 'r', '{}'::jsonb))->>'existing', 'true', 'same correlation id returns the first row');
SELECT is((SELECT count(*)::int FROM agent_action_log WHERE user_id = '00000000-0000-0000-0000-0000000000a1' AND action_slug = 'ai_commit_price'), 1, 'no duplicate row');
SELECT is((SELECT amount_cents FROM agent_action_log WHERE user_id = '00000000-0000-0000-0000-0000000000a1' AND action_slug = 'ai_commit_price'), NULL::integer, 'quoted price is not written to amount_cents');
SELECT throws_ok($$ SELECT public.record_ai_commit_decision('00000000-0000-0000-0000-0000000000a1', 'refund', 'test', 'auto_approved', 'x', NULL, '{}'::jsonb) $$, 'Invalid commit kind: refund', 'unknown kind rejected');

SELECT * FROM finish();
ROLLBACK;
