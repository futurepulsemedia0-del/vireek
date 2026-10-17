/*
  # Reputation Management (/dashboard/reputation)

  One inbox for Google / Yelp / Facebook reviews with AI-drafted replies,
  low-rating alerts and rating trends. Everything is keyed by the ACCOUNT
  OWNER's profile id (user_id = get_account_owner_id()).

  Tables
    review_connections             one row per connected listing (Google location,
                                   Yelp business, Facebook page)
    review_connection_credentials  encrypted OAuth tokens — service role ONLY
                                   (RLS on, zero policies), same posture as
                                   ad_account_credentials
    reviews                        the unified inbox (API-synced OR manually logged)
    reputation_settings            alert threshold, brand voice, sign-off

  Access model (same as Unified Inbox / email_settings / inspection_reports):
    - Account members can SELECT their account's rows.
    - Every write goes through the service-role `reputation` /
      `reputation-sync` / `reputation-oauth-callback` edge functions, so the
      permission gate runs, provider calls happen server-side and a client can
      never forge a review, a rating or a "replied" state.

  Scheduling: reputation-sync should run every ~2 hours (X-Cron-Secret =
  REPUTATION_CRON_SECRET). If pg_cron is enabled:

    select cron.schedule('reputation-sync', '0 */2 * * *', $$
      select net.http_post(
        url := '<project-ref>.supabase.co/functions/v1/reputation-sync',
        headers := jsonb_build_object('X-Cron-Secret', '<REPUTATION_CRON_SECRET>')
      );
    $$);

  Any external scheduler that can POST the URL works too.
*/

CREATE TABLE IF NOT EXISTS review_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('google', 'yelp', 'facebook')),
  external_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'error')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_review_connections_user ON review_connections(user_id);

CREATE TABLE IF NOT EXISTS review_connection_credentials (
  connection_id uuid PRIMARY KEY REFERENCES review_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  encrypted_access_token text,
  encrypted_refresh_token text,
  access_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE review_connection_credentials ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: tokens are readable/writable by the service role only.

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES review_connections(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('google', 'yelp', 'facebook')),
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'manual')),
  external_id text,
  reviewer_name text NOT NULL DEFAULT 'Anonymous' CHECK (length(reviewer_name) <= 120),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text CHECK (body IS NULL OR length(body) <= 5000),
  reviewed_at timestamptz NOT NULL,
  review_url text CHECK (review_url IS NULL OR length(review_url) <= 600),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'dismissed')),
  draft_reply text CHECK (draft_reply IS NULL OR length(draft_reply) <= 4096),
  draft_source text CHECK (draft_source IS NULL OR draft_source IN ('ai', 'template', 'staff')),
  draft_generated_at timestamptz,
  reply_text text CHECK (reply_text IS NULL OR length(reply_text) <= 4096),
  replied_at timestamptz,
  reply_via text CHECK (reply_via IS NULL OR reply_via IN ('api', 'manual', 'platform')),
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Re-syncing never duplicates an API review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_external
  ON reviews(user_id, platform, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_user_time ON reviews(user_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_user_open ON reviews(user_id, status) WHERE status = 'new';

ALTER TABLE review_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_review_connections" ON review_connections;
CREATE POLICY "select_account_review_connections" ON review_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_account_reviews" ON reviews;
CREATE POLICY "select_account_reviews" ON reviews FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS reputation_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  alerts_enabled boolean NOT NULL DEFAULT true,
  alert_max_rating smallint NOT NULL DEFAULT 3 CHECK (alert_max_rating BETWEEN 1 AND 5),
  brand_voice text CHECK (brand_voice IS NULL OR length(brand_voice) <= 500),
  signoff text CHECK (signoff IS NULL OR length(signoff) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reputation_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_reputation_settings" ON reputation_settings;
CREATE POLICY "select_account_reputation_settings" ON reputation_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
