/*
# Dunning management — track failed-payment state so the dashboard can warn
customers and prompt them to update their card *before* their account is
suspended, instead of finding out when Sarah suddenly stops answering calls.

## What this migration does

Adds to `profiles`:
- `subscription_status` — mirrors where the Stripe subscription is in the
  dunning lifecycle: `active` (default) -> `past_due` (a Stripe invoice just
  failed, retries are in progress) -> `suspended` (grace period ran out with
  no successful payment). Kept separate from the existing `status` column
  (which also has a `suspended` value used for manual/admin suspension)
  because dunning needs its own finer-grained state machine; when dunning
  reaches `suspended` we also set `status = 'suspended'` so any existing or
  future code gating access on `status` keeps working unchanged.
- `dunning_stage` — how many `invoice.payment_failed` webhooks have fired
  for the current failure streak. Drives which escalation email gets sent
  (see `stripe-webhook`) without needing to look up Stripe's own retry
  count.
- `payment_failed_at` — timestamp of the *first* failure in the current
  streak. Used to compute "day 3 of 7" style copy in emails/banner.
- `payment_grace_period_ends_at` — the hard deadline. Set on the first
  failure and never pushed further out by subsequent retries; only cleared
  entirely on a successful payment. `enforce-payment-suspension` flips the
  account to `suspended` once `now() > payment_grace_period_ends_at`.
- `last_payment_error` — human-readable decline reason from Stripe (e.g.
  "Your card was declined."), shown in the banner/email so the customer
  knows what to fix.

Adds `billing_events`: an append-only audit/idempotency log of every Stripe
webhook event processed. Stripe fans out retries and duplicate deliveries by
design, so every webhook handler needs some form of "have I already seen
this event id" check — an `insert ... on conflict do nothing` against this
table is that check, and doubles as a support/debugging trail.

## Security
- `billing_events`: RLS enabled, owner can SELECT their own rows only. All
  writes come from the service-role key inside edge functions (bypasses
  RLS), so no INSERT/UPDATE policy is defined.
- `profiles`: no new policy needed — the new columns are covered by the
  existing `select_own_profile` policy for reads; writes happen only from
  the service-role key inside `stripe-webhook` / `enforce-payment-suspension`.
*/

CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_events_user_id_idx ON billing_events(user_id);
CREATE INDEX IF NOT EXISTS billing_events_created_at_idx ON billing_events(created_at DESC);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_billing_events" ON billing_events;
CREATE POLICY "select_own_billing_events"
  ON billing_events FOR SELECT
  USING (auth.uid() = user_id);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('active', 'past_due', 'suspended')),
  ADD COLUMN IF NOT EXISTS dunning_stage integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_grace_period_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_payment_error text;
