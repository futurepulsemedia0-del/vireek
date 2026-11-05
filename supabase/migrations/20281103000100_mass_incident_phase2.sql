/*
  # Mass Incident Mode — phase 2

  Adds (all additive; nothing from phase 1 is dropped):
  1. mass_incident_contacts.address_text      street address kept ONLY until it is geocoded, then cleared (data minimisation).
  2. mass_incident_contacts.geocode_attempts  bounded retries (max 3) for the background geocoder (1 request/second).
  3. mass_incident_contacts.job_id            the job a caller booked, so the owner can see truck rolls booked during an incident.
  4. mass_incident_settings.auto_reply_sms    owner opt-in (default OFF) for ONE hedged SMS reply per caller per incident.
  5. mass_incident_set_geo / mass_incident_link_job / mass_incident_set_auto_reply RPCs.
  6. mass_incident_commit re-created (same signature) so it also stores address_text.

  Rollback: set auto_reply_sms = false; the new columns are nullable / defaulted and ignored by phase-1 code.
*/

ALTER TABLE public.mass_incident_contacts
  ADD COLUMN IF NOT EXISTS address_text text CHECK (address_text IS NULL OR char_length(address_text) <= 300),
  ADD COLUMN IF NOT EXISTS geocode_attempts smallint NOT NULL DEFAULT 0 CHECK (geocode_attempts BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL;

ALTER TABLE public.mass_incident_settings
  ADD COLUMN IF NOT EXISTS auto_reply_sms boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mic_geocode_queue
  ON public.mass_incident_contacts (contact_at DESC)
  WHERE address_text IS NOT NULL AND geo_precision <> 'address' AND geocode_attempts < 3;
CREATE INDEX IF NOT EXISTS idx_mic_job ON public.mass_incident_contacts (job_id) WHERE job_id IS NOT NULL;

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
    geo_precision, symptom_class, symptom_text, is_emergency, hazards, embedding, triage_decision, address_text
  ) VALUES (
    p_user_id, v_c ->> 'source', v_c ->> 'source_ref',
    NULLIF(v_c ->> 'call_id', '')::uuid, NULLIF(v_c ->> 'customer_id', '')::uuid, left(v_c ->> 'contact_phone', 32),
    (v_c ->> 'contact_at')::timestamptz, left(v_c ->> 'postal_code', 10),
    (v_c ->> 'lat')::double precision, (v_c ->> 'lng')::double precision,
    COALESCE(v_c ->> 'geo_precision', 'none'), COALESCE(v_c ->> 'symptom_class', 'other'),
    left(COALESCE(v_c ->> 'symptom_text', ''), 600),
    COALESCE((v_c ->> 'is_emergency')::boolean, false),
    CASE WHEN jsonb_typeof(v_c -> 'hazards') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v_c -> 'hazards')) ELSE '{}'::text[] END,
    v_emb, v_c ->> 'triage_decision', left(NULLIF(v_c ->> 'address_text', ''), 300)
  )
  ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
    postal_code = COALESCE(public.mass_incident_contacts.postal_code, EXCLUDED.postal_code),
    lat = COALESCE(public.mass_incident_contacts.lat, EXCLUDED.lat),
    lng = COALESCE(public.mass_incident_contacts.lng, EXCLUDED.lng),
    geo_precision = CASE WHEN public.mass_incident_contacts.lat IS NULL AND EXCLUDED.lat IS NOT NULL THEN EXCLUDED.geo_precision
                         ELSE public.mass_incident_contacts.geo_precision END,
    triage_decision = COALESCE(EXCLUDED.triage_decision, public.mass_incident_contacts.triage_decision),
    address_text = COALESCE(public.mass_incident_contacts.address_text, EXCLUDED.address_text)
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

-- Background geocoder result (service role). Clears the street address once it has been used.
CREATE OR REPLACE FUNCTION public.mass_incident_set_geo(p_user_id uuid, p_contact_id uuid, p_lat double precision, p_lng double precision)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'invalid coordinates';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 4110));
  UPDATE public.mass_incident_contacts
     SET lat = p_lat, lng = p_lng, geo_precision = 'address', address_text = NULL
   WHERE id = p_contact_id AND user_id = p_user_id;
  UPDATE public.mass_incident_settings SET cluster_version = cluster_version + 1 WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mass_incident_link_job(p_user_id uuid, p_source text, p_source_ref text, p_job_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.mass_incident_contacts c SET job_id = p_job_id
   WHERE c.user_id = p_user_id AND c.source = p_source AND c.source_ref = p_source_ref
     AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.user_id = p_user_id);
$$;

REVOKE ALL ON FUNCTION public.mass_incident_set_geo(uuid, uuid, double precision, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mass_incident_link_job(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mass_incident_set_geo(uuid, uuid, double precision, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.mass_incident_link_job(uuid, text, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mass_incident_set_auto_reply(p_enabled boolean)
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
  INSERT INTO public.mass_incident_settings (user_id, auto_reply_sms) VALUES (v_owner, p_enabled)
  ON CONFLICT (user_id) DO UPDATE SET auto_reply_sms = EXCLUDED.auto_reply_sms, updated_at = now();
  INSERT INTO public.mass_incident_events (user_id, kind, actor, detail)
  VALUES (v_owner, 'auto_reply_changed', auth.uid(), jsonb_build_object('enabled', p_enabled));
END;
$$;

REVOKE ALL ON FUNCTION public.mass_incident_set_auto_reply(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mass_incident_set_auto_reply(boolean) TO authenticated;
