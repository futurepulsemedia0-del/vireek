-- =============================================================
-- Tech <-> Office per-job message thread
-- text + photos + voice notes, realtime, RLS-scoped.
-- Storage path convention: {account_owner_id}/{job_id}/{file}
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_office_member()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = auth.uid()) THEN
      EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.user_id = auth.uid()
          AND tm.invite_status = 'active'
          AND tm.role <> 'technician'
          AND (
            tm.role IN ('admin', 'manager', 'dispatcher')
            OR COALESCE((tm.permissions ->> 'can_view_all_jobs')::boolean, false)
          )
      )
    ELSE EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
  END;
$$;

CREATE OR REPLACE FUNCTION public.can_access_job_thread(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = p_job_id
      AND j.user_id = public.get_account_owner_id()
      AND (
        public.is_office_member()
        OR (j.assigned_technician_id IS NOT NULL AND j.assigned_technician_id = public.get_my_team_member_id())
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_job_media_path(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner text; v_job text;
BEGIN
  v_owner := split_part(p_name, '/', 1);
  v_job := split_part(p_name, '/', 2);
  IF v_owner <> public.get_account_owner_id()::text THEN RETURN false; END IF;
  IF v_job !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  RETURN public.can_access_job_thread(v_job::uuid);
END; $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'job-message-media', 'job-message-media', false, 15728640,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/aac', 'audio/x-m4a']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "job_message_media_select" ON storage.objects;
CREATE POLICY "job_message_media_select" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'job-message-media' AND public.can_access_job_media_path(name));

DROP POLICY IF EXISTS "job_message_media_insert" ON storage.objects;
CREATE POLICY "job_message_media_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'job-message-media' AND public.can_access_job_media_path(name));

CREATE TABLE IF NOT EXISTS job_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL DEFAULT auth.uid(),
  sender_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  sender_role text NOT NULL DEFAULT 'technician' CHECK (sender_role IN ('technician', 'office')),
  kind text NOT NULL CHECK (kind IN ('text', 'photo', 'audio')),
  body text CHECK (body IS NULL OR char_length(body) <= 4000),
  media_path text,
  media_mime text,
  media_duration_ms integer CHECK (media_duration_ms IS NULL OR media_duration_ms BETWEEN 0 AND 600000),
  client_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_messages_payload CHECK (
    (kind = 'text' AND body IS NOT NULL AND btrim(body) <> '')
    OR (kind IN ('photo', 'audio') AND media_path IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_job_messages_job_created ON job_messages(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_messages_owner_created ON job_messages(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_messages_client ON job_messages(job_id, sender_user_id, client_id)
  WHERE client_id IS NOT NULL;

ALTER TABLE job_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_job_messages" ON job_messages;
CREATE POLICY "select_job_messages" ON job_messages FOR SELECT TO authenticated
USING (public.can_access_job_thread(job_id));

DROP POLICY IF EXISTS "insert_job_messages" ON job_messages;
CREATE POLICY "insert_job_messages" ON job_messages FOR INSERT TO authenticated
WITH CHECK (sender_user_id = auth.uid() AND public.can_access_job_thread(job_id));

CREATE OR REPLACE FUNCTION public.job_messages_before_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT j.user_id INTO NEW.user_id FROM jobs j WHERE j.id = NEW.job_id;
  NEW.sender_user_id := auth.uid();
  NEW.sender_team_member_id := public.get_my_team_member_id();
  NEW.sender_role := CASE WHEN public.is_office_member() THEN 'office' ELSE 'technician' END;
  IF NEW.media_path IS NOT NULL AND NEW.media_path NOT LIKE NEW.user_id::text || '/' || NEW.job_id::text || '/%' THEN
    RAISE EXCEPTION 'invalid_media_path';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_job_messages_before_insert ON job_messages;
CREATE TRIGGER trg_job_messages_before_insert BEFORE INSERT ON job_messages
FOR EACH ROW EXECUTE FUNCTION public.job_messages_before_insert();

CREATE OR REPLACE FUNCTION public.job_messages_after_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer text;
BEGIN
  IF NEW.sender_role = 'technician' THEN
    SELECT customer_name INTO v_customer FROM jobs WHERE id = NEW.job_id;
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      NEW.user_id, 'job_message', 'New field message',
      COALESCE(v_customer, 'A job') || ': ' ||
        CASE NEW.kind WHEN 'photo' THEN 'sent a photo' WHEN 'audio' THEN 'sent a voice note' ELSE left(NEW.body, 120) END,
      '/dashboard/field-messages?job=' || NEW.job_id::text
    );
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_job_messages_after_insert ON job_messages;
CREATE TRIGGER trg_job_messages_after_insert AFTER INSERT ON job_messages
FOR EACH ROW EXECUTE FUNCTION public.job_messages_after_insert();

CREATE TABLE IF NOT EXISTS job_message_reads (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id)
);

ALTER TABLE job_message_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_job_message_reads" ON job_message_reads;
CREATE POLICY "own_job_message_reads" ON job_message_reads FOR ALL TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid() AND public.can_access_job_thread(job_id));

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.get_job_thread_summaries(p_limit integer DEFAULT 100)
RETURNS TABLE (
  job_id uuid, customer_name text, address text, service_type text,
  job_status text, scheduled_datetime timestamptz,
  last_kind text, last_body text, last_sender_role text, last_message_at timestamptz,
  unread_count integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT auth.uid() AS uid, public.get_account_owner_id() AS owner_id,
           public.is_office_member() AS is_office, public.get_my_team_member_id() AS tm_id
  )
  SELECT j.id, j.customer_name, j.address, j.service_type, j.job_status, j.scheduled_datetime,
         lm.kind, lm.body, lm.sender_role, lm.created_at,
         COALESCE((
           SELECT count(*)::int FROM job_messages m
           WHERE m.job_id = j.id AND m.sender_user_id <> me.uid
             AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)
         ), 0)
  FROM me, jobs j
  LEFT JOIN job_message_reads r ON r.job_id = j.id AND r.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT m.kind, m.body, m.sender_role, m.created_at FROM job_messages m
    WHERE m.job_id = j.id ORDER BY m.created_at DESC LIMIT 1
  ) lm ON true
  WHERE j.user_id = me.owner_id
    AND (me.is_office OR (j.assigned_technician_id IS NOT NULL AND j.assigned_technician_id = me.tm_id))
    AND (
      lm.created_at IS NOT NULL
      OR (NOT me.is_office AND j.scheduled_datetime BETWEEN now() - interval '7 days' AND now() + interval '7 days')
    )
  ORDER BY COALESCE(lm.created_at, j.scheduled_datetime) DESC NULLS LAST
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

CREATE OR REPLACE FUNCTION public.mark_job_thread_read(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_access_job_thread(p_job_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO job_message_reads (job_id, user_id, last_read_at) VALUES (p_job_id, auth.uid(), now())
  ON CONFLICT (job_id, user_id) DO UPDATE SET last_read_at = now();
END; $$;

REVOKE ALL ON FUNCTION public.is_office_member() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_job_thread(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_job_media_path(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_job_thread_summaries(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_job_thread_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_office_member() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_job_thread(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_job_media_path(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_job_thread_summaries(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_job_thread_read(uuid) TO authenticated;
