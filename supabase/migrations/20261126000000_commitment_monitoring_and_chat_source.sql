/*
  # Commitment Graph — Chat source + Monitoring/Escalation

  ## Why
  The Commitment Graph (20261125000000_commitment_graph.sql) already turns
  Voice (calls.transcript), SMS (outbound_sms), Quotes and Technician Notes
  (jobs.notes, owner_type='technician') into tracked commitments with a
  trust ledger. Two things were still missing for a complete Promise
  Management System:

    1. Chat as a fourth source — outbound WhatsApp/Instagram DM replies
       (dm_messages, direction='outbound') were never scanned.
    2. Nothing watched deadlines. A commitment could go overdue forever
       with no alert — there was no monitoring/escalation loop, only a
       manual Trust Score read at page-load time.

  This migration closes both gaps without touching the existing `promises`
  table/AI pipeline (calls.transcript) or PromiseTrackerPage — that stays
  exactly as-is, running in parallel; commitments already gets its own
  independent, rule-based read of the same calls via trg_extract_from_call.

  ## What this adds
  - 'chat' added to commitments.source_type.
  - trg_extract_from_dm_message: scans outbound WhatsApp/Instagram DM
    replies the same way SMS already is.
  - escalation_stage / escalation_alert_sent_at on commitments — same
    staged-alert pattern as commercial_contracts.renewal_alert_stage
    (20261004000000_contract_renewal_alerts.sql), so the scheduled
    commitment-monitor-tick function never re-alerts the same stage twice.
  - notify_commitment_escalation on profiles (default true), commitment_id
    on notifications — same pattern as notify_contract_renewal/contract_id.
  - Reset trigger: editing the deadline, or reopening a resolved
    commitment back to 'open', clears the stage so monitoring re-evaluates
    it from scratch instead of staying silent.

  ## What this does NOT do
  No DB trigger flips escalation_stage on its own — same as the contract
  renewal design, that write happens inside
  supabase/functions/commitment-monitor-tick (service-role key), because
  "has this become overdue" is a function of wall-clock time passing, not
  a row event. Wire up the schedule once pg_cron is enabled:

    select cron.schedule(
      'commitment-monitor-tick',
      '*/15 * * * *', -- every 15 minutes
      $$
      select net.http_post(
        url := '<your-project-ref>.supabase.co/functions/v1/commitment-monitor-tick',
        headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
      );
      $$
    );

  Until then, trigger it from Supabase's Scheduled Functions UI or any
  external cron that can hit the function's URL every 10-15 minutes.
*/

-- =============================================================
-- 1. Chat as a commitment source
-- =============================================================
ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_source_type_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_source_type_check
  CHECK (source_type IN ('call', 'sms', 'quote', 'job_note', 'manual', 'chat'));

CREATE OR REPLACE FUNCTION public.trg_extract_from_dm_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_conv record;
BEGIN
  IF NEW.direction <> 'outbound' THEN RETURN NEW; END IF;

  SELECT user_id, channel, customer_name, customer_external_id
  INTO v_conv
  FROM dm_conversations WHERE id = NEW.conversation_id;

  IF v_conv.user_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public.extract_commitments(
    v_conv.user_id, 'chat', NEW.id, NEW.body, NEW.created_at,
    'system', NULL, 'Chat (' || v_conv.channel || ')',
    v_conv.customer_name,
    CASE WHEN v_conv.channel = 'whatsapp' THEN v_conv.customer_external_id ELSE NULL END,
    NULL, NULL
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commitments_from_dm_messages ON dm_messages;
CREATE TRIGGER trg_commitments_from_dm_messages AFTER INSERT ON dm_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_extract_from_dm_message();

-- =============================================================
-- 2. Monitoring + escalation columns
-- =============================================================
ALTER TABLE commitments
  ADD COLUMN IF NOT EXISTS escalation_stage text CHECK (escalation_stage IN ('due_soon', 'overdue', 'escalated')),
  ADD COLUMN IF NOT EXISTS escalation_alert_sent_at timestamptz;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_commitment_escalation boolean NOT NULL DEFAULT true;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS commitment_id uuid REFERENCES commitments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_commitments_open_deadline
  ON commitments(deadline_at)
  WHERE status = 'open' AND deadline_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_commitment_id
  ON notifications(commitment_id)
  WHERE commitment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reset_commitment_escalation_stage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR (NEW.status = 'open' AND OLD.status <> 'open') THEN
    NEW.escalation_stage := NULL;
    NEW.escalation_alert_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_commitment_escalation_stage ON commitments;
CREATE TRIGGER trg_reset_commitment_escalation_stage
  BEFORE UPDATE ON commitments
  FOR EACH ROW EXECUTE FUNCTION public.reset_commitment_escalation_stage();
