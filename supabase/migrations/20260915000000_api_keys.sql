-- Real, self-serve API Key management (P1).
--
-- Keys are generated + SHA-256 hashed CLIENT-SIDE (Web Crypto's
-- crypto.subtle.digest, same primitive the api-v1 edge function uses to
-- verify them) — only the hash and a short display prefix are ever sent
-- to the database. The raw key is shown to the user exactly once, at
-- creation time, and is never stored or recoverable — same guarantee as
-- Stripe/GitHub tokens. This mirrors this project's existing pattern of
-- keeping sensitive per-account operations scoped to `auth.uid()`
-- (see list_own_sessions / revoke_own_session), so no new edge function
-- is needed just for CRUD.

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,          -- e.g. "vrk_live_a1b2" — safe to display
  key_hash text NOT NULL UNIQUE,     -- sha256(raw key), hex-encoded
  scopes text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT api_keys_valid_scopes CHECK (
    scopes <@ ARRAY['calls:read', 'leads:read', 'jobs:read']::text[]
  )
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active ON api_keys(key_hash) WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Only the account owner sees/manages keys (billing-equivalent sensitivity —
-- same reasoning webhook_logs and call_tracking_numbers already use).
DROP POLICY IF EXISTS "select_own_api_keys" ON api_keys;
CREATE POLICY "select_own_api_keys"
ON api_keys FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_api_keys" ON api_keys;
CREATE POLICY "insert_own_api_keys"
ON api_keys FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_api_keys" ON api_keys;
CREATE POLICY "update_own_api_keys"
ON api_keys FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

-- A row may only ever be revoked, never un-revoked or edited otherwise —
-- name/prefix/hash/scopes are immutable after creation, and revoked_at
-- can only move from NULL to a timestamp (not back, not into the future
-- being reset). This is enforced server-side so the UI can't be bypassed.
CREATE OR REPLACE FUNCTION public.prevent_api_key_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'API keys are immutable except for revocation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'API key is already revoked';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'revoked_at can only be set, never cleared';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_prevent_api_key_tampering ON api_keys;
CREATE TRIGGER trigger_prevent_api_key_tampering
  BEFORE UPDATE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_api_key_tampering();

COMMENT ON TABLE api_keys IS 'Self-serve developer API keys. Raw key never stored — only key_hash (sha256) and a display key_prefix.';
