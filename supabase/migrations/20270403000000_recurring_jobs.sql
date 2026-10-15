/*
  # Recurring Jobs (maintenance agreements)

  ## What this adds
  - `recurring_agreements`: a maintenance agreement for one customer — what
    service, where, how often (every N weeks/months/years), at what local
    time and timezone, price, preferred technician, and whether to
    auto-invoice when each visit is completed.
  - `recurring_occurrences`: one row per visit the scheduler has handled
    (job created, skipped, or needing attention). Unique per
    (agreement, occurrence number) so the cron can never create a visit twice.
  - `recurring_occurrence_date()`: the single source of truth for date math.
    Occurrence N is ALWAYS `start_date + N * interval` computed from the
    anchor (never "previous + interval"), so a Jan 31 monthly agreement
    runs Jan 31, Feb 28, Mar 31 instead of drifting to the 28th forever.
    `src/lib/recurringJobs.ts` mirrors it for previews and is checked
    against this function's output in its test.
  - `generate_recurring_jobs()`: called by the `recurring-jobs-cron` edge
    function (service_role only). Creates real `jobs` rows inside each
    agreement's lead-time window. The existing double-booking exclusion
    constraint is respected: on a clash it tries later 30-minute slots the
    same local day, and if none fit it records `needs_attention` and
    notifies the owner instead of failing silently.
  - `skip_recurring_occurrence()`, `reschedule_recurring_occurrence()`,
    `cancel_recurring_agreement()`: the only way the dashboard changes
    visits (SECURITY DEFINER with explicit tenant + permission checks), so
    a visit, its job and its invoice state always change together.

  ## Security
  RLS scoped with `public.get_account_owner_id()` like every tenant table.
  Writes to agreements require `can_manage_recurring_jobs()` (owner, admin,
  or anyone with `can_view_billing`, incl. via custom role) — agreements
  carry pricing and auto-invoicing, so they follow the billing permission.
  Authenticated users cannot write occurrences directly; only the RPCs and
  the cron (service_role) can.

  ## Scheduling (run once after deploying `recurring-jobs-cron`)
    select cron.schedule('recurring-jobs-hourly', '7 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/recurring-jobs-cron',
        headers := jsonb_build_object('X-Cron-Secret', '<RECURRING_JOBS_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- PERMISSION HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_recurring_jobs()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.invite_status = 'active'
        AND (
          tm.role = 'admin'
          OR COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
          OR COALESCE((cr.permissions ->> 'can_view_billing')::boolean, false)
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_recurring_jobs() TO authenticated;

-- =============================================================
-- DATE MATH (single source of truth)
-- =============================================================

CREATE OR REPLACE FUNCTION public.recurring_occurrence_date(
  p_start date, p_unit text, p_count integer, p_n integer
) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_unit
    WHEN 'week'  THEN p_start + (p_n * p_count * 7)
    WHEN 'month' THEN (p_start + make_interval(months => p_n * p_count))::date
    WHEN 'year'  THEN (p_start + make_interval(years  => p_n * p_count))::date
  END;
$$;

-- =============================================================
-- AGREEMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS recurring_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 120),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 40),
  customer_email text CHECK (customer_email IS NULL OR char_length(customer_email) <= 200),
  address text NOT NULL CHECK (char_length(btrim(address)) BETWEEN 1 AND 300),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  service_type text CHECK (service_type IS NULL OR char_length(service_type) <= 80),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  interval_unit text NOT NULL CHECK (interval_unit IN ('week', 'month', 'year')),
  interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 52),
  start_date date NOT NULL,
  end_date date,
  preferred_time time NOT NULL DEFAULT '09:00',
  timezone text NOT NULL DEFAULT 'UTC',
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 1440),
  preferred_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  price_amount numeric(10,2) CHECK (price_amount IS NULL OR price_amount >= 0),
  auto_invoice boolean NOT NULL DEFAULT false,
  lead_time_days integer NOT NULL DEFAULT 14 CHECK (lead_time_days BETWEEN 1 AND 90),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  next_occurrence_n integer NOT NULL DEFAULT 0 CHECK (next_occurrence_n >= 0),
  last_generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_agreements_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT recurring_agreements_invoice_needs_price CHECK (NOT auto_invoice OR COALESCE(price_amount, 0) > 0)
);

CREATE INDEX IF NOT EXISTS idx_recurring_agreements_user_status ON recurring_agreements (user_id, status);
CREATE INDEX IF NOT EXISTS idx_recurring_agreements_active ON recurring_agreements (status) WHERE status = 'active';

-- Cross-row validation CHECK constraints can't express: valid IANA timezone,
-- and customer / technician must belong to the same account.
CREATE OR REPLACE FUNCTION public.validate_recurring_agreement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'invalid_timezone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'customer_not_in_account' USING ERRCODE = '42501';
  END IF;
  IF NEW.preferred_technician_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_members tm WHERE tm.id = NEW.preferred_technician_id AND tm.account_owner_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'technician_not_in_account' USING ERRCODE = '42501';
  END IF;
  -- Occurrence N is anchored to (start_date, interval). Changing the anchor
  -- after visits exist would silently re-map every future date, so it is
  -- locked once the first visit has been handled. Create a new agreement to
  -- change the schedule.
  IF TG_OP = 'UPDATE' AND OLD.next_occurrence_n > 0 AND (
    NEW.start_date IS DISTINCT FROM OLD.start_date
    OR NEW.interval_unit IS DISTINCT FROM OLD.interval_unit
    OR NEW.interval_count IS DISTINCT FROM OLD.interval_count
  ) THEN
    RAISE EXCEPTION 'schedule_locked' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_recurring_agreement ON recurring_agreements;
CREATE TRIGGER trg_validate_recurring_agreement
  BEFORE INSERT OR UPDATE ON recurring_agreements
  FOR EACH ROW EXECUTE FUNCTION public.validate_recurring_agreement();

DROP TRIGGER IF EXISTS trg_recurring_agreements_updated_at ON recurring_agreements;
CREATE TRIGGER trg_recurring_agreements_updated_at
  BEFORE UPDATE ON recurring_agreements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE recurring_agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_recurring_agreements" ON recurring_agreements;
CREATE POLICY "select_recurring_agreements" ON recurring_agreements
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_recurring_agreements" ON recurring_agreements;
CREATE POLICY "insert_recurring_agreements" ON recurring_agreements
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_recurring_jobs());

DROP POLICY IF EXISTS "update_recurring_agreements" ON recurring_agreements;
CREATE POLICY "update_recurring_agreements" ON recurring_agreements
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_recurring_jobs())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_recurring_jobs());

DROP POLICY IF EXISTS "delete_recurring_agreements" ON recurring_agreements;
CREATE POLICY "delete_recurring_agreements" ON recurring_agreements
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_recurring_jobs());

-- =============================================================
-- OCCURRENCES (written only by RPCs / cron)
-- =============================================================

CREATE TABLE IF NOT EXISTS recurring_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agreement_id uuid NOT NULL REFERENCES recurring_agreements(id) ON DELETE CASCADE,
  occurrence_n integer NOT NULL CHECK (occurrence_n >= 0),
  occurrence_date date NOT NULL,
  scheduled_datetime timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('generated', 'skipped', 'needs_attention')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  skip_reason text CHECK (skip_reason IS NULL OR char_length(skip_reason) <= 300),
  attention_reason text,
  invoice_state text NOT NULL DEFAULT 'not_applicable'
    CHECK (invoice_state IN ('not_applicable', 'pending', 'sending', 'sent', 'blocked', 'failed')),
  invoice_attempts integer NOT NULL DEFAULT 0,
  invoice_error text,
  invoice_claimed_at timestamptz,
  invoiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, occurrence_n)
);

CREATE INDEX IF NOT EXISTS idx_recurring_occ_user_date ON recurring_occurrences (user_id, scheduled_datetime);
CREATE INDEX IF NOT EXISTS idx_recurring_occ_job ON recurring_occurrences (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recurring_occ_invoice ON recurring_occurrences (invoice_state)
  WHERE invoice_state IN ('pending', 'sending', 'blocked');

DROP TRIGGER IF EXISTS trg_recurring_occ_updated_at ON recurring_occurrences;
CREATE TRIGGER trg_recurring_occ_updated_at
  BEFORE UPDATE ON recurring_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE recurring_occurrences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_recurring_occurrences" ON recurring_occurrences;
CREATE POLICY "select_recurring_occurrences" ON recurring_occurrences
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Intentionally no INSERT/UPDATE/DELETE policies for authenticated users.

-- =============================================================
-- GENERATOR (service_role only — called by recurring-jobs-cron)
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_recurring_jobs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a recurring_agreements%ROWTYPE;
  v_date date;
  v_today date;
  v_base timestamptz;
  v_try timestamptz;
  v_job_id uuid;
  v_tech uuid;
  v_step integer;
  v_iter integer;
  v_placed boolean;
  v_invoice text;
  v_created integer := 0;
  v_attention integer := 0;
  v_missed integer := 0;
  v_agreement_attention integer;
  v_errors jsonb := '[]'::jsonb;
BEGIN
  FOR a IN
    SELECT * FROM recurring_agreements
    WHERE status = 'active'
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_agreement_attention := 0;
      v_iter := 0;
      v_today := (p_now AT TIME ZONE a.timezone)::date;
      v_tech := NULL;

      IF a.preferred_technician_id IS NOT NULL THEN
        SELECT id INTO v_tech FROM team_members
        WHERE id = a.preferred_technician_id AND account_owner_id = a.user_id
          AND role = 'technician' AND invite_status = 'active';
      END IF;

      v_invoice := CASE WHEN a.auto_invoice AND COALESCE(a.price_amount, 0) > 0 THEN 'pending' ELSE 'not_applicable' END;

      LOOP
        EXIT WHEN v_iter >= 6;  -- bounded catch-up per run
        v_date := public.recurring_occurrence_date(a.start_date, a.interval_unit, a.interval_count, a.next_occurrence_n);

        IF a.end_date IS NOT NULL AND v_date > a.end_date THEN
          a.status := 'completed';
          EXIT;
        END IF;
        EXIT WHEN v_date > v_today + a.lead_time_days;
        v_iter := v_iter + 1;
        v_base := (v_date + a.preferred_time) AT TIME ZONE a.timezone;

        IF EXISTS (SELECT 1 FROM recurring_occurrences WHERE agreement_id = a.id AND occurrence_n = a.next_occurrence_n) THEN
          NULL;  -- already handled (e.g. the owner skipped it ahead of time)
        ELSIF v_base < p_now THEN  -- never create a back-dated job
          INSERT INTO recurring_occurrences (user_id, agreement_id, occurrence_n, occurrence_date, scheduled_datetime, status, skip_reason)
          VALUES (a.user_id, a.id, a.next_occurrence_n, v_date, v_base, 'skipped', 'Missed: the scheduler was not running at the scheduled time.');
          v_missed := v_missed + 1;
        ELSE
          v_placed := false;
          FOR v_step IN 0..8 LOOP
            v_try := v_base + (v_step * interval '30 minutes');
            EXIT WHEN (v_try AT TIME ZONE a.timezone)::date <> v_date;
            BEGIN
              INSERT INTO jobs (user_id, customer_id, customer_name, customer_phone, service_type, address,
                                scheduled_datetime, duration_minutes, assigned_technician_id, job_status,
                                invoice_amount, dispatch_note)
              VALUES (a.user_id, a.customer_id, a.customer_name, a.customer_phone, a.service_type, a.address,
                      v_try, a.duration_minutes, v_tech, 'scheduled',
                      a.price_amount, 'Recurring: ' || a.title)
              RETURNING id INTO v_job_id;
              v_placed := true;
              EXIT;
            EXCEPTION WHEN exclusion_violation THEN
              NULL;  -- slot taken; try the next 30-minute step
            END;
          END LOOP;

          IF v_placed THEN
            INSERT INTO recurring_occurrences (user_id, agreement_id, occurrence_n, occurrence_date, scheduled_datetime, status, job_id, invoice_state)
            VALUES (a.user_id, a.id, a.next_occurrence_n, v_date, v_try, 'generated', v_job_id, v_invoice);
            v_created := v_created + 1;
          ELSE
            INSERT INTO recurring_occurrences (user_id, agreement_id, occurrence_n, occurrence_date, scheduled_datetime, status, attention_reason)
            VALUES (a.user_id, a.id, a.next_occurrence_n, v_date, v_base, 'needs_attention',
                    'No free slot within 4 hours of the preferred time. Pick a new time.');
            v_attention := v_attention + 1;
            v_agreement_attention := v_agreement_attention + 1;
          END IF;
        END IF;

        a.next_occurrence_n := a.next_occurrence_n + 1;
      END LOOP;

      UPDATE recurring_agreements
      SET next_occurrence_n = a.next_occurrence_n, status = a.status, last_generated_at = p_now
      WHERE id = a.id;

      IF v_agreement_attention > 0 THEN
        INSERT INTO notifications (user_id, type, title, message, action_url)
        VALUES (a.user_id, 'recurring_job_attention', 'Recurring visit needs a new time',
                format('%s: %s visit(s) could not be scheduled automatically.', a.title, v_agreement_attention),
                '/dashboard/recurring-jobs');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('agreement_id', a.id, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('jobs_created', v_created, 'needs_attention', v_attention, 'missed', v_missed, 'errors', v_errors);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_recurring_jobs(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_recurring_jobs(timestamptz) TO service_role;

-- =============================================================
-- DASHBOARD RPCs (tenant + permission checked)
-- =============================================================

CREATE OR REPLACE FUNCTION public._recurring_require_manager()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_recurring_jobs() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public._recurring_require_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._recurring_require_manager() TO authenticated;

CREATE OR REPLACE FUNCTION public.skip_recurring_occurrence(p_agreement_id uuid, p_occurrence_n integer, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._recurring_require_manager();
  a recurring_agreements%ROWTYPE;
  o recurring_occurrences%ROWTYPE;
  v_job_status text;
  v_date date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  SELECT * INTO a FROM recurring_agreements WHERE id = p_agreement_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agreement_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO o FROM recurring_occurrences WHERE agreement_id = a.id AND occurrence_n = p_occurrence_n FOR UPDATE;

  IF FOUND THEN
    IF o.status = 'skipped' THEN
      RETURN jsonb_build_object('status', 'already_skipped');
    END IF;
    IF o.job_id IS NOT NULL THEN
      SELECT job_status INTO v_job_status FROM jobs WHERE id = o.job_id FOR UPDATE;
      IF v_job_status IS NOT NULL AND v_job_status <> 'scheduled' THEN
        RAISE EXCEPTION 'job_already_started' USING ERRCODE = '55000';
      END IF;
      UPDATE jobs SET job_status = 'cancelled' WHERE id = o.job_id;
    END IF;
    UPDATE recurring_occurrences
    SET status = 'skipped', skip_reason = v_reason, attention_reason = NULL, invoice_state = 'not_applicable'
    WHERE id = o.id;
    RETURN jsonb_build_object('status', 'skipped');
  END IF;

  -- Not generated yet: only a future occurrence can be pre-skipped.
  IF p_occurrence_n < a.next_occurrence_n THEN
    RAISE EXCEPTION 'occurrence_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_date := public.recurring_occurrence_date(a.start_date, a.interval_unit, a.interval_count, p_occurrence_n);
  IF a.end_date IS NOT NULL AND v_date > a.end_date THEN
    RAISE EXCEPTION 'occurrence_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO recurring_occurrences (user_id, agreement_id, occurrence_n, occurrence_date, scheduled_datetime, status, skip_reason)
  VALUES (a.user_id, a.id, p_occurrence_n, v_date, (v_date + a.preferred_time) AT TIME ZONE a.timezone, 'skipped', v_reason);
  RETURN jsonb_build_object('status', 'skipped');
END;
$$;

CREATE OR REPLACE FUNCTION public.reschedule_recurring_occurrence(p_occurrence_id uuid, p_new_datetime timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._recurring_require_manager();
  o recurring_occurrences%ROWTYPE;
  a recurring_agreements%ROWTYPE;
  v_job_status text;
  v_job_id uuid;
  v_tech uuid;
BEGIN
  IF p_new_datetime IS NULL OR p_new_datetime < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'datetime_in_past' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO o FROM recurring_occurrences WHERE id = p_occurrence_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'occurrence_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO a FROM recurring_agreements WHERE id = o.agreement_id AND user_id = v_owner;

  IF o.status = 'skipped' THEN
    RAISE EXCEPTION 'occurrence_skipped' USING ERRCODE = '55000';
  END IF;

  BEGIN
    IF o.status = 'generated' AND o.job_id IS NOT NULL THEN
      SELECT job_status INTO v_job_status FROM jobs WHERE id = o.job_id FOR UPDATE;
      IF v_job_status IS DISTINCT FROM 'scheduled' THEN
        RAISE EXCEPTION 'job_already_started' USING ERRCODE = '55000';
      END IF;
      UPDATE jobs SET scheduled_datetime = p_new_datetime WHERE id = o.job_id;
    ELSE
      SELECT id INTO v_tech FROM team_members
      WHERE id = a.preferred_technician_id AND account_owner_id = a.user_id AND role = 'technician' AND invite_status = 'active';
      INSERT INTO jobs (user_id, customer_id, customer_name, customer_phone, service_type, address,
                        scheduled_datetime, duration_minutes, assigned_technician_id, job_status,
                        invoice_amount, dispatch_note)
      VALUES (a.user_id, a.customer_id, a.customer_name, a.customer_phone, a.service_type, a.address,
              p_new_datetime, a.duration_minutes, v_tech, 'scheduled', a.price_amount, 'Recurring: ' || a.title)
      RETURNING id INTO v_job_id;
      o.job_id := v_job_id;
    END IF;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'slot_conflict' USING ERRCODE = '23P01';
  END;

  UPDATE recurring_occurrences
  SET status = 'generated',
      scheduled_datetime = p_new_datetime,
      job_id = o.job_id,
      attention_reason = NULL,
      invoice_state = CASE
        WHEN o.status = 'needs_attention' AND a.auto_invoice AND COALESCE(a.price_amount, 0) > 0 THEN 'pending'
        ELSE o.invoice_state END
  WHERE id = o.id;

  RETURN jsonb_build_object('status', 'rescheduled');
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_recurring_agreement(p_agreement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._recurring_require_manager();
  a recurring_agreements%ROWTYPE;
  v_cancelled integer := 0;
BEGIN
  SELECT * INTO a FROM recurring_agreements WHERE id = p_agreement_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agreement_not_found' USING ERRCODE = 'P0002'; END IF;

  WITH targets AS (
    SELECT o.id AS occ_id, o.job_id
    FROM recurring_occurrences o
    JOIN jobs j ON j.id = o.job_id
    WHERE o.agreement_id = a.id AND o.status = 'generated'
      AND j.job_status = 'scheduled' AND j.scheduled_datetime > now()
  ), cancelled_jobs AS (
    UPDATE jobs SET job_status = 'cancelled' WHERE id IN (SELECT job_id FROM targets) RETURNING id
  )
  UPDATE recurring_occurrences
  SET status = 'skipped', skip_reason = 'Agreement cancelled', invoice_state = 'not_applicable'
  WHERE id IN (SELECT occ_id FROM targets);
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE recurring_occurrences
  SET status = 'skipped', skip_reason = 'Agreement cancelled', attention_reason = NULL
  WHERE agreement_id = a.id AND status = 'needs_attention';

  UPDATE recurring_agreements SET status = 'cancelled' WHERE id = a.id;
  RETURN jsonb_build_object('status', 'cancelled', 'jobs_cancelled', v_cancelled);
END;
$$;

REVOKE ALL ON FUNCTION public.skip_recurring_occurrence(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reschedule_recurring_occurrence(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_recurring_agreement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skip_recurring_occurrence(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_recurring_occurrence(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_recurring_agreement(uuid) TO authenticated;

COMMENT ON TABLE recurring_agreements IS 'Maintenance agreements that auto-generate jobs on a schedule (see generate_recurring_jobs).';
COMMENT ON TABLE recurring_occurrences IS 'One row per visit the scheduler handled: generated job, skipped, or needs_attention. Written only by RPCs / cron.';
