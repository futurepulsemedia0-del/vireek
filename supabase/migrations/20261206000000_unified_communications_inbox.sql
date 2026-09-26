/*
  # Unified Communications Inbox

  Brings SMS and Email in as first-class conversation channels next to the
  existing site chat (support_conversations/support_messages) and
  WhatsApp/Instagram (dm_conversations/dm_messages), so a business's team
  can read and reply to every channel from one screen
  (/dashboard/inbox — see src/pages/UnifiedInboxPage.tsx).

  Design mirrors dm_conversations/dm_messages exactly (same column shape,
  same RLS posture: tenants can SELECT their own rows; every write goes
  through a service-role edge function — sms-webhook/sms-send and
  email-webhook/email-send — so the two-gate SMS compliance check
  (A2P + opt-out, see _shared/messaging/sendSms.ts) and the inbound
  webhook's own validation can never be bypassed from the client).

  unread: added here on ALL THREE conversation tables (including the
  pre-existing dm_conversations, which had no read-state column yet) so
  the inbox can show a single consistent unread badge per channel.
*/

-- ---------------------------------------------------------------------
-- Read state on the existing WhatsApp/Instagram channel
-- ---------------------------------------------------------------------
ALTER TABLE dm_conversations ADD COLUMN IF NOT EXISTS unread boolean NOT NULL DEFAULT true;

DROP POLICY IF EXISTS "update_own_dm_conversations" ON dm_conversations;
CREATE POLICY "update_own_dm_conversations" ON dm_conversations FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_conversations;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- SMS channel
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_phone text NOT NULL, -- E.164, see normalizePhone() in _shared/compliance/dncCheck.ts
  customer_name text,
  unread boolean NOT NULL DEFAULT true,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_sms_conversations_user ON sms_conversations(user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body text NOT NULL,
  provider_sid text, -- Twilio Message SID, for delivery-status lookups later
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_conversation ON sms_messages(conversation_id, created_at);

ALTER TABLE sms_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_sms_conversations" ON sms_conversations;
CREATE POLICY "select_own_sms_conversations" ON sms_conversations FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_sms_conversations" ON sms_conversations;
CREATE POLICY "update_own_sms_conversations" ON sms_conversations FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "select_own_sms_messages" ON sms_messages;
CREATE POLICY "select_own_sms_messages" ON sms_messages FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM sms_conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid())
);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sms_conversations;
  ALTER PUBLICATION supabase_realtime ADD TABLE sms_messages;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Email channel
-- ---------------------------------------------------------------------
-- Each tenant gets one inbound alias (inbound_email_token@<INBOUND_EMAIL_DOMAIN>,
-- domain fixed platform-wide, see VITE_INBOUND_EMAIL_DOMAIN) that a
-- customer's reply-to lands on; email-webhook resolves it back to user_id.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS inbound_email_token text UNIQUE DEFAULT encode(gen_random_bytes(6), 'hex');
UPDATE profiles SET inbound_email_token = encode(gen_random_bytes(6), 'hex') WHERE inbound_email_token IS NULL;

CREATE TABLE IF NOT EXISTS email_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_email text NOT NULL,
  customer_name text,
  subject text,
  unread boolean NOT NULL DEFAULT true,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_email)
);

CREATE INDEX IF NOT EXISTS idx_email_conversations_user ON email_conversations(user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES email_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  subject text,
  body_text text NOT NULL,
  body_html text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_conversation ON email_messages(conversation_id, created_at);

ALTER TABLE email_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_email_conversations" ON email_conversations;
CREATE POLICY "select_own_email_conversations" ON email_conversations FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_email_conversations" ON email_conversations;
CREATE POLICY "update_own_email_conversations" ON email_conversations FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "select_own_email_messages" ON email_messages;
CREATE POLICY "select_own_email_messages" ON email_messages FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM email_conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid())
);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE email_conversations;
  ALTER PUBLICATION supabase_realtime ADD TABLE email_messages;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;
