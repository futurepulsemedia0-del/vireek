-- "Was this helpful?" feedback from the public developer docs.
-- Visitors (anon or signed in) may INSERT only; nobody but the service role can read it back.
-- Size limits are enforced here, not only in the UI. There is no rate limit at this layer: if abused,
-- add one in an edge function or via Supabase's API gateway limits.
-- Rollback: DROP TABLE docs_feedback;

CREATE TABLE IF NOT EXISTS docs_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page text NOT NULL CHECK (char_length(page) BETWEEN 1 AND 200),
  helpful boolean NOT NULL,
  comment text CHECK (comment IS NULL OR char_length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_feedback_page_created ON docs_feedback (page, created_at DESC);

ALTER TABLE docs_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone_can_submit_docs_feedback" ON docs_feedback;
CREATE POLICY "anyone_can_submit_docs_feedback" ON docs_feedback
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

REVOKE ALL ON docs_feedback FROM anon, authenticated;
GRANT INSERT ON docs_feedback TO anon, authenticated;
