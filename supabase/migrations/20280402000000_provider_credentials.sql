/*
  # Encrypted provider credentials vault

  Third-party credentials (Jobber, ServiceTitan, Housecall Pro, HubSpot, Google) were stored in plaintext:
  price_book_connections.* (service-role only) and integrations.config (browser-readable under the per-user
  SELECT policy). They move to this table, encrypted at the application layer (AES-256-GCM, AAD bound to
  user_id + provider — see supabase/functions/_shared/secrets/credentialVault.ts).

  - RLS enabled with ZERO policies and all grants revoked from anon/authenticated => service role only.
  - ON DELETE CASCADE from auth.users, so account deletion removes every stored credential.
  - Additive only. Plaintext columns are NOT dropped here; they are scrubbed by the runbook SQL after the
    backfill function has run (docs/runbooks/provider-credentials-migration.md).
*/

CREATE TABLE IF NOT EXISTS provider_credentials (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN (
    'jobber', 'service_titan', 'housecall_pro', 'hubspot', 'google_calendar', 'google_business_profile'
  )),
  ciphertext text NOT NULL CHECK (ciphertext LIKE 'v2.%'),
  key_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: default deny for authenticated/anon. Edge functions use the service role.
REVOKE ALL ON provider_credentials FROM anon, authenticated;
COMMENT ON TABLE provider_credentials IS 'AES-256-GCM sealed third-party credentials. Service role only. Never expose via RPC or views.';
