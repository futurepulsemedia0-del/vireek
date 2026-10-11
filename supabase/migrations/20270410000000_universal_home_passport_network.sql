/*
  # VIREEK Universal Verified Home Passport Network

  A permanent, permission-based identity for every PROPERTY. It outlives owners, tenants, contractors and
  service companies. Sister of the Equipment Passport (20270210000000_equipment_passport.sql) and built on the
  same trust model: append-only, SHA-256 hash-chained history with no foreign keys to accounts or jobs.

  - home_passports              : one row per physical property (public QR code, private address, address_key).
  - home_passport_links         : which Vireek accounts are attached, with SCOPED access (what each may read).
  - home_passport_events        : append-only hash-chained history. Every row carries provenance:
                                  source_type, source_ref, confidence (0-1), verification_level, evidence_count,
                                  evidence_digest, contributor, timestamps.
  - home_passport_equipment     : equipment passports installed in this property (the property <-> machine graph).
  - home_passport_grants        : owner-consented, time-boxed, scoped, revocable share tokens (hash stored only).
  - home_passport_attestations  : independent confirm / dispute of an event by a DIFFERENT company (cross-verification).
  - home_passport_access_log    : append-only audit trail of claims, grants, redemptions and reads.

  Privacy by design:
    * The public (QR) view exposes NO history: only city/region, status, counts and chain integrity.
    * No customer name / phone / e-mail / prices ever enter the passport. Technician = "Maria G.".
    * Reading history requires a verified link AND the matching scope. Claiming with the printed code gives
      identity/equipment/warranty/permits only. Service history, risks and evidence need an owner-consented grant
      (or being the issuing company).

  Automatic capture (fail-safe: can NEVER break the source write):
    customer_sites INSERT/UPDATE   -> passport issued (or matched by address_key, unverified until claimed)
    jobs completed                 -> service_visit (+ equipment_linked) with evidence-chain provenance
    job_outcomes / warranty_claims -> outcome / warranty_event
    equipment_failure_events       -> failure (feeds the Failure Genome picture of this property)
    home_permits                   -> permit
    home_ownership_periods         -> ownership_change (dates only, no names)
    customer_sites DELETE          -> this company's link ends; the passport and its history stay

  Nothing existing is modified except: new triggers on customer_sites, jobs, job_outcomes, warranty_claims,
  equipment_failure_events, home_permits, home_ownership_periods, and (optionally) the webhook event allow-list.
  Requires: 20270210000000_equipment_passport.sql (uses vp_generate_code / vp_company_name / vp_display_name).
*/

-- =============================================================
-- 0. PURE HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.hp_normalize_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN length(c) = 15 AND left(c, 3) = 'VHP' THEN substr(c, 4) ELSE c END
  FROM (
    SELECT translate(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011') AS c
  ) s;
$$;

CREATE OR REPLACE FUNCTION public.hp_all_scopes()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT ARRAY['identity', 'equipment', 'service', 'permits', 'warranty', 'risks', 'evidence']::text[]; $$;

-- Which permission scope an event type belongs to.
CREATE OR REPLACE FUNCTION public.hp_scope_of(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_type
    WHEN 'registered' THEN 'identity'
    WHEN 'ownership_change' THEN 'identity'
    WHEN 'access_change' THEN 'identity'
    WHEN 'correction' THEN 'identity'
    WHEN 'installation' THEN 'equipment'
    WHEN 'equipment_linked' THEN 'equipment'
    WHEN 'permit' THEN 'permits'
    WHEN 'warranty_event' THEN 'warranty'
    WHEN 'risk_assessment' THEN 'risks'
    WHEN 'document' THEN 'evidence'
    ELSE 'service'   -- service_visit, repair, inspection, failure, outcome, note
  END;
$$;

-- Address fingerprint used to recognise the SAME property across different companies.
CREATE OR REPLACE FUNCTION public.hp_address_key(p_address text, p_city text, p_state text, p_postal text, p_country text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a text := lower(coalesce(p_address, ''));
  pc text := lower(regexp_replace(coalesce(p_postal, ''), '[^a-zA-Z0-9]', '', 'g'));
  loc text;
BEGIN
  a := regexp_replace(a, '\m(street)\M', 'st', 'g');
  a := regexp_replace(a, '\m(avenue)\M', 'ave', 'g');
  a := regexp_replace(a, '\m(road)\M', 'rd', 'g');
  a := regexp_replace(a, '\m(drive)\M', 'dr', 'g');
  a := regexp_replace(a, '\m(boulevard)\M', 'blvd', 'g');
  a := regexp_replace(a, '\m(lane)\M', 'ln', 'g');
  a := regexp_replace(a, '\m(court)\M', 'ct', 'g');
  a := regexp_replace(a, '\m(place)\M', 'pl', 'g');
  a := regexp_replace(a, '\m(apartment)\M', 'apt', 'g');
  a := regexp_replace(a, '\m(suite)\M', 'ste', 'g');
  a := regexp_replace(a, '[^a-z0-9]', '', 'g');
  IF length(a) < 6 OR a !~ '[0-9]' THEN RETURN NULL; END IF;   -- too vague to match safely
  loc := CASE WHEN pc <> '' THEN pc
         ELSE lower(regexp_replace(coalesce(p_city, '') || coalesce(p_state, ''), '[^a-zA-Z0-9]', '', 'g')) END;
  IF loc = '' THEN RETURN NULL; END IF;
  RETURN upper(left(coalesce(p_country, ''), 2)) || ':' || a || ':' || loc;
END;
$$;

-- Provenance model: how much a record can be trusted, derived from WHERE it came from and WHAT backs it.
CREATE OR REPLACE FUNCTION public.hp_provenance(p_source text, p_evidence integer, p_integrity boolean, p_score numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_level text;
  v_conf numeric;
  v_ev integer := coalesce(p_evidence, 0);
BEGIN
  CASE p_source
    WHEN 'authority_record' THEN v_level := 'authority_verified'; v_conf := 0.95;
    WHEN 'platform_job' THEN
      IF v_ev > 0 AND p_integrity IS TRUE AND coalesce(p_score, 0) >= 70 THEN v_level := 'evidence_backed'; v_conf := 0.90;
      ELSIF v_ev > 0 AND p_integrity IS NOT FALSE THEN v_level := 'evidence_backed'; v_conf := 0.80;
      ELSIF p_integrity IS FALSE THEN v_level := 'platform_recorded'; v_conf := 0.50;
      ELSE v_level := 'platform_recorded'; v_conf := 0.70;
      END IF;
    WHEN 'platform_record' THEN v_level := 'platform_recorded'; v_conf := 0.70;
    WHEN 'inspector' THEN
      IF v_ev > 0 THEN v_level := 'evidence_backed'; v_conf := 0.85; ELSE v_level := 'self_reported'; v_conf := 0.65; END IF;
    WHEN 'manufacturer' THEN
      IF v_ev > 0 THEN v_level := 'evidence_backed'; v_conf := 0.85; ELSE v_level := 'self_reported'; v_conf := 0.65; END IF;
    WHEN 'contractor_entry' THEN v_level := 'self_reported'; v_conf := CASE WHEN v_ev > 0 THEN 0.65 ELSE 0.50 END;
    WHEN 'owner_submission' THEN v_level := 'self_reported'; v_conf := CASE WHEN v_ev > 0 THEN 0.55 ELSE 0.45 END;
    WHEN 'ai_extraction' THEN v_level := 'unverified'; v_conf := 0.40;
    ELSE v_level := 'unverified'; v_conf := 0.35;   -- import and anything unknown
  END CASE;
  RETURN jsonb_build_object('level', v_level, 'confidence', v_conf);
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role'
  ) = 'service_role';
$$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.home_passports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL UNIQUE CHECK (public_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  address_key text,
  address_line text,                 -- private: only members with the 'identity' scope ever see it
  city text,
  region text,
  postal_code text,
  country_code text CHECK (country_code IS NULL OR char_length(country_code) = 2),
  property_type text NOT NULL DEFAULT 'residential'
    CHECK (property_type IN ('residential', 'multi_unit', 'commercial', 'industrial', 'other')),
  year_built integer CHECK (year_built IS NULL OR year_built BETWEEN 1600 AND 2200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'merged')),
  superseded_by uuid REFERENCES public.home_passports(id),
  created_by_user_id uuid,           -- deliberately NOT a foreign key: the passport outlives the account
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hp_passports_address_key
  ON public.home_passports (address_key) WHERE address_key IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS public.home_passport_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.home_passports(id),
  user_id uuid NOT NULL,             -- account owner (tenant); not an FK on purpose
  site_id uuid REFERENCES public.customer_sites(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'servicer' CHECK (role IN ('issuer', 'servicer', 'installer', 'inspector')),
  verified boolean NOT NULL DEFAULT false,
  verified_via text CHECK (verified_via IN ('issuer', 'code', 'grant')),
  scopes text[] NOT NULL DEFAULT '{}'
    CHECK (scopes <@ ARRAY['identity', 'equipment', 'service', 'permits', 'warranty', 'risks', 'evidence']::text[]),
  grant_id uuid,
  show_contractor_publicly boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (passport_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hp_links_site
  ON public.home_passport_links (site_id) WHERE site_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_hp_links_user ON public.home_passport_links (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.home_passport_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.home_passports(id),
  seq integer NOT NULL DEFAULT 0,
  event_type text NOT NULL CHECK (event_type IN (
    'registered', 'ownership_change', 'access_change', 'correction',
    'installation', 'equipment_linked',
    'service_visit', 'repair', 'inspection', 'failure', 'outcome', 'note',
    'permit', 'warranty_event', 'risk_assessment', 'document'
  )),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 20000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  contributor_user_id uuid,          -- no FK (survives account deletion)
  contributor_name text,             -- snapshot of the company name at the time
  source_job_id uuid,                -- no FK (survives job deletion)
  source_key text,
  supersedes_id uuid,
  visibility text NOT NULL DEFAULT 'network' CHECK (visibility IN ('network', 'restricted')),
  -- provenance (required on every record)
  source_type text NOT NULL CHECK (source_type IN (
    'platform_job', 'platform_record', 'contractor_entry', 'owner_submission',
    'inspector', 'authority_record', 'manufacturer', 'ai_extraction', 'import'
  )),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 300),
  confidence numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_level text NOT NULL CHECK (verification_level IN (
    'unverified', 'self_reported', 'platform_recorded', 'evidence_backed', 'authority_verified'
  )),
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  evidence_digest text CHECK (evidence_digest IS NULL OR char_length(evidence_digest) <= 128),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash text,
  entry_hash text NOT NULL DEFAULT '',
  UNIQUE (passport_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hp_events_source_key
  ON public.home_passport_events (passport_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hp_events_passport ON public.home_passport_events (passport_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_hp_events_contributor ON public.home_passport_events (contributor_user_id, recorded_at DESC);

COMMENT ON TABLE public.home_passport_events IS
  'Append-only, hash-chained history of a property. Never UPDATE/DELETE: add a superseding event instead.';

CREATE TABLE IF NOT EXISTS public.home_passport_equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.home_passports(id),
  equipment_passport_id uuid NOT NULL REFERENCES public.equipment_passports(id),
  added_by_user_id uuid,
  status text NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'removed')),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (passport_id, equipment_passport_id)
);

CREATE TABLE IF NOT EXISTS public.home_passport_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.home_passports(id),
  token_hash text NOT NULL UNIQUE,
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  scopes text[] NOT NULL
    CHECK (cardinality(scopes) > 0
      AND scopes <@ ARRAY['identity', 'equipment', 'service', 'permits', 'warranty', 'risks', 'evidence']::text[]),
  consent_basis text NOT NULL DEFAULT 'homeowner_consent'
    CHECK (consent_basis IN ('homeowner_consent', 'tenant_consent', 'property_manager', 'contract', 'legal', 'internal_handover')),
  created_by_user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 25),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hp_grants_passport ON public.home_passport_grants (passport_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.home_passport_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.home_passport_events(id),
  passport_id uuid NOT NULL REFERENCES public.home_passports(id),
  user_id uuid NOT NULL,
  stance text NOT NULL CHECK (stance IN ('confirm', 'dispute')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_hp_attest_event ON public.home_passport_attestations (event_id);

CREATE TABLE IF NOT EXISTS public.home_passport_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passport_id uuid NOT NULL REFERENCES public.home_passports(id),
  user_id uuid,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 40),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hp_log_passport ON public.home_passport_access_log (passport_id, created_at DESC);

-- =============================================================
-- 2. HASH CHAIN + IMMUTABILITY
-- =============================================================

CREATE OR REPLACE FUNCTION public.hp_event_hash(e public.home_passport_events)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    coalesce(e.prev_hash, 'GENESIS'),
    e.passport_id::text,
    e.seq::text,
    e.event_type,
    e.title,
    coalesce(e.detail, ''),
    e.summary::text,
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(e.contributor_user_id::text, ''),
    coalesce(e.contributor_name, ''),
    coalesce(e.source_job_id::text, ''),
    coalesce(e.source_key, ''),
    coalesce(e.supersedes_id::text, ''),
    e.visibility,
    e.source_type,
    coalesce(e.source_ref, ''),
    round(e.confidence, 2)::text,
    e.verification_level,
    e.evidence_count::text,
    coalesce(e.evidence_digest, ''),
    to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.hp_seal_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
  v_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vireek:home-passport:' || NEW.passport_id::text, 0));

  SELECT seq, entry_hash INTO v_seq, v_hash
  FROM public.home_passport_events
  WHERE passport_id = NEW.passport_id
  ORDER BY seq DESC
  LIMIT 1;

  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.home_passport_events e
    WHERE e.id = NEW.supersedes_id AND e.passport_id = NEW.passport_id
  ) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: superseded event not found on this passport' USING ERRCODE = 'P0001';
  END IF;

  NEW.seq := coalesce(v_seq, 0) + 1;
  NEW.prev_hash := v_hash;
  NEW.recorded_at := clock_timestamp();
  NEW.entry_hash := public.hp_event_hash(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hp_seal_event ON public.home_passport_events;
CREATE TRIGGER trg_hp_seal_event
  BEFORE INSERT ON public.home_passport_events
  FOR EACH ROW EXECUTE FUNCTION public.hp_seal_event();

CREATE OR REPLACE FUNCTION public.hp_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HOMEPASSPORT_IMMUTABLE: this record is append-only; add a superseding record instead' USING ERRCODE = 'P0001';
END;
$$;

DO $hp$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['home_passport_events', 'home_passport_attestations', 'home_passport_access_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_hp_block_mutation ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_hp_block_mutation BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hp_block_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_hp_block_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_hp_block_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.hp_block_mutation()', t);
  END LOOP;
END
$hp$;

CREATE OR REPLACE FUNCTION public.hp_verify_chain(p_passport uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.home_passport_events;
  v_prev text := NULL;
  v_n integer := 0;
BEGIN
  FOR e IN SELECT * FROM public.home_passport_events WHERE passport_id = p_passport ORDER BY seq LOOP
    v_n := v_n + 1;
    IF e.seq <> v_n OR e.prev_hash IS DISTINCT FROM v_prev OR e.entry_hash <> public.hp_event_hash(e) THEN
      RETURN jsonb_build_object('valid', false, 'checked', v_n, 'broken_at_seq', e.seq);
    END IF;
    v_prev := e.entry_hash;
  END LOOP;
  RETURN jsonb_build_object('valid', true, 'checked', v_n, 'head_hash', v_prev);
END;
$$;

-- =============================================================
-- 3. ROW LEVEL SECURITY
--    Clients may read only their own links and the passports they are verified on.
--    Events, grants, attestations, the audit log and the equipment graph are RPC-only (scope enforcement).
-- =============================================================

ALTER TABLE public.home_passports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_passport_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hp_links_select" ON public.home_passport_links;
CREATE POLICY "hp_links_select" ON public.home_passport_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "hp_passports_select" ON public.home_passports;
CREATE POLICY "hp_passports_select" ON public.home_passports FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.home_passport_links l
    WHERE l.passport_id = home_passports.id
      AND l.user_id = public.get_account_owner_id() AND l.status = 'active' AND l.verified
  ));

REVOKE ALL ON public.home_passports, public.home_passport_links, public.home_passport_events,
  public.home_passport_equipment, public.home_passport_grants, public.home_passport_attestations,
  public.home_passport_access_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.home_passports, public.home_passport_links, public.home_passport_events,
  public.home_passport_equipment, public.home_passport_grants, public.home_passport_attestations,
  public.home_passport_access_log FROM authenticated;
REVOKE ALL ON public.home_passport_events, public.home_passport_equipment, public.home_passport_grants,
  public.home_passport_attestations, public.home_passport_access_log FROM authenticated;

-- =============================================================
-- 4. INTERNAL WRITERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.hp_append_event(
  p_passport uuid,
  p_type text,
  p_title text,
  p_detail text,
  p_summary jsonb,
  p_occurred timestamptz,
  p_user uuid,
  p_job uuid DEFAULT NULL,
  p_source_key text DEFAULT NULL,
  p_visibility text DEFAULT 'network',
  p_source_type text DEFAULT 'platform_record',
  p_source_ref text DEFAULT NULL,
  p_evidence_count integer DEFAULT 0,
  p_evidence_digest text DEFAULT NULL,
  p_integrity boolean DEFAULT NULL,
  p_evidence_score numeric DEFAULT NULL,
  p_supersedes uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_prov jsonb := public.hp_provenance(p_source_type, p_evidence_count, p_integrity, p_evidence_score);
BEGIN
  INSERT INTO public.home_passport_events
    (passport_id, event_type, title, detail, summary, occurred_at,
     contributor_user_id, contributor_name, source_job_id, source_key, supersedes_id, visibility,
     source_type, source_ref, confidence, verification_level, evidence_count, evidence_digest)
  VALUES
    (p_passport, p_type, left(p_title, 200), left(p_detail, 2000), coalesce(p_summary, '{}'::jsonb),
     coalesce(p_occurred, now()), p_user,
     CASE WHEN p_user IS NULL THEN NULL ELSE public.vp_company_name(p_user) END,
     p_job, p_source_key, p_supersedes, p_visibility,
     p_source_type, left(p_source_ref, 300), (v_prov ->> 'confidence')::numeric, v_prov ->> 'level',
     greatest(coalesce(p_evidence_count, 0), 0), left(p_evidence_digest, 128))
  ON CONFLICT (passport_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_log(p_passport uuid, p_user uuid, p_action text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.home_passport_access_log (passport_id, user_id, action, detail)
  VALUES (p_passport, p_user, left(p_action, 40), coalesce(p_detail, '{}'::jsonb));
$$;

-- Issue (or match) a passport for one customer site. Idempotent.
--   no match  -> new passport, this company is the verified ISSUER with full scopes
--   match     -> link is UNVERIFIED (cannot read or write) until claimed with the printed code or a grant
CREATE OR REPLACE FUNCTION public.hp_issue_for_site(p_site uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  v_pass uuid;
  v_key text;
  v_country text;
  v_year integer;
  v_type text;
  v_created boolean := false;
  v_attempts integer := 0;
BEGIN
  SELECT * INTO s FROM public.customer_sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT passport_id INTO v_pass FROM public.home_passport_links
  WHERE site_id = p_site AND user_id = s.user_id AND status = 'active';
  IF FOUND THEN RETURN v_pass; END IF;

  IF to_regclass('public.property_profiles') IS NOT NULL THEN
    EXECUTE 'SELECT country_code FROM public.property_profiles WHERE site_id = $1' INTO v_country USING p_site;
  END IF;

  v_key := public.hp_address_key(s.address, s.city, s.state, s.postal_code, v_country);
  v_year := CASE WHEN coalesce(to_jsonb(s) ->> 'year_built', '') ~ '^[0-9]{4}$' THEN (to_jsonb(s) ->> 'year_built')::integer END;
  v_type := CASE s.site_type
    WHEN 'residential_complex' THEN 'multi_unit'
    WHEN 'industrial' THEN 'industrial'
    WHEN 'other' THEN 'residential'
    ELSE 'commercial'
  END;

  IF v_key IS NOT NULL THEN
    SELECT id INTO v_pass FROM public.home_passports WHERE address_key = v_key AND status = 'active';
  END IF;

  IF v_pass IS NULL THEN
    LOOP
      v_attempts := v_attempts + 1;
      BEGIN
        INSERT INTO public.home_passports
          (public_code, address_key, address_line, city, region, postal_code, country_code, property_type, year_built, created_by_user_id)
        VALUES
          (public.vp_generate_code(), v_key, nullif(btrim(s.address), ''), nullif(btrim(s.city), ''), nullif(btrim(s.state), ''),
           nullif(btrim(s.postal_code), ''), upper(nullif(left(v_country, 2), '')), v_type, v_year, s.user_id)
        RETURNING id INTO v_pass;
        v_created := true;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF v_key IS NOT NULL THEN
          SELECT id INTO v_pass FROM public.home_passports WHERE address_key = v_key AND status = 'active';
          IF v_pass IS NOT NULL THEN EXIT; END IF;
        END IF;
        IF v_attempts >= 5 THEN RAISE; END IF;
      END;
    END LOOP;
  END IF;

  IF v_created THEN
    INSERT INTO public.home_passport_links (passport_id, user_id, site_id, role, verified, verified_via, scopes)
    VALUES (v_pass, s.user_id, p_site, 'issuer', true, 'issuer', public.hp_all_scopes())
    ON CONFLICT (passport_id, user_id) DO NOTHING;

    PERFORM public.hp_append_event(
      v_pass, 'registered', 'Home Passport issued', NULL,
      jsonb_build_object('property_type', v_type, 'year_built', v_year),
      now(), s.user_id, NULL, 'registered', 'network', 'platform_record');
  ELSE
    INSERT INTO public.home_passport_links (passport_id, user_id, site_id, role, verified, scopes)
    VALUES (v_pass, s.user_id, p_site, 'servicer', false, '{}')
    ON CONFLICT (passport_id, user_id) DO NOTHING;
  END IF;

  RETURN v_pass;
END;
$$;

-- Link a company to a passport (claim / grant redemption), merging a trivial self-issued passport if needed.
CREATE OR REPLACE FUNCTION public.hp_upsert_link(
  p_passport uuid, p_user uuid, p_site uuid, p_role text, p_via text, p_scopes text[], p_grant uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o record;
BEGIN
  IF p_site IS NOT NULL THEN
    SELECT l.id, l.passport_id, l.user_id,
           (SELECT count(*) FROM public.home_passport_events e WHERE e.passport_id = l.passport_id) AS n,
           (SELECT count(*) FROM public.home_passport_links x WHERE x.passport_id = l.passport_id) AS links
    INTO o
    FROM public.home_passport_links l
    WHERE l.site_id = p_site AND l.status = 'active' AND l.passport_id <> p_passport
    LIMIT 1;

    IF FOUND THEN
      IF o.user_id = p_user AND o.n <= 1 AND o.links = 1 THEN
        UPDATE public.home_passport_links SET status = 'ended', ended_at = now(), site_id = NULL WHERE id = o.id;
        UPDATE public.home_passports SET status = 'merged', superseded_by = p_passport, updated_at = now() WHERE id = o.passport_id;
      ELSE
        RAISE EXCEPTION 'HOMEPASSPORT_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.home_passport_links AS l
    (passport_id, user_id, site_id, role, verified, verified_via, scopes, grant_id)
  VALUES
    (p_passport, p_user, p_site, p_role, true, p_via, p_scopes, p_grant)
  ON CONFLICT (passport_id, user_id) DO UPDATE SET
    status = 'active',
    ended_at = NULL,
    verified = true,
    verified_via = CASE WHEN l.verified THEN l.verified_via ELSE EXCLUDED.verified_via END,
    scopes = ARRAY(SELECT DISTINCT unnest(l.scopes || EXCLUDED.scopes)),
    site_id = coalesce(l.site_id, EXCLUDED.site_id),
    grant_id = coalesce(EXCLUDED.grant_id, l.grant_id);
END;
$$;

-- Resolve the verified passport (and owner) a completed job belongs to.
CREATE OR REPLACE FUNCTION public.hp_resolve_job(p_job uuid, OUT o_passport uuid, OUT o_user uuid, OUT o_site uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j record;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job;
  IF NOT FOUND THEN RETURN; END IF;
  o_user := j.user_id;
  o_site := coalesce(
    j.site_id,
    (SELECT cs.id FROM public.customer_sites cs
     WHERE cs.user_id = j.user_id AND cs.customer_id = nullif(to_jsonb(j) ->> 'customer_id', '')::uuid
     ORDER BY cs.is_primary DESC, cs.created_at LIMIT 1)
  );
  IF o_site IS NULL THEN RETURN; END IF;
  SELECT l.passport_id INTO o_passport
  FROM public.home_passport_links l
  WHERE l.site_id = o_site AND l.user_id = j.user_id AND l.status = 'active' AND l.verified;
END;
$$;

-- Sanitised service-visit snapshot for one completed job.
CREATE OR REPLACE FUNCTION public.hp_record_job_service(p_job uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j record;
  r record;
  eq record;
  v_when timestamptz;
  v_tech text;
  v_parts jsonb := '[]'::jsonb;
  v_photos integer := 0;
  v_prints integer := 0;
  v_diag text;
  v_work jsonb := '[]'::jsonb;
  v_res jsonb;
  v_outcome jsonb;
  v_claims integer := 0;
  v_rep jsonb;
  v_integrity boolean;
  v_score numeric;
  v_digest text;
  v_eq jsonb := '[]'::jsonb;
  v_evid jsonb;
  v_has_chain boolean := to_regclass('public.job_evidence_chain_entries') IS NOT NULL;
  v_has_eqp boolean := to_regclass('public.equipment_passports') IS NOT NULL;
  v_rows integer;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job;
  IF NOT FOUND OR j.job_status IS DISTINCT FROM 'completed' THEN RETURN NULL; END IF;

  SELECT * INTO r FROM public.hp_resolve_job(p_job);
  IF r.o_passport IS NULL THEN RETURN NULL; END IF;   -- never write into a home history you have not verified

  v_when := coalesce(nullif(to_jsonb(j) ->> 'scheduled_datetime', '')::timestamptz, now());

  SELECT public.vp_display_name(tm.member_name) INTO v_tech
  FROM public.team_members tm WHERE tm.id = j.assigned_technician_id;

  IF v_has_chain THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', x.payload ->> 'part_name', 'qty', x.payload -> 'quantity') ORDER BY x.seq), '[]'::jsonb)
    INTO v_parts
    FROM (
      SELECT seq, payload FROM public.job_evidence_chain_entries
      WHERE job_id = p_job AND stage = 'part' AND coalesce(payload ->> 'part_name', '') <> ''
      ORDER BY seq LIMIT 20
    ) x;

    SELECT coalesce(sum(CASE WHEN jsonb_typeof(payload -> 'photo_count') = 'number' THEN (payload ->> 'photo_count')::integer ELSE 0 END), 0)::integer
           + coalesce(sum(jsonb_array_length(media)), 0)::integer,
           coalesce(sum(jsonb_array_length(media)), 0)::integer
    INTO v_photos, v_prints
    FROM public.job_evidence_chain_entries WHERE job_id = p_job;

    SELECT left(coalesce(nullif(btrim(detail), ''), title), 300) INTO v_diag
    FROM public.job_evidence_chain_entries
    WHERE job_id = p_job AND stage = 'diagnosis' ORDER BY seq DESC LIMIT 1;

    SELECT coalesce(jsonb_agg(left(t.title, 160) ORDER BY t.seq), '[]'::jsonb) INTO v_work
    FROM (
      SELECT seq, title FROM public.job_evidence_chain_entries
      WHERE job_id = p_job AND stage IN ('work', 'test') ORDER BY seq LIMIT 6
    ) t;

    SELECT payload INTO v_res FROM public.job_evidence_chain_entries
    WHERE job_id = p_job AND stage = 'result' AND payload ? 'resolution' ORDER BY seq DESC LIMIT 1;

    SELECT count(*)::integer INTO v_claims FROM public.job_evidence_chain_entries
    WHERE job_id = p_job AND stage = 'warranty';

    BEGIN
      v_rep := public.job_evidence_chain_report(p_job);
      IF v_rep IS NOT NULL THEN
        v_integrity := nullif(v_rep -> 'integrity' ->> 'valid', '')::boolean;
        v_score := nullif(v_rep ->> 'score', '')::numeric;
        v_digest := v_rep -> 'integrity' ->> 'head_hash';
        v_evid := jsonb_strip_nulls(jsonb_build_object('score', v_rep -> 'score', 'level', v_rep -> 'level', 'integrity_valid', v_rep -> 'integrity' -> 'valid'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_integrity := NULL; v_score := NULL; v_digest := NULL; v_evid := NULL;
    END;
  END IF;

  IF v_res IS NOT NULL THEN
    v_outcome := jsonb_strip_nulls(jsonb_build_object(
      'resolution', v_res ->> 'resolution',
      'first_time_fix', NOT (coalesce((v_res ->> 'is_rework')::boolean, false) OR coalesce((v_res ->> 'caused_callback')::boolean, false)),
      'customer_rating', v_res -> 'customer_rating'));
  END IF;

  -- Machines touched by this job: link the equipment passports into the property graph.
  IF v_has_eqp THEN
    FOR eq IN
      SELECT DISTINCT ep.id, ep.public_code, ep.equipment_type, ep.make, ep.model
      FROM public.job_equipment je
      JOIN public.equipment_passport_links l ON l.equipment_id = je.equipment_id AND l.status = 'active' AND l.verified
      JOIN public.equipment_passports ep ON ep.id = l.passport_id
      WHERE je.job_id = p_job
    LOOP
      v_eq := v_eq || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'code', eq.public_code, 'type', eq.equipment_type, 'make', eq.make, 'model', eq.model)));

      INSERT INTO public.home_passport_equipment (passport_id, equipment_passport_id, added_by_user_id)
      VALUES (r.o_passport, eq.id, r.o_user)
      ON CONFLICT (passport_id, equipment_passport_id) DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN
        PERFORM public.hp_append_event(
          r.o_passport, 'equipment_linked',
          'Equipment linked: ' || coalesce(nullif(btrim(concat_ws(' ', eq.make, eq.model)), ''), eq.equipment_type),
          NULL,
          jsonb_strip_nulls(jsonb_build_object('equipment_code', eq.public_code, 'equipment_type', eq.equipment_type, 'make', eq.make, 'model', eq.model)),
          v_when, r.o_user, p_job, 'eq:' || eq.id::text, 'network', 'platform_record', eq.public_code);
      END IF;
    END LOOP;
  END IF;

  RETURN public.hp_append_event(
    r.o_passport, 'service_visit',
    coalesce(nullif(btrim(j.service_type), ''), 'Service visit'), NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'service_type', nullif(btrim(j.service_type), ''),
      'diagnosis', v_diag,
      'technician', v_tech,
      'parts', v_parts,
      'photos', jsonb_build_object('count', v_photos, 'fingerprinted', v_prints),
      'work', v_work,
      'outcome', v_outcome,
      'evidence', v_evid,
      'equipment', v_eq,
      'warranty_claims', nullif(v_claims, 0))),
    v_when, r.o_user, p_job, 'job:' || p_job::text, 'network',
    'platform_job', 'job:' || left(p_job::text, 8), v_photos, v_digest, v_integrity, v_score);
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_record_permit(p_permit uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p record;
  v_pass uuid;
  v_when date;
BEGIN
  SELECT * INTO p FROM public.home_permits WHERE id = p_permit;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT l.passport_id INTO v_pass FROM public.home_passport_links l
  WHERE l.site_id = p.site_id AND l.user_id = p.user_id AND l.status = 'active' AND l.verified;
  IF v_pass IS NULL THEN RETURN NULL; END IF;
  v_when := coalesce(p.final_inspection_on, p.issued_on, p.applied_on, CURRENT_DATE);
  RETURN public.hp_append_event(
    v_pass, 'permit',
    initcap(replace(p.permit_type, '_', ' ')) || ' permit: ' || replace(p.status, '_', ' '), NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'permit_type', p.permit_type, 'permit_number', nullif(btrim(p.permit_number), ''),
      'jurisdiction', nullif(btrim(p.jurisdiction), ''), 'status', p.status,
      'applied_on', p.applied_on, 'issued_on', p.issued_on, 'expires_on', p.expires_on,
      'final_inspection_on', p.final_inspection_on)),
    v_when::timestamptz, p.user_id, NULL, 'permit:' || p.id::text || ':' || p.status, 'network',
    'contractor_entry', nullif(btrim(p.permit_number), ''),
    CASE WHEN coalesce(btrim(p.document_url), '') <> '' THEN 1 ELSE 0 END);
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_record_failure(p_event uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f record;
  r record;
BEGIN
  SELECT * INTO f FROM public.equipment_failure_events WHERE id = p_event;
  IF NOT FOUND OR f.job_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM public.hp_resolve_job(f.job_id);
  IF r.o_passport IS NULL THEN RETURN NULL; END IF;
  RETURN public.hp_append_event(
    r.o_passport, 'failure',
    'Failure: ' || left(f.failure_component, 120), NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'component', f.failure_component, 'failure_mode', f.failure_mode, 'repair_action', f.repair_action,
      'parts_replaced', to_jsonb(f.parts_replaced), 'symptoms', to_jsonb(f.symptoms),
      'outcome', f.outcome, 'age_months', f.age_months, 'genome_source', f.source)),
    f.occurred_on::timestamptz, r.o_user, f.job_id, 'failure:' || f.id::text, 'network',
    'platform_record', 'failure_genome:' || left(f.id::text, 8));
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_record_ownership(p_period uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o record;
  v_pass uuid;
BEGIN
  SELECT * INTO o FROM public.home_ownership_periods WHERE id = p_period;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT l.passport_id INTO v_pass FROM public.home_passport_links l
  WHERE l.site_id = o.site_id AND l.user_id = o.user_id AND l.status = 'active' AND l.verified;
  IF v_pass IS NULL THEN RETURN NULL; END IF;
  RETURN public.hp_append_event(
    v_pass, 'ownership_change', 'Ownership period began', NULL,
    jsonb_strip_nulls(jsonb_build_object('started_on', o.started_at, 'reason', o.transfer_reason)),
    o.started_at::timestamptz, o.user_id, NULL, 'own:' || o.id::text, 'network', 'platform_record');
END;
$$;

-- =============================================================
-- 5. AUTOMATIC CAPTURE (fail-safe)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hp_on_site_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_country text;
  v_pass uuid;
BEGIN
  BEGIN
    v_pass := public.hp_issue_for_site(NEW.id);

    -- A self-issued passport created before the address was known can adopt it (never overwrites a known address).
    IF TG_OP = 'UPDATE' AND v_pass IS NOT NULL AND coalesce(NEW.address, '') <> '' THEN
      IF to_regclass('public.property_profiles') IS NOT NULL THEN
        EXECUTE 'SELECT country_code FROM public.property_profiles WHERE site_id = $1' INTO v_country USING NEW.id;
      END IF;
      v_key := public.hp_address_key(NEW.address, NEW.city, NEW.state, NEW.postal_code, v_country);
      IF v_key IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.home_passports WHERE id = v_pass AND address_key IS NULL AND status = 'active')
         AND (SELECT count(*) FROM public.home_passport_links WHERE passport_id = v_pass) = 1
         AND NOT EXISTS (SELECT 1 FROM public.home_passports WHERE address_key = v_key AND status = 'active') THEN
        UPDATE public.home_passports
        SET address_key = v_key, address_line = nullif(btrim(NEW.address), ''), city = nullif(btrim(NEW.city), ''),
            region = nullif(btrim(NEW.state), ''), postal_code = nullif(btrim(NEW.postal_code), ''), updated_at = now()
        WHERE id = v_pass;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport issue skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_hp_site_ins ON public.customer_sites;
CREATE TRIGGER trg_hp_site_ins AFTER INSERT ON public.customer_sites
  FOR EACH ROW EXECUTE FUNCTION public.hp_on_site_write();

DROP TRIGGER IF EXISTS trg_hp_site_upd ON public.customer_sites;
CREATE TRIGGER trg_hp_site_upd AFTER UPDATE OF address, city, state, postal_code ON public.customer_sites
  FOR EACH ROW EXECUTE FUNCTION public.hp_on_site_write();

CREATE OR REPLACE FUNCTION public.hp_on_site_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    UPDATE public.home_passport_links SET status = 'ended', ended_at = now(), site_id = NULL
    WHERE site_id = OLD.id AND status = 'active';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport detach skipped: %', SQLERRM;
  END;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_hp_site_del ON public.customer_sites;
CREATE TRIGGER trg_hp_site_del BEFORE DELETE ON public.customer_sites
  FOR EACH ROW EXECUTE FUNCTION public.hp_on_site_delete();

CREATE OR REPLACE FUNCTION public.hp_on_job_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.hp_record_job_service(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport job capture skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_hp_job_closed ON public.jobs;
CREATE TRIGGER trg_hp_job_closed
  AFTER UPDATE OF job_status ON public.jobs
  FOR EACH ROW
  WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.hp_on_job_closed();

CREATE OR REPLACE FUNCTION public.hp_on_followup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  x record;
  v_job uuid := nullif(r ->> 'job_id', '')::uuid;
  v_type text;
  v_title text;
  v_sum jsonb;
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'equipment_failure_events' THEN
      PERFORM public.hp_record_failure(NEW.id);
      RETURN NULL;
    END IF;
    IF v_job IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO x FROM public.hp_resolve_job(v_job);
    IF x.o_passport IS NULL THEN RETURN NULL; END IF;

    IF TG_TABLE_NAME = 'job_outcomes' THEN
      v_type := 'outcome';
      v_title := 'Outcome recorded: ' || replace(coalesce(r ->> 'resolution', 'unknown'), '_', ' ');
      v_sum := jsonb_build_object('outcome', jsonb_strip_nulls(jsonb_build_object(
        'resolution', r ->> 'resolution',
        'first_time_fix', NOT (coalesce((r ->> 'is_rework')::boolean, false) OR coalesce((r ->> 'caused_callback')::boolean, false)),
        'customer_rating', r -> 'customer_rating')));
    ELSE
      v_type := 'warranty_event';
      v_title := 'Warranty claim opened';
      v_sum := jsonb_build_object('warranty', jsonb_strip_nulls(jsonb_build_object(
        'claim_status', r ->> 'status', 'claim_deadline', r ->> 'claim_deadline')));
    END IF;

    PERFORM public.hp_append_event(x.o_passport, v_type, v_title, NULL, v_sum, now(), x.o_user, v_job,
                                   TG_TABLE_NAME || ':' || (r ->> 'id'), 'network', 'platform_record');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport follow-up skipped (%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_on_permit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.hp_record_permit(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport permit capture skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.hp_on_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.hp_record_ownership(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport ownership capture skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DO $hp$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_outcomes', 'warranty_claims', 'equipment_failure_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_hp_followup ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_hp_followup AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hp_on_followup()', t);
    END IF;
  END LOOP;

  IF to_regclass('public.home_permits') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_hp_permit ON public.home_permits;
    CREATE TRIGGER trg_hp_permit AFTER INSERT OR UPDATE OF status ON public.home_permits
      FOR EACH ROW EXECUTE FUNCTION public.hp_on_permit();
  END IF;

  IF to_regclass('public.home_ownership_periods') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_hp_ownership ON public.home_ownership_periods;
    CREATE TRIGGER trg_hp_ownership AFTER INSERT ON public.home_ownership_periods
      FOR EACH ROW EXECUTE FUNCTION public.hp_on_ownership();
  END IF;
END
$hp$;

-- =============================================================
-- 6. READ MODEL (one builder for member + public views)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hp_passport_json(p_passport uuid, p_member boolean, p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.home_passports;
  l public.home_passport_links;
  v_member boolean := false;
  v_scopes text[] := '{}';
  v_events jsonb := '[]'::jsonb;
  v_equipment jsonb := '[]'::jsonb;
  v_risks jsonb := '[]'::jsonb;
  v_stats jsonb;
  v_site uuid;
  v_identity jsonb;
BEGIN
  SELECT * INTO p FROM public.home_passports WHERE id = p_passport;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  IF p_member AND p_owner IS NOT NULL THEN
    SELECT * INTO l FROM public.home_passport_links
    WHERE passport_id = p_passport AND user_id = p_owner AND status = 'active' AND verified;
    IF FOUND THEN v_member := true; v_scopes := l.scopes; END IF;
  END IF;

  -- Aggregate trust signals are safe for everyone: counts only, no content.
  SELECT jsonb_build_object(
    'event_count', count(*),
    'contributor_count', count(DISTINCT contributor_user_id),
    'service_count', count(*) FILTER (WHERE event_type = 'service_visit'),
    'evidence_backed_count', count(*) FILTER (WHERE verification_level IN ('evidence_backed', 'authority_verified')),
    'first_event_at', min(occurred_at),
    'last_event_at', max(occurred_at),
    'last_service_at', max(occurred_at) FILTER (WHERE event_type = 'service_visit'),
    'avg_confidence', round(avg(confidence), 2),
    'equipment_count', (SELECT count(*) FROM public.home_passport_equipment he WHERE he.passport_id = p_passport AND he.status = 'installed')
  ) INTO v_stats
  FROM public.home_passport_events WHERE passport_id = p_passport;

  v_identity := jsonb_build_object(
    'code', p.public_code, 'status', p.status, 'property_type', p.property_type,
    'city', p.city, 'region', p.region, 'country_code', p.country_code,
    'year_built', p.year_built, 'created_at', p.created_at);
  IF v_member AND 'identity' = ANY (v_scopes) THEN
    v_identity := v_identity || jsonb_build_object('address_line', p.address_line, 'postal_code', p.postal_code);
  END IF;

  IF v_member THEN
    SELECT coalesce(jsonb_agg(t.obj ORDER BY t.occurred_at DESC, t.seq DESC), '[]'::jsonb) INTO v_events
    FROM (
      SELECT e.occurred_at, e.seq, jsonb_build_object(
        'id', e.id,
        'seq', e.seq,
        'event_type', e.event_type,
        'scope', public.hp_scope_of(e.event_type),
        'title', e.title,
        'detail', e.detail,
        'occurred_at', e.occurred_at,
        'recorded_at', e.recorded_at,
        'contributor_name', CASE WHEN e.contributor_user_id IS NOT DISTINCT FROM p_owner OR coalesce(cl.show_contractor_publicly, true) THEN e.contributor_name END,
        'is_mine', (e.contributor_user_id IS NOT DISTINCT FROM p_owner),
        'visibility', e.visibility,
        'summary', e.summary,
        'entry_hash', e.entry_hash,
        'superseded', EXISTS (SELECT 1 FROM public.home_passport_events s WHERE s.supersedes_id = e.id),
        'provenance', jsonb_build_object(
          'source_type', e.source_type,
          'source_ref', e.source_ref,
          'confidence', e.confidence,
          'verification_level', e.verification_level,
          'evidence_count', e.evidence_count,
          'evidence_digest', e.evidence_digest,
          'confirmations', (SELECT count(*) FROM public.home_passport_attestations a WHERE a.event_id = e.id AND a.stance = 'confirm'),
          'disputes', (SELECT count(*) FROM public.home_passport_attestations a WHERE a.event_id = e.id AND a.stance = 'dispute'),
          'my_stance', (SELECT a.stance FROM public.home_passport_attestations a WHERE a.event_id = e.id AND a.user_id = p_owner)
        )
      ) AS obj
      FROM public.home_passport_events e
      LEFT JOIN public.home_passport_links cl ON cl.passport_id = e.passport_id AND cl.user_id = e.contributor_user_id
      WHERE e.passport_id = p_passport
        AND (public.hp_scope_of(e.event_type) = ANY (v_scopes) OR e.contributor_user_id IS NOT DISTINCT FROM p_owner)
        AND (e.visibility = 'network' OR e.contributor_user_id IS NOT DISTINCT FROM p_owner)
      ORDER BY e.occurred_at DESC, e.seq DESC
      LIMIT 300
    ) t;

    IF 'equipment' = ANY (v_scopes) THEN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'code', ep.public_code,
        'equipment_type', ep.equipment_type,
        'make', ep.make,
        'model', ep.model,
        'install_date', ep.install_date,
        'warranty_expires_at', ep.warranty_expires_at,
        'status', he.status,
        'linked_at', he.added_at
      ) ORDER BY he.added_at), '[]'::jsonb) INTO v_equipment
      FROM public.home_passport_equipment he
      JOIN public.equipment_passports ep ON ep.id = he.equipment_passport_id
      WHERE he.passport_id = p_passport;
    END IF;

    IF 'risks' = ANY (v_scopes)
       AND to_regclass('public.property_profiles') IS NOT NULL
       AND to_regclass('public.property_intel_layers') IS NOT NULL THEN
      SELECT x.site_id INTO v_site FROM public.home_passport_links x
      WHERE x.passport_id = p_passport AND x.role = 'issuer' AND x.site_id IS NOT NULL
      ORDER BY x.linked_at LIMIT 1;
      IF v_site IS NOT NULL THEN
        EXECUTE $q$
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'layer', ly.layer, 'status', ly.status, 'source', ly.source, 'confidence', ly.confidence,
            'as_of', ly.as_of, 'fetched_at', ly.fetched_at,
            'data', CASE WHEN octet_length(ly.data::text) <= 8000 THEN ly.data END
          ) ORDER BY ly.layer), '[]'::jsonb)
          FROM public.property_intel_layers ly
          JOIN public.property_profiles pp ON pp.id = ly.profile_id
          WHERE pp.site_id = $1 AND ly.layer IN ('hazards', 'climate', 'energy')
        $q$ INTO v_risks USING v_site;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'access', CASE WHEN v_member THEN 'member' ELSE 'public' END,
    'passport', v_identity,
    'link', CASE WHEN v_member THEN jsonb_build_object(
        'role', l.role, 'verified', l.verified, 'verified_via', l.verified_via, 'scopes', to_jsonb(l.scopes),
        'show_contractor_publicly', l.show_contractor_publicly, 'site_id', l.site_id) END,
    'scopes', to_jsonb(v_scopes),
    'stats', v_stats,
    'integrity', public.hp_verify_chain(p_passport),
    'equipment', v_equipment,
    'events', v_events,
    'risks', v_risks
  );
END;
$$;

-- Public (QR) view: no login, no history. Identity, trust signals and chain integrity only.
CREATE OR REPLACE FUNCTION public.verify_home_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN public.hp_passport_json(v_id, false, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_home_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_owner uuid := public.get_account_owner_id();
  v_member boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.home_passport_links
    WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified
  ) INTO v_member;

  IF v_member AND NOT EXISTS (
    SELECT 1 FROM public.home_passport_access_log
    WHERE passport_id = v_id AND user_id = v_owner AND action = 'view' AND created_at > now() - interval '1 hour'
  ) THEN
    PERFORM public.hp_log(v_id, v_owner, 'view');
  END IF;

  RETURN public.hp_passport_json(v_id, v_member, v_owner);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_home_passports()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'passport_id', p.id,
      'code', CASE WHEN l.verified THEN p.public_code END,
      'status', p.status,
      'address_line', coalesce(s.address, CASE WHEN l.verified AND 'identity' = ANY (l.scopes) THEN p.address_line END),
      'city', p.city,
      'region', p.region,
      'property_type', p.property_type,
      'site_id', l.site_id,
      'site_name', s.name,
      'customer_name', c.name,
      'role', l.role,
      'verified', l.verified,
      'verified_via', l.verified_via,
      'scopes', to_jsonb(l.scopes),
      'linked_at', l.linked_at,
      'show_contractor_publicly', l.show_contractor_publicly,
      'event_count', CASE WHEN l.verified THEN (SELECT count(*) FROM public.home_passport_events e WHERE e.passport_id = p.id) END,
      'last_event_at', CASE WHEN l.verified THEN (SELECT max(e.occurred_at) FROM public.home_passport_events e WHERE e.passport_id = p.id) END,
      'last_service_at', CASE WHEN l.verified THEN (SELECT max(e.occurred_at) FROM public.home_passport_events e WHERE e.passport_id = p.id AND e.event_type = 'service_visit') END
    ) ORDER BY l.linked_at DESC)
    FROM public.home_passport_links l
    JOIN public.home_passports p ON p.id = l.passport_id
    LEFT JOIN public.customer_sites s ON s.id = l.site_id
    LEFT JOIN public.customers c ON c.id = s.customer_id
    WHERE l.user_id = v_owner AND l.status = 'active'
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_home_passport_for_site(p_site_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r record;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT l.verified, l.passport_id, p.public_code INTO r
  FROM public.home_passport_links l JOIN public.home_passports p ON p.id = l.passport_id
  WHERE l.site_id = p_site_id AND l.user_id = v_owner AND l.status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('has_passport', false); END IF;
  RETURN jsonb_build_object(
    'has_passport', true,
    'verified', r.verified,
    'code', CASE WHEN r.verified THEN r.public_code END,
    'event_count', CASE WHEN r.verified THEN (SELECT count(*) FROM public.home_passport_events e WHERE e.passport_id = r.passport_id) END,
    'last_event_at', CASE WHEN r.verified THEN (SELECT max(e.occurred_at) FROM public.home_passport_events e WHERE e.passport_id = r.passport_id) END
  );
END;
$$;

-- =============================================================
-- 7. CLIENT RPCs (all writes go through here)
-- =============================================================

CREATE OR REPLACE FUNCTION public.issue_home_passport(p_site_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customer_sites WHERE id = p_site_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_SITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.hp_issue_for_site(p_site_id);
  RETURN public.get_home_passport_for_site(p_site_id);
END;
$$;

-- Prove physical access with the printed / scanned code. Grants identity, equipment, warranty and permits only.
CREATE OR REPLACE FUNCTION public.claim_home_passport(p_code text, p_site_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_status text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT status INTO v_status FROM public.home_passports WHERE id = v_id;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'HOMEPASSPORT_RETIRED' USING ERRCODE = 'P0001'; END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_sites WHERE id = p_site_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_SITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.hp_upsert_link(v_id, v_owner, p_site_id, 'servicer', 'code',
                                ARRAY['identity', 'equipment', 'warranty', 'permits']::text[], NULL);
  PERFORM public.hp_append_event(v_id, 'access_change', 'Servicing company verified by code', NULL,
                                 jsonb_build_object('method', 'code'), now(), v_owner, NULL, 'claim:' || v_owner::text,
                                 'network', 'platform_record');
  PERFORM public.hp_log(v_id, v_owner, 'claim', jsonb_build_object('site_id', p_site_id));
  RETURN public.hp_passport_json(v_id, true, v_owner);
END;
$$;

-- Pull this company's existing history (completed jobs, permits, failures, ownership) into the passport.
CREATE OR REPLACE FUNCTION public.sync_home_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  l public.home_passport_links;
  x record;
  v_before integer;
  v_after integer;
  v_jobs integer := 0;
  v_cust uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM public.home_passport_links
  WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  IF l.site_id IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_NO_SITE' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_before FROM public.home_passport_events WHERE passport_id = v_id;
  SELECT customer_id INTO v_cust FROM public.customer_sites WHERE id = l.site_id;

  FOR x IN
    SELECT j.id FROM public.jobs j
    WHERE j.user_id = v_owner AND j.job_status = 'completed'
      AND (j.site_id = l.site_id OR (j.site_id IS NULL AND nullif(to_jsonb(j) ->> 'customer_id', '')::uuid = v_cust))
    ORDER BY j.id
    LIMIT 500
  LOOP
    BEGIN
      PERFORM public.hp_record_job_service(x.id);
      v_jobs := v_jobs + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'home passport sync job skipped: %', SQLERRM;
    END;
  END LOOP;

  IF to_regclass('public.home_permits') IS NOT NULL THEN
    FOR x IN SELECT id FROM public.home_permits WHERE site_id = l.site_id AND user_id = v_owner LIMIT 200 LOOP
      BEGIN PERFORM public.hp_record_permit(x.id); EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
  END IF;

  IF to_regclass('public.equipment_failure_events') IS NOT NULL THEN
    FOR x IN
      SELECT f.id FROM public.equipment_failure_events f
      JOIN public.jobs j ON j.id = f.job_id
      WHERE f.user_id = v_owner AND j.site_id = l.site_id LIMIT 500
    LOOP
      BEGIN PERFORM public.hp_record_failure(x.id); EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
  END IF;

  IF to_regclass('public.home_ownership_periods') IS NOT NULL THEN
    FOR x IN SELECT id FROM public.home_ownership_periods WHERE site_id = l.site_id AND user_id = v_owner LIMIT 100 LOOP
      BEGIN PERFORM public.hp_record_ownership(x.id); EXCEPTION WHEN OTHERS THEN NULL; END;
    END LOOP;
  END IF;

  SELECT count(*) INTO v_after FROM public.home_passport_events WHERE passport_id = v_id;
  PERFORM public.hp_log(v_id, v_owner, 'sync', jsonb_build_object('added', v_after - v_before));
  RETURN jsonb_build_object('jobs_scanned', v_jobs, 'events_added', v_after - v_before);
END;
$$;

-- Manual contribution by a verified company. Never public, never overwrites: it appends.
CREATE OR REPLACE FUNCTION public.add_home_passport_event(
  p_code text,
  p_type text,
  p_title text,
  p_detail text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT NULL,
  p_restricted boolean DEFAULT false,
  p_evidence_count integer DEFAULT 0,
  p_source_ref text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  l public.home_passport_links;
  v_event uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM public.home_passport_links
  WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;

  IF p_type NOT IN ('installation', 'repair', 'inspection', 'permit', 'warranty_event', 'risk_assessment', 'document', 'note') THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: unsupported record type' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: title must be 1-200 characters' USING ERRCODE = 'P0001';
  END IF;
  IF p_detail IS NOT NULL AND char_length(p_detail) > 2000 THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: detail is too long' USING ERRCODE = 'P0001';
  END IF;
  IF p_occurred_at IS NOT NULL AND p_occurred_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: date cannot be in the future' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.home_passport_events
      WHERE passport_id = v_id AND contributor_user_id = v_owner AND recorded_at > now() - interval '1 hour'
        AND source_type IN ('contractor_entry', 'inspector')) >= 60 THEN
    RAISE EXCEPTION 'HOMEPASSPORT_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  v_event := public.hp_append_event(
    v_id, p_type, btrim(p_title), nullif(btrim(coalesce(p_detail, '')), ''),
    jsonb_build_object('manual', true), coalesce(p_occurred_at, now()), v_owner, NULL, NULL,
    CASE WHEN p_restricted THEN 'restricted' ELSE 'network' END,
    CASE WHEN l.role = 'inspector' THEN 'inspector' ELSE 'contractor_entry' END,
    nullif(btrim(coalesce(p_source_ref, '')), ''), least(greatest(coalesce(p_evidence_count, 0), 0), 50));
  PERFORM public.hp_log(v_id, v_owner, 'add_event', jsonb_build_object('type', p_type));
  RETURN v_event;
END;
$$;

-- Independent cross-verification: a DIFFERENT company confirms or disputes a record.
CREATE OR REPLACE FUNCTION public.attest_home_passport_event(p_event_id uuid, p_stance text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  e public.home_passport_events;
  l public.home_passport_links;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF p_stance NOT IN ('confirm', 'dispute') THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: stance must be confirm or dispute' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO e FROM public.home_passport_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM public.home_passport_links
  WHERE passport_id = e.passport_id AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND OR NOT (public.hp_scope_of(e.event_type) = ANY (l.scopes)) OR e.visibility = 'restricted' THEN
    RAISE EXCEPTION 'HOMEPASSPORT_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF e.contributor_user_id IS NOT DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: you cannot verify your own record' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.home_passport_attestations (event_id, passport_id, user_id, stance, note)
  VALUES (e.id, e.passport_id, v_owner, p_stance, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  ON CONFLICT (event_id, user_id) DO NOTHING;
  PERFORM public.hp_log(e.passport_id, v_owner, 'attest', jsonb_build_object('event_id', e.id, 'stance', p_stance));

  RETURN jsonb_build_object(
    'confirmations', (SELECT count(*) FROM public.home_passport_attestations WHERE event_id = e.id AND stance = 'confirm'),
    'disputes', (SELECT count(*) FROM public.home_passport_attestations WHERE event_id = e.id AND stance = 'dispute'),
    'my_stance', (SELECT stance FROM public.home_passport_attestations WHERE event_id = e.id AND user_id = v_owner));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_home_passport_sharing(p_code text, p_show_contractor boolean)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  UPDATE public.home_passport_links SET show_contractor_publicly = coalesce(p_show_contractor, true)
  WHERE passport_id = v_id AND user_id = v_owner AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
END;
$$;

-- ---------- permission grants (owner-consented, scoped, time-boxed, revocable) ----------

CREATE OR REPLACE FUNCTION public.create_home_passport_grant(
  p_code text,
  p_scopes text[],
  p_ttl_hours integer DEFAULT 72,
  p_label text DEFAULT NULL,
  p_max_uses integer DEFAULT 1,
  p_consent_basis text DEFAULT 'homeowner_consent'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  l public.home_passport_links;
  v_token text;
  v_grant uuid;
  v_exp timestamptz;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM public.home_passport_links
  WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;

  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 OR NOT (p_scopes <@ public.hp_all_scopes()) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: choose at least one valid access scope' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_scopes <@ l.scopes) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: you can only share access you hold yourself' USING ERRCODE = 'P0001';
  END IF;
  IF p_ttl_hours IS NULL OR p_ttl_hours NOT BETWEEN 1 AND 2160 THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: expiry must be between 1 hour and 90 days' USING ERRCODE = 'P0001';
  END IF;
  IF p_max_uses IS NULL OR p_max_uses NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'HOMEPASSPORT_INVALID: uses must be between 1 and 25' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.home_passport_grants
      WHERE passport_id = v_id AND created_by_user_id = v_owner AND revoked_at IS NULL AND expires_at > now()) >= 20 THEN
    RAISE EXCEPTION 'HOMEPASSPORT_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  v_token := 'hpg_' || encode(gen_random_bytes(24), 'hex');
  v_exp := now() + make_interval(hours => p_ttl_hours);

  INSERT INTO public.home_passport_grants
    (passport_id, token_hash, label, scopes, consent_basis, created_by_user_id, expires_at, max_uses)
  VALUES
    (v_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), nullif(left(btrim(coalesce(p_label, '')), 80), ''),
     (SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(p_scopes) s),
     coalesce(p_consent_basis, 'homeowner_consent'), v_owner, v_exp, p_max_uses)
  RETURNING id INTO v_grant;

  PERFORM public.hp_log(v_id, v_owner, 'grant_create', jsonb_build_object('grant_id', v_grant, 'scopes', to_jsonb(p_scopes), 'expires_at', v_exp));
  -- The plaintext token is returned exactly once; only its hash is stored.
  RETURN jsonb_build_object('id', v_grant, 'token', v_token, 'expires_at', v_exp, 'scopes', to_jsonb(p_scopes));
END;
$$;

CREATE OR REPLACE FUNCTION public.list_home_passport_grants(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.home_passport_links WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified
  ) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', g.id, 'label', g.label, 'scopes', to_jsonb(g.scopes), 'consent_basis', g.consent_basis,
      'expires_at', g.expires_at, 'max_uses', g.max_uses, 'uses', g.uses, 'revoked_at', g.revoked_at, 'created_at', g.created_at,
      'state', CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked'
                    WHEN g.expires_at <= now() THEN 'expired'
                    WHEN g.uses >= g.max_uses THEN 'used'
                    ELSE 'active' END
    ) ORDER BY g.created_at DESC)
    FROM public.home_passport_grants g
    WHERE g.passport_id = v_id AND g.created_by_user_id = v_owner
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_home_passport_grant(p_grant_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  g public.home_passport_grants;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO g FROM public.home_passport_grants WHERE id = p_grant_id AND created_by_user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.home_passport_grants SET revoked_at = coalesce(revoked_at, now()) WHERE id = g.id;
  -- Access that came ONLY from this grant ends with it.
  UPDATE public.home_passport_links SET status = 'ended', ended_at = now()
  WHERE grant_id = g.id AND verified_via = 'grant' AND status = 'active';
  PERFORM public.hp_log(g.passport_id, v_owner, 'grant_revoke', jsonb_build_object('grant_id', g.id));
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_home_passport_grant(p_token text, p_site_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  g public.home_passport_grants;
  v_hash text;
  v_status text;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  v_hash := encode(sha256(convert_to(btrim(coalesce(p_token, '')), 'UTF8')), 'hex');
  SELECT * INTO g FROM public.home_passport_grants WHERE token_hash = v_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOMEPASSPORT_GRANT_INVALID' USING ERRCODE = 'P0001'; END IF;
  IF g.revoked_at IS NOT NULL OR g.expires_at <= now() OR g.uses >= g.max_uses THEN
    RAISE EXCEPTION 'HOMEPASSPORT_GRANT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT status INTO v_status FROM public.home_passports WHERE id = g.passport_id;
  IF v_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'HOMEPASSPORT_RETIRED' USING ERRCODE = 'P0001'; END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_sites WHERE id = p_site_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'HOMEPASSPORT_SITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.hp_upsert_link(g.passport_id, v_owner, p_site_id, 'servicer', 'grant', g.scopes, g.id);
  UPDATE public.home_passport_grants SET uses = uses + 1 WHERE id = g.id;
  PERFORM public.hp_append_event(g.passport_id, 'access_change', 'Servicing company authorised by owner consent', NULL,
                                 jsonb_build_object('method', 'grant', 'consent_basis', g.consent_basis, 'scopes', to_jsonb(g.scopes)),
                                 now(), v_owner, NULL, 'grant:' || g.id::text || ':' || v_owner::text, 'network', 'platform_record');
  PERFORM public.hp_log(g.passport_id, v_owner, 'grant_redeem', jsonb_build_object('grant_id', g.id));
  RETURN public.hp_passport_json(g.passport_id, true, v_owner);
END;
$$;

-- ---------- revenue: what the passport says should happen next ----------

CREATE OR REPLACE FUNCTION public.get_home_passport_opportunities(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  l public.home_passport_links;
  v_items jsonb := '[]'::jsonb;
  x record;
  v_last timestamptz;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(superseded_by, id) INTO v_id FROM public.home_passports WHERE public_code = public.hp_normalize_code(p_code);
  IF v_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT * INTO l FROM public.home_passport_links WHERE passport_id = v_id AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  IF 'equipment' = ANY (l.scopes) THEN
    FOR x IN
      SELECT ep.public_code, ep.equipment_type, ep.make, ep.model, ep.install_date, ep.warranty_expires_at
      FROM public.home_passport_equipment he JOIN public.equipment_passports ep ON ep.id = he.equipment_passport_id
      WHERE he.passport_id = v_id AND he.status = 'installed'
    LOOP
      IF x.warranty_expires_at IS NOT NULL AND x.warranty_expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + 120 THEN
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'kind', 'warranty_expiring', 'priority', CASE WHEN x.warranty_expires_at <= CURRENT_DATE + 30 THEN 'high' ELSE 'medium' END,
          'title', 'Warranty ends ' || to_char(x.warranty_expires_at, 'Mon DD, YYYY') || ': ' || coalesce(nullif(btrim(concat_ws(' ', x.make, x.model)), ''), x.equipment_type),
          'reason', 'Inspect and file any claim before coverage lapses.', 'due_on', x.warranty_expires_at, 'equipment_code', x.public_code));
      END IF;
      IF x.install_date IS NOT NULL AND x.install_date <= CURRENT_DATE - interval '12 years' THEN
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'kind', 'aging_equipment', 'priority', 'medium',
          'title', coalesce(nullif(btrim(concat_ws(' ', x.make, x.model)), ''), x.equipment_type) || ' is ' || extract(year FROM age(CURRENT_DATE, x.install_date))::int || ' years old',
          'reason', 'Plan a replacement or an efficiency review before it fails.', 'due_on', NULL, 'equipment_code', x.public_code));
      END IF;
    END LOOP;
  END IF;

  IF 'service' = ANY (l.scopes) THEN
    SELECT max(occurred_at) INTO v_last FROM public.home_passport_events
    WHERE passport_id = v_id AND event_type IN ('service_visit', 'inspection');
    IF v_last IS NULL OR v_last < now() - interval '365 days' THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kind', 'maintenance_due', 'priority', 'medium',
        'title', CASE WHEN v_last IS NULL THEN 'No service or inspection on record' ELSE 'No service for over a year (last ' || to_char(v_last, 'Mon DD, YYYY') || ')' END,
        'reason', 'A maintenance visit keeps warranties valid and catches failures early.', 'due_on', NULL));
    END IF;

    FOR x IN
      SELECT e.id, e.occurred_at, e.summary -> 'outcome' ->> 'resolution' AS resolution
      FROM public.home_passport_events e
      WHERE e.passport_id = v_id AND e.event_type = 'outcome' AND e.occurred_at > now() - interval '180 days'
        AND (e.summary -> 'outcome' ->> 'resolution') IN ('parts_pending', 'quote_declined', 'unresolved', 'needs_followup', 'part_ordered', 'fixed_followup')
        AND NOT EXISTS (SELECT 1 FROM public.home_passport_events s WHERE s.passport_id = v_id AND s.event_type = 'service_visit' AND s.occurred_at > e.occurred_at)
      ORDER BY e.occurred_at DESC LIMIT 3
    LOOP
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kind', 'open_followup', 'priority', 'high',
        'title', 'Open follow-up: ' || replace(x.resolution, '_', ' '),
        'reason', 'The last outcome is unresolved and no later visit is on record.', 'due_on', NULL, 'event_id', x.id));
    END LOOP;

    FOR x IN
      SELECT e.summary ->> 'component' AS component, count(*) AS n
      FROM public.home_passport_events e
      WHERE e.passport_id = v_id AND e.event_type = 'failure' AND e.occurred_at > now() - interval '24 months'
        AND coalesce(e.summary ->> 'component', '') <> ''
      GROUP BY 1 HAVING count(*) >= 2
    LOOP
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'kind', 'recurring_failure', 'priority', 'high',
        'title', 'Recurring failure: ' || x.component || ' (' || x.n || ' times in 24 months)',
        'reason', 'Repeat failures usually mean a root cause that repairs are not removing.', 'due_on', NULL));
    END LOOP;

    IF to_regclass('public.home_interventions') IS NOT NULL AND l.site_id IS NOT NULL THEN
      FOR x IN
        SELECT i.id, i.title, i.intervention_type, i.risk_level, i.target_date, i.est_cost_low_cents, i.est_cost_high_cents
        FROM public.home_interventions i
        WHERE i.site_id = l.site_id AND i.user_id = v_owner AND i.status IN ('predicted', 'proposed')
        ORDER BY i.target_date NULLS LAST LIMIT 10
      LOOP
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'kind', 'planned_intervention', 'priority', x.risk_level,
          'title', x.title, 'reason', 'Planned ' || x.intervention_type || ' from the Home Lifetime Graph.',
          'due_on', x.target_date, 'est_low_cents', x.est_cost_low_cents, 'est_high_cents', x.est_cost_high_cents));
      END LOOP;
    END IF;
  END IF;

  IF 'permits' = ANY (l.scopes) THEN
    FOR x IN
      SELECT DISTINCT ON (coalesce(e.summary ->> 'permit_number', e.id::text))
             e.summary ->> 'status' AS status, e.summary ->> 'permit_number' AS number, e.summary ->> 'expires_on' AS expires_on, e.summary ->> 'permit_type' AS ptype
      FROM public.home_passport_events e
      WHERE e.passport_id = v_id AND e.event_type = 'permit'
      ORDER BY coalesce(e.summary ->> 'permit_number', e.id::text), e.occurred_at DESC, e.seq DESC
    LOOP
      IF x.status IN ('failed', 'expired')
         OR (x.status IN ('applied', 'issued', 'inspection_pending') AND x.expires_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             AND x.expires_on::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60) THEN
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'kind', 'permit_attention', 'priority', 'high',
          'title', initcap(replace(coalesce(x.ptype, 'other'), '_', ' ')) || ' permit ' || coalesce('#' || x.number || ' ', '') || '(' || replace(x.status, '_', ' ') || ')',
          'reason', 'An open or failed permit can block resale, insurance and warranty claims.', 'due_on', NULLIF(x.expires_on, '')));
      END IF;
    END LOOP;
  END IF;

  RETURN v_items;
END;
$$;

-- ---------- AI: compact, scope-safe context for assistants and agents ----------

CREATE OR REPLACE FUNCTION public.get_home_passport_ai_context(p_site_id uuid, p_user uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := coalesce(public.get_account_owner_id(), CASE WHEN public.hp_is_service_role() THEN p_user END);
  l public.home_passport_links;
  p public.home_passports;
  v_events jsonb := '[]'::jsonb;
  v_equipment jsonb := '[]'::jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HOMEPASSPORT_UNAUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM public.home_passport_links
  WHERE site_id = p_site_id AND user_id = v_owner AND status = 'active' AND verified;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false); END IF;
  SELECT * INTO p FROM public.home_passports WHERE id = l.passport_id;

  SELECT coalesce(jsonb_agg(t.o ORDER BY t.occurred_at DESC), '[]'::jsonb) INTO v_events
  FROM (
    SELECT e.occurred_at, jsonb_strip_nulls(jsonb_build_object(
      'type', e.event_type, 'title', e.title, 'date', e.occurred_at::date,
      'verification', e.verification_level, 'confidence', e.confidence,
      'diagnosis', e.summary ->> 'diagnosis',
      'resolution', e.summary -> 'outcome' ->> 'resolution',
      'component', e.summary ->> 'component')) AS o
    FROM public.home_passport_events e
    WHERE e.passport_id = l.passport_id AND public.hp_scope_of(e.event_type) = ANY (l.scopes)
      AND (e.visibility = 'network' OR e.contributor_user_id IS NOT DISTINCT FROM v_owner)
    ORDER BY e.occurred_at DESC LIMIT 15
  ) t;

  IF 'equipment' = ANY (l.scopes) THEN
    SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'type', ep.equipment_type, 'make', ep.make, 'model', ep.model,
      'installed', ep.install_date, 'warranty_expires', ep.warranty_expires_at)) ), '[]'::jsonb) INTO v_equipment
    FROM public.home_passport_equipment he JOIN public.equipment_passports ep ON ep.id = he.equipment_passport_id
    WHERE he.passport_id = l.passport_id AND he.status = 'installed';
  END IF;

  RETURN jsonb_build_object(
    'available', true,
    'code', p.public_code,
    'property', jsonb_strip_nulls(jsonb_build_object('type', p.property_type, 'city', p.city, 'region', p.region, 'year_built', p.year_built)),
    'chain_valid', public.hp_verify_chain(l.passport_id) -> 'valid',
    'equipment', v_equipment,
    'recent_history', v_events);
END;
$$;

-- =============================================================
-- 8. EVENT BUS  ('home_passport.updated' webhook, per contributing company)
-- =============================================================

CREATE OR REPLACE FUNCTION public.hp_dispatch_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
  v_endpoint record;
  v_code text;
BEGIN
  BEGIN
    IF NEW.contributor_user_id IS NULL THEN RETURN NULL; END IF;
    v_base_url := current_setting('app.settings.edge_function_base_url', true);
    v_secret := current_setting('app.settings.push_dispatch_secret', true);
    IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN RETURN NULL; END IF;
    SELECT public_code INTO v_code FROM public.home_passports WHERE id = NEW.passport_id;

    FOR v_endpoint IN
      SELECT id FROM public.webhook_endpoints
      WHERE user_id = NEW.contributor_user_id AND status = 'active' AND 'home_passport.updated' = ANY (events)
    LOOP
      PERFORM net.http_post(
        url := v_base_url || '/event-bus-dispatch',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-dispatch-secret', v_secret),
        body := jsonb_build_object(
          'endpoint_id', v_endpoint.id,
          'event_type', 'home_passport.updated',
          'record', jsonb_build_object(
            'user_id', NEW.contributor_user_id, 'passport_code', v_code, 'event_id', NEW.id, 'seq', NEW.seq,
            'event_type', NEW.event_type, 'title', NEW.title, 'occurred_at', NEW.occurred_at,
            'source_type', NEW.source_type, 'verification_level', NEW.verification_level,
            'confidence', NEW.confidence, 'entry_hash', NEW.entry_hash)));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'home passport webhook dispatch skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DO $hp$
DECLARE
  d text;
  v_list text[];
BEGIN
  IF to_regclass('public.webhook_endpoints') IS NULL THEN RETURN; END IF;

  -- Extend the allow-list from whatever it contains TODAY (keeps events added after the original migration).
  SELECT pg_get_constraintdef(c.oid) INTO d FROM pg_constraint c
  WHERE c.conrelid = 'public.webhook_endpoints'::regclass AND c.conname = 'webhook_endpoints_valid_events';
  IF d IS NOT NULL AND position('home_passport.updated' IN d) = 0 THEN
    SELECT array_agg(DISTINCT m.a[1]) INTO v_list FROM regexp_matches(d, '''([a-z0-9_.]+)''', 'g') AS m(a);
    v_list := array_append(coalesce(v_list, '{}'), 'home_passport.updated');
    ALTER TABLE public.webhook_endpoints DROP CONSTRAINT webhook_endpoints_valid_events;
    EXECUTE format('ALTER TABLE public.webhook_endpoints ADD CONSTRAINT webhook_endpoints_valid_events CHECK (events <@ %L::text[])', v_list);
  END IF;

  DROP TRIGGER IF EXISTS trg_hp_dispatch ON public.home_passport_events;
  CREATE TRIGGER trg_hp_dispatch AFTER INSERT ON public.home_passport_events
    FOR EACH ROW EXECUTE FUNCTION public.hp_dispatch_event();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'home passport event-bus wiring skipped: %', SQLERRM;
END
$hp$;

-- =============================================================
-- 9. PRIVILEGES
-- =============================================================


-- Internal functions: never callable from the browser.
REVOKE ALL ON FUNCTION public.hp_normalize_code(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hp_provenance(text, integer, boolean, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_event_hash(public.home_passport_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_verify_chain(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_append_event(uuid, text, text, text, jsonb, timestamptz, uuid, uuid, text, text, text, text, integer, text, boolean, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_log(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_issue_for_site(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_upsert_link(uuid, uuid, uuid, text, text, text[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_resolve_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_record_job_service(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_record_permit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_record_failure(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_record_ownership(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_passport_json(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hp_dispatch_event() FROM PUBLIC, anon, authenticated;

-- Public QR verification: no login, no history.
REVOKE ALL ON FUNCTION public.verify_home_passport(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_home_passport(text) TO anon, authenticated;

-- Signed-in RPCs.
REVOKE ALL ON FUNCTION public.get_home_passport(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_home_passports() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_home_passport_for_site(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.issue_home_passport(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_home_passport(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_home_passport(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_home_passport_event(text, text, text, text, timestamptz, boolean, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attest_home_passport_event(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_home_passport_sharing(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_home_passport_grant(text, text[], integer, text, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_home_passport_grants(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_home_passport_grant(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_home_passport_grant(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_home_passport_opportunities(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_home_passport_ai_context(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_home_passport(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_home_passports() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_home_passport_for_site(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_home_passport(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_home_passport(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_home_passport(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_home_passport_event(text, text, text, text, timestamptz, boolean, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attest_home_passport_event(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_home_passport_sharing(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_home_passport_grant(text, text[], integer, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_home_passport_grants(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_home_passport_grant(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_home_passport_grant(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_home_passport_opportunities(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_home_passport_ai_context(uuid, uuid) TO authenticated, service_role;

-- =============================================================
-- 10. BACKFILL: give every existing customer site its passport (history is imported per home from the UI)
-- =============================================================

DO $hp$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.customer_sites ORDER BY created_at LOOP
    BEGIN
      PERFORM public.hp_issue_for_site(r.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'home passport backfill skipped site %: %', r.id, SQLERRM;
    END;
  END LOOP;
END
$hp$;
