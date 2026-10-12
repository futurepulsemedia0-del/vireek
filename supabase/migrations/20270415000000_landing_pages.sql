/*
  # Landing & Booking Page Builder

  Tables: landing_pages, landing_domains, landing_page_events
  - Account-scoped RLS via get_account_owner_id() + can_manage_landing_pages()
  - Public access ONLY through SECURITY DEFINER RPCs (same pattern as online booking)
  - Domain ownership is proven by DNS TXT; clients can never set status='verified'
  - Booking conversions reuse create_public_booking() (channel 'landing_page')
*/

-- ---------------------------------------------------------------
-- Permission helper (mirrors AuthContext: owner OR can_edit_business_profile,
-- custom role overrides base flags where it defines a value)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_landing_pages()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.invite_status = 'active'
        AND COALESCE(
          (cr.permissions ->> 'can_edit_business_profile')::boolean,
          (tm.permissions ->> 'can_edit_business_profile')::boolean,
          false
        )
    );
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_landing_pages() TO authenticated;

-- ---------------------------------------------------------------
-- landing_pages
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landing_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  headline text NOT NULL,
  subheadline text,
  body text,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  cta_label text NOT NULL DEFAULT 'Get a free quote',
  cta_mode text NOT NULL DEFAULT 'lead_form',
  accent_color text NOT NULL DEFAULT '#2563eb',
  seo_title text,
  seo_description text,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_pages_slug_format CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  CONSTRAINT landing_pages_cta_mode CHECK (cta_mode IN ('lead_form', 'booking', 'both')),
  CONSTRAINT landing_pages_status CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT landing_pages_accent CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT landing_pages_lengths CHECK (
    char_length(title) BETWEEN 1 AND 120
    AND char_length(headline) BETWEEN 1 AND 160
    AND char_length(cta_label) BETWEEN 1 AND 40
    AND (subheadline IS NULL OR char_length(subheadline) <= 300)
    AND (body IS NULL OR char_length(body) <= 5000)
    AND (seo_title IS NULL OR char_length(seo_title) <= 70)
    AND (seo_description IS NULL OR char_length(seo_description) <= 170)
  ),
  CONSTRAINT landing_pages_sections CHECK (
    jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 6
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_landing_pages_slug ON landing_pages(slug);
CREATE INDEX IF NOT EXISTS idx_landing_pages_user ON landing_pages(user_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.landing_pages_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' AND auth.role() = 'authenticated'
     AND (SELECT count(*) FROM landing_pages WHERE user_id = NEW.user_id) >= 50 THEN
    RAISE EXCEPTION 'page_limit_reached';
  END IF;
  IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landing_pages_before_write ON landing_pages;
CREATE TRIGGER trg_landing_pages_before_write
  BEFORE INSERT OR UPDATE ON landing_pages
  FOR EACH ROW EXECUTE FUNCTION public.landing_pages_before_write();

-- ---------------------------------------------------------------
-- landing_domains
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landing_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  domain text NOT NULL,
  landing_page_id uuid REFERENCES landing_pages(id) ON DELETE SET NULL,
  verification_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_domains_status CHECK (status IN ('pending', 'verified', 'failed')),
  CONSTRAINT landing_domains_format CHECK (
    domain = lower(domain)
    AND char_length(domain) <= 253
    AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  )
);

-- Same account can't add a domain twice; only ONE account may hold a domain as
-- verified (so nobody can squat a domain by adding it unverified first).
CREATE UNIQUE INDEX IF NOT EXISTS uq_landing_domains_account_domain ON landing_domains(user_id, domain);
CREATE UNIQUE INDEX IF NOT EXISTS uq_landing_domains_verified ON landing_domains(domain) WHERE status = 'verified';
CREATE INDEX IF NOT EXISTS idx_landing_domains_page ON landing_domains(landing_page_id);

CREATE OR REPLACE FUNCTION public.landing_domains_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.domain := lower(NEW.domain);
  IF auth.role() = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      IF (SELECT count(*) FROM landing_domains WHERE user_id = NEW.user_id) >= 10 THEN
        RAISE EXCEPTION 'domain_limit_reached';
      END IF;
      NEW.status := 'pending';
      NEW.verified_at := NULL;
      NEW.last_checked_at := NULL;
      NEW.last_error := NULL;
      NEW.verification_token := replace(gen_random_uuid()::text, '-', '');
    ELSE
      IF NEW.domain IS DISTINCT FROM OLD.domain THEN
        RAISE EXCEPTION 'domain_immutable';
      END IF;
      -- Verification state belongs to the verifier (service role) only.
      NEW.status := OLD.status;
      NEW.verified_at := OLD.verified_at;
      NEW.verification_token := OLD.verification_token;
      NEW.last_checked_at := OLD.last_checked_at;
      NEW.last_error := OLD.last_error;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landing_domains_guard ON landing_domains;
CREATE TRIGGER trg_landing_domains_guard
  BEFORE INSERT OR UPDATE ON landing_domains
  FOR EACH ROW EXECUTE FUNCTION public.landing_domains_guard();

-- ---------------------------------------------------------------
-- landing_page_events (written only by SECURITY DEFINER RPCs below)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landing_page_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  landing_page_id uuid NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  event_type text NOT NULL,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  click_id text,
  referrer text,
  host text,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landing_events_type CHECK (event_type IN ('view', 'cta_click', 'lead', 'booking'))
);

CREATE INDEX IF NOT EXISTS idx_landing_events_page_time ON landing_page_events(landing_page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_landing_events_user_time ON landing_page_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_landing_events_visitor ON landing_page_events(landing_page_id, visitor_id, event_type, created_at DESC);

-- ---------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------
ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_page_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_landing_pages" ON landing_pages;
CREATE POLICY "select_own_landing_pages" ON landing_pages FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages());
DROP POLICY IF EXISTS "insert_own_landing_pages" ON landing_pages;
CREATE POLICY "insert_own_landing_pages" ON landing_pages FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages());
DROP POLICY IF EXISTS "update_own_landing_pages" ON landing_pages;
CREATE POLICY "update_own_landing_pages" ON landing_pages FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages());
DROP POLICY IF EXISTS "delete_own_landing_pages" ON landing_pages;
CREATE POLICY "delete_own_landing_pages" ON landing_pages FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages());

DROP POLICY IF EXISTS "select_own_landing_domains" ON landing_domains;
CREATE POLICY "select_own_landing_domains" ON landing_domains FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages());
DROP POLICY IF EXISTS "insert_own_landing_domains" ON landing_domains;
CREATE POLICY "insert_own_landing_domains" ON landing_domains FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_landing_pages()
    AND (landing_domains.landing_page_id IS NULL OR EXISTS (
      SELECT 1 FROM landing_pages lp
      WHERE lp.id = landing_domains.landing_page_id AND lp.user_id = landing_domains.user_id))
  );
DROP POLICY IF EXISTS "update_own_landing_domains" ON landing_domains;
CREATE POLICY "update_own_landing_domains" ON landing_domains FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages())
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_landing_pages()
    AND (landing_domains.landing_page_id IS NULL OR EXISTS (
      SELECT 1 FROM landing_pages lp
      WHERE lp.id = landing_domains.landing_page_id AND lp.user_id = landing_domains.user_id))
  );
-- No DELETE policy on purpose: removal goes through the landing-domain-verify
-- edge function so a verified domain is also detached from the host.

DROP POLICY IF EXISTS "select_own_landing_events" ON landing_page_events;
CREATE POLICY "select_own_landing_events" ON landing_page_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_landing_pages());
-- No INSERT/UPDATE/DELETE policies: events are append-only via RPCs.

-- ---------------------------------------------------------------
-- Internal helpers (not callable by API roles)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landing_attr(p jsonb, k text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(nullif(btrim(coalesce(p ->> k, '')), ''), 200);
$$;

CREATE OR REPLACE FUNCTION public.landing_record_event(
  p_page_id uuid, p_user_id uuid, p_visitor_id text, p_type text,
  p_attr jsonb, p_host text, p_lead_id uuid, p_job_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO landing_page_events (
    user_id, landing_page_id, visitor_id, event_type,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    click_id, referrer, host, lead_id, job_id
  ) VALUES (
    p_user_id, p_page_id, p_visitor_id, p_type,
    landing_attr(p_attr, 'utm_source'), landing_attr(p_attr, 'utm_medium'),
    landing_attr(p_attr, 'utm_campaign'), landing_attr(p_attr, 'utm_term'),
    landing_attr(p_attr, 'utm_content'), landing_attr(p_attr, 'click_id'),
    landing_attr(p_attr, 'referrer'),
    left(lower(nullif(btrim(coalesce(p_host, '')), '')), 253),
    p_lead_id, p_job_id
  );
$$;
REVOKE ALL ON FUNCTION public.landing_record_event(uuid, uuid, text, text, jsonb, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------
-- Public RPCs (anon + authenticated)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_published_landing_page(p_slug text DEFAULT NULL, p_host text DEFAULT NULL)
RETURNS TABLE (
  id uuid, slug text, title text, headline text, subheadline text, body text,
  sections jsonb, cta_label text, cta_mode text, accent_color text,
  seo_title text, seo_description text, business_name text,
  services_offered text[], booking_slug text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    lp.id, lp.slug, lp.title, lp.headline, lp.subheadline, lp.body,
    lp.sections, lp.cta_label, lp.cta_mode, lp.accent_color,
    lp.seo_title, lp.seo_description, p.company_name,
    bp.services_offered,
    CASE WHEN bp.booking_enabled THEN bp.booking_slug ELSE NULL END
  FROM landing_pages lp
  JOIN profiles p ON p.id = lp.user_id
  LEFT JOIN business_profile bp ON bp.user_id = lp.user_id
  WHERE lp.status = 'published'
    AND (
      (p_host IS NOT NULL AND lp.id = (
        SELECT d.landing_page_id FROM landing_domains d
        WHERE d.domain = lower(p_host) AND d.status = 'verified' LIMIT 1))
      OR (p_host IS NULL AND p_slug IS NOT NULL AND lp.slug = lower(p_slug))
    )
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_published_landing_page(text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.track_landing_event(
  p_page_id uuid, p_visitor_id text, p_event_type text,
  p_attribution jsonb DEFAULT '{}'::jsonb, p_host text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF p_event_type NOT IN ('view', 'cta_click') THEN
    RAISE EXCEPTION 'invalid_event';
  END IF;
  IF p_visitor_id IS NULL OR length(p_visitor_id) NOT BETWEEN 8 AND 64 THEN
    RAISE EXCEPTION 'invalid_visitor';
  END IF;

  SELECT user_id INTO v_user FROM landing_pages WHERE id = p_page_id AND status = 'published';
  IF v_user IS NULL THEN RETURN; END IF;

  -- Flood guard: silently drop (analytics must never error the page).
  IF (SELECT count(*) FROM landing_page_events
      WHERE landing_page_id = p_page_id AND visitor_id = p_visitor_id
        AND created_at > now() - interval '1 hour') >= 100 THEN
    RETURN;
  END IF;

  -- One view per visitor per 30 minutes (reloads don't inflate views).
  IF p_event_type = 'view' AND EXISTS (
    SELECT 1 FROM landing_page_events
    WHERE landing_page_id = p_page_id AND visitor_id = p_visitor_id
      AND event_type = 'view' AND created_at > now() - interval '30 minutes'
  ) THEN
    RETURN;
  END IF;

  PERFORM public.landing_record_event(p_page_id, v_user, p_visitor_id, p_event_type, p_attribution, p_host, NULL, NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.track_landing_event(uuid, text, text, jsonb, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_landing_lead(
  p_page_id uuid, p_visitor_id text, p_name text, p_phone text, p_email text,
  p_service text, p_message text,
  p_attribution jsonb DEFAULT '{}'::jsonb, p_host text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_slug text;
  v_lead uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_notes text;
  v_source text;
BEGIN
  IF p_visitor_id IS NULL OR length(p_visitor_id) NOT BETWEEN 8 AND 64 THEN
    RAISE EXCEPTION 'invalid_visitor';
  END IF;

  SELECT user_id, slug INTO v_user, v_slug FROM landing_pages WHERE id = p_page_id AND status = 'published';
  IF v_user IS NULL THEN RAISE EXCEPTION 'page_not_available'; END IF;

  IF v_name = '' OR char_length(v_name) > 120 THEN RAISE EXCEPTION 'invalid_name'; END IF;
  IF v_phone IS NULL AND v_email IS NULL THEN RAISE EXCEPTION 'contact_required'; END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^[0-9+() .-]{7,32}$' THEN RAISE EXCEPTION 'invalid_phone'; END IF;
  IF v_email IS NOT NULL AND (char_length(v_email) > 254 OR v_email !~ '^[^@ ]+@[^@ ]+\.[^@ ]+$') THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;

  IF (SELECT count(*) FROM landing_page_events
      WHERE landing_page_id = p_page_id AND visitor_id = p_visitor_id
        AND event_type = 'lead' AND created_at > now() - interval '1 hour') >= 5
     OR (SELECT count(*) FROM landing_page_events
      WHERE landing_page_id = p_page_id AND event_type = 'lead'
        AND created_at > now() - interval '1 hour') >= 300 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Idempotent double-submit: same contact within 10 minutes returns the same lead.
  SELECT id INTO v_lead FROM leads
  WHERE user_id = v_user
    AND created_at > now() - interval '10 minutes'
    AND ((v_phone IS NOT NULL AND phone = v_phone) OR (v_email IS NOT NULL AND email = v_email))
  ORDER BY created_at DESC LIMIT 1;
  IF v_lead IS NOT NULL THEN RETURN v_lead; END IF;

  v_source := concat_ws(' · ',
    'Landing page: ' || v_slug,
    'source=' || landing_attr(p_attribution, 'utm_source'),
    'medium=' || landing_attr(p_attribution, 'utm_medium'),
    'campaign=' || landing_attr(p_attribution, 'utm_campaign'));
  v_notes := concat_ws(E'\n\n', nullif(left(btrim(coalesce(p_message, '')), 2000), ''), '[' || v_source || ']');

  INSERT INTO leads (user_id, name, phone, email, service_interested, notes)
  VALUES (v_user, v_name, v_phone, v_email, left(nullif(btrim(coalesce(p_service, '')), ''), 120), v_notes)
  RETURNING id INTO v_lead;

  PERFORM public.landing_record_event(p_page_id, v_user, p_visitor_id, 'lead', p_attribution, p_host, v_lead, NULL);
  RETURN v_lead;
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_landing_lead(uuid, text, text, text, text, text, text, jsonb, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_landing_booking(
  p_page_id uuid, p_visitor_id text, p_name text, p_phone text, p_email text,
  p_service text, p_scheduled_datetime timestamptz, p_notes text,
  p_attribution jsonb DEFAULT '{}'::jsonb, p_host text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_booking_slug text;
  v_job uuid;
BEGIN
  IF p_visitor_id IS NULL OR length(p_visitor_id) NOT BETWEEN 8 AND 64 THEN
    RAISE EXCEPTION 'invalid_visitor';
  END IF;

  SELECT lp.user_id, bp.booking_slug INTO v_user, v_booking_slug
  FROM landing_pages lp
  LEFT JOIN business_profile bp ON bp.user_id = lp.user_id AND bp.booking_enabled
  WHERE lp.id = p_page_id AND lp.status = 'published' AND lp.cta_mode IN ('booking', 'both');

  IF v_user IS NULL OR v_booking_slug IS NULL THEN RAISE EXCEPTION 'booking_not_available'; END IF;

  IF (SELECT count(*) FROM landing_page_events
      WHERE landing_page_id = p_page_id AND visitor_id = p_visitor_id
        AND event_type = 'booking' AND created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- Slot locking, lead-time, double-booking checks all live in create_public_booking.
  v_job := public.create_public_booking(
    p_slug => v_booking_slug,
    p_customer_name => p_name,
    p_customer_phone => p_phone,
    p_customer_email => p_email,
    p_service_type => p_service,
    p_scheduled_datetime => p_scheduled_datetime,
    p_notes => p_notes,
    p_channel => 'landing_page',
    p_ref_code => NULL
  );

  PERFORM public.landing_record_event(p_page_id, v_user, p_visitor_id, 'booking', p_attribution, p_host, NULL, v_job);
  RETURN v_job;
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_landing_booking(uuid, text, text, text, text, text, timestamptz, text, jsonb, text) TO anon, authenticated;

-- ---------------------------------------------------------------
-- Dashboard analytics (SECURITY INVOKER: RLS scopes to the account)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_landing_page_analytics(p_days integer DEFAULT 30)
RETURNS TABLE (landing_page_id uuid, views bigint, visitors bigint, cta_clicks bigint, leads bigint, bookings bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    e.landing_page_id,
    count(*) FILTER (WHERE e.event_type = 'view'),
    count(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view'),
    count(*) FILTER (WHERE e.event_type = 'cta_click'),
    count(*) FILTER (WHERE e.event_type = 'lead'),
    count(*) FILTER (WHERE e.event_type = 'booking')
  FROM landing_page_events e
  WHERE e.created_at >= now() - make_interval(days => LEAST(GREATEST(coalesce(p_days, 30), 1), 365))
  GROUP BY e.landing_page_id;
$$;

CREATE OR REPLACE FUNCTION public.get_landing_utm_breakdown(p_page_id uuid DEFAULT NULL, p_days integer DEFAULT 30)
RETURNS TABLE (utm_source text, utm_medium text, utm_campaign text, visitors bigint, leads bigint, bookings bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    coalesce(e.utm_source, nullif(split_part(e.referrer, '/', 1), ''), '(direct)'),
    coalesce(e.utm_medium, CASE WHEN e.referrer IS NOT NULL THEN 'referral' ELSE '(none)' END),
    coalesce(e.utm_campaign, '(none)'),
    count(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view'),
    count(*) FILTER (WHERE e.event_type = 'lead'),
    count(*) FILTER (WHERE e.event_type = 'booking')
  FROM landing_page_events e
  WHERE e.created_at >= now() - make_interval(days => LEAST(GREATEST(coalesce(p_days, 30), 1), 365))
    AND (p_page_id IS NULL OR e.landing_page_id = p_page_id)
  GROUP BY 1, 2, 3
  ORDER BY 4 DESC, 5 DESC
  LIMIT 100;
$$;

CREATE OR REPLACE FUNCTION public.get_landing_daily_series(p_page_id uuid DEFAULT NULL, p_days integer DEFAULT 30)
RETURNS TABLE (day date, visitors bigint, conversions bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH n AS (SELECT LEAST(GREATEST(coalesce(p_days, 30), 1), 365) AS v),
  days AS (
    SELECT generate_series(
      (current_date - ((SELECT v FROM n) - 1))::timestamp, current_date::timestamp, interval '1 day'
    )::date AS d
  )
  SELECT
    days.d AS day,
    count(DISTINCT e.visitor_id) FILTER (WHERE e.event_type = 'view'),
    count(*) FILTER (WHERE e.event_type IN ('lead', 'booking'))
  FROM days
  LEFT JOIN landing_page_events e
    ON e.created_at >= days.d AND e.created_at < days.d + 1
   AND (p_page_id IS NULL OR e.landing_page_id = p_page_id)
  GROUP BY days.d
  ORDER BY days.d;
$$;

REVOKE ALL ON FUNCTION public.get_landing_page_analytics(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landing_utm_breakdown(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landing_daily_series(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landing_page_analytics(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_landing_utm_breakdown(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_landing_daily_series(uuid, integer) TO authenticated;
