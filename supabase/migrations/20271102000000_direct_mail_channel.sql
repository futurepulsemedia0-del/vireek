/*
  # Direct-mail (postcard) offline channel

  Postcards are printed + mailed by a print API (Lob). Every mailer gets its own tracking code that is
  printed as text and encoded in a QR code ({SITE_URL}/m/{code}). Scans resolve to an existing Vireek
  landing page with utm_source=direct_mail / utm_medium=postcard / utm_campaign=dm-xxxxxxxx /
  utm_content={code}; the existing landing_page_events table therefore already carries the attribution
  and leads / bookings are joined back to the exact mailer. Phone responses are logged against the code.

  Security model (same as calendar_feeds):
    - Every table is SELECT-only for clients, scoped to the account owner AND a manager (billing permission).
    - Every write goes through SECURITY DEFINER RPCs that re-check authorization, or through the
      service role (edge functions: direct-mail-send / -settings / -webhook).
    - direct_mail_settings (encrypted API key) has NO client grants at all; clients use direct_mail_settings_get().
*/

-- =============================================================
-- AUTHORIZATION HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.direct_mail_ctx(OUT owner_id uuid, OUT can_manage boolean)
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

  SELECT t.account_owner_id, t.role, t.permissions, cr.permissions AS role_permissions
    INTO tm
  FROM public.team_members t
  LEFT JOIN public.custom_roles cr ON cr.id = t.custom_role_id
  WHERE t.user_id = auth.uid()
  LIMIT 1;

  IF FOUND THEN
    owner_id := tm.account_owner_id;
    can_manage :=
      tm.role IN ('admin', 'owner')
      OR COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
      OR COALESCE(tm.role_permissions ->> 'can_view_billing', 'false') = 'true';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()) THEN
    owner_id := auth.uid();
    can_manage := true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.direct_mail_ctx() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_mail_ctx() TO authenticated;

-- Raises 42501 unless the caller is a manager; returns the account owner id.
CREATE OR REPLACE FUNCTION public.direct_mail_require_manager()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
BEGIN
  SELECT * INTO c FROM public.direct_mail_ctx();
  IF c.owner_id IS NULL OR NOT COALESCE(c.can_manage, false) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN c.owner_id;
END;
$$;

REVOKE ALL ON FUNCTION public.direct_mail_require_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_mail_require_manager() TO authenticated;

-- MUST mirror addressKey() in supabase/functions/_shared/direct-mail/engine.ts
CREATE OR REPLACE FUNCTION public.direct_mail_address_key(p_line1 text, p_line2 text, p_zip text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(lower(coalesce(p_line1, '') || ' ' || coalesce(p_line2, '')), '[^a-z0-9]', '', 'g')
         || '|' || left(coalesce(p_zip, ''), 5);
$$;

CREATE OR REPLACE FUNCTION public.direct_mail_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- TABLES
-- =============================================================

-- One row per account. Holds the ENCRYPTED print-provider credentials: never granted to API roles.
CREATE TABLE IF NOT EXISTS public.direct_mail_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'lob' CHECK (provider IN ('lob')),
  encrypted_api_key text,
  api_key_last4 text,
  api_mode text CHECK (api_mode IN ('test', 'live')),
  encrypted_webhook_secret text,
  webhook_token text NOT NULL
    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  return_name text,
  return_line1 text,
  return_line2 text,
  return_city text,
  return_state text,
  return_zip text,
  default_landing_page_id uuid REFERENCES public.landing_pages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_mail_settings_token_format CHECK (webhook_token ~ '^[0-9a-f]{64}$'),
  CONSTRAINT direct_mail_settings_state CHECK (return_state IS NULL OR return_state ~ '^[A-Z]{2}$'),
  CONSTRAINT direct_mail_settings_zip CHECK (return_zip IS NULL OR return_zip ~ '^[0-9]{5}(-[0-9]{4})?$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_mail_settings_token ON public.direct_mail_settings (webhook_token);

CREATE TABLE IF NOT EXISTS public.direct_mail_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'paused', 'completed', 'cancelled')),
  landing_page_id uuid REFERENCES public.landing_pages(id) ON DELETE SET NULL,
  size text NOT NULL DEFAULT '6x9' CHECK (size IN ('4x6', '6x9', '6x11')),
  mail_type text NOT NULL DEFAULT 'usps_standard' CHECK (mail_type IN ('usps_first_class', 'usps_standard')),
  headline text NOT NULL DEFAULT '' CHECK (char_length(headline) <= 80),
  offer text NOT NULL DEFAULT '' CHECK (char_length(offer) <= 160),
  cta text NOT NULL DEFAULT 'Scan to book online' CHECK (char_length(cta) <= 60),
  phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 32),
  accent_color text NOT NULL DEFAULT '#0F62FE' CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  est_unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (est_unit_cost_cents BETWEEN 0 AND 10000),
  budget_cap_cents integer CHECK (budget_cap_cents IS NULL OR budget_cap_cents > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_direct_mail_campaigns_user ON public.direct_mail_campaigns (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.direct_mail_pieces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.direct_mail_campaigns(id) ON DELETE CASCADE,
  tracking_code text NOT NULL CHECK (tracking_code ~ '^[0-9A-HJKMNP-TV-Z]{9}$'),
  recipient_name text NOT NULL,
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  zip text NOT NULL CHECK (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  address_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'submitting', 'submitted', 'in_transit', 'delivered', 'returned', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  provider_id text,
  provider_url text,
  expected_delivery date,
  cost_cents integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  cost_estimated boolean NOT NULL DEFAULT false,
  last_error text,
  scan_count integer NOT NULL DEFAULT 0,
  first_scan_at timestamptz,
  last_scan_at timestamptz,
  submitted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_mail_pieces_code ON public.direct_mail_pieces (tracking_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_mail_pieces_address ON public.direct_mail_pieces (campaign_id, address_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_mail_pieces_provider ON public.direct_mail_pieces (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_direct_mail_pieces_campaign_status ON public.direct_mail_pieces (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_direct_mail_pieces_user ON public.direct_mail_pieces (user_id);

CREATE TABLE IF NOT EXISTS public.direct_mail_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  piece_id uuid NOT NULL REFERENCES public.direct_mail_pieces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('scan', 'provider')),
  detail text,
  visitor_id text,
  provider_event_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_mail_events_provider ON public.direct_mail_events (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_direct_mail_events_piece ON public.direct_mail_events (piece_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_direct_mail_events_scan ON public.direct_mail_events (user_id, kind, occurred_at DESC);

-- Offline responses logged by a person (e.g. a CSR taking a call that quotes the code).
CREATE TABLE IF NOT EXISTS public.direct_mail_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  piece_id uuid NOT NULL REFERENCES public.direct_mail_pieces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('call', 'lead', 'booking', 'walk_in', 'other')),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_direct_mail_responses_piece ON public.direct_mail_responses (piece_id);
CREATE INDEX IF NOT EXISTS idx_direct_mail_responses_user ON public.direct_mail_responses (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.direct_mail_suppressions (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  address_key text NOT NULL,
  reason text NOT NULL DEFAULT 'do_not_mail' CHECK (char_length(reason) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address_key)
);

DROP TRIGGER IF EXISTS trg_direct_mail_settings_touch ON public.direct_mail_settings;
CREATE TRIGGER trg_direct_mail_settings_touch BEFORE UPDATE ON public.direct_mail_settings
  FOR EACH ROW EXECUTE FUNCTION public.direct_mail_touch_updated_at();
DROP TRIGGER IF EXISTS trg_direct_mail_campaigns_touch ON public.direct_mail_campaigns;
CREATE TRIGGER trg_direct_mail_campaigns_touch BEFORE UPDATE ON public.direct_mail_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.direct_mail_touch_updated_at();
DROP TRIGGER IF EXISTS trg_direct_mail_pieces_touch ON public.direct_mail_pieces;
CREATE TRIGGER trg_direct_mail_pieces_touch BEFORE UPDATE ON public.direct_mail_pieces
  FOR EACH ROW EXECUTE FUNCTION public.direct_mail_touch_updated_at();

-- =============================================================
-- RLS + GRANTS (read-only for clients)
-- =============================================================
ALTER TABLE public.direct_mail_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_mail_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_mail_pieces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_mail_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_mail_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_mail_suppressions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.direct_mail_settings FROM anon, authenticated;
REVOKE ALL ON public.direct_mail_campaigns FROM anon, authenticated;
REVOKE ALL ON public.direct_mail_pieces FROM anon, authenticated;
REVOKE ALL ON public.direct_mail_events FROM anon, authenticated;
REVOKE ALL ON public.direct_mail_responses FROM anon, authenticated;
REVOKE ALL ON public.direct_mail_suppressions FROM anon, authenticated;

GRANT SELECT ON public.direct_mail_campaigns, public.direct_mail_pieces, public.direct_mail_events,
  public.direct_mail_responses, public.direct_mail_suppressions TO authenticated;

DROP POLICY IF EXISTS "direct_mail_campaigns_select" ON public.direct_mail_campaigns;
CREATE POLICY "direct_mail_campaigns_select" ON public.direct_mail_campaigns FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.direct_mail_ctx() c WHERE c.owner_id = direct_mail_campaigns.user_id AND c.can_manage));

DROP POLICY IF EXISTS "direct_mail_pieces_select" ON public.direct_mail_pieces;
CREATE POLICY "direct_mail_pieces_select" ON public.direct_mail_pieces FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.direct_mail_ctx() c WHERE c.owner_id = direct_mail_pieces.user_id AND c.can_manage));

DROP POLICY IF EXISTS "direct_mail_events_select" ON public.direct_mail_events;
CREATE POLICY "direct_mail_events_select" ON public.direct_mail_events FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.direct_mail_ctx() c WHERE c.owner_id = direct_mail_events.user_id AND c.can_manage));

DROP POLICY IF EXISTS "direct_mail_responses_select" ON public.direct_mail_responses;
CREATE POLICY "direct_mail_responses_select" ON public.direct_mail_responses FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.direct_mail_ctx() c WHERE c.owner_id = direct_mail_responses.user_id AND c.can_manage));

DROP POLICY IF EXISTS "direct_mail_suppressions_select" ON public.direct_mail_suppressions;
CREATE POLICY "direct_mail_suppressions_select" ON public.direct_mail_suppressions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.direct_mail_ctx() c WHERE c.owner_id = direct_mail_suppressions.user_id AND c.can_manage));

-- =============================================================
-- SETTINGS RPCs
-- =============================================================
-- Safe view of the settings: never returns the key, the secret or any ciphertext.
CREATE OR REPLACE FUNCTION public.direct_mail_settings_get()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  s public.direct_mail_settings%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.direct_mail_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('configured', false, 'api_mode', NULL, 'api_key_last4', NULL,
      'webhook_secret_set', false, 'webhook_token', NULL, 'return_address', NULL, 'default_landing_page_id', NULL);
  END IF;
  RETURN jsonb_build_object(
    'configured', s.encrypted_api_key IS NOT NULL,
    'api_mode', s.api_mode,
    'api_key_last4', s.api_key_last4,
    'webhook_secret_set', s.encrypted_webhook_secret IS NOT NULL,
    'webhook_token', s.webhook_token,
    'return_address', jsonb_build_object('name', s.return_name, 'line1', s.return_line1, 'line2', s.return_line2,
      'city', s.return_city, 'state', s.return_state, 'zip', s.return_zip),
    'default_landing_page_id', s.default_landing_page_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.direct_mail_settings_save(
  p_name text, p_line1 text, p_line2 text, p_city text, p_state text, p_zip text, p_landing_page_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  v_state text := upper(btrim(coalesce(p_state, '')));
  v_zip text := btrim(coalesce(p_zip, ''));
BEGIN
  IF btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_line1, '')) = '' OR btrim(coalesce(p_city, '')) = '' THEN
    RAISE EXCEPTION 'return_address_incomplete' USING ERRCODE = '22023';
  END IF;
  IF v_state !~ '^[A-Z]{2}$' OR v_zip !~ '^[0-9]{5}(-[0-9]{4})?$' THEN
    RAISE EXCEPTION 'return_address_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_landing_page_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.landing_pages lp WHERE lp.id = p_landing_page_id AND lp.user_id = v_owner) THEN
    RAISE EXCEPTION 'landing_page_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.direct_mail_settings (user_id, return_name, return_line1, return_line2, return_city, return_state, return_zip, default_landing_page_id)
  VALUES (v_owner, left(btrim(p_name), 120), left(btrim(p_line1), 200), nullif(left(btrim(coalesce(p_line2, '')), 200), ''),
          left(btrim(p_city), 100), v_state, v_zip, p_landing_page_id)
  ON CONFLICT (user_id) DO UPDATE SET
    return_name = EXCLUDED.return_name, return_line1 = EXCLUDED.return_line1, return_line2 = EXCLUDED.return_line2,
    return_city = EXCLUDED.return_city, return_state = EXCLUDED.return_state, return_zip = EXCLUDED.return_zip,
    default_landing_page_id = EXCLUDED.default_landing_page_id;
END;
$$;

-- =============================================================
-- CAMPAIGN RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.direct_mail_campaign_save(
  p_id uuid, p_name text, p_landing_page_id uuid, p_size text, p_mail_type text, p_headline text, p_offer text,
  p_cta text, p_phone text, p_accent_color text, p_est_unit_cost_cents integer, p_budget_cap_cents integer
)
RETURNS public.direct_mail_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  c public.direct_mail_campaigns%ROWTYPE;
BEGIN
  IF p_landing_page_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.landing_pages lp WHERE lp.id = p_landing_page_id AND lp.user_id = v_owner) THEN
    RAISE EXCEPTION 'landing_page_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.direct_mail_campaigns (user_id, name, landing_page_id, size, mail_type, headline, offer, cta, phone,
      accent_color, est_unit_cost_cents, budget_cap_cents, created_by)
    VALUES (v_owner, btrim(p_name), p_landing_page_id, p_size, p_mail_type, btrim(coalesce(p_headline, '')),
      btrim(coalesce(p_offer, '')), btrim(coalesce(p_cta, '')), btrim(coalesce(p_phone, '')), p_accent_color,
      coalesce(p_est_unit_cost_cents, 0), p_budget_cap_cents, auth.uid())
    RETURNING * INTO c;
    RETURN c;
  END IF;

  SELECT * INTO c FROM public.direct_mail_campaigns WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'campaign_locked' USING ERRCODE = '55000';
  END IF;

  UPDATE public.direct_mail_campaigns SET
    name = btrim(p_name), landing_page_id = p_landing_page_id, size = p_size, mail_type = p_mail_type,
    headline = btrim(coalesce(p_headline, '')), offer = btrim(coalesce(p_offer, '')), cta = btrim(coalesce(p_cta, '')),
    phone = btrim(coalesce(p_phone, '')), accent_color = p_accent_color,
    est_unit_cost_cents = coalesce(p_est_unit_cost_cents, 0), budget_cap_cents = p_budget_cap_cents
  WHERE id = c.id
  RETURNING * INTO c;
  RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION public.direct_mail_campaign_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  c public.direct_mail_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.direct_mail_campaigns WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.direct_mail_pieces WHERE campaign_id = c.id AND provider_id IS NOT NULL) THEN
    RAISE EXCEPTION 'campaign_has_mailed_pieces' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.direct_mail_campaigns WHERE id = c.id;
END;
$$;

-- Adds recipients (max 5000 per call, 20000 per campaign). Skips invalid rows, addresses already in the
-- campaign, repeats inside the batch and suppressed (do-not-mail) addresses. Tracking codes are generated by
-- the client (engine.generateTrackingCode); a code collision simply comes back as "collisions" and is retried.
CREATE OR REPLACE FUNCTION public.direct_mail_add_pieces(p_campaign_id uuid, p_pieces jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  c public.direct_mail_campaigns%ROWTYPE;
  v_existing integer;
  v_res jsonb;
BEGIN
  IF p_pieces IS NULL OR jsonb_typeof(p_pieces) <> 'array' THEN
    RAISE EXCEPTION 'pieces_invalid' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_pieces) > 5000 THEN
    RAISE EXCEPTION 'too_many_pieces' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO c FROM public.direct_mail_campaigns WHERE id = p_campaign_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'campaign_locked' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_existing FROM public.direct_mail_pieces WHERE campaign_id = c.id;
  IF v_existing + jsonb_array_length(p_pieces) > 20000 THEN
    RAISE EXCEPTION 'campaign_too_large' USING ERRCODE = '22023';
  END IF;

  WITH input AS (
    SELECT * FROM jsonb_to_recordset(p_pieces) AS x(tracking_code text, name text, line1 text, line2 text, city text, state text, zip text)
  ),
  cleaned AS (
    SELECT
      upper(btrim(coalesce(tracking_code, ''))) AS code,
      left(btrim(coalesce(name, '')), 120) AS name,
      left(btrim(coalesce(line1, '')), 200) AS line1,
      nullif(left(btrim(coalesce(line2, '')), 200), '') AS line2,
      left(btrim(coalesce(city, '')), 100) AS city,
      upper(btrim(coalesce(state, ''))) AS state,
      btrim(coalesce(zip, '')) AS zip
    FROM input
  ),
  valid AS (
    SELECT cl.*, public.direct_mail_address_key(cl.line1, cl.line2, cl.zip) AS akey
    FROM cleaned cl
    WHERE cl.code ~ '^[0-9A-HJKMNP-TV-Z]{9}$' AND cl.name <> '' AND cl.line1 <> '' AND cl.city <> ''
      AND cl.state ~ '^[A-Z]{2}$' AND cl.zip ~ '^[0-9]{5}(-[0-9]{4})?$'
  ),
  fresh AS (
    SELECT DISTINCT ON (v.akey) v.*
    FROM valid v
    WHERE NOT EXISTS (SELECT 1 FROM public.direct_mail_pieces p WHERE p.campaign_id = c.id AND p.address_key = v.akey)
    ORDER BY v.akey, v.code
  ),
  ok AS (
    SELECT f.* FROM fresh f
    WHERE NOT EXISTS (SELECT 1 FROM public.direct_mail_suppressions s WHERE s.user_id = v_owner AND s.address_key = f.akey)
  ),
  ins AS (
    INSERT INTO public.direct_mail_pieces (user_id, campaign_id, tracking_code, recipient_name, line1, line2, city, state, zip, address_key)
    SELECT v_owner, c.id, o.code, o.name, o.line1, o.line2, o.city, o.state, o.zip, o.akey FROM ok o
    ON CONFLICT DO NOTHING
    RETURNING tracking_code
  )
  SELECT jsonb_build_object(
    'received', (SELECT count(*) FROM input),
    'invalid', (SELECT count(*) FROM input) - (SELECT count(*) FROM valid),
    'duplicates', (SELECT count(*) FROM valid) - (SELECT count(*) FROM fresh),
    'suppressed', (SELECT count(*) FROM fresh) - (SELECT count(*) FROM ok),
    'collisions', (SELECT count(*) FROM ok) - (SELECT count(*) FROM ins),
    'inserted_codes', COALESCE((SELECT jsonb_agg(tracking_code) FROM ins), '[]'::jsonb)
  ) INTO v_res;

  RETURN v_res;
END;
$$;

-- pause / cancel. Cancelling also cancels every piece that has NOT been handed to the printer yet.
CREATE OR REPLACE FUNCTION public.direct_mail_campaign_set_status(p_id uuid, p_status text)
RETURNS public.direct_mail_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  c public.direct_mail_campaigns%ROWTYPE;
BEGIN
  IF p_status NOT IN ('paused', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM public.direct_mail_campaigns WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.status IN ('completed', 'cancelled') OR (p_status = 'paused' AND c.status <> 'sending') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '55000';
  END IF;

  IF p_status = 'cancelled' THEN
    UPDATE public.direct_mail_pieces SET status = 'cancelled' WHERE campaign_id = c.id AND status = 'queued';
  END IF;
  UPDATE public.direct_mail_campaigns SET status = p_status WHERE id = c.id RETURNING * INTO c;
  RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION public.direct_mail_suppress_piece(p_piece_id uuid, p_reason text DEFAULT 'do_not_mail')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  p public.direct_mail_pieces%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.direct_mail_pieces WHERE id = p_piece_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'piece_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.direct_mail_suppressions (user_id, address_key, reason)
  VALUES (v_owner, p.address_key, left(coalesce(nullif(btrim(p_reason), ''), 'do_not_mail'), 120))
  ON CONFLICT DO NOTHING;
  UPDATE public.direct_mail_pieces SET status = 'cancelled' WHERE id = p.id AND status = 'queued';
END;
$$;

-- Logs an offline response (phone call etc.) against a printed code. Returns what the CSR needs to confirm.
CREATE OR REPLACE FUNCTION public.direct_mail_record_response(
  p_code text, p_kind text, p_note text DEFAULT NULL, p_lead_id uuid DEFAULT NULL, p_job_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[\s\-_.]', '', 'g'));
  p public.direct_mail_pieces%ROWTYPE;
  v_campaign text;
BEGIN
  v_code := translate(v_code, 'OIL', '011');
  IF p_kind NOT IN ('call', 'lead', 'booking', 'walk_in', 'other') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO p FROM public.direct_mail_pieces WHERE tracking_code = v_code AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'code_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.id = p_lead_id AND l.user_id = v_owner) THEN
    RAISE EXCEPTION 'lead_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.direct_mail_responses (user_id, piece_id, kind, lead_id, job_id, note, created_by)
  VALUES (v_owner, p.id, p_kind, p_lead_id, p_job_id, nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid());

  SELECT name INTO v_campaign FROM public.direct_mail_campaigns WHERE id = p.campaign_id;
  RETURN jsonb_build_object('piece_id', p.id, 'campaign_name', v_campaign, 'recipient_name', p.recipient_name, 'status', p.status);
END;
$$;

-- =============================================================
-- PUBLIC SCAN RESOLVER (QR / short link) - anon + authenticated
-- =============================================================
CREATE OR REPLACE FUNCTION public.direct_mail_resolve_scan(p_code text, p_visitor_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[\s\-_.]', '', 'g'));
  p public.direct_mail_pieces%ROWTYPE;
  c public.direct_mail_campaigns%ROWTYPE;
  v_slug text;
  v_business text;
  v_visitor text := CASE WHEN p_visitor_id IS NOT NULL AND length(p_visitor_id) BETWEEN 8 AND 64 THEN p_visitor_id ELSE NULL END;
BEGIN
  v_code := translate(v_code, 'OIL', '011');
  IF v_code !~ '^[0-9A-HJKMNP-TV-Z]{9}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO p FROM public.direct_mail_pieces WHERE tracking_code = v_code;
  IF NOT FOUND OR p.status IN ('queued', 'cancelled') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM public.direct_mail_campaigns WHERE id = p.campaign_id;
  IF NOT FOUND OR c.status = 'cancelled' THEN
    RETURN NULL;
  END IF;

  SELECT company_name INTO v_business FROM public.profiles WHERE id = p.user_id;
  SELECT lp.slug INTO v_slug FROM public.landing_pages lp
  WHERE lp.id = c.landing_page_id AND lp.status = 'published';

  -- Count one scan per visitor per 30 minutes; silently drop floods (never error the redirect).
  IF NOT EXISTS (
       SELECT 1 FROM public.direct_mail_events e
       WHERE e.piece_id = p.id AND e.kind = 'scan' AND e.occurred_at > now() - interval '30 minutes'
         AND (v_visitor IS NULL OR e.visitor_id = v_visitor))
     AND (SELECT count(*) FROM public.direct_mail_events e WHERE e.piece_id = p.id AND e.kind = 'scan'
          AND e.occurred_at > now() - interval '1 hour') < 200 THEN
    INSERT INTO public.direct_mail_events (user_id, piece_id, kind, visitor_id) VALUES (p.user_id, p.id, 'scan', v_visitor);
    UPDATE public.direct_mail_pieces
    SET scan_count = scan_count + 1, first_scan_at = COALESCE(first_scan_at, now()), last_scan_at = now()
    WHERE id = p.id;
  END IF;

  RETURN jsonb_build_object('landing_slug', v_slug, 'campaign_id', c.id, 'business_name', v_business, 'code', v_code);
END;
$$;
GRANT EXECUTE ON FUNCTION public.direct_mail_resolve_scan(text, text) TO anon, authenticated;

-- =============================================================
-- REPORT (one round trip; raw counts - ratios are computed in src/lib/directMail.ts)
-- =============================================================
-- A response = a mailer with a landing-page lead/booking attributed to its code, or a logged offline response.
-- A booked job = a non-cancelled job reachable from those (directly, or through the lead's job). Counted once
-- per campaign. Cost = provider price per submitted mailer (estimate flagged when the provider sent none).
CREATE OR REPLACE FUNCTION public.direct_mail_report(p_days integer DEFAULT 365)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.direct_mail_require_manager();
  v_days integer := LEAST(GREATEST(coalesce(p_days, 365), 1), 1825);
  v_res jsonb;
BEGIN
  WITH camps AS (
    SELECT * FROM public.direct_mail_campaigns
    WHERE user_id = v_owner AND created_at > now() - make_interval(days => v_days)
  ),
  pcs AS (
    SELECT p.* FROM public.direct_mail_pieces p JOIN camps c ON c.id = p.campaign_id WHERE p.user_id = v_owner
  ),
  land AS (
    SELECT p.id AS piece_id, p.campaign_id, e.event_type, e.lead_id, e.job_id, e.visitor_id
    FROM pcs p
    JOIN public.landing_page_events e
      ON e.user_id = v_owner AND e.utm_content = lower(p.tracking_code)
     AND e.utm_source = 'direct_mail' AND e.utm_medium = 'postcard'
  ),
  resp AS (
    SELECT r.piece_id, p.campaign_id, r.lead_id, r.job_id
    FROM public.direct_mail_responses r JOIN pcs p ON p.id = r.piece_id
    WHERE r.user_id = v_owner
  ),
  lead_pairs AS (
    SELECT DISTINCT campaign_id, piece_id, lead_id FROM land WHERE lead_id IS NOT NULL
    UNION
    SELECT DISTINCT campaign_id, piece_id, lead_id FROM resp WHERE lead_id IS NOT NULL
  ),
  job_pairs AS (
    SELECT campaign_id, piece_id, job_id FROM land WHERE job_id IS NOT NULL
    UNION
    SELECT campaign_id, piece_id, job_id FROM resp WHERE job_id IS NOT NULL
    UNION
    SELECT lp.campaign_id, lp.piece_id, j.id FROM lead_pairs lp
    JOIN public.jobs j ON j.lead_id = lp.lead_id AND j.user_id = v_owner
  ),
  jobs_ok AS (
    SELECT DISTINCT ON (jp.campaign_id, j.id) jp.campaign_id, j.id AS job_id, j.job_status, j.invoice_amount
    FROM job_pairs jp JOIN public.jobs j ON j.id = jp.job_id AND j.user_id = v_owner
    WHERE j.job_status NOT IN ('cancelled', 'no_show')
    ORDER BY jp.campaign_id, j.id
  ),
  responders AS (
    SELECT campaign_id, piece_id FROM land WHERE event_type IN ('lead', 'booking')
    UNION
    SELECT campaign_id, piece_id FROM resp
  ),
  piece_agg AS (
    SELECT campaign_id,
      count(*) AS pieces_total,
      count(*) FILTER (WHERE status = 'queued') AS queued,
      count(*) FILTER (WHERE status IN ('submitting', 'submitted', 'in_transit')) AS in_mail,
      count(*) FILTER (WHERE status = 'delivered') AS delivered,
      count(*) FILTER (WHERE status = 'returned') AS returned,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE provider_id IS NOT NULL) AS mailed,
      COALESCE(sum(cost_cents) FILTER (WHERE provider_id IS NOT NULL), 0) AS cost_cents,
      count(*) FILTER (WHERE provider_id IS NOT NULL AND cost_estimated) AS cost_estimated_pieces,
      count(*) FILTER (WHERE scan_count > 0) AS scanned_pieces,
      COALESCE(sum(scan_count), 0) AS scans
    FROM pcs GROUP BY campaign_id
  ),
  land_agg AS (
    SELECT campaign_id,
      count(*) FILTER (WHERE event_type = 'view') AS landing_views,
      count(DISTINCT visitor_id) FILTER (WHERE event_type = 'view') AS landing_visitors
    FROM land GROUP BY campaign_id
  ),
  lead_agg AS (SELECT campaign_id, count(DISTINCT lead_id) AS leads FROM lead_pairs GROUP BY campaign_id),
  resp_agg AS (SELECT campaign_id, count(DISTINCT piece_id) AS responders FROM responders GROUP BY campaign_id),
  job_agg AS (
    SELECT campaign_id,
      count(*) AS booked_jobs,
      count(*) FILTER (WHERE job_status = 'completed') AS completed_jobs,
      COALESCE(sum(invoice_amount) FILTER (WHERE job_status = 'completed'), 0) AS revenue
    FROM jobs_ok GROUP BY campaign_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'campaign_id', c.id, 'name', c.name, 'status', c.status, 'size', c.size, 'created_at', c.created_at, 'sent_at', c.sent_at,
    'pieces_total', COALESCE(pa.pieces_total, 0), 'queued', COALESCE(pa.queued, 0), 'in_mail', COALESCE(pa.in_mail, 0),
    'delivered', COALESCE(pa.delivered, 0), 'returned', COALESCE(pa.returned, 0), 'failed', COALESCE(pa.failed, 0),
    'mailed', COALESCE(pa.mailed, 0), 'cost_cents', COALESCE(pa.cost_cents, 0),
    'cost_estimated_pieces', COALESCE(pa.cost_estimated_pieces, 0),
    'scanned_pieces', COALESCE(pa.scanned_pieces, 0), 'scans', COALESCE(pa.scans, 0),
    'landing_views', COALESCE(la.landing_views, 0), 'landing_visitors', COALESCE(la.landing_visitors, 0),
    'leads', COALESCE(ld.leads, 0), 'responders', COALESCE(ra.responders, 0),
    'booked_jobs', COALESCE(ja.booked_jobs, 0), 'completed_jobs', COALESCE(ja.completed_jobs, 0),
    'revenue', COALESCE(ja.revenue, 0)
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  INTO v_res
  FROM camps c
  LEFT JOIN piece_agg pa ON pa.campaign_id = c.id
  LEFT JOIN land_agg la ON la.campaign_id = c.id
  LEFT JOIN lead_agg ld ON ld.campaign_id = c.id
  LEFT JOIN resp_agg ra ON ra.campaign_id = c.id
  LEFT JOIN job_agg ja ON ja.campaign_id = c.id;

  RETURN v_res;
END;
$$;

-- =============================================================
-- SERVICE-ROLE ONLY (edge functions)
-- =============================================================
-- Atomically claims queued pieces (and pieces stuck in 'submitting' > 10 min after a crash). SKIP LOCKED keeps
-- two concurrent invocations from ever mailing the same piece twice; the print API call also carries an
-- Idempotency-Key = piece id, so a re-claimed piece cannot be printed twice either.
CREATE OR REPLACE FUNCTION public.direct_mail_claim_pieces(p_campaign_id uuid, p_limit integer)
RETURNS SETOF public.direct_mail_pieces
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.direct_mail_pieces
  SET status = 'submitting', claimed_at = now(), attempts = attempts + 1
  WHERE id IN (
    SELECT id FROM public.direct_mail_pieces
    WHERE campaign_id = p_campaign_id
      AND (status = 'queued' OR (status = 'submitting' AND claimed_at < now() - interval '10 minutes'))
    ORDER BY created_at, id
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.direct_mail_campaign_spend(p_campaign_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(cost_cents), 0)::bigint FROM public.direct_mail_pieces
  WHERE campaign_id = p_campaign_id AND provider_id IS NOT NULL;
$$;

-- Idempotent webhook application: the provider event id is unique, status only moves forward
-- (mirrors shouldAdvance() in engine.ts). Returns true when the event was new.
CREATE OR REPLACE FUNCTION public.direct_mail_apply_provider_event(
  p_user_id uuid, p_provider_id text, p_event_id text, p_event_type text, p_next_status text, p_occurred timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.direct_mail_pieces%ROWTYPE;
  v_rank_cur integer;
  v_rank_next integer;
  v_inserted integer;
BEGIN
  SELECT * INTO p FROM public.direct_mail_pieces WHERE provider_id = p_provider_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.direct_mail_events (user_id, piece_id, kind, detail, provider_event_id, occurred_at)
  VALUES (p.user_id, p.id, 'provider', left(p_event_type, 120), left(p_event_id, 120), COALESCE(p_occurred, now()))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  IF p_next_status IS NULL OR p.status = 'cancelled' THEN
    RETURN true;
  END IF;

  v_rank_cur := CASE p.status WHEN 'queued' THEN 0 WHEN 'submitting' THEN 1 WHEN 'submitted' THEN 2 WHEN 'in_transit' THEN 3
                              WHEN 'delivered' THEN 4 WHEN 'returned' THEN 5 WHEN 'failed' THEN 2 ELSE 99 END;
  v_rank_next := CASE p_next_status WHEN 'submitted' THEN 2 WHEN 'in_transit' THEN 3 WHEN 'delivered' THEN 4
                                    WHEN 'returned' THEN 5 ELSE NULL END;

  IF p_next_status IN ('failed', 'cancelled') THEN
    IF v_rank_cur < 4 AND p.status <> 'failed' THEN
      UPDATE public.direct_mail_pieces SET status = p_next_status, last_error = CASE WHEN p_next_status = 'failed' THEN 'Reported failed by the print provider.' ELSE last_error END WHERE id = p.id;
    END IF;
  ELSIF v_rank_next IS NOT NULL AND p.status <> 'failed' AND v_rank_next > v_rank_cur THEN
    UPDATE public.direct_mail_pieces
    SET status = p_next_status,
        delivered_at = CASE WHEN p_next_status = 'delivered' THEN COALESCE(p_occurred, now()) ELSE delivered_at END
    WHERE id = p.id;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.direct_mail_claim_pieces(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.direct_mail_campaign_spend(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.direct_mail_apply_provider_event(uuid, text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_claim_pieces(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.direct_mail_campaign_spend(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.direct_mail_apply_provider_event(uuid, text, text, text, text, timestamptz) TO service_role;

-- =============================================================
-- GRANTS for client RPCs
-- =============================================================
REVOKE ALL ON FUNCTION public.direct_mail_settings_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_settings_save(text, text, text, text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_campaign_save(uuid, text, uuid, text, text, text, text, text, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_campaign_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_add_pieces(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_campaign_set_status(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_suppress_piece(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_record_response(text, text, text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.direct_mail_report(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.direct_mail_settings_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_settings_save(text, text, text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_campaign_save(uuid, text, uuid, text, text, text, text, text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_campaign_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_add_pieces(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_campaign_set_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_suppress_piece(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_record_response(text, text, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.direct_mail_report(integer) TO authenticated;
