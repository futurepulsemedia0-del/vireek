/*
  # Country & Regional Packs (US, CA, GB, EU, AU)

  Additive only: no existing table/column/policy is changed except three nullable
  columns added to consent_records.

  ## New tables (all tenant-scoped: user_id = ACCOUNT OWNER id via get_account_owner_id())
  - regional_pack_enablements : which packs a tenant switched on (+ per-pack settings json)
  - tax_registrations         : the tenant's GST/HST/PST/QST/VAT/ABN registrations
  - regional_custom_closures  : tenant-specific closed/open days layered on the holiday calendars

  ## Changed
  - consent_records.regime / basis / policy_version : which law the consent was collected under

  ## RPCs
  - set_regional_pack(pack, enabled)        : enable/disable a pack (audited)
  - export_customer_personal_data(customer) : GDPR/PIPEDA/CCPA portability bundle (audited)
  - regional_erasure_preview(customer)      : row counts + invoice facts used by the erasure plan

  ## Security
  - Read: any member of the account. Write: owner or can_edit_business_profile
    (public.can_manage_business_locations(), same gate as Locations).
  - Export/erasure helpers are SECURITY DEFINER with a pinned search_path, check ownership
    of the customer, strip secret/internal columns, and write to audit_log.
*/

-- =============================================================
-- PERMISSION HELPER (same rule as Locations)
-- =============================================================
CREATE OR REPLACE FUNCTION public.can_manage_regional_packs()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.can_manage_business_locations(); $$;
GRANT EXECUTE ON FUNCTION public.can_manage_regional_packs() TO authenticated;

CREATE OR REPLACE FUNCTION public.rp_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

-- =============================================================
-- PACK ENABLEMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.regional_pack_enablements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  pack_code text NOT NULL CHECK (pack_code IN ('US', 'CA', 'GB', 'EU', 'AU')),
  enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object' AND pg_column_size(settings) < 8192),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, pack_code)
);
ALTER TABLE public.regional_pack_enablements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rp_enablements_select ON public.regional_pack_enablements;
CREATE POLICY rp_enablements_select ON public.regional_pack_enablements FOR SELECT
  USING (user_id = public.get_account_owner_id());
-- Writes go through set_regional_pack() (SECURITY DEFINER); no direct write policies on purpose.

DROP TRIGGER IF EXISTS trg_rp_enablements_touch ON public.regional_pack_enablements;
CREATE TRIGGER trg_rp_enablements_touch BEFORE UPDATE ON public.regional_pack_enablements
  FOR EACH ROW EXECUTE FUNCTION public.rp_touch_updated_at();

CREATE OR REPLACE FUNCTION public.set_regional_pack(p_pack text, p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_regional_packs() THEN
    RAISE EXCEPTION 'You do not have permission to manage regional packs.' USING ERRCODE = '42501';
  END IF;
  IF p_pack IS NULL OR p_pack NOT IN ('US', 'CA', 'GB', 'EU', 'AU') THEN
    RAISE EXCEPTION 'Unknown regional pack.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.regional_pack_enablements (user_id, pack_code, enabled)
  VALUES (v_owner, p_pack, COALESCE(p_enabled, true))
  ON CONFLICT (user_id, pack_code)
  DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = auth.uid(), updated_at = now();
  PERFORM public.log_audit_event(v_owner, CASE WHEN p_enabled THEN 'regional_pack.enabled' ELSE 'regional_pack.disabled' END,
    'regional_pack_enablements', p_pack, NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_regional_pack(text, boolean) TO authenticated;

-- =============================================================
-- TAX REGISTRATIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.tax_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  scheme text NOT NULL CHECK (scheme IN ('VAT', 'GST_HST', 'QST', 'PST_BC', 'PST_SK', 'RST_MB', 'AU_GST', 'US_SALES_TAX')),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  subdivision text CHECK (subdivision IS NULL OR char_length(subdivision) BETWEEN 2 AND 3),
  registration_number text NOT NULL CHECK (char_length(btrim(registration_number)) BETWEEN 3 AND 40),
  legal_name text CHECK (legal_name IS NULL OR char_length(legal_name) <= 160),
  valid_from date,
  valid_to date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'deregistered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_reg_dates CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  UNIQUE (user_id, scheme, country, registration_number)
);
CREATE INDEX IF NOT EXISTS idx_tax_registrations_user ON public.tax_registrations (user_id, country);
ALTER TABLE public.tax_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rp_taxreg_select ON public.tax_registrations;
CREATE POLICY rp_taxreg_select ON public.tax_registrations FOR SELECT USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS rp_taxreg_insert ON public.tax_registrations;
CREATE POLICY rp_taxreg_insert ON public.tax_registrations FOR INSERT
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs());
DROP POLICY IF EXISTS rp_taxreg_update ON public.tax_registrations;
CREATE POLICY rp_taxreg_update ON public.tax_registrations FOR UPDATE
  USING (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs());
DROP POLICY IF EXISTS rp_taxreg_delete ON public.tax_registrations;
CREATE POLICY rp_taxreg_delete ON public.tax_registrations FOR DELETE
  USING (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs());

DROP TRIGGER IF EXISTS trg_rp_taxreg_touch ON public.tax_registrations;
CREATE TRIGGER trg_rp_taxreg_touch BEFORE UPDATE ON public.tax_registrations
  FOR EACH ROW EXECUTE FUNCTION public.rp_touch_updated_at();

CREATE OR REPLACE FUNCTION public.rp_audit_tax_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.tax_registrations;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  PERFORM public.log_audit_event(r.user_id, 'tax_registration.' || lower(TG_OP), 'tax_registrations', r.id::text,
    jsonb_build_object('scheme', r.scheme, 'country', r.country, 'status', r.status));
  RETURN r;
END;
$$;
DROP TRIGGER IF EXISTS trg_rp_taxreg_audit ON public.tax_registrations;
CREATE TRIGGER trg_rp_taxreg_audit AFTER INSERT OR UPDATE OR DELETE ON public.tax_registrations
  FOR EACH ROW EXECUTE FUNCTION public.rp_audit_tax_registration();

-- =============================================================
-- CUSTOM CLOSURES (layered on holiday calendars)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.regional_custom_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  closure_date date NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  closed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, country, closure_date)
);
ALTER TABLE public.regional_custom_closures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rp_closures_select ON public.regional_custom_closures;
CREATE POLICY rp_closures_select ON public.regional_custom_closures FOR SELECT USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS rp_closures_insert ON public.regional_custom_closures;
CREATE POLICY rp_closures_insert ON public.regional_custom_closures FOR INSERT
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs());
DROP POLICY IF EXISTS rp_closures_update ON public.regional_custom_closures;
CREATE POLICY rp_closures_update ON public.regional_custom_closures FOR UPDATE
  USING (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs());
DROP POLICY IF EXISTS rp_closures_delete ON public.regional_custom_closures;
CREATE POLICY rp_closures_delete ON public.regional_custom_closures FOR DELETE
  USING (user_id = public.get_account_owner_id() AND public.can_manage_regional_packs());

-- =============================================================
-- CONSENT EVIDENCE: which law, which basis, which policy text
-- =============================================================
ALTER TABLE public.consent_records
  ADD COLUMN IF NOT EXISTS regime text,
  ADD COLUMN IF NOT EXISTS basis text,
  ADD COLUMN IF NOT EXISTS policy_version text;

-- =============================================================
-- PORTABILITY + ERASURE HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.rp_scrub_row(j jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(j) = 'object' THEN j ELSE '{}'::jsonb END) AS e
  WHERE e.key !~* '(token|secret|password|api_key|internal|margin|cost|profit|stripe_|hash)';
$$;

CREATE OR REPLACE FUNCTION public.rp_customer_rows(p_table text, p_customer uuid, p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  IF to_regclass('public.' || quote_ident(p_table)) IS NULL THEN RETURN '[]'::jsonb; END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = p_table AND column_name IN ('customer_id', 'user_id')) < 2
  THEN RETURN '[]'::jsonb; END IF;
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(public.rp_scrub_row(to_jsonb(t))), ''[]''::jsonb) FROM (SELECT * FROM public.%I WHERE customer_id = $1 AND user_id = $2 LIMIT 5000) t',
    p_table) INTO v USING p_customer, p_owner;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.rp_customer_rows(text, uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rp_assert_customer(p_customer uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_regional_packs() THEN
    RAISE EXCEPTION 'You do not have permission to handle personal-data requests.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer AND c.user_id = v_owner) THEN
    RAISE EXCEPTION 'Customer not found.' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_owner;
END;
$$;
REVOKE ALL ON FUNCTION public.rp_assert_customer(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.export_customer_personal_data(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.rp_assert_customer(p_customer_id);
  v_sections jsonb;
BEGIN
  v_sections := jsonb_build_object(
    'customer', (SELECT COALESCE(jsonb_agg(public.rp_scrub_row(to_jsonb(c))), '[]'::jsonb)
                   FROM public.customers c WHERE c.id = p_customer_id AND c.user_id = v_owner),
    'jobs', public.rp_customer_rows('jobs', p_customer_id, v_owner),
    'calls', public.rp_customer_rows('calls', p_customer_id, v_owner),
    'leads', public.rp_customer_rows('leads', p_customer_id, v_owner),
    'quotes', public.rp_customer_rows('quotes', p_customer_id, v_owner),
    'consents', public.rp_customer_rows('consent_records', p_customer_id, v_owner),
    'communication_preferences', public.rp_customer_rows('customer_communication_preferences', p_customer_id, v_owner)
  );
  PERFORM public.log_audit_event(v_owner, 'privacy.portability_export', 'customers', p_customer_id::text, NULL);
  RETURN jsonb_build_object(
    'schema', 'vireek.portability.v1',
    'generated_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'subject', jsonb_build_object('customer_id', p_customer_id),
    'sections', v_sections
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.export_customer_personal_data(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.regional_erasure_preview(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.rp_assert_customer(p_customer_id);
  v_counts jsonb := '{}'::jsonb;
  v_t text;
  v_n integer;
  v_invoiced integer := 0;
  v_last date;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['jobs', 'calls', 'leads', 'quotes', 'consent_records'] LOOP
    v_n := jsonb_array_length(public.rp_customer_rows(v_t, p_customer_id, v_owner));
    v_counts := v_counts || jsonb_build_object(v_t, v_n);
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'invoice_amount')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'created_at') THEN
    EXECUTE 'SELECT count(*)::int, max(created_at)::date FROM public.jobs WHERE customer_id = $1 AND user_id = $2 AND invoice_amount IS NOT NULL'
      INTO v_invoiced, v_last USING p_customer_id, v_owner;
  END IF;

  RETURN jsonb_build_object('counts', v_counts, 'invoiced_jobs', COALESCE(v_invoiced, 0), 'last_invoice_on', v_last);
END;
$$;
GRANT EXECUTE ON FUNCTION public.regional_erasure_preview(uuid) TO authenticated;
