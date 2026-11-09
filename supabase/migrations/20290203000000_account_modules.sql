-- Per-account module entitlements (server-side, default OFF).
-- A module is enabled for an account only if a row exists with enabled = true and it has not expired.
-- No row => disabled. Clients can READ their own account's rows; ONLY service_role can write.
-- Every change is recorded in the append-only account_module_events.
-- Additive and idempotent.
-- rollback: DROP TRIGGER IF EXISTS trg_account_modules_audit ON public.account_modules; DROP FUNCTION IF EXISTS public.account_modules_audit(); DROP FUNCTION IF EXISTS public.has_module(text); DROP FUNCTION IF EXISTS public.has_module_for(uuid, text); DROP TABLE IF EXISTS public.account_module_events; DROP TABLE IF EXISTS public.account_modules;

CREATE TABLE IF NOT EXISTS public.account_modules (
  owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{2,40}$'),
  enabled    boolean NOT NULL DEFAULT false,
  source     text NOT NULL DEFAULT 'override' CHECK (source IN ('plan', 'override', 'trial', 'staff')),
  expires_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, module_key)
);

CREATE TABLE IF NOT EXISTS public.account_module_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    uuid NOT NULL,
  module_key  text NOT NULL,
  op          text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  old_enabled boolean,
  new_enabled boolean,
  changed_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_module_events_owner ON public.account_module_events (owner_id, created_at DESC);

ALTER TABLE public.account_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_module_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_modules_select_own_account ON public.account_modules;
CREATE POLICY account_modules_select_own_account ON public.account_modules
  FOR SELECT TO authenticated
  USING (owner_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies: writes are service_role only. account_module_events has no client policy at all.

REVOKE ALL ON public.account_modules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_modules TO authenticated;
REVOKE ALL ON public.account_module_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.account_modules_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.account_module_events (owner_id, module_key, op, old_enabled, new_enabled, changed_by)
    VALUES (OLD.owner_id, OLD.module_key, 'DELETE', OLD.enabled, NULL, auth.uid());
    RETURN OLD;
  END IF;
  NEW.updated_at := now();
  INSERT INTO public.account_module_events (owner_id, module_key, op, old_enabled, new_enabled, changed_by)
  VALUES (NEW.owner_id, NEW.module_key, TG_OP, CASE WHEN TG_OP = 'UPDATE' THEN OLD.enabled END, NEW.enabled, COALESCE(NEW.updated_by, auth.uid()));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_account_modules_audit ON public.account_modules;
CREATE TRIGGER trg_account_modules_audit
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_modules
  FOR EACH ROW EXECUTE FUNCTION public.account_modules_audit();

-- Caller-scoped check (team members resolve to their account owner). Fails closed.
CREATE OR REPLACE FUNCTION public.has_module(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT m.enabled AND (m.expires_at IS NULL OR m.expires_at > now())
      FROM public.account_modules m
     WHERE m.owner_id = public.get_account_owner_id() AND m.module_key = p_key
  ), false);
$$;

-- Service-side check for edge functions that already know the owner.
CREATE OR REPLACE FUNCTION public.has_module_for(p_owner uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT m.enabled AND (m.expires_at IS NULL OR m.expires_at > now())
      FROM public.account_modules m
     WHERE m.owner_id = p_owner AND m.module_key = p_key
  ), false);
$$;

REVOKE ALL ON FUNCTION public.has_module(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_module(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.has_module_for(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_module_for(uuid, text) TO service_role;
