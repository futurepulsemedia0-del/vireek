/*
  # Revenue Leakage Auditor — the two remaining gaps

  ## Why
  Does NOT create a parallel ledger. Extends the same
  revenue_recovery_events + workflow_definitions system that already
  covers missed calls, stalled quotes, unbilled jobs, and overdue
  invoices (20260922000000 + 20261104000000 + 20261105000000).

  Two new source_types:
    - job_parts_unbilled: a completed, already-invoiced job whose
      billed amount doesn't cover the retail value of the parts that
      were actually installed on it (job_parts_required.status =
      'installed'). Detection + the actual math live in the edge
      function (estimate-recovery-agent), same as every other
      source_type here — this migration only widens what the CHECK
      constraints allow.
    - payment_failed: a payment_requests row whose charge attempt came
      back status = 'failed' — distinct from invoice_overdue (which
      only fires after a 14-day silent window), because a declined
      card needs a same-day nudge, not a two-week wait.

  ## Deploy order
    1. Run this migration.
    2. Apply the code edits (estimate-recovery-agent/index.ts,
       src/lib/revenueRecovery.ts, src/lib/workflowEngine.ts,
       src/lib/workflowPlaybooks.ts).
    3. supabase functions deploy estimate-recovery-agent --no-verify-jwt
*/

ALTER TABLE revenue_recovery_events
  DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;

ALTER TABLE revenue_recovery_events
  ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job',
    'quote_financing_stalled', 'quote_accepted_unbooked',
    'job_completed_unbilled', 'invoice_overdue',
    'membership_cancelled', 'membership_churned',
    -- new: revenue leakage auditor
    'job_parts_unbilled',
    'payment_failed'
  ));

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
    -- new: revenue leakage auditor
    'job.parts_unbilled',
    'invoice.payment_failed'
  ));
