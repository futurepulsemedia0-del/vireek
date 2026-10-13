/*
  # Subscription cancellation flow (/dashboard/billing/cancel)

  ## What this adds
  `subscription_cancellations` — an append-only ledger of every retention-flow
  outcome for an account: cancel scheduled, billing paused, win-back offer
  accepted, or a cancel/pause undone. Each row keeps the exit-survey answer so
  churn reasons can be analysed later without parsing audit text.

  ## Security model
  - The account owner can READ their own rows.
  - There is deliberately NO insert / update / delete policy for any client
    role. Rows are written only by the `manage-subscription-cancellation`
    edge function (service role) AFTER it has changed the subscription in
    Stripe, so a client can never forge or erase retention history.
  - Stripe is the source of truth for the live subscription state; this
    table is history + the "has this account already used its win-back
    offer?" check (one offer per account, enforced server-side).
  - The matching security audit trail goes to `audit_log` (written by the
    same edge function; see 20260831090000_notifications_and_audit_log.sql).

  NOTE: rename the timestamp so this sorts AFTER your newest migration.
*/

CREATE TABLE IF NOT EXISTS subscription_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action text NOT NULL
    CHECK (action IN ('cancel_scheduled', 'paused', 'offer_accepted', 'resumed')),
  reason text
    CHECK (reason IS NULL OR reason IN (
      'too_expensive', 'missing_features', 'not_using', 'switching',
      'closing_business', 'technical_issues', 'other'
    )),
  reason_detail text CHECK (reason_detail IS NULL OR char_length(reason_detail) <= 1000),
  plan text,
  stripe_subscription_id text,
  period_end timestamptz,
  resumes_at timestamptz,
  pause_months smallint CHECK (pause_months IS NULL OR pause_months BETWEEN 1 AND 3),
  offer_coupon_id text,
  offer_percent_off numeric(5, 2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_cancellations_user
  ON subscription_cancellations(user_id, created_at DESC);

-- Fast "already used the win-back offer?" lookup
CREATE INDEX IF NOT EXISTS idx_subscription_cancellations_offer
  ON subscription_cancellations(user_id) WHERE action = 'offer_accepted';

-- Churn-reason reporting for staff
CREATE INDEX IF NOT EXISTS idx_subscription_cancellations_reason
  ON subscription_cancellations(reason, created_at DESC) WHERE reason IS NOT NULL;

ALTER TABLE subscription_cancellations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_subscription_cancellations" ON subscription_cancellations;
CREATE POLICY "select_own_subscription_cancellations" ON subscription_cancellations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "select_staff_subscription_cancellations" ON subscription_cancellations;
CREATE POLICY "select_staff_subscription_cancellations" ON subscription_cancellations
  FOR SELECT TO authenticated USING (is_vireek_staff(auth.uid()));

-- No INSERT / UPDATE / DELETE policies on purpose (service-role writes only).
