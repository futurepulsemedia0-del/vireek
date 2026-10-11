/*
  # Customizable Overview — per-user saved layouts

  One row per signed-in user (owner or team member) holding their personal
  Overview layout: widget order, column span, row height and hidden state.
  Role presets (owner / dispatcher / CSR / technician) live in code; a row
  exists only once the user customizes. "Reset to default" deletes the row,
  so the role preset (including widgets shipped later) applies again.

  Security: RLS on, every policy scoped to auth.uid(). The layout is pure UI
  state — no business data — and is validated again client-side on load.
*/

CREATE TABLE IF NOT EXISTS public.overview_layouts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  layout jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  preset text NOT NULL DEFAULT 'custom'
    CHECK (preset IN ('owner', 'dispatcher', 'csr', 'technician', 'custom')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT overview_layouts_layout_is_object CHECK (jsonb_typeof(layout) = 'object'),
  CONSTRAINT overview_layouts_layout_size CHECK (pg_column_size(layout) <= 32768)
);

ALTER TABLE public.overview_layouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS overview_layouts_select_own ON public.overview_layouts;
CREATE POLICY overview_layouts_select_own ON public.overview_layouts
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS overview_layouts_insert_own ON public.overview_layouts;
CREATE POLICY overview_layouts_insert_own ON public.overview_layouts
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS overview_layouts_update_own ON public.overview_layouts;
CREATE POLICY overview_layouts_update_own ON public.overview_layouts
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS overview_layouts_delete_own ON public.overview_layouts;
CREATE POLICY overview_layouts_delete_own ON public.overview_layouts
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.overview_layouts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.overview_layouts TO authenticated;

DROP TRIGGER IF EXISTS overview_layouts_set_updated_at ON public.overview_layouts;
CREATE TRIGGER overview_layouts_set_updated_at
  BEFORE UPDATE ON public.overview_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
