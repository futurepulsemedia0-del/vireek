/*
  # Scheduled reports — email saved reports weekly / monthly (/dashboard/reports/scheduled)

  ## Requires
  20270415000000_saved_reports.sql (saved_reports + public.reports_can_access),
  public.get_account_owner_id(), profiles, team_members.

  ## What this does
  - scheduled_reports: one row per schedule (report, cadence, timezone, recipients).
    Scoped to the ACCOUNT OWNER (user_id); same permission gate as saved reports
    (owner, or team member with can_view_billing) enforced here in RLS.
  - scheduled_report_deliveries: append-only delivery log. Clients can only READ it;
    only the edge function (service role) writes.
  - next_run_at is computed by the DATABASE (scheduled_report_next_run) in the
    schedule's own IANA timezone, so DST is always right and the app has no
    duplicate date maths. Clients cannot write it (column-level grants).
  - scheduled_report_claim_due(): service_role only. Atomically claims due schedules
    (FOR UPDATE SKIP LOCKED), advances next_run_at BEFORE sending (at-most-once, no
    double emails when two ticks overlap), writes a 'pending' log row, and skips
    runs that are more than 48h late instead of sending a stale report.

  ## Scheduling (run once after deploying the edge function `scheduled-reports-run`)
    Replace <project-ref>, <service-role-key>, <CRON_SECRET>.

    select cron.schedule('scheduled-reports-tick', '*/10 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/scheduled-reports-run',
        headers := jsonb_build_object('Content-Type','application/json',
                                      'Authorization','Bearer <service-role-key>',
                                      'X-Cron-Secret','<CRON_SECRET>'),
        body := jsonb_build_object('action','tick')
      );
    $$);
*/

-- =============================================================
-- 1. Next-run calculator (timezone + DST aware, single source of truth)
-- =============================================================
CREATE OR REPLACE FUNCTION public.scheduled_report_next_run(
  p_frequency text,
  p_weekday int,
  p_month_day int,
  p_send_hour int,
  p_tz text,
  p_after timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  local_after timestamp;
  d date;
  candidate timestamp;
BEGIN
  local_after := p_after AT TIME ZONE p_tz;

  IF p_frequency = 'weekly' THEN
    d := local_after::date + ((p_weekday - extract(dow FROM local_after)::int + 7) % 7);
    candidate := d + make_interval(hours => p_send_hour);
    IF candidate <= local_after THEN
      candidate := candidate + interval '7 days';
    END IF;
  ELSE
    d := make_date(extract(year FROM local_after)::int, extract(month FROM local_after)::int, p_month_day);
    candidate := d + make_interval(hours => p_send_hour);
    IF candidate <= local_after THEN
      d := (date_trunc('month', local_after) + interval '1 month')::date + (p_month_day - 1);
      candidate := d + make_interval(hours => p_send_hour);
    END IF;
  END IF;

  RETURN candidate AT TIME ZONE p_tz;
END;
$$;

-- =============================================================
-- 2. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  report_id uuid NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  weekday smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday
  month_day smallint NOT NULL DEFAULT 1 CHECK (month_day BETWEEN 1 AND 28),
  send_hour smallint NOT NULL DEFAULT 8 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  recipients text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 10),
  include_csv boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('sent', 'partial', 'failed', 'skipped')),
  consecutive_failures int NOT NULL DEFAULT 0,
  paused_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_user ON scheduled_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_due ON scheduled_reports (next_run_at) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_report ON scheduled_reports (report_id);

CREATE TABLE IF NOT EXISTS scheduled_report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES scheduled_reports(id) ON DELETE SET NULL,
  report_name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'partial', 'failed', 'skipped')),
  scheduled_for timestamptz,
  recipients_total int NOT NULL DEFAULT 0,
  recipients_sent int NOT NULL DEFAULT 0,
  row_count int,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_srd_user_created ON scheduled_report_deliveries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_srd_schedule_created ON scheduled_report_deliveries (schedule_id, created_at DESC);

-- =============================================================
-- 3. Validation + next_run_at trigger
-- =============================================================
CREATE OR REPLACE FUNCTION public.scheduled_reports_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  addr text;
  cleaned text[] := ARRAY[]::text[];
  cadence_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
  ELSE
    IF (SELECT count(*) FROM scheduled_reports WHERE user_id = NEW.user_id) >= 25 THEN
      RAISE EXCEPTION 'Schedule limit reached (25 per account).' USING ERRCODE = '54000';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM saved_reports WHERE id = NEW.report_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Report not found for this account.' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;

  FOREACH addr IN ARRAY NEW.recipients LOOP
    addr := lower(btrim(addr));
    IF char_length(addr) > 254 OR addr !~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+\.[^@[:space:],;<>]+$' THEN
      RAISE EXCEPTION 'Invalid recipient email: %', addr USING ERRCODE = '22023';
    END IF;
    IF NOT addr = ANY(cleaned) THEN
      cleaned := cleaned || addr;
    END IF;
  END LOOP;
  NEW.recipients := cleaned;

  -- NOTE: OLD does not exist on INSERT and plpgsql does not short-circuit, so branch explicitly.
  IF TG_OP = 'INSERT' THEN
    cadence_changed := true;
  ELSE
    cadence_changed := NEW.frequency IS DISTINCT FROM OLD.frequency
      OR NEW.weekday IS DISTINCT FROM OLD.weekday
      OR NEW.month_day IS DISTINCT FROM OLD.month_day
      OR NEW.send_hour IS DISTINCT FROM OLD.send_hour
      OR NEW.timezone IS DISTINCT FROM OLD.timezone
      OR (NEW.is_active AND NOT OLD.is_active);

    IF NEW.is_active AND NOT OLD.is_active THEN
      NEW.consecutive_failures := 0;
      NEW.paused_reason := NULL;
    END IF;
  END IF;

  IF cadence_changed THEN
    NEW.next_run_at := public.scheduled_report_next_run(NEW.frequency, NEW.weekday, NEW.month_day, NEW.send_hour, NEW.timezone, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scheduled_reports_before_write ON scheduled_reports;
CREATE TRIGGER trg_scheduled_reports_before_write
  BEFORE INSERT OR UPDATE ON scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_reports_before_write();

-- =============================================================
-- 4. RLS + column-level grants
-- =============================================================
ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_report_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON scheduled_reports FROM anon, authenticated;
REVOKE ALL ON scheduled_report_deliveries FROM anon, authenticated;

-- Clients may only touch the user-editable columns; run state is server-owned.
GRANT SELECT, DELETE ON scheduled_reports TO authenticated;
GRANT INSERT (user_id, report_id, frequency, weekday, month_day, send_hour, timezone, recipients, include_csv, is_active)
  ON scheduled_reports TO authenticated;
GRANT UPDATE (report_id, frequency, weekday, month_day, send_hour, timezone, recipients, include_csv, is_active)
  ON scheduled_reports TO authenticated;
GRANT SELECT ON scheduled_report_deliveries TO authenticated;

DROP POLICY IF EXISTS "select_scheduled_reports" ON scheduled_reports;
CREATE POLICY "select_scheduled_reports" ON scheduled_reports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "insert_scheduled_reports" ON scheduled_reports;
CREATE POLICY "insert_scheduled_reports" ON scheduled_reports FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS "update_scheduled_reports" ON scheduled_reports;
CREATE POLICY "update_scheduled_reports" ON scheduled_reports FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id))
  WITH CHECK (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "delete_scheduled_reports" ON scheduled_reports;
CREATE POLICY "delete_scheduled_reports" ON scheduled_reports FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "select_scheduled_report_deliveries" ON scheduled_report_deliveries;
CREATE POLICY "select_scheduled_report_deliveries" ON scheduled_report_deliveries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

-- =============================================================
-- 5. Claim due schedules (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.scheduled_report_claim_due(p_limit int DEFAULT 20)
RETURNS TABLE (o_delivery_id uuid, o_schedule_id uuid, o_scheduled_for timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r scheduled_reports%ROWTYPE;
  rname text;
  did uuid;
BEGIN
  -- A run that never reported back (crash / timeout) must not stay "pending" forever.
  UPDATE scheduled_report_deliveries
     SET status = 'failed', error = 'Timed out before completion', finished_at = now()
   WHERE status = 'pending' AND created_at < now() - interval '15 minutes';

  FOR r IN
    SELECT * FROM scheduled_reports
     WHERE is_active AND next_run_at IS NOT NULL AND next_run_at <= now()
     ORDER BY next_run_at
     LIMIT GREATEST(1, LEAST(p_limit, 100))
     FOR UPDATE SKIP LOCKED
  LOOP
    SELECT name INTO rname FROM saved_reports WHERE id = r.report_id;

    -- Advance first: even if this tick dies mid-send, the schedule is never re-sent in a loop.
    UPDATE scheduled_reports
       SET next_run_at = public.scheduled_report_next_run(r.frequency, r.weekday, r.month_day, r.send_hour, r.timezone, now())
     WHERE id = r.id;

    IF r.next_run_at < now() - interval '48 hours' THEN
      INSERT INTO scheduled_report_deliveries (user_id, schedule_id, report_name, trigger, status, scheduled_for, recipients_total, error, finished_at)
      VALUES (r.user_id, r.id, COALESCE(rname, 'Report'), 'schedule', 'skipped', r.next_run_at, cardinality(r.recipients),
              'Missed run window (over 48 hours late) — skipped instead of sending stale data.', now());
      CONTINUE;
    END IF;

    INSERT INTO scheduled_report_deliveries (user_id, schedule_id, report_name, trigger, status, scheduled_for, recipients_total)
    VALUES (r.user_id, r.id, COALESCE(rname, 'Report'), 'schedule', 'pending', r.next_run_at, cardinality(r.recipients))
    RETURNING id INTO did;

    o_delivery_id := did;
    o_schedule_id := r.id;
    o_scheduled_for := r.next_run_at;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.scheduled_report_claim_due(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_report_claim_due(int) TO service_role;

COMMENT ON TABLE scheduled_reports IS 'Email schedules for saved reports (weekly/monthly, per-schedule timezone). next_run_at is DB-computed.';
COMMENT ON TABLE scheduled_report_deliveries IS 'Append-only delivery log for scheduled and manual report emails. Written by the scheduled-reports-run edge function only.';
