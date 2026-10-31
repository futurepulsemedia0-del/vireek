-- Proof-of-consent log for the cookie / storage consent banner.
-- Append-only. Holds no name, email, IP address or user agent: only a random
-- pseudonymous subject id (+ the account id when the visitor is signed in).
-- Anonymous visitors and signed-in users both write through record_consent();
-- nobody can write to the table directly.

create table if not exists public.consent_records (
  id              uuid primary key default gen_random_uuid(),
  subject_id      text        not null check (char_length(subject_id) between 8 and 64),
  user_id         uuid        references auth.users (id) on delete set null,
  consent_version integer     not null check (consent_version between 1 and 1000),
  recorded_at     timestamptz not null,
  analytics       boolean     not null,
  marketing       boolean     not null,
  source          text        not null check (source in ('accept_all', 'reject_all', 'custom')),
  action          text        not null check (action in ('decision', 'account_link')),
  gpc             boolean     not null default false,
  dnt             boolean     not null default false,
  created_at      timestamptz not null default now(),
  -- idempotency: a retried request for the same decision never creates a duplicate
  -- (NULLS NOT DISTINCT so anonymous rows dedupe too; needs PostgreSQL 15+, which Supabase runs)
  constraint consent_records_dedupe unique nulls not distinct (subject_id, recorded_at, action, user_id)
);

alter table public.consent_records enable row level security;

-- A signed-in user may read their own records (data-access requests). No insert/update/delete policies exist.
drop policy if exists consent_records_select_own on public.consent_records;
create policy consent_records_select_own on public.consent_records
  for select to authenticated
  using (user_id = auth.uid());

revoke all on public.consent_records from anon, authenticated;
grant select on public.consent_records to authenticated;

create index if not exists consent_records_subject_idx on public.consent_records (subject_id, recorded_at desc);
create index if not exists consent_records_user_idx on public.consent_records (user_id, recorded_at desc) where user_id is not null;

create or replace function public.record_consent(
  p_subject_id      text,
  p_consent_version integer,
  p_recorded_at     timestamptz,
  p_analytics       boolean,
  p_marketing       boolean,
  p_source          text,
  p_action          text default 'decision',
  p_gpc             boolean default false,
  p_dnt             boolean default false
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if p_subject_id is null or char_length(p_subject_id) not between 8 and 64 then
    raise exception 'invalid subject id' using errcode = '22023';
  end if;
  if p_consent_version is null or p_consent_version not between 1 and 1000 then
    raise exception 'invalid consent version' using errcode = '22023';
  end if;
  -- reject clocks wildly off (a record cannot come from the future or from before the feature existed)
  if p_recorded_at is null or p_recorded_at > now() + interval '10 minutes' or p_recorded_at < now() - interval '400 days' then
    raise exception 'invalid timestamp' using errcode = '22023';
  end if;
  if p_analytics is null or p_marketing is null or p_source is null or p_action is null then
    raise exception 'missing value' using errcode = '22023';
  end if;
  -- marketing can never be recorded as granted while an opt-out signal was present
  if coalesce(p_gpc, false) or coalesce(p_dnt, false) then
    if p_marketing then
      raise exception 'marketing consent conflicts with opt-out signal' using errcode = '22023';
    end if;
  end if;

  -- abuse guard: a single subject cannot write more than 30 rows per hour
  if (select count(*) from public.consent_records
        where subject_id = p_subject_id and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate limit' using errcode = '54000';
  end if;

  insert into public.consent_records
    (subject_id, user_id, consent_version, recorded_at, analytics, marketing, source, action, gpc, dnt)
  values
    (p_subject_id, v_uid, p_consent_version, p_recorded_at, p_analytics, p_marketing, p_source, p_action,
     coalesce(p_gpc, false), coalesce(p_dnt, false))
  on conflict on constraint consent_records_dedupe do nothing;
end;
$$;

revoke all on function public.record_consent(text, integer, timestamptz, boolean, boolean, text, text, boolean, boolean) from public;
grant execute on function public.record_consent(text, integer, timestamptz, boolean, boolean, text, text, boolean, boolean) to anon, authenticated;

-- Rollback (manual, only if you must):
--   drop function if exists public.record_consent(text, integer, timestamptz, boolean, boolean, text, text, boolean, boolean);
--   drop table if exists public.consent_records;
