/*
  # Call masking (proxy numbers) between technician and customer

  A customer and a technician talk through a temporary PROXY number from a pool the
  business owns. Neither side ever sees the other's real phone number:
    - customer calls the proxy number      -> rings the technician's mobile
    - technician calls the proxy number    -> rings the customer
    - technician taps "Call customer"      -> server bridge, customer sees the proxy number

  ## Objects
  - proxy_numbers                : the pool (one row per Twilio number, account-scoped)
  - proxy_sessions               : one row per job / technician / customer conversation
  - proxy_call_events            : append-only call log (written only by service_role)
  - proxy_number_stats           : per-number load (security_invoker view)
  - RPCs: proxy_set_technician_phone, proxy_allocate_session, proxy_close_session,
          proxy_extend_session, proxy_my_sessions, proxy_prepare_bridge,
          proxy_resolve_inbound (service_role only)
  - trigger on jobs: closes sessions when a job is cancelled, shortens them 24h after completion

  ## Rules
  - Everything is scoped by account_owner_id = get_account_owner_id().
  - A phone number may appear on a proxy number in only ONE role (customer OR technician),
    so an inbound caller always resolves to exactly one session. Enforced under an advisory lock.
  - Sessions are terminal once closed / expired (no reopening).
  - Technicians never read customer numbers: they only get proxy_my_sessions().

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, team_members (user_id,
  member_phone, permissions), jobs, customers, phone_numbers
*/

-- 0) Helpers ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_phone_e164(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_digits text;
BEGIN
  IF p_raw IS NULL THEN RETURN NULL; END IF;
  v_digits := regexp_replace(p_raw, '\D', '', 'g');
  IF left(btrim(p_raw), 1) = '+' THEN
    IF v_digits ~ '^[1-9][0-9]{7,14}$' THEN RETURN '+' || v_digits; END IF;
    RETURN NULL;
  END IF;
  IF v_digits ~ '^[2-9][0-9]{9}$' THEN RETURN '+1' || v_digits; END IF;
  IF v_digits ~ '^1[2-9][0-9]{9}$' THEN RETURN '+' || v_digits; END IF;
  RETURN NULL;
END;
$$;

-- Dispatchers / managers: may create and close sessions, see the console.
CREATE OR REPLACE FUNCTION public.proxy_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.identity_is_manager(), false)
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND COALESCE((m.permissions ->> 'can_view_all_jobs')::boolean, false)
    );
$$;

-- Number administrators: may edit the pool and technician phones.
CREATE OR REPLACE FUNCTION public.proxy_can_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.identity_is_manager(), false)
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND COALESCE((m.permissions ->> 'can_manage_numbers')::boolean, false)
    );
$$;

REVOKE ALL ON FUNCTION public.proxy_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_can_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proxy_can_manage() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.proxy_can_admin() TO authenticated, service_role;

-- 1) Proxy number pool ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.proxy_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  e164 text NOT NULL,
  label text,
  status text NOT NULL DEFAULT 'active',
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proxy_numbers_e164_check CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT proxy_numbers_label_check CHECK (label IS NULL OR char_length(label) <= 80),
  CONSTRAINT proxy_numbers_status_check CHECK (status IN ('active', 'paused', 'retired')),
  CONSTRAINT proxy_numbers_e164_unique UNIQUE (e164)
);

CREATE INDEX IF NOT EXISTS idx_proxy_numbers_owner ON public.proxy_numbers(account_owner_id, status);

-- 2) Sessions ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.proxy_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  proxy_number_id uuid NOT NULL REFERENCES public.proxy_numbers(id),
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  technician_name text,
  customer_e164 text NOT NULL,
  technician_e164 text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proxy_sessions_status_check CHECK (status IN ('active', 'closed', 'expired')),
  CONSTRAINT proxy_sessions_customer_check CHECK (customer_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT proxy_sessions_tech_check CHECK (technician_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT proxy_sessions_distinct_check CHECK (customer_e164 <> technician_e164),
  CONSTRAINT proxy_sessions_name_check CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 120),
  CONSTRAINT proxy_sessions_reason_check CHECK (close_reason IS NULL OR char_length(close_reason) <= 60)
);

CREATE INDEX IF NOT EXISTS idx_ps_owner_status ON public.proxy_sessions(account_owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ps_job ON public.proxy_sessions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ps_technician ON public.proxy_sessions(technician_id) WHERE technician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ps_number_lookup ON public.proxy_sessions(proxy_number_id, status, expires_at);
-- Backstop for the allocator: one live session per (number, phone, role).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_active_customer
  ON public.proxy_sessions(proxy_number_id, customer_e164) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_active_technician
  ON public.proxy_sessions(proxy_number_id, technician_e164) WHERE status = 'active';

-- 3) Call log (append-only; service_role writes) -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.proxy_call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.proxy_sessions(id) ON DELETE SET NULL,
  proxy_number_id uuid REFERENCES public.proxy_numbers(id) ON DELETE SET NULL,
  direction text NOT NULL,
  call_sid text,
  status text NOT NULL DEFAULT 'initiated',
  duration_seconds integer,
  caller_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pce_direction_check CHECK (
    direction IN ('customer_to_technician', 'technician_to_customer', 'bridge_technician_to_customer', 'blocked')
  ),
  CONSTRAINT pce_status_check CHECK (
    status IN ('initiated', 'ringing', 'in_progress', 'completed', 'busy', 'no_answer', 'failed', 'canceled', 'blocked')
  ),
  CONSTRAINT pce_duration_check CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  CONSTRAINT pce_hint_check CHECK (caller_hint IS NULL OR char_length(caller_hint) <= 8)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pce_call_sid ON public.proxy_call_events(call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pce_session ON public.proxy_call_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pce_owner ON public.proxy_call_events(account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pce_number ON public.proxy_call_events(proxy_number_id, created_at DESC);

-- 4) Guard triggers -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proxy_numbers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.label := NULLIF(btrim(COALESCE(NEW.label, '')), '');
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM phone_numbers p WHERE p.phone_number = NEW.e164 AND p.status <> 'released'
    ) THEN
      RAISE EXCEPTION 'number_is_business_line' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.e164 IS DISTINCT FROM OLD.e164
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'owner and number of a proxy number are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired proxy number cannot be reactivated' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proxy_numbers_guard ON public.proxy_numbers;
CREATE TRIGGER trg_proxy_numbers_guard
  BEFORE INSERT OR UPDATE ON public.proxy_numbers
  FOR EACH ROW EXECUTE FUNCTION public.proxy_numbers_guard();

CREATE OR REPLACE FUNCTION public.proxy_numbers_retire_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE proxy_sessions
     SET status = 'closed', close_reason = 'number_retired'
   WHERE proxy_number_id = NEW.id AND status = 'active';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proxy_numbers_retire ON public.proxy_numbers;
CREATE TRIGGER trg_proxy_numbers_retire
  AFTER UPDATE OF status ON public.proxy_numbers
  FOR EACH ROW
  WHEN (NEW.status = 'retired' AND OLD.status IS DISTINCT FROM 'retired')
  EXECUTE FUNCTION public.proxy_numbers_retire_sessions();

CREATE OR REPLACE FUNCTION public.proxy_sessions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id
     OR NEW.proxy_number_id IS DISTINCT FROM OLD.proxy_number_id
     OR NEW.customer_e164 IS DISTINCT FROM OLD.customer_e164
     OR NEW.technician_e164 IS DISTINCT FROM OLD.technician_e164
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'numbers and owner of a proxy session are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'session_is_final' USING ERRCODE = '22023';
  END IF;
  IF OLD.status <> 'active' AND NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'session_is_final' USING ERRCODE = '22023';
  END IF;
  IF OLD.status = 'active' AND NEW.status IN ('closed', 'expired') THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proxy_sessions_guard ON public.proxy_sessions;
CREATE TRIGGER trg_proxy_sessions_guard
  BEFORE UPDATE ON public.proxy_sessions
  FOR EACH ROW EXECUTE FUNCTION public.proxy_sessions_guard();

-- Jobs: cancelled -> close now; completed -> keep 24h so the customer can still reach the tech.
CREATE OR REPLACE FUNCTION public.proxy_sessions_on_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job_status = 'cancelled' THEN
    UPDATE proxy_sessions
       SET status = 'closed', close_reason = 'job_cancelled'
     WHERE job_id = NEW.id AND status = 'active';
  ELSIF NEW.job_status = 'completed' THEN
    UPDATE proxy_sessions
       SET expires_at = LEAST(expires_at, now() + interval '24 hours')
     WHERE job_id = NEW.id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proxy_sessions_job_status ON public.jobs;
CREATE TRIGGER trg_proxy_sessions_job_status
  AFTER UPDATE OF job_status ON public.jobs
  FOR EACH ROW
  WHEN (OLD.job_status IS DISTINCT FROM NEW.job_status)
  EXECUTE FUNCTION public.proxy_sessions_on_job_status();

-- 5) RLS ------------------------------------------------------------------------------------------
ALTER TABLE public.proxy_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxy_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxy_call_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pn_select" ON public.proxy_numbers;
CREATE POLICY "pn_select" ON public.proxy_numbers FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.proxy_can_manage());

DROP POLICY IF EXISTS "pn_insert" ON public.proxy_numbers;
CREATE POLICY "pn_insert" ON public.proxy_numbers FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.proxy_can_admin());

DROP POLICY IF EXISTS "pn_update" ON public.proxy_numbers;
CREATE POLICY "pn_update" ON public.proxy_numbers FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.proxy_can_admin())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.proxy_can_admin());

DROP POLICY IF EXISTS "ps_select" ON public.proxy_sessions;
CREATE POLICY "ps_select" ON public.proxy_sessions FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.proxy_can_manage());

DROP POLICY IF EXISTS "pce_select" ON public.proxy_call_events;
CREATE POLICY "pce_select" ON public.proxy_call_events FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.proxy_can_manage());

REVOKE INSERT, UPDATE, DELETE ON public.proxy_sessions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.proxy_call_events FROM anon, authenticated;
REVOKE DELETE ON public.proxy_numbers FROM anon, authenticated;

-- 6) Stats view (caller's RLS applies) -----------------------------------------------------------------
CREATE OR REPLACE VIEW public.proxy_number_stats WITH (security_invoker = true) AS
SELECT
  n.id AS number_id,
  n.account_owner_id,
  count(s.id) FILTER (WHERE s.status = 'active' AND s.expires_at > now()) AS active_sessions,
  count(s.id) AS total_sessions,
  (
    SELECT count(*) FROM public.proxy_call_events e
    WHERE e.proxy_number_id = n.id
      AND e.direction <> 'blocked'
      AND e.created_at >= now() - interval '30 days'
  ) AS calls_30d
FROM public.proxy_numbers n
LEFT JOIN public.proxy_sessions s ON s.proxy_number_id = n.id
GROUP BY n.id, n.account_owner_id;

GRANT SELECT ON public.proxy_number_stats TO authenticated;

-- 7) RPC: technician phone ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proxy_set_technician_phone(p_technician_id uuid, p_phone text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_norm text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.proxy_can_admin() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  IF p_phone IS NULL OR btrim(p_phone) = '' THEN
    v_norm := NULL;
  ELSE
    v_norm := public.normalize_phone_e164(p_phone);
    IF v_norm IS NULL THEN
      RAISE EXCEPTION 'invalid_phone' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM proxy_numbers n WHERE n.e164 = v_norm) THEN
      RAISE EXCEPTION 'phone_is_proxy_number' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE team_members SET member_phone = v_norm
   WHERE id = p_technician_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'technician_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_norm;
END;
$$;

-- 8) RPC: allocate a session -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proxy_allocate_session(
  p_job_id uuid,
  p_technician_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_customer_id uuid DEFAULT NULL,
  p_ttl_hours integer DEFAULT 72
)
RETURNS public.proxy_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tech team_members%ROWTYPE;
  v_num proxy_numbers%ROWTYPE;
  v_existing proxy_sessions%ROWTYPE;
  v_row proxy_sessions%ROWTYPE;
  v_customer text;
  v_tech_phone text;
  v_name text := btrim(COALESCE(p_customer_name, ''));
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.proxy_can_manage() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_customer_name' USING ERRCODE = '22023';
  END IF;
  v_customer := public.normalize_phone_e164(p_customer_phone);
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'invalid_customer_phone' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_hours IS NULL OR p_ttl_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'invalid_ttl' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_tech FROM team_members WHERE id = p_technician_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'technician_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_tech_phone := public.normalize_phone_e164(v_tech.member_phone);
  IF v_tech_phone IS NULL THEN
    RAISE EXCEPTION 'technician_phone_missing' USING ERRCODE = '22023';
  END IF;
  IF v_tech_phone = v_customer THEN
    RAISE EXCEPTION 'same_phone' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM proxy_numbers n WHERE n.e164 IN (v_customer, v_tech_phone)) THEN
    RAISE EXCEPTION 'phone_is_proxy_number' USING ERRCODE = '22023';
  END IF;

  IF p_job_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_customer_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = p_customer_id AND c.user_id = v_owner) THEN
    RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('proxy_alloc:' || v_owner::text, 0));

  -- Free numbers held by sessions that have run out of time.
  UPDATE proxy_sessions
     SET status = 'expired', close_reason = 'expired'
   WHERE account_owner_id = v_owner AND status = 'active' AND expires_at <= now();

  -- Idempotent: same job + technician + customer already has a live session.
  SELECT * INTO v_existing FROM proxy_sessions s
   WHERE s.account_owner_id = v_owner AND s.status = 'active'
     AND s.technician_id = p_technician_id AND s.customer_e164 = v_customer
     AND s.job_id IS NOT DISTINCT FROM p_job_id
   LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT n.* INTO v_num FROM proxy_numbers n
   WHERE n.account_owner_id = v_owner AND n.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM proxy_sessions s
        WHERE s.proxy_number_id = n.id AND s.status = 'active'
          AND (s.customer_e164 IN (v_customer, v_tech_phone)
               OR s.technician_e164 IN (v_customer, v_tech_phone))
     )
   ORDER BY (SELECT count(*) FROM proxy_sessions s2 WHERE s2.proxy_number_id = n.id AND s2.status = 'active'),
            n.created_at, n.id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_proxy_number_available' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO proxy_sessions (
    account_owner_id, proxy_number_id, job_id, customer_id, technician_id,
    customer_name, technician_name, customer_e164, technician_e164, expires_at
  ) VALUES (
    v_owner, v_num.id, p_job_id, p_customer_id, v_tech.id,
    v_name, v_tech.member_name, v_customer, v_tech_phone,
    now() + make_interval(hours => p_ttl_hours)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- 9) RPC: close / extend ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proxy_close_session(p_session_id uuid, p_reason text DEFAULT 'manual')
RETURNS public.proxy_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row proxy_sessions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.proxy_can_manage() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  UPDATE proxy_sessions
     SET status = 'closed',
         close_reason = left(COALESCE(NULLIF(btrim(p_reason), ''), 'manual'), 60)
   WHERE id = p_session_id AND account_owner_id = v_owner AND status = 'active'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM proxy_sessions WHERE id = p_session_id AND account_owner_id = v_owner) THEN
      RAISE EXCEPTION 'session_is_final' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.proxy_extend_session(p_session_id uuid, p_extra_hours integer)
RETURNS public.proxy_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row proxy_sessions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.proxy_can_manage() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_extra_hours IS NULL OR p_extra_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'invalid_ttl' USING ERRCODE = '22023';
  END IF;

  UPDATE proxy_sessions
     SET expires_at = LEAST(GREATEST(expires_at, now()) + make_interval(hours => p_extra_hours),
                            now() + interval '30 days')
   WHERE id = p_session_id AND account_owner_id = v_owner AND status = 'active'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

-- 10) RPC: technician view (never exposes the customer's number) --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proxy_my_sessions()
RETURNS TABLE (
  id uuid,
  job_id uuid,
  customer_name text,
  proxy_e164 text,
  expires_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.job_id, s.customer_name, n.e164, s.expires_at, s.created_at
    FROM proxy_sessions s
    JOIN proxy_numbers n ON n.id = s.proxy_number_id
    JOIN team_members t ON t.id = s.technician_id
   WHERE t.user_id = auth.uid()
     AND s.status = 'active'
     AND s.expires_at > now()
   ORDER BY s.created_at DESC
   LIMIT 100;
$$;

-- 11) RPC: authorise a server-side bridge (called with the user's JWT by the edge function) ---------------------------------
CREATE OR REPLACE FUNCTION public.proxy_prepare_bridge(p_session_id uuid)
RETURNS TABLE (
  session_id uuid,
  account_owner_id uuid,
  proxy_e164 text,
  technician_e164 text,
  customer_e164 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_s proxy_sessions%ROWTYPE;
  v_proxy text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_s FROM proxy_sessions WHERE id = p_session_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (
    public.proxy_can_manage()
    OR EXISTS (SELECT 1 FROM team_members t WHERE t.id = v_s.technician_id AND t.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF v_s.status <> 'active' OR v_s.expires_at <= now() THEN
    RAISE EXCEPTION 'session_not_active' USING ERRCODE = '22023';
  END IF;
  SELECT n.e164 INTO v_proxy FROM proxy_numbers n WHERE n.id = v_s.proxy_number_id;

  RETURN QUERY SELECT v_s.id, v_s.account_owner_id, v_proxy, v_s.technician_e164, v_s.customer_e164;
END;
$$;

-- 12) RPC: inbound routing (service_role only; used by the Twilio webhook) ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.proxy_resolve_inbound(p_proxy_e164 text, p_from_e164 text)
RETURNS TABLE (
  session_id uuid,
  account_owner_id uuid,
  proxy_number_id uuid,
  direction text,
  destination_e164 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id,
         s.account_owner_id,
         s.proxy_number_id,
         CASE WHEN s.customer_e164 = p_from_e164 THEN 'customer_to_technician' ELSE 'technician_to_customer' END,
         CASE WHEN s.customer_e164 = p_from_e164 THEN s.technician_e164 ELSE s.customer_e164 END
    FROM proxy_sessions s
    JOIN proxy_numbers n ON n.id = s.proxy_number_id
   WHERE n.e164 = p_proxy_e164
     AND n.status IN ('active', 'paused')
     AND s.status = 'active'
     AND s.expires_at > now()
     AND (s.customer_e164 = p_from_e164 OR s.technician_e164 = p_from_e164)
   LIMIT 1;
$$;

-- 13) Grants ------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.proxy_set_technician_phone(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_allocate_session(uuid, uuid, text, text, uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_close_session(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_extend_session(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_my_sessions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_prepare_bridge(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.proxy_resolve_inbound(text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.proxy_set_technician_phone(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.proxy_allocate_session(uuid, uuid, text, text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.proxy_close_session(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.proxy_extend_session(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.proxy_my_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.proxy_prepare_bridge(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.proxy_resolve_inbound(text, text) TO service_role;
