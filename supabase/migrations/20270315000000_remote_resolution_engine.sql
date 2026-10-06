/*
  # Vireek Remote Resolution Engine

  Product principle: THE BEST TRUCK ROLL IS THE ONE THAT NEVER HAD TO HAPPEN, AND NO CUSTOMER IS EVER
  LEFT STRANDED TRYING. Before a technician is dispatched, Vireek tries to resolve the job remotely
  (adaptive questions, a photo, a sound recording, device readings, service history, safe troubleshooting
  steps) and gives an explainable "chance of resolving without a visit". Safety hazards, a low chance,
  exhausted steps, or a customer who simply asks for a visit all hand over to dispatch immediately.

  ## What this adds
  - remote_resolution_settings : per-account switches (enabled, truck-roll cost, probability threshold, verification window).
  - remote_resolution_cases    : one attempt per job. Server-authoritative: the engine (service role) sets probability,
                                 hypotheses, steps and decisions; staff can only dispatch, withdraw or reopen; the customer
                                 can only confirm / ask for a visit / report the problem is back (token-gated RPCs).
  - remote_resolution_signals  : append-only evidence (answers, photo/audio observations, sensor + history snapshots, step results).
  - rr_devices / rr_device_readings : IoT / sensor readings per equipment, ingested with a per-device key (hash stored only).
  - Evidence Chain integration (uses the existing record_job_evidence_system, nothing existing is modified).
  - In-app notifications on safety hold, customer confirmation, customer-requested visit and reopen.
  - remote_resolution_stats(days): attempts, truck rolls avoided, money saved, reopen rate, Brier score + calibration buckets.
  - Own-data calibration: rr_category_rates() feeds each account's real outcomes back into the probability prior.

  NOTHING here changes jobs.job_status automatically. A job is only closed when staff press "Close job" (rr_close_job_remote),
  so a remote fix never creates a fake cancellation, a trust-bank penalty or a surprise invoice.

  Requires: jobs, equipment, notifications, 20261231000000_job_evidence_chain.sql. Safe to run on top of the current schema.
  NOTE: if your newest migration file has a later timestamp than this one, rename this file so it sorts last.
*/

-- =============================================================
-- 0. PRIVATE MEDIA BUCKET (no policies = no client access; only the service role reads/writes)
-- =============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('remote-resolution-media', 'remote-resolution-media', false)
ON CONFLICT (id) DO NOTHING;

-- =============================================================
-- 1. SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.remote_resolution_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  enabled boolean NOT NULL DEFAULT true,
  truck_roll_cost_cents integer NOT NULL DEFAULT 25000 CHECK (truck_roll_cost_cents BETWEEN 0 AND 10000000),
  attempt_threshold smallint NOT NULL DEFAULT 55 CHECK (attempt_threshold BETWEEN 20 AND 95),
  verification_hours smallint NOT NULL DEFAULT 72 CHECK (verification_hours BETWEEN 24 AND 168),
  hold_hours smallint NOT NULL DEFAULT 6 CHECK (hold_hours BETWEEN 1 AND 24),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.remote_resolution_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rr_settings_select" ON public.remote_resolution_settings;
CREATE POLICY "rr_settings_select" ON public.remote_resolution_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Writes go through remote_resolution_save_settings (owner only).

CREATE OR REPLACE FUNCTION public.remote_resolution_get_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'enabled', coalesce(s.enabled, true),
    'truck_roll_cost_cents', coalesce(s.truck_roll_cost_cents, 25000),
    'attempt_threshold', coalesce(s.attempt_threshold, 55),
    'verification_hours', coalesce(s.verification_hours, 72),
    'hold_hours', coalesce(s.hold_hours, 6)
  )
  FROM (SELECT 1) d
  LEFT JOIN public.remote_resolution_settings s ON s.user_id = public.get_account_owner_id();
$$;

CREATE OR REPLACE FUNCTION public.remote_resolution_save_settings(
  p_enabled boolean,
  p_truck_roll_cost_cents integer,
  p_attempt_threshold integer,
  p_verification_hours integer,
  p_hold_hours integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'RR_FORBIDDEN: only the account owner can change these settings' USING ERRCODE = 'P0001';
  END IF;
  IF p_truck_roll_cost_cents NOT BETWEEN 0 AND 10000000
     OR p_attempt_threshold NOT BETWEEN 20 AND 95
     OR p_verification_hours NOT BETWEEN 24 AND 168
     OR p_hold_hours NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'RR_INVALID: a setting is out of range' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.remote_resolution_settings
    (user_id, enabled, truck_roll_cost_cents, attempt_threshold, verification_hours, hold_hours, updated_at)
  VALUES
    (v_owner, coalesce(p_enabled, true), p_truck_roll_cost_cents, p_attempt_threshold, p_verification_hours, p_hold_hours, now())
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    truck_roll_cost_cents = EXCLUDED.truck_roll_cost_cents,
    attempt_threshold = EXCLUDED.attempt_threshold,
    verification_hours = EXCLUDED.verification_hours,
    hold_hours = EXCLUDED.hold_hours,
    updated_at = now();

  RETURN public.remote_resolution_get_settings();
END;
$$;

-- =============================================================
-- 2. CASES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.remote_resolution_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'intake' CHECK (status IN (
    'intake', 'troubleshooting', 'resolved_pending', 'resolved_remotely',
    'dispatch_required', 'reopened', 'expired', 'withdrawn'
  )),
  symptom text NOT NULL CHECK (char_length(btrim(symptom)) BETWEEN 5 AND 1000),
  locale text CHECK (locale IS NULL OR locale ~ '^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$'),
  category text NOT NULL DEFAULT 'unknown' CHECK (char_length(category) <= 40),
  safety_hold boolean NOT NULL DEFAULT false,
  safety_reasons text[] NOT NULL DEFAULT '{}',
  probability smallint CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  attempt_probability smallint CHECK (attempt_probability IS NULL OR attempt_probability BETWEEN 0 AND 100),
  band text CHECK (band IS NULL OR band IN ('high', 'medium', 'low')),
  completeness numeric(4, 3) CHECK (completeness IS NULL OR completeness BETWEEN 0 AND 1),
  factors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(factors) = 'array'),
  hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hypotheses) = 'array'),
  next_question jsonb CHECK (next_question IS NULL OR jsonb_typeof(next_question) = 'object'),
  photo_request text CHECK (photo_request IS NULL OR char_length(photo_request) <= 300),
  audio_request text CHECK (audio_request IS NULL OR char_length(audio_request) <= 300),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  turns smallint NOT NULL DEFAULT 0 CHECK (turns BETWEEN 0 AND 40),
  truck_roll_cost_cents integer NOT NULL DEFAULT 0 CHECK (truck_roll_cost_cents >= 0),
  avoided_cost_cents integer CHECK (avoided_cost_cents IS NULL OR avoided_cost_cents >= 0),
  dispatch_reason text CHECK (dispatch_reason IS NULL OR dispatch_reason IN (
    'safety', 'low_probability', 'steps_exhausted', 'no_safe_steps', 'insufficient_evidence',
    'customer_request', 'customer_not_fixed', 'staff_override'
  )),
  ai_provider text CHECK (ai_provider IS NULL OR char_length(ai_provider) <= 40),
  ai_model text CHECK (ai_model IS NULL OR char_length(ai_model) <= 80),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  resolved_at timestamptz,
  verification_until timestamptz,
  verified_at timestamptz,
  reopened_at timestamptz,
  created_by uuid,
  created_by_name text,
  start_entry_id uuid,
  outcome_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rr_cases_user_status ON public.remote_resolution_cases (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rr_cases_user_created ON public.remote_resolution_cases (user_id, created_at DESC);

COMMENT ON TABLE public.remote_resolution_cases IS
  'Vireek Remote Resolution Engine: one pre-dispatch remote attempt per job. Engine fields are server-authoritative.';

CREATE OR REPLACE FUNCTION public.rr_usd(p_cents integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '$' || to_char(coalesce(p_cents, 0) / 100.0, 'FM999,999,990.00');
$$;

CREATE OR REPLACE FUNCTION public.rr_transition_ok(p_old text, p_new text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_old
    WHEN 'intake' THEN p_new IN ('troubleshooting', 'resolved_pending', 'dispatch_required', 'expired', 'withdrawn')
    WHEN 'troubleshooting' THEN p_new IN ('resolved_pending', 'dispatch_required', 'expired', 'withdrawn')
    WHEN 'resolved_pending' THEN p_new IN ('resolved_remotely', 'reopened')
    WHEN 'resolved_remotely' THEN p_new IN ('reopened')
    ELSE false
  END;
$$;

-- =============================================================
-- 3. TRIGGERS: prepare / guard
-- =============================================================

CREATE OR REPLACE FUNCTION public.rr_cases_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_status text;
  v_cost integer;
  v_hold smallint;
  v_enabled boolean;
  v_name text;
BEGIN
  SELECT j.user_id, j.job_status INTO v_owner, v_status FROM public.jobs j WHERE j.id = NEW.job_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'RR_INVALID: unknown job' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'scheduled' THEN
    RAISE EXCEPTION 'RR_NOT_DISPATCHABLE: remote resolution is only available before a technician is on the way' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.enabled, s.truck_roll_cost_cents, s.hold_hours INTO v_enabled, v_cost, v_hold
  FROM public.remote_resolution_settings s WHERE s.user_id = v_owner;
  IF v_enabled IS NOT NULL AND NOT v_enabled THEN
    RAISE EXCEPTION 'RR_DISABLED: remote resolution is turned off for this account' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT tm.member_name INTO v_name FROM public.team_members tm WHERE tm.user_id = auth.uid() LIMIT 1;
    IF v_name IS NULL THEN
      SELECT u.email INTO v_name FROM auth.users u WHERE u.id = auth.uid();
    END IF;
  END IF;

  NEW.user_id := v_owner;
  NEW.symptom := btrim(NEW.symptom);
  NEW.status := 'intake';
  NEW.category := 'unknown';
  NEW.safety_hold := false;
  NEW.safety_reasons := '{}';
  NEW.probability := NULL;
  NEW.attempt_probability := NULL;
  NEW.band := NULL;
  NEW.completeness := NULL;
  NEW.factors := '[]'::jsonb;
  NEW.hypotheses := '[]'::jsonb;
  NEW.next_question := NULL;
  NEW.photo_request := NULL;
  NEW.audio_request := NULL;
  NEW.steps := '[]'::jsonb;
  NEW.turns := 0;
  NEW.truck_roll_cost_cents := coalesce(v_cost, 25000);
  NEW.avoided_cost_cents := NULL;
  NEW.dispatch_reason := NULL;
  NEW.ai_provider := NULL;
  NEW.ai_model := NULL;
  NEW.expires_at := now() + make_interval(hours => coalesce(v_hold, 6));
  NEW.decided_at := NULL;
  NEW.resolved_at := NULL;
  NEW.verification_until := NULL;
  NEW.verified_at := NULL;
  NEW.reopened_at := NULL;
  NEW.start_entry_id := NULL;
  NEW.outcome_entry_id := NULL;
  NEW.created_by := auth.uid();
  NEW.created_by_name := v_name;
  NEW.created_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_cases_before_insert ON public.remote_resolution_cases;
CREATE TRIGGER trg_rr_cases_before_insert
  BEFORE INSERT ON public.remote_resolution_cases
  FOR EACH ROW EXECUTE FUNCTION public.rr_cases_before_insert();

CREATE OR REPLACE FUNCTION public.rr_cases_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_internal boolean := coalesce(current_setting('vireek.rr_internal', true), 'off') = 'on';
  v_skip text[] := ARRAY['status', 'dispatch_reason', 'decided_at', 'reopened_at', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'RR_IMMUTABLE: cases cannot be deleted' USING ERRCODE = 'P0001';
  END IF;

  IF (OLD.id, OLD.user_id, OLD.job_id, OLD.symptom, OLD.locale, OLD.truck_roll_cost_cents,
      OLD.created_by, OLD.created_by_name, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.user_id, NEW.job_id, NEW.symptom, NEW.locale, NEW.truck_roll_cost_cents,
      NEW.created_by, NEW.created_by_name, NEW.created_at) THEN
    RAISE EXCEPTION 'RR_IMMUTABLE: case identity cannot be edited' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.rr_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'RR_INVALID_TRANSITION: % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_internal THEN
      IF NOT (
        (OLD.status IN ('intake', 'troubleshooting') AND NEW.status IN ('dispatch_required', 'withdrawn'))
        OR (OLD.status IN ('resolved_pending', 'resolved_remotely') AND NEW.status = 'reopened')
      ) THEN
        RAISE EXCEPTION 'RR_FORBIDDEN: staff can only dispatch, withdraw or reopen a case' USING ERRCODE = 'P0001';
      END IF;
      IF (to_jsonb(NEW) - v_skip) IS DISTINCT FROM (to_jsonb(OLD) - v_skip) THEN
        RAISE EXCEPTION 'RR_FORBIDDEN: staff cannot change engine fields' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.status = 'dispatch_required' THEN
        NEW.dispatch_reason := 'staff_override';
      END IF;
      IF NEW.status = 'reopened' THEN
        NEW.reopened_at := now();
      END IF;
      NEW.decided_at := now();
    END IF;
  ELSIF NOT v_internal THEN
    RAISE EXCEPTION 'RR_IMMUTABLE: case cannot be edited' USING ERRCODE = 'P0001';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_cases_guard ON public.remote_resolution_cases;
CREATE TRIGGER trg_rr_cases_guard
  BEFORE UPDATE OR DELETE ON public.remote_resolution_cases
  FOR EACH ROW EXECUTE FUNCTION public.rr_cases_guard();

CREATE OR REPLACE FUNCTION public.rr_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RR_IMMUTABLE: cannot truncate' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_cases_block_truncate ON public.remote_resolution_cases;
CREATE TRIGGER trg_rr_cases_block_truncate
  BEFORE TRUNCATE ON public.remote_resolution_cases
  FOR EACH STATEMENT EXECUTE FUNCTION public.rr_block_truncate();

-- =============================================================
-- 4. SIGNALS (append-only evidence)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.remote_resolution_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.remote_resolution_cases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('answer', 'photo', 'audio', 'sensor', 'history', 'step_result', 'note', 'system')),
  source text NOT NULL CHECK (source IN ('customer', 'staff', 'ai', 'device', 'system')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 60),
  value jsonb NOT NULL CHECK (octet_length(value::text) <= 6000),
  confidence numeric(3, 2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  storage_path text CHECK (storage_path IS NULL OR char_length(storage_path) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rr_signals_case ON public.remote_resolution_signals (case_id, created_at);

CREATE OR REPLACE FUNCTION public.rr_signals_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.remote_resolution_cases WHERE id = OLD.case_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RR_IMMUTABLE: signals are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_signals_guard ON public.remote_resolution_signals;
CREATE TRIGGER trg_rr_signals_guard
  BEFORE UPDATE OR DELETE ON public.remote_resolution_signals
  FOR EACH ROW EXECUTE FUNCTION public.rr_signals_guard();

DROP TRIGGER IF EXISTS trg_rr_signals_block_truncate ON public.remote_resolution_signals;
CREATE TRIGGER trg_rr_signals_block_truncate
  BEFORE TRUNCATE ON public.remote_resolution_signals
  FOR EACH STATEMENT EXECUTE FUNCTION public.rr_block_truncate();

-- =============================================================
-- 5. RLS (same tenant model as the evidence chain)
-- =============================================================

ALTER TABLE public.remote_resolution_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_resolution_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rr_cases_select" ON public.remote_resolution_cases;
CREATE POLICY "rr_cases_select" ON public.remote_resolution_cases FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = remote_resolution_cases.job_id));

DROP POLICY IF EXISTS "rr_cases_insert" ON public.remote_resolution_cases;
CREATE POLICY "rr_cases_insert" ON public.remote_resolution_cases FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = remote_resolution_cases.job_id));

-- Staff may only move a case to dispatch_required / withdrawn / reopened (enforced again by rr_cases_guard).
DROP POLICY IF EXISTS "rr_cases_staff_update" ON public.remote_resolution_cases;
CREATE POLICY "rr_cases_staff_update" ON public.remote_resolution_cases FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND status IN ('intake', 'troubleshooting', 'resolved_pending', 'resolved_remotely')
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = remote_resolution_cases.job_id)
  )
  WITH CHECK (user_id = public.get_account_owner_id() AND status IN ('dispatch_required', 'withdrawn', 'reopened'));

DROP POLICY IF EXISTS "rr_signals_select" ON public.remote_resolution_signals;
CREATE POLICY "rr_signals_select" ON public.remote_resolution_signals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 6. EXPIRY / VERIFICATION FLUSH
-- =============================================================

CREATE OR REPLACE FUNCTION public.rr_flush_case(p_case_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
BEGIN
  PERFORM set_config('vireek.rr_internal', 'on', true);

  UPDATE public.remote_resolution_cases
  SET status = 'expired', decided_at = now()
  WHERE id = p_case_id AND status IN ('intake', 'troubleshooting') AND expires_at < now();

  UPDATE public.remote_resolution_cases
  SET status = 'resolved_remotely', verified_at = now(), avoided_cost_cents = truck_roll_cost_cents
  WHERE id = p_case_id AND status = 'resolved_pending' AND verification_until IS NOT NULL AND verification_until < now();

  PERFORM set_config('vireek.rr_internal', v_prev, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.remote_resolution_flush()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r record;
BEGIN
  IF v_owner IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT id FROM public.remote_resolution_cases c
    WHERE c.user_id = v_owner
      AND ((c.status IN ('intake', 'troubleshooting') AND c.expires_at < now())
        OR (c.status = 'resolved_pending' AND c.verification_until < now()))
    LIMIT 200
  LOOP
    PERFORM public.rr_flush_case(r.id);
  END LOOP;
END;
$$;

-- =============================================================
-- 7. EVIDENCE CHAIN + NOTIFICATIONS
-- =============================================================

CREATE OR REPLACE FUNCTION public.rr_cases_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
BEGIN
  -- The evidence chain is best effort: it must never block a customer-facing flow.
  BEGIN
    v_id := public.record_job_evidence_system(
      NEW.job_id, 'diagnosis', 'system',
      'Remote resolution attempt started',
      left('Customer-reported problem: ' || NEW.symptom, 3900),
      jsonb_build_object('remote_resolution', true, 'phase', 'start', 'case_id', NEW.id),
      'system', 'rr-start:' || NEW.id::text, '{}'::uuid[]
    );
    IF v_id IS NOT NULL THEN
      PERFORM set_config('vireek.rr_internal', 'on', true);
      UPDATE public.remote_resolution_cases SET start_entry_id = v_id WHERE id = NEW.id;
      PERFORM set_config('vireek.rr_internal', v_prev, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('vireek.rr_internal', v_prev, true);
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_cases_after_insert ON public.remote_resolution_cases;
CREATE TRIGGER trg_rr_cases_after_insert
  AFTER INSERT ON public.remote_resolution_cases
  FOR EACH ROW EXECUTE FUNCTION public.rr_cases_after_insert();

CREATE OR REPLACE FUNCTION public.rr_cases_after_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_title text;
  v_detail text;
  v_kind text := 'system';
  v_actor text := 'system';
  v_refs uuid[] := CASE WHEN NEW.start_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.start_entry_id] END;
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
  v_customer text;
  v_notify boolean;
  v_ntitle text;
BEGIN
  IF NEW.status = 'troubleshooting' THEN
    v_title := 'Remote troubleshooting offered to the customer';
    v_detail := 'Estimated chance of resolving without a visit: ' || coalesce(NEW.attempt_probability::text, '?') || '%.';
  ELSIF NEW.status = 'resolved_pending' THEN
    v_kind := 'statement'; v_actor := 'customer';
    v_title := 'Customer reports the problem is fixed';
    v_detail := 'Verification window open until ' || to_char(NEW.verification_until AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC. If the problem returns the customer gets priority dispatch.';
  ELSIF NEW.status = 'resolved_remotely' THEN
    v_title := 'Remote resolution verified - truck roll avoided';
    v_detail := 'No problem reported during the verification window. Estimated saving ' || public.rr_usd(NEW.avoided_cost_cents) || '.';
  ELSIF NEW.status = 'dispatch_required' THEN
    v_title := 'Remote attempt ended - technician required';
    v_detail := 'Reason: ' || replace(coalesce(NEW.dispatch_reason, 'unspecified'), '_', ' ') || '.';
    IF NEW.dispatch_reason IN ('customer_request', 'customer_not_fixed') THEN v_actor := 'customer'; v_kind := 'statement'; END IF;
  ELSIF NEW.status = 'reopened' THEN
    v_title := 'Problem returned after remote resolution - priority dispatch';
    v_detail := 'The customer was not left waiting: this job goes to the front of the queue.';
  ELSIF NEW.status = 'expired' THEN
    v_title := 'Remote attempt expired without a resolution';
    v_detail := 'No further customer activity. Normal dispatch applies.';
  ELSIF NEW.status = 'withdrawn' THEN
    v_title := 'Remote attempt withdrawn by staff';
    v_detail := 'Staff chose to skip remote resolution for this job.';
  END IF;

  IF v_title IS NOT NULL THEN
    BEGIN
      v_id := public.record_job_evidence_system(
        NEW.job_id, 'diagnosis', v_kind, v_title, v_detail,
        jsonb_strip_nulls(jsonb_build_object(
          'remote_resolution', true, 'phase', NEW.status, 'case_id', NEW.id,
          'attempt_probability', NEW.attempt_probability, 'dispatch_reason', NEW.dispatch_reason,
          'avoided_cost_cents', NEW.avoided_cost_cents, 'safety_reasons', to_jsonb(NEW.safety_reasons)
        )),
        v_actor, 'rr-' || NEW.status || ':' || NEW.id::text, v_refs
      );
      IF v_id IS NOT NULL THEN
        PERFORM set_config('vireek.rr_internal', 'on', true);
        UPDATE public.remote_resolution_cases SET outcome_entry_id = v_id WHERE id = NEW.id;
        PERFORM set_config('vireek.rr_internal', v_prev, true);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('vireek.rr_internal', v_prev, true);
    END;
  END IF;

  IF NEW.status IN ('resolved_pending', 'dispatch_required', 'reopened') AND coalesce(NEW.dispatch_reason, '') <> 'staff_override' THEN
    BEGIN
      SELECT coalesce(p.notify_job_update, true) INTO v_notify FROM public.profiles p WHERE p.id = NEW.user_id;
      IF coalesce(v_notify, true) THEN
        SELECT j.customer_name INTO v_customer FROM public.jobs j WHERE j.id = NEW.job_id;
        v_ntitle := CASE
          WHEN NEW.status = 'reopened' THEN 'Problem is back - dispatch with priority'
          WHEN NEW.status = 'resolved_pending' THEN 'Customer fixed the problem remotely'
          WHEN NEW.dispatch_reason = 'safety' THEN 'Safety risk reported - dispatch now'
          ELSE 'Customer needs a technician' END;
        INSERT INTO public.notifications (user_id, type, title, message, action_url)
        VALUES (NEW.user_id, 'job_update', v_ntitle, coalesce(v_customer, 'Customer') || ': ' || left(NEW.symptom, 120), '/dashboard/jobs');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_cases_after_status ON public.remote_resolution_cases;
CREATE TRIGGER trg_rr_cases_after_status
  AFTER UPDATE OF status ON public.remote_resolution_cases
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.rr_cases_after_status();

-- =============================================================
-- 8. ENGINE RPCs (service role only: called by the remote-resolution edge function)
-- =============================================================

CREATE OR REPLACE FUNCTION public.rr_apply_turn(p_case_id uuid, p_patch jsonb, p_signals jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case public.remote_resolution_cases%ROWTYPE;
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
  v_decision text := coalesce(p_patch->>'decision', 'ask');
  v_new_status text;
  v_prob smallint;
  v_expires timestamptz;
  v_sig jsonb;
BEGIN
  SELECT * INTO v_case FROM public.remote_resolution_cases WHERE id = p_case_id FOR UPDATE;
  IF v_case.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_case.status NOT IN ('intake', 'troubleshooting') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_active', 'status', v_case.status);
  END IF;
  IF v_decision NOT IN ('ask', 'troubleshoot', 'dispatch') THEN
    RAISE EXCEPTION 'RR_INVALID: bad decision' USING ERRCODE = 'P0001';
  END IF;

  v_prob := (p_patch->>'probability')::smallint;
  v_new_status := CASE v_decision WHEN 'dispatch' THEN 'dispatch_required' WHEN 'troubleshoot' THEN 'troubleshooting' ELSE v_case.status END;
  v_expires := CASE WHEN v_decision = 'dispatch' THEN v_case.expires_at
    ELSE least(v_case.created_at + interval '24 hours', greatest(v_case.expires_at, now() + interval '2 hours')) END;

  PERFORM set_config('vireek.rr_internal', 'on', true);

  UPDATE public.remote_resolution_cases SET
    status = v_new_status,
    category = coalesce(left(p_patch->>'category', 40), category),
    safety_hold = coalesce((p_patch->>'safety_hold')::boolean, safety_hold),
    safety_reasons = CASE WHEN jsonb_typeof(p_patch->'safety_reasons') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'safety_reasons')) ELSE safety_reasons END,
    probability = v_prob,
    attempt_probability = CASE WHEN v_new_status = 'troubleshooting' THEN coalesce(attempt_probability, v_prob) ELSE attempt_probability END,
    band = p_patch->>'band',
    completeness = (p_patch->>'completeness')::numeric,
    factors = coalesce(p_patch->'factors', '[]'::jsonb),
    hypotheses = coalesce(p_patch->'hypotheses', '[]'::jsonb),
    next_question = CASE WHEN jsonb_typeof(p_patch->'next_question') = 'object' THEN p_patch->'next_question' ELSE NULL END,
    photo_request = nullif(left(coalesce(p_patch->>'photo_request', ''), 300), ''),
    audio_request = nullif(left(coalesce(p_patch->>'audio_request', ''), 300), ''),
    steps = coalesce(p_patch->'steps', steps),
    turns = least(turns + 1, 40),
    dispatch_reason = CASE WHEN v_decision = 'dispatch' THEN p_patch->>'dispatch_reason' ELSE dispatch_reason END,
    decided_at = CASE WHEN v_decision = 'dispatch' THEN now() ELSE decided_at END,
    ai_provider = coalesce(left(p_patch->>'ai_provider', 40), ai_provider),
    ai_model = coalesce(left(p_patch->>'ai_model', 80), ai_model),
    expires_at = v_expires
  WHERE id = p_case_id;

  IF jsonb_typeof(p_signals) = 'array' THEN
    FOR v_sig IN SELECT value FROM jsonb_array_elements(p_signals) LOOP
      INSERT INTO public.remote_resolution_signals (case_id, user_id, kind, source, key, value, confidence, storage_path)
      VALUES (
        p_case_id, v_case.user_id, v_sig->>'kind', v_sig->>'source', left(v_sig->>'key', 60), v_sig->'value',
        (v_sig->>'confidence')::numeric, nullif(left(coalesce(v_sig->>'storage_path', ''), 300), '')
      );
    END LOOP;
  END IF;

  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RETURN jsonb_build_object('ok', true, 'status', v_new_status);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RAISE;
END;
$$;

-- Account-level observed outcomes per category: the engine's self-calibration input.
CREATE OR REPLACE FUNCTION public.rr_category_rates(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_object_agg(category, jsonb_build_object('n', n, 'rate', rate)), '{}'::jsonb)
  FROM (
    SELECT category,
           count(*) AS n,
           round(avg((status = 'resolved_remotely')::int)::numeric, 4) AS rate
    FROM public.remote_resolution_cases
    WHERE user_id = p_user_id
      AND attempt_probability IS NOT NULL
      AND status IN ('resolved_remotely', 'dispatch_required', 'reopened')
      AND created_at >= now() - interval '365 days'
    GROUP BY category
  ) t;
$$;

-- =============================================================
-- 9. PUBLIC (TOKEN-GATED) CUSTOMER API
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_remote_resolution_room(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_case public.remote_resolution_cases%ROWTYPE;
  v_case_id uuid;
  v_biz text;
  v_photos integer;
  v_audio integer;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_job FROM public.jobs j WHERE j.reschedule_token = p_token;
  IF v_job.id IS NULL THEN RETURN NULL; END IF;

  SELECT c.id INTO v_case_id FROM public.remote_resolution_cases c WHERE c.job_id = v_job.id;
  IF v_case_id IS NOT NULL THEN
    PERFORM public.rr_flush_case(v_case_id);
    SELECT * INTO v_case FROM public.remote_resolution_cases c WHERE c.id = v_case_id;
    SELECT count(*) FILTER (WHERE kind = 'photo'), count(*) FILTER (WHERE kind = 'audio')
    INTO v_photos, v_audio FROM public.remote_resolution_signals s WHERE s.case_id = v_case_id;
  END IF;

  SELECT p.company_name INTO v_biz FROM public.profiles p WHERE p.id = v_job.user_id;

  RETURN jsonb_build_object(
    'business_name', v_biz,
    'customer_first_name', nullif(split_part(btrim(v_job.customer_name), ' ', 1), ''),
    'service_type', v_job.service_type,
    'job_status', v_job.job_status,
    'limits', jsonb_build_object('photos', 4, 'audio', 2, 'turns', 12),
    'case', CASE WHEN v_case.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_case.id,
      'status', v_case.status,
      'symptom', v_case.symptom,
      'locale', v_case.locale,
      'band', v_case.band,
      'safety_hold', v_case.safety_hold,
      'safety_reasons', to_jsonb(v_case.safety_reasons),
      'next_question', v_case.next_question,
      'photo_request', v_case.photo_request,
      'audio_request', v_case.audio_request,
      'steps', v_case.steps,
      'turns', v_case.turns,
      'photos_used', coalesce(v_photos, 0),
      'audio_used', coalesce(v_audio, 0),
      'dispatch_reason', v_case.dispatch_reason,
      'verification_until', v_case.verification_until,
      'resolved_at', v_case.resolved_at,
      'verified_at', v_case.verified_at,
      'updated_at', v_case.updated_at
    ) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rr_customer_confirm(p_token uuid, p_outcome text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case public.remote_resolution_cases%ROWTYPE;
  v_hours smallint;
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
BEGIN
  IF p_token IS NULL OR p_outcome NOT IN ('fixed', 'not_fixed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;

  SELECT c.* INTO v_case
  FROM public.remote_resolution_cases c JOIN public.jobs j ON j.id = c.job_id
  WHERE j.reschedule_token = p_token
  FOR UPDATE OF c;
  IF v_case.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  PERFORM public.rr_flush_case(v_case.id);
  SELECT * INTO v_case FROM public.remote_resolution_cases WHERE id = v_case.id;
  IF v_case.status NOT IN ('intake', 'troubleshooting') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_active', 'status', v_case.status);
  END IF;

  PERFORM set_config('vireek.rr_internal', 'on', true);
  IF p_outcome = 'fixed' THEN
    SELECT s.verification_hours INTO v_hours FROM public.remote_resolution_settings s WHERE s.user_id = v_case.user_id;
    UPDATE public.remote_resolution_cases
    SET status = 'resolved_pending', decided_at = now(), resolved_at = now(),
        verification_until = now() + make_interval(hours => coalesce(v_hours, 72)),
        next_question = NULL, photo_request = NULL, audio_request = NULL
    WHERE id = v_case.id;
  ELSE
    UPDATE public.remote_resolution_cases
    SET status = 'dispatch_required', decided_at = now(), next_question = NULL, photo_request = NULL, audio_request = NULL,
        dispatch_reason = CASE WHEN v_case.status = 'troubleshooting' THEN 'customer_not_fixed' ELSE 'customer_request' END
    WHERE id = v_case.id;
  END IF;
  PERFORM set_config('vireek.rr_internal', v_prev, true);

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.rr_customer_request_visit(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case public.remote_resolution_cases%ROWTYPE;
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;
  SELECT c.* INTO v_case
  FROM public.remote_resolution_cases c JOIN public.jobs j ON j.id = c.job_id
  WHERE j.reschedule_token = p_token
  FOR UPDATE OF c;
  IF v_case.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_case.status NOT IN ('intake', 'troubleshooting') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_active', 'status', v_case.status);
  END IF;

  PERFORM set_config('vireek.rr_internal', 'on', true);
  UPDATE public.remote_resolution_cases
  SET status = 'dispatch_required', dispatch_reason = 'customer_request', decided_at = now(),
      next_question = NULL, photo_request = NULL, audio_request = NULL
  WHERE id = v_case.id;
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.rr_customer_report_back(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case public.remote_resolution_cases%ROWTYPE;
  v_prev text := coalesce(current_setting('vireek.rr_internal', true), 'off');
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;
  SELECT c.* INTO v_case
  FROM public.remote_resolution_cases c JOIN public.jobs j ON j.id = c.job_id
  WHERE j.reschedule_token = p_token
  FOR UPDATE OF c;
  IF v_case.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_case.status NOT IN ('resolved_pending', 'resolved_remotely') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_active', 'status', v_case.status);
  END IF;
  IF v_case.status = 'resolved_remotely' AND v_case.verified_at < now() - interval '30 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'window_closed');
  END IF;

  PERFORM set_config('vireek.rr_internal', 'on', true);
  UPDATE public.remote_resolution_cases
  SET status = 'reopened', reopened_at = now(), decided_at = now(), avoided_cost_cents = NULL
  WHERE id = v_case.id;
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.rr_internal', v_prev, true);
  RAISE;
END;
$$;

-- =============================================================
-- 10. STAFF HELPERS
-- =============================================================

-- Closes the job as completed ONLY after the customer confirmed the fix. Never auto-runs, never cancels.
CREATE OR REPLACE FUNCTION public.rr_close_job_remote(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_case_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = public.get_account_owner_id()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  SELECT c.id, c.status INTO v_case_id, v_status FROM public.remote_resolution_cases c WHERE c.job_id = p_job_id;
  IF v_case_id IS NULL OR v_status NOT IN ('resolved_pending', 'resolved_remotely') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_resolved');
  END IF;

  UPDATE public.jobs
  SET job_status = 'completed',
      work_performed_notes = coalesce(nullif(work_performed_notes, '') || E'\n', '')
        || 'Resolved remotely by the customer with Vireek guidance (no truck roll).'
  WHERE id = p_job_id AND job_status = 'scheduled';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'job_not_scheduled');
  END IF;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.remote_resolution_stats(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 730);
  v_res jsonb;
BEGIN
  WITH c AS (
    SELECT * FROM public.remote_resolution_cases WHERE created_at >= now() - make_interval(days => v_days)
  ), a AS (
    SELECT attempt_probability, (status = 'resolved_remotely')::int AS ok
    FROM c
    WHERE attempt_probability IS NOT NULL AND status IN ('resolved_remotely', 'dispatch_required', 'reopened')
  )
  SELECT jsonb_build_object(
    'days', v_days,
    'cases', (SELECT count(*) FROM c),
    'active', (SELECT count(*) FROM c WHERE status IN ('intake', 'troubleshooting')),
    'pending_verification', (SELECT count(*) FROM c WHERE status = 'resolved_pending'),
    'resolved_remotely', (SELECT count(*) FROM c WHERE status = 'resolved_remotely'),
    'dispatched', (SELECT count(*) FROM c WHERE status = 'dispatch_required'),
    'reopened', (SELECT count(*) FROM c WHERE status = 'reopened'),
    'avoided_cost_cents', (SELECT coalesce(sum(avoided_cost_cents), 0) FROM c WHERE status = 'resolved_remotely'),
    'pending_savings_cents', (SELECT coalesce(sum(truck_roll_cost_cents), 0) FROM c WHERE status = 'resolved_pending'),
    'attempted', (SELECT count(*) FROM a),
    'resolved_of_attempted', (SELECT coalesce(sum(ok), 0) FROM a),
    'avg_attempt_probability', (SELECT round(avg(attempt_probability)::numeric, 1) FROM a),
    'brier', (SELECT round(avg(power(attempt_probability / 100.0 - ok, 2))::numeric, 4) FROM a),
    'calibration', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', q.bucket, 'n', q.n, 'predicted', q.pred, 'actual', q.act) ORDER BY q.bucket), '[]'::jsonb)
      FROM (
        SELECT least(attempt_probability / 25, 3) AS bucket,
               count(*) AS n,
               round(avg(attempt_probability)::numeric, 1) AS pred,
               round((avg(ok) * 100)::numeric, 1) AS act
        FROM a GROUP BY 1
      ) q
    )
  ) INTO v_res;
  RETURN v_res;
END;
$$;

-- =============================================================
-- 11. DEVICES / SENSORS (IoT)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.rr_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 80),
  vendor text CHECK (vendor IS NULL OR char_length(vendor) <= 60),
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rr_devices_user ON public.rr_devices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rr_devices_equipment ON public.rr_devices (equipment_id);

CREATE TABLE IF NOT EXISTS public.rr_device_readings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES public.rr_devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[a-z0-9_]{2,40}$'),
  value_num double precision NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rr_readings_equipment ON public.rr_device_readings (equipment_id, metric, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rr_readings_device_recv ON public.rr_device_readings (device_id, received_at DESC);

ALTER TABLE public.rr_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rr_device_readings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rr_devices_select" ON public.rr_devices;
CREATE POLICY "rr_devices_select" ON public.rr_devices FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Staff may only switch a device on/off or relabel it (key + equipment are fixed at registration).
DROP POLICY IF EXISTS "rr_devices_update" ON public.rr_devices;
CREATE POLICY "rr_devices_update" ON public.rr_devices FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.rr_devices_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.id, OLD.user_id, OLD.equipment_id, OLD.key_hash, OLD.key_prefix, OLD.created_at)
     IS DISTINCT FROM (NEW.id, NEW.user_id, NEW.equipment_id, NEW.key_hash, NEW.key_prefix, NEW.created_at) THEN
    RAISE EXCEPTION 'RR_IMMUTABLE: device identity cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rr_devices_guard ON public.rr_devices;
CREATE TRIGGER trg_rr_devices_guard
  BEFORE UPDATE ON public.rr_devices
  FOR EACH ROW EXECUTE FUNCTION public.rr_devices_guard();

DROP POLICY IF EXISTS "rr_readings_select" ON public.rr_device_readings;
CREATE POLICY "rr_readings_select" ON public.rr_device_readings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- Returns the secret key ONCE. Only its SHA-256 hash is stored.
CREATE OR REPLACE FUNCTION public.rr_register_device(p_equipment_id uuid, p_label text, p_vendor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_key text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'RR_FORBIDDEN: sign in first' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = p_equipment_id AND e.user_id = v_owner) THEN
    RAISE EXCEPTION 'RR_INVALID: unknown equipment' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.rr_devices d WHERE d.user_id = v_owner AND d.active) >= 200 THEN
    RAISE EXCEPTION 'RR_LIMIT: too many active devices' USING ERRCODE = 'P0001';
  END IF;

  v_key := 'rrk_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  INSERT INTO public.rr_devices (user_id, equipment_id, label, vendor, key_hash, key_prefix)
  VALUES (v_owner, p_equipment_id, btrim(p_label), nullif(btrim(coalesce(p_vendor, '')), ''),
          encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), left(v_key, 8))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('device_id', v_id, 'key', v_key);
END;
$$;

-- Service role only (called by the rr-device-ingest edge function after range validation).
CREATE OR REPLACE FUNCTION public.rr_ingest_readings(p_key text, p_readings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.rr_devices%ROWTYPE;
  v_n integer := 0;
  r jsonb;
BEGIN
  IF p_key IS NULL OR char_length(p_key) NOT BETWEEN 20 AND 120 OR jsonb_typeof(p_readings) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;

  SELECT * INTO v_dev FROM public.rr_devices d
  WHERE d.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex') AND d.active;
  IF v_dev.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  IF (SELECT count(*) FROM public.rr_device_readings x WHERE x.device_id = v_dev.id AND x.received_at > now() - interval '1 minute') > 300 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(p_readings) LIMIT 50 LOOP
    INSERT INTO public.rr_device_readings (device_id, user_id, equipment_id, metric, value_num, observed_at)
    VALUES (v_dev.id, v_dev.user_id, v_dev.equipment_id, r->>'metric', (r->>'value')::double precision,
            least(coalesce((r->>'observed_at')::timestamptz, now()), now()));
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.rr_devices SET last_seen_at = now() WHERE id = v_dev.id;
  RETURN jsonb_build_object('ok', true, 'inserted', v_n);
END;
$$;

-- Optional housekeeping (schedule with pg_cron if enabled): readings older than 60 days.
CREATE OR REPLACE FUNCTION public.rr_prune_readings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.rr_device_readings WHERE observed_at < now() - interval '60 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- =============================================================
-- 12. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.rr_cases_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_cases_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_cases_after_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_cases_after_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_signals_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_flush_case(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rr_apply_turn(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rr_apply_turn(uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rr_category_rates(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rr_category_rates(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rr_ingest_readings(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rr_ingest_readings(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rr_prune_readings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rr_prune_readings() TO service_role;

REVOKE ALL ON FUNCTION public.remote_resolution_get_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remote_resolution_get_settings() TO authenticated;
REVOKE ALL ON FUNCTION public.remote_resolution_save_settings(boolean, integer, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remote_resolution_save_settings(boolean, integer, integer, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.remote_resolution_flush() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remote_resolution_flush() TO authenticated;
REVOKE ALL ON FUNCTION public.remote_resolution_stats(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remote_resolution_stats(integer) TO authenticated;
REVOKE ALL ON FUNCTION public.rr_close_job_remote(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rr_close_job_remote(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rr_register_device(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rr_register_device(uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_remote_resolution_room(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_resolution_room(uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_customer_confirm(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rr_customer_confirm(uuid, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_customer_request_visit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rr_customer_request_visit(uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_customer_report_back(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rr_customer_report_back(uuid) TO anon, authenticated;

-- =============================================================
-- 13. REALTIME (the dashboard sees the customer's progress instantly)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'remote_resolution_cases'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.remote_resolution_cases;
  END IF;
END;
$$;
