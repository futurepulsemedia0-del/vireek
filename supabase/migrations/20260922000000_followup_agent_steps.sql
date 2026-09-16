/*
  # Automated Follow-up Agents — multi-step, multi-channel

  ## Why
  `outbound_campaigns` + `outbound_calls` + outbound-queue-builder/outbound-dialer
  already do ONE thing well: a single follow-up phone call, N hours after a
  trigger (quote sitting untouched, upcoming appointment, completed+paid job).
  That's kept as-is — `outbound_campaigns` is still the on/off + toggle a
  business sees first.

  What's missing to call this an "agent" instead of a one-shot call:
  1. Multiple steps per campaign type (e.g. text at 24h, call at 48h, text
     again at 96h) instead of exactly one action.
  2. A text-message channel, not just voice — reuses the existing compliant
     SMS sender (supabase/functions/_shared/messaging/sendSms.ts), so A2P
     approval + STOP/opt-out suppression are enforced for free.
  3. A stop condition checked before every step: if the lead already booked,
     the appointment was cancelled/rescheduled, or the review was already
     left, the sequence ends itself instead of pestering someone who no
     longer needs it. (Enforced in code, in followup-agent-dispatcher — see
     that function's computeStopReason().)
  4. Per-business customization of what step N actually says.

  ## What this does
  `followup_agent_steps` — the ordered playbook per user per campaign_type.
  If a business never configures any steps for a campaign_type, the system
  falls back to the exact legacy behavior (one call, at outbound_campaigns.
  trigger_after_hours) — nobody's existing setup breaks.

  `followup_agent_enrollments` — one row per lead/job that entered a
  sequence. Replaces "one outbound_calls row = one attempt" with "one
  enrollment tracks progress across N steps". Dedupe indexes mirror the
  ones outbound_calling_engine.sql added for outbound_calls, so the same
  lead/job is never enrolled twice.

  `outbound_calls` gains `enrollment_id` / `step_number` so the existing
  call log (and OutboundCampaignsPage.tsx's "Recent activity" list) keeps
  working unchanged for the call channel.

  `outbound_sms` — sibling log table for the text channel, same shape as
  outbound_calls, same RLS pattern, same opt-out-syncs-to-dnc_suppressions
  trigger (reuses sync_dnc_suppression_on_opt_out from
  20260914080000_dnc_suppression_list.sql — that function only reads
  NEW.status/customer_phone/user_id, so it works unmodified on this table
  too).

  An opt-out on EITHER channel also closes the enrollment itself, so
  "STOP" on a text stops the calls too, and vice versa.
*/

-- ---------------------------------------------------------------------
-- 1. followup_agent_steps
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS followup_agent_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  campaign_type text NOT NULL
    CHECK (campaign_type IN ('quote_followup', 'appointment_reminder', 'review_request_call')),
  step_number smallint NOT NULL CHECK (step_number BETWEEN 1 AND 5),
  channel text NOT NULL CHECK (channel IN ('call', 'sms')),
  -- Hours after the PREVIOUS step (or, for step 1, after the trigger event
  -- itself) before this step fires.
  delay_hours integer NOT NULL DEFAULT 24 CHECK (delay_hours >= 0),
  -- Required when channel = 'sms'. Supports {{customer_name}},
  -- {{business_name}}, {{quote_amount}}, {{appointment_time}},
  -- {{review_link}} — rendered in followup-agent-dispatcher.
  sms_body text,
  -- Optional, channel = 'call' only: extra instruction passed to the Vapi
  -- assistant as assistantOverrides.variableValues.followup_context for
  -- this step (e.g. "Mention the 0% financing offer"). Only reaches the
  -- live call if the business's Vapi assistant prompt is configured to
  -- read {{followup_context}} — same caveat as financing_note in
  -- 20260912060000_quote_followups_and_financing.sql.
  call_context text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_type, step_number),
  CHECK (channel <> 'sms' OR (sms_body IS NOT NULL AND length(trim(sms_body)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_followup_agent_steps_lookup
  ON followup_agent_steps(user_id, campaign_type, step_number);

DROP TRIGGER IF EXISTS trg_followup_agent_steps_updated_at ON followup_agent_steps;
CREATE TRIGGER trg_followup_agent_steps_updated_at
  BEFORE UPDATE ON followup_agent_steps
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE followup_agent_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_followup_agent_steps" ON followup_agent_steps;
CREATE POLICY "select_own_followup_agent_steps" ON followup_agent_steps FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_followup_agent_steps" ON followup_agent_steps;
CREATE POLICY "insert_own_followup_agent_steps" ON followup_agent_steps FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_followup_agent_steps" ON followup_agent_steps;
CREATE POLICY "update_own_followup_agent_steps" ON followup_agent_steps FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_followup_agent_steps" ON followup_agent_steps;
CREATE POLICY "delete_own_followup_agent_steps" ON followup_agent_steps FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. followup_agent_enrollments
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS followup_agent_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  campaign_type text NOT NULL
    CHECK (campaign_type IN ('quote_followup', 'appointment_reminder', 'review_request_call')),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  -- 0 = enrolled, no step executed yet. After step N runs successfully
  -- this becomes N; followup-agent-dispatcher looks for step N+1 next.
  current_step smallint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'stopped', 'opted_out')),
  stop_reason text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_action_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followup_enrollments_dispatch
  ON followup_agent_enrollments(status, next_action_at) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_enrollments_dedupe_lead
  ON followup_agent_enrollments(user_id, campaign_type, lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_enrollments_dedupe_job
  ON followup_agent_enrollments(user_id, campaign_type, job_id) WHERE job_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_followup_enrollments_updated_at ON followup_agent_enrollments;
CREATE TRIGGER trg_followup_enrollments_updated_at
  BEFORE UPDATE ON followup_agent_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE followup_agent_enrollments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_followup_enrollments" ON followup_agent_enrollments;
CREATE POLICY "select_own_followup_enrollments" ON followup_agent_enrollments FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_followup_enrollments" ON followup_agent_enrollments;
CREATE POLICY "insert_own_followup_enrollments" ON followup_agent_enrollments FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_followup_enrollments" ON followup_agent_enrollments;
CREATE POLICY "update_own_followup_enrollments" ON followup_agent_enrollments FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_followup_enrollments" ON followup_agent_enrollments;
CREATE POLICY "delete_own_followup_enrollments" ON followup_agent_enrollments FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 3. outbound_calls gains enrollment linkage (additive, nullable)
-- ---------------------------------------------------------------------

ALTER TABLE outbound_calls
  ADD COLUMN IF NOT EXISTS enrollment_id uuid REFERENCES followup_agent_enrollments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS step_number smallint;

CREATE INDEX IF NOT EXISTS idx_outbound_calls_enrollment_id ON outbound_calls(enrollment_id);

-- ---------------------------------------------------------------------
-- 4. outbound_sms — sibling log table for the text channel
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outbound_sms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  campaign_type text NOT NULL
    CHECK (campaign_type IN ('quote_followup', 'appointment_reminder', 'review_request_call')),
  enrollment_id uuid REFERENCES followup_agent_enrollments(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  step_number smallint,
  customer_name text NOT NULL,
  customer_phone text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'opted_out')),
  twilio_sid text,
  outcome_notes text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_sms_user_id ON outbound_sms(user_id);
CREATE INDEX IF NOT EXISTS idx_outbound_sms_enrollment_id ON outbound_sms(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_outbound_sms_status ON outbound_sms(status);

ALTER TABLE outbound_sms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_outbound_sms" ON outbound_sms;
CREATE POLICY "select_own_outbound_sms" ON outbound_sms FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_outbound_sms" ON outbound_sms;
CREATE POLICY "insert_own_outbound_sms" ON outbound_sms FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_outbound_sms" ON outbound_sms;
CREATE POLICY "update_own_outbound_sms" ON outbound_sms FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_outbound_sms" ON outbound_sms;
CREATE POLICY "delete_own_outbound_sms" ON outbound_sms FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Reuse the existing opt-out -> dnc_suppressions sync trigger function
-- (20260914080000_dnc_suppression_list.sql). It only touches
-- NEW.status / NEW.customer_phone / NEW.user_id, so it attaches cleanly
-- to this table too — one STOP reply suppresses both calls and texts.
DROP TRIGGER IF EXISTS trg_sync_dnc_suppression_sms ON outbound_sms;
CREATE TRIGGER trg_sync_dnc_suppression_sms
  AFTER UPDATE ON outbound_sms
  FOR EACH ROW EXECUTE FUNCTION sync_dnc_suppression_on_opt_out();

-- Also run it on INSERT: unlike outbound_calls (always inserted as
-- 'queued'/'calling'), an SMS row can be inserted directly with status
-- 'opted_out' when sendCompliantSms() reports the number was already
-- suppressed — that case has no prior row for an UPDATE to fire on.
DROP TRIGGER IF EXISTS trg_sync_dnc_suppression_sms_insert ON outbound_sms;
CREATE TRIGGER trg_sync_dnc_suppression_sms_insert
  AFTER INSERT ON outbound_sms
  FOR EACH ROW EXECUTE FUNCTION sync_dnc_suppression_on_opt_out();

-- ---------------------------------------------------------------------
-- 5. An opt-out on either channel closes the whole enrollment
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION close_enrollment_on_opt_out()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'opted_out' AND NEW.enrollment_id IS NOT NULL THEN
    UPDATE followup_agent_enrollments
    SET status = 'opted_out', stop_reason = 'customer_opted_out'
    WHERE id = NEW.enrollment_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_close_enrollment_on_call_opt_out ON outbound_calls;
CREATE TRIGGER trg_close_enrollment_on_call_opt_out
  AFTER INSERT OR UPDATE ON outbound_calls
  FOR EACH ROW EXECUTE FUNCTION close_enrollment_on_opt_out();

DROP TRIGGER IF EXISTS trg_close_enrollment_on_sms_opt_out ON outbound_sms;
CREATE TRIGGER trg_close_enrollment_on_sms_opt_out
  AFTER INSERT OR UPDATE ON outbound_sms
  FOR EACH ROW EXECUTE FUNCTION close_enrollment_on_opt_out();
