/*
  # Branding & white-label settings

  One row per ACCOUNT (keyed by the account owner's profile id) holding:
    - logo + brand colors
    - email / SMS sender identity
    - customer-portal theme
    - custom-domain claim + DNS verification state

  Security model
    * Every member of the account can READ the row (get_account_owner_id()).
    * Only the owner, or a member holding `can_edit_business_profile`
      (base permission or custom-role override — same precedence the client
      uses in AuthContext), can WRITE it (can_manage_branding()).
    * Domain verification fields are server-controlled: a BEFORE trigger
      discards any client attempt to set status / token / verified_at and
      resets them whenever the domain itself changes. Only the
      `verify-custom-domain` edge function (service role) can mark verified.
    * Anonymous customers get a narrow, read-only RPC (get_portal_branding)
      that validates the portal token and exposes public-safe fields only.
*/

-- =============================================================
-- PERMISSION HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_branding()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR COALESCE((
      SELECT COALESCE(
               (cr.permissions ->> 'can_edit_business_profile')::boolean,
               (tm.permissions ->> 'can_edit_business_profile')::boolean,
               false
             )
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ), false);
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_branding() TO authenticated;

-- =============================================================
-- TABLE
-- =============================================================
CREATE TABLE IF NOT EXISTS public.brand_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Visual identity
  logo_path text,
  primary_color text NOT NULL DEFAULT '#2563EB',
  accent_color text NOT NULL DEFAULT '#0EA5E9',

  -- Email / SMS sender identity
  email_sender_name text,
  email_reply_to text,
  email_footer text,
  sms_sender_label text,

  -- Customer portal
  portal_theme text NOT NULL DEFAULT 'auto',
  portal_welcome_title text,
  portal_welcome_message text,
  portal_show_powered_by boolean NOT NULL DEFAULT true,

  -- Custom domain (server-controlled verification state)
  custom_domain text,
  domain_status text NOT NULL DEFAULT 'unconfigured',
  domain_verification_token text,
  domain_verified_at timestamptz,
  domain_last_checked_at timestamptz,
  domain_error text,

  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brand_primary_hex CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT brand_accent_hex CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT brand_theme_valid CHECK (portal_theme IN ('light', 'dark', 'auto')),
  CONSTRAINT brand_domain_status_valid CHECK (domain_status IN ('unconfigured', 'pending', 'verified', 'failed')),
  CONSTRAINT brand_sender_name_len CHECK (email_sender_name IS NULL OR char_length(email_sender_name) BETWEEN 1 AND 80),
  CONSTRAINT brand_sender_name_clean CHECK (email_sender_name IS NULL OR email_sender_name !~ '[<>"\r\n]'),
  CONSTRAINT brand_reply_to_format CHECK (
    email_reply_to IS NULL
    OR (char_length(email_reply_to) <= 254 AND email_reply_to ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')
  ),
  CONSTRAINT brand_footer_len CHECK (email_footer IS NULL OR char_length(email_footer) <= 500),
  CONSTRAINT brand_sms_label_len CHECK (sms_sender_label IS NULL OR char_length(sms_sender_label) BETWEEN 1 AND 30),
  CONSTRAINT brand_sms_label_clean CHECK (sms_sender_label IS NULL OR sms_sender_label !~ '[\r\n]'),
  CONSTRAINT brand_welcome_title_len CHECK (portal_welcome_title IS NULL OR char_length(portal_welcome_title) <= 80),
  CONSTRAINT brand_welcome_msg_len CHECK (portal_welcome_message IS NULL OR char_length(portal_welcome_message) <= 400),
  CONSTRAINT brand_domain_format CHECK (
    custom_domain IS NULL
    OR (
      char_length(custom_domain) <= 253
      AND custom_domain = lower(custom_domain)
      AND custom_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    )
  )
);

-- A domain can only be VERIFIED by one account. Unverified claims may overlap
-- (the DNS TXT token is what proves control), so squatting a name you don't own
-- never blocks the real owner from verifying it.
CREATE UNIQUE INDEX IF NOT EXISTS brand_settings_verified_domain_uidx
  ON public.brand_settings (custom_domain)
  WHERE domain_status = 'verified';

ALTER TABLE public.brand_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brand_settings_select_account" ON public.brand_settings;
CREATE POLICY "brand_settings_select_account"
  ON public.brand_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "brand_settings_insert_manager" ON public.brand_settings;
CREATE POLICY "brand_settings_insert_manager"
  ON public.brand_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_branding());

DROP POLICY IF EXISTS "brand_settings_update_manager" ON public.brand_settings;
CREATE POLICY "brand_settings_update_manager"
  ON public.brand_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_branding())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_branding());

-- =============================================================
-- GUARD TRIGGER — verification state is server-controlled
-- =============================================================
CREATE OR REPLACE FUNCTION public.brand_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := COALESCE(auth.role(), '') = 'service_role' OR current_user IN ('postgres', 'supabase_admin');
BEGIN
  NEW.updated_at := now();
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;

  IF NEW.custom_domain IS NOT NULL THEN
    NEW.custom_domain := lower(btrim(NEW.custom_domain));
    IF NEW.custom_domain = '' THEN NEW.custom_domain := NULL; END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_is_service THEN
      NEW.domain_verified_at := NULL;
      NEW.domain_last_checked_at := NULL;
      NEW.domain_error := NULL;
      NEW.domain_status := CASE WHEN NEW.custom_domain IS NULL THEN 'unconfigured' ELSE 'pending' END;
      NEW.domain_verification_token :=
        CASE WHEN NEW.custom_domain IS NULL THEN NULL ELSE replace(gen_random_uuid()::text, '-', '') END;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.custom_domain IS DISTINCT FROM OLD.custom_domain THEN
    -- Domain changed (or cleared): verification starts over, always.
    NEW.domain_verified_at := NULL;
    NEW.domain_last_checked_at := NULL;
    NEW.domain_error := NULL;
    NEW.domain_status := CASE WHEN NEW.custom_domain IS NULL THEN 'unconfigured' ELSE 'pending' END;
    NEW.domain_verification_token :=
      CASE WHEN NEW.custom_domain IS NULL THEN NULL ELSE replace(gen_random_uuid()::text, '-', '') END;
  ELSIF NOT v_is_service THEN
    -- Same domain: clients may not touch verification state.
    NEW.domain_status := OLD.domain_status;
    NEW.domain_verification_token := OLD.domain_verification_token;
    NEW.domain_verified_at := OLD.domain_verified_at;
    NEW.domain_last_checked_at := OLD.domain_last_checked_at;
    NEW.domain_error := OLD.domain_error;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brand_settings_guard_trg ON public.brand_settings;
CREATE TRIGGER brand_settings_guard_trg
  BEFORE INSERT OR UPDATE ON public.brand_settings
  FOR EACH ROW EXECUTE FUNCTION public.brand_settings_guard();

-- =============================================================
-- LOGO STORAGE — public read (customers see it), manager-only write,
-- locked to the ACCOUNT OWNER's folder so team members write to the
-- same place the owner does.
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brand-assets',
  'brand-assets',
  true,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp'] -- no SVG: scriptable when opened directly
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "brand_assets_manager_write" ON storage.objects;
CREATE POLICY "brand_assets_manager_write"
  ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'brand-assets'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_branding()
  )
  WITH CHECK (
    bucket_id = 'brand-assets'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.can_manage_branding()
  );

DROP POLICY IF EXISTS "brand_assets_public_read" ON storage.objects;
CREATE POLICY "brand_assets_public_read"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'brand-assets');

-- =============================================================
-- PUBLIC RPC — branding for the customer portal (anon, token-validated)
-- Separate from get_customer_portal_bundle on purpose: that function has
-- been redefined by several migrations, and branding must not depend on
-- (or fork) it. Returns NULL for unknown tokens or disabled portals.
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_portal_branding(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_enabled boolean;
  v_name text;
  v_row brand_settings%ROWTYPE;
BEGIN
  SELECT c.user_id INTO v_owner FROM customers c WHERE c.portal_token = p_token;
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(bp.allow_customer_portal, false), p.company_name
  INTO v_enabled, v_name
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_owner;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NULL; END IF;

  SELECT * INTO v_row FROM brand_settings WHERE user_id = v_owner;
  IF v_row.user_id IS NULL THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'business_name', v_name,
    'logo_path', v_row.logo_path,
    'primary_color', v_row.primary_color,
    'accent_color', v_row.accent_color,
    'portal_theme', v_row.portal_theme,
    'portal_welcome_title', v_row.portal_welcome_title,
    'portal_welcome_message', v_row.portal_welcome_message,
    'portal_show_powered_by', v_row.portal_show_powered_by
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_portal_branding(uuid) TO anon, authenticated;
