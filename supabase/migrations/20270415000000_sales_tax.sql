/*
  # Sales tax for quotes & invoices

  - tax_rates              shared reference rows (user_id NULL) + the account's own
                           rows; lookup_tax_rates() resolves a service address to
                           rate components (state / county / city / district)
  - tax_settings           per-account: which states the business collects in
  - tax_classes            per-service tax classes (labor, materials, ...) with
    tax_class_state_rules  per-state taxable / non-taxable overrides
  - tax_exemptions         customer exemption certificates (+ private storage bucket)
  - quotes / invoices      get a tax SNAPSHOT (breakdown lines, cents, exemption ref)
                           so a document never changes when rates change later.
                           tax_percent stays populated as the EFFECTIVE rate
                           (tax_cents / subtotal) so every existing total
                           calculation keeps producing exactly the same cents.
  - tax_report_*           period reports (accrual or cash basis) + exempt-sales audit

  Reference state rates are a starting point and are NOT guaranteed current.
  Local (county / city / district) rates must be added or imported per account.

  ## Deploy order
    1. Run this migration.
    2. Apply the front-end edits delivered alongside it.
*/

-- =============================================================
-- 0. Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 1. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS tax_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  collect_in_states text[] NOT NULL DEFAULT '{}',
  rate_stale_after_days integer NOT NULL DEFAULT 180 CHECK (rate_stale_after_days BETWEEN 30 AND 730),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid DEFAULT public.get_account_owner_id(),          -- NULL = shared reference row
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  county text,
  city text,
  postal_code text CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}$'),
  jurisdiction_level text NOT NULL CHECK (jurisdiction_level IN ('state', 'county', 'city', 'district')),
  jurisdiction_name text NOT NULL CHECK (length(trim(jurisdiction_name)) > 0),
  rate_percent numeric(7, 4) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 25),
  effective_from date NOT NULL DEFAULT DATE '2000-01-01',
  effective_to date,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('reference', 'manual', 'import', 'provider')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_rates_unique ON tax_rates (
  COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  state, jurisdiction_level, lower(jurisdiction_name),
  COALESCE(lower(county), ''), COALESCE(lower(city), ''), COALESCE(postal_code, ''),
  effective_from
);
CREATE INDEX IF NOT EXISTS idx_tax_rates_lookup ON tax_rates (state, postal_code);
CREATE INDEX IF NOT EXISTS idx_tax_rates_user ON tax_rates (user_id);

CREATE TABLE IF NOT EXISTS tax_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  default_taxable boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);

CREATE TABLE IF NOT EXISTS tax_class_state_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  tax_class_id uuid NOT NULL REFERENCES tax_classes(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  taxable boolean NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_class_id, state)
);

CREATE TABLE IF NOT EXISTS tax_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exemption_type text NOT NULL
    CHECK (exemption_type IN ('resale', 'government', 'nonprofit', 'agricultural', 'manufacturing', 'religious', 'other')),
  certificate_number text,
  issuing_state text CHECK (issuing_state IS NULL OR issuing_state ~ '^[A-Z]{2}$'),
  applies_to_states text[] NOT NULL DEFAULT '{}',     -- empty = every state
  applies_to_classes text[] NOT NULL DEFAULT '{}',    -- empty = every tax class
  issued_on date,
  expires_on date,
  certificate_path text,
  certificate_file_name text,
  certificate_mime text,
  certificate_size_bytes integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'revoked')),
  verified_at timestamptz,
  verified_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CHECK (status <> 'verified' OR certificate_path IS NOT NULL OR certificate_number IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tax_exemptions_customer ON tax_exemptions (customer_id);
CREATE INDEX IF NOT EXISTS idx_tax_exemptions_user_status ON tax_exemptions (user_id, status, expires_on);

-- Stamp who verified a certificate, and when (kept as history after revoke).
CREATE OR REPLACE FUNCTION public.stamp_tax_exemption_verification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'verified' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'verified') THEN
    NEW.verified_at := now();
    NEW.verified_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_tax_exemption_verification ON tax_exemptions;
CREATE TRIGGER trg_stamp_tax_exemption_verification
  BEFORE INSERT OR UPDATE ON tax_exemptions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_tax_exemption_verification();

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_settings', 'tax_rates', 'tax_classes', 'tax_class_state_rules', 'tax_exemptions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- =============================================================
-- 2. RLS — everything scoped to the account owner
-- =============================================================
DO $$
DECLARE
  t text;
  extra text;
BEGIN
  FOR t, extra IN
    SELECT * FROM (VALUES
      ('tax_settings', 'true'),
      ('tax_classes', 'true'),
      ('tax_class_state_rules', 'EXISTS (SELECT 1 FROM tax_classes c WHERE c.id = tax_class_id)'),
      ('tax_exemptions', 'EXISTS (SELECT 1 FROM customers c WHERE c.id = customer_id)')
    ) AS v(tbl, chk)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "select_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "select_own_%1$s" ON %1$I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS "insert_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "insert_own_%1$s" ON %1$I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND %2$s)', t, extra);
    EXECUTE format('DROP POLICY IF EXISTS "update_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "update_own_%1$s" ON %1$I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id() AND %2$s)', t, extra);
    EXECUTE format('DROP POLICY IF EXISTS "delete_own_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "delete_own_%1$s" ON %1$I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id())', t);
  END LOOP;
END $$;

-- tax_rates: shared reference rows are readable by everyone signed in,
-- but only the account's own rows can be written.
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_tax_rates" ON tax_rates;
CREATE POLICY "select_tax_rates" ON tax_rates FOR SELECT TO authenticated
  USING (user_id IS NULL OR user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_tax_rates" ON tax_rates;
CREATE POLICY "insert_own_tax_rates" ON tax_rates FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_tax_rates" ON tax_rates;
CREATE POLICY "update_own_tax_rates" ON tax_rates FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_tax_rates" ON tax_rates;
CREATE POLICY "delete_own_tax_rates" ON tax_rates FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 3. Reference state-level rates (starting point — verify before relying on them)
-- =============================================================
INSERT INTO tax_rates (user_id, state, jurisdiction_level, jurisdiction_name, rate_percent, source)
SELECT NULL, v.code, 'state', v.name || ' state sales tax', v.rate, 'reference'
FROM (VALUES
  ('AL', 'Alabama', 4.0), ('AK', 'Alaska', 0), ('AZ', 'Arizona', 5.6), ('AR', 'Arkansas', 6.5),
  ('CA', 'California', 7.25), ('CO', 'Colorado', 2.9), ('CT', 'Connecticut', 6.35), ('DE', 'Delaware', 0),
  ('DC', 'District of Columbia', 6.0), ('FL', 'Florida', 6.0), ('GA', 'Georgia', 4.0), ('HI', 'Hawaii', 4.0),
  ('ID', 'Idaho', 6.0), ('IL', 'Illinois', 6.25), ('IN', 'Indiana', 7.0), ('IA', 'Iowa', 6.0),
  ('KS', 'Kansas', 6.5), ('KY', 'Kentucky', 6.0), ('LA', 'Louisiana', 5.0), ('ME', 'Maine', 5.5),
  ('MD', 'Maryland', 6.0), ('MA', 'Massachusetts', 6.25), ('MI', 'Michigan', 6.0), ('MN', 'Minnesota', 6.875),
  ('MS', 'Mississippi', 7.0), ('MO', 'Missouri', 4.225), ('MT', 'Montana', 0), ('NE', 'Nebraska', 5.5),
  ('NV', 'Nevada', 6.85), ('NH', 'New Hampshire', 0), ('NJ', 'New Jersey', 6.625), ('NM', 'New Mexico', 4.875),
  ('NY', 'New York', 4.0), ('NC', 'North Carolina', 4.75), ('ND', 'North Dakota', 5.0), ('OH', 'Ohio', 5.75),
  ('OK', 'Oklahoma', 4.5), ('OR', 'Oregon', 0), ('PA', 'Pennsylvania', 6.0), ('RI', 'Rhode Island', 7.0),
  ('SC', 'South Carolina', 6.0), ('SD', 'South Dakota', 4.2), ('TN', 'Tennessee', 7.0), ('TX', 'Texas', 6.25),
  ('UT', 'Utah', 6.1), ('VT', 'Vermont', 6.0), ('VA', 'Virginia', 5.3), ('WA', 'Washington', 6.5),
  ('WV', 'West Virginia', 6.0), ('WI', 'Wisconsin', 5.0), ('WY', 'Wyoming', 4.0)
) AS v(code, name, rate)
ON CONFLICT DO NOTHING;

-- =============================================================
-- 4. Rate lookup by service address
--    Per jurisdiction level, the account's own rows win over shared reference rows.
--    Every matching row is a separate tax component (rows are summed).
-- =============================================================
CREATE OR REPLACE FUNCTION public.lookup_tax_rates(
  p_state text,
  p_postal_code text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_county text DEFAULT NULL,
  p_on_date date DEFAULT current_date
)
RETURNS TABLE (
  rate_id uuid,
  jurisdiction_level text,
  jurisdiction_name text,
  rate_percent numeric,
  source text,
  is_account_rate boolean,
  verified_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH matched AS (
    SELECT r.*, (r.user_id IS NOT NULL) AS own
    FROM tax_rates r
    WHERE r.state = upper(trim(p_state))
      AND (r.postal_code IS NULL OR r.postal_code = left(regexp_replace(coalesce(p_postal_code, ''), '[^0-9]', '', 'g'), 5))
      AND (r.city IS NULL OR lower(r.city) = lower(trim(coalesce(p_city, ''))))
      AND (r.county IS NULL OR lower(r.county) = lower(trim(coalesce(p_county, ''))))
      AND r.effective_from <= p_on_date
      AND (r.effective_to IS NULL OR r.effective_to >= p_on_date)
  ), tiers AS (
    SELECT m.*, bool_or(m.own) OVER (PARTITION BY m.jurisdiction_level) AS level_has_own
    FROM matched m
  )
  SELECT t.id, t.jurisdiction_level, t.jurisdiction_name, t.rate_percent, t.source, t.own, t.verified_at, t.updated_at
  FROM tiers t
  WHERE t.own OR NOT t.level_has_own
  ORDER BY CASE t.jurisdiction_level WHEN 'state' THEN 1 WHEN 'county' THEN 2 WHEN 'city' THEN 3 ELSE 4 END,
           t.jurisdiction_name;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_tax_rates(text, text, text, text, date) TO authenticated;

-- Bulk import / upsert of the account's own rates (CSV import in the UI).
CREATE OR REPLACE FUNCTION public.import_tax_rates(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'Import at most 5000 rows at a time';
  END IF;

  WITH src AS (
    SELECT DISTINCT ON (st, lvl, lower(jname), coalesce(lower(county), ''), coalesce(lower(city), ''), coalesce(zip, ''), eff)
      st, county, city, zip, lvl, jname, rate, eff
    FROM (
      SELECT
        upper(trim(r->>'state')) AS st,
        nullif(trim(r->>'county'), '') AS county,
        nullif(trim(r->>'city'), '') AS city,
        nullif(trim(r->>'postal_code'), '') AS zip,
        lower(trim(r->>'jurisdiction_level')) AS lvl,
        trim(r->>'jurisdiction_name') AS jname,
        (r->>'rate_percent')::numeric AS rate,
        coalesce(nullif(r->>'effective_from', '')::date, DATE '2000-01-01') AS eff
      FROM jsonb_array_elements(p_rows) AS r
    ) parsed
  ), ins AS (
    INSERT INTO tax_rates (state, county, city, postal_code, jurisdiction_level, jurisdiction_name, rate_percent, effective_from, source, verified_at)
    SELECT st, county, city, zip, lvl, jname, rate, eff, 'import', now() FROM src
    ON CONFLICT (
      COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
      state, jurisdiction_level, lower(jurisdiction_name),
      COALESCE(lower(county), ''), COALESCE(lower(city), ''), COALESCE(postal_code, ''),
      effective_from
    )
    DO UPDATE SET rate_percent = EXCLUDED.rate_percent, source = 'import', verified_at = now(), updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_tax_rates(jsonb) TO authenticated;

-- Default classes for a brand-new account (no-op once any class exists).
CREATE OR REPLACE FUNCTION public.ensure_default_tax_classes()
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO tax_classes (code, name, description, default_taxable, is_system, sort_order)
  SELECT v.code, v.name, v.description, v.taxable, true, v.sort_order
  FROM (VALUES
    ('general', 'General', 'Default for anything unclassified', true, 0),
    ('materials', 'Parts & materials', 'Tangible goods you supply with the job', true, 10),
    ('equipment', 'Equipment', 'Installed equipment and appliances', true, 20),
    ('labor', 'Service labor', 'Labor charges — taxability varies by state', false, 30),
    ('permits_fees', 'Permits & pass-through fees', 'Government fees billed at cost', false, 40)
  ) AS v(code, name, description, taxable, sort_order)
  WHERE NOT EXISTS (SELECT 1 FROM tax_classes)
  ON CONFLICT DO NOTHING;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_default_tax_classes() TO authenticated;

-- =============================================================
-- 5. Certificates bucket — PRIVATE, per-account folder, signed URLs only
-- =============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tax-exemption-certificates', 'tax-exemption-certificates', false, 10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "account_manage_tax_certificates" ON storage.objects;
CREATE POLICY "account_manage_tax_certificates"
ON storage.objects
FOR ALL
TO authenticated
USING (bucket_id = 'tax-exemption-certificates' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text)
WITH CHECK (bucket_id = 'tax-exemption-certificates' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

-- =============================================================
-- 6. Tax snapshot columns on quotes & invoices
--    tax_percent stays the EFFECTIVE rate (tax_cents / subtotal) so legacy math is exact.
-- =============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'invoices'] LOOP
    EXECUTE format('ALTER TABLE %I
      ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS service_address jsonb,
      ADD COLUMN IF NOT EXISTS tax_breakdown jsonb NOT NULL DEFAULT ''[]''::jsonb,
      ADD COLUMN IF NOT EXISTS tax_cents integer,
      ADD COLUMN IF NOT EXISTS taxable_cents integer,
      ADD COLUMN IF NOT EXISTS nontaxable_cents integer,
      ADD COLUMN IF NOT EXISTS exempt_cents integer,
      ADD COLUMN IF NOT EXISTS tax_exempt boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS tax_exemption_id uuid REFERENCES tax_exemptions(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS tax_exemption_ref text,
      ADD COLUMN IF NOT EXISTS tax_rate_source text,
      ADD COLUMN IF NOT EXISTS tax_calculated_at timestamptz', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_tax_snapshot_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (
      jsonb_typeof(tax_breakdown) = ''array''
      AND (tax_cents IS NULL OR tax_cents >= 0)
      AND (taxable_cents IS NULL OR taxable_cents >= 0)
      AND (nontaxable_cents IS NULL OR nontaxable_cents >= 0)
      AND (exempt_cents IS NULL OR exempt_cents >= 0)
    )', t, t || '_tax_snapshot_check');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (customer_id)', 'idx_' || t || '_customer', t);
  END LOOP;
END $$;

-- A sent invoice is a tax document: its tax details are frozen. Void + reissue to change.
CREATE OR REPLACE FUNCTION public.guard_invoice_tax_lock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.line_items IS DISTINCT FROM OLD.line_items
    OR NEW.tax_percent IS DISTINCT FROM OLD.tax_percent
    OR NEW.tax_breakdown IS DISTINCT FROM OLD.tax_breakdown
    OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
    OR NEW.taxable_cents IS DISTINCT FROM OLD.taxable_cents
    OR NEW.exempt_cents IS DISTINCT FROM OLD.exempt_cents
    OR NEW.tax_exempt IS DISTINCT FROM OLD.tax_exempt
    OR NEW.service_address IS DISTINCT FROM OLD.service_address
  ) THEN
    RAISE EXCEPTION 'Tax details are locked once an invoice has been sent. Void it and issue a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_invoice_tax_lock ON invoices;
CREATE TRIGGER trg_guard_invoice_tax_lock
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_tax_lock();

-- =============================================================
-- 7. Quote -> invoice carries the snapshot across
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_invoice_from_quote(p_quote_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_invoice_id uuid;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = public.get_account_owner_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found or not authorized'; END IF;

  INSERT INTO invoices (
    user_id, quote_id, customer_id, customer_name, customer_email, customer_phone, line_items, tax_percent, due_date,
    service_address, tax_breakdown, tax_cents, taxable_cents, nontaxable_cents, exempt_cents,
    tax_exempt, tax_exemption_id, tax_exemption_ref, tax_rate_source, tax_calculated_at
  )
  VALUES (
    v_quote.user_id, v_quote.id, v_quote.customer_id, v_quote.customer_name, v_quote.customer_email, v_quote.customer_phone,
    v_quote.line_items, v_quote.tax_percent, p_due_date,
    v_quote.service_address, v_quote.tax_breakdown, v_quote.tax_cents, v_quote.taxable_cents, v_quote.nontaxable_cents, v_quote.exempt_cents,
    v_quote.tax_exempt, v_quote.tax_exemption_id, v_quote.tax_exemption_ref, v_quote.tax_rate_source, v_quote.tax_calculated_at
  )
  RETURNING id INTO v_invoice_id;

  RETURN v_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_invoice_from_quote(uuid, date) TO authenticated;

-- =============================================================
-- 8. Public token-gated reads now return the tax breakdown
-- =============================================================
DROP FUNCTION IF EXISTS public.get_quote_for_token(uuid);

CREATE FUNCTION public.get_quote_for_token(p_token uuid)
RETURNS TABLE (
  quote_id uuid,
  customer_name text,
  line_items jsonb,
  options jsonb,
  photos jsonb,
  recommended_option_id text,
  selected_option_id text,
  presentation_note text,
  deposit_percent numeric,
  tax_percent numeric,
  status text,
  valid_until date,
  business_name text,
  financing_partner_name text,
  financing_note text,
  tax_breakdown jsonb,
  tax_cents integer,
  tax_exempt boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    q.id, q.customer_name, q.line_items, q.options, q.photos,
    q.recommended_option_id, q.selected_option_id, q.presentation_note,
    q.deposit_percent, q.tax_percent, q.status, q.valid_until,
    p.company_name, bp.financing_partner_name, bp.financing_note,
    q.tax_breakdown, q.tax_cents, q.tax_exempt
  FROM quotes q
  JOIN profiles p ON p.id = q.user_id
  LEFT JOIN business_profile bp ON bp.user_id = q.user_id
  WHERE q.quote_token = p_token AND q.status <> 'draft'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_quote_for_token(uuid) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_invoice_for_token(uuid);

CREATE FUNCTION public.get_invoice_for_token(p_token uuid)
RETURNS TABLE (
  invoice_id uuid,
  invoice_number text,
  customer_name text,
  line_items jsonb,
  tax_percent numeric,
  status text,
  due_date date,
  notes text,
  business_name text,
  tax_breakdown jsonb,
  tax_cents integer,
  tax_exempt boolean,
  service_address jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.invoice_number, i.customer_name, i.line_items, i.tax_percent, i.status, i.due_date, i.notes, p.company_name,
         i.tax_breakdown, i.tax_cents, i.tax_exempt, i.service_address
  FROM invoices i
  JOIN profiles p ON p.id = i.user_id
  WHERE i.invoice_token = p_token AND i.status <> 'draft'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_invoice_for_token(uuid) TO anon, authenticated;

-- =============================================================
-- 9. Period reports (RLS on invoices scopes them to the account)
--    basis 'invoiced' = accrual (sent/viewed/paid by sent date)
--    basis 'paid'     = cash    (paid invoices by paid date)
-- =============================================================
CREATE OR REPLACE FUNCTION public.tax_report_summary(p_from date, p_to date, p_basis text DEFAULT 'invoiced')
RETURNS TABLE (
  state text,
  invoice_count bigint,
  gross_cents bigint,
  taxable_cents bigint,
  nontaxable_cents bigint,
  exempt_cents bigint,
  tax_cents bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COALESCE(upper(i.service_address->>'state'), '??'),
    count(*),
    COALESCE(sum(g.sub), 0)::bigint,
    COALESCE(sum(COALESCE(i.taxable_cents, g.sub)), 0)::bigint,
    COALESCE(sum(COALESCE(i.nontaxable_cents, 0)), 0)::bigint,
    COALESCE(sum(COALESCE(i.exempt_cents, 0)), 0)::bigint,
    COALESCE(sum(COALESCE(i.tax_cents, round(g.sub * i.tax_percent / 100.0)::bigint)), 0)::bigint
  FROM invoices i
  CROSS JOIN LATERAL (SELECT public.quote_line_items_subtotal_cents(i.line_items) AS sub) g
  WHERE CASE
          WHEN p_basis = 'paid' THEN i.status = 'paid' AND i.paid_at::date BETWEEN p_from AND p_to
          ELSE i.status IN ('sent', 'viewed', 'paid') AND COALESCE(i.sent_at, i.created_at)::date BETWEEN p_from AND p_to
        END
  GROUP BY 1
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION public.tax_report_by_jurisdiction(p_from date, p_to date, p_basis text DEFAULT 'invoiced')
RETURNS TABLE (
  state text,
  jurisdiction_level text,
  jurisdiction_name text,
  rate_percent numeric,
  taxable_cents bigint,
  tax_cents bigint,
  invoice_count bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COALESCE(upper(i.service_address->>'state'), '??'),
    b->>'level',
    b->>'name',
    (b->>'rate_percent')::numeric,
    COALESCE(sum((b->>'taxable_cents')::bigint), 0)::bigint,
    COALESCE(sum((b->>'tax_cents')::bigint), 0)::bigint,
    count(DISTINCT i.id)
  FROM invoices i
  CROSS JOIN LATERAL jsonb_array_elements(i.tax_breakdown) AS b
  WHERE CASE
          WHEN p_basis = 'paid' THEN i.status = 'paid' AND i.paid_at::date BETWEEN p_from AND p_to
          ELSE i.status IN ('sent', 'viewed', 'paid') AND COALESCE(i.sent_at, i.created_at)::date BETWEEN p_from AND p_to
        END
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4;
$$;

CREATE OR REPLACE FUNCTION public.tax_report_exempt_sales(p_from date, p_to date, p_basis text DEFAULT 'invoiced')
RETURNS TABLE (
  invoice_id uuid,
  invoice_number text,
  customer_name text,
  invoiced_on date,
  exempt_cents integer,
  certificate_ref text,
  exemption_type text,
  expires_on date,
  state text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    i.id, i.invoice_number, i.customer_name, COALESCE(i.sent_at, i.created_at)::date,
    i.exempt_cents, i.tax_exemption_ref, e.exemption_type, e.expires_on,
    COALESCE(upper(i.service_address->>'state'), '??')
  FROM invoices i
  LEFT JOIN tax_exemptions e ON e.id = i.tax_exemption_id
  WHERE COALESCE(i.exempt_cents, 0) > 0
    AND CASE
          WHEN p_basis = 'paid' THEN i.status = 'paid' AND i.paid_at::date BETWEEN p_from AND p_to
          ELSE i.status IN ('sent', 'viewed', 'paid') AND COALESCE(i.sent_at, i.created_at)::date BETWEEN p_from AND p_to
        END
  ORDER BY 4, i.invoice_number;
$$;

GRANT EXECUTE ON FUNCTION public.tax_report_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tax_report_by_jurisdiction(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tax_report_exempt_sales(date, date, text) TO authenticated;
