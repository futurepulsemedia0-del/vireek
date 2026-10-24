/*
  # Capacity-based smart booking

  One engine (supabase/functions/_shared/booking/capacityEngine.ts) decides which slots are offered on
  every channel (public page, AI voice, SMS, MCP agents). This migration adds the three pieces of state
  and the single atomic write path that engine needs. Purely additive and idempotent; nothing changes
  until the owner turns `enabled` on (default OFF = every channel keeps its legacy behaviour).

  - booking_capacity_policies   per-account switches: slot step, assumed travel time, controlled
                                overbooking limits. The emergency reserve and demand thresholds are
                                REUSED from capacity_demand_policies (capacity-demand control).
  - booking_decisions           audit trail: why every committed slot was offered and to whom.
  - book_capacity_slot()        service-role-only. Locks the technician row, re-checks the DB gates
                                (time off / blackout / weekly days, daily capacity incl. the overbooking
                                allowance, credentials) and inserts the job WITH the technician already
                                assigned, so jobs_no_double_booking protects that technician's own
                                calendar (an unassigned job blocks the whole business instead) and the
                                blind auto_dispatch trigger is bypassed.
*/

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS booking_intake jsonb,
  ADD COLUMN IF NOT EXISTS booking_deposit_due_cents integer;

-- =============================================================
-- booking_capacity_policies
-- =============================================================

CREATE TABLE IF NOT EXISTS booking_capacity_policies (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  slot_step_minutes integer NOT NULL DEFAULT 30 CHECK (slot_step_minutes BETWEEN 5 AND 240),
  default_travel_minutes integer NOT NULL DEFAULT 20 CHECK (default_travel_minutes BETWEEN 0 AND 240),
  overbook_jobs_per_tech integer NOT NULL DEFAULT 0 CHECK (overbook_jobs_per_tech BETWEEN 0 AND 3),
  overbook_min_cancel_rate_pct integer NOT NULL DEFAULT 10 CHECK (overbook_min_cancel_rate_pct BETWEEN 0 AND 100),
  max_slots_per_day integer NOT NULL DEFAULT 12 CHECK (max_slots_per_day BETWEEN 1 AND 48),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE booking_capacity_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_booking_capacity_policy" ON booking_capacity_policies;
CREATE POLICY "select_own_booking_capacity_policy" ON booking_capacity_policies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE policy: writes only through the SECURITY DEFINER functions below.

CREATE OR REPLACE FUNCTION public.get_booking_capacity_policy()
RETURNS booking_capacity_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row booking_capacity_policies;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO booking_capacity_policies (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM booking_capacity_policies WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_booking_capacity_policy(
  p_enabled boolean,
  p_slot_step_minutes integer,
  p_default_travel_minutes integer,
  p_overbook_jobs_per_tech integer,
  p_overbook_min_cancel_rate_pct integer,
  p_max_slots_per_day integer
)
RETURNS booking_capacity_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row booking_capacity_policies;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF auth.uid() IS DISTINCT FROM v_owner THEN RAISE EXCEPTION 'owner_only'; END IF;
  INSERT INTO booking_capacity_policies AS p (user_id, enabled, slot_step_minutes, default_travel_minutes, overbook_jobs_per_tech, overbook_min_cancel_rate_pct, max_slots_per_day)
  VALUES (v_owner, p_enabled, p_slot_step_minutes, p_default_travel_minutes, p_overbook_jobs_per_tech, p_overbook_min_cancel_rate_pct, p_max_slots_per_day)
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    slot_step_minutes = EXCLUDED.slot_step_minutes,
    default_travel_minutes = EXCLUDED.default_travel_minutes,
    overbook_jobs_per_tech = EXCLUDED.overbook_jobs_per_tech,
    overbook_min_cancel_rate_pct = EXCLUDED.overbook_min_cancel_rate_pct,
    max_slots_per_day = EXCLUDED.max_slots_per_day,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.get_booking_capacity_policy() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_booking_capacity_policy(boolean, integer, integer, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_booking_capacity_policy() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_booking_capacity_policy(boolean, integer, integer, integer, integer, integer) TO authenticated;

-- =============================================================
-- booking_decisions — why a slot was offered / which technician got it
-- =============================================================

CREATE TABLE IF NOT EXISTS booking_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  channel text NOT NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  overbooked boolean NOT NULL DEFAULT false,
  offered_slot timestamptz NOT NULL,
  duration_minutes integer NOT NULL,
  explanation text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_decisions_user ON booking_decisions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_decisions_job ON booking_decisions (job_id);

ALTER TABLE booking_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_booking_decisions" ON booking_decisions;
CREATE POLICY "select_own_booking_decisions" ON booking_decisions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: only book_capacity_slot() writes here.

-- =============================================================
-- book_capacity_slot — the one atomic write path (service role only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.book_capacity_slot(
  p_user_id uuid,
  p_technician_id uuid,
  p_start timestamptz,
  p_duration_minutes integer,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_service_type text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_notes text,
  p_channel text,
  p_ref_code text,
  p_intake jsonb,
  p_deposit_cents integer,
  p_overbook_allowance integer,
  p_explanation text,
  p_detail jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tech record;
  v_tz text;
  v_day date;
  v_unavail text;
  v_load integer;
  v_cap integer;
  v_allow integer := LEAST(3, GREATEST(0, coalesce(p_overbook_allowance, 0)));
  v_duration integer := LEAST(480, GREATEST(15, coalesce(p_duration_minutes, 60)));
  v_gaps text[];
  v_lead uuid;
  v_customer uuid;
  v_job uuid;
  v_phone text := NULLIF(trim(coalesce(p_customer_phone, '')), '');
  v_email text := NULLIF(trim(coalesce(p_customer_email, '')), '');
  v_ref text := NULLIF(trim(coalesce(p_ref_code, '')), '');
  v_channel text := coalesce(NULLIF(trim(coalesce(p_channel, '')), ''), 'web_booking');
BEGIN
  IF trim(coalesce(p_customer_name, '')) = '' THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'missing_customer_name');
  END IF;

  -- Row lock: concurrent bookings for the same technician are serialized, so the capacity count below is race-free.
  SELECT id, member_name, max_jobs_per_day INTO v_tech
  FROM team_members
  WHERE id = p_technician_id AND account_owner_id = p_user_id AND role = 'technician'
    AND invite_status = 'active' AND dispatch_enabled = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'tech_not_found', 'reason', 'Technician not found or not dispatch-enabled.');
  END IF;

  SELECT NULLIF(timezone, '') INTO v_tz FROM business_profile WHERE user_id = p_user_id;
  BEGIN
    v_day := (p_start AT TIME ZONE coalesce(v_tz, 'UTC'))::date;
  EXCEPTION WHEN OTHERS THEN
    v_day := (p_start AT TIME ZONE 'UTC')::date;
    v_tz := 'UTC';
  END;

  v_unavail := public.technician_unavailable_reason(p_technician_id, v_day);
  IF v_unavail IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'blocked_time_off', 'technician_id', p_technician_id, 'reason', v_unavail);
  END IF;

  v_cap := coalesce(v_tech.max_jobs_per_day, 6);
  SELECT count(*) INTO v_load FROM jobs
  WHERE assigned_technician_id = p_technician_id
    AND job_status IN ('scheduled', 'en_route', 'in_progress')
    AND scheduled_datetime IS NOT NULL
    AND (scheduled_datetime AT TIME ZONE coalesce(v_tz, 'UTC'))::date = v_day;
  IF v_load >= v_cap + v_allow THEN
    RETURN jsonb_build_object('status', 'at_capacity', 'technician_id', p_technician_id, 'day_load', v_load, 'capacity', v_cap,
      'reason', format('%s already has %s of %s jobs that day.', v_tech.member_name, v_load, v_cap));
  END IF;

  v_gaps := public.technician_compliance_gaps(p_technician_id, p_service_type);
  IF array_length(v_gaps, 1) > 0 THEN
    RETURN jsonb_build_object('status', 'blocked_compliance', 'technician_id', p_technician_id, 'gaps', to_jsonb(v_gaps),
      'reason', format('%s is missing required credentials: %s.', v_tech.member_name, array_to_string(v_gaps, ', ')));
  END IF;

  BEGIN
    INSERT INTO leads (user_id, name, phone, email, service_interested, notes)
    VALUES (p_user_id, p_customer_name, p_customer_phone, p_customer_email, p_service_type, p_notes)
    RETURNING id INTO v_lead;

    IF v_phone IS NOT NULL THEN
      SELECT id INTO v_customer FROM customers WHERE user_id = p_user_id AND phone = v_phone;
    END IF;
    IF v_customer IS NULL AND v_email IS NOT NULL THEN
      SELECT id INTO v_customer FROM customers WHERE user_id = p_user_id AND email = v_email;
    END IF;
    IF v_customer IS NULL THEN
      BEGIN
        INSERT INTO customers (user_id, name, phone, email, source, lifecycle_stage, referred_by_code)
        VALUES (p_user_id, p_customer_name, v_phone, v_email, 'job', 'lead', v_ref)
        RETURNING id INTO v_customer;
      EXCEPTION WHEN unique_violation THEN
        SELECT id INTO v_customer FROM customers
        WHERE user_id = p_user_id AND ((v_phone IS NOT NULL AND phone = v_phone) OR (v_email IS NOT NULL AND email = v_email))
        LIMIT 1;
      END;
    END IF;

    INSERT INTO jobs (user_id, lead_id, customer_id, customer_name, customer_phone, service_type, address, latitude, longitude,
                      scheduled_datetime, duration_minutes, job_status, booking_channel, assigned_technician_id,
                      booking_intake, booking_deposit_due_cents, dispatch_note)
    VALUES (p_user_id, v_lead, v_customer, p_customer_name, v_phone, p_service_type, p_address, p_latitude, p_longitude,
            p_start, v_duration, 'scheduled', v_channel, p_technician_id,
            CASE WHEN jsonb_typeof(p_intake) = 'array' AND jsonb_array_length(p_intake) > 0 THEN p_intake END,
            NULLIF(p_deposit_cents, 0), left(p_explanation, 900))
    RETURNING id INTO v_job;
  EXCEPTION WHEN exclusion_violation THEN
    RETURN jsonb_build_object('status', 'slot_conflict', 'technician_id', p_technician_id, 'reason', 'Technician is already booked at that time.');
  END;

  INSERT INTO booking_decisions (user_id, job_id, channel, technician_id, overbooked, offered_slot, duration_minutes, explanation, detail)
  VALUES (p_user_id, v_job, v_channel, p_technician_id, v_load >= v_cap, p_start, v_duration, left(coalesce(p_explanation, ''), 2000), coalesce(p_detail, '{}'::jsonb));

  INSERT INTO technician_capacity_events (user_id, job_id, technician_id, technician_name, outcome, day_load, capacity)
  VALUES (p_user_id, v_job, p_technician_id, v_tech.member_name, 'assigned', v_load + 1, v_cap);

  RETURN jsonb_build_object('status', 'booked', 'job_id', v_job, 'technician_id', p_technician_id, 'technician_name', v_tech.member_name,
    'overbooked', v_load >= v_cap, 'day_load', v_load + 1, 'capacity', v_cap, 'deposit_due_cents', coalesce(p_deposit_cents, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.book_capacity_slot(uuid, uuid, timestamptz, integer, text, text, text, text, text, double precision, double precision, text, text, text, jsonb, integer, integer, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_capacity_slot(uuid, uuid, timestamptz, integer, text, text, text, text, text, double precision, double precision, text, text, text, jsonb, integer, integer, text, jsonb)
  TO service_role;

COMMENT ON TABLE booking_capacity_policies IS 'Capacity-based smart booking switches. enabled=false keeps legacy booking on every channel.';
COMMENT ON TABLE booking_decisions IS 'Audit trail: why each capacity-booked slot was offered and which technician it went to.';
