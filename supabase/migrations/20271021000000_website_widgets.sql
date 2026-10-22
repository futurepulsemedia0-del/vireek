/*
  # Embeddable Website Widgets (booking, request-a-quote, reviews badge)

  Lets each account embed three widgets on its OWN website with one copy-paste <script>:
    - booking : slot picker that books through the SAME engine as the public /book/:slug page
    - quote   : request-a-quote form that lands in the existing `leads` pipeline
    - reviews : rating badge / review cards fed by the existing `reviews` table

  Pattern mirrors the Website Chat Widget (20270501000000_chat_widget.sql). Touches no existing table.
  Requires: profiles, team_members, business_profile, jobs, leads, reviews,
            public.get_account_owner_id(), public.create_public_booking_with_settings().

  ## Objects
  - website_widgets               : one row per account per widget type (look, copy, domains, per-type options).
  - website_widget_daily_stats    : per-widget daily counters (views / opens / conversions). Written ONLY by definer RPCs.
  - website_widgets_can_manage()  : authenticated - owner/admin OR team member with can_edit_business_profile.
  - get_public_website_widget     : anon - settings + data for one widget (+ install heartbeat).
  - track_website_widget_event    : anon - 'view' | 'open' (| 'convert' for the reviews badge only).
  - submit_website_widget_quote   : anon - validated, rate-limited lead insert (source = 'website_quote_widget').
  - submit_website_widget_booking : anon - validated, rate-limited booking via create_public_booking_with_settings.
  - rotate_website_widget_key     : authenticated manager - new public key (old snippet stops working).
  - preview_website_widget_data   : authenticated manager - same data payload for the dashboard live preview.

  ## Security notes
  - The public key identifies the widget; it is NOT a secret (it ships in page source). Abuse is bounded by
    allowed_domains, per-widget rate limits, a honeypot field and strict input validation.
  - Domain check prefers the browser-set Origin header (PostgREST exposes it in request.headers; page JS cannot forge
    it) and only falls back to the client-supplied host. Non-browser clients can still spoof - best-effort by design.
  - Anonymous users get NO table access; only the SECURITY DEFINER RPCs above.
  - Conversions are counted server-side inside the submit RPCs, so the client cannot fake them.
  - Reviewer names are shortened ("Jane D.") and review text is truncated before leaving the database.
*/

-- 1) Settings ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS website_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  widget_type text NOT NULL,
  public_key text NOT NULL UNIQUE DEFAULT ('ww_' || encode(gen_random_bytes(16), 'hex')),
  enabled boolean NOT NULL DEFAULT false,
  brand_color text NOT NULL DEFAULT '#3448E8',
  theme text NOT NULL DEFAULT 'auto',
  display_mode text NOT NULL DEFAULT 'floating',
  position text NOT NULL DEFAULT 'right',
  radius smallint NOT NULL DEFAULT 14,
  title text NOT NULL DEFAULT '',
  subtitle text NOT NULL DEFAULT '',
  button_label text NOT NULL DEFAULT '',
  success_message text NOT NULL DEFAULT '',
  allowed_domains text[] NOT NULL DEFAULT '{}',
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  last_seen_host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ww_type_check CHECK (widget_type IN ('booking', 'quote', 'reviews')),
  CONSTRAINT ww_unique_type UNIQUE (account_owner_id, widget_type),
  CONSTRAINT ww_color_check CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT ww_theme_check CHECK (theme IN ('light', 'dark', 'auto')),
  CONSTRAINT ww_mode_check CHECK (display_mode IN ('floating', 'inline')),
  CONSTRAINT ww_position_check CHECK (position IN ('left', 'right')),
  CONSTRAINT ww_radius_check CHECK (radius BETWEEN 0 AND 24),
  CONSTRAINT ww_title_check CHECK (char_length(title) <= 60),
  CONSTRAINT ww_subtitle_check CHECK (char_length(subtitle) <= 120),
  CONSTRAINT ww_button_check CHECK (char_length(button_label) <= 30),
  CONSTRAINT ww_success_check CHECK (char_length(success_message) <= 240),
  CONSTRAINT ww_domains_check CHECK (cardinality(allowed_domains) <= 20),
  CONSTRAINT ww_options_check CHECK (jsonb_typeof(options) = 'object' AND pg_column_size(options) <= 8192)
);

ALTER TABLE website_widgets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.website_widgets_can_manage()
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
REVOKE ALL ON FUNCTION public.website_widgets_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.website_widgets_can_manage() TO authenticated;

DROP POLICY IF EXISTS "ww_select" ON website_widgets;
CREATE POLICY "ww_select" ON website_widgets FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "ww_insert" ON website_widgets;
CREATE POLICY "ww_insert" ON website_widgets FOR INSERT TO authenticated
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.website_widgets_can_manage());

DROP POLICY IF EXISTS "ww_update" ON website_widgets;
CREATE POLICY "ww_update" ON website_widgets FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.website_widgets_can_manage())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.website_widgets_can_manage());

-- public_key / last_seen_* / widget_type are server-managed: block direct client changes to them.
CREATE OR REPLACE FUNCTION public.website_widgets_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.widget_type := OLD.widget_type;
    NEW.account_owner_id := OLD.account_owner_id;
    IF current_setting('vireek.ww_server_write', true) IS DISTINCT FROM '1' THEN
      NEW.public_key := OLD.public_key;
      NEW.last_seen_at := OLD.last_seen_at;
      NEW.last_seen_host := OLD.last_seen_host;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_website_widgets_guard ON website_widgets;
CREATE TRIGGER trg_website_widgets_guard BEFORE INSERT OR UPDATE ON website_widgets
  FOR EACH ROW EXECUTE FUNCTION public.website_widgets_guard();

-- 2) Per-widget daily analytics ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS website_widget_daily_stats (
  widget_id uuid NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  opens integer NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (widget_id, day)
);
CREATE INDEX IF NOT EXISTS idx_wwds_account_day ON website_widget_daily_stats(account_owner_id, day DESC);

ALTER TABLE website_widget_daily_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wwds_select" ON website_widget_daily_stats;
CREATE POLICY "wwds_select" ON website_widget_daily_stats FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies on purpose: counters are written only by the SECURITY DEFINER RPCs below.

-- Internal: bump one counter (UTC day). Not callable by API roles.
CREATE OR REPLACE FUNCTION public.website_widget_bump(p_widget uuid, p_owner uuid, p_event text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO website_widget_daily_stats AS s (widget_id, account_owner_id, day, views, opens, conversions)
  VALUES (p_widget, p_owner, (now() AT TIME ZONE 'utc')::date,
          (p_event = 'view')::int, (p_event = 'open')::int, (p_event = 'convert')::int)
  ON CONFLICT (widget_id, day) DO UPDATE
    SET views = s.views + EXCLUDED.views,
        opens = s.opens + EXCLUDED.opens,
        conversions = s.conversions + EXCLUDED.conversions;
$$;
REVOKE ALL ON FUNCTION public.website_widget_bump(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- 3) Small shared helpers ------------------------------------------------------------------
-- Host the request really came from: browser-set Origin header first, client-supplied host as fallback.
CREATE OR REPLACE FUNCTION public.website_widget_request_host(p_host text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_headers jsonb;
  v_origin text;
BEGIN
  BEGIN
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  v_origin := lower(coalesce(v_headers ->> 'origin', ''));
  IF v_origin ~ '^https?://[^/:]+' THEN
    RETURN left(regexp_replace(v_origin, '^https?://([^/:]+).*$', '\1'), 253);
  END IF;
  RETURN left(lower(nullif(trim(coalesce(p_host, '')), '')), 253);
END;
$$;

CREATE OR REPLACE FUNCTION public.website_widget_host_allowed(p_allowed text[], p_host text)
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

-- Integer option with a default and hard bounds (never raises on junk).
CREATE OR REPLACE FUNCTION public.website_widget_opt_int(p_opts jsonb, p_key text, p_default int, p_lo int, p_hi int)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN jsonb_typeof(p_opts -> p_key) = 'number' AND (p_opts ->> p_key) ~ '^-?\d{1,6}$'
              THEN least(p_hi, greatest(p_lo, (p_opts ->> p_key)::int))
              ELSE p_default END;
$$;

-- "Jane Doe" -> "Jane D."; blanks / "Anonymous" -> "Customer".
CREATE OR REPLACE FUNCTION public.website_widget_display_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_name, '')) = '' OR lower(btrim(p_name)) = 'anonymous' THEN 'Customer'
    WHEN position(' ' IN btrim(p_name)) = 0 THEN left(btrim(p_name), 40)
    ELSE left(split_part(btrim(p_name), ' ', 1), 40) || ' ' ||
         upper(left(regexp_replace(btrim(p_name), '^.*\s', ''), 1)) || '.'
  END;
$$;

-- Finds an ENABLED widget whose allowed_domains admit the caller. Returns an all-NULL row (id IS NULL) otherwise.
CREATE OR REPLACE FUNCTION public.website_widget_lookup(p_key text, p_host text)
RETURNS website_widgets
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w website_widgets;
BEGIN
  IF p_key IS NULL OR p_key !~ '^ww_[0-9a-f]{32}$' THEN RETURN NULL; END IF;
  SELECT * INTO w FROM website_widgets WHERE public_key = p_key AND enabled;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT public.website_widget_host_allowed(w.allowed_domains, public.website_widget_request_host(p_host)) THEN
    RETURN NULL;
  END IF;
  RETURN w;
END;
$$;
REVOKE ALL ON FUNCTION public.website_widget_lookup(text, text) FROM PUBLIC, anon, authenticated;

-- 4) Data payload (shared by the public RPC and the dashboard preview) ---------------------
CREATE OR REPLACE FUNCTION public.website_widget_payload(w website_widgets)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bp business_profile%ROWTYPE;
  v_name text := (SELECT company_name FROM profiles WHERE id = w.account_owner_id);
  v_data jsonb := '{}'::jsonb;
  v_opts jsonb := CASE WHEN jsonb_typeof(w.options) = 'object' THEN w.options ELSE '{}'::jsonb END;
  v_platforms text[];
  v_min_rating int;
  v_max int;
  v_count bigint;
  v_avg numeric;
  v_cards jsonb := '[]'::jsonb;
  v_cta text;
  v_services jsonb;
BEGIN
  SELECT * INTO bp FROM business_profile WHERE user_id = w.account_owner_id LIMIT 1;

  IF w.widget_type = 'booking' THEN
    IF NOT FOUND OR NOT bp.booking_enabled OR bp.booking_slug IS NULL THEN
      v_data := jsonb_build_object('unavailable', true, 'business_name', v_name);
    ELSE
      v_data := jsonb_build_object(
        'unavailable', false,
        'business_name', v_name,
        'timezone', bp.timezone,
        'services', coalesce((
          SELECT jsonb_agg(s) FROM unnest(coalesce(bp.services_offered, '{}')) s
          WHERE NOT (s = ANY (coalesce(bp.booking_hidden_services, '{}')))
        ), '[]'::jsonb),
        'hours', coalesce(bp.booking_hours, bp.business_hours),
        'holidays', coalesce((
          SELECT jsonb_agg(h ->> 'date') FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(bp.holidays) = 'array' THEN bp.holidays ELSE '[]'::jsonb END
          ) h WHERE h ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$'
        ), '[]'::jsonb),
        'duration_minutes', bp.booking_default_duration_minutes,
        'lead_time_hours', bp.booking_lead_time_hours,
        'window_days', bp.booking_window_days,
        'buffer_before', bp.booking_buffer_before_minutes,
        'buffer_after', bp.booking_buffer_after_minutes,
        'deposit_cents', bp.booking_deposit_cents,
        'deposit_policy', bp.booking_deposit_policy,
        'intake_questions', bp.booking_intake_questions,
        'confirmation_message', bp.booking_branding ->> 'confirmation_message',
        'busy', coalesce((
          SELECT jsonb_agg(jsonb_build_object('start', j.scheduled_datetime, 'minutes', coalesce(j.duration_minutes, 60)))
          FROM jobs j
          WHERE j.user_id = w.account_owner_id
            AND j.scheduled_datetime >= now()
            AND j.scheduled_datetime < now() + make_interval(days => bp.booking_window_days + 1)
            AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
        ), '[]'::jsonb)
      );
    END IF;

  ELSIF w.widget_type = 'quote' THEN
    IF v_opts ->> 'services_mode' = 'custom' AND jsonb_typeof(v_opts -> 'custom_services') = 'array'
       AND jsonb_array_length(v_opts -> 'custom_services') > 0 THEN
      v_services := (
        SELECT coalesce(jsonb_agg(left(s, 60)), '[]'::jsonb)
        FROM (SELECT value AS s FROM jsonb_array_elements_text(v_opts -> 'custom_services') LIMIT 30) t
      );
    ELSE
      v_services := coalesce(to_jsonb(bp.services_offered), '[]'::jsonb);
    END IF;
    v_data := jsonb_build_object('business_name', v_name, 'services', v_services);

  ELSIF w.widget_type = 'reviews' THEN
    SELECT coalesce(array_agg(p), '{}') INTO v_platforms
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(v_opts -> 'platforms') = 'array' THEN v_opts -> 'platforms' ELSE '[]'::jsonb END
    ) p
    WHERE p IN ('google', 'yelp', 'facebook');
    IF cardinality(v_platforms) = 0 THEN v_platforms := ARRAY['google', 'yelp', 'facebook']; END IF;

    v_min_rating := public.website_widget_opt_int(v_opts, 'min_rating', 4, 1, 5);
    v_max := public.website_widget_opt_int(v_opts, 'max_excerpts', 3, 1, 5);

    SELECT count(*), round(avg(rating)::numeric, 2) INTO v_count, v_avg
    FROM reviews WHERE user_id = w.account_owner_id AND platform = ANY (v_platforms);

    IF v_opts ->> 'layout' = 'cards' AND v_count > 0 THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'rating', t.rating,
               'text', t.excerpt,
               'author', public.website_widget_display_name(t.reviewer_name),
               'platform', t.platform,
               'date', t.reviewed_at
             ) ORDER BY t.reviewed_at DESC), '[]'::jsonb)
      INTO v_cards
      FROM (
        SELECT r.rating, r.reviewer_name, r.platform, r.reviewed_at,
               CASE WHEN char_length(btrim(r.body)) > 280 THEN left(btrim(r.body), 279) || '…' ELSE btrim(r.body) END AS excerpt
        FROM reviews r
        WHERE r.user_id = w.account_owner_id
          AND r.platform = ANY (v_platforms)
          AND r.rating >= v_min_rating
          AND r.body IS NOT NULL AND char_length(btrim(r.body)) >= 20
        ORDER BY r.reviewed_at DESC
        LIMIT v_max
      ) t;
    END IF;

    -- https only (never javascript:/data:), no whitespace, bounded length.
    v_cta := CASE
      WHEN char_length(v_opts ->> 'cta_url') <= 500 AND v_opts ->> 'cta_url' ~* '^https://[^\s]+$' THEN v_opts ->> 'cta_url'
      WHEN char_length(bp.google_review_url) <= 500 AND bp.google_review_url ~* '^https://[^\s]+$' THEN bp.google_review_url
      ELSE NULL END;

    v_data := jsonb_build_object(
      'business_name', v_name,
      'count', coalesce(v_count, 0),
      'average', coalesce(v_avg, 0),
      'show', coalesce(v_count, 0) >= public.website_widget_opt_int(v_opts, 'min_reviews', 1, 1, 100),
      'cards', v_cards,
      'cta_url', v_cta
    );
  END IF;

  RETURN jsonb_build_object(
    'type', w.widget_type,
    'settings', jsonb_build_object(
      'brand_color', w.brand_color,
      'theme', w.theme,
      'display_mode', w.display_mode,
      'position', w.position,
      'radius', w.radius,
      'title', w.title,
      'subtitle', w.subtitle,
      'button_label', w.button_label,
      'success_message', w.success_message,
      'options', v_opts
    ),
    'data', v_data
  );
END;
$$;
REVOKE ALL ON FUNCTION public.website_widget_payload(website_widgets) FROM PUBLIC, anon, authenticated;

-- 5) Public config (anon) ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_website_widget(p_key text, p_host text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w website_widgets := public.website_widget_lookup(p_key, p_host);
  v_host text := public.website_widget_request_host(p_host);
BEGIN
  IF w.id IS NULL THEN RETURN NULL; END IF;

  -- Install heartbeat, throttled to one write per 5 minutes per widget.
  IF v_host IS NOT NULL AND (w.last_seen_at IS NULL OR w.last_seen_at < now() - interval '5 minutes' OR w.last_seen_host IS DISTINCT FROM v_host) THEN
    PERFORM set_config('vireek.ww_server_write', '1', true);
    UPDATE website_widgets SET last_seen_at = now(), last_seen_host = v_host WHERE id = w.id;
  END IF;

  RETURN public.website_widget_payload(w);
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_website_widget(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_website_widget(text, text) TO anon, authenticated;

-- 6) Analytics event (anon) ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.track_website_widget_event(p_key text, p_host text, p_event text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w website_widgets;
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('view', 'open', 'convert') THEN RETURN; END IF;
  w := public.website_widget_lookup(p_key, p_host);
  IF w.id IS NULL THEN RETURN; END IF;
  -- Booking / quote conversions are counted by their submit RPCs; only the badge's CTA click is client-reported.
  IF p_event = 'convert' AND w.widget_type <> 'reviews' THEN RETURN; END IF;
  PERFORM public.website_widget_bump(w.id, w.account_owner_id, p_event);
END;
$$;
REVOKE ALL ON FUNCTION public.track_website_widget_event(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_website_widget_event(text, text, text) TO anon, authenticated;

-- 7) Quote request (anon) ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_website_widget_quote(
  p_key text, p_host text, p_name text, p_email text, p_phone text, p_service text,
  p_message text, p_zip text DEFAULT NULL, p_page_url text DEFAULT NULL, p_website text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w website_widgets := public.website_widget_lookup(p_key, p_host);
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
  v_phone text := nullif(left(btrim(coalesce(p_phone, '')), 40), '');
  v_service text := nullif(left(btrim(coalesce(p_service, '')), 80), '');
  v_message text := left(btrim(coalesce(p_message, '')), 2000);
  v_zip text := nullif(left(btrim(coalesce(p_zip, '')), 12), '');
  v_contact text;
  v_notes text;
BEGIN
  IF w.id IS NULL OR w.widget_type <> 'quote' THEN RAISE EXCEPTION 'WIDGET_INVALID'; END IF;

  -- Honeypot: bots fill the hidden field. Pretend success, store nothing.
  IF btrim(coalesce(p_website, '')) <> '' THEN RETURN true; END IF;

  v_contact := CASE WHEN w.options ->> 'contact_required' IN ('email', 'phone', 'either') THEN w.options ->> 'contact_required' ELSE 'either' END;

  IF char_length(v_name) < 2 THEN RAISE EXCEPTION 'WIDGET_BAD_NAME'; END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'WIDGET_BAD_EMAIL'; END IF;
  IF v_phone IS NOT NULL AND char_length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN RAISE EXCEPTION 'WIDGET_BAD_PHONE'; END IF;
  IF v_contact = 'email' AND v_email IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;
  IF v_contact = 'phone' AND v_phone IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;
  IF v_contact = 'either' AND v_email IS NULL AND v_phone IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;
  IF (w.options ->> 'message_required') = 'true' AND v_message = '' THEN RAISE EXCEPTION 'WIDGET_MESSAGE_REQUIRED'; END IF;

  IF (SELECT count(*) FROM leads
      WHERE user_id = w.account_owner_id AND source = 'website_quote_widget' AND created_at > now() - interval '10 minutes') >= 30 THEN
    RAISE EXCEPTION 'WIDGET_RATE_LIMITED';
  END IF;

  v_notes := nullif(btrim(
    v_message
    || CASE WHEN v_zip IS NOT NULL THEN E'\n\nZIP: ' || v_zip ELSE '' END
    || CASE WHEN nullif(left(coalesce(p_page_url, ''), 500), '') IS NOT NULL THEN E'\nSubmitted from: ' || left(p_page_url, 500) ELSE '' END
  ), '');

  INSERT INTO leads (user_id, name, phone, email, service_interested, notes, source)
  VALUES (w.account_owner_id, v_name, v_phone, v_email, v_service, v_notes, 'website_quote_widget');

  PERFORM public.website_widget_bump(w.id, w.account_owner_id, 'convert');
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_website_widget_quote(text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_website_widget_quote(text, text, text, text, text, text, text, text, text, text) TO anon, authenticated;

-- 8) Booking (anon) ------------------------------------------------------------------------
-- Delegates to create_public_booking_with_settings, so lead time, buffers, hidden services, intake validation,
-- customer matching and the jobs_no_double_booking constraint all apply exactly like the public /book page.
CREATE OR REPLACE FUNCTION public.submit_website_widget_booking(
  p_key text, p_host text, p_name text, p_phone text, p_email text, p_service text,
  p_start timestamptz, p_notes text DEFAULT NULL, p_intake jsonb DEFAULT '{}'::jsonb,
  p_page_url text DEFAULT NULL, p_website text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w website_widgets := public.website_widget_lookup(p_key, p_host);
  v_slug text;
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
  v_phone text := nullif(left(btrim(coalesce(p_phone, '')), 40), '');
  v_res jsonb;
BEGIN
  IF w.id IS NULL OR w.widget_type <> 'booking' THEN RAISE EXCEPTION 'WIDGET_INVALID'; END IF;

  IF btrim(coalesce(p_website, '')) <> '' THEN RETURN jsonb_build_object('deposit_due_cents', 0); END IF;

  SELECT bp.booking_slug INTO v_slug FROM business_profile bp
  WHERE bp.user_id = w.account_owner_id AND bp.booking_enabled LIMIT 1;
  IF v_slug IS NULL THEN RAISE EXCEPTION 'booking_not_available'; END IF;

  IF char_length(btrim(coalesce(p_name, ''))) < 2 THEN RAISE EXCEPTION 'missing_customer_name'; END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'WIDGET_BAD_EMAIL'; END IF;
  IF v_phone IS NOT NULL AND char_length(regexp_replace(v_phone, '\D', '', 'g')) < 7 THEN RAISE EXCEPTION 'WIDGET_BAD_PHONE'; END IF;
  IF v_email IS NULL AND v_phone IS NULL THEN RAISE EXCEPTION 'WIDGET_CONTACT_REQUIRED'; END IF;

  IF (SELECT count(*) FROM jobs
      WHERE user_id = w.account_owner_id AND booking_channel = 'website_widget' AND created_at > now() - interval '10 minutes') >= 30 THEN
    RAISE EXCEPTION 'WIDGET_RATE_LIMITED';
  END IF;

  v_res := public.create_public_booking_with_settings(
    p_slug => v_slug,
    p_customer_name => btrim(p_name),
    p_customer_phone => v_phone,
    p_customer_email => v_email,
    p_service_type => nullif(left(btrim(coalesce(p_service, '')), 80), ''),
    p_scheduled_datetime => p_start,
    p_notes => nullif(left(btrim(coalesce(p_notes, '')), 1000)
                      || CASE WHEN nullif(left(coalesce(p_page_url, ''), 500), '') IS NOT NULL
                              THEN E'\nBooked from: ' || left(p_page_url, 500) ELSE '' END, ''),
    p_channel => 'website_widget',
    p_intake_answers => coalesce(p_intake, '{}'::jsonb)
  );

  PERFORM public.website_widget_bump(w.id, w.account_owner_id, 'convert');
  -- The job id stays server-side: an anonymous visitor has no use for it.
  RETURN jsonb_build_object('deposit_due_cents', coalesce((v_res ->> 'deposit_due_cents')::int, 0));
END;
$$;
REVOKE ALL ON FUNCTION public.submit_website_widget_booking(text, text, text, text, text, text, timestamptz, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_website_widget_booking(text, text, text, text, text, text, timestamptz, text, jsonb, text, text) TO anon, authenticated;

-- 9) Key rotation + dashboard preview (authenticated managers) ------------------------------
CREATE OR REPLACE FUNCTION public.rotate_website_widget_key(p_type text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_key text := 'ww_' || encode(gen_random_bytes(16), 'hex');
BEGIN
  IF v_owner IS NULL OR NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'WIDGET_FORBIDDEN'; END IF;
  PERFORM set_config('vireek.ww_server_write', '1', true);
  UPDATE website_widgets SET public_key = v_key, last_seen_at = NULL, last_seen_host = NULL
  WHERE account_owner_id = v_owner AND widget_type = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'WIDGET_NOT_CONFIGURED'; END IF;
  RETURN v_key;
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_website_widget_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_website_widget_key(text) TO authenticated;

-- Same payload the embed receives, but for the caller's own account, even before the widget is saved/enabled.
CREATE OR REPLACE FUNCTION public.preview_website_widget_data(p_type text, p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  w website_widgets;
BEGIN
  IF v_owner IS NULL OR NOT public.website_widgets_can_manage() THEN RAISE EXCEPTION 'WIDGET_FORBIDDEN'; END IF;
  IF p_type IS NULL OR p_type NOT IN ('booking', 'quote', 'reviews') THEN RAISE EXCEPTION 'WIDGET_INVALID'; END IF;
  w.account_owner_id := v_owner;
  w.widget_type := p_type;
  w.options := CASE WHEN jsonb_typeof(p_options) = 'object' THEN p_options ELSE '{}'::jsonb END;
  w.brand_color := '#3448E8'; w.theme := 'auto'; w.display_mode := 'floating'; w.position := 'right'; w.radius := 14;
  w.title := ''; w.subtitle := ''; w.button_label := ''; w.success_message := '';
  RETURN public.website_widget_payload(w) -> 'data';
END;
$$;
REVOKE ALL ON FUNCTION public.preview_website_widget_data(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_website_widget_data(text, jsonb) TO authenticated;
