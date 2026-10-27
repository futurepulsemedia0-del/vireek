/*
  # Technician location privacy — off-duty tracking off, consent log, per-role visibility

  ## What this adds
  1. `location_privacy_policies`  one row per account (owner) with the switches.
  2. `location_visibility_rules`  per-role visibility: none | current | full.
  3. `location_consent_log`       append-only evidence of every grant / revoke.
  4. Gate + filter functions the ingest path calls so off-duty / unconsented
     points are never stored:
       location_tracking_gate(member, at)      -> allowed | no_consent | off_duty
       filter_location_points(member, points)  -> jsonb array of allowed points
  5. RESTRICTIVE select policies on vehicle_live_state, vehicle_position_log and
     vehicle_telemetry_pings, so per-role visibility is enforced by the database
     (and cannot be bypassed by the UI). They only ever REMOVE rows from what the
     existing policies allow.

  ## Backwards compatible by design
  An account with no policy row behaves exactly as before: nobody is blocked,
  no consent is required and every account member keeps seeing locations.
  Nothing changes until an owner / manager saves the policy.

  ## Permissions
  Manage = owner OR can_manage_team (custom role overrides member flags, same
  rule as expenses). Account owner always sees everything. A technician always
  sees their own assigned vehicle.
  Writes only via SECURITY DEFINER RPCs; no client INSERT/UPDATE/DELETE policies.
*/

-- =============================================================
-- 1) Helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.location_privacy_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    coalesce(auth.uid() = public.get_account_owner_id(), false)
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND coalesce(cr.permissions ->> 'can_manage_team', tm.permissions ->> 'can_manage_team', 'false') = 'true'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.location_privacy_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.location_privacy_can_manage() TO authenticated;

-- The caller's own team_members.id inside the current account (NULL for the owner).
CREATE OR REPLACE FUNCTION public.location_my_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.id
  FROM team_members tm
  WHERE tm.user_id = auth.uid()
    AND tm.account_owner_id = public.get_account_owner_id()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.location_my_member_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.location_my_member_id() TO authenticated;

-- =============================================================
-- 2) Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS location_privacy_policies (
  user_id uuid PRIMARY KEY,                       -- account owner
  track_only_on_shift boolean NOT NULL DEFAULT false,
  require_consent boolean NOT NULL DEFAULT false,
  notice_version integer NOT NULL DEFAULT 1 CHECK (notice_version >= 1),
  notice_bumped_at timestamptz NOT NULL DEFAULT now(),
  default_visibility text NOT NULL DEFAULT 'full' CHECK (default_visibility IN ('none', 'current', 'full')),
  hide_vehicle_off_duty boolean NOT NULL DEFAULT false,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE location_privacy_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_location_privacy_policies" ON location_privacy_policies;
CREATE POLICY "select_location_privacy_policies" ON location_privacy_policies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS location_visibility_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role_kind text NOT NULL CHECK (role_kind IN ('base_role', 'custom_role')),
  role_key text NOT NULL CHECK (char_length(btrim(role_key)) BETWEEN 1 AND 80),
  level text NOT NULL CHECK (level IN ('none', 'current', 'full')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_kind, role_key)
);

CREATE INDEX IF NOT EXISTS idx_location_visibility_rules_user ON location_visibility_rules(user_id);

ALTER TABLE location_visibility_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_location_visibility_rules" ON location_visibility_rules;
CREATE POLICY "select_location_visibility_rules" ON location_visibility_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.location_privacy_can_manage());

CREATE TABLE IF NOT EXISTS location_consent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                          -- account owner
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  member_email text NOT NULL,                     -- snapshot: evidence outlives the member row
  member_name text,
  action text NOT NULL CHECK (action IN ('granted', 'revoked')),
  notice_version integer NOT NULL CHECK (notice_version >= 1),
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'web')),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_location_consent_member_time ON location_consent_log(team_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_location_consent_owner_time ON location_consent_log(user_id, created_at DESC);

-- Append-only: rows can never be edited or deleted. The single exception is the
-- ON DELETE SET NULL that detaches a removed team member from its history.
CREATE OR REPLACE FUNCTION public.location_consent_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The location consent log is append-only';
  END IF;
  IF NEW.team_member_id IS NOT NULL
     OR (to_jsonb(NEW) - 'team_member_id') IS DISTINCT FROM (to_jsonb(OLD) - 'team_member_id') THEN
    RAISE EXCEPTION 'The location consent log is append-only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_location_consent_log_immutable ON location_consent_log;
CREATE TRIGGER trg_location_consent_log_immutable
  BEFORE UPDATE OR DELETE ON location_consent_log
  FOR EACH ROW EXECUTE FUNCTION public.location_consent_log_immutable();

ALTER TABLE location_consent_log ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON location_privacy_policies, location_visibility_rules, location_consent_log FROM anon, authenticated;

DROP POLICY IF EXISTS "select_location_consent_log" ON location_consent_log;
CREATE POLICY "select_location_consent_log" ON location_consent_log FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.location_privacy_can_manage() OR team_member_id = public.location_my_member_id())
  );

-- =============================================================
-- 3) Gate + filter (called by the ingest path)
-- =============================================================

-- allowed | no_consent | off_duty — evaluated AS OF p_at so points captured offline
-- and synced later are judged by the situation when they were recorded.
CREATE OR REPLACE FUNCTION public.location_tracking_gate(p_member uuid, p_at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_policy location_privacy_policies%ROWTYPE;
  v_consent location_consent_log%ROWTYPE;
  v_at timestamptz := coalesce(p_at, now());
BEGIN
  SELECT account_owner_id INTO v_owner FROM team_members WHERE id = p_member;
  IF v_owner IS NULL THEN RETURN 'allowed'; END IF;                -- not a team member (e.g. owner device)

  -- Signed-in callers may only probe members of their own account.
  IF auth.uid() IS NOT NULL AND v_owner IS DISTINCT FROM public.get_account_owner_id() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_policy FROM location_privacy_policies WHERE user_id = v_owner;
  IF NOT FOUND THEN RETURN 'allowed'; END IF;                      -- unconfigured account: unchanged behaviour

  IF v_policy.require_consent THEN
    SELECT * INTO v_consent FROM location_consent_log
      WHERE team_member_id = p_member AND created_at <= v_at
      ORDER BY created_at DESC, id DESC LIMIT 1;
    IF NOT FOUND OR v_consent.action <> 'granted' THEN RETURN 'no_consent'; END IF;
    -- After a notice bump, new points need consent to the new notice.
    IF v_at >= v_policy.notice_bumped_at AND v_consent.notice_version < v_policy.notice_version THEN
      RETURN 'no_consent';
    END IF;
  END IF;

  IF v_policy.track_only_on_shift AND NOT EXISTS (
    SELECT 1 FROM time_shifts s
    WHERE s.team_member_id = p_member
      AND s.clock_in_at <= v_at
      AND (s.clock_out_at IS NULL OR s.clock_out_at >= v_at)
  ) THEN
    RETURN 'off_duty';
  END IF;

  RETURN 'allowed';
END;
$$;

REVOKE ALL ON FUNCTION public.location_tracking_gate(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.location_tracking_gate(uuid, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._location_point_ts(p_point jsonb)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF jsonb_typeof(p_point -> 'recorded_at') = 'number' THEN
    RETURN to_timestamp((p_point ->> 'recorded_at')::double precision / 1000.0);   -- client sends epoch ms
  ELSIF jsonb_typeof(p_point -> 'recorded_at') = 'string' THEN
    RETURN (p_point ->> 'recorded_at')::timestamptz;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Drop every point the gate refuses. Hook this into the ingest path:
--   v_points := public.filter_location_points(v_member_id, v_points);
CREATE OR REPLACE FUNCTION public.filter_location_points(p_member uuid, p_points jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_points IS NULL OR jsonb_typeof(p_points) <> 'array' THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(pt ORDER BY ord)
    FROM jsonb_array_elements(p_points) WITH ORDINALITY AS t(pt, ord)
    WHERE public.location_tracking_gate(p_member, coalesce(public._location_point_ts(pt), now())) = 'allowed'
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.filter_location_points(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.filter_location_points(uuid, jsonb) TO authenticated, service_role;

-- =============================================================
-- 4) Visibility resolution + restrictive row policies
-- =============================================================

-- Effective level for a viewer: owner -> full; else custom-role rule, base-role rule,
-- then the account default. No policy row -> full (legacy behaviour).
CREATE OR REPLACE FUNCTION public.location_visibility_level(p_uid uuid DEFAULT auth.uid())
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_tm team_members%ROWTYPE;
  v_policy location_privacy_policies%ROWTYPE;
  v_level text;
BEGIN
  IF p_uid IS NULL THEN RETURN 'none'; END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = p_uid) THEN RETURN 'full'; END IF;

  SELECT * INTO v_tm FROM team_members WHERE user_id = p_uid ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  v_owner := v_tm.account_owner_id;

  SELECT * INTO v_policy FROM location_privacy_policies WHERE user_id = v_owner;
  IF NOT FOUND THEN RETURN 'full'; END IF;

  IF v_tm.custom_role_id IS NOT NULL THEN
    SELECT level INTO v_level FROM location_visibility_rules
      WHERE user_id = v_owner AND role_kind = 'custom_role' AND role_key = v_tm.custom_role_id::text;
  END IF;
  IF v_level IS NULL THEN
    SELECT level INTO v_level FROM location_visibility_rules
      WHERE user_id = v_owner AND role_kind = 'base_role' AND role_key = v_tm.role;
  END IF;
  RETURN coalesce(v_level, v_policy.default_visibility);
END;
$$;

REVOKE ALL ON FUNCTION public.location_visibility_level(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.location_visibility_level(uuid) TO authenticated;

-- Row-level check used by the restrictive policies.
CREATE OR REPLACE FUNCTION public.location_can_view_vehicle(p_vehicle uuid, p_need_history boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_level text;
  v_me uuid;
  v_assigned uuid;
  v_hide boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_uid) THEN RETURN true; END IF;     -- owner sees all

  v_level := public.location_visibility_level(v_uid);

  SELECT va.technician_id INTO v_assigned
    FROM vehicle_assignments va WHERE va.vehicle_id = p_vehicle AND va.unassigned_at IS NULL LIMIT 1;

  -- A technician always sees their own vehicle.
  IF v_assigned IS NOT NULL THEN
    SELECT tm.id INTO v_me FROM team_members tm WHERE tm.user_id = v_uid LIMIT 1;
    IF v_me IS NOT DISTINCT FROM v_assigned THEN RETURN true; END IF;
  END IF;

  IF v_level = 'none' THEN RETURN false; END IF;
  IF p_need_history AND v_level <> 'full' THEN RETURN false; END IF;

  -- Optional: hide the vehicle of a technician who is off duty.
  SELECT p.hide_vehicle_off_duty INTO v_hide
    FROM location_privacy_policies p
    JOIN team_members tm ON tm.account_owner_id = p.user_id AND tm.user_id = v_uid
    LIMIT 1;
  IF coalesce(v_hide, false) AND v_assigned IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM time_shifts s WHERE s.team_member_id = v_assigned AND s.status = 'open'
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.location_can_view_vehicle(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.location_can_view_vehicle(uuid, boolean) TO authenticated;

-- RESTRICTIVE policies are AND-ed with the existing permissive ones: they can only hide rows.
DROP POLICY IF EXISTS "location_privacy_live_state" ON vehicle_live_state;
CREATE POLICY "location_privacy_live_state" ON vehicle_live_state AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.location_can_view_vehicle(vehicle_id, false));

DROP POLICY IF EXISTS "location_privacy_position_log" ON vehicle_position_log;
CREATE POLICY "location_privacy_position_log" ON vehicle_position_log AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.location_can_view_vehicle(vehicle_id, true));

DROP POLICY IF EXISTS "location_privacy_telemetry_pings" ON vehicle_telemetry_pings;
CREATE POLICY "location_privacy_telemetry_pings" ON vehicle_telemetry_pings AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.location_can_view_vehicle(vehicle_id, true));

-- =============================================================
-- 5) RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_location_privacy()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_policy location_privacy_policies%ROWTYPE;
  v_rules jsonb;
  v_roles jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to manage location privacy' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_policy FROM location_privacy_policies WHERE user_id = v_owner;

  SELECT coalesce(jsonb_agg(jsonb_build_object('role_kind', role_kind, 'role_key', role_key, 'level', level) ORDER BY role_kind, role_key), '[]'::jsonb)
    INTO v_rules FROM location_visibility_rules WHERE user_id = v_owner;

  -- Every role that exists on this account, so the UI can show a row for each.
  SELECT coalesce(jsonb_agg(r ORDER BY r ->> 'kind', r ->> 'label'), '[]'::jsonb) INTO v_roles FROM (
    SELECT jsonb_build_object('kind', 'base_role', 'key', tm.role, 'label', tm.role) AS r
      FROM team_members tm WHERE tm.account_owner_id = v_owner GROUP BY tm.role
    UNION ALL
    SELECT jsonb_build_object('kind', 'custom_role', 'key', cr.id::text, 'label', cr.name)
      FROM custom_roles cr WHERE cr.user_id = v_owner
  ) x;

  RETURN jsonb_build_object(
    'configured', v_policy.user_id IS NOT NULL,
    'track_only_on_shift', coalesce(v_policy.track_only_on_shift, false),
    'require_consent', coalesce(v_policy.require_consent, false),
    'notice_version', coalesce(v_policy.notice_version, 1),
    'default_visibility', coalesce(v_policy.default_visibility, 'full'),
    'hide_vehicle_off_duty', coalesce(v_policy.hide_vehicle_off_duty, false),
    'rules', v_rules,
    'roles', v_roles
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_location_privacy() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_location_privacy() TO authenticated;

CREATE OR REPLACE FUNCTION public.save_location_privacy(
  p_track_only_on_shift boolean,
  p_require_consent boolean,
  p_default_visibility text,
  p_hide_vehicle_off_duty boolean,
  p_rules jsonb DEFAULT '[]'::jsonb,
  p_bump_notice boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rules jsonb := coalesce(p_rules, '[]'::jsonb);
  r jsonb;
  v_kind text;
  v_key text;
  v_level text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to manage location privacy' USING ERRCODE = '42501';
  END IF;
  IF p_default_visibility IS NULL OR p_default_visibility NOT IN ('none', 'current', 'full') THEN
    RAISE EXCEPTION 'Choose a default visibility';
  END IF;
  IF jsonb_typeof(v_rules) <> 'array' OR jsonb_array_length(v_rules) > 200 THEN
    RAISE EXCEPTION 'Invalid role rules';
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(v_rules) LOOP
    v_kind := r ->> 'role_kind';
    v_key := btrim(coalesce(r ->> 'role_key', ''));
    v_level := r ->> 'level';
    IF v_kind NOT IN ('base_role', 'custom_role') OR char_length(v_key) NOT BETWEEN 1 AND 80
       OR v_level NOT IN ('none', 'current', 'full') THEN
      RAISE EXCEPTION 'Invalid role rule';
    END IF;
    IF v_kind = 'custom_role' AND NOT EXISTS (
      SELECT 1 FROM custom_roles WHERE id::text = v_key AND user_id = v_owner
    ) THEN
      RAISE EXCEPTION 'A selected role was not found';
    END IF;
  END LOOP;

  INSERT INTO location_privacy_policies AS p (user_id, track_only_on_shift, require_consent, default_visibility, hide_vehicle_off_duty, updated_by)
  VALUES (v_owner, coalesce(p_track_only_on_shift, false), coalesce(p_require_consent, false), p_default_visibility,
          coalesce(p_hide_vehicle_off_duty, false), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    track_only_on_shift = EXCLUDED.track_only_on_shift,
    require_consent = EXCLUDED.require_consent,
    default_visibility = EXCLUDED.default_visibility,
    hide_vehicle_off_duty = EXCLUDED.hide_vehicle_off_duty,
    notice_version = CASE WHEN p_bump_notice THEN p.notice_version + 1 ELSE p.notice_version END,
    notice_bumped_at = CASE WHEN p_bump_notice THEN now() ELSE p.notice_bumped_at END,
    updated_by = auth.uid(),
    updated_at = now();

  -- Replace the rule set atomically (the UI always sends the full set).
  DELETE FROM location_visibility_rules WHERE user_id = v_owner;
  INSERT INTO location_visibility_rules (user_id, role_kind, role_key, level, updated_by)
  SELECT DISTINCT ON (x ->> 'role_kind', btrim(x ->> 'role_key'))
         v_owner, x ->> 'role_kind', btrim(x ->> 'role_key'), x ->> 'level', auth.uid()
  FROM jsonb_array_elements(v_rules) x
  ORDER BY x ->> 'role_kind', btrim(x ->> 'role_key');

  PERFORM public.log_audit_event(v_owner, 'location_privacy_updated', 'location_privacy_policies', v_owner::text);
END;
$$;

REVOKE ALL ON FUNCTION public.save_location_privacy(boolean, boolean, text, boolean, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_location_privacy(boolean, boolean, text, boolean, jsonb, boolean) TO authenticated;

-- Technician-side: record a grant / revoke. Idempotent (offline retries are safe).
CREATE OR REPLACE FUNCTION public.record_location_consent(
  p_action text,
  p_source text DEFAULT 'app',
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_tm team_members%ROWTYPE;
  v_version integer;
  v_last location_consent_log%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('granted', 'revoked') THEN RAISE EXCEPTION 'Invalid consent action'; END IF;
  IF coalesce(p_source, 'app') NOT IN ('app', 'web') THEN RAISE EXCEPTION 'Invalid consent source'; END IF;

  SELECT * INTO v_tm FROM team_members WHERE user_id = v_uid AND account_owner_id = v_owner LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only team members record location consent'; END IF;

  SELECT notice_version INTO v_version FROM location_privacy_policies WHERE user_id = v_owner;
  v_version := coalesce(v_version, 1);

  SELECT * INTO v_last FROM location_consent_log
    WHERE team_member_id = v_tm.id ORDER BY created_at DESC, id DESC LIMIT 1;
  IF FOUND AND v_last.action = p_action AND v_last.notice_version = v_version THEN
    RETURN v_last.id;                                              -- already recorded
  END IF;

  INSERT INTO location_consent_log (user_id, team_member_id, member_email, member_name, action, notice_version, source, user_agent, recorded_by)
  VALUES (v_owner, v_tm.id, v_tm.member_email, v_tm.member_name, p_action, v_version, coalesce(p_source, 'app'),
          left(nullif(btrim(coalesce(p_user_agent, '')), ''), 300), v_uid)
  RETURNING id INTO v_id;

  PERFORM public.log_audit_event(v_owner, 'location_consent_' || p_action, 'location_consent_log', v_id::text);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_location_consent(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_location_consent(text, text, text) TO authenticated;

-- Technician-side: may I be tracked right now? Drives the app toggle and the client gate.
CREATE OR REPLACE FUNCTION public.get_my_location_tracking_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_me uuid := public.location_my_member_id();
  v_policy location_privacy_policies%ROWTYPE;
  v_last location_consent_log%ROWTYPE;
  v_gate text;
  v_on_shift boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;

  SELECT * INTO v_policy FROM location_privacy_policies WHERE user_id = v_owner;

  IF v_me IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'allowed', 'on_shift', false, 'consent_current', true,
      'requires_consent', false, 'track_only_on_shift', false, 'notice_version', coalesce(v_policy.notice_version, 1));
  END IF;

  v_gate := public.location_tracking_gate(v_me, now());
  SELECT EXISTS (SELECT 1 FROM time_shifts s WHERE s.team_member_id = v_me AND s.status = 'open') INTO v_on_shift;
  SELECT * INTO v_last FROM location_consent_log WHERE team_member_id = v_me ORDER BY created_at DESC, id DESC LIMIT 1;

  RETURN jsonb_build_object(
    'allowed', v_gate = 'allowed',
    'reason', v_gate,
    'on_shift', v_on_shift,
    'consent_current', FOUND AND v_last.action = 'granted' AND v_last.notice_version >= coalesce(v_policy.notice_version, 1),
    'requires_consent', coalesce(v_policy.require_consent, false),
    'track_only_on_shift', coalesce(v_policy.track_only_on_shift, false),
    'notice_version', coalesce(v_policy.notice_version, 1)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_location_tracking_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_location_tracking_status() TO authenticated;

-- Manager-side overview: one row per technician with current consent + on-duty state.
CREATE OR REPLACE FUNCTION public.get_location_consent_overview()
RETURNS TABLE (
  team_member_id uuid,
  member_name text,
  member_email text,
  role text,
  consent_action text,
  consent_version integer,
  consent_at timestamptz,
  on_shift boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to manage location privacy' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT tm.id, tm.member_name, tm.member_email, tm.role,
         lc.action, lc.notice_version, lc.created_at,
         EXISTS (SELECT 1 FROM time_shifts s WHERE s.team_member_id = tm.id AND s.status = 'open')
  FROM team_members tm
  LEFT JOIN LATERAL (
    SELECT l.action, l.notice_version, l.created_at
    FROM location_consent_log l WHERE l.team_member_id = tm.id
    ORDER BY l.created_at DESC, l.id DESC LIMIT 1
  ) lc ON true
  WHERE tm.account_owner_id = v_owner
  ORDER BY tm.member_name NULLS LAST, tm.member_email;
END;
$$;

REVOKE ALL ON FUNCTION public.get_location_consent_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_location_consent_overview() TO authenticated;
