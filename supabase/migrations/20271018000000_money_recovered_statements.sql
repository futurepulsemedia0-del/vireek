/*
  # Weekly "Money Recovered" statement (extends the Missed-Revenue Recovery Ledger)

  ## Why
  The ledger (revenue_recovery_events) tracks every lost opportunity and what was won back, but
  owners never receive a periodic, defensible "here is what Vireek earned you" statement. This
  adds the storage for that statement. It does NOT create a parallel ledger: every number comes
  from revenue_recovery_events, attributed by the shared engine
  (supabase/functions/_shared/money-recovered/engine.ts, method "conservative-v1").

  ## Tables
  - money_recovered_settings    one row per account owner (opt-in: no row / enabled=false = no emails)
  - money_recovered_baselines   append-only history of the baseline Leak Report figure (monthly $)
  - money_recovered_statements  one immutable snapshot per account per Monday-start week
  - money_recovered_deliveries  per-recipient send log (prevents duplicate emails on retries)

  ## Security
  - RLS keyed to get_account_owner_id() + reports_can_access() (owner, or team member with
    can_view_billing) — same gate as saved/scheduled reports.
  - Only the account OWNER can change settings or record a baseline.
  - Baselines are append-only (no UPDATE/DELETE policy): a baseline cannot be quietly moved after
    the fact to make a week look better. The newest row wins; captured_at is shown on every statement.
  - Statements and deliveries are written only by the `money-recovered-run` edge function (service role).

  ## Requires
  20260922000000 (revenue_recovery_events), 20270415000000 (reports_can_access), profiles.

  ## Cron — run ONCE in the Supabase SQL editor (pg_cron + pg_net enabled)
  Replace <project-ref> and <CRON_SECRET> (same value as the MONEY_RECOVERED_CRON_SECRET function secret).
  Hourly on purpose: each owner's send hour is evaluated in their own time zone.

    select cron.schedule('money-recovered-hourly', '10 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/money-recovered-run',
        headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
        body := jsonb_build_object('action','sweep')
      ); $$);
*/

-- =============================================================
-- 1. Settings (opt-in)
-- =============================================================
CREATE TABLE IF NOT EXISTS money_recovered_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  send_hour smallint NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'America/New_York',
  include_owner boolean NOT NULL DEFAULT true,
  include_co_owners boolean NOT NULL DEFAULT true,
  extra_recipients text[] NOT NULL DEFAULT '{}' CHECK (cardinality(extra_recipients) <= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_money_recovered_settings_enabled ON money_recovered_settings(enabled) WHERE enabled;

CREATE OR REPLACE FUNCTION money_recovered_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_money_recovered_settings_guard ON money_recovered_settings;
CREATE TRIGGER trg_money_recovered_settings_guard
  BEFORE INSERT OR UPDATE ON money_recovered_settings
  FOR EACH ROW EXECUTE FUNCTION money_recovered_settings_guard();

-- =============================================================
-- 2. Baseline Leak Report figure (append-only)
-- =============================================================
CREATE TABLE IF NOT EXISTS money_recovered_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  monthly_leak_cents integer NOT NULL CHECK (monthly_leak_cents > 0 AND monthly_leak_cents <= 100000000000),
  source text NOT NULL DEFAULT 'leak_report' CHECK (source IN ('leak_report', 'calculator', 'manual')),
  label text CHECK (label IS NULL OR char_length(label) <= 120),
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL DEFAULT auth.uid()
);

CREATE INDEX IF NOT EXISTS idx_money_recovered_baselines_user ON money_recovered_baselines(user_id, captured_at DESC);

-- =============================================================
-- 3. Statements (immutable weekly snapshots) + deliveries
-- =============================================================
CREATE TABLE IF NOT EXISTS money_recovered_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  week_end date NOT NULL,
  period_label text NOT NULL,
  method_version text NOT NULL,
  credited_cents bigint NOT NULL DEFAULT 0 CHECK (credited_cents >= 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 524288),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'partial', 'failed')),
  trigger text NOT NULL DEFAULT 'scheduled' CHECK (trigger IN ('scheduled', 'manual')),
  send_attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_money_recovered_statements_user ON money_recovered_statements(user_id, week_start DESC);

CREATE TABLE IF NOT EXISTS money_recovered_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES money_recovered_statements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  attempts smallint NOT NULL DEFAULT 1,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_id, email)
);

CREATE INDEX IF NOT EXISTS idx_money_recovered_deliveries_statement ON money_recovered_deliveries(statement_id);

-- =============================================================
-- 4. RLS
-- =============================================================
ALTER TABLE money_recovered_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_recovered_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_recovered_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_recovered_deliveries ENABLE ROW LEVEL SECURITY;

-- Read: the account owner, or a team member with can_view_billing.
DROP POLICY IF EXISTS "mrs_select" ON money_recovered_settings;
CREATE POLICY "mrs_select" ON money_recovered_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));
DROP POLICY IF EXISTS "mrb_select" ON money_recovered_baselines;
CREATE POLICY "mrb_select" ON money_recovered_baselines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));
DROP POLICY IF EXISTS "mrst_select" ON money_recovered_statements;
CREATE POLICY "mrst_select" ON money_recovered_statements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));
DROP POLICY IF EXISTS "mrd_select" ON money_recovered_deliveries;
CREATE POLICY "mrd_select" ON money_recovered_deliveries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

-- Write: owner only. Baselines are insert-only (append-only history).
DROP POLICY IF EXISTS "mrs_insert" ON money_recovered_settings;
CREATE POLICY "mrs_insert" ON money_recovered_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "mrs_update" ON money_recovered_settings;
CREATE POLICY "mrs_update" ON money_recovered_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "mrb_insert" ON money_recovered_baselines;
CREATE POLICY "mrb_insert" ON money_recovered_baselines FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND created_by = auth.uid());
-- No client policies on statements / deliveries beyond SELECT: only the service role writes them.
