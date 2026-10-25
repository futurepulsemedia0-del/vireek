/*
  # Hidden Technician — leak ledger, auto-fix suggestions and measured recovery

  Turns unbilled technician hours into a per-cause ledger (drive, idle gap, parts run, no-show,
  callback, paperwork, waiting for approval) and tracks the hours each owner-approved fix really recovers.

  ## Tables
  - ht_settings   one row per account (hourly cost, paid hours, rule caps, time zone)
  - ht_leak_rows  one row per leaked segment, exactly one cause each (written only by ht_replace_ledger)
  - ht_fixes      suggestions -> approved/dismissed -> measured recovery (written only by RPCs)

  ## Security
  - Everything is scoped to the account owner: user_id = public.get_account_owner_id().
  - Owner/manager only: every policy and every RPC also requires public.identity_is_manager().
  - ht_leak_rows and ht_fixes have NO insert/update/delete policy: all writes go through the
    SECURITY DEFINER functions below, which re-validate technician, job and waitlist ownership.
  - No protected attributes are stored and nothing here ranks technicians.

  ## Requires (already in your project)
  profiles, team_members, jobs, capacity_waitlist_entries,
  public.get_account_owner_id(), public.identity_is_manager()

  Safe to re-run (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS).
*/

-- 1. Settings --------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ht_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  hourly_cost numeric(8,2) NOT NULL DEFAULT 84.40 CHECK (hourly_cost BETWEEN 1 AND 2000),
  paid_hours_per_day numeric(4,1) NOT NULL DEFAULT 8 CHECK (paid_hours_per_day BETWEEN 1 AND 16),
  drive_gap_cap_minutes integer NOT NULL DEFAULT 30 CHECK (drive_gap_cap_minutes BETWEEN 0 AND 240),
  paperwork_allowance_minutes integer NOT NULL DEFAULT 10 CHECK (paperwork_allowance_minutes BETWEEN 0 AND 60),
  parts_run_cap_minutes integer NOT NULL DEFAULT 90 CHECK (parts_run_cap_minutes BETWEEN 0 AND 240),
  time_zone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.ht_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.time_zone USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ht_settings_guard ON ht_settings;
CREATE TRIGGER trg_ht_settings_guard BEFORE INSERT OR UPDATE ON ht_settings
  FOR EACH ROW EXECUTE FUNCTION public.ht_settings_guard();

ALTER TABLE ht_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ht_settings_select" ON ht_settings;
CREATE POLICY "ht_settings_select" ON ht_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "ht_settings_insert" ON ht_settings;
CREATE POLICY "ht_settings_insert" ON ht_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "ht_settings_update" ON ht_settings;
CREATE POLICY "ht_settings_update" ON ht_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 2. Leak ledger -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ht_leak_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  leak_day date NOT NULL,
  cause text NOT NULL CHECK (cause IN ('drive', 'idle_gap', 'parts_run', 'no_show', 'callback', 'paperwork', 'waiting_approval')),
  hours numeric(8,4) NOT NULL CHECK (hours > 0 AND hours <= 24),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('measured', 'inferred', 'estimated')),
  rule text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_ht_leak_rows_user_day ON ht_leak_rows (user_id, leak_day);
CREATE INDEX IF NOT EXISTS idx_ht_leak_rows_tech_day ON ht_leak_rows (user_id, technician_id, leak_day);

ALTER TABLE ht_leak_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ht_leak_rows_select" ON ht_leak_rows;
CREATE POLICY "ht_leak_rows_select" ON ht_leak_rows FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 3. Fixes -----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ht_fixes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 3 AND 200),
  kind text NOT NULL CHECK (kind IN ('fill_gap', 'cluster_route', 'stage_parts', 'noshow_reminder', 'paperwork_capture')),
  cause text NOT NULL CHECK (cause IN ('drive', 'idle_gap', 'parts_run', 'no_show', 'callback', 'paperwork', 'waiting_approval')),
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  waitlist_entry_id uuid REFERENCES capacity_waitlist_entries(id) ON DELETE SET NULL,
  target_day date,
  window_start timestamptz,
  window_end timestamptz,
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'dismissed', 'measured', 'expired')),
  estimated_hours numeric(8,2) NOT NULL DEFAULT 0 CHECK (estimated_hours >= 0 AND estimated_hours <= 10000),
  baseline_hours_per_day numeric(8,3) CHECK (baseline_hours_per_day IS NULL OR (baseline_hours_per_day >= 0 AND baseline_hours_per_day <= 24)),
  recovered_hours numeric(8,2) CHECK (recovered_hours IS NULL OR (recovered_hours >= 0 AND recovered_hours <= 100000)),
  measure_method text CHECK (measure_method IS NULL OR measure_method IN ('direct_slot', 'baseline_delta')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8000),
  approved_by uuid,
  approved_at timestamptz,
  measured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ht_fixes_fingerprint UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_ht_fixes_user_status ON ht_fixes (user_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.ht_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ht_fixes_touch ON ht_fixes;
CREATE TRIGGER trg_ht_fixes_touch BEFORE UPDATE ON ht_fixes
  FOR EACH ROW EXECUTE FUNCTION public.ht_touch_updated_at();

ALTER TABLE ht_fixes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ht_fixes_select" ON ht_fixes;
CREATE POLICY "ht_fixes_select" ON ht_fixes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 4. RPC: replace the ledger for a date range (idempotent) ------------------------------------
CREATE OR REPLACE FUNCTION public.ht_replace_ledger(p_from date, p_to date, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR (p_to - p_from) > 62 THEN
    RAISE EXCEPTION 'Invalid date range (max 62 days)' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 20000 THEN
    RAISE EXCEPTION 'Too many rows (max 20000)' USING ERRCODE = '22023';
  END IF;

  DELETE FROM ht_leak_rows WHERE user_id = v_owner AND leak_day BETWEEN p_from AND p_to;

  INSERT INTO ht_leak_rows (user_id, technician_id, job_id, leak_day, cause, hours, starts_at, ends_at, confidence, rule)
  SELECT v_owner, tm.id, j.id, x.leak_day, x.cause, round(x.hours, 4), x.starts_at, x.ends_at, x.confidence, left(x.rule, 60)
  FROM jsonb_to_recordset(p_rows) AS x(
    technician_id uuid, job_id uuid, leak_day date, cause text, hours numeric,
    starts_at timestamptz, ends_at timestamptz, confidence text, rule text
  )
  JOIN team_members tm ON tm.id = x.technician_id AND tm.account_owner_id = v_owner
  LEFT JOIN jobs j ON j.id = x.job_id AND j.user_id = v_owner
  WHERE x.leak_day BETWEEN p_from AND p_to
    AND x.hours >= 0.001 AND x.hours <= 24
    AND x.ends_at > x.starts_at
    AND x.rule IS NOT NULL AND char_length(x.rule) >= 1;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.ht_replace_ledger(date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ht_replace_ledger(date, date, jsonb) TO authenticated;

-- 5. RPC: save new suggestions (duplicates are ignored, so a dismissed fix never comes back) ---
CREATE OR REPLACE FUNCTION public.ht_save_fixes(p_fixes jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_fixes IS NULL OR jsonb_typeof(p_fixes) <> 'array' THEN
    RAISE EXCEPTION 'p_fixes must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_fixes) > 200 THEN
    RAISE EXCEPTION 'Too many suggestions (max 200)' USING ERRCODE = '22023';
  END IF;

  UPDATE ht_fixes SET status = 'expired'
  WHERE user_id = v_owner AND status = 'suggested' AND target_day IS NOT NULL AND target_day < current_date;

  INSERT INTO ht_fixes (
    user_id, fingerprint, kind, cause, technician_id, waitlist_entry_id, target_day, window_start, window_end,
    estimated_hours, baseline_hours_per_day, title, detail
  )
  SELECT
    v_owner, left(x.fingerprint, 200), x.kind, x.cause, tm.id, w.id, x.target_day, x.window_start, x.window_end,
    least(greatest(coalesce(x.estimated_hours, 0), 0), 10000),
    CASE WHEN x.baseline_hours_per_day IS NULL THEN NULL ELSE least(greatest(x.baseline_hours_per_day, 0), 24) END,
    left(btrim(x.title), 160), CASE WHEN jsonb_typeof(x.detail) = 'object' THEN x.detail ELSE '{}'::jsonb END
  FROM jsonb_to_recordset(p_fixes) AS x(
    fingerprint text, kind text, cause text, technician_id uuid, waitlist_entry_id uuid, target_day date,
    window_start timestamptz, window_end timestamptz, estimated_hours numeric, baseline_hours_per_day numeric,
    title text, detail jsonb
  )
  LEFT JOIN team_members tm ON tm.id = x.technician_id AND tm.account_owner_id = v_owner
  LEFT JOIN capacity_waitlist_entries w ON w.id = x.waitlist_entry_id AND w.user_id = v_owner
  WHERE x.fingerprint IS NOT NULL AND char_length(x.fingerprint) >= 3
    AND x.title IS NOT NULL AND char_length(btrim(x.title)) >= 1
    AND x.kind IN ('fill_gap', 'cluster_route', 'stage_parts', 'noshow_reminder', 'paperwork_capture')
    AND x.cause IN ('drive', 'idle_gap', 'parts_run', 'no_show', 'callback', 'paperwork', 'waiting_approval')
    AND (x.technician_id IS NULL OR tm.id IS NOT NULL)
    AND (x.waitlist_entry_id IS NULL OR w.id IS NOT NULL)
    AND (x.kind <> 'fill_gap' OR (w.id IS NOT NULL AND x.window_start IS NOT NULL AND x.window_end IS NOT NULL AND x.window_end > x.window_start))
  ON CONFLICT (user_id, fingerprint) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.ht_save_fixes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ht_save_fixes(jsonb) TO authenticated;

-- 6. RPC: owner approves or dismisses a suggestion ---------------------------------------------
CREATE OR REPLACE FUNCTION public.ht_decide_fix(p_fix_id uuid, p_decision text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_fix ht_fixes%ROWTYPE;
  v_updated integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'dismiss') THEN
    RAISE EXCEPTION 'Decision must be approve or dismiss' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_fix FROM ht_fixes WHERE id = p_fix_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Suggestion not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_fix.status <> 'suggested' THEN
    RAISE EXCEPTION 'This suggestion was already decided' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'dismiss' THEN
    UPDATE ht_fixes SET status = 'dismissed' WHERE id = v_fix.id;
    RETURN;
  END IF;

  IF v_fix.kind = 'fill_gap' THEN
    IF v_fix.waitlist_entry_id IS NULL OR v_fix.window_start IS NULL THEN
      RAISE EXCEPTION 'This suggestion has no waitlist customer or slot' USING ERRCODE = '22023';
    END IF;
    IF v_fix.window_start <= now() THEN
      RAISE EXCEPTION 'This slot is already in the past' USING ERRCODE = '22023';
    END IF;
    UPDATE capacity_waitlist_entries
    SET status = 'offered',
        offered_slot = v_fix.window_start,
        offer_expires_at = least(now() + interval '24 hours', v_fix.window_start),
        updated_at = now()
    WHERE id = v_fix.waitlist_entry_id AND user_id = v_owner AND status = 'waiting';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'The waitlist customer is no longer waiting' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE ht_fixes SET status = 'approved', approved_by = auth.uid(), approved_at = now() WHERE id = v_fix.id;
END $$;

REVOKE ALL ON FUNCTION public.ht_decide_fix(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ht_decide_fix(uuid, text) TO authenticated;

-- 7. RPC: record MEASURED recovery for an approved fix -----------------------------------------
CREATE OR REPLACE FUNCTION public.ht_record_recovery(p_fix_id uuid, p_hours numeric, p_method text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
BEGIN
  IF v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_hours IS NULL OR p_hours < 0 OR p_hours > 100000 THEN
    RAISE EXCEPTION 'Invalid hours' USING ERRCODE = '22023';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('direct_slot', 'baseline_delta') THEN
    RAISE EXCEPTION 'Invalid method' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_status FROM ht_fixes WHERE id = p_fix_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Suggestion not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status NOT IN ('approved', 'measured') THEN
    RAISE EXCEPTION 'Only approved suggestions can be measured' USING ERRCODE = '22023';
  END IF;

  UPDATE ht_fixes
  SET recovered_hours = round(p_hours, 2), measure_method = p_method, status = 'measured', measured_at = now()
  WHERE id = p_fix_id AND user_id = v_owner;
END $$;

REVOKE ALL ON FUNCTION public.ht_record_recovery(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ht_record_recovery(uuid, numeric, text) TO authenticated;
