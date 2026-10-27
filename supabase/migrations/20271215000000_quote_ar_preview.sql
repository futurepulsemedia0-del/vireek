/*
  # AR Product Visualizer ("See it in your space")

  A technician attaches 3D equipment models (GLB, optional USDZ) to a quote.
  The customer opens the normal /quote/:token link, previews the equipment in
  3D and - on a supported phone - places it at TRUE SIZE in their own room with
  AR (Android Scene Viewer / WebXR, iOS Quick Look). The technician sees how
  many times each preview was viewed and launched in AR.

  Tenancy  : user_id = get_account_owner_id() (owner + team share the data).
  Access   : same rule as the quote workspace - owner, or a team member with
             can_view_billing (quote_workspace_caller_can_view()).
  Storage  : PRIVATE bucket `quote-ar-models`, path <owner_id>/<uuid>.glb|usdz.
             Customers only ever get short-lived signed URLs from the
             `quote-ar-public` edge function (service role), matched on the
             unguessable quotes.quote_token.
  Writes   : clients have NO insert/update/delete policy on any table here.
             Everything goes through SECURITY DEFINER functions, so engagement
             history cannot be forged or erased.
  Library  : models belong to the ACCOUNT (reusable across quotes); a preview
             row links one model to one quote (optionally to one tier option).
  Additive : new objects only. No existing table, function or policy changes.
*/

-- =============================================================
-- 1. PRIVATE STORAGE BUCKET
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'quote-ar-models',
  'quote-ar-models',
  false,
  41943040, -- 40 MB (also bounded by your Supabase plan's global upload limit)
  ARRAY['model/gltf-binary', 'model/vnd.usdz+zip']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

-- =============================================================
-- 2. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS quote_ar_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  created_by uuid DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  brand text CHECK (brand IS NULL OR char_length(brand) <= 80),
  model_number text CHECK (model_number IS NULL OR char_length(model_number) <= 80),
  category text NOT NULL DEFAULT 'other' CHECK (category IN (
    'furnace', 'air_conditioner', 'heat_pump', 'air_handler', 'mini_split',
    'water_heater', 'tankless_water_heater', 'boiler', 'thermostat',
    'electrical_panel', 'generator', 'ev_charger', 'other'
  )),
  placement text NOT NULL DEFAULT 'floor' CHECK (placement IN ('floor', 'wall')),
  -- Real-world size in millimetres: the single source of truth for the
  -- customer-facing dimensions AND the technician's scale check.
  width_mm integer NOT NULL CHECK (width_mm BETWEEN 10 AND 6000),
  depth_mm integer NOT NULL CHECK (depth_mm BETWEEN 10 AND 6000),
  height_mm integer NOT NULL CHECK (height_mm BETWEEN 10 AND 6000),
  -- Free space the installer needs in front for service access.
  clearance_mm integer NOT NULL DEFAULT 0 CHECK (clearance_mm BETWEEN 0 AND 3000),
  glb_path text NOT NULL UNIQUE CHECK (char_length(glb_path) <= 300),
  usdz_path text UNIQUE CHECK (usdz_path IS NULL OR char_length(usdz_path) <= 300),
  glb_size_bytes bigint NOT NULL CHECK (glb_size_bytes BETWEEN 1 AND 41943040),
  usdz_size_bytes bigint CHECK (usdz_size_bytes IS NULL OR usdz_size_bytes BETWEEN 1 AND 41943040),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_ar_models_user
  ON quote_ar_models(user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS quote_ar_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES quote_ar_models(id) ON DELETE CASCADE,
  -- NULL = shown for every option. Otherwise the id of one tier option in quotes.options.
  option_id text CHECK (option_id IS NULL OR char_length(option_id) BETWEEN 1 AND 64),
  created_by uuid DEFAULT auth.uid(),
  view_count integer NOT NULL DEFAULT 0,
  ar_launch_count integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  last_ar_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_ar_previews_unique
  ON quote_ar_previews(quote_id, model_id, (COALESCE(option_id, '')));
CREATE INDEX IF NOT EXISTS idx_quote_ar_previews_quote ON quote_ar_previews(quote_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quote_ar_previews_model ON quote_ar_previews(model_id);

CREATE TABLE IF NOT EXISTS quote_ar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL REFERENCES quote_ar_previews(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('viewed', 'ar_launched', 'ar_unsupported', 'ar_failed')),
  platform text CHECK (platform IS NULL OR platform IN ('ios', 'android', 'desktop', 'other')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_ar_events_preview ON quote_ar_events(preview_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_ar_events_user ON quote_ar_events(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_quote_ar_models_updated_at ON quote_ar_models;
CREATE TRIGGER trg_quote_ar_models_updated_at
  BEFORE UPDATE ON quote_ar_models
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_quote_ar_previews_updated_at ON quote_ar_previews;
CREATE TRIGGER trg_quote_ar_previews_updated_at
  BEFORE UPDATE ON quote_ar_previews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 3. RLS: account-scoped READ only
-- =============================================================
ALTER TABLE quote_ar_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_ar_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_ar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_quote_ar_models" ON quote_ar_models;
CREATE POLICY "select_account_quote_ar_models" ON quote_ar_models FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

DROP POLICY IF EXISTS "select_account_quote_ar_previews" ON quote_ar_previews;
CREATE POLICY "select_account_quote_ar_previews" ON quote_ar_previews FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

DROP POLICY IF EXISTS "select_account_quote_ar_events" ON quote_ar_events;
CREATE POLICY "select_account_quote_ar_events" ON quote_ar_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.quote_workspace_caller_can_view());

-- =============================================================
-- 4. STORAGE POLICIES (account folder only)
-- =============================================================
DROP POLICY IF EXISTS "quote_ar_models_insert_account" ON storage.objects;
CREATE POLICY "quote_ar_models_insert_account" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'quote-ar-models'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

DROP POLICY IF EXISTS "quote_ar_models_select_account" ON storage.objects;
CREATE POLICY "quote_ar_models_select_account" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'quote-ar-models'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
  );

-- A client may only remove a file that no ACTIVE model references: an
-- abandoned upload, or the files of a model that was just archived.
DROP POLICY IF EXISTS "quote_ar_models_delete_unreferenced" ON storage.objects;
CREATE POLICY "quote_ar_models_delete_unreferenced" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'quote-ar-models'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND NOT EXISTS (
      SELECT 1 FROM public.quote_ar_models m
      WHERE m.deleted_at IS NULL
        AND (m.glb_path = storage.objects.name OR m.usdz_path = storage.objects.name)
    )
  );

-- =============================================================
-- 5. AUTHORISATION HELPER
-- =============================================================
-- Returns the account owner id when the caller may manage AR previews,
-- otherwise NULL. Pass NULL to skip the per-quote ownership check.
CREATE OR REPLACE FUNCTION public.quote_ar_caller_owner(p_quote_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN NOT public.quote_workspace_caller_can_view() THEN NULL
    WHEN p_quote_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = p_quote_id AND q.user_id = public.get_account_owner_id()
    ) THEN NULL
    ELSE public.get_account_owner_id()
  END;
$$;

-- =============================================================
-- 6. TECHNICIAN RPCs (authenticated). Errors are stable codes.
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_quote_ar_model(
  p_name text,
  p_brand text,
  p_model_number text,
  p_category text,
  p_placement text,
  p_width_mm integer,
  p_depth_mm integer,
  p_height_mm integer,
  p_clearance_mm integer,
  p_glb_path text,
  p_usdz_path text
)
RETURNS quote_ar_models
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_owner uuid;
  v_name text;
  v_glb_size bigint;
  v_usdz_size bigint;
  v_row quote_ar_models;
BEGIN
  v_owner := public.quote_ar_caller_owner(NULL);
  IF v_owner IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  v_name := btrim(COALESCE(p_name, ''));
  IF v_name = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF char_length(v_name) > 120 THEN RAISE EXCEPTION 'NAME_TOO_LONG'; END IF;

  IF p_category IS NULL OR p_category NOT IN (
    'furnace', 'air_conditioner', 'heat_pump', 'air_handler', 'mini_split',
    'water_heater', 'tankless_water_heater', 'boiler', 'thermostat',
    'electrical_panel', 'generator', 'ev_charger', 'other'
  ) THEN RAISE EXCEPTION 'INVALID_CATEGORY'; END IF;

  IF p_placement IS NULL OR p_placement NOT IN ('floor', 'wall') THEN RAISE EXCEPTION 'INVALID_PLACEMENT'; END IF;

  IF p_width_mm IS NULL OR p_depth_mm IS NULL OR p_height_mm IS NULL
     OR p_width_mm NOT BETWEEN 10 AND 6000
     OR p_depth_mm NOT BETWEEN 10 AND 6000
     OR p_height_mm NOT BETWEEN 10 AND 6000
     OR COALESCE(p_clearance_mm, 0) NOT BETWEEN 0 AND 3000 THEN
    RAISE EXCEPTION 'INVALID_DIMENSIONS';
  END IF;

  IF (SELECT count(*) FROM quote_ar_models WHERE user_id = v_owner AND deleted_at IS NULL) >= 200 THEN
    RAISE EXCEPTION 'MODEL_LIMIT';
  END IF;

  IF p_glb_path IS NULL
     OR p_glb_path !~ ('^' || v_owner::text || '/[A-Za-z0-9._-]{1,120}[.]glb$') THEN
    RAISE EXCEPTION 'INVALID_PATH';
  END IF;
  IF p_usdz_path IS NOT NULL
     AND p_usdz_path !~ ('^' || v_owner::text || '/[A-Za-z0-9._-]{1,120}[.]usdz$') THEN
    RAISE EXCEPTION 'INVALID_PATH';
  END IF;

  SELECT COALESCE((o.metadata ->> 'size')::bigint, 0) INTO v_glb_size
  FROM storage.objects o
  WHERE o.bucket_id = 'quote-ar-models' AND o.name = p_glb_path;
  IF NOT FOUND THEN RAISE EXCEPTION 'UPLOAD_MISSING'; END IF;
  IF v_glb_size < 1 OR v_glb_size > 41943040 THEN RAISE EXCEPTION 'INVALID_SIZE'; END IF;

  IF p_usdz_path IS NOT NULL THEN
    SELECT COALESCE((o.metadata ->> 'size')::bigint, 0) INTO v_usdz_size
    FROM storage.objects o
    WHERE o.bucket_id = 'quote-ar-models' AND o.name = p_usdz_path;
    IF NOT FOUND THEN RAISE EXCEPTION 'UPLOAD_MISSING'; END IF;
    IF v_usdz_size < 1 OR v_usdz_size > 41943040 THEN RAISE EXCEPTION 'INVALID_SIZE'; END IF;
  END IF;

  INSERT INTO quote_ar_models (
    user_id, created_by, name, brand, model_number, category, placement,
    width_mm, depth_mm, height_mm, clearance_mm,
    glb_path, usdz_path, glb_size_bytes, usdz_size_bytes
  )
  VALUES (
    v_owner, auth.uid(), v_name,
    NULLIF(left(btrim(COALESCE(p_brand, '')), 80), ''),
    NULLIF(left(btrim(COALESCE(p_model_number, '')), 80), ''),
    p_category, p_placement,
    p_width_mm, p_depth_mm, p_height_mm, COALESCE(p_clearance_mm, 0),
    p_glb_path, p_usdz_path, v_glb_size, v_usdz_size
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Soft delete + detach from every quote. The caller then removes the files
-- (allowed by the storage delete policy once nothing active references them).
CREATE OR REPLACE FUNCTION public.archive_quote_ar_model(p_id uuid)
RETURNS quote_ar_models
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row quote_ar_models;
BEGIN
  SELECT * INTO v_row FROM quote_ar_models WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF public.quote_ar_caller_owner(NULL) IS DISTINCT FROM v_row.user_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  DELETE FROM quote_ar_previews WHERE model_id = p_id;
  UPDATE quote_ar_models SET deleted_at = now() WHERE id = p_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_quote_ar_model(
  p_quote_id uuid,
  p_model_id uuid,
  p_option_id text DEFAULT NULL
)
RETURNS quote_ar_previews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_quote quotes%ROWTYPE;
  v_option text;
  v_has_option boolean;
  v_row quote_ar_previews;
BEGIN
  v_owner := public.quote_ar_caller_owner(p_quote_id);
  IF v_owner IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = v_owner FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_quote.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'QUOTE_CLOSED'; END IF;

  PERFORM 1 FROM quote_ar_models WHERE id = p_model_id AND user_id = v_owner AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'MODEL_NOT_FOUND'; END IF;

  v_option := NULLIF(btrim(COALESCE(p_option_id, '')), '');
  IF v_option IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_quote.options) = 'array' THEN v_quote.options ELSE '[]'::jsonb END
      ) AS o
      WHERE o ->> 'id' = v_option
    ) INTO v_has_option;
    IF NOT v_has_option THEN RAISE EXCEPTION 'INVALID_OPTION'; END IF;
  END IF;

  -- Idempotent: attaching the same model to the same scope twice is a no-op.
  SELECT * INTO v_row FROM quote_ar_previews
  WHERE quote_id = p_quote_id AND model_id = p_model_id AND COALESCE(option_id, '') = COALESCE(v_option, '');
  IF FOUND THEN RETURN v_row; END IF;

  IF (SELECT count(*) FROM quote_ar_previews WHERE quote_id = p_quote_id) >= 6 THEN
    RAISE EXCEPTION 'PREVIEW_LIMIT';
  END IF;

  BEGIN
    INSERT INTO quote_ar_previews (user_id, quote_id, model_id, option_id, created_by)
    VALUES (v_owner, p_quote_id, p_model_id, v_option, auth.uid())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row FROM quote_ar_previews
    WHERE quote_id = p_quote_id AND model_id = p_model_id AND COALESCE(option_id, '') = COALESCE(v_option, '');
  END;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.detach_quote_ar_preview(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row quote_ar_previews;
  v_status text;
BEGIN
  SELECT * INTO v_row FROM quote_ar_previews WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF public.quote_ar_caller_owner(NULL) IS DISTINCT FROM v_row.user_id THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT status INTO v_status FROM quotes WHERE id = v_row.quote_id;
  IF v_status IS NOT NULL AND v_status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'QUOTE_CLOSED'; END IF;

  DELETE FROM quote_ar_previews WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.quote_ar_caller_owner(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_quote_ar_model(text, text, text, text, text, integer, integer, integer, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_quote_ar_model(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_quote_ar_model(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.detach_quote_ar_preview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_ar_caller_owner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_quote_ar_model(text, text, text, text, text, integer, integer, integer, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_quote_ar_model(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_quote_ar_model(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.detach_quote_ar_preview(uuid) TO authenticated;

-- =============================================================
-- 7. CUSTOMER RPCs (service_role only: called by quote-ar-public)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_quote_ar_for_token(p_token uuid)
RETURNS TABLE (
  preview_id uuid,
  option_id text,
  name text,
  brand text,
  model_number text,
  category text,
  placement text,
  width_mm integer,
  depth_mm integer,
  height_mm integer,
  clearance_mm integer,
  glb_path text,
  usdz_path text,
  quote_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.option_id, m.name, m.brand, m.model_number, m.category, m.placement,
         m.width_mm, m.depth_mm, m.height_mm, m.clearance_mm,
         m.glb_path, m.usdz_path, q.status
  FROM quotes q
  JOIN quote_ar_previews p ON p.quote_id = q.id
  JOIN quote_ar_models m ON m.id = p.model_id
  WHERE q.quote_token = p_token
    AND q.status <> 'draft'
    AND m.deleted_at IS NULL
  ORDER BY p.created_at ASC
  LIMIT 6;
$$;

CREATE OR REPLACE FUNCTION public.record_quote_ar_event(
  p_token uuid,
  p_preview_id uuid,
  p_event text,
  p_platform text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r quote_ar_previews%ROWTYPE;
  v_platform text;
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('viewed', 'ar_launched', 'ar_unsupported', 'ar_failed') THEN
    RAISE EXCEPTION 'INVALID_EVENT';
  END IF;
  v_platform := CASE WHEN p_platform IN ('ios', 'android', 'desktop', 'other') THEN p_platform ELSE NULL END;

  SELECT p.* INTO r
  FROM quote_ar_previews p
  JOIN quotes q ON q.id = p.quote_id
  JOIN quote_ar_models m ON m.id = p.model_id
  WHERE p.id = p_preview_id
    AND q.quote_token = p_token
    AND q.status <> 'draft'
    AND m.deleted_at IS NULL
  FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;

  IF p_event = 'viewed' THEN
    -- Throttle: reloads / re-opens inside a minute count once.
    IF r.last_viewed_at IS NOT NULL AND r.last_viewed_at > now() - interval '60 seconds' THEN
      RETURN jsonb_build_object('ok', true, 'throttled', true);
    END IF;
    UPDATE quote_ar_previews
    SET view_count = view_count + 1,
        last_viewed_at = now(),
        first_viewed_at = COALESCE(first_viewed_at, now())
    WHERE id = r.id;

  ELSIF p_event = 'ar_launched' THEN
    IF r.last_ar_at IS NOT NULL AND r.last_ar_at > now() - interval '5 seconds' THEN
      RETURN jsonb_build_object('ok', true, 'throttled', true);
    END IF;
    UPDATE quote_ar_previews
    SET ar_launch_count = ar_launch_count + 1,
        last_ar_at = now()
    WHERE id = r.id;

  ELSE
    -- ar_unsupported / ar_failed: diagnostic only, at most one per 10 minutes.
    IF EXISTS (
      SELECT 1 FROM quote_ar_events e
      WHERE e.preview_id = r.id AND e.event_type = p_event AND e.created_at > now() - interval '10 minutes'
    ) THEN
      RETURN jsonb_build_object('ok', true, 'throttled', true);
    END IF;
  END IF;

  INSERT INTO quote_ar_events (preview_id, quote_id, user_id, event_type, platform)
  VALUES (r.id, r.quote_id, r.user_id, p_event, v_platform);

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.get_quote_ar_for_token(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_quote_ar_event(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_quote_ar_for_token(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quote_ar_event(uuid, uuid, text, text) TO service_role;
