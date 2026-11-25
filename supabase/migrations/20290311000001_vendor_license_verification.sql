/*
  # Subcontractor licence verification (manual workflow) + shared compliance settings

  Extends Vendor Management (vendors / vendor_documents). The technician-only Verification
  Network (verification_checks) is NOT touched.

  Adds (all additive, idempotent):
    - vendor_compliance_settings : one row per account (COI enforcement, licence re-check cadence)
    - vendor_compliance_alerts   : de-duplication log for expiry notifications (service role only)
    - vendor_license_checks      : append-only evidence log (number, state, status, expiry, source URL,
                                   checked-by / checked-at)
    - vendor_license_current     : latest check per vendor + licence, with expiry applied at READ time
    - record_vendor_license_check(), get/save_vendor_compliance_settings()

  Security: reads need account-owner scope + manager; writes only through SECURITY DEFINER RPCs.
  Requires: public.get_account_owner_id(), public.identity_is_manager(), vendors(user_id).
*/

-- 1) Settings ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_compliance_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  coi_enforcement text NOT NULL DEFAULT 'off' CHECK (coi_enforcement IN ('off', 'block')),
  coi_required_coverages text[] NOT NULL DEFAULT ARRAY['general_liability', 'workers_comp']::text[],
  coi_grace_days integer NOT NULL DEFAULT 0 CHECK (coi_grace_days BETWEEN 0 AND 30),
  -- NULL = no minimum enforced. No default is invented: the owner / their broker decides.
  coi_min_general_liability_cents bigint CHECK (coi_min_general_liability_cents IS NULL OR coi_min_general_liability_cents >= 0),
  license_recheck_days integer CHECK (license_recheck_days IS NULL OR license_recheck_days BETWEEN 7 AND 730),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vcs_coverages_known CHECK (
    coi_required_coverages <@ ARRAY['general_liability', 'workers_comp', 'commercial_auto', 'umbrella']::text[]
  )
);

ALTER TABLE public.vendor_compliance_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vcs_select" ON public.vendor_compliance_settings;
CREATE POLICY "vcs_select" ON public.vendor_compliance_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE INSERT, UPDATE, DELETE ON public.vendor_compliance_settings FROM anon, authenticated;

-- 2) Alert de-duplication log (no client access) ------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_compliance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('license', 'coi', 'license_recheck')),
  item_id uuid NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('d30', 'd14', 'd7', 'expired', 'due')),
  due_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vca_unique UNIQUE (item_kind, item_id, bucket, due_on)
);
ALTER TABLE public.vendor_compliance_alerts ENABLE ROW LEVEL SECURITY;   -- no policies on purpose
REVOKE ALL ON public.vendor_compliance_alerts FROM anon, authenticated;

-- 3) Licence checks (append-only evidence) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_license_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  license_number text NOT NULL CHECK (char_length(btrim(license_number)) BETWEEN 1 AND 64),
  license_key text GENERATED ALWAYS AS (upper(regexp_replace(license_number, '[^A-Za-z0-9]', '', 'g'))) STORED,
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^US-[A-Z]{2}$'),
  trade text CHECK (trade IS NULL OR char_length(trade) <= 80),
  holder_name text CHECK (holder_name IS NULL OR char_length(holder_name) <= 200),
  license_status text NOT NULL CHECK (license_status IN ('active', 'inactive', 'expired', 'suspended', 'revoked', 'unknown')),
  expires_on date,
  source_url text CHECK (source_url IS NULL OR (source_url ~* '^https://[^[:space:]]+$' AND char_length(source_url) <= 500)),
  method text NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'primary_source_api')),
  source_key text CHECK (source_key IS NULL OR source_key ~ '^[a-z0-9_]{3,64}$'),
  checked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  next_check_at date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- An "active" result without evidence is just an opinion: a source link is mandatory.
  CONSTRAINT vlc_active_has_source CHECK (license_status <> 'active' OR source_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_vlc_vendor ON public.vendor_license_checks(vendor_id, jurisdiction, license_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_vlc_user_expiry ON public.vendor_license_checks(user_id, expires_on) WHERE expires_on IS NOT NULL;

CREATE OR REPLACE FUNCTION public.vlc_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'licence checks are append-only evidence' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_vlc_immutable ON public.vendor_license_checks;
CREATE TRIGGER trg_vlc_immutable BEFORE UPDATE ON public.vendor_license_checks
  FOR EACH ROW EXECUTE FUNCTION public.vlc_immutable();

ALTER TABLE public.vendor_license_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vlc_select" ON public.vendor_license_checks;
CREATE POLICY "vlc_select" ON public.vendor_license_checks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE INSERT, UPDATE, DELETE ON public.vendor_license_checks FROM anon, authenticated;

-- Latest check per vendor + licence. "Active" is downgraded to "expired" at READ time so a
-- stale "verified" can never outlive the licence itself.
CREATE OR REPLACE VIEW public.vendor_license_current WITH (security_invoker = true) AS
  SELECT DISTINCT ON (c.vendor_id, c.jurisdiction, c.license_key)
         c.*,
         CASE WHEN c.license_status = 'active' AND c.expires_on IS NOT NULL AND c.expires_on < current_date
              THEN 'expired' ELSE c.license_status END AS effective_status
    FROM public.vendor_license_checks c
   ORDER BY c.vendor_id, c.jurisdiction, c.license_key, c.checked_at DESC, c.id DESC;
GRANT SELECT ON public.vendor_license_current TO authenticated;

-- 4) RPC: record a manual verification -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_vendor_license_check(
  p_vendor_id uuid,
  p_license_number text,
  p_jurisdiction text,
  p_status text,
  p_expires_on date DEFAULT NULL,
  p_source_url text DEFAULT NULL,
  p_holder_name text DEFAULT NULL,
  p_trade text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer;
  v_url text := NULLIF(btrim(COALESCE(p_source_url, '')), '');
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = p_vendor_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;
  IF p_status = 'active' AND v_url IS NULL THEN RAISE EXCEPTION 'SOURCE_URL_REQUIRED'; END IF;
  IF p_expires_on IS NOT NULL AND p_expires_on > current_date + interval '20 years' THEN
    RAISE EXCEPTION 'INVALID_EXPIRY';
  END IF;

  SELECT license_recheck_days INTO v_days FROM vendor_compliance_settings WHERE user_id = v_owner;

  INSERT INTO vendor_license_checks (
    user_id, vendor_id, license_number, jurisdiction, trade, holder_name, license_status,
    expires_on, source_url, method, checked_by, next_check_at, notes
  ) VALUES (
    v_owner, p_vendor_id, btrim(p_license_number), upper(btrim(p_jurisdiction)),
    NULLIF(btrim(COALESCE(p_trade, '')), ''), NULLIF(btrim(COALESCE(p_holder_name, '')), ''), p_status,
    p_expires_on, v_url, 'manual', auth.uid(),
    CASE WHEN v_days IS NULL THEN NULL ELSE current_date + v_days END,
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  ) RETURNING id INTO v_id;   -- CHECK constraints reject malformed number / state / status / URL

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_vendor_license_check(uuid, text, text, text, date, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_vendor_license_check(uuid, text, text, text, date, text, text, text, text) TO authenticated;

-- 5) RPC: settings -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_vendor_compliance_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s vendor_compliance_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.identity_is_manager() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO s FROM vendor_compliance_settings WHERE user_id = v_owner;
  IF NOT FOUND THEN
    s.coi_enforcement := 'off';
    s.coi_required_coverages := ARRAY['general_liability', 'workers_comp']::text[];
    s.coi_grace_days := 0;
  END IF;
  RETURN jsonb_build_object(
    'coi_enforcement', s.coi_enforcement,
    'coi_required_coverages', to_jsonb(s.coi_required_coverages),
    'coi_grace_days', s.coi_grace_days,
    'coi_min_general_liability_cents', s.coi_min_general_liability_cents,
    'license_recheck_days', s.license_recheck_days
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_vendor_compliance_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vendor_compliance_settings() TO authenticated;

-- Only owner / admin may change enforcement (a billing-permission manager may read, not switch).
CREATE OR REPLACE FUNCTION public.save_vendor_compliance_settings(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cov text[];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF p ? 'coi_required_coverages' THEN
    IF jsonb_typeof(p -> 'coi_required_coverages') <> 'array' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    SELECT COALESCE(array_agg(DISTINCT x), '{}'::text[]) INTO v_cov
      FROM jsonb_array_elements_text(p -> 'coi_required_coverages') AS t(x);
  END IF;

  INSERT INTO vendor_compliance_settings (user_id) VALUES (v_owner) ON CONFLICT (user_id) DO NOTHING;

  UPDATE vendor_compliance_settings SET
    coi_enforcement = CASE WHEN p ? 'coi_enforcement' THEN p ->> 'coi_enforcement' ELSE coi_enforcement END,
    coi_required_coverages = CASE WHEN p ? 'coi_required_coverages' THEN v_cov ELSE coi_required_coverages END,
    coi_grace_days = CASE WHEN p ? 'coi_grace_days' THEN (p ->> 'coi_grace_days')::integer ELSE coi_grace_days END,
    coi_min_general_liability_cents = CASE WHEN p ? 'coi_min_general_liability_cents'
        THEN (p ->> 'coi_min_general_liability_cents')::bigint ELSE coi_min_general_liability_cents END,
    license_recheck_days = CASE WHEN p ? 'license_recheck_days'
        THEN (p ->> 'license_recheck_days')::integer ELSE license_recheck_days END,
    updated_at = now()
  WHERE user_id = v_owner;   -- CHECK constraints reject out-of-range / unknown values
END;
$$;
REVOKE ALL ON FUNCTION public.save_vendor_compliance_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_vendor_compliance_settings(jsonb) TO authenticated;
