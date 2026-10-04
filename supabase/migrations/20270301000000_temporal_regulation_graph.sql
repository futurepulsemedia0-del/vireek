/*
  # Temporal Regulation Graph (bitemporal)

  Jurisdiction -> Code -> Permit -> License -> Inspection -> Environmental rule
  -> Effective date -> Job

  Answers, provably: "On 17 May 2026, for THIS job in THIS jurisdiction, which
  version of each regulation was in force - and what did we know at the time?"

  ## Model
  - regulation_jurisdictions : country > state > county > city > district tree.
      Child jurisdictions INHERIT parent regulations; a node with the same `key`
      in a nearer jurisdiction OVERRIDES the parent's node (local amendments).
  - regulation_nodes         : stable identity of one regulation
      (kind: code / permit / license / inspection / environmental_rule / ordinance / other).
  - regulation_versions      : APPEND-ONLY, two time axes
      * valid time       = effective_from (+ optional expires_on, or a repeal tombstone)
      * transaction time = recorded_at / retracted_at (what we knew, and when)
      A correction is a NEW version recorded later (corrects_id); history is never rewritten.
      Every version carries a SHA-256 content_hash and mandatory provenance
      (citation or source_url, source_type, verification status).
  - regulation_edges         : temporal links between nodes (requires / triggers / inspected_by ...).
  - job_regulation_snapshots : APPEND-ONLY, hash-chained per job. Freezes the resolved
      answer ("Decision Proof") and also writes a system entry to the Job Evidence Chain
      (Data Provenance), fail-safe.

  ## Security
  - Platform-curated rows have owner_id NULL (readable by all, writable by service_role only).
    Tenant rows are scoped by get_account_owner_id(). Clients never write tables directly:
    every write goes through a validated SECURITY DEFINER RPC (technicians are refused).
  - No legal content is seeded - only the jurisdiction tree. Regulation data must come with a citation.

  Purely additive. NOTE: rename the timestamp so it sorts AFTER your newest migration.
*/

CREATE OR REPLACE FUNCTION public.reg_sha256(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;

-- Generic guard: append-only tables. Only the columns listed in TG_ARGV[0] may change;
-- retraction and verification are one-way; deletes are allowed only via FK cascade
-- (account / job deletion).
CREATE OR REPLACE FUNCTION public.reg_guard_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := string_to_array(coalesce(TG_ARGV[0], ''), ',');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'REGULATION_GRAPH_IMMUTABLE: rows in % are append-only; retract instead of deleting', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'REGULATION_GRAPH_IMMUTABLE: rows in % are append-only; record a new version instead', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(OLD) ->> 'retracted_at') IS NOT NULL
     AND (to_jsonb(NEW) ->> 'retracted_at') IS DISTINCT FROM (to_jsonb(OLD) ->> 'retracted_at') THEN
    RAISE EXCEPTION 'REGULATION_GRAPH_IMMUTABLE: already retracted' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(OLD) ->> 'verification_status') = 'verified'
     AND (to_jsonb(NEW) ->> 'verification_status') IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'REGULATION_GRAPH_IMMUTABLE: a verified version cannot be un-verified; retract it instead' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reg_block_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'REGULATION_GRAPH_IMMUTABLE: truncate is not allowed on %', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

-- =============================================================
-- 1. JURISDICTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.regulation_jurisdictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.regulation_jurisdictions(id),
  level text NOT NULL CHECK (level IN ('country', 'state', 'county', 'city', 'district')),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,79}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  depth integer NOT NULL DEFAULT 0,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_jurisdictions_code
  ON public.regulation_jurisdictions (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE INDEX IF NOT EXISTS idx_reg_jurisdictions_parent ON public.regulation_jurisdictions(parent_id);

CREATE OR REPLACE FUNCTION public.reg_jurisdiction_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_rank constant text[] := ARRAY['country', 'state', 'county', 'city', 'district'];
  v_parent public.regulation_jurisdictions%ROWTYPE;
BEGIN
  NEW.code := upper(btrim(NEW.code));
  NEW.name := btrim(NEW.name);
  IF NEW.parent_id IS NULL THEN
    IF NEW.level <> 'country' THEN
      RAISE EXCEPTION 'Only a country can be a top-level jurisdiction.' USING ERRCODE = '22023';
    END IF;
    NEW.depth := 0;
  ELSE
    SELECT * INTO v_parent FROM public.regulation_jurisdictions WHERE id = NEW.parent_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent jurisdiction not found.' USING ERRCODE = 'P0002';
    END IF;
    IF array_position(v_rank, NEW.level) <= array_position(v_rank, v_parent.level) THEN
      RAISE EXCEPTION 'A % cannot sit under a %.', NEW.level, v_parent.level USING ERRCODE = '22023';
    END IF;
    IF v_parent.owner_id IS NOT NULL AND v_parent.owner_id IS DISTINCT FROM NEW.owner_id THEN
      RAISE EXCEPTION 'Parent jurisdiction belongs to another account.' USING ERRCODE = '42501';
    END IF;
    IF NEW.owner_id IS NULL AND v_parent.owner_id IS NOT NULL THEN
      RAISE EXCEPTION 'A platform jurisdiction cannot sit under a private one.' USING ERRCODE = '42501';
    END IF;
    NEW.depth := v_parent.depth + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reg_jurisdiction_before_insert ON public.regulation_jurisdictions;
CREATE TRIGGER trg_reg_jurisdiction_before_insert
  BEFORE INSERT ON public.regulation_jurisdictions
  FOR EACH ROW EXECUTE FUNCTION public.reg_jurisdiction_before_insert();

DROP TRIGGER IF EXISTS trg_reg_jurisdiction_guard ON public.regulation_jurisdictions;
CREATE TRIGGER trg_reg_jurisdiction_guard
  BEFORE UPDATE OR DELETE ON public.regulation_jurisdictions
  FOR EACH ROW EXECUTE FUNCTION public.reg_guard_mutation('');

-- Seed: structure only (no legal content).
INSERT INTO public.regulation_jurisdictions (owner_id, parent_id, level, code, name)
VALUES (NULL, NULL, 'country', 'US', 'United States'),
       (NULL, NULL, 'country', 'GB', 'United Kingdom'),
       (NULL, NULL, 'country', 'CA', 'Canada')
ON CONFLICT DO NOTHING;

INSERT INTO public.regulation_jurisdictions (owner_id, parent_id, level, code, name)
SELECT NULL, (SELECT id FROM public.regulation_jurisdictions WHERE owner_id IS NULL AND code = 'US'),
       'state', 'US-' || s.c, s.n
FROM (VALUES
  ('AL','Alabama'),('AK','Alaska'),('AZ','Arizona'),('AR','Arkansas'),('CA','California'),('CO','Colorado'),
  ('CT','Connecticut'),('DE','Delaware'),('DC','District of Columbia'),('FL','Florida'),('GA','Georgia'),
  ('HI','Hawaii'),('ID','Idaho'),('IL','Illinois'),('IN','Indiana'),('IA','Iowa'),('KS','Kansas'),('KY','Kentucky'),
  ('LA','Louisiana'),('ME','Maine'),('MD','Maryland'),('MA','Massachusetts'),('MI','Michigan'),('MN','Minnesota'),
  ('MS','Mississippi'),('MO','Missouri'),('MT','Montana'),('NE','Nebraska'),('NV','Nevada'),('NH','New Hampshire'),
  ('NJ','New Jersey'),('NM','New Mexico'),('NY','New York'),('NC','North Carolina'),('ND','North Dakota'),
  ('OH','Ohio'),('OK','Oklahoma'),('OR','Oregon'),('PA','Pennsylvania'),('RI','Rhode Island'),('SC','South Carolina'),
  ('SD','South Dakota'),('TN','Tennessee'),('TX','Texas'),('UT','Utah'),('VT','Vermont'),('VA','Virginia'),
  ('WA','Washington'),('WV','West Virginia'),('WI','Wisconsin'),('WY','Wyoming')
) AS s(c, n)
ON CONFLICT DO NOTHING;

-- =============================================================
-- 2. NODES (stable identity of one regulation)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.regulation_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  jurisdiction_id uuid NOT NULL REFERENCES public.regulation_jurisdictions(id),
  kind text NOT NULL CHECK (kind IN ('code', 'permit', 'license', 'inspection', 'environmental_rule', 'ordinance', 'other')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  authority text CHECK (authority IS NULL OR char_length(authority) <= 200),
  work_types text[] NOT NULL DEFAULT '{}' CHECK (cardinality(work_types) <= 20),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_nodes_key
  ON public.regulation_nodes (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), jurisdiction_id, key);
CREATE INDEX IF NOT EXISTS idx_reg_nodes_jurisdiction ON public.regulation_nodes(jurisdiction_id);

CREATE OR REPLACE FUNCTION public.reg_node_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.regulation_jurisdictions WHERE id = NEW.jurisdiction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Jurisdiction not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner IS NOT NULL AND v_owner IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'Jurisdiction belongs to another account.' USING ERRCODE = '42501';
  END IF;
  NEW.key := lower(btrim(NEW.key));
  NEW.title := btrim(NEW.title);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reg_node_before_insert ON public.regulation_nodes;
CREATE TRIGGER trg_reg_node_before_insert
  BEFORE INSERT ON public.regulation_nodes
  FOR EACH ROW EXECUTE FUNCTION public.reg_node_before_insert();

-- Only descriptive text may be refined; identity (jurisdiction, kind, key) is permanent.
DROP TRIGGER IF EXISTS trg_reg_node_guard ON public.regulation_nodes;
CREATE TRIGGER trg_reg_node_guard
  BEFORE UPDATE OR DELETE ON public.regulation_nodes
  FOR EACH ROW EXECUTE FUNCTION public.reg_guard_mutation('title,authority,work_types,description');

-- =============================================================
-- 3. VERSIONS (append-only, bitemporal, hashed, with provenance)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.regulation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES public.regulation_nodes(id) ON DELETE CASCADE,
  version_no integer NOT NULL DEFAULT 0,
  label text CHECK (label IS NULL OR char_length(label) <= 120),
  -- valid time
  effective_from date NOT NULL CHECK (effective_from BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
  expires_on date,
  is_repeal boolean NOT NULL DEFAULT false,
  title text CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 200),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 4000),
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(requirements) = 'array' AND jsonb_array_length(requirements) <= 40),
  -- provenance
  citation text CHECK (citation IS NULL OR char_length(citation) <= 500),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://[^[:space:]]{3,500}$'),
  source_type text NOT NULL DEFAULT 'other'
    CHECK (source_type IN ('statute', 'code_adoption', 'ordinance', 'agency_rule', 'agency_notice', 'internal_policy', 'other')),
  retrieved_on date,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified')),
  verified_by uuid,
  verified_at timestamptz,
  corrects_id uuid REFERENCES public.regulation_versions(id),
  -- transaction time
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by uuid DEFAULT auth.uid(),
  retracted_at timestamptz,
  retracted_by uuid,
  retracted_reason text CHECK (retracted_reason IS NULL OR char_length(retracted_reason) <= 500),
  content_hash text NOT NULL DEFAULT '',
  CONSTRAINT reg_versions_expiry_after_start CHECK (expires_on IS NULL OR expires_on > effective_from),
  CONSTRAINT reg_versions_body CHECK (is_repeal OR (title IS NOT NULL AND char_length(btrim(coalesce(summary, ''))) > 0)),
  CONSTRAINT reg_versions_provenance CHECK (char_length(btrim(coalesce(citation, ''))) > 0 OR source_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_reg_versions_resolve ON public.regulation_versions(node_id, effective_from DESC, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_reg_versions_owner ON public.regulation_versions(owner_id);

CREATE OR REPLACE FUNCTION public.reg_version_hash(v public.regulation_versions)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT public.reg_sha256(concat_ws('|',
    v.node_id::text, v.version_no::text, v.effective_from::text, coalesce(v.expires_on::text, ''),
    v.is_repeal::text, coalesce(v.title, ''), coalesce(v.summary, ''), v.requirements::text,
    coalesce(v.citation, ''), coalesce(v.source_url, ''), v.source_type, coalesce(v.corrects_id::text, '')));
$$;

CREATE OR REPLACE FUNCTION public.reg_seal_version()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.regulation_nodes WHERE id = NEW.node_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Regulation not found.' USING ERRCODE = 'P0002';
  END IF;

  -- Serialize writers per node so version_no can never fork.
  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:regulation:' || NEW.node_id::text, 0));

  IF NEW.corrects_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.regulation_versions WHERE id = NEW.corrects_id AND node_id = NEW.node_id
  ) THEN
    RAISE EXCEPTION 'The corrected version must belong to the same regulation.' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(max(version_no), 0) + 1 INTO NEW.version_no
  FROM public.regulation_versions WHERE node_id = NEW.node_id;

  NEW.owner_id := v_owner;
  NEW.recorded_at := clock_timestamp();
  NEW.verification_status := 'unverified';
  NEW.verified_by := NULL;
  NEW.verified_at := NULL;
  NEW.retracted_at := NULL;
  NEW.retracted_by := NULL;
  NEW.retracted_reason := NULL;
  NEW.content_hash := public.reg_version_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reg_seal_version ON public.regulation_versions;
CREATE TRIGGER trg_reg_seal_version
  BEFORE INSERT ON public.regulation_versions
  FOR EACH ROW EXECUTE FUNCTION public.reg_seal_version();

DROP TRIGGER IF EXISTS trg_reg_version_guard ON public.regulation_versions;
CREATE TRIGGER trg_reg_version_guard
  BEFORE UPDATE OR DELETE ON public.regulation_versions
  FOR EACH ROW EXECUTE FUNCTION public.reg_guard_mutation('retracted_at,retracted_by,retracted_reason,verification_status,verified_by,verified_at');

DROP TRIGGER IF EXISTS trg_reg_version_truncate ON public.regulation_versions;
CREATE TRIGGER trg_reg_version_truncate
  BEFORE TRUNCATE ON public.regulation_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reg_block_truncate();

-- =============================================================
-- 4. EDGES (temporal relationships between regulations)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.regulation_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL REFERENCES public.regulation_nodes(id) ON DELETE CASCADE,
  to_node_id uuid NOT NULL REFERENCES public.regulation_nodes(id) ON DELETE CASCADE,
  edge_type text NOT NULL CHECK (edge_type IN ('requires', 'triggers', 'inspected_by', 'licensed_by', 'governed_by', 'amends', 'references')),
  valid_from date NOT NULL CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
  valid_to date,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by uuid DEFAULT auth.uid(),
  retracted_at timestamptz,
  retracted_by uuid,
  retracted_reason text CHECK (retracted_reason IS NULL OR char_length(retracted_reason) <= 500),
  CONSTRAINT reg_edges_distinct CHECK (from_node_id <> to_node_id),
  CONSTRAINT reg_edges_range CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS idx_reg_edges_from ON public.regulation_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_reg_edges_to ON public.regulation_edges(to_node_id);

CREATE OR REPLACE FUNCTION public.reg_edge_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.regulation_nodes n
  WHERE n.id IN (NEW.from_node_id, NEW.to_node_id)
    AND n.owner_id IS NOT NULL AND n.owner_id IS DISTINCT FROM NEW.owner_id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'An edge can only connect platform regulations and your own.' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.regulation_nodes WHERE id IN (NEW.from_node_id, NEW.to_node_id)) <> 2 THEN
    RAISE EXCEPTION 'Both regulations must exist.' USING ERRCODE = 'P0002';
  END IF;
  NEW.recorded_at := clock_timestamp();
  NEW.retracted_at := NULL;
  NEW.retracted_by := NULL;
  NEW.retracted_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reg_edge_before_insert ON public.regulation_edges;
CREATE TRIGGER trg_reg_edge_before_insert
  BEFORE INSERT ON public.regulation_edges
  FOR EACH ROW EXECUTE FUNCTION public.reg_edge_before_insert();

DROP TRIGGER IF EXISTS trg_reg_edge_guard ON public.regulation_edges;
CREATE TRIGGER trg_reg_edge_guard
  BEFORE UPDATE OR DELETE ON public.regulation_edges
  FOR EACH ROW EXECUTE FUNCTION public.reg_guard_mutation('retracted_at,retracted_by,retracted_reason');

-- =============================================================
-- 5. JOB SNAPSHOTS (Decision Proof, hash-chained per job)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_regulation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  seq integer NOT NULL DEFAULT 0,
  jurisdiction_id uuid NOT NULL REFERENCES public.regulation_jurisdictions(id),
  jurisdiction_code text NOT NULL,
  jurisdiction_label text NOT NULL,
  as_of date NOT NULL,
  as_of_basis text NOT NULL DEFAULT 'manual' CHECK (as_of_basis IN ('scheduled', 'today', 'manual')),
  known_at timestamptz NOT NULL,
  work_types text[] NOT NULL DEFAULT '{}',
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  edges jsonb NOT NULL DEFAULT '[]'::jsonb,
  entries_digest text NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  prev_hash text,
  snapshot_hash text NOT NULL DEFAULT '',
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_job_reg_snapshots_job ON public.job_regulation_snapshots(job_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_job_reg_snapshots_user ON public.job_regulation_snapshots(user_id);

CREATE OR REPLACE FUNCTION public.reg_entries_digest(p_entries jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT public.reg_sha256(coalesce(string_agg(
    concat_ws(':', e ->> 'node_id', e ->> 'version_id', e ->> 'content_hash', e ->> 'status'),
    ',' ORDER BY e ->> 'node_id'), ''))
  FROM jsonb_array_elements(p_entries) AS e;
$$;

CREATE OR REPLACE FUNCTION public.reg_snapshot_hash(s public.job_regulation_snapshots)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT public.reg_sha256(concat_ws('|',
    coalesce(s.prev_hash, 'GENESIS'), s.job_id::text, s.seq::text, s.jurisdiction_id::text, s.as_of::text,
    to_char(s.known_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    array_to_string(s.work_types, ','), s.entries_digest, coalesce(s.reason, '')));
$$;

CREATE OR REPLACE FUNCTION public.reg_seal_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_last_seq integer;
  v_last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:regulation-snapshot:' || NEW.job_id::text, 0));
  SELECT seq, snapshot_hash INTO v_last_seq, v_last_hash
  FROM public.job_regulation_snapshots WHERE job_id = NEW.job_id ORDER BY seq DESC LIMIT 1;

  NEW.seq := coalesce(v_last_seq, 0) + 1;
  NEW.prev_hash := v_last_hash;
  NEW.entries_digest := public.reg_entries_digest(NEW.entries);
  NEW.snapshot_hash := public.reg_snapshot_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reg_seal_snapshot ON public.job_regulation_snapshots;
CREATE TRIGGER trg_reg_seal_snapshot
  BEFORE INSERT ON public.job_regulation_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.reg_seal_snapshot();

DROP TRIGGER IF EXISTS trg_reg_snapshot_guard ON public.job_regulation_snapshots;
CREATE TRIGGER trg_reg_snapshot_guard
  BEFORE UPDATE OR DELETE ON public.job_regulation_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.reg_guard_mutation('');

DROP TRIGGER IF EXISTS trg_reg_snapshot_truncate ON public.job_regulation_snapshots;
CREATE TRIGGER trg_reg_snapshot_truncate
  BEFORE TRUNCATE ON public.job_regulation_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.reg_block_truncate();

-- =============================================================
-- 6. RLS + grants (reads via RLS; every write goes through an RPC)
-- =============================================================

ALTER TABLE public.regulation_jurisdictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regulation_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regulation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regulation_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_regulation_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reg_jurisdictions_select" ON public.regulation_jurisdictions;
CREATE POLICY "reg_jurisdictions_select" ON public.regulation_jurisdictions FOR SELECT TO authenticated
  USING (owner_id IS NULL OR owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "reg_nodes_select" ON public.regulation_nodes;
CREATE POLICY "reg_nodes_select" ON public.regulation_nodes FOR SELECT TO authenticated
  USING (owner_id IS NULL OR owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "reg_versions_select" ON public.regulation_versions;
CREATE POLICY "reg_versions_select" ON public.regulation_versions FOR SELECT TO authenticated
  USING (owner_id IS NULL OR owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "reg_edges_select" ON public.regulation_edges;
CREATE POLICY "reg_edges_select" ON public.regulation_edges FOR SELECT TO authenticated
  USING (owner_id IS NULL OR owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "reg_snapshots_select" ON public.job_regulation_snapshots;
CREATE POLICY "reg_snapshots_select" ON public.job_regulation_snapshots FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE ALL ON public.regulation_jurisdictions, public.regulation_nodes, public.regulation_versions,
  public.regulation_edges, public.job_regulation_snapshots FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.regulation_jurisdictions, public.regulation_nodes,
  public.regulation_versions, public.regulation_edges, public.job_regulation_snapshots FROM authenticated;
GRANT SELECT ON public.regulation_jurisdictions, public.regulation_nodes, public.regulation_versions,
  public.regulation_edges, public.job_regulation_snapshots TO authenticated;
GRANT ALL ON public.regulation_jurisdictions, public.regulation_nodes, public.regulation_versions,
  public.regulation_edges, public.job_regulation_snapshots TO service_role;

-- =============================================================
-- 7. INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.reg_assert_manager()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid() AND tm.role = 'technician') THEN
    RAISE EXCEPTION 'Only managers can change the regulation graph.' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

-- The time-travel resolver. Visibility is enforced here via p_owner (callers are SECURITY DEFINER).
-- Per node: the latest version with effective_from <= as_of that was recorded and not yet retracted
-- at known_at. A nearer jurisdiction's node with the same key overrides its ancestors'.
CREATE OR REPLACE FUNCTION public.reg_resolve_core(
  p_owner uuid, p_jurisdiction_id uuid, p_as_of date, p_known_at timestamptz, p_work_types text[]
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_jur public.regulation_jurisdictions%ROWTYPE;
  v_chain jsonb;
  v_entries jsonb;
  v_edges jsonb;
BEGIN
  SELECT * INTO v_jur FROM public.regulation_jurisdictions j
   WHERE j.id = p_jurisdiction_id AND (j.owner_id IS NULL OR j.owner_id = p_owner);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Jurisdiction not found.' USING ERRCODE = 'P0002';
  END IF;

  WITH RECURSIVE chain AS (
    SELECT j.id, j.parent_id, j.code, j.name, j.level, 0 AS dist
      FROM public.regulation_jurisdictions j WHERE j.id = v_jur.id
    UNION ALL
    SELECT p.id, p.parent_id, p.code, p.name, p.level, c.dist + 1
      FROM public.regulation_jurisdictions p JOIN chain c ON p.id = c.parent_id
     WHERE (p.owner_id IS NULL OR p.owner_id = p_owner)
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'level', level, 'dist', dist) ORDER BY dist DESC)
    INTO v_chain FROM chain;

  WITH latest AS (
    SELECT DISTINCT ON (n.id)
      n.id AS node_id, n.owner_id AS node_owner, n.key, n.kind, n.title AS node_title, n.authority,
      c.dist, c.code AS jcode, c.name AS jname,
      v.id AS version_id, v.version_no, v.label, v.effective_from, v.expires_on, v.is_repeal,
      v.title AS v_title, v.summary, v.requirements, v.citation, v.source_url, v.source_type,
      v.verification_status, v.content_hash, v.recorded_at
    FROM public.regulation_nodes n
    JOIN jsonb_to_recordset(v_chain) AS c(id uuid, code text, name text, dist integer) ON c.id = n.jurisdiction_id
    JOIN public.regulation_versions v ON v.node_id = n.id
    WHERE (n.owner_id IS NULL OR n.owner_id = p_owner)
      AND (v.owner_id IS NULL OR v.owner_id = p_owner)
      AND v.effective_from <= p_as_of
      AND v.recorded_at <= p_known_at
      AND (v.retracted_at IS NULL OR v.retracted_at > p_known_at)
      AND (cardinality(p_work_types) = 0 OR cardinality(n.work_types) = 0 OR n.work_types && p_work_types)
    ORDER BY n.id, v.effective_from DESC, v.recorded_at DESC
  ), winners AS (
    SELECT DISTINCT ON (l.key) l.* FROM latest l ORDER BY l.key, l.dist ASC, (l.node_owner IS NULL) ASC
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'node_id', w.node_id, 'key', w.key, 'kind', w.kind,
      'title', coalesce(w.v_title, w.node_title), 'authority', w.authority,
      'jurisdiction_code', w.jcode, 'jurisdiction_name', w.jname, 'inherited', w.dist > 0,
      'version_id', w.version_id, 'version_no', w.version_no, 'label', w.label,
      'effective_from', w.effective_from, 'expires_on', w.expires_on,
      'status', CASE WHEN w.is_repeal THEN 'repealed'
                     WHEN w.expires_on IS NOT NULL AND p_as_of >= w.expires_on THEN 'expired'
                     ELSE 'in_force' END,
      'summary', w.summary, 'requirements', w.requirements, 'citation', w.citation,
      'source_url', w.source_url, 'source_type', w.source_type,
      'verification_status', w.verification_status, 'content_hash', w.content_hash, 'recorded_at', w.recorded_at
    ) ORDER BY array_position(ARRAY['code','permit','license','inspection','environmental_rule','ordinance','other'], w.kind), w.key), '[]'::jsonb)
    INTO v_entries FROM winners w;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'from_node_id', e.from_node_id, 'to_node_id', e.to_node_id, 'edge_type', e.edge_type,
      'valid_from', e.valid_from, 'valid_to', e.valid_to, 'note', e.note)), '[]'::jsonb)
    INTO v_edges
  FROM public.regulation_edges e
  WHERE (e.owner_id IS NULL OR e.owner_id = p_owner)
    AND e.valid_from <= p_as_of AND (e.valid_to IS NULL OR p_as_of < e.valid_to)
    AND e.recorded_at <= p_known_at AND (e.retracted_at IS NULL OR e.retracted_at > p_known_at)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) x WHERE (x ->> 'node_id')::uuid = e.from_node_id)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) x WHERE (x ->> 'node_id')::uuid = e.to_node_id);

  RETURN jsonb_build_object(
    'jurisdiction', jsonb_build_object('id', v_jur.id, 'code', v_jur.code, 'name', v_jur.name, 'level', v_jur.level),
    'jurisdiction_path', v_chain,
    'as_of', p_as_of,
    'known_at', p_known_at,
    'entries', v_entries,
    'edges', v_edges,
    'counts', jsonb_build_object(
      'total', jsonb_array_length(v_entries),
      'in_force', (SELECT count(*) FROM jsonb_array_elements(v_entries) x WHERE x ->> 'status' = 'in_force'),
      'ended', (SELECT count(*) FROM jsonb_array_elements(v_entries) x WHERE x ->> 'status' <> 'in_force'),
      'unverified', (SELECT count(*) FROM jsonb_array_elements(v_entries) x
                      WHERE x ->> 'status' = 'in_force' AND x ->> 'verification_status' <> 'verified'))
  );
END;
$$;

-- Deepest visible jurisdiction matching country / state / city (city matched by normalized code).
CREATE OR REPLACE FUNCTION public.reg_find_jurisdiction_core(p_owner uuid, p_country text, p_state text, p_city text)
RETURNS public.regulation_jurisdictions LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_country text := upper(nullif(btrim(coalesce(p_country, '')), ''));
  v_state text := upper(nullif(btrim(coalesce(p_state, '')), ''));
  v_slug text := nullif(trim(both '-' from regexp_replace(upper(coalesce(p_city, '')), '[^A-Z0-9]+', '-', 'g')), '');
  v_codes text[];
  v_row public.regulation_jurisdictions%ROWTYPE;
BEGIN
  IF v_country IS NULL THEN RETURN NULL; END IF;
  v_codes := array_remove(ARRAY[
    v_country,
    CASE WHEN v_state IS NOT NULL THEN v_country || '-' || v_state END,
    CASE WHEN v_state IS NOT NULL AND v_slug IS NOT NULL THEN v_country || '-' || v_state || '-' || v_slug END
  ], NULL);
  SELECT * INTO v_row FROM public.regulation_jurisdictions j
   WHERE j.code = ANY (v_codes) AND (j.owner_id IS NULL OR j.owner_id = p_owner)
   ORDER BY j.depth DESC, (j.owner_id IS NULL) ASC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.reg_assert_manager() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reg_resolve_core(uuid, uuid, date, timestamptz, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reg_find_jurisdiction_core(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 8. PUBLIC RPCs - READ / TIME TRAVEL
-- =============================================================

-- "What was in force on p_as_of, as we knew it at p_known_at (default: now)?"
CREATE OR REPLACE FUNCTION public.regulation_resolve(
  p_jurisdiction_id uuid, p_as_of date, p_known_at timestamptz DEFAULT NULL, p_work_types text[] DEFAULT '{}'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_now timestamptz := clock_timestamp();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF p_as_of IS NULL OR p_as_of < DATE '1900-01-01' OR p_as_of > DATE '2200-01-01' THEN
    RAISE EXCEPTION 'A valid date is required.' USING ERRCODE = '22023';
  END IF;
  RETURN public.reg_resolve_core(
    v_owner, p_jurisdiction_id, p_as_of, LEAST(coalesce(p_known_at, v_now), v_now),
    coalesce((SELECT array_agg(lower(btrim(t))) FROM unnest(coalesce(p_work_types, '{}')) AS t), '{}'));
END;
$$;

-- Job context: default as-of date (scheduled date, else today), jurisdiction detected from the job's
-- compliance review, and the review's work types.
CREATE OR REPLACE FUNCTION public.regulation_job_context(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_sched timestamptz;
  v_review public.job_compliance_reviews%ROWTYPE;
  v_jur public.regulation_jurisdictions%ROWTYPE;
  v_has_review boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  SELECT j.scheduled_datetime INTO v_sched FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_review FROM public.job_compliance_reviews WHERE job_id = p_job_id AND user_id = v_owner;
  v_has_review := FOUND;
  IF v_has_review THEN
    v_jur := public.reg_find_jurisdiction_core(
      v_owner, v_review.jurisdiction ->> 'country', v_review.jurisdiction ->> 'state', v_review.jurisdiction ->> 'city');
  END IF;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'as_of', coalesce(v_sched::date, current_date),
    'as_of_basis', CASE WHEN v_sched IS NOT NULL THEN 'scheduled' ELSE 'today' END,
    'has_review', v_has_review,
    'review_jurisdiction_label', CASE WHEN v_has_review THEN v_review.jurisdiction ->> 'label' END,
    'work_types', CASE WHEN v_has_review AND jsonb_typeof(v_review.work_types) = 'array'
                       THEN coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements_text(v_review.work_types) AS t), '[]'::jsonb)
                       ELSE '[]'::jsonb END,
    'jurisdiction', CASE WHEN v_jur.id IS NOT NULL
                         THEN jsonb_build_object('id', v_jur.id, 'code', v_jur.code, 'name', v_jur.name, 'level', v_jur.level) END
  );
END;
$$;

-- =============================================================
-- 9. PUBLIC RPCs - DECISION PROOF (snapshots)
-- =============================================================

CREATE OR REPLACE FUNCTION public.regulation_record_job_snapshot(
  p_job_id uuid, p_jurisdiction_id uuid, p_as_of date, p_reason text DEFAULT NULL, p_basis text DEFAULT 'manual'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_now timestamptz := clock_timestamp();
  v_basis text := CASE WHEN p_basis IN ('scheduled', 'today', 'manual') THEN p_basis ELSE 'manual' END;
  v_reason text := NULLIF(left(btrim(coalesce(p_reason, '')), 500), '');
  v_work text[] := '{}';
  v_res jsonb;
  v_last public.job_regulation_snapshots%ROWTYPE;
  v_row public.job_regulation_snapshots%ROWTYPE;
  v_digest text;
  v_ev uuid;
BEGIN
  IF p_as_of IS NULL OR p_as_of < DATE '1900-01-01' OR p_as_of > DATE '2200-01-01' THEN
    RAISE EXCEPTION 'A valid date is required.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(array_agg(lower(t)), '{}') INTO v_work
  FROM public.job_compliance_reviews r, jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(r.work_types) = 'array' THEN r.work_types ELSE '[]'::jsonb END) AS t
  WHERE r.job_id = p_job_id AND r.user_id = v_owner;

  v_res := public.reg_resolve_core(v_owner, p_jurisdiction_id, p_as_of, v_now, v_work);
  v_digest := public.reg_entries_digest(v_res -> 'entries');

  -- Idempotent: an identical answer for the same job / place / date is not re-recorded.
  SELECT * INTO v_last FROM public.job_regulation_snapshots WHERE job_id = p_job_id ORDER BY seq DESC LIMIT 1;
  IF FOUND AND v_last.jurisdiction_id = p_jurisdiction_id AND v_last.as_of = p_as_of
     AND v_last.entries_digest = v_digest AND v_last.work_types = v_work THEN
    RETURN jsonb_build_object('id', v_last.id, 'seq', v_last.seq, 'snapshot_hash', v_last.snapshot_hash,
      'as_of', v_last.as_of, 'jurisdiction_code', v_last.jurisdiction_code, 'deduplicated', true,
      'entry_count', jsonb_array_length(v_last.entries));
  END IF;

  INSERT INTO public.job_regulation_snapshots
    (user_id, job_id, jurisdiction_id, jurisdiction_code, jurisdiction_label, as_of, as_of_basis,
     known_at, work_types, entries, edges, reason)
  VALUES
    (v_owner, p_job_id, p_jurisdiction_id, v_res -> 'jurisdiction' ->> 'code',
     (SELECT string_agg(x ->> 'name', ', ' ORDER BY (x ->> 'dist')::int) FROM jsonb_array_elements(v_res -> 'jurisdiction_path') x),
     p_as_of, v_basis, v_now, v_work, v_res -> 'entries', v_res -> 'edges', v_reason)
  RETURNING * INTO v_row;

  -- Data Provenance: mirror into the Job Evidence Chain (stage "problem" = job context; it is already
  -- satisfied by the auto "Service request opened" entry, so this never inflates evidence scoring).
  -- Fail-safe: never blocks the snapshot.
  BEGIN
    v_ev := public.record_job_evidence_system(
      p_job_id, 'problem', 'system',
      left('Regulation snapshot: ' || v_row.jurisdiction_code || ' as of ' || v_row.as_of::text, 200),
      left(jsonb_array_length(v_row.entries)::text || ' regulations resolved'
           || CASE WHEN v_reason IS NOT NULL THEN ' - ' || v_reason ELSE '' END, 4000),
      jsonb_build_object('snapshot_id', v_row.id, 'snapshot_hash', v_row.snapshot_hash, 'as_of', v_row.as_of,
        'jurisdiction_code', v_row.jurisdiction_code, 'known_at', v_row.known_at,
        'versions', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x ->> 'key', 'version_no', (x ->> 'version_no')::int,
                      'status', x ->> 'status', 'content_hash', x ->> 'content_hash')), '[]'::jsonb)
                     FROM jsonb_array_elements(v_row.entries) x)),
      'system', 'regulation-snapshot:' || v_row.id::text);
  EXCEPTION WHEN OTHERS THEN
    v_ev := NULL;
  END;

  PERFORM public.log_audit_event(v_owner, 'regulation.snapshot.recorded', 'job_regulation_snapshots', v_row.id::text);

  RETURN jsonb_build_object('id', v_row.id, 'seq', v_row.seq, 'snapshot_hash', v_row.snapshot_hash,
    'as_of', v_row.as_of, 'jurisdiction_code', v_row.jurisdiction_code, 'deduplicated', false,
    'evidence_linked', v_ev IS NOT NULL, 'entry_count', jsonb_array_length(v_row.entries));
END;
$$;

-- Snapshot history + integrity (hash chain, version tamper check) + drift (retroactive corrections).
CREATE OR REPLACE FUNCTION public.regulation_snapshot_report(p_job_id uuid, p_limit integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  s public.job_regulation_snapshots%ROWTYPE;
  v_prev text := NULL;
  v_chain_ok boolean := true;
  v_broken integer := NULL;
  v_items jsonb := '[]'::jsonb;
  v_now jsonb;
  v_drift jsonb;
  v_versions_ok boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found.' USING ERRCODE = 'P0002';
  END IF;

  FOR s IN SELECT * FROM public.job_regulation_snapshots WHERE job_id = p_job_id AND user_id = v_owner ORDER BY seq ASC LOOP
    IF v_chain_ok AND (s.prev_hash IS DISTINCT FROM v_prev OR s.snapshot_hash <> public.reg_snapshot_hash(s)
                       OR s.entries_digest <> public.reg_entries_digest(s.entries)) THEN
      v_chain_ok := false;
      v_broken := s.seq;
    END IF;
    v_prev := s.snapshot_hash;
  END LOOP;

  FOR s IN SELECT * FROM public.job_regulation_snapshots WHERE job_id = p_job_id AND user_id = v_owner ORDER BY seq DESC LIMIT v_limit LOOP
    SELECT NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(s.entries) e
      LEFT JOIN public.regulation_versions v ON v.id = (e ->> 'version_id')::uuid
      WHERE v.id IS NULL OR v.content_hash <> public.reg_version_hash(v) OR v.content_hash <> e ->> 'content_hash'
    ) INTO v_versions_ok;

    v_now := public.reg_resolve_core(v_owner, s.jurisdiction_id, s.as_of, clock_timestamp(), s.work_types);
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'key', coalesce(d.a ->> 'key', d.b ->> 'key'),
        'was_version', (d.a ->> 'version_no')::int, 'now_version', (d.b ->> 'version_no')::int,
        'was_status', d.a ->> 'status', 'now_status', d.b ->> 'status')), '[]'::jsonb)
      INTO v_drift
    FROM (
      SELECT a.e AS a, b.e AS b
      FROM jsonb_array_elements(s.entries) AS a(e)
      FULL OUTER JOIN jsonb_array_elements(v_now -> 'entries') AS b(e) ON a.e ->> 'node_id' = b.e ->> 'node_id'
      WHERE (a.e ->> 'version_id') IS DISTINCT FROM (b.e ->> 'version_id')
         OR (a.e ->> 'status') IS DISTINCT FROM (b.e ->> 'status')
    ) d;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', s.id, 'seq', s.seq, 'as_of', s.as_of, 'as_of_basis', s.as_of_basis, 'known_at', s.known_at,
      'jurisdiction_code', s.jurisdiction_code, 'jurisdiction_label', s.jurisdiction_label,
      'work_types', to_jsonb(s.work_types), 'reason', s.reason, 'snapshot_hash', s.snapshot_hash,
      'created_at', s.created_at, 'entries', s.entries,
      'versions_intact', v_versions_ok,
      'drifted', jsonb_array_length(v_drift) > 0, 'drift', v_drift));
  END LOOP;

  RETURN jsonb_build_object('snapshots', v_items,
    'integrity', jsonb_build_object('chain_ok', v_chain_ok, 'broken_at_seq', v_broken));
END;
$$;

-- =============================================================
-- 10. PUBLIC RPCs - REGISTRY WRITES (tenant-scoped, managers only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.regulation_add_jurisdiction(p_parent_id uuid, p_level text, p_name text, p_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_parent public.regulation_jurisdictions%ROWTYPE;
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text;
  v_code text;
  v_row public.regulation_jurisdictions%ROWTYPE;
BEGIN
  SELECT * INTO v_parent FROM public.regulation_jurisdictions
   WHERE id = p_parent_id AND (owner_id IS NULL OR owner_id = v_owner);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent jurisdiction not found.' USING ERRCODE = 'P0002';
  END IF;
  v_slug := trim(both '-' from regexp_replace(upper(v_name), '[^A-Z0-9]+', '-', 'g'));
  v_code := upper(btrim(coalesce(nullif(btrim(p_code), ''), v_parent.code || '-' || v_slug)));
  IF char_length(v_name) < 1 OR v_slug = '' THEN
    RAISE EXCEPTION 'A name is required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.regulation_jurisdictions WHERE owner_id = v_owner AND code = v_code;
  IF FOUND THEN RETURN to_jsonb(v_row); END IF;

  INSERT INTO public.regulation_jurisdictions (owner_id, parent_id, level, code, name)
  VALUES (v_owner, p_parent_id, p_level, v_code, v_name) RETURNING * INTO v_row;
  PERFORM public.log_audit_event(v_owner, 'regulation.jurisdiction.added', 'regulation_jurisdictions', v_row.id::text);
  RETURN to_jsonb(v_row);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'That jurisdiction name or code is not valid.' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.regulation_add_node(
  p_jurisdiction_id uuid, p_kind text, p_key text, p_title text,
  p_authority text DEFAULT NULL, p_work_types text[] DEFAULT '{}', p_description text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_row public.regulation_nodes%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.regulation_jurisdictions
                  WHERE id = p_jurisdiction_id AND (owner_id IS NULL OR owner_id = v_owner)) THEN
    RAISE EXCEPTION 'Jurisdiction not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.regulation_nodes (owner_id, jurisdiction_id, kind, key, title, authority, work_types, description)
  VALUES (v_owner, p_jurisdiction_id, p_kind, lower(btrim(coalesce(p_key, ''))), btrim(coalesce(p_title, '')),
          NULLIF(left(btrim(coalesce(p_authority, '')), 200), ''),
          coalesce((SELECT array_agg(DISTINCT lower(btrim(t))) FROM unnest(coalesce(p_work_types, '{}')) AS t WHERE btrim(t) <> ''), '{}'),
          NULLIF(left(btrim(coalesce(p_description, '')), 2000), ''))
  RETURNING * INTO v_row;
  PERFORM public.log_audit_event(v_owner, 'regulation.node.added', 'regulation_nodes', v_row.id::text);
  RETURN to_jsonb(v_row);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'A regulation with this key already exists in this jurisdiction.' USING ERRCODE = '23505';
  WHEN check_violation THEN
    RAISE EXCEPTION 'Check the key (lowercase letters, digits, . _ -), kind and title.' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.regulation_add_version(
  p_node_id uuid, p_effective_from date, p_is_repeal boolean DEFAULT false, p_expires_on date DEFAULT NULL,
  p_title text DEFAULT NULL, p_summary text DEFAULT NULL, p_requirements jsonb DEFAULT '[]'::jsonb,
  p_citation text DEFAULT NULL, p_source_url text DEFAULT NULL, p_source_type text DEFAULT 'other',
  p_retrieved_on date DEFAULT NULL, p_label text DEFAULT NULL, p_corrects_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_row public.regulation_versions%ROWTYPE;
  v_req jsonb := coalesce(p_requirements, '[]'::jsonb);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.regulation_nodes WHERE id = p_node_id AND owner_id = v_owner) THEN
    RAISE EXCEPTION 'Regulation not found (platform regulations are read-only).' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(v_req) <> 'array' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_req) r
    WHERE jsonb_typeof(r) <> 'object' OR char_length(btrim(coalesce(r ->> 'title', ''))) = 0
       OR char_length(r ->> 'title') > 200 OR char_length(coalesce(r ->> 'detail', '')) > 1000
       OR coalesce(r ->> 'severity', 'info') NOT IN ('blocker', 'warning', 'info')
  ) THEN
    RAISE EXCEPTION 'Each requirement needs a title (max 200) and a severity of blocker, warning or info.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.regulation_versions
    (node_id, effective_from, is_repeal, expires_on, title, summary, requirements, citation, source_url,
     source_type, retrieved_on, label, corrects_id)
  VALUES
    (p_node_id, p_effective_from, coalesce(p_is_repeal, false), p_expires_on,
     NULLIF(left(btrim(coalesce(p_title, '')), 200), ''), NULLIF(left(btrim(coalesce(p_summary, '')), 4000), ''),
     v_req, NULLIF(left(btrim(coalesce(p_citation, '')), 500), ''), NULLIF(btrim(coalesce(p_source_url, '')), ''),
     coalesce(p_source_type, 'other'), p_retrieved_on, NULLIF(left(btrim(coalesce(p_label, '')), 120), ''), p_corrects_id)
  RETURNING * INTO v_row;
  PERFORM public.log_audit_event(v_owner, 'regulation.version.added', 'regulation_versions', v_row.id::text);
  RETURN to_jsonb(v_row);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'Check the dates, title, summary and that a citation or source link is provided.' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.regulation_retract_version(p_version_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_reason text := left(btrim(coalesce(p_reason, '')), 500);
  v_row public.regulation_versions%ROWTYPE;
BEGIN
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'A reason (at least 8 characters) is required to retract a version.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.regulation_versions
     SET retracted_at = clock_timestamp(), retracted_by = auth.uid(), retracted_reason = v_reason
   WHERE id = p_version_id AND owner_id = v_owner AND retracted_at IS NULL
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version not found, already retracted, or platform-owned.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'regulation.version.retracted', 'regulation_versions', v_row.id::text);
  RETURN jsonb_build_object('id', v_row.id, 'retracted_at', v_row.retracted_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.regulation_verify_version(p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_row public.regulation_versions%ROWTYPE;
BEGIN
  UPDATE public.regulation_versions
     SET verification_status = 'verified', verified_by = auth.uid(), verified_at = clock_timestamp()
   WHERE id = p_version_id AND owner_id = v_owner AND retracted_at IS NULL AND verification_status = 'unverified'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version not found, retracted, already verified, or platform-owned.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'regulation.version.verified', 'regulation_versions', v_row.id::text);
  RETURN jsonb_build_object('id', v_row.id, 'verified_at', v_row.verified_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.regulation_add_edge(
  p_from_node_id uuid, p_to_node_id uuid, p_edge_type text, p_valid_from date,
  p_valid_to date DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_row public.regulation_edges%ROWTYPE;
BEGIN
  INSERT INTO public.regulation_edges (owner_id, from_node_id, to_node_id, edge_type, valid_from, valid_to, note)
  VALUES (v_owner, p_from_node_id, p_to_node_id, p_edge_type, p_valid_from, p_valid_to,
          NULLIF(left(btrim(coalesce(p_note, '')), 500), ''))
  RETURNING * INTO v_row;
  PERFORM public.log_audit_event(v_owner, 'regulation.edge.added', 'regulation_edges', v_row.id::text);
  RETURN to_jsonb(v_row);
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'Check the relationship type and dates (end must be after start).' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.regulation_retract_edge(p_edge_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.reg_assert_manager();
  v_reason text := left(btrim(coalesce(p_reason, '')), 500);
  v_row public.regulation_edges%ROWTYPE;
BEGIN
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'A reason (at least 8 characters) is required to retract a link.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.regulation_edges
     SET retracted_at = clock_timestamp(), retracted_by = auth.uid(), retracted_reason = v_reason
   WHERE id = p_edge_id AND owner_id = v_owner AND retracted_at IS NULL
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link not found, already retracted, or platform-owned.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.log_audit_event(v_owner, 'regulation.edge.retracted', 'regulation_edges', v_row.id::text);
  RETURN jsonb_build_object('id', v_row.id, 'retracted_at', v_row.retracted_at);
END;
$$;

-- Public RPC grants
REVOKE ALL ON FUNCTION public.regulation_resolve(uuid, date, timestamptz, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_job_context(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_record_job_snapshot(uuid, uuid, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_snapshot_report(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_add_jurisdiction(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_add_node(uuid, text, text, text, text, text[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_add_version(uuid, date, boolean, date, text, text, jsonb, text, text, text, date, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_retract_version(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_verify_version(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_add_edge(uuid, uuid, text, date, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regulation_retract_edge(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.regulation_resolve(uuid, date, timestamptz, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_job_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_record_job_snapshot(uuid, uuid, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_snapshot_report(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_add_jurisdiction(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_add_node(uuid, text, text, text, text, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_add_version(uuid, date, boolean, date, text, text, jsonb, text, text, text, date, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_retract_version(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_verify_version(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_add_edge(uuid, uuid, text, date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regulation_retract_edge(uuid, text) TO authenticated;
