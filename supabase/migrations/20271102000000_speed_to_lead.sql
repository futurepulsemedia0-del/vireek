/*
  # Speed-to-lead voice callback

  A web-form / ad lead arrives WITH captured consent -> the AI agent calls within the
  SLA (default 60 s) inside allowed hours, qualifies, books or hands off to a human.

  ## Tables
  - speed_to_lead_settings   one row per account (feature flag, SLA, window, retries)
  - speed_to_lead_sources    one row per intake endpoint (token HASH only + exact consent wording)
  - speed_to_lead_consents   APPEND-ONLY consent ledger = the proof (wording snapshot, hashes, IP, UA...)
  - speed_to_lead_requests   one row per lead to call (state machine + SLA timing)
  - speed_to_lead_attempts   immutable-ish log of every dial / deferral / skip with the reason

  ## Security model
  - Everything scoped by account_owner_id = public.get_account_owner_id() (team members read, managers write).
  - Consents / requests / attempts are written ONLY by service_role (edge functions). Managers can
    only revoke consent and mark handoffs handled through the SECURITY DEFINER functions below.
  - Consent ledger has NO foreign keys on purpose: an FK "ON DELETE SET NULL/CASCADE" would try to
    UPDATE/DELETE proof rows, and the append-only trigger (correctly) refuses that.

  ## Requires (already in your project)
  public.get_account_owner_id(), public.identity_is_manager(), profiles, leads, dnc_suppressions

  ## Scheduling (run once, after deploying the function; same pattern as your other cron jobs)
    select cron.schedule('speed-to-lead-sweep', '* * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/speed-to-lead-intake?action=sweep',
        headers := jsonb_build_object('X-Cron-Secret', '<CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/

-- ============================================================
-- 1. Settings
-- ============================================================
CREATE TABLE IF NOT EXISTS speed_to_lead_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  sla_seconds integer NOT NULL DEFAULT 60 CHECK (sla_seconds BETWEEN 15 AND 300),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3),
  retry_delays_minutes integer[] NOT NULL DEFAULT '{5,60}',
  -- Recipient-local calling window. DB-enforced inside the 08:00-21:00 federal floor; default is
  -- narrower on purpose (several state laws end the day at 20:00).
  call_window_start time NOT NULL DEFAULT '09:00' CHECK (call_window_start >= '08:00'),
  call_window_end time NOT NULL DEFAULT '20:00' CHECK (call_window_end <= '21:00'),
  lead_ttl_hours integer NOT NULL DEFAULT 48 CHECK (lead_ttl_hours BETWEEN 1 AND 168),
  qualification_notes text CHECK (qualification_notes IS NULL OR char_length(qualification_notes) <= 1500),
  notify_on_handoff boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stl_window_order CHECK (call_window_start < call_window_end)
);

CREATE OR REPLACE FUNCTION public.stl_settings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id THEN
    RAISE EXCEPTION 'account_owner_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF cardinality(NEW.retry_delays_minutes) > 2 THEN
    RAISE EXCEPTION 'at most 2 retry delays' USING ERRCODE = '22023';
  END IF;
  FOREACH d IN ARRAY NEW.retry_delays_minutes LOOP
    IF d < 1 OR d > 1440 THEN
      RAISE EXCEPTION 'retry delay must be 1..1440 minutes' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stl_settings_guard ON speed_to_lead_settings;
CREATE TRIGGER trg_stl_settings_guard BEFORE INSERT OR UPDATE ON speed_to_lead_settings
  FOR EACH ROW EXECUTE FUNCTION public.stl_settings_guard();

ALTER TABLE speed_to_lead_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stl_settings_select" ON speed_to_lead_settings;
CREATE POLICY "stl_settings_select" ON speed_to_lead_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "stl_settings_insert" ON speed_to_lead_settings;
CREATE POLICY "stl_settings_insert" ON speed_to_lead_settings FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "stl_settings_update" ON speed_to_lead_settings;
CREATE POLICY "stl_settings_update" ON speed_to_lead_settings FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- ============================================================
-- 2. Sources (intake endpoints)
-- ============================================================
CREATE TABLE IF NOT EXISTS speed_to_lead_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  kind text NOT NULL DEFAULT 'web_form'
    CHECK (kind IN ('web_form', 'landing_page', 'meta_lead_ads', 'google_lead_form', 'zapier_or_api')),
  -- sha256 hex of the secret token. The token itself is generated in the browser, shown once, never stored.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (char_length(token_hint) = 4),
  -- The EXACT sentence(s) shown next to the consent checkbox. Version bumps automatically on edit.
  disclosure_text text NOT NULL CHECK (char_length(disclosure_text) BETWEEN 80 AND 2000),
  disclosure_version integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  last_lead_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stl_sources_owner ON speed_to_lead_sources(account_owner_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.stl_sources_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.token_hint IS DISTINCT FROM OLD.token_hint
       OR NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id THEN
      RAISE EXCEPTION 'token and owner are immutable; create a new source to rotate' USING ERRCODE = '42501';
    END IF;
    IF NEW.disclosure_text IS DISTINCT FROM OLD.disclosure_text THEN
      NEW.disclosure_version := OLD.disclosure_version + 1;
    ELSE
      NEW.disclosure_version := OLD.disclosure_version;
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stl_sources_guard ON speed_to_lead_sources;
CREATE TRIGGER trg_stl_sources_guard BEFORE UPDATE ON speed_to_lead_sources
  FOR EACH ROW EXECUTE FUNCTION public.stl_sources_guard();

ALTER TABLE speed_to_lead_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stl_sources_select" ON speed_to_lead_sources;
CREATE POLICY "stl_sources_select" ON speed_to_lead_sources FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "stl_sources_insert" ON speed_to_lead_sources;
CREATE POLICY "stl_sources_insert" ON speed_to_lead_sources FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "stl_sources_update" ON speed_to_lead_sources;
CREATE POLICY "stl_sources_update" ON speed_to_lead_sources FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "stl_sources_delete" ON speed_to_lead_sources;
CREATE POLICY "stl_sources_delete" ON speed_to_lead_sources FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- ============================================================
-- 3. Consent ledger (append-only proof)
-- ============================================================
CREATE TABLE IF NOT EXISTS speed_to_lead_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL,
  source_id uuid,
  lead_id uuid,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+1[2-9]\d{2}[2-9]\d{6}$'),
  email text,
  granted boolean NOT NULL,
  scope text[] NOT NULL,
  method text NOT NULL
    CHECK (method IN ('web_form', 'api', 'revocation_call', 'revocation_manual', 'revocation_wrong_number')),
  disclosure_text text NOT NULL,
  disclosure_sha256 text NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
  disclosure_version integer NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  page_url text,
  form_id text,
  submission_id text,
  third_party_proof_url text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- sha256 over the canonical record: tamper evidence for exports / discovery.
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_stl_consents_phone ON speed_to_lead_consents(account_owner_id, phone_e164, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stl_consents_lead ON speed_to_lead_consents(lead_id) WHERE lead_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.stl_consents_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'speed_to_lead_consents is append-only' USING ERRCODE = '42501';
  END IF;
  -- Retention: proof rows may only be purged after 5 years (TCPA claims commonly reach back 4 years).
  IF OLD.captured_at < now() - interval '5 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'consent proof is retained for 5 years' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS trg_stl_consents_immutable ON speed_to_lead_consents;
CREATE TRIGGER trg_stl_consents_immutable BEFORE UPDATE OR DELETE ON speed_to_lead_consents
  FOR EACH ROW EXECUTE FUNCTION public.stl_consents_immutable();

ALTER TABLE speed_to_lead_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stl_consents_select" ON speed_to_lead_consents;
CREATE POLICY "stl_consents_select" ON speed_to_lead_consents FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: only service_role (edge functions) and the revoke() function below write.

-- ============================================================
-- 4. Requests (one per lead to call) + 5. Attempts (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS speed_to_lead_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  source_id uuid REFERENCES speed_to_lead_sources(id) ON DELETE SET NULL,
  consent_id uuid NOT NULL REFERENCES speed_to_lead_consents(id) ON DELETE RESTRICT,
  phone_e164 text NOT NULL,
  first_name text,
  full_name text,
  service text,
  message text,
  received_at timestamptz NOT NULL,
  sla_deadline_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'dialing', 'booked', 'handoff', 'not_interested', 'unreachable',
                      'suppressed', 'expired', 'cancelled', 'needs_review')),
  final_reason text,
  needs_human boolean NOT NULL DEFAULT false,
  human_reason text,
  handled_at timestamptz,
  handled_by uuid,
  first_dial_at timestamptz,
  time_to_first_dial_ms bigint CHECK (time_to_first_dial_ms IS NULL OR time_to_first_dial_ms >= 0),
  sla_met boolean,
  last_vapi_call_id text,
  claimed_at timestamptz,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_stl_requests_due ON speed_to_lead_requests(next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_stl_requests_owner ON speed_to_lead_requests(account_owner_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stl_requests_vapi ON speed_to_lead_requests(last_vapi_call_id) WHERE last_vapi_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stl_requests_phone ON speed_to_lead_requests(account_owner_id, phone_e164);

CREATE TABLE IF NOT EXISTS speed_to_lead_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES speed_to_lead_requests(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('dialed', 'deferred', 'skipped', 'failed')),
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text,
  local_time text,
  vapi_call_id text,
  outcome text,
  duration_seconds integer,
  ended_reason text,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_stl_attempts_request ON speed_to_lead_attempts(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stl_attempts_vapi ON speed_to_lead_attempts(vapi_call_id) WHERE vapi_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stl_attempts_owner_time ON speed_to_lead_attempts(account_owner_id, created_at DESC);

ALTER TABLE speed_to_lead_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE speed_to_lead_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stl_requests_select" ON speed_to_lead_requests;
CREATE POLICY "stl_requests_select" ON speed_to_lead_requests FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "stl_attempts_select" ON speed_to_lead_attempts;
CREATE POLICY "stl_attempts_select" ON speed_to_lead_attempts FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- ============================================================
-- 6. Functions
-- ============================================================

-- Atomic claim: SKIP LOCKED so overlapping cron runs / the immediate dial never double-dial a lead.
CREATE OR REPLACE FUNCTION public.stl_claim_due(p_limit integer DEFAULT 10, p_request_id uuid DEFAULT NULL)
RETURNS SETOF speed_to_lead_requests
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT id FROM speed_to_lead_requests
    WHERE status = 'queued' AND next_attempt_at <= now()
      AND (p_request_id IS NULL OR id = p_request_id)
    ORDER BY next_attempt_at
    LIMIT GREATEST(1, LEAST(p_limit, 50))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE speed_to_lead_requests r
     SET status = 'dialing', claimed_at = now(), updated_at = now()
    FROM due WHERE r.id = due.id
  RETURNING r.*;
$$;

-- Never guess about a call that may or may not have been placed: park it for a human instead of re-dialing.
CREATE OR REPLACE FUNCTION public.stl_release_stuck()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE speed_to_lead_requests
     SET status = 'needs_review', needs_human = true,
         human_reason = CASE WHEN last_vapi_call_id IS NULL THEN 'dial_state_unknown' ELSE 'no_call_report' END,
         final_reason = CASE WHEN last_vapi_call_id IS NULL THEN 'dial_state_unknown' ELSE 'no_call_report' END,
         next_attempt_at = NULL, updated_at = now()
   WHERE status = 'dialing'
     AND ((last_vapi_call_id IS NULL AND claimed_at < now() - interval '5 minutes')
       OR (last_vapi_call_id IS NOT NULL AND claimed_at < now() - interval '45 minutes'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Owner/manager revocation ("customer told us to stop"): ledger row + DNC + cancel queued calls.
CREATE OR REPLACE FUNCTION public.speed_to_lead_revoke(p_phone text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_text constant text := 'Consent revoked by account manager';
BEGIN
  IF v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+1[2-9]\d{2}[2-9]\d{6}$' THEN
    RAISE EXCEPTION 'invalid phone' USING ERRCODE = '22023';
  END IF;

  INSERT INTO speed_to_lead_consents (
    account_owner_id, phone_e164, granted, scope, method, disclosure_text, disclosure_sha256,
    disclosure_version, captured_at, evidence, record_sha256
  ) VALUES (
    v_owner, p_phone, false, ARRAY['ai_voice_call'], 'revocation_manual', v_text,
    encode(sha256(convert_to(v_text, 'UTF8')), 'hex'), 0, now(),
    jsonb_build_object('note', left(coalesce(p_note, ''), 300), 'by', auth.uid()),
    encode(sha256(convert_to(v_owner::text || p_phone || now()::text || coalesce(p_note, ''), 'UTF8')), 'hex')
  );

  INSERT INTO dnc_suppressions (user_id, phone_number, reason)
  VALUES (v_owner, p_phone, 'manual')
  ON CONFLICT (user_id, phone_number) DO NOTHING;

  UPDATE speed_to_lead_requests
     SET status = 'cancelled', final_reason = 'consent_revoked', next_attempt_at = NULL, updated_at = now()
   WHERE account_owner_id = v_owner AND phone_e164 = p_phone AND status = 'queued';
END $$;

CREATE OR REPLACE FUNCTION public.speed_to_lead_mark_handled(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE speed_to_lead_requests
     SET handled_at = now(), handled_by = auth.uid(), updated_at = now()
   WHERE id = p_request_id AND account_owner_id = public.get_account_owner_id() AND needs_human = true;
END $$;

-- Dashboard KPIs (SECURITY INVOKER: RLS applies, so it can only ever see the caller's account).
CREATE OR REPLACE FUNCTION public.speed_to_lead_metrics(p_days integer DEFAULT 30)
RETURNS TABLE (
  total bigint, dialed bigint, within_sla bigint, median_ms bigint, p90_ms bigint,
  booked bigint, handoff bigint, open_handoffs bigint, suppressed bigint
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT
    count(*),
    count(first_dial_at),
    count(*) FILTER (WHERE sla_met),
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY time_to_first_dial_ms))::bigint,
    (percentile_cont(0.9) WITHIN GROUP (ORDER BY time_to_first_dial_ms))::bigint,
    count(*) FILTER (WHERE status = 'booked'),
    count(*) FILTER (WHERE status = 'handoff'),
    count(*) FILTER (WHERE needs_human AND handled_at IS NULL),
    count(*) FILTER (WHERE status IN ('suppressed', 'cancelled'))
  FROM speed_to_lead_requests
  WHERE account_owner_id = public.get_account_owner_id()
    AND received_at >= now() - make_interval(days => GREATEST(1, LEAST(p_days, 365)));
$$;

REVOKE ALL ON FUNCTION public.stl_claim_due(integer, uuid) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.stl_release_stuck() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.stl_claim_due(integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.stl_release_stuck() TO service_role;
REVOKE ALL ON FUNCTION public.speed_to_lead_revoke(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.speed_to_lead_mark_handled(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.speed_to_lead_revoke(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.speed_to_lead_mark_handled(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.speed_to_lead_metrics(integer) TO authenticated;
