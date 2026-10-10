/*
  # Job detail — realtime coverage

  /dashboard/jobs/:id live-updates the activity feed, parts, costs and invoice
  sections. Postgres Realtime only emits changes for tables that are in the
  `supabase_realtime` publication, and until now only `jobs` (among these) was.

  This adds, idempotently and only where the table exists:
    - business_activity_events   (the append-only job ledger -> live activity feed)
    - job_parts_required         (required parts / readiness changes)
    - inventory_transactions     (parts consumed on the job)
    - job_cost_entries           (costs & profit)
    - invoices                   (invoice status: sent / viewed / paid)

  Realtime applies each table's existing RLS SELECT policy, so a subscriber only
  ever receives rows their account may read; the page additionally filters by
  job id and re-checks the account owner client-side.

  Also adds two lookup indexes the page's per-job queries rely on (no-ops if
  equivalent indexes already exist under these names).
*/

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY[
      'business_activity_events',
      'job_parts_required',
      'inventory_transactions',
      'job_cost_entries',
      'invoices'
    ] LOOP
      IF to_regclass('public.' || t) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
         )
      THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.job_cost_entries') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_job_cost_entries_job_created ON public.job_cost_entries (job_id, created_at DESC);
  END IF;
  IF to_regclass('public.invoices') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_invoices_job_created ON public.invoices (job_id, created_at DESC) WHERE job_id IS NOT NULL;
  END IF;
END $$;
