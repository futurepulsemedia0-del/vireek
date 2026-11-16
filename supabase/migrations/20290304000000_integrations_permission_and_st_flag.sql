/*
  Integrations safety pack.

  1. public.can_manage_integrations()  - permission used by the Jobber / HubSpot / Google Calendar OAuth start
     functions and the ServiceTitan connect function. Same rule as can_manage_quickbooks(): business-profile edit
     AND billing view (owners always pass via has_account_permission's "no team_members row" branch).
  2. Feature flag `servicetitan_app_key_onboarding`, seeded OFF (enabled=false, rollout 0). New tenants cannot hand
     Vireek their ServiceTitan App Key; tenants with a live connection are grandfathered in code
     (price-book-connect-servicetitan), not by this flag.
  3. oauth_state_consumed + oauth_state_consume(): single-use enforcement for signed OAuth state nonces.

  Prerequisites (verified in this repo): has_account_permission(text) [20270503000000_crm_sync.sql],
  feature_flags [20270411000100_feature_flags.sql; kind/risk/owner columns in 20280501000000_release_safety_core.sql].

  ROLLBACK (manual, in this order):
    DROP FUNCTION IF EXISTS public.oauth_state_consume(text, text);
    DROP TABLE IF EXISTS public.oauth_state_consumed;
    DELETE FROM public.feature_flags WHERE key = 'servicetitan_app_key_onboarding';
    DROP FUNCTION IF EXISTS public.can_manage_integrations();
  (Roll back the edge-function changes first; they call these objects.)
*/

-- 1. PERMISSION ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_integrations()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_account_permission('can_edit_business_profile')
     AND public.has_account_permission('can_view_billing');
$$;
REVOKE ALL ON FUNCTION public.can_manage_integrations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_integrations() TO authenticated;

-- 2. FEATURE FLAG (default OFF) -----------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct, kind, risk)
VALUES (
  'servicetitan_app_key_onboarding',
  'ServiceTitan App-Key onboarding',
  'When OFF (default) new tenants cannot connect ServiceTitan by pasting their own App Key (ServiceTitan treats this as tunneling). Tenants with an existing connection keep working.',
  false, 0, 'ops', 'high'
)
ON CONFLICT (key) DO NOTHING;

-- 3. SINGLE-USE OAUTH STATE ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.oauth_state_consumed (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{24}$'),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  consumed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_state_consumed_at_idx ON public.oauth_state_consumed (consumed_at);
ALTER TABLE public.oauth_state_consumed ENABLE ROW LEVEL SECURITY;  -- no policies: service_role only
REVOKE ALL ON public.oauth_state_consumed FROM PUBLIC, anon, authenticated;

-- Returns true only for the FIRST consumption of a nonce. States live 10 minutes, so rows older than 1 day are
-- safe to prune (pruned opportunistically here to avoid needing a cron job).
CREATE OR REPLACE FUNCTION public.oauth_state_consume(p_nonce text, p_provider text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{24}$' THEN
    RETURN false;
  END IF;
  INSERT INTO public.oauth_state_consumed (nonce, provider) VALUES (p_nonce, left(coalesce(p_provider, 'unknown'), 40))
  ON CONFLICT (nonce) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF random() < 0.02 THEN
    DELETE FROM public.oauth_state_consumed WHERE consumed_at < now() - interval '1 day';
  END IF;
  RETURN v_rows = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.oauth_state_consume(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_state_consume(text, text) TO service_role;
