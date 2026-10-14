/*
  # VIREEK Universal Identity Layer

  One global identity graph for the whole Vireek ecosystem:
    Person · Company · Property · Equipment · Service · Technician · Contractor · Part · Agent · Outcome · Evidence · Transaction

  Every entity gets:
    - an IMMUTABLE universal ID  (uid)      VRK-EQP-8F3K2M9QX7T4N6BA-7Q  (type code + 80 random bits + 2-char checksum)
    - relationships              (temporal, typed, validated against a registry)
    - provenance                 (append-only: who/what asserted each claim, how, how confident)
    - permissions                (tenant isolation + explicit, expiring, purpose-bound grants; agent grants)
    - lifecycle                  (draft/active/suspended/disputed/retired/merged/erased, enforced in the database)
    - history                    (per-entity SHA-256 hash chain; payloads live in an erasable side table so GDPR
                                  erasure never breaks chain verification)

  ADDITIVE ONLY. Nothing existing is altered. Operational tables (customers, customer_sites, equipment, jobs,
  job_outcomes, job_evidence_chain_entries, invoices, team_members, marketplace_agent_installs) are only READ by
  the sync logic and gain one AFTER trigger each that can never block a write (errors become WARNINGs).

  Kill switch (per session / database):   ALTER DATABASE postgres SET vireek.identity_autoregister = 'off';
  Remove triggers entirely:               see the "UNINSTALL" note at the bottom of this file.

  Clients: SELECT only on the tables (RLS, tenant-scoped). All writes go through SECURITY DEFINER RPCs below.
  Cross-tenant sharing is RPC-only so attribute-level redaction can never be bypassed with a direct SELECT.
*/

-- =============================================================
-- 0. PURE HELPERS (uid format, checksum, state machine)
-- =============================================================

CREATE OR REPLACE FUNCTION public.identity_type_code(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'person' THEN 'PER' WHEN 'company' THEN 'CMP' WHEN 'property' THEN 'PRP' WHEN 'equipment' THEN 'EQP'
    WHEN 'service' THEN 'SVC' WHEN 'technician' THEN 'TEC' WHEN 'contractor' THEN 'CTR' WHEN 'part' THEN 'PRT'
    WHEN 'agent' THEN 'AGT' WHEN 'outcome' THEN 'OUT' WHEN 'evidence' THEN 'EVD' WHEN 'transaction' THEN 'TXN'
  END;
$$;

-- Crockford base32 (no I, L, O, U). 10 bytes -> 16 chars.
CREATE OR REPLACE FUNCTION public.identity_b32(p_bytes bytea)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_acc bigint := 0; v_bits int := 0; v_out text := ''; i int;
BEGIN
  FOR i IN 0 .. length(p_bytes) - 1 LOOP
    v_acc := (v_acc << 8) | get_byte(p_bytes, i);
    v_bits := v_bits + 8;
    WHILE v_bits >= 5 LOOP
      v_out := v_out || substr(v_alphabet, (((v_acc >> (v_bits - 5)) & 31)::int) + 1, 1);
      v_bits := v_bits - 5;
    END LOOP;
    v_acc := v_acc & ((1::bigint << v_bits) - 1);
  END LOOP;
  RETURN v_out;
END;
$$;

-- Weighted ASCII sum mod 1024 over (typeCode || body), written as 2 base32 chars. Mirrored in src/lib/universalIdentity.ts.
CREATE OR REPLACE FUNCTION public.identity_checksum(p_compact text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_sum int := 0; v_chk int; i int;
BEGIN
  FOR i IN 1 .. length(p_compact) LOOP
    v_sum := v_sum + ascii(substr(p_compact, i, 1)) * i;
  END LOOP;
  v_chk := v_sum % 1024;
  RETURN substr(v_alphabet, (v_chk / 32) + 1, 1) || substr(v_alphabet, (v_chk % 32) + 1, 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_new_uid(p_type text)
RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_code text := public.identity_type_code(p_type);
  v_raw bytea; v_body text;
BEGIN
  IF v_code IS NULL THEN RAISE EXCEPTION 'invalid_entity_type' USING ERRCODE = '22023'; END IF;
  -- bytes 0-5 and 9-12 of a v4 uuid are fully random (bytes 6 and 8 carry version/variant bits)
  v_raw := uuid_send(gen_random_uuid());
  v_body := public.identity_b32(substring(v_raw FROM 1 FOR 6) || substring(v_raw FROM 10 FOR 4));
  RETURN 'VRK-' || v_code || '-' || v_body || '-' || public.identity_checksum(v_code || v_body);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_uid_valid(p_uid text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_uid ~ '^VRK-(PER|CMP|PRP|EQP|SVC|TEC|CTR|PRT|AGT|OUT|EVD|TXN)-[0-9A-HJKMNP-TV-Z]{16}-[0-9A-HJKMNP-TV-Z]{2}$'
     AND public.identity_checksum(substr(p_uid, 5, 3) || substr(p_uid, 9, 16)) = substr(p_uid, 26, 2);
$$;

CREATE OR REPLACE FUNCTION public.identity_transition_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = 'erased' THEN false
    WHEN p_to = 'erased' THEN true
    WHEN p_from = 'merged' THEN false
    WHEN p_to = 'merged' THEN p_from IN ('draft', 'active', 'suspended', 'disputed')
    WHEN p_from = 'draft' THEN p_to IN ('active', 'retired')
    WHEN p_from = 'active' THEN p_to IN ('suspended', 'disputed', 'retired')
    WHEN p_from = 'suspended' THEN p_to IN ('active', 'disputed', 'retired')
    WHEN p_from = 'disputed' THEN p_to IN ('active', 'suspended', 'retired')
    WHEN p_from = 'retired' THEN p_to = 'active'
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.identity_default_confidence(p_source_type text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_source_type
    WHEN 'authoritative' THEN 0.97 WHEN 'sensor' THEN 0.85 WHEN 'document' THEN 0.80 WHEN 'customer_attested' THEN 0.75
    WHEN 'system_derived' THEN 0.70 WHEN 'third_party' THEN 0.70 WHEN 'import' THEN 0.60 WHEN 'user_entry' THEN 0.60
    WHEN 'ai_inference' THEN 0.45 ELSE 0.50 END::numeric;
$$;

CREATE OR REPLACE FUNCTION public.identity_assurance_for(p_source_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_source_type
    WHEN 'authoritative' THEN 'authoritative'
    WHEN 'system_derived' THEN 'system_derived' WHEN 'sensor' THEN 'system_derived'
    WHEN 'document' THEN 'verified' WHEN 'customer_attested' THEN 'verified' WHEN 'third_party' THEN 'verified'
    WHEN 'user_entry' THEN 'self_asserted' WHEN 'import' THEN 'self_asserted'
    ELSE 'unverified' END;
$$;

CREATE OR REPLACE FUNCTION public.identity_jwt_role()
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  BEGIN
    v := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  EXCEPTION WHEN OTHERS THEN v := NULL;
  END;
  RETURN coalesce(v, nullif(current_setting('request.jwt.claim.role', true), ''), '');
END;
$$;

-- Same semantics as the manager helper of the Technician Identity Graph, but self-contained (no cross-migration dependency).
CREATE OR REPLACE FUNCTION public.identity_layer_is_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
      OR EXISTS (
        SELECT 1 FROM team_members m
        WHERE m.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
          AND m.invite_status = 'active'
          AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
      );
$$;

CREATE OR REPLACE FUNCTION public.identity_require_owner()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  v := public.get_account_owner_id();
  IF v IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  RETURN v;
END;
$$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.identity_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid text NOT NULL UNIQUE
    CHECK (uid ~ '^VRK-(PER|CMP|PRP|EQP|SVC|TEC|CTR|PRT|AGT|OUT|EVD|TXN)-[0-9A-HJKMNP-TV-Z]{16}-[0-9A-HJKMNP-TV-Z]{2}$'),
  entity_type text NOT NULL CHECK (entity_type IN (
    'person', 'company', 'property', 'equipment', 'service', 'technician', 'contractor', 'part', 'agent', 'outcome', 'evidence', 'transaction')),
  scope text NOT NULL DEFAULT 'tenant' CHECK (scope IN ('tenant', 'global')),
  owner_user_id uuid,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object' AND pg_column_size(attributes) <= 32768),
  lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('draft', 'active', 'suspended', 'disputed', 'retired', 'merged', 'erased')),
  lifecycle_reason text CHECK (lifecycle_reason IS NULL OR char_length(lifecycle_reason) <= 500),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  merged_into_id uuid REFERENCES public.identity_entities(id),
  confidence numeric(3, 2) NOT NULL DEFAULT 0.50 CHECK (confidence BETWEEN 0 AND 1),
  assurance text NOT NULL DEFAULT 'unverified'
    CHECK (assurance IN ('unverified', 'self_asserted', 'system_derived', 'verified', 'authoritative')),
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  erased_at timestamptz,
  CONSTRAINT identity_entities_scope_owner CHECK (
    (scope = 'tenant' AND owner_user_id IS NOT NULL) OR (scope = 'global' AND owner_user_id IS NULL)),
  CONSTRAINT identity_entities_merge_target CHECK ((lifecycle_state = 'merged') = (merged_into_id IS NOT NULL)),
  CONSTRAINT identity_entities_no_self_merge CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_identity_entities_owner_type ON public.identity_entities (owner_user_id, entity_type, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_identity_entities_owner_name ON public.identity_entities (owner_user_id, lower(display_name));
CREATE INDEX IF NOT EXISTS idx_identity_entities_global ON public.identity_entities (entity_type, lower(display_name)) WHERE scope = 'global';
CREATE INDEX IF NOT EXISTS idx_identity_entities_merged ON public.identity_entities (merged_into_id) WHERE merged_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.identity_external_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES public.identity_entities(id),
  owner_user_id uuid,
  system text NOT NULL CHECK (system ~ '^[a-z0-9_]{2,40}$'),
  ref_type text NOT NULL CHECK (ref_type ~ '^[a-z0-9_]{1,40}$'),
  ref_value text NOT NULL CHECK (char_length(ref_value) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_refs_active
  ON public.identity_external_refs ((coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid)), system, ref_type, ref_value)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_identity_refs_entity ON public.identity_external_refs (entity_id);

-- Registry of allowed relationship types (shared, read-only for clients).
CREATE TABLE IF NOT EXISTS public.identity_relationship_types (
  rel_type text NOT NULL CHECK (rel_type ~ '^[a-z_]{2,40}$'),
  src_type text NOT NULL,
  dst_type text NOT NULL,
  label text NOT NULL,
  inverse_label text NOT NULL,
  acyclic boolean NOT NULL DEFAULT false,
  single_active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (rel_type, src_type, dst_type)
);

CREATE TABLE IF NOT EXISTS public.identity_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  src_id uuid NOT NULL REFERENCES public.identity_entities(id),
  dst_id uuid NOT NULL REFERENCES public.identity_entities(id),
  rel_type text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object' AND pg_column_size(attributes) <= 8192),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  confidence numeric(3, 2) NOT NULL DEFAULT 0.50 CHECK (confidence BETWEEN 0 AND 1),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason text CHECK (ended_reason IS NULL OR char_length(ended_reason) <= 300),
  CONSTRAINT identity_rel_no_self CHECK (src_id <> dst_id),
  CONSTRAINT identity_rel_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT identity_rel_ended_consistent CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_rel_active ON public.identity_relationships (owner_user_id, src_id, dst_id, rel_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_identity_rel_src ON public.identity_relationships (owner_user_id, src_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_identity_rel_dst ON public.identity_relationships (owner_user_id, dst_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.identity_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid,
  entity_id uuid NOT NULL REFERENCES public.identity_entities(id),
  relationship_id uuid REFERENCES public.identity_relationships(id),
  claim_path text NOT NULL DEFAULT '*' CHECK (char_length(claim_path) <= 120),
  source_type text NOT NULL CHECK (source_type IN (
    'user_entry', 'system_derived', 'import', 'sensor', 'document', 'customer_attested', 'third_party', 'ai_inference', 'authoritative')),
  source_system text CHECK (source_system IS NULL OR char_length(source_system) <= 60),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 300),
  method text CHECK (method IS NULL OR char_length(method) <= 120),
  actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'technician', 'customer', 'agent', 'system', 'third_party')),
  actor_user_id uuid,
  evidence_entity_id uuid REFERENCES public.identity_entities(id),
  confidence numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  observed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_prov_entity ON public.identity_provenance (entity_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.identity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES public.identity_entities(id),
  owner_user_id uuid,
  seq integer NOT NULL CHECK (seq >= 1),
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'attributes_changed', 'state_changed', 'relationship_added', 'relationship_ended',
    'ref_added', 'ref_retired', 'grant_issued', 'grant_revoked', 'merged_into', 'merged_from', 'erased')),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'technician', 'customer', 'agent', 'system', 'third_party')),
  actor_user_id uuid,
  related_entity_id uuid,
  relationship_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  diff_keys text[] NOT NULL DEFAULT '{}',
  payload_hash text NOT NULL,
  prev_hash text NOT NULL,
  event_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (entity_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_identity_events_owner ON public.identity_events (owner_user_id, occurred_at DESC);

-- Erasable payloads (may contain personal data). The chain only commits to payload_hash, so deleting these never breaks verification.
CREATE TABLE IF NOT EXISTS public.identity_event_payloads (
  event_id uuid PRIMARY KEY REFERENCES public.identity_events(id),
  owner_user_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.identity_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES public.identity_entities(id),
  owner_user_id uuid NOT NULL,
  grantee_kind text NOT NULL CHECK (grantee_kind IN ('tenant', 'agent')),
  grantee_id uuid NOT NULL,
  actions text[] NOT NULL
    CHECK (cardinality(actions) BETWEEN 1 AND 4 AND actions <@ ARRAY['read', 'read_attributes', 'link', 'write']::text[]),
  purpose text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 3 AND 300),
  expires_at timestamptz,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_grants_active ON public.identity_grants (entity_id, grantee_kind, grantee_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_identity_grants_grantee ON public.identity_grants (grantee_kind, grantee_id) WHERE revoked_at IS NULL;

-- =============================================================
-- 2. GUARDS (immutability, state machine, append-only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.identity_entities_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.identity_jwt_role() IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'identity_is_immutable' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.lifecycle_state = 'erased' THEN RAISE EXCEPTION 'entity_erased' USING ERRCODE = '42501'; END IF;
  IF NEW.id <> OLD.id OR NEW.uid <> OLD.uid OR NEW.entity_type <> OLD.entity_type OR NEW.scope <> OLD.scope
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identity_is_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.lifecycle_state <> OLD.lifecycle_state THEN
    IF NOT public.identity_transition_allowed(OLD.lifecycle_state, NEW.lifecycle_state) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
    END IF;
    NEW.state_changed_at := now();
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_identity_entities_guard ON public.identity_entities;
CREATE TRIGGER trg_identity_entities_guard BEFORE UPDATE OR DELETE ON public.identity_entities
  FOR EACH ROW EXECUTE FUNCTION public.identity_entities_guard();

CREATE OR REPLACE FUNCTION public.identity_rel_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'identity_is_immutable' USING ERRCODE = '42501'; END IF;
  IF NEW.owner_user_id <> OLD.owner_user_id OR NEW.rel_type <> OLD.rel_type OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identity_is_immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'ended' AND (NEW.status <> 'ended' OR NEW.src_id <> OLD.src_id OR NEW.dst_id <> OLD.dst_id) THEN
    RAISE EXCEPTION 'relationship_ended' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_identity_rel_guard ON public.identity_relationships;
CREATE TRIGGER trg_identity_rel_guard BEFORE UPDATE OR DELETE ON public.identity_relationships
  FOR EACH ROW EXECUTE FUNCTION public.identity_rel_guard();

CREATE OR REPLACE FUNCTION public.identity_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_ledger' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_identity_events_append_only ON public.identity_events;
CREATE TRIGGER trg_identity_events_append_only BEFORE UPDATE OR DELETE ON public.identity_events
  FOR EACH ROW EXECUTE FUNCTION public.identity_append_only_guard();
DROP TRIGGER IF EXISTS trg_identity_prov_append_only ON public.identity_provenance;
CREATE TRIGGER trg_identity_prov_append_only BEFORE UPDATE OR DELETE ON public.identity_provenance
  FOR EACH ROW EXECUTE FUNCTION public.identity_append_only_guard();

-- =============================================================
-- 3. RLS (SELECT only for clients, tenant-scoped)
-- =============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity_entities', 'identity_external_refs', 'identity_relationship_types', 'identity_relationships',
                           'identity_provenance', 'identity_events', 'identity_event_payloads', 'identity_grants'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS identity_entities_select ON public.identity_entities;
CREATE POLICY identity_entities_select ON public.identity_entities FOR SELECT TO authenticated
  USING (scope = 'global' OR owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS identity_refs_select ON public.identity_external_refs;
CREATE POLICY identity_refs_select ON public.identity_external_refs FOR SELECT TO authenticated
  USING (owner_user_id IS NULL OR owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS identity_reltypes_select ON public.identity_relationship_types;
CREATE POLICY identity_reltypes_select ON public.identity_relationship_types FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS identity_rel_select ON public.identity_relationships;
CREATE POLICY identity_rel_select ON public.identity_relationships FOR SELECT TO authenticated
  USING (owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS identity_prov_select ON public.identity_provenance;
CREATE POLICY identity_prov_select ON public.identity_provenance FOR SELECT TO authenticated
  USING (owner_user_id IS NULL OR owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS identity_events_select ON public.identity_events;
CREATE POLICY identity_events_select ON public.identity_events FOR SELECT TO authenticated
  USING (owner_user_id IS NULL OR owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS identity_payloads_select ON public.identity_event_payloads;
CREATE POLICY identity_payloads_select ON public.identity_event_payloads FOR SELECT TO authenticated
  USING (owner_user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS identity_grants_select ON public.identity_grants;
CREATE POLICY identity_grants_select ON public.identity_grants FOR SELECT TO authenticated
  USING (owner_user_id = public.get_account_owner_id()
         OR (grantee_kind = 'tenant' AND grantee_id = public.get_account_owner_id()));

-- =============================================================
-- 4. RELATIONSHIP REGISTRY (seed)
-- =============================================================

INSERT INTO public.identity_relationship_types (rel_type, src_type, dst_type, label, inverse_label, acyclic, single_active) VALUES
  ('owns', 'person', 'property', 'owns', 'owned by', false, false),
  ('owns', 'company', 'property', 'owns', 'owned by', false, false),
  ('owns', 'person', 'equipment', 'owns', 'owned by', false, false),
  ('owns', 'company', 'equipment', 'owns', 'owned by', false, false),
  ('has_site', 'person', 'property', 'has service site', 'service site of', false, false),
  ('has_site', 'company', 'property', 'has service site', 'service site of', false, false),
  ('located_at', 'equipment', 'property', 'located at', 'hosts', false, true),
  ('component_of', 'equipment', 'equipment', 'component of', 'has component', true, true),
  ('installed_in', 'part', 'equipment', 'installed in', 'contains part', false, false),
  ('part_of', 'property', 'property', 'part of', 'contains', true, true),
  ('subsidiary_of', 'company', 'company', 'subsidiary of', 'parent of', true, true),
  ('employs', 'company', 'technician', 'employs', 'employed by', false, false),
  ('employs', 'company', 'person', 'employs', 'employed by', false, false),
  ('identifies_as', 'technician', 'person', 'is the person', 'works as technician', false, true),
  ('works_for', 'technician', 'company', 'works for', 'has technician', false, false),
  ('backed_by', 'contractor', 'company', 'backed by', 'backs contractor', false, true),
  ('backed_by', 'contractor', 'person', 'backed by', 'backs contractor', false, true),
  ('subcontracts_to', 'company', 'contractor', 'subcontracts to', 'subcontracted by', false, false),
  ('subcontracted_to', 'service', 'contractor', 'subcontracted to', 'subcontracted on', false, false),
  ('performed_by', 'service', 'technician', 'performed by', 'performed', false, true),
  ('assisted_by', 'service', 'agent', 'assisted by', 'assisted', false, false),
  ('performed_on', 'service', 'equipment', 'performed on', 'serviced by', false, false),
  ('performed_on', 'service', 'property', 'performed at', 'serviced by', false, false),
  ('requested_by', 'service', 'person', 'requested by', 'requested', false, true),
  ('requested_by', 'service', 'company', 'requested by', 'requested', false, true),
  ('used_part', 'service', 'part', 'used part', 'used in service', false, false),
  ('produced', 'service', 'outcome', 'produced', 'produced by', false, false),
  ('evidences', 'evidence', 'service', 'evidences', 'evidenced by', false, false),
  ('evidences', 'evidence', 'outcome', 'evidences', 'evidenced by', false, false),
  ('evidences', 'evidence', 'equipment', 'evidences', 'evidenced by', false, false),
  ('evidences', 'evidence', 'property', 'evidences', 'evidenced by', false, false),
  ('evidences', 'evidence', 'transaction', 'evidences', 'evidenced by', false, false),
  ('captured_by', 'evidence', 'technician', 'captured by', 'captured', false, true),
  ('captured_by', 'evidence', 'agent', 'captured by', 'captured', false, true),
  ('captured_by', 'evidence', 'person', 'captured by', 'captured', false, true),
  ('supersedes', 'evidence', 'evidence', 'supersedes', 'superseded by', true, false),
  ('supersedes', 'outcome', 'outcome', 'supersedes', 'superseded by', true, false),
  ('settles', 'transaction', 'service', 'settles', 'settled by', false, false),
  ('billed_to', 'transaction', 'person', 'billed to', 'billed', false, true),
  ('billed_to', 'transaction', 'company', 'billed to', 'billed', false, true),
  ('paid_to', 'transaction', 'company', 'paid to', 'received payment', false, true),
  ('paid_to', 'transaction', 'contractor', 'paid to', 'received payment', false, true),
  ('manufactured_by', 'equipment', 'company', 'manufactured by', 'manufactures', false, true),
  ('manufactured_by', 'part', 'company', 'manufactured by', 'manufactures', false, true),
  ('authorized_by', 'agent', 'company', 'authorized by', 'authorizes agent', false, false),
  ('operated_by', 'agent', 'company', 'operated by', 'operates', false, true),
  ('operated_by', 'agent', 'person', 'operated by', 'operates', false, true),
  ('acted_on', 'agent', 'person', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'company', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'property', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'equipment', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'service', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'outcome', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'evidence', 'acted on', 'acted on by', false, false),
  ('acted_on', 'agent', 'transaction', 'acted on', 'acted on by', false, false)
ON CONFLICT DO NOTHING;

-- =============================================================
-- 5. INTERNAL ENGINE (no auth; service_role + SECURITY DEFINER callers only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.identity_json(e public.identity_entities, p_attrs boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', e.id, 'uid', e.uid, 'entity_type', e.entity_type, 'scope', e.scope, 'display_name', e.display_name,
    'lifecycle_state', e.lifecycle_state, 'lifecycle_reason', e.lifecycle_reason, 'state_changed_at', e.state_changed_at,
    'merged_into_id', e.merged_into_id, 'confidence', e.confidence, 'assurance', e.assurance, 'version', e.version,
    'created_at', e.created_at, 'updated_at', e.updated_at)
  || CASE WHEN p_attrs THEN jsonb_build_object('attributes', e.attributes, 'attributes_redacted', false)
          ELSE jsonb_build_object('attributes', '{}'::jsonb, 'attributes_redacted', true) END;
$$;

CREATE OR REPLACE FUNCTION public.identity_event_digest(
  p_prev text, p_seq integer, p_uid text, p_type text, p_actor uuid, p_at timestamptz, p_payload_hash text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', p_prev, p_seq::text, p_uid, p_type, coalesce(p_actor::text, ''),
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), p_payload_hash), 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.identity_append_event(
  p_entity_id uuid, p_type text, p_payload jsonb, p_actor_type text, p_actor_user uuid,
  p_reason text DEFAULT NULL, p_related uuid DEFAULT NULL, p_rel uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e public.identity_entities; v_seq integer; v_prev text; v_pay jsonb := coalesce(p_payload, '{}'::jsonb);
  v_ph text; v_at timestamptz := clock_timestamp(); v_id uuid := gen_random_uuid(); v_keys text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_entity_id::text, 7));
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT x.seq, x.event_hash INTO v_seq, v_prev FROM public.identity_events x WHERE x.entity_id = p_entity_id ORDER BY x.seq DESC LIMIT 1;
  IF v_seq IS NULL THEN v_seq := 1; v_prev := repeat('0', 64); ELSE v_seq := v_seq + 1; END IF;
  v_ph := encode(sha256(convert_to(v_pay::text, 'UTF8')), 'hex');
  IF jsonb_typeof(v_pay -> 'changed') = 'object' THEN
    SELECT coalesce(array_agg(k), '{}') INTO v_keys FROM jsonb_object_keys(v_pay -> 'changed') AS k;
  ELSE v_keys := '{}'; END IF;
  INSERT INTO public.identity_events (id, entity_id, owner_user_id, seq, event_type, actor_type, actor_user_id, related_entity_id,
    relationship_id, reason, diff_keys, payload_hash, prev_hash, event_hash, occurred_at)
  VALUES (v_id, p_entity_id, e.owner_user_id, v_seq, p_type, p_actor_type, p_actor_user, p_related, p_rel, left(p_reason, 500), v_keys, v_ph, v_prev,
    public.identity_event_digest(v_prev, v_seq, e.uid, p_type, p_actor_user, v_at, v_ph), v_at);
  INSERT INTO public.identity_event_payloads (event_id, owner_user_id, payload) VALUES (v_id, e.owner_user_id, v_pay);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_add_provenance(
  p_entity_id uuid, p_rel uuid, p_path text, p_source jsonb, p_actor_type text, p_actor_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e public.identity_entities; v_src text; v_conf numeric; v_id uuid := gen_random_uuid(); v_ev uuid;
BEGIN
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002'; END IF;
  v_src := coalesce(nullif(p_source ->> 'source_type', ''), 'user_entry');
  IF v_src NOT IN ('user_entry', 'system_derived', 'import', 'sensor', 'document', 'customer_attested', 'third_party', 'ai_inference', 'authoritative') THEN
    v_src := 'user_entry';
  END IF;
  v_conf := CASE WHEN (p_source ->> 'confidence') ~ '^(0(\.[0-9]+)?|1(\.0+)?)$' THEN (p_source ->> 'confidence')::numeric
                 ELSE public.identity_default_confidence(v_src) END;
  IF (p_source ->> 'evidence_entity_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.identity_entities x WHERE x.id = (p_source ->> 'evidence_entity_id')::uuid
                 AND x.entity_type = 'evidence' AND (x.scope = 'global' OR x.owner_user_id = e.owner_user_id)) THEN
    v_ev := (p_source ->> 'evidence_entity_id')::uuid;
  END IF;
  INSERT INTO public.identity_provenance (id, owner_user_id, entity_id, relationship_id, claim_path, source_type, source_system, source_ref,
    method, actor_type, actor_user_id, evidence_entity_id, confidence, content_hash)
  VALUES (v_id, e.owner_user_id, p_entity_id, p_rel, left(coalesce(p_path, '*'), 120), v_src, left(p_source ->> 'source_system', 60),
    left(p_source ->> 'source_ref', 300), left(p_source ->> 'method', 120), p_actor_type, p_actor_user, v_ev, v_conf,
    encode(sha256(convert_to(e.uid || '|' || coalesce(p_path, '*') || '|' || coalesce(p_source::text, '{}'), 'UTF8')), 'hex'));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_register_internal(
  p_owner uuid, p_type text, p_name text, p_attributes jsonb, p_refs jsonb, p_source jsonb,
  p_actor_type text, p_actor_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_name text := btrim(coalesce(p_name, ''));
  v_attrs jsonb := coalesce(p_attributes, '{}'::jsonb);
  v_refs jsonb := coalesce(p_refs, '[]'::jsonb);
  v_src text := coalesce(nullif(p_source ->> 'source_type', ''), 'user_entry');
  v_ref jsonb; v_hit record; v_id uuid; v_uid text; v_try int := 0; v_conf numeric;
BEGIN
  IF public.identity_type_code(p_type) IS NULL THEN RAISE EXCEPTION 'invalid_entity_type' USING ERRCODE = '22023'; END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_display_name' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(v_attrs) <> 'object' THEN RAISE EXCEPTION 'invalid_attributes' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(v_refs) <> 'array' OR jsonb_array_length(v_refs) > 10 THEN RAISE EXCEPTION 'invalid_refs' USING ERRCODE = '22023'; END IF;

  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
    IF coalesce(v_ref ->> 'system', '') !~ '^[a-z0-9_]{2,40}$' OR coalesce(v_ref ->> 'ref_type', '') !~ '^[a-z0-9_]{1,40}$'
       OR char_length(coalesce(v_ref ->> 'ref_value', '')) NOT BETWEEN 1 AND 300 THEN
      RAISE EXCEPTION 'invalid_refs' USING ERRCODE = '22023';
    END IF;
    SELECT f.entity_id, e.entity_type, e.uid INTO v_hit
      FROM public.identity_external_refs f JOIN public.identity_entities e ON e.id = f.entity_id
     WHERE f.status = 'active' AND coalesce(f.owner_user_id, v_zero) = coalesce(p_owner, v_zero)
       AND f.system = v_ref ->> 'system' AND f.ref_type = v_ref ->> 'ref_type' AND f.ref_value = v_ref ->> 'ref_value';
    IF FOUND THEN
      IF v_hit.entity_type <> p_type THEN RAISE EXCEPTION 'ref_conflict' USING ERRCODE = '23505'; END IF;
      RETURN jsonb_build_object('created', false, 'entity_id', v_hit.entity_id, 'uid', v_hit.uid, 'entity_type', p_type);
    END IF;
  END LOOP;

  v_conf := CASE WHEN (p_source ->> 'confidence') ~ '^(0(\.[0-9]+)?|1(\.0+)?)$' THEN (p_source ->> 'confidence')::numeric
                 ELSE public.identity_default_confidence(v_src) END;
  LOOP
    v_try := v_try + 1;
    v_uid := public.identity_new_uid(p_type);
    BEGIN
      INSERT INTO public.identity_entities (uid, entity_type, scope, owner_user_id, display_name, attributes, confidence, assurance, created_by)
      VALUES (v_uid, p_type, CASE WHEN p_owner IS NULL THEN 'global' ELSE 'tenant' END, p_owner, v_name, v_attrs, v_conf,
              public.identity_assurance_for(v_src), p_actor_user)
      RETURNING id INTO v_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try >= 3 THEN RAISE; END IF;
    END;
  END LOOP;

  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
    BEGIN
      INSERT INTO public.identity_external_refs (entity_id, owner_user_id, system, ref_type, ref_value, created_by)
      VALUES (v_id, p_owner, v_ref ->> 'system', v_ref ->> 'ref_type', v_ref ->> 'ref_value', p_actor_user);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'ref_conflict' USING ERRCODE = '23505';
    END;
  END LOOP;

  PERFORM public.identity_add_provenance(v_id, NULL, '*', p_source, p_actor_type, p_actor_user);
  PERFORM public.identity_append_event(v_id, 'created', jsonb_build_object(
    'entity_type', p_type, 'display_name', v_name, 'refs', v_refs,
    'attribute_keys', (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(v_attrs) AS k)), p_actor_type, p_actor_user);
  RETURN jsonb_build_object('created', true, 'entity_id', v_id, 'uid', v_uid, 'entity_type', p_type);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_patch_internal(
  p_entity_id uuid, p_name text, p_patch jsonb, p_source jsonb, p_actor_type text, p_actor_user uuid,
  p_expected_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e public.identity_entities; v_new jsonb; v_changed jsonb := '{}'::jsonb; k text; v jsonb; v_name text;
BEGIN
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002'; END IF;
  IF e.lifecycle_state IN ('merged', 'erased') THEN RAISE EXCEPTION 'entity_terminal' USING ERRCODE = '22023'; END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version <> e.version THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'invalid_attributes' USING ERRCODE = '22023'; END IF;
  v_new := e.attributes;
  FOR k, v IN SELECT key, value FROM jsonb_each(coalesce(p_patch, '{}'::jsonb)) LOOP
    IF char_length(k) > 64 THEN RAISE EXCEPTION 'invalid_attributes' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(v) = 'null' THEN
      IF v_new ? k THEN
        v_changed := v_changed || jsonb_build_object(k, jsonb_build_object('from', v_new -> k, 'to', 'null'::jsonb));
        v_new := v_new - k;
      END IF;
    ELSIF (v_new -> k) IS DISTINCT FROM v THEN
      v_changed := v_changed || jsonb_build_object(k, jsonb_build_object('from', coalesce(v_new -> k, 'null'::jsonb), 'to', v));
      v_new := v_new || jsonb_build_object(k, v);
    END IF;
  END LOOP;
  v_name := btrim(coalesce(p_name, e.display_name));
  IF char_length(v_name) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_display_name' USING ERRCODE = '22023'; END IF;
  IF v_name <> e.display_name THEN
    v_changed := v_changed || jsonb_build_object('display_name', jsonb_build_object('from', e.display_name, 'to', v_name));
  END IF;
  IF v_changed = '{}'::jsonb THEN
    RETURN jsonb_build_object('changed', false, 'version', e.version);
  END IF;
  UPDATE public.identity_entities SET attributes = v_new, display_name = v_name WHERE id = e.id;
  FOR k IN SELECT key FROM jsonb_each(v_changed) LIMIT 25 LOOP
    PERFORM public.identity_add_provenance(e.id, NULL, k, p_source, p_actor_type, p_actor_user);
  END LOOP;
  PERFORM public.identity_append_event(e.id, 'attributes_changed', jsonb_build_object('changed', v_changed), p_actor_type, p_actor_user);
  RETURN jsonb_build_object('changed', true, 'version', e.version + 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_transition_internal(
  p_entity_id uuid, p_to text, p_reason text, p_actor_type text, p_actor_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e public.identity_entities;
BEGIN
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002'; END IF;
  IF e.lifecycle_state = p_to THEN RETURN jsonb_build_object('changed', false, 'state', e.lifecycle_state); END IF;
  IF NOT public.identity_transition_allowed(e.lifecycle_state, p_to) THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023'; END IF;
  UPDATE public.identity_entities SET lifecycle_state = p_to, lifecycle_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500) WHERE id = e.id;
  PERFORM public.identity_append_event(e.id, 'state_changed', jsonb_build_object('from', e.lifecycle_state, 'to', p_to), p_actor_type, p_actor_user, p_reason);
  RETURN jsonb_build_object('changed', true, 'state', p_to);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_end_edge_internal(p_edge_id uuid, p_reason text, p_actor_type text, p_actor_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.identity_relationships;
BEGIN
  SELECT * INTO r FROM public.identity_relationships WHERE id = p_edge_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.identity_relationships
     SET status = 'ended', ended_at = now(), valid_to = greatest(now(), valid_from), ended_reason = left(p_reason, 300)
   WHERE id = r.id;
  PERFORM public.identity_append_event(r.src_id, 'relationship_ended', jsonb_build_object('rel_type', r.rel_type, 'other', r.dst_id, 'direction', 'out'), p_actor_type, p_actor_user, p_reason, r.dst_id, r.id);
  PERFORM public.identity_append_event(r.dst_id, 'relationship_ended', jsonb_build_object('rel_type', r.rel_type, 'other', r.src_id, 'direction', 'in'), p_actor_type, p_actor_user, p_reason, r.src_id, r.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_link_internal(
  p_owner uuid, p_src uuid, p_dst uuid, p_rel text, p_attrs jsonb, p_valid_from timestamptz, p_source jsonb,
  p_actor_type text, p_actor_user uuid, p_strict boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.identity_entities; d public.identity_entities; reg public.identity_relationship_types;
  v_id uuid; v_old uuid; v_conf numeric; v_src text := coalesce(nullif(p_source ->> 'source_type', ''), 'user_entry');
BEGIN
  IF p_src = p_dst THEN RAISE EXCEPTION 'invalid_relationship' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM public.identity_entities WHERE id = p_src;
  SELECT * INTO d FROM public.identity_entities WHERE id = p_dst;
  IF s.id IS NULL OR d.id IS NULL THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002'; END IF;
  IF s.lifecycle_state IN ('merged', 'erased') OR d.lifecycle_state IN ('merged', 'erased') THEN
    RAISE EXCEPTION 'entity_terminal' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO reg FROM public.identity_relationship_types t WHERE t.rel_type = p_rel AND t.src_type = s.entity_type AND t.dst_type = d.entity_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'relationship_not_allowed' USING ERRCODE = '22023'; END IF;

  SELECT r.id INTO v_old FROM public.identity_relationships r
   WHERE r.owner_user_id = p_owner AND r.src_id = p_src AND r.dst_id = p_dst AND r.rel_type = p_rel AND r.status = 'active';
  IF v_old IS NOT NULL THEN RETURN v_old; END IF;

  IF reg.single_active THEN
    FOR v_old IN SELECT r.id FROM public.identity_relationships r
                  WHERE r.owner_user_id = p_owner AND r.src_id = p_src AND r.rel_type = p_rel AND r.status = 'active' LOOP
      IF p_strict THEN RAISE EXCEPTION 'single_active_violation' USING ERRCODE = '23505'; END IF;
      PERFORM public.identity_end_edge_internal(v_old, 'superseded', p_actor_type, p_actor_user);
    END LOOP;
  END IF;

  IF reg.acyclic AND EXISTS (
    WITH RECURSIVE walk(id, depth) AS (
      SELECT p_dst, 0
      UNION ALL
      SELECT r.dst_id, w.depth + 1 FROM public.identity_relationships r JOIN walk w ON r.src_id = w.id
       WHERE r.owner_user_id = p_owner AND r.rel_type = p_rel AND r.status = 'active' AND w.depth < 25)
    SELECT 1 FROM walk WHERE id = p_src) THEN
    RAISE EXCEPTION 'cycle_detected' USING ERRCODE = '22023';
  END IF;

  v_conf := CASE WHEN (p_source ->> 'confidence') ~ '^(0(\.[0-9]+)?|1(\.0+)?)$' THEN (p_source ->> 'confidence')::numeric
                 ELSE public.identity_default_confidence(v_src) END;
  INSERT INTO public.identity_relationships (owner_user_id, src_id, dst_id, rel_type, attributes, valid_from, confidence, created_by)
  VALUES (p_owner, p_src, p_dst, p_rel, coalesce(p_attrs, '{}'::jsonb), coalesce(p_valid_from, now()), v_conf, p_actor_user)
  RETURNING id INTO v_id;

  PERFORM public.identity_add_provenance(p_src, v_id, 'rel:' || p_rel, p_source, p_actor_type, p_actor_user);
  PERFORM public.identity_append_event(p_src, 'relationship_added', jsonb_build_object('rel_type', p_rel, 'other', p_dst, 'direction', 'out'), p_actor_type, p_actor_user, NULL, p_dst, v_id);
  PERFORM public.identity_append_event(p_dst, 'relationship_added', jsonb_build_object('rel_type', p_rel, 'other', p_src, 'direction', 'in'), p_actor_type, p_actor_user, NULL, p_src, v_id);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_can(p_entity_id uuid, p_action text DEFAULT 'read')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.identity_entities e
     WHERE e.id = p_entity_id AND e.lifecycle_state <> 'erased' AND (
       (e.scope = 'tenant' AND e.owner_user_id = public.get_account_owner_id())
       OR (e.scope = 'global' AND p_action IN ('read', 'read_attributes'))
       OR EXISTS (
         SELECT 1 FROM public.identity_grants g
          WHERE g.entity_id = e.id AND g.grantee_kind = 'tenant' AND g.grantee_id = public.get_account_owner_id()
            AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND p_action = ANY (g.actions))));
$$;

-- Agent runtime check: may this agent entity perform `p_action` on `p_entity_id`?
CREATE OR REPLACE FUNCTION public.identity_agent_can(p_agent_id uuid, p_entity_id uuid, p_action text DEFAULT 'read')
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.identity_jwt_role() IN ('authenticated', 'anon') AND NOT EXISTS (
    SELECT 1 FROM public.identity_entities a WHERE a.id = p_agent_id AND a.owner_user_id = public.get_account_owner_id()) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.identity_grants g JOIN public.identity_entities a ON a.id = g.grantee_id AND a.entity_type = 'agent'
     WHERE g.grantee_kind = 'agent' AND g.grantee_id = p_agent_id AND g.entity_id = p_entity_id
       AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
       AND a.lifecycle_state = 'active' AND p_action = ANY (g.actions));
END;
$$;

-- =============================================================
-- 6. PUBLIC RPC (authenticated)
-- =============================================================

CREATE OR REPLACE FUNCTION public.identity_register_entity(
  p_entity_type text, p_display_name text, p_attributes jsonb DEFAULT '{}'::jsonb,
  p_refs jsonb DEFAULT '[]'::jsonb, p_source jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); v_ref jsonb;
BEGIN
  IF jsonb_typeof(coalesce(p_refs, '[]'::jsonb)) = 'array' THEN
    FOR v_ref IN SELECT value FROM jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) LOOP
      IF v_ref ->> 'system' = 'vireek' THEN RAISE EXCEPTION 'reserved_ref_system' USING ERRCODE = '22023'; END IF;
    END LOOP;
  END IF;
  RETURN public.identity_register_internal(v_owner, p_entity_type, p_display_name, p_attributes, p_refs, p_source, 'user', auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_add_ref(p_entity_id uuid, p_system text, p_ref_type text, p_ref_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); e public.identity_entities; v_id uuid;
BEGIN
  IF NOT public.identity_can(p_entity_id, 'write') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_system = 'vireek' THEN RAISE EXCEPTION 'reserved_ref_system' USING ERRCODE = '22023'; END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  IF e.owner_user_id IS DISTINCT FROM v_owner OR e.lifecycle_state IN ('merged', 'erased') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  BEGIN
    INSERT INTO public.identity_external_refs (entity_id, owner_user_id, system, ref_type, ref_value, created_by)
    VALUES (e.id, v_owner, p_system, p_ref_type, p_ref_value, auth.uid()) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'ref_conflict' USING ERRCODE = '23505';
  END;
  PERFORM public.identity_append_event(e.id, 'ref_added', jsonb_build_object('system', p_system, 'ref_type', p_ref_type, 'ref_value', p_ref_value), 'user', auth.uid());
  RETURN jsonb_build_object('ref_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_resolve_ref(p_system text, p_ref_type text, p_ref_value text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); e public.identity_entities;
BEGIN
  SELECT x.* INTO e FROM public.identity_external_refs f JOIN public.identity_entities x ON x.id = f.entity_id
   WHERE f.status = 'active' AND f.owner_user_id = v_owner AND f.system = p_system AND f.ref_type = p_ref_type AND f.ref_value = p_ref_value;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object('found', true, 'entity', public.identity_json(e, true));
END;
$$;

-- Resolves a uid, following merge redirects (max 8 hops). The requested uid never stops resolving.
CREATE OR REPLACE FUNCTION public.identity_resolve_uid(p_uid text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; e public.identity_entities; v_req text := upper(btrim(coalesce(p_uid, '')));
BEGIN
  PERFORM public.identity_require_owner();
  IF NOT public.identity_uid_valid(v_req) THEN RETURN jsonb_build_object('found', false, 'reason', 'invalid_uid'); END IF;
  WITH RECURSIVE chain(id, merged_into_id, depth) AS (
    SELECT x.id, x.merged_into_id, 0 FROM public.identity_entities x WHERE x.uid = v_req
    UNION ALL
    SELECT x.id, x.merged_into_id, c.depth + 1 FROM public.identity_entities x JOIN chain c ON x.id = c.merged_into_id WHERE c.depth < 8)
  SELECT id INTO v_id FROM chain WHERE merged_into_id IS NULL ORDER BY depth DESC LIMIT 1;
  IF v_id IS NULL OR NOT public.identity_can(v_id, 'read') THEN RETURN jsonb_build_object('found', false, 'reason', 'not_found'); END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = v_id;
  RETURN jsonb_build_object('found', true, 'redirected', e.uid <> v_req, 'requested_uid', v_req,
    'entity', public.identity_json(e, public.identity_can(v_id, 'read_attributes')));
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_update_entity(
  p_entity_id uuid, p_patch jsonb DEFAULT '{}'::jsonb, p_display_name text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL, p_source jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.identity_require_owner();
  IF NOT public.identity_can(p_entity_id, 'write') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  RETURN public.identity_patch_internal(p_entity_id, p_display_name, p_patch, p_source, 'user', auth.uid(), p_expected_version);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_link(
  p_src_id uuid, p_dst_id uuid, p_rel_type text, p_attributes jsonb DEFAULT '{}'::jsonb,
  p_valid_from timestamptz DEFAULT NULL, p_source jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); v_id uuid;
BEGIN
  IF NOT public.identity_can(p_src_id, 'link') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF NOT (public.identity_can(p_dst_id, 'link')
          OR EXISTS (SELECT 1 FROM public.identity_entities g WHERE g.id = p_dst_id AND g.scope = 'global')) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  v_id := public.identity_link_internal(v_owner, p_src_id, p_dst_id, p_rel_type, p_attributes, p_valid_from, p_source, 'user', auth.uid(), true);
  RETURN jsonb_build_object('relationship_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_unlink(p_relationship_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.identity_relationships r WHERE r.id = p_relationship_id AND r.owner_user_id = v_owner AND r.status = 'active') THEN
    RAISE EXCEPTION 'relationship_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.identity_end_edge_internal(p_relationship_id, coalesce(nullif(btrim(p_reason), ''), 'unlinked'), 'user', auth.uid());
  RETURN jsonb_build_object('ended', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_transition(p_entity_id uuid, p_to_state text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); e public.identity_entities;
BEGIN
  IF NOT public.identity_layer_is_manager() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_to_state NOT IN ('draft', 'active', 'suspended', 'disputed', 'retired') THEN RAISE EXCEPTION 'use_merge_or_erase' USING ERRCODE = '22023'; END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  IF NOT FOUND OR e.owner_user_id IS DISTINCT FROM v_owner THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_to_state IN ('suspended', 'disputed', 'retired') AND char_length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  RETURN public.identity_transition_internal(p_entity_id, p_to_state, p_reason, 'user', auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_merge(p_survivor_id uuid, p_duplicate_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.identity_require_owner(); s public.identity_entities; d public.identity_entities; r public.identity_relationships;
  v_src uuid; v_dst uuid; v_moved int := 0; v_dropped int := 0; v_refs int;
BEGIN
  IF NOT public.identity_layer_is_manager() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_survivor_id = p_duplicate_id OR char_length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'invalid_merge' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.identity_entities WHERE id IN (p_survivor_id, p_duplicate_id) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM public.identity_entities WHERE id = p_survivor_id;
  SELECT * INTO d FROM public.identity_entities WHERE id = p_duplicate_id;
  IF s.id IS NULL OR d.id IS NULL OR s.scope <> 'tenant' OR d.scope <> 'tenant' OR s.owner_user_id <> v_owner OR d.owner_user_id <> v_owner
     OR s.entity_type <> d.entity_type OR s.lifecycle_state IN ('merged', 'erased') OR d.lifecycle_state IN ('merged', 'erased') THEN
    RAISE EXCEPTION 'invalid_merge' USING ERRCODE = '22023';
  END IF;

  UPDATE public.identity_external_refs SET entity_id = s.id WHERE entity_id = d.id AND status = 'active';
  GET DIAGNOSTICS v_refs = ROW_COUNT;

  FOR r IN SELECT * FROM public.identity_relationships
            WHERE owner_user_id = v_owner AND status = 'active' AND (src_id = d.id OR dst_id = d.id) FOR UPDATE LOOP
    v_src := CASE WHEN r.src_id = d.id THEN s.id ELSE r.src_id END;
    v_dst := CASE WHEN r.dst_id = d.id THEN s.id ELSE r.dst_id END;
    IF v_src = v_dst
       OR EXISTS (SELECT 1 FROM public.identity_relationships x WHERE x.owner_user_id = v_owner AND x.status = 'active'
                   AND x.src_id = v_src AND x.dst_id = v_dst AND x.rel_type = r.rel_type AND x.id <> r.id)
       OR (r.src_id = d.id AND EXISTS (SELECT 1 FROM public.identity_relationship_types t WHERE t.rel_type = r.rel_type AND t.single_active)
           AND EXISTS (SELECT 1 FROM public.identity_relationships x WHERE x.owner_user_id = v_owner AND x.status = 'active'
                        AND x.src_id = s.id AND x.rel_type = r.rel_type)) THEN
      UPDATE public.identity_relationships SET status = 'ended', ended_at = now(), valid_to = greatest(now(), valid_from), ended_reason = 'merge_duplicate' WHERE id = r.id;
      v_dropped := v_dropped + 1;
    ELSE
      UPDATE public.identity_relationships SET src_id = v_src, dst_id = v_dst WHERE id = r.id;
      v_moved := v_moved + 1;
    END IF;
  END LOOP;

  UPDATE public.identity_entities SET attributes = d.attributes || s.attributes WHERE id = s.id;
  UPDATE public.identity_entities SET lifecycle_state = 'merged', merged_into_id = s.id, lifecycle_reason = left(btrim(p_reason), 500) WHERE id = d.id;
  PERFORM public.identity_add_provenance(s.id, NULL, 'merge', jsonb_build_object('source_type', 'user_entry', 'method', 'identity_merge', 'source_ref', d.uid), 'user', auth.uid());
  PERFORM public.identity_append_event(d.id, 'merged_into', jsonb_build_object('survivor', s.uid), 'user', auth.uid(), p_reason, s.id);
  PERFORM public.identity_append_event(s.id, 'merged_from', jsonb_build_object('duplicate', d.uid, 'refs_moved', v_refs, 'edges_moved', v_moved, 'edges_dropped', v_dropped), 'user', auth.uid(), p_reason, d.id);
  RETURN jsonb_build_object('survivor_uid', s.uid, 'duplicate_uid', d.uid, 'refs_moved', v_refs, 'edges_moved', v_moved, 'edges_dropped', v_dropped);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_erase(p_entity_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); e public.identity_entities; r record;
BEGIN
  IF NOT public.identity_layer_is_manager() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND OR e.scope <> 'tenant' OR e.owner_user_id <> v_owner OR e.lifecycle_state = 'erased' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;

  FOR r IN SELECT id FROM public.identity_relationships WHERE owner_user_id = v_owner AND status = 'active' AND (src_id = e.id OR dst_id = e.id) LOOP
    PERFORM public.identity_end_edge_internal(r.id, 'erasure', 'user', auth.uid());
  END LOOP;
  UPDATE public.identity_relationships SET attributes = '{}'::jsonb WHERE owner_user_id = v_owner AND (src_id = e.id OR dst_id = e.id);
  UPDATE public.identity_external_refs
     SET status = 'retired', retired_at = now(), ref_value = 'erased:' || encode(sha256(convert_to(ref_value, 'UTF8')), 'hex')
   WHERE entity_id = e.id;
  UPDATE public.identity_grants SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'erasure' WHERE entity_id = e.id AND revoked_at IS NULL;
  DELETE FROM public.identity_event_payloads WHERE event_id IN (SELECT id FROM public.identity_events WHERE entity_id = e.id);
  UPDATE public.identity_entities
     SET display_name = '[erased]', attributes = '{}'::jsonb, merged_into_id = NULL, lifecycle_state = 'erased',
         lifecycle_reason = left(btrim(p_reason), 500), erased_at = now()
   WHERE id = e.id;
  PERFORM public.identity_append_event(e.id, 'erased', jsonb_build_object('erased', true), 'user', auth.uid(), p_reason);
  RETURN jsonb_build_object('uid', e.uid, 'erased', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_grant_access(
  p_entity_id uuid, p_grantee_kind text, p_grantee_id uuid, p_actions text[], p_purpose text, p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); e public.identity_entities; v_exp timestamptz; v_id uuid;
BEGIN
  IF NOT public.identity_layer_is_manager() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  IF NOT FOUND OR e.scope <> 'tenant' OR e.owner_user_id <> v_owner OR e.lifecycle_state IN ('merged', 'erased') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_grantee_kind = 'tenant' THEN
    IF p_grantee_id = v_owner OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_grantee_id) THEN RAISE EXCEPTION 'invalid_grantee' USING ERRCODE = '22023'; END IF;
  ELSIF p_grantee_kind = 'agent' THEN
    IF NOT EXISTS (SELECT 1 FROM public.identity_entities a WHERE a.id = p_grantee_id AND a.entity_type = 'agent' AND a.owner_user_id = v_owner AND a.lifecycle_state = 'active') THEN
      RAISE EXCEPTION 'invalid_grantee' USING ERRCODE = '22023';
    END IF;
  ELSE RAISE EXCEPTION 'invalid_grantee' USING ERRCODE = '22023'; END IF;
  v_exp := coalesce(p_expires_at, now() + interval '90 days');
  IF v_exp <= now() OR v_exp > now() + interval '366 days' THEN RAISE EXCEPTION 'invalid_expiry' USING ERRCODE = '22023'; END IF;
  IF p_actions IS NULL OR cardinality(p_actions) = 0 THEN RAISE EXCEPTION 'invalid_actions' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.identity_grants (entity_id, owner_user_id, grantee_kind, grantee_id, actions, purpose, expires_at, granted_by)
  VALUES (e.id, v_owner, p_grantee_kind, p_grantee_id, p_actions, btrim(p_purpose), v_exp, auth.uid())
  ON CONFLICT (entity_id, grantee_kind, grantee_id) WHERE revoked_at IS NULL
  DO UPDATE SET actions = EXCLUDED.actions, purpose = EXCLUDED.purpose, expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by
  RETURNING id INTO v_id;
  PERFORM public.identity_append_event(e.id, 'grant_issued', jsonb_build_object('grant_id', v_id, 'grantee_kind', p_grantee_kind, 'grantee_id', p_grantee_id,
    'actions', to_jsonb(p_actions), 'purpose', btrim(p_purpose), 'expires_at', v_exp), 'user', auth.uid(), p_purpose);
  RETURN jsonb_build_object('grant_id', v_id, 'expires_at', v_exp);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_revoke_grant(p_grant_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner(); g public.identity_grants;
BEGIN
  IF NOT public.identity_layer_is_manager() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO g FROM public.identity_grants WHERE id = p_grant_id AND owner_user_id = v_owner AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'grant_not_found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.identity_grants SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300) WHERE id = g.id;
  PERFORM public.identity_append_event(g.entity_id, 'grant_revoked', jsonb_build_object('grant_id', g.id, 'grantee_kind', g.grantee_kind, 'grantee_id', g.grantee_id), 'user', auth.uid(), p_reason);
  RETURN jsonb_build_object('revoked', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_identity_chain(p_entity_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE e public.identity_entities; ev record; v_prev text := repeat('0', 64); v_n int := 0; v_expect int := 1;
BEGIN
  PERFORM public.identity_require_owner();
  IF NOT public.identity_can(p_entity_id, 'read') THEN RETURN jsonb_build_object('found', false); END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  FOR ev IN SELECT * FROM public.identity_events WHERE entity_id = p_entity_id ORDER BY seq LOOP
    IF ev.seq <> v_expect OR ev.prev_hash <> v_prev
       OR ev.event_hash <> public.identity_event_digest(ev.prev_hash, ev.seq, e.uid, ev.event_type, ev.actor_user_id, ev.occurred_at, ev.payload_hash) THEN
      RETURN jsonb_build_object('found', true, 'valid', false, 'events', v_n, 'broken_at_seq', ev.seq);
    END IF;
    v_prev := ev.event_hash; v_n := v_n + 1; v_expect := v_expect + 1;
  END LOOP;
  RETURN jsonb_build_object('found', true, 'valid', true, 'events', v_n, 'head_hash', CASE WHEN v_n = 0 THEN NULL ELSE v_prev END);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_identity_entity(p_entity_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.identity_require_owner(); e public.identity_entities; v_attrs boolean; v_mgr boolean := public.identity_layer_is_manager();
BEGIN
  IF NOT public.identity_can(p_entity_id, 'read') THEN RETURN jsonb_build_object('found', false); END IF;
  SELECT * INTO e FROM public.identity_entities WHERE id = p_entity_id;
  v_attrs := public.identity_can(p_entity_id, 'read_attributes');
  RETURN jsonb_build_object(
    'found', true,
    'entity', public.identity_json(e, v_attrs),
    'permissions', jsonb_build_object('read_attributes', v_attrs, 'link', public.identity_can(p_entity_id, 'link'),
      'write', public.identity_can(p_entity_id, 'write'), 'manage', v_mgr AND e.owner_user_id = v_owner),
    'refs', CASE WHEN NOT v_attrs THEN '[]'::jsonb ELSE (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'system', f.system, 'ref_type', f.ref_type, 'ref_value', f.ref_value,
        'status', f.status, 'created_at', f.created_at) ORDER BY f.created_at), '[]'::jsonb)
      FROM public.identity_external_refs f WHERE f.entity_id = e.id) END,
    'relationships', (
      SELECT coalesce(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.created_at DESC), '[]'::jsonb) FROM (
        SELECT r.id, r.rel_type, r.status, r.valid_from, r.valid_to, r.confidence, r.created_at,
               CASE WHEN r.src_id = e.id THEN 'out' ELSE 'in' END AS direction,
               o.id AS other_id,
               CASE WHEN public.identity_can(o.id, 'read') THEN o.uid ELSE NULL END AS other_uid,
               CASE WHEN public.identity_can(o.id, 'read') THEN o.entity_type ELSE NULL END AS other_type,
               CASE WHEN public.identity_can(o.id, 'read') THEN o.display_name ELSE 'Restricted entity' END AS other_name,
               t.label, t.inverse_label
          FROM public.identity_relationships r
          JOIN public.identity_entities o ON o.id = CASE WHEN r.src_id = e.id THEN r.dst_id ELSE r.src_id END
          LEFT JOIN public.identity_relationship_types t ON t.rel_type = r.rel_type
               AND t.src_type = (SELECT s.entity_type FROM public.identity_entities s WHERE s.id = r.src_id)
               AND t.dst_type = (SELECT d.entity_type FROM public.identity_entities d WHERE d.id = r.dst_id)
         WHERE r.owner_user_id = v_owner AND (r.src_id = e.id OR r.dst_id = e.id)
         ORDER BY r.created_at DESC LIMIT 200) q),
    'provenance', (
      SELECT coalesce(jsonb_agg(row_to_json(p)::jsonb ORDER BY p.recorded_at DESC), '[]'::jsonb) FROM (
        SELECT id, claim_path, source_type, source_system, source_ref, method, actor_type, confidence, observed_at, recorded_at
          FROM public.identity_provenance WHERE entity_id = e.id ORDER BY recorded_at DESC LIMIT 50) p),
    'events', (
      SELECT coalesce(jsonb_agg(row_to_json(h)::jsonb ORDER BY h.seq DESC), '[]'::jsonb) FROM (
        SELECT ev.seq, ev.event_type, ev.actor_type, ev.reason, ev.diff_keys, ev.event_hash, ev.occurred_at,
               CASE WHEN v_attrs THEN pl.payload ELSE NULL END AS payload
          FROM public.identity_events ev LEFT JOIN public.identity_event_payloads pl ON pl.event_id = ev.id
         WHERE ev.entity_id = e.id ORDER BY ev.seq DESC LIMIT 50) h),
    'grants', CASE WHEN v_mgr AND e.owner_user_id = v_owner THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'grantee_kind', g.grantee_kind, 'grantee_id', g.grantee_id, 'actions', g.actions,
        'purpose', g.purpose, 'expires_at', g.expires_at, 'created_at', g.created_at) ORDER BY g.created_at DESC), '[]'::jsonb)
      FROM public.identity_grants g WHERE g.entity_id = e.id AND g.revoked_at IS NULL) ELSE '[]'::jsonb END);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_identity_graph(
  p_entity_id uuid, p_depth integer DEFAULT 2, p_limit integer DEFAULT 150, p_include_ended boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.identity_require_owner();
  v_depth int := least(greatest(coalesce(p_depth, 2), 1), 4);
  v_limit int := least(greatest(coalesce(p_limit, 150), 10), 400);
  v_nodes jsonb; v_edges jsonb; v_total int; v_ids uuid[]; v_depths jsonb;
BEGIN
  IF NOT public.identity_can(p_entity_id, 'read') THEN RETURN jsonb_build_object('found', false); END IF;
  WITH RECURSIVE walk(node, depth) AS (
    SELECT p_entity_id, 0
    UNION
    SELECT CASE WHEN r.src_id = w.node THEN r.dst_id ELSE r.src_id END, w.depth + 1
      FROM walk w JOIN public.identity_relationships r ON (r.src_id = w.node OR r.dst_id = w.node)
     WHERE w.depth < v_depth AND r.owner_user_id = v_owner AND (p_include_ended OR r.status = 'active')),
  best AS (SELECT node, min(depth) AS depth FROM walk GROUP BY node),
  ranked AS (
    SELECT b.node, b.depth FROM best b JOIN public.identity_entities e ON e.id = b.node
     WHERE public.identity_can(b.node, 'read') ORDER BY b.depth, e.display_name LIMIT v_limit)
  SELECT array_agg(node), jsonb_object_agg(node::text, depth), (SELECT count(*) FROM best)
    INTO v_ids, v_depths, v_total FROM ranked;
  IF v_ids IS NULL THEN v_ids := ARRAY[p_entity_id]; v_depths := jsonb_build_object(p_entity_id::text, 0); END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'uid', e.uid, 'entity_type', e.entity_type, 'display_name', e.display_name,
    'lifecycle_state', e.lifecycle_state, 'confidence', e.confidence, 'depth', (v_depths ->> e.id::text)::int)
    ORDER BY (v_depths ->> e.id::text)::int, e.display_name), '[]'::jsonb)
    INTO v_nodes FROM public.identity_entities e WHERE e.id = ANY (v_ids);

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'src', r.src_id, 'dst', r.dst_id, 'rel_type', r.rel_type, 'status', r.status,
    'valid_from', r.valid_from, 'valid_to', r.valid_to, 'confidence', r.confidence)), '[]'::jsonb)
    INTO v_edges
    FROM public.identity_relationships r
   WHERE r.owner_user_id = v_owner AND r.src_id = ANY (v_ids) AND r.dst_id = ANY (v_ids) AND (p_include_ended OR r.status = 'active');

  RETURN jsonb_build_object('found', true, 'root_id', p_entity_id, 'depth', v_depth, 'nodes', v_nodes, 'edges', v_edges,
    'truncated', coalesce(v_total, 0) > cardinality(v_ids));
END;
$$;

CREATE OR REPLACE FUNCTION public.search_identity_entities(
  p_query text DEFAULT NULL, p_types text[] DEFAULT NULL, p_states text[] DEFAULT NULL, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.identity_require_owner();
  v_q text := btrim(coalesce(p_query, ''));
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int; v_items jsonb;
BEGIN
  WITH visible AS (
    SELECT e.id, e.updated_at FROM public.identity_entities e
     WHERE e.lifecycle_state <> 'erased'
       AND (p_types IS NULL OR e.entity_type = ANY (p_types))
       AND (p_states IS NULL OR e.lifecycle_state = ANY (p_states))
       AND (e.owner_user_id = v_owner OR e.scope = 'global' OR EXISTS (
             SELECT 1 FROM public.identity_grants g WHERE g.entity_id = e.id AND g.grantee_kind = 'tenant' AND g.grantee_id = v_owner
                AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND 'read' = ANY (g.actions)))
       AND (v_q = '' OR (upper(v_q) LIKE 'VRK-%' AND e.uid = upper(v_q))
            OR (upper(v_q) NOT LIKE 'VRK-%' AND (e.display_name ILIKE v_like
                OR (e.owner_user_id = v_owner AND EXISTS (SELECT 1 FROM public.identity_external_refs f
                      WHERE f.entity_id = e.id AND f.status = 'active' AND f.ref_value ILIKE v_like)))))),
  page AS (SELECT id, updated_at FROM visible ORDER BY updated_at DESC, id LIMIT v_limit OFFSET v_offset)
  SELECT (SELECT count(*) FROM visible),
         coalesce((SELECT jsonb_agg((public.identity_json(x, false) - 'attributes' - 'attributes_redacted') ORDER BY pg.updated_at DESC, pg.id)
                     FROM page pg JOIN public.identity_entities x ON x.id = pg.id), '[]'::jsonb)
    INTO v_total, v_items;
  RETURN jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_registered_count(p_owner uuid, p_ref_type text)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM public.identity_external_refs f
   WHERE f.owner_user_id = p_owner AND f.system = 'vireek' AND f.ref_type = p_ref_type AND f.status = 'active';
$$;
REVOKE ALL ON FUNCTION public.identity_registered_count(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_identity_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.identity_require_owner();
BEGIN
  RETURN jsonb_build_object(
    'entities', (SELECT count(*) FROM public.identity_entities WHERE owner_user_id = v_owner AND lifecycle_state NOT IN ('merged', 'erased')),
    'by_type', (SELECT coalesce(jsonb_object_agg(entity_type, n), '{}'::jsonb) FROM (
        SELECT entity_type, count(*) AS n FROM public.identity_entities WHERE owner_user_id = v_owner AND lifecycle_state NOT IN ('merged', 'erased') GROUP BY 1) t),
    'by_state', (SELECT coalesce(jsonb_object_agg(lifecycle_state, n), '{}'::jsonb) FROM (
        SELECT lifecycle_state, count(*) AS n FROM public.identity_entities WHERE owner_user_id = v_owner GROUP BY 1) t),
    'relationships', (SELECT count(*) FROM public.identity_relationships WHERE owner_user_id = v_owner AND status = 'active'),
    'events', (SELECT count(*) FROM public.identity_events WHERE owner_user_id = v_owner),
    'provenance_claims', (SELECT count(*) FROM public.identity_provenance WHERE owner_user_id = v_owner),
    'grants_given', (SELECT count(*) FROM public.identity_grants WHERE owner_user_id = v_owner AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())),
    'grants_received', (SELECT count(*) FROM public.identity_grants WHERE grantee_kind = 'tenant' AND grantee_id = v_owner AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())),
    'avg_confidence', (SELECT round(avg(confidence), 2) FROM public.identity_entities WHERE owner_user_id = v_owner AND lifecycle_state = 'active'),
    'coverage', jsonb_build_array(
      jsonb_build_object('key', 'customers', 'label', 'Customers', 'total', (SELECT count(*) FROM public.customers WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'customers')),
      jsonb_build_object('key', 'customer_sites', 'label', 'Properties', 'total', (SELECT count(*) FROM public.customer_sites WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'customer_sites')),
      jsonb_build_object('key', 'equipment', 'label', 'Equipment', 'total', (SELECT count(*) FROM public.equipment WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'equipment')),
      jsonb_build_object('key', 'team_members', 'label', 'Technicians', 'total', (SELECT count(*) FROM public.team_members WHERE account_owner_id = v_owner AND role = 'technician'), 'registered', public.identity_registered_count(v_owner, 'team_members')),
      jsonb_build_object('key', 'jobs', 'label', 'Services', 'total', (SELECT count(*) FROM public.jobs WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'jobs')),
      jsonb_build_object('key', 'job_outcomes', 'label', 'Outcomes', 'total', (SELECT count(*) FROM public.job_outcomes WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'job_outcomes')),
      jsonb_build_object('key', 'job_evidence_chain_entries', 'label', 'Evidence', 'total', (SELECT count(*) FROM public.job_evidence_chain_entries WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'job_evidence_chain_entries')),
      jsonb_build_object('key', 'invoices', 'label', 'Transactions', 'total', (SELECT count(*) FROM public.invoices WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'invoices')),
      jsonb_build_object('key', 'marketplace_agent_installs', 'label', 'Agents', 'total', (SELECT count(*) FROM public.marketplace_agent_installs WHERE user_id = v_owner), 'registered', public.identity_registered_count(v_owner, 'marketplace_agent_installs'))));
END;
$$;

-- =============================================================
-- 7. OPERATIONAL SYNC (one mapping, used by triggers AND the backfill RPC)
-- =============================================================

CREATE OR REPLACE FUNCTION public.identity_ref_entity(p_owner uuid, p_ref_type text, p_value text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.entity_id FROM public.identity_external_refs f
   WHERE f.owner_user_id = p_owner AND f.system = 'vireek' AND f.ref_type = p_ref_type AND f.ref_value = p_value AND f.status = 'active' LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.identity_upsert_native(
  p_owner uuid, p_type text, p_ref_type text, p_ref_id text, p_name text, p_attrs jsonb, p_retire boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_res jsonb;
  v_src jsonb := jsonb_build_object('source_type', 'system_derived', 'source_system', 'vireek', 'source_ref', p_ref_type || ':' || p_ref_id, 'method', 'operational_sync');
  v_name text := coalesce(nullif(btrim(p_name), ''), initcap(p_type));
BEGIN
  v_id := public.identity_ref_entity(p_owner, p_ref_type, p_ref_id);
  IF v_id IS NULL THEN
    v_res := public.identity_register_internal(p_owner, p_type, left(v_name, 200), coalesce(p_attrs, '{}'::jsonb),
      jsonb_build_array(jsonb_build_object('system', 'vireek', 'ref_type', p_ref_type, 'ref_value', p_ref_id)), v_src, 'system', NULL);
    v_id := (v_res ->> 'entity_id')::uuid;
  ELSE
    PERFORM public.identity_patch_internal(v_id, left(v_name, 200), coalesce(p_attrs, '{}'::jsonb), v_src, 'system', NULL);
  END IF;
  IF p_retire THEN
    PERFORM public.identity_transition_internal(v_id, 'retired', 'Retired in source system', 'system', NULL);
  END IF;
  RETURN v_id;
EXCEPTION WHEN SQLSTATE '22023' THEN
  -- entity is merged/erased/not transitionable: sync must never fight a manager's decision
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_sync_row(p_table text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_src jsonb := jsonb_build_object('source_type', 'system_derived', 'source_system', 'vireek', 'method', 'operational_sync');
  v_owner uuid; v_id uuid; v_other uuid; v_company uuid; v_row jsonb; v_type text; v_tmp jsonb;
BEGIN
  IF current_setting('vireek.identity_autoregister', true) = 'off' THEN RETURN; END IF;
  v_owner := CASE p_table WHEN 'team_members' THEN (p_row ->> 'account_owner_id')::uuid ELSE (p_row ->> 'user_id')::uuid END;

  IF p_table = 'job_equipment' THEN
    SELECT user_id INTO v_owner FROM public.jobs WHERE id = (p_row ->> 'job_id')::uuid;
  END IF;
  IF v_owner IS NULL THEN RETURN; END IF;

  IF p_table = 'customers' THEN
    PERFORM public.identity_upsert_native(v_owner, CASE WHEN p_row ->> 'customer_type' = 'commercial' THEN 'company' ELSE 'person' END,
      'customers', p_row ->> 'id', p_row ->> 'name',
      jsonb_strip_nulls(jsonb_build_object('email', p_row -> 'email', 'phone', p_row -> 'phone', 'address', p_row -> 'address',
        'customer_type', p_row -> 'customer_type', 'lifecycle_stage', p_row -> 'lifecycle_stage')));

  ELSIF p_table = 'customer_sites' THEN
    v_id := public.identity_upsert_native(v_owner, 'property', 'customer_sites', p_row ->> 'id', p_row ->> 'name',
      jsonb_strip_nulls(jsonb_build_object('site_type', p_row -> 'site_type', 'address', p_row -> 'address', 'city', p_row -> 'city',
        'state', p_row -> 'state', 'postal_code', p_row -> 'postal_code', 'is_primary', p_row -> 'is_primary')));
    v_other := public.identity_ref_entity(v_owner, 'customers', p_row ->> 'customer_id');
    IF v_other IS NULL THEN
      SELECT to_jsonb(c) INTO v_row FROM public.customers c WHERE c.id = (p_row ->> 'customer_id')::uuid;
      IF v_row IS NOT NULL THEN PERFORM public.identity_sync_row('customers', v_row); v_other := public.identity_ref_entity(v_owner, 'customers', p_row ->> 'customer_id'); END IF;
    END IF;
    IF v_other IS NOT NULL THEN PERFORM public.identity_link_internal(v_owner, v_other, v_id, 'has_site', '{}', NULL, v_src, 'system', NULL, false); END IF;

  ELSIF p_table = 'equipment' THEN
    v_id := public.identity_upsert_native(v_owner, 'equipment', 'equipment', p_row ->> 'id',
      concat_ws(' ', nullif(p_row ->> 'make', ''), nullif(p_row ->> 'model', ''), nullif(p_row ->> 'equipment_type', '')),
      jsonb_strip_nulls(jsonb_build_object('equipment_type', p_row -> 'equipment_type', 'make', p_row -> 'make', 'model', p_row -> 'model',
        'serial_number', p_row -> 'serial_number', 'install_date', p_row -> 'install_date', 'warranty_expires_at', p_row -> 'warranty_expires_at',
        'status', p_row -> 'status', 'expected_lifespan_years', p_row -> 'expected_lifespan_years')),
      p_row ->> 'status' IN ('replaced', 'removed'));
    v_other := public.identity_ref_entity(v_owner, 'customers', p_row ->> 'customer_id');
    IF v_other IS NULL THEN
      SELECT to_jsonb(c) INTO v_row FROM public.customers c WHERE c.id = (p_row ->> 'customer_id')::uuid;
      IF v_row IS NOT NULL THEN PERFORM public.identity_sync_row('customers', v_row); v_other := public.identity_ref_entity(v_owner, 'customers', p_row ->> 'customer_id'); END IF;
    END IF;
    IF v_other IS NOT NULL THEN PERFORM public.identity_link_internal(v_owner, v_other, v_id, 'owns', '{}', NULL, v_src, 'system', NULL, false); END IF;

  ELSIF p_table = 'team_members' THEN
    IF p_row ->> 'role' <> 'technician' THEN RETURN; END IF;
    v_company := public.identity_upsert_native(v_owner, 'company', 'profiles', v_owner::text,
      (SELECT coalesce(nullif(p.company_name, ''), nullif(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = v_owner),
      '{"is_tenant_company": true}'::jsonb);
    v_id := public.identity_upsert_native(v_owner, 'technician', 'team_members', p_row ->> 'id',
      coalesce(nullif(p_row ->> 'member_name', ''), p_row ->> 'member_email'),
      jsonb_strip_nulls(jsonb_build_object('role', p_row -> 'role', 'invite_status', p_row -> 'invite_status', 'email', p_row -> 'member_email')));
    v_other := public.identity_upsert_native(v_owner, 'person', 'team_members_person', p_row ->> 'id',
      coalesce(nullif(p_row ->> 'member_name', ''), p_row ->> 'member_email'),
      jsonb_strip_nulls(jsonb_build_object('email', p_row -> 'member_email')));
    PERFORM public.identity_link_internal(v_owner, v_company, v_id, 'employs', '{}', NULL, v_src, 'system', NULL, false);
    PERFORM public.identity_link_internal(v_owner, v_id, v_other, 'identifies_as', '{}', NULL, v_src, 'system', NULL, false);

  ELSIF p_table = 'jobs' THEN
    v_id := public.identity_upsert_native(v_owner, 'service', 'jobs', p_row ->> 'id',
      concat_ws(' · ', nullif(p_row ->> 'service_type', ''), nullif(p_row ->> 'customer_name', '')),
      jsonb_strip_nulls(jsonb_build_object('service_type', p_row -> 'service_type', 'job_status', p_row -> 'job_status',
        'scheduled_datetime', p_row -> 'scheduled_datetime', 'completed_at', p_row -> 'completed_at', 'address', p_row -> 'address')),
      lower(coalesce(p_row ->> 'job_status', '')) LIKE 'cancel%');
    IF p_row ->> 'customer_id' IS NOT NULL THEN
      v_other := public.identity_ref_entity(v_owner, 'customers', p_row ->> 'customer_id');
      IF v_other IS NOT NULL THEN
        BEGIN PERFORM public.identity_link_internal(v_owner, v_id, v_other, 'requested_by', '{}', NULL, v_src, 'system', NULL, false);
        EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
      END IF;
    END IF;
    IF p_row ->> 'assigned_technician_id' IS NOT NULL THEN
      v_other := public.identity_ref_entity(v_owner, 'team_members', p_row ->> 'assigned_technician_id');
      IF v_other IS NOT NULL THEN PERFORM public.identity_link_internal(v_owner, v_id, v_other, 'performed_by', '{}', NULL, v_src, 'system', NULL, false); END IF;
    END IF;

  ELSIF p_table = 'job_equipment' THEN
    v_id := public.identity_ref_entity(v_owner, 'jobs', p_row ->> 'job_id');
    IF v_id IS NULL THEN
      SELECT to_jsonb(j) INTO v_row FROM public.jobs j WHERE j.id = (p_row ->> 'job_id')::uuid;
      IF v_row IS NOT NULL THEN PERFORM public.identity_sync_row('jobs', v_row); v_id := public.identity_ref_entity(v_owner, 'jobs', p_row ->> 'job_id'); END IF;
    END IF;
    v_other := public.identity_ref_entity(v_owner, 'equipment', p_row ->> 'equipment_id');
    IF v_other IS NULL THEN
      SELECT to_jsonb(q) INTO v_row FROM public.equipment q WHERE q.id = (p_row ->> 'equipment_id')::uuid;
      IF v_row IS NOT NULL THEN PERFORM public.identity_sync_row('equipment', v_row); v_other := public.identity_ref_entity(v_owner, 'equipment', p_row ->> 'equipment_id'); END IF;
    END IF;
    IF v_id IS NOT NULL AND v_other IS NOT NULL THEN
      PERFORM public.identity_link_internal(v_owner, v_id, v_other, 'performed_on', jsonb_strip_nulls(jsonb_build_object('service_type', p_row -> 'service_type')), NULL, v_src, 'system', NULL, false);
    END IF;

  ELSIF p_table IN ('job_outcomes', 'job_evidence_chain_entries', 'invoices') THEN
    v_type := CASE p_table WHEN 'job_outcomes' THEN 'outcome' WHEN 'job_evidence_chain_entries' THEN 'evidence' ELSE 'transaction' END;
    IF p_table = 'job_outcomes' THEN
      v_id := public.identity_upsert_native(v_owner, v_type, p_table, p_row ->> 'id', initcap(replace(coalesce(p_row ->> 'resolution', 'outcome'), '_', ' ')),
        jsonb_strip_nulls(jsonb_build_object('resolution', p_row -> 'resolution', 'root_cause_key', p_row -> 'root_cause_key',
          'playbook_slug', p_row -> 'playbook_slug', 'job_type_key', p_row -> 'job_type_key')));
    ELSIF p_table = 'job_evidence_chain_entries' THEN
      v_id := public.identity_upsert_native(v_owner, v_type, p_table, p_row ->> 'id', p_row ->> 'title',
        jsonb_strip_nulls(jsonb_build_object('stage', p_row -> 'stage', 'kind', p_row -> 'kind', 'seq', p_row -> 'seq', 'actor_type', p_row -> 'actor_type')));
    ELSE
      v_id := public.identity_upsert_native(v_owner, v_type, p_table, p_row ->> 'id',
        concat_ws(' · ', 'Invoice', nullif(p_row ->> 'invoice_number', '')),
        jsonb_strip_nulls(jsonb_build_object('kind', 'invoice', 'status', p_row -> 'status', 'due_date', p_row -> 'due_date',
          'paid_at', p_row -> 'paid_at', 'payment_method', p_row -> 'payment_method')),
        p_row ->> 'status' = 'void');
    END IF;
    IF p_row ->> 'job_id' IS NOT NULL THEN
      v_other := public.identity_ref_entity(v_owner, 'jobs', p_row ->> 'job_id');
      IF v_other IS NULL THEN
        SELECT to_jsonb(j) INTO v_row FROM public.jobs j WHERE j.id = (p_row ->> 'job_id')::uuid;
        IF v_row IS NOT NULL THEN PERFORM public.identity_sync_row('jobs', v_row); v_other := public.identity_ref_entity(v_owner, 'jobs', p_row ->> 'job_id'); END IF;
      END IF;
      IF v_other IS NOT NULL THEN
        PERFORM public.identity_link_internal(v_owner,
          CASE WHEN p_table = 'job_outcomes' THEN v_other ELSE v_id END,
          CASE WHEN p_table = 'job_outcomes' THEN v_id ELSE v_other END,
          CASE p_table WHEN 'job_outcomes' THEN 'produced' WHEN 'job_evidence_chain_entries' THEN 'evidences' ELSE 'settles' END,
          '{}', NULL, v_src, 'system', NULL, false);
      END IF;
    END IF;
    IF p_table = 'job_evidence_chain_entries' AND p_row ->> 'supersedes_id' IS NOT NULL THEN
      v_other := public.identity_ref_entity(v_owner, p_table, p_row ->> 'supersedes_id');
      IF v_other IS NOT NULL THEN
        BEGIN PERFORM public.identity_link_internal(v_owner, v_id, v_other, 'supersedes', '{}', NULL, v_src, 'system', NULL, false);
        EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
      END IF;
    END IF;

  ELSIF p_table = 'marketplace_agent_installs' THEN
    SELECT jsonb_build_object('name', a.name, 'slug', a.slug) INTO v_tmp FROM public.marketplace_agents a WHERE a.id = (p_row ->> 'agent_id')::uuid;
    v_id := public.identity_upsert_native(v_owner, 'agent', p_table, p_row ->> 'id', coalesce(v_tmp ->> 'name', 'Agent'),
      jsonb_strip_nulls(jsonb_build_object('agent_slug', v_tmp -> 'slug', 'status', p_row -> 'status', 'granted_scopes', p_row -> 'granted_scopes')),
      p_row ->> 'status' = 'revoked');
    v_company := public.identity_upsert_native(v_owner, 'company', 'profiles', v_owner::text,
      (SELECT coalesce(nullif(p.company_name, ''), nullif(p.full_name, ''), p.email) FROM public.profiles p WHERE p.id = v_owner),
      '{"is_tenant_company": true}'::jsonb);
    PERFORM public.identity_link_internal(v_owner, v_id, v_company, 'authorized_by', '{}', NULL, v_src, 'system', NULL, false);
  END IF;
END;
$$;

-- Backfill / repair for the calling account. Idempotent; call repeatedly until `more` is false.
CREATE OR REPLACE FUNCTION public.identity_sync_operational(p_limit integer DEFAULT 400)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.identity_require_owner();
  v_limit int := least(greatest(coalesce(p_limit, 400), 1), 1000);
  v_tbl text; v_ownercol text; v_extra text; v_row jsonb; v_n int; v_done jsonb := '{}'::jsonb; v_more boolean := false;
BEGIN
  IF NOT public.identity_layer_is_manager() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  FOREACH v_tbl IN ARRAY ARRAY['customers', 'customer_sites', 'team_members', 'equipment', 'jobs', 'job_outcomes',
                               'job_evidence_chain_entries', 'invoices', 'marketplace_agent_installs'] LOOP
    v_ownercol := CASE v_tbl WHEN 'team_members' THEN 'account_owner_id' ELSE 'user_id' END;
    v_extra := CASE v_tbl WHEN 'team_members' THEN ' AND x.role = ''technician''' ELSE '' END;
    v_n := 0;
    FOR v_row IN EXECUTE format(
      'SELECT to_jsonb(x) FROM public.%I x WHERE x.%I = $1%s AND NOT EXISTS (SELECT 1 FROM public.identity_external_refs f WHERE f.owner_user_id = $1 AND f.system = ''vireek'' AND f.ref_type = %L AND f.ref_value = x.id::text AND f.status = ''active'') ORDER BY x.id LIMIT %s',
      v_tbl, v_ownercol, v_extra, v_tbl, v_limit + 1) USING v_owner LOOP
      EXIT WHEN v_n >= v_limit;
      BEGIN
        PERFORM public.identity_sync_row(v_tbl, v_row);
        v_n := v_n + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'identity sync skipped % %: %', v_tbl, v_row ->> 'id', SQLERRM;
      END;
    END LOOP;
    IF v_n >= v_limit THEN v_more := true; END IF;
    v_done := v_done || jsonb_build_object(v_tbl, v_n);
  END LOOP;
  RETURN jsonb_build_object('synced', v_done, 'more', v_more);
END;
$$;

-- Auto-registration: never blocks a write.
CREATE OR REPLACE FUNCTION public.identity_auto_register_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('vireek.identity_autoregister', true) IS DISTINCT FROM 'off' THEN
    BEGIN
      PERFORM public.identity_sync_row(TG_TABLE_NAME, to_jsonb(NEW));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'identity auto-register skipped for %: %', TG_TABLE_NAME, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'customer_sites', 'equipment', 'jobs', 'job_outcomes', 'job_evidence_chain_entries',
                           'invoices', 'team_members', 'marketplace_agent_installs'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_identity_auto_register ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_identity_auto_register AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.identity_auto_register_trg()', t);
    END IF;
  END LOOP;
  IF to_regclass('public.job_equipment') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_identity_auto_register ON public.job_equipment;
    CREATE TRIGGER trg_identity_auto_register AFTER INSERT ON public.job_equipment FOR EACH ROW EXECUTE FUNCTION public.identity_auto_register_trg();
  END IF;
END $$;

-- =============================================================
-- 8. GRANTS
-- =============================================================

DO $$
DECLARE f text;
BEGIN
  -- internal engine: service_role only
  FOREACH f IN ARRAY ARRAY[
    'identity_append_event(uuid,text,jsonb,text,uuid,text,uuid,uuid)',
    'identity_add_provenance(uuid,uuid,text,jsonb,text,uuid)',
    'identity_register_internal(uuid,text,text,jsonb,jsonb,jsonb,text,uuid)',
    'identity_patch_internal(uuid,text,jsonb,jsonb,text,uuid,integer)',
    'identity_transition_internal(uuid,text,text,text,uuid)',
    'identity_end_edge_internal(uuid,text,text,uuid)',
    'identity_link_internal(uuid,uuid,uuid,text,jsonb,timestamptz,jsonb,text,uuid,boolean)',
    'identity_ref_entity(uuid,text,text)',
    'identity_upsert_native(uuid,text,text,text,text,jsonb,boolean)',
    'identity_sync_row(text,jsonb)',
    'identity_auto_register_trg()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  -- public RPC: authenticated
  FOREACH f IN ARRAY ARRAY[
    'identity_register_entity(text,text,jsonb,jsonb,jsonb)',
    'identity_add_ref(uuid,text,text,text)',
    'identity_resolve_ref(text,text,text)',
    'identity_resolve_uid(text)',
    'identity_update_entity(uuid,jsonb,text,integer,jsonb)',
    'identity_link(uuid,uuid,text,jsonb,timestamptz,jsonb)',
    'identity_unlink(uuid,text)',
    'identity_transition(uuid,text,text)',
    'identity_merge(uuid,uuid,text)',
    'identity_erase(uuid,text)',
    'identity_grant_access(uuid,text,uuid,text[],text,timestamptz)',
    'identity_revoke_grant(uuid,text)',
    'identity_can(uuid,text)',
    'identity_agent_can(uuid,uuid,text)',
    'verify_identity_chain(uuid)',
    'get_identity_entity(uuid)',
    'get_identity_graph(uuid,integer,integer,boolean)',
    'search_identity_entities(text,text[],text[],integer,integer)',
    'get_identity_overview()',
    'identity_sync_operational(integer)',
    'identity_layer_is_manager()',
    'identity_require_owner()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.identity_uid_valid(text) TO authenticated, anon, service_role;
REVOKE ALL ON FUNCTION public.identity_new_uid(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_new_uid(text) TO service_role;

/*
  UNINSTALL (only if ever needed; history is lost):
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'trg_identity_auto_register' LOOP
        EXECUTE format('DROP TRIGGER trg_identity_auto_register ON public.%I', t);
      END LOOP; END $$;
  Disabling just the auto-registration, keeping everything else:  ALTER DATABASE postgres SET vireek.identity_autoregister = 'off';
*/
