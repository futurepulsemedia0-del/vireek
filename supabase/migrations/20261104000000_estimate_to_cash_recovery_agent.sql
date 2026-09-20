/*
  # Estimate-to-Cash Recovery Agent

  ## Why
  This does NOT build a parallel ledger or a parallel automation engine.
  It extends two systems that already exist and already do exactly this
  job for the earlier stages of the funnel:

    - revenue_recovery_events (20260922000000) is already "a queue of
      money still on the table, ranked, with follow-up tracking." This
      migration just teaches it four new kinds of at-risk moment that
      happen AFTER a quote is sent: stuck waiting on financing, accepted
      but never booked, completed but never invoiced, invoiced but
      unpaid past the collection window.
    - workflow_definitions / business_activity_events (20261005000000)
      is already "event -> enrolled playbook -> sms/call/wait/
      human_approval/webhook steps." This migration just widens
      trigger_event so four new playbooks (shipped as code in
      src/lib/workflowPlaybooks.ts, see the edit instructions delivered
      alongside this migration) can enroll against these new moments.

  Detection itself is NOT trigger-based (these are time-based conditions
  — "stalled for 72 hours" — which a row-level trigger cannot see), so
  it lives in a new scheduled Edge Function, estimate-recovery-agent,
  which writes into these two systems using the service role (same
  security posture as every other cron function in this project: no
  client INSERT policy on revenue_recovery_events, so a compromised
  client session still cannot fabricate a recovery entry).

  Auto-resolution is free: close_revenue_recovery_on_payment() already
  closes ANY open ledger entry for a lead once invoice_status hits
  'paid', and close_revenue_recovery_on_quote_accept() already closes
  any entry with source_table = 'quotes' once that quote is accepted.
  Both are reused as-is for the four new source_types below.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy estimate-recovery-agent --no-verify-jwt
    3. Point your existing external cron (the one already hitting
       workflow-engine-executor / followup-agent-dispatcher) at
       estimate-recovery-agent too, every 15-30 minutes, same
       X-Cron-Secret header / CRON_SECRET value.
    4. Apply the four code edits delivered alongside this migration
       (src/lib/revenueRecovery.ts, src/lib/workflowEngine.ts,
       src/lib/workflowPlaybooks.ts, supabase/functions/
       workflow-engine-executor/index.ts).
*/

-- =============================================================
-- 1. Four new at-risk moments in the existing recovery ledger
-- =============================================================

ALTER TABLE revenue_recovery_events
  DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_type_check;

ALTER TABLE revenue_recovery_events
  ADD CONSTRAINT revenue_recovery_events_source_type_check
  CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job',
    -- new: post-acceptance, estimate-to-cash pipeline risk
    'quote_financing_stalled',   -- sent, high-value, no response, financing never offered
    'quote_accepted_unbooked',   -- accepted, but no job ever got scheduled
    'job_completed_unbilled',    -- completed, but invoice was never sent
    'invoice_overdue'            -- invoiced, but unpaid past the collection window
  ));

ALTER TABLE revenue_recovery_events
  DROP CONSTRAINT IF EXISTS revenue_recovery_events_source_table_check;

ALTER TABLE revenue_recovery_events
  ADD CONSTRAINT revenue_recovery_events_source_table_check
  CHECK (source_table IN ('calls', 'quotes', 'jobs', 'payment_requests'));

-- =============================================================
-- 2. Four new trigger events the workflow engine can enroll against
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
    -- new: estimate-to-cash recovery agent
    'quote.financing_needed',
    'quote.accepted_not_booked',
    'job.completed_not_invoiced',
    'invoice.payment_overdue'
  ));
