/*
  # Smart Payment Collection (Stripe Connect)

  Each business connects its own Stripe account (Connect Express) so
  customer payments land directly with them — Vireek never touches the
  money, same trust model as the Jobber/ServiceTitan connections
  already in this schema.

  payment_requests is deliberately self-contained (stores its own
  customer_phone/customer_email) instead of adding columns to jobs, so
  this migration can't collide with anything already changed on jobs
  in your live project.
*/

CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  stripe_account_id text UNIQUE,
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stripe_connect_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_stripe_connect_account" ON stripe_connect_accounts;
CREATE POLICY "select_own_stripe_connect_account" ON stripe_connect_accounts
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No insert/update/delete policy: this table is only ever written by
-- edge functions using the service role (account creation + the
-- account.updated webhook), never directly by the client.

DROP TRIGGER IF EXISTS trigger_stripe_connect_accounts_updated_at ON stripe_connect_accounts;
CREATE TRIGGER trigger_stripe_connect_accounts_updated_at
  BEFORE UPDATE ON stripe_connect_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text,
  customer_phone text,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'paid', 'failed', 'overdue', 'canceled')),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  payment_link_url text,
  reminder_count integer NOT NULL DEFAULT 0,
  last_reminder_sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_user_id ON payment_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_job_id ON payment_requests(job_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status_reminder ON payment_requests(status, last_reminder_sent_at);

ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_payment_requests" ON payment_requests;
CREATE POLICY "select_own_payment_requests" ON payment_requests
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- Same as above: created/updated only by edge functions (Checkout
-- session creation needs the Stripe secret key, so it can never run
-- client-side) and the payment webhook.

DROP TRIGGER IF EXISTS trigger_payment_requests_updated_at ON payment_requests;
CREATE TRIGGER trigger_payment_requests_updated_at
  BEFORE UPDATE ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
