/*
  # Enterprise Trust Pack

  Regional data residency (US / EU / CA), customer-managed encryption keys (CMEK)
  for sensitive fields and call recordings, a dedicated-tenant option, SLA tracking
  with automatic service credits, and the security-portal back end (pentest
  summaries + sub-processor change notices with objections).

  Purely additive. Reuses the existing governance layer:
    - public.get_account_owner_id(), public.is_vireek_staff(), public.log_audit_event()
    - public.has_active_legal_hold() (blocks region changes while a legal hold is active)
    - pii_field_registry (what "sensitive" means) and OWNED_TABLES (erasure/retention)
    - the sub-processor list in src/lib/subprocessors.ts (notices are about THAT list)

  ## Architecture
  CONTROL PLANE = this (primary) project: accounts, billing, jobs, key registry,
    residency choice, SLA, portal content, and `sealed_inventory` (a content-free ledger).
  DATA PLANE    = one Supabase project per region. Each project runs THIS SAME migration and
    is then labelled once with:  SELECT public.init_data_plane('eu');   -- or 'ca'
    That creates its `recordings-<region>` bucket and makes the DB triggers stamp/enforce its
    region. The primary project is the 'us' plane by default.
  Edge functions pick the plane from the tenant's residency row and FAIL CLOSED
  (src/lib/trustPack/regions.ts -> resolveDataPlane).

  ## Enforcement layers (defence in depth)
  1. UI only offers regions that are provisioned (data_regions.is_available).
  2. tenant_residency has no UPDATE policy: a region is chosen once, changed only through the
     staff-approved residency_change_requests workflow (blocked by legal hold).
  3. Edge router never falls back to another region.
  4. DB triggers on sealed_values / sealed_objects reject rows that do not belong to this
     plane's region (and, in the primary, rows for tenants pinned elsewhere).
  5. Buckets are private with no client policies; objects are ciphertext only.
*/

-- =====================================================================
-- 0. DATA PLANE IDENTITY
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.data_plane_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  region text NOT NULL CHECK (region IN ('us', 'eu', 'ca')),
  initialized_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.data_plane_identity (region) VALUES ('us') ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE public.data_plane_identity ENABLE ROW LEVEL SECURITY; -- no policies: service role only

CREATE OR REPLACE FUNCTION public.plane_region()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT region FROM public.data_plane_identity LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public.init_data_plane(p_region text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_region NOT IN ('us', 'eu', 'ca') THEN
    RAISE EXCEPTION 'Unknown region %', p_region USING ERRCODE = '22023';
  END IF;
  UPDATE public.data_plane_identity SET region = p_region, initialized_at = now();
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('recordings-' || p_region, 'recordings-' || p_region, false, 104857600, ARRAY['application/octet-stream'])
  ON CONFLICT (id) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.init_data_plane(text) FROM PUBLIC, anon, authenticated;

-- The primary project is the US plane out of the box.
SELECT public.init_data_plane((SELECT region FROM public.data_plane_identity LIMIT 1));

-- =====================================================================
-- 1. REGIONS + TENANT RESIDENCY (control plane)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.data_regions (
  code text PRIMARY KEY CHECK (code IN ('us', 'eu', 'ca')),
  label text NOT NULL,
  is_available boolean NOT NULL DEFAULT false,
  provisioned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.data_regions (code, label, is_available, provisioned_at) VALUES
  ('us', 'United States', true, now()),
  ('eu', 'European Union', false, NULL),
  ('ca', 'Canada', false, NULL)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.data_regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone_read_data_regions" ON public.data_regions;
CREATE POLICY "anyone_read_data_regions" ON public.data_regions FOR SELECT USING (true);
DROP POLICY IF EXISTS "staff_manage_data_regions" ON public.data_regions;
CREATE POLICY "staff_manage_data_regions" ON public.data_regions FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.tenant_residency (
  user_id uuid PRIMARY KEY,                       -- account owner
  region text NOT NULL REFERENCES public.data_regions (code),
  selected_by uuid,
  selected_at timestamptz NOT NULL DEFAULT now()
);

-- Missing row == 'us' (every account that existed before this feature).
CREATE OR REPLACE FUNCTION public.tenant_region(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT COALESCE((SELECT region FROM public.tenant_residency WHERE user_id = p_user), 'us') $$;
GRANT EXECUTE ON FUNCTION public.tenant_region(uuid) TO authenticated;

ALTER TABLE public.tenant_residency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_tenant_residency" ON public.tenant_residency;
CREATE POLICY "account_select_tenant_residency" ON public.tenant_residency FOR SELECT
  USING (user_id = public.get_account_owner_id());
-- Owner may choose ONCE. There is intentionally no UPDATE/DELETE policy: changes go through
-- residency_change_requests (staff-approved, legal-hold aware).
DROP POLICY IF EXISTS "owner_choose_tenant_residency" ON public.tenant_residency;
CREATE POLICY "owner_choose_tenant_residency" ON public.tenant_residency FOR INSERT
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_read_tenant_residency" ON public.tenant_residency;
CREATE POLICY "staff_read_tenant_residency" ON public.tenant_residency FOR SELECT
  USING (public.is_vireek_staff(auth.uid()));

-- =====================================================================
-- 2. SEALED DATA (plane-local ciphertext) + CONTROL-PLANE INVENTORY
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tenant_encryption_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'aws_kms' CHECK (provider IN ('aws_kms')),
  key_arn text NOT NULL CHECK (char_length(key_arn) BETWEEN 20 AND 400),
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  -- pending: registered, not yet validated; active: used for NEW data;
  -- retired: decrypt/rewrap only (after rotation); revoked: customer/Vireek cut it off.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'retired', 'revoked')),
  last_validated_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (user_id, key_arn)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_encryption_keys_one_active_idx
  ON public.tenant_encryption_keys (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS tenant_encryption_keys_user_idx ON public.tenant_encryption_keys (user_id, created_at DESC);

ALTER TABLE public.tenant_encryption_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_encryption_keys" ON public.tenant_encryption_keys;
CREATE POLICY "account_select_encryption_keys" ON public.tenant_encryption_keys FOR SELECT
  USING (user_id = public.get_account_owner_id());
-- Writes: only the `trust-keys` edge function (service role) — it validates the key with KMS first.

CREATE TABLE IF NOT EXISTS public.tenant_encryption_policy (
  user_id uuid PRIMARY KEY,
  seal_recordings boolean NOT NULL DEFAULT false,
  seal_transcripts boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.encryption_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.seal_recordings OR NEW.seal_transcripts) AND NOT EXISTS (
    SELECT 1 FROM public.tenant_encryption_keys WHERE user_id = NEW.user_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Register and validate an encryption key before turning encryption on.' USING ERRCODE = '22023';
  END IF;
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_encryption_policy_guard ON public.tenant_encryption_policy;
CREATE TRIGGER trg_encryption_policy_guard BEFORE INSERT OR UPDATE ON public.tenant_encryption_policy
  FOR EACH ROW EXECUTE FUNCTION public.encryption_policy_guard();

ALTER TABLE public.tenant_encryption_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_encryption_policy" ON public.tenant_encryption_policy;
CREATE POLICY "account_select_encryption_policy" ON public.tenant_encryption_policy FOR SELECT
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "owner_insert_encryption_policy" ON public.tenant_encryption_policy;
CREATE POLICY "owner_insert_encryption_policy" ON public.tenant_encryption_policy FOR INSERT
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "owner_update_encryption_policy" ON public.tenant_encryption_policy;
CREATE POLICY "owner_update_encryption_policy" ON public.tenant_encryption_policy FOR UPDATE
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id())
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());

-- ---- plane-local ciphertext (service role only; no client policies) ----

CREATE TABLE IF NOT EXISTS public.sealed_values (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  region text NOT NULL,
  key_id uuid NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  column_name text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  wrapped_dek text NOT NULL,
  alg text NOT NULL DEFAULT 'AES-256-GCM',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, table_name, row_id, column_name)
);
CREATE INDEX IF NOT EXISTS sealed_values_key_idx ON public.sealed_values (key_id);

CREATE TABLE IF NOT EXISTS public.sealed_objects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  region text NOT NULL,
  key_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'call_recording' CHECK (kind IN ('call_recording')),
  source_row_id uuid NOT NULL,
  bucket text NOT NULL,
  object_path text NOT NULL,
  iv text NOT NULL,
  wrapped_dek text NOT NULL,
  alg text NOT NULL DEFAULT 'AES-256-GCM',
  content_type text NOT NULL DEFAULT 'audio/wav' CHECK (char_length(content_type) <= 100),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, source_row_id)
);
CREATE INDEX IF NOT EXISTS sealed_objects_key_idx ON public.sealed_objects (key_id);

-- Stamp + enforce the plane's region on every write.
CREATE OR REPLACE FUNCTION public.sealed_plane_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plane text := public.plane_region();
  v_tenant text;
BEGIN
  SELECT region INTO v_tenant FROM public.tenant_residency WHERE user_id = NEW.user_id;
  IF v_tenant IS NOT NULL AND v_tenant <> v_plane
     AND NOT EXISTS (SELECT 1 FROM public.residency_change_requests
                      WHERE user_id = NEW.user_id AND status = 'approved' AND to_region = v_plane) THEN
    RAISE EXCEPTION 'Residency violation: tenant is pinned to % but this data plane is %', v_tenant, v_plane
      USING ERRCODE = '42501';
  END IF;
  NEW.region := v_plane;
  IF TG_TABLE_NAME = 'sealed_objects' AND NEW.bucket <> 'recordings-' || v_plane THEN
    RAISE EXCEPTION 'Residency violation: bucket % is not this plane''s bucket', NEW.bucket USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sealed_values_plane ON public.sealed_values;
CREATE TRIGGER trg_sealed_values_plane BEFORE INSERT ON public.sealed_values
  FOR EACH ROW EXECUTE FUNCTION public.sealed_plane_guard();
DROP TRIGGER IF EXISTS trg_sealed_objects_plane ON public.sealed_objects;
CREATE TRIGGER trg_sealed_objects_plane BEFORE INSERT ON public.sealed_objects
  FOR EACH ROW EXECUTE FUNCTION public.sealed_plane_guard();

ALTER TABLE public.sealed_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sealed_objects ENABLE ROW LEVEL SECURITY;

-- ---- control-plane inventory: WHAT is sealed WHERE (no content, no keys) ----

CREATE TABLE IF NOT EXISTS public.sealed_inventory (
  id uuid PRIMARY KEY,                           -- same id as the plane row
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('field', 'recording')),
  source_table text NOT NULL,
  source_row_id uuid NOT NULL,
  source_column text,
  region text NOT NULL CHECK (region IN ('us', 'eu', 'ca')),
  isolation text NOT NULL DEFAULT 'shared' CHECK (isolation IN ('shared', 'dedicated')),
  key_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  purge_requested_at timestamptz
);
CREATE INDEX IF NOT EXISTS sealed_inventory_user_idx ON public.sealed_inventory (user_id, region);
CREATE INDEX IF NOT EXISTS sealed_inventory_source_idx ON public.sealed_inventory (source_table, source_row_id);
CREATE INDEX IF NOT EXISTS sealed_inventory_purge_idx ON public.sealed_inventory (purge_requested_at) WHERE purge_requested_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sealed_inventory_key_idx ON public.sealed_inventory (key_id);

ALTER TABLE public.sealed_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_sealed_inventory" ON public.sealed_inventory;
CREATE POLICY "account_select_sealed_inventory" ON public.sealed_inventory FOR SELECT
  USING (user_id = public.get_account_owner_id());

-- Retention / erasure parity: when a call is deleted (full erasure, deletion request) or its
-- transcript / recording is anonymised by data-retention-sweep, the sealed copies must go too.
-- The trigger only FLAGS the inventory; `trust-vault` (action purge_pending) removes the plane
-- rows and storage objects, because they may live in another region's project.
CREATE OR REPLACE FUNCTION public.flag_sealed_for_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.sealed_inventory SET purge_requested_at = COALESCE(purge_requested_at, now())
     WHERE source_table = TG_TABLE_NAME AND source_row_id = OLD.id AND purge_requested_at IS NULL;
    RETURN OLD;
  END IF;
  -- UPDATE: a sealed column is only "anonymised" when it becomes NULL (sealed rows hold a sealed:// marker).
  UPDATE public.sealed_inventory si SET purge_requested_at = COALESCE(si.purge_requested_at, now())
   WHERE si.source_table = TG_TABLE_NAME AND si.source_row_id = NEW.id AND si.purge_requested_at IS NULL
     AND ((si.kind = 'field' AND si.source_column = 'transcript' AND NEW.transcript IS NULL)
       OR (si.kind = 'recording' AND NEW.recording_url IS NULL));
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.calls') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_calls_flag_sealed_delete ON public.calls;
    CREATE TRIGGER trg_calls_flag_sealed_delete AFTER DELETE ON public.calls
      FOR EACH ROW EXECUTE FUNCTION public.flag_sealed_for_purge();
    DROP TRIGGER IF EXISTS trg_calls_flag_sealed_update ON public.calls;
    CREATE TRIGGER trg_calls_flag_sealed_update AFTER UPDATE OF transcript, recording_url ON public.calls
      FOR EACH ROW EXECUTE FUNCTION public.flag_sealed_for_purge();
  END IF;
END $$;

-- =====================================================================
-- 3. RESIDENCY: guard + change workflow
-- =====================================================================

CREATE OR REPLACE FUNCTION public.tenant_residency_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.data_regions WHERE code = NEW.region AND is_available) THEN
    RAISE EXCEPTION 'Region % is not available yet.', NEW.region USING ERRCODE = '22023';
  END IF;
  -- Choosing a region must not strand data that is already sealed somewhere else.
  IF EXISTS (SELECT 1 FROM public.sealed_inventory
              WHERE user_id = NEW.user_id AND region <> NEW.region AND purge_requested_at IS NULL) THEN
    RAISE EXCEPTION 'Encrypted data already exists in another region. Use a region change request.' USING ERRCODE = '22023';
  END IF;
  NEW.selected_by := COALESCE(auth.uid(), NEW.selected_by);
  NEW.selected_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tenant_residency_guard ON public.tenant_residency;
CREATE TRIGGER trg_tenant_residency_guard BEFORE INSERT ON public.tenant_residency
  FOR EACH ROW EXECUTE FUNCTION public.tenant_residency_guard();

CREATE TABLE IF NOT EXISTS public.residency_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  from_region text NOT NULL REFERENCES public.data_regions (code),
  to_region text NOT NULL REFERENCES public.data_regions (code),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'cancelled')),
  requested_by uuid,
  decided_by uuid,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  completed_at timestamptz,
  CHECK (from_region <> to_region)
);
CREATE UNIQUE INDEX IF NOT EXISTS residency_change_one_open_idx
  ON public.residency_change_requests (user_id) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS residency_change_status_idx ON public.residency_change_requests (status, created_at);

CREATE OR REPLACE FUNCTION public.residency_change_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.from_region := public.tenant_region(NEW.user_id);
  NEW.status := 'pending';
  NEW.requested_by := COALESCE(auth.uid(), NEW.requested_by);
  NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.completed_at := NULL; NEW.decision_note := NULL;
  IF NEW.from_region = NEW.to_region THEN
    RAISE EXCEPTION 'Your data is already in this region.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.data_regions WHERE code = NEW.to_region AND is_available) THEN
    RAISE EXCEPTION 'Region % is not available yet.', NEW.to_region USING ERRCODE = '22023';
  END IF;
  IF public.has_active_legal_hold(NEW.user_id) THEN
    RAISE EXCEPTION 'Region changes are blocked while a legal hold is active on your account.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_residency_change_before_insert ON public.residency_change_requests;
CREATE TRIGGER trg_residency_change_before_insert BEFORE INSERT ON public.residency_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.residency_change_before_insert();

ALTER TABLE public.residency_change_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_residency_changes" ON public.residency_change_requests;
CREATE POLICY "account_select_residency_changes" ON public.residency_change_requests FOR SELECT
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "owner_insert_residency_changes" ON public.residency_change_requests;
CREATE POLICY "owner_insert_residency_changes" ON public.residency_change_requests FOR INSERT
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
-- Owner may only withdraw a request nobody has acted on yet.
DROP POLICY IF EXISTS "owner_cancel_residency_changes" ON public.residency_change_requests;
CREATE POLICY "owner_cancel_residency_changes" ON public.residency_change_requests FOR UPDATE
  USING (user_id = auth.uid() AND status = 'pending')
  WITH CHECK (user_id = auth.uid() AND status = 'cancelled');
DROP POLICY IF EXISTS "staff_read_residency_changes" ON public.residency_change_requests;
CREATE POLICY "staff_read_residency_changes" ON public.residency_change_requests FOR SELECT
  USING (public.is_vireek_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.staff_decide_region_change(p_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_req public.residency_change_requests%ROWTYPE;
BEGIN
  IF NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM public.residency_change_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Request is not pending.' USING ERRCODE = '22023';
  END IF;
  IF p_approve AND public.has_active_legal_hold(v_req.user_id) THEN
    RAISE EXCEPTION 'A legal hold is active on this account.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.residency_change_requests
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = auth.uid(), decided_at = now(), decision_note = p_note
   WHERE id = p_id;
  PERFORM public.log_audit_event(v_req.user_id,
    CASE WHEN p_approve THEN 'approved_region_change' ELSE 'rejected_region_change' END,
    'residency_change_requests', p_id::text,
    jsonb_build_object('from', v_req.from_region, 'to', v_req.to_region));
END;
$$;

-- Final step: flips the tenant's region. Refuses while sealed items still sit in the old region
-- (run trust-vault action migrate_region first) and requires staff to confirm the old plane is clean.
CREATE OR REPLACE FUNCTION public.staff_complete_region_change(p_id uuid, p_confirm_old_region_clean boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.residency_change_requests%ROWTYPE;
  v_left integer;
BEGIN
  IF NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(p_confirm_old_region_clean, false) THEN
    RAISE EXCEPTION 'Confirm the old region holds no remaining tenant data.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.residency_change_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Request is not approved.' USING ERRCODE = '22023';
  END IF;
  IF public.has_active_legal_hold(v_req.user_id) THEN
    RAISE EXCEPTION 'A legal hold is active on this account.' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_left FROM public.sealed_inventory
   WHERE user_id = v_req.user_id AND region = v_req.from_region AND purge_requested_at IS NULL;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% sealed item(s) still stored in %. Migrate them first.', v_left, v_req.from_region USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.tenant_residency (user_id, region, selected_by)
  VALUES (v_req.user_id, v_req.to_region, auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET region = EXCLUDED.region, selected_by = EXCLUDED.selected_by, selected_at = now();
  UPDATE public.residency_change_requests SET status = 'completed', completed_at = now() WHERE id = p_id;
  PERFORM public.log_audit_event(v_req.user_id, 'completed_region_change', 'residency_change_requests', p_id::text,
    jsonb_build_object('from', v_req.from_region, 'to', v_req.to_region));
END;
$$;
GRANT EXECUTE ON FUNCTION public.staff_decide_region_change(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_complete_region_change(uuid, boolean) TO authenticated;

-- NOTE: the upsert in staff_complete_region_change fires tenant_residency_guard (BEFORE INSERT) too,
-- which re-checks region availability and that no live sealed item remains in a different region.

-- =====================================================================
-- 4. DEDICATED TENANT
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.dedicated_tenants (
  user_id uuid PRIMARY KEY,
  region text NOT NULL REFERENCES public.data_regions (code),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'provisioning', 'active', 'suspended', 'declined')),
  endpoint_url text,
  secret_ref text,
  request_note text CHECK (request_note IS NULL OR char_length(request_note) <= 1000),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dedicated_active_needs_endpoint CHECK (
    status <> 'active'
    OR (COALESCE(endpoint_url ~ '^https://[^/\s]+', false) AND COALESCE(secret_ref ~ '^[A-Z0-9_]{1,40}$', false))
  )
);

CREATE OR REPLACE FUNCTION public.dedicated_tenant_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    -- Customers can only ask. Provisioning fields are staff-controlled.
    NEW.status := 'requested';
    NEW.endpoint_url := NULL;
    NEW.secret_ref := NULL;
    NEW.activated_at := NULL;
    NEW.requested_by := auth.uid();
  END IF;
  NEW.region := public.tenant_region(NEW.user_id);   -- the plane must match the tenant's residency
  NEW.updated_at := now();
  IF NEW.status = 'active' AND NEW.activated_at IS NULL THEN NEW.activated_at := now(); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dedicated_tenant_before_write ON public.dedicated_tenants;
CREATE TRIGGER trg_dedicated_tenant_before_write BEFORE INSERT OR UPDATE ON public.dedicated_tenants
  FOR EACH ROW EXECUTE FUNCTION public.dedicated_tenant_before_write();

ALTER TABLE public.dedicated_tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_dedicated_tenants" ON public.dedicated_tenants;
CREATE POLICY "account_select_dedicated_tenants" ON public.dedicated_tenants FOR SELECT
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "owner_request_dedicated_tenant" ON public.dedicated_tenants;
CREATE POLICY "owner_request_dedicated_tenant" ON public.dedicated_tenants FOR INSERT
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "owner_withdraw_dedicated_request" ON public.dedicated_tenants;
CREATE POLICY "owner_withdraw_dedicated_request" ON public.dedicated_tenants FOR DELETE
  USING (user_id = auth.uid() AND status = 'requested');
DROP POLICY IF EXISTS "staff_manage_dedicated_tenants" ON public.dedicated_tenants;
CREATE POLICY "staff_manage_dedicated_tenants" ON public.dedicated_tenants FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

-- =====================================================================
-- 5. SLA TRACKING + AUTOMATIC SERVICE CREDITS
-- =====================================================================

-- A row here = this account has a contracted SLA (order form) and receives credits automatically.
-- Accounts without a row still see measured uptime and can claim per the public SLA (/sla).
CREATE TABLE IF NOT EXISTS public.sla_policies (
  user_id uuid PRIMARY KEY,
  monthly_fee_cents integer CHECK (monthly_fee_cents IS NULL OR monthly_fee_cents > 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  tiers jsonb NOT NULL DEFAULT '[{"below":99.9,"credit_pct":10},{"below":99.0,"credit_pct":25},{"below":95.0,"credit_pct":50}]'::jsonb
    CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) BETWEEN 1 AND 6),
  auto_credit boolean NOT NULL DEFAULT true,
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sla_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_sla_policies" ON public.sla_policies;
CREATE POLICY "account_select_sla_policies" ON public.sla_policies FOR SELECT
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_manage_sla_policies" ON public.sla_policies;
CREATE POLICY "staff_manage_sla_policies" ON public.sla_policies FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.sla_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  kind text NOT NULL DEFAULT 'outage'
    CHECK (kind IN ('outage', 'degraded', 'maintenance', 'third_party', 'force_majeure')),
  scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'us', 'eu', 'ca')),
  tenant_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  announced_at timestamptz,
  confirmed boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE INDEX IF NOT EXISTS sla_incidents_window_idx ON public.sla_incidents (started_at, ended_at);

ALTER TABLE public.sla_incidents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_read_confirmed_incidents" ON public.sla_incidents;
CREATE POLICY "authenticated_read_confirmed_incidents" ON public.sla_incidents FOR SELECT TO authenticated
  USING (confirmed AND (tenant_id IS NULL OR tenant_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS "staff_manage_sla_incidents" ON public.sla_incidents;
CREATE POLICY "staff_manage_sla_incidents" ON public.sla_incidents FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.sla_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  uptime_pct numeric(9, 5) NOT NULL,
  measured_minutes numeric(12, 2) NOT NULL,
  downtime_minutes numeric(12, 2) NOT NULL,
  credit_pct integer NOT NULL DEFAULT 0,
  monthly_fee_cents integer,
  credit_cents integer NOT NULL DEFAULT 0,
  -- none: no credit due; pending: due but not applied (no fee / no Stripe customer / auto_credit off);
  -- applied: Stripe balance credit created; failed: retry next run; void: staff cancelled.
  status text NOT NULL DEFAULT 'none' CHECK (status IN ('none', 'pending', 'applied', 'failed', 'void')),
  stripe_ref text,
  error text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (user_id, period)
);
CREATE INDEX IF NOT EXISTS sla_credits_user_idx ON public.sla_credits (user_id, period DESC);

ALTER TABLE public.sla_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_sla_credits" ON public.sla_credits;
CREATE POLICY "account_select_sla_credits" ON public.sla_credits FOR SELECT
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_manage_sla_credits" ON public.sla_credits;
CREATE POLICY "staff_manage_sla_credits" ON public.sla_credits FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));
-- Computation + application is done by `sla-credit-run` (service role).

-- =====================================================================
-- 6. SECURITY PORTAL: pentests, report requests, sub-processor notices
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.security_pentests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  tester text NOT NULL CHECK (char_length(btrim(tester)) BETWEEN 2 AND 160),
  performed_on date NOT NULL,
  scope text NOT NULL CHECK (char_length(btrim(scope)) BETWEEN 5 AND 600),
  methodology text NOT NULL CHECK (char_length(btrim(methodology)) BETWEEN 5 AND 600),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 20 AND 2000),
  found jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(found) = 'object'),
  remediated jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(remediated) = 'object'),
  report_available_on_request boolean NOT NULL DEFAULT true,
  published_at timestamptz,                      -- NULL = draft (staff only)
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_pentests_published_idx ON public.security_pentests (performed_on DESC) WHERE published_at IS NOT NULL;

ALTER TABLE public.security_pentests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_published_pentests" ON public.security_pentests;
CREATE POLICY "public_read_published_pentests" ON public.security_pentests FOR SELECT
  USING (published_at IS NOT NULL AND published_at <= now());
DROP POLICY IF EXISTS "staff_manage_pentests" ON public.security_pentests;
CREATE POLICY "staff_manage_pentests" ON public.security_pentests FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

-- "Request the full report under NDA" (public form, like sales_inquiries).
CREATE TABLE IF NOT EXISTS public.security_report_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pentest_id uuid REFERENCES public.security_pentests (id) ON DELETE SET NULL,
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(email) <= 254),
  company text NOT NULL CHECK (char_length(btrim(company)) BETWEEN 2 AND 160),
  message text CHECK (message IS NULL OR char_length(message) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.security_report_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone_request_security_report" ON public.security_report_requests;
CREATE POLICY "anyone_request_security_report" ON public.security_report_requests FOR INSERT
  WITH CHECK (true);
DROP POLICY IF EXISTS "staff_read_security_report_requests" ON public.security_report_requests;
CREATE POLICY "staff_read_security_report_requests" ON public.security_report_requests FOR SELECT
  USING (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.subprocessor_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_name text NOT NULL CHECK (char_length(btrim(processor_name)) BETWEEN 2 AND 120),
  change_type text NOT NULL CHECK (change_type IN ('add', 'replace', 'remove', 'change')),
  replaces_name text,
  purpose text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 5 AND 300),
  location text NOT NULL CHECK (char_length(btrim(location)) BETWEEN 2 AND 120),
  data_types text NOT NULL CHECK (char_length(btrim(data_types)) BETWEEN 3 AND 300),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 10 AND 1000),
  posted_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL,
  emergency boolean NOT NULL DEFAULT false,
  withdrawn_at timestamptz,
  dispatched_at timestamptz,                     -- set by subprocessor-notice-dispatch
  created_by uuid,
  -- Non-emergency changes must leave a 30-day objection window (mirrors DPA section 5).
  CONSTRAINT subprocessor_notice_window CHECK (emergency OR effective_at >= posted_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS subprocessor_notices_posted_idx ON public.subprocessor_notices (posted_at DESC);

ALTER TABLE public.subprocessor_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_subprocessor_notices" ON public.subprocessor_notices;
CREATE POLICY "public_read_subprocessor_notices" ON public.subprocessor_notices FOR SELECT USING (true);
DROP POLICY IF EXISTS "staff_manage_subprocessor_notices" ON public.subprocessor_notices;
CREATE POLICY "staff_manage_subprocessor_notices" ON public.subprocessor_notices FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

-- Double opt-in email subscribers. Written ONLY by the `trust-subscribe` edge function.
CREATE TABLE IF NOT EXISTS public.subprocessor_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(email) <= 254),
  verify_token uuid NOT NULL DEFAULT gen_random_uuid(),
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  verified_at timestamptz,
  unsubscribed_at timestamptz,
  last_verification_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subprocessor_subscribers_email_idx ON public.subprocessor_subscribers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS subprocessor_subscribers_verify_idx ON public.subprocessor_subscribers (verify_token);
CREATE UNIQUE INDEX IF NOT EXISTS subprocessor_subscribers_unsub_idx ON public.subprocessor_subscribers (unsubscribe_token);
ALTER TABLE public.subprocessor_subscribers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_read_subprocessor_subscribers" ON public.subprocessor_subscribers;
CREATE POLICY "staff_read_subprocessor_subscribers" ON public.subprocessor_subscribers FOR SELECT
  USING (public.is_vireek_staff(auth.uid()));

-- One row per (notice, recipient) so a retried dispatch never double-sends.
CREATE TABLE IF NOT EXISTS public.subprocessor_notice_deliveries (
  notice_id uuid NOT NULL REFERENCES public.subprocessor_notices (id) ON DELETE CASCADE,
  email text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('subscriber', 'account_owner')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, email)
);
ALTER TABLE public.subprocessor_notice_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_read_notice_deliveries" ON public.subprocessor_notice_deliveries;
CREATE POLICY "staff_read_notice_deliveries" ON public.subprocessor_notice_deliveries FOR SELECT
  USING (public.is_vireek_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.subprocessor_objections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES public.subprocessor_notices (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 20 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'withdrawn')),
  response text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (notice_id, user_id)
);

CREATE OR REPLACE FUNCTION public.subprocessor_objection_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_notice public.subprocessor_notices%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' AND NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    SELECT * INTO v_notice FROM public.subprocessor_notices WHERE id = NEW.notice_id;
    IF NOT FOUND OR v_notice.withdrawn_at IS NOT NULL OR v_notice.effective_at <= now() THEN
      RAISE EXCEPTION 'The objection window for this change is closed.' USING ERRCODE = '22023';
    END IF;
    NEW.status := 'open'; NEW.response := NULL; NEW.resolved_at := NULL;
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_subprocessor_objection_guard ON public.subprocessor_objections;
CREATE TRIGGER trg_subprocessor_objection_guard BEFORE INSERT ON public.subprocessor_objections
  FOR EACH ROW EXECUTE FUNCTION public.subprocessor_objection_guard();

ALTER TABLE public.subprocessor_objections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_select_objections" ON public.subprocessor_objections;
CREATE POLICY "account_select_objections" ON public.subprocessor_objections FOR SELECT
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "owner_insert_objections" ON public.subprocessor_objections;
CREATE POLICY "owner_insert_objections" ON public.subprocessor_objections FOR INSERT
  WITH CHECK (user_id = auth.uid() AND user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "staff_manage_objections" ON public.subprocessor_objections;
CREATE POLICY "staff_manage_objections" ON public.subprocessor_objections FOR ALL
  USING (public.is_vireek_staff(auth.uid())) WITH CHECK (public.is_vireek_staff(auth.uid()));

-- =====================================================================
-- 7. PII registry: mark the fields sealing covers (read by Data Governance UI)
-- =====================================================================
UPDATE public.pii_field_registry
   SET notes = COALESCE(notes || ' · ', '') || 'Sealable with customer-managed keys (Trust Pack)'
 WHERE table_name = 'calls' AND column_name = 'transcript' AND COALESCE(notes, '') NOT LIKE '%Trust Pack%';

COMMENT ON TABLE public.tenant_residency IS
  'Trust Pack: chosen once per account; changes only via residency_change_requests. Missing row = us.';
COMMENT ON TABLE public.sealed_inventory IS
  'Trust Pack: content-free ledger of sealed items and their region. Purge is flagged by triggers on calls and executed by trust-vault.';
