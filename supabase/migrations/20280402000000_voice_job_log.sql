-- Hands-free voice job log: AI-drafted structured logs that a technician must review and approve.
-- Security model: clients can only READ their own drafts. Rows are inserted by the
-- `voice-log-extract` Edge Function (service role, after verifying JWT + job access) and
-- state changes go through transition_voice_log_draft(). Nothing here writes to customers.

CREATE TABLE IF NOT EXISTS public.voice_log_drafts (
  id               uuid PRIMARY KEY,                       -- client-generated; also in the audio path => idempotent
  job_id           uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL,
  status           text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'approved', 'discarded')),
  language         text,
  transcript       text NOT NULL DEFAULT '',               -- already PII-redacted by the Edge Function
  extraction       jsonb NOT NULL,
  needs_review     boolean NOT NULL DEFAULT false,
  model            text,
  consent_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz,
  purge_after      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT voice_log_extraction_is_object CHECK (jsonb_typeof(extraction) = 'object'),
  CONSTRAINT voice_log_extraction_size CHECK (pg_column_size(extraction) < 65536)
);

CREATE INDEX IF NOT EXISTS voice_log_drafts_job_idx   ON public.voice_log_drafts (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_log_drafts_user_idx  ON public.voice_log_drafts (created_by, status);
CREATE INDEX IF NOT EXISTS voice_log_drafts_purge_idx ON public.voice_log_drafts (purge_after);

ALTER TABLE public.voice_log_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voice_log_drafts_select_own" ON public.voice_log_drafts;
CREATE POLICY "voice_log_drafts_select_own" ON public.voice_log_drafts
  FOR SELECT TO authenticated USING (created_by = auth.uid());
-- Deliberately no INSERT/UPDATE/DELETE policies for clients.

-- Allowed transitions: ready->approved (optionally with the technician's edited extraction),
-- approved->ready (rollback when writing the job note failed), ready->discarded.
CREATE OR REPLACE FUNCTION public.transition_voice_log_draft(
  p_id uuid, p_from text, p_to text, p_extraction jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF NOT ((p_from = 'ready' AND p_to = 'approved') OR (p_from = 'approved' AND p_to = 'ready')
          OR (p_from = 'ready' AND p_to = 'discarded')) THEN
    RETURN false;
  END IF;
  IF p_extraction IS NOT NULL AND (jsonb_typeof(p_extraction) <> 'object' OR pg_column_size(p_extraction) >= 65536) THEN
    RETURN false;
  END IF;

  UPDATE voice_log_drafts
     SET status = p_to,
         extraction = CASE WHEN p_to = 'approved' AND p_extraction IS NOT NULL THEN p_extraction ELSE extraction END,
         approved_at = CASE WHEN p_to = 'approved' THEN now() WHEN p_to = 'ready' THEN NULL ELSE approved_at END,
         transcript = CASE WHEN p_to = 'discarded' THEN '' ELSE transcript END
   WHERE id = p_id AND created_by = auth.uid() AND status = p_from;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.transition_voice_log_draft(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_voice_log_draft(uuid, text, text, jsonb) TO authenticated;

-- Per-user hourly quota (same shape as consume_tribal_knowledge_quota).
CREATE TABLE IF NOT EXISTS public.voice_log_usage (
  user_id       uuid PRIMARY KEY,
  window_start  timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.voice_log_usage ENABLE ROW LEVEL SECURITY;  -- no policies: service role only

CREATE OR REPLACE FUNCTION public.consume_voice_log_quota(p_user_id uuid, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO voice_log_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE u.window_start END,
        request_count = CASE WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE u.request_count + 1 END
  RETURNING u.request_count INTO v_count;
  RETURN v_count <= p_max;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_voice_log_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_voice_log_quota(uuid, integer, integer) TO service_role;

-- Retention: drafts (and their redacted transcripts) are deleted after purge_after (default 30 days).
CREATE OR REPLACE FUNCTION public.purge_expired_voice_logs() RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (DELETE FROM voice_log_drafts WHERE purge_after < now() RETURNING 1) SELECT count(*)::integer FROM d;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_voice_logs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_voice_logs() TO service_role;

-- Rollback (manual, destructive):
--   DROP FUNCTION IF EXISTS public.purge_expired_voice_logs();
--   DROP FUNCTION IF EXISTS public.consume_voice_log_quota(uuid, integer, integer);
--   DROP FUNCTION IF EXISTS public.transition_voice_log_draft(uuid, text, text, jsonb);
--   DROP TABLE IF EXISTS public.voice_log_usage;
--   DROP TABLE IF EXISTS public.voice_log_drafts;
