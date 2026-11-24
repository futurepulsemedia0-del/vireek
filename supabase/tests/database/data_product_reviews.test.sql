-- Data product reviews (pgTAP): catalog + privileges, seeds, approval invariants, separation of duties, freeze,
-- revocation, expiry, gate reasons, append-only history and staff-only RLS.
-- Migration under test: 20290311000000_data_product_reviews.sql
-- Run with:  supabase test db        (NOT RUN in the authoring environment: no Postgres was available)
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d0a01', 'staff-a@dpr.test'),
  ('00000000-0000-0000-0000-0000000d0b01', 'staff-b@dpr.test'),
  ('00000000-0000-0000-0000-0000000d0c01', 'tenant@dpr.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000d0a01', 'owner'),
  ('00000000-0000-0000-0000-0000000d0b01', 'owner'),
  ('00000000-0000-0000-0000-0000000d0c01', 'owner')
on conflict (id) do nothing;
update public.profiles set is_staff = true
 where id in ('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01');

create or replace function pg_temp.claim_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.all_criteria() returns jsonb language sql as $$
  select jsonb_object_agg(c, true) from unnest(public.data_product_required_criteria()) c
$$;

-- --------------------------------------------------------------- catalog ----
select ok((select relrowsecurity from pg_class where oid = 'public.data_product_reviews'::regclass), 'reviews: RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.data_product_review_events'::regclass), 'events: RLS enabled');
select is((select count(*)::int from pg_policies where tablename in ('data_product_reviews','data_product_review_events') and cmd <> 'SELECT'), 0,
          'no client write policy on either table');
select ok(not has_table_privilege('authenticated', 'public.data_product_reviews', 'insert'), 'authenticated cannot insert');
select ok(not has_table_privilege('authenticated', 'public.data_product_reviews', 'update'), 'authenticated cannot update');
select ok(not has_table_privilege('authenticated', 'public.data_product_reviews', 'delete'), 'authenticated cannot delete');
select ok(not has_table_privilege('anon', 'public.data_product_reviews', 'select'), 'anon cannot read');
select ok(not has_function_privilege('authenticated', 'public.data_product_gate(text,text)', 'execute'), 'authenticated cannot call the gate');
select ok(not has_function_privilege('anon', 'public.data_product_gate(text,text)', 'execute'), 'anon cannot call the gate');
select ok(has_function_privilege('service_role', 'public.data_product_gate(text,text)', 'execute'), 'service_role can call the gate');
select ok(not has_function_privilege('anon', 'public.data_product_decide(uuid,text,text,integer)', 'execute'), 'anon cannot decide');
select is(public.data_product_required_criteria(), array['E1','E2','E3','E4','E5','E6','E7','E8'], 'criteria E1..E8');

-- ----------------------------------------------------------------- seeds ----
select is((select count(*)::int from public.data_product_reviews where product_key in ('vireek_insights','evidence_marketplace','state_of_calls') and decision = 'pending'), 3,
          'three seeded products are pending, never pre-approved');
select is((select count(*)::int from public.data_product_reviews where decision = 'approved'), 0, 'nothing is approved by the migration');
select is((select count(*)::int from public.data_product_review_events e join public.data_product_reviews r on r.id = e.review_id
           where r.product_key in ('vireek_insights','evidence_marketplace','state_of_calls') and e.event = 'requested'), 3, 'seeds logged a requested event');

-- ------------------------------------------------------- gate: fail-closed ---
select is(public.data_product_gate('vireek_insights', 'insights-api') ->> 'reason', 'pending', 'seeded product: pending');
select is((public.data_product_gate('vireek_insights', 'insights-api') ->> 'allowed')::boolean, false, 'pending => not allowed');
select is(public.data_product_gate('no_such_product', 'x') ->> 'reason', 'no_review', 'unknown product => no_review');
select is(public.data_product_gate(null, 'x') ->> 'reason', 'invalid_arguments', 'NULL key => invalid_arguments');
select is(public.data_product_gate('Bad Key', 'x') ->> 'reason', 'invalid_arguments', 'malformed key => invalid_arguments');
select is(public.data_product_gate('ok_key', '  ') ->> 'reason', 'invalid_arguments', 'blank endpoint => invalid_arguments');

-- ------------------------------------------------------ non-staff refused ----
select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0c01');
select throws_ok($$select public.data_product_request_review('t_prod','T','A purpose that is long enough to pass.',array['t-fn'],array[]::text[],'[{"class":"subscriber","name":"S"}]'::jsonb,false)$$,
                 '42501', null, 'non-staff cannot request a review');
select pg_temp.claim_as(null);
select throws_ok($$select public.data_product_decide(gen_random_uuid(),'approved','x',30)$$, '42501', null, 'no session (service role) cannot decide');

-- ------------------------------------------------------------- happy path ---
select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0a01');
create temp table t_ids as
  select public.data_product_request_review('t_prod','Test product','A purpose that is long enough to pass the check.',
         array['t-fn'], array['benchmark_cohorts'], '[{"class":"subscriber","name":"Subscribers"}]'::jsonb, false) as id;
select ok((select id from t_ids) is not null, 'staff A requested a review');
select is((select requested_by from public.data_product_reviews where id = (select id from t_ids)), '00000000-0000-0000-0000-0000000d0a01'::uuid, 'requested_by comes from the session');
select throws_ok($$select public.data_product_request_review('t_prod','Dup','Another long enough purpose text.',array['t-fn'],array[]::text[],'[{"class":"public","name":"P"}]'::jsonb,false)$$,
                 '23505', null, 'only one open review per product');
select throws_ok($$select public.data_product_request_review('t_other','X','A purpose that is long enough to pass.',array['t-fn'],array['no_such_flow'],'[{"class":"public","name":"P"}]'::jsonb,false)$$,
                 '22023', null, 'unknown source flow is refused');
select throws_ok($$select public.data_product_request_review('t_bad','X','A purpose that is long enough to pass.',array['t-fn'],array[]::text[],'[{"class":"galaxy","name":"P"}]'::jsonb,false)$$,
                 '23514', null, 'unknown recipient class violates the check');

-- separation of duties: the requester can neither review nor approve
select throws_ok(format($$select public.data_product_record_privacy_review(%L,'low',10,%L,pg_temp.all_criteria(),null)$$, (select id from t_ids), repeat('x', 50)),
                 '42501', null, 'requester cannot be the privacy reviewer');
select throws_ok(format($$select public.data_product_decide(%L,'approved','ok',30)$$, (select id from t_ids)), '42501', null, 'requester cannot approve their own request');

select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0b01');
-- each approval invariant, one at a time
select lives_ok(format($$select public.data_product_record_privacy_review(%L,'high',10,%L,pg_temp.all_criteria(),null)$$, (select id from t_ids), repeat('x', 50)), 'staff B records a privacy review (risk high)');
select throws_ok(format($$select public.data_product_decide(%L,'approved','ok',30)$$, (select id from t_ids)), '22023', null, 'high re-identification risk cannot be approved');
select lives_ok(format($$select public.data_product_record_privacy_review(%L,'low',4,%L,pg_temp.all_criteria(),null)$$, (select id from t_ids), repeat('x', 50)), 'review updated (k=4)');
select throws_ok(format($$select public.data_product_decide(%L,'approved','ok',30)$$, (select id from t_ids)), '22023', null, 'external release with k<5 is refused');
select lives_ok(format($$select public.data_product_record_privacy_review(%L,'low',10,%L,pg_temp.all_criteria() - 'E3',null)$$, (select id from t_ids), repeat('x', 50)), 'review updated (E3 missing)');
select throws_ok(format($$select public.data_product_decide(%L,'approved','ok',30)$$, (select id from t_ids)), '22023', null, 'a missing criterion blocks approval');
select lives_ok(format($$select public.data_product_record_privacy_review(%L,'low',10,%L,pg_temp.all_criteria(),null)$$, (select id from t_ids), repeat('x', 50)), 'review complete');
select throws_ok(format($$select public.data_product_decide(%L,'approved','ok',400)$$, (select id from t_ids)), '22023', null, 'validity over 366 days is refused');
select is((public.data_product_gate('t_prod','t-fn') ->> 'reason'), 'pending', 'still pending: gate stays closed');

select lives_ok(format($$select public.data_product_decide(%L,'approved','Reviewed against E1-E8.',90)$$, (select id from t_ids)), 'staff B approves');
select is((public.data_product_gate('t_prod','t-fn') ->> 'allowed')::boolean, true, 'approved + covered endpoint => allowed');
select is(public.data_product_gate('t_prod','other-fn') ->> 'reason', 'endpoint_not_covered', 'an endpoint the review does not list is denied');
select is((select decided_by from public.data_product_reviews where id = (select id from t_ids)), '00000000-0000-0000-0000-0000000d0b01'::uuid, 'approver comes from the session');
select ok((select valid_until from public.data_product_reviews where id = (select id from t_ids)) <= now() + interval '91 days', 'expiry honours valid_days');

-- frozen once decided
select throws_ok(format($$update public.data_product_reviews set purpose = 'Changed purpose that is long enough.' where id = %L$$, (select id from t_ids)), '22023', null, 'decided review content is frozen (only approved -> revoked is allowed)');
select throws_ok(format($$update public.data_product_reviews set purpose = 'Sneaky change while revoking it.', decision = 'revoked', decision_reason = 'sneaky' where id = %L$$, (select id from t_ids)), '42501', null, 'content cannot change even in the revoking update');
select throws_ok(format($$update public.data_product_reviews set decision = 'pending' where id = %L$$, (select id from t_ids)), '22023', null, 'approved cannot go back to pending');
select throws_ok(format($$delete from public.data_product_reviews where id = %L$$, (select id from t_ids)), '42501', null, 'reviews cannot be deleted');
select throws_ok($$update public.data_product_review_events set event = 'approved'$$, '42501', null, 'history is append-only (update)');
select throws_ok($$delete from public.data_product_review_events$$, '42501', null, 'history is append-only (delete)');

-- expiry (triggers bypassed ONLY to age the row in the test)
set local session_replication_role = replica;
update public.data_product_reviews set valid_until = now() - interval '1 day' where id = (select id from t_ids);
set local session_replication_role = origin;
select is(public.data_product_gate('t_prod','t-fn') ->> 'reason', 'expired', 'an expired approval is denied');
set local session_replication_role = replica;
update public.data_product_reviews set valid_until = now() + interval '30 days' where id = (select id from t_ids);
set local session_replication_role = origin;
select is((public.data_product_gate('t_prod','t-fn') ->> 'allowed')::boolean, true, 'allowed again after restoring validity (fixture)');

-- revocation
select throws_ok(format($$select public.data_product_revoke(%L,'x')$$, (select id from t_ids)), '23514', null, 'a revocation needs a real reason (check)');
select lives_ok(format($$select public.data_product_revoke(%L,'Recipient terms lapsed.')$$, (select id from t_ids)), 'staff revokes');
select is(public.data_product_gate('t_prod','t-fn') ->> 'reason', 'revoked', 'revoked => denied');
select throws_ok(format($$select public.data_product_revoke(%L,'Again, for good measure.')$$, (select id from t_ids)), '22023', null, 'cannot revoke twice');
select is((select array_agg(event order by id) from public.data_product_review_events where review_id = (select id from t_ids)),
          array['requested','privacy_reviewed','privacy_reviewed','privacy_reviewed','privacy_reviewed','approved','revoked'],
          'history records every step in order');

-- rejection needs a reason; personal data needs counsel
select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0a01');
create temp table t_ids2 as
  select public.data_product_request_review('t_pii','PII product','A purpose that is long enough to pass the check.',
         array['t-fn'], array[]::text[], '[{"class":"partner","name":"P"}]'::jsonb, true) as id;
select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0b01');
select lives_ok(format($$select public.data_product_record_privacy_review(%L,'low',50,%L,pg_temp.all_criteria(),null)$$, (select id from t_ids2), repeat('y', 50)), 'review recorded without counsel reference');
select throws_ok(format($$select public.data_product_decide(%L,'approved','ok',30)$$, (select id from t_ids2)), '22023', null, 'personal data without counsel_reference is refused [COUNSEL]');
select throws_ok(format($$select public.data_product_decide(%L,'rejected',null,null)$$, (select id from t_ids2)), '23514', null, 'a rejection needs a reason');
select lives_ok(format($$select public.data_product_decide(%L,'rejected','Personal data, no counsel sign-off.',null)$$, (select id from t_ids2)), 'rejected');
select is(public.data_product_gate('t_pii','t-fn') ->> 'reason', 'rejected', 'rejected => denied');
select throws_ok(format($$update public.data_product_reviews set decision = 'approved' where id = %L$$, (select id from t_ids2)), '22023', null, 'a rejected review is terminal');

-- ------------------------------------------------------------- RLS reads ----
reset role;
select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0c01');
set local role authenticated;
select is((select count(*)::int from public.data_product_reviews), 0, 'non-staff sees no reviews');
select is((select count(*)::int from public.data_product_review_events), 0, 'non-staff sees no history');
reset role;
select pg_temp.claim_as('00000000-0000-0000-0000-0000000d0a01');
set local role authenticated;
select ok((select count(*)::int from public.data_product_reviews) >= 5, 'staff can read reviews');
select throws_ok($$insert into public.data_product_reviews (product_key, product_name, purpose, recipients) values ('x_direct','X','A purpose that is long enough to pass.','[{"class":"public","name":"P"}]')$$,
                 '42501', null, 'staff cannot insert directly either (RPC only)');
reset role;

select * from finish();
rollback;
