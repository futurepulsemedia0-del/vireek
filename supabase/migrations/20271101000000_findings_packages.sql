/*
  # Inspection & Quote Photo Packages ("Findings Packages")

  A technician pins annotated photos from a job (job_photos), prices each
  finding with Good / Better / Best options (same option shape as
  quotes.options — see src/lib/estimates.ts), and sends ONE customer-facing
  findings report. The customer approves per finding in one tap; approved items
  become a job automatically.

  Tenancy : user_id = get_account_owner_id() (owner + team share the data).
  Public  : there is NO anon access. The customer page talks to the
            `findings-package-public` edge function (service role), which matches
            only on the unguessable share_token and signs photo URLs.
  Money   : integer cents. Totals on approval are recomputed here with
            quote_option_total_cents() — client-sent prices are never trusted.
  Additive: new tables + one nullable column on jobs. Nothing existing changes.
*/

-- =============================================================
-- 1. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS findings_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 4000),
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 200),
  customer_email text CHECK (customer_email IS NULL OR char_length(customer_email) <= 320),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 40),
  address text CHECK (address IS NULL OR char_length(address) <= 500),
  technician_name text CHECK (technician_name IS NULL OR char_length(technician_name) <= 120),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'approved', 'partially_approved', 'declined')),
  tax_percent numeric NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 30),
  share_token uuid NOT NULL DEFAULT gen_random_uuid(),
  share_enabled boolean NOT NULL DEFAULT true,
  share_expires_at timestamptz,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  responded_at timestamptz,
  approver_name text CHECK (approver_name IS NULL OR char_length(approver_name) <= 120),
  approved_total_cents bigint NOT NULL DEFAULT 0 CHECK (approved_total_cents >= 0),
  converted_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_packages_token ON findings_packages(share_token);
CREATE INDEX IF NOT EXISTS idx_findings_packages_user_created ON findings_packages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_packages_job ON findings_packages(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS findings_package_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES findings_packages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  sort_order integer NOT NULL DEFAULT 0,
  photo_id uuid REFERENCES job_photos(id) ON DELETE SET NULL,
  -- snapshot of the object in the private `job-photos` bucket (<owner id>/...)
  storage_path text NOT NULL CHECK (char_length(storage_path) <= 500),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  severity text NOT NULL DEFAULT 'recommended' CHECK (severity IN ('urgent', 'recommended', 'monitor')),
  -- [{ x:0..1, y:0..1, type:'circle'|'arrow'|'label', label?:text }]  (AnnotatableImage shape)
  annotations jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(annotations) = 'array' AND jsonb_array_length(annotations) <= 50),
  -- EstimateOption[] (good/better/best), identical to quotes.options
  options jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 3),
  recommended_option_id text,
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'declined')),
  approved_option_id text,
  approved_cents bigint CHECK (approved_cents IS NULL OR approved_cents >= 0),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_items_package ON findings_package_items(package_id, sort_order);

-- Traceability: which package produced this job.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS findings_package_id uuid REFERENCES findings_packages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_findings_package ON jobs(findings_package_id) WHERE findings_package_id IS NOT NULL;

-- =============================================================
-- 2. GUARDS (client sessions can only edit drafts; state changes go through RPCs)
-- =============================================================
CREATE OR REPLACE FUNCTION public.findings_is_internal()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('vireek.findings_internal', true), '') = '1';
$$;

CREATE OR REPLACE FUNCTION public.findings_packages_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT public.findings_is_internal() THEN
      NEW.status := 'draft';
      NEW.sent_at := NULL; NEW.first_viewed_at := NULL; NEW.last_viewed_at := NULL;
      NEW.view_count := 0; NEW.responded_at := NULL; NEW.approver_name := NULL;
      NEW.approved_total_cents := 0; NEW.converted_job_id := NULL;
    END IF;
    IF NEW.job_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jobs j WHERE j.id = NEW.job_id AND j.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'job does not belong to this account' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF public.findings_is_internal() THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.share_token IS DISTINCT FROM OLD.share_token
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
     OR NEW.first_viewed_at IS DISTINCT FROM OLD.first_viewed_at
     OR NEW.last_viewed_at IS DISTINCT FROM OLD.last_viewed_at
     OR NEW.view_count IS DISTINCT FROM OLD.view_count
     OR NEW.responded_at IS DISTINCT FROM OLD.responded_at
     OR NEW.approver_name IS DISTINCT FROM OLD.approver_name
     OR NEW.approved_total_cents IS DISTINCT FROM OLD.approved_total_cents
     OR NEW.converted_job_id IS DISTINCT FROM OLD.converted_job_id THEN
    RAISE EXCEPTION 'managed fields can only change through the findings functions' USING ERRCODE = '42501';
  END IF;

  -- after sending, only the share switch / expiry may change
  IF OLD.status <> 'draft' AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.customer_name IS DISTINCT FROM OLD.customer_name OR NEW.customer_email IS DISTINCT FROM OLD.customer_email
       OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone OR NEW.address IS DISTINCT FROM OLD.address
       OR NEW.technician_name IS DISTINCT FROM OLD.technician_name OR NEW.tax_percent IS DISTINCT FROM OLD.tax_percent
       OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     ) THEN
    RAISE EXCEPTION 'a sent package is locked — reopen it to edit' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_findings_packages_guard ON findings_packages;
CREATE TRIGGER trg_findings_packages_guard
  BEFORE INSERT OR UPDATE ON findings_packages
  FOR EACH ROW EXECUTE FUNCTION public.findings_packages_guard();

DROP TRIGGER IF EXISTS trg_findings_packages_updated_at ON findings_packages;
CREATE TRIGGER trg_findings_packages_updated_at
  BEFORE UPDATE ON findings_packages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.findings_items_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg findings_packages%ROWTYPE;
BEGIN
  SELECT * INTO v_pkg FROM findings_packages WHERE id = NEW.package_id;
  IF NOT FOUND OR v_pkg.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'package does not belong to this account' USING ERRCODE = '42501';
  END IF;

  IF split_part(NEW.storage_path, '/', 1) <> NEW.user_id::text THEN
    RAISE EXCEPTION 'storage path outside account folder' USING ERRCODE = '42501';
  END IF;

  IF NEW.photo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_photos jp WHERE jp.id = NEW.photo_id AND jp.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'photo does not belong to this account' USING ERRCODE = '42501';
  END IF;

  IF public.findings_is_internal() THEN
    RETURN NEW;
  END IF;

  IF v_pkg.status <> 'draft' THEN
    RAISE EXCEPTION 'a sent package is locked — reopen it to edit' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.decision := 'pending'; NEW.approved_option_id := NULL;
    NEW.approved_cents := NULL; NEW.decided_at := NULL;
  ELSE
    IF NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.decision IS DISTINCT FROM OLD.decision
       OR NEW.approved_option_id IS DISTINCT FROM OLD.approved_option_id
       OR NEW.approved_cents IS DISTINCT FROM OLD.approved_cents
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'immutable finding fields cannot be changed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_findings_items_guard ON findings_package_items;
CREATE TRIGGER trg_findings_items_guard
  BEFORE INSERT OR UPDATE ON findings_package_items
  FOR EACH ROW EXECUTE FUNCTION public.findings_items_guard();

DROP TRIGGER IF EXISTS trg_findings_items_updated_at ON findings_package_items;
CREATE TRIGGER trg_findings_items_updated_at
  BEFORE UPDATE ON findings_package_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- deleting a finding is a client action → only while the package is a draft
CREATE OR REPLACE FUNCTION public.findings_items_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.findings_is_internal() THEN RETURN OLD; END IF;
  -- parent already gone (cascade) → nothing to protect
  IF NOT EXISTS (SELECT 1 FROM findings_packages p WHERE p.id = OLD.package_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM findings_packages p WHERE p.id = OLD.package_id AND p.status <> 'draft') THEN
    RAISE EXCEPTION 'a sent package is locked — reopen it to edit' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_findings_items_delete_guard ON findings_package_items;
CREATE TRIGGER trg_findings_items_delete_guard
  BEFORE DELETE ON findings_package_items
  FOR EACH ROW EXECUTE FUNCTION public.findings_items_delete_guard();

-- =============================================================
-- 3. RLS (account-scoped; trigger rules above add the draft lock)
-- =============================================================
ALTER TABLE findings_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings_package_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_findings_packages" ON findings_packages;
CREATE POLICY "select_account_findings_packages" ON findings_packages FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_account_findings_packages" ON findings_packages;
CREATE POLICY "insert_account_findings_packages" ON findings_packages FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND created_by = auth.uid());
DROP POLICY IF EXISTS "update_account_findings_packages" ON findings_packages;
CREATE POLICY "update_account_findings_packages" ON findings_packages FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_draft_findings_packages" ON findings_packages;
CREATE POLICY "delete_draft_findings_packages" ON findings_packages FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND status = 'draft');

DROP POLICY IF EXISTS "select_account_findings_items" ON findings_package_items;
CREATE POLICY "select_account_findings_items" ON findings_package_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_account_findings_items" ON findings_package_items;
CREATE POLICY "insert_account_findings_items" ON findings_package_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_account_findings_items" ON findings_package_items;
CREATE POLICY "update_account_findings_items" ON findings_package_items FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_account_findings_items" ON findings_package_items;
CREATE POLICY "delete_account_findings_items" ON findings_package_items FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. RPC: build a package from a job's photos (atomic, RLS applies)
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_findings_package_from_job(
  p_job_id uuid,
  p_photo_ids uuid[],
  p_title text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_tech text;
  v_pkg uuid;
  v_found integer;
BEGIN
  IF p_photo_ids IS NULL OR cardinality(p_photo_ids) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'choose between 1 and 30 photos' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_found FROM job_photos
  WHERE id = ANY (p_photo_ids) AND user_id = v_owner AND job_id = p_job_id;
  IF v_found <> cardinality(ARRAY(SELECT DISTINCT unnest(p_photo_ids))) THEN
    RAISE EXCEPTION 'every photo must belong to this job' USING ERRCODE = '22023';
  END IF;

  IF v_job.customer_id IS NOT NULL THEN
    SELECT * INTO v_cust FROM customers WHERE id = v_job.customer_id AND user_id = v_owner;
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULL) INTO v_tech FROM profiles p WHERE p.id = auth.uid();

  INSERT INTO findings_packages (
    user_id, job_id, customer_id, title, customer_name, customer_email, customer_phone, address, technician_name, created_by
  ) VALUES (
    v_owner, v_job.id, v_job.customer_id,
    COALESCE(NULLIF(btrim(p_title), ''), 'Inspection findings — ' || COALESCE(v_job.service_type, 'service visit')),
    COALESCE(v_cust.name, v_job.customer_name), v_cust.email, v_cust.phone, v_job.address, v_tech, auth.uid()
  ) RETURNING id INTO v_pkg;

  INSERT INTO findings_package_items (package_id, user_id, sort_order, photo_id, storage_path, title, annotations)
  SELECT
    v_pkg, v_owner, o.ord::integer, jp.id, jp.storage_path,
    left(COALESCE(
      NULLIF(btrim(jp.caption), ''),
      (SELECT NULLIF(btrim(a->>'label'), '') FROM jsonb_array_elements(jp.annotations) a WHERE a ? 'label' LIMIT 1),
      'Finding ' || o.ord
    ), 160),
    jp.annotations
  FROM unnest(p_photo_ids) WITH ORDINALITY AS o(pid, ord)
  JOIN job_photos jp ON jp.id = o.pid
  ORDER BY o.ord;

  RETURN v_pkg;
END;
$$;

-- =============================================================
-- 5. RPC: validate + publish (draft → sent)
-- =============================================================
CREATE OR REPLACE FUNCTION public.send_findings_package(p_id uuid, p_expires_days integer DEFAULT 30)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg findings_packages%ROWTYPE;
  v_item findings_package_items%ROWTYPE;
  v_decisionable integer := 0;
  v_opt jsonb;
BEGIN
  SELECT * INTO v_pkg FROM findings_packages
  WHERE id = p_id AND user_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package not found' USING ERRCODE = '42501'; END IF;
  IF v_pkg.status <> 'draft' THEN RAISE EXCEPTION 'package was already sent' USING ERRCODE = '22023'; END IF;
  IF p_expires_days IS NULL OR p_expires_days NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'expiry must be 1–180 days' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT * FROM findings_package_items WHERE package_id = p_id ORDER BY sort_order LOOP
    IF v_item.severity <> 'monitor' THEN
      v_decisionable := v_decisionable + 1;
      IF jsonb_array_length(v_item.options) = 0 THEN
        RAISE EXCEPTION 'finding "%" needs at least one priced option', v_item.title USING ERRCODE = '22023';
      END IF;
      FOR v_opt IN SELECT * FROM jsonb_array_elements(v_item.options) LOOP
        IF COALESCE(v_opt->>'id', '') = '' OR public.quote_option_total_cents(v_item.options, v_opt->>'id', v_pkg.tax_percent) IS NULL
           OR public.quote_option_total_cents(v_item.options, v_opt->>'id', v_pkg.tax_percent) <= 0 THEN
          RAISE EXCEPTION 'finding "%" has an option with no price', v_item.title USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF v_decisionable = 0 THEN
    RAISE EXCEPTION 'add at least one finding the customer can approve' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vireek.findings_internal', '1', true);
  UPDATE findings_packages
  SET status = 'sent', sent_at = now(), share_enabled = true,
      share_expires_at = now() + make_interval(days => p_expires_days)
  WHERE id = p_id;
  PERFORM set_config('vireek.findings_internal', '', true);

  RETURN v_pkg.share_token;
END;
$$;

-- sent but not yet answered → back to draft so it can be corrected
CREATE OR REPLACE FUNCTION public.reopen_findings_package(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM findings_packages
  WHERE id = p_id AND user_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package not found' USING ERRCODE = '42501'; END IF;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'only a sent package without a response can be reopened' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('vireek.findings_internal', '1', true);
  UPDATE findings_packages SET status = 'draft', sent_at = NULL, share_expires_at = NULL WHERE id = p_id;
  PERFORM set_config('vireek.findings_internal', '', true);
END;
$$;

-- =============================================================
-- 6. RPC: customer response (service_role only, called by the edge function)
--    p_decisions = [{ "item_id": uuid, "option_id": text | null }]  (null = decline)
-- =============================================================
CREATE OR REPLACE FUNCTION public.respond_to_findings_package(
  p_token uuid,
  p_decisions jsonb,
  p_approver_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pkg findings_packages%ROWTYPE;
  v_job jobs%ROWTYPE;
  v_item findings_package_items%ROWTYPE;
  v_dec jsonb;
  v_option text;
  v_cents bigint;
  v_total bigint := 0;
  v_approved integer := 0;
  v_declined integer := 0;
  v_status text;
  v_job_id uuid;
  v_scope text := '';
  v_ids text[];
BEGIN
  IF jsonb_typeof(COALESCE(p_decisions, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_decisions) > 60 THEN
    RAISE EXCEPTION 'INVALID_DECISIONS' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_pkg FROM findings_packages WHERE share_token = p_token FOR UPDATE;
  IF NOT FOUND OR NOT v_pkg.share_enabled OR v_pkg.status = 'draft' THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_pkg.share_expires_at IS NOT NULL AND v_pkg.share_expires_at <= now() THEN
    RAISE EXCEPTION 'EXPIRED' USING ERRCODE = 'P0003';
  END IF;
  IF v_pkg.status <> 'sent' THEN
    RAISE EXCEPTION 'ALREADY_RESPONDED' USING ERRCODE = 'P0004';
  END IF;

  -- every decisionable finding must be answered exactly once
  SELECT array_agg(d->>'item_id') INTO v_ids FROM jsonb_array_elements(p_decisions) d;
  IF v_ids IS NULL OR cardinality(v_ids) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) x)
     OR cardinality(v_ids) <> (SELECT count(*) FROM findings_package_items WHERE package_id = v_pkg.id AND severity <> 'monitor')
     OR EXISTS (
       SELECT 1 FROM unnest(v_ids) x
       WHERE NOT EXISTS (
         SELECT 1 FROM findings_package_items i
         WHERE i.package_id = v_pkg.id AND i.severity <> 'monitor' AND i.id::text = x
       )
     ) THEN
    RAISE EXCEPTION 'INCOMPLETE_DECISIONS' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vireek.findings_internal', '1', true);

  FOR v_dec IN SELECT * FROM jsonb_array_elements(p_decisions) LOOP
    SELECT * INTO v_item FROM findings_package_items
    WHERE id = (v_dec->>'item_id')::uuid AND package_id = v_pkg.id;

    v_option := NULLIF(v_dec->>'option_id', '');
    IF v_option IS NULL THEN
      UPDATE findings_package_items
      SET decision = 'declined', approved_option_id = NULL, approved_cents = NULL, decided_at = now()
      WHERE id = v_item.id;
      v_declined := v_declined + 1;
    ELSE
      v_cents := public.quote_option_total_cents(v_item.options, v_option, v_pkg.tax_percent);
      IF v_cents IS NULL THEN
        RAISE EXCEPTION 'INVALID_OPTION' USING ERRCODE = '22023';
      END IF;
      UPDATE findings_package_items
      SET decision = 'approved', approved_option_id = v_option, approved_cents = v_cents, decided_at = now()
      WHERE id = v_item.id;
      v_total := v_total + v_cents;
      v_approved := v_approved + 1;
      v_scope := v_scope || E'\n• ' || v_item.title || ' — ' ||
        COALESCE((SELECT o->>'name' FROM jsonb_array_elements(v_item.options) o WHERE o->>'id' = v_option), 'Approved option');
    END IF;
  END LOOP;

  v_status := CASE WHEN v_approved = 0 THEN 'declined'
                   WHEN v_declined = 0 THEN 'approved' ELSE 'partially_approved' END;

  IF v_approved > 0 THEN
    SELECT * INTO v_job FROM jobs WHERE id = v_pkg.job_id;
    INSERT INTO jobs (user_id, customer_id, customer_name, service_type, address, invoice_amount, notes, findings_package_id)
    VALUES (
      v_pkg.user_id, v_pkg.customer_id, v_pkg.customer_name,
      COALESCE(v_job.service_type, 'Approved repairs'), COALESCE(v_pkg.address, v_job.address),
      round(v_total / 100.0, 2),
      'Created from customer-approved findings: ' || v_pkg.title || v_scope,
      v_pkg.id
    ) RETURNING id INTO v_job_id;
  END IF;

  UPDATE findings_packages
  SET status = v_status, responded_at = now(), approved_total_cents = v_total,
      approver_name = left(NULLIF(btrim(p_approver_name), ''), 120), converted_job_id = v_job_id
  WHERE id = v_pkg.id;

  -- Notification must never block the customer's approval.
  BEGIN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      v_pkg.user_id, 'findings_response',
      CASE v_status WHEN 'declined' THEN 'Findings declined' ELSE 'Findings approved' END,
      v_pkg.customer_name || CASE v_status
        WHEN 'declined' THEN ' declined all recommended repairs.'
        ELSE ' approved ' || v_approved || ' repair' || CASE WHEN v_approved = 1 THEN '' ELSE 's' END ||
             ' ($' || to_char(v_total / 100.0, 'FM999,999,990.00') || ') — a job was created.'
      END,
      '/dashboard/findings/' || v_pkg.id
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM set_config('vireek.findings_internal', '', true);

  RETURN jsonb_build_object(
    'status', v_status, 'approved_count', v_approved, 'declined_count', v_declined,
    'approved_total_cents', v_total, 'job_created', v_job_id IS NOT NULL
  );
END;
$$;

-- =============================================================
-- 7. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.create_findings_package_from_job(uuid, uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_findings_package(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_findings_package(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_findings_package(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_findings_package_from_job(uuid, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_findings_package(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_findings_package(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_findings_package(uuid, jsonb, text) TO service_role;
