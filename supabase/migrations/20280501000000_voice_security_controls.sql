/*
  # Voice-agent security controls

  What this adds (all server-side; the AI model can never read or write any of it)
  - voice_security_controls : kill switch. mode = normal | restricted | lockdown, per tenant and global.
  - voice_call_security     : per-call state (verification factors, lock/restrict flags, risk score, counters).
  - voice_otp_challenges    : one-time codes (HMAC digests only, never the code), attempt-limited, expiring.
  - voice_pending_actions   : confirm-before-write: one-shot, params-bound, minimum-age pending actions.
  - voice_rate_counters     : atomic fixed-window counters (per call / per caller / per number / per tenant).
  - voice_canaries          : HMAC digests of decoy identifiers whose use trips a critical alert.
  - voice_security_audit    : IMMUTABLE, hash-chained audit trail (UPDATE / DELETE / TRUNCATE are rejected).

  Security model
  - RLS is on for every table. Account owners / AI-security managers may SELECT their own tenant's rows
    (audit, controls, call state). Nobody except the service role can write: every mutation is a SECURITY DEFINER
    RPC that is GRANTed to service_role only (the edge function), except voice_set_my_mode (owner kill switch).
  - Audit rows carry stable codes, ids and counts ONLY: never transcripts, tool arguments, phone numbers or PII.
  - high / critical audit rows also raise an ai_security_events 'anomaly' row (shows up in the AI Security Center).
  - Hash chain: hash = sha256(prev_hash | user | at | kind | severity | call | tool | decision | code | detail).
    voice_audit_verify_chain() detects any edit, deletion or reordering of a tenant's rows.

  Retention / legal note
  - The audit table is append-only by design. Deleting a tenant's data (DSAR / account deletion) does NOT cascade
    into it (it holds no PII). Whether and how long to retain it is a legal decision; see docs/security/.

  Rollback
    DROP TABLE public.voice_security_audit, public.voice_canaries, public.voice_rate_counters,
               public.voice_pending_actions, public.voice_otp_challenges, public.voice_call_security,
               public.voice_security_controls CASCADE;
    DROP FUNCTION public.voice_audit_hash(text, uuid, timestamptz, text, text, text, text, text, text, jsonb);
    (functions that reference the tables are dropped by CASCADE above or can be dropped by name)
    The edge function fails CLOSED for non-safety tools if these RPCs are missing, so deploy this migration BEFORE
    the webhook change.
*/

-- =============================================================================================
-- Kill switch
-- =============================================================================================
CREATE TABLE IF NOT EXISTS public.voice_security_controls (
  scope   text NOT NULL CHECK (scope IN ('global', 'tenant')),
  user_id uuid,
  mode    text NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'restricted', 'lockdown')),
  reason  text CHECK (reason IS NULL OR char_length(reason) <= 300),
  set_by  uuid,
  set_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_controls_scope_chk CHECK ((scope = 'global' AND user_id IS NULL) OR (scope = 'tenant' AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_controls_global_uq ON public.voice_security_controls (scope) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS voice_controls_tenant_uq ON public.voice_security_controls (user_id) WHERE scope = 'tenant';

-- =============================================================================================
-- Per-call security state
-- =============================================================================================
CREATE TABLE IF NOT EXISTS public.voice_call_security (
  user_id        uuid NOT NULL,
  vapi_call_id   text NOT NULL CHECK (char_length(vapi_call_id) BETWEEN 1 AND 200),
  customer_id    uuid,
  kd_passed_at   timestamptz,
  otp_passed_at  timestamptz,
  kd_fails       integer NOT NULL DEFAULT 0 CHECK (kd_fails >= 0),
  restricted     boolean NOT NULL DEFAULT false,
  locked         boolean NOT NULL DEFAULT false,
  risk_score     integer NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  counters       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counters) = 'object' AND pg_column_size(counters) < 4096),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vapi_call_id)
);
CREATE INDEX IF NOT EXISTS voice_call_security_recent_idx ON public.voice_call_security (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS voice_call_security_risky_idx ON public.voice_call_security (user_id, updated_at DESC) WHERE risk_score >= 60;

CREATE TABLE IF NOT EXISTS public.voice_otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  vapi_call_id  text NOT NULL,
  customer_id   uuid NOT NULL,
  code_digest   text NOT NULL CHECK (char_length(code_digest) = 64),
  attempts      integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_otp_call_idx ON public.voice_otp_challenges (user_id, vapi_call_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.voice_pending_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  vapi_call_id  text NOT NULL,
  tool          text NOT NULL CHECK (char_length(tool) <= 64),
  params_hash   text NOT NULL CHECK (char_length(params_hash) = 64),
  summary       text CHECK (summary IS NULL OR char_length(summary) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS voice_pending_open_idx ON public.voice_pending_actions (user_id, vapi_call_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.voice_rate_counters (
  user_id       uuid NOT NULL,
  key           text NOT NULL CHECK (char_length(key) <= 200),
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key, window_start)
);
CREATE INDEX IF NOT EXISTS voice_rate_old_idx ON public.voice_rate_counters (window_start);

CREATE TABLE IF NOT EXISTS public.voice_canaries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('phone', 'email', 'name', 'address')),
  value_digest  text NOT NULL CHECK (char_length(value_digest) = 64),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, value_digest)
);

-- =============================================================================================
-- Immutable, hash-chained audit trail
-- =============================================================================================
CREATE TABLE IF NOT EXISTS public.voice_security_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL,
  at            timestamptz NOT NULL,
  kind          text NOT NULL CHECK (char_length(kind) <= 64),
  severity      text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  vapi_call_id  text CHECK (vapi_call_id IS NULL OR char_length(vapi_call_id) <= 200),
  tool          text CHECK (tool IS NULL OR char_length(tool) <= 64),
  decision      text NOT NULL CHECK (decision IN ('allow', 'deny', 'minimal', 'challenge', 'info')),
  code          text NOT NULL CHECK (char_length(code) <= 64),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) < 2048),
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_audit_user_id_idx ON public.voice_security_audit (user_id, id DESC);
CREATE INDEX IF NOT EXISTS voice_audit_user_at_idx ON public.voice_security_audit (user_id, at DESC);
CREATE INDEX IF NOT EXISTS voice_audit_severe_idx ON public.voice_security_audit (user_id, at DESC) WHERE severity IN ('high', 'critical');

CREATE OR REPLACE FUNCTION public.voice_audit_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'voice_security_audit is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS voice_audit_no_update_delete ON public.voice_security_audit;
CREATE TRIGGER voice_audit_no_update_delete BEFORE UPDATE OR DELETE ON public.voice_security_audit
  FOR EACH ROW EXECUTE FUNCTION public.voice_audit_immutable();
DROP TRIGGER IF EXISTS voice_audit_no_truncate ON public.voice_security_audit;
CREATE TRIGGER voice_audit_no_truncate BEFORE TRUNCATE ON public.voice_security_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.voice_audit_immutable();

CREATE OR REPLACE FUNCTION public.voice_audit_hash(
  p_prev text, p_user uuid, p_at timestamptz, p_kind text, p_severity text, p_call text, p_tool text, p_decision text, p_code text, p_detail jsonb
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT encode(sha256(convert_to(
    p_prev || '|' || p_user::text || '|' || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
    p_kind || '|' || p_severity || '|' || coalesce(p_call, '') || '|' || coalesce(p_tool, '') || '|' || p_decision || '|' || p_code || '|' || p_detail::text,
    'UTF8')), 'hex')
$$;

-- =============================================================================================
-- RLS: owners / AI-security managers can READ their tenant's rows. Nothing is writable from the client.
-- =============================================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['voice_security_controls','voice_call_security','voice_otp_challenges','voice_pending_actions','voice_rate_counters','voice_canaries','voice_security_audit']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

GRANT SELECT ON public.voice_security_audit, public.voice_call_security, public.voice_security_controls TO authenticated;

DROP POLICY IF EXISTS voice_audit_owner_select ON public.voice_security_audit;
CREATE POLICY voice_audit_owner_select ON public.voice_security_audit FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_ai_security());
DROP POLICY IF EXISTS voice_call_security_owner_select ON public.voice_call_security;
CREATE POLICY voice_call_security_owner_select ON public.voice_call_security FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_ai_security());
DROP POLICY IF EXISTS voice_controls_owner_select ON public.voice_security_controls;
CREATE POLICY voice_controls_owner_select ON public.voice_security_controls FOR SELECT TO authenticated
  USING (scope = 'tenant' AND user_id = public.get_account_owner_id() AND public.can_manage_ai_security());

-- =============================================================================================
-- Audit append (single writer, serialised per tenant so the chain is consistent)
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_audit_append(
  p_user_id uuid, p_kind text, p_severity text, p_call_id text, p_tool text, p_decision text, p_code text, p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_prev text; v_at timestamptz := clock_timestamp(); v_id bigint; v_hash text;
  v_detail jsonb := CASE WHEN jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) = 'object' THEN coalesce(p_detail, '{}'::jsonb) ELSE '{}'::jsonb END;
  v_kind text := left(coalesce(p_kind, 'unknown'), 64);
  v_code text := left(coalesce(p_code, 'unknown'), 64);
  v_tool text := left(p_tool, 64);
  v_call text := left(p_call_id, 200);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  IF pg_column_size(v_detail) >= 2000 THEN v_detail := '{"truncated": true}'::jsonb; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('voice_audit:' || p_user_id::text, 0));
  SELECT hash INTO v_prev FROM public.voice_security_audit WHERE user_id = p_user_id ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, 'genesis');
  v_hash := public.voice_audit_hash(v_prev, p_user_id, v_at, v_kind, p_severity, v_call, v_tool, p_decision, v_code, v_detail);
  INSERT INTO public.voice_security_audit (user_id, at, kind, severity, vapi_call_id, tool, decision, code, detail, prev_hash, hash)
  VALUES (p_user_id, v_at, v_kind, p_severity, v_call, v_tool, p_decision, v_code, v_detail, v_prev, v_hash)
  RETURNING id INTO v_id;

  IF p_severity IN ('high', 'critical') THEN
    BEGIN -- never let alert plumbing break the audit write
      PERFORM public.record_ai_security_events(p_user_id, jsonb_build_array(jsonb_build_object(
        'event_type', 'anomaly', 'severity', p_severity, 'source', 'voice-security', 'task', 'voice_tool_gate',
        'agent_source', 'vapi-webhook', 'detail', jsonb_build_object('kind', v_kind, 'code', v_code, 'tool', v_tool, 'audit_id', v_id)
      )));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'voice_audit_append: alert dispatch failed: %', SQLERRM;
    END;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.voice_audit_verify_chain(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
DECLARE r record; v_prev text := 'genesis'; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.voice_security_audit WHERE user_id = p_user_id ORDER BY id LOOP
    IF r.prev_hash <> v_prev OR r.hash <> public.voice_audit_hash(r.prev_hash, r.user_id, r.at, r.kind, r.severity, r.vapi_call_id, r.tool, r.decision, r.code, r.detail) THEN
      RETURN jsonb_build_object('ok', false, 'broken_at', r.id, 'rows', n);
    END IF;
    v_prev := r.hash; n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'rows', n);
END $$;

-- =============================================================================================
-- Kill switch RPCs
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_get_mode(p_user_id uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN bool_or(mode = 'lockdown') THEN 'lockdown'
    WHEN bool_or(mode = 'restricted') THEN 'restricted'
    ELSE 'normal' END
  FROM public.voice_security_controls WHERE scope = 'global' OR (scope = 'tenant' AND user_id = p_user_id)
$$;

CREATE OR REPLACE FUNCTION public.voice_set_mode(p_scope text, p_user_id uuid, p_mode text, p_reason text, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old text; v_audit_user uuid;
BEGIN
  IF p_scope NOT IN ('global', 'tenant') OR p_mode NOT IN ('normal', 'restricted', 'lockdown') THEN RAISE EXCEPTION 'invalid scope or mode'; END IF;
  IF p_scope = 'tenant' AND p_user_id IS NULL THEN RAISE EXCEPTION 'tenant scope needs user_id'; END IF;
  IF p_scope = 'global' THEN
    SELECT mode INTO v_old FROM public.voice_security_controls WHERE scope = 'global';
    INSERT INTO public.voice_security_controls (scope, user_id, mode, reason, set_by, set_at) VALUES ('global', NULL, p_mode, left(p_reason, 300), p_actor, now())
      ON CONFLICT (scope) WHERE scope = 'global' DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now();
    -- Global changes are audited under every tenant that currently has voice security rows (cheap, bounded).
    FOR v_audit_user IN SELECT DISTINCT user_id FROM public.voice_call_security WHERE updated_at > now() - interval '7 days' LOOP
      PERFORM public.voice_audit_append(v_audit_user, 'mode_changed', CASE WHEN p_mode = 'normal' THEN 'medium' ELSE 'high' END, NULL, NULL, 'info', 'global_' || p_mode, jsonb_build_object('from', coalesce(v_old, 'normal')));
    END LOOP;
  ELSE
    SELECT mode INTO v_old FROM public.voice_security_controls WHERE scope = 'tenant' AND user_id = p_user_id;
    INSERT INTO public.voice_security_controls (scope, user_id, mode, reason, set_by, set_at) VALUES ('tenant', p_user_id, p_mode, left(p_reason, 300), p_actor, now())
      ON CONFLICT (user_id) WHERE scope = 'tenant' DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now();
    PERFORM public.voice_audit_append(p_user_id, 'mode_changed', CASE WHEN p_mode = 'normal' THEN 'medium' ELSE 'high' END, NULL, NULL, 'info', 'tenant_' || p_mode, jsonb_build_object('from', coalesce(v_old, 'normal')));
  END IF;
END $$;

-- Owner / AI-security manager kill switch (the only client-callable mutation).
CREATE OR REPLACE FUNCTION public.voice_set_my_mode(p_mode text, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_ai_security() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.voice_set_mode('tenant', v_owner, p_mode, p_reason, auth.uid());
END $$;

-- =============================================================================================
-- Per-call state
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_call_state_get(p_user_id uuid, p_call_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.voice_call_security;
BEGIN
  INSERT INTO public.voice_call_security (user_id, vapi_call_id) VALUES (p_user_id, p_call_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.voice_call_security WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
  RETURN jsonb_build_object(
    'customerId', r.customer_id,
    'kdPassedAt', (extract(epoch FROM r.kd_passed_at) * 1000)::bigint,
    'otpPassedAt', (extract(epoch FROM r.otp_passed_at) * 1000)::bigint,
    'kdFails', r.kd_fails, 'restricted', r.restricted, 'locked', r.locked, 'riskScore', r.risk_score, 'counters', r.counters);
END $$;

CREATE OR REPLACE FUNCTION public.voice_call_state_bump(p_user_id uuid, p_call_id text, p_counters jsonb, p_risk integer, p_restricted boolean, p_locked boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_add jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(coalesce(p_counters, '{}'::jsonb)) = 'object' THEN
    SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) INTO v_add FROM (
      SELECT key AS k, CASE WHEN value ~ '^[0-9]{1,4}$' THEN value::int ELSE 0 END AS v
      FROM jsonb_each_text(coalesce(p_counters, '{}'::jsonb)) WHERE key ~ '^[a-z_]{1,32}$' LIMIT 20) s;
  END IF;
  INSERT INTO public.voice_call_security (user_id, vapi_call_id) VALUES (p_user_id, p_call_id) ON CONFLICT DO NOTHING;
  UPDATE public.voice_call_security SET
    counters = (SELECT coalesce(jsonb_object_agg(k, s), '{}'::jsonb) FROM (
      SELECT k, sum(v)::int AS s FROM (
        SELECT key AS k, CASE WHEN value ~ '^[0-9]{1,9}$' THEN value::int ELSE 0 END AS v FROM jsonb_each_text(counters)
        UNION ALL SELECT key, value::int FROM jsonb_each_text(v_add)) t GROUP BY k) u),
    risk_score = greatest(risk_score, least(100, greatest(0, coalesce(p_risk, 0)))),
    restricted = restricted OR coalesce(p_restricted, false),
    locked = locked OR coalesce(p_locked, false),
    updated_at = now()
  WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
END $$;

-- =============================================================================================
-- Rate limiting (atomic fixed window)
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_rate_consume(p_user_id uuid, p_key text, p_limit integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_win timestamptz; v_count integer;
BEGIN
  IF p_limit < 0 OR p_window_seconds NOT BETWEEN 1 AND 604800 OR p_key IS NULL OR char_length(p_key) > 200 THEN RAISE EXCEPTION 'invalid rate parameters'; END IF;
  v_win := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.voice_rate_counters (user_id, key, window_start, count) VALUES (p_user_id, p_key, v_win, 1)
  ON CONFLICT (user_id, key, window_start) DO UPDATE SET count = public.voice_rate_counters.count + 1
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END $$;

-- =============================================================================================
-- Step-up verification
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_otp_issue(
  p_user_id uuid, p_call_id text, p_customer_id uuid, p_digest text, p_caller_hash text, p_ttl_seconds integer, p_max_per_call integer, p_max_per_number_day integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.voice_call_security; v_n integer;
BEGIN
  INSERT INTO public.voice_call_security (user_id, vapi_call_id) VALUES (p_user_id, p_call_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.voice_call_security WHERE user_id = p_user_id AND vapi_call_id = p_call_id FOR UPDATE;
  IF r.locked THEN RETURN jsonb_build_object('ok', false, 'reason', 'locked'); END IF;
  SELECT count(*) INTO v_n FROM public.voice_otp_challenges WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
  IF v_n >= p_max_per_call THEN RETURN jsonb_build_object('ok', false, 'reason', 'too_many_challenges'); END IF;
  -- Protect the VICTIM'S phone from SMS bombing (keyed by customer) and the tenant's SMS bill (keyed by caller).
  IF NOT public.voice_rate_consume(p_user_id, 'otp_cust:' || p_customer_id::text, p_max_per_number_day, 86400)
     OR NOT public.voice_rate_consume(p_user_id, 'otp_caller:' || left(p_caller_hash, 64), p_max_per_number_day, 86400) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'number_daily_limit');
  END IF;
  UPDATE public.voice_otp_challenges SET consumed_at = now() WHERE user_id = p_user_id AND vapi_call_id = p_call_id AND consumed_at IS NULL;
  INSERT INTO public.voice_otp_challenges (user_id, vapi_call_id, customer_id, code_digest, expires_at)
  VALUES (p_user_id, p_call_id, p_customer_id, p_digest, now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 900))));
  RETURN jsonb_build_object('ok', true, 'reason', 'issued');
END $$;

CREATE OR REPLACE FUNCTION public.voice_otp_check(p_user_id uuid, p_call_id text, p_digest text, p_max_attempts integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.voice_call_security; c public.voice_otp_challenges;
BEGIN
  INSERT INTO public.voice_call_security (user_id, vapi_call_id) VALUES (p_user_id, p_call_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.voice_call_security WHERE user_id = p_user_id AND vapi_call_id = p_call_id FOR UPDATE;
  IF r.locked THEN RETURN jsonb_build_object('ok', false, 'reason', 'locked'); END IF;
  SELECT * INTO c FROM public.voice_otp_challenges
   WHERE user_id = p_user_id AND vapi_call_id = p_call_id AND consumed_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_challenge'); END IF;
  UPDATE public.voice_otp_challenges SET attempts = attempts + 1 WHERE id = c.id;
  IF c.attempts + 1 > p_max_attempts THEN
    UPDATE public.voice_otp_challenges SET consumed_at = now() WHERE id = c.id;
    UPDATE public.voice_call_security SET locked = true, updated_at = now() WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
    PERFORM public.voice_audit_append(p_user_id, 'verification_locked', 'high', p_call_id, 'verify_caller', 'deny', 'too_many_attempts', '{}'::jsonb);
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  END IF;
  IF c.code_digest <> p_digest THEN
    UPDATE public.voice_call_security SET counters = jsonb_set(counters, '{verify_fail}', to_jsonb(coalesce((counters ->> 'verify_fail')::int, 0) + 1)), updated_at = now()
     WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'mismatch');
  END IF;
  UPDATE public.voice_otp_challenges SET consumed_at = now() WHERE id = c.id;
  UPDATE public.voice_call_security SET
    kd_passed_at = CASE WHEN customer_id IS NOT NULL AND customer_id <> c.customer_id THEN NULL ELSE kd_passed_at END,
    customer_id = c.customer_id, otp_passed_at = now(), updated_at = now()
   WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
  RETURN jsonb_build_object('ok', true, 'reason', 'ok', 'customerId', c.customer_id);
END $$;

CREATE OR REPLACE FUNCTION public.voice_kd_record(p_user_id uuid, p_call_id text, p_customer_id uuid, p_passed boolean, p_max_fails integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.voice_call_security;
BEGIN
  INSERT INTO public.voice_call_security (user_id, vapi_call_id) VALUES (p_user_id, p_call_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.voice_call_security WHERE user_id = p_user_id AND vapi_call_id = p_call_id FOR UPDATE;
  IF r.locked THEN RETURN jsonb_build_object('locked', true); END IF;
  IF p_passed THEN
    UPDATE public.voice_call_security SET
      otp_passed_at = CASE WHEN customer_id IS NOT NULL AND customer_id <> p_customer_id THEN NULL ELSE otp_passed_at END,
      customer_id = p_customer_id, kd_passed_at = now(), updated_at = now()
     WHERE user_id = p_user_id AND vapi_call_id = p_call_id;
    RETURN jsonb_build_object('locked', false);
  END IF;
  UPDATE public.voice_call_security SET kd_fails = kd_fails + 1,
    counters = jsonb_set(counters, '{verify_fail}', to_jsonb(coalesce((counters ->> 'verify_fail')::int, 0) + 1)),
    locked = (kd_fails + 1 >= p_max_fails), updated_at = now()
   WHERE user_id = p_user_id AND vapi_call_id = p_call_id
  RETURNING locked INTO r.locked;
  IF r.locked THEN PERFORM public.voice_audit_append(p_user_id, 'verification_locked', 'high', p_call_id, 'verify_caller', 'deny', 'too_many_detail_failures', '{}'::jsonb); END IF;
  RETURN jsonb_build_object('locked', r.locked);
END $$;

-- =============================================================================================
-- Confirm-before-write (one-shot, params-bound, minimum age so a chained tool call can't self-confirm instantly)
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_pending_create(p_user_id uuid, p_call_id text, p_tool text, p_params_hash text, p_summary text, p_ttl_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_open integer;
BEGIN
  SELECT count(*) INTO v_open FROM public.voice_pending_actions WHERE user_id = p_user_id AND vapi_call_id = p_call_id AND consumed_at IS NULL AND expires_at > now();
  IF v_open >= 10 THEN RAISE EXCEPTION 'too many pending actions'; END IF;
  INSERT INTO public.voice_pending_actions (user_id, vapi_call_id, tool, params_hash, summary, expires_at)
  VALUES (p_user_id, p_call_id, left(p_tool, 64), p_params_hash, left(p_summary, 200), now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 900))))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.voice_pending_consume(p_user_id uuid, p_call_id text, p_tool text, p_params_hash text, p_id uuid, p_min_age_ms integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.voice_pending_actions;
BEGIN
  SELECT * INTO r FROM public.voice_pending_actions
   WHERE id = p_id AND user_id = p_user_id AND vapi_call_id = p_call_id AND tool = p_tool AND consumed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF r.params_hash <> p_params_hash THEN RETURN 'mismatch'; END IF;
  IF now() > r.expires_at THEN RETURN 'expired'; END IF;
  IF extract(epoch FROM (clock_timestamp() - r.created_at)) * 1000 < p_min_age_ms THEN RETURN 'too_soon'; END IF;
  UPDATE public.voice_pending_actions SET consumed_at = now() WHERE id = r.id;
  RETURN 'ok';
END $$;

-- =============================================================================================
-- Canaries (decoy identifiers: only HMAC digests are stored)
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_canary_register(p_user_id uuid, p_kind text, p_digest text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.voice_canaries (user_id, kind, value_digest) VALUES (p_user_id, p_kind, p_digest) ON CONFLICT DO NOTHING
$$;

CREATE OR REPLACE FUNCTION public.voice_canary_hit(p_user_id uuid, p_digests text[])
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.voice_canaries WHERE user_id = p_user_id AND value_digest = ANY (p_digests))
$$;

-- =============================================================================================
-- Housekeeping (audit is never purged)
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.voice_security_purge()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer := 0; k integer;
BEGIN
  DELETE FROM public.voice_rate_counters WHERE window_start < now() - interval '8 days'; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM public.voice_otp_challenges WHERE created_at < now() - interval '2 days'; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM public.voice_pending_actions WHERE created_at < now() - interval '2 days'; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM public.voice_call_security WHERE updated_at < now() - interval '90 days'; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END $$;

-- =============================================================================================
-- Grants: every RPC is service_role only, except the owner kill switch.
-- =============================================================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'voice_audit_append(uuid,text,text,text,text,text,text,jsonb)', 'voice_audit_verify_chain(uuid)', 'voice_get_mode(uuid)',
    'voice_set_mode(text,uuid,text,text,uuid)', 'voice_call_state_get(uuid,text)', 'voice_call_state_bump(uuid,text,jsonb,integer,boolean,boolean)',
    'voice_rate_consume(uuid,text,integer,integer)', 'voice_otp_issue(uuid,text,uuid,text,text,integer,integer,integer)',
    'voice_otp_check(uuid,text,text,integer)', 'voice_kd_record(uuid,text,uuid,boolean,integer)',
    'voice_pending_create(uuid,text,text,text,text,integer)', 'voice_pending_consume(uuid,text,text,text,uuid,integer)',
    'voice_canary_register(uuid,text,text)', 'voice_canary_hit(uuid,text[])', 'voice_security_purge()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.voice_set_my_mode(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voice_set_my_mode(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.voice_audit_immutable() FROM PUBLIC, anon, authenticated;
