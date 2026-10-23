/*
  # Video Quotes, Video Messages & Live Video Estimates

  A technician records a short explanation of their findings and attaches it
  to a quote. The customer watches it on the existing /quote/:token page and
  approves through the normal accept flow; the technician sees how much was
  watched and whether the customer acknowledged it. Optionally the technician
  opens a live video estimate session (Daily.co room) the customer can join
  from the same quote link.

  Tenancy  : user_id = get_account_owner_id() (owner + team share the data).
  Access   : same rule as the quote workspace - owner, or a team member with
             can_view_billing (quote_workspace_caller_can_view()).
  Storage  : PRIVATE bucket `quote-videos`, path <owner_id>/<quote_id>/<file>.
             No public URLs. Customers only ever get short-lived signed URLs
             from the `quote-video-public` edge function (service role), which
             matches on the unguessable quote_token.
  Writes   : clients have NO insert/update/delete policy on any table here.
             Everything goes through SECURITY DEFINER functions, so engagement
             history and the retention clock cannot be forged or erased.
  Retention: per-account `retention_days` (default 365). A video expires
             retention_days after the LATER of (upload, quote response). The
             `quote-video-retention-sweep` edge function physically deletes the
             file, honours legal holds, and keeps a metadata tombstone row.
  Additive : new objects only. No existing table, function or policy changes.
*/

-- =============================================================
-- 1. PRIVATE STORAGE BUCKET
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'quote-videos',
  'quote-videos',
  false,
  104857600, -- 100 MB (also bounded by your Supabase plan's global upload limit)
  ARRAY['video/mp4', 'video/webm', 'video/quicktime']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

-- Account members may upload + preview inside their own account folder.
DROP POLICY IF EXISTS "quote_videos_insert_account" ON storage.objects;
CREATE POLICY "quote_videos_insert_account" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'quote-videos'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

DROP POLICY IF EXISTS "quote_videos_select_account" ON storage.objects;
CREATE POLICY "quote_videos_select_account" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'quote-videos'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

-- =============================================================
-- 2. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS quote_video_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 1825),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  -- SET NULL (not CASCADE): deleting a quote must not orphan the file; the
  -- sweep treats quote_id IS NULL as due for deletion.
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  title text NOT NULL DEFAULT 'Explanation of findings'
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  storage_path text NOT NULL UNIQUE CHECK (char_length(storage_path) <= 300),
  mime_type text NOT NULL CHECK (mime_type IN ('video/mp4', 'video/webm', 'video/quicktime')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 600),

  shared boolean NOT NULL DEFAULT false,      -- visible to the customer
  shared_at timestamptz,

  view_count integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  max_progress smallint NOT NULL DEFAULT 0 CHECK (max_progress BETWEEN 0 AND 100),
  completed_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_name text CHECK (acknowledged_name IS NULL OR char_length(acknowledged_name) <= 120),

  deleted_at timestamptz,                     -- user removed it: hidden immediately
  purged_at timestamptz,                      -- file physically deleted (tombstone row stays)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_videos_quote
  ON quote_videos(quote_id, created_at DESC) WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quote_videos_user_created ON quote_videos(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_videos_purge_scan
  ON quote_videos(created_at) WHERE purged_at IS NULL;

CREATE TABLE IF NOT EXISTS quote_video_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES quote_videos(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('viewed', 'progress', 'completed', 'acknowledged')),
  progress smallint CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_video_events_video ON quote_video_events(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_video_events_user ON quote_video_events(user_id, created_at DESC);

-- Live (Daily.co) estimate sessions. Written only by the edge function.
CREATE TABLE IF NOT EXISTS quote_video_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  created_by uuid,
  room_name text NOT NULL UNIQUE,
  room_url text NOT NULL,
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  customer_join_count integer NOT NULL DEFAULT 0,
  customer_first_joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One live session per quote at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_video_sessions_one_live
  ON quote_video_sessions(quote_id) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_quote_video_sessions_user ON quote_video_sessions(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_quote_videos_updated_at ON quote_videos;
CREATE TRIGGER trg_quote_videos_updated_at
  BEFORE UPDATE ON quote_videos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 3. RLS: account-scoped READ only
-- =============================================================
ALTER TABLE quote_video_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_video_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_video_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_quote_video_settings" ON quote_video_settings;
CREATE POLICY "select_account_quote_video_settings" ON quote_video_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_account_quote_videos" ON quote_videos;
CREATE POLICY "select_account_quote_videos" ON quote_videos FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

DROP POLICY IF EXISTS "select_account_quote_video_events" ON quote_video_events;
CREATE POLICY "select_account_quote_video_events" ON quote_video_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

DROP POLICY IF EXISTS "select_account_quote_video_sessions" ON quote_video_sessions;
CREATE POLICY "select_account_quote_video_sessions" ON quote_video_sessions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

-- A client may only remove an upload that was never registered as a quote
-- video (failed/abandoned upload). Registered videos are deleted by the sweep.
DROP POLICY IF EXISTS "quote_videos_delete_unregistered" ON storage.objects;
CREATE POLICY "quote_videos_delete_unregistered" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'quote-videos'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND NOT EXISTS (SELECT 1 FROM public.quote_videos v WHERE v.storage_path = name)
  );

-- =============================================================
-- 4. AUTHORISATION HELPER (also called by the live-session edge function)
-- =============================================================
-- Returns the account owner id when the caller may manage this quote's video,
-- otherwise NULL. Pass NULL to skip the per-quote ownership check.
CREATE OR REPLACE FUNCTION public.quote_video_caller_owner(p_quote_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN NOT public.quote_workspace_caller_can_view() THEN NULL
    WHEN p_quote_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = p_quote_id AND q.user_id = public.get_account_owner_id()
    ) THEN NULL
    ELSE public.get_account_owner_id()
  END;
$$;

REVOKE ALL ON FUNCTION public.quote_video_caller_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_video_caller_owner(uuid) TO authenticated;

-- =============================================================
-- 5. TECHNICIAN RPCs (authenticated)
-- =============================================================
-- Registers an uploaded file as a quote video. Verifies the object really
-- exists in the bucket, lives in this account + quote folder, and caps videos
-- per quote. Error messages are stable codes the client maps to copy.
CREATE OR REPLACE FUNCTION public.create_quote_video(
  p_quote_id uuid,
  p_path text,
  p_title text,
  p_note text,
  p_mime text,
  p_size bigint,
  p_duration integer
)
RETURNS quote_videos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_owner uuid;
  v_quote quotes%ROWTYPE;
  v_size bigint;
  v_row quote_videos;
BEGIN
  v_owner := public.quote_video_caller_owner(p_quote_id);
  IF v_owner IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = v_owner FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_quote.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'QUOTE_CLOSED'; END IF;

  IF p_path IS NULL
     OR p_path !~ ('^' || v_owner::text || '/' || p_quote_id::text || '/[A-Za-z0-9._-]{1,120}$') THEN
    RAISE EXCEPTION 'INVALID_PATH';
  END IF;

  SELECT COALESCE((o.metadata ->> 'size')::bigint, p_size) INTO v_size
  FROM storage.objects o
  WHERE o.bucket_id = 'quote-videos' AND o.name = p_path;
  IF NOT FOUND THEN RAISE EXCEPTION 'UPLOAD_MISSING'; END IF;
  IF v_size IS NULL OR v_size < 1 OR v_size > 104857600 THEN RAISE EXCEPTION 'INVALID_SIZE'; END IF;

  IF (SELECT count(*) FROM quote_videos
       WHERE quote_id = p_quote_id AND deleted_at IS NULL AND purged_at IS NULL) >= 5 THEN
    RAISE EXCEPTION 'QUOTE_VIDEO_LIMIT';
  END IF;

  INSERT INTO quote_videos (user_id, quote_id, created_by, title, note, storage_path, mime_type, size_bytes, duration_seconds)
  VALUES (
    v_owner, p_quote_id, auth.uid(),
    COALESCE(NULLIF(btrim(p_title), ''), 'Explanation of findings'),
    NULLIF(btrim(COALESCE(p_note, '')), ''),
    p_path, p_mime, v_size,
    CASE WHEN p_duration BETWEEN 1 AND 600 THEN p_duration ELSE NULL END
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_quote_video_shared(p_id uuid, p_shared boolean)
RETURNS quote_videos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row quote_videos;
BEGIN
  SELECT * INTO v_row FROM quote_videos
  WHERE id = p_id AND deleted_at IS NULL AND purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF public.quote_video_caller_owner(NULL) IS DISTINCT FROM v_row.user_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  UPDATE quote_videos
  SET shared = COALESCE(p_shared, false),
      shared_at = CASE WHEN COALESCE(p_shared, false) THEN COALESCE(shared_at, now()) ELSE shared_at END
  WHERE id = p_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Soft delete: the customer loses access immediately; the file itself is
-- removed by the next retention sweep (unless a legal hold applies).
CREATE OR REPLACE FUNCTION public.delete_quote_video(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row quote_videos;
BEGIN
  SELECT * INTO v_row FROM quote_videos
  WHERE id = p_id AND deleted_at IS NULL AND purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF public.quote_video_caller_owner(NULL) IS DISTINCT FROM v_row.user_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  UPDATE quote_videos SET deleted_at = now(), shared = false WHERE id = p_id;
END;
$$;

-- Owner-only: how long videos are kept (days after the later of upload / quote response).
CREATE OR REPLACE FUNCTION public.set_quote_video_retention(p_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_days IS NULL OR p_days < 30 OR p_days > 1825 THEN RAISE EXCEPTION 'INVALID_RETENTION'; END IF;

  INSERT INTO quote_video_settings (user_id, retention_days, updated_at)
  VALUES (auth.uid(), p_days, now())
  ON CONFLICT (user_id) DO UPDATE SET retention_days = EXCLUDED.retention_days, updated_at = now();
  RETURN p_days;
END;
$$;

REVOKE ALL ON FUNCTION public.create_quote_video(uuid, text, text, text, text, bigint, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_quote_video_shared(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_quote_video(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_quote_video_retention(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quote_video(uuid, text, text, text, text, bigint, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_quote_video_shared(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_quote_video(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_quote_video_retention(integer) TO authenticated;

-- =============================================================
-- 6. CUSTOMER RPCs (service_role only: called by quote-video-public)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_quote_videos_for_token(p_token uuid)
RETURNS TABLE (
  id uuid,
  title text,
  note text,
  storage_path text,
  mime_type text,
  duration_seconds integer,
  max_progress smallint,
  completed_at timestamptz,
  acknowledged_at timestamptz,
  quote_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id, v.title, v.note, v.storage_path, v.mime_type, v.duration_seconds,
         v.max_progress, v.completed_at, v.acknowledged_at, q.status
  FROM quotes q
  JOIN quote_videos v ON v.quote_id = q.id
  WHERE q.quote_token = p_token
    AND q.status <> 'draft'
    AND v.shared
    AND v.deleted_at IS NULL
    AND v.purged_at IS NULL
  ORDER BY v.created_at ASC
  LIMIT 5;
$$;

CREATE OR REPLACE FUNCTION public.record_quote_video_event(
  p_token uuid,
  p_video_id uuid,
  p_event text,
  p_progress integer DEFAULT NULL,
  p_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r quote_videos%ROWTYPE;
  v_status text;
  v_progress integer;
  v_prev integer;
  v_name text;
BEGIN
  IF p_event NOT IN ('viewed', 'progress', 'completed', 'acknowledged') THEN
    RAISE EXCEPTION 'INVALID_EVENT';
  END IF;

  SELECT qv.* INTO r
  FROM quote_videos qv
  JOIN quotes q ON q.id = qv.quote_id
  WHERE qv.id = p_video_id
    AND q.quote_token = p_token
    AND q.status <> 'draft'
    AND qv.shared
    AND qv.deleted_at IS NULL
    AND qv.purged_at IS NULL
  FOR UPDATE OF qv;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;

  SELECT status INTO v_status FROM quotes WHERE id = r.quote_id;

  IF p_event = 'viewed' THEN
    -- Throttle: reloads / replays inside a minute count once.
    IF r.last_viewed_at IS NOT NULL AND r.last_viewed_at > now() - interval '60 seconds' THEN
      RETURN jsonb_build_object('ok', true, 'throttled', true);
    END IF;
    UPDATE quote_videos
    SET view_count = view_count + 1,
        last_viewed_at = now(),
        first_viewed_at = COALESCE(first_viewed_at, now())
    WHERE id = r.id;
    INSERT INTO quote_video_events (video_id, quote_id, user_id, event_type)
    VALUES (r.id, r.quote_id, r.user_id, 'viewed');

  ELSIF p_event IN ('progress', 'completed') THEN
    v_progress := CASE WHEN p_event = 'completed' THEN 100
                       ELSE LEAST(GREATEST(COALESCE(p_progress, 0), 0), 100) END;
    v_prev := r.max_progress;
    IF v_progress > v_prev THEN
      UPDATE quote_videos
      SET max_progress = v_progress,
          completed_at = CASE WHEN v_progress >= 90 THEN COALESCE(completed_at, now()) ELSE completed_at END
      WHERE id = r.id;
      -- One event per 25% milestone, one 'completed' when 90% is first crossed.
      IF (v_progress / 25) > (v_prev / 25) AND v_progress < 90 THEN
        INSERT INTO quote_video_events (video_id, quote_id, user_id, event_type, progress)
        VALUES (r.id, r.quote_id, r.user_id, 'progress', (v_progress / 25) * 25);
      END IF;
      IF v_progress >= 90 AND r.completed_at IS NULL THEN
        INSERT INTO quote_video_events (video_id, quote_id, user_id, event_type, progress)
        VALUES (r.id, r.quote_id, r.user_id, 'completed', v_progress);
      END IF;
    END IF;

  ELSE -- acknowledged
    IF v_status <> 'sent' THEN RAISE EXCEPTION 'QUOTE_NOT_OPEN'; END IF;
    IF r.completed_at IS NULL THEN RAISE EXCEPTION 'WATCH_REQUIRED'; END IF;
    v_name := left(btrim(COALESCE(p_name, '')), 120);
    IF v_name = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
    IF r.acknowledged_at IS NULL THEN
      UPDATE quote_videos SET acknowledged_at = now(), acknowledged_name = v_name WHERE id = r.id;
      INSERT INTO quote_video_events (video_id, quote_id, user_id, event_type)
      VALUES (r.id, r.quote_id, r.user_id, 'acknowledged');
    END IF;
  END IF;

  SELECT * INTO r FROM quote_videos WHERE id = p_video_id;
  RETURN jsonb_build_object(
    'ok', true,
    'max_progress', r.max_progress,
    'completed', r.completed_at IS NOT NULL,
    'acknowledged', r.acknowledged_at IS NOT NULL
  );
END;
$$;

-- =============================================================
-- 7. RETENTION SWEEP RPCs (service_role only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.quote_videos_due_for_purge(p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, user_id uuid, storage_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id, v.user_id, v.storage_path
  FROM quote_videos v
  LEFT JOIN quotes q ON q.id = v.quote_id
  LEFT JOIN quote_video_settings s ON s.user_id = v.user_id
  WHERE v.purged_at IS NULL
    AND (
      v.deleted_at IS NOT NULL
      OR v.quote_id IS NULL
      OR GREATEST(v.created_at, COALESCE(q.responded_at, v.created_at))
           + make_interval(days => COALESCE(s.retention_days, 365)) < now()
    )
    AND NOT public.has_active_legal_hold(v.user_id, 'quote_videos')
  ORDER BY v.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;

CREATE OR REPLACE FUNCTION public.mark_quote_videos_purged(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE quote_videos
  SET purged_at = now(), shared = false, deleted_at = COALESCE(deleted_at, now())
  WHERE id = ANY (p_ids) AND purged_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Uploaded but never registered (abandoned) files older than a day.
CREATE OR REPLACE FUNCTION public.quote_video_orphan_paths(p_limit integer DEFAULT 200)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'quote-videos'
    AND o.created_at < now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM quote_videos v WHERE v.storage_path = o.name)
  ORDER BY o.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.get_quote_videos_for_token(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_quote_video_event(uuid, uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quote_videos_due_for_purge(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_quote_videos_purged(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quote_video_orphan_paths(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_quote_videos_for_token(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quote_video_event(uuid, uuid, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.quote_videos_due_for_purge(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_quote_videos_purged(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.quote_video_orphan_paths(integer) TO service_role;
