/*
  # Customer Home Inventory (customer portal: /portal/:token/inventory)

  ## What this adds
  Customers keep a private inventory of what is in their home: appliances and equipment, with photos,
  receipts, manuals and warranty cards. Labels / receipts are read with OCR (edge function
  `portal-home-inventory`), items link to the business's equipment records (and therefore to the
  equipment passport) and carry warranty + maintenance reminders.

  ## Security model (same as the rest of the portal)
  - The durable `customers.portal_token` is the credential and `business_profile.allow_customer_portal` is the
    per-business opt-in. Every token-facing function returns NULL for BOTH "bad token" and "portal disabled".
  - RLS is NEVER opened to anon. All tables: RLS on, anon has nothing, authenticated may only SELECT their own
    account's rows (so staff can see what a customer shared), nobody can write directly.
  - Writes happen only through SECURITY DEFINER functions that re-validate the token and the ownership of every
    id they touch (equipment, files, reminders) against the SAME customer.
  - Files live in a PRIVATE bucket (`home-inventory`), path = <business owner id>/<customer id>/<uuid>.<ext>.
    Customers upload through short-lived signed upload URLs issued by the edge function after token validation;
    they can only read files through short-lived signed URLs from the same function.
  - Storage paths are never returned to the browser.

  ## Idempotent / re-runnable
  Everything uses IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.

  NOTE: keep this file's timestamp AFTER your newest migration (rename it if needed).
*/

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public.home_inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                        -- business owner (tenant)
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'other' CHECK (category IN (
    'hvac', 'water_heating', 'plumbing', 'electrical', 'kitchen', 'laundry', 'smart_home', 'outdoor', 'other'
  )),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  brand text CHECK (brand IS NULL OR char_length(brand) <= 80),
  model text CHECK (model IS NULL OR char_length(model) <= 80),
  serial_number text CHECK (serial_number IS NULL OR char_length(serial_number) <= 60),
  location text CHECK (location IS NULL OR char_length(location) <= 80),
  retailer text CHECK (retailer IS NULL OR char_length(retailer) <= 120),
  purchase_date date,
  purchase_price_cents bigint CHECK (purchase_price_cents IS NULL OR purchase_price_cents BETWEEN 0 AND 100000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  warranty_months integer CHECK (warranty_months IS NULL OR warranty_months BETWEEN 1 AND 600),
  warranty_expires_at date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  source text NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'ocr')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hi_items_customer ON public.home_inventory_items (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hi_items_user ON public.home_inventory_items (user_id);
CREATE INDEX IF NOT EXISTS idx_hi_items_equipment ON public.home_inventory_items (equipment_id) WHERE equipment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.home_inventory_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  item_id uuid REFERENCES public.home_inventory_items(id) ON DELETE CASCADE,   -- NULL = uploaded, not attached yet
  kind text NOT NULL CHECK (kind IN ('appliance_photo', 'receipt', 'manual', 'warranty_card', 'label', 'other')),
  storage_path text NOT NULL CHECK (char_length(storage_path) <= 300),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  original_name text CHECK (original_name IS NULL OR char_length(original_name) <= 160),
  ocr_status text NOT NULL DEFAULT 'skipped' CHECK (ocr_status IN ('done', 'skipped', 'failed')),
  ocr jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ocr) = 'object'),
  model_name text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, sha256),            -- the same photo is stored (and OCR-billed) once per customer
  UNIQUE (storage_path)
);

CREATE INDEX IF NOT EXISTS idx_hi_files_item ON public.home_inventory_files (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hi_files_customer ON public.home_inventory_files (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.home_inventory_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.home_inventory_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('maintenance', 'warranty_expiry', 'custom')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  due_date date NOT NULL,
  interval_months integer CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dismissed')),
  last_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One system reminder per item and kind (custom reminders can be many).
CREATE UNIQUE INDEX IF NOT EXISTS uq_hi_reminders_system
  ON public.home_inventory_reminders (item_id, kind) WHERE kind IN ('maintenance', 'warranty_expiry');
CREATE INDEX IF NOT EXISTS idx_hi_reminders_customer ON public.home_inventory_reminders (customer_id, due_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_hi_reminders_due ON public.home_inventory_reminders (user_id, due_date) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.home_inventory_rate_limit (
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, bucket)
);

-- =============================================================
-- 2. RLS: staff may read their own account's rows; nobody writes directly
-- =============================================================

ALTER TABLE public.home_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_inventory_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_inventory_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_inventory_rate_limit ENABLE ROW LEVEL SECURITY;
-- home_inventory_rate_limit: intentionally no policies (service role / definer functions only).

DROP POLICY IF EXISTS "hi_items_select" ON public.home_inventory_items;
CREATE POLICY "hi_items_select" ON public.home_inventory_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "hi_files_select" ON public.home_inventory_files;
CREATE POLICY "hi_files_select" ON public.home_inventory_files FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "hi_reminders_select" ON public.home_inventory_reminders;
CREATE POLICY "hi_reminders_select" ON public.home_inventory_reminders FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE ALL ON public.home_inventory_items FROM anon;
REVOKE ALL ON public.home_inventory_files FROM anon;
REVOKE ALL ON public.home_inventory_reminders FROM anon;
REVOKE ALL ON public.home_inventory_rate_limit FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.home_inventory_items FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.home_inventory_files FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.home_inventory_reminders FROM authenticated;

-- =============================================================
-- 3. Private storage bucket (signed URLs only; staff may read their tenant folder)
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('home-inventory', 'home-inventory', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "hi_media_staff_select" ON storage.objects;
CREATE POLICY "hi_media_staff_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'home-inventory' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
-- No INSERT / UPDATE / DELETE policy on purpose: customers write through signed upload URLs issued by the
-- edge function, and deletes are performed by the edge function with the service role.

-- =============================================================
-- 4. Internal helpers
-- =============================================================

-- Text sanitiser: strips control chars and angle brackets, collapses whitespace, bounds length. NULL when empty.
CREATE OR REPLACE FUNCTION public.hi_clean(p_text text, p_max integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    left(btrim(regexp_replace(regexp_replace(COALESCE(p_text, ''), '[[:cntrl:]<>]', ' ', 'g'), '\s+', ' ', 'g')), p_max),
    ''
  );
$$;

-- Token -> customer. Zero rows for BOTH "bad token" and "portal disabled".
CREATE OR REPLACE FUNCTION public.hi_resolve_customer(p_token uuid)
RETURNS TABLE (customer_id uuid, owner_id uuid, customer_name text, business_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.user_id, c.name, p.company_name
  FROM customers c
  JOIN business_profile bp ON bp.user_id = c.user_id
  LEFT JOIN profiles p ON p.id = c.user_id
  WHERE p_token IS NOT NULL
    AND c.portal_token = p_token
    AND COALESCE(bp.allow_customer_portal, false) = true
  LIMIT 1;
$$;

-- Atomic fixed-window limiter. Returns TRUE while the caller is still within p_max requests per window.
CREATE OR REPLACE FUNCTION public.hi_rate_limit_hit(p_customer uuid, p_bucket text, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.home_inventory_rate_limit AS r (customer_id, bucket, window_start, request_count)
  VALUES (p_customer, p_bucket, now(), 1)
  ON CONFLICT (customer_id, bucket) DO UPDATE
    SET window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END,
        request_count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.request_count + 1 END
  RETURNING r.request_count INTO v_count;
  RETURN v_count <= p_max;
END;
$$;

-- Keeps the system reminders (warranty ending, recurring maintenance) of one item in step with the item.
CREATE OR REPLACE FUNCTION public.hi_sync_item_reminders(p_item_id uuid, p_sync_maintenance boolean, p_maint_interval integer, p_maint_due date)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  i public.home_inventory_items%ROWTYPE;
  v_due date;
BEGIN
  SELECT * INTO i FROM public.home_inventory_items WHERE id = p_item_id;
  IF i.id IS NULL THEN
    RETURN;
  END IF;

  -- Warranty: a heads-up 30 days before it ends. Nothing for an unknown or already-ended warranty.
  IF i.warranty_expires_at IS NOT NULL AND i.warranty_expires_at >= current_date THEN
    v_due := GREATEST(i.warranty_expires_at - 30, current_date);
    UPDATE public.home_inventory_reminders
       SET title = left('Warranty ends: ' || i.name, 120),
           status = CASE WHEN due_date IS DISTINCT FROM v_due THEN 'active' ELSE status END,
           due_date = v_due
     WHERE item_id = i.id AND kind = 'warranty_expiry';
    IF NOT FOUND THEN
      INSERT INTO public.home_inventory_reminders (user_id, customer_id, item_id, kind, title, due_date)
      VALUES (i.user_id, i.customer_id, i.id, 'warranty_expiry', left('Warranty ends: ' || i.name, 120), v_due);
    END IF;
  ELSE
    DELETE FROM public.home_inventory_reminders WHERE item_id = i.id AND kind = 'warranty_expiry';
  END IF;

  -- Maintenance: only touched when the caller sent the maintenance fields.
  IF p_sync_maintenance THEN
    IF p_maint_interval IS NULL THEN
      DELETE FROM public.home_inventory_reminders WHERE item_id = i.id AND kind = 'maintenance';
    ELSE
      v_due := p_maint_due;
      IF v_due IS NULL AND i.equipment_id IS NOT NULL THEN
        -- Linked to the business's equipment record: follow ITS service history.
        SELECT (COALESCE(e.last_service_date, e.install_date) + make_interval(months => e.service_interval_months))::date
          INTO v_due
          FROM public.equipment e
         WHERE e.id = i.equipment_id;
      END IF;
      IF v_due IS NULL THEN
        v_due := (current_date + make_interval(months => p_maint_interval))::date;
      END IF;
      UPDATE public.home_inventory_reminders
         SET title = left('Maintenance: ' || i.name, 120),
             interval_months = p_maint_interval,
             due_date = v_due,
             status = 'active'
       WHERE item_id = i.id AND kind = 'maintenance';
      IF NOT FOUND THEN
        INSERT INTO public.home_inventory_reminders (user_id, customer_id, item_id, kind, title, due_date, interval_months)
        VALUES (i.user_id, i.customer_id, i.id, 'maintenance', left('Maintenance: ' || i.name, 120), v_due, p_maint_interval);
      END IF;
    END IF;
  END IF;
END;
$$;

-- =============================================================
-- 5. Read: the whole inventory for one customer
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_portal_home_inventory(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_ctx FROM public.hi_resolve_customer(p_token);
  IF v_ctx.customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_result := jsonb_build_object(
    'customer', jsonb_build_object('name', v_ctx.customer_name),
    'business_name', v_ctx.business_name,

    'summary', jsonb_build_object(
      'item_count', (SELECT count(*) FROM public.home_inventory_items WHERE customer_id = v_ctx.customer_id),
      'file_count', (SELECT count(*) FROM public.home_inventory_files WHERE customer_id = v_ctx.customer_id),
      'active_warranties', (SELECT count(*) FROM public.home_inventory_items
                             WHERE customer_id = v_ctx.customer_id AND warranty_expires_at >= current_date),
      'expiring_warranties', (SELECT count(*) FROM public.home_inventory_items
                               WHERE customer_id = v_ctx.customer_id
                                 AND warranty_expires_at BETWEEN current_date AND current_date + 60),
      'reminders_due', (SELECT count(*) FROM public.home_inventory_reminders
                         WHERE customer_id = v_ctx.customer_id AND status = 'active' AND due_date <= current_date + 30)
    ),

    'items', COALESCE((
      SELECT jsonb_agg(x.obj ORDER BY x.sort_name)
      FROM (
        SELECT
          lower(i.name) AS sort_name,
          jsonb_build_object(
            'id', i.id,
            'category', i.category,
            'name', i.name,
            'brand', i.brand,
            'model', i.model,
            'serial_number', i.serial_number,
            'location', i.location,
            'retailer', i.retailer,
            'purchase_date', i.purchase_date,
            'purchase_price_cents', i.purchase_price_cents,
            'currency', i.currency,
            'warranty_months', i.warranty_months,
            'warranty_expires_at', i.warranty_expires_at,
            'notes', i.notes,
            'equipment_id', i.equipment_id,
            'source', i.source,
            'created_at', i.created_at,
            'equipment', (
              SELECT jsonb_build_object(
                'id', e.id,
                'equipment_type', e.equipment_type,
                'make', e.make,
                'model', e.model,
                'install_date', e.install_date,
                'last_service_date', e.last_service_date,
                'service_interval_months', e.service_interval_months,
                'next_service_due', (COALESCE(e.last_service_date, e.install_date) + make_interval(months => e.service_interval_months))::date,
                -- The public code is only shown for a VERIFIED passport link (same rule as everywhere else).
                'passport_code', (
                  SELECT pp.public_code
                  FROM equipment_passport_links l
                  JOIN equipment_passports pp ON pp.id = l.passport_id
                  WHERE l.equipment_id = e.id AND l.status = 'active' AND l.verified = true AND pp.status = 'active'
                  LIMIT 1
                )
              )
              FROM equipment e
              WHERE e.id = i.equipment_id AND e.customer_id = i.customer_id
            ),
            'files', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', f.id,
                'kind', f.kind,
                'mime_type', f.mime_type,
                'byte_size', f.byte_size,
                'original_name', f.original_name,
                'ocr_status', f.ocr_status,
                'created_at', f.created_at
              ) ORDER BY f.created_at)
              FROM public.home_inventory_files f
              WHERE f.item_id = i.id
            ), '[]'::jsonb)
          ) AS obj
        FROM public.home_inventory_items i
        WHERE i.customer_id = v_ctx.customer_id
      ) x
    ), '[]'::jsonb),

    -- Uploaded but not attached to an item yet (e.g. the customer left the form).
    'unattached_files', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id,
        'kind', f.kind,
        'mime_type', f.mime_type,
        'byte_size', f.byte_size,
        'original_name', f.original_name,
        'ocr_status', f.ocr_status,
        'created_at', f.created_at
      ) ORDER BY f.created_at DESC)
      FROM public.home_inventory_files f
      WHERE f.customer_id = v_ctx.customer_id AND f.item_id IS NULL
    ), '[]'::jsonb),

    'reminders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id,
        'item_id', r.item_id,
        'item_name', i.name,
        'kind', r.kind,
        'title', r.title,
        'due_date', r.due_date,
        'interval_months', r.interval_months,
        'status', r.status,
        'last_completed_at', r.last_completed_at
      ) ORDER BY r.due_date, r.created_at)
      FROM public.home_inventory_reminders r
      JOIN public.home_inventory_items i ON i.id = r.item_id
      WHERE r.customer_id = v_ctx.customer_id AND r.status = 'active'
    ), '[]'::jsonb),

    -- Equipment the business has on file for this customer: the link picker in the item form.
    'equipment_options', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id,
        'equipment_type', e.equipment_type,
        'make', e.make,
        'model', e.model
      ) ORDER BY e.created_at)
      FROM equipment e
      WHERE e.customer_id = v_ctx.customer_id AND e.user_id = v_ctx.owner_id AND e.status <> 'removed'
    ), '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;

-- =============================================================
-- 6. Write: create / update one item (+ attach files, sync reminders) in ONE transaction
-- =============================================================

CREATE OR REPLACE FUNCTION public.portal_inventory_save_item(
  p_token uuid,
  p_item_id uuid DEFAULT NULL,
  p_fields jsonb DEFAULT '{}'::jsonb,
  p_file_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_id uuid;
  v_name text;
  v_category text;
  v_brand text;
  v_model text;
  v_serial text;
  v_location text;
  v_retailer text;
  v_notes text;
  v_currency text;
  v_source text;
  v_purchase date;
  v_price bigint;
  v_months integer;
  v_expires date;
  v_equipment uuid;
  v_serial_key text;
  v_auto boolean := false;
  v_sync_maint boolean := false;
  v_maint_interval integer;
  v_maint_due date;
BEGIN
  SELECT * INTO v_ctx FROM public.hi_resolve_customer(p_token);
  IF v_ctx.customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;

  BEGIN
    v_name := public.hi_clean(p_fields->>'name', 120);
    v_category := lower(COALESCE(NULLIF(btrim(p_fields->>'category'), ''), 'other'));
    v_brand := public.hi_clean(p_fields->>'brand', 80);
    v_model := public.hi_clean(p_fields->>'model', 80);
    v_serial := public.hi_clean(p_fields->>'serial_number', 60);
    v_location := public.hi_clean(p_fields->>'location', 80);
    v_retailer := public.hi_clean(p_fields->>'retailer', 120);
    v_notes := public.hi_clean(p_fields->>'notes', 1000);
    v_currency := upper(COALESCE(NULLIF(btrim(p_fields->>'currency'), ''), 'USD'));
    v_source := lower(COALESCE(NULLIF(btrim(p_fields->>'source'), ''), 'customer'));
    v_purchase := NULLIF(btrim(COALESCE(p_fields->>'purchase_date', '')), '')::date;
    v_price := NULLIF(btrim(COALESCE(p_fields->>'purchase_price_cents', '')), '')::bigint;
    v_months := NULLIF(btrim(COALESCE(p_fields->>'warranty_months', '')), '')::integer;
    v_expires := NULLIF(btrim(COALESCE(p_fields->>'warranty_expires_at', '')), '')::date;
    v_equipment := NULLIF(btrim(COALESCE(p_fields->>'equipment_id', '')), '')::uuid;

    IF p_fields ? 'maintenance_interval_months' THEN
      v_sync_maint := true;
      v_maint_interval := NULLIF(btrim(COALESCE(p_fields->>'maintenance_interval_months', '')), '')::integer;
      v_maint_due := NULLIF(btrim(COALESCE(p_fields->>'next_maintenance_due', '')), '')::date;
    END IF;

    IF v_expires IS NULL AND v_purchase IS NOT NULL AND v_months IS NOT NULL THEN
      v_expires := (v_purchase + make_interval(months => v_months))::date;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
                 OR numeric_value_out_of_range OR invalid_parameter_value THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'HI_INVALID_NAME';
  END IF;
  IF v_category NOT IN ('hvac', 'water_heating', 'plumbing', 'electrical', 'kitchen', 'laundry', 'smart_home', 'outdoor', 'other') THEN
    v_category := 'other';
  END IF;
  IF v_source NOT IN ('customer', 'ocr') THEN
    v_source := 'customer';
  END IF;
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;
  IF v_purchase IS NOT NULL AND (v_purchase < date '1970-01-01' OR v_purchase > current_date + 1) THEN
    RAISE EXCEPTION 'HI_INVALID_DATE';
  END IF;
  IF v_expires IS NOT NULL AND (v_expires < date '1970-01-01' OR v_expires > date '2100-12-31') THEN
    RAISE EXCEPTION 'HI_INVALID_DATE';
  END IF;
  IF v_maint_due IS NOT NULL AND (v_maint_due < date '2000-01-01' OR v_maint_due > date '2100-12-31') THEN
    RAISE EXCEPTION 'HI_INVALID_DATE';
  END IF;
  IF v_price IS NOT NULL AND (v_price < 0 OR v_price > 100000000000) THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;
  IF v_months IS NOT NULL AND (v_months < 1 OR v_months > 600) THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;
  IF v_maint_interval IS NOT NULL AND (v_maint_interval < 1 OR v_maint_interval > 120) THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;

  -- The equipment record must belong to THIS customer of THIS business.
  IF v_equipment IS NOT NULL THEN
    PERFORM 1 FROM public.equipment e
     WHERE e.id = v_equipment AND e.customer_id = v_ctx.customer_id AND e.user_id = v_ctx.owner_id AND e.status <> 'removed';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HI_EQUIPMENT_NOT_FOUND';
    END IF;
  END IF;

  IF p_item_id IS NULL THEN
    IF (SELECT count(*) FROM public.home_inventory_items WHERE customer_id = v_ctx.customer_id) >= 200 THEN
      RAISE EXCEPTION 'HI_LIMIT';
    END IF;

    -- New item with a readable serial that matches the business's equipment record: link it automatically.
    v_serial_key := regexp_replace(upper(COALESCE(v_serial, '')), '[^A-Z0-9]', '', 'g');
    IF v_equipment IS NULL AND char_length(v_serial_key) >= 5 THEN
      SELECT e.id INTO v_equipment
        FROM public.equipment e
       WHERE e.customer_id = v_ctx.customer_id AND e.user_id = v_ctx.owner_id AND e.status <> 'removed'
         AND regexp_replace(upper(COALESCE(e.serial_number, '')), '[^A-Z0-9]', '', 'g') = v_serial_key
       ORDER BY e.created_at
       LIMIT 1;
      v_auto := v_equipment IS NOT NULL;
    END IF;

    INSERT INTO public.home_inventory_items (
      user_id, customer_id, equipment_id, category, name, brand, model, serial_number, location, retailer,
      purchase_date, purchase_price_cents, currency, warranty_months, warranty_expires_at, notes, source
    ) VALUES (
      v_ctx.owner_id, v_ctx.customer_id, v_equipment, v_category, v_name, v_brand, v_model, v_serial, v_location, v_retailer,
      v_purchase, v_price, v_currency, v_months, v_expires, v_notes, v_source
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.home_inventory_items
       SET equipment_id = v_equipment, category = v_category, name = v_name, brand = v_brand, model = v_model,
           serial_number = v_serial, location = v_location, retailer = v_retailer, purchase_date = v_purchase,
           purchase_price_cents = v_price, currency = v_currency, warranty_months = v_months,
           warranty_expires_at = v_expires, notes = v_notes, updated_at = now()
     WHERE id = p_item_id AND customer_id = v_ctx.customer_id
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'HI_NOT_FOUND';
    END IF;
  END IF;

  -- Attach previously uploaded files (only this customer's own).
  IF p_file_ids IS NOT NULL AND array_length(p_file_ids, 1) IS NOT NULL THEN
    UPDATE public.home_inventory_files
       SET item_id = v_id
     WHERE customer_id = v_ctx.customer_id AND id = ANY(p_file_ids);
  END IF;

  PERFORM public.hi_sync_item_reminders(v_id, v_sync_maint, v_maint_interval, v_maint_due);

  RETURN jsonb_build_object('id', v_id, 'equipment_id', v_equipment, 'linked_by_serial', v_auto);
END;
$$;

-- =============================================================
-- 7. Write: custom reminder + reminder actions
-- =============================================================

CREATE OR REPLACE FUNCTION public.portal_inventory_add_reminder(
  p_token uuid,
  p_item_id uuid,
  p_title text,
  p_due_date date,
  p_interval_months integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  v_title text;
  v_id uuid;
BEGIN
  SELECT * INTO v_ctx FROM public.hi_resolve_customer(p_token);
  IF v_ctx.customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_title := public.hi_clean(p_title, 120);
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'HI_INVALID_NAME';
  END IF;
  IF p_due_date IS NULL OR p_due_date < date '2000-01-01' OR p_due_date > date '2100-12-31' THEN
    RAISE EXCEPTION 'HI_INVALID_DATE';
  END IF;
  IF p_interval_months IS NOT NULL AND (p_interval_months < 1 OR p_interval_months > 120) THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;

  PERFORM 1 FROM public.home_inventory_items WHERE id = p_item_id AND customer_id = v_ctx.customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HI_NOT_FOUND';
  END IF;
  IF (SELECT count(*) FROM public.home_inventory_reminders WHERE customer_id = v_ctx.customer_id AND status = 'active') >= 300 THEN
    RAISE EXCEPTION 'HI_LIMIT';
  END IF;

  INSERT INTO public.home_inventory_reminders (user_id, customer_id, item_id, kind, title, due_date, interval_months)
  VALUES (v_ctx.owner_id, v_ctx.customer_id, p_item_id, 'custom', v_title, p_due_date, p_interval_months)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_inventory_reminder_action(
  p_token uuid,
  p_reminder_id uuid,
  p_action text,
  p_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx record;
  r public.home_inventory_reminders%ROWTYPE;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
BEGIN
  SELECT * INTO v_ctx FROM public.hi_resolve_customer(p_token);
  IF v_ctx.customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('done', 'snooze', 'dismiss', 'reopen') THEN
    RAISE EXCEPTION 'HI_INVALID_FIELD';
  END IF;

  SELECT * INTO r FROM public.home_inventory_reminders
   WHERE id = p_reminder_id AND customer_id = v_ctx.customer_id
   FOR UPDATE;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'HI_NOT_FOUND';
  END IF;

  IF p_action = 'done' THEN
    IF r.interval_months IS NOT NULL THEN
      -- Recurring: roll the due date forward from today and keep the reminder active.
      UPDATE public.home_inventory_reminders
         SET due_date = (current_date + make_interval(months => r.interval_months))::date,
             last_completed_at = now(), status = 'active'
       WHERE id = r.id;
    ELSE
      UPDATE public.home_inventory_reminders SET status = 'done', last_completed_at = now() WHERE id = r.id;
    END IF;
  ELSIF p_action = 'snooze' THEN
    UPDATE public.home_inventory_reminders
       SET due_date = GREATEST(due_date, current_date) + v_days, status = 'active'
     WHERE id = r.id;
  ELSIF p_action = 'dismiss' THEN
    UPDATE public.home_inventory_reminders SET status = 'dismissed' WHERE id = r.id;
  ELSE
    UPDATE public.home_inventory_reminders SET status = 'active' WHERE id = r.id;
  END IF;

  RETURN (SELECT jsonb_build_object('id', x.id, 'status', x.status, 'due_date', x.due_date)
            FROM public.home_inventory_reminders x WHERE x.id = r.id);
END;
$$;

-- =============================================================
-- 8. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.hi_clean(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hi_resolve_customer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hi_rate_limit_hit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hi_sync_item_reminders(uuid, boolean, integer, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hi_resolve_customer(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.hi_rate_limit_hit(uuid, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_portal_home_inventory(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_inventory_save_item(uuid, uuid, jsonb, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_inventory_add_reminder(uuid, uuid, text, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_inventory_reminder_action(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portal_home_inventory(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_inventory_save_item(uuid, uuid, jsonb, uuid[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_inventory_add_reminder(uuid, uuid, text, date, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_inventory_reminder_action(uuid, uuid, text, integer) TO anon, authenticated;
