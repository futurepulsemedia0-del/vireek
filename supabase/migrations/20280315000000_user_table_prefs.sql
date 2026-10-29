/*
# Per-user, per-table UI preferences

## Why
Filters, sort, column visibility/order/width, density and page size should follow
the user across devices. Named "saved views" already live in `saved_views`; this
table stores the *current working state* of each table, one row per (user, table).

## Security
- RLS: a user can read/write ONLY their own rows (user_id = auth.uid()).
- `user_id` defaults to auth.uid() and is re-checked in WITH CHECK, so a client
  cannot write a row for someone else.
- `state` is capped at 32 KB and must be a JSON object.
*/

CREATE TABLE IF NOT EXISTS public.user_table_prefs (
  user_id    uuid        NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  table_key  text        NOT NULL CHECK (table_key ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  state      jsonb       NOT NULL DEFAULT '{}'::jsonb
             CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 32768),
  version    integer     NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, table_key)
);

ALTER TABLE public.user_table_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_table_prefs_select_own" ON public.user_table_prefs;
CREATE POLICY "user_table_prefs_select_own" ON public.user_table_prefs
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_table_prefs_insert_own" ON public.user_table_prefs;
CREATE POLICY "user_table_prefs_insert_own" ON public.user_table_prefs
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_table_prefs_update_own" ON public.user_table_prefs;
CREATE POLICY "user_table_prefs_update_own" ON public.user_table_prefs
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "user_table_prefs_delete_own" ON public.user_table_prefs;
CREATE POLICY "user_table_prefs_delete_own" ON public.user_table_prefs
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_table_prefs TO authenticated;

CREATE OR REPLACE FUNCTION public.user_table_prefs_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_table_prefs_touch ON public.user_table_prefs;
CREATE TRIGGER trg_user_table_prefs_touch
  BEFORE UPDATE ON public.user_table_prefs
  FOR EACH ROW EXECUTE FUNCTION public.user_table_prefs_touch();

-- Rollback (manual): DROP TABLE public.user_table_prefs; DROP FUNCTION public.user_table_prefs_touch();
