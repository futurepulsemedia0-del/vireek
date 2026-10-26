/*
  # RCS Business Messaging + Apple Messages for Business (rich messaging)

  Adds two channels to the Unified Inbox via an approved messaging aggregator
  (Sinch Conversation API; see docs/RICH_MESSAGING.md):

    * rcs  - Google RCS Business Messaging. Recipient identity = phone number.
             Capability is detected per recipient and cached (rich_capabilities).
    * amb  - Apple Messages for Business. Customer-initiated only; recipient
             identity is an opaque Apple id (urn:mbid:...), NOT a phone number.

  Design (mirrors sms_conversations / sms_messages):
    * Tenants may only SELECT their threads (and flip `unread`). Every write goes
      through a service-role edge function (rich-webhook / rich-send /
      rich-fallback-sweep), so the opt-out + A2P + quiet-hours gates can never
      be bypassed from the browser.
    * Opt-outs are shared with SMS: STOP on RCS writes dnc_suppressions, the same
      list sendCompliantSms() already checks.
    * Automatic SMS fallback is tracked on the outbound row (fallback_state /
      fallback_deadline) and executed by rich-fallback-sweep or immediately when
      the aggregator reports FAILED. Claims are atomic (FOR UPDATE SKIP LOCKED +
      conditional updates) so a message can never fall back twice.

  Idempotent. Rename the timestamp so it sorts AFTER your newest migration.
*/

-- =============================================================
-- 0. Shared updated_at trigger
-- =============================================================

CREATE OR REPLACE FUNCTION public.rich_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- =============================================================
-- 1. Per-tenant account (provider approval state + sender branding)
-- =============================================================
-- provider_app_id / *_status / *_agent_id / amb_business_id / verified_sender_name are
-- OPERATOR-controlled (service role). Tenants can only edit display + behaviour columns
-- (enforced by column-level GRANTs below, not just RLS).

CREATE TABLE IF NOT EXISTS rich_messaging_accounts (
  user_id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'sinch' CHECK (provider IN ('sinch')),
  provider_app_id text UNIQUE,
  provider_region text NOT NULL DEFAULT 'us' CHECK (provider_region IN ('us', 'eu', 'br')),
  rcs_status text NOT NULL DEFAULT 'not_started'
    CHECK (rcs_status IN ('not_started', 'requested', 'in_review', 'approved', 'rejected', 'suspended')),
  rcs_agent_id text,
  amb_status text NOT NULL DEFAULT 'not_started'
    CHECK (amb_status IN ('not_started', 'requested', 'in_review', 'approved', 'rejected', 'suspended')),
  amb_business_id text,            -- Apple Messages for Business account id (MBA-ID)
  rcs_enabled boolean NOT NULL DEFAULT false,
  amb_enabled boolean NOT NULL DEFAULT false,
  brand_name text,                 -- shown in SMS fallback text + inbox
  brand_logo_url text,
  brand_color text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  verified_sender_name text,       -- name as verified by carriers / Apple (set by operator)
  fallback_to_sms boolean NOT NULL DEFAULT true,
  fallback_after_seconds integer NOT NULL DEFAULT 45 CHECK (fallback_after_seconds BETWEEN 10 AND 900),
  attempt_on_unknown boolean NOT NULL DEFAULT true,  -- try RCS when capability is not yet known
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rich_messaging_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rich_messaging_accounts" ON rich_messaging_accounts;
CREATE POLICY "select_own_rich_messaging_accounts" ON rich_messaging_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_rich_messaging_accounts" ON rich_messaging_accounts;
CREATE POLICY "update_own_rich_messaging_accounts" ON rich_messaging_accounts
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON rich_messaging_accounts FROM anon, authenticated;
GRANT SELECT ON rich_messaging_accounts TO authenticated;
GRANT UPDATE (brand_name, brand_logo_url, brand_color, rcs_enabled, amb_enabled,
              fallback_to_sms, fallback_after_seconds, attempt_on_unknown)
  ON rich_messaging_accounts TO authenticated;

DROP TRIGGER IF EXISTS trg_rich_accounts_updated_at ON rich_messaging_accounts;
CREATE TRIGGER trg_rich_accounts_updated_at BEFORE UPDATE ON rich_messaging_accounts
  FOR EACH ROW EXECUTE FUNCTION public.rich_touch_updated_at();

-- Tenant self-service "request access": creates the row / moves not_started -> requested.
-- Approval itself is an operator action (see docs/RICH_MESSAGING.md).
CREATE OR REPLACE FUNCTION public.request_rich_messaging_access()
RETURNS rich_messaging_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row rich_messaging_accounts;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  INSERT INTO rich_messaging_accounts (user_id, rcs_status, amb_status)
  VALUES (auth.uid(), 'requested', 'requested')
  ON CONFLICT (user_id) DO UPDATE SET
    rcs_status = CASE WHEN rich_messaging_accounts.rcs_status = 'not_started' THEN 'requested' ELSE rich_messaging_accounts.rcs_status END,
    amb_status = CASE WHEN rich_messaging_accounts.amb_status = 'not_started' THEN 'requested' ELSE rich_messaging_accounts.amb_status END
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.request_rich_messaging_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_rich_messaging_access() TO authenticated;

-- =============================================================
-- 2. Conversations
-- =============================================================

CREATE TABLE IF NOT EXISTS rich_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('rcs', 'amb')),
  customer_identity text NOT NULL,   -- rcs: E.164 phone. amb: opaque Apple id (urn:mbid:...)
  customer_phone text,               -- E.164 when known (always for rcs). Used for SMS fallback + DNC.
  customer_name text,
  provider_contact_id text,
  provider_conversation_id text,
  unread boolean NOT NULL DEFAULT true,
  opted_out_at timestamptz,          -- customer sent STOP (or provider opt-out) on this thread
  customer_closed_at timestamptz,    -- amb: customer deleted the conversation; business cannot message
  last_inbound_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, customer_identity)
);

CREATE INDEX IF NOT EXISTS idx_rich_conversations_user ON rich_conversations(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_rich_conversations_phone ON rich_conversations(user_id, customer_phone) WHERE customer_phone IS NOT NULL;

ALTER TABLE rich_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rich_conversations" ON rich_conversations;
CREATE POLICY "select_own_rich_conversations" ON rich_conversations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_rich_conversations" ON rich_conversations;
CREATE POLICY "update_own_rich_conversations" ON rich_conversations
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Browsers may only mark a thread read; opt-out / closed state is server-owned.
REVOKE ALL ON rich_conversations FROM anon, authenticated;
GRANT SELECT ON rich_conversations TO authenticated;
GRANT UPDATE (unread) ON rich_conversations TO authenticated;

-- =============================================================
-- 3. Messages (inbound + outbound, delivery state, fallback state)
-- =============================================================

CREATE TABLE IF NOT EXISTS rich_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- also the aggregator correlation_id
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES rich_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'card', 'reply', 'media')),
  body text NOT NULL,                -- plain-text rendering (search, notifications, SMS fallback source)
  content jsonb,                     -- outbound: {kind,card?,text?}; inbound: {postback?,mediaUrl?}
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'deferred', 'sent', 'delivered', 'read', 'failed', 'fallback_sent', 'cancelled', 'received')),
  sent_by text NOT NULL DEFAULT 'human' CHECK (sent_by IN ('human', 'system', 'ai', 'ai_approved')),
  source text,
  purpose text NOT NULL DEFAULT 'service' CHECK (purpose IN ('marketing', 'service', 'emergency')),
  customer_id uuid,
  dedupe_key text,
  provider_message_id text,
  scheduled_for timestamptz,         -- quiet-hours deferral
  fallback_state text NOT NULL DEFAULT 'none'
    CHECK (fallback_state IN ('none', 'armed', 'sending', 'sent', 'cancelled', 'failed')),
  fallback_deadline timestamptz,
  fallback_text text,
  fallback_phone text,
  fallback_sms_sid text,
  failure_reason text,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rich_messages_conversation ON rich_messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rich_messages_provider
  ON rich_messages(conversation_id, direction, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rich_messages_provider_lookup ON rich_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rich_messages_dedupe
  ON rich_messages(conversation_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rich_messages_fallback_due ON rich_messages(fallback_deadline) WHERE fallback_state = 'armed';
CREATE INDEX IF NOT EXISTS idx_rich_messages_deferred_due ON rich_messages(scheduled_for) WHERE status = 'deferred';

ALTER TABLE rich_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rich_messages" ON rich_messages;
CREATE POLICY "select_own_rich_messages" ON rich_messages
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON rich_messages FROM anon, authenticated;
GRANT SELECT ON rich_messages TO authenticated;

DROP TRIGGER IF EXISTS trg_rich_messages_updated_at ON rich_messages;
CREATE TRIGGER trg_rich_messages_updated_at BEFORE UPDATE ON rich_messages
  FOR EACH ROW EXECUTE FUNCTION public.rich_touch_updated_at();

-- =============================================================
-- 4. Per-recipient capability cache
-- =============================================================

CREATE TABLE IF NOT EXISTS rich_capabilities (
  user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('rcs', 'amb')),
  identity text NOT NULL,
  status text NOT NULL CHECK (status IN ('capable', 'not_capable', 'unknown')),
  features jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, channel, identity)
);

ALTER TABLE rich_capabilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_rich_capabilities" ON rich_capabilities;
CREATE POLICY "select_own_rich_capabilities" ON rich_capabilities
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON rich_capabilities FROM anon, authenticated;
GRANT SELECT ON rich_capabilities TO authenticated;

-- =============================================================
-- 5. Webhook de-duplication (provider retries are at-least-once)
-- =============================================================

CREATE TABLE IF NOT EXISTS rich_webhook_events (
  provider text NOT NULL,
  event_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_key)
);

ALTER TABLE rich_webhook_events ENABLE ROW LEVEL SECURITY;  -- service role only: no policies
REVOKE ALL ON rich_webhook_events FROM anon, authenticated;

-- =============================================================
-- 6. Realtime (one block per table so a re-run never skips the second)
-- =============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE rich_conversations;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE rich_messages;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- =============================================================
-- 7. Worker RPCs (service role only)
-- =============================================================

-- Atomically claims armed fallbacks whose deadline has passed.
CREATE OR REPLACE FUNCTION public.claim_rich_fallbacks(p_limit integer DEFAULT 25)
RETURNS SETOF rich_messages
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE rich_messages m
     SET fallback_state = 'sending', updated_at = now()
   WHERE m.id IN (
     SELECT id FROM rich_messages
      WHERE fallback_state = 'armed'
        AND fallback_deadline <= now()
        AND status IN ('queued', 'sent')
      ORDER BY fallback_deadline
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING m.*;
$$;

-- Atomically claims quiet-hours-deferred messages that are due.
CREATE OR REPLACE FUNCTION public.claim_due_rich_deferred(p_limit integer DEFAULT 25)
RETURNS SETOF rich_messages
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE rich_messages m
     SET status = 'queued', updated_at = now()
   WHERE m.id IN (
     SELECT id FROM rich_messages
      WHERE status = 'deferred'
        AND scheduled_for <= now()
      ORDER BY scheduled_for
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING m.*;
$$;

-- Purges old webhook keys and fails rows a crashed worker left half-processed.
CREATE OR REPLACE FUNCTION public.rich_housekeeping()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_events integer;
  v_fallbacks integer;
  v_dispatch integer;
BEGIN
  DELETE FROM rich_webhook_events WHERE received_at < now() - interval '14 days';
  GET DIAGNOSTICS v_events = ROW_COUNT;

  UPDATE rich_messages
     SET fallback_state = 'failed', status = 'failed', failure_reason = 'fallback_interrupted'
   WHERE fallback_state = 'sending' AND updated_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_fallbacks = ROW_COUNT;

  UPDATE rich_messages
     SET status = 'failed', failure_reason = 'dispatch_interrupted'
   WHERE direction = 'outbound' AND status = 'queued' AND fallback_state = 'none'
     AND provider_message_id IS NULL AND updated_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_dispatch = ROW_COUNT;

  RETURN jsonb_build_object('events_purged', v_events, 'fallbacks_failed', v_fallbacks, 'dispatch_failed', v_dispatch);
END $$;

REVOKE ALL ON FUNCTION public.claim_rich_fallbacks(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_rich_deferred(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rich_housekeeping() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_rich_fallbacks(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_rich_deferred(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rich_housekeeping() TO service_role;
