/*
  # Inbound AI auto-reply (SMS + email)

  - auto_reply_settings : per-business switches, mode (human approval | auto),
                          confidence threshold, escalation keywords, guards.
  - auto_reply_log      : one row per inbound message the AI looked at
                          (full audit trail; UNIQUE key = idempotency).
  - ai_paused / needs_human on both conversation tables, sent_by on messages.

  Writes to auto_reply_log happen only from edge functions (service role);
  tenants can read their own rows. Settings are tenant-editable under RLS.
*/

CREATE TABLE IF NOT EXISTS auto_reply_settings (
  user_id uuid PRIMARY KEY,
  sms_enabled boolean NOT NULL DEFAULT false,
  email_enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'approval' CHECK (mode IN ('approval', 'auto')),
  confidence_threshold numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (confidence_threshold BETWEEN 0.50 AND 0.99),
  escalation_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(escalation_keywords) <= 100),
  use_default_keywords boolean NOT NULL DEFAULT true,
  scope text NOT NULL DEFAULT 'always' CHECK (scope IN ('always', 'after_hours_only')),
  timezone text NOT NULL DEFAULT 'America/New_York',
  share_booking_link boolean NOT NULL DEFAULT true,
  send_escalation_ack boolean NOT NULL DEFAULT true,
  escalation_ack_message text CHECK (escalation_ack_message IS NULL OR char_length(escalation_ack_message) <= 320),
  signature text CHECK (signature IS NULL OR char_length(signature) <= 80),
  extra_instructions text CHECK (extra_instructions IS NULL OR char_length(extra_instructions) <= 1000),
  max_auto_replies_per_day integer NOT NULL DEFAULT 4 CHECK (max_auto_replies_per_day BETWEEN 1 AND 20),
  human_takeover_minutes integer NOT NULL DEFAULT 120 CHECK (human_takeover_minutes BETWEEN 0 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auto_reply_settings_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.timezone;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_reply_settings_validate ON auto_reply_settings;
CREATE TRIGGER trg_auto_reply_settings_validate BEFORE INSERT OR UPDATE ON auto_reply_settings
  FOR EACH ROW EXECUTE FUNCTION auto_reply_settings_validate();

ALTER TABLE auto_reply_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_auto_reply_settings" ON auto_reply_settings;
CREATE POLICY "select_own_auto_reply_settings" ON auto_reply_settings FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_auto_reply_settings" ON auto_reply_settings;
CREATE POLICY "insert_own_auto_reply_settings" ON auto_reply_settings FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_auto_reply_settings" ON auto_reply_settings;
CREATE POLICY "update_own_auto_reply_settings" ON auto_reply_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_reply_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  conversation_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'sent', 'pending_approval', 'escalated', 'skipped', 'rejected', 'failed')),
  reason text,
  matched_keyword text,
  confidence numeric(4,3),
  epistemic_tier text,
  kb_article_ids uuid[] NOT NULL DEFAULT '{}',
  draft_body text,
  final_body text,
  provider text,
  model text,
  latency_ms integer,
  outbound_message_id uuid,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (channel, inbound_message_id)
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_log_user ON auto_reply_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_reply_log_conv ON auto_reply_log(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_reply_log_pending ON auto_reply_log(user_id) WHERE status = 'pending_approval';

ALTER TABLE auto_reply_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_auto_reply_log" ON auto_reply_log;
CREATE POLICY "select_own_auto_reply_log" ON auto_reply_log FOR SELECT TO authenticated USING (user_id = auth.uid());

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE auto_reply_log;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
ALTER TABLE sms_conversations   ADD COLUMN IF NOT EXISTS ai_paused boolean NOT NULL DEFAULT false;
ALTER TABLE sms_conversations   ADD COLUMN IF NOT EXISTS needs_human boolean NOT NULL DEFAULT false;
ALTER TABLE email_conversations ADD COLUMN IF NOT EXISTS ai_paused boolean NOT NULL DEFAULT false;
ALTER TABLE email_conversations ADD COLUMN IF NOT EXISTS needs_human boolean NOT NULL DEFAULT false;

ALTER TABLE sms_messages   ADD COLUMN IF NOT EXISTS sent_by text NOT NULL DEFAULT 'human' CHECK (sent_by IN ('human', 'ai', 'ai_approved'));
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS sent_by text NOT NULL DEFAULT 'human' CHECK (sent_by IN ('human', 'ai', 'ai_approved'));

CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_sid ON sms_messages(conversation_id, provider_sid) WHERE provider_sid IS NOT NULL;
