/*
# Execution Reliability Score (ERS)

## چی می‌سازه
- execution_reliability_events : لاگ هر اجرای واقعی از یک Agent، Workflow یا
  Integration (موفق / ناموفق / rollback‌شده)، همراه با latency، این‌که override
  دستی خورده یا نه، و اثر مالی تخمینی (business_impact_cents).
- get_execution_reliability_summary(p_window_days) : تابع تجمیع‌کننده که به‌ازای
  هر (entity_type, entity_key) در بازه‌ی زمانی داده‌شده، شمارش موفقیت/شکست/
  rollback/override، میانگین و p95 لتنسی، و مجموع اثر مالی رو برمی‌گردونه.
  محاسبه‌ی نهاییِ امتیاز ۰ تا ۱۰۰ سمت کلاینت انجام می‌شه
  (src/lib/executionReliability.ts) تا وزن‌ها بدون migration جدید قابل تنظیم باشن.

## دسترسی
مثل بقیه‌ی جدول‌های مشابه، از public.get_account_owner_id() استفاده شده تا هر
عضو یک اکانت فقط داده‌ی همون اکانت رو ببینه. پیش‌فرض account_id همون تابع
هست، پس کلاینت لازم نیست خودش account_id بفرسته.
*/

create table if not exists public.execution_reliability_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.get_account_owner_id() references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('agent', 'workflow', 'integration')),
  entity_key text not null,
  entity_label text not null,
  status text not null check (status in ('success', 'failure', 'rolled_back')),
  was_override boolean not null default false,
  override_reason text,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  business_impact_cents integer,
  context jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists execution_reliability_events_account_idx
  on public.execution_reliability_events (account_id, entity_type, entity_key, created_at desc);
create index if not exists execution_reliability_events_created_idx
  on public.execution_reliability_events (account_id, created_at desc);

alter table public.execution_reliability_events enable row level security;

create policy "Account members view their own execution reliability events"
  on public.execution_reliability_events
  for select
  using (account_id = public.get_account_owner_id());

create policy "Account members log execution reliability events"
  on public.execution_reliability_events
  for insert
  with check (account_id = public.get_account_owner_id());

-- =============================================================
-- SUMMARY (تجمیع per-entity، RLS-safe از طریق security definer)
-- =============================================================

create or replace function public.get_execution_reliability_summary(p_window_days integer default 30)
returns table (
  entity_type text,
  entity_key text,
  entity_label text,
  total_runs bigint,
  success_count bigint,
  failure_count bigint,
  rollback_count bigint,
  override_count bigint,
  avg_latency_ms numeric,
  p95_latency_ms numeric,
  business_impact_cents bigint,
  last_event_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    entity_type,
    entity_key,
    (array_agg(entity_label order by created_at desc))[1] as entity_label,
    count(*) as total_runs,
    count(*) filter (where status = 'success') as success_count,
    count(*) filter (where status = 'failure') as failure_count,
    count(*) filter (where status = 'rolled_back') as rollback_count,
    count(*) filter (where was_override) as override_count,
    avg(latency_ms) as avg_latency_ms,
    percentile_cont(0.95) within group (order by latency_ms) as p95_latency_ms,
    coalesce(sum(business_impact_cents), 0) as business_impact_cents,
    max(created_at) as last_event_at
  from public.execution_reliability_events
  where account_id = public.get_account_owner_id()
    and created_at >= now() - (greatest(p_window_days, 1) || ' days')::interval
  group by entity_type, entity_key
  order by total_runs desc;
$$;

grant execute on function public.get_execution_reliability_summary(integer) to authenticated;
