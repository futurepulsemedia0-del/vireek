-- MCP OAuth 2.1 (authorization code + PKCE S256, refresh-token rotation) for the Agent Network MCP server.
--
-- API keys (vrk_agent_...) are untouched and keep working. OAuth adds a second way to obtain the same
-- governed identity: every grant owns ONE agent_network_clients row, so scopes, per-client rate limits, daily
-- quota, denial throttling, audit and revocation (Dashboard > Agent Network) apply to OAuth callers unchanged.
--   * That row's key_hash is the SHA-256 of a random secret nobody ever receives, so it cannot be used as an API key.
--   * Access tokens (1 h) live in mcp_oauth_tokens; refresh tokens (30 d sliding, 90 d absolute) in mcp_oauth_grants.
--   * Only hashes are stored. Codes are single-use (120 s). Replaying a code or a rotated refresh token revokes the grant.
--   * Randomness is gen_random_uuid() (CSPRNG); hashing is the built-in sha256(): no extension dependency.
-- The functions below are SERVICE-ROLE only (called by the mcp-oauth / mcp-server edge functions) except the two
-- consent RPCs, which require a signed-in account admin (agent_network_is_admin()).
--
-- Rollback (revokes every OAuth connection):
--   UPDATE agent_network_clients SET revoked_at = now() WHERE id IN (SELECT agent_client_id FROM mcp_oauth_grants) AND revoked_at IS NULL;
--   then DROP the mcp_oauth_* functions and tables (grants/tokens/codes/clients, in that order).

-- =============================================================
-- TABLES (no policies, no client grants: reachable only through the RPCs below)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  client_id text PRIMARY KEY CHECK (client_id ~ '^vrk_oc_[0-9a-f]{32}$'),
  client_name text NOT NULL CHECK (char_length(btrim(client_name)) BETWEEN 1 AND 60),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  resource text NOT NULL CHECK (char_length(resource) <= 512),
  agent_client_id uuid NOT NULL REFERENCES public.agent_network_clients(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE CHECK (refresh_hash ~ '^[0-9a-f]{64}$'),
  refresh_prev_hash text CHECK (refresh_prev_hash IS NULL OR refresh_prev_hash ~ '^[0-9a-f]{64}$'),
  refresh_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,                   -- absolute lifetime of the grant (matches the agent client's expiry)
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grants_owner ON public.mcp_oauth_grants (owner_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grants_prev ON public.mcp_oauth_grants (refresh_prev_hash) WHERE refresh_prev_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.mcp_oauth_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  scopes text[] NOT NULL,
  resource text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  grant_id uuid REFERENCES public.mcp_oauth_grants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_owner ON public.mcp_oauth_codes (owner_id, expires_at);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid NOT NULL REFERENCES public.mcp_oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_grant ON public.mcp_oauth_tokens (grant_id);

ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_oauth_clients, public.mcp_oauth_grants, public.mcp_oauth_codes, public.mcp_oauth_tokens FROM anon, authenticated;

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.mcp_oauth_sha256(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT encode(sha256(convert_to(p, 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.mcp_oauth_revoke_grant(p_grant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_agent uuid;
BEGIN
  UPDATE public.mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = p_grant_id RETURNING agent_client_id INTO v_agent;
  IF v_agent IS NULL THEN RETURN; END IF;
  DELETE FROM public.mcp_oauth_tokens WHERE grant_id = p_grant_id;
  UPDATE public.agent_network_clients SET revoked_at = now() WHERE id = v_agent AND revoked_at IS NULL;
  -- Anything still waiting on a human for this client can no longer run (same rule as revoke_agent_network_client).
  UPDATE public.agent_network_calls SET status = 'canceled', updated_at = now() WHERE client_id = v_agent AND status IN ('received', 'pending_approval');
END;
$$;

-- Validates an authorization request. Errors that must NOT be redirected (unknown client / redirect URI) are flagged.
CREATE OR REPLACE FUNCTION public.mcp_oauth_check_request(p_client_id text, p_redirect_uri text, p_resource text, p_challenge text, p_method text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE c public.mcp_oauth_clients;
BEGIN
  SELECT * INTO c FROM public.mcp_oauth_clients WHERE client_id = p_client_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_client', 'redirectable', false); END IF;
  IF p_redirect_uri IS NULL OR NOT (p_redirect_uri = ANY (c.redirect_uris)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_redirect_uri', 'redirectable', false);
  END IF;
  IF p_method IS DISTINCT FROM 'S256' OR COALESCE(p_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request', 'description', 'PKCE with code_challenge_method=S256 is required.', 'redirectable', true);
  END IF;
  IF COALESCE(p_resource, '') !~ '^https?://[^#?[:space:]]{1,500}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_target', 'description', 'A valid resource parameter is required.', 'redirectable', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'client_name', c.client_name);
END;
$$;

-- =============================================================
-- SERVICE-ROLE RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.mcp_oauth_register_client(p_client_id text, p_name text, p_redirect_uris text[])
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Unauthenticated endpoint: global throttles keep it from becoming a storage-fill vector.
  IF (SELECT count(*) FROM public.mcp_oauth_clients WHERE created_at > now() - interval '1 hour') >= 200 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;
  DELETE FROM public.mcp_oauth_clients c
   WHERE c.created_at < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_grants g WHERE g.client_id = c.client_id)
     AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_codes k WHERE k.client_id = c.client_id);
  IF (SELECT count(*) FROM public.mcp_oauth_clients) >= 50000 THEN RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000'; END IF;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES (p_client_id, btrim(p_name), p_redirect_uris);
  RETURN p_client_id;
END;
$$;

-- Atomically consumes an authorization code. Returns what the edge function needs to verify PKCE and resource.
CREATE OR REPLACE FUNCTION public.mcp_oauth_code_consume(p_code_hash text, p_client_id text, p_redirect_uri text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k public.mcp_oauth_codes;
BEGIN
  SELECT * INTO k FROM public.mcp_oauth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;
  IF k.used_at IS NOT NULL THEN
    -- Replay of a used code: assume theft and kill whatever it produced.
    IF k.grant_id IS NOT NULL THEN PERFORM public.mcp_oauth_revoke_grant(k.grant_id); END IF;
    RETURN jsonb_build_object('ok', false);
  END IF;
  UPDATE public.mcp_oauth_codes SET used_at = now() WHERE code_hash = p_code_hash;   -- burned even if a later check fails
  IF k.expires_at <= now() OR k.client_id <> p_client_id OR k.redirect_uri <> p_redirect_uri THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'challenge', k.code_challenge, 'scopes', to_jsonb(k.scopes), 'resource', k.resource);
END;
$$;

-- Creates the grant (and its governed agent client) from a code consumed moments ago.
CREATE OR REPLACE FUNCTION public.mcp_oauth_issue_grant(p_code_hash text, p_access_hash text, p_refresh_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k public.mcp_oauth_codes;
  cl public.mcp_oauth_clients;
  v_agent uuid;
  v_grant uuid;
BEGIN
  IF p_access_hash !~ '^[0-9a-f]{64}$' OR p_refresh_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO k FROM public.mcp_oauth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR k.used_at IS NULL OR k.used_at < now() - interval '60 seconds' OR k.grant_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  SELECT * INTO cl FROM public.mcp_oauth_clients WHERE client_id = k.client_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false); END IF;

  INSERT INTO public.agent_network_clients (user_id, name, key_prefix, key_hash, scopes, daily_call_limit, expires_at)
  VALUES (k.owner_id, left('OAuth · ' || cl.client_name, 80), 'oauth-grant',
          public.mcp_oauth_sha256(gen_random_uuid()::text || gen_random_uuid()::text), k.scopes, 1000, now() + interval '90 days')
  RETURNING id INTO v_agent;

  INSERT INTO public.mcp_oauth_grants (client_id, owner_id, granted_by, scopes, resource, agent_client_id, refresh_hash, refresh_expires_at, expires_at)
  VALUES (k.client_id, k.owner_id, k.granted_by, k.scopes, k.resource, v_agent, p_refresh_hash, now() + interval '30 days', now() + interval '90 days')
  RETURNING id INTO v_grant;

  INSERT INTO public.mcp_oauth_tokens (token_hash, grant_id, expires_at) VALUES (p_access_hash, v_grant, now() + interval '1 hour');
  UPDATE public.mcp_oauth_codes SET grant_id = v_grant WHERE code_hash = p_code_hash;
  RETURN jsonb_build_object('ok', true, 'scopes', to_jsonb(k.scopes), 'resource', k.resource, 'expires_in', 3600);
END;
$$;

-- Refresh-token rotation with reuse detection (OAuth 2.1 §4.3.1 / security BCP).
CREATE OR REPLACE FUNCTION public.mcp_oauth_refresh(p_client_id text, p_refresh_hash text, p_new_refresh_hash text, p_new_access_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.mcp_oauth_grants;
  v_agent_revoked timestamptz;
BEGIN
  IF p_new_access_hash !~ '^[0-9a-f]{64}$' OR p_new_refresh_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO g FROM public.mcp_oauth_grants WHERE refresh_hash = p_refresh_hash OR refresh_prev_hash = p_refresh_hash FOR UPDATE;
  IF NOT FOUND OR g.client_id <> p_client_id THEN RETURN jsonb_build_object('ok', false); END IF;
  IF g.refresh_hash <> p_refresh_hash THEN
    PERFORM public.mcp_oauth_revoke_grant(g.id);          -- an already-rotated token came back: revoke the family
    RETURN jsonb_build_object('ok', false, 'reuse', true);
  END IF;
  SELECT revoked_at INTO v_agent_revoked FROM public.agent_network_clients WHERE id = g.agent_client_id;
  IF g.revoked_at IS NOT NULL OR v_agent_revoked IS NOT NULL OR g.expires_at <= now() OR g.refresh_expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  UPDATE public.mcp_oauth_grants
     SET refresh_prev_hash = refresh_hash, refresh_hash = p_new_refresh_hash,
         refresh_expires_at = LEAST(now() + interval '30 days', expires_at)
   WHERE id = g.id;
  DELETE FROM public.mcp_oauth_tokens WHERE grant_id = g.id;
  INSERT INTO public.mcp_oauth_tokens (token_hash, grant_id, expires_at) VALUES (p_new_access_hash, g.id, now() + interval '1 hour');
  RETURN jsonb_build_object('ok', true, 'scopes', to_jsonb(g.scopes), 'resource', g.resource, 'expires_in', 3600);
END;
$$;

-- RFC 7009: always succeeds from the caller's point of view.
CREATE OR REPLACE FUNCTION public.mcp_oauth_revoke(p_client_id text, p_token_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_grant uuid;
BEGIN
  SELECT id INTO v_grant FROM public.mcp_oauth_grants WHERE client_id = p_client_id AND (refresh_hash = p_token_hash OR refresh_prev_hash = p_token_hash);
  IF v_grant IS NULL THEN
    SELECT g.id INTO v_grant FROM public.mcp_oauth_tokens t JOIN public.mcp_oauth_grants g ON g.id = t.grant_id
     WHERE t.token_hash = p_token_hash AND g.client_id = p_client_id;
  END IF;
  IF v_grant IS NOT NULL THEN PERFORM public.mcp_oauth_revoke_grant(v_grant); END IF;
END;
$$;

-- Resource-server gate: resolves an access token and then runs the SAME gate as API keys (burst, quota, denial throttle).
CREATE OR REPLACE FUNCTION public.mcp_oauth_gate(p_token_hash text, p_cost integer DEFAULT 1, p_v2 boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.mcp_oauth_grants;
  v_key_hash text;
  v_res jsonb;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_key'); END IF;
  SELECT g2.* INTO g FROM public.mcp_oauth_tokens t JOIN public.mcp_oauth_grants g2 ON g2.id = t.grant_id
   WHERE t.token_hash = p_token_hash AND t.expires_at > now();
  IF NOT FOUND OR g.revoked_at IS NOT NULL OR g.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_key'); END IF;
  SELECT key_hash INTO v_key_hash FROM public.agent_network_clients WHERE id = g.agent_client_id;
  IF v_key_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_key'); END IF;
  v_res := CASE WHEN p_v2 THEN public.agent_network_begin_v2(v_key_hash, p_cost) ELSE public.agent_network_begin(v_key_hash) END;
  IF COALESCE((v_res ->> 'ok')::boolean, false) THEN v_res := v_res || jsonb_build_object('resource', g.resource); END IF;
  RETURN v_res;
END;
$$;

-- =============================================================
-- CONSENT RPCs (signed-in account admin only)
-- =============================================================
CREATE OR REPLACE FUNCTION public.mcp_oauth_authorize_preview(p_client_id text, p_redirect_uri text, p_resource text, p_challenge text, p_method text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_account_owner_id() IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN public.mcp_oauth_check_request(p_client_id, p_redirect_uri, p_resource, p_challenge, p_method);
END;
$$;

-- Records the owner's decision. On approval returns a single-use code (only its hash is stored).
CREATE OR REPLACE FUNCTION public.mcp_oauth_authorize_decide(
  p_client_id text, p_redirect_uri text, p_resource text, p_challenge text, p_method text, p_scopes text[], p_approve boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_chk jsonb;
  v_code text;
  v_all text[] := ARRAY['customers:read', 'equipment:read', 'jobs:read', 'schedule:read', 'inventory:read',
                        'quotes:create', 'dispatch:assign', 'messages:send', 'payments:collect'];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.agent_network_is_admin() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  v_chk := public.mcp_oauth_check_request(p_client_id, p_redirect_uri, p_resource, p_challenge, p_method);
  IF NOT COALESCE((v_chk ->> 'ok')::boolean, false) THEN RETURN v_chk; END IF;
  IF NOT COALESCE(p_approve, false) THEN RETURN jsonb_build_object('ok', true, 'approved', false); END IF;

  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 OR NOT (p_scopes <@ v_all) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_scope', 'description', 'Choose at least one valid scope.', 'redirectable', true);
  END IF;
  IF (SELECT count(*) FROM public.mcp_oauth_grants WHERE owner_id = v_owner AND revoked_at IS NULL AND expires_at > now()) >= 15 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'access_denied', 'description', 'Too many connected apps. Revoke one in Agent Network first.', 'redirectable', true);
  END IF;
  IF (SELECT count(*) FROM public.mcp_oauth_codes WHERE owner_id = v_owner AND used_at IS NULL AND expires_at > now()) >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'temporarily_unavailable', 'description', 'Too many pending authorizations.', 'redirectable', true);
  END IF;

  v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  INSERT INTO public.mcp_oauth_codes (code_hash, client_id, owner_id, granted_by, scopes, resource, redirect_uri, code_challenge, expires_at)
  VALUES (public.mcp_oauth_sha256(v_code), p_client_id, v_owner, auth.uid(), p_scopes, p_resource, p_redirect_uri, p_challenge, now() + interval '120 seconds');
  IF random() < 0.05 THEN DELETE FROM public.mcp_oauth_codes WHERE expires_at < now() - interval '1 day'; END IF;
  RETURN jsonb_build_object('ok', true, 'approved', true, 'code', v_code);
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.mcp_oauth_sha256(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_revoke_grant(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_check_request(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_register_client(text, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_code_consume(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_issue_grant(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_refresh(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_revoke(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_gate(text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mcp_oauth_authorize_preview(text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mcp_oauth_authorize_decide(text, text, text, text, text, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_sha256(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_revoke_grant(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_register_client(text, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_code_consume(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_issue_grant(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_refresh(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_revoke(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_gate(text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_authorize_preview(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_authorize_decide(text, text, text, text, text, text[], boolean) TO authenticated;
