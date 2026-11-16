-- 20290303000000_billing_notices.sql
-- Billing lifecycle notices: idempotency log, price-change notices, grandfathering, SMS consent.
-- Rollback (manual, destroys notice history):
--   drop function if exists public.claim_billing_notice(uuid,text,text);
--   drop function if exists public.complete_billing_notice(uuid,text,text,text[]);
--   drop function if exists public.release_billing_notice(uuid,text,text);
--   drop table if exists public.billing_grandfathered_accounts, public.price_change_notices, public.billing_notice_log;
--   alter table public.profiles drop column if exists billing_sms_opt_in;

create table if not exists public.billing_notice_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind ~ '^[a-z0-9_]{3,64}$'),
  key        text not null check (length(key) between 1 and 200),
  channels   text[] not null default '{}',
  claimed_at timestamptz not null default now(),
  sent_at    timestamptz,
  constraint billing_notice_log_user_kind_key_uk unique (user_id, kind, key)
);
create index if not exists billing_notice_log_kind_key_idx on public.billing_notice_log (kind, key);
alter table public.billing_notice_log enable row level security;  -- no policies: service role only

-- Atomically claims one notice. TRUE = caller may send. A claim never completed (crash) is
-- re-claimable after 15 minutes; a completed notice (sent_at set) is never claimable again.
create or replace function public.claim_billing_notice(p_user_id uuid, p_kind text, p_key text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows integer;
begin
  insert into public.billing_notice_log (user_id, kind, key) values (p_user_id, p_kind, p_key)
  on conflict (user_id, kind, key) do update set claimed_at = now()
    where billing_notice_log.sent_at is null and billing_notice_log.claimed_at < now() - interval '15 minutes';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

create or replace function public.complete_billing_notice(p_user_id uuid, p_kind text, p_key text, p_channels text[])
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.billing_notice_log set sent_at = now(), channels = coalesce(p_channels, '{}')
  where user_id = p_user_id and kind = p_kind and key = p_key and sent_at is null;
$$;

create or replace function public.release_billing_notice(p_user_id uuid, p_kind text, p_key text)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.billing_notice_log where user_id = p_user_id and kind = p_kind and key = p_key and sent_at is null;
$$;

revoke all on function public.claim_billing_notice(uuid,text,text) from public, anon, authenticated;
revoke all on function public.complete_billing_notice(uuid,text,text,text[]) from public, anon, authenticated;
revoke all on function public.release_billing_notice(uuid,text,text) from public, anon, authenticated;
grant execute on function public.claim_billing_notice(uuid,text,text) to service_role;
grant execute on function public.complete_billing_notice(uuid,text,text,text[]) to service_role;
grant execute on function public.release_billing_notice(uuid,text,text) to service_role;

-- A planned price increase or limit reduction. Insert a row to announce one; the cron notifies affected accounts.
-- [LAWYER TO CONFIRM] the 30-day minimum notice is enforced here and in _shared/billing/notices/schedule.ts.
create table if not exists public.price_change_notices (
  id                  uuid primary key default gen_random_uuid(),
  plan_id             text not null check (plan_id in ('starter','professional','business')),
  change_kind         text not null check (change_kind in ('price_increase','limit_reduction','both')),
  effective_date      date not null,
  old_price_cents     integer check (old_price_cents >= 0),
  new_price_cents     integer check (new_price_cents >= 0),
  old_minutes         integer check (old_minutes >= 0),
  new_minutes         integer check (new_minutes >= 0),
  currency            text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  status              text not null default 'scheduled' check (status in ('scheduled','completed','blocked_late','canceled')),
  dispatch_started_at timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  constraint pcn_price_cols check (change_kind = 'limit_reduction'
    or (old_price_cents is not null and new_price_cents is not null and new_price_cents > old_price_cents)),
  constraint pcn_limit_cols check (change_kind = 'price_increase'
    or (old_minutes is not null and new_minutes is not null and new_minutes < old_minutes)),
  constraint pcn_notice_period check (effective_date >= ((created_at at time zone 'utc')::date + 30))
);
create index if not exists price_change_notices_status_idx on public.price_change_notices (status, effective_date);
alter table public.price_change_notices enable row level security;  -- service role / staff tooling only

-- Once notices went out, the announced terms are frozen.
create or replace function public.price_change_notices_freeze() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.dispatch_started_at is not null and (
       new.plan_id is distinct from old.plan_id or new.effective_date is distinct from old.effective_date
    or new.old_price_cents is distinct from old.old_price_cents or new.new_price_cents is distinct from old.new_price_cents
    or new.old_minutes is distinct from old.old_minutes or new.new_minutes is distinct from old.new_minutes) then
    raise exception 'price_change_notices: terms are frozen after notices were sent (create a new notice instead)';
  end if;
  return new;
end $$;
drop trigger if exists price_change_notices_freeze_trg on public.price_change_notices;
create trigger price_change_notices_freeze_trg before update on public.price_change_notices
  for each row execute function public.price_change_notices_freeze();

-- Accounts that keep their current terms: they receive no price-change notice for that plan.
create table if not exists public.billing_grandfathered_accounts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  plan_id    text not null check (plan_id in ('starter','professional','business')),
  reason     text,
  created_at timestamptz not null default now(),
  primary key (user_id, plan_id)
);
alter table public.billing_grandfathered_accounts enable row level security;

-- Explicit SMS consent for billing texts (default OFF). Email notices are transactional and need no flag.
alter table public.profiles add column if not exists billing_sms_opt_in boolean not null default false;
