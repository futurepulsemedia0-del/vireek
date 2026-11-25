-- Causal Dispatch Network pooling (pgTAP): tenant isolation, consent gate, k-anonymity minimums, privilege lockdown.
-- Migration under test: 20290312000000_causal_dispatch_network.sql   Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000ca001', 'p1@cdn.test'), ('00000000-0000-0000-0000-0000000ca002', 'p2@cdn.test'),
  ('00000000-0000-0000-0000-0000000ca003', 'p3@cdn.test'), ('00000000-0000-0000-0000-0000000ca004', 'p4@cdn.test'),
  ('00000000-0000-0000-0000-0000000ca005', 'p5@cdn.test'), ('00000000-0000-0000-0000-0000000ca006', 'p6@cdn.test');

create or replace function pg_temp.visible(p_sub uuid) returns bigint language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.causal_dispatch_tenant_priors;
  reset role;
  return n;
end $f$;

select ok((select relrowsecurity from pg_class where oid = 'public.causal_dispatch_tenant_priors'::regclass), 'tenant priors: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.causal_dispatch_job_type_priors'::regclass), 'pooled priors: RLS on');
select is((select count(*)::int from pg_policies where tablename = 'causal_dispatch_job_type_priors'), 0, 'pooled priors: no client policy');
select ok(not has_table_privilege('authenticated', 'public.causal_dispatch_job_type_priors', 'select'), 'pooled priors: clients cannot read');
select ok(not has_function_privilege('authenticated', 'public.refresh_causal_dispatch_priors()', 'execute'), 'refresh: clients cannot run');
select ok(has_function_privilege('service_role', 'public.refresh_causal_dispatch_priors()', 'execute'), 'refresh: service role can run');

-- Tenant isolation: each owner sees only its own row.
insert into public.causal_dispatch_tenant_priors (user_id, job_type, n_rows, n_technicians, tau2, baseline) values
  ('00000000-0000-0000-0000-0000000ca001', 'hvac', 100, 5, 0.001, 0.80),
  ('00000000-0000-0000-0000-0000000ca002', 'hvac', 100, 5, 0.002, 0.82),
  ('00000000-0000-0000-0000-0000000ca003', 'hvac', 100, 5, 0.003, 0.78),
  ('00000000-0000-0000-0000-0000000ca004', 'hvac', 100, 5, 0.004, 0.80),
  ('00000000-0000-0000-0000-0000000ca005', 'hvac', 105, 5, 0.005, 0.80),
  ('00000000-0000-0000-0000-0000000ca006', 'hvac',  10, 5, 0.100, 0.10);
select is(pg_temp.visible('00000000-0000-0000-0000-0000000ca001'), 1::bigint, 'tenant 1 sees exactly its own row (no cross-tenant read)');
select is(pg_temp.visible('00000000-0000-0000-0000-0000000ca006'), 1::bigint, 'tenant 6 sees exactly its own row');

-- Consent gate: the flow is unmapped (fail-closed) => nothing pooled even with 6 tenants of data.
select is(public.refresh_causal_dispatch_priors(), 0, 'unmapped flow: nothing pooled');
update public.cross_tenant_flows set sde_domain = 'outcomes' where flow_key = 'causal_cohorts';
select is(public.refresh_causal_dispatch_priors(), 0, 'mapped but no consents: nothing pooled');

-- 4 consenting tenants (< 5): suppressed. 5th consents: published. Tenant 6 has consent but is too thin (10 rows).
insert into public.sde_consents (user_id, domain, status, terms_version, granted_at)
select u, 'outcomes', 'granted', 'test', now() from (values
  ('00000000-0000-0000-0000-0000000ca001'::uuid), ('00000000-0000-0000-0000-0000000ca002'), ('00000000-0000-0000-0000-0000000ca003'),
  ('00000000-0000-0000-0000-0000000ca004'), ('00000000-0000-0000-0000-0000000ca006')) v(u);
select is(public.refresh_causal_dispatch_priors(), 0, '4 usable tenants (thin tenant excluded): suppressed below k=5');
insert into public.sde_consents (user_id, domain, status, terms_version, granted_at)
values ('00000000-0000-0000-0000-0000000ca005', 'outcomes', 'granted', 'test', now());
select is(public.refresh_causal_dispatch_priors(), 1, '5 usable tenants: one job type published');
select is((select n_tenants from public.causal_dispatch_job_type_priors where job_type = 'hvac'), 5, 'n_tenants counts only usable consenting tenants');
select is((select n_rows from public.causal_dispatch_job_type_priors where job_type = 'hvac'), 500, 'row count floored to a multiple of 10 (505 -> 500)');
select is((select round(tau2, 4) from public.causal_dispatch_job_type_priors where job_type = 'hvac'), 0.0030, 'equal-weight pooled tau2');
select is((select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'causal_dispatch_job_type_priors' and column_name ~ 'user|tenant_id|account'), 0, 'pooled table has no tenant identifier column');

-- Revocation takes effect on the very next build and the stale pooled row is removed.
update public.sde_consents set status = 'revoked', revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000ca005' and domain = 'outcomes';
select is(public.refresh_causal_dispatch_priors(), 0, 'after revocation: below k=5 again');
select is((select count(*)::int from public.causal_dispatch_job_type_priors), 0, 'stale pooled row deleted');

select * from finish();
rollback;
