-- Phone / Numbers Management
-- Adjust the account_id foreign key below to point at your actual
-- accounts/profiles table if it's different from auth.users.

create table if not exists public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users(id) on delete cascade, -- TODO: point at your accounts/profiles table if different
  phone_number text not null unique,
  friendly_name text not null default 'Untitled Number',
  number_type text not null default 'local' check (number_type in ('local', 'toll_free', 'mobile')),
  status text not null default 'pending' check (status in ('active', 'porting_in', 'porting_out', 'pending', 'released')),
  is_primary boolean not null default false,
  voice_enabled boolean not null default true,
  sms_enabled boolean not null default false,
  forwarding_number text,
  assigned_trade text,
  assigned_location text,
  monthly_cost_cents integer not null default 100,
  porting_details jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists phone_numbers_account_id_idx on public.phone_numbers (account_id);
create index if not exists phone_numbers_status_idx on public.phone_numbers (status);

-- Only one primary, non-released number per account
create unique index if not exists phone_numbers_one_primary_per_account
  on public.phone_numbers (account_id)
  where is_primary = true and status != 'released';

alter table public.phone_numbers enable row level security;

create policy "Users manage their own phone numbers"
  on public.phone_numbers
  for all
  using (auth.uid() = account_id)
  with check (auth.uid() = account_id);
