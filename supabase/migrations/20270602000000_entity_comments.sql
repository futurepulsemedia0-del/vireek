/*
  # Entity comments + @mentions (jobs, customers, quotes, leads)

  Internal team discussion on a record, with @mentions, one-level threads,
  resolve state, realtime updates and per-person notifications (bell, push,
  email).

  ## Tables
  - public.entity_comments            one row per comment. Replies point at their
                                      thread root through parent_id (one level
                                      only). Resolve state lives on the root.
                                      Deleting is a SOFT delete (deleted_at) so
                                      realtime can deliver it and threads keep
                                      their shape; the body is blanked.

  ## Access model (enforced here, not just in the UI)
  - Everything is scoped to the account: user_id = get_account_owner_id().
  - A caller can read/write comments on a record only if they can SEE that
    record under the record's own RLS (comment_entity_visible runs with the
    caller's rights) AND comment_member_can_access() says so:
      * owner and managers (custom role overrides base can_view_all_jobs,
        same rule as AuthContext / tasks) -> every record type
      * everyone else -> only jobs assigned to them
  - Body edits: author only. Soft delete: author or manager. Resolve/reopen:
    anyone who can see the thread. All enforced by the BEFORE trigger, so a
    hand-written client request cannot bypass them.
  - Mentions are NEVER trusted from the client: the trigger re-extracts
    @[Name](user:<uuid>) tokens from the body and keeps only people who are
    members of the account AND can access the record.

  ## Notifications
  - notifications gets recipient_id (nullable). NULL = account-wide row (every
    existing type, unchanged behaviour). Non-NULL = visible ONLY to that user:
    select/update/delete policies are replaced accordingly, and clients can no
    longer insert targeted rows (only the SECURITY DEFINER comment trigger can).
  - Types: comment_mention, comment_reply (thread participants).
  - Push: send-push-notification reads notifications.recipient_id and pushes
    only to that person's devices (push_subscriptions / device_push_tokens
    .subscriber_user_id, which already exist in this project).
  - Email: a pg_net trigger calls the send-comment-email edge function (same
    app.settings.* + secret as send-push-notification) when the recipient has
    notify_comment_email = true.
  - Preferences (profiles, one row per signed-in user): notify_comment_mention
    (bell + push) and notify_comment_email.

  ## Cleanup
  - Deleting a job / customer / quote / lead removes its comments (a polymorphic
    entity_id cannot carry a foreign key, so AFTER DELETE triggers do it).

  Requires: get_account_owner_id(), profiles, team_members(user_id,
  account_owner_id, invite_status, role, permissions, custom_role_id),
  custom_roles(permissions), jobs(assigned_technician_id), customers, quotes,
  leads, notifications, pg_net (already used by push).
*/

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notify_comment_mention boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_comment_email boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- notifications.recipient_id  (per-person notifications)
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS recipient_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
  ON public.notifications (recipient_id, created_at DESC) WHERE recipient_id IS NOT NULL;

DROP POLICY IF EXISTS "select_own_notifications" ON public.notifications;
CREATE POLICY "select_own_notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (recipient_id IS NULL OR recipient_id = auth.uid())
  );

DROP POLICY IF EXISTS "insert_own_notifications" ON public.notifications;
CREATE POLICY "insert_own_notifications" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND recipient_id IS NULL);

DROP POLICY IF EXISTS "update_own_notifications" ON public.notifications;
CREATE POLICY "update_own_notifications" ON public.notifications
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (recipient_id IS NULL OR recipient_id = auth.uid())
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (recipient_id IS NULL OR recipient_id = auth.uid())
  );

DROP POLICY IF EXISTS "delete_own_notifications" ON public.notifications;
CREATE POLICY "delete_own_notifications" ON public.notifications
  FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (recipient_id IS NULL OR recipient_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('job', 'customer', 'quote', 'lead')),
  entity_id uuid NOT NULL,
  parent_id uuid REFERENCES public.entity_comments(id) ON DELETE CASCADE,
  author_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  author_name text NOT NULL DEFAULT 'Team member',
  body text NOT NULL DEFAULT '',
  mentions uuid[] NOT NULL DEFAULT '{}',
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_by_name text,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_comments_body_len CHECK (
    deleted_at IS NOT NULL OR char_length(btrim(body)) BETWEEN 1 AND 4000
  ),
  CONSTRAINT entity_comments_resolve_root_only CHECK (
    parent_id IS NULL OR (resolved_at IS NULL AND resolved_by IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_entity_comments_entity
  ON public.entity_comments (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entity_comments_parent
  ON public.entity_comments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_comments_user_open
  ON public.entity_comments (user_id, created_at DESC) WHERE parent_id IS NULL AND resolved_at IS NULL AND deleted_at IS NULL;

ALTER TABLE public.entity_comments ENABLE ROW LEVEL SECURITY;

-- Rows are only reachable through the policies below. No DELETE grant on purpose
-- (soft delete is an UPDATE).
GRANT SELECT, INSERT, UPDATE ON public.entity_comments TO authenticated;

-- ---------------------------------------------------------------------------
-- Helpers. All SECURITY DEFINER helpers refuse to answer for any account other
-- than the caller's, so they cannot be used to probe other tenants.
-- ---------------------------------------------------------------------------

-- Owner of a record, only if it belongs to the caller's account.
CREATE OR REPLACE FUNCTION public.comment_entity_owner(p_type text, p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_type
    WHEN 'job' THEN (SELECT j.user_id FROM public.jobs j WHERE j.id = p_id AND j.user_id = public.get_account_owner_id())
    WHEN 'customer' THEN (SELECT c.user_id FROM public.customers c WHERE c.id = p_id AND c.user_id = public.get_account_owner_id())
    WHEN 'quote' THEN (SELECT q.user_id FROM public.quotes q WHERE q.id = p_id AND q.user_id = public.get_account_owner_id())
    WHEN 'lead' THEN (SELECT l.user_id FROM public.leads l WHERE l.id = p_id AND l.user_id = public.get_account_owner_id())
  END;
$$;

-- Human label + dashboard path for a record (used in notification text).
CREATE OR REPLACE FUNCTION public.comment_entity_info(p_type text, p_id uuid)
RETURNS TABLE (label text, kind text, path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(btrim(j.customer_name), ''), 'Job'), 'Job'::text, '/dashboard/jobs/' || j.id::text
    FROM public.jobs j
   WHERE p_type = 'job' AND j.id = p_id AND j.user_id = public.get_account_owner_id()
  UNION ALL
  SELECT COALESCE(NULLIF(btrim(c.name), ''), 'Customer'), 'Customer'::text, '/dashboard/customers/' || c.id::text
    FROM public.customers c
   WHERE p_type = 'customer' AND c.id = p_id AND c.user_id = public.get_account_owner_id()
  UNION ALL
  SELECT COALESCE(NULLIF(btrim(q.customer_name), ''), 'Quote'), 'Quote'::text, '/dashboard/quotes/' || q.id::text
    FROM public.quotes q
   WHERE p_type = 'quote' AND q.id = p_id AND q.user_id = public.get_account_owner_id()
  UNION ALL
  SELECT COALESCE(NULLIF(btrim(l.name), ''), 'Lead'), 'Lead'::text, '/dashboard/leads?lead=' || l.id::text
    FROM public.leads l
   WHERE p_type = 'lead' AND l.id = p_id AND l.user_id = public.get_account_owner_id();
$$;

-- Can the CALLER see the record? Runs with the caller's rights, so the record's
-- own RLS decides (whatever policies your jobs/customers/quotes/leads have).
CREATE OR REPLACE FUNCTION public.comment_entity_visible(p_type text, p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE p_type
    WHEN 'job' THEN EXISTS (SELECT 1 FROM public.jobs WHERE id = p_id)
    WHEN 'customer' THEN EXISTS (SELECT 1 FROM public.customers WHERE id = p_id)
    WHEN 'quote' THEN EXISTS (SELECT 1 FROM public.quotes WHERE id = p_id)
    WHEN 'lead' THEN EXISTS (SELECT 1 FROM public.leads WHERE id = p_id)
    ELSE false
  END;
$$;

-- Manager = account owner, or an active member whose effective
-- can_view_all_jobs is true (custom role overrides the base permission).
CREATE OR REPLACE FUNCTION public.comment_is_manager(p_user uuid, p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user IS NOT NULL
    AND p_owner IS NOT DISTINCT FROM public.get_account_owner_id()
    AND (
      p_user = p_owner
      OR EXISTS (
        SELECT 1
          FROM public.team_members m
          LEFT JOIN public.custom_roles cr ON cr.id = m.custom_role_id
         WHERE m.user_id = p_user
           AND m.account_owner_id = p_owner
           AND m.invite_status = 'active'
           AND COALESCE(
                 (cr.permissions ->> 'can_view_all_jobs')::boolean,
                 (m.permissions ->> 'can_view_all_jobs')::boolean,
                 false
               )
      )
    );
$$;

-- May this person take part in the discussion on this record?
-- (membership + manager / assigned-technician rule; used for the caller AND for
-- validating mentioned people.)
CREATE OR REPLACE FUNCTION public.comment_member_can_access(p_user uuid, p_owner uuid, p_type text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user IS NULL OR p_owner IS NULL OR p_owner IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN false;
  END IF;

  IF p_user <> p_owner AND NOT EXISTS (
    SELECT 1 FROM public.team_members m
     WHERE m.user_id = p_user AND m.account_owner_id = p_owner AND m.invite_status = 'active'
  ) THEN
    RETURN false;
  END IF;

  IF public.comment_is_manager(p_user, p_owner) THEN
    RETURN true;
  END IF;

  IF p_type = 'job' THEN
    RETURN EXISTS (
      SELECT 1
        FROM public.jobs j
        JOIN public.team_members m ON m.id = j.assigned_technician_id
       WHERE j.id = p_id AND j.user_id = p_owner AND m.user_id = p_user
    );
  END IF;

  RETURN false;
END;
$$;

-- Display name snapshot (team member name > profile name > email prefix).
-- Only answers for people in the caller's own account.
CREATE OR REPLACE FUNCTION public.comment_display_name(p_user uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_name text;
BEGIN
  IF p_user IS NULL OR v_owner IS NULL THEN
    RETURN 'Team member';
  END IF;
  IF p_user <> v_owner AND NOT EXISTS (
    SELECT 1 FROM public.team_members m WHERE m.user_id = p_user AND m.account_owner_id = v_owner
  ) THEN
    RETURN 'Team member';
  END IF;

  SELECT COALESCE(
           (SELECT NULLIF(btrim(m.member_name), '') FROM public.team_members m WHERE m.user_id = p_user LIMIT 1),
           (SELECT NULLIF(btrim(p.full_name), '') FROM public.profiles p WHERE p.id = p_user),
           (SELECT NULLIF(split_part(p.email, '@', 1), '') FROM public.profiles p WHERE p.id = p_user)
         )
    INTO v_name;

  RETURN COALESCE(left(v_name, 80), 'Team member');
END;
$$;

-- @[Name](user:<uuid>) tokens -> distinct uuids.
CREATE OR REPLACE FUNCTION public.comment_extract_mentions(p_body text)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT m[1]::uuid), '{}'::uuid[])
    FROM regexp_matches(
           COALESCE(p_body, ''),
           '@\[[^\]]{1,80}\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)',
           'g'
         ) AS m;
$$;

-- Body without tokens: "@[Ana](user:...)" -> "@Ana".
CREATE OR REPLACE FUNCTION public.comment_plain_text(p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT regexp_replace(
           COALESCE(p_body, ''),
           '@\[([^\]]{1,80})\]\(user:[0-9a-fA-F-]{36}\)',
           '@\1',
           'g'
         );
$$;

-- ---------------------------------------------------------------------------
-- Integrity trigger (BEFORE INSERT/UPDATE)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entity_comments_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_parent public.entity_comments;
  v_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.body := btrim(NEW.body);
    IF v_uid IS NOT NULL THEN
      NEW.author_id := v_uid;
    END IF;
    NEW.author_name := public.comment_display_name(NEW.author_id);
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
    NEW.resolved_by_name := NULL;
    NEW.edited_at := NULL;
    NEW.deleted_at := NULL;
    NEW.deleted_by := NULL;
    NEW.created_at := now();
    NEW.updated_at := now();

    IF NEW.parent_id IS NOT NULL THEN
      SELECT * INTO v_parent FROM public.entity_comments WHERE id = NEW.parent_id;
      IF NOT FOUND
         OR v_parent.parent_id IS NOT NULL
         OR v_parent.user_id <> NEW.user_id
         OR v_parent.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'invalid_parent' USING ERRCODE = '22023';
      END IF;
      IF v_parent.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION 'thread_resolved' USING ERRCODE = '22023';
      END IF;
      NEW.entity_type := v_parent.entity_type;
      NEW.entity_id := v_parent.entity_id;
    END IF;

    IF public.comment_entity_owner(NEW.entity_type, NEW.entity_id) IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
    END IF;

    v_ids := public.comment_extract_mentions(NEW.body);
    IF cardinality(v_ids) > 20 THEN
      RAISE EXCEPTION 'too_many_mentions' USING ERRCODE = '22023';
    END IF;
    NEW.mentions := ARRAY(
      SELECT x FROM unnest(v_ids) AS x
       WHERE x IS DISTINCT FROM NEW.author_id
         AND public.comment_member_can_access(x, NEW.user_id, NEW.entity_type, NEW.entity_id)
    );
    RETURN NEW;
  END IF;

  -- ---- UPDATE ----
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'comment_deleted' USING ERRCODE = '22023';
  END IF;

  NEW.user_id := OLD.user_id;
  NEW.entity_type := OLD.entity_type;
  NEW.entity_id := OLD.entity_id;
  NEW.parent_id := OLD.parent_id;
  NEW.author_id := OLD.author_id;
  NEW.author_name := OLD.author_name;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();

  -- Soft delete: author or manager.
  IF NEW.deleted_at IS NOT NULL THEN
    IF v_uid IS NOT NULL AND v_uid IS DISTINCT FROM OLD.author_id AND NOT public.comment_is_manager(v_uid, OLD.user_id) THEN
      RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
    END IF;
    NEW.deleted_at := now();
    NEW.deleted_by := v_uid;
    NEW.body := '';
    NEW.mentions := '{}';
    NEW.resolved_at := OLD.resolved_at;
    NEW.resolved_by := OLD.resolved_by;
    NEW.resolved_by_name := OLD.resolved_by_name;
    NEW.edited_at := OLD.edited_at;
    RETURN NEW;
  END IF;
  NEW.deleted_by := NULL;

  -- Body edit: author only; mentions are re-derived.
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF v_uid IS NOT NULL AND v_uid IS DISTINCT FROM OLD.author_id THEN
      RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
    END IF;
    NEW.body := btrim(NEW.body);
    NEW.edited_at := now();
    v_ids := public.comment_extract_mentions(NEW.body);
    IF cardinality(v_ids) > 20 THEN
      RAISE EXCEPTION 'too_many_mentions' USING ERRCODE = '22023';
    END IF;
    NEW.mentions := ARRAY(
      SELECT x FROM unnest(v_ids) AS x
       WHERE x IS DISTINCT FROM OLD.author_id
         AND public.comment_member_can_access(x, OLD.user_id, OLD.entity_type, OLD.entity_id)
    );
  ELSE
    NEW.body := OLD.body;
    NEW.mentions := OLD.mentions;
    NEW.edited_at := OLD.edited_at;
  END IF;

  -- Resolve / reopen (thread root only; any participant).
  IF NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
    IF OLD.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'resolve_root_only' USING ERRCODE = '22023';
    END IF;
    IF NEW.resolved_at IS NOT NULL THEN
      NEW.resolved_at := now();
      NEW.resolved_by := v_uid;
      NEW.resolved_by_name := public.comment_display_name(v_uid);
    ELSE
      NEW.resolved_by := NULL;
      NEW.resolved_by_name := NULL;
    END IF;
  ELSE
    NEW.resolved_at := OLD.resolved_at;
    NEW.resolved_by := OLD.resolved_by;
    NEW.resolved_by_name := OLD.resolved_by_name;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_entity_comments_before_write ON public.entity_comments;
CREATE TRIGGER trigger_entity_comments_before_write
  BEFORE INSERT OR UPDATE ON public.entity_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.entity_comments_before_write();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "entity_comments_select" ON public.entity_comments;
CREATE POLICY "entity_comments_select" ON public.entity_comments
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND public.comment_entity_visible(entity_type, entity_id)
    AND public.comment_member_can_access(auth.uid(), user_id, entity_type, entity_id)
  );

DROP POLICY IF EXISTS "entity_comments_insert" ON public.entity_comments;
CREATE POLICY "entity_comments_insert" ON public.entity_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND author_id = auth.uid()
    AND public.comment_entity_visible(entity_type, entity_id)
    AND public.comment_member_can_access(auth.uid(), user_id, entity_type, entity_id)
  );

-- Edits / resolve / soft delete. Which COLUMN each person may change is
-- enforced by entity_comments_before_write().
DROP POLICY IF EXISTS "entity_comments_update" ON public.entity_comments;
CREATE POLICY "entity_comments_update" ON public.entity_comments
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND public.comment_entity_visible(entity_type, entity_id)
    AND public.comment_member_can_access(auth.uid(), user_id, entity_type, entity_id)
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.comment_entity_visible(entity_type, entity_id)
    AND public.comment_member_can_access(auth.uid(), user_id, entity_type, entity_id)
  );
-- No DELETE policy on purpose: removal is a soft delete (UPDATE).

-- ---------------------------------------------------------------------------
-- Notifications (SECURITY DEFINER: writes rows for OTHER people)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entity_comments_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text;
  v_kind text;
  v_path text;
  v_url text;
  v_preview text;
  v_targets uuid[];
  v_notified uuid[] := '{}';
  v_uid uuid;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT i.label, i.kind, i.path INTO v_label, v_kind, v_path
      FROM public.comment_entity_info(NEW.entity_type, NEW.entity_id) i
     LIMIT 1;
    IF v_path IS NULL THEN
      RETURN NEW;
    END IF;

    v_url := v_path || CASE WHEN position('?' IN v_path) > 0 THEN '&' ELSE '?' END || 'comment=' || NEW.id::text;
    v_preview := left(regexp_replace(public.comment_plain_text(NEW.body), '\s+', ' ', 'g'), 140);

    -- 1) @mentions (on edit: only people newly mentioned)
    IF TG_OP = 'INSERT' THEN
      v_targets := NEW.mentions;
    ELSE
      v_targets := ARRAY(SELECT x FROM unnest(NEW.mentions) AS x WHERE NOT (x = ANY (OLD.mentions)));
    END IF;

    FOREACH v_uid IN ARRAY COALESCE(v_targets, '{}'::uuid[]) LOOP
      IF v_uid IS NOT DISTINCT FROM NEW.author_id THEN
        CONTINUE;
      END IF;
      v_notified := v_notified || v_uid;
      IF COALESCE((SELECT p.notify_comment_mention FROM public.profiles p WHERE p.id = v_uid), true) THEN
        INSERT INTO public.notifications (user_id, recipient_id, type, title, message, action_url)
        VALUES (
          NEW.user_id,
          v_uid,
          'comment_mention',
          NEW.author_name || ' mentioned you',
          v_kind || ' · ' || v_label || ': ' || v_preview,
          v_url
        );
      END IF;
    END LOOP;

    -- 2) replies: tell everyone already in the thread (once, not the author,
    --    not people just notified by a mention)
    IF TG_OP = 'INSERT' AND NEW.parent_id IS NOT NULL THEN
      FOR v_uid IN
        SELECT DISTINCT c.author_id
          FROM public.entity_comments c
         WHERE (c.id = NEW.parent_id OR c.parent_id = NEW.parent_id)
           AND c.id <> NEW.id
           AND c.deleted_at IS NULL
           AND c.author_id IS NOT NULL
      LOOP
        IF v_uid IS NOT DISTINCT FROM NEW.author_id OR v_uid = ANY (v_notified) THEN
          CONTINUE;
        END IF;
        IF NOT public.comment_member_can_access(v_uid, NEW.user_id, NEW.entity_type, NEW.entity_id) THEN
          CONTINUE;
        END IF;
        IF COALESCE((SELECT p.notify_comment_mention FROM public.profiles p WHERE p.id = v_uid), true) THEN
          INSERT INTO public.notifications (user_id, recipient_id, type, title, message, action_url)
          VALUES (
            NEW.user_id,
            v_uid,
            'comment_reply',
            NEW.author_name || ' replied in a thread',
            v_kind || ' · ' || v_label || ': ' || v_preview,
            v_url
          );
        END IF;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A notification problem must never lose the comment itself.
    RAISE WARNING 'entity_comments_notify failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_entity_comments_notify ON public.entity_comments;
CREATE TRIGGER trigger_entity_comments_notify
  AFTER INSERT OR UPDATE OF body ON public.entity_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.entity_comments_notify();

-- ---------------------------------------------------------------------------
-- Email dispatch for comment notifications (pg_net -> send-comment-email).
-- No-ops until app.settings.edge_function_base_url / push_dispatch_secret are
-- set (same manual setup as send-push-notification).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_comment_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.push_dispatch_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;
  IF NOT COALESCE((SELECT p.notify_comment_email FROM public.profiles p WHERE p.id = NEW.recipient_id), true) THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_base_url || '/send-comment-email',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
      body := jsonb_build_object('notification_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'dispatch_comment_email failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_dispatch_comment_email ON public.notifications;
CREATE TRIGGER trigger_dispatch_comment_email
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  WHEN (NEW.recipient_id IS NOT NULL AND NEW.type IN ('comment_mention', 'comment_reply'))
  EXECUTE FUNCTION public.dispatch_comment_email();

-- ---------------------------------------------------------------------------
-- Mention picker: who can be @mentioned on this record (name + role only, no
-- emails). Only people who can actually open the record are returned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comment_mention_candidates(p_entity_type text, p_entity_id uuid)
RETURNS TABLE (member_id uuid, display_name text, member_role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF public.comment_entity_owner(p_entity_type, p_entity_id) IS DISTINCT FROM v_owner THEN
    RETURN;
  END IF;
  IF NOT public.comment_member_can_access(auth.uid(), v_owner, p_entity_type, p_entity_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.uid, public.comment_display_name(c.uid), c.role_label
    FROM (
      SELECT v_owner AS uid, 'owner'::text AS role_label
      UNION
      SELECT m.user_id, m.role
        FROM public.team_members m
       WHERE m.account_owner_id = v_owner
         AND m.invite_status = 'active'
         AND m.user_id IS NOT NULL
         AND m.user_id <> v_owner
    ) c
   WHERE public.comment_member_can_access(c.uid, v_owner, p_entity_type, p_entity_id)
   ORDER BY 2;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cleanup when the record itself is deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entity_comments_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.entity_comments
   WHERE entity_type = TG_ARGV[0] AND entity_id = OLD.id;
  RETURN OLD;
END;
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('jobs', 'job'), ('customers', 'customer'), ('quotes', 'quote'), ('leads', 'lead')) AS t(tbl, kind) LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trigger_entity_comments_cleanup ON public.%I', r.tbl);
      EXECUTE format(
        'CREATE TRIGGER trigger_entity_comments_cleanup AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.entity_comments_cleanup(%L)',
        r.tbl, r.kind
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.comment_entity_owner(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.comment_entity_info(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.comment_entity_visible(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.comment_is_manager(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.comment_member_can_access(uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.comment_display_name(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.comment_mention_candidates(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.entity_comments_notify() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_comment_email() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_comments_cleanup() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.comment_entity_owner(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comment_entity_info(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comment_entity_visible(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comment_is_manager(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comment_member_can_access(uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comment_display_name(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comment_mention_candidates(text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Realtime (idempotent)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'entity_comments'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.entity_comments;
  END IF;
END $$;
