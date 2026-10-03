/*
  # Vireek Autonomous Emergency Network

  ## Why
  Emergency Mode, Emergency Triage, AI Dispatch, Live ETA, the Contractor Network and the
  Capacity Exchange already exist — as separate islands. This migration is the spine that joins
  them into ONE pipeline per incident:

    Triage -> Dispatch -> ETA -> Customer updates -> Technician prep -> Job -> Evidence -> Payment -> Follow-up

  and adds the rule that makes it a *network*:  "No technician available" != "No service available".
  When the company cannot respond fast enough (no skilled technician, everyone at capacity, or the best
  ETA is beyond the owner's limit) the incident is handed to the Contractor Network automatically
  (or after one-tap approval — the owner chooses) and, if no partner accepts in time, it falls back
  to the best internal technician instead of leaving the customer with nothing.

  ## What this adds (all additive — no existing table or function is changed)
  1. emergency_network_settings  : per-account switches. MASTER SWITCH `enabled` defaults to FALSE:
                                   nothing autonomous happens until the owner opts in.
  2. emergency_incidents         : one row per incident; the single source of truth for pipeline state.
  3. emergency_incident_events   : append-only timeline (what the system did, and why).
  4. RPCs
       create_emergency_incident        (service role + any signed-in team member)
       set_emergency_network_settings   (owner / admin / security managers)
       approve_emergency_network_handoff, retry_emergency_incident, cancel_emergency_incident
       claim_due_emergency_incidents    (service role — work queue with leases, SKIP LOCKED)
       emergency_network_post_handoff   (service role — posts to the Contractor Network)
       emergency_network_withdraw       (service role — withdraws an unaccepted handoff)
       emergency_network_maintain       (service role — keeps emergency offers fast: 5-minute windows)
  5. Automatic bridges (guarded — a bridge failure can NEVER block the underlying operation):
       emergency_triage_submissions -> creates an incident
       jobs.job_status               -> keeps the incident in step with the real job

  ## Why `emergency_network_post_handoff` impersonates the owner
  The existing post_network_handoff() / compute_handoff_matches() authenticate with auth.uid().
  Re-using them (instead of copying their rules) guarantees the emergency path obeys exactly the same
  membership, PII, cap and matching rules as a manual hand-off, today and after any future change.
  The impersonation is transaction-local, restricted to the incident's own account, and the function
  is executable by service_role only.

  RLS mirrors the rest of the project: whole-account SELECT via get_account_owner_id(), no client
  INSERT/UPDATE/DELETE anywhere — every write goes through a SECURITY DEFINER function.
*/

-- =============================================================
-- HELPER: may the current user manage emergency-network settings?
-- =============================================================

CREATE OR REPLACE FUNCTION public.emergency_net_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    auth.uid() = public.get_account_owner_id()
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND lower(tm.member_email) = lower((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()))
        AND (tm.role = 'admin' OR COALESCE((tm.permissions ->> 'can_manage_security')::boolean, false))
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.emergency_net_can_manage() TO authenticated;

-- =============================================================
-- 1. SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.emergency_network_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  auto_dispatch boolean NOT NULL DEFAULT true,
  -- false = the owner approves each network hand-off with one tap (recommended default)
  auto_network_handoff boolean NOT NULL DEFAULT false,
  -- own best ETA above this => the network is considered
  max_internal_eta_minutes smallint NOT NULL DEFAULT 45 CHECK (max_internal_eta_minutes BETWEEN 5 AND 240),
  -- how long a network search may run before falling back to our own best technician
  network_wait_minutes smallint NOT NULL DEFAULT 12 CHECK (network_wait_minutes BETWEEN 3 AND 60),
  sla_critical_minutes smallint NOT NULL DEFAULT 60 CHECK (sla_critical_minutes BETWEEN 10 AND 1440),
  sla_high_minutes smallint NOT NULL DEFAULT 120 CHECK (sla_high_minutes BETWEEN 10 AND 1440),
  sla_standard_minutes smallint NOT NULL DEFAULT 240 CHECK (sla_standard_minutes BETWEEN 10 AND 1440),
  customer_updates boolean NOT NULL DEFAULT true,
  publish_estimated_eta boolean NOT NULL DEFAULT true,
  notify_phone text CHECK (notify_phone IS NULL OR char_length(notify_phone) <= 32),
  referral_fee_pct numeric(5, 2) NOT NULL DEFAULT 10 CHECK (referral_fee_pct BETWEEN 0 AND 50),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.emergency_network_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_emergency_network_settings" ON public.emergency_network_settings;
CREATE POLICY "select_own_emergency_network_settings" ON public.emergency_network_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 2. INCIDENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.emergency_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('call', 'portal', 'manual', 'api')),
  call_id uuid,
  triage_submission_id uuid,
  customer_id uuid,
  job_id uuid,

  customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 200),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 32),
  address text CHECK (address IS NULL OR char_length(address) <= 400),
  latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  hazards text[] NOT NULL DEFAULT '{}',
  required_trade text NOT NULL DEFAULT 'general'
    CHECK (required_trade IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')),

  severity_tier text NOT NULL CHECK (severity_tier IN ('critical', 'high', 'standard')),
  severity_score integer NOT NULL DEFAULT 0,
  severity_reason text,

  insurance_involved boolean NOT NULL DEFAULT false,
  insurance_claim_id uuid,

  sla_minutes integer NOT NULL CHECK (sla_minutes > 0),
  sla_due_at timestamptz NOT NULL,

  status text NOT NULL DEFAULT 'dispatching' CHECK (status IN (
    'dispatching', 'assigned', 'network_search', 'network_pending_approval', 'handed_off',
    'en_route', 'on_site', 'resolved', 'needs_human', 'cancelled', 'closed'
  )),
  stage text NOT NULL DEFAULT 'dispatch' CHECK (stage IN (
    'triage', 'dispatch', 'eta', 'customer_updates', 'tech_prep', 'job', 'evidence', 'payment', 'followup', 'done'
  )),

  assigned_technician_id uuid,
  assigned_technician_name text,
  assigned_at timestamptz,
  eta_minutes_est integer CHECK (eta_minutes_est IS NULL OR eta_minutes_est >= 0),
  eta_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,

  handoff_id uuid,
  network_started_at timestamptz,
  network_approved boolean NOT NULL DEFAULT false,
  network_rejected boolean NOT NULL DEFAULT false,
  partner_name text,
  partner_phone text,

  alerts_sent text[] NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  locked_until timestamptz,
  next_action_at timestamptz NOT NULL DEFAULT now(),

  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_emergency_incident_call
  ON public.emergency_incidents (user_id, call_id) WHERE call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_emergency_incident_triage
  ON public.emergency_incidents (user_id, triage_submission_id) WHERE triage_submission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emergency_incidents_user_created
  ON public.emergency_incidents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emergency_incidents_active
  ON public.emergency_incidents (user_id, severity_score DESC)
  WHERE status NOT IN ('closed', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_emergency_incidents_queue
  ON public.emergency_incidents (next_action_at)
  WHERE status NOT IN ('closed', 'cancelled', 'needs_human');
CREATE INDEX IF NOT EXISTS idx_emergency_incidents_job
  ON public.emergency_incidents (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emergency_incidents_handoff
  ON public.emergency_incidents (handoff_id) WHERE handoff_id IS NOT NULL;

ALTER TABLE public.emergency_incidents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_emergency_incidents" ON public.emergency_incidents;
CREATE POLICY "select_own_emergency_incidents" ON public.emergency_incidents
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Terminal states are final; updated_at is always maintained.
CREATE OR REPLACE FUNCTION public.emergency_incidents_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('closed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'emergency_incidents: % is a terminal status', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'emergency_incidents: user_id is immutable' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emergency_incidents_guard ON public.emergency_incidents;
CREATE TRIGGER trg_emergency_incidents_guard
  BEFORE UPDATE ON public.emergency_incidents
  FOR EACH ROW EXECUTE FUNCTION public.emergency_incidents_guard();

-- =============================================================
-- 3. EVENTS (append-only timeline)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.emergency_incident_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES public.emergency_incidents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN (
    'triage', 'dispatch', 'eta', 'customer_updates', 'tech_prep', 'job', 'evidence', 'payment', 'followup', 'network', 'system'
  )),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'skipped', 'failed', 'info')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emergency_events_incident ON public.emergency_incident_events (incident_id, id);

ALTER TABLE public.emergency_incident_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_emergency_incident_events" ON public.emergency_incident_events;
CREATE POLICY "select_own_emergency_incident_events" ON public.emergency_incident_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.emergency_network_settings,
  public.emergency_incidents,
  public.emergency_incident_events
FROM anon, authenticated;
REVOKE SELECT ON
  public.emergency_network_settings,
  public.emergency_incidents,
  public.emergency_incident_events
FROM anon;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.emergency_incidents;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- Internal event writer.
CREATE OR REPLACE FUNCTION public._emergency_log(
  p_incident_id uuid,
  p_user_id uuid,
  p_stage text,
  p_outcome text,
  p_summary text,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_actor text DEFAULT 'system'
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.emergency_incident_events (incident_id, user_id, stage, outcome, summary, detail, actor)
  VALUES (p_incident_id, p_user_id, p_stage, p_outcome, left(p_summary, 500), COALESCE(p_detail, '{}'::jsonb), p_actor);
$$;

REVOKE ALL ON FUNCTION public._emergency_log(uuid, uuid, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._emergency_log(uuid, uuid, text, text, text, jsonb, text) TO service_role;

-- =============================================================
-- RPC: create_emergency_incident  (triage happens here, instantly and deterministically)
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_emergency_incident(
  p_user_id uuid,
  p_source text,
  p_customer_name text,
  p_customer_phone text,
  p_address text,
  p_description text,
  p_hazards text[] DEFAULT '{}',
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_call_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_triage_submission_id uuid DEFAULT NULL,
  p_insurance_involved boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_settings public.emergency_network_settings%ROWTYPE;
  v_existing public.emergency_incidents%ROWTYPE;
  v_name text := btrim(COALESCE(p_customer_name, ''));
  v_desc text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_hazards text[] := COALESCE(p_hazards, '{}');
  v_signal text;
  v_trade text := 'general';
  v_priority record;
  v_tier text;
  v_score integer;
  v_reason text;
  v_sla integer;
  v_insurance boolean;
  v_claim_id uuid;
  v_loss text;
  v_id uuid;
  v_phone text := NULLIF(btrim(COALESCE(p_customer_phone, '')), '');
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id is required'; END IF;
  IF p_source NOT IN ('call', 'portal', 'manual', 'api') THEN RAISE EXCEPTION 'invalid source'; END IF;
  IF v_caller IS NOT NULL AND public.get_account_owner_id() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;
  IF v_name = '' THEN v_name := 'Unknown caller'; END IF;

  SELECT * INTO v_settings FROM public.emergency_network_settings WHERE user_id = p_user_id;
  IF NOT FOUND OR NOT v_settings.enabled THEN
    IF v_caller IS NULL THEN
      RETURN jsonb_build_object('skipped', true, 'reason', 'emergency_network_disabled');
    END IF;
    RAISE EXCEPTION 'EMERGENCY_NETWORK_DISABLED';
  END IF;

  -- Idempotency: the same call / triage submission, or the same phone within 30 minutes, is one incident.
  SELECT * INTO v_existing FROM public.emergency_incidents
  WHERE user_id = p_user_id
    AND status NOT IN ('closed', 'cancelled')
    AND (
      (p_call_id IS NOT NULL AND call_id = p_call_id)
      OR (p_triage_submission_id IS NOT NULL AND triage_submission_id = p_triage_submission_id)
      OR (v_phone IS NOT NULL AND customer_phone = v_phone AND created_at > now() - interval '30 minutes')
    )
  ORDER BY created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('incident_id', v_existing.id, 'existing', true, 'tier', v_existing.severity_tier,
                              'sla_due_at', v_existing.sla_due_at);
  END IF;

  -- Trade + signal: same vocabulary submit_emergency_triage() feeds emergency_priority_for_job().
  v_signal := COALESCE(v_desc, '');
  IF 'gas' = ANY (v_hazards) THEN v_signal := v_signal || ' gas leak'; v_trade := 'plumbing'; END IF;
  IF 'water' = ANY (v_hazards) THEN v_signal := v_signal || ' active leak flooding'; IF v_trade = 'general' THEN v_trade := 'plumbing'; END IF; END IF;
  IF 'electric' = ANY (v_hazards) THEN v_signal := v_signal || ' no power'; IF v_trade = 'general' THEN v_trade := 'electrical'; END IF; END IF;
  IF 'smoke' = ANY (v_hazards) THEN v_signal := v_signal || ' electrical fire'; v_trade := 'electrical'; END IF;

  IF v_trade = 'general' THEN
    v_trade := CASE
      WHEN lower(v_signal) ~ '(pipe|leak|flood|sewage|drain|water heater|toilet|burst)' THEN 'plumbing'
      WHEN lower(v_signal) ~ '(no heat|no ac|furnace|cooling|heating|hvac|a/c|boiler)' THEN 'hvac'
      WHEN lower(v_signal) ~ '(power|spark|breaker|electric|outlet|panel|downed line)' THEN 'electrical'
      WHEN lower(v_signal) ~ '(roof|tree|storm damage|shingle)' THEN 'roofing'
      WHEN lower(v_signal) ~ '(locked out|lockout|lock |break-in|break in)' THEN 'locksmith'
      WHEN lower(v_signal) ~ '(water damage|fire damage|mold|restoration)' THEN 'restoration'
      ELSE 'general' END;
  END IF;

  SELECT * INTO v_priority FROM public.emergency_priority_for_job(v_signal, now());
  v_tier := v_priority.tier;
  v_score := v_priority.score;
  v_reason := v_priority.reason;

  -- A person (or an emergency call flow) declared this an emergency: never treat it as routine.
  IF v_tier = 'standard' THEN
    v_tier := 'high';
    v_score := GREATEST(v_score, 60);
    v_reason := 'Declared as an emergency by ' || CASE WHEN v_caller IS NOT NULL THEN 'staff' ELSE p_source END;
  END IF;

  v_sla := CASE v_tier WHEN 'critical' THEN v_settings.sla_critical_minutes
                       WHEN 'high' THEN v_settings.sla_high_minutes
                       ELSE v_settings.sla_standard_minutes END;

  v_insurance := COALESCE(p_insurance_involved, false) OR lower(v_signal) ~ '(insur|adjuster|claim)';

  INSERT INTO public.emergency_incidents (
    user_id, source, call_id, triage_submission_id, customer_id,
    customer_name, customer_phone, address, latitude, longitude, description, hazards, required_trade,
    severity_tier, severity_score, severity_reason, insurance_involved, sla_minutes, sla_due_at
  ) VALUES (
    p_user_id, p_source, p_call_id, p_triage_submission_id, p_customer_id,
    left(v_name, 200), v_phone, left(NULLIF(btrim(COALESCE(p_address, '')), ''), 400), p_latitude, p_longitude,
    left(v_desc, 2000), v_hazards, v_trade,
    v_tier, v_score, v_reason, v_insurance, v_sla, now() + make_interval(mins => v_sla)
  )
  RETURNING id INTO v_id;

  PERFORM public._emergency_log(v_id, p_user_id, 'triage', 'ok',
    format('Triaged as %s (%s): %s', upper(v_tier), v_trade, v_reason),
    jsonb_build_object('score', v_score, 'trade', v_trade, 'hazards', v_hazards, 'source', p_source,
                       'sla_minutes', v_sla, 'insurance', v_insurance),
    CASE WHEN v_caller IS NOT NULL THEN 'user:' || v_caller::text ELSE 'system' END);

  -- Insurance intake (only for loss types an adjuster actually handles). Never blocks the incident.
  IF v_insurance AND to_regclass('public.insurance_claims') IS NOT NULL THEN
    BEGIN
      v_loss := CASE WHEN 'smoke' = ANY (v_hazards) THEN 'smoke_damage'
                     WHEN 'water' = ANY (v_hazards) OR v_trade IN ('plumbing', 'restoration') THEN 'water_damage'
                     WHEN lower(v_signal) ~ 'storm|wind|tree|roof' THEN 'storm_wind'
                     ELSE 'other' END;
      INSERT INTO public.insurance_claims (user_id, customer_name, customer_phone, property_address, loss_type, date_of_loss, status, notes)
      VALUES (p_user_id, left(v_name, 200), v_phone, left(p_address, 400), v_loss, current_date, 'intake',
              'Auto-created by the Emergency Network. Collect policy, carrier and photos on site.')
      RETURNING id INTO v_claim_id;
      UPDATE public.emergency_incidents SET insurance_claim_id = v_claim_id WHERE id = v_id;
      PERFORM public._emergency_log(v_id, p_user_id, 'triage', 'ok', 'Insurance claim intake opened', jsonb_build_object('claim_id', v_claim_id, 'loss_type', v_loss));
    EXCEPTION WHEN OTHERS THEN
      PERFORM public._emergency_log(v_id, p_user_id, 'triage', 'failed', 'Insurance intake could not be created', jsonb_build_object('error', SQLERRM));
    END;
  END IF;

  RETURN jsonb_build_object('incident_id', v_id, 'existing', false, 'tier', v_tier, 'sla_due_at', now() + make_interval(mins => v_sla));
END;
$$;

REVOKE ALL ON FUNCTION public.create_emergency_incident(uuid, text, text, text, text, text, text[], double precision, double precision, uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_emergency_incident(uuid, text, text, text, text, text, text[], double precision, double precision, uuid, uuid, uuid, boolean) TO authenticated, service_role;

-- =============================================================
-- RPC: settings
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_emergency_network_settings()
RETURNS public.emergency_network_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.emergency_network_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  INSERT INTO public.emergency_network_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.emergency_network_settings WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.get_emergency_network_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_emergency_network_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_emergency_network_settings(
  p_enabled boolean,
  p_auto_dispatch boolean,
  p_auto_network_handoff boolean,
  p_max_internal_eta_minutes integer,
  p_network_wait_minutes integer,
  p_sla_critical_minutes integer,
  p_sla_high_minutes integer,
  p_sla_standard_minutes integer,
  p_customer_updates boolean,
  p_publish_estimated_eta boolean,
  p_notify_phone text,
  p_referral_fee_pct numeric
)
RETURNS public.emergency_network_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.emergency_network_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.emergency_net_can_manage() THEN RAISE EXCEPTION 'You do not have permission to change Emergency Network settings'; END IF;
  IF p_max_internal_eta_minutes NOT BETWEEN 5 AND 240 THEN RAISE EXCEPTION 'Maximum internal ETA must be between 5 and 240 minutes'; END IF;
  IF p_network_wait_minutes NOT BETWEEN 3 AND 60 THEN RAISE EXCEPTION 'Network wait must be between 3 and 60 minutes'; END IF;
  IF p_sla_critical_minutes NOT BETWEEN 10 AND 1440 OR p_sla_high_minutes NOT BETWEEN 10 AND 1440 OR p_sla_standard_minutes NOT BETWEEN 10 AND 1440 THEN
    RAISE EXCEPTION 'SLA minutes must be between 10 and 1440';
  END IF;
  IF p_referral_fee_pct NOT BETWEEN 0 AND 50 THEN RAISE EXCEPTION 'Referral fee must be between 0 and 50 percent'; END IF;

  INSERT INTO public.emergency_network_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.emergency_network_settings SET
    enabled = COALESCE(p_enabled, false),
    auto_dispatch = COALESCE(p_auto_dispatch, true),
    auto_network_handoff = COALESCE(p_auto_network_handoff, false),
    max_internal_eta_minutes = p_max_internal_eta_minutes,
    network_wait_minutes = p_network_wait_minutes,
    sla_critical_minutes = p_sla_critical_minutes,
    sla_high_minutes = p_sla_high_minutes,
    sla_standard_minutes = p_sla_standard_minutes,
    customer_updates = COALESCE(p_customer_updates, true),
    publish_estimated_eta = COALESCE(p_publish_estimated_eta, true),
    notify_phone = NULLIF(btrim(COALESCE(p_notify_phone, '')), ''),
    referral_fee_pct = p_referral_fee_pct,
    updated_by = auth.uid(),
    updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_emergency_network_settings(boolean, boolean, boolean, integer, integer, integer, integer, integer, boolean, boolean, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_emergency_network_settings(boolean, boolean, boolean, integer, integer, integer, integer, integer, boolean, boolean, text, numeric) TO authenticated;

-- =============================================================
-- RPC (dashboard): human decisions
-- =============================================================

CREATE OR REPLACE FUNCTION public.approve_emergency_network_handoff(p_incident_id uuid, p_approve boolean)
RETURNS public.emergency_incidents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.emergency_incidents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_row FROM public.emergency_incidents WHERE id = p_incident_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF v_row.status <> 'network_pending_approval' THEN
    RAISE EXCEPTION 'This incident is not waiting for a network approval (current: %)', v_row.status;
  END IF;

  UPDATE public.emergency_incidents
  SET network_approved = p_approve,
      network_rejected = NOT p_approve,
      status = 'dispatching',
      stage = 'dispatch',
      next_action_at = now(),
      locked_until = NULL
  WHERE id = p_incident_id
  RETURNING * INTO v_row;

  PERFORM public._emergency_log(v_row.id, v_owner, 'network', 'info',
    CASE WHEN p_approve THEN 'Network hand-off approved by a person' ELSE 'Network hand-off declined by a person — using the best internal technician' END,
    '{}'::jsonb, 'user:' || auth.uid()::text);
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_emergency_network_handoff(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_emergency_network_handoff(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.retry_emergency_incident(p_incident_id uuid)
RETURNS public.emergency_incidents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.emergency_incidents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_row FROM public.emergency_incidents WHERE id = p_incident_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF v_row.status <> 'needs_human' THEN RAISE EXCEPTION 'Only incidents that need a person can be retried (current: %)', v_row.status; END IF;

  UPDATE public.emergency_incidents
  SET status = 'dispatching', stage = 'dispatch', attempts = 0, last_error = NULL,
      network_rejected = false, next_action_at = now(), locked_until = NULL
  WHERE id = p_incident_id
  RETURNING * INTO v_row;

  PERFORM public._emergency_log(v_row.id, v_owner, 'system', 'info', 'Retried by a person', '{}'::jsonb, 'user:' || auth.uid()::text);
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.retry_emergency_incident(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_emergency_incident(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_emergency_incident(p_incident_id uuid, p_reason text)
RETURNS public.emergency_incidents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.emergency_incidents%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'A reason is required to cancel an incident'; END IF;
  SELECT * INTO v_row FROM public.emergency_incidents WHERE id = p_incident_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF v_row.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'This incident is already finished'; END IF;

  -- Withdraw an unaccepted network offer so no partner is sent to a cancelled emergency.
  IF v_row.handoff_id IS NOT NULL THEN
    UPDATE public.network_handoffs SET status = 'cancelled' WHERE id = v_row.handoff_id AND user_id = v_owner AND status = 'open';
    UPDATE public.network_handoff_matches SET status = 'superseded' WHERE handoff_id = v_row.handoff_id AND status IN ('queued', 'offered');
  END IF;

  UPDATE public.emergency_incidents
  SET status = 'cancelled', closed_at = now(), last_error = left(v_reason, 500), locked_until = NULL
  WHERE id = p_incident_id
  RETURNING * INTO v_row;

  PERFORM public._emergency_log(v_row.id, v_owner, 'system', 'info', 'Cancelled: ' || v_reason, '{}'::jsonb, 'user:' || auth.uid()::text);
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_emergency_incident(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_emergency_incident(uuid, text) TO authenticated;

-- =============================================================
-- RPC (service role): work queue with leases
-- =============================================================

CREATE OR REPLACE FUNCTION public.claim_due_emergency_incidents(p_limit integer DEFAULT 10)
RETURNS SETOF public.emergency_incidents
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.emergency_incidents e
  SET locked_until = now() + interval '2 minutes'
  WHERE e.id IN (
    SELECT i.id FROM public.emergency_incidents i
    WHERE i.status NOT IN ('closed', 'cancelled', 'needs_human')
      AND i.next_action_at <= now()
      AND (i.locked_until IS NULL OR i.locked_until < now())
    ORDER BY i.severity_score DESC, i.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(COALESCE(p_limit, 10), 50))
  )
  RETURNING e.*;
$$;

REVOKE ALL ON FUNCTION public.claim_due_emergency_incidents(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_emergency_incidents(integer) TO service_role;

-- Lease one specific incident (dashboard "run now" / immediate processing after creation).
CREATE OR REPLACE FUNCTION public.claim_emergency_incident(p_incident_id uuid)
RETURNS SETOF public.emergency_incidents
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.emergency_incidents e
  SET locked_until = now() + interval '2 minutes'
  WHERE e.id = p_incident_id
    AND e.status NOT IN ('closed', 'cancelled', 'needs_human')
    AND (e.locked_until IS NULL OR e.locked_until < now())
  RETURNING e.*;
$$;

REVOKE ALL ON FUNCTION public.claim_emergency_incident(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_emergency_incident(uuid) TO service_role;

-- =============================================================
-- RPC (service role): Contractor Network hand-off
-- Posts through the EXISTING post_network_handoff() + compute_handoff_matches() under the owner's identity.
-- =============================================================

CREATE OR REPLACE FUNCTION public.emergency_network_post_handoff(p_incident_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inc public.emergency_incidents%ROWTYPE;
  v_settings public.emergency_network_settings%ROWTYPE;
  v_prev_sub text := current_setting('request.jwt.claim.sub', true);
  v_prev_claims text := current_setting('request.jwt.claims', true);
  v_handoff uuid;
  v_matches integer := 0;
  v_title text;
  v_summary text;
  v_needed timestamptz;
BEGIN
  SELECT * INTO v_inc FROM public.emergency_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident not found'; END IF;
  IF v_inc.handoff_id IS NOT NULL THEN
    RETURN jsonb_build_object('handoff_id', v_inc.handoff_id, 'matches', 0, 'existing', true);
  END IF;
  SELECT * INTO v_settings FROM public.emergency_network_settings WHERE user_id = v_inc.user_id;

  -- Public network fields must never contain contact details: trade + hazard words only.
  v_title := left('Emergency ' || v_inc.required_trade || ' call — ' || upper(v_inc.severity_tier), 120);
  v_summary := left(
    'Priority ' || v_inc.severity_tier || '. Hazards reported: ' ||
    COALESCE(NULLIF(array_to_string(v_inc.hazards, ', '), ''), 'none stated') ||
    '. Response needed as soon as possible.', 1000);
  v_needed := NULL;

  -- Impersonate the account owner for the duration of this transaction only.
  PERFORM set_config('request.jwt.claim.sub', v_inc.user_id::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_inc.user_id, 'role', 'authenticated')::text, true);

  BEGIN
    v_handoff := public.post_network_handoff(
      'emergency', v_inc.required_trade, v_title, v_summary, NULL, v_needed,
      NULL, COALESCE(v_settings.referral_fee_pct, 10),
      v_inc.customer_name, v_inc.customer_phone, v_inc.address,
      'Emergency incident ' || left(v_inc.id::text, 8) || '. Severity ' || v_inc.severity_tier || '. ' || COALESCE(left(v_inc.description, 500), ''),
      true
    );
    v_matches := public.compute_handoff_matches(v_handoff);
  EXCEPTION WHEN OTHERS THEN
    -- Restore identity before surfacing the error.
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
    PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);
    RAISE;
  END;

  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_prev_claims, ''), true);

  -- Emergencies cannot wait 20 minutes for an answer.
  UPDATE public.network_handoff_matches
  SET responds_by = now() + interval '5 minutes'
  WHERE handoff_id = v_handoff AND status = 'offered';

  UPDATE public.emergency_incidents
  SET handoff_id = v_handoff, network_started_at = now()
  WHERE id = p_incident_id;

  RETURN jsonb_build_object('handoff_id', v_handoff, 'matches', v_matches, 'existing', false);
END;
$$;

REVOKE ALL ON FUNCTION public.emergency_network_post_handoff(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emergency_network_post_handoff(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.emergency_network_withdraw(p_incident_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inc public.emergency_incidents%ROWTYPE;
  v_n integer;
BEGIN
  SELECT * INTO v_inc FROM public.emergency_incidents WHERE id = p_incident_id;
  IF NOT FOUND OR v_inc.handoff_id IS NULL THEN RETURN false; END IF;

  UPDATE public.network_handoffs SET status = 'cancelled'
  WHERE id = v_inc.handoff_id AND user_id = v_inc.user_id AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.network_handoff_matches SET status = 'superseded'
  WHERE handoff_id = v_inc.handoff_id AND status IN ('queued', 'offered');

  IF v_n > 0 THEN
    INSERT INTO public.network_handoff_events (handoff_id, actor_id, event) VALUES (v_inc.handoff_id, v_inc.user_id, 'cancelled');
  END IF;
  RETURN v_n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.emergency_network_withdraw(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emergency_network_withdraw(uuid) TO service_role;

-- Keeps emergency offers fast: expire unanswered offers after 5 minutes and offer the next-best member.
CREATE OR REPLACE FUNCTION public.emergency_network_maintain()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_n integer := 0;
BEGIN
  FOR rec IN
    SELECT m.id, m.handoff_id
    FROM public.network_handoff_matches m
    JOIN public.network_handoffs h ON h.id = m.handoff_id
    WHERE m.status = 'offered' AND h.kind = 'emergency' AND h.status = 'open'
      AND m.responds_by IS NOT NULL AND m.responds_by <= now()
    FOR UPDATE OF m SKIP LOCKED
  LOOP
    UPDATE public.network_handoff_matches SET status = 'expired', responded_at = now() WHERE id = rec.id;
    PERFORM public._promote_next_match(rec.handoff_id);
    UPDATE public.network_handoff_matches
    SET responds_by = now() + interval '5 minutes'
    WHERE handoff_id = rec.handoff_id AND status = 'offered';
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.emergency_network_maintain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emergency_network_maintain() TO service_role;

-- =============================================================
-- BRIDGE 1: customer self-triage -> incident
-- (submit_emergency_triage may already have created a job; the orchestrator adopts it, never duplicates it)
-- =============================================================

CREATE OR REPLACE FUNCTION public.emergency_from_triage_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust record;
BEGIN
  BEGIN
    SELECT name, phone, address INTO v_cust FROM public.customers WHERE id = NEW.customer_id;
    PERFORM public.create_emergency_incident(
      NEW.user_id, 'portal', COALESCE(v_cust.name, 'Portal customer'), v_cust.phone, v_cust.address,
      NEW.what_happened, NEW.hazards, NULL, NULL, NULL, NEW.customer_id, NEW.id, false
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'emergency_from_triage_submission failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.emergency_from_triage_submission() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.emergency_triage_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_emergency_from_triage_submission ON public.emergency_triage_submissions;
    CREATE TRIGGER trg_emergency_from_triage_submission
      AFTER INSERT ON public.emergency_triage_submissions
      FOR EACH ROW EXECUTE FUNCTION public.emergency_from_triage_submission();
  END IF;
END;
$$;

-- =============================================================
-- BRIDGE 2: real job status -> incident status
-- =============================================================

CREATE OR REPLACE FUNCTION public.emergency_sync_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inc public.emergency_incidents%ROWTYPE;
  v_status text;
  v_stage text;
BEGIN
  BEGIN
    IF NEW.job_status IS NOT DISTINCT FROM OLD.job_status THEN RETURN NEW; END IF;

    SELECT * INTO v_inc FROM public.emergency_incidents
    WHERE job_id = NEW.id AND status NOT IN ('closed', 'cancelled', 'handed_off')
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN NEW; END IF;

    IF NEW.job_status = 'en_route' THEN v_status := 'en_route'; v_stage := 'job';
    ELSIF NEW.job_status = 'in_progress' THEN v_status := 'on_site'; v_stage := 'job';
    ELSIF NEW.job_status = 'completed' THEN v_status := 'resolved'; v_stage := 'evidence';
    ELSIF NEW.job_status = 'cancelled' THEN v_status := 'needs_human'; v_stage := 'dispatch';
    ELSE RETURN NEW;
    END IF;

    UPDATE public.emergency_incidents
    SET status = v_status, stage = v_stage,
        resolved_at = CASE WHEN v_status = 'resolved' THEN now() ELSE resolved_at END,
        last_error = CASE WHEN v_status = 'needs_human' THEN 'The job was cancelled while the emergency was still open.' ELSE last_error END,
        next_action_at = now(), locked_until = NULL
    WHERE id = v_inc.id;

    PERFORM public._emergency_log(v_inc.id, v_inc.user_id, 'job',
      CASE WHEN v_status = 'needs_human' THEN 'failed' ELSE 'ok' END,
      'Job status changed to ' || NEW.job_status,
      jsonb_build_object('job_id', NEW.id, 'job_status', NEW.job_status), 'system');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'emergency_sync_job_status failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.emergency_sync_job_status() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.jobs') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_emergency_sync_job_status ON public.jobs;
    CREATE TRIGGER trg_emergency_sync_job_status
      AFTER UPDATE OF job_status ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.emergency_sync_job_status();
  END IF;
END;
$$;

COMMENT ON TABLE public.emergency_incidents IS
  'One row per emergency: triage, dispatch, ETA, customer updates, technician prep, job, evidence, payment, follow-up — and the Contractor Network fallback.';
COMMENT ON TABLE public.emergency_incident_events IS
  'Append-only timeline of everything the Emergency Network did for an incident, and why.';
