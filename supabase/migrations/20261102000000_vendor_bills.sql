-- Vendor Bills (Accounts Payable) — linked to jobs + job_cost_entries
-- so every vendor bill automatically flows into job profitability.

create table if not exists public.vendor_bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null references public.jobs(id) on delete cascade,
  cost_entry_id uuid references public.job_cost_entries(id) on delete set null,
  vendor_name text not null,
  bill_number text,
  category text not null default 'material'
    check (category in ('labor', 'material', 'equipment', 'subcontractor', 'permit', 'other')),
  amount_cents integer not null check (amount_cents > 0),
  bill_date date not null default current_date,
  due_date date,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'overdue')),
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_bills_job_id_idx on public.vendor_bills (job_id);
create index if not exists vendor_bills_user_id_idx on public.vendor_bills (user_id);
create index if not exists vendor_bills_status_idx on public.vendor_bills (status);

alter table public.vendor_bills enable row level security;

create policy "Users manage their own vendor bills"
  on public.vendor_bills
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.set_vendor_bills_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists vendor_bills_set_updated_at on public.vendor_bills;
create trigger vendor_bills_set_updated_at
  before update on public.vendor_bills
  for each row execute function public.set_vendor_bills_updated_at();
