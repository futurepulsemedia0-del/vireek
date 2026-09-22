/*
  # WhatsApp DM channel (Phase 1: receive, store, auto-reply from Knowledge Base)

  One Meta App = one webhook URL for the whole platform. Each tenant's own
  WhatsApp Business phone_number_id + access token are stored in
  dm_channel_connections so an inbound webhook payload can be routed to the
  right business by phone_number_id.
*/

CREATE TABLE IF NOT EXISTS dm_channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram')),
  external_account_id text NOT NULL, -- WhatsApp phone_number_id / IG page id
  access_token text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_channel_connections_user ON dm_channel_connections(user_id);

CREATE TABLE IF NOT EXISTS dm_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram')),
  customer_external_id text NOT NULL, -- WhatsApp phone / IG-scoped user id
  customer_name text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, customer_external_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_user ON dm_conversations(user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS dm_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation ON dm_messages(conversation_id, created_at);

ALTER TABLE dm_channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_dm_connections" ON dm_channel_connections;
CREATE POLICY "select_own_dm_connections" ON dm_channel_connections FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "select_own_dm_conversations" ON dm_conversations;
CREATE POLICY "select_own_dm_conversations" ON dm_conversations FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "select_own_dm_messages" ON dm_messages;
CREATE POLICY "select_own_dm_messages" ON dm_messages FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM dm_conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid())
);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE dm_messages;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;
