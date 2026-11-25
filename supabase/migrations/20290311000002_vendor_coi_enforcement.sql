/*
  # Subcontractor insurance certificates (COI): coverage tracking, expiry alerts, assignment gate

  Builds on vendor_documents (doc_type 'coi' keeps working untouched) and the job board.

  Adds (additive, idempotent):
    - vendor_coi_coverages     : one row per coverage line on a certificate (GL, workers' comp, ...),
                                 fields keyed in manually; verified by a manager
    - vendor_coi_requirements  : per-vendor override / exemption (reason required)
    - private bucket vendor-documents  ({owner}/{vendor}/{file}), manager-only
    - vendor_coi_blockers()    : [] = ok, ['COI'] = blocked (only when enforcement = 'block')
    - vendor_coi_status()      : per required coverage state, for the UI
    - job_board_vendor_blockers() wrapped so the board audience / bids also see 'COI'
    - trigger on job_board_posts : the final award is refused too, INCLUDING dispatcher override
    - vendor_compliance_sweep() : daily expiry notifications (licence + COI + licence re-check)

  Enforcement is OFF by default (vendor_compliance_settings.coi_enforcement = 'off'): nothing changes
  for any account until its owner switches it on.

  Requires migration 20290311000001 and the open job board (20271102000000).
*/

-- 1) Coverage lines --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_coi_coverages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  coverage_type text NOT NULL CHECK (coverage_type IN ('general_liability', 'workers_comp', 'commercial_auto', 'umbrella')),
  carrier text CHECK (carrier IS NULL OR char_length(carrier) <= 200),
  policy_number text CHECK (policy_number IS NULL OR char_length(policy_number) <= 80),
  effective_on date,
  expires_on date NOT NULL,
  each_occurrence_cents bigint CHECK (each_occurrence_cents IS NULL OR each_occurrence_cents >= 0),
  aggregate_cents bigint CHECK (aggregate_cents IS NULL OR aggregate_cents >= 0),
  file_path text CHECK (file_path IS NULL OR char_length(file_path) <= 300),
  extraction_method text NOT NULL DEFAULT 'manual' CHECK (extraction_method IN ('manual', 'ocr')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vcc_dates_ordered CHECK (effective_on IS NULL OR expires_on >= effective_on),
  CONSTRAINT vcc_verified_has_actor CHECK (status <> 'verified' OR (verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_vcc_vendor ON public.vendor_coi_coverages(vendor_id, coverage_type, expires_on DESC);
CREATE INDEX IF NOT EXISTS idx_vcc_user_expiry ON public.vendor_coi_coverages(user_id, expires_on) WHERE status <> 'rejected';

ALTER TABLE public.vendor_coi_coverages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vcc_select" ON public.vendor_coi_coverages;
CREATE POLICY "vcc_select" ON public.vendor_coi_coverages FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE INSERT, UPDATE, DELETE ON public.vendor_coi_coverages FROM anon, authenticated;

-- 2) Per-vendor requirements -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_coi_requirements (
  vendor_id uuid PRIMARY KEY REFERENCES public.vendors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  exempt boolean NOT NULL DEFAULT false,
  exempt_reason text CHECK (exempt_reason IS NULL OR char_length(exempt_reason) BETWEEN 3 AND 300),
  required_coverages text[] CHECK (required_coverages IS NULL OR
    required_coverages <@ ARRAY['general_liability', 'workers_comp', 'commercial_auto', 'umbrella']::text[]),
  set_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vcr_exempt_needs_reason CHECK (NOT exempt OR exempt_reason IS NOT NULL)
);

ALTER TABLE public.vendor_coi_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vcr_select" ON public.vendor_coi_requirements;
CREATE POLICY "vcr_select" ON public.vendor_coi_requirements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE INSERT, UPDATE, DELETE ON public.vendor_coi_requirements FROM anon, authenticated;

-- 3) Private storage bucket (manager-only, path = {owner}/{vendor}/{file}) ----------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('vendor-documents', 'vendor-documents', false, 10485760,
        ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "vendor_documents_insert" ON storage.objects;
CREATE POLICY "vendor_documents_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vendor-documents'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.identity_is_manager());
DROP POLICY IF EXISTS "vendor_documents_select" ON storage.objects;
CREATE POLICY "vendor_documents_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'vendor-documents'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.identity_is_manager());
DROP POLICY IF EXISTS "vendor_documents_delete" ON storage.objects;
CREATE POLICY "vendor_documents_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'vendor-documents'
    AND (storage.foldername(name))[1] = public.get_account_owner_id()::text
    AND public.identity_is_manager());

-- 4) Status + blockers -------------------------------------------------------------------------
-- One row per REQUIRED coverage: ok | pending | expired | missing | below_minimum
-- Uses the newest non-rejected row per coverage type, so a renewal supersedes the old policy.
CREATE OR REPLACE FUNCTION public.vendor_coi_status(p_owner uuid, p_vendor_id uuid)
RETURNS TABLE (coverage_type text, state text, expires_on date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s vendor_compliance_settings;
  r vendor_coi_requirements;
  v_required text[];
  v_grace integer;
BEGIN
  SELECT * INTO s FROM vendor_compliance_settings WHERE user_id = p_owner;
  v_grace := COALESCE(s.coi_grace_days, 0);
  v_required := COALESCE(s.coi_required_coverages, ARRAY['general_liability', 'workers_comp']::text[]);

  SELECT * INTO r FROM vendor_coi_requirements WHERE vendor_id = p_vendor_id AND user_id = p_owner;
  IF FOUND THEN
    IF r.exempt THEN RETURN; END IF;
    IF r.required_coverages IS NOT NULL THEN v_required := r.required_coverages; END IF;
  END IF;

  RETURN QUERY
  SELECT req.t,
         CASE
           WHEN c.id IS NULL THEN 'missing'
           WHEN c.expires_on + v_grace < current_date THEN 'expired'
           WHEN c.status <> 'verified' THEN 'pending'
           WHEN req.t = 'general_liability' AND s.coi_min_general_liability_cents IS NOT NULL
                AND COALESCE(c.each_occurrence_cents, 0) < s.coi_min_general_liability_cents THEN 'below_minimum'
           ELSE 'ok'
         END,
         c.expires_on
    FROM unnest(v_required) AS req(t)
    LEFT JOIN LATERAL (
      SELECT x.* FROM vendor_coi_coverages x
       WHERE x.vendor_id = p_vendor_id AND x.user_id = p_owner AND x.coverage_type = req.t AND x.status <> 'rejected'
       ORDER BY x.expires_on DESC, x.created_at DESC LIMIT 1
    ) c ON true;
END;
$$;
REVOKE ALL ON FUNCTION public.vendor_coi_status(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.vendor_coi_blockers(p_owner uuid, p_vendor_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode text;
BEGIN
  SELECT coi_enforcement INTO v_mode FROM vendor_compliance_settings WHERE user_id = p_owner;
  IF COALESCE(v_mode, 'off') <> 'block' THEN RETURN '{}'::text[]; END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_coi_status(p_owner, p_vendor_id) st WHERE st.state <> 'ok') THEN
    RETURN ARRAY['COI']::text[];
  END IF;
  RETURN '{}'::text[];
END;
$$;
REVOKE ALL ON FUNCTION public.vendor_coi_blockers(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Manager-facing status for the vendor detail panel.
CREATE OR REPLACE FUNCTION public.get_vendor_coi_status(p_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = p_vendor_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;
  RETURN jsonb_build_object(
    'enforcement', COALESCE((SELECT coi_enforcement FROM vendor_compliance_settings WHERE user_id = v_owner), 'off'),
    'exempt', COALESCE((SELECT exempt FROM vendor_coi_requirements WHERE vendor_id = p_vendor_id), false),
    'exempt_reason', (SELECT exempt_reason FROM vendor_coi_requirements WHERE vendor_id = p_vendor_id),
    'blocked', cardinality(public.vendor_coi_blockers(v_owner, p_vendor_id)) > 0,
    'coverages', COALESCE((SELECT jsonb_agg(jsonb_build_object('coverage_type', st.coverage_type, 'state', st.state, 'expires_on', st.expires_on))
                             FROM public.vendor_coi_status(v_owner, p_vendor_id) st), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_vendor_coi_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vendor_coi_status(uuid) TO authenticated;

-- 5) Wrap the existing job-board gate (original body is kept verbatim as *_base) ------------------
DO $$
BEGIN
  IF to_regprocedure('public.job_board_vendor_blockers_base(uuid,uuid,text,uuid)') IS NULL
     AND to_regprocedure('public.job_board_vendor_blockers(uuid,uuid,text,uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.job_board_vendor_blockers(uuid, uuid, text, uuid) RENAME TO job_board_vendor_blockers_base;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.job_board_vendor_blockers(
  p_owner uuid, p_vendor_id uuid, p_skill text, p_area_id uuid
) RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out text[];
BEGIN
  v_out := public.job_board_vendor_blockers_base(p_owner, p_vendor_id, p_skill, p_area_id);
  -- The base function returns early (SUBS_DISABLED / NOT_APPROVED / NOT_ENROLLED) for ineligible
  -- vendors; the COI reason is only meaningful for vendors that would otherwise qualify.
  IF NOT (v_out && ARRAY['SUBS_DISABLED', 'NOT_APPROVED', 'NOT_ENROLLED']::text[]) THEN
    v_out := v_out || public.vendor_coi_blockers(p_owner, p_vendor_id);
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.job_board_vendor_blockers_base(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
-- (grants on the public wrapper are intentionally left exactly as they were)

-- 6) Hard stop at the moment of award (covers dispatcher override too) ------------------------------
CREATE OR REPLACE FUNCTION public.job_board_guard_vendor_coi()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.awarded_vendor_id IS NOT NULL
     AND NEW.status = 'awarded'
     AND (OLD.status IS DISTINCT FROM 'awarded' OR NEW.awarded_vendor_id IS DISTINCT FROM OLD.awarded_vendor_id)
     AND cardinality(public.vendor_coi_blockers(NEW.user_id, NEW.awarded_vendor_id)) > 0 THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE:COI' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_job_board_guard_vendor_coi ON public.job_board_posts;
CREATE TRIGGER trg_job_board_guard_vendor_coi
  BEFORE UPDATE OF awarded_vendor_id ON public.job_board_posts
  FOR EACH ROW EXECUTE FUNCTION public.job_board_guard_vendor_coi();

-- 7) RPCs: coverage CRUD ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_vendor_coi_coverage(
  p_vendor_id uuid,
  p_coverage_type text,
  p_expires_on date,
  p_carrier text DEFAULT NULL,
  p_policy_number text DEFAULT NULL,
  p_effective_on date DEFAULT NULL,
  p_each_occurrence_cents bigint DEFAULT NULL,
  p_aggregate_cents bigint DEFAULT NULL,
  p_file_path text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_path text := NULLIF(btrim(COALESCE(p_file_path, '')), '');
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = p_vendor_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;
  IF p_expires_on IS NULL THEN RAISE EXCEPTION 'EXPIRY_REQUIRED'; END IF;
  -- The file must live in THIS account's folder for THIS vendor (no pointing at someone else's file).
  IF v_path IS NOT NULL AND v_path NOT LIKE (v_owner::text || '/' || p_vendor_id::text || '/%') THEN
    RAISE EXCEPTION 'INVALID_FILE_PATH';
  END IF;
  IF v_path IS NOT NULL AND v_path LIKE '%..%' THEN RAISE EXCEPTION 'INVALID_FILE_PATH'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO vendor_coi_coverages (
      user_id, vendor_id, coverage_type, carrier, policy_number, effective_on, expires_on,
      each_occurrence_cents, aggregate_cents, file_path, notes, created_by
    ) VALUES (
      v_owner, p_vendor_id, p_coverage_type, NULLIF(btrim(COALESCE(p_carrier, '')), ''),
      NULLIF(btrim(COALESCE(p_policy_number, '')), ''), p_effective_on, p_expires_on,
      p_each_occurrence_cents, p_aggregate_cents, v_path, NULLIF(btrim(COALESCE(p_notes, '')), ''), auth.uid()
    ) RETURNING id INTO v_id;
  ELSE
    -- Any edit drops a verified coverage back to "pending": the new numbers were never checked.
    UPDATE vendor_coi_coverages SET
      coverage_type = p_coverage_type, carrier = NULLIF(btrim(COALESCE(p_carrier, '')), ''),
      policy_number = NULLIF(btrim(COALESCE(p_policy_number, '')), ''), effective_on = p_effective_on,
      expires_on = p_expires_on, each_occurrence_cents = p_each_occurrence_cents,
      aggregate_cents = p_aggregate_cents, file_path = COALESCE(v_path, file_path),
      notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
      status = 'pending', verified_by = NULL, verified_at = NULL, updated_at = now()
     WHERE id = p_id AND vendor_id = p_vendor_id AND user_id = v_owner
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'COVERAGE_NOT_FOUND'; END IF;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_vendor_coi_coverage(uuid, text, date, text, text, date, bigint, bigint, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_vendor_coi_coverage(uuid, text, date, text, text, date, bigint, bigint, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_vendor_coi_coverage_status(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_status NOT IN ('pending', 'verified', 'rejected') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  UPDATE vendor_coi_coverages SET
    status = p_status,
    verified_by = CASE WHEN p_status = 'verified' THEN auth.uid() END,
    verified_at = CASE WHEN p_status = 'verified' THEN now() END,
    updated_at = now()
   WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'COVERAGE_NOT_FOUND'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_vendor_coi_coverage_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_vendor_coi_coverage_status(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_vendor_coi_coverage(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  DELETE FROM vendor_coi_coverages WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'COVERAGE_NOT_FOUND'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_vendor_coi_coverage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_vendor_coi_coverage(uuid) TO authenticated;

-- Per-vendor exemption / override. Exempting needs a written reason.
CREATE OR REPLACE FUNCTION public.set_vendor_coi_requirement(
  p_vendor_id uuid, p_exempt boolean, p_reason text DEFAULT NULL, p_required text[] DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = p_vendor_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;
  IF COALESCE(p_exempt, false) AND v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  INSERT INTO vendor_coi_requirements (vendor_id, user_id, exempt, exempt_reason, required_coverages, set_by)
  VALUES (p_vendor_id, v_owner, COALESCE(p_exempt, false), CASE WHEN COALESCE(p_exempt, false) THEN v_reason END, p_required, auth.uid())
  ON CONFLICT (vendor_id) DO UPDATE SET
    exempt = EXCLUDED.exempt, exempt_reason = EXCLUDED.exempt_reason,
    required_coverages = EXCLUDED.required_coverages, set_by = EXCLUDED.set_by, updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.set_vendor_coi_requirement(uuid, boolean, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_vendor_coi_requirement(uuid, boolean, text, text[]) TO authenticated;

-- 8) Expiry notifications (service role / cron only) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.vendor_compliance_sweep()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  -- COI: newest non-rejected row per vendor + coverage; only vendors still in play.
  WITH cur AS (
    SELECT DISTINCT ON (c.vendor_id, c.coverage_type)
           c.id, c.user_id, c.vendor_id, c.coverage_type, c.expires_on
      FROM vendor_coi_coverages c
      JOIN vendors v ON v.id = c.vendor_id AND v.active
     WHERE c.status <> 'rejected'
     ORDER BY c.vendor_id, c.coverage_type, c.expires_on DESC, c.created_at DESC
  ), due AS (
    SELECT cur.*, CASE WHEN cur.expires_on < current_date THEN 'expired'
                       WHEN cur.expires_on <= current_date + 7 THEN 'd7'
                       WHEN cur.expires_on <= current_date + 14 THEN 'd14'
                       ELSE 'd30' END AS bucket
      FROM cur WHERE cur.expires_on <= current_date + 30
  ), ins AS (
    INSERT INTO vendor_compliance_alerts (user_id, vendor_id, item_kind, item_id, bucket, due_on)
    SELECT user_id, vendor_id, 'coi', id, bucket, expires_on FROM due
    ON CONFLICT ON CONSTRAINT vca_unique DO NOTHING
    RETURNING user_id, vendor_id, item_id, bucket, due_on
  ), note AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT i.user_id, 'system',
           CASE WHEN i.bucket = 'expired' THEN 'Subcontractor insurance expired' ELSE 'Subcontractor insurance expiring' END,
           v.name || ': ' || replace(d.coverage_type, '_', ' ') || CASE WHEN i.bucket = 'expired'
             THEN ' coverage expired on ' ELSE ' coverage expires on ' END || to_char(i.due_on, 'YYYY-MM-DD') || '.',
           '/dashboard/vendors'
      FROM ins i JOIN vendors v ON v.id = i.vendor_id JOIN due d ON d.id = i.item_id
    RETURNING 1
  )
  SELECT count(*) INTO v_k FROM note;
  v_n := v_n + COALESCE(v_k, 0);

  -- Licences: latest check per licence, effective expiry.
  WITH due AS (
    SELECT c.id, c.user_id, c.vendor_id, c.license_number, c.jurisdiction, c.expires_on,
           CASE WHEN c.expires_on < current_date THEN 'expired'
                WHEN c.expires_on <= current_date + 7 THEN 'd7'
                WHEN c.expires_on <= current_date + 14 THEN 'd14'
                ELSE 'd30' END AS bucket
      FROM vendor_license_current c
      JOIN vendors v ON v.id = c.vendor_id AND v.active
     WHERE c.license_status = 'active' AND c.expires_on IS NOT NULL AND c.expires_on <= current_date + 30
  ), ins AS (
    INSERT INTO vendor_compliance_alerts (user_id, vendor_id, item_kind, item_id, bucket, due_on)
    SELECT user_id, vendor_id, 'license', id, bucket, expires_on FROM due
    ON CONFLICT ON CONSTRAINT vca_unique DO NOTHING
    RETURNING user_id, vendor_id, item_id, bucket, due_on
  ), note AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT i.user_id, 'system',
           CASE WHEN i.bucket = 'expired' THEN 'Subcontractor licence expired' ELSE 'Subcontractor licence expiring' END,
           v.name || ': licence ' || d.license_number || ' (' || d.jurisdiction || ')' || CASE WHEN i.bucket = 'expired'
             THEN ' expired on ' ELSE ' expires on ' END || to_char(i.due_on, 'YYYY-MM-DD') || '.',
           '/dashboard/vendors'
      FROM ins i JOIN vendors v ON v.id = i.vendor_id JOIN due d ON d.id = i.item_id
    RETURNING 1
  )
  SELECT count(*) INTO v_k FROM note;
  v_n := v_n + COALESCE(v_k, 0);

  -- Licences whose re-check date has arrived (only when the owner set a cadence).
  WITH due AS (
    SELECT c.id, c.user_id, c.vendor_id, c.license_number, c.jurisdiction, c.next_check_at
      FROM vendor_license_current c
      JOIN vendors v ON v.id = c.vendor_id AND v.active
     WHERE c.next_check_at IS NOT NULL AND c.next_check_at <= current_date
  ), ins AS (
    INSERT INTO vendor_compliance_alerts (user_id, vendor_id, item_kind, item_id, bucket, due_on)
    SELECT user_id, vendor_id, 'license_recheck', id, 'due', next_check_at FROM due
    ON CONFLICT ON CONSTRAINT vca_unique DO NOTHING
    RETURNING user_id, vendor_id, item_id, due_on
  ), note AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT i.user_id, 'system', 'Subcontractor licence re-check due',
           v.name || ': re-verify licence ' || d.license_number || ' (' || d.jurisdiction || ').', '/dashboard/vendors'
      FROM ins i JOIN vendors v ON v.id = i.vendor_id JOIN due d ON d.id = i.item_id
    RETURNING 1
  )
  SELECT count(*) INTO v_k FROM note;
  v_n := v_n + COALESCE(v_k, 0);

  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.vendor_compliance_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_compliance_sweep() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-vendor-compliance-sweep', '20 6 * * *', 'select public.vendor_compliance_sweep()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled: call public.vendor_compliance_sweep() daily from an external scheduler.';
  END IF;
END $$;
