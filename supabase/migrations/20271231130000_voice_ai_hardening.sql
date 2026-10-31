/*
  Voice AI hardening (vapi-webhook).

  1. calls(vapi_call_id): the only unique index on this column is PARTIAL
     (20260911080000: ... WHERE vapi_call_id IS NOT NULL). The webhook upserts with
     ON CONFLICT (vapi_call_id) and no predicate, which Postgres cannot match to a partial
     index (error 42P10). A plain unique index is inferable; NULLs stay distinct, so rows
     without a vapi_call_id are unaffected, and it cannot fail on existing data because the
     partial index already guarantees uniqueness among non-null values.

  2. voice_webhook_events: per-(vapi_call_id, event_type) ledger used for
     - idempotency on duplicate / retried end-of-call-report deliveries
     - dead-letter when the call row could not be persisted (nothing is lost: the minimal
       call facts are kept in `payload` and can be replayed with replay_dead_voice_events()).
     Tenant-scoped read; writes are service-role only (the webhook). Every status change is
     appended to status_history by trigger.

  Rollback: DROP TABLE voice_webhook_events; DROP INDEX idx_calls_vapi_call_id_full;
  (the partial index and all call data are untouched).
*/

CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_vapi_call_id_full ON public.calls (vapi_call_id);

CREATE TABLE IF NOT EXISTS public.voice_webhook_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vapi_call_id   text NOT NULL,
  event_type     text NOT NULL,
  status         text NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing', 'processed', 'failed', 'dead', 'replayed')),
  attempts       integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_error     text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vapi_call_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_voice_webhook_events_user
  ON public.voice_webhook_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_webhook_events_open
  ON public.voice_webhook_events (status) WHERE status IN ('failed', 'dead');

ALTER TABLE public.voice_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_webhook_events_select ON public.voice_webhook_events;
CREATE POLICY voice_webhook_events_select ON public.voice_webhook_events
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- No INSERT/UPDATE/DELETE policy for clients: only the service role (webhook) writes.
REVOKE ALL ON public.voice_webhook_events FROM anon, authenticated;
GRANT SELECT ON public.voice_webhook_events TO authenticated;

CREATE OR REPLACE FUNCTION public.voice_webhook_events_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_history := jsonb_build_array(jsonb_build_object('status', NEW.status, 'at', now()));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_history := OLD.status_history || jsonb_build_array(jsonb_build_object('status', NEW.status, 'at', now()));
  ELSE
    NEW.status_history := OLD.status_history;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_voice_webhook_events_audit ON public.voice_webhook_events;
CREATE TRIGGER trg_voice_webhook_events_audit
  BEFORE INSERT OR UPDATE ON public.voice_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.voice_webhook_events_audit();

/*
  Replays dead/failed end-of-call-report events into `calls` from the minimal facts stored in
  payload (no transcript/recording: those were never persisted). Idempotent: ON CONFLICT DO
  NOTHING on vapi_call_id; rows without a vapi_call_id/user_id are skipped. Service role only.
*/
CREATE OR REPLACE FUNCTION public.replay_dead_voice_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.voice_webhook_events
    WHERE status IN ('failed', 'dead') AND event_type = 'end-of-call-report'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.calls (user_id, vapi_call_id, caller_phone, caller_name, duration_seconds, summary, status)
    VALUES (
      r.user_id,
      r.vapi_call_id,
      NULLIF(r.payload->>'caller_phone', ''),
      NULLIF(r.payload->>'caller_name', ''),
      CASE WHEN (r.payload->>'duration_seconds') ~ '^[0-9]+$' THEN (r.payload->>'duration_seconds')::integer END,
      NULLIF(r.payload->>'summary', ''),
      'new_lead'
    )
    ON CONFLICT (vapi_call_id) DO NOTHING;

    UPDATE public.voice_webhook_events SET status = 'replayed' WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.replay_dead_voice_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replay_dead_voice_events() TO service_role;
