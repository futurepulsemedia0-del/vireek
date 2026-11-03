/*
  # Agent Readiness — audit, approved auto-fix with undo, weekly monitoring

  Additive + idempotent (safe to run twice). Touches NO existing table or function; the only write to
  existing data is the owner-approved, undoable price_book_items.description update below.

  1. agent_readiness_settings      per-account monitoring switch
  2. agent_readiness_scans         every scan: score, coverage, subscores, checks, proposed fixes
  3. agent_readiness_fix_actions   approve / skip decisions with before+after values (the undo log)
  4. agent_readiness_alerts        regressions found by the weekly scan
  5. agent_readiness_public_limits atomic counters for the public /agent-readiness tool (service role only)
  6. agent_readiness_snapshot_internal  ONE read of everything the scorer needs (no PII beyond the business's own public NAP)
  7. RPCs: apply / skip / undo, history, monitoring switch, alert ack

  Security: RLS on every table scoped by get_account_owner_id(). Scans, alerts and limiter rows are written
  ONLY by the service role (edge functions) so a client can never forge a score. The apply RPC never accepts
  text from the client: it applies the `after` value stored in the server-generated scan, and only when the
  row still holds the `before` value (stale/duplicate/concurrent safe).
  Depends on: get_account_owner_id(), can_manage_service_areas(), gbp_build_desired() (google_agentic_booking
  migration), business_profile, business_locations, profiles, price_book_items, reviews, review_connections,
  service_areas, google_booking_settings, calls.
*/

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_readiness_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  weekly_scan boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agent_readiness_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_agent_readiness_settings" ON agent_readiness_settings;
CREATE POLICY "select_agent_readiness_settings" ON agent_readiness_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS agent_readiness_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('manual', 'weekly')),
  score smallint CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  coverage numeric(4, 2) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  subscores jsonb NOT NULL,
  checks jsonb NOT NULL,
  fixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  site jsonb NOT NULL DEFAULT '{}'::jsonb,
  engine_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_readiness_scans_shape CHECK (
    jsonb_typeof(subscores) = 'array' AND jsonb_typeof(checks) = 'array' AND jsonb_typeof(fixes) = 'array'
    AND jsonb_array_length(checks) <= 100 AND jsonb_array_length(fixes) <= 30)
);
CREATE INDEX IF NOT EXISTS idx_agent_readiness_scans_user ON agent_readiness_scans (user_id, created_at DESC);
ALTER TABLE agent_readiness_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_agent_readiness_scans" ON agent_readiness_scans;
CREATE POLICY "select_agent_readiness_scans" ON agent_readiness_scans
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS agent_readiness_fix_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scan_id uuid NOT NULL REFERENCES agent_readiness_scans(id) ON DELETE CASCADE,
  fix_key text NOT NULL CHECK (char_length(fix_key) BETWEEN 1 AND 60),
  status text NOT NULL CHECK (status IN ('applied', 'skipped', 'undone')),
  changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid
);
CREATE INDEX IF NOT EXISTS idx_agent_readiness_actions_user ON agent_readiness_fix_actions (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_readiness_skip ON agent_readiness_fix_actions (scan_id, fix_key) WHERE status = 'skipped';
ALTER TABLE agent_readiness_fix_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_agent_readiness_actions" ON agent_readiness_fix_actions;
CREATE POLICY "select_agent_readiness_actions" ON agent_readiness_fix_actions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS agent_readiness_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scan_id uuid REFERENCES agent_readiness_scans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('score_drop', 'hours_changed', 'feed_stale', 'site_regression', 'site_unreachable')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_readiness_alert ON agent_readiness_alerts (scan_id, kind);
CREATE INDEX IF NOT EXISTS idx_agent_readiness_alerts_user ON agent_readiness_alerts (user_id, created_at DESC);
ALTER TABLE agent_readiness_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_agent_readiness_alerts" ON agent_readiness_alerts;
CREATE POLICY "select_agent_readiness_alerts" ON agent_readiness_alerts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Public tool limiter: hashed keys only (IP hash, host hash). No policies: service role only.
CREATE TABLE IF NOT EXISTS agent_readiness_public_limits (
  key_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);
ALTER TABLE agent_readiness_public_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_agent_readiness_limit(p_key_hash text, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_key_hash IS NULL OR char_length(p_key_hash) NOT BETWEEN 16 AND 128 OR p_max < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'bad_request';
  END IF;
  INSERT INTO agent_readiness_public_limits AS r (key_hash, window_start, request_count)
  VALUES (p_key_hash, now(), 1)
  ON CONFLICT (key_hash) DO UPDATE SET
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END,
    request_count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.request_count + 1 END
  RETURNING request_count INTO v_count;
  IF random() < 0.02 THEN
    DELETE FROM agent_readiness_public_limits WHERE window_start < now() - interval '1 day';
  END IF;
  RETURN v_count <= p_max;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_agent_readiness_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_agent_readiness_limit(text, integer, integer) TO service_role;

-- =============================================================
-- SNAPSHOT (one read; feeds the scorer)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_readiness_snapshot_internal(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bp business_profile%ROWTYPE;
  pr profiles%ROWTYPE;
  loc business_locations%ROWTYPE;
  gs google_booking_settings%ROWTYPE;
  v_has_loc boolean;
  v_tz_ok boolean;
  v_holidays integer := 0;
  v_areas jsonb;
  v_price jsonb;
  v_reviews jsonb;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE user_id = p_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO pr FROM profiles WHERE id = p_user;
  SELECT * INTO loc FROM business_locations
   WHERE user_id = p_user AND status = 'active' ORDER BY is_primary DESC, created_at LIMIT 1;
  v_has_loc := FOUND;
  SELECT * INTO gs FROM google_booking_settings WHERE user_id = p_user;

  v_tz_ok := bp.timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = bp.timezone);
  IF jsonb_typeof(bp.holidays) = 'array' THEN v_holidays := jsonb_array_length(bp.holidays); END IF;

  SELECT coalesce(jsonb_agg(q.name ORDER BY q.priority DESC, q.name), '[]'::jsonb) INTO v_areas
  FROM (SELECT name, priority FROM service_areas WHERE user_id = p_user AND is_active ORDER BY priority DESC, name LIMIT 20) q;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'service_name', q.service_name, 'description', q.description, 'pricing_model', q.pricing_model,
           'price_cents', q.price_cents, 'price_max_cents', q.price_max_cents, 'unit_label', q.unit_label)
         ORDER BY q.sort_order, q.service_name), '[]'::jsonb) INTO v_price
  FROM (SELECT * FROM price_book_items WHERE user_id = p_user AND active ORDER BY sort_order, service_name LIMIT 50) q;

  SELECT jsonb_build_object(
           'connected', EXISTS (SELECT 1 FROM review_connections WHERE user_id = p_user AND status = 'active'),
           'total', count(*),
           'last_90d', count(*) FILTER (WHERE reviewed_at >= now() - interval '90 days'),
           'due_total', count(*) FILTER (WHERE reviewed_at < now() - interval '7 days' AND reviewed_at >= now() - interval '365 days' AND status <> 'dismissed'),
           'due_replied', count(*) FILTER (WHERE reviewed_at < now() - interval '7 days' AND reviewed_at >= now() - interval '365 days' AND status = 'replied'))
    INTO v_reviews
  FROM reviews WHERE user_id = p_user;

  RETURN jsonb_build_object(
    'business', jsonb_build_object(
      'name', pr.company_name,
      'phone', coalesce(CASE WHEN v_has_loc THEN loc.phone END, pr.phone),
      'address', CASE WHEN v_has_loc THEN loc.address_line1 END,
      'city', CASE WHEN v_has_loc THEN loc.city END,
      'state', CASE WHEN v_has_loc THEN loc.state END,
      'website', pr.business_website,
      'country', CASE WHEN v_has_loc THEN loc.country END),
    'hours', bp.business_hours,
    'booking_hours', bp.booking_hours,
    'holidays', v_holidays,
    'handles_emergency', bp.handles_emergency_calls,
    'after_hours_mode', CASE WHEN v_has_loc THEN loc.after_hours_mode END,
    'currency', CASE WHEN v_has_loc THEN loc.currency END,
    'timezone_valid', v_tz_ok,
    'services_offered', public.gbp_build_desired(p_user, 'services'),
    'faqs', CASE WHEN jsonb_typeof(bp.faqs) = 'array' THEN bp.faqs ELSE '[]'::jsonb END,
    'service_areas', v_areas,
    'price_book', v_price,
    'reviews', v_reviews,
    'booking', jsonb_build_object(
      'enabled', coalesce(bp.booking_enabled, false),
      'feed_enabled', coalesce(gs.feed_enabled, false),
      'partner_status', coalesce(gs.partner_status, 'not_applied')),
    'phone_ai_configured', bp.vapi_phone_number_id IS NOT NULL AND btrim(bp.vapi_phone_number_id) <> '');
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_snapshot_internal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_snapshot_internal(uuid) TO service_role;

-- Owner-facing wrapper: the edge function resolves the caller's account here, so the user id is never client-supplied.
CREATE OR REPLACE FUNCTION public.agent_readiness_context()
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
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN jsonb_build_object('owner_id', v_owner);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_context() TO authenticated;

-- =============================================================
-- SERVICE-ROLE ONLY: store a scan, list due accounts
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_readiness_insert_scan(p_user uuid, p_source text, p_result jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_source NOT IN ('manual', 'weekly') OR p_result IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;
  INSERT INTO agent_readiness_scans (user_id, source, score, coverage, subscores, checks, fixes, facts, site, engine_version)
  VALUES (p_user, p_source, NULLIF(p_result ->> 'score', '')::smallint, (p_result ->> 'coverage')::numeric,
          p_result -> 'subscores', p_result -> 'checks', coalesce(p_result -> 'fixes', '[]'::jsonb),
          coalesce(p_result -> 'facts', '{}'::jsonb), coalesce(p_result -> 'site', '{}'::jsonb),
          coalesce((p_result ->> 'engine_version')::smallint, 1))
  RETURNING id INTO v_id;
  -- keep the most recent 60 scans per account (about a year of weekly scans)
  DELETE FROM agent_readiness_scans WHERE user_id = p_user AND id IN (
    SELECT id FROM agent_readiness_scans WHERE user_id = p_user ORDER BY created_at DESC OFFSET 60);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_insert_scan(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_insert_scan(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.agent_readiness_due_accounts(p_limit integer DEFAULT 100)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.user_id
  FROM (SELECT x.user_id, max(x.created_at) AS last_at FROM agent_readiness_scans x GROUP BY x.user_id) s
  JOIN profiles p ON p.id = s.user_id AND p.status = 'active'
  WHERE s.last_at < now() - interval '6 days'
    AND NOT EXISTS (SELECT 1 FROM agent_readiness_settings st WHERE st.user_id = s.user_id AND NOT st.weekly_scan)
  ORDER BY s.last_at
  LIMIT greatest(1, least(p_limit, 500));
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_due_accounts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_due_accounts(integer) TO service_role;

-- =============================================================
-- OWNER RPCs: apply / skip / undo (service descriptions)
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_readiness_apply_descriptions(p_scan_id uuid, p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_fix jsonb;
  v_row jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_count integer;
  v_action uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 OR cardinality(p_item_ids) > 50 THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT f INTO v_fix
  FROM agent_readiness_scans s, jsonb_array_elements(s.fixes) f
  WHERE s.id = p_scan_id AND s.user_id = v_owner AND f ->> 'key' = 'service_descriptions'
  LIMIT 1;
  IF v_fix IS NULL OR jsonb_typeof(v_fix -> 'diff') <> 'array' THEN RAISE EXCEPTION 'not_found'; END IF;

  FOR v_row IN
    SELECT d FROM jsonb_array_elements(v_fix -> 'diff') d WHERE (d ->> 'id')::uuid = ANY (p_item_ids)
  LOOP
    UPDATE price_book_items
       SET description = NULLIF(btrim(v_row ->> 'after'), ''), updated_at = now()
     WHERE id = (v_row ->> 'id')::uuid
       AND user_id = v_owner
       AND coalesce(btrim(description), '') = coalesce(v_row ->> 'before', '')
       AND char_length(coalesce(v_row ->> 'after', '')) BETWEEN 1 AND 300;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 1 THEN
      v_applied := v_applied + 1;
      v_changes := v_changes || jsonb_build_array(v_row);
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  IF v_applied > 0 THEN
    INSERT INTO agent_readiness_fix_actions (user_id, scan_id, fix_key, status, changes, decided_by)
    VALUES (v_owner, p_scan_id, 'service_descriptions', 'applied', v_changes, auth.uid())
    RETURNING id INTO v_action;
  END IF;
  RETURN jsonb_build_object('ok', true, 'applied', v_applied, 'skipped', v_skipped, 'action_id', v_action);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_apply_descriptions(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_apply_descriptions(uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_readiness_skip_fix(p_scan_id uuid, p_fix_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_fix_key IS NULL OR char_length(p_fix_key) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'bad_request'; END IF;
  IF NOT EXISTS (SELECT 1 FROM agent_readiness_scans WHERE id = p_scan_id AND user_id = v_owner) THEN RAISE EXCEPTION 'not_found'; END IF;
  INSERT INTO agent_readiness_fix_actions (user_id, scan_id, fix_key, status, decided_by)
  VALUES (v_owner, p_scan_id, p_fix_key, 'skipped', auth.uid())
  ON CONFLICT (scan_id, fix_key) WHERE status = 'skipped' DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_skip_fix(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_skip_fix(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_readiness_undo_action(p_action_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_act agent_readiness_fix_actions%ROWTYPE;
  v_ch jsonb;
  v_restored integer := 0;
  v_conflicts integer := 0;
  v_count integer;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_act FROM agent_readiness_fix_actions WHERE id = p_action_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_act.status <> 'applied' THEN RETURN jsonb_build_object('ok', true, 'restored', 0, 'conflicts', 0, 'already', true); END IF;

  FOR v_ch IN SELECT c FROM jsonb_array_elements(v_act.changes) c LOOP
    UPDATE price_book_items
       SET description = NULLIF(v_ch ->> 'before', ''), updated_at = now()
     WHERE id = (v_ch ->> 'id')::uuid AND user_id = v_owner
       AND coalesce(btrim(description), '') = coalesce(v_ch ->> 'after', '');
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 1 THEN v_restored := v_restored + 1; ELSE v_conflicts := v_conflicts + 1; END IF;
  END LOOP;

  UPDATE agent_readiness_fix_actions SET status = 'undone', undone_at = now(), undone_by = auth.uid() WHERE id = p_action_id;
  RETURN jsonb_build_object('ok', true, 'restored', v_restored, 'conflicts', v_conflicts);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_undo_action(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_undo_action(uuid) TO authenticated;

-- =============================================================
-- MONITORING: switch, alert ack, history for the before/after chart
-- =============================================================
CREATE OR REPLACE FUNCTION public.agent_readiness_set_monitoring(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO agent_readiness_settings (user_id, weekly_scan) VALUES (v_owner, coalesce(p_enabled, true))
  ON CONFLICT (user_id) DO UPDATE SET weekly_scan = EXCLUDED.weekly_scan, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'weekly_scan', coalesce(p_enabled, true));
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_set_monitoring(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_set_monitoring(boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_readiness_ack_alert(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE agent_readiness_alerts SET acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = p_id AND user_id = v_owner;
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_ack_alert(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_ack_alert(uuid) TO authenticated;

-- Score history next to weekly inbound-call volume. Correlation only: the UI says so.
CREATE OR REPLACE FUNCTION public.agent_readiness_history()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_scans jsonb;
  v_calls jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'created_at', q.created_at, 'score', q.score, 'coverage', q.coverage, 'source', q.source)
                            ORDER BY q.created_at), '[]'::jsonb) INTO v_scans
  FROM (SELECT id, created_at, score, coverage, source FROM agent_readiness_scans
         WHERE user_id = v_owner ORDER BY created_at DESC LIMIT 26) q;
  SELECT coalesce(jsonb_agg(jsonb_build_object('week_start', w.week_start, 'calls', w.n) ORDER BY w.week_start), '[]'::jsonb) INTO v_calls
  FROM (SELECT date_trunc('week', call_datetime)::date AS week_start, count(*) AS n
          FROM calls WHERE user_id = v_owner AND call_datetime >= now() - interval '26 weeks'
         GROUP BY 1) w;
  RETURN jsonb_build_object('scans', v_scans, 'weekly_calls', v_calls);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_readiness_history() TO authenticated;

/*
  ROLLBACK (data-safe order; run manually if ever needed — price_book_items.description edits are reverted
  per action with agent_readiness_undo_action BEFORE dropping, otherwise the applied text simply stays):
    DROP FUNCTION IF EXISTS public.agent_readiness_history(), public.agent_readiness_ack_alert(uuid),
      public.agent_readiness_set_monitoring(boolean), public.agent_readiness_undo_action(uuid),
      public.agent_readiness_skip_fix(uuid, text), public.agent_readiness_apply_descriptions(uuid, uuid[]),
      public.agent_readiness_due_accounts(integer), public.agent_readiness_insert_scan(uuid, text, jsonb),
      public.agent_readiness_context(), public.agent_readiness_snapshot_internal(uuid),
      public.consume_agent_readiness_limit(text, integer, integer);
    DROP TABLE IF EXISTS agent_readiness_alerts, agent_readiness_fix_actions, agent_readiness_scans,
      agent_readiness_settings, agent_readiness_public_limits;
*/
