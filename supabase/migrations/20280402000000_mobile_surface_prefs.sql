-- Per-person settings for glanceable mobile surfaces (lock screen, widgets, watch, Siri).
-- Privacy-first defaults: customer names/addresses are hidden on lock screens until the user opts in.
-- Written only by the signed-in person for their own row; read by service role (push dispatch).

CREATE TABLE IF NOT EXISTS public.user_mobile_surface_prefs (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  hide_customer_names boolean NOT NULL DEFAULT true,
  live_activities_enabled boolean NOT NULL DEFAULT true,
  widgets_enabled boolean NOT NULL DEFAULT true,
  watch_enabled boolean NOT NULL DEFAULT true,
  voice_assistant_enabled boolean NOT NULL DEFAULT true,
  time_sensitive_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_mobile_surface_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_mobile_surface_prefs" ON public.user_mobile_surface_prefs;
CREATE POLICY "select_own_mobile_surface_prefs"
ON public.user_mobile_surface_prefs FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_mobile_surface_prefs" ON public.user_mobile_surface_prefs;
CREATE POLICY "insert_own_mobile_surface_prefs"
ON public.user_mobile_surface_prefs FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_mobile_surface_prefs" ON public.user_mobile_surface_prefs;
CREATE POLICY "update_own_mobile_surface_prefs"
ON public.user_mobile_surface_prefs FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_mobile_surface_prefs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_mobile_surface_prefs ON public.user_mobile_surface_prefs;
CREATE TRIGGER trg_touch_mobile_surface_prefs
BEFORE UPDATE ON public.user_mobile_surface_prefs
FOR EACH ROW EXECUTE FUNCTION public.touch_mobile_surface_prefs();

-- Rollback: DROP TABLE public.user_mobile_surface_prefs; DROP FUNCTION public.touch_mobile_surface_prefs();
