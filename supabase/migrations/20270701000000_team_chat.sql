/*
  # Team chat (office <-> technicians)

  Internal, per-job channels plus 1:1 direct messages, with photos, voice
  notes, read receipts, realtime and per-person push notifications.

  ## Tables
  - chat_channels : one row per job channel (kind='job') or DM (kind='direct').
  - chat_members  : read state (last_read_at -> read receipts / unread badges),
                    mute flag, and the authoritative participant list of a DM.
  - chat_messages : text | image | voice | system. Soft-deleted (tombstones).

  ## Access model (enforced here, never only in the UI)
  Everything is scoped to the account: user_id = public.get_account_owner_id().
  - Job channel  : managers (owner, or effective can_view_all_jobs — custom role
                   overrides the base flag, same as AuthContext) + the
                   technician currently assigned to that job. Reassigning the
                   job moves access automatically.
  - Direct       : exactly the two people listed in chat_members.
  Clients have NO direct write access to channels / members; those go through
  SECURITY DEFINER RPCs that re-check access. Messages can be inserted/edited
  by their sender only; there is no hard-DELETE policy.

  ## Read receipts
  A message is "read by X" when X.last_read_at >= message.created_at
  (chat_mark_read(channel, up_to) never moves the marker backwards).

  ## Push
  push_subscriptions is account-wide (user_id = owner). A per-person column
  `subscriber_id` (default auth.uid()) is added so chat can notify ONE person
  and never leak previews to the rest of the team. Existing rows have NULL and
  are intentionally ignored by chat until that person re-enables notifications.
  Dispatch reuses the existing pg_net settings
  (app.settings.edge_function_base_url / push_dispatch_secret) and calls the
  new `send-chat-push` edge function. Without them it silently no-ops.

  ## Storage
  Private bucket `chat-media`, object path: <account>/<channel>/<senderUid>_<uuid>.<ext>.
  Reads/writes require access to that channel; only the uploader may delete.

  Requires: get_account_owner_id(), get_my_team_member_id(), team_members
  (user_id, permissions, custom_role_id, invite_status), custom_roles,
  profiles, jobs(assigned_technician_id), push_subscriptions.
*/

-- ---------------------------------------------------------------------------
-- Per-person push targeting (additive; existing rows keep working untouched)
-- ---------------------------------------------------------------------------
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS subscriber_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_subscriber
  ON public.push_subscriptions (subscriber_id) WHERE subscriber_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('job', 'direct')),
  job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  dm_key text CHECK (dm_key IS NULL OR char_length(dm_key) <= 80),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  last_message_kind text CHECK (last_message_kind IS NULL OR last_message_kind IN ('text', 'image', 'voice', 'system')),
  last_message_preview text,
  last_message_sender_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_channels_kind_shape CHECK (
    (kind = 'job' AND job_id IS NOT NULL AND dm_key IS NULL)
    OR (kind = 'direct' AND dm_key IS NOT NULL AND job_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channels_job ON public.chat_channels (job_id) WHERE kind = 'job';
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_channels_dm ON public.chat_channels (user_id, dm_key) WHERE kind = 'direct';
CREATE INDEX IF NOT EXISTS idx_chat_channels_user_recent ON public.chat_channels (user_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS public.chat_members (
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  muted boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON public.chat_members (user_id);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'voice', 'system')),
  body text CHECK (body IS NULL OR char_length(body) <= 4000),
  attachment_path text CHECK (attachment_path IS NULL OR char_length(attachment_path) <= 300),
  attachment_mime text CHECK (attachment_mime IS NULL OR char_length(attachment_mime) <= 100),
  attachment_bytes integer CHECK (attachment_bytes IS NULL OR attachment_bytes BETWEEN 1 AND 26214400),
  voice_duration_ms integer CHECK (voice_duration_ms IS NULL OR voice_duration_ms BETWEEN 1 AND 600000),
  client_id uuid,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_shape CHECK (
    deleted_at IS NOT NULL
    OR (kind = 'text' AND body IS NOT NULL AND char_length(btrim(body)) >= 1 AND attachment_path IS NULL)
    OR (kind = 'image' AND attachment_path IS NOT NULL AND voice_duration_ms IS NULL)
    OR (kind = 'voice' AND attachment_path IS NOT NULL AND voice_duration_ms IS NOT NULL)
    OR (kind = 'system' AND body IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON public.chat_messages (channel_id, created_at DESC, id DESC);
-- Idempotent sends: a retried offline message can never be stored twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_client
  ON public.chat_messages (channel_id, sender_id, client_id) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Access helpers (SECURITY DEFINER: they read tables the caller may not)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    NOT EXISTS (SELECT 1 FROM team_members m WHERE m.user_id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM team_members m
      LEFT JOIN custom_roles cr ON cr.id = m.custom_role_id
      WHERE m.user_id = auth.uid()
        AND COALESCE(
          (cr.permissions ->> 'can_view_all_jobs')::boolean,
          (m.permissions ->> 'can_view_all_jobs')::boolean,
          false
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.chat_can_access(p_channel uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM chat_channels c
    WHERE c.id = p_channel
      AND c.user_id = public.get_account_owner_id()
      AND (
        (c.kind = 'direct' AND EXISTS (
          SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = auth.uid()
        ))
        OR (c.kind = 'job' AND (
          public.chat_is_manager()
          OR EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = c.job_id
              AND j.assigned_technician_id IS NOT NULL
              AND j.assigned_technician_id = public.get_my_team_member_id()
          )
        ))
      )
  );
$$;

-- Storage helper: path is <account>/<channel>/<file>; never throws on junk input.
CREATE OR REPLACE FUNCTION public.chat_storage_can_access(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parts text[] := storage.foldername(p_name);
BEGIN
  IF v_parts IS NULL OR array_length(v_parts, 1) IS DISTINCT FROM 2 THEN RETURN false; END IF;
  IF v_parts[1] IS DISTINCT FROM public.get_account_owner_id()::text THEN RETURN false; END IF;
  IF v_parts[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  RETURN public.chat_can_access(v_parts[2]::uuid);
END;
$$;

REVOKE ALL ON FUNCTION public.chat_is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_can_access(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_storage_can_access(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_is_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_can_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_storage_can_access(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_channels_select" ON public.chat_channels;
CREATE POLICY "chat_channels_select" ON public.chat_channels
  FOR SELECT TO authenticated
  USING (public.chat_can_access(id));

DROP POLICY IF EXISTS "chat_members_select" ON public.chat_members;
CREATE POLICY "chat_members_select" ON public.chat_members
  FOR SELECT TO authenticated
  USING (public.chat_can_access(channel_id));

DROP POLICY IF EXISTS "chat_messages_select" ON public.chat_messages;
CREATE POLICY "chat_messages_select" ON public.chat_messages
  FOR SELECT TO authenticated
  USING (public.chat_can_access(channel_id));

DROP POLICY IF EXISTS "chat_messages_insert" ON public.chat_messages;
CREATE POLICY "chat_messages_insert" ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND sender_id = auth.uid()
    AND kind <> 'system'
    AND public.chat_can_access(channel_id)
  );

DROP POLICY IF EXISTS "chat_messages_update" ON public.chat_messages;
CREATE POLICY "chat_messages_update" ON public.chat_messages
  FOR UPDATE TO authenticated
  USING (sender_id = auth.uid() AND public.chat_can_access(channel_id))
  WITH CHECK (sender_id = auth.uid() AND public.chat_can_access(channel_id));

-- ---------------------------------------------------------------------------
-- Message integrity (insert) + side effects
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_messages_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_recent integer;
BEGIN
  SELECT c.user_id INTO v_account FROM chat_channels c WHERE c.id = NEW.channel_id;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'channel_not_found' USING ERRCODE = 'P0002';
  END IF;
  NEW.user_id := v_account;

  IF NEW.body IS NOT NULL THEN NEW.body := btrim(NEW.body); END IF;
  IF NEW.kind = 'text' THEN
    NEW.attachment_path := NULL; NEW.attachment_mime := NULL; NEW.attachment_bytes := NULL; NEW.voice_duration_ms := NULL;
  END IF;

  IF NEW.kind IN ('image', 'voice') THEN
    -- Attachment must live in THIS channel's folder and be named after the sender.
    IF NEW.attachment_path IS NULL
       OR NEW.attachment_path NOT LIKE v_account::text || '/' || NEW.channel_id::text || '/' || NEW.sender_id::text || '\_%'
       OR position('..' IN NEW.attachment_path) > 0 THEN
      RAISE EXCEPTION 'invalid_attachment_path' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Burst guard (per sender per channel): 30 messages / 10 s.
  SELECT count(*) INTO v_recent
  FROM chat_messages m
  WHERE m.channel_id = NEW.channel_id AND m.sender_id = NEW.sender_id
    AND m.created_at > now() - interval '10 seconds';
  IF v_recent >= 30 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_chat_messages_before_insert ON public.chat_messages;
CREATE TRIGGER trigger_chat_messages_before_insert
  BEFORE INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_before_insert();

-- Update: sender may soft-delete any time, edit text within 15 minutes.
CREATE OR REPLACE FUNCTION public.chat_messages_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.id := OLD.id; NEW.channel_id := OLD.channel_id; NEW.user_id := OLD.user_id;
  NEW.sender_id := OLD.sender_id; NEW.kind := OLD.kind; NEW.created_at := OLD.created_at;
  NEW.client_id := OLD.client_id; NEW.attachment_mime := OLD.attachment_mime;
  NEW.attachment_bytes := OLD.attachment_bytes; NEW.voice_duration_ms := OLD.voice_duration_ms;

  IF OLD.deleted_at IS NOT NULL THEN
    NEW.deleted_at := OLD.deleted_at; NEW.body := OLD.body; NEW.attachment_path := OLD.attachment_path;
    NEW.edited_at := OLD.edited_at;
    RETURN NEW;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := now(); NEW.body := NULL; NEW.attachment_path := NULL; NEW.edited_at := OLD.edited_at;
    RETURN NEW;
  END IF;

  NEW.attachment_path := OLD.attachment_path;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF OLD.kind <> 'text' THEN
      RAISE EXCEPTION 'only_text_editable' USING ERRCODE = '22023';
    END IF;
    IF OLD.created_at < now() - interval '15 minutes' THEN
      RAISE EXCEPTION 'edit_window_closed' USING ERRCODE = '22023';
    END IF;
    NEW.body := btrim(NEW.body);
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_chat_messages_before_update ON public.chat_messages;
CREATE TRIGGER trigger_chat_messages_before_update
  BEFORE UPDATE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_before_update();

CREATE OR REPLACE FUNCTION public.chat_messages_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
BEGIN
  UPDATE chat_channels
     SET last_message_at = NEW.created_at,
         last_message_kind = NEW.kind,
         last_message_preview = CASE WHEN NEW.kind IN ('text', 'system') THEN left(NEW.body, 140) ELSE NULL END,
         last_message_sender_id = NEW.sender_id
   WHERE id = NEW.channel_id
     AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);

  -- Sending implies "I have read everything up to here" (and follows the channel).
  INSERT INTO chat_members (channel_id, user_id, last_read_at)
  VALUES (NEW.channel_id, NEW.sender_id, NEW.created_at)
  ON CONFLICT (channel_id, user_id)
  DO UPDATE SET last_read_at = GREATEST(chat_members.last_read_at, EXCLUDED.last_read_at);

  IF NEW.kind <> 'system' THEN
    v_base_url := current_setting('app.settings.edge_function_base_url', true);
    v_secret := current_setting('app.settings.push_dispatch_secret', true);
    IF v_base_url IS NOT NULL AND v_base_url <> '' AND v_secret IS NOT NULL AND v_secret <> '' THEN
      BEGIN
        PERFORM net.http_post(
          url := v_base_url || '/send-chat-push',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
          body := jsonb_build_object('message_id', NEW.id)
        );
      EXCEPTION WHEN OTHERS THEN
        -- A push problem must never block (or roll back) a chat message.
        RAISE WARNING 'chat push dispatch failed: %', SQLERRM;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_chat_messages_after_insert ON public.chat_messages;
CREATE TRIGGER trigger_chat_messages_after_insert
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_after_insert();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_open_job_channel(p_job_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = p_job_id AND j.user_id = v_account
      AND (
        public.chat_is_manager()
        OR (j.assigned_technician_id IS NOT NULL AND j.assigned_technician_id = public.get_my_team_member_id())
      )
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  INSERT INTO chat_channels (user_id, kind, job_id, created_by)
  VALUES (v_account, 'job', p_job_id, auth.uid())
  ON CONFLICT (job_id) WHERE kind = 'job' DO NOTHING;

  SELECT c.id INTO v_id FROM chat_channels c WHERE c.kind = 'job' AND c.job_id = p_job_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_open_direct(p_other uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := public.get_account_owner_id();
  v_me uuid := auth.uid();
  v_key text;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF p_other IS NULL OR p_other = v_me THEN RAISE EXCEPTION 'invalid_recipient' USING ERRCODE = '22023'; END IF;

  IF NOT (
    p_other = v_account
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = p_other AND m.account_owner_id = v_account AND m.invite_status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_key := least(v_me::text, p_other::text) || ':' || greatest(v_me::text, p_other::text);

  INSERT INTO chat_channels (user_id, kind, dm_key, created_by)
  VALUES (v_account, 'direct', v_key, v_me)
  ON CONFLICT (user_id, dm_key) WHERE kind = 'direct' DO NOTHING;

  SELECT c.id INTO v_id FROM chat_channels c WHERE c.user_id = v_account AND c.kind = 'direct' AND c.dm_key = v_key;

  INSERT INTO chat_members (channel_id, user_id) VALUES (v_id, v_me), (v_id, p_other)
  ON CONFLICT (channel_id, user_id) DO NOTHING;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_mark_read(p_channel uuid, p_up_to timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_to timestamptz := LEAST(COALESCE(p_up_to, now()), now());
BEGIN
  IF NOT public.chat_can_access(p_channel) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO chat_members (channel_id, user_id, last_read_at)
  VALUES (p_channel, auth.uid(), v_to)
  ON CONFLICT (channel_id, user_id)
  DO UPDATE SET last_read_at = GREATEST(chat_members.last_read_at, EXCLUDED.last_read_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_set_muted(p_channel uuid, p_muted boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.chat_can_access(p_channel) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO chat_members (channel_id, user_id, muted)
  VALUES (p_channel, auth.uid(), COALESCE(p_muted, false))
  ON CONFLICT (channel_id, user_id) DO UPDATE SET muted = EXCLUDED.muted;
END;
$$;

-- Unread per channel. Followers count messages after their marker; an assigned
-- technician who never opened a job channel sees everything as unread; managers
-- who never opened one see 0 (so a 200-job shop does not drown the badge).
CREATE OR REPLACE FUNCTION public.chat_unread_counts()
RETURNS TABLE (channel_id uuid, unread bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, count(m.id)
  FROM chat_channels c
  LEFT JOIN chat_members cm ON cm.channel_id = c.id AND cm.user_id = auth.uid()
  JOIN chat_messages m
    ON m.channel_id = c.id
   AND m.sender_id <> auth.uid()
   AND m.deleted_at IS NULL
   AND m.kind <> 'system'
   AND m.created_at > COALESCE(cm.last_read_at, 'epoch'::timestamptz)
  WHERE c.user_id = public.get_account_owner_id()
    AND c.last_message_at IS NOT NULL
    AND public.chat_can_access(c.id)
    AND (
      cm.user_id IS NOT NULL
      OR (c.kind = 'job' AND EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.id = c.job_id AND j.assigned_technician_id IS NOT NULL
          AND j.assigned_technician_id = public.get_my_team_member_id()
      ))
    )
  GROUP BY c.id;
$$;

-- People the caller can message (same account only).
CREATE OR REPLACE FUNCTION public.chat_people()
RETURNS TABLE (user_id uuid, name text, role text, is_self boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH acct AS (SELECT public.get_account_owner_id() AS id)
  SELECT p.id,
         COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.company_name), ''), split_part(p.email, '@', 1)),
         'owner'::text,
         p.id = auth.uid()
  FROM profiles p, acct
  WHERE auth.uid() IS NOT NULL AND p.id = acct.id
  UNION ALL
  SELECT tm.user_id,
         COALESCE(NULLIF(btrim(tm.member_name), ''), split_part(tm.member_email, '@', 1)),
         tm.role,
         tm.user_id = auth.uid()
  FROM team_members tm, acct
  WHERE auth.uid() IS NOT NULL
    AND tm.account_owner_id = acct.id
    AND tm.user_id IS NOT NULL
    AND tm.invite_status = 'active';
$$;

-- Push audience for one message. Service role only (called by the edge function).
CREATE OR REPLACE FUNCTION public.chat_push_recipients(p_message_id uuid)
RETURNS TABLE (user_id uuid, channel_id uuid, channel_kind text, job_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg chat_messages;
  v_chan chat_channels;
  v_tech_user uuid;
BEGIN
  SELECT * INTO v_msg FROM chat_messages WHERE id = p_message_id AND deleted_at IS NULL AND kind <> 'system';
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_chan FROM chat_channels WHERE id = v_msg.channel_id;

  IF v_chan.kind = 'direct' THEN
    RETURN QUERY
      SELECT cm.user_id, v_chan.id, v_chan.kind, v_chan.job_id
      FROM chat_members cm
      WHERE cm.channel_id = v_chan.id AND cm.user_id <> v_msg.sender_id AND NOT cm.muted;
    RETURN;
  END IF;

  SELECT tm.user_id INTO v_tech_user
  FROM jobs j JOIN team_members tm ON tm.id = j.assigned_technician_id
  WHERE j.id = v_chan.job_id;

  RETURN QUERY
  WITH followers AS (
    SELECT cm.user_id AS uid FROM chat_members cm
    WHERE cm.channel_id = v_chan.id AND cm.user_id <> v_msg.sender_id AND NOT cm.muted
  ),
  tech AS (
    SELECT v_tech_user AS uid
    WHERE v_tech_user IS NOT NULL AND v_tech_user <> v_msg.sender_id
      AND NOT EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = v_chan.id AND cm.user_id = v_tech_user AND cm.muted)
  ),
  managers AS (
    -- First contact from the field: nobody in the office follows this job yet.
    SELECT p.id AS uid FROM profiles p WHERE p.id = v_chan.user_id
    UNION
    SELECT tm.user_id FROM team_members tm
    LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
    WHERE tm.account_owner_id = v_chan.user_id AND tm.user_id IS NOT NULL AND tm.invite_status = 'active'
      AND COALESCE((cr.permissions ->> 'can_view_all_jobs')::boolean, (tm.permissions ->> 'can_view_all_jobs')::boolean, false)
  ),
  office_followers AS (
    -- Anyone in the office already on this job (muted or not) means it is covered.
    SELECT cm.user_id AS uid FROM chat_members cm
    WHERE cm.channel_id = v_chan.id AND cm.user_id <> v_msg.sender_id
      AND cm.user_id IS DISTINCT FROM v_tech_user
  ),
  audience AS (
    SELECT uid FROM followers
    UNION SELECT uid FROM tech
    UNION SELECT mg.uid FROM managers mg
      WHERE v_msg.sender_id IS NOT DISTINCT FROM v_tech_user
        AND NOT EXISTS (SELECT 1 FROM office_followers)
        AND mg.uid <> v_msg.sender_id
        AND NOT EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = v_chan.id AND cm.user_id = mg.uid AND cm.muted)
  )
  SELECT a.uid, v_chan.id, v_chan.kind, v_chan.job_id FROM audience a WHERE a.uid IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_open_job_channel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_open_direct(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_mark_read(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_set_muted(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_unread_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_people() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_push_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_open_job_channel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_open_direct(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_mark_read(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_set_muted(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_people() TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_push_recipients(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for photos + voice notes
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media', 'chat-media', false, 15728640, -- 15 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "chat_media_select" ON storage.objects;
CREATE POLICY "chat_media_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media' AND public.chat_storage_can_access(name));

DROP POLICY IF EXISTS "chat_media_insert" ON storage.objects;
CREATE POLICY "chat_media_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND public.chat_storage_can_access(name)
    AND split_part(name, '/', 3) LIKE auth.uid()::text || '\_%'
  );

DROP POLICY IF EXISTS "chat_media_delete" ON storage.objects;
CREATE POLICY "chat_media_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND public.chat_storage_can_access(name)
    AND split_part(name, '/', 3) LIKE auth.uid()::text || '\_%'
  );

-- ---------------------------------------------------------------------------
-- Realtime (idempotent; each table's RLS SELECT policy filters what is sent)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['chat_messages', 'chat_members', 'chat_channels'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;
