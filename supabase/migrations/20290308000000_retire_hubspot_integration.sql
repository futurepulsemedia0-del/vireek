/*
  # Retire the HubSpot OAuth stub

  Decision (from code usage): no function ever read the stored HubSpot tokens (only hubspot-oauth-start/-callback
  referenced HubSpot), there is no sync, refresh, webhook or uninstall path, and the public copy claimed behaviour
  that does not exist. This migration removes the data the stub collected:
    - sealed tokens in provider_credentials (provider = 'hubspot')
    - connection rows in integrations (integration_type = 'hubspot')
  Idempotent; safe to re-run. The 'hubspot' value stays allowed by provider_credentials' CHECK constraint on purpose
  (dropping it would need a table rewrite for no benefit).

  NOTE: this deletes Vireek's copy of the tokens only. Customers who authorised the app can still remove it in
  HubSpot (Settings > Integrations > Connected apps). Remote revocation is not performed [VERIFY endpoint before adding].
*/
DO $$
BEGIN
  IF to_regclass('public.provider_credentials') IS NOT NULL THEN
    DELETE FROM public.provider_credentials WHERE provider = 'hubspot';
  END IF;
  IF to_regclass('public.integrations') IS NOT NULL THEN
    DELETE FROM public.integrations WHERE integration_type = 'hubspot';
  END IF;
END
$$;
