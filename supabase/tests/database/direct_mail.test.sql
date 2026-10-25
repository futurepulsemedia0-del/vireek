-- Direct mail channel: authorization, de-duplication, scan resolver, attribution report, provider events (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- ---------------------------------------------------------------- fixtures --
-- a1 owner, a2 admin (manager), a3 technician (no billing), b1 owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@dm.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@dm.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@dm.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-dm.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@dm.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@dm.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');

insert into public.landing_pages (id, user_id, slug, title, headline, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'dm-test-page', 'DM test', 'Beat the heat', 'published');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------------- settings --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(
  $$select public.direct_mail_settings_save('Acme HVAC', '1 Main St', '', 'Austin', 'tx', '78701', '00000000-0000-0000-0000-0000000000d1')$$,
  'owner can save the return address');
select is(public.direct_mail_settings_get() -> 'return_address' ->> 'state', 'TX', 'state is normalized to upper case');
select ok(not jsonb_exists(public.direct_mail_settings_get(), 'encrypted_api_key')
          and not jsonb_exists(public.direct_mail_settings_get(), 'encrypted_webhook_secret'),
  'settings_get never exposes ciphertext');
select throws_ok(
  $$select public.direct_mail_settings_save('Acme', '1 Main', '', 'Austin', 'Texas', '78701', null)$$,
  '22023', 'return_address_invalid', 'a bad state is rejected');

-- ------------------------------------------------------------------ campaigns --
select set_config('t.camp', (public.direct_mail_campaign_save(
  null, 'Spring tune-up', '00000000-0000-0000-0000-0000000000d1', '6x9', 'usps_standard',
  'Beat the heat', '$79 tune-up', 'Scan to book', '', '#0F62FE', 85, 100000)).id::text, true);
select ok(current_setting('t.camp')::uuid is not null, 'owner can create a campaign');

select set_config('t.res', public.direct_mail_add_pieces(current_setting('t.camp')::uuid, jsonb_build_array(
  jsonb_build_object('tracking_code', 'AAAAAAAA1', 'name', 'Ana Silva', 'line1', '12 Oak St', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '78701'),
  jsonb_build_object('tracking_code', 'BBBBBBBB2', 'name', 'Bob Jones', 'line1', '5 Elm Ave', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '78702'),
  jsonb_build_object('tracking_code', 'CCCCCCCC3', 'name', 'Ana Again', 'line1', '12 OAK st.', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '78701'),
  jsonb_build_object('tracking_code', 'DDDDDDDD4', 'name', 'Bad Zip', 'line1', '9 Bad Rd', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '7870')
))::text, true);
select is(jsonb_array_length(current_setting('t.res')::jsonb -> 'inserted_codes'), 2, 'two valid unique recipients are inserted');
select is((current_setting('t.res')::jsonb ->> 'invalid')::int, 1, 'the bad ZIP is counted as invalid');
select is((current_setting('t.res')::jsonb ->> 'duplicates')::int, 1, 'a repeated address inside the batch is a duplicate');
select is((select count(*)::int from public.direct_mail_pieces), 2, 'the owner sees both pieces through RLS');

select is((public.direct_mail_add_pieces(current_setting('t.camp')::uuid, jsonb_build_array(
  jsonb_build_object('tracking_code', 'EEEEEEEE5', 'name', 'Ana', 'line1', '12 Oak Street', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '78701')
)) ->> 'inserted_codes'), '[]', 'an address already in the campaign is skipped');

-- do-not-mail
select set_config('t.pieceB', (select id::text from public.direct_mail_pieces where tracking_code = 'BBBBBBBB2'), true);
select lives_ok(format($f$select public.direct_mail_suppress_piece(%L::uuid)$f$, current_setting('t.pieceB')), 'owner can suppress a queued piece');
select is((select status from public.direct_mail_pieces where tracking_code = 'BBBBBBBB2'), 'cancelled', 'a suppressed queued piece is cancelled');
select is(((public.direct_mail_add_pieces(current_setting('t.camp')::uuid, jsonb_build_array(
  jsonb_build_object('tracking_code', 'FFFFFFFF6', 'name', 'Bob', 'line1', '5 Elm Avenue', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '78702')
))) ->> 'suppressed')::int, 1, 'a suppressed address is never added again');

-- ------------------------------------------------------------- authorization --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select public.direct_mail_settings_get()$$, '42501', 'not_authorized', 'a technician without billing access is refused');
select is((select count(*)::int from public.direct_mail_campaigns), 0, 'a technician sees no campaigns');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.direct_mail_campaigns), 1, 'an admin manages the same account');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.direct_mail_pieces), 0, 'another account sees nothing');
select throws_ok(
  format($f$select public.direct_mail_campaign_save(%L::uuid, 'x', null, '6x9', 'usps_standard', 'h', 'o', 'c', '', '#0F62FE', 0, null)$f$, current_setting('t.camp')),
  'P0002', 'campaign_not_found', 'another account cannot edit this campaign');

select set_config('role', 'anon', true);
select throws_ok($$select public.direct_mail_settings_get()$$, '42501', null, 'anon cannot call manager RPCs');

-- ------------------------------------------------------------ scan resolver --
reset role;
update public.direct_mail_pieces set status = 'submitted', provider_id = 'psc_test_1', cost_cents = 85, cost_estimated = false,
  submitted_at = now() where tracking_code = 'AAAAAAAA1';
select set_config('role', 'anon', true);
select is(public.direct_mail_resolve_scan('aaaaaaaa1', 'visitor-aaaaaaaa') ->> 'landing_slug', 'dm-test-page', 'the scan resolves to the landing page (case-insensitive)');
select is(public.direct_mail_resolve_scan('AAAAAAAA1', 'visitor-aaaaaaaa') ->> 'code', 'AAAAAAAA1', 'a repeated scan still resolves');
select is(public.direct_mail_resolve_scan('ZZZZZZZZ9', 'visitor-aaaaaaaa'), null::jsonb, 'an unknown code resolves to nothing');
select is(public.direct_mail_resolve_scan('GARBAGE', null), null::jsonb, 'a malformed code resolves to nothing');
reset role;
select is((select scan_count from public.direct_mail_pieces where tracking_code = 'AAAAAAAA1'), 1, 'one visitor is counted once per 30 minutes');

-- ----------------------------------------------------------------- report --
insert into public.leads (id, user_id, name, phone) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Ana Silva', '+1 512 555 0100'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'Someone Else', '+1 512 555 0111');
insert into public.jobs (id, user_id, lead_id, customer_name, job_status, invoice_amount) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Ana Silva', 'completed', 500);
insert into public.landing_page_events (user_id, landing_page_id, visitor_id, event_type, utm_source, utm_medium, utm_campaign, utm_content, lead_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'visitor-aaaaaaaa', 'view', 'direct_mail', 'postcard', 'dm-x', 'aaaaaaaa1', null),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'visitor-aaaaaaaa', 'lead', 'direct_mail', 'postcard', 'dm-x', 'aaaaaaaa1', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'visitor-bbbbbbbb', 'lead', 'google', 'cpc', 'dm-x', 'aaaaaaaa1', '00000000-0000-0000-0000-0000000000f2');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.direct_mail_report(30) -> 0 ->> 'leads')::int, 1, 'only direct_mail/postcard events count (a spoofed google source is ignored)');
select is((public.direct_mail_report(30) -> 0 ->> 'booked_jobs')::int, 1, 'the lead''s job is the booked job');
select is((public.direct_mail_report(30) -> 0 ->> 'revenue')::numeric, 500::numeric, 'completed job revenue is attributed');
select is((public.direct_mail_report(30) -> 0 ->> 'cost_cents')::int, 85, 'cost counts mailed pieces only');
select is((public.direct_mail_report(30) -> 0 ->> 'scanned_pieces')::int, 1, 'scanned pieces are counted');

select is(public.direct_mail_record_response('aaaa-aaaa-1', 'call', 'Called from the card') ->> 'recipient_name', 'Ana Silva', 'a phone response is logged by the printed code');
select throws_ok($$select public.direct_mail_record_response('ZZZZZZZZ9', 'call')$$, 'P0002', 'code_not_found', 'an unknown code cannot be logged');
select is((public.direct_mail_report(30) -> 0 ->> 'responders')::int, 1, 'the same mailer is one responder even with several touches');

-- -------------------------------------------------------- provider events --
reset role;
select is(public.direct_mail_apply_provider_event('00000000-0000-0000-0000-0000000000a1', 'psc_test_1', 'evt_1', 'postcard.in_transit', 'in_transit', now()), true, 'a new provider event is applied');
select is(public.direct_mail_apply_provider_event('00000000-0000-0000-0000-0000000000a1', 'psc_test_1', 'evt_1', 'postcard.in_transit', 'in_transit', now()), false, 'a replayed event id is ignored');
select is(public.direct_mail_apply_provider_event('00000000-0000-0000-0000-0000000000a1', 'psc_test_1', 'evt_2', 'postcard.delivered', 'delivered', now()), true, 'delivery is applied');
select is(public.direct_mail_apply_provider_event('00000000-0000-0000-0000-0000000000a1', 'psc_test_1', 'evt_3', 'postcard.in_transit', 'in_transit', now()), true, 'a late event is recorded');
select is((select status from public.direct_mail_pieces where tracking_code = 'AAAAAAAA1'), 'delivered', 'status never moves backwards');
select is(public.direct_mail_apply_provider_event('00000000-0000-0000-0000-0000000000a1', 'psc_unknown', 'evt_9', 'postcard.delivered', 'delivered', now()), false, 'an unknown provider id is ignored');

-- -------------------------------------------------------- claiming + locks --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(format($f$select public.direct_mail_add_pieces(%L::uuid, jsonb_build_array(
  jsonb_build_object('tracking_code', 'GGGGGGGG7', 'name', 'Cara', 'line1', '9 Pine St', 'line2', '', 'city', 'Austin', 'state', 'TX', 'zip', '78703')))$f$,
  current_setting('t.camp')), 'a queued piece is added');
reset role;
select is((select count(*)::int from public.direct_mail_claim_pieces(current_setting('t.camp')::uuid, 10)), 1, 'a queued piece is claimed');
select is((select count(*)::int from public.direct_mail_claim_pieces(current_setting('t.camp')::uuid, 10)), 0, 'a claimed piece cannot be claimed twice');

update public.direct_mail_campaigns set status = 'sending' where id = current_setting('t.camp')::uuid;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok(format($f$select public.direct_mail_add_pieces(%L::uuid, '[]'::jsonb)$f$, current_setting('t.camp')), '55000', 'campaign_locked', 'a sending campaign is locked');
select throws_ok(format($f$select public.direct_mail_campaign_delete(%L::uuid)$f$, current_setting('t.camp')), '55000', 'campaign_has_mailed_pieces', 'a campaign with mailed pieces cannot be deleted');

select * from finish();
rollback;
