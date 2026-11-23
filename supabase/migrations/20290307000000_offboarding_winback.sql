/*
  # Offboarding + opt-in win-back (extends the cancellation flow)

  ## What this adds
  After an owner schedules a cancellation (manage-subscription-cancellation `cancel`):
    - offboarding_cases      one row per cancellation: access-end date, reason, export + outcome tracking
    - offboarding_settings   singleton: kill switch + message timing (never a legal commitment)
    - winback_messages       max TWO rows per case (seq 1 and 2) -> the sequence can never exceed 2
    - winback_events         append-only funnel: opted_in / sent / unsubscribed / reactivated ...

  ## What it deliberately REUSES (not duplicated)
    - subscription_cancellations  exit-survey reason + period_end (source of the access-end date)
    - deletion_requests           the existing owner-initiated, cancellable 14-day-grace erasure pipeline
                                  (+ has_active_legal_hold trigger + data-retention-sweep executor)
    - tenant-export / export-run  the existing data export functions
    - is_vireek_staff(), audit_log

  ## Consent model (win-back is MARKETING to the account owner, not a transactional notice)
    - Opt-in only, never pre-ticked. Consent is stored on the case with a wording version.
    - Every message carries a per-case unsubscribe token (public edge function winback-unsubscribe).
    - Unsubscribe / opt-out cancels every unsent message in the same transaction.
    - Hard cap: UNIQUE (case_id, seq) + CHECK (seq IN (1, 2)) = at most 2 messages per case.
    - [COUNSEL] CAN-SPAM / GDPR / ePrivacy wording, sender identity and postal address are NOT decided here.

  ## Security model
    - Owner reads ONLY their own case through offboarding_my_case(); no client INSERT/UPDATE/DELETE.
    - Consent changes only through SECURITY DEFINER RPCs that resolve the caller via auth.uid().
    - Staff read via staff_offboarding_overview(); settings change via an audited staff RPC.
    - Sweep/unsubscribe RPCs are service_role only.
    - winback_events / offboarding_cases carry opaque ids and NO email, NO free text (no FK to profiles so an
      account erasure is never blocked by append-only history). [COUNSEL] confirm retention of this history.

  Requires: profiles, subscription_cancellations, deletion_requests, audit_log, is_vireek_staff(uuid).
  Idempotent: safe to run twice.
*/

-- ---------------------------------------------------------------------------
-- 1. Settings (singleton)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.offboarding_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  winback_enabled boolean NOT NULL DEFAULT false,            -- OFF until counsel signs off the wording
  first_message_delay_days integer NOT NULL DEFAULT 7 CHECK (first_message_delay_days BETWEEN 1 AND 90),
  second_message_gap_days integer NOT NULL DEFAULT 30 CHECK (second_message_gap_days BETWEEN 7 AND 180),
  attribution_days integer NOT NULL DEFAULT 30 CHECK (attribution_days BETWEEN 1 AND 90),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.offboarding_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Cases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.offboarding_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'ended', 'withdrawn', 'reactivated')),
  reason text
    CHECK (reason IS NULL OR reason IN ('too_expensive', 'missing_features', 'not_using', 'switching', 'closing_business', 'technical_issues', 'other')),
  plan text,
  access_ends_at timestamptz NOT NULL,
  export_started_at timestamptz,
  -- win-back consent (NULL consent_at = never opted in)
  winback_consent_at timestamptz,
  winback_consent_version text CHECK (winback_consent_version IS NULL OR char_length(winback_consent_version) <= 40),
  winback_withdrawn_at timestamptz,
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  -- outcome
  ended_at timestamptz,
  reactivated_at timestamptz,
  attributed_seq smallint CHECK (attributed_seq IS NULL OR attributed_seq IN (1, 2)),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- one OPEN case per account (a past reactivated/withdrawn case never blocks a new cancellation)
CREATE UNIQUE INDEX IF NOT EXISTS uq_offboarding_open_case
  ON public.offboarding_cases (user_id) WHERE status IN ('scheduled', 'ended');
CREATE UNIQUE INDEX IF NOT EXISTS uq_offboarding_unsub_token ON public.offboarding_cases (unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_offboarding_cases_created ON public.offboarding_cases (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offboarding_cases_due_end ON public.offboarding_cases (access_ends_at) WHERE status = 'scheduled';

-- ---------------------------------------------------------------------------
-- 3. Win-back messages: at most seq 1 and seq 2 per case
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.winback_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.offboarding_cases(id) ON DELETE CASCADE,
  seq smallint NOT NULL CHECK (seq IN (1, 2)),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  scheduled_for timestamptz NOT NULL,
  claimed_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0,
  sent_at timestamptz,
  skip_reason text CHECK (skip_reason IS NULL OR char_length(skip_reason) <= 60),
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_winback_case_seq UNIQUE (case_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_winback_messages_due ON public.winback_messages (scheduled_for) WHERE status IN ('scheduled', 'sending');

-- ---------------------------------------------------------------------------
-- 4. Events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.winback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN (
    'case_opened', 'export_started', 'opted_in', 'opted_out', 'unsubscribed',
    'sent', 'skipped', 'failed', 'ended', 'withdrawn', 'reactivated'
  )),
  seq smallint CHECK (seq IS NULL OR seq IN (1, 2)),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_winback_events_case ON public.winback_events (case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_winback_events_event ON public.winback_events (event, created_at DESC);

CREATE OR REPLACE FUNCTION public.winback_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_winback_events_append_only ON public.winback_events;
CREATE TRIGGER trg_winback_events_append_only
  BEFORE UPDATE OR DELETE ON public.winback_events
  FOR EACH ROW EXECUTE FUNCTION public.winback_events_append_only();

-- ---------------------------------------------------------------------------
-- 5. RLS: nobody writes directly; owner reads own case; staff read all
-- ---------------------------------------------------------------------------
ALTER TABLE public.offboarding_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offboarding_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.winback_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.winback_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_offboarding_settings" ON public.offboarding_settings;
CREATE POLICY "staff_select_offboarding_settings" ON public.offboarding_settings
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "owner_select_offboarding_cases" ON public.offboarding_cases;
CREATE POLICY "owner_select_offboarding_cases" ON public.offboarding_cases
  FOR SELECT TO authenticated USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "staff_select_offboarding_cases" ON public.offboarding_cases;
CREATE POLICY "staff_select_offboarding_cases" ON public.offboarding_cases
  FOR SELECT TO authenticated USING (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS "staff_select_winback_messages" ON public.winback_messages;
CREATE POLICY "staff_select_winback_messages" ON public.winback_messages
  FOR SELECT TO authenticated USING (public.is_vireek_staff((select auth.uid())));

DROP POLICY IF EXISTS "staff_select_winback_events" ON public.winback_events;
CREATE POLICY "staff_select_winback_events" ON public.winback_events
  FOR SELECT TO authenticated USING (public.is_vireek_staff((select auth.uid())));

REVOKE ALL ON public.offboarding_settings, public.offboarding_cases, public.winback_messages, public.winback_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.offboarding_settings, public.offboarding_cases, public.winback_messages, public.winback_events FROM authenticated;
GRANT SELECT ON public.offboarding_settings, public.offboarding_cases, public.winback_messages, public.winback_events TO authenticated;  -- rows still filtered by the RLS policies above

-- ---------------------------------------------------------------------------
-- 6. Internal helper: cancel every unsent message of a case
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.winback_cancel_unsent(p_case uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.winback_messages
     SET status = 'cancelled', claimed_at = NULL
   WHERE case_id = p_case AND status IN ('scheduled', 'sending', 'failed');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.winback_cancel_unsent(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Edge-function RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- 7a) Open (or refresh) the case when a cancellation is scheduled. Idempotent per open case.
CREATE OR REPLACE FUNCTION public.offboarding_open_case(
  p_user uuid, p_reason text, p_plan text, p_access_ends_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user IS NULL OR p_access_ends_at IS NULL THEN
    RAISE EXCEPTION 'user and access end are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.offboarding_cases (user_id, reason, plan, access_ends_at)
  VALUES (p_user, p_reason, p_plan, p_access_ends_at)
  ON CONFLICT (user_id) WHERE status IN ('scheduled', 'ended')
  DO UPDATE SET reason = COALESCE(EXCLUDED.reason, public.offboarding_cases.reason),
                plan = COALESCE(EXCLUDED.plan, public.offboarding_cases.plan),
                access_ends_at = EXCLUDED.access_ends_at,
                updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.winback_events (case_id, user_id, event)
  SELECT v_id, p_user, 'case_opened'
   WHERE NOT EXISTS (SELECT 1 FROM public.winback_events e WHERE e.case_id = v_id AND e.event = 'case_opened');

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.offboarding_open_case(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboarding_open_case(uuid, text, text, timestamptz) TO service_role;

-- 7b) The owner changed their mind before access ended ("Keep my subscription").
CREATE OR REPLACE FUNCTION public.offboarding_withdraw_case(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.offboarding_cases
     SET status = 'withdrawn', withdrawn_at = now(), updated_at = now()
   WHERE user_id = p_user AND status = 'scheduled'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;

  PERFORM public.winback_cancel_unsent(v_id);
  INSERT INTO public.winback_events (case_id, user_id, event) VALUES (v_id, p_user, 'withdrawn');
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.offboarding_withdraw_case(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboarding_withdraw_case(uuid) TO service_role;

-- 7c) Hourly reconcile: scheduled -> ended once access is over; ended -> reactivated when the
--     account is paying again. Attribution to win-back only if a message was SENT inside the window.
CREATE OR REPLACE FUNCTION public.offboarding_reconcile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attr integer;
  v_ended integer := 0;
  v_react integer := 0;
  r record;
  v_seq smallint;
BEGIN
  SELECT attribution_days INTO v_attr FROM public.offboarding_settings WHERE id;

  -- A claim nobody finished within an hour is parked, never re-sent (at-most-once delivery).
  UPDATE public.winback_messages
     SET status = 'failed', error = 'stale_claim', claimed_at = NULL
   WHERE status = 'sending' AND claimed_at < now() - interval '1 hour';

  FOR r IN
    SELECT c.id, c.user_id FROM public.offboarding_cases c
     WHERE c.status = 'scheduled' AND c.access_ends_at <= now()
     FOR UPDATE OF c SKIP LOCKED
  LOOP
    UPDATE public.offboarding_cases SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = r.id;
    INSERT INTO public.winback_events (case_id, user_id, event) VALUES (r.id, r.user_id, 'ended');
    v_ended := v_ended + 1;
  END LOOP;

  FOR r IN
    SELECT c.id, c.user_id FROM public.offboarding_cases c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE c.status = 'ended'
       AND p.status = 'active'
       AND p.subscription_status = 'active'
     FOR UPDATE OF c SKIP LOCKED
  LOOP
    SELECT m.seq INTO v_seq
      FROM public.winback_messages m
     WHERE m.case_id = r.id AND m.status = 'sent'
       AND m.sent_at >= now() - make_interval(days => v_attr)
     ORDER BY m.seq DESC LIMIT 1;

    UPDATE public.offboarding_cases
       SET status = 'reactivated', reactivated_at = now(), attributed_seq = v_seq, updated_at = now()
     WHERE id = r.id;
    PERFORM public.winback_cancel_unsent(r.id);
    INSERT INTO public.winback_events (case_id, user_id, event, seq, detail)
    VALUES (r.id, r.user_id, 'reactivated', v_seq, CASE WHEN v_seq IS NULL THEN 'organic' ELSE 'attributed' END);
    v_react := v_react + 1;
  END LOOP;

  RETURN jsonb_build_object('ended', v_ended, 'reactivated', v_react);
END;
$$;
REVOKE ALL ON FUNCTION public.offboarding_reconcile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboarding_reconcile() TO service_role;

-- 7d) Claim due messages. Atomic: SKIP LOCKED + status flip, so two overlapping sweeps never send twice.
--     seq 2 is claimable only after seq 1 was actually SENT. Delivery is AT-MOST-ONCE: a claim that is never
--     finished (crashed sweep) is parked as 'failed' by offboarding_reconcile(), never re-sent, so a marketing
--     email can be lost but not duplicated. Only a KNOWN provider failure is retried (max 3 attempts).
--     Nothing is claimed while the kill switch is off or consent is missing/withdrawn.
CREATE OR REPLACE FUNCTION public.winback_claim_due(p_limit integer DEFAULT 25)
RETURNS TABLE (message_id uuid, case_id uuid, user_id uuid, seq smallint, unsubscribe_token uuid, access_ends_at timestamptz, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE((SELECT s.winback_enabled FROM public.offboarding_settings s WHERE s.id), false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT m.id
      FROM public.winback_messages m
      JOIN public.offboarding_cases c ON c.id = m.case_id
     WHERE m.status = 'scheduled'
       AND m.scheduled_for <= now()
       AND c.status = 'ended'
       AND c.winback_consent_at IS NOT NULL
       AND c.winback_withdrawn_at IS NULL
       AND (m.seq = 1 OR EXISTS (
             SELECT 1 FROM public.winback_messages p WHERE p.case_id = m.case_id AND p.seq = 1 AND p.status = 'sent'))
     ORDER BY m.scheduled_for
     LIMIT greatest(1, least(COALESCE(p_limit, 25), 100))
     FOR UPDATE OF m SKIP LOCKED
  ), upd AS (
    UPDATE public.winback_messages m
       SET status = 'sending', claimed_at = now(), attempts = m.attempts + 1
      FROM due WHERE m.id = due.id
    RETURNING m.id, m.case_id, m.seq
  )
  SELECT upd.id, upd.case_id, c.user_id, upd.seq, c.unsubscribe_token, c.access_ends_at, c.reason
    FROM upd JOIN public.offboarding_cases c ON c.id = upd.case_id;
END;
$$;
REVOKE ALL ON FUNCTION public.winback_claim_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.winback_claim_due(integer) TO service_role;

-- 7e) Record the result of one send attempt.
--     p_outcome: sent | skipped | failed. A failed attempt goes back to 'scheduled' (retry next sweep)
--     until attempts reach 3, then it stays 'failed'.
CREATE OR REPLACE FUNCTION public.winback_finish(p_message uuid, p_outcome text, p_detail text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case uuid;
  v_user uuid;
  v_seq smallint;
  v_attempts smallint;
BEGIN
  IF p_outcome NOT IN ('sent', 'skipped', 'failed') THEN
    RAISE EXCEPTION 'bad outcome' USING ERRCODE = '22023';
  END IF;

  SELECT m.case_id, c.user_id, m.seq, m.attempts INTO v_case, v_user, v_seq, v_attempts
    FROM public.winback_messages m JOIN public.offboarding_cases c ON c.id = m.case_id
   WHERE m.id = p_message AND m.status = 'sending'
   FOR UPDATE OF m;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_outcome = 'sent' THEN
    UPDATE public.winback_messages SET status = 'sent', sent_at = now(), error = NULL WHERE id = p_message;
  ELSIF p_outcome = 'skipped' THEN
    UPDATE public.winback_messages SET status = 'skipped', skip_reason = left(p_detail, 60) WHERE id = p_message;
    IF v_seq = 1 THEN PERFORM public.winback_cancel_unsent(v_case); END IF;   -- no seq 1 => no seq 2
  ELSE
    UPDATE public.winback_messages
       SET status = CASE WHEN v_attempts >= 3 THEN 'failed' ELSE 'scheduled' END,
           claimed_at = NULL, error = left(p_detail, 300)
     WHERE id = p_message;
  END IF;

  INSERT INTO public.winback_events (case_id, user_id, event, seq, detail)
  VALUES (v_case, v_user, p_outcome, v_seq, CASE WHEN p_outcome = 'sent' THEN NULL ELSE left(p_detail, 60) END);
END;
$$;
REVOKE ALL ON FUNCTION public.winback_finish(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.winback_finish(uuid, text, text) TO service_role;

-- 7f) One-click unsubscribe by token (service role, called by winback-unsubscribe). Idempotent.
CREATE OR REPLACE FUNCTION public.winback_unsubscribe(p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case uuid;
  v_user uuid;
  v_was_active boolean;
BEGIN
  SELECT id, user_id, (winback_withdrawn_at IS NULL) INTO v_case, v_user, v_was_active
    FROM public.offboarding_cases WHERE unsubscribe_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.offboarding_cases
     SET winback_withdrawn_at = COALESCE(winback_withdrawn_at, now()), updated_at = now()
   WHERE id = v_case;
  PERFORM public.winback_cancel_unsent(v_case);

  IF v_was_active THEN
    INSERT INTO public.winback_events (case_id, user_id, event) VALUES (v_case, v_user, 'unsubscribed');
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.winback_unsubscribe(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.winback_unsubscribe(uuid) TO service_role;

-- 7g) Public lookup for the unsubscribe page: company name only, never an email address.
CREATE OR REPLACE FUNCTION public.winback_unsubscribe_lookup(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  SELECT c.winback_withdrawn_at, p.company_name INTO r
    FROM public.offboarding_cases c LEFT JOIN public.profiles p ON p.id = c.user_id
   WHERE c.unsubscribe_token = p_token;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('company', r.company_name, 'already', r.winback_withdrawn_at IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.winback_unsubscribe_lookup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.winback_unsubscribe_lookup(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Owner-facing RPCs (authenticated; resolve the caller via auth.uid(), never a client id)
-- ---------------------------------------------------------------------------

-- 8a) What the offboarding page renders. NULL when the caller has no open or recent case.
CREATE OR REPLACE FUNCTION public.offboarding_my_case()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  c public.offboarding_cases%ROWTYPE;
  v_s public.offboarding_settings%ROWTYPE;
  v_del record;
  v_msgs jsonb;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND role = 'owner') THEN
    RETURN NULL;
  END IF;

  SELECT * INTO c FROM public.offboarding_cases
   WHERE user_id = v_uid ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_s FROM public.offboarding_settings WHERE id;

  SELECT d.id, d.status, d.scheduled_for INTO v_del
    FROM public.deletion_requests d
   WHERE d.user_id = v_uid AND d.request_type = 'full_account' AND d.status IN ('grace_period', 'processing', 'blocked_legal_hold', 'completed')
   ORDER BY d.created_at DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('seq', m.seq, 'status', m.status, 'scheduled_for', m.scheduled_for) ORDER BY m.seq), '[]'::jsonb)
    INTO v_msgs FROM public.winback_messages m WHERE m.case_id = c.id AND m.status IN ('scheduled', 'sending', 'sent');

  RETURN jsonb_build_object(
    'id', c.id,
    'status', c.status,
    'reason', c.reason,
    'access_ends_at', c.access_ends_at,
    'export_started_at', c.export_started_at,
    'winback_available', v_s.winback_enabled,
    'winback_opted_in', (c.winback_consent_at IS NOT NULL AND c.winback_withdrawn_at IS NULL),
    'winback_messages', v_msgs,
    'deletion', CASE WHEN v_del.status IS NULL THEN NULL
                     ELSE jsonb_build_object('id', v_del.id, 'status', v_del.status, 'scheduled_for', v_del.scheduled_for) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.offboarding_my_case() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.offboarding_my_case() TO authenticated;

-- 8b) Owner records that they started an export (for the guided checklist + funnel). Idempotent.
CREATE OR REPLACE FUNCTION public.offboarding_record_export()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_case uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  UPDATE public.offboarding_cases
     SET export_started_at = COALESCE(export_started_at, now()), updated_at = now()
   WHERE user_id = v_uid AND status IN ('scheduled', 'ended') AND export_started_at IS NULL
  RETURNING id INTO v_case;
  IF v_case IS NOT NULL THEN
    INSERT INTO public.winback_events (case_id, user_id, event) VALUES (v_case, v_uid, 'export_started');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.offboarding_record_export() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.offboarding_record_export() TO authenticated;

-- 8c) Opt in / opt out of the win-back sequence. Opt-in creates exactly two scheduled messages.
--     Re-opting in re-arms only messages that were never sent (a sent message is never re-sent).
CREATE OR REPLACE FUNCTION public.offboarding_set_winback_consent(p_opt_in boolean, p_consent_version text DEFAULT 'winback-v1')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  c public.offboarding_cases%ROWTYPE;
  v_s public.offboarding_settings%ROWTYPE;
  v_first timestamptz;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND role = 'owner') THEN
    RAISE EXCEPTION 'only the account owner can change this' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.offboarding_cases
   WHERE user_id = v_uid AND status IN ('scheduled', 'ended') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open offboarding case' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_s FROM public.offboarding_settings WHERE id;

  IF p_opt_in THEN
    IF NOT v_s.winback_enabled THEN
      RAISE EXCEPTION 'win-back is not available' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(COALESCE(p_consent_version, '')) NOT BETWEEN 1 AND 40 THEN
      RAISE EXCEPTION 'consent version required' USING ERRCODE = '22023';
    END IF;

    UPDATE public.offboarding_cases
       SET winback_consent_at = now(), winback_consent_version = p_consent_version,
           winback_withdrawn_at = NULL, updated_at = now()
     WHERE id = c.id;

    v_first := greatest(c.access_ends_at + make_interval(days => v_s.first_message_delay_days), now() + interval '1 hour');

    INSERT INTO public.winback_messages (case_id, seq, scheduled_for)
    VALUES (c.id, 1, v_first), (c.id, 2, v_first + make_interval(days => v_s.second_message_gap_days))
    ON CONFLICT (case_id, seq) DO UPDATE
       SET status = 'scheduled', scheduled_for = EXCLUDED.scheduled_for, claimed_at = NULL, attempts = 0, skip_reason = NULL, error = NULL
     WHERE public.winback_messages.status = 'cancelled';

    INSERT INTO public.winback_events (case_id, user_id, event) VALUES (c.id, v_uid, 'opted_in');
  ELSE
    UPDATE public.offboarding_cases
       SET winback_withdrawn_at = COALESCE(winback_withdrawn_at, now()), updated_at = now()
     WHERE id = c.id;
    PERFORM public.winback_cancel_unsent(c.id);
    IF c.winback_consent_at IS NOT NULL AND c.winback_withdrawn_at IS NULL THEN
      INSERT INTO public.winback_events (case_id, user_id, event) VALUES (c.id, v_uid, 'opted_out');
    END IF;
  END IF;

  RETURN public.offboarding_my_case();
END;
$$;
REVOKE ALL ON FUNCTION public.offboarding_set_winback_consent(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.offboarding_set_winback_consent(boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. Staff: overview + audited settings change
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_offboarding_overview(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := greatest(7, least(COALESCE(p_days, 90), 365));
  v_since timestamptz;
  v_s public.offboarding_settings%ROWTYPE;
  v_funnel jsonb;
  v_reasons jsonb;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  v_since := now() - make_interval(days => v_days);
  SELECT * INTO v_s FROM public.offboarding_settings WHERE id;

  SELECT jsonb_build_object(
    'cases', count(*),
    'ended', count(*) FILTER (WHERE c.status = 'ended' OR c.status = 'reactivated'),
    'withdrawn', count(*) FILTER (WHERE c.status = 'withdrawn'),
    'exported', count(*) FILTER (WHERE c.export_started_at IS NOT NULL),
    'opted_in', count(*) FILTER (WHERE c.winback_consent_at IS NOT NULL),
    'unsubscribed', count(*) FILTER (WHERE c.winback_consent_at IS NOT NULL AND c.winback_withdrawn_at IS NOT NULL),
    'reactivated', count(*) FILTER (WHERE c.status = 'reactivated'),
    'reactivated_attributed', count(*) FILTER (WHERE c.status = 'reactivated' AND c.attributed_seq IS NOT NULL),
    'sent_1', (SELECT count(*) FROM public.winback_messages m JOIN public.offboarding_cases x ON x.id = m.case_id WHERE x.created_at >= v_since AND m.seq = 1 AND m.status = 'sent'),
    'sent_2', (SELECT count(*) FROM public.winback_messages m JOIN public.offboarding_cases x ON x.id = m.case_id WHERE x.created_at >= v_since AND m.seq = 2 AND m.status = 'sent'),
    'failed', (SELECT count(*) FROM public.winback_messages m JOIN public.offboarding_cases x ON x.id = m.case_id WHERE x.created_at >= v_since AND m.status = 'failed')
  ) INTO v_funnel
  FROM public.offboarding_cases c WHERE c.created_at >= v_since;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.cases DESC), '[]'::jsonb) INTO v_reasons FROM (
    SELECT COALESCE(c.reason, 'unknown') AS reason,
           count(*) AS cases,
           count(*) FILTER (WHERE c.status = 'withdrawn') AS withdrawn,
           count(*) FILTER (WHERE c.winback_consent_at IS NOT NULL) AS opted_in,
           count(*) FILTER (WHERE c.status = 'reactivated') AS reactivated
      FROM public.offboarding_cases c WHERE c.created_at >= v_since GROUP BY 1
  ) t;

  RETURN jsonb_build_object(
    'days', v_days,
    'settings', jsonb_build_object(
      'winback_enabled', v_s.winback_enabled,
      'first_message_delay_days', v_s.first_message_delay_days,
      'second_message_gap_days', v_s.second_message_gap_days,
      'attribution_days', v_s.attribution_days),
    'funnel', v_funnel,
    'reasons', v_reasons
  );
END;
$$;
REVOKE ALL ON FUNCTION public.staff_offboarding_overview(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_offboarding_overview(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_offboarding_update_settings(
  p_winback_enabled boolean, p_first_delay integer, p_gap integer, p_attribution integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;

  UPDATE public.offboarding_settings
     SET winback_enabled = COALESCE(p_winback_enabled, winback_enabled),
         first_message_delay_days = COALESCE(p_first_delay, first_message_delay_days),
         second_message_gap_days = COALESCE(p_gap, second_message_gap_days),
         attribution_days = COALESCE(p_attribution, attribution_days),
         updated_by = v_uid, updated_at = now()
   WHERE id;

  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (v_uid, v_uid, (SELECT email FROM public.profiles WHERE id = v_uid), 'offboarding_settings_updated', 'offboarding_settings', 'singleton');
END;
$$;
REVOKE ALL ON FUNCTION public.staff_offboarding_update_settings(boolean, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_offboarding_update_settings(boolean, integer, integer, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 10. Hourly transport (same pattern as voice_cron_tick). If pg_cron is absent, schedule the
--     edge function `offboarding-sweep` with your external cron.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offboarding_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base text;
  v_secret text;
BEGIN
  v_base := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);
  IF coalesce(v_base, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base || '/offboarding-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
    body := '{}'::jsonb
  );
END $$;
REVOKE ALL ON FUNCTION public.offboarding_cron_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offboarding_cron_tick() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-offboarding-sweep', '17 * * * *', $c$select public.offboarding_cron_tick()$c$);
  ELSE
    RAISE NOTICE 'pg_cron not installed: call the offboarding-sweep edge function hourly from your external cron';
  END IF;
END $$;
