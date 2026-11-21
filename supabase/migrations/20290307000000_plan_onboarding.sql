-- 20290307000000_plan_onboarding.sql
--
-- Plan-selection step after email verification (/onboarding/plan).
--
--   * plan_onboarding_config : ONE row of policy (trial mode, skip allowed, reminder delay). Read by the app AND by
--                              create-checkout-session, so the policy lives in one place and is never hard-coded.
--   * plan_onboarding        : per-owner plan INTENT (plan, billing, source, step). Resumes after refresh, another
--                              device or a later login. It never grants anything: entitlements still change ONLY from
--                              the verified Stripe webhook (stripe-webhook -> profiles).
--   * RPCs                   : plan_onboarding_state(), save_plan_intent(), skip_plan_step() (authenticated, owner-only)
--                              plan_onboarding_reminder_candidates() (service_role, used by plan-resume-reminder)
--
-- Idempotent: every statement is safe to re-run. Existing accounts are NOT touched: gate_starts_at defaults to the moment
-- this migration first runs, so only accounts created afterwards are sent through the step automatically.
--
-- Rollback (manual; destroys stored plan intents):
--   drop function if exists public.plan_onboarding_reminder_candidates(integer);
--   drop function if exists public.skip_plan_step();
--   drop function if exists public.save_plan_intent(text, text, text, text, jsonb, boolean);
--   drop function if exists public.plan_onboarding_state();
--   drop function if exists public.plan_onboarding_clamp_int(jsonb, integer);
--   drop function if exists public.plan_onboarding_email_key(text);
--   drop table if exists public.plan_onboarding;
--   drop table if exists public.plan_onboarding_config;

-- 1) policy ------------------------------------------------------------------------------------------------------------
create table if not exists public.plan_onboarding_config (
  id                   boolean primary key default true check (id),
  -- card_required : trial needs a card up front (what the repo does today, see docs/billing/card-required-trial.md)
  -- no_card       : trial starts without a card; Stripe cancels it if no payment method is added by the end
  -- none          : no trial from this step, the first payment happens at checkout
  trial_mode           text    not null default 'card_required' check (trial_mode in ('card_required', 'no_card', 'none')),
  allow_skip           boolean not null default true,
  reminder_delay_hours integer not null default 24 check (reminder_delay_hours between 1 and 720),
  gate_starts_at       timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
insert into public.plan_onboarding_config (id) values (true) on conflict (id) do nothing;

alter table public.plan_onboarding_config enable row level security;
revoke all on public.plan_onboarding_config from anon, authenticated;
grant select on public.plan_onboarding_config to authenticated;
drop policy if exists plan_onboarding_config_read on public.plan_onboarding_config;
create policy plan_onboarding_config_read on public.plan_onboarding_config for select to authenticated using (true);
-- Changes go through the SQL editor / service role (documented in docs/billing/plan-step.md). No write policy on purpose.

-- 2) per-owner plan intent --------------------------------------------------------------------------------------------
create table if not exists public.plan_onboarding (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  plan                text check (plan in ('starter', 'professional', 'business', 'enterprise')),
  billing             text not null default 'monthly' check (billing in ('monthly', 'annual')),
  source              text not null default 'plan_step' check (source ~ '^[a-z0-9_]{1,32}$'),
  step                text not null default 'plan' check (step in ('plan', 'checkout', 'done', 'skipped', 'sales')),
  size_answers        jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(size_answers) = 'object' and pg_column_size(size_answers) < 512),
  checkout_session_id text check (checkout_session_id is null or checkout_session_id ~ '^cs_[A-Za-z0-9_]{8,200}$'),
  checkout_started_at timestamptz,
  reminder_consent    boolean not null default false,
  skipped_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists plan_onboarding_reminder_idx
  on public.plan_onboarding (updated_at) where reminder_consent and step in ('plan', 'checkout', 'skipped');

alter table public.plan_onboarding enable row level security;
revoke all on public.plan_onboarding from anon, authenticated;
-- No policies and no grants: the client only talks to the SECURITY DEFINER functions below; the edge functions use the service role.

-- 3) helpers ---------------------------------------------------------------------------------------------------------
-- Same normalisation as emailDedupeKey() in supabase/functions/_shared/billing/trialLifecycle.ts (lower-case, "+tag" stripped).
create or replace function public.plan_onboarding_email_key(p_email text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else split_part(split_part(lower(btrim(p_email)), '@', 1), '+', 1) || '@' || split_part(lower(btrim(p_email)), '@', 2)
  end
$$;

-- Whole non-negative number from a JSON value, clamped to p_max; NULL when absent or not a number.
create or replace function public.plan_onboarding_clamp_int(p_value jsonb, p_max integer)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_value is not null and jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^[0-9]{1,9}(\.0+)?$'
      then least(split_part(p_value #>> '{}', '.', 1)::bigint, p_max)::integer
    else null
  end
$$;

-- 4) state -----------------------------------------------------------------------------------------------------------
-- can_use_step  : owner who is not subscribed yet -> may open /onboarding/plan (also after "skip for now")
-- should_prompt : can_use_step AND the account is new (created after gate_starts_at) AND still on step plan/checkout
--                 -> the dashboard gate sends them there automatically
-- show_resume   : can_use_step AND an intent row is still open (plan / checkout / skipped) -> dashboard banner
create or replace function public.plan_onboarding_state()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid        uuid := auth.uid();
  v_cfg        public.plan_onboarding_config%rowtype;
  v_prof       record;
  v_row        public.plan_onboarding%rowtype;
  v_has_row    boolean;
  v_owner      boolean;
  v_subscribed boolean;
  v_can_use    boolean;
  v_step       text;
  v_trial_ok   boolean;
  v_key        text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_cfg from public.plan_onboarding_config where id;
  select id, email, role, created_at, stripe_subscription_id, trial_state, trial_used_at
    into v_prof from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('can_use_step', false, 'should_prompt', false, 'show_resume', false, 'reason', 'no_profile');
  end if;

  v_owner := coalesce(public.get_account_owner_id() = v_uid, false) and v_prof.role = 'owner';
  v_subscribed := v_prof.stripe_subscription_id is not null or v_prof.trial_state in ('trialing', 'converted');
  v_can_use := v_owner and not v_subscribed;

  select * into v_row from public.plan_onboarding where user_id = v_uid;
  v_has_row := found;

  -- A subscription (or trial) exists now: close the intent. This is a bookkeeping write only; it grants nothing.
  if v_has_row and v_subscribed and v_row.step not in ('done') then
    update public.plan_onboarding set step = 'done', completed_at = coalesce(completed_at, now()), updated_at = now()
     where user_id = v_uid returning * into v_row;
  end if;

  v_step := case when v_has_row then v_row.step else 'plan' end;

  v_key := public.plan_onboarding_email_key(v_prof.email);
  v_trial_ok := v_cfg.trial_mode <> 'none'
    and v_prof.trial_used_at is null
    and v_prof.trial_state in ('none')
    and not exists (select 1 from public.trial_claims c where c.email_key = v_key and c.user_id <> v_uid);

  return jsonb_build_object(
    'can_use_step', v_can_use,
    'should_prompt', v_can_use and v_prof.created_at >= v_cfg.gate_starts_at and v_step in ('plan', 'checkout'),
    'show_resume', v_can_use and v_has_row and v_step in ('plan', 'checkout', 'skipped'),
    'reason', case when not v_owner then 'not_owner' when v_subscribed then 'subscribed' else 'ok' end,
    'step', v_step,
    'plan', case when v_has_row then v_row.plan else null end,
    'billing', case when v_has_row then v_row.billing else 'monthly' end,
    'source', case when v_has_row then v_row.source else null end,
    'size_answers', case when v_has_row then v_row.size_answers else '{}'::jsonb end,
    'reminder_consent', case when v_has_row then v_row.reminder_consent else false end,
    'trial_eligible', v_trial_ok,
    'policy', jsonb_build_object(
      'trial_mode', v_cfg.trial_mode,
      'allow_skip', v_cfg.allow_skip,
      'reminder_delay_hours', v_cfg.reminder_delay_hours
    )
  );
end $$;
revoke all on function public.plan_onboarding_state() from public, anon;
grant execute on function public.plan_onboarding_state() to authenticated;

-- 5) save the intent --------------------------------------------------------------------------------------------------
-- p_step may only be 'plan' or 'sales'. 'checkout' and 'done' are written by the server only.
create or replace function public.save_plan_intent(
  p_plan             text,
  p_billing          text default 'monthly',
  p_source           text default 'plan_step',
  p_step             text default 'plan',
  p_answers          jsonb default null,
  p_reminder_consent boolean default null
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid     uuid := auth.uid();
  v_prof    record;
  v_state   jsonb;
  v_source  text;
  v_answers jsonb;
  v_old     public.plan_onboarding%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_plan is not null and p_plan not in ('starter', 'professional', 'business', 'enterprise') then
    raise exception 'invalid_plan' using errcode = '22023';
  end if;
  if p_billing not in ('monthly', 'annual') then
    raise exception 'invalid_billing' using errcode = '22023';
  end if;
  if p_step not in ('plan', 'sales') then
    raise exception 'invalid_step' using errcode = '22023';
  end if;

  v_state := public.plan_onboarding_state();
  if not coalesce((v_state ->> 'can_use_step')::boolean, false) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;

  v_source := case when p_source ~ '^[a-z0-9_]{1,32}$' then p_source else 'plan_step' end;
  v_answers := case when p_answers is null or jsonb_typeof(p_answers) <> 'object' then null else
    jsonb_strip_nulls(jsonb_build_object(
      'monthly_calls', public.plan_onboarding_clamp_int(p_answers -> 'monthly_calls', 1000000),
      'technicians',   public.plan_onboarding_clamp_int(p_answers -> 'technicians', 10000),
      'locations',     public.plan_onboarding_clamp_int(p_answers -> 'locations', 1000)
    )) end;

  select * into v_old from public.plan_onboarding where user_id = v_uid;

  insert into public.plan_onboarding as po (user_id, plan, billing, source, step, size_answers, reminder_consent)
  values (v_uid, p_plan, p_billing, v_source, p_step, coalesce(v_answers, '{}'::jsonb), coalesce(p_reminder_consent, false))
  on conflict (user_id) do update set
    plan             = excluded.plan,
    billing          = excluded.billing,
    source           = case when po.plan is distinct from excluded.plan then excluded.source else po.source end,
    -- Re-saving the SAME plan/cycle (e.g. toggling the reminder box) must not forget that checkout was started.
    step             = case when po.step = 'checkout' and excluded.step = 'plan'
                             and po.plan is not distinct from excluded.plan and po.billing is not distinct from excluded.billing
                            then 'checkout' else excluded.step end,
    size_answers     = coalesce(v_answers, po.size_answers),
    reminder_consent = coalesce(p_reminder_consent, po.reminder_consent),
    -- A different plan or cycle invalidates any open Stripe session for the old choice.
    checkout_session_id = case when po.plan is distinct from excluded.plan or po.billing is distinct from excluded.billing
                               then null else po.checkout_session_id end,
    skipped_at       = null,
    updated_at       = now();
end $$;
revoke all on function public.save_plan_intent(text, text, text, text, jsonb, boolean) from public, anon;
grant execute on function public.save_plan_intent(text, text, text, text, jsonb, boolean) to authenticated;

-- 6) skip for now -----------------------------------------------------------------------------------------------------
create or replace function public.skip_plan_step()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_state jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  v_state := public.plan_onboarding_state();
  if not coalesce((v_state ->> 'can_use_step')::boolean, false) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  if not coalesce((v_state #>> '{policy,allow_skip}')::boolean, false) then
    raise exception 'skip_not_allowed' using errcode = '42501';
  end if;
  insert into public.plan_onboarding (user_id, step, skipped_at) values (v_uid, 'skipped', now())
  on conflict (user_id) do update set step = 'skipped', skipped_at = now(), updated_at = now();
end $$;
revoke all on function public.skip_plan_step() from public, anon;
grant execute on function public.skip_plan_step() to authenticated;

-- 7) reminder candidates (service role only) -------------------------------------------------------------------------
-- Consent-respecting: only people who ticked the reminder box, only owners, only while still unsubscribed and idle for
-- longer than the configured delay. Whether the one email was already sent is enforced by billing_notice_log
-- (claim_billing_notice, kind 'plan_resume') in the edge function, not here.
create or replace function public.plan_onboarding_reminder_candidates(p_limit integer default 50)
returns table (user_id uuid, email text, full_name text, plan text, billing text)
language sql security definer set search_path = public, pg_temp as $$
  select po.user_id, p.email, p.full_name, po.plan, po.billing
    from public.plan_onboarding po
    join public.profiles p on p.id = po.user_id
    cross join public.plan_onboarding_config c
   where po.reminder_consent
     and po.step in ('plan', 'checkout', 'skipped')
     and po.updated_at <= now() - make_interval(hours => c.reminder_delay_hours)
     and p.role = 'owner'
     and p.email is not null
     and p.stripe_subscription_id is null
     and p.trial_state not in ('trialing', 'converted')
     and not exists (
       select 1 from public.billing_notice_log l
        where l.user_id = po.user_id and l.kind = 'plan_resume' and l.sent_at is not null)
   order by po.updated_at
   limit least(greatest(p_limit, 1), 200)
$$;
revoke all on function public.plan_onboarding_reminder_candidates(integer) from public, anon, authenticated;
grant execute on function public.plan_onboarding_reminder_candidates(integer) to service_role;
