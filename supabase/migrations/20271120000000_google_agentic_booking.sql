/*
  # Google Agentic-Booking Readiness

  Additive + idempotent (safe to run twice). Touches NO existing function or table.

  1. google_booking_settings  per-account publish switches (feed / structured data), partner status, horizon
  2. google_booking_audit     who changed what
  3. gbp_sync_proposals       Google Business Profile changes that need OWNER APPROVAL before anything is sent
  4. get_google_feed_snapshot*  ONE atomic read (settings + capacity + busy jobs) the feed engine computes from
  5. get_google_structured_data  PII-free public data for schema.org JSON-LD (only if owner opted in)

  Security: RLS scoped with get_account_owner_id(); all writes via SECURITY DEFINER RPCs gated by
  can_manage_service_areas() (same real enforcement as service areas). The snapshot RPCs that take a slug
  are service_role only (the public feed edge function is the only caller).
*/

-- =============================================================
-- SETTINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS google_booking_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  feed_enabled boolean NOT NULL DEFAULT false,
  structured_data_enabled boolean NOT NULL DEFAULT false,
  partner_status text NOT NULL DEFAULT 'not_applied'
    CHECK (partner_status IN ('not_applied', 'applied', 'sandbox', 'approved')),
  horizon_days integer NOT NULL DEFAULT 14 CHECK (horizon_days BETWEEN 1 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE google_booking_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_google_booking_settings" ON google_booking_settings;
CREATE POLICY "select_google_booking_settings" ON google_booking_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS google_booking_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_google_booking_audit_user ON google_booking_audit (user_id, created_at DESC);
ALTER TABLE google_booking_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_google_booking_audit" ON google_booking_audit;
CREATE POLICY "select_google_booking_audit" ON google_booking_audit
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- GBP SYNC PROPOSALS (owner approval gate)
-- =============================================================
CREATE TABLE IF NOT EXISTS gbp_sync_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('services', 'service_areas')),
  desired jsonb NOT NULL,
  base_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'applying', 'applied', 'rejected', 'superseded', 'failed')),
  applied_via text CHECK (applied_via IS NULL OR applied_via IN ('api', 'manual')),
  decided_by uuid,
  decided_at timestamptz,
  applied_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gbp_sync_proposals_user ON gbp_sync_proposals (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_open_proposal
  ON gbp_sync_proposals (user_id, kind) WHERE status IN ('pending', 'approved', 'applying');

ALTER TABLE gbp_sync_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_gbp_sync_proposals" ON gbp_sync_proposals;
CREATE POLICY "select_gbp_sync_proposals" ON gbp_sync_proposals
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- INTERNAL: desired state for a proposal kind
-- =============================================================
CREATE OR REPLACE FUNCTION public.gbp_build_desired(p_user uuid, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  IF p_kind = 'services' THEN
    SELECT coalesce(jsonb_agg(s ORDER BY s), '[]'::jsonb) INTO v_out
    FROM (
      SELECT DISTINCT btrim(x) AS s
      FROM business_profile bp, unnest(coalesce(bp.services_offered, '{}'::text[])) AS x
      WHERE bp.user_id = p_user
        AND btrim(x) <> ''
        AND NOT (x = ANY (coalesce(bp.booking_hidden_services, '{}'::text[])))
    ) q;
  ELSIF p_kind = 'service_areas' THEN
    SELECT coalesce(jsonb_agg(
             jsonb_build_object('name', a.name, 'zone_type', a.zone_type, 'zip_codes', to_jsonb(a.zip_codes[1:50]))
             ORDER BY a.priority DESC, a.name), '[]'::jsonb) INTO v_out
    FROM service_areas a
    WHERE a.user_id = p_user AND a.is_active;
  ELSE
    RAISE EXCEPTION 'unknown_kind';
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.gbp_build_desired(uuid, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- SETTINGS RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_google_booking_settings()
RETURNS google_booking_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row google_booking_settings;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO google_booking_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM google_booking_settings WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_google_booking_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.update_google_booking_settings(
  p_feed_enabled boolean DEFAULT NULL,
  p_structured_data_enabled boolean DEFAULT NULL,
  p_partner_status text DEFAULT NULL,
  p_horizon_days integer DEFAULT NULL
)
RETURNS google_booking_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row google_booking_settings;
  bp business_profile%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;

  INSERT INTO google_booking_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;

  -- Never publish availability that cannot be verified: the feed can only be switched ON when the
  -- booking engine itself is on, the business timezone is a real timezone, and hours exist.
  IF p_feed_enabled IS TRUE THEN
    SELECT * INTO bp FROM business_profile WHERE user_id = v_owner;
    IF NOT FOUND OR NOT coalesce(bp.booking_enabled, false)
       OR bp.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = bp.timezone)
       OR coalesce(bp.booking_hours, bp.business_hours) IS NULL THEN
      RAISE EXCEPTION 'not_ready';
    END IF;
  END IF;

  UPDATE google_booking_settings SET
    feed_enabled = coalesce(p_feed_enabled, feed_enabled),
    structured_data_enabled = coalesce(p_structured_data_enabled, structured_data_enabled),
    partner_status = coalesce(p_partner_status, partner_status),
    horizon_days = coalesce(p_horizon_days, horizon_days),
    updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;

  INSERT INTO google_booking_audit (user_id, actor_id, event, detail)
  VALUES (v_owner, auth.uid(), 'settings_updated', jsonb_build_object(
    'feed_enabled', v_row.feed_enabled, 'structured_data_enabled', v_row.structured_data_enabled,
    'partner_status', v_row.partner_status, 'horizon_days', v_row.horizon_days));

  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_google_booking_settings(boolean, boolean, text, integer) TO authenticated;

-- =============================================================
-- FEED SNAPSHOT (one statement-consistent read; PII-free)
-- =============================================================
CREATE OR REPLACE FUNCTION public.google_feed_snapshot_internal(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bp business_profile%ROWTYPE;
  gs google_booking_settings%ROWTYPE;
  v_name text;
  v_tz_ok boolean := false;
  v_window integer;
  v_capacity integer;
  v_reserve integer := 1;
  v_full integer := 90;
  v_holidays jsonb := '[]'::jsonb;
  v_busy jsonb;
  v_load jsonb := '{}'::jsonb;
  v_services jsonb;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE user_id = p_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO gs FROM google_booking_settings WHERE user_id = p_user;
  SELECT company_name INTO v_name FROM profiles WHERE id = p_user;

  v_window := coalesce(bp.booking_window_days, 14);
  v_tz_ok := bp.timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = bp.timezone);

  IF jsonb_typeof(bp.holidays) = 'array' THEN
    SELECT coalesce(jsonb_agg(h ->> 'date'), '[]'::jsonb) INTO v_holidays
    FROM jsonb_array_elements(bp.holidays) h
    WHERE jsonb_typeof(h) = 'object' AND (h ->> 'date') IS NOT NULL;
  END IF;

  SELECT coalesce(SUM(max_jobs_per_day), 0) INTO v_capacity
  FROM team_members
  WHERE account_owner_id = p_user AND role = 'technician' AND dispatch_enabled = true;

  SELECT emergency_reserve_slots, full_threshold_pct INTO v_reserve, v_full
  FROM capacity_demand_policies WHERE user_id = p_user;
  v_reserve := coalesce(v_reserve, 1);
  v_full := coalesce(v_full, 90);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'start', j.scheduled_datetime, 'duration_minutes', coalesce(j.duration_minutes, 60))), '[]'::jsonb)
  INTO v_busy
  FROM jobs j
  WHERE j.user_id = p_user
    AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
    AND j.scheduled_datetime IS NOT NULL
    AND j.scheduled_datetime >= now() - interval '1 day'
    AND j.scheduled_datetime < now() + make_interval(days => v_window + 2);

  IF v_tz_ok THEN
    SELECT coalesce(jsonb_object_agg(d, c), '{}'::jsonb) INTO v_load
    FROM (
      SELECT to_char((j.scheduled_datetime AT TIME ZONE bp.timezone)::date, 'YYYY-MM-DD') AS d, count(*) AS c
      FROM jobs j
      WHERE j.user_id = p_user
        AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
        AND j.scheduled_datetime IS NOT NULL
        AND j.scheduled_datetime >= now() - interval '1 day'
        AND j.scheduled_datetime < now() + make_interval(days => v_window + 2)
      GROUP BY 1
    ) s;
  END IF;

  v_services := public.gbp_build_desired(p_user, 'services');

  RETURN jsonb_build_object(
    'generated_at', now(),
    'slug', bp.booking_slug,
    'business', jsonb_build_object(
      'name', v_name,
      'timezone', CASE WHEN v_tz_ok THEN bp.timezone END,
      'timezone_set', bp.timezone IS NOT NULL AND btrim(bp.timezone) <> '',
      'services', v_services),
    'settings', jsonb_build_object(
      'enabled', coalesce(bp.booking_enabled, false),
      'hours', coalesce(bp.booking_hours, bp.business_hours),
      'holidays', v_holidays,
      'duration_minutes', coalesce(bp.booking_default_duration_minutes, 60),
      'lead_time_hours', coalesce(bp.booking_lead_time_hours, 2),
      'window_days', v_window,
      'buffer_before', coalesce(bp.booking_buffer_before_minutes, 0),
      'buffer_after', coalesce(bp.booking_buffer_after_minutes, 0)),
    'capacity', jsonb_build_object(
      'technician_capacity', v_capacity, 'emergency_reserve', v_reserve, 'full_threshold_pct', v_full),
    'google', jsonb_build_object(
      'feed_enabled', coalesce(gs.feed_enabled, false),
      'structured_data_enabled', coalesce(gs.structured_data_enabled, false),
      'partner_status', coalesce(gs.partner_status, 'not_applied'),
      'horizon_days', coalesce(gs.horizon_days, 14)),
    'busy', v_busy,
    'load_by_day', v_load);
END;
$$;
REVOKE ALL ON FUNCTION public.google_feed_snapshot_internal(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_google_feed_snapshot(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM business_profile WHERE booking_slug = p_slug;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  RETURN public.google_feed_snapshot_internal(v_user);
END;
$$;
REVOKE ALL ON FUNCTION public.get_google_feed_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_google_feed_snapshot(text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_google_feed_snapshot_for_owner()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  RETURN public.google_feed_snapshot_internal(v_owner);
END;
$$;
REVOKE ALL ON FUNCTION public.get_google_feed_snapshot_for_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_google_feed_snapshot_for_owner() TO authenticated;

-- =============================================================
-- STRUCTURED DATA (public, PII-free, opt-in)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_google_structured_data(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bp business_profile%ROWTYPE;
  v_name text;
  v_areas jsonb;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE booking_slug = p_slug AND booking_enabled;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM google_booking_settings g WHERE g.user_id = bp.user_id AND g.structured_data_enabled
  ) THEN
    RETURN NULL;
  END IF;

  SELECT company_name INTO v_name FROM profiles WHERE id = bp.user_id;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RETURN NULL; END IF;

  v_areas := public.gbp_build_desired(bp.user_id, 'service_areas');

  RETURN jsonb_build_object(
    'name', v_name,
    'services', public.gbp_build_desired(bp.user_id, 'services'),
    'areas', (SELECT coalesce(jsonb_agg(a -> 'name'), '[]'::jsonb) FROM jsonb_array_elements(v_areas) a),
    'hours', coalesce(bp.booking_hours, bp.business_hours));
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_google_structured_data(text) TO anon, authenticated;

-- =============================================================
-- GBP PROPOSALS: propose -> approve -> apply
-- =============================================================
CREATE OR REPLACE FUNCTION public.gbp_propose_sync()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_kind text;
  v_desired jsonb;
  v_hash text;
  v_last text;
  v_results jsonb := '[]'::jsonb;
  v_result text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;

  FOREACH v_kind IN ARRAY ARRAY['services', 'service_areas'] LOOP
    v_desired := public.gbp_build_desired(v_owner, v_kind);
    v_hash := md5(v_desired::text);
    v_result := NULL;

    IF jsonb_array_length(v_desired) = 0 THEN
      v_result := 'empty';
    ELSE
      SELECT base_hash INTO v_last FROM gbp_sync_proposals
      WHERE user_id = v_owner AND kind = v_kind AND status = 'applied'
      ORDER BY applied_at DESC NULLS LAST LIMIT 1;

      IF v_last = v_hash THEN
        v_result := 'unchanged';
      ELSIF EXISTS (SELECT 1 FROM gbp_sync_proposals
                    WHERE user_id = v_owner AND kind = v_kind AND status = 'applying') THEN
        v_result := 'in_progress';
      ELSIF EXISTS (SELECT 1 FROM gbp_sync_proposals
                    WHERE user_id = v_owner AND kind = v_kind AND status IN ('pending', 'approved') AND base_hash = v_hash) THEN
        v_result := 'already_proposed';
      ELSE
        UPDATE gbp_sync_proposals SET status = 'superseded'
        WHERE user_id = v_owner AND kind = v_kind AND status IN ('pending', 'approved');
        INSERT INTO gbp_sync_proposals (user_id, kind, desired, base_hash)
        VALUES (v_owner, v_kind, v_desired, v_hash);
        v_result := 'proposed';
      END IF;
    END IF;

    v_results := v_results || jsonb_build_array(jsonb_build_object('kind', v_kind, 'result', v_result));
  END LOOP;

  INSERT INTO google_booking_audit (user_id, actor_id, event, detail)
  VALUES (v_owner, auth.uid(), 'gbp_propose', v_results);

  RETURN v_results;
END;
$$;
GRANT EXECUTE ON FUNCTION public.gbp_propose_sync() TO authenticated;

CREATE OR REPLACE FUNCTION public.gbp_decide_proposal(p_id uuid, p_decision text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row gbp_sync_proposals;
  v_current text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_decision NOT IN ('approve', 'reject', 'applied_manually') THEN RAISE EXCEPTION 'bad_decision'; END IF;

  SELECT * INTO v_row FROM gbp_sync_proposals WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;

  IF p_decision = 'reject' THEN
    IF v_row.status NOT IN ('pending', 'approved') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_state');
    END IF;
    UPDATE gbp_sync_proposals SET status = 'rejected', decided_by = auth.uid(), decided_at = now() WHERE id = p_id;
  ELSE
    -- approve / applied_manually: the source data must still match what the owner is looking at.
    v_current := md5(public.gbp_build_desired(v_owner, v_row.kind)::text);
    IF p_decision = 'approve' AND v_row.status <> 'pending' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_state');
    END IF;
    IF p_decision = 'applied_manually' AND v_row.status <> 'approved' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'bad_state');
    END IF;
    IF v_current <> v_row.base_hash THEN
      UPDATE gbp_sync_proposals SET status = 'superseded' WHERE id = p_id;
      RETURN jsonb_build_object('ok', false, 'code', 'stale');
    END IF;
    IF p_decision = 'approve' THEN
      UPDATE gbp_sync_proposals SET status = 'approved', decided_by = auth.uid(), decided_at = now() WHERE id = p_id;
    ELSE
      UPDATE gbp_sync_proposals
      SET status = 'applied', applied_via = 'manual', applied_at = now(), last_error = NULL WHERE id = p_id;
    END IF;
  END IF;

  INSERT INTO google_booking_audit (user_id, actor_id, event, detail)
  VALUES (v_owner, auth.uid(), 'gbp_' || p_decision, jsonb_build_object('proposal_id', p_id, 'kind', v_row.kind));

  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.gbp_decide_proposal(uuid, text) TO authenticated;

-- Called by the gbp-sync edge function with the USER's JWT. Re-checks approval + freshness atomically.
CREATE OR REPLACE FUNCTION public.gbp_begin_apply(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row gbp_sync_proposals;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT * INTO v_row FROM gbp_sync_proposals WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF v_row.status <> 'approved' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_approved'); END IF;

  IF md5(public.gbp_build_desired(v_owner, v_row.kind)::text) <> v_row.base_hash THEN
    UPDATE gbp_sync_proposals SET status = 'superseded' WHERE id = p_id;
    RETURN jsonb_build_object('ok', false, 'code', 'stale');
  END IF;

  UPDATE gbp_sync_proposals SET status = 'applying' WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'owner_id', v_owner, 'kind', v_row.kind, 'desired', v_row.desired);
END;
$$;
GRANT EXECUTE ON FUNCTION public.gbp_begin_apply(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.gbp_finish_apply(p_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row gbp_sync_proposals;
BEGIN
  IF p_status NOT IN ('applied', 'approved', 'failed') THEN RAISE EXCEPTION 'bad_status'; END IF;
  SELECT * INTO v_row FROM gbp_sync_proposals WHERE id = p_id AND status = 'applying' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE gbp_sync_proposals SET
    status = p_status,
    applied_via = CASE WHEN p_status = 'applied' THEN 'api' ELSE applied_via END,
    applied_at = CASE WHEN p_status = 'applied' THEN now() ELSE applied_at END,
    last_error = left(p_error, 500)
  WHERE id = p_id;

  INSERT INTO google_booking_audit (user_id, actor_id, event, detail)
  VALUES (v_row.user_id, NULL, 'gbp_apply_' || p_status,
          jsonb_build_object('proposal_id', p_id, 'kind', v_row.kind, 'error', left(p_error, 200)));
END;
$$;
REVOKE ALL ON FUNCTION public.gbp_finish_apply(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gbp_finish_apply(uuid, text, text) TO service_role;
