/*
  # Reassigned-number check log + cross-channel consent revocation

  ## Tables
  - consent_checks       APPEND-ONLY log of every pre-contact compliance check (reassigned-number lookups,
                         revocation lookups, fail-closed blocks). One row per decision, with the reason.
  - consent_revocations  APPEND-ONLY ledger of revocations parsed from SMS / voice / email. Fan-out
                         bookkeeping columns (fanout_completed_at, fanout_summary) are the only
                         mutable columns.

  ## Functions (service_role only)
  - consent_record_revocation(...)         writes the ledger row (idempotent per source_ref) and fans out
  - consent_apply_revocation_fanout(uuid)  suppresses phone/email + cancels queued work; safe to re-run
  - consent_revocation_active(uuid,text,text)  gate read used before every contact
  - consent_revocation_sweep(integer)      retries incomplete fan-outs; returns overdue count

  ## Security model
  - Scoped by account_owner_id = public.get_account_owner_id() (team members read).
  - Only service_role (edge functions) writes. No INSERT/UPDATE/DELETE policy for authenticated users.
  - No foreign keys on purpose (same reasoning as speed_to_lead_consents): an FK cascade would try to
    DELETE proof rows and the append-only trigger correctly refuses.

  ## Requires (already in the project)
  public.get_account_owner_id(), dnc_suppressions, email_suppressions, outbound_calls,
  followup_agent_enrollments, speed_to_lead_requests

  ## Scheduling (run once; same pattern as the other cron jobs). Retries any fan-out left incomplete.
    select cron.schedule('consent-revocation-sweep', '*/10 * * * *',
      $$ select public.consent_revocation_sweep(200); $$);

  ## Rollback
    drop function if exists public.consent_revocation_sweep(integer);
    drop function if exists public.consent_revocation_active(uuid, text, text);
    drop function if exists public.consent_apply_revocation_fanout(uuid);
    drop function if exists public.consent_record_revocation(uuid, text, text, text, text, text, text, boolean, text, text, integer);
    drop table if exists consent_revocations;
    drop table if exists consent_checks;
  (Tables are append-only evidence; dropping them is a deliberate, counsel-reviewed act.)
*/

-- ============================================================
-- 1. consent_checks (decision log)
-- ============================================================
CREATE TABLE IF NOT EXISTS consent_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL,
  phone_e164 text,
  email text,
  check_type text NOT NULL CHECK (check_type IN ('reassigned_number', 'revocation')),
  channel text NOT NULL CHECK (channel IN ('call', 'sms', 'email', 'any')),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  decision text NOT NULL CHECK (decision IN ('allow', 'block')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 80),
  adapter text CHECK (adapter IS NULL OR char_length(adapter) <= 60),
  provider_status text CHECK (provider_status IS NULL OR provider_status IN ('not_reassigned', 'reassigned', 'unknown')),
  provider_reference text CHECK (provider_reference IS NULL OR char_length(provider_reference) <= 120),
  consent_captured_at timestamptz,
  retryable boolean NOT NULL DEFAULT false,
  detail text CHECK (detail IS NULL OR char_length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_checks_subject CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_consent_checks_phone ON consent_checks(account_owner_id, phone_e164, created_at DESC) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_checks_owner_time ON consent_checks(account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_checks_blocks ON consent_checks(account_owner_id, created_at DESC) WHERE decision = 'block';

CREATE OR REPLACE FUNCTION public.consent_checks_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'consent_checks is append-only' USING ERRCODE = '42501';
  END IF;
  -- Retention: decision evidence may only be purged after 5 years (same horizon as the consent ledger).
  IF OLD.created_at < now() - interval '5 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'consent check evidence is retained for 5 years' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS trg_consent_checks_immutable ON consent_checks;
CREATE TRIGGER trg_consent_checks_immutable BEFORE UPDATE OR DELETE ON consent_checks
  FOR EACH ROW EXECUTE FUNCTION public.consent_checks_immutable();

ALTER TABLE consent_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "consent_checks_select" ON consent_checks;
CREATE POLICY "consent_checks_select" ON consent_checks FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- ============================================================
-- 2. consent_revocations (ledger)
-- ============================================================
CREATE TABLE IF NOT EXISTS consent_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL,
  phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9]\d{7,14}$'),
  email text CHECK (email IS NULL OR (email = lower(email) AND char_length(email) <= 254)),
  channel text NOT NULL CHECK (channel IN ('sms', 'voice', 'email', 'manual')),
  scope text NOT NULL DEFAULT 'all_channels' CHECK (scope IN ('all_channels', 'this_channel')),
  match_kind text CHECK (match_kind IS NULL OR match_kind IN ('keyword', 'phrase', 'structured')),
  matched text CHECK (matched IS NULL OR char_length(matched) <= 80),
  wrong_number boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Outer bound by which every downstream effect must be complete (configurable per deployment).
  effective_by timestamptz NOT NULL,
  fanout_completed_at timestamptz,
  fanout_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT consent_revocations_subject CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_revocations_source_ref
  ON consent_revocations(account_owner_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_revocations_phone ON consent_revocations(account_owner_id, phone_e164, received_at DESC) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_revocations_email ON consent_revocations(account_owner_id, email, received_at DESC) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_revocations_pending ON consent_revocations(effective_by) WHERE fanout_completed_at IS NULL;

CREATE OR REPLACE FUNCTION public.consent_revocations_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only the fan-out bookkeeping may change.
    IF (to_jsonb(NEW) - 'fanout_completed_at' - 'fanout_summary')
       IS DISTINCT FROM (to_jsonb(OLD) - 'fanout_completed_at' - 'fanout_summary') THEN
      RAISE EXCEPTION 'consent_revocations is append-only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.received_at < now() - interval '5 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'revocation evidence is retained for 5 years' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS trg_consent_revocations_guard ON consent_revocations;
CREATE TRIGGER trg_consent_revocations_guard BEFORE UPDATE OR DELETE ON consent_revocations
  FOR EACH ROW EXECUTE FUNCTION public.consent_revocations_guard();

ALTER TABLE consent_revocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "consent_revocations_select" ON consent_revocations;
CREATE POLICY "consent_revocations_select" ON consent_revocations FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- ============================================================
-- 3. Fan-out: suppress + cancel queued work (idempotent, re-runnable)
-- ============================================================
CREATE OR REPLACE FUNCTION public.consent_apply_revocation_fanout(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r consent_revocations%ROWTYPE;
  v_digits text;
  v_calls integer := 0;
  v_enrol integer := 0;
  v_stl integer := 0;
  v_dnc boolean := false;
  v_email boolean := false;
  v_summary jsonb;
BEGIN
  SELECT * INTO r FROM consent_revocations WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revocation not found' USING ERRCODE = 'P0002';
  END IF;

  IF r.phone_e164 IS NOT NULL THEN
    INSERT INTO dnc_suppressions (user_id, phone_number, reason)
    VALUES (r.account_owner_id, r.phone_e164, 'customer_opt_out')
    ON CONFLICT (user_id, phone_number) DO NOTHING;
    v_dnc := true;

    v_digits := regexp_replace(r.phone_e164, '\D', '', 'g');

    UPDATE outbound_calls
       SET status = 'opted_out', outcome_notes = 'Consent revoked (' || r.channel || '); cancelled before dial.'
     WHERE user_id = r.account_owner_id
       AND status = 'queued'
       AND customer_phone IS NOT NULL
       AND (regexp_replace(customer_phone, '\D', '', 'g') = v_digits
            OR (left(v_digits, 1) = '1' AND length(v_digits) = 11
                AND regexp_replace(customer_phone, '\D', '', 'g') = substr(v_digits, 2)));
    GET DIAGNOSTICS v_calls = ROW_COUNT;

    UPDATE followup_agent_enrollments
       SET status = 'opted_out', stop_reason = 'consent_revoked', updated_at = now()
     WHERE user_id = r.account_owner_id
       AND status = 'active'
       AND customer_phone IS NOT NULL
       AND (regexp_replace(customer_phone, '\D', '', 'g') = v_digits
            OR (left(v_digits, 1) = '1' AND length(v_digits) = 11
                AND regexp_replace(customer_phone, '\D', '', 'g') = substr(v_digits, 2)));
    GET DIAGNOSTICS v_enrol = ROW_COUNT;

    UPDATE speed_to_lead_requests
       SET status = 'cancelled', final_reason = 'consent_revoked', next_attempt_at = NULL, updated_at = now()
     WHERE account_owner_id = r.account_owner_id
       AND phone_e164 = r.phone_e164
       AND status = 'queued';
    GET DIAGNOSTICS v_stl = ROW_COUNT;
  END IF;

  IF r.email IS NOT NULL THEN
    INSERT INTO email_suppressions (user_id, email, reason)
    VALUES (r.account_owner_id, r.email, 'unsubscribe')
    ON CONFLICT (user_id, email) DO NOTHING;
    v_email := true;
  END IF;

  v_summary := jsonb_build_object(
    'dnc_phone', v_dnc, 'email_suppressed', v_email,
    'outbound_calls_cancelled', v_calls, 'followup_enrollments_stopped', v_enrol,
    'speed_to_lead_cancelled', v_stl, 'at', now());

  UPDATE consent_revocations SET fanout_completed_at = now(), fanout_summary = v_summary WHERE id = p_id;
  RETURN v_summary;
END $$;

-- ============================================================
-- 4. Record a revocation (idempotent per source_ref) and fan out
-- ============================================================
CREATE OR REPLACE FUNCTION public.consent_record_revocation(
  p_owner uuid,
  p_phone text,
  p_email text,
  p_channel text,
  p_scope text,
  p_match_kind text,
  p_matched text,
  p_wrong_number boolean,
  p_source text,
  p_source_ref text,
  p_window_hours integer DEFAULT 24
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_hours integer := least(240, greatest(0, coalesce(p_window_hours, 24)));
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'phone or email required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO consent_revocations (
    account_owner_id, phone_e164, email, channel, scope, match_kind, matched, wrong_number,
    source, source_ref, effective_by
  ) VALUES (
    p_owner, v_phone, v_email, p_channel, coalesce(p_scope, 'all_channels'), p_match_kind,
    left(p_matched, 80), coalesce(p_wrong_number, false), p_source, p_source_ref,
    now() + make_interval(hours => v_hours)
  )
  ON CONFLICT (account_owner_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Duplicate delivery of the same event (provider retry): return the existing row, change nothing.
    SELECT id INTO v_id FROM consent_revocations
     WHERE account_owner_id = p_owner AND source = p_source AND source_ref = p_source_ref;
    RETURN v_id;
  END IF;

  BEGIN
    PERFORM public.consent_apply_revocation_fanout(v_id);
  EXCEPTION WHEN OTHERS THEN
    -- The revocation itself is already recorded and the gates read it directly; the sweeper retries the fan-out.
    UPDATE consent_revocations
       SET fanout_summary = jsonb_build_object('error', left(SQLERRM, 200), 'at', now())
     WHERE id = v_id;
  END;
  RETURN v_id;
END $$;

-- ============================================================
-- 5. Gate read + sweeper
-- ============================================================
CREATE OR REPLACE FUNCTION public.consent_revocation_active(p_owner uuid, p_phone text, p_email text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM consent_revocations r
     WHERE r.account_owner_id = p_owner
       AND r.scope = 'all_channels'
       AND ((p_phone IS NOT NULL AND r.phone_e164 = p_phone)
         OR (p_email IS NOT NULL AND r.email = lower(p_email)))
  );
$$;

CREATE OR REPLACE FUNCTION public.consent_revocation_sweep(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rec record;
  v_overdue integer := 0;
BEGIN
  FOR rec IN
    SELECT id, effective_by FROM consent_revocations
     WHERE fanout_completed_at IS NULL
     ORDER BY effective_by ASC
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
  LOOP
    BEGIN
      PERFORM public.consent_apply_revocation_fanout(rec.id);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- stays pending; counted below if past its deadline
    END;
  END LOOP;

  SELECT count(*) INTO v_overdue FROM consent_revocations
   WHERE fanout_completed_at IS NULL AND effective_by < now();
  RETURN v_overdue;
END $$;

-- ============================================================
-- 6. Grants (service_role only)
-- ============================================================
REVOKE ALL ON FUNCTION public.consent_apply_revocation_fanout(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consent_record_revocation(uuid, text, text, text, text, text, text, boolean, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consent_revocation_active(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consent_revocation_sweep(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consent_apply_revocation_fanout(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.consent_record_revocation(uuid, text, text, text, text, text, text, boolean, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.consent_revocation_active(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consent_revocation_sweep(integer) TO service_role;
