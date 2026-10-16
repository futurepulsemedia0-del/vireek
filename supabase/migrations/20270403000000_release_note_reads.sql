/*
  # What's New: per-user read state

  One row per (user, release) the user has marked as read. Release ids are the ISO dates
  derived from src/lib/changelog.ts ("2026-09-06"). Deliberately scoped to auth.uid() and NOT
  get_account_owner_id(): every team member keeps their own unread badge.
*/

CREATE TABLE IF NOT EXISTS release_note_reads (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  release_id text NOT NULL CHECK (char_length(release_id) BETWEEN 1 AND 64),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, release_id)
);

ALTER TABLE release_note_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_release_note_reads" ON release_note_reads;
CREATE POLICY "select_own_release_note_reads" ON release_note_reads
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_release_note_reads" ON release_note_reads;
CREATE POLICY "insert_own_release_note_reads" ON release_note_reads
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

REVOKE ALL ON release_note_reads FROM anon;
