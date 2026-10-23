/*
  # Business phone system (PBX) on Twilio Voice

  Extensions, ring groups, ACD queues, schedules, shared lines, call parking,
  conferencing legs, voicemail, access-controlled recordings.

  Purely additive. Config tables: readable by every member of the account,
  writable only by pbx_can_manage() (owner/admin or can_manage_numbers).
  Runtime tables (calls/legs/parking/recordings/voicemails) are written ONLY by
  the edge functions (service role).
*/

-- =====================================================================
-- 0. Helpers
-- =====================================================================
CREATE OR REPLACE FUNCTION public.pbx_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.pbx_can_manage()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_manage_numbers', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_manage_numbers', 'false') = 'true'
        )
    );
$$;
REVOKE ALL ON FUNCTION public.pbx_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pbx_can_manage() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pbx_valid_destination(d jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT d IS NULL OR (
    jsonb_typeof(d) = 'object'
    AND d ->> 'type' IN ('extension', 'ring_group', 'queue', 'voicemail', 'ai', 'external', 'hangup')
    AND (d ->> 'type' NOT IN ('extension', 'ring_group', 'queue') OR (d ->> 'id') ~* '^[0-9a-f-]{36}$')
    AND (d ->> 'type' <> 'external' OR (d ->> 'number') ~ '^\+[1-9][0-9]{7,14}$')
  );
$$;

-- Rejects a row that points at another account's row (single-column FKs).
CREATE OR REPLACE FUNCTION public.pbx_assert_same_tenant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ref uuid; v_owner uuid;
BEGIN
  EXECUTE format('SELECT ($1).%I', TG_ARGV[0]) INTO v_ref USING NEW;
  IF v_ref IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT account_owner_id FROM public.%I WHERE id = $1', TG_ARGV[1]) INTO v_owner USING v_ref;
  IF v_owner IS DISTINCT FROM NEW.account_owner_id THEN
    RAISE EXCEPTION 'Cross-account reference rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- =====================================================================
-- 1. Configuration tables
-- =====================================================================
CREATE TABLE IF NOT EXISTS pbx_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/New_York',
  recording_mode text NOT NULL DEFAULT 'off' CHECK (recording_mode IN ('off', 'inbound', 'outbound', 'all')),
  recording_announcement boolean NOT NULL DEFAULT true,
  recording_retention_days integer NOT NULL DEFAULT 365 CHECK (recording_retention_days BETWEEN 7 AND 3650),
  default_hold_music_url text CHECK (default_hold_music_url IS NULL OR default_hold_music_url ~* '^https://'),
  voicemail_greeting text NOT NULL DEFAULT 'Please leave a message after the tone.' CHECK (char_length(voicemail_greeting) <= 500),
  voicemail_transcribe boolean NOT NULL DEFAULT true,
  park_timeout_seconds integer NOT NULL DEFAULT 120 CHECK (park_timeout_seconds BETWEEN 30 AND 900),
  outbound_country_codes text[] NOT NULL DEFAULT ARRAY['+1'],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pbx_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  timezone text NOT NULL DEFAULT 'America/New_York',
  -- {"mon":[["09:00","17:00"]], ...}; interval with start >= end wraps past midnight
  weekly jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(weekly) = 'object'),
  -- [{"date":"2027-12-24","closed":true} | {"date":"...","intervals":[["10:00","14:00"]]}]
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(exceptions) = 'array' AND jsonb_array_length(exceptions) <= 400),
  include_business_holidays boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_owner_id)
);

CREATE TABLE IF NOT EXISTS pbx_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  extension text NOT NULL CHECK (extension ~ '^[0-9]{2,6}$'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  presence text NOT NULL DEFAULT 'offline' CHECK (presence IN ('available', 'dnd', 'offline')),
  last_seen_at timestamptz,
  last_call_ended_at timestamptz,
  mobile_e164 text CHECK (mobile_e164 IS NULL OR mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ring_mobile boolean NOT NULL DEFAULT false,
  voicemail_enabled boolean NOT NULL DEFAULT true,
  voicemail_greeting text CHECK (voicemail_greeting IS NULL OR char_length(voicemail_greeting) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, extension),
  UNIQUE (id, account_owner_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pbx_extensions_user
  ON pbx_extensions (account_owner_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pbx_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  phone_number_id uuid NOT NULL UNIQUE REFERENCES phone_numbers(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  kind text NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'direct', 'shared')),
  schedule_id uuid REFERENCES pbx_schedules(id) ON DELETE SET NULL,
  open_destination jsonb NOT NULL CHECK (public.pbx_valid_destination(open_destination)),
  closed_destination jsonb NOT NULL DEFAULT '{"type":"voicemail"}'::jsonb
    CHECK (public.pbx_valid_destination(closed_destination)),
  -- Twilio-compatible voice webhook that hands the call to the AI receptionist (verify on a real call).
  ai_fallback_url text CHECK (ai_fallback_url IS NULL OR ai_fallback_url ~* '^https://'),
  allow_outbound boolean NOT NULL DEFAULT true,
  recording_override text CHECK (recording_override IS NULL OR recording_override IN ('off', 'inbound', 'outbound', 'all')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_owner_id)
);

ALTER TABLE pbx_extensions
  ADD COLUMN IF NOT EXISTS outbound_line_id uuid REFERENCES pbx_lines(id) ON DELETE SET NULL;

-- Shared line appearances + per-user caller ID permission.
CREATE TABLE IF NOT EXISTS pbx_line_members (
  line_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rings boolean NOT NULL DEFAULT true,
  can_dial_out boolean NOT NULL DEFAULT true,
  PRIMARY KEY (line_id, extension_id),
  FOREIGN KEY (line_id, account_owner_id) REFERENCES pbx_lines (id, account_owner_id) ON DELETE CASCADE,
  FOREIGN KEY (extension_id, account_owner_id) REFERENCES pbx_extensions (id, account_owner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pbx_ring_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  strategy text NOT NULL DEFAULT 'simultaneous'
    CHECK (strategy IN ('simultaneous', 'sequential', 'round_robin', 'longest_idle')),
  ring_seconds integer NOT NULL DEFAULT 20 CHECK (ring_seconds BETWEEN 5 AND 60),
  no_answer_destination jsonb NOT NULL DEFAULT '{"type":"voicemail"}'::jsonb
    CHECK (public.pbx_valid_destination(no_answer_destination)),
  rr_cursor integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_owner_id)
);

CREATE TABLE IF NOT EXISTS pbx_ring_group_members (
  group_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, extension_id),
  FOREIGN KEY (group_id, account_owner_id) REFERENCES pbx_ring_groups (id, account_owner_id) ON DELETE CASCADE,
  FOREIGN KEY (extension_id, account_owner_id) REFERENCES pbx_extensions (id, account_owner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pbx_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  strategy text NOT NULL DEFAULT 'ringall' CHECK (strategy IN ('ringall', 'longest_idle', 'round_robin')),
  ring_seconds integer NOT NULL DEFAULT 20 CHECK (ring_seconds BETWEEN 5 AND 60),
  hold_music_url text CHECK (hold_music_url IS NULL OR hold_music_url ~* '^https://'),
  announce_position boolean NOT NULL DEFAULT true,
  announce_wait boolean NOT NULL DEFAULT true,
  max_wait_seconds integer NOT NULL DEFAULT 600 CHECK (max_wait_seconds BETWEEN 30 AND 3600),
  max_size integer NOT NULL DEFAULT 50 CHECK (max_size BETWEEN 1 AND 500),
  wrap_up_seconds integer NOT NULL DEFAULT 15 CHECK (wrap_up_seconds BETWEEN 0 AND 300),
  service_level_seconds integer NOT NULL DEFAULT 20 CHECK (service_level_seconds BETWEEN 5 AND 600),
  overflow_destination jsonb NOT NULL DEFAULT '{"type":"voicemail"}'::jsonb
    CHECK (public.pbx_valid_destination(overflow_destination)),
  rr_cursor integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_owner_id)
);

CREATE TABLE IF NOT EXISTS pbx_queue_members (
  queue_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  PRIMARY KEY (queue_id, extension_id),
  FOREIGN KEY (queue_id, account_owner_id) REFERENCES pbx_queues (id, account_owner_id) ON DELETE CASCADE,
  FOREIGN KEY (extension_id, account_owner_id) REFERENCES pbx_extensions (id, account_owner_id) ON DELETE CASCADE
);

-- Tenant guards + updated_at
CREATE OR REPLACE FUNCTION public.pbx_line_phone_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.phone_numbers pn
    WHERE pn.id = NEW.phone_number_id AND pn.account_id = NEW.account_owner_id AND pn.status <> 'released'
  ) THEN
    RAISE EXCEPTION 'Phone number does not belong to this account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pbx_line_phone ON pbx_lines;
CREATE TRIGGER trg_pbx_line_phone BEFORE INSERT OR UPDATE OF phone_number_id ON pbx_lines
  FOR EACH ROW EXECUTE FUNCTION public.pbx_line_phone_guard();
DROP TRIGGER IF EXISTS trg_pbx_line_schedule ON pbx_lines;
CREATE TRIGGER trg_pbx_line_schedule BEFORE INSERT OR UPDATE OF schedule_id ON pbx_lines
  FOR EACH ROW EXECUTE FUNCTION public.pbx_assert_same_tenant('schedule_id', 'pbx_schedules');
DROP TRIGGER IF EXISTS trg_pbx_ext_line ON pbx_extensions;
CREATE TRIGGER trg_pbx_ext_line BEFORE INSERT OR UPDATE OF outbound_line_id ON pbx_extensions
  FOR EACH ROW EXECUTE FUNCTION public.pbx_assert_same_tenant('outbound_line_id', 'pbx_lines');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pbx_settings', 'pbx_schedules', 'pbx_extensions', 'pbx_lines', 'pbx_ring_groups', 'pbx_queues'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_touch ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.pbx_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- 2. Runtime tables (service-role writes only)
-- =====================================================================
CREATE TABLE IF NOT EXISTS pbx_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_sid text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  from_number text,
  to_number text,
  line_id uuid REFERENCES pbx_lines(id) ON DELETE SET NULL,
  extension_id uuid REFERENCES pbx_extensions(id) ON DELETE SET NULL,
  queue_id uuid REFERENCES pbx_queues(id) ON DELETE SET NULL,
  ring_group_id uuid REFERENCES pbx_ring_groups(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ringing' CHECK (status IN (
    'ringing', 'queued', 'in_progress', 'parked', 'completed', 'missed',
    'voicemail', 'abandoned', 'failed', 'ai_handled')),
  conference_name text NOT NULL UNIQUE,
  conference_sid text,
  dispatch jsonb NOT NULL DEFAULT '{}'::jsonb,
  recording_enabled boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  queue_entered_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  queue_wait_seconds integer,
  duration_seconds integer,
  calls_id uuid,                       -- row mirrored into the existing public.calls table
  UNIQUE (account_owner_id, call_sid),
  UNIQUE (id, account_owner_id)
);
CREATE INDEX IF NOT EXISTS idx_pbx_calls_recent ON pbx_calls (account_owner_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pbx_calls_queue ON pbx_calls (queue_id, status, queue_entered_at);

CREATE TABLE IF NOT EXISTS pbx_call_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  extension_id uuid REFERENCES pbx_extensions(id) ON DELETE SET NULL,
  call_sid text UNIQUE,
  role text NOT NULL CHECK (role IN ('customer', 'agent', 'consult')),
  target_number text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled')),
  round integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  FOREIGN KEY (call_id, account_owner_id) REFERENCES pbx_calls (id, account_owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pbx_legs_call ON pbx_call_legs (call_id);
CREATE INDEX IF NOT EXISTS idx_pbx_legs_ext ON pbx_call_legs (extension_id, status);

CREATE TABLE IF NOT EXISTS pbx_parking_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 20),
  call_id uuid NOT NULL UNIQUE REFERENCES pbx_calls(id) ON DELETE CASCADE,
  parked_by_extension_id uuid REFERENCES pbx_extensions(id) ON DELETE SET NULL,
  parked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ring_backs integer NOT NULL DEFAULT 0,
  UNIQUE (account_owner_id, slot)
);

-- =====================================================================
-- 3. Media: recordings, voicemails, access log
-- =====================================================================
CREATE TABLE IF NOT EXISTS pbx_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES pbx_calls(id) ON DELETE CASCADE,
  recording_sid text NOT NULL UNIQUE,
  storage_path text NOT NULL,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  size_bytes bigint,
  retention_until timestamptz NOT NULL,
  legal_hold boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbx_recordings_recent ON pbx_recordings (account_owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pbx_recording_grants (
  recording_id uuid NOT NULL REFERENCES pbx_recordings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, user_id)
);

CREATE TABLE IF NOT EXISTS pbx_voicemails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_id uuid REFERENCES pbx_calls(id) ON DELETE SET NULL,
  line_id uuid REFERENCES pbx_lines(id) ON DELETE SET NULL,
  mailbox_extension_id uuid REFERENCES pbx_extensions(id) ON DELETE SET NULL,  -- NULL = general mailbox (managers)
  caller_phone text,
  recording_sid text UNIQUE,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  storage_path text,
  transcript text CHECK (transcript IS NULL OR char_length(transcript) <= 20000),
  transcript_status text NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending', 'completed', 'failed', 'unavailable')),
  listened_at timestamptz,
  listened_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbx_voicemails_recent ON pbx_voicemails (account_owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pbx_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('recording', 'voicemail')),
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('play', 'grant', 'revoke', 'legal_hold')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbx_access_log_recent ON pbx_access_log (account_owner_id, created_at DESC);

-- Private bucket, NO storage policies: only the service role (edge functions) can touch objects.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('pbx-media', 'pbx-media', false, 104857600)
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- 4. Access functions + RLS
-- =====================================================================
CREATE OR REPLACE FUNCTION public.pbx_can_access_recording(p_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM pbx_recordings r
    WHERE r.id = p_recording_id AND r.deleted_at IS NULL
      AND r.account_owner_id = public.get_account_owner_id()
      AND (
        public.pbx_can_manage()
        OR EXISTS (
          SELECT 1 FROM pbx_calls c JOIN pbx_extensions e ON e.id = c.extension_id
          WHERE c.id = r.call_id AND e.user_id = auth.uid())
        OR EXISTS (
          SELECT 1 FROM pbx_recording_grants g
          WHERE g.recording_id = r.id AND g.user_id = auth.uid()
            AND (g.expires_at IS NULL OR g.expires_at > now()))
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.pbx_can_access_voicemail(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM pbx_voicemails v
    WHERE v.id = p_id AND v.deleted_at IS NULL
      AND v.account_owner_id = public.get_account_owner_id()
      AND (
        public.pbx_can_manage()
        OR EXISTS (SELECT 1 FROM pbx_extensions e WHERE e.id = v.mailbox_extension_id AND e.user_id = auth.uid())
      )
  );
$$;

DO $$
DECLARE t text;
BEGIN
  -- Config tables: members read, managers write.
  FOREACH t IN ARRAY ARRAY['pbx_settings', 'pbx_schedules', 'pbx_extensions', 'pbx_lines', 'pbx_line_members',
                           'pbx_ring_groups', 'pbx_ring_group_members', 'pbx_queues', 'pbx_queue_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id())', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (account_owner_id = public.get_account_owner_id() AND public.pbx_can_manage()) WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.pbx_can_manage())', t || '_write', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
  END LOOP;
  -- Runtime tables: members read, nobody writes through the API.
  FOREACH t IN ARRAY ARRAY['pbx_calls', 'pbx_call_legs', 'pbx_parking_slots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id())', t || '_select', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM authenticated', t);
  END LOOP;
END $$;

ALTER TABLE pbx_recordings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pbx_recordings_select ON pbx_recordings;
CREATE POLICY pbx_recordings_select ON pbx_recordings FOR SELECT TO authenticated
  USING (public.pbx_can_access_recording(id));
REVOKE ALL ON pbx_recordings FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pbx_recordings FROM authenticated;

ALTER TABLE pbx_recording_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pbx_grants_select ON pbx_recording_grants;
CREATE POLICY pbx_grants_select ON pbx_recording_grants FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (public.pbx_can_manage() AND EXISTS (
    SELECT 1 FROM pbx_recordings r WHERE r.id = recording_id AND r.account_owner_id = public.get_account_owner_id())));
REVOKE ALL ON pbx_recording_grants FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pbx_recording_grants FROM authenticated;

ALTER TABLE pbx_voicemails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pbx_voicemails_select ON pbx_voicemails;
CREATE POLICY pbx_voicemails_select ON pbx_voicemails FOR SELECT TO authenticated
  USING (public.pbx_can_access_voicemail(id));
REVOKE ALL ON pbx_voicemails FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pbx_voicemails FROM authenticated;

ALTER TABLE pbx_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pbx_access_log_select ON pbx_access_log;
CREATE POLICY pbx_access_log_select ON pbx_access_log FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.pbx_can_manage());
REVOKE ALL ON pbx_access_log FROM anon;
REVOKE INSERT, UPDATE, DELETE ON pbx_access_log FROM authenticated;

-- =====================================================================
-- 5. RPCs for signed-in users
-- =====================================================================
CREATE OR REPLACE FUNCTION public.pbx_set_presence(p_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_state NOT IN ('available', 'dnd', 'offline') THEN
    RAISE EXCEPTION 'Invalid presence' USING ERRCODE = '22023';
  END IF;
  UPDATE pbx_extensions SET presence = p_state, last_seen_at = now()
  WHERE user_id = auth.uid() AND account_owner_id = public.get_account_owner_id();
END $$;

-- Returns the storage path after authorising AND auditing the access.
CREATE OR REPLACE FUNCTION public.pbx_authorize_media(p_kind text, p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_path text;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_kind = 'recording' THEN
    IF NOT public.pbx_can_access_recording(p_id) THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
    SELECT storage_path INTO v_path FROM pbx_recordings WHERE id = p_id;
  ELSIF p_kind = 'voicemail' THEN
    IF NOT public.pbx_can_access_voicemail(p_id) THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
    SELECT storage_path INTO v_path FROM pbx_voicemails WHERE id = p_id;
    UPDATE pbx_voicemails
       SET listened_at = COALESCE(listened_at, now()), listened_by = COALESCE(listened_by, auth.uid())
     WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Unknown media kind' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL THEN RAISE EXCEPTION 'Media not available' USING ERRCODE = '02000'; END IF;
  INSERT INTO pbx_access_log (account_owner_id, user_id, target_type, target_id, action)
  VALUES (v_owner, auth.uid(), p_kind, p_id, 'play');
  RETURN v_path;
END $$;

CREATE OR REPLACE FUNCTION public.pbx_grant_recording(p_recording_id uuid, p_user_id uuid, p_expires_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.pbx_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pbx_recordings WHERE id = p_recording_id AND account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Recording not found' USING ERRCODE = '02000';
  END IF;
  INSERT INTO pbx_recording_grants (recording_id, user_id, granted_by, expires_at)
  VALUES (p_recording_id, p_user_id, auth.uid(), p_expires_at)
  ON CONFLICT (recording_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_by = auth.uid();
  INSERT INTO pbx_access_log (account_owner_id, user_id, target_type, target_id, action)
  VALUES (v_owner, auth.uid(), 'recording', p_recording_id, 'grant');
END $$;

CREATE OR REPLACE FUNCTION public.pbx_revoke_recording_grant(p_recording_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.pbx_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  DELETE FROM pbx_recording_grants g USING pbx_recordings r
   WHERE g.recording_id = p_recording_id AND g.user_id = p_user_id
     AND r.id = g.recording_id AND r.account_owner_id = v_owner;
  INSERT INTO pbx_access_log (account_owner_id, user_id, target_type, target_id, action)
  VALUES (v_owner, auth.uid(), 'recording', p_recording_id, 'revoke');
END $$;

CREATE OR REPLACE FUNCTION public.pbx_set_legal_hold(p_recording_id uuid, p_hold boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF NOT public.pbx_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE pbx_recordings SET legal_hold = p_hold WHERE id = p_recording_id AND account_owner_id = v_owner;
  INSERT INTO pbx_access_log (account_owner_id, user_id, target_type, target_id, action)
  VALUES (v_owner, auth.uid(), 'recording', p_recording_id, 'legal_hold');
END $$;

REVOKE ALL ON FUNCTION public.pbx_set_presence(text), public.pbx_authorize_media(text, uuid),
  public.pbx_grant_recording(uuid, uuid, timestamptz), public.pbx_revoke_recording_grant(uuid, uuid),
  public.pbx_set_legal_hold(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pbx_set_presence(text), public.pbx_authorize_media(text, uuid),
  public.pbx_grant_recording(uuid, uuid, timestamptz), public.pbx_revoke_recording_grant(uuid, uuid),
  public.pbx_set_legal_hold(uuid, boolean) TO authenticated;

-- =====================================================================
-- 6. Service-role-only functions (call engine)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.pbx_claim_call(p_call_id uuid, p_extension_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE pbx_calls
     SET status = 'in_progress', answered_at = now(),
         extension_id = COALESCE(p_extension_id, extension_id),
         queue_wait_seconds = CASE WHEN queue_entered_at IS NOT NULL
           THEN EXTRACT(EPOCH FROM (now() - queue_entered_at))::integer END
   WHERE id = p_call_id AND status IN ('ringing', 'queued');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

CREATE OR REPLACE FUNCTION public.pbx_available_extensions(p_owner uuid, p_ids uuid[], p_wrap_seconds integer DEFAULT 0)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id FROM pbx_extensions e
  WHERE e.account_owner_id = p_owner AND e.id = ANY (p_ids) AND e.presence = 'available'
    AND (e.last_call_ended_at IS NULL
         OR e.last_call_ended_at <= now() - make_interval(secs => GREATEST(p_wrap_seconds, 0)))
    AND NOT EXISTS (
      SELECT 1 FROM pbx_call_legs l
      WHERE l.extension_id = e.id AND l.status IN ('queued', 'ringing', 'in_progress')
        AND l.created_at > now() - interval '6 hours');
$$;

CREATE OR REPLACE FUNCTION public.pbx_park_call(p_call_id uuid, p_extension_id uuid, p_timeout integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid; v_slot integer;
BEGIN
  SELECT account_owner_id INTO v_owner FROM pbx_calls WHERE id = p_call_id AND status = 'in_progress' FOR UPDATE;
  IF v_owner IS NULL THEN RETURN NULL; END IF;
  FOR v_slot IN 1..20 LOOP
    BEGIN
      INSERT INTO pbx_parking_slots (account_owner_id, slot, call_id, parked_by_extension_id, expires_at)
      VALUES (v_owner, v_slot, p_call_id, p_extension_id, now() + make_interval(secs => p_timeout));
      UPDATE pbx_calls SET status = 'parked' WHERE id = p_call_id;
      RETURN v_slot;
    EXCEPTION WHEN unique_violation THEN CONTINUE;
    END;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.pbx_queue_stats(p_queue_id uuid)
RETURNS TABLE (waiting integer, avg_wait_seconds integer, avg_handle_seconds integer,
               agents_available integer, agents_total integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM pbx_calls c WHERE c.queue_id = p_queue_id AND c.status = 'queued'),
    COALESCE((SELECT avg(x.queue_wait_seconds)::integer FROM (
      SELECT c.queue_wait_seconds FROM pbx_calls c
      WHERE c.queue_id = p_queue_id AND c.queue_wait_seconds IS NOT NULL AND c.started_at > now() - interval '7 days'
      ORDER BY c.started_at DESC LIMIT 50) x), 0),
    COALESCE((SELECT avg(x.duration_seconds)::integer FROM (
      SELECT c.duration_seconds FROM pbx_calls c
      WHERE c.queue_id = p_queue_id AND c.status = 'completed' AND c.duration_seconds > 0
        AND c.started_at > now() - interval '7 days'
      ORDER BY c.started_at DESC LIMIT 50) x), 240),
    (SELECT count(*)::integer FROM pbx_queue_members m JOIN pbx_extensions e ON e.id = m.extension_id
      WHERE m.queue_id = p_queue_id AND NOT m.paused AND e.presence = 'available'),
    (SELECT count(*)::integer FROM pbx_queue_members m WHERE m.queue_id = p_queue_id AND NOT m.paused);
END $$;

REVOKE ALL ON FUNCTION public.pbx_claim_call(uuid, uuid), public.pbx_available_extensions(uuid, uuid[], integer),
  public.pbx_park_call(uuid, uuid, integer), public.pbx_queue_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pbx_claim_call(uuid, uuid), public.pbx_available_extensions(uuid, uuid[], integer),
  public.pbx_park_call(uuid, uuid, integer), public.pbx_queue_stats(uuid) TO service_role;

-- =====================================================================
-- 7. Realtime (live presence / call board)
-- =====================================================================
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.pbx_calls;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.pbx_extensions;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.pbx_parking_slots;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.pbx_voicemails;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;
