/*
  # Blog newsletter (double opt-in)

  - `blog_subscribers`: one row per email. status pending -> confirmed -> unsubscribed.
    The confirmation token is stored only as a SHA-256 hash and expires after 48 h.
    consent_text / consent_version / consent_at record what the visitor agreed to.
  - `blog_newsletter_rate_limits` + `consume_blog_newsletter_rate_limit`: hourly counters keyed by
    hashed IP / hashed email (no raw IPs are stored).
  - RLS is enabled with NO policies and all grants are revoked from anon/authenticated: the only
    reader/writer is the `blog-newsletter` Edge Function (service role). Visitors never touch the tables.

  Rollback:
    DROP FUNCTION IF EXISTS consume_blog_newsletter_rate_limit(text, integer);
    DROP TABLE IF EXISTS blog_newsletter_rate_limits;
    DROP TABLE IF EXISTS blog_subscribers;
*/

CREATE TABLE IF NOT EXISTS blog_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (length(email) <= 254),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token_hash text,
  confirm_expires_at timestamptz,
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  consent_text text NOT NULL,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  source text CHECK (source IS NULL OR length(source) <= 80),
  last_confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_subscribers_email ON blog_subscribers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_subscribers_unsubscribe_token ON blog_subscribers (unsubscribe_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_subscribers_confirm_token_hash
  ON blog_subscribers (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blog_subscribers_status ON blog_subscribers (status);

ALTER TABLE blog_subscribers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON blog_subscribers FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS blog_newsletter_rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE blog_newsletter_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON blog_newsletter_rate_limits FROM anon, authenticated;

/* Returns true while the caller is within `p_limit` hits for the current hour. */
CREATE OR REPLACE FUNCTION consume_blog_newsletter_rate_limit(p_key text, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window timestamptz := date_trunc('hour', now());
  v_hits integer;
BEGIN
  DELETE FROM blog_newsletter_rate_limits WHERE window_start < now() - interval '2 days';
  INSERT INTO blog_newsletter_rate_limits AS r (key, window_start, hits)
  VALUES (p_key, v_window, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;
  RETURN v_hits <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION consume_blog_newsletter_rate_limit(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_blog_newsletter_rate_limit(text, integer) TO service_role;
