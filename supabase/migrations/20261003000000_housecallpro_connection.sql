/*
  # Housecall Pro connection support

  Housecall Pro uses a static per-company API key (Settings → API Keys in
  HCP), not OAuth — simpler than Jobber/ServiceTitan. Reuses the existing
  price_book_connections table for status tracking, even though Housecall
  Pro isn't wired into price-book pull/sync in this phase — only job
  write-back.
*/

ALTER TABLE price_book_connections DROP CONSTRAINT IF EXISTS price_book_connections_provider_check;
ALTER TABLE price_book_connections
  ADD CONSTRAINT price_book_connections_provider_check
  CHECK (provider IN ('service_titan', 'jobber', 'housecall_pro'));

ALTER TABLE price_book_connections
  ADD COLUMN IF NOT EXISTS hcp_api_key text;
