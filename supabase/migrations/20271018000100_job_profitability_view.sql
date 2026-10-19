/*
  # Job costing: job_cost_entries + the job_profitability view

  ## Why
  Ten modules read `job_profitability` (job costing, agreements, fleet economics, job autopsy, digital
  twin, forecasting...) but no migration in the repo creates it, and the original
  20260916_job_cost_entries.sql defines an older shape (amount numeric, category 'materials') with a
  policy that references a column jobs does not have (jobs.account_id). The app code
  (src/lib/jobCosting.ts) uses integer cents, quantity x unit cost, 'material' and per-account scoping.

  ## What this does (idempotent, never overwrites what you already have)
    * creates job_cost_entries in the shape the code expects, or upgrades an old one in place
      (adds missing columns, 'materials' -> 'material', backfills user_id from the job);
    * replaces the broken jobs.account_id policy with one scoped by get_account_owner_id();
    * creates the job_profitability view ONLY IF it does not exist yet (security_invoker, so the
      viewer's own RLS on jobs / job_cost_entries applies - never bypassed).
  Requires PostgreSQL 15+ (every current Supabase project).
*/

-- =============================================================
-- 1. job_cost_entries
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'other',
  description text NOT NULL,
  quantity numeric(12, 3) NOT NULL DEFAULT 1,
  unit_cost_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Upgrade path for the older shape.
ALTER TABLE public.job_cost_entries
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS quantity numeric(12, 3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_cost_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_book_item_id uuid REFERENCES public.price_book_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  -- Old rows stored dollars in "amount": carry them over as quantity 1 x unit cost.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'job_cost_entries' AND column_name = 'amount'
  ) THEN
    EXECUTE $q$
      UPDATE public.job_cost_entries
      SET unit_cost_cents = round(amount * 100)::integer, quantity = 1
      WHERE unit_cost_cents = 0 AND amount IS NOT NULL AND amount > 0
    $q$;
    -- New rows no longer write the legacy dollar column.
    EXECUTE 'ALTER TABLE public.job_cost_entries ALTER COLUMN amount DROP NOT NULL';
  END IF;

  -- total_cost_cents is computed by the database so it can never drift from quantity x unit cost.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'job_cost_entries' AND column_name = 'total_cost_cents'
  ) THEN
    EXECUTE 'ALTER TABLE public.job_cost_entries ADD COLUMN total_cost_cents integer GENERATED ALWAYS AS (round(quantity * unit_cost_cents)::integer) STORED';
  END IF;
END $$;

UPDATE public.job_cost_entries c
SET user_id = j.user_id
FROM public.jobs j
WHERE c.job_id = j.id AND c.user_id IS NULL;

ALTER TABLE public.job_cost_entries ALTER COLUMN user_id SET NOT NULL;

-- Drop the old category check first: it only allows 'materials'.
ALTER TABLE public.job_cost_entries DROP CONSTRAINT IF EXISTS job_cost_entries_category_check;
UPDATE public.job_cost_entries SET category = 'material' WHERE category = 'materials';
ALTER TABLE public.job_cost_entries ADD CONSTRAINT job_cost_entries_category_check
  CHECK (category IN ('labor', 'material', 'equipment', 'subcontractor', 'permit', 'other'));

ALTER TABLE public.job_cost_entries DROP CONSTRAINT IF EXISTS job_cost_entries_quantity_check;
ALTER TABLE public.job_cost_entries ADD CONSTRAINT job_cost_entries_quantity_check CHECK (quantity > 0);

ALTER TABLE public.job_cost_entries DROP CONSTRAINT IF EXISTS job_cost_entries_unit_cost_cents_check;
ALTER TABLE public.job_cost_entries ADD CONSTRAINT job_cost_entries_unit_cost_cents_check CHECK (unit_cost_cents >= 0);

CREATE INDEX IF NOT EXISTS job_cost_entries_job_id_idx ON public.job_cost_entries (job_id);
CREATE INDEX IF NOT EXISTS job_cost_entries_user_id_idx ON public.job_cost_entries (user_id);

CREATE OR REPLACE FUNCTION public.job_cost_entries_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_cost_entries_touch ON public.job_cost_entries;
CREATE TRIGGER trg_job_cost_entries_touch
  BEFORE UPDATE ON public.job_cost_entries
  FOR EACH ROW EXECUTE FUNCTION public.job_cost_entries_touch();

ALTER TABLE public.job_cost_entries ENABLE ROW LEVEL SECURITY;

-- The old policy referenced jobs.account_id, which does not exist.
DROP POLICY IF EXISTS "Users manage cost entries on their own jobs" ON public.job_cost_entries;
DROP POLICY IF EXISTS "manage_own_job_cost_entries" ON public.job_cost_entries;
CREATE POLICY "manage_own_job_cost_entries"
  ON public.job_cost_entries FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_cost_entries.job_id AND j.user_id = job_cost_entries.user_id)
  );

-- =============================================================
-- 2. job_profitability (one row per job) - created only if absent
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.job_profitability') IS NULL THEN
    EXECUTE $view$
      CREATE VIEW public.job_profitability WITH (security_invoker = true) AS
      SELECT
        j.id                                   AS job_id,
        j.user_id                              AS user_id,
        j.customer_name                        AS customer_name,
        j.service_type                         AS service_type,
        j.job_status                           AS job_status,
        j.scheduled_datetime                   AS scheduled_datetime,
        j.assigned_technician_id               AS assigned_technician_id,
        j.invoice_status                       AS invoice_status,
        COALESCE(round(j.invoice_amount * 100), 0)::bigint                                         AS revenue_cents,
        COALESCE(sum(c.total_cost_cents) FILTER (WHERE c.category = 'labor'), 0)::bigint           AS labor_cost_cents,
        COALESCE(sum(c.total_cost_cents) FILTER (WHERE c.category = 'material'), 0)::bigint        AS material_cost_cents,
        COALESCE(sum(c.total_cost_cents) FILTER (WHERE c.category = 'equipment'), 0)::bigint       AS equipment_cost_cents,
        COALESCE(sum(c.total_cost_cents) FILTER (WHERE c.category = 'subcontractor'), 0)::bigint   AS subcontractor_cost_cents,
        COALESCE(sum(c.total_cost_cents) FILTER (WHERE c.category = 'permit'), 0)::bigint          AS permit_cost_cents,
        COALESCE(sum(c.total_cost_cents) FILTER (WHERE c.category = 'other'), 0)::bigint           AS other_cost_cents,
        COALESCE(sum(c.total_cost_cents), 0)::bigint                                               AS total_cost_cents,
        (COALESCE(round(j.invoice_amount * 100), 0) - COALESCE(sum(c.total_cost_cents), 0))::bigint AS gross_profit_cents,
        CASE
          WHEN COALESCE(round(j.invoice_amount * 100), 0) > 0
            THEN round(((COALESCE(round(j.invoice_amount * 100), 0) - COALESCE(sum(c.total_cost_cents), 0)) * 100.0)
                       / round(j.invoice_amount * 100), 1)
          ELSE NULL
        END                                                                                        AS margin_pct,
        count(c.id)::integer                                                                       AS cost_entry_count
      FROM public.jobs j
      LEFT JOIN public.job_cost_entries c ON c.job_id = j.id
      GROUP BY j.id
    $view$;
    EXECUTE 'GRANT SELECT ON public.job_profitability TO authenticated';
  END IF;
END $$;
