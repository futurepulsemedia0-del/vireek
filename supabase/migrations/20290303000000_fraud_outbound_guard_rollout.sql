/*
  # Fraud guard: staged rollout switch for customer-driven outbound senders (additive on 20280402/20280403)

  Customer-driven outbound SMS/calls (campaigns, follow-ups, workflows, speed-to-lead, customer notifications,
  power dialer) now pass guardOutbound() before any Twilio / Vapi request. They are governed by a DEDICATED switch so
  the already-live OTP / inbound paths keep using fraud_settings.enforce unchanged:

    outbound_guard_mode = 'shadow'   (DEFAULT)  the guard evaluates everything and logs would-be denials to
                                                fraud_events (detail.shadow = true) but ALLOWS the send.
    outbound_guard_mode = 'enforce'             denials are returned to the caller and nothing reaches the provider.

  The global fraud_settings.enforce = false still forces shadow for everything (master off-switch).

  ## Security
  fraud_guard_context() stays SECURITY DEFINER / service_role only; it only gains one read-only key.
  ## Rollback
  ALTER TABLE public.fraud_settings DROP COLUMN IF EXISTS outbound_guard_mode;
  (then re-apply the previous fraud_guard_context from 20280402000000_fraud_abuse_prevention.sql).
  guard.ts treats a missing key as 'shadow', so an old function body is safe.
  ## Go-live
  1. Deploy, watch:  SELECT code, source, count(*) FROM fraud_events WHERE detail->>'shadow' = 'true' GROUP BY 1,2 ORDER BY 3 DESC;
  2. When the would-block list only contains traffic you agree should be blocked:
     UPDATE public.fraud_settings SET outbound_guard_mode = 'enforce';
*/

ALTER TABLE public.fraud_settings
  ADD COLUMN IF NOT EXISTS outbound_guard_mode text NOT NULL DEFAULT 'shadow'
  CHECK (outbound_guard_mode IN ('shadow', 'enforce'));

CREATE OR REPLACE FUNCTION public.fraud_guard_context(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'enforce', s.enforce,
    'outbound_guard_mode', s.outbound_guard_mode,
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
    -- profiles.plan defaults to 'starter' and subscription_status to 'active' for EVERYONE, so only a real
    -- Stripe subscription makes an account paid. No subscription id => free tier.
    'plan', CASE WHEN p.stripe_subscription_id IS NOT NULL AND p.subscription_status IN ('active', 'past_due') THEN p.plan ELSE 'free' END,
    'account_age_days', GREATEST(0, EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400.0)
  ) INTO v
  FROM public.fraud_settings s
  CROSS JOIN public.profiles p
  LEFT JOIN public.fraud_org_state o ON o.user_id = p.id
  WHERE s.id = true AND p.id = p_user;
  RETURN v;  -- NULL when the profile does not exist: guard.ts treats that as deny
END;
$$;

-- CREATE OR REPLACE keeps existing grants; re-assert them so this file is safe to run on its own.
REVOKE ALL ON FUNCTION public.fraud_guard_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fraud_guard_context(uuid) TO service_role;
