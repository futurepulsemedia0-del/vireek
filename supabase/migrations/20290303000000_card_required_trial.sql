-- 20290303000000_card_required_trial.sql
--
-- Card-required 14-day trial, capped at 60 minutes (replaces the no-card Free signup for NEW accounts).
--
-- Idempotent: every statement is safe to re-run. Existing rows are NOT touched
-- (existing free accounts keep their current minutes_included = grandfathered).
--
-- Design notes
--  * profiles.subscription_status has CHECK IN ('active','past_due','suspended'); it is deliberately NOT widened.
--    Trial state lives in its own column `trial_state`, so every existing consumer of subscription_status is unaffected.
--  * Trial usage is metered by profiles.minutes_used_this_month (driven by trg_apply_call_duration_to_usage),
--    which the webhook zeroes when a trial starts and again when it converts to paid.
--  * New signups: minutes_included default becomes 0 => fraud_inbound_allowance() blocks inbound voice until a trial/plan exists.
--
-- Rollback (manual, only if needed):
--   ALTER TABLE public.profiles ALTER COLUMN minutes_included SET DEFAULT 50;
--   (restore the previous bodies of fraud_inbound_allowance / fraud_guard_context from
--    20280403000000_fraud_phase2.sql and 20280402000000_fraud_abuse_prevention.sql)
--   DROP FUNCTION IF EXISTS public.claim_trial(uuid, text, text, text, timestamptz, timestamptz);
--   DROP TABLE IF EXISTS public.trial_claims;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS trial_state, DROP COLUMN IF EXISTS trial_started_at,
--     DROP COLUMN IF EXISTS trial_ends_at, DROP COLUMN IF EXISTS trial_used_at,
--     DROP COLUMN IF EXISTS trial_subscription_id, DROP COLUMN IF EXISTS billing_state_event_at;

-- 1) profile columns ------------------------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trial_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_state_event_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_trial_state_check' AND conrelid = 'public.profiles'::regclass) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_trial_state_check CHECK (trial_state IN ('none', 'trialing', 'ended', 'converted'));
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.trial_state IS
  'none = never in a card trial (or restarted as plain paid); trialing = card trial running or its first invoice still unpaid; ended = trial canceled/expired unpaid; converted = first trial invoice paid.';
COMMENT ON COLUMN public.profiles.trial_used_at IS 'Set once when the account''s single trial starts. Never cleared.';

-- 2) new signups get 0 included minutes (existing rows untouched) -----------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN minutes_included SET DEFAULT 0;

-- 3) one trial per person: account (trial_used_at), normalized email, card fingerprint ------------------------
CREATE TABLE IF NOT EXISTS public.trial_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription_id text NOT NULL,
  email_key text,
  card_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_claims_subscription ON public.trial_claims (subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_claims_user ON public.trial_claims (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_claims_email_key ON public.trial_claims (email_key) WHERE email_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_claims_card ON public.trial_claims (card_fingerprint) WHERE card_fingerprint IS NOT NULL;
ALTER TABLE public.trial_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trial_claims_staff_read ON public.trial_claims;
CREATE POLICY trial_claims_staff_read ON public.trial_claims
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
-- No INSERT/UPDATE/DELETE policies: only the SECURITY DEFINER function below (service role) writes.

-- Atomic, idempotent trial claim. Returns: 'granted' | 'replay' | 'denied_used' | 'denied_email' | 'denied_card' | 'no_profile'
CREATE OR REPLACE FUNCTION public.claim_trial(
  p_user uuid,
  p_subscription_id text,
  p_email_key text,
  p_card_fingerprint text,
  p_trial_start timestamptz,
  p_trial_end timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_used timestamptz;
  v_sub text;
  v_owner uuid;
BEGIN
  IF p_user IS NULL OR p_subscription_id IS NULL OR length(p_subscription_id) = 0 THEN
    RAISE EXCEPTION 'user and subscription required';
  END IF;

  SELECT trial_used_at, trial_subscription_id INTO v_used, v_sub FROM public.profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_profile'; END IF;

  IF v_sub = p_subscription_id THEN RETURN 'replay'; END IF;
  IF v_used IS NOT NULL THEN RETURN 'denied_used'; END IF;

  IF p_email_key IS NOT NULL THEN
    SELECT user_id INTO v_owner FROM public.trial_claims WHERE email_key = p_email_key;
    IF FOUND AND v_owner <> p_user THEN RETURN 'denied_email'; END IF;
  END IF;
  IF p_card_fingerprint IS NOT NULL THEN
    SELECT user_id INTO v_owner FROM public.trial_claims WHERE card_fingerprint = p_card_fingerprint;
    IF FOUND AND v_owner <> p_user THEN RETURN 'denied_card'; END IF;
  END IF;

  BEGIN
    INSERT INTO public.trial_claims (user_id, subscription_id, email_key, card_fingerprint)
    VALUES (p_user, p_subscription_id, p_email_key, p_card_fingerprint);
  EXCEPTION WHEN unique_violation THEN
    RETURN 'denied_used'; -- lost a race with a concurrent claim
  END;

  UPDATE public.profiles
     SET trial_used_at = now(),
         trial_subscription_id = p_subscription_id,
         trial_started_at = COALESCE(p_trial_start, now()),
         trial_ends_at = p_trial_end
   WHERE id = p_user;
  RETURN 'granted';
END;
$$;
REVOKE ALL ON FUNCTION public.claim_trial(uuid, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trial(uuid, text, text, text, timestamptz, timestamptz) TO service_role;

-- 4) inbound allowance: trial branch + blocked ended-trial accounts ---------------------------------------------
-- Existing behaviour is preserved for every account whose trial_state is 'none' or 'converted'.
CREATE OR REPLACE FUNCTION public.fraud_inbound_allowance(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paid boolean;
  v_included integer;
  v_used integer;
  v_mode text;
  v_trial_state text;
  v_status text;
BEGIN
  SELECT (p.stripe_subscription_id IS NOT NULL), p.minutes_included, p.minutes_used_this_month, p.trial_state, p.subscription_status
    INTO v_paid, v_included, v_used, v_trial_state, v_status
    FROM public.profiles p WHERE p.id = p_user;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', true, 'free', false); END IF;  -- unknown profile: never block inbound here

  -- Card trial: hard 60-minute cap (profiles.minutes_included is forced to TRIAL_MINUTES by the webhook).
  IF v_trial_state = 'trialing' THEN
    IF v_status = 'suspended' THEN
      RETURN jsonb_build_object('allowed', false, 'free', true, 'trial', true, 'reason', 'suspended', 'used', v_used, 'included', v_included);
    END IF;
    RETURN jsonb_build_object('allowed', COALESCE(v_used, 0) < COALESCE(v_included, 0), 'free', true, 'trial', true, 'used', v_used, 'included', v_included, 'mode', 'trial');
  END IF;

  -- Canceled / expired trial that never paid: voice stays off until a paid plan is bought.
  IF v_trial_state = 'ended' THEN
    RETURN jsonb_build_object('allowed', false, 'free', true, 'trial', true, 'reason', 'trial_ended', 'used', v_used, 'included', v_included);
  END IF;

  IF v_paid THEN RETURN jsonb_build_object('allowed', true, 'free', false); END IF;

  SELECT free_minutes_mode INTO v_mode FROM public.fraud_settings WHERE id = true;
  IF v_mode = 'lifetime' THEN
    SELECT COALESCE(SUM(CEIL(c.usage_billed_seconds / 60.0)), 0)::integer INTO v_used FROM public.calls c WHERE c.user_id = p_user;
  END IF;
  RETURN jsonb_build_object('allowed', v_used < v_included, 'free', true, 'used', v_used, 'included', v_included, 'mode', v_mode);
END;
$$;

-- 5) fraud caps: a trial is treated as the 'free' tier (PLAN_LIMITS.free) ---------------------------------------
CREATE OR REPLACE FUNCTION public.fraud_guard_context(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'enforce', s.enforce,
    'kill_outbound_calls', s.kill_outbound_calls,
    'kill_sms', s.kill_sms,
    'kill_international', s.kill_international,
    'kill_otp_sms', s.kill_otp_sms,
    'status', CASE WHEN o.status <> 'active' AND o.status_until IS NOT NULL AND o.status_until < now() THEN 'active' ELSE COALESCE(o.status, 'active') END,
    'status_reason', o.status_reason,
    'outbound_unlocked', COALESCE(o.outbound_unlocked, false),
    'international_unlocked', COALESCE(o.international_unlocked, false),
    'voice_clone_unlocked', COALESCE(o.voice_clone_unlocked, false),
    'allowed_countries', COALESCE(o.allowed_countries, '{}'),
    'tz_offset_minutes', COALESCE(o.tz_offset_minutes, 0),
    -- profiles.plan defaults to 'starter' for EVERYONE, so only a real Stripe subscription makes an account paid.
    -- A card trial (trial_state = 'trialing') keeps the chosen plan for features but is capped like 'free'.
    'plan', CASE
              WHEN p.trial_state IN ('trialing', 'ended') THEN 'free'
              WHEN p.stripe_subscription_id IS NOT NULL AND p.subscription_status IN ('active', 'past_due') THEN p.plan
              ELSE 'free'
            END,
    'account_age_days', GREATEST(0, EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400.0)
  ) INTO v
  FROM public.fraud_settings s
  CROSS JOIN public.profiles p
  LEFT JOIN public.fraud_org_state o ON o.user_id = p.id
  WHERE s.id = true AND p.id = p_user;
  RETURN v;
END;
$$;
