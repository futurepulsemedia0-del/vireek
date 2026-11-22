-- Workflow tokens, durable compensation, idempotency constraints (pgTAP). Run with:  supabase test db
-- Migration under test: 20290307000100_workflow_tokens_compensation.sql
-- STATUS: written without access to Postgres, NOT RUN. The fixture inserts a minimal compiled_workflows + runs row;
-- adjust the column list if 20270210000000 has since gained NOT NULL columns without defaults.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000d0f01', 'w1@wf.test'), ('00000000-0000-0000-0000-0000000d0f02', 'w2@wf.test');
insert into public.compiled_workflows (id, user_id, name, summary, trigger_event, graph, status)
values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000d0f01', 'wf', 's', 'call.emergency', '{}'::jsonb, 'active');
insert into public.compiled_workflow_runs (id, workflow_id, user_id, status, current_node, state)
values ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000d0f01', 'active', 'p', '{}'::jsonb);

-- ----------------------------------------------------------- privileges / RLS
select ok((select relrowsecurity from pg_class where oid = 'public.compiled_workflow_tokens'::regclass), 'tokens: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.compiled_workflow_compensations'::regclass), 'compensations: RLS on');
select ok(not has_table_privilege('authenticated', 'public.compiled_workflow_tokens', 'select'), 'authenticated cannot read tokens');
select ok(not has_function_privilege('authenticated', 'public.cwf_token_claim(uuid,uuid,text,integer,integer)', 'execute'), 'authenticated cannot claim tokens');
select ok(not has_function_privilege('anon', 'public.cwf_comp_plan(uuid,uuid,jsonb)', 'execute'), 'anon cannot plan compensation');
select ok(has_function_privilege('service_role', 'public.cwf_comp_claim(uuid,uuid,integer)', 'execute'), 'service_role can claim compensation');

-- ----------------------------------------------------------- idempotent spawn (UNIQUE run_id, scope_key)
select is(public.cwf_token_spawn('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 'branch', '[{"ordinal":0,"cursor":"t0"},{"ordinal":1,"cursor":"t1"},{"ordinal":2,"cursor":"t2"}]'::jsonb), 3, 'first spawn creates 3 tokens');
select is(public.cwf_token_spawn('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 'branch', '[{"ordinal":0,"cursor":"t0"},{"ordinal":1,"cursor":"t1"},{"ordinal":2,"cursor":"t2"}]'::jsonb), 0, 'respawn creates nothing');
select throws_ok($$insert into public.compiled_workflow_tokens (run_id, user_id, parent_node, kind, ordinal, scope_key, cursor) values ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 'branch', 0, 'p:b0', 'x')$$, '23505', null, 'UNIQUE (run_id, scope_key) rejects a duplicate');
select throws_ok($$insert into public.compiled_workflow_tokens (run_id, user_id, parent_node, kind, ordinal, scope_key, cursor) values ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 'branch', 5, 'p:b9', 'x')$$, '23514', null, 'scope_key must match parent/kind/ordinal');
select throws_ok($$select public.cwf_token_spawn('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f02', 'p', 'branch', '[{"ordinal":0,"cursor":"t0"}]'::jsonb)$$, 'P0001', 'run not found', 'another tenant cannot spawn tokens into this run');

-- ----------------------------------------------------------- claim = concurrency cap, lease, unknown-outcome rule
select is((select count(*)::int from public.cwf_token_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 2, 90)), 2, 'claim honours the limit');
select is((select count(*)::int from public.cwf_token_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 2, 90)), 0, 'valid leases count against the limit (cap holds across workers)');
select is((select count(*)::int from public.cwf_token_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f02', 'p', 5, 90)), 0, 'another tenant claims nothing');
select is(public.cwf_token_save('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p:b0', 'succeeded', 1, null, null, '{"outputs":{},"done":[]}'::jsonb, null), true, 'leased token can be saved');
select is(public.cwf_token_save('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p:b0', 'failed', 2, null, null, null, 'late'), false, 'a terminal token never changes again (I3)');
select is(public.cwf_token_save('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p:b2', 'succeeded', 1, null, null, null, null), false, 'an unleased token cannot be saved');

update public.compiled_workflow_tokens set inflight_node = 't1', lease_until = now() - interval '1 minute' where scope_key = 'p:b1';
select is((select count(*)::int from public.cwf_token_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p', 5, 90)), 1, 'only the untouched token (b2) is re-claimed');
select is((select status from public.compiled_workflow_tokens where scope_key = 'p:b1'), 'failed', 'mid-node + expired lease => failed, never re-run');
select is(public.cwf_token_cancel('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'p'), 0, 'nothing open and unleased to cancel');

-- ----------------------------------------------------------- compensation plan / claim
select is(public.cwf_comp_plan('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', '[{"node_id":"a","compensator":"undo_a","seq":1,"manual":false},{"node_id":"b","compensator":"undo_b","seq":2,"manual":false},{"node_id":"d","compensator":"undo_d","seq":4,"manual":true}]'::jsonb), 3, 'plan inserts 3 rows');
select is(public.cwf_comp_plan('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', '[{"node_id":"a","compensator":"undo_a","seq":1,"manual":false}]'::jsonb), 0, 'replanning is a no-op (UNIQUE run_id,node_id)');
select is((select compensator from public.cwf_comp_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 90)), 'undo_b', 'highest seq is undone first (reverse order)');
select is((select count(*)::int from public.cwf_comp_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 90)), 0, 'strictly one undo at a time');
update public.compiled_workflow_compensations set lease_until = now() - interval '1 minute' where node_id = 'b';
select is((select compensator from public.cwf_comp_claim('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 90)), 'undo_a', 'crashed undo is failed and the next step proceeds');
select is((select status from public.compiled_workflow_compensations where node_id = 'b'), 'failed', 'interrupted undo is failed, not repeated');
select is((select status from public.compiled_workflow_compensations where node_id = 'd'), 'manual', 'unknown-outcome step stays manual');

-- ----------------------------------------------------------- run status + claim_compiled_runs
select lives_ok($$update public.compiled_workflow_runs set status = 'compensating', next_wake_at = now() - interval '1 second', locked_until = null where id = '00000000-0000-0000-0000-00000000bb01'$$, "'compensating' is an allowed run status");
select is((select count(*)::int from public.claim_compiled_runs(10, 120) where id = '00000000-0000-0000-0000-00000000bb01'), 1, 'compensating runs are leased by the executor');
select is((select count(*)::int from public.claim_compiled_runs(10, 120) where id = '00000000-0000-0000-0000-00000000bb01'), 0, 'a leased run is not handed out twice');

-- ----------------------------------------------------------- step key must belong to its run
select throws_ok($$insert into public.compiled_workflow_step_keys (key, run_id, user_id, node_id, purpose) values ('00000000-0000-0000-0000-00000000cc99:n:exec:-:-', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'n', 'exec')$$, '23514', null, 'a step key must start with its own run id');
select throws_ok($$insert into public.compiled_workflow_step_keys (key, run_id, user_id, node_id, purpose) values ('00000000-0000-0000-0000-00000000bb01:n:exec:-:-', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'n', 'exec'), ('00000000-0000-0000-0000-00000000bb01:n:exec:-:-', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000d0f01', 'n', 'exec')$$, '23505', null, 'the step key is UNIQUE (primary key): a side effect cannot be claimed twice');

select * from finish();
rollback;
