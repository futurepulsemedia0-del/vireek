/*
  # Pesticide usage reports (regulatory reporting on top of the Pest Control trade pack)

  ## Why
  The Pest Control pack already records every chemical application in the append-only
  `trade_log_entries` ledger. Regulators (state lead agencies, restricted-use programs,
  auditors) ask for a PERIOD REPORT of that ledger, not individual rows. This adds:

  - `pesticide_usage_report(from, to, restricted_only)`  -> live report (read-only, RLS-scoped)
  - `pesticide_usage_reports`                           -> immutable, hash-sealed snapshots of a report
  - `finalize_pesticide_usage_report(...)`              -> builds + seals a snapshot (owner/admin)
  - `mark_pesticide_usage_report_filed(id, reference)`  -> records that it was submitted (once)
  - `verify_pesticide_usage_report(id)`                 -> re-hashes a snapshot (tamper check)

  ## Safety
  - No existing table is altered. Fully idempotent (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS).
  - Reads only non-voided `chemical_application` rows of the caller's ACCOUNT OWNER.
  - Snapshots can never be edited or deleted; only `filed_at` + `filing_reference` may be set once.
  - Records support, but never replace, local regulation: report formats differ per jurisdiction.

  ## Depends on
  20271201000000_trade_packs.sql (trade_log_entries, can_manage_trade_packs),
  20270410000000 (is_account_owner), audit log (log_audit_event), get_account_owner_id().
*/

-- =============================================================
-- 1. LIVE REPORT (SECURITY INVOKER: RLS on trade_log_entries still applies)
-- =============================================================

CREATE OR REPLACE FUNCTION public.pesticide_usage_report(
  p_from timestamptz,
  p_to timestamptz,
  p_restricted_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cap constant integer := 5000;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'invalid_period: choose a start date before the end date' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > interval '1100 days' THEN
    RAISE EXCEPTION 'invalid_period: a report can cover at most 3 years' USING ERRCODE = '22023';
  END IF;

  WITH scoped AS (
    SELECT
      e.id,
      e.performed_at,
      e.job_id,
      e.customer_id,
      e.site_address,
      e.technician_id,
      e.technician_name,
      e.credential_type,
      e.credential_number,
      e.product_id,
      e.product_name,
      e.product_epa_reg,
      COALESCE(e.product_restricted, false) AS product_restricted,
      e.reentry_until,
      e.voided_at,
      e.data,
      e.notes,
      CASE WHEN jsonb_typeof(e.data -> 'amount') = 'number' THEN (e.data ->> 'amount')::numeric END AS amount,
      e.data ->> 'amount_unit' AS amount_unit,
      CASE WHEN jsonb_typeof(e.data -> 'area_sqft') = 'number' THEN (e.data ->> 'area_sqft')::numeric END AS area_sqft
    FROM trade_log_entries e
    WHERE e.user_id = v_owner
      AND e.pack_key = 'pest_control'
      AND e.entry_type = 'chemical_application'
      AND e.performed_at >= p_from
      AND e.performed_at < p_to
      AND (NOT p_restricted_only OR COALESCE(e.product_restricted, false))
  ),
  live AS (
    SELECT * FROM scoped WHERE voided_at IS NULL
  ),
  capped AS (
    SELECT * FROM live ORDER BY performed_at, id LIMIT v_cap
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'period_from', p_from,
    'period_to', p_to,
    'restricted_only', p_restricted_only,
    'entry_count', (SELECT count(*) FROM live),
    'voided_count', (SELECT count(*) FROM scoped WHERE voided_at IS NOT NULL),
    'truncated', (SELECT count(*) FROM live) > v_cap,
    'totals', jsonb_build_object(
      'restricted_applications', (SELECT count(*) FROM live WHERE product_restricted),
      'distinct_products', (SELECT count(DISTINCT product_id) FROM live),
      'distinct_applicators', (SELECT count(DISTINCT technician_id) FROM live),
      'distinct_sites', (SELECT count(DISTINCT site_address) FROM live WHERE site_address IS NOT NULL),
      'missing_licence', (SELECT count(*) FROM live WHERE credential_number IS NULL),
      'missing_area', (SELECT count(*) FROM live WHERE area_sqft IS NULL),
      'missing_epa_reg', (SELECT count(*) FROM live WHERE product_epa_reg IS NULL),
      'ppe_not_confirmed', (SELECT count(*) FROM live WHERE (data ->> 'ppe_used') = 'false'),
      'customer_not_notified', (SELECT count(*) FROM live WHERE (data ->> 'customer_notified') = 'false')
    ),
    'by_product', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.product_restricted DESC, p.product_name, p.amount_unit)
      FROM (
        SELECT
          product_id,
          COALESCE(product_name, 'Unknown product') AS product_name,
          product_epa_reg,
          product_restricted,
          amount_unit,
          count(*) AS applications,
          COALESCE(sum(amount), 0) AS total_amount,
          COALESCE(sum(area_sqft), 0) AS total_area_sqft,
          count(DISTINCT job_id) AS jobs,
          min(performed_at) AS first_at,
          max(performed_at) AS last_at
        FROM live
        GROUP BY product_id, product_name, product_epa_reg, product_restricted, amount_unit
      ) p
    ), '[]'::jsonb),
    'by_applicator', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.technician_name, a.credential_number)
      FROM (
        SELECT
          technician_id,
          COALESCE(technician_name, 'Unknown technician') AS technician_name,
          credential_type,
          credential_number,
          count(*) AS applications,
          count(*) FILTER (WHERE product_restricted) AS restricted_applications,
          count(DISTINCT product_id) AS products,
          min(performed_at) AS first_at,
          max(performed_at) AS last_at
        FROM live
        GROUP BY technician_id, technician_name, credential_type, credential_number
      ) a
    ), '[]'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.performed_at, c.id)
      FROM capped c
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION public.pesticide_usage_report(timestamptz, timestamptz, boolean) TO authenticated;

-- =============================================================
-- 2. SEALED SNAPSHOTS
-- =============================================================

CREATE TABLE IF NOT EXISTS pesticide_usage_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  restricted_only boolean NOT NULL DEFAULT false,
  jurisdiction text CHECK (jurisdiction IS NULL OR char_length(jurisdiction) <= 120),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  voided_count integer NOT NULL DEFAULT 0 CHECK (voided_count >= 0),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  prepared_by uuid DEFAULT auth.uid(),
  prepared_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  filed_at timestamptz,
  filing_reference text CHECK (filing_reference IS NULL OR char_length(filing_reference) <= 120),
  CONSTRAINT pesticide_usage_reports_period CHECK (period_to > period_from),
  CONSTRAINT pesticide_usage_reports_filed_pair CHECK (
    (filed_at IS NULL AND filing_reference IS NULL)
    OR (filed_at IS NOT NULL AND char_length(btrim(COALESCE(filing_reference, ''))) >= 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_pesticide_usage_reports_user
  ON pesticide_usage_reports (user_id, created_at DESC);

ALTER TABLE pesticide_usage_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_pesticide_usage_reports" ON pesticide_usage_reports;
CREATE POLICY "select_pesticide_usage_reports" ON pesticide_usage_reports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Intentionally NO insert / update / delete policies: writes go through the RPCs below only.

CREATE OR REPLACE FUNCTION public.pesticide_usage_report_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pesticide usage reports cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.user_id, NEW.period_from, NEW.period_to, NEW.restricted_only, NEW.jurisdiction, NEW.note,
      NEW.entry_count, NEW.voided_count, NEW.report, NEW.content_hash, NEW.prepared_by, NEW.prepared_by_email, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.user_id, OLD.period_from, OLD.period_to, OLD.restricted_only, OLD.jurisdiction, OLD.note,
      OLD.entry_count, OLD.voided_count, OLD.report, OLD.content_hash, OLD.prepared_by, OLD.prepared_by_email, OLD.created_at)
  THEN
    RAISE EXCEPTION 'pesticide usage reports are sealed and cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF OLD.filed_at IS NOT NULL
     AND (NEW.filed_at, NEW.filing_reference) IS DISTINCT FROM (OLD.filed_at, OLD.filing_reference)
  THEN
    RAISE EXCEPTION 'this report is already marked as filed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pesticide_usage_report_guard ON pesticide_usage_reports;
CREATE TRIGGER trg_pesticide_usage_report_guard BEFORE UPDATE OR DELETE ON pesticide_usage_reports
  FOR EACH ROW EXECUTE FUNCTION public.pesticide_usage_report_guard();

-- =============================================================
-- 3. FINALIZE (seal) / MARK FILED / VERIFY
-- =============================================================

CREATE OR REPLACE FUNCTION public.finalize_pesticide_usage_report(
  p_from timestamptz,
  p_to timestamptz,
  p_restricted_only boolean DEFAULT false,
  p_jurisdiction text DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_report jsonb;
  v_id uuid;
  v_email text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_pack_installs WHERE user_id = v_owner AND pack_key = 'pest_control') THEN
    RAISE EXCEPTION 'pack_not_installed' USING ERRCODE = 'P0002';
  END IF;

  v_report := public.pesticide_usage_report(p_from, p_to, COALESCE(p_restricted_only, false));
  IF COALESCE((v_report ->> 'truncated')::boolean, false) THEN
    RAISE EXCEPTION 'invalid_period: too many applications in this period to seal in one report; choose a shorter period' USING ERRCODE = '22023';
  END IF;
  IF (v_report ->> 'entry_count')::integer = 0 THEN
    RAISE EXCEPTION 'invalid_period: there are no applications in this period' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();

  INSERT INTO pesticide_usage_reports (
    user_id, period_from, period_to, restricted_only, jurisdiction, note,
    entry_count, voided_count, report, content_hash, prepared_by, prepared_by_email
  )
  VALUES (
    v_owner, p_from, p_to, COALESCE(p_restricted_only, false),
    NULLIF(left(btrim(COALESCE(p_jurisdiction, '')), 120), ''),
    NULLIF(left(btrim(COALESCE(p_note, '')), 1000), ''),
    (v_report ->> 'entry_count')::integer,
    (v_report ->> 'voided_count')::integer,
    v_report,
    encode(sha256(convert_to(v_report::text, 'UTF8')), 'hex'),
    auth.uid(), v_email
  )
  RETURNING id INTO v_id;

  PERFORM public.log_audit_event(v_owner, 'pesticide_report.finalize', 'pesticide_usage_reports', v_id::text);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_pesticide_usage_report(timestamptz, timestamptz, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_pesticide_usage_report(timestamptz, timestamptz, boolean, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_pesticide_usage_report_filed(p_id uuid, p_reference text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_ref text := left(btrim(COALESCE(p_reference, '')), 120);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_ref = '' THEN
    RAISE EXCEPTION 'invalid_reference: enter the confirmation or filing number' USING ERRCODE = '22023';
  END IF;

  UPDATE pesticide_usage_reports
  SET filed_at = now(), filing_reference = v_ref
  WHERE id = p_id AND user_id = v_owner AND filed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found or already marked as filed' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'pesticide_report.filed', 'pesticide_usage_reports', p_id::text);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_pesticide_usage_report_filed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_pesticide_usage_report_filed(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.verify_pesticide_usage_report(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT r.report, r.content_hash INTO v_row
  FROM pesticide_usage_reports r
  WHERE r.id = p_id AND r.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN encode(sha256(convert_to(v_row.report::text, 'UTF8')), 'hex') = v_row.content_hash;
END;
$$;
GRANT EXECUTE ON FUNCTION public.verify_pesticide_usage_report(uuid) TO authenticated;
