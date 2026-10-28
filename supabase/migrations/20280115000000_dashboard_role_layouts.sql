/*
  # Dashboard Builder — saved Overview layouts per role

  Adds: dashboard_role_layouts — one row per (account, role) holding the Overview
  layout that account owners/admins publish for a role (owner, dispatcher, csr,
  technician). Powers /dashboard/dashboard-builder.

  ## How it fits with the existing system
  - public.overview_layouts (per-user layouts) is NOT changed.
  - Which layout a person sees, first match wins:
      1. their own saved layout (overview_layouts)
      2. the account's layout for their role (this table)
      3. the built-in preset for their role (lives in code)
  - "Reset to default" in the builder deletes the row, so step 3 applies again.

  ## Security
  - RLS follows this project's standard: `public.get_account_owner_id()` so the
    account owner and every team member can READ their account's role layouts.
  - Only people with the `can_manage_team` permission (the owner always has it)
    can INSERT / UPDATE / DELETE, checked with `public.has_account_permission()`.
  - Additive only: no existing table, column, policy or function is changed.

  ## Requires (already in your project)
  public.profiles, public.get_account_owner_id(), public.has_account_permission(text)
*/

CREATE TABLE IF NOT EXISTS public.dashboard_role_layouts (
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id()
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  role_key text NOT NULL
    CHECK (role_key IN ('owner', 'dispatcher', 'csr', 'technician')),
  layout jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key),
  CONSTRAINT dashboard_role_layouts_layout_is_object CHECK (jsonb_typeof(layout) = 'object'),
  CONSTRAINT dashboard_role_layouts_layout_size CHECK (pg_column_size(layout) <= 32768)
);

ALTER TABLE public.dashboard_role_layouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_dashboard_role_layouts" ON public.dashboard_role_layouts;
CREATE POLICY "select_account_dashboard_role_layouts" ON public.dashboard_role_layouts
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "insert_account_dashboard_role_layouts" ON public.dashboard_role_layouts;
CREATE POLICY "insert_account_dashboard_role_layouts" ON public.dashboard_role_layouts
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT public.get_account_owner_id())
    AND (SELECT public.has_account_permission('can_manage_team'))
  );

DROP POLICY IF EXISTS "update_account_dashboard_role_layouts" ON public.dashboard_role_layouts;
CREATE POLICY "update_account_dashboard_role_layouts" ON public.dashboard_role_layouts
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT public.get_account_owner_id())
    AND (SELECT public.has_account_permission('can_manage_team'))
  )
  WITH CHECK (
    user_id = (SELECT public.get_account_owner_id())
    AND (SELECT public.has_account_permission('can_manage_team'))
  );

DROP POLICY IF EXISTS "delete_account_dashboard_role_layouts" ON public.dashboard_role_layouts;
CREATE POLICY "delete_account_dashboard_role_layouts" ON public.dashboard_role_layouts
  FOR DELETE TO authenticated
  USING (
    user_id = (SELECT public.get_account_owner_id())
    AND (SELECT public.has_account_permission('can_manage_team'))
  );

REVOKE ALL ON public.dashboard_role_layouts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_role_layouts TO authenticated;

CREATE OR REPLACE FUNCTION public.dashboard_role_layouts_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dashboard_role_layouts_touch ON public.dashboard_role_layouts;
CREATE TRIGGER trg_dashboard_role_layouts_touch
  BEFORE INSERT OR UPDATE ON public.dashboard_role_layouts
  FOR EACH ROW EXECUTE FUNCTION public.dashboard_role_layouts_touch();

COMMENT ON TABLE public.dashboard_role_layouts IS
  'Account-level Overview layout per role (owner|dispatcher|csr|technician), published from /dashboard/dashboard-builder. A person''s own overview_layouts row wins; with neither, the built-in code preset applies.';
