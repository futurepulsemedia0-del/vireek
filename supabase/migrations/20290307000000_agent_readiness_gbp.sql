/*
  # Agent Readiness — Google Business Profile read (cache + context)

  Additive + idempotent (safe to run twice). Touches no existing table or function.

  1. agent_readiness_gbp_cache         one row per account: last GBP read outcome + last-good derived facts
  2. agent_readiness_gbp_context       service role: is GBP connected, which location (drops the cache when not connected)
  3. agent_readiness_gbp_cache_get/put service role: read / upsert the cache row
  4. agent_readiness_gbp_set_expiry    service role: record the new access-token expiry after a refresh

  Security: the cache holds DERIVED facts only (category names, counts, the listing's own public NAP) — never
  tokens and never the raw Google payload. RLS is on with no policy and all table privileges are revoked from
  anon/authenticated, so only the service role (edge functions) can read or write it. Rows are deleted by
  ON DELETE CASCADE with the account and by agent_readiness_gbp_context when the integration is disconnected.
  Depends on: integrations (integration_type = 'google_business_profile', config.location_name / account_name / expires_at).
*/

CREATE TABLE IF NOT EXISTS agent_readiness_gbp_cache (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  location_name text,
  status text NOT NULL CHECK (status IN ('ok', 'forbidden', 'unauthorized', 'not_found', 'rate_limited', 'unavailable')),
  facts jsonb,
  facts_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_readiness_gbp_cache_shape CHECK (
    (facts IS NULL OR (jsonb_typeof(facts) = 'object' AND length(facts::text) <= 8000))
    AND (location_name IS NULL OR location_name ~ '^locations/[0-9]{1,24}$'))
);
ALTER TABLE agent_readiness_gbp_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_readiness_gbp_cache FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_readiness_gbp_context(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_cfg jsonb;
BEGIN
  SELECT status, config INTO v_status, v_cfg
  FROM integrations
  WHERE user_id = p_user AND integration_type = 'google_business_profile'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_status IS DISTINCT FROM 'connected' THEN
    DELETE FROM agent_readiness_gbp_cache WHERE user_id = p_user;
    RETURN jsonb_build_object('connected', false);
  END IF;

  RETURN jsonb_build_object(
    'connected', true,
    'location_name', CASE WHEN v_cfg ->> 'location_name' ~ '^locations/[0-9]{1,24}$' THEN v_cfg ->> 'location_name' END,
    'account_name', CASE WHEN v_cfg ->> 'account_name' ~ '^accounts/[0-9]{1,24}$' THEN v_cfg ->> 'account_name' END,
    'expires_at', v_cfg ->> 'expires_at'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_gbp_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_gbp_context(uuid) TO service_role;

-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_readiness_gbp_cache_get(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('location_name', location_name, 'status', status, 'facts', facts,
                            'facts_at', facts_at, 'fetched_at', fetched_at)
  FROM agent_readiness_gbp_cache WHERE user_id = p_user;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_gbp_cache_get(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_gbp_cache_get(uuid) TO service_role;

-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_readiness_gbp_cache_put(
  p_user uuid, p_location text, p_status text, p_facts jsonb, p_facts_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('ok', 'forbidden', 'unauthorized', 'not_found', 'rate_limited', 'unavailable') THEN
    RAISE EXCEPTION 'bad_request';
  END IF;
  INSERT INTO agent_readiness_gbp_cache (user_id, location_name, status, facts, facts_at, fetched_at)
  VALUES (p_user, p_location, p_status, p_facts, p_facts_at, now())
  ON CONFLICT (user_id) DO UPDATE
    SET location_name = EXCLUDED.location_name, status = EXCLUDED.status, facts = EXCLUDED.facts,
        facts_at = EXCLUDED.facts_at, fetched_at = EXCLUDED.fetched_at;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_gbp_cache_put(uuid, text, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_gbp_cache_put(uuid, text, text, jsonb, timestamptz) TO service_role;

-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_readiness_gbp_set_expiry(p_user uuid, p_expires_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE integrations
  SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{expires_at}',
        to_jsonb(to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
  WHERE user_id = p_user AND integration_type = 'google_business_profile';
END;
$$;
REVOKE ALL ON FUNCTION public.agent_readiness_gbp_set_expiry(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_readiness_gbp_set_expiry(uuid, timestamptz) TO service_role;
