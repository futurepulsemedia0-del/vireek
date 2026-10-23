-- Customer identity resolution (pgTAP). Run with:  supabase test db
-- Covers: name + score rules, key sync, household safety, lead linking, ambiguity,
-- auto-merge, unmerge -> never re-merged, dismissal sync, RLS and grants.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@idr.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-idr.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do update set role = excluded.role;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Household pair: same address, same (differently formatted) phone, different first names.
insert into public.customers (id, user_id, name, phone, email, address, created_at) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'John Smith', '+1 512-555-0101', 'john@smith.test', '12 Oak Street, Austin TX 78701', '2027-01-01 00:00+00');
insert into public.customers (id, user_id, name, phone, email, address, created_at) values
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'Jane Smith', '512.555.0101', 'jane@smith.test', '12 oak st austin tx 78701', '2027-01-01 00:00+00');

-- True duplicate pair: same person, same email (case variant), different phone.
insert into public.customers (id, user_id, name, phone, email, created_at) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'Robert Lee', '5125550003', 'rob@x.com', '2027-01-01 00:00+00');
insert into public.customers (id, user_id, name, phone, email, created_at) values
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1', 'Robert Lee', '5125550004', 'ROB@x.com ', '2027-01-02 00:00+00');

insert into public.customers (id, user_id, name, phone) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Other Tenant', '5125559999');

-- ------------------------------------------------------- pure helpers (1-8) --
select is(public.identity_name_similarity('John Smith', 'Smith, John'), 1.00, 'name: word order does not matter');
select is(public.identity_name_similarity('J Smith', 'John Smith'), 1.00, 'name: initial matches first name');
select is(public.identity_name_similarity('John Smith', 'Mary Jones'), 0.00, 'name: different people score 0');
select is(public.identity_name_similarity('', 'John'), null::numeric, 'name: blank is unknown, not a mismatch');
select ok(public.identity_name_suffix_conflict('John Smith', 'John Smith Jr'), 'name: Jr vs none is a conflict');
select is((public.identity_combine_signals(true, true, false, null) ->> 'score')::int, 98, 'score: phone + email = 98');
select is((public.identity_combine_signals(true, false, false, null) ->> 'score')::int, 78, 'score: phone alone = 78');
select is((public.identity_combine_signals(true, false, false, 0.0) ->> 'score')::int, 74, 'score: phone + clearly different name is capped at 74');

-- ------------------------------------------------- sync, queue, household (9-11) --
select is((select count(*)::int from public.customer_identity_keys
           where customer_id = '00000000-0000-0000-0000-000000000001'), 3, 'keys: phone + email + address registered on insert');
select is((select band from public.identity_match_candidates
           where status = 'pending' and a_id = '00000000-0000-0000-0000-000000000001'
             and b_id = '00000000-0000-0000-0000-000000000002'), 'review',
          'queue: shared phone + address with different names is review, never auto-merge');
select is((select count(*)::int from public.customer_household_members m
           join public.customer_households h on h.id = m.household_id
           where m.customer_id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')
             and m.status = 'suggested' and h.user_id = '00000000-0000-0000-0000-0000000000a1'), 2,
          'household: both people are suggested members of one household');

-- -------------------------------------------------------------- lookup (12-14) --
select is(public.identity_lookup('00000000-0000-0000-0000-0000000000a1', '(512) 555-0101', null, null, null) ->> 'band',
          'medium', 'lookup: a shared phone alone is medium confidence');
select is(public.identity_lookup('00000000-0000-0000-0000-0000000000a1', '5125550101', 'JOHN@smith.test', null, null) #>> '{best,customer_id}',
          '00000000-0000-0000-0000-000000000001', 'lookup: phone + email picks the right person');
select is(public.identity_ingest('00000000-0000-0000-0000-0000000000a1', '+15125550101', null, null, null, 'system', null) ->> 'status',
          'ambiguous', 'ingest: a phone shared by two people is not linked blindly');

-- ------------------------------------------------- lead trigger + safety (15-17) --
insert into public.leads (id, user_id, name, phone, email) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'John Smith', '(512) 555-0101', 'john@smith.test');

select is((select customer_id from public.leads where id = '00000000-0000-0000-0000-0000000000e1'),
          '00000000-0000-0000-0000-000000000001'::uuid, 'lead trigger: linked to the right customer');
select is((select count(*)::int from public.customers
           where user_id = '00000000-0000-0000-0000-0000000000a1' and merged_into_id is not null), 0,
          'safety: household pair was NOT merged');
select is((select count(*)::int from public.customers
           where id = '00000000-0000-0000-0000-000000000002' and merged_into_id is null and deleted_at is null), 1,
          'safety: Jane Smith is still her own record');

-- ----------------------------------------------------------- auto-merge (18-21) --
select is(public.identity_ingest('00000000-0000-0000-0000-0000000000a1', '5125550004', 'rob@x.com', null, 'Robert Lee', 'system', null) ->> 'status',
          'linked', 'ingest: strong bridging event is linked');
select is((select count(*)::int from public.customers
           where user_id = '00000000-0000-0000-0000-0000000000a1' and name = 'Robert Lee' and merged_into_id is null), 1,
          'auto-merge: the two Robert Lee records became one');
select is((select merged_by_email from public.record_merges
           where user_id = '00000000-0000-0000-0000-0000000000a1' and status = 'merged'), 'system:identity-auto-merge',
          'auto-merge: recorded as a system merge in the ledger (undoable)');
select is((select status from public.identity_match_candidates
           where a_id = '00000000-0000-0000-0000-000000000003' and b_id = '00000000-0000-0000-0000-000000000004'
           order by updated_at desc limit 1), 'auto_merged', 'auto-merge: candidate marked auto_merged');

-- ------------------------------------------------ unmerge -> never again (22-24) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.unmerge_records((select id from public.record_merges where status = 'merged' limit 1))$$,
                'unmerge: owner can undo an automatic merge');
reset role;
select is((select count(*)::int from public.customers
           where user_id = '00000000-0000-0000-0000-0000000000a1' and name = 'Robert Lee' and merged_into_id is null), 2,
          'unmerge: both records are back');
select is((select count(*)::int from public.duplicate_dismissals
           where a_id = '00000000-0000-0000-0000-000000000003' and b_id = '00000000-0000-0000-0000-000000000004'), 1,
          'unmerge: the pair is remembered as "different people"');

-- (25) same event again must not re-merge
select is(jsonb_array_length(public.identity_ingest('00000000-0000-0000-0000-0000000000a1', '5125550004', 'rob@x.com', null, 'Robert Lee', 'system', null) -> 'merged'),
          0, 'unmerge: the same evidence never auto-merges that pair again');

-- ------------------------------------------------- dismissal + profile RPC (26-27) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select public.identity_dismiss_candidate((select id from public.identity_match_candidates
                   where status = 'pending' and a_id = '00000000-0000-0000-0000-000000000001'
                     and b_id = '00000000-0000-0000-0000-000000000002'))$$,
                'queue: owner can dismiss a candidate');
select cmp_ok(jsonb_array_length(public.customer_identity_profile('00000000-0000-0000-0000-000000000001') -> 'keys'), '>=', 3,
              'profile RPC: returns the customer''s identifiers');
reset role;

-- ------------------------------------------------------ RLS + grants (28-29) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.customer_identity_keys
           where customer_id <> '00000000-0000-0000-0000-0000000000f1'), 0, 'RLS: another account sees none of these identity keys');
select throws_ok($$select public.identity_lookup('00000000-0000-0000-0000-0000000000a1', '5125550101', null, null, null)$$,
                 '42501', null, 'grants: browser users cannot call the service-only lookup');
reset role;

select * from finish();
rollback;
