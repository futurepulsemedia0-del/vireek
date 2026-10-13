/*
  # Executive Monthly Report — auto-generated PDF + email to owners

  ## Tables
  - executive_report_settings   one row per account owner (opt-in: no row = no emails)
  - executive_reports           one row per account per month (idempotent), metrics + commentary + PDF path
  - executive_report_deliveries per-recipient send log (prevents duplicate emails on retries)

  ## Security
  - RLS: owners read/write only their own settings, read only their own reports/deliveries.
  - Reports/deliveries are written by the `executive-report-run` edge function (service role).
  - Private storage bucket `executive-reports`; files live under "<user_id>/<YYYY-MM>.pdf".

  ## Cron (run once in the Supabase SQL editor — see bottom of this file)
*/

CREATE TABLE IF NOT EXISTS executive_report_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  send_day smallint NOT NULL DEFAULT 1 CHECK (send_day BETWEEN 1 AND 28),
  send_hour smallint NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'America/New_York',
  include_owner boolean NOT NULL DEFAULT true,
  include_co_owners boolean NOT NULL DEFAULT true,
  extra_recipients text[] NOT NULL DEFAULT '{}' CHECK (cardinality(extra_recipients) <= 10),
  ai_commentary_enabled boolean NOT NULL DEFAULT true,
  revenue_goal numeric CHECK (revenue_goal IS NULL OR revenue_goal >= 0),
  jobs_goal integer CHECK (jobs_goal IS NULL OR jobs_goal >= 0),
  close_rate_goal_pct numeric CHECK (close_rate_goal_pct IS NULL OR close_rate_goal_pct BETWEEN 0 AND 100),
  margin_goal_pct numeric CHECK (margin_goal_pct IS NULL OR margin_goal_pct BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exec_report_settings_enabled ON executive_report_settings(enabled) WHERE enabled;

CREATE OR REPLACE FUNCTION executive_report_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_exec_report_settings_guard ON executive_report_settings;
CREATE TRIGGER trg_exec_report_settings_guard
  BEFORE INSERT OR UPDATE ON executive_report_settings
  FOR EACH ROW EXECUTE FUNCTION executive_report_settings_guard();

CREATE TABLE IF NOT EXISTS executive_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  period_label text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'partial', 'failed')),
  trigger text NOT NULL DEFAULT 'scheduled' CHECK (trigger IN ('scheduled', 'manual')),
  metrics jsonb NOT NULL,
  commentary jsonb NOT NULL,
  commentary_source text NOT NULL DEFAULT 'deterministic' CHECK (commentary_source IN ('ai', 'deterministic')),
  pdf_path text,
  send_attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_exec_reports_user_period ON executive_reports(user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS executive_report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES executive_reports(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  attempts smallint NOT NULL DEFAULT 1,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, email)
);

CREATE INDEX IF NOT EXISTS idx_exec_deliveries_report ON executive_report_deliveries(report_id);

-- ---------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------
ALTER TABLE executive_report_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE executive_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE executive_report_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exec_settings_select_own" ON executive_report_settings;
CREATE POLICY "exec_settings_select_own" ON executive_report_settings FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "exec_settings_insert_own" ON executive_report_settings;
CREATE POLICY "exec_settings_insert_own" ON executive_report_settings FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "exec_settings_update_own" ON executive_report_settings;
CREATE POLICY "exec_settings_update_own" ON executive_report_settings FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "exec_reports_select_own" ON executive_reports;
CREATE POLICY "exec_reports_select_own" ON executive_reports FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "exec_deliveries_select_own" ON executive_report_deliveries;
CREATE POLICY "exec_deliveries_select_own" ON executive_report_deliveries FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ---------------------------------------------------------------
-- Private storage for the generated PDFs
-- ---------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('executive-reports', 'executive-reports', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "exec_reports_pdf_read_own" ON storage.objects;
CREATE POLICY "exec_reports_pdf_read_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'executive-reports' AND (storage.foldername(name))[1] = auth.uid()::text);

/*
## Cron — run ONCE in the Supabase SQL editor (pg_cron + pg_net enabled).
Replace <project-ref> and <CRON_SECRET> (same value as the EXECUTIVE_REPORT_CRON_SECRET function secret).
Hourly is intentional: each owner's send_day/send_hour is evaluated in their own time zone.

  select cron.schedule('executive-report-hourly', '5 * * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/executive-report-run',
      headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
      body := jsonb_build_object('action','sweep')
    ); $$);
*/
