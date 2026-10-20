/*
  # Vireek Home — homeowner identity, per-business sharing, privacy

  Homeowners sign in with phone OTP (Supabase Auth). They are NOT business
  accounts: phone-only users get no `profiles` row. Every read goes through
  narrow SECURITY DEFINER functions keyed on auth.uid(); tables are read-only
  for clients. A link between a homeowner and a business starts `pending`
  (shows nothing) and only becomes `active` when the homeowner explicitly
  chooses what to share. `revoked` and `pending` links can never share data
  (enforced by a CHECK constraint).
*/

-- =============================================================
-- 0. Helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.vireek_phone_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 10 THEN '1' || regexp_replace(p, '\D', '', 'g')
    WHEN length(regexp_replace(p, '\D', '', 'g')) BETWEEN 11 AND 15 THEN regexp_replace(p, '\D', '', 'g')
    ELSE NULL
  END
$$;

CREATE INDEX IF NOT EXISTS idx_customers_phone_key
  ON public.customers (public.vireek_phone_key(phone))
  WHERE phone IS NOT NULL;

-- Phone-only sign-ups are homeowners: do not create a business profile.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL AND NEW.phone IS NOT NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public.homeowner_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  full_name text CHECK (full_name IS NULL OR char_length(btrim(full_name)) BETWEEN 1 AND 120),
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  ai_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.homeowner_business_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  homeowner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  business_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  linked_via text NOT NULL CHECK (linked_via IN ('phone_match', 'portal_link')),
  share_jobs boolean NOT NULL DEFAULT false,
  share_invoices boolean NOT NULL DEFAULT false,
  share_equipment boolean NOT NULL DEFAULT false,
  share_documents boolean NOT NULL DEFAULT false,
  share_health boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (homeowner_id, customer_id),
  CONSTRAINT hbl_no_share_unless_active CHECK (
    status = 'active'
    OR NOT (share_jobs OR share_invoices OR share_equipment OR share_documents OR share_health)
  )
);

CREATE INDEX IF NOT EXISTS idx_hbl_homeowner ON public.homeowner_business_links (homeowner_id);
CREATE INDEX IF NOT EXISTS idx_hbl_business_customer ON public.homeowner_business_links (business_user_id, customer_id);

CREATE TABLE IF NOT EXISTS public.homeowner_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  homeowner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  link_id uuid REFERENCES public.homeowner_business_links(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'discovered', 'link_attempt', 'linked', 'scopes_updated', 'revoked',
    'settings_updated', 'export', 'service_request'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hce_homeowner ON public.homeowner_consent_events (homeowner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.homeowner_ai_usage (
  homeowner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (homeowner_id, day)
);

ALTER TABLE public.homeowner_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_business_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_ai_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.homeowner_profiles, public.homeowner_business_links,
  public.homeowner_consent_events, public.homeowner_ai_usage FROM anon, authenticated;
GRANT SELECT ON public.homeowner_profiles, public.homeowner_business_links,
  public.homeowner_consent_events TO authenticated;

DROP POLICY IF EXISTS "homeowner_select_own_profile" ON public.homeowner_profiles;
CREATE POLICY "homeowner_select_own_profile" ON public.homeowner_profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

DROP POLICY IF EXISTS "homeowner_select_own_links" ON public.homeowner_business_links;
CREATE POLICY "homeowner_select_own_links" ON public.homeowner_business_links
  FOR SELECT TO authenticated USING (homeowner_id = auth.uid());

DROP POLICY IF EXISTS "homeowner_select_own_consent" ON public.homeowner_consent_events;
CREATE POLICY "homeowner_select_own_consent" ON public.homeowner_consent_events
  FOR SELECT TO authenticated USING (homeowner_id = auth.uid());

-- =============================================================
-- 2. Extensions to existing tables
-- =============================================================

ALTER TABLE public.portal_requests
  ADD COLUMN IF NOT EXISTS homeowner_id uuid,
  ADD COLUMN IF NOT EXISTS photo_paths text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS homeowner_visible boolean NOT NULL DEFAULT false;

-- =============================================================
-- 3. Storage: private bucket for service-request photos
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'homeowner-uploads', 'homeowner-uploads', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "homeowner_uploads_insert_own" ON storage.objects;
CREATE POLICY "homeowner_uploads_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'homeowner-uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND EXISTS (SELECT 1 FROM public.homeowner_profiles hp WHERE hp.id = auth.uid())
  );

DROP POLICY IF EXISTS "homeowner_uploads_select_own" ON storage.objects;
CREATE POLICY "homeowner_uploads_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'homeowner-uploads' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "homeowner_uploads_delete_own" ON storage.objects;
CREATE POLICY "homeowner_uploads_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'homeowner-uploads' AND (storage.foldername(name))[1] = auth.uid()::text);

-- The business that received a request may read that request's photos.
DROP POLICY IF EXISTS "homeowner_uploads_business_read" ON storage.objects;
CREATE POLICY "homeowner_uploads_business_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'homeowner-uploads'
    AND EXISTS (
      SELECT 1 FROM public.portal_requests pr
      WHERE pr.user_id = public.get_account_owner_id()
        AND storage.objects.name = ANY (pr.photo_paths)
    )
  );

-- =============================================================
-- 4. Internal helper: the caller's live (active + portal enabled) link
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_live_link(p_link_id uuid)
RETURNS public.homeowner_business_links
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link public.homeowner_business_links;
BEGIN
  SELECT l.* INTO v_link
  FROM public.homeowner_business_links l
  JOIN public.business_profile bp ON bp.user_id = l.business_user_id
  WHERE l.id = p_link_id
    AND l.homeowner_id = auth.uid()
    AND l.status = 'active'
    AND bp.allow_customer_portal;
  IF v_link.id IS NULL THEN
    RAISE EXCEPTION 'link not available' USING ERRCODE = '42501';
  END IF;
  RETURN v_link;
END;
$$;

REVOKE ALL ON FUNCTION public.homeowner_live_link(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. Bootstrap: create profile + discover businesses by verified phone
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_bootstrap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_phone text;
  v_key text;
  v_new integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'business accounts cannot use Vireek Home' USING ERRCODE = '42501';
  END IF;

  SELECT u.phone INTO v_phone FROM auth.users u WHERE u.id = v_uid;
  v_key := public.vireek_phone_key(v_phone);
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'phone sign-in required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.homeowner_profiles (id, phone)
  VALUES (v_uid, v_phone)
  ON CONFLICT (id) DO UPDATE
    SET phone = EXCLUDED.phone, updated_at = now()
    WHERE public.homeowner_profiles.phone IS DISTINCT FROM EXCLUDED.phone;

  WITH found AS (
    INSERT INTO public.homeowner_business_links (homeowner_id, customer_id, business_user_id, linked_via)
    SELECT v_uid, m.id, m.user_id, 'phone_match'
    FROM (
      SELECT c.id, c.user_id
      FROM public.customers c
      JOIN public.business_profile bp ON bp.user_id = c.user_id AND bp.allow_customer_portal
      WHERE public.vireek_phone_key(c.phone) = v_key
      LIMIT 100
    ) m
    ON CONFLICT (homeowner_id, customer_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_new FROM found;

  IF v_new > 0 THEN
    INSERT INTO public.homeowner_consent_events (homeowner_id, event_type, detail)
    VALUES (v_uid, 'discovered', jsonb_build_object('count', v_new));
  END IF;

  RETURN jsonb_build_object('discovered', v_new);
END;
$$;

-- =============================================================
-- 6. Link by an existing portal link (portal_token)
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_link_by_portal_token(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_customer public.customers%ROWTYPE;
  v_link_id uuid;
  v_attempts integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.homeowner_profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'homeowner profile required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_attempts
  FROM public.homeowner_consent_events
  WHERE homeowner_id = v_uid AND event_type = 'link_attempt' AND created_at > now() - interval '1 hour';
  IF v_attempts >= 10 THEN
    RAISE EXCEPTION 'too many attempts' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.homeowner_consent_events (homeowner_id, event_type) VALUES (v_uid, 'link_attempt');

  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.* INTO v_customer
  FROM public.customers c
  JOIN public.business_profile bp ON bp.user_id = c.user_id AND bp.allow_customer_portal
  WHERE c.portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.homeowner_business_links (homeowner_id, customer_id, business_user_id, linked_via)
  VALUES (v_uid, v_customer.id, v_customer.user_id, 'portal_link')
  ON CONFLICT (homeowner_id, customer_id) DO NOTHING
  RETURNING id INTO v_link_id;

  IF v_link_id IS NULL THEN
    SELECT id INTO v_link_id FROM public.homeowner_business_links
    WHERE homeowner_id = v_uid AND customer_id = v_customer.id;
  ELSE
    INSERT INTO public.homeowner_consent_events (homeowner_id, link_id, event_type, detail)
    VALUES (v_uid, v_link_id, 'linked', jsonb_build_object('via', 'portal_link'));
  END IF;

  RETURN v_link_id;
END;
$$;

-- =============================================================
-- 7. Sharing controls
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_set_link_sharing(
  p_link_id uuid,
  p_jobs boolean,
  p_invoices boolean,
  p_equipment boolean,
  p_documents boolean,
  p_health boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.homeowner_business_links
  SET status = 'active',
      share_jobs = COALESCE(p_jobs, false),
      share_invoices = COALESCE(p_invoices, false),
      share_equipment = COALESCE(p_equipment, false),
      share_documents = COALESCE(p_documents, false),
      share_health = COALESCE(p_health, false),
      activated_at = COALESCE(activated_at, now()),
      revoked_at = NULL,
      updated_at = now()
  WHERE id = p_link_id AND homeowner_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.homeowner_consent_events (homeowner_id, link_id, event_type, detail)
  VALUES (v_uid, p_link_id, 'scopes_updated', jsonb_build_object(
    'jobs', COALESCE(p_jobs, false), 'invoices', COALESCE(p_invoices, false),
    'equipment', COALESCE(p_equipment, false), 'documents', COALESCE(p_documents, false),
    'health', COALESCE(p_health, false)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.homeowner_revoke_link(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.homeowner_business_links
  SET status = 'revoked',
      share_jobs = false, share_invoices = false, share_equipment = false,
      share_documents = false, share_health = false,
      revoked_at = now(), updated_at = now()
  WHERE id = p_link_id AND homeowner_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.homeowner_consent_events (homeowner_id, link_id, event_type)
  VALUES (v_uid, p_link_id, 'revoked');
END;
$$;

CREATE OR REPLACE FUNCTION public.homeowner_update_settings(
  p_full_name text,
  p_language text,
  p_ai_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.homeowner_profiles
  SET full_name = CASE WHEN p_full_name IS NULL THEN full_name ELSE NULLIF(btrim(p_full_name), '') END,
      preferred_language = COALESCE(p_language, preferred_language),
      ai_enabled = COALESCE(p_ai_enabled, ai_enabled),
      updated_at = now()
  WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'homeowner profile required' USING ERRCODE = '42501';
  END IF;

  IF p_ai_enabled IS NOT NULL THEN
    INSERT INTO public.homeowner_consent_events (homeowner_id, event_type, detail)
    VALUES (v_uid, 'settings_updated', jsonb_build_object('ai_enabled', p_ai_enabled));
  END IF;
END;
$$;

-- =============================================================
-- 8. Reads
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_get_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  RETURN jsonb_build_object(
    'profile', (
      SELECT jsonb_build_object(
        'full_name', hp.full_name, 'phone', hp.phone,
        'language', hp.preferred_language, 'ai_enabled', hp.ai_enabled
      )
      FROM public.homeowner_profiles hp WHERE hp.id = v_uid
    ),
    'businesses', COALESCE((
      SELECT jsonb_agg(b.obj ORDER BY b.created_at DESC)
      FROM (
        SELECT l.created_at,
          jsonb_build_object(
            'link_id', l.id,
            'status', l.status,
            'live', t.live,
            'business_name', COALESCE(NULLIF(p.company_name, ''), 'Service provider'),
            'business_phone', CASE WHEN t.live THEN p.phone END,
            'booking_slug', CASE WHEN t.live THEN bp.booking_slug END,
            'scopes', jsonb_build_object(
              'jobs', l.share_jobs, 'invoices', l.share_invoices, 'equipment', l.share_equipment,
              'documents', l.share_documents, 'health', l.share_health
            ),
            'next_appointment', CASE WHEN t.live AND l.share_jobs THEN (
              SELECT jsonb_build_object(
                'job_id', j.id, 'service_type', j.service_type,
                'scheduled_datetime', j.scheduled_datetime, 'job_status', j.job_status
              )
              FROM public.jobs j
              WHERE j.user_id = l.business_user_id
                AND (j.customer_id = l.customer_id OR (c.phone IS NOT NULL AND j.customer_phone = c.phone))
                AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
              ORDER BY j.scheduled_datetime NULLS LAST
              LIMIT 1
            ) END,
            'outstanding_cents', CASE WHEN t.live AND l.share_invoices THEN (
              SELECT COALESCE(sum(public.portal_invoice_total_cents(i.line_items, i.tax_percent)), 0)::bigint
              FROM public.invoices i
              WHERE i.user_id = l.business_user_id
                AND i.status IN ('sent', 'viewed')
                AND (
                  i.job_id IN (
                    SELECT j2.id FROM public.jobs j2
                    WHERE j2.user_id = l.business_user_id
                      AND (j2.customer_id = l.customer_id OR (c.phone IS NOT NULL AND j2.customer_phone = c.phone))
                  )
                  OR (c.phone IS NOT NULL AND i.customer_phone = c.phone)
                )
            ) END,
            'health_score', CASE WHEN t.live AND l.share_health THEN (
              SELECT s.score FROM public.home_health_scores s WHERE s.customer_id = l.customer_id
            ) END
          ) AS obj
        FROM public.homeowner_business_links l
        JOIN public.customers c ON c.id = l.customer_id
        LEFT JOIN public.profiles p ON p.id = l.business_user_id
        LEFT JOIN public.business_profile bp ON bp.user_id = l.business_user_id
        CROSS JOIN LATERAL (
          SELECT (l.status = 'active' AND COALESCE(bp.allow_customer_portal, false)) AS live
        ) t
        WHERE l.homeowner_id = v_uid
      ) b
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.homeowner_get_business(p_link_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link public.homeowner_business_links;
  v_customer public.customers%ROWTYPE;
  v_name text;
  v_phone text;
  v_slug text;
  v_jobs jsonb := NULL;
  v_invoices jsonb := NULL;
  v_equipment jsonb := NULL;
  v_documents jsonb := NULL;
  v_health jsonb := NULL;
BEGIN
  v_link := public.homeowner_live_link(p_link_id);

  SELECT * INTO v_customer FROM public.customers WHERE id = v_link.customer_id;
  SELECT COALESCE(NULLIF(p.company_name, ''), 'Service provider'), p.phone, bp.booking_slug
  INTO v_name, v_phone, v_slug
  FROM public.profiles p
  LEFT JOIN public.business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_link.business_user_id;

  IF v_link.share_jobs THEN
    SELECT COALESCE(jsonb_agg(x.obj ORDER BY x.sort_at DESC), '[]'::jsonb) INTO v_jobs
    FROM (
      SELECT COALESCE(j.scheduled_datetime, j.completed_at, j.created_at) AS sort_at,
        jsonb_build_object(
          'id', j.id, 'service_type', j.service_type,
          'scheduled_datetime', j.scheduled_datetime, 'completed_at', j.completed_at,
          'job_status', j.job_status,
          'reschedule_token', CASE WHEN j.job_status = 'scheduled' THEN j.reschedule_token END
        ) AS obj
      FROM public.jobs j
      WHERE j.user_id = v_link.business_user_id
        AND (j.customer_id = v_link.customer_id
             OR (v_customer.phone IS NOT NULL AND j.customer_phone = v_customer.phone))
      ORDER BY COALESCE(j.scheduled_datetime, j.completed_at, j.created_at) DESC
      LIMIT 100
    ) x;
  END IF;

  IF v_link.share_invoices THEN
    SELECT COALESCE(jsonb_agg(x.obj ORDER BY x.sort_at DESC), '[]'::jsonb) INTO v_invoices
    FROM (
      SELECT COALESCE(i.sent_at, i.created_at) AS sort_at,
        jsonb_build_object(
          'id', i.id, 'invoice_number', i.invoice_number, 'invoice_token', i.invoice_token,
          'status', i.status,
          'total_cents', public.portal_invoice_total_cents(i.line_items, i.tax_percent),
          'due_date', i.due_date, 'sent_at', i.sent_at, 'paid_at', i.paid_at
        ) AS obj
      FROM public.invoices i
      WHERE i.user_id = v_link.business_user_id
        AND i.status <> 'draft'
        AND (
          i.job_id IN (
            SELECT j.id FROM public.jobs j
            WHERE j.user_id = v_link.business_user_id
              AND (j.customer_id = v_link.customer_id
                   OR (v_customer.phone IS NOT NULL AND j.customer_phone = v_customer.phone))
          )
          OR (v_customer.phone IS NOT NULL AND i.customer_phone = v_customer.phone)
        )
      ORDER BY COALESCE(i.sent_at, i.created_at) DESC
      LIMIT 100
    ) x;
  END IF;

  IF v_link.share_equipment THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', e.id, 'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
      'install_date', e.install_date,
      'warranty_expires_at', COALESCE(e.warranty_expires_at, ep.warranty_expires_at),
      'last_service_date', e.last_service_date,
      'passport_code', ep.public_code
    ) ORDER BY e.created_at DESC), '[]'::jsonb) INTO v_equipment
    FROM public.equipment e
    LEFT JOIN LATERAL (
      SELECT p.public_code, p.warranty_expires_at
      FROM public.equipment_passport_links l
      JOIN public.equipment_passports p ON p.id = l.passport_id
      WHERE l.equipment_id = e.id AND l.status = 'active' AND p.status = 'active'
      LIMIT 1
    ) ep ON true
    WHERE e.user_id = v_link.business_user_id
      AND e.customer_id = v_link.customer_id
      AND e.status = 'active';
  END IF;

  IF v_link.share_documents THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'title', d.title, 'category', d.category,
      'issued_on', d.issued_on, 'expires_on', d.expires_on,
      'file_name', d.current_file_name, 'mime_type', d.current_mime_type,
      'size_bytes', d.current_file_size
    ) ORDER BY d.created_at DESC), '[]'::jsonb) INTO v_documents
    FROM public.documents d
    WHERE d.user_id = v_link.business_user_id
      AND d.customer_id = v_link.customer_id
      AND d.homeowner_visible
      AND d.current_version_id IS NOT NULL;
  END IF;

  IF v_link.share_health THEN
    SELECT jsonb_build_object(
      'score', s.score, 'grade', s.grade, 'confidence', s.confidence,
      'equipment_count', s.equipment_count, 'at_risk_count', s.at_risk_count,
      'breakdown', s.breakdown, 'computed_at', s.computed_at,
      'history', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('score', h.score, 'computed_at', h.computed_at) ORDER BY h.computed_at)
        FROM (
          SELECT score, computed_at FROM public.home_health_score_history
          WHERE customer_id = v_link.customer_id
          ORDER BY computed_at DESC LIMIT 24
        ) h
      ), '[]'::jsonb),
      'actions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', a.id, 'equipment_id', a.equipment_id, 'action_type', a.action_type,
          'stage', a.stage, 'urgency', a.urgency,
          'window_min_months', a.window_min_months, 'window_max_months', a.window_max_months,
          'explanation', a.explanation
        ))
        FROM public.home_health_actions a
        WHERE a.customer_id = v_link.customer_id
          AND a.stage IN ('detected', 'explained', 'awaiting_customer', 'scheduled', 'dispatched')
      ), '[]'::jsonb)
    ) INTO v_health
    FROM public.home_health_scores s
    WHERE s.customer_id = v_link.customer_id;
  END IF;

  RETURN jsonb_build_object(
    'link_id', v_link.id,
    'business_name', v_name,
    'business_phone', v_phone,
    'booking_slug', v_slug,
    'customer_name', v_customer.name,
    'scopes', jsonb_build_object(
      'jobs', v_link.share_jobs, 'invoices', v_link.share_invoices, 'equipment', v_link.share_equipment,
      'documents', v_link.share_documents, 'health', v_link.share_health
    ),
    'jobs', v_jobs,
    'invoices', v_invoices,
    'equipment', v_equipment,
    'documents', v_documents,
    'health', v_health
  );
END;
$$;

-- Storage path of a shared document (the edge function signs it after this check).
CREATE OR REPLACE FUNCTION public.homeowner_get_document_path(p_link_id uuid, p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link public.homeowner_business_links;
  v_result jsonb;
BEGIN
  v_link := public.homeowner_live_link(p_link_id);
  IF NOT v_link.share_documents THEN
    RAISE EXCEPTION 'documents are not shared' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object('storage_path', dv.storage_path, 'file_name', dv.file_name, 'mime_type', dv.mime_type)
  INTO v_result
  FROM public.documents d
  JOIN public.document_versions dv ON dv.id = d.current_version_id
  WHERE d.id = p_document_id
    AND d.user_id = v_link.business_user_id
    AND d.customer_id = v_link.customer_id
    AND d.homeowner_visible;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'document not available' USING ERRCODE = '42501';
  END IF;
  RETURN v_result;
END;
$$;

-- =============================================================
-- 9. Service request with photos
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_submit_service_request(
  p_link_id uuid,
  p_service_type text,
  p_message text,
  p_photo_paths text[] DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_link public.homeowner_business_links;
  v_customer public.customers%ROWTYPE;
  v_type text := NULLIF(btrim(COALESCE(p_service_type, '')), '');
  v_msg text := NULLIF(btrim(COALESCE(p_message, '')), '');
  v_paths text[] := COALESCE(p_photo_paths, '{}');
  v_path text;
  v_recent integer;
  v_lead_id uuid;
  v_request_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  v_link := public.homeowner_live_link(p_link_id);

  IF v_type IS NULL AND v_msg IS NULL THEN
    RAISE EXCEPTION 'describe what you need' USING ERRCODE = '22023';
  END IF;
  IF char_length(COALESCE(v_msg, '')) > 2000 OR char_length(COALESCE(v_type, '')) > 120 THEN
    RAISE EXCEPTION 'text is too long' USING ERRCODE = '22001';
  END IF;
  IF COALESCE(array_length(v_paths, 1), 0) > 6 THEN
    RAISE EXCEPTION 'too many photos' USING ERRCODE = '22023';
  END IF;

  FOREACH v_path IN ARRAY v_paths LOOP
    IF v_path IS NULL
       OR char_length(v_path) > 300
       OR position('..' IN v_path) > 0
       OR split_part(v_path, '/', 1) <> v_uid::text
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'homeowner-uploads' AND o.name = v_path
       ) THEN
      RAISE EXCEPTION 'invalid photo reference' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_recent
  FROM public.portal_requests
  WHERE homeowner_id = v_uid AND created_at > now() - interval '1 hour';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'too many requests' USING ERRCODE = '54000';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE id = v_link.customer_id;

  INSERT INTO public.leads (user_id, customer_id, name, phone, email, service_interested, notes, stage)
  VALUES (
    v_link.business_user_id, v_customer.id, v_customer.name, v_customer.phone, v_customer.email,
    v_type,
    NULLIF(btrim(concat_ws(E'\n', v_msg,
      CASE WHEN array_length(v_paths, 1) > 0
        THEN '[Vireek Home request: ' || array_length(v_paths, 1) || ' photo(s) attached]' END)), ''),
    'new'
  )
  RETURNING id INTO v_lead_id;

  INSERT INTO public.portal_requests (user_id, customer_id, lead_id, service_type, message, homeowner_id, photo_paths)
  VALUES (v_link.business_user_id, v_customer.id, v_lead_id, v_type, v_msg, v_uid, v_paths)
  RETURNING id INTO v_request_id;

  INSERT INTO public.homeowner_consent_events (homeowner_id, link_id, event_type, detail)
  VALUES (v_uid, v_link.id, 'service_request', jsonb_build_object('photos', COALESCE(array_length(v_paths, 1), 0)));

  RETURN v_request_id;
END;
$$;

-- =============================================================
-- 10. AI quota + data export + business-side document toggle
-- =============================================================

CREATE OR REPLACE FUNCTION public.homeowner_ai_consume()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.homeowner_ai_usage (homeowner_id, day, requests)
  VALUES (v_uid, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (homeowner_id, day) DO UPDATE SET requests = public.homeowner_ai_usage.requests + 1
  RETURNING requests INTO v_count;
  RETURN v_count <= 40;
END;
$$;

CREATE OR REPLACE FUNCTION public.homeowner_export_my_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_recent integer;
  v_shared jsonb := '[]'::jsonb;
  v_link_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT count(*) INTO v_recent
  FROM public.homeowner_consent_events
  WHERE homeowner_id = v_uid AND event_type = 'export' AND created_at > now() - interval '1 day';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'too many exports' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.homeowner_consent_events (homeowner_id, event_type) VALUES (v_uid, 'export');

  FOR v_link_id IN
    SELECT id FROM public.homeowner_business_links WHERE homeowner_id = v_uid AND status = 'active'
  LOOP
    BEGIN
      v_shared := v_shared || jsonb_build_array(jsonb_build_object(
        'link_id', v_link_id, 'data', public.homeowner_get_business(v_link_id)
      ));
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- business turned its portal off; nothing to export for that link
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'exported_at', now(),
    'profile', (SELECT to_jsonb(hp) - 'id' FROM public.homeowner_profiles hp WHERE hp.id = v_uid),
    'business_links', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'link_id', l.id,
        'business_name', COALESCE(NULLIF(p.company_name, ''), 'Service provider'),
        'status', l.status, 'linked_via', l.linked_via,
        'shares', jsonb_build_object(
          'jobs', l.share_jobs, 'invoices', l.share_invoices, 'equipment', l.share_equipment,
          'documents', l.share_documents, 'health', l.share_health
        ),
        'created_at', l.created_at, 'activated_at', l.activated_at, 'revoked_at', l.revoked_at
      ))
      FROM public.homeowner_business_links l
      LEFT JOIN public.profiles p ON p.id = l.business_user_id
      WHERE l.homeowner_id = v_uid
    ), '[]'::jsonb),
    'consent_history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('event', e.event_type, 'detail', e.detail, 'at', e.created_at) ORDER BY e.created_at DESC)
      FROM public.homeowner_consent_events e WHERE e.homeowner_id = v_uid
    ), '[]'::jsonb),
    'service_requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'service_type', r.service_type, 'message', r.message, 'status', r.status,
        'photos', COALESCE(array_length(r.photo_paths, 1), 0), 'created_at', r.created_at
      ) ORDER BY r.created_at DESC)
      FROM public.portal_requests r WHERE r.homeowner_id = v_uid
    ), '[]'::jsonb),
    'shared_business_data', v_shared
  );
END;
$$;

-- Business side: choose which of a customer's documents the homeowner may see.
CREATE OR REPLACE FUNCTION public.set_document_homeowner_visible(p_document_id uuid, p_visible boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_manage_documents() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE public.documents
  SET homeowner_visible = COALESCE(p_visible, false), updated_at = now()
  WHERE id = p_document_id
    AND user_id = public.get_account_owner_id()
    AND customer_id IS NOT NULL;
  RETURN FOUND;
END;
$$;

-- =============================================================
-- 11. Grants: authenticated only, never anon / PUBLIC
-- =============================================================

REVOKE ALL ON FUNCTION public.homeowner_bootstrap() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_link_by_portal_token(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_set_link_sharing(uuid, boolean, boolean, boolean, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_revoke_link(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_update_settings(text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_get_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_get_business(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_get_document_path(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_submit_service_request(uuid, text, text, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_ai_consume() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.homeowner_export_my_data() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_document_homeowner_visible(uuid, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.homeowner_bootstrap() TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_link_by_portal_token(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_set_link_sharing(uuid, boolean, boolean, boolean, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_revoke_link(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_update_settings(text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_get_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_get_business(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_get_document_path(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_submit_service_request(uuid, text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_ai_consume() TO authenticated;
GRANT EXECUTE ON FUNCTION public.homeowner_export_my_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_document_homeowner_visible(uuid, boolean) TO authenticated;
