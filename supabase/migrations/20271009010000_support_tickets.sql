/*
  # In-app support tickets (/dashboard/support) on top of support_conversations

  ## Why
  Tenants need to open, track and reply to support tickets from inside the
  dashboard, and Vireek staff must work them from the SAME place they already
  answer live chat (/staff/support-inbox). So tickets are rows in
  support_conversations (kind = 'ticket') and replies are support_messages.

  ## What this does (purely additive)
  - New columns on support_conversations: kind, account_owner_id, ticket_number,
    subject, category, priority, awaiting_customer, first_response_at,
    resolved_at, sla_first_response_due_at, sla_resolution_due_at.
    Existing live-chat rows default to kind = 'chat' and are unaffected.
  - Ticket status reuses the existing CHECK values:
      open = awaiting support, active = in progress, closed = resolved.
    "Waiting on you" is the awaiting_customer flag (set by trigger).
  - New table support_attachments + private storage bucket support-attachments.
  - SLA deadlines are stamped by a trigger from priority (single source of truth):
      urgent 1h / 8h, high 4h / 24h, normal 8h / 72h, low 24h / 120h
      (first response / resolution, calendar hours).

  ## Security
  - Tickets belong to an ACCOUNT, not a person: account_owner_id is forced to
    public.get_account_owner_id() by trigger, so the owner and every team member
    see and reply to the same tickets, and nobody can file one into another
    account.
  - A guard trigger stops non-staff from editing SLA, priority, ticket number,
    assignment, owner or kind on any row (the pre-existing UPDATE policy lets a
    visitor update their own row; this narrows it to status only).
  - Attachments: private bucket, objects live under <account_owner_id>/<conversation_id>/,
    read/write only by that account's members or Vireek staff; no update/delete.
*/

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS account_owner_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ticket_number bigint UNIQUE,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS awaiting_customer boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_first_response_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_resolution_due_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_kind_valid') THEN
    ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_kind_valid CHECK (kind IN ('chat', 'ticket'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_priority_valid') THEN
    ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_priority_valid CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_category_valid') THEN
    ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_category_valid
      CHECK (category IS NULL OR category IN ('billing', 'technical', 'account', 'feature_request', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_ticket_subject') THEN
    ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_ticket_subject
      CHECK (kind <> 'ticket' OR char_length(btrim(subject)) BETWEEN 3 AND 120);
  END IF;
  -- NOT VALID: applies to new messages only, so existing chat history is never re-checked.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_body_len') THEN
    ALTER TABLE support_messages ADD CONSTRAINT support_messages_body_len
      CHECK (char_length(body) BETWEEN 1 AND 5000) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_conversations_ticket_account
  ON support_conversations (account_owner_id, last_message_at DESC) WHERE kind = 'ticket';

CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq START 1001;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_ticket_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'ticket' THEN
    NEW.account_owner_id := public.get_account_owner_id();
    IF NEW.account_owner_id IS NULL THEN
      RAISE EXCEPTION 'Tickets require a signed-in Vireek account.' USING ERRCODE = '42501';
    END IF;
    NEW.ticket_number := nextval('support_ticket_number_seq');
    NEW.status := 'open';
    NEW.awaiting_customer := false;
    NEW.first_response_at := NULL;
    NEW.resolved_at := NULL;
    NEW.sla_first_response_due_at := NEW.created_at + CASE NEW.priority
      WHEN 'urgent' THEN interval '1 hour' WHEN 'high' THEN interval '4 hours'
      WHEN 'low' THEN interval '24 hours' ELSE interval '8 hours' END;
    NEW.sla_resolution_due_at := NEW.created_at + CASE NEW.priority
      WHEN 'urgent' THEN interval '8 hours' WHEN 'high' THEN interval '24 hours'
      WHEN 'low' THEN interval '120 hours' ELSE interval '72 hours' END;
  ELSE
    -- Live-chat rows never carry ticket fields.
    NEW.account_owner_id := NULL;
    NEW.ticket_number := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_ticket_before_insert ON support_conversations;
CREATE TRIGGER trg_support_ticket_before_insert
  BEFORE INSERT ON support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.support_ticket_before_insert();

CREATE OR REPLACE FUNCTION public.support_ticket_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Internal bookkeeping from support_ticket_after_message() is trusted.
  IF COALESCE(current_setting('vireek.support_internal', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  IF NOT COALESCE(public.is_vireek_staff(auth.uid()), false) THEN
    NEW.visitor_id := OLD.visitor_id;
    NEW.kind := OLD.kind;
    NEW.account_owner_id := OLD.account_owner_id;
    NEW.ticket_number := OLD.ticket_number;
    NEW.subject := OLD.subject;
    NEW.category := OLD.category;
    NEW.priority := OLD.priority;
    NEW.assigned_staff_id := OLD.assigned_staff_id;
    NEW.awaiting_customer := OLD.awaiting_customer;
    NEW.first_response_at := OLD.first_response_at;
    NEW.resolved_at := OLD.resolved_at;
    NEW.sla_first_response_due_at := OLD.sla_first_response_due_at;
    NEW.sla_resolution_due_at := OLD.sla_resolution_due_at;
  END IF;

  IF NEW.kind = 'ticket' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'closed' THEN
      NEW.resolved_at := now();
      NEW.awaiting_customer := false;
    ELSIF OLD.status = 'closed' THEN
      NEW.resolved_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_ticket_before_update ON support_conversations;
CREATE TRIGGER trg_support_ticket_before_update
  BEFORE UPDATE ON support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.support_ticket_before_update();

-- A staff reply stops the first-response clock and flips "waiting on you";
-- a customer-side reply flips it back. Separate from touch_support_conversation().
CREATE OR REPLACE FUNCTION public.support_ticket_after_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('vireek.support_internal', '1', true);
  UPDATE support_conversations c
  SET awaiting_customer = (NEW.sender_type = 'staff'),
      first_response_at = CASE
        WHEN NEW.sender_type = 'staff' AND c.first_response_at IS NULL THEN NEW.created_at
        ELSE c.first_response_at END
  WHERE c.id = NEW.conversation_id AND c.kind = 'ticket';
  PERFORM set_config('vireek.support_internal', '', true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_ticket_after_message ON support_messages;
CREATE TRIGGER trg_support_ticket_after_message
  AFTER INSERT ON support_messages
  FOR EACH ROW EXECUTE FUNCTION public.support_ticket_after_message();

-- ---------------------------------------------------------------------
-- Account-scoped policies (added next to the existing visitor/staff ones)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "account_select_tickets" ON support_conversations;
CREATE POLICY "account_select_tickets" ON support_conversations FOR SELECT TO authenticated
  USING (kind = 'ticket' AND account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "account_update_tickets" ON support_conversations;
CREATE POLICY "account_update_tickets" ON support_conversations FOR UPDATE TO authenticated
  USING (kind = 'ticket' AND account_owner_id = public.get_account_owner_id())
  WITH CHECK (kind = 'ticket' AND account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "account_select_ticket_messages" ON support_messages;
CREATE POLICY "account_select_ticket_messages" ON support_messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM support_conversations c
    WHERE c.id = conversation_id AND c.kind = 'ticket' AND c.account_owner_id = public.get_account_owner_id()
  ));

DROP POLICY IF EXISTS "account_insert_ticket_messages" ON support_messages;
CREATE POLICY "account_insert_ticket_messages" ON support_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'visitor' AND sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM support_conversations c
      WHERE c.id = conversation_id AND c.kind = 'ticket' AND c.account_owner_id = public.get_account_owner_id()
    )
  );

-- ---------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 180),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  uploaded_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_attachments_conversation ON support_attachments (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_attachments_message ON support_attachments (message_id);

CREATE OR REPLACE FUNCTION public.support_attachment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  conv_owner uuid;
BEGIN
  SELECT c.account_owner_id INTO conv_owner
  FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id
  WHERE m.id = NEW.message_id AND c.id = NEW.conversation_id AND c.kind = 'ticket';
  IF conv_owner IS NULL THEN
    RAISE EXCEPTION 'Attachment must belong to a message on a ticket.' USING ERRCODE = '42501';
  END IF;
  IF NEW.storage_path NOT LIKE conv_owner::text || '/' || NEW.conversation_id::text || '/%' THEN
    RAISE EXCEPTION 'Invalid attachment path.' USING ERRCODE = '42501';
  END IF;
  NEW.account_owner_id := conv_owner;
  NEW.uploaded_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_attachment_guard ON support_attachments;
CREATE TRIGGER trg_support_attachment_guard
  BEFORE INSERT ON support_attachments
  FOR EACH ROW EXECUTE FUNCTION public.support_attachment_guard();

ALTER TABLE support_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_support_attachments" ON support_attachments;
CREATE POLICY "select_support_attachments" ON support_attachments FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() OR public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "insert_support_attachments" ON support_attachments;
CREATE POLICY "insert_support_attachments" ON support_attachments FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND (
      public.is_vireek_staff(auth.uid())
      OR EXISTS (
        SELECT 1 FROM support_conversations c
        WHERE c.id = conversation_id AND c.kind = 'ticket' AND c.account_owner_id = public.get_account_owner_id()
      )
    )
  );

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'support-attachments', 'support-attachments', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
        'application/pdf', 'text/plain', 'text/csv', 'video/mp4']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "support_attachments_read" ON storage.objects;
CREATE POLICY "support_attachments_read" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'support-attachments'
    AND ((storage.foldername(name))[1] = public.get_account_owner_id()::text OR public.is_vireek_staff(auth.uid()))
  );

DROP POLICY IF EXISTS "support_attachments_write" ON storage.objects;
CREATE POLICY "support_attachments_write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'support-attachments'
    AND ((storage.foldername(name))[1] = public.get_account_owner_id()::text OR public.is_vireek_staff(auth.uid()))
  );

COMMENT ON TABLE support_attachments IS
  'Files attached to support ticket messages. Objects live in the private support-attachments bucket under <account_owner_id>/<conversation_id>/.';
