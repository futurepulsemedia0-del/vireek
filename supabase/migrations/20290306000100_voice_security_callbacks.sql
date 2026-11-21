/*
  # Voice step-up: callback requests (voice_security_callbacks)

  When a caller asks for something that needs step-up and cannot (or will not) receive the SMS code, the AI
  files a callback request. A human calls the customer back on the number ON FILE (never a number the caller
  gave). This resolves the request out of band; it never unlocks anything inside the original call.

  - voice_callback_requests: one open request per (account, call, action class); RLS read for AI-security managers.
  - voice_callback_create(...): service_role only; idempotent per call+class; max 3 open requests per customer per day.
  - voice_callback_mark_done(uuid): managers close a request.

  Requires: public.get_account_owner_id(), public.can_manage_ai_security(), public.identity_is_manager() (all in the voice-security migration / base schema).

  Rollback:
    drop function if exists public.voice_callback_mark_done(uuid);
    drop function if exists public.voice_callback_create(uuid, text, uuid, text, text, text, integer);
    drop table if exists public.voice_callback_requests;
*/

CREATE TABLE IF NOT EXISTS public.voice_callback_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  vapi_call_id  text NOT NULL CHECK (char_length(vapi_call_id) <= 200),
  customer_id   uuid NOT NULL,
  action_class  text NOT NULL CHECK (action_class IN ('account_read', 'reschedule', 'address_change', 'payment', 'other')),
  requested_tool text NOT NULL CHECK (char_length(requested_tool) <= 64),
  reason        text CHECK (reason IS NULL OR char_length(reason) <= 200),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  due_by        timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  handled_at    timestamptz,
  handled_by    uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_callback_call_class ON public.voice_callback_requests (user_id, vapi_call_id, action_class);
CREATE INDEX IF NOT EXISTS idx_voice_callback_pending ON public.voice_callback_requests (user_id, due_by) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_voice_callback_customer_day ON public.voice_callback_requests (user_id, customer_id, created_at DESC);

ALTER TABLE public.voice_callback_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_callback_requests FROM anon, authenticated;
GRANT SELECT ON public.voice_callback_requests TO authenticated;
DROP POLICY IF EXISTS voice_callback_owner_select ON public.voice_callback_requests;
CREATE POLICY voice_callback_owner_select ON public.voice_callback_requests FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_ai_security());

CREATE OR REPLACE FUNCTION public.voice_callback_create(
  p_user_id uuid, p_call_id text, p_customer_id uuid, p_action_class text, p_tool text, p_reason text, p_due_minutes integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_class text := CASE WHEN p_action_class IN ('account_read', 'reschedule', 'address_change', 'payment') THEN p_action_class ELSE 'other' END;
BEGIN
  IF p_user_id IS NULL OR p_customer_id IS NULL OR p_call_id IS NULL OR btrim(p_call_id) = '' THEN
    RAISE EXCEPTION 'user, customer and call are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('voice_callback:' || p_user_id::text || ':' || p_customer_id::text, 0));
  IF (SELECT count(*) FROM voice_callback_requests
       WHERE user_id = p_user_id AND customer_id = p_customer_id AND created_at > now() - interval '24 hours') >= 3 THEN
    RETURN 'limited';
  END IF;
  INSERT INTO voice_callback_requests (user_id, vapi_call_id, customer_id, action_class, requested_tool, reason, due_by)
  VALUES (p_user_id, left(p_call_id, 200), p_customer_id, v_class, left(coalesce(p_tool, 'request_callback'), 64),
          left(p_reason, 200), now() + make_interval(mins => least(1440, greatest(15, coalesce(p_due_minutes, 240)))))
  ON CONFLICT (user_id, vapi_call_id, action_class) DO NOTHING
  RETURNING id INTO v_id;
  RETURN CASE WHEN v_id IS NULL THEN 'duplicate' ELSE 'created' END;
END $$;

CREATE OR REPLACE FUNCTION public.voice_callback_mark_done(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.get_account_owner_id() IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE voice_callback_requests
     SET status = 'done', handled_at = now(), handled_by = auth.uid()
   WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'pending';
END $$;

REVOKE ALL ON FUNCTION public.voice_callback_create(uuid, text, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_callback_create(uuid, text, uuid, text, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.voice_callback_mark_done(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voice_callback_mark_done(uuid) TO authenticated;
