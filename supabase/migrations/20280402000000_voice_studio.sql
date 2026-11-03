/*
  # Voice Studio (Phase 1)
  Rollback: DROP TABLE public.voice_studio_preview_log; DROP TABLE public.voice_studio_profiles;
            DROP FUNCTION public.voice_studio_touch_updated_at();
*/
CREATE OR REPLACE FUNCTION public.voice_studio_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.voice_studio_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  location_id uuid REFERENCES public.business_locations(id) ON DELETE CASCADE,
  scenario text NOT NULL DEFAULT 'default' CHECK (scenario IN ('default', 'emergency', 'sales')),
  voice_key text NOT NULL CHECK (voice_key IN (
    'sarah-warm-f-us', 'aria-friendly-f-us', 'maya-calm-f-uk',
    'miles-confident-m-us', 'jay-easygoing-m-us', 'oliver-polished-m-uk'
  )),
  tuning jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(tuning) = 'object' AND octet_length(tuning::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_studio_profiles_scope_uq
  ON public.voice_studio_profiles (user_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid), scenario);

DROP TRIGGER IF EXISTS voice_studio_profiles_touch ON public.voice_studio_profiles;
CREATE TRIGGER voice_studio_profiles_touch
  BEFORE UPDATE ON public.voice_studio_profiles
  FOR EACH ROW EXECUTE FUNCTION public.voice_studio_touch_updated_at();

ALTER TABLE public.voice_studio_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_studio_profiles_select ON public.voice_studio_profiles;
CREATE POLICY voice_studio_profiles_select ON public.voice_studio_profiles
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS voice_studio_profiles_insert ON public.voice_studio_profiles;
CREATE POLICY voice_studio_profiles_insert ON public.voice_studio_profiles
  FOR INSERT TO authenticated WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (voice_studio_profiles.location_id IS NULL OR EXISTS (
      SELECT 1 FROM public.business_locations l
      WHERE l.id = voice_studio_profiles.location_id AND l.user_id = public.get_account_owner_id()))
  );

DROP POLICY IF EXISTS voice_studio_profiles_update ON public.voice_studio_profiles;
CREATE POLICY voice_studio_profiles_update ON public.voice_studio_profiles
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (voice_studio_profiles.location_id IS NULL OR EXISTS (
      SELECT 1 FROM public.business_locations l
      WHERE l.id = voice_studio_profiles.location_id AND l.user_id = public.get_account_owner_id()))
  );

DROP POLICY IF EXISTS voice_studio_profiles_delete ON public.voice_studio_profiles;
CREATE POLICY voice_studio_profiles_delete ON public.voice_studio_profiles
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_studio_profiles TO authenticated;

CREATE TABLE IF NOT EXISTS public.voice_studio_preview_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  voice_key text NOT NULL,
  chars integer NOT NULL CHECK (chars >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ok boolean NOT NULL,
  est_cost_cents numeric(10, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_studio_preview_log_user_time
  ON public.voice_studio_preview_log (user_id, created_at DESC);

ALTER TABLE public.voice_studio_preview_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_studio_preview_log_select ON public.voice_studio_preview_log;
CREATE POLICY voice_studio_preview_log_select ON public.voice_studio_preview_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

GRANT SELECT ON public.voice_studio_preview_log TO authenticated;
