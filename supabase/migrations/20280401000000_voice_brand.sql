-- Voice & Sound Identity: per-business script overrides + per-call turn latency.
-- Both tables are tenant-scoped (user_id = account owner) with RLS.

create table if not exists public.voice_script_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template_id text not null check (template_id ~ '^[a-z][a-z0-9_]{2,40}$'),
  body text not null check (char_length(btrim(body)) between 1 and 400),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, template_id)
);

alter table public.voice_script_overrides enable row level security;

drop policy if exists "voice_script_overrides_select" on public.voice_script_overrides;
create policy "voice_script_overrides_select"
  on public.voice_script_overrides for select
  using (user_id = public.get_account_owner_id());

drop policy if exists "voice_script_overrides_write" on public.voice_script_overrides;
create policy "voice_script_overrides_write"
  on public.voice_script_overrides for all
  using (
    user_id = public.get_account_owner_id()
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
  )
  with check (
    user_id = public.get_account_owner_id()
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
  );

-- Written ONLY by vapi-webhook (service role). Members can read their own account's rows.
create table if not exists public.voice_call_latency (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vapi_call_id text not null check (char_length(vapi_call_id) between 1 and 128),
  turn_count integer not null check (turn_count >= 0),
  p50_ms integer,
  p95_ms integer,
  max_ms integer,
  within_budget boolean not null,
  created_at timestamptz not null default now(),
  unique (user_id, vapi_call_id)
);

create index if not exists voice_call_latency_user_created_idx
  on public.voice_call_latency (user_id, created_at desc);

alter table public.voice_call_latency enable row level security;

drop policy if exists "voice_call_latency_select" on public.voice_call_latency;
create policy "voice_call_latency_select"
  on public.voice_call_latency for select
  using (user_id = public.get_account_owner_id());

-- Rollback (manual):
--   drop table public.voice_call_latency; drop table public.voice_script_overrides;
