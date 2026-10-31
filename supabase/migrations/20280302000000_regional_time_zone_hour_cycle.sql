-- Regional operations: business time zone + clock style
--
-- Adds two columns to the existing business_regional_settings table:
--   time_zone  : IANA zone the business operates in (NULL = show every viewer their own zone)
--   hour_cycle : 'auto' (follow language) | '12h' | '24h'
--
-- RLS is unchanged: the existing regional_select / regional_insert_owner /
-- regional_update_owner policies are row-level and already cover new columns.
--
-- ROLLBACK (loses the two saved settings; nothing else depends on them):
--   DROP TRIGGER IF EXISTS trigger_regional_time_zone ON public.business_regional_settings;
--   DROP FUNCTION IF EXISTS public.validate_regional_time_zone();
--   ALTER TABLE public.business_regional_settings DROP CONSTRAINT IF EXISTS business_regional_settings_hour_cycle_check;
--   ALTER TABLE public.business_regional_settings DROP COLUMN IF EXISTS hour_cycle, DROP COLUMN IF EXISTS time_zone;

ALTER TABLE public.business_regional_settings
  ADD COLUMN IF NOT EXISTS time_zone text,
  ADD COLUMN IF NOT EXISTS hour_cycle text NOT NULL DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_regional_settings_hour_cycle_check'
      AND conrelid = 'public.business_regional_settings'::regclass
  ) THEN
    ALTER TABLE public.business_regional_settings
      ADD CONSTRAINT business_regional_settings_hour_cycle_check
      CHECK (hour_cycle IN ('auto', '12h', '24h'));
  END IF;
END $$;

-- Reject unknown zones (a CHECK cannot query pg_timezone_names, so use a trigger).
CREATE OR REPLACE FUNCTION public.validate_regional_time_zone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.time_zone IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown timezone: %', NEW.time_zone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trigger_regional_time_zone ON public.business_regional_settings;
CREATE TRIGGER trigger_regional_time_zone
  BEFORE INSERT OR UPDATE OF time_zone ON public.business_regional_settings
  FOR EACH ROW EXECUTE FUNCTION public.validate_regional_time_zone();
