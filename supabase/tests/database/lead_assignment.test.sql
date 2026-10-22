-- Lead assignment engine: rules, rotation, SLA, reassign, escalation, RLS, reporting (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(65);

-- ---------------------------------------------------------------- fixtures --
-- O = owner, A1..A3 = CSR agents, T = technician (not an agent, no manage rights), X = ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'csr1@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'csr2@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'csr3@acme.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'csr1@acme.test', 'Ann CSR', 'member',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_all_jobs": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'csr2@acme.test', 'Bob CSR', 'member',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_all_jobs": true}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'csr3@acme.test', 'Cy CSR', 'member',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{"can_view_all_jobs": true}'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a5', 'active', '{"can_view_all_jobs": false}');

-- handle_new_user() gives every auth user a profile with role 'owner'; team members are not owners.
update public.profiles set role = 'member'
 where id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3',
              '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a5');

update public.team_members set languages = '{Spanish}' where id = '00000000-0000-0000-0000-0000000000c4';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create or replace function pg_temp.assignee(p_lead uuid) returns uuid language sql as $$
  select assigned_to from public.leads where id = p_lead $$;

-- --------------------------------------------------------- pure SQL helpers --
select is(public.lead_extract_postal_code('12 Main St, Austin TX 78701-1234'), '78701', 'extracts a US ZIP (ZIP+4 trimmed)');
select is(public.lead_extract_postal_code('Toronto ON m5v 2t6'), 'M5V2T6', 'extracts a Canadian postal code');
select is(public.lead_extract_postal_code('call 5551234567'), null, 'a phone number is not a ZIP');
select ok(public.lead_postal_matches('M5V2T6', 'M5V'), 'FSA entry matches a full Canadian postal code');
select ok(not public.lead_postal_matches('90210', '902'), 'a partial ZIP does not match');
select ok(not public.lead_stage_is_open('won') and public.lead_stage_is_open('new'), 'won leads are closed, new leads are open');

-- ------------------------------------------------- disabled = no assignment --
insert into public.leads (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000a1', 'Before enabled');
select ok(pg_temp.assignee('00000000-0000-0000-0000-0000000000d0') is null, 'nothing is assigned while the engine is disabled');
delete from public.leads where id = '00000000-0000-0000-0000-0000000000d0';

insert into public.lead_assignment_settings (user_id, enabled, first_touch_sla_minutes, reassign_after_minutes, max_reassignments)
values ('00000000-0000-0000-0000-0000000000a1', true, 5, 15, 2);

insert into public.lead_assignment_agents (team_member_id, user_id) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1');

-- ------------------------------------------------------ default round robin --
insert into public.leads (id, user_id, name, service_interested) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Lead 1', 'Plumbing');
insert into public.leads (id, user_id, name, service_interested) values
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Lead 2', 'Plumbing');
insert into public.leads (id, user_id, name, service_interested) values
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'Lead 3', 'Plumbing');
insert into public.leads (id, user_id, name, service_interested) values
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', 'Lead 4', 'Plumbing');

select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d1'), '00000000-0000-0000-0000-0000000000c2'::uuid, 'round robin: 1st lead -> agent 1');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d2'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'round robin: 2nd lead -> agent 2');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d3'), '00000000-0000-0000-0000-0000000000c4'::uuid, 'round robin: 3rd lead -> agent 3');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d4'), '00000000-0000-0000-0000-0000000000c2'::uuid, 'round robin wraps back to agent 1');
select is((select assignment_method from public.leads where id = '00000000-0000-0000-0000-0000000000d1'), 'default_round_robin', 'method recorded');
select is((select extract(epoch from (sla_due_at - assigned_at))::int from public.leads where id = '00000000-0000-0000-0000-0000000000d1'), 300, 'SLA timer = assigned_at + 5 minutes');
select is((select count(*)::int from public.lead_assignment_events
           where lead_id = '00000000-0000-0000-0000-0000000000d1' and event_type = 'assigned'
             and to_member_id = '00000000-0000-0000-0000-0000000000c2'), 1, 'assignment is audited');

-- ------------------------------------------------------------------- rules --
insert into public.service_areas (id, user_id, name, zone_type, zip_codes) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Toronto core', 'zip', '{M5V}');

insert into public.lead_assignment_rules (id, user_id, name, priority, strategy, languages) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Spanish desk', 10, 'round_robin', '{Spanish}');
insert into public.lead_assignment_rule_agents (rule_id, team_member_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c4');

insert into public.lead_assignment_rules (id, user_id, name, priority, strategy, services) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'HVAC team', 20, 'load_balanced', '{hvac}');
insert into public.lead_assignment_rule_agents (rule_id, team_member_id) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c3');

insert into public.lead_assignment_rules (id, user_id, name, priority, strategy, postal_codes) values
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'Beverly Hills', 5, 'round_robin', '{90210}');
insert into public.lead_assignment_rule_agents (rule_id, team_member_id) values
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c2');

insert into public.lead_assignment_rules (id, user_id, name, priority, strategy, service_area_ids) values
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1', 'Toronto zone', 30, 'round_robin',
   '{00000000-0000-0000-0000-0000000000f1}');
insert into public.lead_assignment_rule_agents (rule_id, team_member_id) values
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000c3');

insert into public.leads (id, user_id, name, language) values
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a1', 'Lead ES', 'spanish');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d5'), '00000000-0000-0000-0000-0000000000c4'::uuid, 'language rule routes (case-insensitive) to the Spanish speaker');
select is((select assignment_rule_id from public.leads where id = '00000000-0000-0000-0000-0000000000d5'), '00000000-0000-0000-0000-0000000000e1'::uuid, 'winning rule is recorded');
select is((select assignment_method from public.leads where id = '00000000-0000-0000-0000-0000000000d5'), 'rule_round_robin', 'rule method recorded');

insert into public.leads (id, user_id, name, service_interested) values
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000a1', 'Lead HVAC', 'HVAC tune-up');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d6'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'service rule (substring, case-insensitive) routes to the HVAC pool');

insert into public.leads (id, user_id, name, notes) values
  ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000a1', 'Lead ZIP', 'At 12 Rodeo Dr, Beverly Hills CA 90210');
select is((select postal_code from public.leads where id = '00000000-0000-0000-0000-0000000000d7'), '90210', 'postal code is derived from the notes');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d7'), '00000000-0000-0000-0000-0000000000c2'::uuid, 'ZIP rule routes to its pool');

insert into public.leads (id, user_id, name, notes) values
  ('00000000-0000-0000-0000-0000000000d8', '00000000-0000-0000-0000-0000000000a1', 'Lead Toronto', 'Toronto ON M5V 2T6');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d8'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'service-area zone (FSA) routes to its pool');

-- A rule that matches but has no available agent falls through to the default pool.
update public.lead_assignment_agents set accepts_leads = false where team_member_id = '00000000-0000-0000-0000-0000000000c4';
insert into public.leads (id, user_id, name, language) values
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000a1', 'Lead ES 2', 'Spanish');
select isnt(pg_temp.assignee('00000000-0000-0000-0000-0000000000d9'), '00000000-0000-0000-0000-0000000000c4'::uuid, 'agent who stopped accepting leads is skipped');
select ok(pg_temp.assignee('00000000-0000-0000-0000-0000000000d9') is not null, 'rule with no available agent falls through to the default pool');
update public.lead_assignment_agents set accepts_leads = true where team_member_id = '00000000-0000-0000-0000-0000000000c4';

-- Capacity: agents 1 and 2 already hold open leads, so a cap of 1 leaves only agent 3.
update public.lead_assignment_agents set max_open_leads = 1
 where team_member_id in ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c3');
insert into public.leads (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-0000000000a1', 'Lead cap');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000da'), '00000000-0000-0000-0000-0000000000c4'::uuid, 'agents at capacity are skipped');
update public.lead_assignment_agents set max_open_leads = 25;

-- Preview RPC is read-only and uses the same engine.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select (public.lead_assignment_preview(null, null, 'Spanish', null) ->> 'member_id')::uuid), '00000000-0000-0000-0000-0000000000c4'::uuid, 'preview shows who would get a Spanish lead');
select is((select public.lead_assignment_preview(null, '90210', null, null) ->> 'rule_name'), 'Beverly Hills', 'preview names the matching rule');
select pg_temp.act_admin();

-- ------------------------------------------------- SLA, breach and reassign --
insert into public.leads (id, user_id, name, service_interested) values
  ('00000000-0000-0000-0000-0000000000db', '00000000-0000-0000-0000-0000000000a1', 'Lead SLA', 'Roofing');
select set_config('t.first', pg_temp.assignee('00000000-0000-0000-0000-0000000000db')::text, true);

update public.leads set assigned_at = now() - interval '6 minutes', sla_due_at = now() - interval '1 minute'
 where id = '00000000-0000-0000-0000-0000000000db';
select public.lead_assignment_sweep();
select ok((select sla_breached_at is not null from public.leads where id = '00000000-0000-0000-0000-0000000000db'), 'SLA breach is stamped after the first-touch window');
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000db')::text, current_setting('t.first'), 'not reassigned before the N-minute window');
select is((select count(*)::int from public.lead_assignment_events where lead_id = '00000000-0000-0000-0000-0000000000db' and event_type = 'sla_breach'), 1, 'breach is audited');

update public.leads set assigned_at = now() - interval '16 minutes' where id = '00000000-0000-0000-0000-0000000000db';
select public.lead_assignment_sweep();
select isnt(pg_temp.assignee('00000000-0000-0000-0000-0000000000db')::text, current_setting('t.first'), 'untouched lead is auto-reassigned after N minutes');
select is((select reassign_count from public.leads where id = '00000000-0000-0000-0000-0000000000db'), 1, 'reassign count increments');
select ok((select sla_breached_at is null and first_touched_at is null from public.leads where id = '00000000-0000-0000-0000-0000000000db'), 'the new assignee starts with a fresh SLA');
select is((select count(*)::int from public.lead_assignment_events
           where lead_id = '00000000-0000-0000-0000-0000000000db' and event_type = 'reassigned'
             and from_member_id::text = current_setting('t.first')), 1, 'reassignment is audited with the previous agent');

-- A human touch by the assignee stops the timer.
select set_config('t.holder_user', (select tm.user_id::text from public.team_members tm
  where tm.id = pg_temp.assignee('00000000-0000-0000-0000-0000000000db')), true);
select pg_temp.act_as(current_setting('t.holder_user')::uuid);
update public.leads set stage = 'contacted' where id = '00000000-0000-0000-0000-0000000000db';
select pg_temp.act_admin();
select ok((select first_touched_at is not null from public.leads where id = '00000000-0000-0000-0000-0000000000db'), 'assignee changing the stage counts as the first touch');
select set_config('t.holder', pg_temp.assignee('00000000-0000-0000-0000-0000000000db')::text, true);
update public.leads set assigned_at = now() - interval '40 minutes' where id = '00000000-0000-0000-0000-0000000000db';
select public.lead_assignment_sweep();
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000db')::text, current_setting('t.holder'), 'a touched lead is never reassigned');

-- A system update (e.g. marketplace auto-reply) is not a touch.
insert into public.leads (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000dc', '00000000-0000-0000-0000-0000000000a1', 'Lead system');
update public.leads set first_response_at = now() where id = '00000000-0000-0000-0000-0000000000dc';
select ok((select first_touched_at is null from public.leads where id = '00000000-0000-0000-0000-0000000000dc'), 'automated first response is not a human touch');

-- --------------------------------------------------- escalation (reused) -----
insert into public.on_call_schedules (user_id) values ('00000000-0000-0000-0000-0000000000a1');
update public.leads set reassign_count = 2, assigned_at = now() - interval '16 minutes'
 where id = '00000000-0000-0000-0000-0000000000dc';
select public.lead_assignment_sweep();
select ok((select escalated_at is not null from public.leads where id = '00000000-0000-0000-0000-0000000000dc'), 'exhausted reassignments escalate the lead');
select is((select count(*)::int from public.escalation_events where lead_id = '00000000-0000-0000-0000-0000000000dc' and status = 'active'), 1, 'an escalation_events row is created on the existing on-call schedule');
select is((select count(*)::int from public.notifications where type = 'lead_sla_breach' and user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'an account notification is raised');
select public.lead_assignment_sweep();
select is((select count(*)::int from public.escalation_events where lead_id = '00000000-0000-0000-0000-0000000000dc'), 1, 'escalation is idempotent across sweeps');

update public.escalation_events
   set status = 'acknowledged', acknowledged_by = '00000000-0000-0000-0000-0000000000c3', acknowledged_at = now()
 where lead_id = '00000000-0000-0000-0000-0000000000dc';
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000dc'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'accepting the escalation link assigns the lead to that person');
select ok((select first_touched_at is not null from public.leads where id = '00000000-0000-0000-0000-0000000000dc'), 'accepting the escalation stops the timer');
select is((select count(*)::int from public.lead_assignment_events where lead_id = '00000000-0000-0000-0000-0000000000dc' and event_type = 'escalation_accepted'), 1, 'acceptance is audited');

-- ------------------------------------------------ manual assignment rules ----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
update public.leads set assigned_to = '00000000-0000-0000-0000-0000000000c4' where id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.act_admin();
select is((select assignment_method from public.leads where id = '00000000-0000-0000-0000-0000000000d1'), 'manual', 'a manual assignment is recorded as manual');
select ok((select sla_due_at is not null and reassign_count = 0 from public.leads where id = '00000000-0000-0000-0000-0000000000d1'), 'a manual assignment also gets a fresh SLA timer');
update public.leads set assigned_at = now() - interval '20 minutes' where id = '00000000-0000-0000-0000-0000000000d1';
select public.lead_assignment_sweep();
select is(pg_temp.assignee('00000000-0000-0000-0000-0000000000d1'), '00000000-0000-0000-0000-0000000000c4'::uuid, 'manual assignments are not auto-reassigned by default');
select ok((select escalated_at is not null from public.leads where id = '00000000-0000-0000-0000-0000000000d1'), 'an untouched manual assignment escalates instead');

-- ---------------------------------------------------------------- reporting --
update public.leads set stage = 'won', quote_amount = 500 where id = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select cmp_ok((select count(*)::int from public.lead_assignment_agent_report(now() - interval '1 day', now() + interval '1 day')), '>', 0, 'report returns rows');
select is((select leads_won from public.lead_assignment_agent_report(now() - interval '1 day', now() + interval '1 day')
           where member_id = '00000000-0000-0000-0000-0000000000c3'), 1::bigint, 'report counts won leads per agent');
select is((select won_value from public.lead_assignment_agent_report(now() - interval '1 day', now() + interval '1 day')
           where member_id = '00000000-0000-0000-0000-0000000000c3'), 500::numeric, 'report sums won value per agent');
select is((select conversion_rate from public.lead_assignment_agent_report(now() - interval '1 day', now() + interval '1 day')
           where member_id = '00000000-0000-0000-0000-0000000000c3'),
          (select round(100.0 * 1 / count(*), 1) from public.leads where assigned_to = '00000000-0000-0000-0000-0000000000c3'),
          'report conversion rate = won / assigned');
select is((select leads_assigned from public.lead_assignment_agent_report(now() - interval '1 day', now() + interval '1 day')
           where member_id = '00000000-0000-0000-0000-0000000000c2'),
          (select count(*) from public.leads where assigned_to = '00000000-0000-0000-0000-0000000000c2'),
          'report assigned count matches the leads table');
select throws_ok($$ select * from public.lead_assignment_agent_report(now(), now() - interval '1 day') $$, '22023', 'invalid date range', 'report rejects an inverted range');
select pg_temp.act_admin();

-- ------------------------------------------------------ permissions and RLS --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');
select throws_ok($$ insert into public.lead_assignment_rules (name) values ('nope') $$, '42501', null, 'a technician cannot create rules');
select throws_ok($$ select public.lead_assignment_preview() $$, '42501', 'not authorized', 'a technician cannot run the preview');
select throws_ok($$ select * from public.lead_assignment_agent_report() $$, '42501', 'not authorized', 'a technician cannot read the agent report');
select cmp_ok((select count(*)::int from public.lead_assignment_rules), '>', 0, 'a team member can read the rules of their own account');
select throws_ok($$ select public.lead_assignment_sweep() $$, '42501', null, 'the sweep is not callable by clients');
select pg_temp.act_admin();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into public.lead_assignment_rules (name, priority) values ('Owner rule', 50) $$, 'the owner can create rules');
select throws_ok($$ insert into public.lead_assignment_events (user_id, lead_id, event_type)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'manual') $$, '42501', null, 'clients cannot write the audit trail');
select pg_temp.act_admin();

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.lead_assignment_events), 0, 'another account sees none of the events');
select is((select count(*)::int from public.lead_assignment_rules), 0, 'another account sees none of the rules');
select is((select count(*)::int from public.lead_assignment_agents), 0, 'another account sees none of the agents');
select throws_ok($$ insert into public.lead_assignment_agents (team_member_id, user_id)
  values ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b1') $$, '42501', null, 'an account cannot enrol another account''s team member');
select pg_temp.act_admin();

-- ------------------------------------------------------------ constraints ----
select throws_ok($$ update public.lead_assignment_settings set reassign_after_minutes = 2 where user_id = '00000000-0000-0000-0000-0000000000a1' $$,
  '23514', null, 'reassign window cannot be shorter than the SLA');

select * from finish();
rollback;
