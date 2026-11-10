-- Per-key rate limit override. NULL = use the platform default (RATE_LIMIT_PER_MINUTE in contract.ts).
-- Tenants can NOT set or change it (service_role / staff only), so a key owner cannot raise their own limit.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_api_keys_guard_rate_limit_insert ON public.api_keys;
--   DROP FUNCTION IF EXISTS public.api_keys_guard_rate_limit_insert();
--   ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_rate_limit_range;
--   ALTER TABLE public.api_keys DROP COLUMN IF EXISTS rate_limit_per_minute;
--   (then re-create prevent_api_key_tampering() from 20280402000000_api_keys_modes_ip_allowlist.sql)

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer;

ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_rate_limit_range;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_rate_limit_range
  CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute BETWEEN 10 AND 1200);

COMMENT ON COLUMN public.api_keys.rate_limit_per_minute IS
  'NULL = platform default. Set only by service_role/staff; enforced by api-v1.';

-- UPDATE guard: same rules as 20280402000000 + rate_limit_per_minute is service_role-only.
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
  IF (NEW.last_used_at IS DISTINCT FROM OLD.last_used_at OR NEW.last_used_ip IS DISTINCT FROM OLD.last_used_ip)
     AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'last_used_at / last_used_ip are maintained by the API';
  END IF;
  IF NEW.rate_limit_per_minute IS DISTINCT FROM OLD.rate_limit_per_minute
     AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'rate_limit_per_minute can only be changed by Vireek staff';
  END IF;
  RETURN NEW;
END;
$$;

-- INSERT guard: the insert policy lets a tenant create keys, so they must not be able to pick their own limit.
CREATE OR REPLACE FUNCTION public.api_keys_guard_rate_limit_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rate_limit_per_minute IS NOT NULL AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'rate_limit_per_minute can only be set by Vireek staff';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_api_keys_guard_rate_limit_insert ON public.api_keys;
CREATE TRIGGER trg_api_keys_guard_rate_limit_insert
  BEFORE INSERT ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard_rate_limit_insert();
