/*
  # Live video sessions (technician <-> remote expert)

  A technician starts a WebRTC video session from a job and shares a join link with a remote
  expert (a colleague, a manufacturer rep, ...). The expert needs no account. The technician can
  record a clip (with the expert's recorded consent); clips land in a private bucket and in the
  job's activity timeline (business_activity_events, aggregate 'job').

  Security model
    - video_sessions / video_session_clips: RLS SELECT for account members who can see the job
      (the jobs RLS decides). No client INSERT/UPDATE/DELETE on clips; sessions can only be
      INSERTed by an account member for a job they can see (a trigger forces every sensitive column).
    - Guests (anon) only ever talk to SECURITY DEFINER RPCs keyed by a 244-bit join token.
    - Media never touches the database: it flows peer-to-peer (TURN relay when needed).
    - Recording is gated server-side: attach_video_clip refuses without the expert's consent.

  Purely additive. Safe to re-run.
*/

-- =============================================================
-- 0. PERMISSION HELPER (owner or "edit business profile")
-- =============================================================
CREATE OR REPLACE FUNCTION public.video_sessions_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM team_members t
      LEFT JOIN custom_roles cr ON cr.id = t.custom_role_id
      WHERE t.user_id = auth.uid()
        AND COALESCE(
              (cr.permissions ->> 'can_edit_business_profile')::boolean,
              (t.permissions ->> 'can_edit_business_profile')::boolean,
              false
            )
    );
$$;

REVOKE ALL ON FUNCTION public.video_sessions_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.video_sessions_can_manage() TO authenticated;

-- =============================================================
-- 1. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.video_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_by_name text,
  join_token text NOT NULL UNIQUE
    DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    CHECK (join_token ~ '^[0-9a-f]{64}$'),
  title text NOT NULL DEFAULT 'Remote expert session'
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  expert_label text CHECK (expert_label IS NULL OR char_length(expert_label) <= 80),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'live', 'ended', 'cancelled')),
  recording_allowed boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '4 hours'),
  technician_joined_at timestamptz,
  expert_joined_at timestamptz,
  expert_name text CHECK (expert_name IS NULL OR char_length(expert_name) <= 60),
  expert_user_id uuid,
  expert_consented_at timestamptz,
  last_heartbeat_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  ended_by text CHECK (ended_by IS NULL OR ended_by IN ('technician', 'manager')),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_sessions_job ON public.video_sessions (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_sessions_user ON public.video_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.video_session_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES public.video_sessions(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE CHECK (char_length(storage_path) <= 300),
  mime text NOT NULL CHECK (mime IN ('video/webm', 'video/mp4')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 3600),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid NOT NULL,
  recorded_by_name text,
  consent jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(consent) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_clips_session ON public.video_session_clips (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_video_clips_job ON public.video_session_clips (job_id, created_at DESC);

ALTER TABLE public.video_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_session_clips ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 2. RLS (writes to clips and every state change go through RPCs)
-- =============================================================
DROP POLICY IF EXISTS "video_sessions_select" ON public.video_sessions;
CREATE POLICY "video_sessions_select" ON public.video_sessions FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = video_sessions.job_id)
  );

DROP POLICY IF EXISTS "video_sessions_insert" ON public.video_sessions;
CREATE POLICY "video_sessions_insert" ON public.video_sessions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = video_sessions.job_id)
  );

DROP POLICY IF EXISTS "video_clips_select" ON public.video_session_clips;
CREATE POLICY "video_clips_select" ON public.video_session_clips FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = video_session_clips.job_id)
  );

-- =============================================================
-- 3. INSERT SANITISER: the client cannot choose the token, status or timestamps
-- =============================================================
CREATE OR REPLACE FUNCTION public.video_sessions_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.status := 'waiting';
  NEW.join_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  NEW.technician_joined_at := NULL;
  NEW.expert_joined_at := NULL;
  NEW.expert_name := NULL;
  NEW.expert_user_id := NULL;
  NEW.expert_consented_at := NULL;
  NEW.last_heartbeat_at := NULL;
  NEW.started_at := NULL;
  NEW.ended_at := NULL;
  NEW.ended_by := NULL;
  NEW.duration_seconds := NULL;
  NEW.title := btrim(NEW.title);
  NEW.expires_at := LEAST(
    GREATEST(COALESCE(NEW.expires_at, now() + interval '4 hours'), now() + interval '5 minutes'),
    now() + interval '24 hours'
  );
  NEW.created_by_name := left(COALESCE(
    (SELECT tm.member_name FROM public.team_members tm WHERE tm.user_id = auth.uid() AND tm.member_name IS NOT NULL LIMIT 1),
    (SELECT p.full_name FROM public.profiles p WHERE p.id = auth.uid()),
    'Technician'
  ), 80);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.video_sessions_before_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_video_sessions_before_insert ON public.video_sessions;
CREATE TRIGGER trg_video_sessions_before_insert
  BEFORE INSERT ON public.video_sessions
  FOR EACH ROW EXECUTE FUNCTION public.video_sessions_before_insert();

-- =============================================================
-- 4. EFFECTIVE STATUS (expiry + abandoned-call detection, no cron needed)
-- =============================================================
CREATE OR REPLACE FUNCTION public.video_session_effective_status(s public.video_sessions)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN s.status IN ('ended', 'cancelled') THEN s.status
    WHEN s.status = 'waiting' AND s.expires_at < now() THEN 'expired'
    WHEN s.status = 'live'
      AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) < now() - interval '90 seconds' THEN 'ended'
    ELSE s.status
  END;
$$;

REVOKE ALL ON FUNCTION public.video_session_effective_status(public.video_sessions) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. PUBLIC (TOKEN) RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_video_session_public(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.video_sessions;
  v_company text;
  v_creator boolean;
  v_member boolean;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO s FROM public.video_sessions WHERE join_token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT company_name INTO v_company FROM public.profiles WHERE id = s.user_id;
  v_creator := auth.uid() IS NOT NULL AND auth.uid() = s.created_by;
  v_member := auth.uid() IS NOT NULL AND s.user_id = public.get_account_owner_id();

  RETURN jsonb_build_object(
    'id', s.id,
    'title', s.title,
    'status', public.video_session_effective_status(s),
    'expires_at', s.expires_at,
    'business_name', v_company,
    'technician_name', s.created_by_name,
    'expert_label', s.expert_label,
    'recording_allowed', s.recording_allowed,
    'expert_consented', s.expert_consented_at IS NOT NULL,
    'role', CASE WHEN v_creator THEN 'technician' ELSE 'expert' END,
    'owner_id', CASE WHEN v_creator THEN s.user_id ELSE NULL END,
    'job_id', CASE WHEN v_member THEN s.job_id ELSE NULL END,
    'started_at', s.started_at,
    'ended_at', s.ended_at,
    'duration_seconds', s.duration_seconds
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.join_video_session(
  p_token text,
  p_display_name text DEFAULT NULL,
  p_consent_recording boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.video_sessions;
  v_eff text;
  v_creator boolean;
  v_name text;
  v_now timestamptz := now();
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  SELECT * INTO s FROM public.video_sessions WHERE join_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  v_eff := public.video_session_effective_status(s);
  IF v_eff = 'expired' THEN
    RAISE EXCEPTION 'session_expired';
  ELSIF v_eff IN ('ended', 'cancelled') THEN
    RAISE EXCEPTION 'session_ended';
  END IF;

  v_creator := auth.uid() IS NOT NULL AND auth.uid() = s.created_by;

  IF v_creator THEN
    UPDATE public.video_sessions
       SET technician_joined_at = COALESCE(technician_joined_at, v_now),
           last_heartbeat_at = v_now
     WHERE id = s.id;
  ELSE
    v_name := btrim(COALESCE(p_display_name, ''));
    IF char_length(v_name) < 2 OR char_length(v_name) > 60 THEN
      RAISE EXCEPTION 'name_required';
    END IF;
    UPDATE public.video_sessions
       SET expert_joined_at = COALESCE(expert_joined_at, v_now),
           expert_name = v_name,
           expert_user_id = auth.uid(),
           expert_consented_at = CASE
             WHEN recording_allowed AND COALESCE(p_consent_recording, false) THEN COALESCE(expert_consented_at, v_now)
             ELSE NULL
           END,
           last_heartbeat_at = v_now
     WHERE id = s.id;
  END IF;

  SELECT * INTO s FROM public.video_sessions WHERE id = s.id;

  IF s.status = 'waiting' AND s.technician_joined_at IS NOT NULL AND s.expert_joined_at IS NOT NULL THEN
    UPDATE public.video_sessions SET status = 'live', started_at = v_now WHERE id = s.id RETURNING * INTO s;
    PERFORM public.append_activity_event(
      p_aggregate_type := 'job',
      p_aggregate_id := s.job_id,
      p_event_type := 'job.video_session_started',
      p_event_data := jsonb_build_object('session_id', s.id, 'title', s.title, 'expert_name', s.expert_name),
      p_actor_type := 'system',
      p_user_id := s.user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'session_id', s.id,
    'role', CASE WHEN v_creator THEN 'technician' ELSE 'expert' END,
    'status', public.video_session_effective_status(s),
    'recording_allowed', s.recording_allowed,
    'expert_consented', s.expert_consented_at IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.video_session_heartbeat(p_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.video_sessions;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN 'not_found';
  END IF;

  UPDATE public.video_sessions
     SET last_heartbeat_at = now()
   WHERE join_token = p_token AND status IN ('waiting', 'live')
   RETURNING * INTO s;

  IF NOT FOUND THEN
    SELECT * INTO s FROM public.video_sessions WHERE join_token = p_token;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
  END IF;

  RETURN public.video_session_effective_status(s);
END;
$$;

REVOKE ALL ON FUNCTION public.get_video_session_public(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_video_session(text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.video_session_heartbeat(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_video_session_public(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_video_session(text, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_session_heartbeat(text) TO anon, authenticated;

-- =============================================================
-- 6. STAFF RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.end_video_session(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.video_sessions;
  v_by text;
  v_now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  SELECT * INTO s FROM public.video_sessions WHERE join_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;

  IF auth.uid() = s.created_by THEN
    v_by := 'technician';
  ELSIF s.user_id = public.get_account_owner_id() AND public.video_sessions_can_manage() THEN
    v_by := 'manager';
  ELSE
    RAISE EXCEPTION 'not_allowed';
  END IF;

  IF s.status IN ('ended', 'cancelled') THEN
    RETURN jsonb_build_object('status', s.status, 'duration_seconds', s.duration_seconds);
  END IF;

  IF s.status = 'live' THEN
    UPDATE public.video_sessions
       SET status = 'ended',
           ended_at = v_now,
           ended_by = v_by,
           duration_seconds = GREATEST(0, floor(extract(epoch FROM (v_now - COALESCE(started_at, v_now))))::integer)
     WHERE id = s.id
     RETURNING * INTO s;
    PERFORM public.append_activity_event(
      p_aggregate_type := 'job',
      p_aggregate_id := s.job_id,
      p_event_type := 'job.video_session_ended',
      p_event_data := jsonb_build_object('session_id', s.id, 'title', s.title, 'duration_seconds', s.duration_seconds, 'ended_by', v_by),
      p_actor_type := 'user',
      p_user_id := s.user_id
    );
  ELSE
    UPDATE public.video_sessions
       SET status = 'cancelled', ended_at = v_now, ended_by = v_by, duration_seconds = 0
     WHERE id = s.id
     RETURNING * INTO s;
  END IF;

  RETURN jsonb_build_object('status', s.status, 'duration_seconds', s.duration_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_video_clip(
  p_session_id uuid,
  p_storage_path text,
  p_mime text,
  p_size_bytes bigint,
  p_duration_seconds integer,
  p_sha256 text,
  p_technician_confirmed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.video_sessions;
  c public.video_session_clips;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT * INTO s FROM public.video_sessions
   WHERE id = p_session_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_not_found';
  END IF;
  IF s.created_by <> auth.uid() THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;
  IF s.status = 'cancelled' THEN
    RAISE EXCEPTION 'session_ended';
  END IF;
  IF NOT s.recording_allowed THEN
    RAISE EXCEPTION 'recording_not_allowed';
  END IF;
  IF s.expert_consented_at IS NULL THEN
    RAISE EXCEPTION 'consent_missing';
  END IF;
  IF NOT COALESCE(p_technician_confirmed, false) THEN
    RAISE EXCEPTION 'confirmation_required';
  END IF;
  IF p_mime NOT IN ('video/webm', 'video/mp4')
     OR p_size_bytes IS NULL OR p_size_bytes < 1 OR p_size_bytes > 104857600
     OR p_duration_seconds IS NULL OR p_duration_seconds < 1 OR p_duration_seconds > 3600
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_clip';
  END IF;
  IF p_storage_path IS NULL
     OR p_storage_path !~ ('^' || s.user_id::text || '/' || s.id::text || '/[0-9a-f-]{36}\.(webm|mp4)$') THEN
    RAISE EXCEPTION 'invalid_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'video-session-clips' AND o.name = p_storage_path) THEN
    RAISE EXCEPTION 'upload_missing';
  END IF;

  SELECT left(COALESCE(tm.member_name, pr.full_name, 'Technician'), 80) INTO v_name
    FROM (SELECT 1) x
    LEFT JOIN public.team_members tm ON tm.user_id = auth.uid()
    LEFT JOIN public.profiles pr ON pr.id = auth.uid()
   LIMIT 1;

  INSERT INTO public.video_session_clips
    (user_id, session_id, job_id, storage_path, mime, size_bytes, duration_seconds, sha256, recorded_by, recorded_by_name, consent)
  VALUES
    (s.user_id, s.id, s.job_id, p_storage_path, p_mime, p_size_bytes, p_duration_seconds, p_sha256, auth.uid(), v_name,
     jsonb_build_object(
       'expert_name', s.expert_name,
       'expert_consented_at', s.expert_consented_at,
       'technician_confirmed_customer_notice', true,
       'confirmed_at', now()
     ))
  RETURNING * INTO c;

  PERFORM public.append_activity_event(
    p_aggregate_type := 'job',
    p_aggregate_id := s.job_id,
    p_event_type := 'job.video_clip_added',
    p_event_data := jsonb_build_object('session_id', s.id, 'clip_id', c.id, 'title', s.title, 'duration_seconds', c.duration_seconds),
    p_actor_type := 'user',
    p_user_id := s.user_id
  );

  RETURN to_jsonb(c);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_video_clip(p_clip_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.video_session_clips;
BEGIN
  IF auth.uid() IS NULL OR NOT public.video_sessions_can_manage() THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  DELETE FROM public.video_session_clips
   WHERE id = p_clip_id AND user_id = public.get_account_owner_id()
   RETURNING * INTO c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clip_not_found';
  END IF;

  PERFORM public.append_activity_event(
    p_aggregate_type := 'job',
    p_aggregate_id := c.job_id,
    p_event_type := 'job.video_clip_removed',
    p_event_data := jsonb_build_object('session_id', c.session_id, 'clip_id', c.id),
    p_actor_type := 'user',
    p_user_id := c.user_id
  );

  RETURN c.storage_path;
END;
$$;

REVOKE ALL ON FUNCTION public.end_video_session(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_video_clip(uuid, text, text, bigint, integer, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_video_clip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_video_session(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_video_clip(uuid, text, text, bigint, integer, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_video_clip(uuid) TO authenticated;

-- =============================================================
-- 7. STORAGE (private; <owner_id>/<session_id>/<uuid>.<ext>)
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('video-session-clips', 'video-session-clips', false, 104857600, ARRAY['video/webm', 'video/mp4'])
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "video_clips_storage_select" ON storage.objects;
CREATE POLICY "video_clips_storage_select" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'video-session-clips'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND EXISTS (SELECT 1 FROM public.video_sessions s WHERE s.id::text = (storage.foldername(name))[2])
  );

DROP POLICY IF EXISTS "video_clips_storage_insert" ON storage.objects;
CREATE POLICY "video_clips_storage_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'video-session-clips'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND EXISTS (
      SELECT 1 FROM public.video_sessions s
      WHERE s.id::text = (storage.foldername(name))[2] AND s.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "video_clips_storage_delete" ON storage.objects;
CREATE POLICY "video_clips_storage_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'video-session-clips'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.video_sessions_can_manage()
  );

-- =============================================================
-- 8. REALTIME (job panel + sessions page update live)
-- =============================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.video_sessions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.video_session_clips;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

COMMENT ON TABLE public.video_sessions IS 'Live WebRTC video sessions between a technician and a remote expert, joined by an unguessable token.';
COMMENT ON TABLE public.video_session_clips IS 'Clips recorded during a video session (consent-gated); the file lives in the private video-session-clips bucket.';
