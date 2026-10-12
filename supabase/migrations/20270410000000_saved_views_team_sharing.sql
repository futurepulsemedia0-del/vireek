/*
# Saved views: every list page, team sharing, default view

## Why
`saved_views` shipped for Calls only (personal, filters only). Owners and
office staff now want the same "save my filters" workflow on Jobs, Leads,
Customers, Quotes, Invoices and Equipment, with the ability to share a view
with the team and to open a page already on their preferred view.

## What this does (additive, backwards compatible, safe to re-run)
- Widens the `page` CHECK to: calls, leads, jobs, customers, quotes,
  invoices, equipment.
- New columns: `sort` (jsonb {key, dir}), `columns` (jsonb string[]),
  `is_shared`, `is_default`, `owner_id` (the account the view belongs to,
  resolved with get_account_owner_id()), `updated_at`.
- Existing rows are back-filled: owner_id = the creator's account owner;
  they stay private (is_shared = false) with no default.
- RLS (replaces the own-rows-only policies):
    SELECT  my own views, plus views my teammates shared in MY account.
    INSERT  only as myself, only into my own account.
    UPDATE  only my own views (rename, share/unshare, overwrite, default).
    DELETE  my own views; the account owner can also remove shared views
            of their team (moderation).
- At most ONE default view per (user, page) — enforced by a partial unique
  index. `set_saved_view_default()` flips it atomically.
- Size/shape guards (NOT VALID so legacy rows can never block the migration).
*/

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.saved_views
  ADD COLUMN IF NOT EXISTS sort jsonb,
  ADD COLUMN IF NOT EXISTS columns jsonb,
  ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Back-fill the account for rows created before sharing existed.
UPDATE public.saved_views sv
SET owner_id = COALESCE(
  (SELECT tm.account_owner_id FROM public.team_members tm WHERE tm.user_id = sv.user_id LIMIT 1),
  sv.user_id
)
WHERE sv.owner_id IS NULL;

ALTER TABLE public.saved_views ALTER COLUMN owner_id SET DEFAULT public.get_account_owner_id();
ALTER TABLE public.saved_views ALTER COLUMN owner_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------
ALTER TABLE public.saved_views DROP CONSTRAINT IF EXISTS saved_views_page_check;
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_page_check
  CHECK (page IN ('calls', 'leads', 'jobs', 'customers', 'quotes', 'invoices', 'equipment'));

ALTER TABLE public.saved_views DROP CONSTRAINT IF EXISTS saved_views_name_len;
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_name_len
  CHECK (char_length(name) <= 60) NOT VALID;

ALTER TABLE public.saved_views DROP CONSTRAINT IF EXISTS saved_views_filters_shape;
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_filters_shape
  CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 16384) NOT VALID;

ALTER TABLE public.saved_views DROP CONSTRAINT IF EXISTS saved_views_sort_shape;
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_sort_shape
  CHECK (sort IS NULL OR jsonb_typeof(sort) = 'object') NOT VALID;

ALTER TABLE public.saved_views DROP CONSTRAINT IF EXISTS saved_views_columns_shape;
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_columns_shape
  CHECK (columns IS NULL OR (jsonb_typeof(columns) = 'array' AND pg_column_size(columns) <= 2048)) NOT VALID;

-- One default per user per page.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_views_one_default
  ON public.saved_views (user_id, page) WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_saved_views_owner_page_shared
  ON public.saved_views (owner_id, page) WHERE is_shared;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saved_views_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saved_views_touch ON public.saved_views;
CREATE TRIGGER trg_saved_views_touch
  BEFORE UPDATE ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION public.saved_views_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_saved_views" ON public.saved_views;
DROP POLICY IF EXISTS "insert_own_saved_views" ON public.saved_views;
DROP POLICY IF EXISTS "delete_own_saved_views" ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_select" ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_insert" ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_update" ON public.saved_views;
DROP POLICY IF EXISTS "saved_views_delete" ON public.saved_views;

CREATE POLICY "saved_views_select" ON public.saved_views FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (is_shared AND owner_id = public.get_account_owner_id())
  );

CREATE POLICY "saved_views_insert" ON public.saved_views FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND owner_id = public.get_account_owner_id());

CREATE POLICY "saved_views_update" ON public.saved_views FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND owner_id = public.get_account_owner_id());

CREATE POLICY "saved_views_delete" ON public.saved_views FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (is_shared AND owner_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Atomic default switch (SECURITY INVOKER: RLS still applies)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_saved_view_default(p_id uuid, p_default boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_page text;
BEGIN
  SELECT page INTO v_page FROM saved_views WHERE id = p_id AND user_id = auth.uid();
  IF v_page IS NULL THEN
    RAISE EXCEPTION 'saved view not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_default THEN
    UPDATE saved_views
       SET is_default = false
     WHERE user_id = auth.uid() AND page = v_page AND is_default AND id <> p_id;
  END IF;

  UPDATE saved_views SET is_default = p_default WHERE id = p_id AND user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.set_saved_view_default(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_saved_view_default(uuid, boolean) TO authenticated;
