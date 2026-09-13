/*
# Saved views (Calls / Leads / Jobs)

## Why
Owners re-apply the same filter combo every day (e.g. "emergency +
unbooked this week"). Saved views let them store and reload that
combo by name instead of rebuilding it every visit.

## What this does
- New `saved_views` table: one row per saved filter set, scoped to
  the user who created it — same per-user scoping the rest of the
  app uses (a team member's saved views are personal, not shared).
- `filters` is a jsonb blob — each page (Calls/Leads/Jobs) owns its
  own shape and is responsible for reading it back safely.
- Same RLS pattern as outbound_campaigns: strictly own-rows only.
  Views are immutable once saved (delete + recreate to "edit"), so
  no UPDATE policy is needed.
*/

CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  page text NOT NULL CHECK (page IN ('calls', 'leads', 'jobs')),
  name text NOT NULL CHECK (char_length(trim(name)) > 0),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_views_user_page ON saved_views (user_id, page);

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_saved_views" ON saved_views;
CREATE POLICY "select_own_saved_views" ON saved_views FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_saved_views" ON saved_views;
CREATE POLICY "insert_own_saved_views" ON saved_views FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_saved_views" ON saved_views;
CREATE POLICY "delete_own_saved_views" ON saved_views FOR DELETE TO authenticated USING (user_id = auth.uid());
