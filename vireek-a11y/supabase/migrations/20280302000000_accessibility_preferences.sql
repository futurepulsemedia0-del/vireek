-- Per-user accessibility preferences (opt-in cloud sync for the Accessibility Center).
-- Personal, not tenant data: strictly one row per auth user, readable/writable only by that user.
-- Rollback: ship a new migration that removes the table (data is user-owned and optional).

CREATE TABLE IF NOT EXISTS public.accessibility_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  settings jsonb NOT NULL,
  version integer NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accessibility_preferences_settings_is_object CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT accessibility_preferences_settings_size CHECK (pg_column_size(settings) <= 16384)
);

ALTER TABLE public.accessibility_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accessibility_preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accessibility_preferences_select_own ON public.accessibility_preferences;
CREATE POLICY accessibility_preferences_select_own ON public.accessibility_preferences
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS accessibility_preferences_insert_own ON public.accessibility_preferences;
CREATE POLICY accessibility_preferences_insert_own ON public.accessibility_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS accessibility_preferences_update_own ON public.accessibility_preferences;
CREATE POLICY accessibility_preferences_update_own ON public.accessibility_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS accessibility_preferences_delete_own ON public.accessibility_preferences;
CREATE POLICY accessibility_preferences_delete_own ON public.accessibility_preferences
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- Server-side clock is authoritative for last-write-wins; clients cannot forge updated_at.
CREATE OR REPLACE FUNCTION public.accessibility_preferences_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accessibility_preferences_touch ON public.accessibility_preferences;
CREATE TRIGGER accessibility_preferences_touch
  BEFORE INSERT OR UPDATE ON public.accessibility_preferences
  FOR EACH ROW EXECUTE FUNCTION public.accessibility_preferences_touch();

REVOKE ALL ON public.accessibility_preferences FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accessibility_preferences TO authenticated;
