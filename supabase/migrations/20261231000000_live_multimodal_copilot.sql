/*
  # Live Multimodal Technician Copilot (live-copilot)

  A technician points the phone at a unit, speaks, and the AI combines camera
  frames + a short audio clip + the job/equipment record + service history +
  the company's own manuals (knowledge_articles) into one grounded answer.

  Purely additive - touches nothing that already exists.

  1. live_copilot_sessions   one row per on-site session (job / equipment / escalation link).
  2. live_copilot_turns      one row per capture-and-ask turn (perception + result audit trail).
  3. live-copilot-media      PRIVATE bucket for frames + audio clips, owner folder-scoped.
  4. consume_live_copilot_quota()  atomic hourly quota, service-role only.
  5. finish_live_copilot_session() lets the technician close / mark a session escalated.

  Depends on: jobs, equipment, expert_assist_requests (20261213000000).
  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Sessions -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_copilot_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'escalated')),
  turn_count integer NOT NULL DEFAULT 0,
  max_severity text NOT NULL DEFAULT 'low' CHECK (max_severity IN ('low', 'medium', 'high', 'emergency')),
  escalation_request_id uuid REFERENCES expert_assist_requests(id) ON DELETE SET NULL,
  outcome_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_live_copilot_sessions_user_created
  ON live_copilot_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_copilot_sessions_job
  ON live_copilot_sessions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_live_copilot_sessions_equipment
  ON live_copilot_sessions(equipment_id) WHERE equipment_id IS NOT NULL;

ALTER TABLE live_copilot_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_live_copilot_sessions" ON live_copilot_sessions;
CREATE POLICY "users_read_own_live_copilot_sessions"
ON live_copilot_sessions FOR SELECT TO authenticated
USING (user_id = auth.uid());
-- No client INSERT/UPDATE/DELETE policy: the Edge Function (service role) writes,
-- so severity / confidence / turn counts can never be forged from the browser.

-- 2) Turns --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_copilot_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_copilot_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  question text,
  frame_paths text[] NOT NULL DEFAULT '{}',
  audio_path text,
  perception jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL,
  severity text NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high', 'emergency')),
  confidence numeric,
  model text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_live_copilot_turns_user_created
  ON live_copilot_turns(user_id, created_at DESC);

ALTER TABLE live_copilot_turns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_live_copilot_turns" ON live_copilot_turns;
CREATE POLICY "users_read_own_live_copilot_turns"
ON live_copilot_turns FOR SELECT TO authenticated
USING (user_id = auth.uid());

-- 3) Private media bucket ------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'live-copilot-media',
  'live-copilot-media',
  false,
  8388608, -- 8 MB (frames are downscaled client-side; a 10 s 16 kHz WAV is ~320 KB)
  ARRAY['image/jpeg', 'image/png', 'image/webp',
        'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "users_manage_own_live_copilot_media" ON storage.objects;
CREATE POLICY "users_manage_own_live_copilot_media"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'live-copilot-media' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'live-copilot-media' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 4) Atomic quota (service-role only) ------------------------------------------
CREATE TABLE IF NOT EXISTS live_copilot_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE live_copilot_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the RPC below (service role) touches it.

CREATE OR REPLACE FUNCTION public.consume_live_copilot_quota(
  p_user_id uuid,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO live_copilot_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_live_copilot_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_live_copilot_quota(uuid, integer, integer) TO service_role;

-- 5) Close / escalate a session (caller can only touch their own) --------------
CREATE OR REPLACE FUNCTION public.finish_live_copilot_session(
  p_session_id uuid,
  p_status text,
  p_request_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('completed', 'escalated') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  IF p_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM expert_assist_requests r
    WHERE r.id = p_request_id AND r.user_id = public.get_account_owner_id()
  ) THEN
    RAISE EXCEPTION 'invalid_request';
  END IF;

  UPDATE live_copilot_sessions
  SET status = p_status,
      escalation_request_id = COALESCE(p_request_id, escalation_request_id),
      outcome_note = COALESCE(left(p_note, 1000), outcome_note),
      ended_at = COALESCE(ended_at, now())
  WHERE id = p_session_id AND user_id = auth.uid();

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_live_copilot_session(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_live_copilot_session(uuid, text, uuid, text) TO authenticated;
