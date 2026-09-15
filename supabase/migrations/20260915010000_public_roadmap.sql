/*
  # Public Roadmap (feature requests + voting)

  Public-facing "what should we build next" board, in the same spirit as
  the existing /changelog (which shows what already shipped). Logged-out
  visitors can browse and read every idea; only authenticated users can
  submit a new idea or vote.

  votes_count lives on roadmap_items so the public list page renders with
  a single query and no joins — kept in sync by a trigger on
  roadmap_votes, the same "trigger keeps a counter column correct"
  pattern already used for outbound_calls -> dnc_suppressions.

  Curation (moving an item under_review -> planned -> in_progress ->
  shipped, or declined) is done by the team directly in the Supabase
  dashboard / service role — there is intentionally no UPDATE policy for
  regular users.
*/

CREATE TABLE IF NOT EXISTS roadmap_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'general'
    CHECK (category IN ('feature', 'integration', 'improvement', 'general')),
  status text NOT NULL DEFAULT 'under_review'
    CHECK (status IN ('under_review', 'planned', 'in_progress', 'shipped', 'declined')),
  votes_count integer NOT NULL DEFAULT 0,
  submitted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roadmap_items_status ON roadmap_items(status, votes_count DESC);

ALTER TABLE roadmap_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_roadmap_items" ON roadmap_items;
CREATE POLICY "select_roadmap_items" ON roadmap_items FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_own_roadmap_items" ON roadmap_items;
CREATE POLICY "insert_own_roadmap_items" ON roadmap_items FOR INSERT TO authenticated
  WITH CHECK (submitted_by = auth.uid());

CREATE TABLE IF NOT EXISTS roadmap_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_roadmap_votes_item ON roadmap_votes(item_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_votes_user ON roadmap_votes(user_id);

ALTER TABLE roadmap_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_roadmap_votes" ON roadmap_votes;
CREATE POLICY "select_own_roadmap_votes" ON roadmap_votes FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_roadmap_votes" ON roadmap_votes;
CREATE POLICY "insert_own_roadmap_votes" ON roadmap_votes FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_roadmap_votes" ON roadmap_votes;
CREATE POLICY "delete_own_roadmap_votes" ON roadmap_votes FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION sync_roadmap_votes_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE roadmap_items SET votes_count = votes_count + 1, updated_at = now() WHERE id = NEW.item_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE roadmap_items SET votes_count = GREATEST(votes_count - 1, 0), updated_at = now() WHERE id = OLD.item_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_roadmap_vote_insert ON roadmap_votes;
CREATE TRIGGER trg_roadmap_vote_insert
  AFTER INSERT ON roadmap_votes
  FOR EACH ROW EXECUTE FUNCTION sync_roadmap_votes_count();

DROP TRIGGER IF EXISTS trg_roadmap_vote_delete ON roadmap_votes;
CREATE TRIGGER trg_roadmap_vote_delete
  AFTER DELETE ON roadmap_votes
  FOR EACH ROW EXECUTE FUNCTION sync_roadmap_votes_count();
