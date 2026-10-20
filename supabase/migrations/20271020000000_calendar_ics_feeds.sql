/*
  # ICS calendar subscription feeds (per technician + per business)

  Lets a business owner/manager — or a technician for his own schedule — subscribe
  Google Calendar, Apple Calendar or Outlook to a read-only feed of Vireek jobs.

  - calendar_feeds: one business feed per account + one feed per team member.
    The feed is addressed by an unguessable 256-bit token (two random UUIDs, 64 hex
    chars, CHECK-constrained). "Regenerate link" swaps the token in place, which
    instantly invalidates every existing subscription.
  - Served by supabase/functions/calendar-feed (public, deployed --no-verify-jwt).
    That function uses the service role and resolves the token itself.
  - Clients NEVER write the table: every change goes through the SECURITY DEFINER
    RPCs below, which re-check authorization:
      * business feed ........ owner/admin or can_manage_team
      * technician feed ...... the same managers, or the technician for his OWN feed
  - SELECT is RLS-scoped the same way, so a technician never sees the business
    feed token or a colleague's token.
*/

-- =============================================================
-- AUTHORIZATION HELPER
-- =============================================================

-- Who is calling and for which account. All-null result = not authenticated / unknown user.
CREATE OR REPLACE FUNCTION public.calendar_feed_ctx(OUT owner_id uuid, OUT member_id uuid, OUT can_manage boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tm record;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT t.id, t.account_owner_id, t.role, t.permissions, cr.permissions AS role_permissions
    INTO tm
  FROM public.team_members t
  LEFT JOIN public.custom_roles cr ON cr.id = t.custom_role_id
  WHERE t.user_id = auth.uid()
  LIMIT 1;

  IF FOUND THEN
    owner_id := tm.account_owner_id;
    member_id := tm.id;
    can_manage :=
      tm.role IN ('admin', 'owner')
      OR COALESCE(tm.permissions ->> 'can_manage_team', 'false') = 'true'
      OR COALESCE(tm.role_permissions ->> 'can_manage_team', 'false') = 'true';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()) THEN
    owner_id := auth.uid();
    can_manage := true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.calendar_feed_ctx() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calendar_feed_ctx() TO authenticated;

-- =============================================================
-- TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.calendar_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,   -- account owner
  scope text NOT NULL CHECK (scope IN ('business', 'technician')),
  team_member_id uuid REFERENCES public.team_members(id) ON DELETE CASCADE,
  token text NOT NULL
    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  enabled boolean NOT NULL DEFAULT true,
  detail_level text NOT NULL DEFAULT 'full' CHECK (detail_level IN ('full', 'busy')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  last_accessed_at timestamptz,
  access_count bigint NOT NULL DEFAULT 0,
  CONSTRAINT calendar_feeds_scope_member CHECK (
    (scope = 'business' AND team_member_id IS NULL) OR (scope = 'technician' AND team_member_id IS NOT NULL)
  ),
  CONSTRAINT calendar_feeds_token_format CHECK (token ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_feeds_token ON public.calendar_feeds (token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_feeds_business ON public.calendar_feeds (user_id) WHERE scope = 'business';
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_feeds_technician ON public.calendar_feeds (user_id, team_member_id) WHERE scope = 'technician';
CREATE INDEX IF NOT EXISTS idx_calendar_feeds_member ON public.calendar_feeds (team_member_id) WHERE team_member_id IS NOT NULL;

ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.calendar_feeds FROM anon, authenticated;
GRANT SELECT ON public.calendar_feeds TO authenticated;

DROP POLICY IF EXISTS "calendar_feeds_select" ON public.calendar_feeds;
CREATE POLICY "calendar_feeds_select"
ON public.calendar_feeds FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.calendar_feed_ctx() c
    WHERE c.owner_id = calendar_feeds.user_id
      AND (c.can_manage OR (calendar_feeds.team_member_id IS NOT NULL AND c.member_id = calendar_feeds.team_member_id))
  )
);

-- =============================================================
-- RPCs (the ONLY write path)
-- =============================================================

-- Loads + locks a feed the caller is allowed to manage, or raises 42501 / P0002.
CREATE OR REPLACE FUNCTION public.calendar_feed_authorize(p_feed_id uuid)
RETURNS public.calendar_feeds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  f public.calendar_feeds%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO f FROM public.calendar_feeds WHERE id = p_feed_id AND user_id = c.owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'feed_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (c.can_manage OR (f.team_member_id IS NOT NULL AND f.team_member_id = c.member_id)) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN f;
END;
$$;

REVOKE ALL ON FUNCTION public.calendar_feed_authorize(uuid) FROM PUBLIC;

-- One round trip for the whole page: caller role, roster (managers only) and the feeds they may see.
CREATE OR REPLACE FUNCTION public.calendar_feed_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'can_manage', c.can_manage,
    'my_member_id', c.member_id,
    'members', CASE WHEN c.can_manage THEN COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', t.id, 'name', t.member_name, 'email', t.member_email, 'role', t.role)
        ORDER BY lower(COALESCE(NULLIF(t.member_name, ''), t.member_email))
      )
      FROM public.team_members t
      WHERE t.account_owner_id = c.owner_id
    ), '[]'::jsonb) ELSE '[]'::jsonb END,
    'feeds', COALESCE((
      SELECT jsonb_agg(to_jsonb(f) ORDER BY f.scope, f.created_at)
      FROM public.calendar_feeds f
      WHERE f.user_id = c.owner_id
        AND (c.can_manage OR (f.team_member_id IS NOT NULL AND f.team_member_id = c.member_id))
    ), '[]'::jsonb)
  );
END;
$$;

-- Creates the feed on first use, returns the existing one afterwards (idempotent).
CREATE OR REPLACE FUNCTION public.calendar_feed_ensure(p_scope text, p_member_id uuid DEFAULT NULL)
RETURNS public.calendar_feeds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  f public.calendar_feeds%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_scope = 'business' THEN
    IF NOT c.can_manage OR p_member_id IS NOT NULL THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
    END IF;
  ELSIF p_scope = 'technician' THEN
    IF p_member_id IS NULL THEN
      RAISE EXCEPTION 'member_required' USING ERRCODE = '22023';
    END IF;
    IF NOT (c.can_manage OR p_member_id = c.member_id) THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.team_members t WHERE t.id = p_member_id AND t.account_owner_id = c.owner_id) THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_scope' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO f FROM public.calendar_feeds
  WHERE user_id = c.owner_id AND scope = p_scope AND team_member_id IS NOT DISTINCT FROM p_member_id;
  IF FOUND THEN
    RETURN f;
  END IF;

  BEGIN
    INSERT INTO public.calendar_feeds (user_id, scope, team_member_id)
    VALUES (c.owner_id, p_scope, p_member_id)
    RETURNING * INTO f;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO f FROM public.calendar_feeds
    WHERE user_id = c.owner_id AND scope = p_scope AND team_member_id IS NOT DISTINCT FROM p_member_id;
  END;
  RETURN f;
END;
$$;

-- Swaps the token in place: the old URL stops working immediately. Usage stats reset so
-- the page can show when the NEW link is first fetched.
CREATE OR REPLACE FUNCTION public.calendar_feed_regenerate(p_feed_id uuid)
RETURNS public.calendar_feeds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.calendar_feeds%ROWTYPE;
BEGIN
  f := public.calendar_feed_authorize(p_feed_id);

  UPDATE public.calendar_feeds
  SET token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      rotated_at = now(),
      last_accessed_at = NULL,
      access_count = 0
  WHERE id = f.id
  RETURNING * INTO f;
  RETURN f;
END;
$$;

-- Pause/resume and privacy level. NULL arguments leave the field unchanged.
CREATE OR REPLACE FUNCTION public.calendar_feed_update(p_feed_id uuid, p_enabled boolean DEFAULT NULL, p_detail_level text DEFAULT NULL)
RETURNS public.calendar_feeds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.calendar_feeds%ROWTYPE;
BEGIN
  IF p_detail_level IS NOT NULL AND p_detail_level NOT IN ('full', 'busy') THEN
    RAISE EXCEPTION 'invalid_detail_level' USING ERRCODE = '22023';
  END IF;
  f := public.calendar_feed_authorize(p_feed_id);

  UPDATE public.calendar_feeds
  SET enabled = COALESCE(p_enabled, enabled),
      detail_level = COALESCE(p_detail_level, detail_level)
  WHERE id = f.id
  RETURNING * INTO f;
  RETURN f;
END;
$$;

REVOKE ALL ON FUNCTION public.calendar_feed_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calendar_feed_ensure(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calendar_feed_regenerate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calendar_feed_update(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calendar_feed_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_feed_ensure(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_feed_regenerate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_feed_update(uuid, boolean, text) TO authenticated;
