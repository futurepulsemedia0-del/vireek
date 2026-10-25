-- pgTAP: Vireek Pay & Capital safety invariants (run with `supabase test db`).
BEGIN;
SELECT plan(14);

-- 1. Fail-closed defaults
SELECT is((SELECT count(*)::int FROM pay_platform_controls WHERE enabled), 0, 'every product starts disabled');
SELECT is((SELECT count(*)::int FROM pay_platform_controls WHERE mode <> 'sandbox'), 0, 'every product starts in sandbox');

-- 2. Live mode is impossible without an agreement + approver
SELECT throws_ok(
  $$UPDATE pay_platform_controls SET mode = 'live' WHERE product = 'capital'$$,
  '23514', NULL, 'live mode requires partner agreement + approval stamp');

-- 3. product state reflects the kill switch
SELECT is((public.pay_product_state('capital', gen_random_uuid()))->>'reason', 'platform_disabled', 'disabled product is unavailable');
UPDATE pay_platform_controls SET enabled = true WHERE product = 'capital';
SELECT is((public.pay_product_state('capital', gen_random_uuid()))->>'available', 'true', 'enabled sandbox product is available');
UPDATE pay_platform_controls SET enabled = false, killed_at = now() WHERE product = 'capital';
SELECT is((public.pay_product_state('capital', gen_random_uuid()))->>'reason', 'killed', 'killed product is unavailable');
SELECT is((public.pay_product_state('nope', gen_random_uuid()))->>'available', 'false', 'unknown product is unavailable');

-- 4. Disclosure text is immutable; seeded drafts are unreviewed
SELECT throws_ok($$UPDATE pay_disclosures SET body = body || ' tampered' WHERE key = 'ewa_terms'$$, '42501', NULL, 'disclosure text cannot be edited');
SELECT throws_ok($$DELETE FROM pay_disclosures WHERE key = 'ewa_terms'$$, '42501', NULL, 'disclosure cannot be deleted');
SELECT is((SELECT count(*)::int FROM pay_disclosures WHERE legal_reviewed), 0, 'seeded disclosures are drafts until counsel reviews');

-- 5. Offers cannot exist without full cost disclosure
SELECT throws_ok(
  $$INSERT INTO capital_offers (application_id, user_id, provider, sandbox, external_offer_id, offered_amount_cents, total_repayment_cents, finance_charge_cents, term_days, estimated_apr_bps, repayment_description, expires_at)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'x', true, 'o', 100000, 110000, 5, 90, 1000, 'long enough description', now() + interval '1 day')$$,
  NULL, NULL, 'offer with inconsistent finance charge is rejected');

-- 6. Service-only functions are not callable by signed-in users
SELECT is(has_function_privilege('authenticated', 'public.pay_finalize_transfer(uuid,text,text,text,jsonb)', 'EXECUTE'), false, 'finalize is service-only');
SELECT is(has_function_privilege('authenticated', 'public.pay_product_state(text,uuid)', 'EXECUTE'), false, 'product_state(tenant) is service-only');
SELECT is(has_table_privilege('authenticated', 'pay_transfers', 'INSERT'), false, 'clients cannot insert transfers');

SELECT * FROM finish();
ROLLBACK;
