/*
  # PCI-safe pay-by-phone

  ## Why
  Card payments taken by phone (by the AI receptionist or by staff) must never put
  card data into Vireek: not in call recordings, transcripts, logs, or the database.
  Card digits are keyed on the caller's keypad into Twilio <Pay>, tokenized by the
  payment provider, and Vireek only ever receives a token + masked metadata.

  ## What this adds
  1. phone_payment_sessions        one row per secure capture: state machine, amount
                                   (server-derived, never caller/AI supplied), provider
                                   call leg, recording-pause timestamps, masked card result.
  2. phone_payment_audit_events    APPEND-ONLY, hash-chained compliance trail. Allowlisted
                                   metadata only; the database rejects card-like content.
  3. DB-level card-data scrubbing  pci_redact_text() + BEFORE triggers on calls,
                                   live_call_lines and live_calls: if a caller reads a card
                                   number aloud and it reaches a transcript, it is redacted
                                   before it is stored, and the call is flagged.
  4. Invariants enforced here too  (not just in app code)
       - capture states require recording_paused_at   (CHECK)
       - only legal state transitions                  (trigger)
       - finished sessions are immutable                (trigger)
       - one active session per call                    (partial unique index)
       - audit rows cannot be updated, deleted or truncated

  ## Security
  - Written ONLY by edge functions (service role). `authenticated` gets SELECT only.
  - SELECT requires user_id = get_account_owner_id() AND can_view_phone_payments().
  - Audit rows carry no names, phone numbers or card data. Retention: keep >= 12 months
    (PCI DSS 10.5.1); purge older rows with a scheduled job that runs as the table owner.
*/

-- =============================================================
-- 0. Card-data scrubbing primitives
-- =============================================================

CREATE OR REPLACE FUNCTION public.pci_luhn_valid(p_digits text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  i int;
  d int;
  s int := 0;
  dbl boolean := false;
BEGIN
  IF p_digits IS NULL OR p_digits !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;
  FOR i IN REVERSE length(p_digits)..1 LOOP
    d := substr(p_digits, i, 1)::int;
    IF dbl THEN
      d := d * 2;
      IF d > 9 THEN d := d - 9; END IF;
    END IF;
    s := s + d;
    dbl := NOT dbl;
  END LOOP;
  RETURN s % 10 = 0;
END;
$$;

-- Redacts Luhn-valid 13-19 digit card numbers (single space/dash/dot separators allowed)
-- and security codes that follow a "cvv / security code" keyword. Conservative on purpose:
-- it must never corrupt phone numbers, order numbers or timestamps. The edge-function layer
-- (_shared/pci/cardData.ts) is stricter and also handles spoken digits.
CREATE OR REPLACE FUNCTION public.pci_redact_text(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  m text[];
  digits text;
  out_text text := p_text;
BEGIN
  IF p_text IS NULL OR length(p_text) < 3 THEN
    RETURN p_text;
  END IF;

  out_text := regexp_replace(
    out_text,
    '(\m(?:cvv2?|cvc2?|cid|csc|security\s*code|verification\s*(?:code|number))\M[^0-9\n]{0,24})(?:[0-9][ -]?){3,4}(?![0-9])',
    '\1[REDACTED-CVV]',
    'gi'
  );

  IF out_text !~ '(?:[0-9][ .-]?){13}' THEN
    RETURN out_text;
  END IF;

  FOR m IN SELECT regexp_matches(out_text, '(?<![0-9])((?:[0-9][ .-]?){12,18}[0-9])(?![0-9])', 'g') LOOP
    digits := regexp_replace(m[1], '[^0-9]', '', 'g');
    IF length(digits) BETWEEN 13 AND 19
       AND substr(digits, 1, 1) BETWEEN '2' AND '6'
       AND (substr(digits, 1, 1) <> '2' OR substr(digits, 1, 2) BETWEEN '22' AND '27')
       AND public.pci_luhn_valid(digits) THEN
      out_text := replace(out_text, m[1], '[REDACTED-CARD]');
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;

-- =============================================================
-- 1. Flags on calls + scrubbing triggers
-- =============================================================

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS pci_capture_occurred boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pci_spoken_card_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pci_redactions integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.calls.pci_spoken_card_detected IS
  'True when card-like digits reached this call''s transcript/summary and were redacted. The AUDIO may contain them: purge the recording.';
COMMENT ON COLUMN public.calls.pci_capture_occurred IS
  'True when a secure keypad payment capture happened on this call (digits were never recorded or transcribed).';

CREATE OR REPLACE FUNCTION public.pci_scrub_calls()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cleaned text;
BEGIN
  IF NEW.transcript IS NOT NULL THEN
    cleaned := public.pci_redact_text(NEW.transcript);
    IF cleaned IS DISTINCT FROM NEW.transcript THEN
      NEW.transcript := cleaned;
      NEW.pci_spoken_card_detected := true;
      NEW.pci_redactions := COALESCE(NEW.pci_redactions, 0) + 1;
    END IF;
  END IF;
  IF NEW.summary IS NOT NULL THEN
    cleaned := public.pci_redact_text(NEW.summary);
    IF cleaned IS DISTINCT FROM NEW.summary THEN
      NEW.summary := cleaned;
      NEW.pci_spoken_card_detected := true;
      NEW.pci_redactions := COALESCE(NEW.pci_redactions, 0) + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_pci_scrub_calls
  BEFORE INSERT OR UPDATE OF transcript, summary ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.pci_scrub_calls();

CREATE OR REPLACE FUNCTION public.pci_scrub_live_call_lines()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.content := public.pci_redact_text(NEW.content);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_pci_scrub_live_call_lines
  BEFORE INSERT OR UPDATE OF content ON public.live_call_lines
  FOR EACH ROW EXECUTE FUNCTION public.pci_scrub_live_call_lines();

CREATE OR REPLACE FUNCTION public.pci_scrub_live_calls()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.signal_text := public.pci_redact_text(NEW.signal_text);
  NEW.last_line_preview := public.pci_redact_text(NEW.last_line_preview);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_pci_scrub_live_calls
  BEFORE INSERT OR UPDATE OF signal_text, last_line_preview ON public.live_calls
  FOR EACH ROW EXECUTE FUNCTION public.pci_scrub_live_calls();

-- =============================================================
-- 2. Permission helper (same shape as can_view_live_calls)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_view_phone_payments()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_phone_payments() TO authenticated;

-- =============================================================
-- 3. phone_payment_sessions
-- =============================================================

CREATE TABLE IF NOT EXISTS public.phone_payment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  payment_request_id uuid REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  vapi_call_id text NOT NULL,
  provider_call_sid text NOT NULL CHECK (provider_call_sid ~ '^(CA[0-9a-f]{32}|unsupported)$'),
  channel text NOT NULL CHECK (channel IN ('ai_agent', 'staff')),
  initiated_by uuid,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN
    ('requested', 'recording_paused', 'capturing', 'tokenized', 'charging', 'succeeded', 'failed', 'cancelled', 'expired')),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 50 AND 100000000),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,40}$'),
  -- Masked result only. A PAN can never fit these constraints.
  card_brand text CHECK (card_brand IS NULL OR card_brand ~ '^[a-z-]{2,20}$'),
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  stripe_payment_intent_id text UNIQUE CHECK (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  return_to_number text CHECK (return_to_number IS NULL OR return_to_number ~ '^\+[1-9][0-9]{6,14}$'),
  recording_paused_at timestamptz,
  recording_resumed_at timestamptz,
  capture_started_at timestamptz,
  capture_ended_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- THE invariant: no capture without a verified recording pause.
  CONSTRAINT phone_payment_pause_before_capture
    CHECK (status NOT IN ('capturing', 'tokenized', 'charging', 'succeeded') OR recording_paused_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_phone_payment_one_active_per_call
  ON public.phone_payment_sessions (vapi_call_id)
  WHERE status IN ('requested', 'recording_paused', 'capturing', 'tokenized', 'charging');

CREATE INDEX IF NOT EXISTS idx_phone_payment_sessions_user_created
  ON public.phone_payment_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_payment_sessions_job
  ON public.phone_payment_sessions (job_id);

CREATE OR REPLACE FUNCTION public.phone_payment_sessions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  legal boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'phone payment sessions cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.user_id <> OLD.user_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.provider_call_sid <> OLD.provider_call_sid OR NEW.vapi_call_id <> OLD.vapi_call_id
     OR NEW.channel <> OLD.channel THEN
    RAISE EXCEPTION 'phone payment session identity fields are immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    legal := CASE OLD.status
      WHEN 'requested'        THEN NEW.status IN ('recording_paused', 'failed', 'cancelled', 'expired')
      WHEN 'recording_paused' THEN NEW.status IN ('capturing', 'failed', 'cancelled', 'expired')
      WHEN 'capturing'        THEN NEW.status IN ('tokenized', 'failed', 'cancelled', 'expired')
      WHEN 'tokenized'        THEN NEW.status IN ('charging', 'failed', 'expired')
      WHEN 'charging'         THEN NEW.status IN ('succeeded', 'failed')
      ELSE false
    END;
    IF NOT legal THEN
      RAISE EXCEPTION 'illegal phone payment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status IN ('succeeded', 'failed', 'cancelled', 'expired') THEN
    -- Finished sessions are immutable, except stamping when recording resumed.
    IF (to_jsonb(NEW) - 'recording_resumed_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'recording_resumed_at' - 'updated_at') THEN
      RAISE EXCEPTION 'finished phone payment sessions are immutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_phone_payment_sessions_guard
  BEFORE UPDATE OR DELETE ON public.phone_payment_sessions
  FOR EACH ROW EXECUTE FUNCTION public.phone_payment_sessions_guard();

-- =============================================================
-- 4. phone_payment_audit_events (append-only, hash-chained)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.phone_payment_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.phone_payment_sessions(id),
  seq integer NOT NULL,
  user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'session_requested', 'recording_pause_requested', 'recording_paused', 'recording_pause_failed',
    'capture_redirect_sent', 'capture_redirect_failed', 'capture_started', 'capture_progress',
    'capture_completed', 'capture_failed', 'tokenized', 'charge_attempted', 'charge_succeeded',
    'charge_failed', 'recording_resumed', 'recording_resume_failed', 'session_cancelled',
    'session_expired', 'spoken_card_data_detected', 'fallback_payment_link', 'callback_rejected')),
  actor_type text NOT NULL CHECK (actor_type IN ('ai_agent', 'staff', 'system', 'provider')),
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 2048),
  prev_hash text NOT NULL,
  event_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_phone_payment_audit_user_created
  ON public.phone_payment_audit_events (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.phone_payment_event_hash(
  p_prev text, p_session uuid, p_seq integer, p_user uuid, p_type text, p_actor_type text,
  p_actor uuid, p_metadata jsonb, p_created timestamptz
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(
    sha256(convert_to(concat_ws('|',
      p_prev, p_session::text, p_seq::text, p_user::text, p_type, p_actor_type,
      COALESCE(p_actor::text, ''), p_metadata::text,
      to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
    ), 'UTF8')),
    'hex');
$$;

CREATE OR REPLACE FUNCTION public.phone_payment_audit_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  owner uuid;
  last_seq integer;
  last_hash text;
  meta_text text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id::text, 0));

  SELECT s.user_id INTO owner FROM public.phone_payment_sessions s WHERE s.id = NEW.session_id;
  IF owner IS NULL OR owner <> NEW.user_id THEN
    RAISE EXCEPTION 'audit event does not match its session owner' USING ERRCODE = 'check_violation';
  END IF;

  meta_text := NEW.metadata::text;
  IF public.pci_redact_text(meta_text) IS DISTINCT FROM meta_text THEN
    RAISE EXCEPTION 'card data is not allowed in the phone payment audit trail' USING ERRCODE = 'check_violation';
  END IF;

  SELECT e.seq, e.event_hash INTO last_seq, last_hash
    FROM public.phone_payment_audit_events e
   WHERE e.session_id = NEW.session_id
   ORDER BY e.seq DESC
   LIMIT 1;

  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.event_hash := public.phone_payment_event_hash(
    NEW.prev_hash, NEW.session_id, NEW.seq, NEW.user_id, NEW.event_type, NEW.actor_type,
    NEW.actor_id, NEW.metadata, NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_phone_payment_audit_chain
  BEFORE INSERT ON public.phone_payment_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.phone_payment_audit_chain();

CREATE OR REPLACE FUNCTION public.phone_payment_audit_block()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'the phone payment audit trail is append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE TRIGGER trg_phone_payment_audit_no_update
  BEFORE UPDATE OR DELETE ON public.phone_payment_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.phone_payment_audit_block();

CREATE OR REPLACE TRIGGER trg_phone_payment_audit_no_truncate
  BEFORE TRUNCATE ON public.phone_payment_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.phone_payment_audit_block();

-- Recomputes the whole chain for one session. Returns valid=false and the first bad seq on tampering.
CREATE OR REPLACE FUNCTION public.verify_phone_payment_audit_chain(p_session_id uuid)
RETURNS TABLE (valid boolean, events integer, first_bad_seq integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner uuid;
  r record;
  prev text := repeat('0', 64);
  n integer := 0;
  bad integer := NULL;
BEGIN
  SELECT s.user_id INTO owner FROM public.phone_payment_sessions s WHERE s.id = p_session_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION 'session not found';
  END IF;
  IF auth.uid() IS NOT NULL
     AND (owner <> public.get_account_owner_id() OR NOT public.can_view_phone_payments()) THEN
    RAISE EXCEPTION 'session not found';
  END IF;

  FOR r IN SELECT * FROM public.phone_payment_audit_events e WHERE e.session_id = p_session_id ORDER BY e.seq LOOP
    n := n + 1;
    IF bad IS NULL AND (
         r.seq <> n
         OR r.prev_hash <> prev
         OR r.event_hash <> public.phone_payment_event_hash(
              r.prev_hash, r.session_id, r.seq, r.user_id, r.event_type, r.actor_type, r.actor_id, r.metadata, r.created_at)
       ) THEN
      bad := r.seq;
    END IF;
    prev := r.event_hash;
  END LOOP;

  RETURN QUERY SELECT bad IS NULL, n, bad;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_phone_payment_audit_chain(uuid) TO authenticated;

-- =============================================================
-- 5. Expiry sweep (service role only; also called at the start of every new session)
-- =============================================================

CREATE OR REPLACE FUNCTION public.expire_stale_phone_payment_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expired_ids uuid[];
BEGIN
  WITH u AS (
    UPDATE public.phone_payment_sessions s
       SET status = 'expired',
           failure_code = 'expired',
           capture_ended_at = COALESCE(s.capture_ended_at, now())
     WHERE s.user_id = p_user_id
       AND s.status IN ('requested', 'recording_paused', 'capturing', 'tokenized')
       AND s.expires_at < now()
    RETURNING s.id, s.payment_request_id
  )
  SELECT array_agg(u.id) INTO expired_ids FROM u;

  IF expired_ids IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.payment_requests pr
     SET status = 'canceled'
   WHERE pr.status = 'pending'
     AND pr.id IN (SELECT s.payment_request_id FROM public.phone_payment_sessions s WHERE s.id = ANY (expired_ids));

  INSERT INTO public.phone_payment_audit_events (session_id, user_id, event_type, actor_type, metadata)
  SELECT s.id, s.user_id, 'session_expired', 'system', '{}'::jsonb
    FROM public.phone_payment_sessions s
   WHERE s.id = ANY (expired_ids);

  RETURN array_length(expired_ids, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_phone_payment_sessions(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. RLS + grants (read-only for the dashboard)
-- =============================================================

ALTER TABLE public.phone_payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_payment_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS phone_payment_sessions_select ON public.phone_payment_sessions;
CREATE POLICY phone_payment_sessions_select ON public.phone_payment_sessions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_phone_payments());

DROP POLICY IF EXISTS phone_payment_audit_select ON public.phone_payment_audit_events;
CREATE POLICY phone_payment_audit_select ON public.phone_payment_audit_events
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_view_phone_payments());

REVOKE ALL ON public.phone_payment_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.phone_payment_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.phone_payment_sessions TO authenticated;
GRANT SELECT ON public.phone_payment_audit_events TO authenticated;

-- Live status in the dashboard dialog (best effort — the dialog also polls).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.phone_payment_sessions;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;
