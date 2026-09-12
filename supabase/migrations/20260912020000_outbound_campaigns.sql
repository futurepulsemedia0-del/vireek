/*
  # Outbound call campaigns

  Adds support for automated outbound follow-up calls:
  - outbound_campaigns: per-user on/off + timing config for each campaign type
  - outbound_calls: log/queue of individual outbound call attempts
  - RLS policies scoped to auth.uid(), same pattern as review_requests
*/

CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  campaign_type text NOT NULL
    CHECK (campaign_type IN ('quote_followup', 'appointment_reminder', 'review_request_call')),
  enabled boolean NOT NULL DEFAULT false,
  trigger_after_hours integer NOT NULL DEFAULT 24,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_type)
);

CREATE TABLE IF NOT EXISTS outbound_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  campaign_type text NOT NULL
    CHECK (campaign_type IN ('quote_followup', 'appointment_reminder', 'review_request_call')),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_phone text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'calling', 'connected', 'no_answer', 'voicemail_left', 'converted', 'opted_out', 'failed')),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  called_at timestamptz,
  outcome_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_user_id ON outbound_campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_outbound_calls_user_id ON outbound_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_outbound_calls_status ON outbound_calls(status);

ALTER TABLE outbound_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_outbound_campaigns" ON outbound_campaigns;
CREATE POLICY "select_own_outbound_campaigns" ON outbound_campaigns FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_outbound_campaigns" ON outbound_campaigns;
CREATE POLICY "insert_own_outbound_campaigns" ON outbound_campaigns FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_outbound_campaigns" ON outbound_campaigns;
CREATE POLICY "update_own_outbound_campaigns" ON outbound_campaigns FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_outbound_campaigns" ON outbound_campaigns;
CREATE POLICY "delete_own_outbound_campaigns" ON outbound_campaigns FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "select_own_outbound_calls" ON outbound_calls;
CREATE POLICY "select_own_outbound_calls" ON outbound_calls FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_outbound_calls" ON outbound_calls;
CREATE POLICY "insert_own_outbound_calls" ON outbound_calls FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_outbound_calls" ON outbound_calls;
CREATE POLICY "update_own_outbound_calls" ON outbound_calls FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_outbound_calls" ON outbound_calls;
CREATE POLICY "delete_own_outbound_calls" ON outbound_calls FOR DELETE TO authenticated USING (user_id = auth.uid());
