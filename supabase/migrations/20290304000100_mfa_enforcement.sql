/*
  # MFA enforcement state for owner / admin / staff (server-side, with grace period)

  - mfa_enforcement_policy: singleton row. enforce_from IS NULL (default) = enforcement OFF (dark launch).
    Service role only (RLS on, zero policies, grants revoked).
  - mfa_enforcement_state(): SECURITY DEFINER, reads ONLY the caller's own data (auth.uid()), so no IDOR.
    required = is_staff OR (team member with role owner/admin) OR (non-member whose profile role is owner/admin).
    Technicians and other members stay opt-in.
    Grace ends at greatest(enforce_from, user created_at) + grace_days (staff_grace_days for staff).

  Turn on (operator, SQL editor):   update public.mfa_enforcement_policy set enforce_from = now();
  Turn off:                         update public.mfa_enforcement_policy set enforce_from = null;

  ROLLBACK:
    DROP FUNCTION IF EXISTS public.mfa_enforcement_state();
    DROP TABLE IF EXISTS public.mfa_enforcement_policy;
*/

CREATE TABLE IF NOT EXISTS public.mfa_enforcement_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enforce_from timestamptz,
  grace_days integer NOT NULL DEFAULT 14 CHECK (grace_days BETWEEN 0 AND 90),
  staff_grace_days integer NOT NULL DEFAULT 0 CHECK (staff_grace_days BETWEEN 0 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mfa_enforcement_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mfa_enforcement_policy FROM anon, authenticated;
-- Deliberately NO policies: service-role only (documented in docs/security/RLS_EXCEPTIONS.md).
COMMENT ON TABLE public.mfa_enforcement_policy IS 'Singleton MFA enforcement policy. Service role only.';
INSERT INTO public.mfa_enforcement_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mfa_enforcement_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pol public.mfa_enforcement_policy%ROWTYPE;
  v_staff boolean;
  v_profile_role text;
  v_has_tm boolean;
  v_tm_role text;
  v_required boolean;
  v_enrolled boolean;
  v_created timestamptz;
  v_active boolean;
  v_grace_ends timestamptz;
  v_days integer;
  v_enforced boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('required', false, 'enrolled', false, 'aal', 'aal1',
                              'policy_active', false, 'enforced', false, 'grace_ends_at', NULL, 'days_left', NULL);
  END IF;

  SELECT * INTO v_pol FROM public.mfa_enforcement_policy LIMIT 1;
  SELECT COALESCE(p.is_staff, false), p.role INTO v_staff, v_profile_role FROM public.profiles p WHERE p.id = v_uid;
  SELECT true, t.role INTO v_has_tm, v_tm_role FROM public.team_members t WHERE t.user_id = v_uid ORDER BY t.created_at LIMIT 1;

  v_required := COALESCE(v_staff, false)
    OR (CASE WHEN COALESCE(v_has_tm, false) THEN COALESCE(v_tm_role, '') IN ('owner', 'admin')
             ELSE COALESCE(v_profile_role, 'owner') IN ('owner', 'admin') END);

  v_enrolled := EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = v_uid AND f.status = 'verified');
  SELECT u.created_at INTO v_created FROM auth.users u WHERE u.id = v_uid;

  v_active := v_pol.enforce_from IS NOT NULL AND v_pol.enforce_from <= now();
  IF v_pol.enforce_from IS NOT NULL THEN
    v_grace_ends := GREATEST(v_pol.enforce_from, COALESCE(v_created, v_pol.enforce_from))
      + make_interval(days => CASE WHEN COALESCE(v_staff, false) THEN v_pol.staff_grace_days ELSE v_pol.grace_days END);
    v_days := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_grace_ends - now())) / 86400.0))::integer;
  END IF;

  v_enforced := COALESCE(v_required AND v_active AND NOT v_enrolled AND now() >= v_grace_ends, false);

  RETURN jsonb_build_object(
    'required', v_required,
    'enrolled', v_enrolled,
    'aal', COALESCE(auth.jwt() ->> 'aal', 'aal1'),
    'policy_active', v_active,
    'enforced', v_enforced,
    'grace_ends_at', v_grace_ends,
    'days_left', v_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mfa_enforcement_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_enforcement_state() TO authenticated;
COMMENT ON FUNCTION public.mfa_enforcement_state() IS 'Caller-only MFA enforcement state (required/enrolled/grace). SECURITY DEFINER, reads only auth.uid() data.';
