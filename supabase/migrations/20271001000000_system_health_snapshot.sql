/*
  # System health snapshot (Overview health strip)

  One read-only, tenant-scoped RPC that reports REAL state for: voice AI,
  phone numbers, SMS / A2P, Stripe, Google Calendar, QuickBooks and webhooks.
  SECURITY DEFINER so team members get the same account-level answer as the
  owner regardless of per-table RLS; it only ever reads rows belonging to
  public.get_account_owner_id(). Nothing is written.
*/

CREATE OR REPLACE FUNCTION public.get_system_health_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_assistant boolean := false;
  v_vapi_phone boolean := false;
  v_calls_7d integer := 0;
  v_last_call timestamptz;
  v_total integer := 0;
  v_active integer := 0;
  v_active_voice integer := 0;
  v_active_sms integer := 0;
  v_pending integer := 0;
  v_porting integer := 0;
  v_has_customer boolean := false;
  v_sub_status text := 'active';
  v_grace timestamptz;
  v_pay_error text;
  v_brand text := 'not_started';
  v_campaign text := 'not_started';
  v_a2p_reason text;
  v_connect_exists boolean := false;
  v_charges boolean := false;
  v_payouts boolean := false;
  v_details boolean := false;
  v_integrations jsonb := '{}'::jsonb;
  v_ep_active integer := 0;
  v_ep_failing integer := 0;
  v_deliveries integer := 0;
  v_errors integer := 0;
  v_last_err_at timestamptz;
  v_last_err_msg text;
BEGIN
  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT (bp.vapi_assistant_id IS NOT NULL), (bp.vapi_phone_number_id IS NOT NULL)
    INTO v_assistant, v_vapi_phone
    FROM business_profile bp WHERE bp.user_id = v_owner;
  v_assistant := COALESCE(v_assistant, false);
  v_vapi_phone := COALESCE(v_vapi_phone, false);

  SELECT count(*) FILTER (WHERE c.call_datetime >= now() - interval '7 days'), max(c.call_datetime)
    INTO v_calls_7d, v_last_call
    FROM calls c WHERE c.user_id = v_owner;

  SELECT count(*) FILTER (WHERE p.status <> 'released'),
         count(*) FILTER (WHERE p.status = 'active'),
         count(*) FILTER (WHERE p.status = 'active' AND p.voice_enabled),
         count(*) FILTER (WHERE p.status = 'active' AND p.sms_enabled),
         count(*) FILTER (WHERE p.status = 'pending'),
         count(*) FILTER (WHERE p.status IN ('porting_in', 'porting_out'))
    INTO v_total, v_active, v_active_voice, v_active_sms, v_pending, v_porting
    FROM phone_numbers p WHERE p.account_id = v_owner;

  SELECT (pr.stripe_customer_id IS NOT NULL), COALESCE(pr.subscription_status, 'active'),
         pr.payment_grace_period_ends_at, pr.last_payment_error,
         COALESCE(pr.a2p_brand_status, 'not_started'), COALESCE(pr.a2p_campaign_status, 'not_started'),
         pr.a2p_rejection_reason
    INTO v_has_customer, v_sub_status, v_grace, v_pay_error, v_brand, v_campaign, v_a2p_reason
    FROM profiles pr WHERE pr.id = v_owner;

  SELECT true, s.charges_enabled, s.payouts_enabled, s.details_submitted
    INTO v_connect_exists, v_charges, v_payouts, v_details
    FROM stripe_connect_accounts s WHERE s.user_id = v_owner;
  v_connect_exists := COALESCE(v_connect_exists, false);
  v_charges := COALESCE(v_charges, false);
  v_payouts := COALESCE(v_payouts, false);
  v_details := COALESCE(v_details, false);

  SELECT COALESCE(jsonb_object_agg(i.integration_type, jsonb_build_object(
           'status', i.status,
           'error_code', i.config ->> 'error_code',
           'error_message', COALESCE(i.config ->> 'error_message', i.config ->> 'last_error'))), '{}'::jsonb)
    INTO v_integrations
    FROM integrations i
    WHERE i.user_id = v_owner AND i.integration_type IN ('google_calendar', 'quickbooks', 'webhook');

  SELECT count(*) FILTER (WHERE w.status = 'active'),
         count(*) FILTER (WHERE w.status = 'active' AND w.last_delivery_status = 'error')
    INTO v_ep_active, v_ep_failing
    FROM webhook_endpoints w WHERE w.user_id = v_owner;

  SELECT count(*), count(*) FILTER (WHERE l.status = 'error')
    INTO v_deliveries, v_errors
    FROM webhook_logs l WHERE l.user_id = v_owner AND l.created_at >= now() - interval '24 hours';

  SELECT l.created_at, l.error_message INTO v_last_err_at, v_last_err_msg
    FROM webhook_logs l
    WHERE l.user_id = v_owner AND l.status = 'error' AND l.created_at >= now() - interval '24 hours'
    ORDER BY l.created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'voice', jsonb_build_object(
      'assistant_linked', v_assistant OR v_vapi_phone,
      'calls_7d', v_calls_7d,
      'last_call_at', v_last_call),
    'phone', jsonb_build_object(
      'total', v_total, 'active', v_active, 'active_voice', v_active_voice,
      'pending', v_pending, 'porting', v_porting),
    'sms', jsonb_build_object(
      'active_sms_numbers', v_active_sms, 'brand_status', v_brand,
      'campaign_status', v_campaign, 'rejection_reason', v_a2p_reason),
    'stripe', jsonb_build_object(
      'has_customer', v_has_customer, 'subscription_status', v_sub_status,
      'grace_ends_at', v_grace, 'last_payment_error', v_pay_error,
      'connect', jsonb_build_object(
        'exists', v_connect_exists, 'charges_enabled', v_charges,
        'payouts_enabled', v_payouts, 'details_submitted', v_details)),
    'integrations', v_integrations,
    'webhooks', jsonb_build_object(
      'endpoints_active', v_ep_active, 'endpoints_failing', v_ep_failing,
      'deliveries_24h', v_deliveries, 'errors_24h', v_errors,
      'last_error_at', v_last_err_at, 'last_error_message', v_last_err_msg)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_system_health_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_system_health_snapshot() TO authenticated;
