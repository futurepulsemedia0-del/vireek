/*
  # Resources hub lead capture

  - Hardens newsletter_subscribers (it accepts anonymous INSERTs, so it must
    enforce its own shape). Constraints are NOT VALID: they apply to new rows
    only and never block on legacy data.
  - resource_downloads: one row per (email, resource) so we can see which lead
    magnet captured whom. newsletter_subscribers is unique on email, so only the
    FIRST source would otherwise survive.
  - capture_resource_lead(): the only write path for /resources. Validates,
    upserts the subscriber (source = 'resources:<slug>') and records the download
    in one transaction. Idempotent: re-submitting never errors or duplicates.
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscribers_email_format') THEN
    ALTER TABLE newsletter_subscribers
      ADD CONSTRAINT newsletter_subscribers_email_format
      CHECK (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscribers_source_length') THEN
    ALTER TABLE newsletter_subscribers
      ADD CONSTRAINT newsletter_subscribers_source_length
      CHECK (char_length(source) <= 100) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS resource_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  resource_slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_downloads_slug_format CHECK (resource_slug ~ '^[a-z0-9-]{3,80}$'),
  CONSTRAINT resource_downloads_email_format CHECK (
    char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_downloads_email_slug ON resource_downloads(email, resource_slug);
CREATE INDEX IF NOT EXISTS idx_resource_downloads_slug_time ON resource_downloads(resource_slug, created_at DESC);

-- RLS on with NO policies + revoked grants: unreachable from the browser.
-- Readable only via service role / dashboard, like newsletter_subscribers.
ALTER TABLE resource_downloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resource_downloads FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.capture_resource_lead(p_email text, p_resource_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_slug text := lower(btrim(coalesce(p_resource_slug, '')));
BEGIN
  IF char_length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  IF v_slug !~ '^[a-z0-9-]{3,80}$' THEN
    RAISE EXCEPTION 'invalid_resource';
  END IF;

  -- Abuse guard per email (the registry has far fewer than 20 resources).
  IF (SELECT count(*) FROM resource_downloads
      WHERE email = v_email AND created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  INSERT INTO newsletter_subscribers (email, source)
  VALUES (v_email, 'resources:' || v_slug)
  ON CONFLICT (email) DO NOTHING;

  INSERT INTO resource_downloads (email, resource_slug)
  VALUES (v_email, v_slug)
  ON CONFLICT (email, resource_slug) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.capture_resource_lead(text, text) TO anon, authenticated;
