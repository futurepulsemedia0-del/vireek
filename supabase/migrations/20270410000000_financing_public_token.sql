/*
  # Financing offers — public customer page (/financing/:token)

  Adds an unguessable per-offer token and a token-gated read RPC so the
  customer can open a branded status page from the SMS/email link
  without signing in. Same pattern as get_public_service_guarantee:
  SECURITY DEFINER, callable by anon, returns NULL for an unknown token.

  Privacy: the RPC returns only what the customer needs to see. It does
  NOT return email, phone, provider transaction ids, the raw decline
  reason or the job id. The provider's application_url is returned only
  while the customer can still act on it.
*/

ALTER TABLE financing_offers
  ADD COLUMN IF NOT EXISTS public_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_financing_offers_public_token
  ON financing_offers(public_token);

CREATE OR REPLACE FUNCTION public.get_public_financing_offer(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o financing_offers%ROWTYPE;
  v_business text;
  v_service text;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO o FROM financing_offers WHERE public_token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name INTO v_business FROM profiles p WHERE p.id = o.user_id;

  IF o.job_id IS NOT NULL THEN
    SELECT j.service_type INTO v_service FROM jobs j WHERE j.id = o.job_id;
  END IF;

  RETURN jsonb_build_object(
    'business_name', v_business,
    'service_type', v_service,
    'customer_first_name', NULLIF(split_part(btrim(o.customer_name), ' ', 1), ''),
    'status', o.status,
    'requested_amount_cents', o.requested_amount_cents,
    'approved_amount_cents', o.approved_amount_cents,
    'apr_bps', o.apr_bps,
    'term_months', o.term_months,
    'application_url', CASE WHEN o.status IN ('sent', 'clicked', 'applied', 'approved') THEN o.application_url END,
    'created_at', o.created_at,
    'updated_at', o.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_financing_offer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_financing_offer(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_financing_offer(uuid) IS
  'Token-gated public read of one financing offer for the customer-facing /financing/:token page. Returns NULL for an unknown token.';
