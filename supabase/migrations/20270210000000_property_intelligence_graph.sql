/*
  # Vireek Property Intelligence Graph

  Separate from the Property Digital Twin (service system of record). The twin answers
  "what do we service here?"; the graph answers "what do we know about this building?":

    Address -> Parcel -> Building -> Structure -> Unit
            -> Characteristics -> Climate -> Hazards -> Permits / Construction history
            -> Energy -> Economic context   (+ Equipment / Service history from the twin)

  ## Tables
  - property_profiles      : one per customer_sites row. Normalized address, coordinates, census tract, enrichment status.
  - property_intel_layers  : one row per (profile, layer). Provider layers (climate, hazards, economic) are written by the
                             property-intelligence-enrich edge function; characteristics / energy are user-entered ('manual').
                             Every row carries provenance: source, confidence, as_of, fetched_at.
  - property_intel_nodes   : graph nodes (parcel, building, structure, unit, permit, construction_event) with a validated
                             parent hierarchy and an optional bridge to customer_site_buildings.

  ## Guarantees
  - RLS: every row is scoped to get_account_owner_id() (team members share the owner's data).
  - Hierarchy is validated by trigger (allowed parent kinds, same profile, no kind change, bridge belongs to the same site).
  - Manual layers are never overwritten by providers (enforced in the edge function).
  - get_property_intelligence(site, create) returns profile + layers + nodes in one round trip (SECURITY INVOKER -> RLS applies).

  Requires: customer_sites, customer_site_buildings, public.get_account_owner_id(), public.set_updated_at().
  Additive only: no existing table is modified.
*/

-- =============================================================
-- 1. PROFILES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.property_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  site_id uuid NOT NULL UNIQUE REFERENCES public.customer_sites(id) ON DELETE CASCADE,
  normalized_address text CHECK (normalized_address IS NULL OR char_length(normalized_address) <= 500),
  geocoded_query text CHECK (geocoded_query IS NULL OR char_length(geocoded_query) <= 500),
  latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  geocode_source text,
  geocode_confidence numeric(3, 2) CHECK (geocode_confidence IS NULL OR geocode_confidence BETWEEN 0 AND 1),
  country_code text CHECK (country_code IS NULL OR char_length(country_code) = 2),
  census_geoid text CHECK (census_geoid IS NULL OR census_geoid ~ '^[0-9]{11}$'),
  enrichment_status text NOT NULL DEFAULT 'never'
    CHECK (enrichment_status IN ('never', 'running', 'complete', 'partial', 'failed')),
  last_enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_profiles_user ON public.property_profiles (user_id);

COMMENT ON TABLE public.property_profiles IS
  'Vireek Property Intelligence Graph: one profile per customer site (address, coordinates, census tract, enrichment state).';

-- =============================================================
-- 2. LAYERS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.property_intel_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  profile_id uuid NOT NULL REFERENCES public.property_profiles(id) ON DELETE CASCADE,
  layer text NOT NULL CHECK (layer IN ('climate', 'hazards', 'economic', 'energy', 'characteristics')),
  status text NOT NULL CHECK (status IN ('ok', 'partial', 'unavailable', 'manual', 'failed')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 100000),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 120),
  confidence numeric(3, 2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  as_of date,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  UNIQUE (profile_id, layer)
);

CREATE INDEX IF NOT EXISTS idx_property_intel_layers_user ON public.property_intel_layers (user_id);

-- =============================================================
-- 3. NODES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.property_intel_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  profile_id uuid NOT NULL REFERENCES public.property_profiles(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.property_intel_nodes(id) ON DELETE CASCADE,
  site_building_id uuid REFERENCES public.customer_site_buildings(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('parcel', 'building', 'structure', 'unit', 'permit', 'construction_event')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  occurred_on date,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 20000),
  source text NOT NULL DEFAULT 'manual' CHECK (char_length(source) BETWEEN 1 AND 120),
  verified boolean NOT NULL DEFAULT false,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_intel_nodes_profile ON public.property_intel_nodes (profile_id, kind);
CREATE INDEX IF NOT EXISTS idx_property_intel_nodes_parent ON public.property_intel_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_property_intel_nodes_user ON public.property_intel_nodes (user_id);

-- =============================================================
-- 4. TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_property_profiles_updated ON public.property_profiles;
CREATE TRIGGER trg_property_profiles_updated
  BEFORE UPDATE ON public.property_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_property_intel_nodes_updated ON public.property_intel_nodes;
CREATE TRIGGER trg_property_intel_nodes_updated
  BEFORE UPDATE ON public.property_intel_nodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.pin_validate_node()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_parent_kind text;
  v_parent_profile uuid;
  v_site uuid;
  v_bsite uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'PROPERTY_INTEL_INVALID: profile and kind cannot change' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'PROPERTY_INTEL_INVALID: a node cannot be its own parent' USING ERRCODE = 'P0001';
    END IF;

    SELECT n.kind, n.profile_id INTO v_parent_kind, v_parent_profile
    FROM public.property_intel_nodes n WHERE n.id = NEW.parent_id;

    IF v_parent_kind IS NULL OR v_parent_profile IS DISTINCT FROM NEW.profile_id THEN
      RAISE EXCEPTION 'PROPERTY_INTEL_INVALID: unknown parent' USING ERRCODE = 'P0001';
    END IF;

    IF NOT (
      CASE NEW.kind
        WHEN 'parcel' THEN false
        WHEN 'building' THEN v_parent_kind = 'parcel'
        WHEN 'structure' THEN v_parent_kind = 'building'
        WHEN 'unit' THEN v_parent_kind IN ('structure', 'building')
        WHEN 'permit' THEN v_parent_kind IN ('parcel', 'building', 'structure')
        ELSE v_parent_kind IN ('parcel', 'building', 'structure', 'unit')
      END
    ) THEN
      RAISE EXCEPTION 'PROPERTY_INTEL_INVALID: a % cannot sit under a %', NEW.kind, v_parent_kind USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.site_building_id IS NOT NULL THEN
    IF NEW.kind <> 'building' THEN
      RAISE EXCEPTION 'PROPERTY_INTEL_INVALID: only building nodes link to a site building' USING ERRCODE = 'P0001';
    END IF;
    SELECT p.site_id INTO v_site FROM public.property_profiles p WHERE p.id = NEW.profile_id;
    SELECT b.site_id INTO v_bsite FROM public.customer_site_buildings b WHERE b.id = NEW.site_building_id;
    IF v_bsite IS DISTINCT FROM v_site THEN
      RAISE EXCEPTION 'PROPERTY_INTEL_INVALID: building belongs to another site' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  NEW.name := btrim(NEW.name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_intel_nodes_validate ON public.property_intel_nodes;
CREATE TRIGGER trg_property_intel_nodes_validate
  BEFORE INSERT OR UPDATE ON public.property_intel_nodes
  FOR EACH ROW EXECUTE FUNCTION public.pin_validate_node();

-- =============================================================
-- 5. RLS
-- =============================================================

ALTER TABLE public.property_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_intel_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_intel_nodes ENABLE ROW LEVEL SECURITY;

-- profiles: the site must belong to the same account
DROP POLICY IF EXISTS "pin_profiles_select" ON public.property_profiles;
CREATE POLICY "pin_profiles_select" ON public.property_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pin_profiles_insert" ON public.property_profiles;
CREATE POLICY "pin_profiles_insert" ON public.property_profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.customer_sites s WHERE s.id = site_id AND s.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "pin_profiles_update" ON public.property_profiles;
CREATE POLICY "pin_profiles_update" ON public.property_profiles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pin_profiles_delete" ON public.property_profiles;
CREATE POLICY "pin_profiles_delete" ON public.property_profiles FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- layers
DROP POLICY IF EXISTS "pin_layers_select" ON public.property_intel_layers;
CREATE POLICY "pin_layers_select" ON public.property_intel_layers FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pin_layers_insert" ON public.property_intel_layers;
CREATE POLICY "pin_layers_insert" ON public.property_intel_layers FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.property_profiles p WHERE p.id = profile_id AND p.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "pin_layers_update" ON public.property_intel_layers;
CREATE POLICY "pin_layers_update" ON public.property_intel_layers FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pin_layers_delete" ON public.property_intel_layers;
CREATE POLICY "pin_layers_delete" ON public.property_intel_layers FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- nodes
DROP POLICY IF EXISTS "pin_nodes_select" ON public.property_intel_nodes;
CREATE POLICY "pin_nodes_select" ON public.property_intel_nodes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pin_nodes_insert" ON public.property_intel_nodes;
CREATE POLICY "pin_nodes_insert" ON public.property_intel_nodes FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM public.property_profiles p WHERE p.id = profile_id AND p.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "pin_nodes_update" ON public.property_intel_nodes;
CREATE POLICY "pin_nodes_update" ON public.property_intel_nodes FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "pin_nodes_delete" ON public.property_intel_nodes;
CREATE POLICY "pin_nodes_delete" ON public.property_intel_nodes FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 6. READ MODEL: one round trip
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_property_intelligence(p_site_id uuid, p_create boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_profile public.property_profiles;
BEGIN
  IF p_create THEN
    INSERT INTO public.property_profiles (site_id)
    SELECT s.id FROM public.customer_sites s WHERE s.id = p_site_id
    ON CONFLICT (site_id) DO NOTHING;
  END IF;

  SELECT * INTO v_profile FROM public.property_profiles WHERE site_id = p_site_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'profile', to_jsonb(v_profile),
    'layers', coalesce((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.layer)
      FROM public.property_intel_layers l WHERE l.profile_id = v_profile.id
    ), '[]'::jsonb),
    'nodes', coalesce((
      SELECT jsonb_agg(to_jsonb(n) ORDER BY n.kind, n.occurred_on NULLS LAST, n.created_at)
      FROM public.property_intel_nodes n WHERE n.profile_id = v_profile.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_property_intelligence(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_property_intelligence(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.get_property_intelligence(uuid, boolean) IS
  'Returns {profile, layers, nodes} for a site in one round trip. p_create=true lazily creates the profile. RLS applies (SECURITY INVOKER).';
