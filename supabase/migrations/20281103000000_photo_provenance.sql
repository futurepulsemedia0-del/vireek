/*
  # Photo Provenance — capture records, server receipts, derived-hash mapping, public verification

  -- lint:allow-destructive the only TRUNCATE below is a trigger that BLOCKS truncation; no data is dropped.

  ## What this adds (it EXTENDS the existing Job Evidence Chain; it does not create a parallel ledger)
  - evidence_photo_policies   : per-account switches (photo location on/off, retention days).
  - evidence_photo_captures   : one row per photo. Immutable except status flags for location purge / file erasure.
  - evidence_photo_locations  : coordinates, kept OUT of the captures table so they can be hard-deleted
        (purge on request / retention) and are unreadable to clients (no policy, no grant).
        Records: job, who captured, sha256 of the ORIGINAL bytes, capture source (in-app camera vs
        gallery import vs plain web input), device time + device-time sanity status, server receipt
        time, "queued offline" flag, and (only when allowed) location with accuracy.
  - evidence_photo_derivatives: every re-encoded / resized / redacted copy, mapped to its parent hash.
  - evidence_photo_shares     : public verification links (only a SHA-256 of the token is stored).
  - Every capture and every derivative is also sealed into the EXISTING per-job hash chain
    (job_evidence_chain_entries, stage 'evidence', kind 'media'). Tamper detection = existing
    job_evidence_chain_verify() + a commitment recomputed from the capture row.
  - Location privacy: coordinates are NOT written to the chain. The chain only holds a salted
    commitment, so coordinates can be purged on request / on expiry without breaking the chain.
    Coordinates are accepted only when ALL hold: account switch on, technician consent logged
    (location_privacy_policies.require_consent), location_tracking_gate() = allowed, and the photo's
    device time is inside the job window (arrived/started .. completed + 60 min).

  ## Honest limits (also shown in the UI)
  Proves integrity since the server RECEIVED the bytes (and since capture only to the extent the
  device clock/app are honest). Does NOT prove the work was done correctly. Device clock and GPS can
  be spoofed; web/gallery photos carry no capture guarantee.

  ## Writes
  Clients never write these tables. Server-verified writes go through the photo-provenance edge
  function (service role) which re-hashes the stored file before calling evp_record_capture().
  Requires: 20261231000000_job_evidence_chain.sql, 20271210000000_technician_location_privacy.sql.
  Rollback: see docs/photo-provenance.md (drop order for the objects below).
*/

-- =============================================================
-- 0. PREFLIGHT (fail early with a readable message)
-- =============================================================
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.jobs') IS NULL THEN v_missing := v_missing || 'table jobs'; END IF;
  IF to_regclass('public.team_members') IS NULL THEN v_missing := v_missing || 'table team_members'; END IF;
  IF to_regclass('public.job_evidence_chain_entries') IS NULL THEN v_missing := v_missing || 'table job_evidence_chain_entries (20261231000000)'; END IF;
  IF to_regclass('public.location_privacy_policies') IS NULL THEN v_missing := v_missing || 'table location_privacy_policies (20271210000000)'; END IF;
  IF to_regprocedure('public.get_account_owner_id()') IS NULL THEN v_missing := v_missing || 'function get_account_owner_id()'; END IF;
  IF to_regprocedure('public.location_tracking_gate(uuid,timestamptz)') IS NULL THEN v_missing := v_missing || 'function location_tracking_gate(uuid,timestamptz)'; END IF;
  IF to_regprocedure('public.location_privacy_can_manage()') IS NULL THEN v_missing := v_missing || 'function location_privacy_can_manage()'; END IF;
  IF to_regprocedure('public.job_evidence_chain_verify(uuid)') IS NULL THEN v_missing := v_missing || 'function job_evidence_chain_verify(uuid)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'user_id') THEN v_missing := v_missing || 'jobs.user_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'arrived_at') THEN v_missing := v_missing || 'jobs.arrived_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'started_at') THEN v_missing := v_missing || 'jobs.started_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'completed_at') THEN v_missing := v_missing || 'jobs.completed_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'team_members' AND column_name = 'account_owner_id') THEN v_missing := v_missing || 'team_members.account_owner_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'team_members' AND column_name = 'role') THEN v_missing := v_missing || 'team_members.role'; END IF;
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_PREREQUISITES_MISSING: %', array_to_string(v_missing, ', ');
  END IF;
END;
$$;

-- =============================================================
-- 1. POLICY (per account)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.evidence_photo_policies (
  user_id uuid PRIMARY KEY,                        -- account owner
  capture_location boolean NOT NULL DEFAULT false,
  location_retention_days integer NOT NULL DEFAULT 90 CHECK (location_retention_days BETWEEN 1 AND 365),
  photo_retention_days integer NOT NULL DEFAULT 1095 CHECK (photo_retention_days BETWEEN 30 AND 3650),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.evidence_photo_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evp_policies_select" ON public.evidence_photo_policies;
CREATE POLICY "evp_policies_select" ON public.evidence_photo_policies FOR SELECT TO authenticated
  USING (user_id = (select public.get_account_owner_id()));

REVOKE ALL ON public.evidence_photo_policies FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.evidence_photo_policies FROM authenticated;

-- =============================================================
-- 2. CAPTURES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.evidence_photo_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                           -- account owner
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  client_capture_id uuid NOT NULL,                 -- idempotency key generated on the device
  captured_by_user_id uuid,
  captured_by_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  original_path text NOT NULL CHECK (char_length(original_path) BETWEEN 10 AND 400),
  original_bytes bigint NOT NULL CHECK (original_bytes BETWEEN 1 AND 26214400),
  original_mime text NOT NULL CHECK (original_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  capture_source text NOT NULL CHECK (capture_source IN ('in_app_camera', 'gallery_import', 'web_input', 'unknown')),
  device_captured_at timestamptz,
  device_time_status text NOT NULL CHECK (device_time_status IN ('ok', 'missing', 'future', 'stale')),
  offline_queued boolean NOT NULL DEFAULT false,
  client_queued_at timestamptz,
  server_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  loc_status text NOT NULL DEFAULT 'not_requested' CHECK (loc_status IN (
    'recorded', 'not_requested', 'policy_off', 'consent_not_configured', 'no_consent',
    'off_duty', 'outside_job_window', 'invalid', 'purged'
  )),
  location_commit text,                            -- salted commitment; unlinkable once the locations row is deleted
  core_commit text NOT NULL DEFAULT '',
  location_purged_at timestamptz,
  erasure_requested_at timestamptz,
  files_erased_at timestamptz,
  CONSTRAINT evp_cap_unique_client UNIQUE (user_id, client_capture_id),
  CONSTRAINT evp_cap_unique_hash UNIQUE (job_id, original_sha256)
);

CREATE INDEX IF NOT EXISTS idx_evp_captures_job ON public.evidence_photo_captures (job_id, server_received_at);
CREATE INDEX IF NOT EXISTS idx_evp_captures_user_time ON public.evidence_photo_captures (user_id, server_received_at);
CREATE INDEX IF NOT EXISTS idx_evp_captures_actor_time ON public.evidence_photo_captures (captured_by_user_id, server_received_at);
CREATE INDEX IF NOT EXISTS idx_evp_captures_member ON public.evidence_photo_captures (captured_by_member_id) WHERE captured_by_member_id IS NOT NULL;

COMMENT ON TABLE public.evidence_photo_captures IS
  'Immutable photo capture records (sealed into job_evidence_chain_entries). Only location purge and file erasure may change a row.';

-- Canonical commitment over the immutable core of a capture (used by the seal trigger AND the verifier).
CREATE OR REPLACE FUNCTION public.evp_core_commit(c public.evidence_photo_captures)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    'evp1',
    c.id::text,
    c.user_id::text,
    c.job_id::text,
    c.client_capture_id::text,
    coalesce(c.captured_by_user_id::text, ''),
    c.original_sha256,
    c.original_bytes::text,
    c.original_mime,
    c.capture_source,
    coalesce(to_char(c.device_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), ''),
    c.device_time_status,
    c.offline_queued::text,
    coalesce(to_char(c.client_queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), ''),
    to_char(c.server_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

-- Salted commitment over the coordinates; the salt lives only in evidence_photo_locations and is deleted on
-- purge, so the commitment stored in the chain becomes unlinkable to any coordinate.
CREATE OR REPLACE FUNCTION public.evp_location_commit(p_salt text, p_lat numeric, p_lng numeric, p_acc numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', 'evpl1', p_salt, p_lat::text, p_lng::text, coalesce(p_acc::text, '')), 'UTF8')), 'hex');
$$;

-- BEFORE INSERT: server stamps the receipt time and computes the core commitment. The client cannot forge them.
CREATE OR REPLACE FUNCTION public.evp_seal_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.server_received_at := clock_timestamp();
  NEW.core_commit := public.evp_core_commit(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evp_seal_capture ON public.evidence_photo_captures;
CREATE TRIGGER trg_evp_seal_capture
  BEFORE INSERT ON public.evidence_photo_captures
  FOR EACH ROW EXECUTE FUNCTION public.evp_seal_capture();

-- Immutability: only location purge / file erasure columns may change, and only inside a maintenance function.
CREATE OR REPLACE FUNCTION public.evp_captures_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_maintenance boolean := coalesce(current_setting('vireek.evp_maintenance', true), 'off') = 'on';
  v_mutable text[] := ARRAY['loc_status', 'location_purged_at', 'erasure_requested_at', 'files_erased_at', 'captured_by_member_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id) THEN
      RAISE EXCEPTION 'PHOTO_PROVENANCE_IMMUTABLE: capture records cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;                                    -- the whole job was deleted (FK cascade)
  END IF;

  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_IMMUTABLE: only location purge and file erasure may change a capture' USING ERRCODE = 'P0001';
  END IF;
  -- Detaching a removed team member (FK ON DELETE SET NULL) is the one change allowed outside maintenance.
  IF NOT v_maintenance AND (to_jsonb(NEW) - 'captured_by_member_id') IS DISTINCT FROM (to_jsonb(OLD) - 'captured_by_member_id') THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_IMMUTABLE: use the purge / erasure functions' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evp_captures_guard ON public.evidence_photo_captures;
CREATE TRIGGER trg_evp_captures_guard
  BEFORE UPDATE OR DELETE ON public.evidence_photo_captures
  FOR EACH ROW EXECUTE FUNCTION public.evp_captures_guard();

CREATE OR REPLACE FUNCTION public.evp_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PHOTO_PROVENANCE_IMMUTABLE: provenance tables cannot be truncated' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_evp_captures_truncate ON public.evidence_photo_captures;
CREATE TRIGGER trg_evp_captures_truncate
  BEFORE TRUNCATE ON public.evidence_photo_captures
  FOR EACH STATEMENT EXECUTE FUNCTION public.evp_block_truncate();

ALTER TABLE public.evidence_photo_captures ENABLE ROW LEVEL SECURITY;

-- Reads inherit the jobs' own RLS (same model as the evidence chain). Coordinates live in a separate,
-- client-unreadable table (section 2b).
DROP POLICY IF EXISTS "evp_captures_select" ON public.evidence_photo_captures;
CREATE POLICY "evp_captures_select" ON public.evidence_photo_captures FOR SELECT TO authenticated
  USING (
    user_id = (select public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = evidence_photo_captures.job_id)
  );

REVOKE ALL ON public.evidence_photo_captures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.evidence_photo_captures TO authenticated;

-- =============================================================
-- 2b. LOCATIONS (client-unreadable; hard-deleted on purge / retention)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.evidence_photo_locations (
  capture_id uuid PRIMARY KEY REFERENCES public.evidence_photo_captures(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  latitude numeric NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m numeric CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000),
  loc_salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evp_locations_user ON public.evidence_photo_locations (user_id);
CREATE INDEX IF NOT EXISTS idx_evp_locations_job ON public.evidence_photo_locations (job_id);

CREATE OR REPLACE FUNCTION public.evp_locations_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
       coalesce(current_setting('vireek.evp_maintenance', true), 'off') = 'on'
       OR NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id)
     ) THEN
    RETURN OLD;                                    -- purge function, or the whole job was deleted
  END IF;
  RAISE EXCEPTION 'PHOTO_PROVENANCE_IMMUTABLE: coordinates change only through the purge functions' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_evp_locations_guard ON public.evidence_photo_locations;
CREATE TRIGGER trg_evp_locations_guard
  BEFORE UPDATE OR DELETE ON public.evidence_photo_locations
  FOR EACH ROW EXECUTE FUNCTION public.evp_locations_guard();

ALTER TABLE public.evidence_photo_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.evidence_photo_locations FROM PUBLIC, anon, authenticated;
-- No policies on purpose: only SECURITY DEFINER functions touch this table.

-- =============================================================
-- 3. DERIVATIVES (original <-> derived hash mapping)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.evidence_photo_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES public.evidence_photo_captures(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('analysis_resize', 'thumbnail', 'redacted')),
  parent_sha256 text NOT NULL CHECK (parent_sha256 ~ '^[0-9a-f]{64}$'),
  derived_sha256 text NOT NULL CHECK (derived_sha256 ~ '^[0-9a-f]{64}$'),
  derived_path text NOT NULL CHECK (char_length(derived_path) BETWEEN 10 AND 400),
  derived_bytes bigint NOT NULL CHECK (derived_bytes BETWEEN 1 AND 26214400),
  derived_mime text NOT NULL CHECK (derived_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  width integer CHECK (width IS NULL OR width BETWEEN 1 AND 20000),
  height integer CHECK (height IS NULL OR height BETWEEN 1 AND 20000),
  transform jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(transform) = 'object' AND char_length(transform::text) <= 2000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT evp_deriv_unique UNIQUE (capture_id, derived_sha256)
);

CREATE INDEX IF NOT EXISTS idx_evp_derivatives_job ON public.evidence_photo_derivatives (job_id);
CREATE INDEX IF NOT EXISTS idx_evp_derivatives_user ON public.evidence_photo_derivatives (user_id);
CREATE INDEX IF NOT EXISTS idx_evp_derivatives_sha ON public.evidence_photo_derivatives (derived_sha256);

CREATE OR REPLACE FUNCTION public.evp_derivatives_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id) THEN
    RETURN OLD;                                    -- the whole job was deleted (FK cascade)
  END IF;
  RAISE EXCEPTION 'PHOTO_PROVENANCE_IMMUTABLE: derivative records are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_evp_derivatives_guard ON public.evidence_photo_derivatives;
CREATE TRIGGER trg_evp_derivatives_guard
  BEFORE UPDATE OR DELETE ON public.evidence_photo_derivatives
  FOR EACH ROW EXECUTE FUNCTION public.evp_derivatives_guard();

DROP TRIGGER IF EXISTS trg_evp_derivatives_truncate ON public.evidence_photo_derivatives;
CREATE TRIGGER trg_evp_derivatives_truncate
  BEFORE TRUNCATE ON public.evidence_photo_derivatives
  FOR EACH STATEMENT EXECUTE FUNCTION public.evp_block_truncate();

ALTER TABLE public.evidence_photo_derivatives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evp_derivatives_select" ON public.evidence_photo_derivatives;
CREATE POLICY "evp_derivatives_select" ON public.evidence_photo_derivatives FOR SELECT TO authenticated
  USING (
    user_id = (select public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = evidence_photo_derivatives.job_id)
  );

REVOKE ALL ON public.evidence_photo_derivatives FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.evidence_photo_derivatives FROM authenticated;

-- =============================================================
-- 4. SHARES (public verification links)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.evidence_photo_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label text CHECK (label IS NULL OR char_length(label) <= 120),   -- internal only, never shown publicly
  capture_ids uuid[] NOT NULL CHECK (cardinality(capture_ids) BETWEEN 1 AND 50),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_evp_shares_job ON public.evidence_photo_shares (job_id);
CREATE INDEX IF NOT EXISTS idx_evp_shares_user ON public.evidence_photo_shares (user_id);

ALTER TABLE public.evidence_photo_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.evidence_photo_shares FROM PUBLIC, anon, authenticated;
-- No policies on purpose: shares are managed only through the SECURITY DEFINER functions below.

-- =============================================================
-- 5. INTERNAL HELPERS
-- =============================================================

-- Appends one entry to the EXISTING per-job hash chain (same mechanism as record_job_evidence_system,
-- but it can carry media[]). The seal trigger assigns seq / prev_hash / entry_hash / recorded_at.
CREATE OR REPLACE FUNCTION public.evp_append_ledger(
  p_job uuid, p_title text, p_payload jsonb, p_media jsonb, p_actor_type text, p_source_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM set_config('vireek.evidence_system', 'on', true);
  INSERT INTO public.job_evidence_chain_entries (job_id, stage, kind, title, payload, media, actor_type, source_key)
  VALUES (p_job, 'evidence', 'media', left(p_title, 200), coalesce(p_payload, '{}'::jsonb), coalesce(p_media, '[]'::jsonb),
          CASE WHEN p_actor_type IN ('technician', 'staff') THEN p_actor_type ELSE 'staff' END, p_source_key)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  PERFORM set_config('vireek.evidence_system', 'off', true);
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evidence_system', 'off', true);
  RAISE;
END;
$$;

-- Registers one derivative (row + ledger entry). Idempotent on (capture, derived hash).
CREATE OR REPLACE FUNCTION public.evp_add_derivative(
  p_capture uuid, p_actor uuid, p_sha256 text, p_path text, p_bytes bigint, p_mime text,
  p_kind text, p_width integer, p_height integer, p_transform jsonb, p_parent text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap public.evidence_photo_captures%ROWTYPE;
  v_id uuid;
  v_entry uuid;
BEGIN
  SELECT * INTO v_cap FROM public.evidence_photo_captures WHERE id = p_capture;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: unknown capture' USING ERRCODE = 'P0001'; END IF;
  IF v_cap.files_erased_at IS NOT NULL OR v_cap.erasure_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: capture was erased' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind NOT IN ('analysis_resize', 'thumbnail', 'redacted') THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: bad derivative kind' USING ERRCODE = 'P0001';
  END IF;
  IF p_parent IS DISTINCT FROM v_cap.original_sha256 AND NOT EXISTS (
    SELECT 1 FROM public.evidence_photo_derivatives d WHERE d.capture_id = p_capture AND d.derived_sha256 = p_parent
  ) THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: parent hash is not part of this capture' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_id FROM public.evidence_photo_derivatives WHERE capture_id = p_capture AND derived_sha256 = p_sha256;
  IF FOUND THEN RETURN v_id; END IF;

  INSERT INTO public.evidence_photo_derivatives
    (user_id, job_id, capture_id, kind, parent_sha256, derived_sha256, derived_path, derived_bytes, derived_mime,
     width, height, transform, created_by)
  VALUES
    (v_cap.user_id, v_cap.job_id, p_capture, p_kind, p_parent, p_sha256, p_path, p_bytes, p_mime,
     p_width, p_height, coalesce(p_transform, '{}'::jsonb), p_actor)
  RETURNING id INTO v_id;

  v_entry := public.evp_append_ledger(
    v_cap.job_id,
    CASE WHEN p_kind = 'redacted' THEN 'Photo redacted copy registered' ELSE 'Photo derived copy registered' END,
    jsonb_build_object('photo_provenance', jsonb_build_object(
      'v', 1, 'type', 'derivative', 'capture_id', v_cap.id, 'derivative_id', v_id, 'kind', p_kind,
      'original_sha256', v_cap.original_sha256, 'parent_sha256', p_parent, 'derived_sha256', p_sha256,
      'transform', coalesce(p_transform, '{}'::jsonb)
    )),
    '[]'::jsonb, 'staff', 'photoderiv:' || v_id::text
  );
  IF v_entry IS NULL THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_CHAIN: could not append derivative to the evidence chain' USING ERRCODE = 'P0001'; END IF;
  RETURN v_id;
END;
$$;

-- Boolean-only check of the salted location commitment (callers never read coordinates).
-- NULL = no coordinates stored for this capture.
CREATE OR REPLACE FUNCTION public.evp_location_commit_ok(p_capture uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.capture_id IS NOT NULL AND c.location_commit IS NOT DISTINCT FROM
         public.evp_location_commit(l.loc_salt, l.latitude, l.longitude, l.accuracy_m)
  FROM public.evidence_photo_locations l
  JOIN public.evidence_photo_captures c ON c.id = l.capture_id
  WHERE l.capture_id = p_capture;
$$;

-- Accuracy only (no coordinates) — safe for the public verification page.
CREATE OR REPLACE FUNCTION public.evp_location_accuracy(p_capture uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.accuracy_m FROM public.evidence_photo_locations l WHERE l.capture_id = p_capture;
$$;

-- Coordinates for one capture, only for managers of the owning account (never for the public path).
CREATE OR REPLACE FUNCTION public.evp_coordinates(p_capture uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NOT NULL AND public.location_privacy_can_manage()
    THEN jsonb_build_object('latitude', l.latitude, 'longitude', l.longitude)
    ELSE NULL
  END
  FROM public.evidence_photo_locations l
  WHERE l.capture_id = p_capture AND l.user_id = public.get_account_owner_id();
$$;

-- Verified, privacy-safe view of one capture. SECURITY INVOKER: callers see only what RLS lets them see;
-- the public share function runs it as the function owner. p_chain = job_evidence_chain_verify() result.
CREATE OR REPLACE FUNCTION public.evp_capture_view(p_id uuid, p_coords boolean, p_chain jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  c public.evidence_photo_captures%ROWTYPE;
  v_entry public.job_evidence_chain_entries%ROWTYPE;
  v_broken integer := nullif(p_chain ->> 'broken_seq', '')::integer;
  v_chain_ok boolean;
  v_commit_ok boolean := false;
  v_found boolean;
  v_loc_ok boolean;
  v_acc numeric;
  v_integrity boolean;
  v_acc_class text;
  v_derivs jsonb;
  v_status text;
  v_flags jsonb := '[]'::jsonb;
  v_skew bigint;
BEGIN
  SELECT * INTO c FROM public.evidence_photo_captures WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_entry FROM public.job_evidence_chain_entries WHERE job_id = c.job_id AND source_key = 'photo:' || c.id::text;
  v_found := FOUND;
  v_chain_ok := v_found AND (v_broken IS NULL OR v_broken > v_entry.seq);

  IF v_found THEN
    v_commit_ok := c.core_commit = public.evp_core_commit(c)
      AND v_entry.payload #>> '{photo_provenance,core_commit}' = c.core_commit
      AND v_entry.payload #>> '{photo_provenance,original_sha256}' = c.original_sha256
      AND coalesce(v_entry.payload #>> '{photo_provenance,location_commit}', '') = coalesce(c.location_commit, '')
      AND v_entry.media -> 0 ->> 'sha256' = c.original_sha256;
  END IF;

  IF c.loc_status = 'recorded' THEN
    v_loc_ok := coalesce(public.evp_location_commit_ok(c.id), false);   -- recorded but coordinates missing = tampering
    v_acc := public.evp_location_accuracy(c.id);
  END IF;
  v_integrity := v_chain_ok AND v_commit_ok AND coalesce(v_loc_ok, true);

  v_acc_class := CASE
    WHEN v_acc IS NULL OR c.loc_status <> 'recorded' THEN 'unknown'
    WHEN v_acc <= 20 THEN 'high'
    WHEN v_acc <= 100 THEN 'medium'
    ELSE 'low' END;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'kind', d.kind,
    'sha256', d.derived_sha256,
    'parent_sha256', d.parent_sha256,
    'width', d.width,
    'height', d.height,
    'bytes', d.derived_bytes,
    'created_at', d.created_at,
    'modified', d.kind = 'redacted',
    'verified', EXISTS (
      SELECT 1 FROM public.job_evidence_chain_entries e
      WHERE e.job_id = d.job_id AND e.source_key = 'photoderiv:' || d.id::text
        AND e.payload #>> '{photo_provenance,derived_sha256}' = d.derived_sha256
        AND e.payload #>> '{photo_provenance,parent_sha256}' = d.parent_sha256
        AND (v_broken IS NULL OR v_broken > e.seq)
    )
  ) ORDER BY d.created_at), '[]'::jsonb)
  INTO v_derivs
  FROM public.evidence_photo_derivatives d WHERE d.capture_id = c.id;

  IF c.capture_source <> 'in_app_camera' THEN v_flags := v_flags || '"imported"'::jsonb; END IF;
  IF c.offline_queued THEN v_flags := v_flags || '"offline_capture"'::jsonb; END IF;
  IF c.device_time_status <> 'ok' THEN v_flags := v_flags || '"device_time_unreliable"'::jsonb; END IF;

  v_status := CASE
    WHEN NOT v_integrity THEN 'integrity_failed'
    WHEN c.capture_source <> 'in_app_camera' THEN 'imported'
    WHEN c.offline_queued THEN 'offline'
    ELSE 'unmodified' END;

  v_skew := CASE WHEN c.device_captured_at IS NULL THEN NULL
                 ELSE round(extract(epoch FROM (c.server_received_at - c.device_captured_at)))::bigint END;

  RETURN jsonb_build_object(
    'id', c.id,
    'short_id', left(c.id::text, 8),
    'job_id', c.job_id,
    'original_sha256', c.original_sha256,
    'original_bytes', c.original_bytes,
    'original_mime', c.original_mime,
    'capture_source', c.capture_source,
    'device_captured_at', c.device_captured_at,
    'device_time_status', c.device_time_status,
    'server_received_at', c.server_received_at,
    'time_skew_seconds', v_skew,
    'offline_queued', c.offline_queued,
    'client_queued_at', c.client_queued_at,
    'status', v_status,
    'flags', v_flags,
    'location', jsonb_build_object(
      'status', c.loc_status,
      'accuracy_m', CASE WHEN c.loc_status = 'recorded' THEN round(v_acc) ELSE NULL END,
      'accuracy_class', v_acc_class,
      'within_job_window', c.loc_status = 'recorded',
      'purged', c.location_purged_at IS NOT NULL,
      'coordinates', CASE WHEN p_coords THEN public.evp_coordinates(c.id) ELSE NULL END
    ),
    'derivatives', v_derivs,
    'verification', jsonb_build_object(
      'chain_ok', v_chain_ok,
      'commit_ok', v_commit_ok,
      'location_commit_ok', v_loc_ok,
      'entry_seq', v_entry.seq,
      'entry_hash', v_entry.entry_hash,
      'prev_hash', v_entry.prev_hash
    ),
    'files_erased', c.files_erased_at IS NOT NULL,
    'erasure_requested', c.erasure_requested_at IS NOT NULL,
    'captured_by_user_id', CASE WHEN p_coords THEN c.captured_by_user_id ELSE NULL END
  );
END;
$$;

-- =============================================================
-- 6. RECORD A CAPTURE (service role only — called by the photo-provenance edge function
--    AFTER it re-hashed the stored bytes)
-- =============================================================
CREATE OR REPLACE FUNCTION public.evp_record_capture(
  p_owner uuid,
  p_actor uuid,
  p_job uuid,
  p_client_capture_id uuid,
  p_sha256 text,
  p_path text,
  p_bytes bigint,
  p_mime text,
  p_source text,
  p_device_at timestamptz,
  p_offline boolean,
  p_queued_at timestamptz,
  p_location jsonb,
  p_derivatives jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_owner uuid;
  v_arrived timestamptz;
  v_started timestamptz;
  v_completed timestamptz;
  v_member uuid;
  v_role text;
  v_existing uuid;
  v_now timestamptz := clock_timestamp();
  v_dts text;
  v_policy_loc boolean := false;
  v_require_consent boolean := false;
  v_gate text;
  v_loc_status text := 'not_requested';
  v_lat numeric;
  v_lng numeric;
  v_acc numeric;
  v_salt text;
  v_lcommit text;
  v_start timestamptz;
  v_at timestamptz;
  v_cap public.evidence_photo_captures%ROWTYPE;
  v_entry uuid;
  v_d record;
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: bad sha256' USING ERRCODE = 'P0001';
  END IF;
  IF p_source NOT IN ('in_app_camera', 'gallery_import', 'web_input', 'unknown') THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: bad capture source' USING ERRCODE = 'P0001';
  END IF;
  IF p_derivatives IS NOT NULL AND (jsonb_typeof(p_derivatives) <> 'array' OR jsonb_array_length(p_derivatives) > 4) THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: derivatives must be an array of at most 4' USING ERRCODE = 'P0001';
  END IF;

  SELECT user_id, arrived_at, started_at, completed_at
    INTO v_job_owner, v_arrived, v_started, v_completed
  FROM public.jobs WHERE id = p_job;
  IF v_job_owner IS DISTINCT FROM p_owner THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: job is not in this account' USING ERRCODE = '42501';
  END IF;

  SELECT tm.id, tm.role INTO v_member, v_role
  FROM public.team_members tm
  WHERE tm.user_id = p_actor AND tm.account_owner_id = p_owner
  LIMIT 1;
  IF p_actor IS DISTINCT FROM p_owner AND v_member IS NULL THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: caller is not a member of this account' USING ERRCODE = '42501';
  END IF;

  -- Idempotency (retries from the offline queue, double taps, duplicate uploads of the same bytes).
  SELECT id INTO v_existing FROM public.evidence_photo_captures
  WHERE (user_id = p_owner AND client_capture_id = p_client_capture_id) OR (job_id = p_job AND original_sha256 = p_sha256)
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('duplicate', true, 'capture_id', v_existing);
  END IF;

  -- Device-time sanity (stored as claimed, never silently corrected).
  v_dts := CASE
    WHEN p_device_at IS NULL THEN 'missing'
    WHEN p_device_at > v_now + interval '5 minutes' THEN 'future'
    WHEN p_device_at < v_now - interval '30 days' THEN 'stale'
    ELSE 'ok' END;

  -- Location: every gate must pass; otherwise coordinates are discarded (never stored).
  IF p_location IS NOT NULL AND jsonb_typeof(p_location) = 'object' THEN
    SELECT coalesce(capture_location, false) INTO v_policy_loc FROM public.evidence_photo_policies WHERE user_id = p_owner;
    v_policy_loc := coalesce(v_policy_loc, false);

    IF NOT v_policy_loc THEN
      v_loc_status := 'policy_off';
    ELSIF jsonb_typeof(p_location -> 'lat') IS DISTINCT FROM 'number' OR jsonb_typeof(p_location -> 'lng') IS DISTINCT FROM 'number' THEN
      v_loc_status := 'invalid';
    ELSE
      v_lat := (p_location ->> 'lat')::numeric;
      v_lng := (p_location ->> 'lng')::numeric;
      v_acc := CASE WHEN jsonb_typeof(p_location -> 'accuracy_m') = 'number' THEN (p_location ->> 'accuracy_m')::numeric ELSE NULL END;
      IF v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180 OR (v_acc IS NOT NULL AND v_acc NOT BETWEEN 0 AND 100000) THEN
        v_loc_status := 'invalid';
        v_lat := NULL; v_lng := NULL; v_acc := NULL;
      ELSE
        v_lat := round(v_lat, 4);                      -- ~11 m: minimal precision on purpose
        v_lng := round(v_lng, 4);
        v_acc := round(v_acc, 1);
        v_at := coalesce(p_device_at, v_now);
        v_loc_status := 'recorded';
      END IF;
    END IF;

    IF v_loc_status = 'recorded' THEN

      IF v_member IS NOT NULL THEN
        SELECT coalesce(require_consent, false) INTO v_require_consent FROM public.location_privacy_policies WHERE user_id = p_owner;
        v_require_consent := coalesce(v_require_consent, false);
        IF NOT v_require_consent THEN
          v_loc_status := 'consent_not_configured';
        ELSE
          v_gate := public.location_tracking_gate(v_member, v_at);
          IF v_gate = 'no_consent' THEN v_loc_status := 'no_consent';
          ELSIF v_gate = 'off_duty' THEN v_loc_status := 'off_duty';
          END IF;
        END IF;
      END IF;

      IF v_loc_status = 'recorded' THEN
        v_start := coalesce(v_arrived, v_started);
        IF v_start IS NULL OR v_at < v_start - interval '15 minutes' OR v_at > coalesce(v_completed, v_now) + interval '60 minutes' THEN
          v_loc_status := 'outside_job_window';
        END IF;
      END IF;

      IF v_loc_status <> 'recorded' THEN
        v_lat := NULL; v_lng := NULL; v_acc := NULL;
      END IF;
    END IF;
  END IF;

  IF v_loc_status = 'recorded' THEN
    v_salt := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
    v_lcommit := public.evp_location_commit(v_salt, v_lat, v_lng, v_acc);
  END IF;

  BEGIN
    INSERT INTO public.evidence_photo_captures
      (user_id, job_id, client_capture_id, captured_by_user_id, captured_by_member_id,
       original_sha256, original_path, original_bytes, original_mime, capture_source,
       device_captured_at, device_time_status, offline_queued, client_queued_at,
       loc_status, location_commit)
    VALUES
      (p_owner, p_job, p_client_capture_id, p_actor, v_member,
       p_sha256, p_path, p_bytes, p_mime, p_source,
       p_device_at, v_dts, coalesce(p_offline, false), p_queued_at,
       v_loc_status, v_lcommit)
    RETURNING * INTO v_cap;

    IF v_loc_status = 'recorded' THEN
      INSERT INTO public.evidence_photo_locations (capture_id, user_id, job_id, latitude, longitude, accuracy_m, loc_salt)
      VALUES (v_cap.id, p_owner, p_job, v_lat, v_lng, v_acc, v_salt);
    END IF;

    v_entry := public.evp_append_ledger(
      p_job,
      'Photo captured',
      jsonb_build_object('photo_provenance', jsonb_build_object(
        'v', 1, 'type', 'capture', 'capture_id', v_cap.id, 'core_commit', v_cap.core_commit,
        'original_sha256', v_cap.original_sha256, 'capture_source', v_cap.capture_source,
        'device_captured_at', v_cap.device_captured_at, 'device_time_status', v_cap.device_time_status,
        'offline_queued', v_cap.offline_queued, 'server_received_at', v_cap.server_received_at,
        'location_status', v_cap.loc_status, 'location_commit', v_cap.location_commit,
        'captured_by_user_id', v_cap.captured_by_user_id
      )),
      jsonb_build_array(jsonb_build_object(
        'path', v_cap.original_path, 'sha256', v_cap.original_sha256, 'mime', v_cap.original_mime,
        'bytes', v_cap.original_bytes,
        'captured_at', to_char(coalesce(v_cap.device_captured_at, v_cap.server_received_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'name', 'photo-' || left(v_cap.original_sha256, 8)
      )),
      CASE WHEN v_role = 'technician' THEN 'technician' ELSE 'staff' END,
      'photo:' || v_cap.id::text
    );
    IF v_entry IS NULL THEN
      RAISE EXCEPTION 'PHOTO_PROVENANCE_CHAIN: could not append the capture to the evidence chain' USING ERRCODE = 'P0001';
    END IF;

    IF p_derivatives IS NOT NULL THEN
      FOR v_d IN
        SELECT * FROM jsonb_to_recordset(p_derivatives)
          AS x(sha256 text, path text, bytes bigint, mime text, kind text, width integer, height integer, transform jsonb)
      LOOP
        PERFORM public.evp_add_derivative(v_cap.id, p_actor, v_d.sha256, v_d.path, v_d.bytes, v_d.mime,
                                          v_d.kind, v_d.width, v_d.height, v_d.transform, v_cap.original_sha256);
      END LOOP;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Concurrent identical request won the race: return its record.
    SELECT id INTO v_existing FROM public.evidence_photo_captures
    WHERE (user_id = p_owner AND client_capture_id = p_client_capture_id) OR (job_id = p_job AND original_sha256 = p_sha256)
    LIMIT 1;
    RETURN jsonb_build_object('duplicate', true, 'capture_id', v_existing);
  END;

  RETURN jsonb_build_object('duplicate', false, 'capture_id', v_cap.id, 'location_status', v_cap.loc_status,
                            'server_received_at', v_cap.server_received_at, 'device_time_status', v_cap.device_time_status);
END;
$$;

REVOKE ALL ON FUNCTION public.evp_record_capture(uuid, uuid, uuid, uuid, text, text, bigint, text, text, timestamptz, boolean, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evp_record_capture(uuid, uuid, uuid, uuid, text, text, bigint, text, text, timestamptz, boolean, timestamptz, jsonb, jsonb) TO service_role;

-- Registers a later derivative (e.g. a redacted copy). Service role only: the edge function re-hashed the file.
CREATE OR REPLACE FUNCTION public.evp_register_derivative(
  p_owner uuid, p_actor uuid, p_capture uuid, p_sha256 text, p_path text, p_bytes bigint, p_mime text,
  p_kind text, p_width integer, p_height integer, p_transform jsonb, p_parent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_id uuid;
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR p_parent IS NULL OR p_parent !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: bad sha256' USING ERRCODE = 'P0001';
  END IF;
  SELECT user_id INTO v_owner FROM public.evidence_photo_captures WHERE id = p_capture;
  IF v_owner IS DISTINCT FROM p_owner THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: capture is not in this account' USING ERRCODE = '42501';
  END IF;
  IF p_actor IS DISTINCT FROM p_owner AND NOT EXISTS (
    SELECT 1 FROM public.team_members tm WHERE tm.user_id = p_actor AND tm.account_owner_id = p_owner
  ) THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: caller is not a member of this account' USING ERRCODE = '42501';
  END IF;
  v_id := public.evp_add_derivative(p_capture, p_actor, p_sha256, p_path, p_bytes, p_mime, p_kind, p_width, p_height, p_transform, p_parent);
  RETURN jsonb_build_object('derivative_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.evp_register_derivative(uuid, uuid, uuid, text, text, bigint, text, text, integer, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evp_register_derivative(uuid, uuid, uuid, text, text, bigint, text, text, integer, integer, jsonb, text) TO service_role;

-- Throttle helper for the edge function (photos recorded by one user in the last hour).
CREATE OR REPLACE FUNCTION public.evp_recent_capture_count(p_actor uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer FROM public.evidence_photo_captures
  WHERE captured_by_user_id = p_actor AND server_received_at > now() - interval '1 hour';
$$;

REVOKE ALL ON FUNCTION public.evp_recent_capture_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evp_recent_capture_count(uuid) TO service_role;

-- File paths of a capture (original + derivatives) for erasure; service role only.
CREATE OR REPLACE FUNCTION public.evp_capture_file_paths(p_capture uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT array_cat(
    ARRAY(SELECT original_path FROM public.evidence_photo_captures WHERE id = p_capture),
    ARRAY(SELECT derived_path FROM public.evidence_photo_derivatives WHERE capture_id = p_capture)
  );
$$;

REVOKE ALL ON FUNCTION public.evp_capture_file_paths(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evp_capture_file_paths(uuid) TO service_role;

-- =============================================================
-- 7. SETTINGS (signed-in)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_evidence_photo_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pol public.evidence_photo_policies%ROWTYPE;
  v_member uuid;
  v_require boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_pol FROM public.evidence_photo_policies WHERE user_id = v_owner;
  SELECT tm.id INTO v_member FROM public.team_members tm WHERE tm.user_id = auth.uid() AND tm.account_owner_id = v_owner LIMIT 1;
  SELECT coalesce(require_consent, false) INTO v_require FROM public.location_privacy_policies WHERE user_id = v_owner;
  RETURN jsonb_build_object(
    'capture_location', coalesce(v_pol.capture_location, false),
    'location_retention_days', coalesce(v_pol.location_retention_days, 90),
    'photo_retention_days', coalesce(v_pol.photo_retention_days, 1095),
    'consent_required_configured', coalesce(v_require, false),
    'tracking_gate', CASE WHEN v_member IS NULL THEN 'allowed' ELSE public.location_tracking_gate(v_member, now()) END,
    'can_manage', public.location_privacy_can_manage()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_evidence_photo_settings(
  p_capture_location boolean, p_location_retention_days integer, p_photo_retention_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: managers only' USING ERRCODE = '42501';
  END IF;
  IF p_location_retention_days NOT BETWEEN 1 AND 365 OR p_photo_retention_days NOT BETWEEN 30 AND 3650 THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: retention out of range' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.evidence_photo_policies (user_id, capture_location, location_retention_days, photo_retention_days, updated_by, updated_at)
  VALUES (v_owner, coalesce(p_capture_location, false), p_location_retention_days, p_photo_retention_days, auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET capture_location = EXCLUDED.capture_location,
        location_retention_days = EXCLUDED.location_retention_days,
        photo_retention_days = EXCLUDED.photo_retention_days,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();
  RETURN public.get_evidence_photo_settings();
END;
$$;

-- =============================================================
-- 8. SUMMARY (signed-in) — used by the job panel, the PDF export and proposal/dispute attachments
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_evidence_photo_summary(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_chain jsonb;
  v_caps jsonb;
  v_manage boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id) THEN
    RETURN jsonb_build_object('job_id', p_job_id, 'captures', '[]'::jsonb, 'counts', jsonb_build_object('total', 0));
  END IF;
  v_manage := public.location_privacy_can_manage();
  v_chain := public.job_evidence_chain_verify(p_job_id);

  SELECT coalesce(jsonb_agg(v ORDER BY v ->> 'server_received_at'), '[]'::jsonb) INTO v_caps
  FROM (
    SELECT public.evp_capture_view(c.id, v_manage, v_chain) AS v
    FROM public.evidence_photo_captures c WHERE c.job_id = p_job_id
  ) s WHERE v IS NOT NULL;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'chain_valid', coalesce((v_chain ->> 'valid')::boolean, false),
    'captures', v_caps,
    'counts', jsonb_build_object(
      'total', jsonb_array_length(v_caps),
      'unmodified', (SELECT count(*) FROM jsonb_array_elements(v_caps) e WHERE e ->> 'status' = 'unmodified'),
      'imported', (SELECT count(*) FROM jsonb_array_elements(v_caps) e WHERE e ->> 'status' = 'imported'),
      'offline', (SELECT count(*) FROM jsonb_array_elements(v_caps) e WHERE e ->> 'status' = 'offline'),
      'integrity_failed', (SELECT count(*) FROM jsonb_array_elements(v_caps) e WHERE e ->> 'status' = 'integrity_failed'),
      'with_location', (SELECT count(*) FROM jsonb_array_elements(v_caps) e WHERE e #>> '{location,status}' = 'recorded')
    )
  );
END;
$$;

-- =============================================================
-- 9. SHARES
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_evidence_photo_share(
  p_job_id uuid, p_capture_ids uuid[], p_ttl_days integer DEFAULT 30, p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_token text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: managers only' USING ERRCODE = '42501';
  END IF;
  IF p_ttl_days IS NULL OR p_ttl_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: ttl must be 1-365 days' USING ERRCODE = 'P0001';
  END IF;
  IF p_capture_ids IS NULL OR cardinality(p_capture_ids) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: choose 1-50 photos' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: job is not in this account' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.evidence_photo_captures
      WHERE job_id = p_job_id AND user_id = v_owner AND id = ANY (p_capture_ids))
     <> (SELECT count(DISTINCT x) FROM unnest(p_capture_ids) x) THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: every photo must belong to this job' USING ERRCODE = 'P0001';
  END IF;

  v_token := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  v_exp := now() + make_interval(days => p_ttl_days);
  INSERT INTO public.evidence_photo_shares (user_id, job_id, token_hash, label, capture_ids, expires_at, created_by)
  VALUES (v_owner, p_job_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), left(p_label, 120),
          ARRAY(SELECT DISTINCT x FROM unnest(p_capture_ids) x), v_exp, auth.uid())
  RETURNING id INTO v_id;

  -- The plain token is returned exactly once; only its hash is stored.
  RETURN jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_evidence_photo_shares(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: managers only' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'label', s.label, 'photos', cardinality(s.capture_ids), 'created_at', s.created_at,
      'expires_at', s.expires_at, 'revoked_at', s.revoked_at, 'view_count', s.view_count, 'last_viewed_at', s.last_viewed_at
    ) ORDER BY s.created_at DESC)
    FROM public.evidence_photo_shares s WHERE s.job_id = p_job_id AND s.user_id = v_owner
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_evidence_photo_share(p_share_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: managers only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.evidence_photo_shares SET revoked_at = now()
  WHERE id = p_share_id AND user_id = v_owner AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- PUBLIC, no login. Returns only integrity facts: hashes, timestamps, source flags, location ACCURACY class
-- (never coordinates), derivative hashes. No customer, address, technician or job-label data, no image bytes.
CREATE OR REPLACE FUNCTION public.verify_evidence_photo_share(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_share public.evidence_photo_shares%ROWTYPE;
  v_chain jsonb;
  v_caps jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  SELECT * INTO v_share FROM public.evidence_photo_shares
  WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF v_share.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('found', true, 'state', 'revoked'); END IF;
  IF v_share.expires_at <= now() THEN RETURN jsonb_build_object('found', true, 'state', 'expired'); END IF;

  UPDATE public.evidence_photo_shares SET view_count = view_count + 1, last_viewed_at = now() WHERE id = v_share.id;

  v_chain := public.job_evidence_chain_verify(v_share.job_id);
  SELECT coalesce(jsonb_agg(v - 'job_id' ORDER BY v ->> 'server_received_at'), '[]'::jsonb) INTO v_caps
  FROM (
    SELECT public.evp_capture_view(c.id, false, v_chain) AS v
    FROM public.evidence_photo_captures c
    WHERE c.job_id = v_share.job_id AND c.id = ANY (v_share.capture_ids)
  ) s WHERE v IS NOT NULL;

  RETURN jsonb_build_object(
    'found', true,
    'state', 'active',
    'issued_at', v_share.created_at,
    'expires_at', v_share.expires_at,
    'chain_valid', coalesce((v_chain ->> 'valid')::boolean, false),
    'captures', v_caps
  );
END;
$$;

-- =============================================================
-- 10. PRIVACY: purge / erasure / retention
-- =============================================================
CREATE OR REPLACE FUNCTION public.purge_evidence_photo_location(p_capture_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('vireek.evp_maintenance', 'on', true);
  UPDATE public.evidence_photo_captures
     SET loc_status = 'purged', location_purged_at = now()
   WHERE id = p_capture_id AND user_id = v_owner AND loc_status = 'recorded'
     AND (captured_by_user_id = auth.uid() OR public.location_privacy_can_manage());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.evidence_photo_locations WHERE capture_id = p_capture_id AND user_id = v_owner AND v_n > 0;
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RETURN v_n > 0;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RAISE;
END;
$$;

-- "Delete on request" for a technician: purge every stored photo location of one team member.
CREATE OR REPLACE FUNCTION public.purge_evidence_photo_locations_for_member(p_member uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.location_privacy_can_manage() THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN: managers only' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('vireek.evp_maintenance', 'on', true);
  DELETE FROM public.evidence_photo_locations l
   USING public.evidence_photo_captures c
   WHERE l.capture_id = c.id AND c.user_id = v_owner AND c.captured_by_member_id = p_member;
  UPDATE public.evidence_photo_captures
     SET loc_status = 'purged', location_purged_at = now()
   WHERE user_id = v_owner AND captured_by_member_id = p_member AND loc_status = 'recorded';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RETURN v_n;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RAISE;
END;
$$;

-- Step 1 of file erasure (signed-in): purge location now and mark the capture for file removal.
-- The edge function then deletes the stored files and calls evp_mark_files_erased().
CREATE OR REPLACE FUNCTION public.request_evidence_photo_erasure(p_capture_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('vireek.evp_maintenance', 'on', true);
  UPDATE public.evidence_photo_captures
     SET loc_status = CASE WHEN loc_status = 'recorded' THEN 'purged' ELSE loc_status END,
         location_purged_at = coalesce(location_purged_at, CASE WHEN loc_status = 'recorded' THEN now() END),
         erasure_requested_at = coalesce(erasure_requested_at, now())
   WHERE id = p_capture_id AND user_id = v_owner
     AND (captured_by_user_id = auth.uid() OR public.location_privacy_can_manage());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.evidence_photo_locations WHERE capture_id = p_capture_id AND user_id = v_owner AND v_n > 0;
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RETURN v_n > 0;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.evp_mark_files_erased(p_capture_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('vireek.evp_maintenance', 'on', true);
  UPDATE public.evidence_photo_captures
     SET files_erased_at = now()
   WHERE id = p_capture_id AND erasure_requested_at IS NOT NULL AND files_erased_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RETURN v_n > 0;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RAISE;
END;
$$;

-- Retention sweep (service role / cron): purges expired coordinates, marks expired photos for erasure and
-- returns the capture ids whose FILES still have to be deleted by the edge function.
CREATE OR REPLACE FUNCTION public.evp_retention_sweep(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loc integer := 0;
  v_ids uuid[];
BEGIN
  PERFORM set_config('vireek.evp_maintenance', 'on', true);

  WITH gone AS (
    DELETE FROM public.evidence_photo_locations l
     USING public.evidence_photo_captures c, public.evidence_photo_policies p
     WHERE l.capture_id = c.id AND p.user_id = c.user_id
       AND c.server_received_at < now() - make_interval(days => p.location_retention_days)
    RETURNING l.capture_id
  )
  UPDATE public.evidence_photo_captures c
     SET loc_status = 'purged', location_purged_at = now()
    FROM gone WHERE c.id = gone.capture_id AND c.loc_status = 'recorded';
  GET DIAGNOSTICS v_loc = ROW_COUNT;

  WITH due AS (
    SELECT c.id FROM public.evidence_photo_captures c
    JOIN public.evidence_photo_policies p ON p.user_id = c.user_id
    WHERE c.files_erased_at IS NULL AND c.server_received_at < now() - make_interval(days => p.photo_retention_days)
    ORDER BY c.server_received_at
    LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
  ), loc AS (
    DELETE FROM public.evidence_photo_locations l USING due WHERE l.capture_id = due.id RETURNING l.capture_id
  ), marked AS (
    UPDATE public.evidence_photo_captures c
       SET erasure_requested_at = coalesce(c.erasure_requested_at, now()),
           loc_status = CASE WHEN c.loc_status = 'recorded' THEN 'purged' ELSE c.loc_status END,
           location_purged_at = coalesce(c.location_purged_at, CASE WHEN c.loc_status = 'recorded' THEN now() END)
      FROM due WHERE c.id = due.id
    RETURNING c.id
  )
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_ids FROM marked;

  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RETURN jsonb_build_object('locations_purged', v_loc, 'erase_capture_ids', to_jsonb(v_ids));
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vireek.evp_maintenance', 'off', true);
  RAISE;
END;
$$;

-- =============================================================
-- 11. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.evp_append_ledger(uuid, text, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evp_add_derivative(uuid, uuid, text, text, bigint, text, text, integer, integer, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evp_location_commit_ok(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.evp_coordinates(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.evp_location_accuracy(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.evp_capture_view(uuid, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_evidence_photo_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_evidence_photo_settings(boolean, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_evidence_photo_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_evidence_photo_share(uuid, uuid[], integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_evidence_photo_shares(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_evidence_photo_share(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_evidence_photo_location(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_evidence_photo_locations_for_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_evidence_photo_erasure(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.evp_mark_files_erased(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evp_retention_sweep(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_evidence_photo_share(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.evp_core_commit(public.evidence_photo_captures) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.evp_location_commit(text, numeric, numeric, numeric) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.evp_location_commit_ok(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evp_coordinates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evp_location_accuracy(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evp_capture_view(uuid, boolean, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evp_core_commit(public.evidence_photo_captures) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.evp_location_commit(text, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_evidence_photo_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_evidence_photo_settings(boolean, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_evidence_photo_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_evidence_photo_share(uuid, uuid[], integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_evidence_photo_shares(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_evidence_photo_share(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_evidence_photo_location(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_evidence_photo_locations_for_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_evidence_photo_erasure(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evp_mark_files_erased(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.evp_retention_sweep(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_evidence_photo_share(text) TO anon, authenticated;
