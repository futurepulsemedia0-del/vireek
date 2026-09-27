/*
  # Customer Experience OS — Phase 3: Live Service Room

  ## Why
  Tracking (Phase 2) only shows ETA. The portal (Phase 1) only shows a list.
  Neither answers "what's happening with MY job right now" in one place.
  This adds a single per-job public page — reusing the same `reschedule_token`
  already issued to every job (one durable secret, now three uses: reschedule,
  tracking, service room) — that shows the full lifecycle: assigned →
  en route → diagnosis → quote approval → work → quality check → invoice →
  warranty → next maintenance, plus documents and before/after photos.

  ## What this adds
  1. New nullable/defaulted columns on `jobs` for the stages nothing currently
     models: work_performed_notes, before_photos/after_photos
     (storage paths, same bucket convention as job-evidence-photos),
     quality_check_passed, next_maintenance_date, documents (jsonb list of
     {name,url}), and quote_id (optional explicit link to the quote for this
     specific job — falls back to the customer's latest quote if unset).
  2. `business_profile.allow_job_room` — same opt-in pattern as
     allow_customer_portal / allow_live_tracking. Defaults false; a business
     that never turns this on has zero new exposure.
  3. `get_job_room(p_token uuid)` — SECURITY DEFINER, matches on
     reschedule_token, returns only display-safe fields. No RLS grant on
     jobs/quotes/equipment is opened to anon.

  All writes to the new columns go through the already-authenticated staff
  dashboard using the same `supabase.from('jobs').update(...)` pattern
  JobsPage.tsx already uses — covered by jobs' existing RLS
  (update_own_jobs), no new write policy needed.
*/

-- Diagnosis reuses the existing jobs.technician_diagnosis column
-- (added in 20261127000000_callback_root_cause_prevention_engine.sql) —
-- not duplicated here.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS work_performed_notes text,
  ADD COLUMN IF NOT EXISTS before_photos text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS after_photos text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS quality_check_passed boolean,
  ADD COLUMN IF NOT EXISTS next_maintenance_date date,
  ADD COLUMN IF NOT EXISTS documents jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL;

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS allow_job_room boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.get_job_room(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_business_name text;
  v_room_enabled boolean;
  v_technician_name text;
  v_technician_role text;
  v_quote quotes%ROWTYPE;
  v_warranty jsonb;
  v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE reschedule_token = p_token;
  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, COALESCE(bp.allow_job_room, false)
  INTO v_business_name, v_room_enabled
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_job.user_id;

  IF NOT v_room_enabled THEN
    RETURN NULL;
  END IF;

  SELECT tm.member_name, tm.role INTO v_technician_name, v_technician_role
  FROM team_members tm WHERE tm.id = v_job.assigned_technician_id;

  -- Explicit quote_id wins; otherwise fall back to this customer's most
  -- recent non-draft quote, same matching rule get_customer_portal_bundle
  -- already uses (user_id + customer_phone).
  IF v_job.quote_id IS NOT NULL THEN
    SELECT * INTO v_quote FROM quotes WHERE id = v_job.quote_id;
  ELSE
    SELECT * INTO v_quote FROM quotes q
    WHERE q.user_id = v_job.user_id
      AND v_job.customer_phone IS NOT NULL
      AND q.customer_phone = v_job.customer_phone
      AND q.status <> 'draft'
    ORDER BY q.created_at DESC
    LIMIT 1;
  END IF;

  SELECT jsonb_build_object(
    'equipment_type', e.equipment_type,
    'make', e.make,
    'model', e.model,
    'warranty_expires_at', e.warranty_expires_at,
    'warranty_alert_stage', e.warranty_alert_stage
  ) INTO v_warranty
  FROM equipment e
  WHERE e.user_id = v_job.user_id
    AND e.customer_id = v_job.customer_id
    AND e.status = 'active'
  ORDER BY e.created_at DESC
  LIMIT 1;

  SELECT jsonb_build_object(
    'business_name', v_business_name,
    'customer_name', v_job.customer_name,
    'service_type', v_job.service_type,
    'job_status', v_job.job_status,
    'scheduled_datetime', v_job.scheduled_datetime,
    'created_at', v_job.created_at,
    'completed_at', v_job.completed_at,

    'technician_name', v_technician_name,
    'technician_role', v_technician_role,
    'eta_minutes', v_job.eta_minutes,
    'eta_set_at', v_job.eta_set_at,
    'technician_lat', CASE WHEN v_job.job_status IN ('en_route', 'in_progress') THEN v_job.technician_lat ELSE NULL END,
    'technician_lng', CASE WHEN v_job.job_status IN ('en_route', 'in_progress') THEN v_job.technician_lng ELSE NULL END,

    'diagnosis_notes', v_job.technician_diagnosis,
    'work_performed_notes', v_job.work_performed_notes,
    'before_photos', to_jsonb(v_job.before_photos),
    'after_photos', to_jsonb(v_job.after_photos),
    'quality_check_passed', v_job.quality_check_passed,
    'next_maintenance_date', v_job.next_maintenance_date,
    'documents', v_job.documents,

    'quote', CASE WHEN v_quote.id IS NULL THEN NULL ELSE jsonb_build_object(
      'status', v_quote.status,
      'line_items', v_quote.line_items,
      'tax_percent', v_quote.tax_percent,
      'valid_until', v_quote.valid_until,
      'quote_token', v_quote.quote_token
    ) END,

    'invoice_amount', v_job.invoice_amount,
    'invoice_status', v_job.invoice_status,
    'payment_link_url', v_job.payment_link_url,

    'warranty', v_warranty
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_job_room(uuid) TO anon, authenticated;

-- =============================================================
-- STORAGE — before/after job photos shown on the public Service Room
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'job-room-photos',
  'job-room-photos',
  true,
  10485760, -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Writes locked to the uploader's own top-level folder; reads are public
-- because the service room link is opened by an anonymous customer.
DROP POLICY IF EXISTS "users_manage_own_job_room_photos" ON storage.objects;
CREATE POLICY "users_manage_own_job_room_photos"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'job-room-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'job-room-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "public_read_job_room_photos" ON storage.objects;
CREATE POLICY "public_read_job_room_photos"
ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'job-room-photos');
