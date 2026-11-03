/*
  Consumer Agent surface (public, read-mostly) — data layer

  Lets a homeowner's AI agent (ChatGPT, Gemini, Claude, ...) discover ONE Vireek customer business and send it a
  PENDING service request. Separate from the owner-authenticated mcp-server (agent_network_*). This surface can
  never read customers, jobs, equipment, quotes or payments, and never confirms an appointment or takes payment.

  Adds
    consumer_agent_settings    per-business opt-in: which sections are published, request mode, caps, SLA, auto-accept
    consumer_agent_requests    the review queue (PII-minimised contact + untrusted description + risk flags)
    consumer_agent_events      PII-free call log for anomaly detection (30-day retention via consumer_agent_purge)
    consumer_agent_rate_buckets atomic fixed-window counters (rate limits, nonce replay, one-time challenges)
    consumer_agent_blocklist   platform-level takedown for an abusive principal
    consumer_agent_registry    registered (request-signing) agents; managed by Vireek staff with SQL / service role
    consumer_agent_audit       who changed what
    price_book_items.agent_published  (new column) the owner's per-price publish switch
  Public-side RPCs are service_role only (the edge function `consumer-agent` is the only caller).
  Owner RPCs are authenticated and gated by can_manage_service_areas() (owner / admin / can_manage_team).

  Prerequisites (checked below, fails with a clear message instead of half-applying):
    20270402 service_areas, 20270404 reputation (reviews), 20270410 booking_settings,
    20271120 google_agentic_booking (google_feed_snapshot_internal, gbp_build_desired),
    20260913 price_book_items, 20260831 notifications.

  Additive and idempotent: safe to run twice. Touches no existing function; one ADD COLUMN IF NOT EXISTS.
  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 0) Prerequisite check ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text[] := '{}';
BEGIN
  IF to_regclass('public.business_profile') IS NULL THEN v_missing := v_missing || 'business_profile'; END IF;
  IF to_regclass('public.service_areas') IS NULL THEN v_missing := v_missing || 'service_areas'; END IF;
  IF to_regclass('public.reviews') IS NULL THEN v_missing := v_missing || 'reviews'; END IF;
  IF to_regclass('public.price_book_items') IS NULL THEN v_missing := v_missing || 'price_book_items'; END IF;
  IF to_regclass('public.notifications') IS NULL THEN v_missing := v_missing || 'notifications'; END IF;
  IF to_regclass('public.jobs') IS NULL THEN v_missing := v_missing || 'jobs'; END IF;
  IF to_regprocedure('public.google_feed_snapshot_internal(uuid)') IS NULL THEN v_missing := v_missing || 'google_feed_snapshot_internal(uuid)'; END IF;
  IF to_regprocedure('public.gbp_build_desired(uuid, text)') IS NULL THEN v_missing := v_missing || 'gbp_build_desired(uuid,text)'; END IF;
  IF to_regprocedure('public.create_public_booking_with_settings(text, text, text, text, text, timestamptz, text, text, text, jsonb)') IS NULL THEN
    v_missing := v_missing || 'create_public_booking_with_settings(...)';
  END IF;
  IF to_regprocedure('public.can_manage_service_areas()') IS NULL THEN v_missing := v_missing || 'can_manage_service_areas()'; END IF;
  IF to_regprocedure('public.get_account_owner_id()') IS NULL THEN v_missing := v_missing || 'get_account_owner_id()'; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'consumer_agent_surface: missing prerequisites: %. Apply the earlier migrations first.', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- 1) Per-price publish switch (owner flips it with the existing price_book_items RLS) --------------
ALTER TABLE public.price_book_items ADD COLUMN IF NOT EXISTS agent_published boolean NOT NULL DEFAULT false;

-- 2) Settings (opt-in; everything off by default) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.consumer_agent_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  publish_services boolean NOT NULL DEFAULT false,
  publish_service_area boolean NOT NULL DEFAULT false,
  publish_hours boolean NOT NULL DEFAULT false,
  publish_prices boolean NOT NULL DEFAULT false,
  publish_reviews boolean NOT NULL DEFAULT false,
  publish_policies boolean NOT NULL DEFAULT false,
  publish_contact boolean NOT NULL DEFAULT false,
  public_phone text CHECK (public_phone IS NULL OR (char_length(public_phone) BETWEEN 7 AND 25 AND public_phone ~ '^[0-9+() .-]+$')),
  public_email text CHECK (public_email IS NULL OR (char_length(public_email) BETWEEN 5 AND 254 AND public_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')),
  public_website text CHECK (public_website IS NULL OR (char_length(public_website) <= 200 AND public_website ~ '^https://')),
  policies_text text CHECK (policies_text IS NULL OR char_length(policies_text) <= 600),
  request_mode text NOT NULL DEFAULT 'pending' CHECK (request_mode IN ('pending', 'hold')),
  hold_minutes integer NOT NULL DEFAULT 30 CHECK (hold_minutes BETWEEN 5 AND 240),
  daily_request_cap integer NOT NULL DEFAULT 20 CHECK (daily_request_cap BETWEEN 1 AND 200),
  sla_minutes integer NOT NULL DEFAULT 120 CHECK (sla_minutes BETWEEN 15 AND 1440),
  auto_accept_enabled boolean NOT NULL DEFAULT false,
  auto_accept_services text[] NOT NULL DEFAULT '{}',
  auto_accept_min_lead_hours integer NOT NULL DEFAULT 24 CHECK (auto_accept_min_lead_hours BETWEEN 1 AND 336),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consumer_agent_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_consumer_agent_settings" ON public.consumer_agent_settings;
CREATE POLICY "select_consumer_agent_settings" ON public.consumer_agent_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy on purpose: writes go through update_consumer_agent_settings().

-- 3) Requests (the review queue) ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.consumer_agent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  principal text NOT NULL CHECK (char_length(principal) BETWEEN 8 AND 64),
  principal_kind text NOT NULL CHECK (principal_kind IN ('anonymous', 'registered')),
  agent_label text CHECK (agent_label IS NULL OR char_length(agent_label) <= 60),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  args_hash text NOT NULL CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  source text NOT NULL DEFAULT 'ai_agent' CHECK (source = 'ai_agent'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'accepted', 'declined', 'expired')),
  service_type text NOT NULL CHECK (char_length(service_type) BETWEEN 1 AND 120),
  requested_start timestamptz NOT NULL,
  contact_name text NOT NULL CHECK (char_length(contact_name) BETWEEN 2 AND 80),
  contact_phone text CHECK (contact_phone IS NULL OR char_length(contact_phone) BETWEEN 7 AND 20),
  contact_email text CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  postal_code text NOT NULL CHECK (char_length(postal_code) BETWEEN 3 AND 10),
  address_line text CHECK (address_line IS NULL OR char_length(address_line) <= 120),
  description_untrusted text CHECK (description_untrusted IS NULL OR char_length(description_untrusted) <= 500),
  risk_flags text[] NOT NULL DEFAULT '{}',
  area_verified boolean NOT NULL DEFAULT false,
  ip_hash text,
  sla_due_at timestamptz NOT NULL,
  hold_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision text CHECK (decision IS NULL OR decision IN ('accepted_by_owner', 'accepted_by_rule', 'declined_by_owner')),
  decline_reason text CHECK (decline_reason IS NULL OR decline_reason IN ('unavailable', 'outside_area', 'not_offered', 'other')),
  job_id uuid,
  accept_error text CHECK (accept_error IS NULL OR char_length(accept_error) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_agent_requests_has_contact CHECK (contact_phone IS NOT NULL OR contact_email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consumer_agent_requests_idem
  ON public.consumer_agent_requests (user_id, principal, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_consumer_agent_requests_queue
  ON public.consumer_agent_requests (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consumer_agent_requests_slot
  ON public.consumer_agent_requests (user_id, requested_start) WHERE status IN ('pending', 'held');
CREATE INDEX IF NOT EXISTS idx_consumer_agent_requests_principal
  ON public.consumer_agent_requests (principal, created_at DESC);
ALTER TABLE public.consumer_agent_requests ENABLE ROW LEVEL SECURITY;
-- No policies: contact details are read only through list_consumer_agent_requests() (owner/admin gate).

-- 4) Events, rate buckets, blocklist, registry, audit ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.consumer_agent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid,
  principal text,
  ip_hash text,
  tool text NOT NULL CHECK (char_length(tool) <= 40),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'invalid', 'denied', 'rate_limited', 'challenge_failed', 'blocked', 'error')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  flagged boolean NOT NULL DEFAULT false,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consumer_agent_events_user_time ON public.consumer_agent_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consumer_agent_events_principal_time ON public.consumer_agent_events (principal, created_at DESC);
ALTER TABLE public.consumer_agent_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.consumer_agent_rate_buckets (
  key text NOT NULL CHECK (char_length(key) <= 200),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.consumer_agent_rate_buckets ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.consumer_agent_blocklist (
  principal text PRIMARY KEY CHECK (char_length(principal) BETWEEN 8 AND 64),
  reasons text[] NOT NULL DEFAULT '{}',
  blocked_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consumer_agent_blocklist ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.consumer_agent_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL UNIQUE CHECK (key_id ~ '^[A-Za-z0-9_.:-]{3,64}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  operator_url text CHECK (operator_url IS NULL OR operator_url ~ '^https://'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consumer_agent_registry ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.consumer_agent_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consumer_agent_audit_user ON public.consumer_agent_audit (user_id, created_at DESC);
ALTER TABLE public.consumer_agent_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_consumer_agent_audit" ON public.consumer_agent_audit;
CREATE POLICY "select_consumer_agent_audit" ON public.consumer_agent_audit
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- 5) Helpers (internal) -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consumer_agent_expire_stale()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a integer;
  v_b integer;
BEGIN
  UPDATE consumer_agent_requests SET status = 'expired', hold_expires_at = NULL, updated_at = now()
  WHERE status IN ('pending', 'held') AND expires_at <= now();
  GET DIAGNOSTICS v_a = ROW_COUNT;
  -- A lapsed hold releases the slot but the request keeps waiting for a human.
  UPDATE consumer_agent_requests SET status = 'pending', hold_expires_at = NULL, updated_at = now()
  WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at <= now();
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_expire_stale() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_expire_stale() TO service_role;

CREATE OR REPLACE FUNCTION public.consumer_agent_purge()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
  v_c integer;
BEGIN
  DELETE FROM consumer_agent_events WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;
  DELETE FROM consumer_agent_rate_buckets WHERE window_start < now() - interval '2 days';
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;
  DELETE FROM consumer_agent_blocklist WHERE blocked_until < now() - interval '7 days';
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;
  -- PII minimisation: contact details of requests that ended unaccepted are erased after 30 days.
  UPDATE consumer_agent_requests
     SET contact_phone = NULL, contact_email = 'redacted@invalid.example', contact_name = 'redacted',
         address_line = NULL, description_untrusted = NULL, ip_hash = NULL, updated_at = now()
   WHERE status IN ('declined', 'expired') AND updated_at < now() - interval '30 days' AND contact_name <> 'redacted';
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_purge() TO service_role;

-- Atomic fixed-window counter. Returns allowed=false when the window is already at p_max.
CREATE OR REPLACE FUNCTION public.consumer_agent_hit(p_key text, p_window_seconds integer, p_max integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_hits integer;
BEGIN
  IF p_key IS NULL OR char_length(p_key) > 200 OR p_window_seconds < 1 OR p_window_seconds > 172800 OR p_max < 1 THEN
    RAISE EXCEPTION 'invalid_rate_limit_arguments';
  END IF;
  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO consumer_agent_rate_buckets AS b (key, window_start, hits) VALUES (p_key, v_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = b.hits + 1
  RETURNING b.hits INTO v_hits;
  RETURN jsonb_build_object(
    'allowed', v_hits <= p_max,
    'hits', v_hits,
    'retry_after', greatest(1, ceil(extract(epoch FROM (v_start + make_interval(secs => p_window_seconds) - now())))::integer));
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_hit(text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.consumer_agent_is_blocked(p_principal text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM consumer_agent_blocklist WHERE principal = p_principal AND blocked_until > now());
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_is_blocked(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_is_blocked(text) TO service_role;

CREATE OR REPLACE FUNCTION public.consumer_agent_block(p_principal text, p_reasons text[], p_hours integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_principal IS NULL OR char_length(p_principal) < 8 THEN RAISE EXCEPTION 'invalid_principal'; END IF;
  INSERT INTO consumer_agent_blocklist (principal, reasons, blocked_until)
  VALUES (p_principal, coalesce(p_reasons, '{}'), now() + make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720)))
  ON CONFLICT (principal) DO UPDATE SET reasons = EXCLUDED.reasons, blocked_until = EXCLUDED.blocked_until;
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_block(text, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_block(text, text[], integer) TO service_role;

CREATE OR REPLACE FUNCTION public.consumer_agent_log(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO consumer_agent_events (user_id, principal, ip_hash, tool, outcome, error_code, flagged, latency_ms)
  VALUES (
    (SELECT bp.user_id FROM business_profile bp WHERE bp.booking_slug = left(p ->> 'slug', 60)), left(p ->> 'principal', 64), left(p ->> 'ip_hash', 64),
    left(coalesce(p ->> 'tool', 'unknown'), 40),
    CASE WHEN p ->> 'outcome' IN ('ok', 'invalid', 'denied', 'rate_limited', 'challenge_failed', 'blocked', 'error') THEN p ->> 'outcome' ELSE 'error' END,
    left(p ->> 'error_code', 60), coalesce((p ->> 'flagged')::boolean, false), NULLIF(p ->> 'latency_ms', '')::integer);
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_log(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_log(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.consumer_agent_principal_stats(p_principal text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'requests_1h', (SELECT count(*) FROM consumer_agent_requests WHERE principal = p_principal AND created_at > now() - interval '1 hour'),
    'distinct_contacts_1h', (SELECT count(DISTINCT coalesce(contact_phone, contact_email)) FROM consumer_agent_requests WHERE principal = p_principal AND created_at > now() - interval '1 hour'),
    'flagged_1h', (SELECT count(*) FROM consumer_agent_requests WHERE principal = p_principal AND created_at > now() - interval '1 hour'
                      AND (risk_flags && ARRAY['injection_pattern', 'payment_language'])),
    'invalid_10m', (SELECT count(*) FROM consumer_agent_events WHERE principal = p_principal AND outcome IN ('invalid', 'denied', 'challenge_failed') AND created_at > now() - interval '10 minutes'),
    'declined_24h', (SELECT count(*) FROM consumer_agent_requests WHERE principal = p_principal AND status = 'declined' AND created_at > now() - interval '24 hours'),
    'total_24h', (SELECT count(*) FROM consumer_agent_requests WHERE principal = p_principal AND created_at > now() - interval '24 hours'));
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_principal_stats(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_principal_stats(text) TO service_role;

CREATE OR REPLACE FUNCTION public.consumer_agent_lookup_key(p_key_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('id', r.id, 'name', r.name, 'public_key', r.public_key)
  FROM consumer_agent_registry r WHERE r.key_id = p_key_id AND r.status = 'active';
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_lookup_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_lookup_key(text) TO service_role;

-- 6) The exact public payload (single source of truth for the public endpoints AND the owner preview) -------
CREATE OR REPLACE FUNCTION public.consumer_agent_profile_internal(p_user uuid, p_ignore_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s consumer_agent_settings%ROWTYPE;
  bp business_profile%ROWTYPE;
  v_name text;
  v_tz_ok boolean;
  v_published text[] := '{}';
  v_out jsonb;
  v_areas jsonb;
  v_zips text[];
  v_prices jsonb;
  v_reviews jsonb;
  v_count integer;
BEGIN
  SELECT * INTO s FROM consumer_agent_settings WHERE user_id = p_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF s.kill_switch THEN RETURN NULL; END IF;
  IF NOT s.enabled AND NOT p_ignore_enabled THEN RETURN NULL; END IF;
  SELECT * INTO bp FROM business_profile WHERE user_id = p_user;
  IF NOT FOUND OR bp.booking_slug IS NULL THEN RETURN NULL; END IF;
  SELECT company_name INTO v_name FROM profiles WHERE id = p_user;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RETURN NULL; END IF;
  v_tz_ok := bp.timezone IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = bp.timezone);

  v_out := jsonb_build_object(
    'schema', 'vireek.consumer-agent.profile.v1',
    'slug', bp.booking_slug,
    'name', left(v_name, 120),
    'timezone', CASE WHEN v_tz_ok THEN bp.timezone END,
    'booking_enabled', coalesce(bp.booking_enabled, false),
    'request_mode', s.request_mode);

  IF s.publish_services THEN
    v_published := v_published || 'services';
    v_out := v_out || jsonb_build_object('services', public.gbp_build_desired(p_user, 'services'));
  END IF;

  IF s.publish_service_area THEN
    v_published := v_published || 'service_area';
    SELECT coalesce(jsonb_agg(a.name ORDER BY a.priority DESC, a.name), '[]'::jsonb) INTO v_areas
      FROM service_areas a WHERE a.user_id = p_user AND a.is_active;
    SELECT coalesce(array_agg(z), '{}') INTO v_zips FROM (
      SELECT DISTINCT unnest(a.zip_codes) AS z FROM service_areas a WHERE a.user_id = p_user AND a.is_active AND a.zone_type = 'zip' LIMIT 300) q;
    v_out := v_out || jsonb_build_object('service_area', jsonb_build_object(
      'names', v_areas, 'postal_codes', to_jsonb(v_zips),
      'postal_codes_truncated', coalesce((SELECT count(DISTINCT z) FROM (SELECT unnest(a.zip_codes) AS z FROM service_areas a WHERE a.user_id = p_user AND a.is_active AND a.zone_type = 'zip') t), 0) > 300));
  END IF;

  IF s.publish_hours THEN
    v_published := v_published || 'hours';
    v_out := v_out || jsonb_build_object('hours', coalesce(bp.booking_hours, bp.business_hours));
  END IF;

  IF s.publish_prices THEN
    v_published := v_published || 'prices';
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'service', i.service_name, 'model', i.pricing_model,
             'min_cents', i.price_cents, 'max_cents', i.price_max_cents,
             'unit', i.unit_label, 'currency', 'USD', 'description', left(i.description, 200))
           ORDER BY i.sort_order, i.service_name), '[]'::jsonb) INTO v_prices
      FROM (SELECT * FROM price_book_items WHERE user_id = p_user AND active AND agent_published ORDER BY sort_order, service_name LIMIT 50) i;
    v_out := v_out || jsonb_build_object('prices', v_prices);
  END IF;

  IF s.publish_reviews THEN
    -- Real data only: reviews synced from a platform API (source = 'api'); manual entries are never summarised.
    SELECT count(*) INTO v_count FROM reviews WHERE user_id = p_user AND source = 'api';
    IF v_count >= 5 THEN
      v_published := v_published || 'reviews';
      SELECT jsonb_build_object(
               'count', count(*), 'average', round(avg(rating)::numeric, 1),
               'distribution', jsonb_build_object(
                 '1', count(*) FILTER (WHERE rating = 1), '2', count(*) FILTER (WHERE rating = 2), '3', count(*) FILTER (WHERE rating = 3),
                 '4', count(*) FILTER (WHERE rating = 4), '5', count(*) FILTER (WHERE rating = 5)),
               'last_12_months', count(*) FILTER (WHERE reviewed_at > now() - interval '12 months'),
               'platforms', (SELECT coalesce(jsonb_agg(DISTINCT platform), '[]'::jsonb) FROM reviews WHERE user_id = p_user AND source = 'api'),
               'as_of', now())
        INTO v_reviews FROM reviews WHERE user_id = p_user AND source = 'api';
      v_out := v_out || jsonb_build_object('reviews', v_reviews);
    END IF;
  END IF;

  IF s.publish_policies THEN
    v_published := v_published || 'policies';
    v_out := v_out || jsonb_build_object('policies', jsonb_build_object(
      'text', s.policies_text, 'request_mode', s.request_mode,
      'hold_minutes', CASE WHEN s.request_mode = 'hold' THEN s.hold_minutes END,
      'response_sla_minutes', s.sla_minutes,
      'payment', 'never_collected_through_agents',
      'confirmation', 'requests_are_not_appointments_until_the_business_confirms'));
  END IF;

  IF s.publish_contact THEN
    v_published := v_published || 'contact';
    v_out := v_out || jsonb_build_object('contact', jsonb_build_object(
      'phone', s.public_phone, 'email', s.public_email, 'website', s.public_website));
  END IF;

  RETURN v_out || jsonb_build_object('published', to_jsonb(v_published));
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_profile_internal(uuid, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consumer_agent_get_profile(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM business_profile WHERE booking_slug = p_slug;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  RETURN public.consumer_agent_profile_internal(v_user, false);
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_get_profile(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_get_profile(text) TO service_role;

-- Verified-availability snapshot (reuses the Google feed snapshot: one atomic, PII-free read). NULL unless published.
CREATE OR REPLACE FUNCTION public.consumer_agent_get_snapshot(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  s consumer_agent_settings%ROWTYPE;
BEGIN
  SELECT user_id INTO v_user FROM business_profile WHERE booking_slug = p_slug;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM consumer_agent_settings WHERE user_id = v_user;
  IF NOT FOUND OR NOT s.enabled OR s.kill_switch THEN RETURN NULL; END IF;
  PERFORM public.consumer_agent_expire_stale();
  RETURN public.google_feed_snapshot_internal(v_user);
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_get_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_get_snapshot(text) TO service_role;

-- Slot starts that must be hidden from agents: an unexpired HELD slot, or a slot that already has 3 open requests.
CREATE OR REPLACE FUNCTION public.consumer_agent_get_blocked_starts(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT to_char(r.requested_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), '[]'::jsonb)
  FROM consumer_agent_requests r
  JOIN business_profile bp ON bp.user_id = r.user_id AND bp.booking_slug = p_slug
  WHERE r.status IN ('pending', 'held') AND r.expires_at > now() AND r.requested_start > now()
    AND (
      (r.status = 'held' AND r.hold_expires_at > now())
      OR (SELECT count(*) FROM consumer_agent_requests r2
          WHERE r2.user_id = r.user_id AND r2.requested_start = r.requested_start AND r2.status IN ('pending', 'held') AND r2.expires_at > now()) >= 3
    );
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_get_blocked_starts(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_get_blocked_starts(text) TO service_role;

-- Authoritative postal-code check. 'inside' | 'outside' | 'unknown' (owner publishes no ZIP list).
CREATE OR REPLACE FUNCTION public.consumer_agent_area_check(p_slug text, p_postal text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_has boolean;
  v_in boolean;
BEGIN
  SELECT user_id INTO v_user FROM business_profile WHERE booking_slug = p_slug;
  IF v_user IS NULL THEN RETURN 'unknown'; END IF;
  SELECT EXISTS (SELECT 1 FROM service_areas WHERE user_id = v_user AND is_active AND zone_type = 'zip') INTO v_has;
  IF NOT v_has THEN RETURN 'unknown'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM service_areas a
    WHERE a.user_id = v_user AND a.is_active AND a.zone_type = 'zip'
      AND EXISTS (SELECT 1 FROM unnest(a.zip_codes) z WHERE upper(btrim(z)) = upper(btrim(p_postal)))) INTO v_in;
  RETURN CASE WHEN v_in THEN 'inside' ELSE 'outside' END;
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_area_check(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_area_check(text, text) TO service_role;

-- 7) Accept (shared by the owner button and the auto-accept rule) --------------------------------------------
-- Creates the job through the EXISTING booking path, so lead time, buffers, intake rules, customer matching and
-- jobs_no_double_booking all still apply. Tagged booking_channel = 'ai_agent' (shows up as the lead source).
CREATE OR REPLACE FUNCTION public.consumer_agent_accept_internal(p_request uuid, p_actor uuid, p_by_rule boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r consumer_agent_requests%ROWTYPE;
  v_slug text;
  v_res jsonb;
  v_msg text;
BEGIN
  SELECT * INTO r FROM consumer_agent_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF r.status NOT IN ('pending', 'held') OR r.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;
  SELECT booking_slug INTO v_slug FROM business_profile WHERE user_id = r.user_id;
  IF v_slug IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'booking_not_available'); END IF;

  BEGIN
    v_res := public.create_public_booking_with_settings(
      p_slug => v_slug,
      p_customer_name => r.contact_name,
      p_customer_phone => r.contact_phone,
      p_customer_email => r.contact_email,
      p_service_type => r.service_type,
      p_scheduled_datetime => r.requested_start,
      p_notes => left('AI agent lead (' || coalesce(r.agent_label, 'unnamed agent') || '). Address: ' || coalesce(r.address_line, 'not given')
                      || ' ' || r.postal_code || '. Homeowner note (untrusted text from an outside agent): ' || coalesce(r.description_untrusted, 'none'), 1000),
      p_channel => 'ai_agent',
      p_intake_answers => '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    UPDATE consumer_agent_requests SET accept_error = left(v_msg, 80), updated_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', false, 'error', left(v_msg, 80));
  END;

  UPDATE consumer_agent_requests
     SET status = 'accepted', decided_by = p_actor, decided_at = now(), hold_expires_at = NULL, accept_error = NULL,
         decision = CASE WHEN p_by_rule THEN 'accepted_by_rule' ELSE 'accepted_by_owner' END,
         job_id = NULLIF(v_res ->> 'job_id', '')::uuid, updated_at = now()
   WHERE id = r.id;
  INSERT INTO consumer_agent_audit (user_id, actor_id, event, detail)
  VALUES (r.user_id, p_actor, CASE WHEN p_by_rule THEN 'request_auto_accepted' ELSE 'request_accepted' END,
          jsonb_build_object('request_id', r.id, 'job_id', v_res ->> 'job_id'));
  RETURN jsonb_build_object('ok', true, 'job_id', v_res ->> 'job_id');
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_accept_internal(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- 8) Create request (service_role only; the ONLY write the public surface can perform) --------------------------
CREATE OR REPLACE FUNCTION public.consumer_agent_create_request(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text := p ->> 'slug';
  v_user uuid;
  s consumer_agent_settings%ROWTYPE;
  bp business_profile%ROWTYPE;
  v_principal text := p ->> 'principal';
  v_kind text := p ->> 'principal_kind';
  v_key text := p ->> 'idempotency_key';
  v_hash text := p ->> 'args_hash';
  v_service text := p ->> 'service_type';
  v_start timestamptz := (p ->> 'requested_start')::timestamptz;
  v_flags text[] := coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p -> 'risk_flags', '[]'::jsonb))), '{}');
  v_area text;
  v_existing consumer_agent_requests%ROWTYPE;
  v_new consumer_agent_requests%ROWTYPE;
  v_status text;
  v_services jsonb;
  v_today integer;
  v_open_same integer;
  v_held_same integer;
  v_auto jsonb;
  v_final text;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE booking_slug = v_slug;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_available'); END IF;
  v_user := bp.user_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('consumer_agent:' || v_user::text, 0));
  PERFORM public.consumer_agent_expire_stale();

  SELECT * INTO s FROM consumer_agent_settings WHERE user_id = v_user;
  IF NOT FOUND OR NOT s.enabled OR s.kill_switch OR NOT coalesce(bp.booking_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_available');
  END IF;
  IF v_kind NOT IN ('anonymous', 'registered') OR v_principal IS NULL OR v_key IS NULL OR v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Idempotency first: a retry must return the original request, never a second one.
  SELECT * INTO v_existing FROM consumer_agent_requests WHERE user_id = v_user AND principal = v_principal AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.args_hash <> v_hash THEN RETURN jsonb_build_object('ok', false, 'error', 'idempotency_conflict'); END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'request_id', v_existing.id, 'status', v_existing.status,
      'sla_due_at', v_existing.sla_due_at, 'hold_expires_at', v_existing.hold_expires_at, 'expires_at', v_existing.expires_at);
  END IF;

  -- The service must be one the business really offers and has not hidden.
  v_services := public.gbp_build_desired(v_user, 'services');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_services) x WHERE lower(btrim(x)) = lower(btrim(v_service))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_service');
  END IF;

  v_area := public.consumer_agent_area_check(v_slug, p ->> 'postal_code');
  IF v_area = 'outside' THEN RETURN jsonb_build_object('ok', false, 'error', 'outside_service_area'); END IF;

  IF v_start < now() + make_interval(hours => coalesce(bp.booking_lead_time_hours, 2))
     OR v_start > now() + make_interval(days => coalesce(bp.booking_window_days, 14)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.user_id = v_user AND j.job_status IN ('scheduled', 'en_route', 'in_progress') AND j.scheduled_datetime IS NOT NULL
      AND j.scheduled_datetime < v_start + make_interval(mins => coalesce(bp.booking_default_duration_minutes, 60) + coalesce(bp.booking_buffer_after_minutes, 0))
      AND j.scheduled_datetime + make_interval(mins => coalesce(j.duration_minutes, 60)) > v_start - make_interval(mins => coalesce(bp.booking_buffer_before_minutes, 0))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('pending', 'held')), count(*) FILTER (WHERE status = 'held' AND hold_expires_at > now())
    INTO v_open_same, v_held_same
    FROM consumer_agent_requests WHERE user_id = v_user AND requested_start = v_start AND expires_at > now();
  IF v_held_same > 0 OR v_open_same >= 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'slot_unavailable'); END IF;

  SELECT count(*) INTO v_today FROM consumer_agent_requests WHERE user_id = v_user AND created_at > now() - interval '24 hours';
  IF v_today >= s.daily_request_cap THEN RETURN jsonb_build_object('ok', false, 'error', 'daily_cap_reached'); END IF;

  v_status := CASE WHEN s.request_mode = 'hold' THEN 'held' ELSE 'pending' END;

  INSERT INTO consumer_agent_requests (
    user_id, principal, principal_kind, agent_label, idempotency_key, args_hash, status, service_type, requested_start,
    contact_name, contact_phone, contact_email, postal_code, address_line, description_untrusted, risk_flags, area_verified, ip_hash,
    sla_due_at, hold_expires_at, expires_at)
  VALUES (
    v_user, v_principal, v_kind, left(p ->> 'agent_name', 60), v_key, v_hash, v_status, left(v_service, 120), v_start,
    left(p ->> 'contact_name', 80), left(p ->> 'contact_phone', 20), left(p ->> 'contact_email', 254),
    left(p ->> 'postal_code', 10), left(p ->> 'address_line', 120), left(p ->> 'description', 500), v_flags, v_area = 'inside', left(p ->> 'ip_hash', 64),
    now() + make_interval(mins => s.sla_minutes),
    CASE WHEN v_status = 'held' THEN now() + make_interval(mins => s.hold_minutes) END,
    now() + interval '48 hours')
  RETURNING * INTO v_new;

  -- Best effort: a failing notification trigger must never lose the request.
  BEGIN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (v_user, 'agent_booking_request', 'New AI agent booking request',
            left('A homeowner''s AI agent asked for ' || v_new.service_type || ' on ' || to_char(v_new.requested_start AT TIME ZONE coalesce(bp.timezone, 'UTC'), 'Mon DD HH24:MI') || '. Review it before the response window ends.', 300),
            '/dashboard/consumer-agent');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  v_final := v_new.status;
  -- Auto-accept: only for REGISTERED (signature-verified) agents, only for explicitly listed services, never when flagged,
  -- never for a slot sooner than the owner's minimum lead time, never when the area could not be verified.
  IF s.auto_accept_enabled AND v_kind = 'registered' AND cardinality(v_flags) = 0 AND v_area = 'inside'
     AND v_new.requested_start >= now() + make_interval(hours => s.auto_accept_min_lead_hours)
     AND EXISTS (SELECT 1 FROM unnest(s.auto_accept_services) a WHERE lower(btrim(a)) = lower(btrim(v_new.service_type))) THEN
    v_auto := public.consumer_agent_accept_internal(v_new.id, NULL, true);
    IF coalesce((v_auto ->> 'ok')::boolean, false) THEN v_final := 'accepted'; END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'request_id', v_new.id, 'status', v_final,
    'sla_due_at', v_new.sla_due_at, 'hold_expires_at', v_new.hold_expires_at, 'expires_at', v_new.expires_at);
EXCEPTION WHEN unique_violation THEN
  -- Lost a race with an identical concurrent request: return the winner.
  SELECT * INTO v_existing FROM consumer_agent_requests WHERE principal = v_principal AND idempotency_key = v_key
    AND user_id = (SELECT user_id FROM business_profile WHERE booking_slug = v_slug);
  IF FOUND AND v_existing.args_hash = v_hash THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'request_id', v_existing.id, 'status', v_existing.status,
      'sla_due_at', v_existing.sla_due_at, 'hold_expires_at', v_existing.hold_expires_at, 'expires_at', v_existing.expires_at);
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', 'idempotency_conflict');
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_create_request(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_create_request(jsonb) TO service_role;

-- Minimal, PII-free status for the agent that created the request (the edge function checks the HMAC token first).
CREATE OR REPLACE FUNCTION public.consumer_agent_request_status(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r consumer_agent_requests%ROWTYPE;
BEGIN
  PERFORM public.consumer_agent_expire_stale();
  SELECT * INTO r FROM consumer_agent_requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('request_id', r.id, 'status', r.status, 'sla_due_at', r.sla_due_at, 'hold_expires_at', r.hold_expires_at,
    'decided_at', r.decided_at, 'decline_reason', r.decline_reason, 'updated_at', r.updated_at);
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_request_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consumer_agent_request_status(uuid) TO service_role;

-- 9) Owner RPCs (authenticated; same permission gate as the Google-booking controls) ----------------------------
CREATE OR REPLACE FUNCTION public.get_consumer_agent_settings()
RETURNS consumer_agent_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row consumer_agent_settings;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  INSERT INTO consumer_agent_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM consumer_agent_settings WHERE user_id = v_owner;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.get_consumer_agent_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_consumer_agent_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.update_consumer_agent_settings(p jsonb)
RETURNS consumer_agent_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row consumer_agent_settings;
  bp business_profile%ROWTYPE;
  v_enable boolean := (p ->> 'enabled')::boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'invalid'; END IF;
  INSERT INTO consumer_agent_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;

  IF v_enable IS TRUE THEN
    SELECT * INTO bp FROM business_profile WHERE user_id = v_owner;
    IF NOT FOUND OR bp.booking_slug IS NULL OR NOT coalesce(bp.booking_enabled, false)
       OR bp.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = bp.timezone)
       OR coalesce(bp.booking_hours, bp.business_hours) IS NULL
       OR (SELECT company_name FROM profiles WHERE id = v_owner) IS NULL THEN
      RAISE EXCEPTION 'not_ready';
    END IF;
    -- A tripped kill switch is only released by consumer_agent_set_kill_switch(false), never as a side effect of enabling.
    IF (SELECT kill_switch FROM consumer_agent_settings WHERE user_id = v_owner) THEN
      RAISE EXCEPTION 'kill_switch_on';
    END IF;
  END IF;

  UPDATE consumer_agent_settings SET
    enabled = coalesce(v_enable, enabled),
    publish_services = coalesce((p ->> 'publish_services')::boolean, publish_services),
    publish_service_area = coalesce((p ->> 'publish_service_area')::boolean, publish_service_area),
    publish_hours = coalesce((p ->> 'publish_hours')::boolean, publish_hours),
    publish_prices = coalesce((p ->> 'publish_prices')::boolean, publish_prices),
    publish_reviews = coalesce((p ->> 'publish_reviews')::boolean, publish_reviews),
    publish_policies = coalesce((p ->> 'publish_policies')::boolean, publish_policies),
    publish_contact = coalesce((p ->> 'publish_contact')::boolean, publish_contact),
    public_phone = CASE WHEN p ? 'public_phone' THEN nullif(btrim(p ->> 'public_phone'), '') ELSE public_phone END,
    public_email = CASE WHEN p ? 'public_email' THEN nullif(lower(btrim(p ->> 'public_email')), '') ELSE public_email END,
    public_website = CASE WHEN p ? 'public_website' THEN nullif(btrim(p ->> 'public_website'), '') ELSE public_website END,
    policies_text = CASE WHEN p ? 'policies_text' THEN nullif(btrim(p ->> 'policies_text'), '') ELSE policies_text END,
    request_mode = coalesce(p ->> 'request_mode', request_mode),
    hold_minutes = coalesce((p ->> 'hold_minutes')::integer, hold_minutes),
    daily_request_cap = coalesce((p ->> 'daily_request_cap')::integer, daily_request_cap),
    sla_minutes = coalesce((p ->> 'sla_minutes')::integer, sla_minutes),
    auto_accept_enabled = coalesce((p ->> 'auto_accept_enabled')::boolean, auto_accept_enabled),
    auto_accept_services = CASE WHEN p ? 'auto_accept_services'
                                THEN coalesce(ARRAY(SELECT left(btrim(x), 120) FROM jsonb_array_elements_text(p -> 'auto_accept_services') x WHERE btrim(x) <> '' LIMIT 20), '{}')
                                ELSE auto_accept_services END,
    auto_accept_min_lead_hours = coalesce((p ->> 'auto_accept_min_lead_hours')::integer, auto_accept_min_lead_hours),
    updated_at = now()
  WHERE user_id = v_owner
  RETURNING * INTO v_row;

  INSERT INTO consumer_agent_audit (user_id, actor_id, event, detail)
  VALUES (v_owner, auth.uid(), 'settings_updated', jsonb_build_object(
    'enabled', v_row.enabled, 'request_mode', v_row.request_mode, 'auto_accept_enabled', v_row.auto_accept_enabled,
    'published', to_jsonb(ARRAY_REMOVE(ARRAY[
      CASE WHEN v_row.publish_services THEN 'services' END, CASE WHEN v_row.publish_service_area THEN 'service_area' END,
      CASE WHEN v_row.publish_hours THEN 'hours' END, CASE WHEN v_row.publish_prices THEN 'prices' END,
      CASE WHEN v_row.publish_reviews THEN 'reviews' END, CASE WHEN v_row.publish_policies THEN 'policies' END,
      CASE WHEN v_row.publish_contact THEN 'contact' END], NULL))));
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.update_consumer_agent_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_consumer_agent_settings(jsonb) TO authenticated;

-- Takedown: instant, reversible only by an explicit owner action.
CREATE OR REPLACE FUNCTION public.consumer_agent_set_kill_switch(p_on boolean)
RETURNS consumer_agent_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row consumer_agent_settings;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO consumer_agent_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  UPDATE consumer_agent_settings SET kill_switch = coalesce(p_on, true),
         enabled = CASE WHEN coalesce(p_on, true) THEN false ELSE enabled END, updated_at = now()
   WHERE user_id = v_owner RETURNING * INTO v_row;
  IF coalesce(p_on, true) THEN
    -- Held slots are released immediately; requests already in the queue stay so a human can still answer them.
    UPDATE consumer_agent_requests SET status = 'pending', hold_expires_at = NULL, updated_at = now()
     WHERE user_id = v_owner AND status = 'held';
  END IF;
  INSERT INTO consumer_agent_audit (user_id, actor_id, event, detail)
  VALUES (v_owner, auth.uid(), CASE WHEN coalesce(p_on, true) THEN 'kill_switch_on' ELSE 'kill_switch_off' END, '{}'::jsonb);
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_set_kill_switch(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumer_agent_set_kill_switch(boolean) TO authenticated;

-- Exact preview: byte-for-byte what the public endpoints return once enabled, plus what stays private.
CREATE OR REPLACE FUNCTION public.consumer_agent_preview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_profile jsonb;
  s consumer_agent_settings%ROWTYPE;
  bp business_profile%ROWTYPE;
  v_blockers text[] := '{}';
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO consumer_agent_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO s FROM consumer_agent_settings WHERE user_id = v_owner;
  SELECT * INTO bp FROM business_profile WHERE user_id = v_owner;
  IF NOT FOUND OR bp.booking_slug IS NULL THEN v_blockers := v_blockers || 'booking_slug_missing'; END IF;
  IF NOT coalesce(bp.booking_enabled, false) THEN v_blockers := v_blockers || 'booking_disabled'; END IF;
  IF bp.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = bp.timezone) THEN v_blockers := v_blockers || 'timezone_invalid'; END IF;
  IF coalesce(bp.booking_hours, bp.business_hours) IS NULL THEN v_blockers := v_blockers || 'hours_missing'; END IF;
  IF (SELECT company_name FROM profiles WHERE id = v_owner) IS NULL THEN v_blockers := v_blockers || 'company_name_missing'; END IF;
  IF s.kill_switch THEN v_blockers := v_blockers || 'kill_switch_on'; END IF;
  v_profile := public.consumer_agent_profile_internal(v_owner, true);
  RETURN jsonb_build_object(
    'live', s.enabled AND NOT s.kill_switch AND cardinality(v_blockers) = 0,
    'blockers', to_jsonb(v_blockers),
    'profile', v_profile,
    'never_exposed', to_jsonb(ARRAY['customers', 'jobs', 'equipment', 'technicians', 'quotes', 'invoices', 'payments', 'inventory', 'review text', 'reviewer names', 'internal notes']));
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_preview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumer_agent_preview() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_consumer_agent_requests(p_status text DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid, status text, agent_label text, principal_kind text, service_type text, requested_start timestamptz,
  contact_name text, contact_phone text, contact_email text, postal_code text, address_line text,
  description_untrusted text, risk_flags text[], area_verified boolean,
  sla_due_at timestamptz, sla_state text, hold_expires_at timestamptz, expires_at timestamptz,
  decision text, decline_reason text, accept_error text, job_id uuid, created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  PERFORM public.consumer_agent_expire_stale();
  RETURN QUERY
  SELECT r.id, r.status, r.agent_label, r.principal_kind, r.service_type, r.requested_start,
         r.contact_name, r.contact_phone, r.contact_email, r.postal_code, r.address_line,
         r.description_untrusted, r.risk_flags, r.area_verified,
         r.sla_due_at,
         CASE WHEN r.status NOT IN ('pending', 'held') THEN 'closed'
              WHEN r.sla_due_at <= now() THEN 'overdue'
              WHEN r.sla_due_at <= now() + interval '15 minutes' THEN 'due_soon'
              ELSE 'ok' END,
         r.hold_expires_at, r.expires_at, r.decision, r.decline_reason, r.accept_error, r.job_id, r.created_at
  FROM consumer_agent_requests r
  WHERE r.user_id = v_owner AND (p_status IS NULL OR r.status = p_status)
  ORDER BY (r.status IN ('pending', 'held')) DESC, r.sla_due_at ASC, r.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION public.list_consumer_agent_requests(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_consumer_agent_requests(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_consumer_agent_request(p_id uuid, p_action text, p_decline_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r consumer_agent_requests%ROWTYPE;
  v_res jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_action NOT IN ('accept', 'decline') THEN RAISE EXCEPTION 'invalid_action'; END IF;
  SELECT * INTO r FROM consumer_agent_requests WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF p_action = 'accept' THEN
    RETURN public.consumer_agent_accept_internal(r.id, auth.uid(), false);
  END IF;

  IF r.status NOT IN ('pending', 'held') THEN RETURN jsonb_build_object('ok', false, 'error', 'not_open'); END IF;
  UPDATE consumer_agent_requests
     SET status = 'declined', decision = 'declined_by_owner', decided_by = auth.uid(), decided_at = now(), hold_expires_at = NULL,
         decline_reason = CASE WHEN p_decline_reason IN ('unavailable', 'outside_area', 'not_offered', 'other') THEN p_decline_reason ELSE 'other' END,
         updated_at = now()
   WHERE id = r.id;
  INSERT INTO consumer_agent_audit (user_id, actor_id, event, detail)
  VALUES (v_owner, auth.uid(), 'request_declined', jsonb_build_object('request_id', r.id));
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.decide_consumer_agent_request(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_consumer_agent_request(uuid, text, text) TO authenticated;

-- Aggregate activity for the owner dashboard (no PII, no principals).
CREATE OR REPLACE FUNCTION public.consumer_agent_activity()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN jsonb_build_object(
    'calls_24h', (SELECT count(*) FROM consumer_agent_events WHERE user_id = v_owner AND created_at > now() - interval '24 hours'),
    'calls_7d', (SELECT count(*) FROM consumer_agent_events WHERE user_id = v_owner AND created_at > now() - interval '7 days'),
    'denied_7d', (SELECT count(*) FROM consumer_agent_events WHERE user_id = v_owner AND created_at > now() - interval '7 days' AND outcome <> 'ok'),
    'flagged_7d', (SELECT count(*) FROM consumer_agent_events WHERE user_id = v_owner AND created_at > now() - interval '7 days' AND flagged),
    'requests_7d', (SELECT count(*) FROM consumer_agent_requests WHERE user_id = v_owner AND created_at > now() - interval '7 days'),
    'accepted_7d', (SELECT count(*) FROM consumer_agent_requests WHERE user_id = v_owner AND created_at > now() - interval '7 days' AND status = 'accepted'),
    'open_now', (SELECT count(*) FROM consumer_agent_requests WHERE user_id = v_owner AND status IN ('pending', 'held') AND expires_at > now()),
    'overdue_now', (SELECT count(*) FROM consumer_agent_requests WHERE user_id = v_owner AND status IN ('pending', 'held') AND expires_at > now() AND sla_due_at <= now()));
END;
$$;
REVOKE ALL ON FUNCTION public.consumer_agent_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumer_agent_activity() TO authenticated;
