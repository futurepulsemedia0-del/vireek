/*
  # Live Price Book — external CRM sync (ServiceTitan / Jobber)

  - price_book_items: add source tracking so rows pulled from a connected
    CRM are distinguishable from ones the business typed in by hand, and
    can be safely re-synced without duplicating or clobbering manual entries.
  - price_book_connections: per-tenant CRM credentials. RLS is intentionally
    LOCKED for the `authenticated` role (zero policies = default deny) —
    these rows hold API secrets and must only ever be touched by edge
    functions running with the service-role key, never read/written
    directly from the browser. The dashboard reads connection *status*
    through the SECURITY DEFINER function below instead, which returns
    nothing sensitive.
*/

ALTER TABLE price_book_items
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'service_titan', 'jobber')),
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_book_items_external
  ON price_book_items(user_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_book_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  provider text NOT NULL CHECK (provider IN ('service_titan', 'jobber')),
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'error', 'disconnected')),

  st_client_id text,
  st_client_secret text,
  st_app_key text,
  st_tenant_id text,

  jobber_access_token text,
  jobber_refresh_token text,
  jobber_token_expires_at timestamptz,

  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, provider)
);

ALTER TABLE price_book_connections ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies here for `authenticated` — locked to service-role only.

CREATE OR REPLACE FUNCTION set_price_book_connections_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_price_book_connections_updated_at ON price_book_connections;
CREATE TRIGGER trg_price_book_connections_updated_at
  BEFORE UPDATE ON price_book_connections
  FOR EACH ROW EXECUTE FUNCTION set_price_book_connections_updated_at();

CREATE OR REPLACE FUNCTION get_price_book_connections()
RETURNS TABLE (
  provider text,
  status text,
  last_synced_at timestamptz,
  last_sync_error text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT provider, status, last_synced_at, last_sync_error
  FROM price_book_connections
  WHERE user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION get_price_book_connections() TO authenticated;
