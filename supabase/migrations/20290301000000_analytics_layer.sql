/*
  # Analytics layer (Part A, customer-facing) - governed rollups, settings, alerts, events

  Everything is behind the feature flag `analytics_layer` (default OFF, rollout 0). Per-account
  entitlement = a tenant override ON in /staff/feature-flags (feature_flag_overrides). With the flag
  OFF nothing here is readable by tenants and the refresh job skips them: zero behavior change.

  Objects
    analytics_feature_on(owner)     flag evaluation for one account owner (SECURITY DEFINER)
    analytics_daily_rollups         ADDITIVE per-day / per-technician components of every metric
    analytics_settings              hours_per_day (utilization), digest opt-in, alert opt-in
    analytics_alerts                anomaly alerts, idempotent per (account, metric, period)
    analytics_events                PII-free product events (service role writes only)
    analytics_refresh_rollups()     rebuild one account's rollups for a date range (atomic, locked)
    analytics_refresh_all(days)     rebuild the trailing window for every enabled account (pg_cron)
    analytics_tech_capacity()       technicians + working days (for utilization capacity)
    analytics_ar_open_invoices()    open invoice balances (no customer names) for AR aging
  Metric formulas live in supabase/functions/_shared/analytics/customerKpis.ts (docs/ANALYTICS_METRICS.md).

  Tenant boundary: every row carries user_id (= get_account_owner_id()). RLS policies require
  user_id = get_account_owner_id() AND the flag AND reports_can_access(user_id) (owner or a team
  member with billing access, same rule as Reports / Data Platform).

  Refresh window: rework creates a LATER job that changes an earlier day's first-time-fix numbers, so
  the cron rebuilds the trailing 90 days every night. Older days are frozen.

  Runs on a fresh database and on the current schema (all statements idempotent). Index builds take a
  short lock on jobs/quotes/invoices; on a very large tenant base create them CONCURRENTLY by hand first
  (same names, IF NOT EXISTS makes this migration skip them).

  ROLLBACK (manual, destructive to analytics data only): see the comment block at the end of this file.
*/

-- =============================================================
-- FLAG (default OFF)
-- =============================================================
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('analytics_layer', 'Analytics layer',
        'Governed KPI dashboard, CSV export, weekly digest and anomaly alerts. Default OFF; enable per account with an override.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.analytics_feature_on(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_owner, f.key)
    FROM public.feature_flags f
    LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_owner
    WHERE f.key = 'analytics_layer'
  ), false);
$$;
REVOKE ALL ON FUNCTION public.analytics_feature_on(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.analytics_feature_on(uuid) TO authenticated, service_role;

-- =============================================================
-- SOURCE-TABLE INDEXES (support the refresh + AR queries)
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_jobs_analytics_completed
  ON public.jobs (user_id, (COALESCE(completed_at, scheduled_datetime, created_at)))
  WHERE job_status = 'completed';
CREATE INDEX IF NOT EXISTS idx_quotes_analytics_sent
  ON public.quotes (user_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_analytics_open
  ON public.invoices (user_id) WHERE status IN ('sent', 'viewed');
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
  ON public.invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_job_cost_entries_job
  ON public.job_cost_entries (job_id);

-- =============================================================
-- ROLLUPS (additive components; ratios are computed from sums, never stored)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.analytics_daily_rollups (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  technician_id uuid,
  technician_key uuid GENERATED ALWAYS AS (COALESCE(technician_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  jobs_completed integer NOT NULL DEFAULT 0 CHECK (jobs_completed >= 0),
  jobs_reworked integer NOT NULL DEFAULT 0 CHECK (jobs_reworked >= 0),
  rework_jobs integer NOT NULL DEFAULT 0 CHECK (rework_jobs >= 0),
  billed_jobs integer NOT NULL DEFAULT 0 CHECK (billed_jobs >= 0),
  revenue_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),
  costed_jobs integer NOT NULL DEFAULT 0 CHECK (costed_jobs >= 0),
  costed_revenue_cents bigint NOT NULL DEFAULT 0 CHECK (costed_revenue_cents >= 0),
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  scheduled_minutes bigint NOT NULL DEFAULT 0 CHECK (scheduled_minutes >= 0),
  quotes_sent integer NOT NULL DEFAULT 0 CHECK (quotes_sent >= 0),
  quotes_accepted integer NOT NULL DEFAULT 0 CHECK (quotes_accepted >= 0),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, technician_key)
);

ALTER TABLE public.analytics_daily_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "analytics_rollups_select" ON public.analytics_daily_rollups;
CREATE POLICY "analytics_rollups_select" ON public.analytics_daily_rollups FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.analytics_feature_on(user_id) AND public.reports_can_access(user_id));
-- No INSERT/UPDATE/DELETE policies: only the SECURITY DEFINER refresh functions write.

-- =============================================================
-- SETTINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.analytics_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  hours_per_day numeric(4, 2) NOT NULL DEFAULT 8 CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  digest_enabled boolean NOT NULL DEFAULT false,
  digest_cadence text NOT NULL DEFAULT 'weekly' CHECK (digest_cadence IN ('weekly', 'monthly')),
  digest_last_sent_at timestamptz,
  alerts_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.analytics_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "analytics_settings_select" ON public.analytics_settings;
CREATE POLICY "analytics_settings_select" ON public.analytics_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.analytics_feature_on(user_id) AND public.reports_can_access(user_id));
-- Writes go through the analytics-query edge function (owner only, validated).

-- =============================================================
-- ALERTS (idempotent per account + metric + period)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.analytics_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('first_time_fix_rate', 'callback_rate', 'revenue_per_technician', 'job_profitability', 'utilization', 'quote_conversion')),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  direction text NOT NULL CHECK (direction IN ('up', 'down')),
  bad boolean NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  value bigint NOT NULL,
  baseline_mean bigint NOT NULL,
  z numeric(8, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (user_id, metric, period_start)
);
CREATE INDEX IF NOT EXISTS idx_analytics_alerts_user ON public.analytics_alerts (user_id, created_at DESC);

ALTER TABLE public.analytics_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "analytics_alerts_select" ON public.analytics_alerts;
CREATE POLICY "analytics_alerts_select" ON public.analytics_alerts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.analytics_feature_on(user_id) AND public.reports_can_access(user_id));

-- =============================================================
-- EVENTS (PII-free; allow-list enforced in code AND by constraints here)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name IN ('dashboard_viewed', 'metric_drilldown', 'csv_exported', 'digest_toggled', 'anomaly_alert_opened')),
  props jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(props) = 'object' AND pg_column_size(props) <= 512),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON public.analytics_events (user_id, created_at DESC);
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_events FROM anon, authenticated; -- service role only (edge function)

-- =============================================================
-- REFRESH
-- =============================================================
CREATE OR REPLACE FUNCTION public.analytics_refresh_rollups(p_owner uuid, p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a integer := 0;
  v_b integer := 0;
  v_from_ts timestamptz;
  v_to_ts timestamptz;
BEGIN
  IF p_owner IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'analytics_refresh_rollups: invalid arguments';
  END IF;
  IF p_to - p_from > 800 THEN
    RAISE EXCEPTION 'analytics_refresh_rollups: range too large (max 800 days)';
  END IF;
  -- One refresh per account at a time (cron + first-view backfill can overlap).
  PERFORM pg_advisory_xact_lock(hashtextextended('analytics_refresh:' || p_owner::text, 0));

  v_from_ts := p_from::timestamp AT TIME ZONE 'UTC';
  v_to_ts := (p_to + 1)::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.analytics_daily_rollups WHERE user_id = p_owner AND day BETWEEN p_from AND p_to;

  INSERT INTO public.analytics_daily_rollups (
    user_id, day, technician_id, jobs_completed, jobs_reworked, rework_jobs, billed_jobs, revenue_cents,
    costed_jobs, costed_revenue_cents, cost_cents, scheduled_minutes
  )
  WITH j AS (
    SELECT jb.id,
           jb.assigned_technician_id AS tech,
           (COALESCE(jb.completed_at, jb.scheduled_datetime, jb.created_at) AT TIME ZONE 'UTC')::date AS d,
           COALESCE(jb.is_rework, false) AS is_rework,
           COALESCE(jb.invoice_amount, 0) AS amt,
           COALESCE(jb.duration_minutes, 0) AS dur,
           EXISTS (SELECT 1 FROM public.jobs c WHERE c.rework_of_job_id = jb.id AND c.user_id = jb.user_id) AS was_reworked
    FROM public.jobs jb
    WHERE jb.user_id = p_owner
      AND jb.job_status = 'completed'
      AND COALESCE(jb.completed_at, jb.scheduled_datetime, jb.created_at) >= v_from_ts
      AND COALESCE(jb.completed_at, jb.scheduled_datetime, jb.created_at) < v_to_ts
  ), costs AS (
    SELECT e.job_id, SUM(COALESCE(e.total_cost_cents, 0))::bigint AS cost
    FROM public.job_cost_entries e
    WHERE e.job_id IN (SELECT id FROM j)
    GROUP BY e.job_id
  )
  SELECT p_owner, j.d, j.tech,
         count(*)::integer,
         count(*) FILTER (WHERE j.was_reworked)::integer,
         count(*) FILTER (WHERE j.is_rework)::integer,
         count(*) FILTER (WHERE j.amt > 0)::integer,
         COALESCE(sum(round(j.amt * 100)) FILTER (WHERE j.amt > 0), 0)::bigint,
         count(*) FILTER (WHERE j.amt > 0 AND c.job_id IS NOT NULL)::integer,
         COALESCE(sum(round(j.amt * 100)) FILTER (WHERE j.amt > 0 AND c.job_id IS NOT NULL), 0)::bigint,
         COALESCE(sum(c.cost) FILTER (WHERE j.amt > 0 AND c.job_id IS NOT NULL), 0)::bigint,
         COALESCE(sum(j.dur), 0)::bigint
  FROM j LEFT JOIN costs c ON c.job_id = j.id
  GROUP BY j.d, j.tech;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  -- Quotes are attributed to the day they were SENT; they have no technician (NULL key row).
  INSERT INTO public.analytics_daily_rollups (user_id, day, technician_id, quotes_sent, quotes_accepted)
  SELECT p_owner, (q.sent_at AT TIME ZONE 'UTC')::date, NULL::uuid,
         count(*)::integer, count(*) FILTER (WHERE q.status = 'accepted')::integer
  FROM public.quotes q
  WHERE q.user_id = p_owner AND q.sent_at IS NOT NULL AND q.sent_at >= v_from_ts AND q.sent_at < v_to_ts
  GROUP BY 2
  ON CONFLICT (user_id, day, technician_key)
  DO UPDATE SET quotes_sent = EXCLUDED.quotes_sent, quotes_accepted = EXCLUDED.quotes_accepted, refreshed_at = now();
  GET DIAGNOSTICS v_b = ROW_COUNT;

  RETURN v_a + v_b;
END;
$$;
REVOKE ALL ON FUNCTION public.analytics_refresh_rollups(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_refresh_rollups(uuid, date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.analytics_refresh_all(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_n integer := 0;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 800 THEN
    RAISE EXCEPTION 'analytics_refresh_all: p_days must be 1..800';
  END IF;
  FOR r IN SELECT p.id FROM public.profiles p WHERE public.analytics_feature_on(p.id) LOOP
    BEGIN
      PERFORM public.analytics_refresh_rollups(r.id, v_today - p_days, v_today);
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      -- One bad account must never block the others.
      RAISE WARNING 'analytics_refresh_all: account % failed: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.analytics_refresh_all(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_refresh_all(integer) TO service_role;

-- Nightly 02:30 UTC refresh of the trailing 90 days (needs pg_cron; otherwise call it from any scheduler).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-analytics-refresh', '30 2 * * *', 'select public.analytics_refresh_all(90)');
  ELSE
    RAISE NOTICE 'pg_cron not enabled: call select public.analytics_refresh_all(90) nightly from an external scheduler.';
  END IF;
END $$;

-- =============================================================
-- READ HELPERS (service role; the edge function scopes by the verified owner id)
-- =============================================================
CREATE OR REPLACE FUNCTION public.analytics_tech_capacity(p_owner uuid)
RETURNS TABLE (technician_id uuid, technician_name text, working_days smallint[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- ASSUMPTION (documented): a technician is a team member who has been assigned at least one job.
  SELECT tm.id, COALESCE(NULLIF(btrim(tm.member_name), ''), 'Technician'),
         COALESCE(ta.working_days, '{0,1,2,3,4,5,6}'::smallint[])
  FROM public.team_members tm
  LEFT JOIN public.technician_availability ta ON ta.technician_id = tm.id
  WHERE tm.account_owner_id = p_owner
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.assigned_technician_id = tm.id AND j.user_id = p_owner);
$$;
REVOKE ALL ON FUNCTION public.analytics_tech_capacity(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_tech_capacity(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.analytics_ar_open_invoices(p_owner uuid)
RETURNS TABLE (due_date date, balance_cents bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- No customer name / email / invoice number leaves this function: AR aging needs only date + amount.
  -- Refunds are not netted (documented limitation).
  SELECT i.due_date,
         GREATEST(public.invoice_total_cents(i.line_items, i.tax_percent) - COALESCE(pay.paid, 0), 0)::bigint
  FROM public.invoices i
  LEFT JOIN LATERAL (SELECT SUM(p.amount_cents)::bigint AS paid FROM public.invoice_payments p WHERE p.invoice_id = i.id) pay ON true
  WHERE i.user_id = p_owner AND i.status IN ('sent', 'viewed');
$$;
REVOKE ALL ON FUNCTION public.analytics_ar_open_invoices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_ar_open_invoices(uuid) TO service_role;

/* ROLLBACK (manual; removes analytics data only, never touches jobs/quotes/invoices):
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN PERFORM cron.unschedule('vireek-analytics-refresh'); END IF;
END $$;
DROP FUNCTION IF EXISTS public.analytics_ar_open_invoices(uuid);
DROP FUNCTION IF EXISTS public.analytics_tech_capacity(uuid);
DROP FUNCTION IF EXISTS public.analytics_refresh_all(integer);
DROP FUNCTION IF EXISTS public.analytics_refresh_rollups(uuid, date, date);
DROP TABLE IF EXISTS public.analytics_events, public.analytics_alerts, public.analytics_settings, public.analytics_daily_rollups;
DROP FUNCTION IF EXISTS public.analytics_feature_on(uuid);
DELETE FROM public.feature_flags WHERE key = 'analytics_layer';
DROP INDEX IF EXISTS public.idx_jobs_analytics_completed, public.idx_quotes_analytics_sent, public.idx_invoices_analytics_open;
-- idx_invoice_payments_invoice / idx_job_cost_entries_job are generally useful: keep them.
*/
