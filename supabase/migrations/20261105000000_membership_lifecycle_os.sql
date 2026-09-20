/*
  # Membership / Service Agreement Lifecycle OS

  ## Why
  membership_plans / memberships (20260912030000) is currently just a
  status label (offered/active/cancelled) with no billing cycle, no
  committed-visit tracking, no failed-payment state, and no way to tell
  a voluntary cancel from a silent lapse. This migration turns it into
  a real lifecycle, reusing three systems this project already has
  instead of building parallel ones:

    - Renewal billing rides on payment_requests + Stripe Connect
      Checkout (20260916010000) — the scheduled agent
      (membership-lifecycle-agent) creates a real payment_request and a
      real Stripe Checkout session the exact same way
      create-payment-request does, so it inherits the SAME dunning
      reminders (send-payment-reminders) for free. No parallel Stripe
      Subscriptions object, no second webhook to reconcile.
    - Churn / win-back rides on revenue_recovery_events
      (20260922000000) — two new source_types, same ledger, same
      /dashboard/recovery page.
    - Lifecycle messaging (welcome, visit reminders, renewal notices,
      dunning nudges, save offers, win-back) rides on the Call-to-Cash
      Workflow Engine (20261005000000) — six new trigger_event values,
      matched to six new playbooks shipped as code in
      src/lib/workflowPlaybooks.ts (edit instructions delivered
      alongside this migration).
    - Instant state changes (sold, cancelled) reuse the existing
      public.log_activity_event() trigger factory — no new trigger
      function needed, just two DROP/CREATE TRIGGER statements.

  Time-based conditions (renewal due, grace period expired, visit
  overdue, unused-benefit churn risk) have no row-level event to hang a
  trigger on — same reasoning documented in
  20261004000000_contract_renewal_alerts.sql — so those live in the
  scheduled membership-lifecycle-agent Edge Function instead.

  ## What this does NOT do
  It does not build real Stripe Subscription objects, and it does not
  auto-link a completed job to a membership_visit (no job UI today has
  an "this job fulfills a membership visit" toggle) — membership_visits
  rows are written directly (by the agent, when it books a reminder, or
  by future UI) and the counter trigger below keeps the running total
  correct regardless of what writes them.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy membership-lifecycle-agent --no-verify-jwt
    3. Point your existing external cron at it once daily (renewal
       billing and grace periods are day-granularity, unlike the
       minute-granularity workflow executor).
    4. Apply the five code edits delivered alongside this migration.
*/

-- =============================================================
-- 1. membership_plans — committed visits per billing period
-- =============================================================

ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS visits_included_per_period integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_type text;

-- =============================================================
-- 2. memberships — full lifecycle columns
-- =============================================================

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS visits_included_current_period integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visits_used_current_period integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_request_id uuid REFERENCES payment_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dunning_stage integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_grace_period_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS churn_risk_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renewal_alert_stage text,
  ADD COLUMN IF NOT EXISTS renewal_alert_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS churned_at timestamptz;

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('offered', 'active', 'past_due', 'cancelled', 'churned'));

CREATE INDEX IF NOT EXISTS idx_memberships_renewal_due
  ON memberships(current_period_end) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_memberships_past_due
  ON memberships(payment_grace_period_ends_at) WHERE status = 'past_due';
CREATE INDEX IF NOT EXISTS idx_memberships_customer_id ON memberships(customer_id);

-- Editing the renewal date (manual correction, plan change) should
-- re-arm the renewal alert — exact pattern as
-- reset_contract_renewal_alert_stage() in 20261004000000.
CREATE OR REPLACE FUNCTION public.reset_membership_renewal_alert_stage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_period_end IS DISTINCT FROM OLD.current_period_end THEN
    NEW.renewal_alert_stage := NULL;
    NEW.renewal_alert_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_membership_renewal_alert_stage ON memberships;
CREATE TRIGGER trg_reset_membership_renewal_alert_stage
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION public.reset_membership_renewal_alert_stage();

-- =============================================================
-- 3. membership_visits — committed-visit tracking
-- =============================================================

CREATE TABLE IF NOT EXISTS membership_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'missed')),
  scheduled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_membership_visits_membership ON membership_visits(membership_id);
CREATE INDEX IF NOT EXISTS idx_membership_visits_user_id ON membership_visits(user_id);

ALTER TABLE membership_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_membership_visits" ON membership_visits;
CREATE POLICY "select_own_membership_visits" ON membership_visits FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_membership_visits" ON membership_visits;
CREATE POLICY "insert_own_membership_visits" ON membership_visits FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_membership_visits" ON membership_visits;
CREATE POLICY "update_own_membership_visits" ON membership_visits FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_membership_visits" ON membership_visits;
CREATE POLICY "delete_own_membership_visits" ON membership_visits FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Keeps memberships.visits_used_current_period correct no matter what
-- writes a visit row (dashboard today, job-linkage UI later).
CREATE OR REPLACE FUNCTION public.sync_membership_visit_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'completed')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'completed' AND OLD.status <> 'completed') THEN
    UPDATE memberships SET visits_used_current_period = visits_used_current_period + 1 WHERE id = NEW.membership_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    UPDATE memberships SET visits_used_current_period = GREATEST(0, visits_used_current_period - 1) WHERE id = NEW.membership_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_membership_visit_usage ON membership_visits;
CREATE TRIGGER trg_sync_membership_visit_usage
  AFTER INSERT OR UPDATE OF status ON membership_visits
  FOR EACH ROW EXECUTE FUNCTION public.sync_membership_visit_usage();

-- =============================================================
-- 4. Instant lifecycle events — reuse the existing trigger factory
-- =============================================================

DROP TRIGGER IF EXISTS trigger_log_membership_sold ON memberships;
CREATE TRIGGER trigger_log_membership_sold
  AFTER UPDATE OF status ON memberships
  FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.log_activity_event('membership', 'membership.sold');

DROP TRIGGER IF EXISTS trigger_log_membership_cancelled ON memberships;
CREATE TRIGGER trigger_log_membership_cancelled
  AFTER UPDATE OF status ON memberships
  FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.log_activity_event('membership', 'membership.cancelled');

-- =============================================================
-- 5. Auto-recovery — a membership reactivated after churn/cancel
--    closes its own win-back ledger entry (same idea as
--    close_revenue_recovery_on_quote_accept in 20260922000000).
-- =============================================================

CREATE OR REPLACE FUNCTION public.close_revenue_recovery_on_membership_reactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'active' OR OLD.status NOT IN ('churned', 'cancelled') THEN
    RETURN NEW;
  END IF;

  UPDATE revenue_recovery_events e
  SET status = 'recovered',
      recovery_method = COALESCE(e.recovery_method, 'rebooked'),
      recovered_amount_cents = (
        SELECT price_cents FROM membership_plans WHERE id = NEW.plan_id
      ),
      resolved_at = now()
  WHERE e.source_table = 'memberships' AND e.source_id = NEW.id AND e.status IN ('open', 'contacted');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_revenue_recovery_on_membership_reactivation ON memberships;
CREATE TRIGGER trg_close_revenue_recovery_on_membership_reactivation
  AFTER UPDATE OF status ON memberships
  FOR EACH ROW EXECUTE FUNCTION public.close_revenue_recovery_on_membership_reactivation();

-- =============================================================
-- 6. Extend the shared recovery ledger for churn / win-back
-- =============================================================

ALTER TABLE revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;
ALTER TABLE revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job',
    'quote_financing_stalled', 'quote_accepted_unbooked',
    'job_completed_unbilled', 'invoice_overdue',
    'membership_cancelled', 'membership_churned'
  ));

ALTER TABLE revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_table_check;
ALTER TABLE revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_source_table_check
  CHECK (source_table IN ('calls', 'quotes', 'jobs', 'payment_requests', 'memberships'));

ALTER TABLE revenue_recovery_events DROP CONSTRAINT IF EXISTS revenue_recovery_events_estimated_value_basis_check;
ALTER TABLE revenue_recovery_events ADD CONSTRAINT revenue_recovery_events_estimated_value_basis_check
  CHECK (estimated_value_basis IN ('quote_amount', 'job_invoice', 'price_book_match', 'avg_job_value', 'membership_plan', 'manual', 'none'));

-- =============================================================
-- 7. Extend the shared workflow engine for lifecycle messaging
-- =============================================================

ALTER TABLE workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_trigger_event_check;
ALTER TABLE workflow_definitions ADD CONSTRAINT workflow_definitions_trigger_event_check
  CHECK (trigger_event IN (
    'call.created', 'call.missed', 'call.emergency',
    'lead.created', 'job.created', 'job.completed',
    'quote.sent', 'quote.accepted', 'quote.declined',
    'payment.received', 'review.completed',
    'quote.financing_needed', 'quote.accepted_not_booked',
    'job.completed_not_invoiced', 'invoice.payment_overdue',
    'membership.sold', 'membership.visit_due', 'membership.renewal_upcoming',
    'membership.payment_failed', 'membership.churn_risk', 'membership.churned'
  ));

-- =============================================================
-- 8. Notifications + preference toggle (same pattern as
--    20261004000000_contract_renewal_alerts.sql)
-- ============================================
