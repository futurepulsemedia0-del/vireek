/*
  # Service Recovery & Complaint Prevention Agent

  ## Why
  This does NOT build a parallel ledger. It follows the exact pattern
  already used by revenue_recovery_events (20260922000000) and the
  estimate-to-cash recovery agent (20261104000000): a dedicated queue
  table for one class of at-risk moment, populated by a scheduled Edge
  Function using the service role, closed automatically by triggers,
  and wired into the existing workflow_definitions / business_activity_events
  playbook engine so the actual customer-facing action (apology SMS,
  manager call, escalation) is defined as data in
  src/lib/workflowPlaybooks.ts — not hardcoded in this migration.

  ## What creates a signal (via the service-recovery-agent cron function)
  - eta_missed          — job is 'en_route', eta_minutes/eta_set_at was
                           set, and now() is past that promised window.
  - technician_delayed  — job is still 'scheduled' well past
                           scheduled_datetime (technician hasn't even
                           left yet).
  - negative_sentiment  — a call linked to a job comes back with
                           calls.sentiment = 'negative'.
  - customer_dispute    — staff (or a future customer-portal action)
                           flags jobs.customer_disputed = true.

  ## What closes a signal (automatic)
  - A review_requests row for the same job gets rating >= 4 (the
    relationship was recovered) closes any open signal for that job.
  - jobs.customer_disputed flipping back to false closes any open
    'customer_dispute' signal for that job.

  ## Security
  Same posture as revenue_recovery_events: RLS keyed to
  get_account_owner_id(). No client INSERT policy — signals are
  created exclusively by the service-recovery-agent Edge Function
  (service role), so a compromised client session cannot fabricate or
  erase one. Staff can UPDATE (resolve/escalate/ignore) rows they own.

  ## IMPORTANT — read before applying
  Section 3 below (workflow_definitions_trigger_event_check) DROPS and
  RE-ADDS a CHECK constraint. The IN (...) list below reflects every
  trigger_event value found across this project's migrations up to
  20261125000000_ai_ops_evaluation_cost.sql. If you've added more
  workflows/trigger events in Supabase since generating the zip you
  gave me, open your current constraint definition first
  (Table Editor → workflow_definitions → constraints, or
  `\d workflow_definitions` in SQL) and merge any missing values into
  this list before running — otherwise this migration will silently
  narrow your allowed trigger_event values.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy service-recovery-agent --no-verify-jwt
    3. Point your existing external cron (the one already hitting
       workflow-engine-executor / estimate-recovery-agent) at
       service-recovery-agent too, every 10-15 minutes (this is a
       complaint-prevention agent — it should run tighter than the
       revenue agents), same X-Cron-Secret header / CRON_SECRET value.
    4. Apply the four code edits delivered alongside this migration.
*/

-- =============================================================
-- 1. Dispute flag on jobs (staff-set, same trust model as every
--    other manual field on this table — invoice_amount, eta_minutes)
-- =============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS customer_disputed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_disputed_note text,
  ADD COLUMN IF NOT EXISTS customer_disputed_at timestamptz;

-- =============================================================
-- 2. The signal queue
-- =============================================================

CREATE TABLE IF NOT EXISTS service_recovery_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  signal_type text NOT NULL CHECK (signal_type IN (
    'eta_missed', 'technician_delayed', 'negative_sentiment', 'customer_dispute'
  )),
  source_table text NOT NULL CHECK (source_table IN ('jobs', 'calls')),
  source_id uuid NOT NULL,

  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,

  customer_name text NOT NULL DEFAULT 'Unknown customer',
  customer_phone text,

  severity_score smallint NOT NULL DEFAULT 50 CHECK (severity_score BETWEEN 0 AND 100),
  detail text,

  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'playbook_enrolled', 'escalated', 'resolved', 'ignored'
  )),

  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_table, source_id, signal_type)
);

CREATE INDEX IF NOT EXISTS idx_service_recovery_user_id ON service_recovery_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_service_recovery_status ON service_recovery_signals(status);
CREATE INDEX IF NOT EXISTS idx_service_recovery_detected_at ON service_recovery_signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_recovery_job_id ON service_recovery_signals(job_id);

ALTER TABLE service_recovery_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_recovery_signals" ON service_recovery_signals;
CREATE POLICY "select_own_service_recovery_signals"
ON service_recovery_signals FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_service_recovery_signals" ON service_recovery_signals;
CREATE POLICY "update_own_service_recovery_signals"
ON service_recovery_signals FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

-- No INSERT policy for `authenticated` on purpose — only the
-- service-recovery-agent Edge Function (service role) creates rows.

-- =============================================================
-- 3. Four new trigger events the workflow engine can enroll against
-- =============================================================

ALTER TABLE workflow_definitions
  DROP CONSTRAINT IF EXISTS workflow_definitions_trigger_event_check;

ALTER TABLE workflow_definitions
  ADD CONSTRAINT workflow_definitions_trigger_event_check
  CHECK (trigger_event IN (
    'call.created', 'call.missed', 'call.emergency',
    'lead.created', 'job.created', 'job.completed',
    'quote.sent', 'quote.accepted', 'quote.declined',
    'payment.received', 'review.completed',
    'quote.financing_needed', 'quote.accepted_not_booked',
    'job.completed_not_invoiced', 'invoice.payment_overdue',
    'membership.sold', 'membership.visit_due', 'membership.renewal_upcoming',
    'membership.payment_failed', 'membership.churn_risk', 'membership.churned',
    -- new: service recovery & complaint prevention agent
    'job.eta_missed', 'job.technician_delayed',
    'call.negative_sentiment', 'job.customer_disputed'
  ));

-- =============================================================
-- 4. Auto-resolution
-- =============================================================

CREATE OR REPLACE FUNCTION public.close_service_recovery_on_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.rating IS NOT NULL AND NEW.rating >= 4 AND NEW.job_id IS NOT NULL
     AND (OLD.rating IS NULL OR OLD.rating < 4) THEN
    UPDATE service_recovery_signals
    SET status = 'resolved',
        resolved_at = now(),
        resolution_note = COALESCE(resolution_note, 'Auto-resolved: customer left a ' || NEW.rating || '-star review after recovery outreach.')
    WHERE job_id = NEW.job_id
      AND status IN ('open', 'playbook_enrolled', 'escalated');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_service_recovery_on_review ON review_requests;
CREATE TRIGGER trg_close_service_recovery_on_review
AFTER UPDATE OF rating ON review_requests
FOR EACH ROW
EXECUTE FUNCTION public.close_service_recovery_on_review();

CREATE OR REPLACE FUNCTION public.close_service_recovery_on_dispute_cleared()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.customer_disputed = false AND OLD.customer_disputed = true THEN
    UPDATE service_recovery_signals
    SET status = 'resolved',
        resolved_at = now(),
        resolution_note = COALESCE(resolution_note, 'Auto-resolved: dispute flag cleared by staff.')
    WHERE job_id = NEW.id
      AND signal_type = 'customer_dispute'
      AND status IN ('open', 'playbook_enrolled', 'escalated');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_service_recovery_on_dispute_cleared ON jobs;
CREATE TRIGGER trg_close_service_recovery_on_dispute_cleared
AFTER UPDATE OF customer_disputed ON jobs
FOR EACH ROW
EXECUTE FUNCTION public.close_service_recovery_on_dispute_cleared();
