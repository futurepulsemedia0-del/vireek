-- =============================================================
-- Remote Expert Assist (v1: photo + voice-note + on-image
-- annotation + realtime text thread — not live video; see notes).
-- =============================================================

-- 1) Private media bucket (photos + short voice notes) ----------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expert-assist-media',
  'expert-assist-media',
  false,
  15728640, -- 15 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "users_manage_own_expert_assist_media" ON storage.objects;
CREATE POLICY "users_manage_own_expert_assist_media"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'expert-assist-media' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'expert-assist-media' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 2) The request itself -------------------------------------------------------
CREATE TABLE IF NOT EXISTS expert_assist_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, -- account owner, for RLS scoping (= jobs.user_id)
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  requested_by uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  assigned_expert_id uuid REFERENCES team_members(id) ON DELETE SET NULL,

  error_code text,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, -- equipment/diagnosis/parts, captured client-side from the Job Brief at request time

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'resolved', 'cancelled')),
  resolution_summary text,

  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ear_user_status ON expert_assist_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ear_job_id ON expert_assist_requests(job_id);

ALTER TABLE expert_assist_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_expert_assist_requests" ON expert_assist_requests;
CREATE POLICY "select_expert_assist_requests" ON expert_assist_requests FOR SELECT TO authenticated
USING (
  user_id = public.get_account_owner_id()
  AND (
    requested_by = public.get_my_team_member_id()
    OR assigned_expert_id = public.get_my_team_member_id()
    OR status = 'open'
  )
);

DROP POLICY IF EXISTS "insert_expert_assist_requests" ON expert_assist_requests;
CREATE POLICY "insert_expert_assist_requests" ON expert_assist_requests FOR INSERT TO authenticated
WITH CHECK (user_id = public.get_account_owner_id() AND requested_by = public.get_my_team_member_id());

-- 3) The thread (photos, voice notes, text, annotations) ---------------------
CREATE TABLE IF NOT EXISTS expert_assist_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES expert_assist_requests(id) ON DELETE CASCADE,
  sender_team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('text', 'photo', 'audio', 'annotation')),
  body text,
  media_path text, -- storage path in expert-assist-media, for 'photo'/'audio'
  -- for kind='annotation': { target_message_id, points: [{x, y, type: 'circle'|'arrow'|'label', label?}] }
  annotation_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eam_request_id ON expert_assist_messages(request_id, created_at);

ALTER TABLE expert_assist_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_expert_assist_messages" ON expert_assist_messages;
CREATE POLICY "select_expert_assist_messages" ON expert_assist_messages FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM expert_assist_requests r
    WHERE r.id = request_id
      AND r.user_id = public.get_account_owner_id()
      AND (
        r.requested_by = public.get_my_team_member_id()
        OR r.assigned_expert_id = public.get_my_team_member_id()
        OR r.status = 'open'
      )
  )
);

DROP POLICY IF EXISTS "insert_expert_assist_messages" ON expert_assist_messages;
CREATE POLICY "insert_expert_assist_messages" ON expert_assist_messages FOR INSERT TO authenticated
WITH CHECK (
  sender_team_member_id = public.get_my_team_member_id()
  AND EXISTS (
    SELECT 1 FROM expert_assist_requests r
    WHERE r.id = request_id
      AND r.user_id = public.get_account_owner_id()
      AND (r.requested_by = public.get_my_team_member_id() OR r.assigned_expert_id = public.get_my_team_member_id())
  )
);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE expert_assist_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE expert_assist_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- 4) RPCs ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_expert_assist_request(
  p_job_id uuid, p_error_code text DEFAULT NULL,
  p_context_snapshot jsonb DEFAULT '{}'::jsonb, p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner_id uuid;
  v_my_tm_id uuid;
  v_request_id uuid;
BEGIN
  v_owner_id := public.get_account_owner_id();
  v_my_tm_id := public.get_my_team_member_id();

  IF v_my_tm_id IS NULL THEN
    RAISE EXCEPTION 'not_a_team_member';
  END IF;

  INSERT INTO expert_assist_requests (user_id, job_id, requested_by, error_code, context_snapshot)
  VALUES (v_owner_id, p_job_id, v_my_tm_id, p_error_code, p_context_snapshot)
  RETURNING id INTO v_request_id;

  IF p_note IS NOT NULL AND p_note <> '' THEN
    INSERT INTO expert_assist_messages (request_id, sender_team_member_id, kind, body)
    VALUES (v_request_id, v_my_tm_id, 'text', p_note);
  END IF;

  RETURN v_request_id;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_expert_assist_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_my_tm_id uuid; v_updated int;
BEGIN
  v_my_tm_id := public.get_my_team_member_id();
  IF v_my_tm_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_a_team_member'); END IF;

  UPDATE expert_assist_requests
  SET status = 'claimed', assigned_expert_id = v_my_tm_id, claimed_at = now()
  WHERE id = p_request_id AND status = 'open' AND user_id = public.get_account_owner_id();

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'already_claimed'); END IF;
  RETURN jsonb_build_object('success', true);
END; $$;

CREATE OR REPLACE FUNCTION public.add_expert_assist_message(
  p_request_id uuid, p_kind text, p_body text DEFAULT NULL,
  p_media_path text DEFAULT NULL, p_annotation_data jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_my_tm_id uuid; v_message_id uuid; v_is_participant boolean;
BEGIN
  IF p_kind NOT IN ('text', 'photo', 'audio', 'annotation') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;

  v_my_tm_id := public.get_my_team_member_id();

  SELECT EXISTS (
    SELECT 1 FROM expert_assist_requests r
    WHERE r.id = p_request_id
      AND r.user_id = public.get_account_owner_id()
      AND (r.requested_by = v_my_tm_id OR r.assigned_expert_id = v_my_tm_id)
  ) INTO v_is_participant;

  IF NOT v_is_participant THEN RAISE EXCEPTION 'forbidden'; END IF;

  INSERT INTO expert_assist_messages (request_id, sender_team_member_id, kind, body, media_path, annotation_data)
  VALUES (p_request_id, v_my_tm_id, p_kind, p_body, p_media_path, p_annotation_data)
  RETURNING id INTO v_message_id;

  RETURN v_message_id;
END; $$;

-- publish_to_knowledge reuses your existing knowledge_articles table/search
-- (source='manual' so it doesn't need its own CHECK-constraint value;
-- category='expert_assist' + keywords make it findable and filterable).
CREATE OR REPLACE FUNCTION public.resolve_expert_assist_request(
  p_request_id uuid, p_summary text, p_publish_to_knowledge boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_my_tm_id uuid;
  v_request expert_assist_requests%ROWTYPE;
  v_job_service_type text;
  v_thread_body text;
BEGIN
  v_my_tm_id := public.get_my_team_member_id();
  SELECT * INTO v_request FROM expert_assist_requests WHERE id = p_request_id;

  IF v_request.id IS NULL OR v_request.assigned_expert_id IS DISTINCT FROM v_my_tm_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  UPDATE expert_assist_requests
  SET status = 'resolved', resolved_at = now(), resolution_summary = p_summary
  WHERE id = p_request_id;

  IF p_publish_to_knowledge THEN
    SELECT service_type INTO v_job_service_type FROM jobs WHERE id = v_request.job_id;

    SELECT string_agg(coalesce(body, '[' || kind || ']'), E'\n' ORDER BY created_at)
    INTO v_thread_body
    FROM expert_assist_messages WHERE request_id = p_request_id AND kind IN ('text', 'annotation');

    INSERT INTO knowledge_articles (user_id, title, summary, body, category, keywords, audience, status, source)
    VALUES (
      v_request.user_id,
      coalesce(v_job_service_type, 'Field issue') || coalesce(' — ' || v_request.error_code, ''),
      left(p_summary, 200),
      coalesce(v_thread_body, '') || E'\n\nResolution: ' || p_summary,
      'expert_assist',
      ARRAY_REMOVE(ARRAY[v_request.error_code, v_job_service_type], NULL),
      'team',
      'published',
      'manual'
    );
  END IF;

  RETURN jsonb_build_object('success', true);
END; $$;

GRANT EXECUTE ON FUNCTION public.create_expert_assist_request(uuid, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_expert_assist_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_expert_assist_message(uuid, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_expert_assist_request(uuid, text, boolean) TO authenticated;
