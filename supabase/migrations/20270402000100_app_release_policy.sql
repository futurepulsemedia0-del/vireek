-- Minimum / latest app version per platform, read by the native app before login.
-- Bump min_version in the SQL editor to force old builds to update; bump latest_version to
-- show the dismissible "update available" banner. No client write path exists.

CREATE TABLE IF NOT EXISTS public.app_release_policy (
  platform text PRIMARY KEY CHECK (platform IN ('ios', 'android')),
  min_version text NOT NULL DEFAULT '0.0.0',
  latest_version text NOT NULL DEFAULT '0.0.0',
  store_url text,
  message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_release_policy ENABLE ROW LEVEL SECURITY; -- no policies: reads go through the RPC below

CREATE OR REPLACE FUNCTION public.get_app_release_policy(p_platform text)
RETURNS TABLE (min_version text, latest_version text, store_url text, message text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.min_version, p.latest_version, p.store_url, p.message
  FROM public.app_release_policy p
  WHERE p.platform = p_platform;
$$;

REVOKE ALL ON FUNCTION public.get_app_release_policy(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_app_release_policy(text) TO anon, authenticated;

INSERT INTO public.app_release_policy (platform, min_version, latest_version, store_url)
VALUES
  ('android', '0.0.0', '1.0.0', 'https://play.google.com/store/apps/details?id=com.vireek.field'),
  ('ios', '0.0.0', '1.0.0', NULL)
ON CONFLICT (platform) DO NOTHING;
