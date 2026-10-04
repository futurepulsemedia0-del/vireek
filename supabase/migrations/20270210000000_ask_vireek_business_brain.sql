/*
  # Ask Vireek — Business Brain

  Conversation history + answer feedback for the Ask Vireek reasoning layer.

  Security model
  - Tenant scoping: user_id = get_account_owner_id() (same as every other table).
  - Privacy inside a tenant: a conversation is visible ONLY to the person who
    asked it (asked_by = auth.uid()), so a manager cannot read the owner's
    private financial questions and vice-versa.
  - Rate limiting is atomic and service-role only (no client can reset it).
*/

-- =============================================================
-- CONVERSATIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS ask_vireek_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  asked_by uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ask_vireek_conv_asked_by
  ON ask_vireek_conversations (asked_by, updated_at DESC);

ALTER TABLE ask_vireek_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ask_vireek_conversations" ON ask_vireek_conversations;
CREATE POLICY "select_own_ask_vireek_conversations" ON ask_vireek_conversations
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND asked_by = auth.uid());

DROP POLICY IF EXISTS "insert_own_ask_vireek_conversations" ON ask_vireek_conversations;
CREATE POLICY "insert_own_ask_vireek_conversations" ON ask_vireek_conversations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND asked_by = auth.uid());

DROP POLICY IF EXISTS "update_own_ask_vireek_conversations" ON ask_vireek_conversations;
CREATE POLICY "update_own_ask_vireek_conversations" ON ask_vireek_conversations
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND asked_by = auth.uid())
  WITH CHECK (user_id = public.get_account_owner_id() AND asked_by = auth.uid());

DROP POLICY IF EXISTS "delete_own_ask_vireek_conversations" ON ask_vireek_conversations;
CREATE POLICY "delete_own_ask_vireek_conversations" ON ask_vireek_conversations
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND asked_by = auth.uid());

-- =============================================================
-- MESSAGES
-- =============================================================
CREATE TABLE IF NOT EXISTS ask_vireek_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ask_vireek_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  asked_by uuid NOT NULL DEFAULT auth.uid(),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  -- Full structured answer (headline, findings, actions, evidence, ...) for assistant rows.
  response jsonb,
  feedback text CHECK (feedback IN ('helpful', 'not_helpful')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ask_vireek_msg_conv
  ON ask_vireek_messages (conversation_id, created_at);

ALTER TABLE ask_vireek_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ask_vireek_messages" ON ask_vireek_messages;
CREATE POLICY "select_own_ask_vireek_messages" ON ask_vireek_messages
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND asked_by = auth.uid());

DROP POLICY IF EXISTS "insert_own_ask_vireek_messages" ON ask_vireek_messages;
CREATE POLICY "insert_own_ask_vireek_messages" ON ask_vireek_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND asked_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM ask_vireek_conversations c
      WHERE c.id = conversation_id AND c.asked_by = auth.uid()
    )
  );

-- Only the feedback column may change after insert (enforced by the trigger below).
DROP POLICY IF EXISTS "update_own_ask_vireek_messages" ON ask_vireek_messages;
CREATE POLICY "update_own_ask_vireek_messages" ON ask_vireek_messages
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND asked_by = auth.uid())
  WITH CHECK (user_id = public.get_account_owner_id() AND asked_by = auth.uid());

CREATE OR REPLACE FUNCTION public.ask_vireek_messages_feedback_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- service_role (edge functions) may write anything; end users may only rate.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.response IS DISTINCT FROM OLD.response
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'Only feedback can be changed on an Ask Vireek message';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ask_vireek_messages_feedback_only ON ask_vireek_messages;
CREATE TRIGGER trg_ask_vireek_messages_feedback_only
  BEFORE UPDATE ON ask_vireek_messages
  FOR EACH ROW EXECUTE FUNCTION public.ask_vireek_messages_feedback_only();

-- Messages are not deleted individually; deleting a conversation cascades.

-- =============================================================
-- RATE LIMIT (atomic, service-role only)
-- =============================================================
CREATE TABLE IF NOT EXISTS ask_vireek_rate_limit (
  user_id uuid PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE ask_vireek_rate_limit ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role (which bypasses RLS) touches this table.

CREATE OR REPLACE FUNCTION public.ask_vireek_consume_rate_limit(
  p_user_id uuid,
  p_max integer DEFAULT 40,
  p_window_seconds integer DEFAULT 3600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO ask_vireek_rate_limit AS r (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = CASE
      WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
      ELSE r.window_start END,
    request_count = CASE
      WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
      ELSE r.request_count + 1 END
  RETURNING r.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.ask_vireek_consume_rate_limit(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ask_vireek_consume_rate_limit(uuid, integer, integer) TO service_role;
