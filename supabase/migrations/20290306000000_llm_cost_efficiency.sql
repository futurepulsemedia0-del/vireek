-- LLM cost efficiency: response cache (deterministic prompts), batch queue (non-realtime jobs),
-- and cache / batch accounting columns on ai_usage_logs.
--
-- Idempotent and additive: safe to re-run; no existing column, policy or row is changed.
-- Access model: the cache and the batch queue are written and read ONLY by edge functions with the
-- service role. RLS is enabled with NO policy for anon/authenticated, and table privileges are revoked,
-- so a tenant can never read another tenant's cached answers or queued prompts through PostgREST.
--
-- Rollback (manual, after turning AI_RESPONSE_CACHE / AI_BATCH_MODE off):
--   drop function if exists public.ai_response_cache_get(uuid, text);
--   drop function if exists public.ai_response_cache_sweep(integer);
--   drop function if exists public.ai_batch_claim_pending(integer);
--   drop table if exists public.ai_batch_jobs;  drop table if exists public.ai_response_cache;
--   alter table public.ai_usage_logs drop column cache_read_tokens, drop column cache_write_tokens,
--     drop column cache_hit, drop column batched, drop column saved_usd;

-- ---------------------------------------------------------------------------------------------
-- 1. Usage-log accounting
-- ---------------------------------------------------------------------------------------------
alter table public.ai_usage_logs add column if not exists cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0);
alter table public.ai_usage_logs add column if not exists cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0);
alter table public.ai_usage_logs add column if not exists cache_hit boolean not null default false;
alter table public.ai_usage_logs add column if not exists batched boolean not null default false;
alter table public.ai_usage_logs add column if not exists saved_usd numeric(12, 6) not null default 0 check (saved_usd >= 0);

-- ---------------------------------------------------------------------------------------------
-- 2. Response cache
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ai_response_cache (
  account_id uuid not null references auth.users(id) on delete cascade,
  cache_key text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  task text not null,
  response_text text not null check (length(response_text) between 1 and 64000),
  provider text not null,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  hit_count integer not null default 0 check (hit_count >= 0),
  created_at timestamptz not null default now(),
  last_hit_at timestamptz,
  expires_at timestamptz not null,
  primary key (account_id, cache_key)
);

create index if not exists ai_response_cache_expires_idx on public.ai_response_cache (expires_at);

alter table public.ai_response_cache enable row level security;
revoke all on public.ai_response_cache from anon, authenticated;

-- Atomic read + hit counter in one round trip. Expired rows are invisible even before the sweep runs.
create or replace function public.ai_response_cache_get(p_account uuid, p_key text)
returns table (response_text text, provider text, model text, input_tokens integer, output_tokens integer)
language sql
security definer
set search_path = public
as $$
  update public.ai_response_cache c
     set hit_count = c.hit_count + 1, last_hit_at = now()
   where c.account_id = p_account and c.cache_key = p_key and c.expires_at > now()
  returning c.response_text, c.provider, c.model, c.input_tokens, c.output_tokens;
$$;

create or replace function public.ai_response_cache_sweep(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  with doomed as (
    select account_id, cache_key from public.ai_response_cache
     where expires_at < now() - interval '1 hour'
     limit greatest(1, least(p_limit, 50000))
  )
  delete from public.ai_response_cache c using doomed d
   where c.account_id = d.account_id and c.cache_key = d.cache_key;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.ai_response_cache_get(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_response_cache_sweep(integer) from public, anon, authenticated;
grant execute on function public.ai_response_cache_get(uuid, text) to service_role;
grant execute on function public.ai_response_cache_sweep(integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Batch queue
-- ---------------------------------------------------------------------------------------------
create table if not exists public.ai_batch_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users(id) on delete cascade,
  task text not null,
  source text,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'submitting', 'submitted', 'succeeded', 'failed', 'canceled')),
  provider text not null default 'anthropic',
  provider_batch_id text,
  attempts integer not null default 0 check (attempts >= 0),
  result_text text,
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  cost_usd numeric(12, 6),
  saved_usd numeric(12, 6),
  error_code text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  -- Enqueueing the same logical job twice (a retried cron, a double click) returns the existing row.
  unique (account_id, idempotency_key)
);

create index if not exists ai_batch_jobs_status_idx on public.ai_batch_jobs (status, created_at);
create index if not exists ai_batch_jobs_batch_idx on public.ai_batch_jobs (provider_batch_id) where provider_batch_id is not null;

alter table public.ai_batch_jobs enable row level security;
revoke all on public.ai_batch_jobs from anon, authenticated;

-- Claims up to p_limit jobs for submission. SKIP LOCKED makes concurrent runners safe; rows stuck in
-- 'submitting' for over 15 minutes (a crashed runner) are re-claimed, bounded by attempts.
create or replace function public.ai_batch_claim_pending(p_limit integer default 200)
returns setof public.ai_batch_jobs
language sql
security definer
set search_path = public
as $$
  with picked as (
    select id from public.ai_batch_jobs
     where (status = 'pending' or (status = 'submitting' and claimed_at < now() - interval '15 minutes'))
       and attempts < 3
     order by created_at
     limit greatest(1, least(p_limit, 1000))
     for update skip locked
  )
  update public.ai_batch_jobs j
     set status = 'submitting', claimed_at = now(), attempts = j.attempts + 1
    from picked
   where j.id = picked.id
  returning j.*;
$$;

revoke all on function public.ai_batch_claim_pending(integer) from public, anon, authenticated;
grant execute on function public.ai_batch_claim_pending(integer) to service_role;
