/*
  # Guard privileged profiles columns from client writes

  Why: policy "update_own_profile" allows UPDATE of the caller's own row with no column
  restriction, so a signed-in tenant could PATCH role / plan / status / stripe_* /
  subscription state / usage counters through PostgREST. Only is_staff was protected.

  Rule: when the statement runs as the PostgREST end-user roles (authenticated / anon),
  privileged columns cannot change. Service role, SECURITY DEFINER functions (current_user =
  function owner), migrations and the SQL editor are unaffected.

  Protected: explicit list below + any column named extra_* or stripe_*.
  Additive: one function + one trigger. Existing trg_protect_profile_staff_flag is untouched.

  ROLLBACK:
    DROP TRIGGER IF EXISTS trg_guard_profile_privileged_columns ON public.profiles;
    DROP FUNCTION IF EXISTS public.guard_profile_privileged_columns();
*/

CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_protected constant text[] := ARRAY[
    'id', 'role', 'plan', 'status', 'is_staff', 'is_synthetic_tenant',
    'minutes_used_this_month', 'minutes_included', 'external_id', 'inbound_email_token',
    'subscription_status', 'dunning_stage', 'payment_failed_at', 'payment_grace_period_ends_at',
    'last_payment_error', 'trial_state', 'trial_started_at', 'trial_ends_at', 'trial_used_at',
    'trial_subscription_id', 'billing_state_event_at', 'custom_limits',
    'a2p_brand_sid', 'a2p_campaign_sid', 'a2p_rejection_reason'
  ];
BEGIN
  -- Only end-user API roles are restricted. SECURITY DEFINER callers run as their owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
    IF (v_key = ANY (v_protected) OR left(v_key, 6) = 'extra_' OR left(v_key, 7) = 'stripe_')
       AND (v_new -> v_key) IS DISTINCT FROM (v_old -> v_key) THEN
      RAISE EXCEPTION 'profiles.% cannot be changed from the client', v_key
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_privileged_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_profile_privileged_columns ON public.profiles;
CREATE TRIGGER trg_guard_profile_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_columns();

COMMENT ON FUNCTION public.guard_profile_privileged_columns() IS
  'Blocks end-user (authenticated/anon) changes to billing, plan, role, usage and staff columns on profiles.';
