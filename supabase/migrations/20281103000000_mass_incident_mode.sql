/*
  # Mass Incident Mode

  ## Why
  During storms, outages and main breaks every inbound contact is handled in isolation: each caller
  hears a different story and the business rolls trucks to homes that have no fault of their own.
  This groups contacts into one Incident, so callers get consistent and HONEST information.

  ## What this adds
  1. mass_incident_settings   per-account opt-in (default OFF), thresholds, optimistic-lock version.
  2. mass_incidents           the Incident: confidence, scope, suspected cause + uncertainty, status.
  3. mass_incident_contacts   every contact (call / sms / lead), attached or not. NEVER deleted by
                              clustering: a contact that fits no incident simply has incident_id NULL.
  4. mass_incident_signals    external evidence (NWS alerts, notices the owner verified from an official page).
  5. mass_incident_directory  region-keyed utility / municipal contacts. Only VERIFIED, NON-STALE rows are
                              ever spoken to a caller. Platform rows are service-role only.
  6. mass_incident_events     append-only audit trail.
  7. mass_incident_postal_cache  postal-code centroid cache (service role only).

  ## Concurrency
  Clustering is computed in application code (pure, unit-tested) and COMMITTED here under a per-account
  advisory lock plus an optimistic `cluster_version` check, so two simultaneous contacts can never create
  two duplicate incidents. A stale plan returns {status:'conflict'} and the caller recomputes.

  ## Security
  - Every table has RLS. The dashboard gets SELECT only; every write goes through SECURITY DEFINER RPCs
    that check `can_manage_mass_incidents()` and derive the tenant from get_account_owner_id().
  - The commit / apply RPCs are service_role only (edge functions).
  - Rows are keyed by the account OWNER id, so team members see the owner's incidents, never another account's.

  ## Rollback
  Purely additive. To disable: set mass_incident_settings.enabled = false (runtime then does nothing).
  To remove: drop the objects created here in reverse order (this file deliberately contains no DROP).
*/

-- =============================================================
-- 0. Permission helpers (same shape as can_view_live_calls)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_view_mass_incidents()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_manage_numbers', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_manage_numbers', 'false') = 'true'
          OR COALESCE(tm.permissions ->> 'can_view_all_jobs', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_all_jobs', 'false') = 'true'
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_mass_incidents()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_manage_numbers', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_manage_numbers', 'false') = 'true'
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_mass_incidents() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_mass_incidents() TO authenticated;

-- =============================================================
-- 1. Settings (opt-in, default OFF)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mass_incident_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  window_minutes integer NOT NULL DEFAULT 120 CHECK (window_minutes BETWEEN 15 AND 720),
  radius_miles numeric(5, 2) NOT NULL DEFAULT 3 CHECK (radius_miles BETWEEN 0.5 AND 25),
  min_contacts integer NOT NULL DEFAULT 3 CHECK (min_contacts BETWEEN 2 AND 20),
  notify_owner boolean NOT NULL DEFAULT true,
  cluster_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- 2. Incidents
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mass_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching', 'active', 'monitoring', 'resolved', 'dismissed')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  symptom_class text NOT NULL DEFAULT 'other' CHECK (symptom_class IN (
    'no_water', 'low_water_pressure', 'discolored_water', 'no_power', 'partial_power', 'no_heat', 'no_cooling',
    'gas_odor', 'flooding', 'sewer_backup', 'storm_damage', 'frozen_pipes', 'other')),
  scope jsonb NOT NULL DEFAULT '{"kind":"postal","postalCodes":[],"center":null,"radiusMiles":null,"polygon":null}'::jsonb,
  confidence numeric(4, 3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  confidence_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  suspected_cause text NOT NULL DEFAULT 'unknown' CHECK (suspected_cause IN (
    'water_supply_issue', 'power_grid_outage', 'gas_utility_issue', 'severe_weather', 'sewer_main_issue', 'extreme_temperature', 'unknown')),
  cause_status text NOT NULL DEFAULT 'suspected' CHECK (cause_status IN ('suspected', 'corroborated', 'owner_confirmed')),
  cause_confidence numeric(4, 3) NOT NULL DEFAULT 0 CHECK (cause_confidence BETWEEN 0 AND 1),
  cause_uncertainty text NOT NULL DEFAULT '' CHECK (char_length(cause_uncertainty) <= 600),
  cause_basis text[] NOT NULL DEFAULT '{}',
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  corroborated_by uuid[] NOT NULL DEFAULT '{}',
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  emergency_count integer NOT NULL DEFAULT 0 CHECK (emergency_count >= 0),
  first_contact_at timestamptz NOT NULL DEFAULT now(),
  last_contact_at timestamptz NOT NULL DEFAULT now(),
  owner_confirmed_cause text CHECK (owner_confirmed_cause IS NULL OR owner_confirmed_cause IN (
    'water_supply_issue', 'power_grid_outage', 'gas_utility_issue', 'severe_weather', 'sewer_main_issue', 'extreme_temperature', 'unknown')),
  owner_confirmed_at timestamptz,
  owner_confirmed_by uuid,
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mass_incidents_user_status_last
  ON public.mass_incidents (user_id, status, last_contact_at DESC);

-- =============================================================
-- 3. Contacts (every contact stays visible)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mass_incident_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES public.mass_incidents(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('call', 'sms', 'lead', 'manual')),
  source_ref text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  contact_phone text CHECK (contact_phone IS NULL OR char_length(contact_phone) <= 32),
  contact_at timestamptz NOT NULL,
  postal_code text CHECK (postal_code IS NULL OR char_length(postal_code) <= 10),
  lat double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  geo_precision text NOT NULL DEFAULT 'none' CHECK (geo_precision IN ('address', 'postal', 'none')),
  symptom_class text NOT NULL DEFAULT 'other' CHECK (symptom_class IN (
    'no_water', 'low_water_pressure', 'discolored_water', 'no_power', 'partial_power', 'no_heat', 'no_cooling',
    'gas_odor', 'flooding', 'sewer_backup', 'storm_damage', 'frozen_pipes', 'other')),
  symptom_text text NOT NULL DEFAULT '' CHECK (char_length(symptom_text) <= 600),
  is_emergency boolean NOT NULL DEFAULT false,
  hazards text[] NOT NULL DEFAULT '{}',
  embedding real[],
  triage_decision text CHECK (triage_decision IS NULL OR triage_decision IN ('escalate_emergency', 'upstream_likely', 'book_normally')),
  detached boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mass_incident_contacts_unique_ref UNIQUE (user_id, source, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_mic_user_time ON public.mass_incident_contacts (user_id, contact_at DESC);
CREATE INDEX IF NOT EXISTS idx_mic_incident ON public.mass_incident_contacts (incident_id) WHERE incident_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mic_pool ON public.mass_incident_contacts (user_id, contact_at DESC) WHERE incident_id IS NULL AND NOT detached;

-- =============================================================
-- 4. External signals
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mass_incident_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('weather_alert', 'utility_outage', 'municipal_notice', 'manual')),
  source text NOT NULL CHECK (source IN ('nws', 'owner_entered')),
  external_id text CHECK (external_id IS NULL OR char_length(external_id) <= 200),
  headline text NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 300),
  area_desc text CHECK (area_desc IS NULL OR char_length(area_desc) <= 500),
  postal_codes text[] NOT NULL DEFAULT '{}',
  lat double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  radius_miles numeric(6, 2) CHECK (radius_miles IS NULL OR radius_miles BETWEEN 0.1 AND 200),
  corroborates text[] NOT NULL DEFAULT '{}',
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https://'),
  verified boolean NOT NULL DEFAULT false,
  effective_at timestamptz,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- "verified" evidence needs a provenance: the NWS feed, or an https page the owner attests is official.
  CONSTRAINT mass_incident_signals_verified_needs_source CHECK (NOT verified OR source = 'nws' OR source_url IS NOT NULL)
);

-- Plain (non-partial) unique index so PostgREST upserts can target it; NULL external_ids never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mass_incident_signals_external
  ON public.mass_incident_signals (user_id, source, external_id);
CREATE INDEX IF NOT EXISTS idx_mass_incident_signals_active
  ON public.mass_incident_signals (user_id, expires_at);

-- =============================================================
-- 5. Directory (region-keyed, verified only)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mass_incident_directory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE, -- NULL = platform-maintained
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  region text CHECK (region IS NULL OR region ~ '^[A-Z0-9]{1,3}$'),
  postal_prefix text CHECK (postal_prefix IS NULL OR postal_prefix ~ '^[A-Z0-9]{1,5}$'),
  service text NOT NULL CHECK (service IN ('water', 'power', 'gas', 'sewer', 'municipal_info')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  website text CHECK (website IS NULL OR website ~* '^https://'),
  source_url text NOT NULL CHECK (source_url ~* '^https://'),
  verified_at timestamptz NOT NULL,
  verified_by text NOT NULL CHECK (char_length(verified_by) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'verified' CHECK (status IN ('verified', 'stale', 'retired')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mass_incident_directory_has_channel CHECK (phone IS NOT NULL OR website IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_mass_incident_directory_lookup
  ON public.mass_incident_directory (country, service, status);

-- =============================================================
-- 6. Events (append-only audit) + 7. postal cache
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mass_incident_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES public.mass_incidents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 60),
  actor uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mass_incident_events_incident ON public.mass_incident_events (incident_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_mass_incident_events_user ON public.mass_incident_events (user_id, id DESC);

CREATE TABLE IF NOT EXISTS public.mass_incident_postal_cache (
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  postal_code text NOT NULL CHECK (char_length(postal_code) <= 10),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country, postal_code)
);

-- =============================================================
-- 8. Row Level Security (dashboard = SELECT only)
-- =============================================================

ALTER TABLE public.mass_incident_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_incident_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_incident_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_incident_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mass_incident_postal_cache ENABLE ROW LEVEL SECURITY; -- no policies: service role only

DROP POLICY IF EXISTS "mass_incident_settings_select" ON public.mass_incident_settings;
CREATE POLICY "mass_incident_settings_select" ON public.mass_incident_settings
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.can_view_mass_incidents());

DROP POLICY IF EXISTS "mass_incidents_select" ON public.mass_incidents;
CREATE POLICY "mass_incidents_select" ON public.mass_incidents
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.can_view_mass_incidents());

DROP POLICY IF EXISTS "mass_incident_contacts_select" ON public.mass_incident_contacts;
CREATE POLICY "mass_incident_contacts_select" ON public.mass_incident_contacts
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.can_view_mass_incidents());

DROP POLICY IF EXISTS "mass_incident_signals_select" ON public.mass_incident_signals;
CREATE POLICY "mass_incident_signals_select" ON public.mass_incident_signals
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.can_view_mass_incidents());

DROP POLICY IF EXISTS "mass_incident_directory_select" ON public.mass_incident_directory;
CREATE POLICY "mass_incident_directory_select" ON public.mass_incident_directory
  FOR SELECT TO authenticated
  USING (
    public.can_view_mass_incidents()
    AND (user_id IS NULL OR user_id = (SELECT public.get_account_owner_id()))
  );

DROP POLICY IF EXISTS "mass_incident_events_select" ON public.mass_incident_events;
CREATE POLICY "mass_incident_events_select" ON public.mass_incident_events
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.can_view_mass_incidents());

REVOKE ALL ON public.mass_incident_settings, public.mass_incidents, public.mass_incident_contacts,
  public.mass_incident_signals, public.mass_incident_directory, public.mass_incident_events,
  public.mass_incident_postal_cache FROM anon, authenticated;
GRANT SELECT ON public.mass_incident_settings, public.mass_incidents, public.mass_incident_contacts,
  public.mass_incident_signals, public.mass_incident_directory, public.mass_incident_events TO authenticated;

-- =============================================================
-- 9. Internal helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.mass_incident_recount(p_incident_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.mass_incidents i
     SET member_count = s.n,
         emergency_count = s.e,
         first_contact_at = COALESCE(s.first_at, i.first_contact_at),
         last_contact_at = COALESCE(s.last_at, i.last_contact_at),
         updated_at = now()
    FROM (
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE c.is_emergency OR cardinality(c.hazards) > 0)::int AS e,
             min(c.contact_at) AS first_at,
             max(c.contact_at) AS last_at
        FROM public.mass_incident_contacts c
       WHERE c.incident_id = p_incident_id
    ) s
   WHERE i.id = p_incident_id;
$$;

REVOKE ALL ON FUNCTION public.mass_incident_recount(uuid) FROM PUBLIC, anon, authenticated;

-- Applies a whitelisted, TS-computed field set to an incident. Never revives resolved / dismissed incidents
-- and never overrides an owner-confirmed cause.
CREATE OR REPLACE FUNCTION public.mass_incident_apply_fields(p_user_id uuid, p_incident_id uuid, p_fields jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inc public.mass_incidents%ROWTYPE;
BEGIN
  SELECT * INTO v_inc FROM public.mass_incidents WHERE id = p_incident_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.mass_incidents SET
    title = COALESCE(NULLIF(left(p_fields ->> 'title', 200), ''), title),
    status = CASE
      WHEN v_inc.status IN ('resolved', 'dismissed') THEN v_inc.status
      ELSE COALESCE(p_fields ->> 'status', v_inc.status)
    END,
    symptom_class = COALESCE(p_fields ->> 'symptom_class', symptom_class),
    scope = COALESCE(p_fields -> 'scope', scope),
    confidence = COALESCE((p_fields ->> 'confidence')::numeric, confidence),
    confidence_breakdown = COALESCE(p_fields -> 'confidence_breakdown', confidence_breakdown),
    suspected_cause = CASE WHEN v_inc.owner_confirmed_cause IS NOT NULL THEN v_inc.suspected_cause
                           ELSE COALESCE(p_fields ->> 'suspected_cause', v_inc.suspected_cause) END,
    cause_status = CASE WHEN v_inc.owner_confirmed_cause IS NOT NULL THEN v_inc.cause_status
                        ELSE COALESCE(p_fields ->> 'cause_status', v_inc.cause_status) END,
    cause_confidence = CASE WHEN v_inc.owner_confirmed_cause IS NOT NULL THEN v_inc.cause_confidence
                            ELSE COALESCE((p_fields ->> 'cause_confidence')::numeric, v_inc.cause_confidence) END,
    cause_uncertainty = COALESCE(left(p_fields ->> 'cause_uncertainty', 600), cause_uncertainty),
    cause_basis = CASE WHEN jsonb_typeof(p_fields -> 'cause_basis') = 'array'
                       THEN ARRAY(SELECT jsonb_array_elements_text(p_fields -> 'cause_basis')) ELSE cause_basis END,
    alternatives = COALESCE(p_fields -> 'alternatives', alternatives),
    corroborated_by = CASE WHEN jsonb_typeof(p_fields -> 'corroborated_by') = 'array'
                           THEN ARRAY(SELECT (jsonb_array_elements_text(p_fields -> 'corroborated_by'))::uuid) ELSE corroborated_by END,
    updated_at = now()
  WHERE id = p_incident_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mass_incident_apply_fields(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 10. Commit one clustering plan (service role only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.mass_incident_commit(p_user_id uuid, p_expected_version bigint, p_plan jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_set public.mass_incident_settings%ROWTYPE;
  v_c jsonb := p_plan -> 'contact';
  v_action text := COALESCE(p_plan ->> 'action', 'none');
  v_contact_id uuid;
  v_contact_incident uuid;
  v_detached boolean;
  v_incident_id uuid;
  v_created boolean := false;
  v_emb real[];
BEGIN
  IF v_c IS NULL OR jsonb_typeof(v_c) <> 'object' THEN
    RAISE EXCEPTION 'invalid plan: contact missing';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 4110));

  SELECT * INTO v_set FROM public.mass_incident_settings WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT v_set.enabled THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;
  IF v_set.cluster_version <> p_expected_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'version', v_set.cluster_version);
  END IF;

  IF jsonb_typeof(v_c -> 'embedding') = 'array' AND jsonb_array_length(v_c -> 'embedding') BETWEEN 1 AND 2048 THEN
    v_emb := ARRAY(SELECT (jsonb_array_elements_text(v_c -> 'embedding'))::real);
  END IF;

  -- Idempotent on (user, source, source_ref). Owner decisions (detached) and existing attachment are preserved.
  INSERT INTO public.mass_incident_contacts (
    user_id, source, source_ref, call_id, customer_id, contact_phone, contact_at, postal_code, lat, lng,
    geo_precision, symptom_class, symptom_text, is_emergency, hazards, embedding, triage_decision
  ) VALUES (
    p_user_id, v_c ->> 'source', v_c ->> 'source_ref',
    NULLIF(v_c ->> 'call_id', '')::uuid, NULLIF(v_c ->> 'customer_id', '')::uuid, left(v_c ->> 'contact_phone', 32),
    (v_c ->> 'contact_at')::timestamptz, left(v_c ->> 'postal_code', 10),
    (v_c ->> 'lat')::double precision, (v_c ->> 'lng')::double precision,
    COALESCE(v_c ->> 'geo_precision', 'none'), COALESCE(v_c ->> 'symptom_class', 'other'),
    left(COALESCE(v_c ->> 'symptom_text', ''), 600),
    COALESCE((v_c ->> 'is_emergency')::boolean, false),
    CASE WHEN jsonb_typeof(v_c -> 'hazards') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v_c -> 'hazards')) ELSE '{}'::text[] END,
    v_emb, v_c ->> 'triage_decision'
  )
  ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
    postal_code = COALESCE(public.mass_incident_contacts.postal_code, EXCLUDED.postal_code),
    lat = COALESCE(public.mass_incident_contacts.lat, EXCLUDED.lat),
    lng = COALESCE(public.mass_incident_contacts.lng, EXCLUDED.lng),
    geo_precision = CASE WHEN public.mass_incident_contacts.lat IS NULL AND EXCLUDED.lat IS NOT NULL THEN EXCLUDED.geo_precision
                         ELSE public.mass_incident_contacts.geo_precision END,
    triage_decision = COALESCE(EXCLUDED.triage_decision, public.mass_incident_contacts.triage_decision)
  RETURNING id, incident_id, detached INTO v_contact_id, v_contact_incident, v_detached;

  v_incident_id := v_contact_incident;

  IF NOT v_detached AND v_contact_incident IS NULL THEN
    IF v_action = 'attach' THEN
      SELECT id INTO v_incident_id FROM public.mass_incidents
       WHERE id = NULLIF(p_plan ->> 'incident_id', '')::uuid AND user_id = p_user_id AND status NOT IN ('resolved', 'dismissed');
      IF v_incident_id IS NOT NULL THEN
        UPDATE public.mass_incident_contacts SET incident_id = v_incident_id WHERE id = v_contact_id;
      END IF;
    ELSIF v_action = 'create' THEN
      INSERT INTO public.mass_incidents (user_id, status, title, symptom_class, scope, suspected_cause)
      VALUES (
        p_user_id, 'watching',
        COALESCE(NULLIF(left(p_plan -> 'incident' ->> 'title', 200), ''), 'Cluster of similar requests'),
        COALESCE(p_plan -> 'incident' ->> 'symptom_class', 'other'),
        COALESCE(p_plan -> 'incident' -> 'scope', '{"kind":"postal","postalCodes":[],"center":null,"radiusMiles":null,"polygon":null}'::jsonb),
        COALESCE(p_plan -> 'incident' ->> 'suspected_cause', 'unknown')
      ) RETURNING id INTO v_incident_id;
      v_created := true;

      UPDATE public.mass_incident_contacts
         SET incident_id = v_incident_id
       WHERE user_id = p_user_id AND NOT detached AND incident_id IS NULL AND NOT is_emergency AND cardinality(hazards) = 0
         AND (id = v_contact_id
              OR id = ANY (CASE WHEN jsonb_typeof(p_plan -> 'candidate_ids') = 'array'
                                THEN ARRAY(SELECT (jsonb_array_elements_text(p_plan -> 'candidate_ids'))::uuid) ELSE '{}'::uuid[] END));
    END IF;
  END IF;

  IF v_incident_id IS NOT NULL THEN
    PERFORM public.mass_incident_recount(v_incident_id);
    IF jsonb_typeof(p_plan -> 'incident') = 'object' THEN
      PERFORM public.mass_incident_apply_fields(p_user_id, v_incident_id, p_plan -> 'incident');
    END IF;
    INSERT INTO public.mass_incident_events (user_id, incident_id, kind, detail)
    VALUES (p_user_id, v_incident_id, CASE WHEN v_created THEN 'incident_created' ELSE 'contact_attached' END,
            jsonb_build_object('contact_id', v_contact_id, 'source', v_c ->> 'source'));
  END IF;

  UPDATE public.mass_incident_settings SET cluster_version = cluster_version + 1, updated_at = now() WHERE user_id = p_user_id;

  RETURN jsonb_build_object('status', 'ok', 'contact_id', v_contact_id, 'incident_id', v_incident_id,
                            'created', v_created, 'version', v_set.cluster_version + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.mass_incident_commit(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mass_incident_commit(uuid, bigint, jsonb) TO service_role;

-- Sweep / recompute update (service role): TS-computed fields + lifecycle, under the same lock.
CREATE OR REPLACE FUNCTION public.mass_incident_apply_update(p_user_id uuid, p_incident_id uuid, p_fields jsonb, p_event text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 4110));
  PERFORM public.mass_incident_recount(p_incident_id);
  PERFORM public.mass_incident_apply_fields(p_user_id, p_incident_id, p_fields);
  IF COALESCE(p_fields ->> 'status', '') = 'resolved' THEN
    UPDATE public.mass_incidents SET resolved_at = COALESCE(resolved_at, now())
     WHERE id = p_incident_id AND user_id = p_user_id AND status = 'resolved';
  END IF;
  INSERT INTO public.mass_incident_events (user_id, incident_id, kind, detail)
  VALUES (p_user_id, p_incident_id, left(COALESCE(p_event, 'incident_updated'), 60), COALESCE(p_fields, '{}'::jsonb));
  UPDATE public.mass_incident_settings SET cluster_version = cluster_version + 1 WHERE user_id = p_user_id;
  RETURN jsonb_build_object('status', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.mass_incident_apply_update(uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mass_incident_apply_update(uuid, uuid, jsonb, text) TO service_role;

-- =============================================================
-- 11. Dashboard RPCs (permission-checked, tenant derived from the session)
-- =============================================================

CREATE OR REPLACE FUNCTION public.mass_incident_save_settings(
  p_enabled boolean, p_window_minutes integer, p_radius_miles numeric, p_min_contacts integer, p_notify_owner boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.mass_incident_settings (user_id, enabled, window_minutes, radius_miles, min_contacts, notify_owner)
  VALUES (v_owner, p_enabled, p_window_minutes, p_radius_miles, p_min_contacts, p_notify_owner)
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled, window_minutes = EXCLUDED.window_minutes, radius_miles = EXCLUDED.radius_miles,
    min_contacts = EXCLUDED.min_contacts, notify_owner = EXCLUDED.notify_owner, updated_at = now();
  INSERT INTO public.mass_incident_events (user_id, kind, actor, detail)
  VALUES (v_owner, 'settings_changed', auth.uid(), jsonb_build_object('enabled', p_enabled));
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_set_status(p_incident_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('active', 'monitoring', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text, 4110));
  UPDATE public.mass_incidents
     SET status = p_status,
         resolved_at = CASE WHEN p_status IN ('resolved', 'dismissed') THEN now() ELSE NULL END,
         resolution_note = CASE WHEN p_status IN ('resolved', 'dismissed') THEN left(p_note, 1000) ELSE NULL END,
         updated_at = now()
   WHERE id = p_incident_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.mass_incident_events (user_id, incident_id, kind, actor, detail)
  VALUES (v_owner, p_incident_id, 'status_' || p_status, auth.uid(), jsonb_build_object('note', left(p_note, 1000)));
  UPDATE public.mass_incident_settings SET cluster_version = cluster_version + 1 WHERE user_id = v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_confirm_cause(p_incident_id uuid, p_cause text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_cause NOT IN ('water_supply_issue', 'power_grid_outage', 'gas_utility_issue', 'severe_weather', 'sewer_main_issue', 'extreme_temperature', 'unknown') THEN
    RAISE EXCEPTION 'invalid cause';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text, 4110));
  UPDATE public.mass_incidents
     SET owner_confirmed_cause = p_cause, owner_confirmed_at = now(), owner_confirmed_by = auth.uid(),
         suspected_cause = p_cause, cause_status = 'owner_confirmed', cause_confidence = 0.95,
         cause_uncertainty = 'Confirmed by the business owner.', updated_at = now()
   WHERE id = p_incident_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.mass_incident_events (user_id, incident_id, kind, actor, detail)
  VALUES (v_owner, p_incident_id, 'cause_confirmed', auth.uid(), jsonb_build_object('cause', p_cause));
  UPDATE public.mass_incident_settings SET cluster_version = cluster_version + 1 WHERE user_id = v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_detach_contact(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_inc uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text, 4110));
  SELECT incident_id INTO v_inc FROM public.mass_incident_contacts WHERE id = p_contact_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.mass_incident_contacts SET incident_id = NULL, detached = true WHERE id = p_contact_id;
  IF v_inc IS NOT NULL THEN
    PERFORM public.mass_incident_recount(v_inc);
    INSERT INTO public.mass_incident_events (user_id, incident_id, kind, actor, detail)
    VALUES (v_owner, v_inc, 'contact_detached', auth.uid(), jsonb_build_object('contact_id', p_contact_id));
  END IF;
  UPDATE public.mass_incident_settings SET cluster_version = cluster_version + 1 WHERE user_id = v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_add_notice(
  p_kind text, p_headline text, p_area_desc text, p_postal_codes text[], p_source_url text,
  p_corroborates text[], p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('utility_outage', 'municipal_notice', 'manual') THEN
    RAISE EXCEPTION 'invalid kind';
  END IF;
  IF p_source_url IS NULL OR p_source_url !~* '^https://' THEN
    RAISE EXCEPTION 'an https source URL of the official notice is required';
  END IF;
  INSERT INTO public.mass_incident_signals (
    user_id, kind, source, headline, area_desc, postal_codes, source_url, corroborates, verified, effective_at, expires_at, created_by
  ) VALUES (
    v_owner, p_kind, 'owner_entered', left(p_headline, 300), left(p_area_desc, 500), COALESCE(p_postal_codes, '{}'),
    p_source_url, COALESCE(p_corroborates, '{}'), true, now(), COALESCE(p_expires_at, now() + interval '24 hours'), auth.uid()
  ) RETURNING id INTO v_id;
  INSERT INTO public.mass_incident_events (user_id, kind, actor, detail)
  VALUES (v_owner, 'notice_added', auth.uid(), jsonb_build_object('signal_id', v_id, 'source_url', p_source_url));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_directory_upsert(
  p_id uuid, p_country text, p_region text, p_postal_prefix text, p_service text, p_name text,
  p_phone text, p_website text, p_source_url text, p_verified_at timestamptz, p_verified_by text, p_notes text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_verified_at > now() + interval '1 day' THEN
    RAISE EXCEPTION 'verified_at cannot be in the future';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.mass_incident_directory (user_id, country, region, postal_prefix, service, name, phone, website, source_url, verified_at, verified_by, notes)
    VALUES (v_owner, upper(p_country), NULLIF(upper(p_region), ''), NULLIF(upper(p_postal_prefix), ''), p_service, p_name,
            NULLIF(p_phone, ''), NULLIF(p_website, ''), p_source_url, p_verified_at, p_verified_by, NULLIF(p_notes, ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.mass_incident_directory SET
      country = upper(p_country), region = NULLIF(upper(p_region), ''), postal_prefix = NULLIF(upper(p_postal_prefix), ''),
      service = p_service, name = p_name, phone = NULLIF(p_phone, ''), website = NULLIF(p_website, ''),
      source_url = p_source_url, verified_at = p_verified_at, verified_by = p_verified_by, notes = NULLIF(p_notes, ''),
      status = 'verified', updated_at = now()
     WHERE id = p_id AND user_id = v_owner
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'directory entry not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_directory_retire(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_manage_mass_incidents() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.mass_incident_directory SET status = 'retired', updated_at = now() WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'directory entry not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION
  public.mass_incident_save_settings(boolean, integer, numeric, integer, boolean),
  public.mass_incident_set_status(uuid, text, text),
  public.mass_incident_confirm_cause(uuid, text),
  public.mass_incident_detach_contact(uuid),
  public.mass_incident_add_notice(text, text, text, text[], text, text[], timestamptz),
  public.mass_incident_directory_upsert(uuid, text, text, text, text, text, text, text, text, timestamptz, text, text),
  public.mass_incident_directory_retire(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.mass_incident_save_settings(boolean, integer, numeric, integer, boolean),
  public.mass_incident_set_status(uuid, text, text),
  public.mass_incident_confirm_cause(uuid, text),
  public.mass_incident_detach_contact(uuid),
  public.mass_incident_add_notice(text, text, text, text[], text, text[], timestamptz),
  public.mass_incident_directory_upsert(uuid, text, text, text, text, text, text, text, text, timestamptz, text, text),
  public.mass_incident_directory_retire(uuid)
TO authenticated;

-- =============================================================
-- 12. Realtime
-- =============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.mass_incidents;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.mass_incident_contacts;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
