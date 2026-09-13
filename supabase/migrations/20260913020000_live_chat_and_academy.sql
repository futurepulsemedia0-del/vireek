/*
  # Feature 14 — Customer Support/Success

  Part A — Live chat with a real human on the marketing site (separate
  system from `site-assistant`, which is AI-only and has no human on the
  other end):
    - profiles.is_staff: marks a Vireek *employee* account (not a tenant's
      own team member). No UI grants this; set it by hand:
        update profiles set is_staff = true where email = 'ali@vireek.com';
    - support_conversations / support_messages: visitors are anonymous
      Supabase Auth users (supabase.auth.signInAnonymously()), not real
      accounts — gives every visitor a stable auth.uid() for RLS and
      Realtime without a signup flow.
    - is_vireek_staff(): shared helper so every policy reads the same way.

  Part B — Academy / self-service onboarding video course:
    - academy_progress: per-user lesson completions. Course content itself
      (titles, video URLs) is static data in src/lib/academy.ts.
*/

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION is_vireek_staff(uid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE((SELECT is_staff FROM profiles WHERE id = uid), false);
$$;

GRANT EXECUTE ON FUNCTION is_vireek_staff(uuid) TO authenticated, anon;

CREATE TABLE IF NOT EXISTS support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id uuid NOT NULL,
  visitor_name text,
  visitor_email text,
  page_path text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'closed')),
  assigned_staff_id uuid REFERENCES profiles(id),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_conversations_visitor ON support_conversations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_support_conversations_status ON support_conversations(status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('visitor', 'staff')),
  sender_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id, created_at);

ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "visitor_select_own_conversation" ON support_conversations;
CREATE POLICY "visitor_select_own_conversation" ON support_conversations FOR SELECT TO authenticated, anon
  USING (visitor_id = auth.uid() OR is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "visitor_insert_own_conversation" ON support_conversations;
CREATE POLICY "visitor_insert_own_conversation" ON support_conversations FOR INSERT TO authenticated, anon
  WITH CHECK (visitor_id = auth.uid());

DROP POLICY IF EXISTS "update_conversation" ON support_conversations;
CREATE POLICY "update_conversation" ON support_conversations FOR UPDATE TO authenticated, anon
  USING (visitor_id = auth.uid() OR is_vireek_staff(auth.uid()))
  WITH CHECK (visitor_id = auth.uid() OR is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "select_messages_in_own_conversation" ON support_messages;
CREATE POLICY "select_messages_in_own_conversation" ON support_messages FOR SELECT TO authenticated, anon
  USING (
    is_vireek_staff(auth.uid())
    OR EXISTS (SELECT 1 FROM support_conversations c WHERE c.id = conversation_id AND c.visitor_id = auth.uid())
  );

DROP POLICY IF EXISTS "insert_message_in_own_conversation" ON support_messages;
CREATE POLICY "insert_message_in_own_conversation" ON support_messages FOR INSERT TO authenticated, anon
  WITH CHECK (
    sender_id = auth.uid()
    AND (
      (sender_type = 'staff' AND is_vireek_staff(auth.uid()))
      OR (
        sender_type = 'visitor'
        AND EXISTS (SELECT 1 FROM support_conversations c WHERE c.id = conversation_id AND c.visitor_id = auth.uid())
      )
    )
  );

CREATE OR REPLACE FUNCTION touch_support_conversation()
RETURNS trigger AS $$
BEGIN
  UPDATE support_conversations
  SET last_message_at = NEW.created_at,
      status = CASE WHEN status = 'closed' AND NEW.sender_type = 'visitor' THEN 'open' ELSE status END
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_touch_support_conversation ON support_messages;
CREATE TRIGGER trg_touch_support_conversation
  AFTER INSERT ON support_messages
  FOR EACH ROW EXECUTE FUNCTION touch_support_conversation();

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE support_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE support_conversations;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS academy_progress (
  user_id uuid NOT NULL DEFAULT auth.uid(),
  lesson_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

ALTER TABLE academy_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_academy_progress" ON academy_progress;
CREATE POLICY "select_own_academy_progress" ON academy_progress FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_academy_progress" ON academy_progress;
CREATE POLICY "insert_own_academy_progress" ON academy_progress FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_academy_progress" ON academy_progress;
CREATE POLICY "delete_own_academy_progress" ON academy_progress FOR DELETE TO authenticated USING (user_id = auth.uid());
