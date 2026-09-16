-- Profitability / Job Costing
-- Adds a line-item cost table against the existing `jobs` table.
-- Revenue is read from jobs.invoice_amount — no changes needed there.

create table if not exists public.job_cost_entries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  category text not null check (category in ('labor', 'materials', 'subcontractor', 'permits', 'equipment', 'other')),
  description text not null,
  amount numeric(10, 2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists job_cost_entries_job_id_idx on public.job_cost_entries (job_id);

alter table public.job_cost_entries enable row level security;

-- Access follows the parent job's account scope.
-- Adjust `account_id` below if your jobs table links to accounts under a
-- different column name.
create policy "Users manage cost entries on their own jobs"
  on public.job_cost_entries
  for all
  using (
    exists (
      select 1 from public.jobs
      where jobs.id = job_cost_entries.job_id
      and jobs.account_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.jobs
      where jobs.id = job_cost_entries.job_id
      and jobs.account_id = auth.uid()
    )
  );
