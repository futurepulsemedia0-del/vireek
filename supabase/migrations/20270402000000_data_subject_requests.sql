/*
  # Public Data Subject Requests (DSAR): access / delete / correct

  Intake ledger for the public /data-request page. Anyone (no login) can ask
  Vireek to access, delete or correct their personal data, but only after
  proving control of the email address with a one-time code.

  ## New tables
  - `data_subject_requests` — one row per request: verification state, SLA
    deadline, outcome. Service-role written (edge function `dsar-request`);
    Vireek staff (profiles.is_staff) may read and resolve them.
  - `dsar_rate_limit` — atomic fixed-window counters keyed by hashed IP /
    hashed email. Service-role only.

  ## Changes to existing tables
  - `deletion_requests.dsar_id` — links an erasure created from a verified
    DSAR. A verified *delete* request from an account owner becomes a normal
    `full_account` row in `deletion_requests`, so the existing grace period,
    legal-hold trigger and `data-retention-sweep` do the real work. A trigger
    mirrors the erasure's outcome back onto the DSAR.

  ## Privacy
  - Verification codes are stored only as HMAC hashes, never in clear.
  - Unverified requests are scrubbed after 24h and deleted after 7 days
    (see `dsar_expire_stale`, called opportunistically by the edge function).
*/

CREATE TABLE IF NOT EXISTS public.data_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE
    DEFAULT ('DSR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  request_kind text NOT NULL CHECK (request_kind IN ('access', 'delete', 'correct')),
  requester_email text NOT NULL CHECK (char_length(requester_email) BETWEEN 3 AND 254),
  requester_name text NOT NULL CHECK (char_length(requester_name) BETWEEN 1 AND 120),
  relationship text NOT NULL
    CHECK (relationship IN ('account_holder', 'customer_of_customer', 'website_visitor', 'other')),
  region text NOT NULL DEFAULT 'other' CHECK (region IN ('eu_uk', 'california', 'other')),
  details text CHECK (details IS NULL OR char_length(details) <= 2000),
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'in_progress', 'completed', 'rejected', 'expired', 'cancelled')),
  verification_code_hash text,
  verification_expires_at timestamptz,
  verification_attempts integer NOT NULL DEFAULT 0,
  verification_sent_count integer NOT NULL DEFAULT 1,
  verified_at timestamptz,
  due_at timestamptz,
  matched_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  completed_at timestamptz,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dsar_correct_needs_details
    CHECK (request_kind <> 'correct' OR char_length(btrim(coalesce(details, ''))) >= 10)
);

CREATE INDEX IF NOT EXISTS dsar_status_due_idx ON public.data_subject_requests (status, due_at);
CREATE INDEX IF NOT EXISTS dsar_email_idx ON public.data_subject_requests (requester_email);
CREATE INDEX IF NOT EXISTS dsar_pending_created_idx
  ON public.data_subject_requests (created_at) WHERE status = 'pending_verification';

ALTER TABLE public.data_subject_requests ENABLE ROW LEVEL SECURITY;

-- No anonymous/authenticated-user policies: the public form only ever talks
-- to the edge function (service role). Staff can triage and resolve.
CREATE POLICY "staff_select_data_subject_requests"
  ON public.data_subject_requests FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

CREATE POLICY "staff_update_data_subject_requests"
  ON public.data_subject_requests FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

CREATE OR REPLACE FUNCTION public.dsar_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dsar_touch_updated_at ON public.data_subject_requests;
CREATE TRIGGER trg_dsar_touch_updated_at
  BEFORE UPDATE ON public.data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION public.dsar_touch_updated_at();

-- =============================================================
-- RATE LIMIT (atomic, one statement — no read-then-write race)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.dsar_rate_limit (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.dsar_rate_limit ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service-role only.

-- Returns TRUE if the call is within the limit, FALSE if it must be rejected.
CREATE OR REPLACE FUNCTION public.dsar_consume_rate_limit(
  p_bucket text, p_limit integer, p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.dsar_rate_limit AS r (bucket, window_start, request_count)
  VALUES (p_bucket, now(), 1)
  ON CONFLICT (bucket) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds)
                        THEN now() ELSE r.window_start END,
    request_count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds)
                         THEN 1 ELSE r.request_count + 1 END
  RETURNING request_count INTO v_count;
  RETURN v_count <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_consume_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dsar_consume_rate_limit(text, integer, integer) TO service_role;

-- =============================================================
-- VERIFY (atomic: attempt counting + expiry + state change in one call)
-- =============================================================

CREATE OR REPLACE FUNCTION public.dsar_verify_code(
  p_request_id uuid, p_email text, p_code_hash text
)
RETURNS TABLE (
  o_outcome text, o_reference text, o_kind text, o_due_at timestamptz, o_attempts_left integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.data_subject_requests%ROWTYPE;
  c_max constant integer := 5;
BEGIN
  SELECT * INTO r FROM public.data_subject_requests WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND OR r.requester_email <> lower(btrim(p_email)) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  IF r.status = 'expired' THEN
    RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  IF r.status <> 'pending_verification' THEN
    RETURN QUERY SELECT 'already_verified'::text, r.reference, r.request_kind, r.due_at, NULL::integer;
    RETURN;
  END IF;
  IF r.verification_attempts >= c_max THEN
    RETURN QUERY SELECT 'locked'::text, NULL::text, NULL::text, NULL::timestamptz, 0;
    RETURN;
  END IF;
  IF r.verification_expires_at IS NULL OR r.verification_expires_at < now() THEN
    RETURN QUERY SELECT 'code_expired'::text, NULL::text, NULL::text, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  IF r.verification_code_hash IS NOT NULL AND r.verification_code_hash = p_code_hash THEN
    UPDATE public.data_subject_requests
       SET status = 'in_progress',
           verified_at = now(),
           due_at = now() + interval '30 days',
           verification_code_hash = NULL,
           verification_expires_at = NULL
     WHERE id = r.id
     RETURNING due_at INTO r.due_at;
    RETURN QUERY SELECT 'verified'::text, r.reference, r.request_kind, r.due_at, NULL::integer;
    RETURN;
  END IF;

  UPDATE public.data_subject_requests
     SET verification_attempts = verification_attempts + 1
   WHERE id = r.id;
  RETURN QUERY SELECT 'invalid'::text, NULL::text, NULL::text, NULL::timestamptz,
                      GREATEST(c_max - (r.verification_attempts + 1), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_verify_code(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dsar_verify_code(uuid, text, text) TO service_role;

-- =============================================================
-- HOUSEKEEPING: scrub abandoned (unverified) requests
-- =============================================================

CREATE OR REPLACE FUNCTION public.dsar_expire_stale()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.data_subject_requests
     SET status = 'expired',
         requester_email = 'redacted@invalid',
         requester_name = 'redacted',
         details = NULL,
         verification_code_hash = NULL,
         ip_hash = NULL
   WHERE status = 'pending_verification'
     AND created_at < now() - interval '24 hours';

  DELETE FROM public.data_subject_requests
   WHERE status = 'expired' AND updated_at < now() - interval '7 days';

  DELETE FROM public.dsar_rate_limit WHERE window_start < now() - interval '1 day';
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_expire_stale() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dsar_expire_stale() TO service_role;

-- =============================================================
-- LINK TO THE EXISTING ERASURE WORKFLOW (deletion_requests)
-- =============================================================

ALTER TABLE public.deletion_requests
  ADD COLUMN IF NOT EXISTS dsar_id uuid REFERENCES public.data_subject_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deletion_requests_dsar_idx
  ON public.deletion_requests (dsar_id) WHERE dsar_id IS NOT NULL;

-- Mirrors what happens to the erasure back onto the originating DSAR so the
-- requester-facing record never drifts from what the sweep actually did.
CREATE OR REPLACE FUNCTION public.sync_dsar_from_deletion_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.dsar_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' THEN
    UPDATE public.data_subject_requests
       SET status = 'completed', completed_at = now(),
           resolution_note = 'Erasure executed by the retention sweep.'
     WHERE id = NEW.dsar_id AND status = 'in_progress';
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE public.data_subject_requests
       SET status = 'cancelled', completed_at = now(),
           resolution_note = 'Erasure cancelled by the account owner during the grace period.'
     WHERE id = NEW.dsar_id AND status = 'in_progress';
  ELSIF NEW.status = 'blocked_legal_hold' THEN
    UPDATE public.data_subject_requests
       SET resolution_note = 'Automatic erasure blocked by an active legal hold — needs manual review.'
     WHERE id = NEW.dsar_id AND status = 'in_progress';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_dsar_from_deletion_request ON public.deletion_requests;
CREATE TRIGGER trg_sync_dsar_from_deletion_request
  AFTER INSERT OR UPDATE OF status ON public.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION public.sync_dsar_from_deletion_request();
