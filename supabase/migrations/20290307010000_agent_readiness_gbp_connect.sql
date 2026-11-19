/*
  # Agent Readiness — Google Business Profile connect (state, save, location choice)

  Additive + idempotent. Depends on 20290307000000_agent_readiness_gbp.sql, integrations
  (UNIQUE (user_id, integration_type)), get_account_owner_id(), can_manage_service_areas().

  1. gbp_connect_save(p_user, p_expires_at, p_candidates)  service role (OAuth callback): upsert the integration row.
  2. gbp_connection_state()                                authenticated: what the UI needs, no secrets.
  3. gbp_select_location(p_location)                       authenticated: pick one of the stored candidates.

  Tokens are NEVER stored here (they go to the credential vault). config holds: expires_at, location_name,
  account_name, location_title, candidates[{location, account, title}] (business names the connecting Google
  user can already see). A client can only choose a location that is already in `candidates`.
*/

CREATE OR REPLACE FUNCTION public.gbp_connect_save(p_user uuid, p_expires_at timestamptz, p_candidates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean jsonb;
  v_old jsonb;
  v_keep jsonb;
  v_pick jsonb;
  v_cfg jsonb;
BEGIN
  IF p_candidates IS NULL OR jsonb_typeof(p_candidates) <> 'array' THEN RAISE EXCEPTION 'bad_request'; END IF;

  -- Keep only well-formed entries, at most 50, titles cut to 120 characters.
  SELECT coalesce(jsonb_agg(jsonb_build_object('location', c ->> 'location', 'account', c ->> 'account',
                                               'title', left(coalesce(nullif(btrim(c ->> 'title'), ''), c ->> 'location'), 120))), '[]'::jsonb)
  INTO v_clean
  FROM (SELECT c FROM jsonb_array_elements(p_candidates) AS c
        WHERE jsonb_typeof(c) = 'object'
          AND c ->> 'location' ~ '^locations/[0-9]{1,24}$'
          AND c ->> 'account' ~ '^accounts/[0-9]{1,24}$'
        LIMIT 50) s;

  SELECT config INTO v_old FROM integrations WHERE user_id = p_user AND integration_type = 'google_business_profile';

  -- Reconnecting keeps the previous choice when that location is still readable.
  SELECT c INTO v_keep FROM jsonb_array_elements(v_clean) AS c WHERE c ->> 'location' = v_old ->> 'location_name' LIMIT 1;
  IF v_keep IS NOT NULL THEN
    v_pick := v_keep;
  ELSIF jsonb_array_length(v_clean) = 1 THEN
    v_pick := v_clean -> 0;
  END IF;

  v_cfg := jsonb_build_object(
    'expires_at', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'candidates', v_clean);
  IF v_pick IS NOT NULL THEN
    v_cfg := v_cfg || jsonb_build_object('location_name', v_pick ->> 'location', 'account_name', v_pick ->> 'account', 'location_title', v_pick ->> 'title');
  END IF;

  INSERT INTO integrations (user_id, integration_type, status, config)
  VALUES (p_user, 'google_business_profile', 'connected', v_cfg)
  ON CONFLICT (user_id, integration_type) DO UPDATE SET status = 'connected', config = EXCLUDED.config;

  DELETE FROM agent_readiness_gbp_cache WHERE user_id = p_user;
  RETURN jsonb_build_object('ok', true, 'count', jsonb_array_length(v_clean), 'selected', v_pick IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.gbp_connect_save(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gbp_connect_save(uuid, timestamptz, jsonb) TO service_role;

-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gbp_connection_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
  v_cfg jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT status, config INTO v_status, v_cfg
  FROM integrations WHERE user_id = v_owner AND integration_type = 'google_business_profile'
  ORDER BY created_at DESC LIMIT 1;

  IF v_status IS DISTINCT FROM 'connected' THEN
    RETURN jsonb_build_object('state', 'not_connected', 'candidates', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'state', CASE WHEN v_cfg ->> 'location_name' ~ '^locations/[0-9]{1,24}$' THEN 'connected' ELSE 'needs_choice' END,
    'location_name', v_cfg ->> 'location_name',
    'location_title', v_cfg ->> 'location_title',
    'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object('location', c ->> 'location', 'title', c ->> 'title'))
                            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_cfg -> 'candidates') = 'array' THEN v_cfg -> 'candidates' ELSE '[]'::jsonb END) AS c), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.gbp_connection_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gbp_connection_state() TO authenticated;

-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gbp_select_location(p_location text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_cfg jsonb;
  v_pick jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.can_manage_service_areas() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_location IS NULL OR p_location !~ '^locations/[0-9]{1,24}$' THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT config INTO v_cfg FROM integrations
  WHERE user_id = v_owner AND integration_type = 'google_business_profile' AND status = 'connected'
  FOR UPDATE;
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg -> 'candidates') <> 'array' THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT c INTO v_pick FROM jsonb_array_elements(v_cfg -> 'candidates') AS c WHERE c ->> 'location' = p_location LIMIT 1;
  IF v_pick IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;

  UPDATE integrations
  SET config = v_cfg || jsonb_build_object('location_name', v_pick ->> 'location', 'account_name', v_pick ->> 'account', 'location_title', v_pick ->> 'title')
  WHERE user_id = v_owner AND integration_type = 'google_business_profile';

  DELETE FROM agent_readiness_gbp_cache WHERE user_id = v_owner;
  RETURN jsonb_build_object('ok', true, 'location_title', v_pick ->> 'title');
END;
$$;
REVOKE ALL ON FUNCTION public.gbp_select_location(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gbp_select_location(text) TO authenticated;
