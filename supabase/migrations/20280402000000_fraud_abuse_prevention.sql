/*
  # Fraud & abuse prevention (toll fraud, SMS pumping, free-tier farming)

  Adds (all additive, nothing dropped):
  - fraud_settings          singleton: global kill switches
  - fraud_org_state         per-account status (active/throttled/suspended), unlock flags, allowlists
  - fraud_usage             atomic spend/velocity ledger (day / life / handoff buckets)
  - fraud_events            append-only signal + decision log (anomalies, denials)
  - fraud_cases             case queue for staff review (suspensions, appeals)
  - fraud_otp_attempts      hashed-phone / hashed-IP SMS-code ledger (pumping defence)
  - fraud_signup_attempts   hashed-IP / device signup ledger (farming defence)
  - fraud_blocked_email_domains
  - RPCs: fraud_guard_context(), fraud_reserve(), fraud_otp_consume(), fraud_signup_consume(), fraud_set_org_status()

  ## Security
  - Every table has RLS enabled. Only staff (is_vireek_staff) can read; owners may read THEIR OWN org
    state and cases (so the app can show "your account is restricted" and an appeal form).
    Writes go through service-role edge functions or SECURITY DEFINER RPCs only.
  - RPCs that mutate state are executable by service_role only.
  - fraud_events / fraud_org_status history are append-only (trigger blocks UPDATE/DELETE on fraud_events).
  - Phone numbers and IPs are stored hashed (sha-256 hex computed by the caller with a server-side pepper).

  ## Rollback
  See the bottom of this file (commented DROP statements). Disabling enforcement without dropping anything:
  UPDATE fraud_settings SET enforce = false;  -- guard.ts then logs would-be denials but allows traffic.

  ## Backfill decision (REVIEW BEFORE APPLYING)
  Existing accounts that already pay (profiles.stripe_subscription_id is set) or have an approved A2P campaign are
  marked outbound_unlocked = true so this migration does not break live customers. Everyone else must verify.
*/

-- 1) Settings ----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enforce boolean NOT NULL DEFAULT true,
  kill_outbound_calls boolean NOT NULL DEFAULT false,
  kill_sms boolean NOT NULL DEFAULT false,
  kill_international boolean NOT NULL DEFAULT false,
  kill_otp_sms boolean NOT NULL DEFAULT false,
  otp_allowed_countries text[] NOT NULL DEFAULT ARRAY['US','CA'],
  reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.fraud_settings (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.fraud_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_settings_staff_read ON public.fraud_settings;
CREATE POLICY fraud_settings_staff_read ON public.fraud_settings
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- 2) Org state ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_org_state (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'throttled', 'suspended')),
  status_reason text,
  status_until timestamptz,
  outbound_unlocked boolean NOT NULL DEFAULT false,
  international_unlocked boolean NOT NULL DEFAULT false,
  voice_clone_unlocked boolean NOT NULL DEFAULT false,
  allowed_countries text[] NOT NULL DEFAULT '{}',
  risk_score integer NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  tz_offset_minutes integer NOT NULL DEFAULT 0 CHECK (tz_offset_minutes BETWEEN -840 AND 840),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fraud_org_state_status ON public.fraud_org_state (status) WHERE status <> 'active';
ALTER TABLE public.fraud_org_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_org_state_staff_read ON public.fraud_org_state;
CREATE POLICY fraud_org_state_staff_read ON public.fraud_org_state
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS fraud_org_state_owner_read ON public.fraud_org_state;
CREATE POLICY fraud_org_state_owner_read ON public.fraud_org_state
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Backfill (see header). Idempotent.
INSERT INTO public.fraud_org_state (user_id, outbound_unlocked, voice_clone_unlocked)
SELECT p.id,
       (p.stripe_subscription_id IS NOT NULL OR p.a2p_campaign_status = 'approved'),
       (p.stripe_subscription_id IS NOT NULL)
FROM public.profiles p
ON CONFLICT (user_id) DO NOTHING;

-- New profiles get a state row automatically (locked by default).
CREATE OR REPLACE FUNCTION public.fraud_init_org_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.fraud_org_state (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fraud_init_org_state ON public.profiles;
CREATE TRIGGER trg_fraud_init_org_state AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fraud_init_org_state();

-- 3) Usage ledger -----------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_usage (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bucket text NOT NULL,                       -- 'day:YYYY-MM-DD' | 'life' | 'handoff:YYYY-MM-DD'
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  sms integer NOT NULL DEFAULT 0 CHECK (sms >= 0),
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket)
);
ALTER TABLE public.fraud_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_usage_staff_read ON public.fraud_usage;
CREATE POLICY fraud_usage_staff_read ON public.fraud_usage
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- 4) Events (append-only) ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  kind text NOT NULL,                         -- 'denied' | 'anomaly' | 'status_change' | 'kill_switch' | 'otp_blocked' | 'signup_blocked'
  code text NOT NULL,
  source text,
  country text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fraud_events_user_time ON public.fraud_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_events_kind_time ON public.fraud_events (kind, created_at DESC);
ALTER TABLE public.fraud_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_events_staff_read ON public.fraud_events;
CREATE POLICY fraud_events_staff_read ON public.fraud_events
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.fraud_events_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'fraud_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_fraud_events_immutable ON public.fraud_events;
CREATE TRIGGER trg_fraud_events_immutable BEFORE UPDATE OR DELETE ON public.fraud_events
  FOR EACH ROW EXECUTE FUNCTION public.fraud_events_immutable();

-- 4b) Call events: one row per ALLOWED discretionary call (feeds fraud-sweep anomaly detection) ------------
CREATE TABLE IF NOT EXISTS public.fraud_call_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  country text NOT NULL,
  international boolean NOT NULL,
  prefix text NOT NULL,                       -- first 7 digits of the E.164 number, no '+'
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),  -- NULL until the provider reports it
  source text,
  external_id text
);
CREATE INDEX IF NOT EXISTS idx_fraud_call_events_user_at ON public.fraud_call_events (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_call_events_at ON public.fraud_call_events (at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fraud_call_events_external ON public.fraud_call_events (external_id) WHERE external_id IS NOT NULL;
ALTER TABLE public.fraud_call_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_call_events_staff_read ON public.fraud_call_events;
CREATE POLICY fraud_call_events_staff_read ON public.fraud_call_events
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- Provider hang-up callbacks call this to record the real duration (idempotent).
CREATE OR REPLACE FUNCTION public.fraud_call_finish(p_external_id text, p_duration integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.fraud_call_events SET duration_seconds = GREATEST(0, p_duration)
  WHERE external_id = p_external_id AND duration_seconds IS NULL;
$$;
REVOKE ALL ON FUNCTION public.fraud_call_finish(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fraud_call_finish(text, integer) TO service_role;

-- 5) Cases --------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(signals) = 'array'),
  appeal_text text CHECK (appeal_text IS NULL OR char_length(appeal_text) <= 2000),
  appeal_at timestamptz,
  resolution text,
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One open case per account at a time: repeated anomalies append to it instead of flooding the queue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fraud_cases_one_open ON public.fraud_cases (user_id) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_fraud_cases_queue ON public.fraud_cases (status, severity, created_at);
ALTER TABLE public.fraud_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_cases_staff_all ON public.fraud_cases;
CREATE POLICY fraud_cases_staff_all ON public.fraud_cases
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS fraud_cases_owner_read ON public.fraud_cases;
CREATE POLICY fraud_cases_owner_read ON public.fraud_cases
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- 6) OTP + signup ledgers -------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_otp_attempts (
  key_hash text NOT NULL,                     -- sha256(pepper || scope || value)
  scope text NOT NULL CHECK (scope IN ('phone', 'ip', 'prefix', 'global')),
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  PRIMARY KEY (scope, key_hash)
);
ALTER TABLE public.fraud_otp_attempts ENABLE ROW LEVEL SECURITY;  -- no policies: service role only

CREATE TABLE IF NOT EXISTS public.fraud_signup_attempts (
  key_hash text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('ip', 'device', 'domain', 'mailbox')),
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key_hash)
);
ALTER TABLE public.fraud_signup_attempts ENABLE ROW LEVEL SECURITY;  -- no policies: service role only

CREATE TABLE IF NOT EXISTS public.fraud_blocked_email_domains (
  domain text PRIMARY KEY CHECK (domain = lower(domain)),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fraud_blocked_email_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_blocked_domains_staff_read ON public.fraud_blocked_email_domains;
CREATE POLICY fraud_blocked_domains_staff_read ON public.fraud_blocked_email_domains
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- 7) RPCs ---------------------------------------------------------------------------------------------------

-- One round trip: everything guard.ts needs to decide.
CREATE OR REPLACE FUNCTION public.fraud_guard_context(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'enforce', s.enforce,
    'kill_outbound_calls', s.kill_outbound_calls,
    'kill_sms', s.kill_sms,
    'kill_international', s.kill_international,
    'kill_otp_sms', s.kill_otp_sms,
    'status', CASE WHEN o.status <> 'active' AND o.status_until IS NOT NULL AND o.status_until < now() THEN 'active' ELSE COALESCE(o.status, 'active') END,
    'status_reason', o.status_reason,
    'outbound_unlocked', COALESCE(o.outbound_unlocked, false),
    'international_unlocked', COALESCE(o.international_unlocked, false),
    'voice_clone_unlocked', COALESCE(o.voice_clone_unlocked, false),
    'allowed_countries', COALESCE(o.allowed_countries, '{}'),
    'tz_offset_minutes', COALESCE(o.tz_offset_minutes, 0),
    -- profiles.plan defaults to 'starter' and subscription_status to 'active' for EVERYONE, so only a real
    -- Stripe subscription makes an account paid. No subscription id => free tier.
    'plan', CASE WHEN p.stripe_subscription_id IS NOT NULL AND p.subscription_status IN ('active', 'past_due') THEN p.plan ELSE 'free' END,
    'account_age_days', GREATEST(0, EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400.0)
  ) INTO v
  FROM public.fraud_settings s
  CROSS JOIN public.profiles p
  LEFT JOIN public.fraud_org_state o ON o.user_id = p.id
  WHERE s.id = true AND p.id = p_user;
  RETURN v;  -- NULL when the profile does not exist: guard.ts treats that as deny
END;
$$;

-- Atomic reservation. The rule is identical to tryReserve() in planLimits.ts:
-- add the request iff it fits EVERY cap, otherwise change nothing. Returns NULL on success or the denial code.
CREATE OR REPLACE FUNCTION public.fraud_reserve(
  p_user uuid, p_day text, p_calls integer, p_sms integer, p_cost integer,
  p_cap_calls integer, p_cap_sms integer, p_cap_day_cost integer, p_cap_life_cost integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.fraud_usage;
BEGIN
  IF p_calls < 0 OR p_sms < 0 OR p_cost < 0 THEN RAISE EXCEPTION 'negative reservation'; END IF;
  BEGIN
    INSERT INTO public.fraud_usage AS u (user_id, bucket, calls, sms, cost_cents)
    VALUES (p_user, 'day:' || p_day, p_calls, p_sms, p_cost)
    ON CONFLICT (user_id, bucket) DO UPDATE SET
      calls = u.calls + EXCLUDED.calls, sms = u.sms + EXCLUDED.sms,
      cost_cents = u.cost_cents + EXCLUDED.cost_cents, updated_at = now()
    RETURNING * INTO v_row;
    IF v_row.calls > p_cap_calls THEN RAISE EXCEPTION 'FRAUD_CAP:DAILY_CALLS'; END IF;
    IF v_row.sms > p_cap_sms THEN RAISE EXCEPTION 'FRAUD_CAP:DAILY_SMS'; END IF;
    IF v_row.cost_cents > p_cap_day_cost THEN RAISE EXCEPTION 'FRAUD_CAP:DAILY_COST'; END IF;

    IF p_cap_life_cost IS NOT NULL THEN
      INSERT INTO public.fraud_usage AS u (user_id, bucket, calls, sms, cost_cents)
      VALUES (p_user, 'life', p_calls, p_sms, p_cost)
      ON CONFLICT (user_id, bucket) DO UPDATE SET
        calls = u.calls + EXCLUDED.calls, sms = u.sms + EXCLUDED.sms,
        cost_cents = u.cost_cents + EXCLUDED.cost_cents, updated_at = now()
      RETURNING * INTO v_row;
      IF v_row.cost_cents > p_cap_life_cost THEN RAISE EXCEPTION 'FRAUD_CAP:LIFETIME_COST'; END IF;
    END IF;
    RETURN NULL;
  EXCEPTION WHEN raise_exception THEN
    -- The sub-transaction rolled back every increment above: a denied request leaves no trace in the ledger.
    IF SQLERRM LIKE 'FRAUD_CAP:%' THEN RETURN substr(SQLERRM, 11); END IF;
    RAISE;
  END;
END;
$$;

-- Atomic OTP/signup counters (fixed window). Returns the attempt count AFTER this call.
CREATE OR REPLACE FUNCTION public.fraud_otp_consume(p_scope text, p_key_hash text, p_window_seconds integer)
RETURNS TABLE (attempts integer, seconds_since_last integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev timestamptz;
BEGIN
  SELECT last_sent_at INTO v_prev FROM public.fraud_otp_attempts WHERE scope = p_scope AND key_hash = p_key_hash;
  RETURN QUERY
  INSERT INTO public.fraud_otp_attempts AS r (scope, key_hash, window_start, attempts, last_sent_at)
  VALUES (p_scope, p_key_hash, now(), 1, now())
  ON CONFLICT (scope, key_hash) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END,
    attempts = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.attempts + 1 END,
    last_sent_at = now()
  RETURNING r.attempts, COALESCE(EXTRACT(EPOCH FROM (now() - v_prev))::integer, 2147483647);
  IF random() < 0.01 THEN
    DELETE FROM public.fraud_otp_attempts WHERE window_start < now() - interval '2 days';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fraud_signup_consume(p_scope text, p_key_hash text, p_window_seconds integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.fraud_signup_attempts AS r (scope, key_hash, window_start, attempts)
  VALUES (p_scope, p_key_hash, now(), 1)
  ON CONFLICT (scope, key_hash) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END,
    attempts = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.attempts + 1 END
  RETURNING r.attempts INTO v_count;
  IF random() < 0.01 THEN
    DELETE FROM public.fraud_signup_attempts WHERE window_start < now() - interval '2 days';
  END IF;
  RETURN v_count;
END;
$$;

-- Reversible status change + audit + case, in one transaction.
CREATE OR REPLACE FUNCTION public.fraud_set_org_status(
  p_user uuid, p_status text, p_reason text, p_until timestamptz, p_actor uuid, p_source text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev text;
BEGIN
  IF p_status NOT IN ('active', 'throttled', 'suspended') THEN RAISE EXCEPTION 'invalid status'; END IF;
  INSERT INTO public.fraud_org_state (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
  SELECT status INTO v_prev FROM public.fraud_org_state WHERE user_id = p_user FOR UPDATE;
  UPDATE public.fraud_org_state
     SET status = p_status, status_reason = p_reason, status_until = p_until, updated_at = now()
   WHERE user_id = p_user;
  INSERT INTO public.fraud_events (user_id, kind, code, source, detail)
  VALUES (p_user, 'status_change', upper(p_status), p_source,
          jsonb_build_object('from', v_prev, 'to', p_status, 'reason', p_reason, 'actor', p_actor, 'until', p_until));
  INSERT INTO public.audit_log (user_id, actor_id, action, target_table, target_id, metadata)
  VALUES (p_user, p_actor, 'fraud.status.' || p_status, 'fraud_org_state', p_user::text,
          jsonb_build_object('from', v_prev, 'reason', p_reason, 'source', p_source));
END;
$$;

-- Lock every mutating RPC to the service role.
REVOKE ALL ON FUNCTION public.fraud_guard_context(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_reserve(uuid, text, integer, integer, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_otp_consume(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_signup_consume(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_set_org_status(uuid, text, text, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fraud_guard_context(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_reserve(uuid, text, integer, integer, integer, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_otp_consume(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_signup_consume(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_set_org_status(uuid, text, text, timestamptz, uuid, text) TO service_role;

/* ROLLBACK (manual, destructive — run only if you must remove the feature):
   DROP TRIGGER IF EXISTS trg_fraud_init_org_state ON public.profiles;
   DROP FUNCTION IF EXISTS public.fraud_init_org_state();
   DROP TABLE IF EXISTS public.fraud_blocked_email_domains, public.fraud_signup_attempts, public.fraud_otp_attempts,
     public.fraud_cases, public.fraud_call_events, public.fraud_events, public.fraud_usage, public.fraud_org_state, public.fraud_settings CASCADE;
   DROP FUNCTION IF EXISTS public.fraud_call_finish(text,integer), public.fraud_events_immutable(), public.fraud_guard_context(uuid), public.fraud_otp_consume(text,text,integer),
     public.fraud_signup_consume(text,text,integer), public.fraud_set_org_status(uuid,text,text,timestamptz,uuid,text),
     public.fraud_reserve(uuid,text,integer,integer,integer,integer,integer,integer,integer);
*/
