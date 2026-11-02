-- API keys: test/live mode, IP allowlist, last-used IP — and fixes for two latent bugs.
--
-- BUG 1: prevent_api_key_tampering() rejected EVERY update except a revoke, including the
--   `last_used_at` update api-v1 sends on each request. That update failed silently (it is
--   fire-and-forget), so "Last used" never changed. The trigger now lets the service role
--   record last_used_at / last_used_ip and lets the owner edit ip_allowlist, and keeps
--   everything else immutable.
-- BUG 2: the original CHECK only allowed calls/leads/jobs:read, while the dashboard offers ten
--   scopes, so creating a key with any other scope failed at the database. The CHECK now matches
--   API_SCOPES in src/lib/apiKeys.ts.
--
-- Privacy note: last_used_ip stores ONE address per key (the most recent caller), overwritten on
-- each request. api_request_logs still stores no IP addresses.
--
-- Rollback (safe, additive columns only):
--   ALTER TABLE api_keys DROP COLUMN mode, DROP COLUMN ip_allowlist, DROP COLUMN last_used_ip;
--   (then re-create the previous constraint/trigger from 20260915000000_api_keys.sql)

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS ip_allowlist inet[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_used_ip inet;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_valid_mode;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_valid_mode CHECK (mode IN ('live', 'test'));

-- The display prefix must agree with the mode (existing keys are all vrk_live_…).
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_prefix_matches_mode;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_prefix_matches_mode CHECK (
  (mode = 'live' AND key_prefix LIKE 'vrk\_live\_%') OR (mode = 'test' AND key_prefix LIKE 'vrk\_test\_%')
);

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_allowlist_size;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_allowlist_size CHECK (cardinality(ip_allowlist) <= 20);

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_valid_scopes;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_valid_scopes CHECK (
  scopes <@ ARRAY[
    'calls:read', 'leads:read', 'jobs:read', 'verticals:read',
    'assistants:read', 'assistants:write', 'numbers:read', 'numbers:write',
    'webhooks:read', 'webhooks:write'
  ]::text[]
);

CREATE OR REPLACE FUNCTION public.prevent_api_key_tampering()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'API keys are immutable except for revocation, last-used info and the IP allowlist';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'API key is already revoked';
  END IF;
  -- Only the API itself (service role) may record usage; a user cannot forge it.
  IF (NEW.last_used_at IS DISTINCT FROM OLD.last_used_at OR NEW.last_used_ip IS DISTINCT FROM OLD.last_used_ip)
     AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'last_used_at / last_used_ip are maintained by the API';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN api_keys.mode IS 'live = real account data; test = synthetic sandbox data only (never touches real tables).';
COMMENT ON COLUMN api_keys.ip_allowlist IS 'Empty = any IP. Otherwise api-v1 only accepts requests from these addresses/CIDR ranges (fail-closed).';
COMMENT ON COLUMN api_keys.last_used_ip IS 'Most recent caller address (overwritten, not a history).';
