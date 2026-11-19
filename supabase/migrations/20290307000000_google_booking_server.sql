/*
  # Google Booking Server — idempotency ledger + cancel (service_role only)

  Backs supabase/functions/google-booking-server (Actions Center REST v3: HealthCheck, BatchAvailabilityLookup,
  CreateBooking, UpdateBooking). Adds NO column to existing tables and changes NO existing function.

  - google_booking_requests : one row per Google idempotency_token (unique per merchant). booking_id handed to Google
                              is this row's uuid (opaque; never the job id).
  - claim_google_booking_request    : atomic claim -> new | replay | in_flight | duplicate | mismatch
  - complete_google_booking_request : pending -> confirmed (+ job_id)  /  sandbox rows are completed without a job
  - fail_google_booking_request     : pending -> failed (a failed token may be claimed again)
  - cancel_google_booking           : UpdateBooking CANCELED -> cancels the Vireek job when still 'scheduled'

  Everything is service_role only; owners may SELECT their own ledger rows (RLS) for the dashboard / support.

  ## Rollback
    DROP FUNCTION IF EXISTS public.cancel_google_booking(uuid, boolean);
    DROP FUNCTION IF EXISTS public.fail_google_booking_request(uuid, text);
    DROP FUNCTION IF EXISTS public.complete_google_booking_request(uuid, uuid, boolean);
    DROP FUNCTION IF EXISTS public.claim_google_booking_request(uuid, text, bigint, text, text, boolean);
    DROP TABLE IF EXISTS public.google_booking_requests;
*/

CREATE TABLE IF NOT EXISTS public.google_booking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_token text NOT NULL CHECK (length(idempotency_token) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'sandbox', 'canceled', 'failed')),
  slot_start_sec bigint NOT NULL,
  service_id text NOT NULL,
  contact_hash text NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  failure_cause text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_token)
);

CREATE INDEX IF NOT EXISTS idx_google_booking_requests_dupe
  ON public.google_booking_requests (user_id, contact_hash, slot_start_sec);
CREATE INDEX IF NOT EXISTS idx_google_booking_requests_job
  ON public.google_booking_requests (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE public.google_booking_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_google_booking_requests" ON public.google_booking_requests;
CREATE POLICY "select_google_booking_requests" ON public.google_booking_requests
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- -------------------------------------------------------------
-- claim
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_google_booking_request(
  p_user uuid, p_token text, p_start_sec bigint, p_service_id text, p_contact_hash text, p_sandbox boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.google_booking_requests;
BEGIN
  IF p_user IS NULL OR coalesce(p_token, '') = '' OR p_start_sec IS NULL
     OR coalesce(p_service_id, '') = '' OR coalesce(p_contact_hash, '') = '' THEN
    RAISE EXCEPTION 'invalid_claim';
  END IF;

  -- Serialise concurrent claims for the same merchant + token so exactly one caller proceeds.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_token, 0));

  SELECT * INTO v_row FROM public.google_booking_requests
  WHERE user_id = p_user AND idempotency_token = p_token;

  IF FOUND THEN
    IF v_row.slot_start_sec <> p_start_sec OR v_row.service_id <> p_service_id OR v_row.contact_hash <> p_contact_hash THEN
      RETURN jsonb_build_object('state', 'mismatch');
    END IF;
    IF v_row.status = 'failed' THEN
      UPDATE public.google_booking_requests
         SET status = 'pending', failure_cause = NULL, updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('state', 'new', 'id', v_row.id);
    END IF;
    IF v_row.status = 'pending' THEN
      RETURN jsonb_build_object('state', 'in_flight', 'id', v_row.id);
    END IF;
    RETURN jsonb_build_object('state', 'replay', 'id', v_row.id, 'status', v_row.status, 'job_id', v_row.job_id);
  END IF;

  -- A DIFFERENT token for the same person + start time is a duplicate booking (Google: OVERLAPPING_RESERVATION).
  IF EXISTS (
    SELECT 1 FROM public.google_booking_requests r
    WHERE r.user_id = p_user AND r.contact_hash = p_contact_hash AND r.slot_start_sec = p_start_sec
      AND r.status IN ('pending', 'confirmed', 'sandbox')
  ) THEN
    RETURN jsonb_build_object('state', 'duplicate');
  END IF;

  INSERT INTO public.google_booking_requests (user_id, idempotency_token, slot_start_sec, service_id, contact_hash)
  VALUES (p_user, p_token, p_start_sec, p_service_id, p_contact_hash)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'new', 'id', v_row.id, 'sandbox', coalesce(p_sandbox, false));
END;
$$;

-- -------------------------------------------------------------
-- complete / fail
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_google_booking_request(p_id uuid, p_job_id uuid, p_sandbox boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.google_booking_requests
     SET status = CASE WHEN coalesce(p_sandbox, false) THEN 'sandbox' ELSE 'confirmed' END,
         job_id = p_job_id,
         updated_at = now()
   WHERE id = p_id AND status = 'pending';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_google_booking_request(p_id uuid, p_cause text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.google_booking_requests
     SET status = 'failed', failure_cause = left(coalesce(p_cause, 'unknown'), 200), updated_at = now()
   WHERE id = p_id AND status = 'pending';
  RETURN FOUND;
END;
$$;

-- -------------------------------------------------------------
-- cancel (UpdateBooking status=CANCELED)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_google_booking(p_booking_id uuid, p_sandbox boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.google_booking_requests;
  v_status text;
  v_fsm boolean := false;
  p_user uuid;
BEGIN
  -- UpdateBooking carries only the opaque booking_id (uuid); the owning merchant comes from the ledger row.
  SELECT * INTO v_row FROM public.google_booking_requests WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'not_found'); END IF;
  p_user := v_row.user_id;
  IF v_row.status = 'canceled' THEN RETURN jsonb_build_object('state', 'already_canceled'); END IF;
  -- The sandbox endpoint may only touch sandbox rows and the production endpoint only real ones.
  IF (v_row.status = 'sandbox') <> coalesce(p_sandbox, false) THEN RETURN jsonb_build_object('state', 'not_found'); END IF;

  IF v_row.status = 'sandbox' THEN
    UPDATE public.google_booking_requests SET status = 'canceled', updated_at = now() WHERE id = v_row.id;
    RETURN jsonb_build_object('state', 'canceled', 'sandbox', true);
  END IF;
  IF v_row.status <> 'confirmed' OR v_row.job_id IS NULL THEN
    RETURN jsonb_build_object('state', 'not_cancellable');
  END IF;

  SELECT job_status INTO v_status FROM public.jobs WHERE id = v_row.job_id AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'not_cancellable'); END IF;
  IF v_status = 'cancelled' THEN
    UPDATE public.google_booking_requests SET status = 'canceled', updated_at = now() WHERE id = v_row.id;
    RETURN jsonb_build_object('state', 'already_canceled');
  END IF;
  IF v_status <> 'scheduled' THEN RETURN jsonb_build_object('state', 'not_cancellable'); END IF;

  UPDATE public.jobs SET job_status = 'cancelled' WHERE id = v_row.job_id AND user_id = p_user;
  UPDATE public.google_booking_requests SET status = 'canceled', updated_at = now() WHERE id = v_row.id;

  -- A job already pushed to an FSM stays open there: surface it for a human (we cannot cancel it remotely yet).
  SELECT EXISTS (
    SELECT 1 FROM public.job_external_syncs s
    WHERE s.job_id = v_row.job_id AND s.status = 'synced' AND s.external_id IS NOT NULL
  ) INTO v_fsm;

  INSERT INTO public.google_booking_audit (user_id, actor_id, event, detail)
  VALUES (p_user, NULL, 'booking_canceled_by_google',
          jsonb_build_object('booking_id', v_row.id, 'job_id', v_row.job_id, 'fsm_followup_required', v_fsm));

  RETURN jsonb_build_object('state', 'canceled', 'job_id', v_row.job_id, 'fsm_followup_required', v_fsm);
END;
$$;

-- -------------------------------------------------------------
-- Privileges: service_role only
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_google_booking_request(uuid, text, bigint, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_google_booking_request(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_google_booking_request(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_google_booking(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_google_booking_request(uuid, text, bigint, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_google_booking_request(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_google_booking_request(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_google_booking(uuid, boolean) TO service_role;
