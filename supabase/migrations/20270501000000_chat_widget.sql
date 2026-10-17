/*
  # Website Chat Widget (per-account configuration + inbox)

  Lets each account configure and embed a live-chat widget on its OWN website.
  Touches no existing table. Requires: profiles, team_members, public.get_account_owner_id().

  ## Objects
  - chat_widget_settings          : one row per account (account_owner_id PK) - look, greeting, hours, routing, allowed domains.
  - chat_widget_messages          : visitor messages submitted from the embed. Written ONLY via submit_chat_widget_message().
  - chat_widget_can_manage()      : authenticated - owner/admin OR team member with can_edit_business_profile (same gate as the UI).
  - get_public_chat_widget_config : anon - safe public subset of settings for the embed script (+ install heartbeat).
  - submit_chat_widget_message    : anon - validated, rate-limited visitor message insert.
  - rotate_chat_widget_key        : authenticated manager - issue a new public key (old snippet stops working).

  ## Security notes
  - The public key identifies the account; it is NOT a secret (it ships in page source). Abuse is bounded by
    allowed_domains (best-effort: host is client supplied), per-key rate limit and strict input validation.
  - Anonymous users have no table access at all; only the two SECURITY DEFINER RPCs.
*/

-- 1) Settings ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_widget_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  public_key text NOT NULL UNIQUE DEFAULT ('cw_' || encode(gen_random_bytes(16), 'hex')),
  enabled boolean NOT NULL DEFAULT false,
  brand_color text NOT NULL DEFAULT '#3448E8',
  position text NOT NULL DEFAULT 'right',
  theme text NOT NULL DEFAULT 'auto',
  title text NOT NULL DEFAULT 'Chat with us',
  greeting text NOT NULL DEFAULT 'Hi! How can we help you today?',
  offline_message text NOT NULL DEFAULT 'We are offline right now. Leave a message and we will get back to you.',
  hours_mode text NOT NULL DEFAULT 'always',
  timezone text NOT NULL DEFAULT 'America/New_York',
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  routing_mode text NOT NULL DEFAULT 'team_inbox',
  assigned_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  offline_behavior text NOT NULL DEFAULT 'collect_lead',
  contact_field text NOT NULL DEFAULT 'email',
  allowed_domains text[] NOT NULL DEFAULT '{}',
  last_seen_at timestamptz,
  last_seen_host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cws_color_check CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT cws_position_check CHECK (position IN ('left', 'right')),
  CONSTRAINT cws_theme_check CHECK (theme IN ('light', 'dark', 'auto')),
  CONSTRAINT cws_title_check CHECK (char_length(title) BETWEEN 1 AND 60),
  CONSTRAINT cws_greeting_check CHECK (char_length(greeting) BETWEEN 1 AND 240),
  CONSTRAINT cws_offline_check CHECK (char_length(offline_message) BETWEEN 1 AND 240),
  CONSTRAINT cws_hours_check CHECK (hours_mode IN ('always', 'scheduled')),
  CONSTRAINT cws_routing_check CHECK (routing_mode IN ('team_inbox', 'assigned_member')),
  CONSTRAINT cws_assigned_check CHECK (routing_mode <> 'assigned_member' OR assigned_team_member_id IS NOT NULL),
  CONSTRAINT cws_offline_behavior_check CHECK (offline_behavior IN ('collect_lead', 'show_message', 'hide')),
  CONSTRAINT cws_contact_check CHECK (contact_field IN ('none', 'email', 'phone', 'either')),
  CONSTRAINT cws_domains_check CHECK (cardinality(allowed_domains) <= 20),
  CONSTRAINT cws_schedule_check CHECK (jsonb_typeof(schedule) = 'object')
);

ALTER TABLE chat_widget_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.chat_widget_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
      OR EXISTS (
        SELECT 1 FROM team_members m
        WHERE m.user_id = auth.uid()
          AND coalesce((m.permissions ->> 'can_edit_business_profile')::boolean, false)
      );
$$;
REVOKE ALL ON FUNCTION public.chat_widget_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_widget_can_manage() TO authenticated;

DROP POLICY IF EXISTS "cws_select" ON chat_widget_settings;
CREATE POLICY "cws_select" ON chat_widget_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "cws_insert" ON chat_widget_settings;
CREATE POLICY "cws_insert" ON chat_widget_settings FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.chat_widget_can_manage());

DROP POLICY IF EXISTS "cws_update" ON chat_widget_settings;
CREATE POLICY "cws_update" ON chat_widget_settings FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.chat_widget_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.chat_widget_can_manage());

-- public_key / last_seen_* are server-managed: block direct client writes to them.
CREATE OR REPLACE FUNCTION public.chat_widget_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' AND current_setting('vireek.cw_server_write', true) IS DISTINCT FROM '1' THEN
    NEW.public_key := OLD.public_key;
    NEW.last_seen_at := OLD.last_seen_at;
    NEW.last_seen_host := OLD.last_seen_host;
  END IF;
  IF NEW.assigned_team_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_members m WHERE m.id = NEW.assigned_team_member_id AND m.account_owner_id = NEW.account_owner_id
  ) THEN
    RAISE EXCEPTION 'CHAT_WIDGET_INVALID_ASSIGNEE: team member does not belong to this account';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_chat_widget_settings_guard ON chat_widget_settings;
CREATE TRIGGER trg_chat_widget_settings_guard BEFORE INSERT OR UPDATE ON chat_widget_settings
  FOR EACH ROW EXECUTE FUNCTION public.chat_widget_settings_guard();

-- 2) Messages ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_widget_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  assigned_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  visitor_name text,
  visitor_email text,
  visitor_phone text,
  body text NOT NULL,
  page_url text,
  host text,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cwm_body_check CHECK (char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT cwm_status_check CHECK (status IN ('new', 'read', 'archived'))
);
CREATE INDEX IF NOT EXISTS idx_cwm_account_created ON chat_widget_messages(account_owner_id, created_at DESC);

ALTER TABLE chat_widget_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cwm_select" ON chat_widget_messages;
CREATE POLICY "cwm_select" ON chat_widget_messages FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "cwm_update" ON chat_widget_messages;
CREATE POLICY "cwm_update" ON chat_widget_messages FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.chat_widget_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.chat_widget_can_manage());

-- 3) Shared host check ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_widget_host_allowed(p_allowed text[], p_host text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT cardinality(coalesce(p_allowed, '{}')) = 0
      OR EXISTS (
        SELECT 1 FROM unnest(p_allowed) d
        WHERE lower(coalesce(p_host, '')) = d OR lower(coalesce(p_host, '')) LIKE '%.' || d
      );
$$;

-- 4) Public config (anon) ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_chat_widget_config(p_key text, p_host text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s chat_widget_settings;
  v_host text := left(lower(nullif(trim(coalesce(p_host, '')), '')), 253);
BEGIN
  IF p_key IS NULL OR p_key !~ '^cw_[0-9a-f]{32}$' THEN RETURN NULL; END IF;

  SELECT * INTO s FROM chat_widget_settings WHERE public_key = p_key AND enabled;
  IF NOT FOUND OR NOT public.chat_widget_host_allowed(s.allowed_domains, v_host) THEN RETURN NULL; END IF;

  -- Install heartbeat, throttled to one write per 5 minutes per account.
  IF v_host IS NOT NULL AND (s.last_seen_at IS NULL OR s.last_seen_at < now() - interval '5 minutes' OR s.last_seen_host IS DISTINCT FROM v_host) THEN
    PERFORM set_config('vireek.cw_server_write', '1', true);
    UPDATE chat_widget_settings SET last_seen_at = now(), last_seen_host = v_host WHERE account_owner_id = s.account_owner_id;
  END IF;

  RETURN jsonb_build_object(
    'brand_color', s.brand_color,
    'position', s.position,
    'theme', s.theme,
    'title', s.title,
    'greeting', s.greeting,
    'offline_message', s.offline_message,
    'hours_mode', s.hours_mode,
    'timezone', s.timezone,
    'schedule', s.schedule,
    'offline_behavior', s.offline_behavior,
    'contact_field', s.contact_field,
    'business_name', (SELECT company_name FROM profiles WHERE id = s.account_owner_id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_chat_widget_config(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_chat_widget_config(text, text) TO anon, authenticated;

-- 5) Visitor message (anon) ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_chat_widget_message(
  p_key text, p_host text, p_name text, p_email text, p_phone text, p_body text, p_page_url text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s chat_widget_settings;
  v_body text := trim(coalesce(p_body, ''));
  v_email text := nullif(left(trim(coalesce(p_email, '')), 254), '');
  v_phone text := nullif(left(trim(coalesce(p_phone, '')), 40), '');
BEGIN
  IF p_key IS NULL OR p_key !~ '^cw_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'CHAT_WIDGET_INVALID'; END IF;
  SELECT * INTO s FROM chat_widget_settings WHERE public_key = p_key AND enabled;
  IF NOT FOUND OR NOT public.chat_widget_host_allowed(s.allowed_domains, p_host) THEN RAISE EXCEPTION 'CHAT_WIDGET_INVALID'; END IF;

  IF char_length(v_body) < 1 OR char_length(v_body) > 2000 THEN RAISE EXCEPTION 'CHAT_WIDGET_BAD_MESSAGE'; END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'CHAT_WIDGET_BAD_EMAIL'; END IF;
  IF s.contact_field = 'email' AND v_email IS NULL THEN RAISE EXCEPTION 'CHAT_WIDGET_CONTACT_REQUIRED'; END IF;
  IF s.contact_field = 'phone' AND v_phone IS NULL THEN RAISE EXCEPTION 'CHAT_WIDGET_CONTACT_REQUIRED'; END IF;
  IF s.contact_field = 'either' AND v_email IS NULL AND v_phone IS NULL THEN RAISE EXCEPTION 'CHAT_WIDGET_CONTACT_REQUIRED'; END IF;

  IF (SELECT count(*) FROM chat_widget_messages WHERE account_owner_id = s.account_owner_id AND created_at > now() - interval '10 minutes') >= 60 THEN
    RAISE EXCEPTION 'CHAT_WIDGET_RATE_LIMITED';
  END IF;

  INSERT INTO chat_widget_messages (account_owner_id, assigned_team_member_id, visitor_name, visitor_email, visitor_phone, body, page_url, host)
  VALUES (
    s.account_owner_id,
    CASE WHEN s.routing_mode = 'assigned_member' THEN s.assigned_team_member_id END,
    nullif(left(trim(coalesce(p_name, '')), 80), ''),
    v_email, v_phone, v_body,
    nullif(left(coalesce(p_page_url, ''), 500), ''),
    left(lower(nullif(trim(coalesce(p_host, '')), '')), 253)
  );
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_chat_widget_message(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_chat_widget_message(text, text, text, text, text, text, text) TO anon, authenticated;

-- 6) Key rotation --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotate_chat_widget_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_key text := 'cw_' || encode(gen_random_bytes(16), 'hex');
BEGIN
  IF v_owner IS NULL OR NOT public.chat_widget_can_manage() THEN RAISE EXCEPTION 'CHAT_WIDGET_FORBIDDEN'; END IF;
  PERFORM set_config('vireek.cw_server_write', '1', true);
  UPDATE chat_widget_settings SET public_key = v_key, last_seen_at = NULL, last_seen_host = NULL WHERE account_owner_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAT_WIDGET_NOT_CONFIGURED'; END IF;
  RETURN v_key;
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_chat_widget_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_chat_widget_key() TO authenticated;
