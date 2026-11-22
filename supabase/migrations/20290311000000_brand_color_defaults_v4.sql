-- Brand colour defaults v4 ("Signal Exact"): align the database defaults with the application defaults.
--
-- Why: these columns still defaulted to the pre-rebrand blues (#2563EB, #3448E8, #3B82F6, #0EA5E9, #0F62FE) while the application
-- (src/lib/branding.ts, chatWidget.ts, websiteWidgets.ts, landingPageUtils.ts, geofences.ts, canvassing.ts, direct-mail engine)
-- already defaults to the v4 palette. Every NEW row created through SQL, an RPC or an import therefore came out blue.
--
-- Safety:
--   * Only column DEFAULTs and three function fallbacks change. Existing rows are NOT touched (a tenant may have chosen its colour on
--     purpose). Run docs/design/DB_COLOR_DEFAULTS_BACKFILL.sql (read-only counts first) if untouched rows should follow the new brand.
--   * Idempotent (SET DEFAULT / CREATE OR REPLACE can be re-run). CREATE OR REPLACE keeps each function's owner and grants.
--   * A missing table is skipped, not an error (the loop checks to_regclass first).
--
-- Rollback: re-run the old defaults —
--   ALTER TABLE public.brand_settings ALTER COLUMN primary_color SET DEFAULT '#2563EB';
--   ALTER TABLE public.brand_settings ALTER COLUMN accent_color SET DEFAULT '#0EA5E9';
--   ALTER TABLE public.chat_widget_settings ALTER COLUMN brand_color SET DEFAULT '#3448E8';
--   ALTER TABLE public.website_widgets ALTER COLUMN brand_color SET DEFAULT '#3448E8';
--   ALTER TABLE public.landing_pages ALTER COLUMN accent_color SET DEFAULT '#2563eb';
--   ALTER TABLE public.fleet_geofences ALTER COLUMN color SET DEFAULT '#2563eb';
--   ALTER TABLE public.service_areas ALTER COLUMN color SET DEFAULT '#3b82f6';
--   ALTER TABLE public.territories ALTER COLUMN color SET DEFAULT '#3b82f6';
--   ALTER TABLE public.canvass_territories ALTER COLUMN color SET DEFAULT '#2563EB';
--   ALTER TABLE public.direct_mail_campaigns ALTER COLUMN accent_color SET DEFAULT '#0F62FE';
--   (and re-apply the previous bodies of get_portal_branding / preview_website_widget_data / canvass_territory_save from the
--   migrations named below).

DO $migration$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('brand_settings', 'primary_color', '#9F4223'),
    ('brand_settings', 'accent_color', '#0071E3'),
    ('chat_widget_settings', 'brand_color', '#934126'),
    ('website_widgets', 'brand_color', '#934126'),
    ('landing_pages', 'accent_color', '#934126'),
    ('fleet_geofences', 'color', '#934126'),
    ('service_areas', 'color', '#3d8ef6'),
    ('territories', 'color', '#3d8ef6'),
    ('canvass_territories', 'color', '#934126'),
    ('direct_mail_campaigns', 'accent_color', '#0071E3')
  ) AS v(tbl, col, dflt)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col)
    THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %L', r.tbl, r.col, r.dflt);
    END IF;
  END LOOP;
END
$migration$;

-- from 20280110000000_white_label.sql: only the colour fallback literal(s) changed
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
    'primary_color', COALESCE(v_row.primary_color, '#9F4223'),
    'accent_color', COALESCE(v_row.accent_color, '#0071E3'),
    'portal_theme', COALESCE(v_row.portal_theme, 'auto'),
    'portal_welcome_title', v_row.portal_welcome_title,
    'portal_welcome_message', v_row.portal_welcome_message,
    -- EFFECTIVE flag: a downgraded account shows the badge again without any write
    'portal_show_powered_by',
      COALESCE(v_row.portal_show_powered_by, true) OR NOT public.brand_plan_is_white_label(v_plan)
  );
END;
$$;

-- from 20271215000000_website_widget_estimator.sql: only the colour fallback literal(s) changed
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
  IF p_type IS NULL OR p_type NOT IN ('booking', 'quote', 'reviews', 'estimator') THEN RAISE EXCEPTION 'WIDGET_INVALID'; END IF;
  w.account_owner_id := v_owner;
  w.widget_type := p_type;
  w.options := CASE WHEN jsonb_typeof(p_options) = 'object' THEN p_options ELSE '{}'::jsonb END;
  w.brand_color := '#934126'; w.theme := 'auto'; w.display_mode := 'floating'; w.position := 'right'; w.radius := 14;
  w.title := ''; w.subtitle := ''; w.button_label := ''; w.success_message := '';
  RETURN public.website_widget_payload(w) -> 'data';
END;
$$;

-- from 20271231120000_door_to_door_canvassing.sql: only the colour fallback literal(s) changed
CREATE OR REPLACE FUNCTION public.canvass_territory_save(
  p_id uuid, p_name text, p_color text, p_zip_codes text[], p_assigned_user_id uuid, p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.canvass_require_manager();
  v_name text := btrim(coalesce(p_name, ''));
  v_color text := COALESCE(NULLIF(btrim(p_color), ''), '#934126');
  v_notes text := NULLIF(btrim(coalesce(p_notes, '')), '');
  v_zones text[];
  v_raw_count integer;
  old public.canvass_territories%ROWTYPE;
  t public.canvass_territories%ROWTYPE;
  v_claimed integer := 0;
BEGIN
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'name_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_color !~ '^#[0-9a-fA-F]{6}$' THEN
    RAISE EXCEPTION 'color_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'notes_too_long' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_raw_count FROM unnest(COALESCE(p_zip_codes, '{}'::text[])) z WHERE btrim(coalesce(z, '')) <> '';
  SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), '{}'::text[]) INTO v_zones
  FROM (SELECT public.canvass_zone_key(z) AS k FROM unnest(COALESCE(p_zip_codes, '{}'::text[])) z WHERE btrim(coalesce(z, '')) <> '') s
  WHERE k IS NOT NULL;
  IF v_raw_count > 0 AND (SELECT count(*) FROM (
       SELECT 1 FROM unnest(p_zip_codes) z WHERE btrim(coalesce(z, '')) <> '' AND public.canvass_zone_key(z) IS NULL) bad) > 0 THEN
    RAISE EXCEPTION 'zip_invalid' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_zones) > 200 THEN
    RAISE EXCEPTION 'too_many_zips' USING ERRCODE = '22023';
  END IF;

  IF p_assigned_user_id IS NOT NULL AND NOT public.canvass_is_account_user(v_owner, p_assigned_user_id) THEN
    RAISE EXCEPTION 'rep_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.canvass_territories (user_id, name, color, zip_codes, assigned_user_id, assigned_at, notes, created_by)
      VALUES (v_owner, v_name, v_color, v_zones, p_assigned_user_id,
              CASE WHEN p_assigned_user_id IS NULL THEN NULL ELSE now() END, v_notes, auth.uid())
      RETURNING * INTO t;
    ELSE
      SELECT * INTO old FROM public.canvass_territories WHERE id = p_id AND user_id = v_owner FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'territory_not_found' USING ERRCODE = 'P0002';
      END IF;
      IF old.status <> 'active' THEN
        RAISE EXCEPTION 'territory_archived' USING ERRCODE = '22023';
      END IF;
      UPDATE public.canvass_territories SET
        name = v_name, color = v_color, zip_codes = v_zones, notes = v_notes,
        assigned_user_id = p_assigned_user_id,
        assigned_at = CASE
          WHEN p_assigned_user_id IS NULL THEN NULL
          WHEN p_assigned_user_id IS DISTINCT FROM old.assigned_user_id THEN now()
          ELSE old.assigned_at END
      WHERE id = p_id
      RETURNING * INTO t;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'territory_name_taken' USING ERRCODE = '23505';
  END;

  -- Unassigned doors inside the territory's zones join it automatically.
  IF cardinality(t.zip_codes) > 0 THEN
    UPDATE public.canvass_doors d SET territory_id = t.id
    WHERE d.user_id = v_owner AND d.territory_id IS NULL AND d.zone = ANY (t.zip_codes);
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('territory', to_jsonb(t), 'claimed', v_claimed);
END;
$$;
