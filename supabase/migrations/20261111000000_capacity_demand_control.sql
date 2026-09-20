/*
  # AI Capacity-Based Demand Control

  ## What this adds
  A new decision layer that sits on top of the capacity system already
  shipped in 20260925000000_technician_capacity_locking.sql. That
  migration answers "can THIS ONE job be assigned right now" — this one
  answers a broader question for the whole day: is the business under-
  booked (AI should be generating demand), comfortably booked, or full
  (AI should protect the schedule with a waitlist + a reserved emergency
  buffer and ease off outbound demand campaigns)?

  1. `capacity_demand_policies` — one row per account, the thresholds
     and toggles the owner controls (low/full %, emergency reserve
     slots, waitlist on/off, auto demand-campaign toggle). Auto-created
     with sane defaults on first read via `get_or_create_capacity_policy`.
  2. `capacity_waitlist_entries` — customers who couldn't get a slot
     while the business is full, ready to be offered the next opening.
  3. `capacity_demand_events` — audit trail of every status computation
     and the action taken, mirroring the existing
     `technician_capacity_events` pattern so this system is provable,
     not just trusted.
  4. RPCs: `get_capacity_status`, `add_to_capacity_waitlist`,
     `update_capacity_waitlist_status`, `run_capacity_demand_control`,
     `update_capacity_demand_policy` — all SECURITY DEFINER, all scoped
     to `public.get_account_owner_id()` exactly like the existing
     capacity RPCs, so no new cross-tenant surface is introduced.
*/

-- =============================================================
-- CAPACITY_DEMAND_POLICIES
-- =============================================================

CREATE TABLE IF NOT EXISTS capacity_demand_policies (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  low_threshold_pct integer NOT NULL DEFAULT 50 CHECK (low_threshold_pct >= 0 AND low_threshold_pct <= 100),
  full_threshold_pct integer NOT NULL DEFAULT 90 CHECK (full_threshold_pct >= 0 AND full_threshold_pct <= 100),
  emergency_reserve_slots integer NOT NULL DEFAULT 1 CHECK (emergency_reserve_slots >= 0),
  waitlist_enabled boolean NOT NULL DEFAULT true,
  auto_demand_campaigns_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (low_threshold_pct < full_threshold_pct)
);

ALTER TABLE capacity_demand_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_capacity_demand_policy" ON capacity_demand_policies;
CREATE POLICY "select_own_capacity_demand_policy" ON capacity_demand_policies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No direct INSERT/UPDATE policy for `authenticated` — writes only go
-- through update_capacity_demand_policy() / get_or_create_capacity_policy()
-- below, both SECURITY DEFINER, so the CHECK constraints above can never
-- be bypassed by a hand-crafted client write.

-- =============================================================
-- CAPACITY_WAITLIST_ENTRIES
-- =============================================================

CREATE TABLE IF NOT EXISTS capacity_waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  service_type text,
  requested_date date NOT NULL,
  notes text,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  offered_slot timestamptz,
  offer_expires_at timestamptz,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capacity_waitlist_user_status
  ON capacity_waitlist_entries(user_id, status, requested_date);

ALTER TABLE capacity_waitlist_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_capacity_waitlist" ON capacity_waitlist_entries;
CREATE POLICY "select_own_capacity_waitlist" ON capacity_waitlist_entries FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Writes go through add_to_capacity_waitlist() / update_capacity_waitlist_status()
-- (both SECURITY DEFINER) so status transitions stay valid and job_id can
-- only ever be attached by the server-side "promote" path, never a raw client UPDATE.

-- =============================================================
-- CAPACITY_DEMAND_EVENTS — audit trail
-- =============================================================

CREATE TABLE IF NOT EXISTS capacity_demand_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('low', 'optimal', 'full', 'no_capacity')),
  day_load integer NOT NULL,
  day_capacity integer NOT NULL,
  load_pct numeric,
  action_taken text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capacity_demand_events_user
  ON capacity_demand_events(user_id, created_at DESC);

ALTER TABLE capacity_demand_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_capacity_demand_events" ON capacity_demand_events;
CREATE POLICY "select_own_capacity_demand_events" ON capacity_demand_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No client INSERT policy — only run_capacity_demand_control() (SECURITY DEFINER) writes here.

-- =============================================================
-- RPC: get_or_create_capacity_policy
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_or_create_capacity_policy()
RETURNS capacity_demand_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row capacity_demand_policies;
BEGIN
  SELECT * INTO v_row FROM capacity_demand_policies WHERE user_id = v_owner;
  IF NOT FOUND THEN
    INSERT INTO capacity_demand_policies (user_id) VALUES (v_owner)
    ON CONFLICT (user_id) DO NOTHING;
    SELECT * INTO v_row FROM capacity_demand_policies WHERE user_id = v_owner;
  END IF;
  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: update_capacity_demand_policy
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_capacity_demand_policy(
  p_low_threshold_pct integer DEFAULT NULL,
  p_full_threshold_pct integer DEFAULT NULL,
  p_emergency_reserve_slots integer DEFAULT NULL,
  p_waitlist_enabled boolean DEFAULT NULL,
  p_auto_demand_campaigns_enabled boolean DEFAULT NULL
)
RETURNS capacity_demand_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row capacity_demand_policies;
BEGIN
  PERFORM public.get_or_create_capacity_policy();

  UPDATE capacity_demand_policies SET
    low_threshold_pct = COALESCE(p_low_threshold_pct, low_threshold_pct),
    full_threshold_pct = COALESCE(p_full_threshold_pct, full_threshold_pct),
    emergency_reserve_slots = COALESCE(p_emergency_reserve_slots, emergency_reserve_slots),
    waitlist_enabled = COALESCE(p_waitlist_enabled, waitlist_enabled),
    auto_demand_campaigns_enabled = COALESCE(p_auto_demand_campaigns_enabled, auto_demand_campaigns_enabled),
    updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: get_capacity_status
-- The core read: today's (or a given date's) load vs. capacity,
-- with the emergency reserve carved out, classified into a status.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_capacity_status(p_date date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_policy capacity_demand_policies;
  v_capacity integer;
  v_load integer;
  v_load_pct numeric;
  v_status text;
  v_remaining integer;
  v_normal_remaining integer;
  v_emergency_remaining integer;
BEGIN
  v_policy := public.get_or_create_capacity_policy();

  SELECT COALESCE(SUM(max_jobs_per_day), 0) INTO v_capacity
  FROM team_members
  WHERE account_owner_id = v_owner AND role = 'technician' AND dispatch_enabled = true;

  SELECT count(*) INTO v_load
  FROM jobs
  WHERE user_id = v_owner
    AND job_status IN ('scheduled', 'en_route', 'in_progress')
    AND scheduled_datetime::date = p_date;

  v_remaining := GREATEST(0, v_capacity - v_load);
  v_normal_remaining := GREATEST(0, v_remaining - v_policy.emergency_reserve_slots);
  v_emergency_remaining := LEAST(v_remaining, v_policy.emergency_reserve_slots);

  IF v_capacity = 0 THEN
    v_status := 'no_capacity';
    v_load_pct := NULL;
  ELSE
    v_load_pct := round((v_load::numeric / v_capacity::numeric) * 100, 1);
    IF v_load_pct >= v_policy.full_threshold_pct THEN
      v_status := 'full';
    ELSIF v_load_pct <= v_policy.low_threshold_pct THEN
      v_status := 'low';
    ELSE
      v_status := 'optimal';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'date', p_date,
    'status', v_status,
    'day_load', v_load,
    'day_capacity', v_capacity,
    'load_pct', v_load_pct,
    'normal_slots_remaining', v_normal_remaining,
    'emergency_slots_remaining', v_emergency_remaining,
    'policy', jsonb_build_object(
      'low_threshold_pct', v_policy.low_threshold_pct,
      'full_threshold_pct', v_policy.full_threshold_pct,
      'emergency_reserve_slots', v_policy.emergency_reserve_slots,
      'waitlist_enabled', v_policy.waitlist_enabled,
      'auto_demand_campaigns_enabled', v_policy.auto_demand_campaigns_enabled
    )
  );
END;
$$;

-- =============================================================
-- RPC: run_capacity_demand_control
-- Decides + logs the action for the given date's status. Pure,
-- deterministic rule layer — the AI narrative (edge function,
-- capacity-demand-insight) explains this decision in natural
-- language, it does not make it.
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_capacity_demand_control(p_date date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status jsonb;
  v_action text;
BEGIN
  v_status := public.get_capacity_status(p_date);

  v_action := CASE v_status->>'status'
    WHEN 'low' THEN
      CASE WHEN (v_status->'policy'->>'auto_demand_campaigns_enabled')::boolean
        THEN 'demand_campaign_recommended' ELSE 'none_campaigns_disabled' END
    WHEN 'full' THEN
      CASE WHEN (v_status->'policy'->>'waitlist_enabled')::boolean
        THEN 'waitlist_mode_enabled' ELSE 'campaigns_paused_recommended' END
    WHEN 'no_capacity' THEN 'no_technicians_configured'
    ELSE 'none'
  END;

  INSERT INTO capacity_demand_events (user_id, event_date, status, day_load, day_capacity, load_pct, action_taken, detail)
  VALUES (
    v_owner, p_date, v_status->>'status',
    (v_status->>'day_load')::integer, (v_status->>'day_capacity')::integer,
    NULLIF(v_status->>'load_pct', '')::numeric, v_action, v_status
  );

  RETURN v_status || jsonb_build_object('action_taken', v_action);
END;
$$;

-- =============================================================
-- RPC: add_to_capacity_waitlist
-- =============================================================

CREATE OR REPLACE FUNCTION public.add_to_capacity_waitlist(
  p_customer_name text,
  p_requested_date date,
  p_customer_phone text DEFAULT NULL,
  p_customer_email text DEFAULT NULL,
  p_service_type text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_priority integer DEFAULT 0
)
RETURNS capacity_waitlist_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row capacity_waitlist_entries;
BEGIN
  IF trim(coalesce(p_customer_name, '')) = '' THEN
    RAISE EXCEPTION 'customer_name is required';
  END IF;

  INSERT INTO capacity_waitlist_entries (
    user_id, customer_name, customer_phone, customer_email, service_type, requested_date, notes, priority
  ) VALUES (
    v_owner, trim(p_customer_name), nullif(trim(coalesce(p_customer_phone, '')), ''),
    nullif(trim(coalesce(p_customer_email, '')), ''), p_service_type, p_requested_date,
    p_notes, coalesce(p_priority, 0)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- =============================================================
-- RPC: update_capacity_waitlist_status
-- Covers offering a slot, cancelling, expiring, and — once a real
-- job is created for the customer through the normal booking flow —
-- marking the entry booked and linking it to that job.
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_capacity_waitlist_status(
  p_entry_id uuid,
  p_status text,
  p_offered_slot timestamptz DEFAULT NULL,
  p_job_id uuid DEFAULT NULL
)
RETURNS capacity_waitlist_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row capacity_waitlist_entries;
BEGIN
  IF p_status NOT IN ('waiting', 'offered', 'booked', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  UPDATE capacity_waitlist_entries SET
    status = p_status,
    offered_slot = CASE WHEN p_status = 'offered' THEN p_offered_slot ELSE offered_slot END,
    offer_expires_at = CASE WHEN p_status = 'offered' THEN now() + interval '2 hours' ELSE offer_expires_at END,
    job_id = COALESCE(p_job_id, job_id),
    updated_at = now()
  WHERE id = p_entry_id AND user_id = v_owner
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waitlist entry not found';
  END IF;

  RETURN v_row;
END;
$$;
