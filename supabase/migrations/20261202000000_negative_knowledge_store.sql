/*
# Negative Knowledge Store

## چی می‌سازه
- negative_knowledge_entries : هر بار که یک استراتژی یا اقدام (توسط یک Agent،
  Workflow، Integration، یا یک تصمیم انسانی) تحت شرایط مشخصی شکست خورده، این‌جا
  ثبت می‌شه: چی امتحان شد، تحت چه شرایطی (context_conditions به‌صورت jsonb)،
  چرا شکست خورد، و چقدر بد بود (severity/business_impact_cents).
- check_negative_knowledge(p_domain, p_context) : قبل از این‌که یک agent/workflow
  دوباره همون کار رو امتحان کنه، این تابع با شرایط فعلی صدا زده می‌شه؛ هر ردیف
  فعالی که شرایط شکستش زیرمجموعه‌ی شرایط فعلیه برمی‌گرده — یعنی «قبلاً همین‌جوری
  امتحان کردیم، شکست خورد».
- record_negative_knowledge_match(p_entry_id) : هر بار match واقعاً جلوی تکرار
  خطا رو گرفت، شمارنده‌ی times_matched زیاد می‌شه — تا معلوم بشه این حافظه‌ی
  منفی چند بار واقعاً مفید بوده.

## دسترسی
مثل بقیه‌ی جدول‌های اخیر، از public.get_account_owner_id() استفاده شده.
source_event_id (اختیاری) به execution_reliability_events وصل می‌شه.
*/

create table if not exists public.negative_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.get_account_owner_id() references auth.users(id) on delete cascade,
  domain text not null,
  strategy text not null,
  action_description text not null,
  context_conditions jsonb not null default '{}'::jsonb,
  failure_reason text not null,
  outcome_summary text,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  business_impact_cents integer,
  source_type text check (source_type in ('agent', 'workflow', 'integration', 'human_decision')),
  source_entity_key text,
  source_event_id uuid references public.execution_reliability_events(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'resolved', 'superseded')),
  resolved_reason text,
  times_matched integer not null default 0,
  last_matched_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists negative_knowledge_entries_account_domain_idx
  on public.negative_knowledge_entries (account_id, domain, status);
create index if not exists negative_knowledge_entries_context_gin_idx
  on public.negative_knowledge_entries using gin (context_conditions);

alter table public.negative_knowledge_entries enable row level security;

create policy "Account members view their own negative knowledge entries"
  on public.negative_knowledge_entries
  for select
  using (account_id = public.get_account_owner_id());

create policy "Account members log negative knowledge entries"
  on public.negative_knowledge_entries
  for insert
  with check (account_id = public.get_account_owner_id());

create policy "Account members update their own negative knowledge entries"
  on public.negative_knowledge_entries
  for update
  using (account_id = public.get_account_owner_id())
  with check (account_id = public.get_account_owner_id());

-- از تابع مشترک موجود public.update_updated_at() استفاده می‌کنه
drop trigger if exists trigger_negative_knowledge_entries_updated_at on public.negative_knowledge_entries;
create trigger trigger_negative_knowledge_entries_updated_at
  before update on public.negative_knowledge_entries
  for each row
  execute function public.update_updated_at();

-- =============================================================
-- CHECK: آیا این اقدام قبلاً تحت همین شرایط شکست خورده؟
-- =============================================================

create or replace function public.check_negative_knowledge(p_domain text, p_context jsonb default '{}'::jsonb)
returns setof public.negative_knowledge_entries
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.negative_knowledge_entries
  where account_id = public.get_account_owner_id()
    and domain = p_domain
    and status = 'active'
    and context_conditions <@ p_context
  order by
    case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
    times_matched desc;
$$;

grant execute on function public.check_negative_knowledge(text, jsonb) to authenticated;

-- =============================================================
-- MATCH: ثبت این‌که یک ردیف واقعاً جلوی تکرار خطا رو گرفت
-- =============================================================

create or replace function public.record_negative_knowledge_match(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.negative_knowledge_entries
  set times_matched = times_matched + 1,
      last_matched_at = now()
  where id = p_entry_id
    and account_id = public.get_account_owner_id();
end;
$$;

grant execute on function public.record_negative_knowledge_match(uuid) to authenticated;
