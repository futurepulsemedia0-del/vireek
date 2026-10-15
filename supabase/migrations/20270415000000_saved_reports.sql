/*
  # Saved reports — custom report builder (/dashboard/reports)

  ## Why
  Owners and managers keep asking the same ad-hoc questions ("emergency calls
  by source this quarter", "revenue by service type", "leads quoted but not
  won"). Saved reports let them define the question once — entity, columns,
  filters, grouping, chart — and re-run it against live data.

  ## What this does
  - New `saved_reports` table: one row per saved report definition, scoped to
    the ACCOUNT OWNER (user_id = owner), so the whole team shares one library.
  - The report runs client-side against the entity tables, which keep their
    own RLS. Only the *definition* is stored here, never result rows.
  - `definition` is a size-capped jsonb object; the app (src/lib/reportBuilder.ts)
    re-validates it on every read, so a hand-edited row can never crash the UI.
  - Permission gate: owner, or a team member with `can_view_billing`
    (same rule as Analytics / Click-to-Cash, enforced here AND in the UI).
  - Names are unique per account (case-insensitive).
*/

-- =============================================================
-- 1. Permission helper (same rule as fabric_can_view)
-- =============================================================
CREATE OR REPLACE FUNCTION public.reports_can_access(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = p_owner
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      WHERE tm.account_owner_id = p_owner
        AND lower(tm.member_email) = lower((SELECT email FROM auth.users WHERE id = auth.uid()))
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

REVOKE ALL ON FUNCTION public.reports_can_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reports_can_access(uuid) TO authenticated;

-- =============================================================
-- 2. Table
-- =============================================================
CREATE TABLE IF NOT EXISTS saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  entity text NOT NULL CHECK (entity IN ('calls', 'leads', 'jobs', 'customers')),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(definition) = 'object' AND pg_column_size(definition) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_reports_user_name
  ON saved_reports (user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_saved_reports_user_updated
  ON saved_reports (user_id, updated_at DESC);

-- updated_at bump + immutable ownership columns
CREATE OR REPLACE FUNCTION public.saved_reports_before_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.user_id := OLD.user_id;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saved_reports_before_update ON saved_reports;
CREATE TRIGGER trg_saved_reports_before_update
  BEFORE UPDATE ON saved_reports
  FOR EACH ROW EXECUTE FUNCTION public.saved_reports_before_update();

-- =============================================================
-- 3. RLS — account-scoped + permission-gated
-- =============================================================
ALTER TABLE saved_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON saved_reports FROM anon;

DROP POLICY IF EXISTS "select_saved_reports" ON saved_reports;
CREATE POLICY "select_saved_reports" ON saved_reports FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "insert_saved_reports" ON saved_reports;
CREATE POLICY "insert_saved_reports" ON saved_reports FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.reports_can_access(user_id)
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "update_saved_reports" ON saved_reports;
CREATE POLICY "update_saved_reports" ON saved_reports FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id))
  WITH CHECK (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

DROP POLICY IF EXISTS "delete_saved_reports" ON saved_reports;
CREATE POLICY "delete_saved_reports" ON saved_reports FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.reports_can_access(user_id));

COMMENT ON TABLE saved_reports IS
  'Saved definitions for the /dashboard/reports builder (entity, columns, filters, grouping, chart). Definitions only — result rows are never stored.';
