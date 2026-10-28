/*
  # White-label: plan entitlements, server-enforced gating, portal branding RPC

  * brand_plan_is_white_label(plan)  -> single source of truth (business, enterprise)
  * get_brand_entitlements()         -> what the signed-in account may do
  * brand_settings_plan_guard        -> non-entitled accounts can never claim a custom domain
                                        or turn Vireek branding off (server-side, not just UI)
  * get_portal_branding              -> works without a brand row, returns the EFFECTIVE
                                        "show Vireek branding" flag (downgrade-safe)
*/

ALTER TABLE public.brand_settings
  ADD COLUMN IF NOT EXISTS domain_provisioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS domain_provision_error text;

CREATE OR REPLACE FUNCTION public.brand_plan_is_white_label(p_plan text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_plan, '') IN ('business', 'enterprise');
$$;

CREATE OR REPLACE FUNCTION public.get_brand_entitlements()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_plan text;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN RETURN NULL; END IF;
  SELECT p.plan, p.company_name INTO v_plan, v_name FROM public.profiles p WHERE p.id = v_owner;
  RETURN jsonb_build_object(
    'plan', v_plan,
    'white_label', public.brand_plan_is_white_label(v_plan),
    'business_name', v_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_brand_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_brand_entitlements() TO authenticated;

-- Fires AFTER brand_settings_guard_trg (triggers run alphabetically: "guard" < "plan_guard").
CREATE OR REPLACE FUNCTION public.brand_settings_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Edge functions (service role), migrations and the SQL editor have no end-user JWT.
  v_is_user boolean := auth.uid() IS NOT NULL AND COALESCE(auth.role(), '') <> 'service_role';
  v_plan text;
  v_allowed boolean;
BEGIN
  IF NOT v_is_user THEN
    RETURN NEW;
  END IF;

  SELECT p.plan INTO v_plan FROM public.profiles p WHERE p.id = NEW.user_id;
  v_allowed := public.brand_plan_is_white_label(v_plan);

  IF NOT v_allowed THEN
    NEW.portal_show_powered_by := true;

    IF NEW.custom_domain IS NOT NULL THEN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.custom_domain IS DISTINCT FROM OLD.custom_domain THEN
          RAISE EXCEPTION 'PLAN_REQUIRED: custom domains need the Business plan or higher.' USING ERRCODE = 'P0001';
        END IF;
      ELSIF NOT EXISTS (
        -- upsert fires BEFORE INSERT even when the row exists: an unchanged, already-held domain is fine
        SELECT 1 FROM public.brand_settings b
        WHERE b.user_id = NEW.user_id AND b.custom_domain = NEW.custom_domain
      ) THEN
        RAISE EXCEPTION 'PLAN_REQUIRED: custom domains need the Business plan or higher.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- Hosting-provisioning state is server-controlled, same as verification state.
  IF TG_OP = 'INSERT' THEN
    NEW.domain_provisioned_at := NULL;
    NEW.domain_provision_error := NULL;
  ELSIF NEW.custom_domain IS DISTINCT FROM OLD.custom_domain THEN
    NEW.domain_provisioned_at := NULL;
    NEW.domain_provision_error := NULL;
  ELSE
    NEW.domain_provisioned_at := OLD.domain_provisioned_at;
    NEW.domain_provision_error := OLD.domain_provision_error;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brand_settings_plan_guard_trg ON public.brand_settings;
CREATE TRIGGER brand_settings_plan_guard_trg
  BEFORE INSERT OR UPDATE ON public.brand_settings
  FOR EACH ROW EXECUTE FUNCTION public.brand_settings_plan_guard();

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
  v_plan text;
  v_row brand_settings%ROWTYPE;
BEGIN
  SELECT c.user_id INTO v_owner FROM customers c WHERE c.portal_token = p_token;
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(bp.allow_customer_portal, false), p.company_name, p.plan
  INTO v_enabled, v_name, v_plan
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_owner;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NULL; END IF;

  SELECT * INTO v_row FROM brand_settings WHERE user_id = v_owner;

  RETURN jsonb_build_object(
    'business_name', v_name,
    'logo_path', v_row.logo_path,
    'primary_color', COALESCE(v_row.primary_color, '#2563EB'),
    'accent_color', COALESCE(v_row.accent_color, '#0EA5E9'),
    'portal_theme', COALESCE(v_row.portal_theme, 'auto'),
    'portal_welcome_title', v_row.portal_welcome_title,
    'portal_welcome_message', v_row.portal_welcome_message,
    -- EFFECTIVE flag: a downgraded account shows the badge again without any write
    'portal_show_powered_by',
      COALESCE(v_row.portal_show_powered_by, true) OR NOT public.brand_plan_is_white_label(v_plan)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_portal_branding(uuid) TO anon, authenticated;
