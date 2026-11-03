/*
  # "Answered by Vireek" trust badge (embeddable, verified, privacy-first)

  Customers embed a badge on their own website. Anything the badge or the public verification page claims
  is computed server-side from real data, only for data the customer approved, and only for hosts whose
  domain the customer has proven they own.

  ## Objects
  - calls.answer_ms                  : OPTIONAL measured answer time. Nothing populates it yet -> the "answer time" stat
                                       stays off (neutral text) until a trustworthy source writes it.
  - trust_badge_settings             : one row per account (slug, approvals, powered-by, rel, card actions, heartbeat).
  - trust_badge_domains              : website domains + DNS TXT proof (_vireek-badge.<domain>). Unique while verified.
  - trust_badge_rate_limit           : per-minute buckets for the public endpoint (service role only).
  - trust_badge_get / _save          : authenticated managers - read / validated update (owner + admin or can_edit_business_profile).
  - trust_badge_add_domain / _remove_domain : authenticated managers.
  - trust_badge_verified_domains     : service role - union of badge domains + already-verified brand/landing domains.
  - trust_badge_public_context       : service role - everything the public edge function needs, in one round trip.
  - trust_badge_touch / _hit         : service role - install heartbeat / rate limiter.

  ## Security
  - Anonymous and authenticated roles get NO table writes and NO access to the service-role functions: the public
    endpoint is an edge function using the service role, so the browser can never fabricate state.
  - Settings can only change through trust_badge_save (explicit field list; table CHECKs are the second line).
  - Plan-based white-label: "Powered by Vireek" cannot be switched off unless brand_plan_is_white_label(plan).
    It is enforced in the guard trigger AND again at render time (downgrades take effect immediately).

  Requires: profiles, calls, business_profile, brand_settings, landing_domains, partners,
            public.get_account_owner_id(), public.website_widgets_can_manage(), public.brand_plan_is_white_label(),
            pgcrypto (gen_random_bytes) - all already used by earlier migrations.

  Rollback: DROP the functions and tables created here (trust_badge_*), then
            DROP INDEX idx_calls_trust_badge; ALTER TABLE calls DROP COLUMN answer_ms.  No existing data is modified.
*/

-- 0) calls: optional measured answer time + the index the stats query uses ----------------------------------
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS answer_ms integer;
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_answer_ms_range;
ALTER TABLE public.calls ADD CONSTRAINT calls_answer_ms_range CHECK (answer_ms IS NULL OR answer_ms BETWEEN 0 AND 600000) NOT VALID;
ALTER TABLE public.calls VALIDATE CONSTRAINT calls_answer_ms_range;
-- On a very large calls table, create this first with CREATE INDEX CONCURRENTLY (same name) outside a transaction.
CREATE INDEX IF NOT EXISTS idx_calls_trust_badge ON public.calls (user_id, call_datetime DESC) WHERE is_voicemail = false;

-- 1) Settings --------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trust_badge_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  public_slug text NOT NULL UNIQUE DEFAULT ('tb-' || encode(gen_random_bytes(5), 'hex')),
  display_name text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  stat_metric text NOT NULL DEFAULT 'calls',
  approve_active_since boolean NOT NULL DEFAULT false,
  approve_plan_category boolean NOT NULL DEFAULT false,
  approve_answer_stats boolean NOT NULL DEFAULT false,
  show_powered_by boolean NOT NULL DEFAULT true,
  link_rel text[] NOT NULL DEFAULT ARRAY['nofollow']::text[],
  card_phone text,
  card_booking_enabled boolean NOT NULL DEFAULT false,
  first_enabled_at timestamptz,
  last_seen_at timestamptz,
  last_seen_host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tbs_slug_format CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  CONSTRAINT tbs_slug_reserved CHECK (public_slug NOT IN ('technician', 'home', 'api', 'admin', 'badge', 'embed', 'vireek', 'www', 'app', 'support', 'security', 'status')),
  CONSTRAINT tbs_name_len CHECK (char_length(display_name) <= 80 AND display_name !~ '[[:cntrl:]]'),
  CONSTRAINT tbs_metric CHECK (stat_metric IN ('calls', 'answer_time')),
  CONSTRAINT tbs_rel CHECK (link_rel <@ ARRAY['nofollow', 'sponsored', 'ugc']::text[]),
  CONSTRAINT tbs_phone CHECK (card_phone IS NULL OR card_phone ~ '^\+[1-9][0-9]{6,14}$')
);

ALTER TABLE public.trust_badge_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tbs_select" ON public.trust_badge_settings;
CREATE POLICY "tbs_select" ON public.trust_badge_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies on purpose: writes go through trust_badge_save() only.

CREATE OR REPLACE FUNCTION public.trust_badge_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text;
BEGIN
  SELECT p.plan INTO v_plan FROM profiles p WHERE p.id = NEW.account_owner_id;
  IF NOT public.brand_plan_is_white_label(v_plan) THEN
    NEW.show_powered_by := true; -- white-label is a Business/Enterprise feature
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id THEN
      RAISE EXCEPTION 'A badge cannot move to another account' USING ERRCODE = '42501';
    END IF;
    IF OLD.first_enabled_at IS NOT NULL AND NEW.public_slug IS DISTINCT FROM OLD.public_slug THEN
      RAISE EXCEPTION 'The badge address is locked once the badge has been enabled, because installed badges use it.' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.enabled AND NEW.first_enabled_at IS NULL THEN
    NEW.first_enabled_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_trust_badge_settings_guard ON public.trust_badge_settings;
CREATE TRIGGER trg_trust_badge_settings_guard
  BEFORE INSERT OR UPDATE ON public.trust_badge_settings
  FOR EACH ROW EXECUTE FUNCTION public.trust_badge_settings_guard();

-- 2) Domains ----------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trust_badge_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  domain text NOT NULL,
  verification_token text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tbd_status CHECK (status IN ('pending', 'verified', 'failed')),
  CONSTRAINT tbd_format CHECK (domain = lower(domain) AND char_length(domain) <= 253
    AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  CONSTRAINT tbd_unique_per_account UNIQUE (account_owner_id, domain)
);
-- A domain can be verified by one account at a time (same idea as brand_settings / landing_domains).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tbd_verified_domain ON public.trust_badge_domains (domain) WHERE status = 'verified';
CREATE INDEX IF NOT EXISTS idx_tbd_owner ON public.trust_badge_domains (account_owner_id);

ALTER TABLE public.trust_badge_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tbd_select" ON public.trust_badge_domains;
CREATE POLICY "tbd_select" ON public.trust_badge_domains FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

-- 3) Rate-limit buckets (service role only; RLS on with no policies) --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trust_badge_rate_limit (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.trust_badge_rate_limit ENABLE ROW LEVEL SECURITY;

-- 4) Service-role helpers ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trust_badge_hit(p_bucket text, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hits integer;
BEGIN
  IF p_bucket IS NULL OR char_length(p_bucket) > 120 THEN RETURN false; END IF;
  INSERT INTO trust_badge_rate_limit AS r (bucket, window_start, hits)
  VALUES (p_bucket, date_trunc('minute', now()), 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING hits INTO v_hits;
  IF random() < 0.01 THEN
    DELETE FROM trust_badge_rate_limit WHERE window_start < now() - interval '1 hour';
  END IF;
  RETURN v_hits <= p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.trust_badge_verified_domains(p_owner uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT x.d), ARRAY[]::text[])
  FROM (
    SELECT d.domain AS d FROM trust_badge_domains d WHERE d.account_owner_id = p_owner AND d.status = 'verified'
    UNION ALL
    SELECT lower(b.custom_domain) FROM brand_settings b
      WHERE b.user_id = p_owner AND b.domain_status = 'verified' AND b.custom_domain IS NOT NULL
    UNION ALL
    SELECT l.domain FROM landing_domains l WHERE l.user_id = p_owner AND l.status = 'verified'
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.trust_badge_touch(p_slug text, p_host text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE trust_badge_settings
     SET last_seen_at = now(), last_seen_host = left(p_host, 253)
   WHERE public_slug = p_slug
     AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes' OR last_seen_host IS DISTINCT FROM left(p_host, 253));
$$;

CREATE OR REPLACE FUNCTION public.trust_badge_public_context(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s trust_badge_settings%ROWTYPE;
  p profiles%ROWTYPE;
  v_stats jsonb := NULL;
  v_booking text;
  v_partner text;
BEGIN
  SELECT * INTO s FROM trust_badge_settings WHERE public_slug = p_slug;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM profiles WHERE id = s.account_owner_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF s.approve_answer_stats THEN
    SELECT jsonb_build_object(
      'callCount', count(*),
      'latestCallAt', max(c.call_datetime),
      'timedCount', count(c.answer_ms),
      'latestTimedAt', max(c.call_datetime) FILTER (WHERE c.answer_ms IS NOT NULL),
      'avgAnswerMs', round(avg(c.answer_ms))
    ) INTO v_stats
    FROM calls c
    WHERE c.user_id = s.account_owner_id
      AND c.is_voicemail = false
      AND COALESCE(c.duration_seconds, 0) >= 5
      AND c.call_datetime >= now() - interval '30 days'
      AND c.call_datetime <= now() + interval '5 minutes';
  END IF;

  IF s.card_booking_enabled THEN
    SELECT bp.booking_slug INTO v_booking FROM business_profile bp
     WHERE bp.user_id = s.account_owner_id AND bp.booking_enabled AND bp.booking_slug IS NOT NULL;
  END IF;
  SELECT pt.referral_code INTO v_partner FROM partners pt WHERE pt.user_id = s.account_owner_id AND pt.status = 'approved';

  RETURN jsonb_build_object(
    'slug', s.public_slug,
    'enabled', s.enabled,
    'displayName', COALESCE(NULLIF(s.display_name, ''), NULLIF(p.company_name, ''), 'This business'),
    'profileStatus', p.status,
    'subscriptionStatus', p.subscription_status,
    'whiteLabel', public.brand_plan_is_white_label(p.plan),
    'planCategory', CASE WHEN s.approve_plan_category THEN
        CASE WHEN public.brand_plan_is_white_label(p.plan) THEN 'business' ELSE 'standard' END END,
    'activeSince', CASE WHEN s.approve_active_since THEN to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM') END,
    'metric', s.stat_metric,
    'stats', v_stats,
    'showPoweredBy', s.show_powered_by,
    'linkRel', to_jsonb(s.link_rel),
    'cardPhone', s.card_phone,
    'bookingSlug', v_booking,
    'partnerCode', v_partner,
    'hosts', to_jsonb(public.trust_badge_verified_domains(s.account_owner_id))
  );
END;
$$;

-- 5) Dashboard RPCs (authenticated managers) ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trust_badge_get()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s trust_badge_settings%ROWTYPE;
  p profiles%ROWTYPE;
  v_ctx jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage the trust badge.' USING ERRCODE = '42501'; END IF;

  INSERT INTO trust_badge_settings (account_owner_id, display_name)
  SELECT v_owner, COALESCE(pr.company_name, '') FROM profiles pr WHERE pr.id = v_owner
  ON CONFLICT (account_owner_id) DO NOTHING;

  SELECT * INTO s FROM trust_badge_settings WHERE account_owner_id = v_owner;
  SELECT * INTO p FROM profiles WHERE id = v_owner;
  v_ctx := public.trust_badge_public_context(s.public_slug);

  RETURN jsonb_build_object(
    'settings', to_jsonb(s),
    'domains', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at) FROM trust_badge_domains d WHERE d.account_owner_id = v_owner), '[]'::jsonb),
    'inheritedDomains', COALESCE((SELECT jsonb_agg(h) FROM jsonb_array_elements_text(v_ctx -> 'hosts') h
        WHERE h NOT IN (SELECT d.domain FROM trust_badge_domains d WHERE d.account_owner_id = v_owner AND d.status = 'verified')), '[]'::jsonb),
    'whiteLabel', public.brand_plan_is_white_label(p.plan),
    'partnerApproved', (v_ctx ->> 'partnerCode') IS NOT NULL,
    'partnerCode', v_ctx -> 'partnerCode',
    'bookingSlug', (SELECT bp.booking_slug FROM business_profile bp WHERE bp.user_id = v_owner AND bp.booking_enabled),
    'liveStats', (SELECT jsonb_build_object(
        'callCount', count(*), 'latestCallAt', max(c.call_datetime),
        'timedCount', count(c.answer_ms), 'latestTimedAt', max(c.call_datetime) FILTER (WHERE c.answer_ms IS NOT NULL),
        'avgAnswerMs', round(avg(c.answer_ms)))
      FROM calls c WHERE c.user_id = v_owner AND c.is_voicemail = false AND COALESCE(c.duration_seconds, 0) >= 5
        AND c.call_datetime >= now() - interval '30 days' AND c.call_datetime <= now() + interval '5 minutes'),
    'profileStatus', p.status,
    'subscriptionStatus', p.subscription_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trust_badge_save(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s trust_badge_settings%ROWTYPE;
  v_rel text[];
  v_enable boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage the trust badge.' USING ERRCODE = '42501'; END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Invalid settings' USING ERRCODE = '22023'; END IF;

  SELECT * INTO s FROM trust_badge_settings WHERE account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open the trust badge page first.' USING ERRCODE = 'P0002'; END IF;

  IF p ? 'link_rel' THEN
    SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[]) INTO v_rel FROM jsonb_array_elements_text(p -> 'link_rel') t;
  END IF;
  v_enable := COALESCE((p ->> 'enabled')::boolean, s.enabled);
  IF v_enable AND NOT s.enabled AND cardinality(public.trust_badge_verified_domains(v_owner)) = 0 THEN
    RAISE EXCEPTION 'Verify a website domain before enabling the badge.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE trust_badge_settings SET
    display_name = COALESCE(btrim(p ->> 'display_name'), display_name),
    public_slug = COALESCE(lower(btrim(p ->> 'public_slug')), public_slug),
    enabled = v_enable,
    stat_metric = COALESCE(p ->> 'stat_metric', stat_metric),
    approve_active_since = COALESCE((p ->> 'approve_active_since')::boolean, approve_active_since),
    approve_plan_category = COALESCE((p ->> 'approve_plan_category')::boolean, approve_plan_category),
    approve_answer_stats = COALESCE((p ->> 'approve_answer_stats')::boolean, approve_answer_stats),
    show_powered_by = COALESCE((p ->> 'show_powered_by')::boolean, show_powered_by),
    link_rel = COALESCE(v_rel, link_rel),
    card_phone = CASE WHEN p ? 'card_phone' THEN NULLIF(btrim(p ->> 'card_phone'), '') ELSE card_phone END,
    card_booking_enabled = COALESCE((p ->> 'card_booking_enabled')::boolean, card_booking_enabled)
  WHERE account_owner_id = v_owner;

  RETURN public.trust_badge_get();
END;
$$;

CREATE OR REPLACE FUNCTION public.trust_badge_add_domain(p_domain text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_domain text := regexp_replace(regexp_replace(lower(btrim(COALESCE(p_domain, ''))), '^[a-z]+://', ''), '[/?#:].*$', '');
  v_row trust_badge_domains%ROWTYPE;
  v_suffix text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage the trust badge.' USING ERRCODE = '42501'; END IF;
  v_domain := regexp_replace(regexp_replace(v_domain, '\.$', ''), '^www\.', '');
  FOREACH v_suffix IN ARRAY ARRAY['vireek.com', 'vireek.app', 'vercel.app', 'supabase.co', 'localhost', 'local', 'internal', 'example', 'invalid', 'test'] LOOP
    IF v_domain = v_suffix OR v_domain LIKE '%.' || v_suffix THEN
      RAISE EXCEPTION 'That domain belongs to a platform we host on. Use your own domain.' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM trust_badge_domains WHERE account_owner_id = v_owner) >= 10 THEN
    RAISE EXCEPTION 'You can add at most 10 domains.' USING ERRCODE = '54000';
  END IF;
  INSERT INTO trust_badge_domains (account_owner_id, domain) VALUES (v_owner, v_domain)
  ON CONFLICT (account_owner_id, domain) DO NOTHING;
  SELECT * INTO v_row FROM trust_badge_domains WHERE account_owner_id = v_owner AND domain = v_domain;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.trust_badge_remove_domain(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '28000'; END IF;
  IF NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'You do not have permission to manage the trust badge.' USING ERRCODE = '42501'; END IF;
  DELETE FROM trust_badge_domains WHERE id = p_id AND account_owner_id = v_owner;
END;
$$;

-- 6) Grants: explicit allow-lists -------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.trust_badge_hit(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trust_badge_verified_domains(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trust_badge_touch(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trust_badge_public_context(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trust_badge_settings_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trust_badge_hit(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.trust_badge_verified_domains(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.trust_badge_touch(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trust_badge_public_context(text) TO service_role;

REVOKE ALL ON FUNCTION public.trust_badge_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trust_badge_save(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trust_badge_add_domain(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trust_badge_remove_domain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trust_badge_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trust_badge_save(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trust_badge_add_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trust_badge_remove_domain(uuid) TO authenticated;

REVOKE ALL ON public.trust_badge_settings, public.trust_badge_domains, public.trust_badge_rate_limit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trust_badge_settings, public.trust_badge_domains TO authenticated;
