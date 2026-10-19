/*
  # Equipment data-plate (nameplate) scanning

  A technician photographs the manufacturer's data plate; the `equipment-nameplate-scan` edge function
  reads brand / model / serial / manufacture date (vision OCR), and creates the equipment record. The
  existing AFTER INSERT trigger on `equipment` (vp_on_equipment_insert) then issues — or joins — the
  equipment passport, so this feature reuses the passport machinery instead of duplicating it.

  ## What this adds
  - `equipment_nameplate_scans`: one row per photo (unique per account + SHA-256, so a repeated photo
    costs zero AI tokens). Holds the normalised read, the review reasons and the outcome.
  - `nameplate_create_equipment(scan, user, fields)`: the ONLY write path. One transaction that
    de-duplicates the unit for the customer, inserts the equipment, links it to the job, resolves the
    passport and appends ONE sanitised passport event. Idempotent: calling it twice returns the same result.

  ## Security
  - No client writes: authenticated users can only SELECT their own account's scans.
  - The RPC is executable by service_role ONLY (the edge function validates the caller first).
  - The passport event is written only when the passport link is VERIFIED (same rule as every other
    writer): joining another company's existing passport stays unverified until the QR label is scanned,
    and the public code is withheld until then.

  NOTE: keep this file's timestamp AFTER your newest migration (rename it if needed).
*/

-- 1) Scans -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.equipment_nameplate_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                   -- account owner (tenant)
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  storage_path text NOT NULL CHECK (char_length(storage_path) <= 300),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text,
  byte_size integer,
  status text NOT NULL DEFAULT 'extracted' CHECK (status IN ('extracted', 'created', 'failed')),
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extracted) = 'object'),
  review_reasons text[] NOT NULL DEFAULT '{}',
  auto_create_ready boolean NOT NULL DEFAULT false,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  passport_id uuid REFERENCES public.equipment_passports(id),
  model_name text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_nameplate_scans_user ON public.equipment_nameplate_scans (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nameplate_scans_equipment ON public.equipment_nameplate_scans (equipment_id) WHERE equipment_id IS NOT NULL;

ALTER TABLE public.equipment_nameplate_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "nameplate_scans_select" ON public.equipment_nameplate_scans;
CREATE POLICY "nameplate_scans_select" ON public.equipment_nameplate_scans FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE ALL ON public.equipment_nameplate_scans FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.equipment_nameplate_scans FROM authenticated;

-- 2) Create equipment + passport from a scan ----------------------------------
CREATE OR REPLACE FUNCTION public.nameplate_create_equipment(p_scan uuid, p_user uuid, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  v_eq uuid;
  v_reused boolean := false;
  v_make text := nullif(btrim(p_fields->>'make'), '');
  v_model text := nullif(btrim(p_fields->>'model'), '');
  v_serial text := nullif(btrim(p_fields->>'serial_number'), '');
  v_type text := nullif(btrim(p_fields->>'equipment_type'), '');
  v_install date := nullif(p_fields->>'install_date', '')::date;
  v_warranty date := nullif(p_fields->>'warranty_expires_at', '')::date;
  v_wnotes text := nullif(left(p_fields->>'warranty_notes', 500), '');
  v_notes text := nullif(left(p_fields->>'notes', 300), '');
  v_key text;
  v_pid uuid;
  v_verified boolean;
  v_via text;
  v_code text;
BEGIN
  SELECT * INTO s FROM public.equipment_nameplate_scans WHERE id = p_scan AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NAMEPLATE_SCAN_NOT_FOUND'; END IF;
  IF s.customer_id IS NULL THEN RAISE EXCEPTION 'NAMEPLATE_NO_CUSTOMER'; END IF;

  IF s.status = 'created' AND s.equipment_id IS NOT NULL THEN
    -- Idempotent replay (double tap, retry after a dropped response): report the same outcome.
    v_eq := s.equipment_id;
    v_reused := true;
  ELSE
    IF v_make IS NULL OR v_type IS NULL THEN RAISE EXCEPTION 'NAMEPLATE_INVALID: brand and equipment type are required'; END IF;

    v_key := public.vp_serial_key(v_make, v_serial);
    IF v_key IS NOT NULL THEN
      -- This customer already has this physical unit on file: reuse it instead of creating a duplicate.
      SELECT id INTO v_eq FROM public.equipment
      WHERE user_id = p_user AND customer_id = s.customer_id AND status = 'active'
        AND public.vp_serial_key(make, serial_number) = v_key
      LIMIT 1;
      v_reused := FOUND;
    END IF;

    IF v_eq IS NULL THEN
      INSERT INTO public.equipment
        (user_id, customer_id, equipment_type, make, model, serial_number, install_date, warranty_expires_at, warranty_notes, notes)
      VALUES
        (p_user, s.customer_id, v_type, v_make, v_model, v_serial, v_install, v_warranty, v_wnotes, v_notes)
      RETURNING id INTO v_eq;
    ELSIF v_warranty IS NOT NULL THEN
      UPDATE public.equipment
      SET warranty_expires_at = v_warranty, warranty_notes = coalesce(warranty_notes, v_wnotes)
      WHERE id = v_eq AND warranty_expires_at IS NULL;
    END IF;
  END IF;

  IF s.job_id IS NOT NULL THEN
    INSERT INTO public.job_equipment (job_id, equipment_id, service_type)
    VALUES (s.job_id, v_eq, (SELECT service_type FROM public.jobs WHERE id = s.job_id))
    ON CONFLICT (job_id, equipment_id) DO NOTHING;
  END IF;

  -- The equipment INSERT trigger issued (or joined) the passport. Resolve it; self-heal if it was skipped.
  SELECT l.passport_id, l.verified, l.verified_via, p.public_code
    INTO v_pid, v_verified, v_via, v_code
  FROM public.equipment_passport_links l
  JOIN public.equipment_passports p ON p.id = l.passport_id
  WHERE l.equipment_id = v_eq AND l.status = 'active';

  IF v_pid IS NULL THEN
    BEGIN
      PERFORM public.vp_issue_for_equipment(v_eq);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'nameplate passport issue skipped: %', SQLERRM;
    END;
    SELECT l.passport_id, l.verified, l.verified_via, p.public_code
      INTO v_pid, v_verified, v_via, v_code
    FROM public.equipment_passport_links l
    JOIN public.equipment_passports p ON p.id = l.passport_id
    WHERE l.equipment_id = v_eq AND l.status = 'active';
  END IF;

  IF v_pid IS NOT NULL AND v_verified THEN
    PERFORM public.vp_append_event(
      v_pid, 'inspection', 'Data plate scanned', 'Brand, model and serial were read from the manufacturer data plate.',
      jsonb_strip_nulls(jsonb_build_object(
        'action', 'nameplate_scan',
        'source', 'ocr',
        'manufactured', nullif(p_fields->>'manufacture_date', ''),
        'manufactured_precision', nullif(p_fields->>'manufacture_precision', ''),
        'serial_masked', public.vp_mask_serial(v_serial))),
      now(), p_user, s.job_id, 'nameplate:' || s.id::text, 'network');
  END IF;

  UPDATE public.equipment_nameplate_scans
  SET status = 'created', equipment_id = v_eq, passport_id = v_pid, error = NULL, updated_at = now()
  WHERE id = s.id;

  RETURN jsonb_build_object(
    'equipment_id', v_eq,
    'reused', v_reused,
    'passport', CASE WHEN v_pid IS NULL THEN NULL ELSE jsonb_build_object(
      'code', CASE WHEN v_verified THEN v_code END,
      'verified', coalesce(v_verified, false),
      'joined_existing', v_reused OR coalesce(v_via, '') <> 'issuer') END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.nameplate_create_equipment(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nameplate_create_equipment(uuid, uuid, jsonb) TO service_role;
