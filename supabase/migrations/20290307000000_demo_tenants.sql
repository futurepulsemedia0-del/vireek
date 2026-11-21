/*
  # Demo tenants (sales demos / proofs of concept)

  Registry + expiry enforcement for tenants created by scripts/provision-demo-tenant.mjs.
  Does NOT create users or data: the script does that through the Auth admin API with a random password.
  Nothing in this migration contains a password.

  What it adds
    1. public.demo_tenants          one row per demo tenant (tombstone: no FK, survives erasure of the account)
    2. register_demo_tenant()       service_role only; accepts only a *@demo.vireek.invalid, non-staff account
    3. extend_demo_tenant()         service_role only; max 14 days per call, max 2 extensions, hard ceiling 60 days
    4. expire_due_demo_tenants()    service_role only; bans the login (auth.users.banned_until), drops sessions,
                                    marks the row expired. Scheduled hourly via pg_cron when that extension exists.
    5. mark_demo_tenant_purged()    service_role only; called by the script after erasure
    6. is_demo_tenant(uuid)         stable helper other features can use to refuse real side effects for demo accounts

  Limits (honest):
    - Expiry bans the login and deletes refresh sessions; an access token already issued stays valid until it expires
      (Supabase default: 1 hour).
    - Nothing here blocks outbound integrations for demo accounts. Synthetic phones/emails use reserved fictional ranges
      (555-01NN, .invalid), and no provider is provisioned. Wire is_demo_tenant() into send paths if you enable any.
    - Data the prospect creates while exploring is removed by the purge command (same table list as delete-account).

  Idempotent: safe to run twice.

  -- rollback:
  --   select cron.unschedule('vireek-demo-tenant-expire');   -- only if pg_cron was present
  --   drop function public.is_demo_tenant(uuid), public.mark_demo_tenant_purged(uuid), public.expire_due_demo_tenants(),
  --     public.extend_demo_tenant(uuid, integer), public.register_demo_tenant(uuid, text, text, text, text, timestamptz, text);
  --   drop table public.demo_tenants;   -- loses the demo registry only
*/

CREATE TABLE IF NOT EXISTS public.demo_tenants (
  account_id uuid PRIMARY KEY,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  prospect text CHECK (prospect IS NULL OR char_length(prospect) <= 120),
  scenario text NOT NULL DEFAULT 'hvac' CHECK (scenario IN ('hvac', 'plumbing')),
  seed text NOT NULL CHECK (char_length(seed) BETWEEN 1 AND 120),
  created_by text NOT NULL DEFAULT 'cli' CHECK (char_length(created_by) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  original_expires_at timestamptz NOT NULL,
  extensions integer NOT NULL DEFAULT 0 CHECK (extensions BETWEEN 0 AND 2),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'purged')),
  expired_at timestamptz,
  purged_at timestamptz,
  CONSTRAINT demo_tenants_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT demo_tenants_lifetime_ceiling CHECK (expires_at <= created_at + interval '60 days')
);

CREATE INDEX IF NOT EXISTS idx_demo_tenants_due ON public.demo_tenants (expires_at) WHERE status = 'active';

ALTER TABLE public.demo_tenants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.demo_tenants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.demo_tenants TO authenticated;

DROP POLICY IF EXISTS "staff_select_demo_tenants" ON public.demo_tenants;
CREATE POLICY "staff_select_demo_tenants" ON public.demo_tenants
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
-- No INSERT/UPDATE/DELETE policy on purpose: only the service_role RPCs below write this table.

-- 1) register -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_demo_tenant(
  p_account uuid,
  p_label text,
  p_prospect text,
  p_scenario text,
  p_seed text,
  p_expires_at timestamptz,
  p_created_by text DEFAULT 'cli'
)
RETURNS public.demo_tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_row public.demo_tenants;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = p_account;
  IF v_email IS NULL OR lower(v_email) NOT LIKE '%@demo.vireek.invalid' THEN
    RAISE EXCEPTION 'Only a demo account (*@demo.vireek.invalid) can be registered as a demo tenant.';
  END IF;
  IF public.is_vireek_staff(p_account) THEN
    RAISE EXCEPTION 'A staff account cannot be a demo tenant.';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'Expiry must be in the future and at most 30 days from now.';
  END IF;

  INSERT INTO public.demo_tenants (account_id, label, prospect, scenario, seed, created_by, expires_at, original_expires_at)
  VALUES (p_account, p_label, NULLIF(p_prospect, ''), p_scenario, p_seed, COALESCE(NULLIF(p_created_by, ''), 'cli'), p_expires_at, p_expires_at)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- 2) extend ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.extend_demo_tenant(p_account uuid, p_days integer)
RETURNS public.demo_tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.demo_tenants;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 14 THEN
    RAISE EXCEPTION 'An extension is between 1 and 14 days.';
  END IF;
  SELECT * INTO v_row FROM public.demo_tenants WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown demo tenant.'; END IF;
  IF v_row.status <> 'active' THEN RAISE EXCEPTION 'Only an active demo tenant can be extended (status: %).', v_row.status; END IF;
  IF v_row.extensions >= 2 THEN RAISE EXCEPTION 'A demo tenant can be extended at most twice.'; END IF;

  UPDATE public.demo_tenants
     SET expires_at = LEAST(expires_at + make_interval(days => p_days), created_at + interval '60 days'),
         extensions = extensions + 1
   WHERE account_id = p_account
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- 3) expire ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_due_demo_tenants()
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN
    SELECT account_id FROM public.demo_tenants WHERE status = 'active' AND expires_at <= now() FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = v_id;
    IF to_regclass('auth.sessions') IS NOT NULL THEN
      EXECUTE 'DELETE FROM auth.sessions WHERE user_id = $1' USING v_id;
    END IF;
    UPDATE public.demo_tenants SET status = 'expired', expired_at = now() WHERE account_id = v_id;
    RETURN NEXT v_id;
  END LOOP;
  RETURN;
END;
$$;

-- 4) purged marker ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_demo_tenant_purged(p_account uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.demo_tenants SET status = 'purged', purged_at = now() WHERE account_id = p_account AND status <> 'purged';
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown or already purged demo tenant.'; END IF;
END;
$$;

-- 5) helper for other features ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_demo_tenant(p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.demo_tenants WHERE account_id = p_account AND status <> 'purged');
$$;

-- Privileges: Supabase grants EXECUTE on new functions to anon/authenticated by default, so revoke explicitly.
REVOKE ALL ON FUNCTION public.register_demo_tenant(uuid, text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.extend_demo_tenant(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_due_demo_tenants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_demo_tenant_purged(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_demo_tenant(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_demo_tenant(uuid, text, text, text, text, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.extend_demo_tenant(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_due_demo_tenants() TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_demo_tenant_purged(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_demo_tenant(uuid) TO service_role;

-- 6) hourly expiry when pg_cron is available (same guard style as other scheduled migrations) ---------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-demo-tenant-expire', '7 * * * *', $c$select public.expire_due_demo_tenants()$c$);
  END IF;
END $$;
