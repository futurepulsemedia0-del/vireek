-- OAuth app registry (Settings → OAuth apps).
--
-- Two tables:
--   oauth_apps   — apps an account owner registers (client_id, hashed secret,
--                  redirect URIs, allowed scopes, consent-screen metadata).
--   oauth_grants — tokens issued to an app after a user approved the consent
--                  screen. Rows are INSERTED by the oauth edge function using
--                  the service role (never by the browser). The dashboard may
--                  only read them and revoke them.
--
-- Same guarantees as api_keys: the raw client secret is generated + hashed
-- CLIENT-SIDE (Web Crypto SHA-256) and shown exactly once; only the hash and a
-- display prefix are stored. All access is scoped to the account owner via
-- public.get_account_owner_id() AND restricted to profiles.role = 'owner'.

-- ---------------------------------------------------------------------------
-- Helper: true only for the account owner (not admins / members / technicians)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_account_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner');
$$;

GRANT EXECUTE ON FUNCTION public.is_account_owner() TO authenticated;

-- ---------------------------------------------------------------------------
-- oauth_apps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  homepage_url text,
  privacy_url text,
  terms_url text,
  redirect_uris text[] NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  client_id text NOT NULL UNIQUE,            -- public identifier, e.g. "vrk_app_…"
  client_secret_prefix text NOT NULL,        -- safe to display
  client_secret_hash text NOT NULL UNIQUE,   -- sha256(raw secret), hex
  secret_rotated_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_apps_name_len CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  CONSTRAINT oauth_apps_desc_len CHECK (char_length(description) <= 280),
  CONSTRAINT oauth_apps_redirect_count CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  CONSTRAINT oauth_apps_valid_scopes CHECK (
    cardinality(scopes) >= 1
    AND scopes <@ ARRAY['calls:read', 'leads:read', 'jobs:read']::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_oauth_apps_user ON oauth_apps(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trigger_oauth_apps_updated_at ON oauth_apps;
CREATE TRIGGER trigger_oauth_apps_updated_at
  BEFORE UPDATE ON oauth_apps
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE oauth_apps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_oauth_apps" ON oauth_apps;
CREATE POLICY "select_own_oauth_apps"
ON oauth_apps FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id() AND public.is_account_owner());

DROP POLICY IF EXISTS "insert_own_oauth_apps" ON oauth_apps;
CREATE POLICY "insert_own_oauth_apps"
ON oauth_apps FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id() AND public.is_account_owner());

DROP POLICY IF EXISTS "update_own_oauth_apps" ON oauth_apps;
CREATE POLICY "update_own_oauth_apps"
ON oauth_apps FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id() AND public.is_account_owner())
WITH CHECK (user_id = public.get_account_owner_id() AND public.is_account_owner());

DROP POLICY IF EXISTS "delete_own_oauth_apps" ON oauth_apps;
CREATE POLICY "delete_own_oauth_apps"
ON oauth_apps FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id() AND public.is_account_owner());

-- Identity columns are immutable. Secret hash/prefix may change (rotation) but
-- only together, and rotation stamps secret_rotated_at server-side.
CREATE OR REPLACE FUNCTION public.guard_oauth_app_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OAuth app identity (owner, client_id) is immutable';
  END IF;

  IF NEW.client_secret_hash IS DISTINCT FROM OLD.client_secret_hash THEN
    NEW.secret_rotated_at := now();
  ELSIF NEW.client_secret_prefix IS DISTINCT FROM OLD.client_secret_prefix THEN
    RAISE EXCEPTION 'client_secret_prefix must change together with client_secret_hash';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_guard_oauth_app_update ON oauth_apps;
CREATE TRIGGER trigger_guard_oauth_app_update
  BEFORE UPDATE ON oauth_apps
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_oauth_app_update();

-- ---------------------------------------------------------------------------
-- oauth_grants (tokens issued after consent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,  -- account owner
  scopes text[] NOT NULL DEFAULT '{}',
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_grants_valid_scopes CHECK (
    scopes <@ ARRAY['calls:read', 'leads:read', 'jobs:read']::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_app ON oauth_grants(app_id);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_hash_active
  ON oauth_grants(token_hash) WHERE revoked_at IS NULL;

ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;

-- Read + revoke only. No INSERT/DELETE policy: tokens are minted by the edge
-- function (service role bypasses RLS) and kept for audit.
DROP POLICY IF EXISTS "select_own_oauth_grants" ON oauth_grants;
CREATE POLICY "select_own_oauth_grants"
ON oauth_grants FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id() AND public.is_account_owner());

DROP POLICY IF EXISTS "update_own_oauth_grants" ON oauth_grants;
CREATE POLICY "update_own_oauth_grants"
ON oauth_grants FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id() AND public.is_account_owner())
WITH CHECK (user_id = public.get_account_owner_id() AND public.is_account_owner());

-- A grant can only ever move from active → revoked.
CREATE OR REPLACE FUNCTION public.guard_oauth_grant_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Service-role writers (token refresh / last_used_at bumps) are not limited.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.app_id IS DISTINCT FROM OLD.app_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.token_prefix IS DISTINCT FROM OLD.token_prefix
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OAuth grants are immutable except for revocation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'OAuth grant is already revoked';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'revoked_at can only be set, never cleared';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_guard_oauth_grant_update ON oauth_grants;
CREATE TRIGGER trigger_guard_oauth_grant_update
  BEFORE UPDATE ON oauth_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_oauth_grant_update();

-- Disabling an app must kill every live token at once.
-- SECURITY DEFINER so it works regardless of the caller's grant-update rights.
CREATE OR REPLACE FUNCTION public.revoke_grants_on_app_disable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.disabled_at IS NOT NULL AND OLD.disabled_at IS NULL THEN
    UPDATE oauth_grants
       SET revoked_at = now()
     WHERE app_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_revoke_grants_on_app_disable ON oauth_apps;
CREATE TRIGGER trigger_revoke_grants_on_app_disable
  AFTER UPDATE OF disabled_at ON oauth_apps
  FOR EACH ROW
  EXECUTE FUNCTION public.revoke_grants_on_app_disable();

COMMENT ON TABLE oauth_apps IS 'Account-owner registered OAuth apps. Raw client secret never stored — only client_secret_hash (sha256) and a display prefix.';
COMMENT ON TABLE oauth_grants IS 'Tokens issued to OAuth apps after user consent. Inserted by the oauth edge function (service role); dashboard can only read and revoke.';
