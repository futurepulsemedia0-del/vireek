/*
  # Merchants eligible for the Google Appointments Redirect feeds

  Returns ONE jsonb array of merchants for the Entity/Action feeds. A merchant is included only if ALL hold:
    - the owner turned the Google feed on (google_booking_settings.feed_enabled)
    - partner_status is 'sandbox' or 'approved' (never publish before Google onboards you)
    - online booking is enabled and a booking slug exists
    - a company name exists
    - there is an ACTIVE, non-archived PRIMARY location (name/phone/address come from business_locations)
  Address completeness is validated in code (feeds.ts), which reports rejected merchants and reasons.
  Service role only: contains business contact data for every tenant.
*/

CREATE OR REPLACE FUNCTION public.get_google_redirect_merchants()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'user_id', bp.user_id,
    'slug', bp.booking_slug,
    'name', btrim(p.company_name),
    'phone', bl.phone,
    'address_line1', bl.address_line1,
    'address_line2', bl.address_line2,
    'city', bl.city,
    'state', bl.state,
    'postal_code', bl.postal_code,
    'country', bl.country
  ) ORDER BY bp.user_id), '[]'::jsonb)
  FROM google_booking_settings gs
  JOIN business_profile bp ON bp.user_id = gs.user_id
  JOIN profiles p ON p.id = bp.user_id
  JOIN business_locations bl ON bl.user_id = bp.user_id AND bl.is_primary AND bl.status = 'active' AND bl.archived_at IS NULL
  WHERE gs.feed_enabled
    AND gs.partner_status IN ('sandbox', 'approved')
    AND coalesce(bp.booking_enabled, false)
    AND bp.booking_slug IS NOT NULL
    AND btrim(coalesce(p.company_name, '')) <> '';
$$;

REVOKE ALL ON FUNCTION public.get_google_redirect_merchants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_google_redirect_merchants() TO service_role;
