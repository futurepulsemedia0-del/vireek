/*
# AI Ops: Evaluation + Cost Management

## چی می‌سازه
- ai_usage_logs      : لاگ هر تماس واقعی به AI Core (provider, model, token, cost, latency, fallback, خطا)
- ai_budget_limits   : سقف هزینه‌ی ماهانه‌ی هر اکانت (ردیف با account_id = NULL فقط از طریق service-role/SQL
                        قابل مدیریته و به‌عمد در هیچ policy ای برای کاربران قابل دیدن نیست — این سقفِ
                        داخلیِ خودِ Vireek روی زیرساخت AI هست، نه تنظیمات مشتری)
- ai_eval_suites/cases/runs/results : مجموعه تست برای agentها + نتیجه‌ی هر اجرا (pass/fail،
                        hallucination، دقت خروجی، latency، cost)

## دسترسی
همه‌جا از تابع موجود public.get_account_owner_id() استفاده شده (همون چیزی که
team_members / profiles ازش استفاده می‌کنن) تا اعضای یک اکانت فقط داده‌ی خودشون رو ببینن.
نوشتن روی ai_usage_logs / ai_eval_runs / ai_eval_results فقط از طریق service-role
(داخل edge functionها) انجام می‌شه — هیچ INSERT policy ای برای کاربر عادی تعریف نشده.

محدودیت شناخته‌شده: چک نقش ادمین این‌جا فقط profiles.role رو می‌بینه، نه اعضای تیم
(team_members). اگر لازم شد همون‌جوری که team_invite_tokens.sql این کار رو کرده،
یک شرط EXISTS روی team_members هم اضافه کنید.
*/

-- =============================================================
-- USAGE LOGS
-- =============================================================

create table if not exists public.ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references auth.users(id) on delete set null,
  task text not null,
  source text,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  tokens_estimated boolean not null default false,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms integer not null default 0,
  was_fallback boolean not null default false,
  attempt_count integer not null default 0,
  provider_chain jsonb,
  ok boolean not null default true,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_logs_account_created_idx
  on public.ai_usage_logs (account_id, created_at desc);
create index if not exists ai_usage_logs_task_idx
  on public.ai_usage_logs (task, created_at desc);
create index if not exists ai_usage_logs_provider_idx
  on public.ai_usage_logs (provider, created_at desc);

alter table public.ai_usage_logs enable row level security;

create policy "Account members view their own usage logs"
  on public.ai_usage_logs
  for select
  using (account_id = public.get_account_owner_id());

-- =============================================================
-- BUDGET LIMITS
-- =============================================================

create table if not exists public.ai_budget_limits (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references auth.users(id) on delete cascade, -- NULL = platform-wide (Vireek internal), never exposed via RLS
  monthly_limit_usd numeric(12, 2) not null check (monthly_limit_usd > 0),
  alert_threshold_pct smallint not null default 80 check (alert_threshold_pct between 1 and 100),
  hard_stop boolean not null default false,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_budget_limits_account_unique
  on public.ai_budget_limits (account_id) where account_id is not null;
create unique index if not exists ai_budget_limits_platform_unique
  on public.ai_budget_limits ((account_id is null)) where account_id is null;

alter table public.ai_budget_limits enable row level security;

create policy "Account owners and admins manage their own budget"
  on public.ai_budget_limits
  for all
  using (
    account_id = public.get_account_owner_id()
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
  )
  with check (
    account_id = public.get_account_owner_id()
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
  );

-- =============================================================
-- EVAL SUITES / CASES
-- =============================================================

create table if not exists public.ai_eval_suites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  task text not null, -- one of ai-core's TaskType values, e.g. "dashboard_answer"
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists ai_eval_suites_account_idx on public.ai_eval_suites (account_id);

alter table public.ai_eval_suites enable row level security;

create policy "Account owners and admins manage eval suites"
  on public.ai_eval_suites
  for all
  using (
    account_id = public.get_account_owner_id()
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
  )
  with check (
    account_id = public.get_account_owner_id()
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
  );

create table if not exists public.ai_eval_cases (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.ai_eval_suites(id) on delete cascade,
  name text not null,
  user_message text not null,
  extra_instructions text,
  json_mode boolean not null default false,
  -- آرایه‌ای از { type: 'contains_keyword' | 'not_contains_keyword' | 'json_field_equals' | 'max_latency_ms', ... }
  assertions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_eval_cases_suite_idx on public.ai_eval_cases (suite_id);

alter table public.ai_eval_cases enable row level security;

create policy "Account owners and admins manage eval cases"
  on public.ai_eval_cases
  for all
  using (
    exists (
      select 1 from public.ai_eval_suites s
      where s.id = ai_eval_cases.suite_id
        and s.account_id = public.get_account_owner_id()
        and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
    )
  )
  with check (
    exists (
      select 1 from public.ai_eval_suites s
      where s.id = ai_eval_cases.suite_id
        and s.account_id = public.get_account_owner_id()
        and exists (select 1 from public.profiles where id = auth.uid() and role in ('owner', 'admin'))
    )
  );

-- =============================================================
-- EVAL RUNS / RESULTS  (written only by the ai-eval-run edge function)
-- =============================================================

create table if not exists public.ai_eval_runs (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.ai_eval_suites(id) on delete cascade,
  account_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  case_count integer not null default 0,
  pass_count integer not null default 0,
  fail_count integer not null default 0,
  hallucination_count integer not null default 0,
  avg_latency_ms integer,
  total_cost_usd numeric(12, 6) not null default 0,
  triggered_by uuid references auth.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ai_eval_runs_account_idx on public.ai_eval_runs (account_id, started_at desc);
create index if not exists ai_eval_runs_suite_idx on public.ai_eval_runs (suite_id, started_at desc);

alter table public.ai_eval_runs enable row level security;

create policy "Account members view their own eval runs"
  on public.ai_eval_runs
  for select
  using (account_id = public.get_account_owner_id());

create table if not exists public.ai_eval_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_eval_runs(id) on delete cascade,
  case_id uuid not null references public.ai_eval_cases(id) on delete cascade,
  passed boolean not null,
  assertions_failed jsonb not null default '[]'::jsonb,
  hallucination_detected boolean not null default false,
  hallucination_reason text,
  provider text,
  model text,
  latency_ms integer,
  cost_usd numeric(12, 6) default 0,
  output_text text,
  created_at timestamptz not null default now()
);

create index if not exists ai_eval_results_run_idx on public.ai_eval_results (run_id);

alter table public.ai_eval_results enable row level security;

create policy "Account members view their own eval results"
  on public.ai_eval_results
  for select
  using (
    exists (
      select 1 from public.ai_eval_runs r
      where r.id = ai_eval_results.run_id
        and r.account_id = public.get_account_owner_id()
    )
  );
