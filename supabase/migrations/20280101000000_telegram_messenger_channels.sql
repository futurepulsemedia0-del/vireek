/*
  # Telegram + Facebook Messenger channels for the Unified Inbox

  Reuses the WhatsApp/Instagram DM tables (dm_channel_connections, dm_conversations, dm_messages) so
  both channels appear in /dashboard/inbox with no new read path:

    * channel CHECKs widened to ('whatsapp','instagram','telegram','messenger')
    * dm_channel_connections: display_name, webhook_secret (Telegram secret_token), updated_at;
      one connection per tenant per new channel
    * dm_conversations: last_inbound_at (Messenger 24h reply window), opted_out_at (STOP / START)
    * dm_messages: provider_message_id (idempotent webhook retries), sent_by, sender_user_id

  Security: tenants may SELECT their rows but never the stored bot / Page token or the webhook secret
  (column-level GRANT), and may only flip `unread` on a conversation, so opt-out state is server-owned.
  Every write goes through service-role edge functions (telegram-webhook, messenger-webhook,
  dm-connect, dm-send). Idempotent. Rename the timestamp so it sorts AFTER your newest migration.
*/

-- ---------------------------------------------------------------------
-- 1. Allow the new channel values (drops whatever the CHECK was called, then re-adds it)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN ('public.dm_channel_connections'::regclass, 'public.dm_conversations'::regclass)
      AND pg_get_constraintdef(c.oid) ILIKE '%channel%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE dm_channel_connections ADD CONSTRAINT dm_channel_connections_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'telegram', 'messenger'));
ALTER TABLE dm_conversations ADD CONSTRAINT dm_conversations_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'telegram', 'messenger'));

-- ---------------------------------------------------------------------
-- 2. Columns
-- ---------------------------------------------------------------------
ALTER TABLE dm_channel_connections
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS webhook_secret text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS opted_out_at timestamptz;

ALTER TABLE dm_messages
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS sent_by text,
  ADD COLUMN IF NOT EXISTS sender_user_id uuid;

-- NULL provider ids (existing WhatsApp / Instagram rows) never collide: NULLs are distinct in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_messages_provider
  ON dm_messages(conversation_id, direction, provider_message_id);

-- One Telegram bot / one Facebook Page per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_connections_user_channel
  ON dm_channel_connections(user_id, channel) WHERE channel IN ('telegram', 'messenger');

-- ---------------------------------------------------------------------
-- 3. updated_at maintenance
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dm_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_dm_connections_updated_at ON dm_channel_connections;
CREATE TRIGGER trg_dm_connections_updated_at BEFORE UPDATE ON dm_channel_connections
  FOR EACH ROW EXECUTE FUNCTION public.dm_touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. Least-privilege grants (RLS policies from earlier migrations still apply on top)
-- ---------------------------------------------------------------------
-- Never expose access_token / webhook_secret to the browser. Clients must list columns explicitly.
REVOKE ALL ON dm_channel_connections FROM anon, authenticated;
GRANT SELECT (id, user_id, channel, external_account_id, status, last_error, created_at, display_name, updated_at)
  ON dm_channel_connections TO authenticated;

-- Browsers may only mark a thread read; opt-out state is server-owned.
REVOKE UPDATE ON dm_conversations FROM anon, authenticated;
GRANT UPDATE (unread) ON dm_conversations TO authenticated;
