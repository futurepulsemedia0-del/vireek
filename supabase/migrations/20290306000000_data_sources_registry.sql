/*
  # Data-source registry + non-customer data-subject handling

  ## Why
  property-intelligence-enrich sends a customer's site address to third-party services and
  identity-signal-scan sends aggregated owner-decision metadata to AI providers. Nothing recorded
  WHICH providers, WHAT leaves Vireek, under WHICH terms, or for HOW LONG. Separately, the public
  DSAR flow (dsar-request) only fully handles account owners; verified requests from people who are
  NOT Vireek customers (a contractor's customers, website visitors) were only "queued" for staff.

  ## New tables
  - data_sources                 : registry of every external data/inference provider the code calls.
                                   Staff-managed (profiles.is_staff). Seeded from code (see seed block).
  - data_subject_suppressions    : hashed email / address keys of people who opted out. Service-role only.
  - dsar_controller_referrals    : per-tenant "a data subject asked about records you control" tasks.
                                   Vireek is the processor for tenant customer data, so deleting those
                                   rows is the tenant's decision [COUNSEL]. Tenant sees only its own rows.

  ## New functions
  - dsar_suppression_key(kind, value)       : normalise + sha256 -> hex (NULL when value is too short to be safe).
  - property_site_suppressed(site_id)       : boolean for the enrich edge function (caller-scoped).
  - dsar_discover_non_customer_data(email)  : per-tenant row COUNTS only (service role).
  - dsar_erase_property_enrichment(email)   : clears Vireek-derived geocode/enrichment for matching sites (service role).
  - dsar_referral_resolve(id, note)         : tenant owner/admin closes a referral.

  Additive and idempotent: safe to run more than once. No existing table is altered.
  Requires: profiles.is_staff, customers, customer_sites, property_profiles, property_intel_layers,
            data_subject_requests, public.get_account_owner_id(), public.set_updated_at(), pgcrypto.
*/

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =============================================================
-- 1. data_sources
-- =============================================================

CREATE TABLE IF NOT EXISTS public.data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE CHECK (source_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 120),
  provider_kind text NOT NULL
    CHECK (provider_kind IN ('geocoder', 'government_open_data', 'weather_reanalysis', 'ai_inference')),
  hosts text[] NOT NULL DEFAULT '{}',
  data_types text[] NOT NULL CHECK (cardinality(data_types) >= 1),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 500),
  personal_data_sent text[] NOT NULL DEFAULT '{}',
  data_subjects text[] NOT NULL DEFAULT '{}',
  license_note text NOT NULL CHECK (char_length(license_note) BETWEEN 1 AND 1000),
  license_status text NOT NULL DEFAULT 'verify' CHECK (license_status IN ('verify', 'verified', 'restricted')),
  terms_url text CHECK (terms_url IS NULL OR terms_url ~ '^https://'),
  retention_note text NOT NULL CHECK (char_length(retention_note) BETWEEN 1 AND 500),
  retention_days integer CHECK (retention_days IS NULL OR retention_days >= 0),
  used_by text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  last_reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A source may only be marked 'verified' after a named reviewer looked at the terms.
  CONSTRAINT data_sources_verified_needs_review
    CHECK (license_status <> 'verified' OR (last_reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_data_sources_kind ON public.data_sources (provider_kind) WHERE active;

COMMENT ON TABLE public.data_sources IS
  'Registry of external data/inference providers called by Vireek code. Seeded from code; license_status stays "verify" until a staff reviewer confirms the provider terms.';

DROP TRIGGER IF EXISTS trg_data_sources_updated ON public.data_sources;
CREATE TRIGGER trg_data_sources_updated
  BEFORE UPDATE ON public.data_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_data_sources" ON public.data_sources;
CREATE POLICY "staff_select_data_sources" ON public.data_sources FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

DROP POLICY IF EXISTS "staff_insert_data_sources" ON public.data_sources;
CREATE POLICY "staff_insert_data_sources" ON public.data_sources FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

DROP POLICY IF EXISTS "staff_update_data_sources" ON public.data_sources;
CREATE POLICY "staff_update_data_sources" ON public.data_sources FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

-- No DELETE policy on purpose: retire a source with active = false so the history stays.

-- -------------------------------------------------------------
-- Seed: populated from code (property-intelligence-enrich, identity-signal-scan -> ai-core).
-- DO NOTHING on conflict so a reviewer's edits are never overwritten by a re-run.
-- -------------------------------------------------------------
INSERT INTO public.data_sources
  (source_key, provider, provider_kind, hosts, data_types, purpose, personal_data_sent, data_subjects,
   license_note, terms_url, retention_note, retention_days, used_by)
VALUES
  ('osm-nominatim', 'OpenStreetMap Nominatim', 'geocoder',
   ARRAY['nominatim.openstreetmap.org'],
   ARRAY['geocoded coordinates', 'country code', 'display address'],
   'Convert a customer site address to coordinates so the Property Intelligence Graph can attach climate, hazard and area data.',
   ARRAY['full site street address (address, city, state, postal code)'],
   ARRAY['end customers of Vireek tenants (non-customers of Vireek)'],
   '[VERIFY] Public Nominatim instance has a usage policy (identifying User-Agent, request-rate limits, restrictions on bulk use); results are OpenStreetMap data under ODbL (attribution/share-alike). Confirm commercial SaaS use is permitted or move to a licensed/self-hosted geocoder.',
   'https://operations.osmfoundation.org/policies/nominatim/',
   'Coordinates and normalized address are stored on property_profiles for the life of the customer site (deleted by cascade when the site is deleted). No separate retention job located in code [VERIFY].',
   NULL,
   ARRAY['property-intelligence-enrich']),
  ('us-census-geocoder', 'US Census Bureau Geocoder', 'government_open_data',
   ARRAY['geocoding.geo.census.gov'],
   ARRAY['census tract GEOID'],
   'Resolve a coordinate pair to a US census tract for area-level economic context.',
   ARRAY['site latitude/longitude (precise location of a residence or business)'],
   ARRAY['end customers of Vireek tenants (non-customers of Vireek)'],
   '[VERIFY] US government public service; confirm current terms and any attribution or non-endorsement wording required.',
   NULL,
   'Only the 11-digit tract id is stored (property_profiles.census_geoid), for the life of the site.',
   NULL,
   ARRAY['property-intelligence-enrich']),
  ('us-census-acs', 'US Census Bureau ACS 5-year API', 'government_open_data',
   ARRAY['api.census.gov'],
   ARRAY['area-level income, housing and demographic statistics'],
   'Area-level economic context for a property (never about the occupants).',
   ARRAY[]::text[],
   ARRAY[]::text[],
   '[VERIFY] Census Data API terms of use (attribution and non-endorsement notice). Optional CENSUS_API_KEY secret is read from the environment, never from code.',
   NULL,
   'Stored as the "economic" layer in property_intel_layers for the life of the site.',
   NULL,
   ARRAY['property-intelligence-enrich']),
  ('open-meteo-archive', 'Open-Meteo Historical Weather API', 'weather_reanalysis',
   ARRAY['archive-api.open-meteo.com'],
   ARRAY['5-year temperature and precipitation history (ERA5 reanalysis)'],
   'Climate normals for a property, used for equipment-stress and seasonal context.',
   ARRAY['site latitude/longitude (precise location of a residence or business)'],
   ARRAY['end customers of Vireek tenants (non-customers of Vireek)'],
   '[VERIFY] The free Open-Meteo API is offered for non-commercial use; commercial use normally needs a paid plan or self-hosting. Vireek is a commercial SaaS: confirm the plan in use before relying on this source.',
   'https://open-meteo.com/en/terms',
   'Derived climate summary stored as the "climate" layer for the life of the site; raw series are not stored.',
   NULL,
   ARRAY['property-intelligence-enrich']),
  ('fema-nfhl', 'FEMA National Flood Hazard Layer', 'government_open_data',
   ARRAY['hazards.fema.gov'],
   ARRAY['flood zone designation'],
   'Flood-zone context for a US property.',
   ARRAY['site latitude/longitude (precise location of a residence or business)'],
   ARRAY['end customers of Vireek tenants (non-customers of Vireek)'],
   '[VERIFY] US government public data service; confirm terms, availability expectations and any disclaimer to show alongside the result.',
   NULL,
   'Stored in the "hazards" layer for the life of the site.',
   NULL,
   ARRAY['property-intelligence-enrich']),
  ('usgs-comcat', 'USGS ComCat Earthquake Catalog', 'government_open_data',
   ARRAY['earthquake.usgs.gov'],
   ARRAY['count of regional M4+ earthquakes'],
   'Regional seismic activity context for a property.',
   ARRAY['site latitude/longitude (precise location of a residence or business)'],
   ARRAY['end customers of Vireek tenants (non-customers of Vireek)'],
   '[VERIFY] US government public data service; confirm terms and any required credit line.',
   NULL,
   'Stored in the "hazards" layer for the life of the site.',
   NULL,
   ARRAY['property-intelligence-enrich']),
  ('ai-gemini', 'Google Gemini API', 'ai_inference',
   ARRAY['generativelanguage.googleapis.com'],
   ARRAY['short generated text (drift title and summary)'],
   'Narrate an identity-drift alert for the account owner. First provider in the continual_identity_learner chain.',
   ARRAY[]::text[],
   ARRAY['Vireek account owners (their own aggregated decision metadata only)'],
   '[VERIFY] AI provider terms: whether API inputs are used for training and the data-processing terms in force for the key used. A deterministic fallback text is used when every provider fails.',
   NULL,
   'Prompt/response retention at the provider is governed by the provider account settings [VERIFY]. Vireek stores only the generated title and summary on identity_drift_alerts.',
   NULL,
   ARRAY['identity-signal-scan']),
  ('ai-groq', 'Groq Cloud API', 'ai_inference',
   ARRAY['api.groq.com'],
   ARRAY['short generated text (drift title and summary)'],
   'Second provider in the continual_identity_learner chain.',
   ARRAY[]::text[],
   ARRAY['Vireek account owners (their own aggregated decision metadata only)'],
   '[VERIFY] AI provider terms and training/retention settings for the key used.',
   NULL,
   'Provider-side retention [VERIFY]; Vireek stores only the generated text.',
   NULL,
   ARRAY['identity-signal-scan']),
  ('ai-cerebras', 'Cerebras Inference API', 'ai_inference',
   ARRAY['api.cerebras.ai'],
   ARRAY['short generated text (drift title and summary)'],
   'Third provider in the continual_identity_learner chain.',
   ARRAY[]::text[],
   ARRAY['Vireek account owners (their own aggregated decision metadata only)'],
   '[VERIFY] AI provider terms and training/retention settings for the key used.',
   NULL,
   'Provider-side retention [VERIFY]; Vireek stores only the generated text.',
   NULL,
   ARRAY['identity-signal-scan']),
  ('ai-openrouter', 'OpenRouter', 'ai_inference',
   ARRAY['openrouter.ai'],
   ARRAY['short generated text (drift title and summary)'],
   'Last provider in the continual_identity_learner chain; routes to an upstream model chosen by OpenRouter ("openrouter/auto"), so the real downstream processor can vary.',
   ARRAY[]::text[],
   ARRAY['Vireek account owners (their own aggregated decision metadata only)'],
   '[VERIFY] OpenRouter terms plus the terms of whichever upstream provider serves a request; confirm data-collection settings on the key.',
   NULL,
   'Provider-side retention [VERIFY]; Vireek stores only the generated text.',
   NULL,
   ARRAY['identity-signal-scan'])
ON CONFLICT (source_key) DO NOTHING;

-- =============================================================
-- 2. Suppression list (opt-outs of non-customer data subjects)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.data_subject_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_kind text NOT NULL CHECK (key_kind IN ('email', 'address')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL DEFAULT 'opt_out' CHECK (reason IN ('opt_out', 'deletion')),
  dsar_id uuid REFERENCES public.data_subject_requests(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_kind, key_hash)
);

ALTER TABLE public.data_subject_suppressions ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: service-role only (same model as dsar_rate_limit).

-- Normalise + hash. NULL means "too short to suppress safely" (avoids matching everything on an empty key).
CREATE OR REPLACE FUNCTION public.dsar_suppression_key(p_kind text, p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $$
DECLARE
  v text;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF p_kind = 'email' THEN
    v := lower(btrim(p_value));
    IF char_length(v) < 5 OR position('@' IN v) < 2 THEN RETURN NULL; END IF;
  ELSIF p_kind = 'address' THEN
    -- ASCII alphanumerics only; must stay identical to normalizeAddressKey() in _shared/compliance/nonCustomerDsar.ts
    v := regexp_replace(lower(p_value), '[^a-z0-9]+', '', 'g');
    IF char_length(v) < 8 THEN RETURN NULL; END IF;
  ELSE
    RETURN NULL;
  END IF;
  RETURN encode(extensions.digest(p_kind || ':' || v, 'sha256'), 'hex');
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_suppression_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dsar_suppression_key(text, text) TO service_role;

-- Used by property-intelligence-enrich (runs as the caller). Reveals nothing for sites outside the caller's account.
CREATE OR REPLACE FUNCTION public.property_site_suppressed(p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.customer_sites s
      JOIN public.customers c ON c.id = s.customer_id
     WHERE s.id = p_site_id
       AND s.user_id = public.get_account_owner_id()
       AND EXISTS (
         SELECT 1 FROM public.data_subject_suppressions x
          WHERE (x.key_kind = 'email'
                 AND x.key_hash = public.dsar_suppression_key('email', c.email))
             OR (x.key_kind = 'address'
                 AND x.key_hash = public.dsar_suppression_key(
                       'address', concat_ws(' ', s.address, s.city, s.state, s.postal_code)))
       )
  );
$$;

REVOKE ALL ON FUNCTION public.property_site_suppressed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_site_suppressed(uuid) TO authenticated, service_role;

-- =============================================================
-- 3. Referrals to the tenant that controls the data
-- =============================================================

CREATE TABLE IF NOT EXISTS public.dsar_controller_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dsar_id uuid NOT NULL REFERENCES public.data_subject_requests(id) ON DELETE CASCADE,
  tenant_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_kind text NOT NULL CHECK (request_kind IN ('access', 'delete', 'correct')),
  source_table text NOT NULL CHECK (source_table IN ('customers', 'leads')),
  row_count integer NOT NULL CHECK (row_count >= 0),
  subject_email text CHECK (subject_email IS NULL OR char_length(subject_email) <= 254),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  due_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dsar_id, tenant_user_id, source_table)
);

CREATE INDEX IF NOT EXISTS idx_dsar_referrals_tenant ON public.dsar_controller_referrals (tenant_user_id, status);
CREATE INDEX IF NOT EXISTS idx_dsar_referrals_open_due ON public.dsar_controller_referrals (due_at) WHERE status = 'open';

ALTER TABLE public.dsar_controller_referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_select_dsar_referrals" ON public.dsar_controller_referrals;
CREATE POLICY "tenant_select_dsar_referrals" ON public.dsar_controller_referrals FOR SELECT TO authenticated
  USING (tenant_user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "staff_select_dsar_referrals" ON public.dsar_controller_referrals;
CREATE POLICY "staff_select_dsar_referrals" ON public.dsar_controller_referrals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_staff));

-- Writes happen only through the service role (edge function) or dsar_referral_resolve().

CREATE OR REPLACE FUNCTION public.dsar_referral_resolve(p_id uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_dsar uuid;
  v_open integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'DSAR_REFERRAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Same gate as tenant-export: only an owner/admin of the account may decide on data it controls.
  IF NOT COALESCE(public.agent_network_is_admin(), false) THEN
    RAISE EXCEPTION 'DSAR_REFERRAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE public.dsar_controller_referrals
     SET status = 'resolved', resolved_at = now(), subject_email = NULL,
         resolution_note = left(btrim(coalesce(p_note, '')), 1000)
   WHERE id = p_id AND tenant_user_id = v_owner AND status = 'open'
   RETURNING dsar_id INTO v_dsar;

  IF v_dsar IS NULL THEN RETURN false; END IF;

  -- Last open referral for this request closes the loop on the DSAR itself.
  SELECT count(*) INTO v_open FROM public.dsar_controller_referrals WHERE dsar_id = v_dsar AND status = 'open';
  IF v_open = 0 THEN
    UPDATE public.data_subject_requests
       SET status = 'completed', completed_at = now(),
           resolution_note = 'Vireek-held data handled; every controller referral has been resolved.'
     WHERE id = v_dsar AND status = 'in_progress';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_referral_resolve(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dsar_referral_resolve(uuid, text) TO authenticated;

-- =============================================================
-- 4. Discovery (counts only) + erasure of Vireek-derived data
-- =============================================================

CREATE OR REPLACE FUNCTION public.dsar_discover_non_customer_data(p_email text)
RETURNS TABLE (tenant_user_id uuid, source_table text, row_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Counts only, never content. Exact match on the normalised address (no LIKE wildcards).
  SELECT c.user_id, 'customers'::text, count(*)
    FROM public.customers c
   WHERE lower(btrim(c.email)) = lower(btrim(p_email))
   GROUP BY c.user_id
  UNION ALL
  SELECT l.user_id, 'leads'::text, count(*)
    FROM public.leads l
   WHERE lower(btrim(l.email)) = lower(btrim(p_email))
   GROUP BY l.user_id;
$$;

REVOKE ALL ON FUNCTION public.dsar_discover_non_customer_data(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dsar_discover_non_customer_data(text) TO service_role;

CREATE OR REPLACE FUNCTION public.dsar_erase_property_enrichment(p_email text, p_dsar_id uuid)
RETURNS TABLE (profiles_cleared integer, layers_deleted integer, suppressions_added integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_sites uuid[];
  v_profiles integer := 0;
  v_layers integer := 0;
  v_supp integer := 0;
  v_added integer;
  r record;
  v_key text;
BEGIN
  SELECT coalesce(array_agg(s.id), '{}') INTO v_sites
    FROM public.customer_sites s
    JOIN public.customers c ON c.id = s.customer_id
   WHERE lower(btrim(c.email)) = lower(btrim(p_email));

  -- Provider-fetched layers only. 'manual' layers were typed in by the tenant: that is tenant data (see referrals).
  DELETE FROM public.property_intel_layers
   WHERE profile_id IN (SELECT id FROM public.property_profiles WHERE site_id = ANY (v_sites))
     AND status <> 'manual'
     AND layer IN ('climate', 'hazards', 'economic');
  GET DIAGNOSTICS v_layers = ROW_COUNT;

  UPDATE public.property_profiles
     SET latitude = NULL, longitude = NULL, normalized_address = NULL, geocoded_query = NULL,
         geocode_source = NULL, geocode_confidence = NULL, census_geoid = NULL,
         enrichment_status = 'never', last_enriched_at = NULL
   WHERE site_id = ANY (v_sites);
  GET DIAGNOSTICS v_profiles = ROW_COUNT;

  -- Stop the same address being re-enriched by the tenant tomorrow.
  FOR r IN SELECT s.address, s.city, s.state, s.postal_code FROM public.customer_sites s WHERE s.id = ANY (v_sites) LOOP
    v_key := public.dsar_suppression_key('address', concat_ws(' ', r.address, r.city, r.state, r.postal_code));
    IF v_key IS NOT NULL THEN
      INSERT INTO public.data_subject_suppressions (key_kind, key_hash, reason, dsar_id)
      VALUES ('address', v_key, 'deletion', p_dsar_id)
      ON CONFLICT (key_kind, key_hash) DO NOTHING;
      GET DIAGNOSTICS v_added = ROW_COUNT;
      v_supp := v_supp + v_added;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_profiles, v_layers, v_supp;
END;
$$;

REVOKE ALL ON FUNCTION public.dsar_erase_property_enrichment(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dsar_erase_property_enrichment(text, uuid) TO service_role;
