-- Pay by Bank — structural pgTAP checks (no fixtures, safe on any schema state after the migration).
BEGIN;
SELECT plan(21);

SELECT has_table('public', 'bank_payment_settings', 'settings table exists');
SELECT has_table('public', 'bank_payment_attempts', 'attempts table exists');
SELECT has_table('public', 'bank_payment_events', 'events table exists');
SELECT has_table('public', 'bank_payment_methods', 'methods table exists');

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_payment_settings'::regclass), 'RLS on settings');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_payment_attempts'::regclass), 'RLS on attempts');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_payment_events'::regclass), 'RLS on events');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_payment_methods'::regclass), 'RLS on methods');

-- Clients are read-only: no write policies for authenticated.
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'bank_payment_%' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')), 0, 'no client write policies');

SELECT has_column('public', 'payment_requests', 'payment_rail', 'payment_requests.payment_rail');
SELECT has_column('public', 'payment_requests', 'settlement_status', 'payment_requests.settlement_status');
SELECT has_column('public', 'payment_plans', 'payment_rail', 'payment_plans.payment_rail');

SELECT has_function('public', 'bank_attempt_apply', ARRAY['jsonb'], 'state machine RPC exists');
SELECT has_function('public', 'get_bank_payment_stats', ARRAY['integer'], 'stats RPC exists');

-- Service-role RPCs must not be callable by clients.
SELECT ok(NOT has_function_privilege('authenticated', 'public.bank_attempt_apply(jsonb)', 'EXECUTE'), 'authenticated cannot run bank_attempt_apply');
SELECT ok(NOT has_function_privilege('anon', 'public.bank_attempt_apply(jsonb)', 'EXECUTE'), 'anon cannot run bank_attempt_apply');
SELECT ok(has_function_privilege('service_role', 'public.bank_attempt_apply(jsonb)', 'EXECUTE'), 'service_role can run bank_attempt_apply');
SELECT ok(has_function_privilege('authenticated', 'public.set_bank_payment_settings(jsonb)', 'EXECUTE'), 'authenticated can save settings');

-- Fee estimates mirror functions/_shared/bankPayments/logic.ts.
SELECT is(public.bank_fee_estimate('card', 50000), 1480, 'card fee: 2.9% + 30c');
SELECT is(public.bank_fee_estimate('ach_debit', 50000), 400, 'ACH fee: 0.8%');
SELECT is(public.bank_fee_estimate('ach_debit', 1000000), 500, 'ACH fee capped at $5');

SELECT * FROM finish();
ROLLBACK;
