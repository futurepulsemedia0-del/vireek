/*
  # Leak Report onboarding mode

  Measures, during a customer's first N days (default 7) and WITHOUT changing their phone setup,
  answer rate, missed / after-hours volume by hour and day, time to first response and estimated
  revenue lost. Call events arrive from call-tracking webhooks, forwarded copies or CSV import.

  ## Tables
  - leak_report_settings     one row per account (mode on/off, window start, timezone, assumptions)
  - leak_report_sources      one row per webhook endpoint (token HASH only)
  - leak_report_call_events  observed calls (phone stored as digits only), immutable

  ## Security
  Everything is scoped by account_owner_id = public.get_account_owner_id(); writes need
  public.identity_is_manager(). The edge function uses the service role.

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles
*/

-- 1. Settings --------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leak_report_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  window_days integer NOT NULL DEFAULT 7 CHECK (window_days BETWEEN 3 AND 14),
  timezone text NOT NULL DEFAULT 'America/New_York',
  avg_ticket_cents integer CHECK (avg_ticket_cents IS NULL OR (avg_ticket_cents > 0 AND avg_ticket_cents <= 100000000)),
  close_rate_bps integer NOT NULL DEFAULT 3000 CHECK (close_rate_bps BETWEEN 100 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.leak_report_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id THEN
      RAISE EXCEPTION 'account_owner_id is immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  IF NEW.enabled AND NEW.started_at IS NULL THEN
    NEW.started_at := now();
  END IF;
  IF NEW.started_at IS NOT NULL AND NEW.started_at < now() - interval '30 days' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'started_at cannot be more than 30 days in the past' USING ERRCODE = '22023';
    ELSIF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'started_at cannot be more than 30 days in the past' USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_leak_report_settings_guard ON leak_report_settings;
CREATE TRIGGER trg_leak_report_settings_guard BEFORE INSERT OR UPDATE ON leak_report_settings
  FOR EACH ROW EXECUTE FUNCTION public.leak_report_settings_guard();

ALTER TABLE leak_report_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leak_settings_select" ON leak_report_settings;
CREATE POLICY "leak_settings_select" ON leak_report_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "leak_settings_insert" ON leak_report_settings;
CREATE POLICY "leak_settings_insert" ON leak_report_settings FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "leak_settings_update" ON leak_report_settings;
CREATE POLICY "leak_settings_update" ON leak_report_settings FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 2. Sources (webhook endpoints) -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leak_report_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  kind text NOT NULL DEFAULT 'call_tracking' CHECK (kind IN ('call_tracking', 'forwarded_copy')),
  -- sha256 hex of the secret token. The token is generated in the browser, shown once, never stored.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (char_length(token_hint) = 4),
  enabled boolean NOT NULL DEFAULT true,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leak_sources_owner ON leak_report_sources(account_owner_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.leak_report_sources_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.token_hint IS DISTINCT FROM OLD.token_hint
     OR NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id THEN
    RAISE EXCEPTION 'token and owner are immutable; create a new source to rotate' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_leak_report_sources_guard ON leak_report_sources;
CREATE TRIGGER trg_leak_report_sources_guard BEFORE UPDATE ON leak_report_sources
  FOR EACH ROW EXECUTE FUNCTION public.leak_report_sources_guard();

ALTER TABLE leak_report_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leak_sources_select" ON leak_report_sources;
CREATE POLICY "leak_sources_select" ON leak_report_sources FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "leak_sources_insert" ON leak_report_sources;
CREATE POLICY "leak_sources_insert" ON leak_report_sources FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "leak_sources_update" ON leak_report_sources;
CREATE POLICY "leak_sources_update" ON leak_report_sources FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "leak_sources_delete" ON leak_report_sources;
CREATE POLICY "leak_sources_delete" ON leak_report_sources FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 3. Observed call events --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leak_report_call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  source_id uuid REFERENCES leak_report_sources(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  started_at timestamptz NOT NULL,
  answered boolean NOT NULL,
  is_voicemail boolean NOT NULL DEFAULT false,
  ring_seconds integer CHECK (ring_seconds IS NULL OR ring_seconds BETWEEN 0 AND 3600),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  -- digits only (US leading 1 removed); never a formatted number
  phone_key text CHECK (phone_key IS NULL OR phone_key ~ '^[0-9]{7,15}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leak_events_voicemail_not_answered CHECK (NOT (is_voicemail AND answered))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leak_events_dedupe ON leak_report_call_events(account_owner_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_leak_events_owner_time ON leak_report_call_events(account_owner_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_leak_events_source_received ON leak_report_call_events(source_id, received_at DESC);

ALTER TABLE leak_report_call_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leak_events_select" ON leak_report_call_events;
CREATE POLICY "leak_events_select" ON leak_report_call_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "leak_events_insert" ON leak_report_call_events;
CREATE POLICY "leak_events_insert" ON leak_report_call_events FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "leak_events_delete" ON leak_report_call_events;
CREATE POLICY "leak_events_delete" ON leak_report_call_events FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
