/*
  # Real Financing / BNPL Integration

  Lets a business offer point-of-sale financing (Buy Now, Pay Later) on
  a job's invoice — the customer applies through the provider's hosted
  flow, and once approved the business gets paid without waiting on the
  customer's own cash flow. Same trust model as Stripe Connect: Vireek
  never touches the loan or the money, only tracks status.

  ## Provider model
  Unlike Stripe Connect (OAuth per business) or ServiceTitan/Jobber
  (per-business API credentials), BNPL partners like Wisetack work as a
  software-partner marketplace: Vireek holds ONE partner API key
  (WISETACK_API_KEY, an edge function secret — never in this schema),
  and each business is enrolled under it, getting back an
  external_merchant_id. That's why financing_connections has no
  secret/token columns — there's nothing per-business to store except
  the enrollment status.

  ## Tables
  - financing_connections   — per-account enrollment status with a
                               given BNPL provider
  - financing_offers        — one row per financing offer sent to a
                               customer for a specific job
  - financing_offer_events  — append-only webhook event ledger per
                               offer (mirrors the audit-trail pattern
                               used by inventory_transactions)

  ## Access model
  Same as payment_requests / stripe_connect_accounts: SELECT is open to
  the account (user_id = get_account_owner_id()); INSERT/UPDATE only
  ever happen from edge functions using the service role, because
  creating an offer needs the platform's BNPL secret key and updating
  one only ever happens from a signed provider webhook.
*/

-- =============================================================
-- FINANCING_CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS financing_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'wisetack' CHECK (provider IN ('wisetack')),
  external_merchant_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_financing_connections_user_id ON financing_connections(user_id);

ALTER TABLE financing_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_financing_connections" ON financing_connections;
CREATE POLICY "select_own_financing_connections" ON financing_connections
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No insert/update/delete policy — written only by service-role edge
-- functions (enrollment + the connection-status webhook).

DROP TRIGGER IF EXISTS trigger_financing_connections_updated_at ON financing_connections;
CREATE TRIGGER trigger_financing_connections_updated_at
  BEFORE UPDATE ON financing_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- FINANCING_OFFERS
-- =============================================================

CREATE TABLE IF NOT EXISTS financing_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'wisetack' CHECK (provider IN ('wisetack')),
  external_transaction_id text,
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,
  requested_amount_cents integer NOT NULL CHECK (requested_amount_cents > 0),
  approved_amount_cents integer,
  apr_bps integer, -- annual percentage rate in basis points (e.g. 999 = 9.99%), set once approved
  term_months integer,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'sent', 'clicked', 'applied', 'approved', 'declined', 'expired', 'loan_confirmed', 'funded', 'canceled')),
  application_url text,
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  funded_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_financing_offers_user_id ON financing_offers(user_id);
CREATE INDEX IF NOT EXISTS idx_financing_offers_job_id ON financing_offers(job_id);
CREATE INDEX IF NOT EXISTS idx_financing_offers_external_transaction ON financing_offers(external_transaction_id) WHERE external_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financing_offers_status ON financing_offers(status);

ALTER TABLE financing_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_financing_offers" ON financing_offers;
CREATE POLICY "select_own_financing_offers" ON financing_offers
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Same as payment_requests: created only by financing-create-offer,
-- updated only by financing-webhook — both service-role, never direct
-- client writes (the platform's BNPL secret can't live client-side).

DROP TRIGGER IF EXISTS trigger_financing_offers_updated_at ON financing_offers;
CREATE TRIGGER trigger_financing_offers_updated_at
  BEFORE UPDATE ON financing_offers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- FINANCING_OFFER_EVENTS  (append-only webhook ledger)
-- =============================================================

CREATE TABLE IF NOT EXISTS financing_offer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES financing_offers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financing_offer_events_offer_id ON financing_offer_events(offer_id);
CREATE INDEX IF NOT EXISTS idx_financing_offer_events_user_id ON financing_offer_events(user_id);

ALTER TABLE financing_offer_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_financing_offer_events" ON financing_offer_events;
CREATE POLICY "select_own_financing_offer_events" ON financing_offer_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Insert only from financing-webhook (service role) — this is an audit
-- trail, never written by the client.

COMMENT ON TABLE financing_offers IS
  'One row per BNPL financing offer sent to a customer for a job. Vireek never holds the loan or the funds — this only tracks status through the provider''s hosted application flow.';
COMMENT ON TABLE financing_offer_events IS
  'Append-only raw webhook events per financing offer, for audit/debugging — mirrors the inventory_transactions ledger pattern used elsewhere in this schema.';
