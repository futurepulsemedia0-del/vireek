/*
  # Fraud & abuse prevention, phase 2 (additive on 20280402000000)

  - Settlement: fraud_call_events gets event_ref / rate / settlement; fraud_call_attach() links a provider call id,
    fraud_call_finish() records the real duration and REFUNDS the unused worst-case reservation (day + life buckets).
    A call that outlives its reservation is logged as DURATION_OVERRUN (the provider did not enforce the limit).
  - Inbound free-minute hard stop: fraud_inbound_allowance() (mode 'monthly' = the product's current behaviour,
    'lifetime' = strict farming protection). Paid accounts are never blocked here (overage is billed).
  - Marketing gates: consent ledger lookup (consent_records, + new 'marketing_voice' type), per-campaign approval for
    accounts younger than N days, both with a log-only rollout mode.
  - SMS-pumping tickets: otp-request issues a short-lived ticket per (phone) after per-IP/per-phone limits; the Send-SMS
    hook only sends when it can consume a ticket, so calling /auth/v1/otp directly sends nothing.

  ## Security
  All new RPCs are service_role only; new tables have RLS enabled (staff read; writes via service role).
  ## Rollback
  See the bottom (commented). Rollout switches live in fraud_settings: consent_mode, campaign_approval_days, free_minutes_mode.
*/

-- 1) settings -------------------------------------------------------------------------------------------------
ALTER TABLE public.fraud_settings
  ADD COLUMN IF NOT EXISTS consent_mode text NOT NULL DEFAULT 'log' CHECK (consent_mode IN ('off', 'log', 'enforce')),
  ADD COLUMN IF NOT EXISTS campaign_approval_days integer NOT NULL DEFAULT 14 CHECK (campaign_approval_days BETWEEN 0 AND 90),
  ADD COLUMN IF NOT EXISTS free_minutes_mode text NOT NULL DEFAULT 'monthly' CHECK (free_minutes_mode IN ('monthly', 'lifetime'));

-- 2) consent type for voice -----------------------------------------------------------------------------------
ALTER TABLE public.consent_records DROP CONSTRAINT IF EXISTS consent_records_consent_type_check;
ALTER TABLE public.consent_records ADD CONSTRAINT consent_records_consent_type_check
  CHECK (consent_type IN ('call_recording', 'marketing_sms', 'marketing_email', 'data_processing', 'marketing_voice'));

-- 3) call events: settlement columns --------------------------------------------------------------------------
ALTER TABLE public.fraud_call_events
  ADD COLUMN IF NOT EXISTS event_ref uuid,
  ADD COLUMN IF NOT EXISTS rate_cents_per_min integer CHECK (rate_cents_per_min IS NULL OR rate_cents_per_min >= 0),
  ADD COLUMN IF NOT EXISTS reserved_cents integer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fraud_call_events_ref ON public.fraud_call_events (event_ref) WHERE event_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fraud_call_attach(p_ref uuid, p_external_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.fraud_call_events SET external_id = p_external_id
  WHERE event_ref = p_ref AND external_id IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.fraud_call_finish(p_external_id text, p_duration integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e public.fraud_call_events;
  v_actual integer;
  v_refund integer;
BEGIN
  UPDATE public.fraud_call_events SET duration_seconds = GREATEST(0, p_duration)
   WHERE external_id = p_external_id AND duration_seconds IS NULL
   RETURNING * INTO e;
  IF NOT FOUND OR e.rate_cents_per_min IS NULL THEN RETURN; END IF;

  v_actual := CEIL(e.duration_seconds / 60.0)::integer * e.rate_cents_per_min;
  IF v_actual > COALESCE(e.reserved_cents, e.cost_cents) THEN
    INSERT INTO public.fraud_events (user_id, kind, code, source, country, detail)
    VALUES (e.user_id, 'anomaly', 'DURATION_OVERRUN', 'fraud_call_finish', e.country,
            jsonb_build_object('reserved_cents', COALESCE(e.reserved_cents, e.cost_cents), 'actual_cents', v_actual, 'seconds', e.duration_seconds));
    RETURN;
  END IF;
  v_refund := COALESCE(e.reserved_cents, e.cost_cents) - v_actual;
  IF v_refund <= 0 THEN RETURN; END IF;

  UPDATE public.fraud_call_events SET cost_cents = v_actual WHERE id = e.id;
  UPDATE public.fraud_usage SET cost_cents = GREATEST(0, cost_cents - v_refund), updated_at = now()
   WHERE user_id = e.user_id
     AND bucket IN ('day:' || to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 'life');
END;
$$;

-- 4) inbound free-minute hard stop ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fraud_inbound_allowance(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paid boolean;
  v_included integer;
  v_used integer;
  v_mode text;
BEGIN
  SELECT (p.stripe_subscription_id IS NOT NULL), p.minutes_included, p.minutes_used_this_month
    INTO v_paid, v_included, v_used
    FROM public.profiles p WHERE p.id = p_user;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', true, 'free', false); END IF;  -- unknown profile: never block inbound here
  IF v_paid THEN RETURN jsonb_build_object('allowed', true, 'free', false); END IF;

  SELECT free_minutes_mode INTO v_mode FROM public.fraud_settings WHERE id = true;
  IF v_mode = 'lifetime' THEN
    SELECT COALESCE(SUM(CEIL(c.usage_billed_seconds / 60.0)), 0)::integer INTO v_used FROM public.calls c WHERE c.user_id = p_user;
  END IF;
  RETURN jsonb_build_object('allowed', v_used < v_included, 'free', true, 'used', v_used, 'included', v_included, 'mode', v_mode);
END;
$$;

-- 5) marketing gates: consent + campaign approval ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_campaign_approvals (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  campaign text NOT NULL CHECK (char_length(campaign) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid,
  decided_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, campaign)
);
CREATE INDEX IF NOT EXISTS idx_fraud_campaign_approvals_pending ON public.fraud_campaign_approvals (created_at) WHERE status = 'pending';
ALTER TABLE public.fraud_campaign_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fraud_campaign_approvals_staff_read ON public.fraud_campaign_approvals;
CREATE POLICY fraud_campaign_approvals_staff_read ON public.fraud_campaign_approvals
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS fraud_campaign_approvals_owner_read ON public.fraud_campaign_approvals;
CREATE POLICY fraud_campaign_approvals_owner_read ON public.fraud_campaign_approvals
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- One call returns everything the marketing gate needs.
CREATE OR REPLACE FUNCTION public.fraud_marketing_checks(p_user uuid, p_phone text, p_channel text, p_campaign text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_days integer;
  v_mode text;
  v_age_days numeric;
  v_digits text := right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 10);
  v_type text := CASE WHEN p_channel = 'sms' THEN 'marketing_sms' ELSE 'marketing_voice' END;
  v_consent boolean := false;
  v_status text := 'none';
BEGIN
  SELECT consent_mode, campaign_approval_days INTO v_mode, v_days FROM public.fraud_settings WHERE id = true;
  SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0 INTO v_age_days FROM public.profiles WHERE id = p_user;

  -- Latest ledger row per contact decides (grant or revoke); expired grants do not count.
  SELECT (c.granted AND (c.expires_at IS NULL OR c.expires_at > now())) INTO v_consent
    FROM public.consent_records c
   WHERE c.user_id = p_user AND c.consent_type = v_type
     AND right(regexp_replace(COALESCE(c.contact_phone, ''), '\D', '', 'g'), 10) = v_digits AND v_digits <> ''
   ORDER BY c.created_at DESC LIMIT 1;

  IF p_campaign IS NOT NULL THEN
    SELECT status INTO v_status FROM public.fraud_campaign_approvals WHERE user_id = p_user AND campaign = p_campaign;
    v_status := COALESCE(v_status, 'none');
  END IF;
  RETURN jsonb_build_object(
    'consent_mode', v_mode,
    'has_consent', COALESCE(v_consent, false),
    'approval_required', COALESCE(v_age_days, 0) < v_days,
    'campaign_status', v_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fraud_request_campaign_approval(p_user uuid, p_campaign text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.fraud_campaign_approvals (user_id, campaign) VALUES (p_user, left(p_campaign, 80))
  ON CONFLICT (user_id, campaign) DO NOTHING;
$$;

-- 6) OTP tickets -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fraud_otp_tickets (
  phone_hash text PRIMARY KEY,
  ip_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.fraud_otp_tickets ENABLE ROW LEVEL SECURITY;  -- no policies: service role only

CREATE OR REPLACE FUNCTION public.fraud_otp_ticket_issue(p_phone_hash text, p_ip_hash text, p_ttl_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.fraud_otp_tickets (phone_hash, ip_hash, expires_at)
  VALUES (p_phone_hash, p_ip_hash, now() + make_interval(secs => LEAST(GREATEST(p_ttl_seconds, 10), 300)))
  ON CONFLICT (phone_hash) DO UPDATE SET ip_hash = EXCLUDED.ip_hash, expires_at = EXCLUDED.expires_at;
  IF random() < 0.02 THEN DELETE FROM public.fraud_otp_tickets WHERE expires_at < now(); END IF;
END;
$$;

-- Single use: returns true exactly once per issued ticket.
CREATE OR REPLACE FUNCTION public.fraud_otp_ticket_consume(p_phone_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.fraud_otp_tickets WHERE phone_hash = p_phone_hash AND expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- 7) grants -----------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fraud_call_attach(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_call_finish(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_inbound_allowance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_marketing_checks(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_request_campaign_approval(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_otp_ticket_issue(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fraud_otp_ticket_consume(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fraud_call_attach(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_call_finish(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_inbound_allowance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_marketing_checks(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_request_campaign_approval(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_otp_ticket_issue(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fraud_otp_ticket_consume(text) TO service_role;

/* ROLLBACK (manual):
   DROP FUNCTION IF EXISTS public.fraud_call_attach(uuid,text), public.fraud_inbound_allowance(uuid),
     public.fraud_marketing_checks(uuid,text,text,text), public.fraud_request_campaign_approval(uuid,text),
     public.fraud_otp_ticket_issue(text,text,integer), public.fraud_otp_ticket_consume(text);
   DROP TABLE IF EXISTS public.fraud_campaign_approvals, public.fraud_otp_tickets;
   -- fraud_call_finish() reverts by re-running its definition from 20280402000000.
   -- The consent_records constraint may stay (it only adds a value).
*/
