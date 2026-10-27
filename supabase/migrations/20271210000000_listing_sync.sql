/*
  # Listing Sync (/dashboard/listings)

  Keeps every business location's public directory listings (Apple Business
  Connect, Bing Places, Yelp, Facebook) consistent with ONE source of truth:
  `business_locations` (name / address / phone / hours) plus the account's
  website + description. Everything is keyed by the ACCOUNT OWNER's profile id
  (user_id = get_account_owner_id()).

  Tables
    listing_settings               auto-sync switch, website, description
    listing_connections            one row per connected directory account/page/business
    listing_connection_credentials encrypted OAuth tokens — service role ONLY
                                   (RLS on, zero policies; same posture as
                                   review_connection_credentials)
    listing_links                  location x directory: mode, state, drift, hashes
    listing_sync_events            audit trail of every push / check / manual confirm

  Access model (same as Reputation):
    - Account members can SELECT their account's rows.
    - Every write goes through the service-role `listings` / `listings-sync` /
      `listings-oauth-callback` edge functions, so the permission gate runs,
      provider calls happen server-side and a client can never forge a
      "synced" state.

  Self-healing: editing a location's name / phone / address / hours flips its
  links back to 'pending' via trigger, so the next sync pushes the change.

  Scheduling: listings-sync should run hourly (X-Cron-Secret = LISTINGS_CRON_SECRET):

    select cron.schedule('listings-sync', '15 * * * *', $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/listings-sync',
        headers := jsonb_build_object('X-Cron-Secret', '<LISTINGS_CRON_SECRET>', 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $$);
*/

-- =============================================================
-- SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS listing_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  auto_sync boolean NOT NULL DEFAULT true,
  website_url text CHECK (website_url IS NULL OR (website_url ~* '^https?://\S+$' AND char_length(website_url) <= 300)),
  description text CHECK (description IS NULL OR char_length(description) <= 750),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- CONNECTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS listing_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('apple', 'bing', 'yelp', 'facebook')),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'error')),
  last_synced_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_connections_user ON listing_connections(user_id);

CREATE TABLE IF NOT EXISTS listing_connection_credentials (
  connection_id uuid PRIMARY KEY REFERENCES listing_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  encrypted_access_token text,
  encrypted_refresh_token text,
  access_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- LINKS (location x directory)
-- =============================================================

CREATE TABLE IF NOT EXISTS listing_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES business_locations(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES listing_connections(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('apple', 'bing', 'yelp', 'facebook')),
  external_location_id text NOT NULL CHECK (char_length(external_location_id) BETWEEN 1 AND 200),
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('push', 'monitor', 'manual')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'synced', 'drift', 'blocked', 'error', 'needs_reauth')),
  last_pushed_hash text CHECK (last_pushed_hash IS NULL OR char_length(last_pushed_hash) <= 64),
  last_pushed_at timestamptz,
  last_checked_at timestamptz,
  drift_fields text[] NOT NULL DEFAULT '{}',
  remote_snapshot jsonb CHECK (remote_snapshot IS NULL OR jsonb_typeof(remote_snapshot) = 'object'),
  blocked_reason text CHECK (blocked_reason IS NULL OR char_length(blocked_reason) <= 300),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_listing_links_user ON listing_links(user_id);
CREATE INDEX IF NOT EXISTS idx_listing_links_connection ON listing_links(connection_id);
CREATE INDEX IF NOT EXISTS idx_listing_links_due ON listing_links(last_checked_at NULLS FIRST) WHERE state <> 'needs_reauth';

-- =============================================================
-- EVENTS (audit trail)
-- =============================================================

CREATE TABLE IF NOT EXISTS listing_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_id uuid REFERENCES business_locations(id) ON DELETE CASCADE,
  link_id uuid REFERENCES listing_links(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('apple', 'bing', 'yelp', 'facebook')),
  kind text NOT NULL CHECK (kind IN ('push', 'check', 'manual_confirm', 'link', 'unlink')),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'drift', 'blocked', 'error')),
  fields text[] NOT NULL DEFAULT '{}',
  detail text CHECK (detail IS NULL OR char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_sync_events_user_time ON listing_sync_events(user_id, created_at DESC);

-- =============================================================
-- TRIGGER: a location edit that affects the listing makes its links stale
-- =============================================================

CREATE OR REPLACE FUNCTION public.listing_links_mark_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.name, NEW.phone, NEW.address_line1, NEW.address_line2, NEW.city, NEW.state,
      NEW.postal_code, NEW.country, NEW.business_hours, NEW.status, NEW.brand_id)
     IS DISTINCT FROM
     (OLD.name, OLD.phone, OLD.address_line1, OLD.address_line2, OLD.city, OLD.state,
      OLD.postal_code, OLD.country, OLD.business_hours, OLD.status, OLD.brand_id)
  THEN
    UPDATE public.listing_links
       SET state = 'pending', updated_at = now()
     WHERE location_id = NEW.id
       AND state IN ('synced', 'drift', 'blocked');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_links_mark_pending ON business_locations;
CREATE TRIGGER trg_listing_links_mark_pending
  AFTER UPDATE ON business_locations
  FOR EACH ROW EXECUTE FUNCTION public.listing_links_mark_pending();

-- =============================================================
-- RLS: members read, only the service role writes
-- =============================================================

ALTER TABLE listing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_connection_credentials ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies on listing_connection_credentials: service role only.
ALTER TABLE listing_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_sync_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_listing_settings" ON listing_settings;
CREATE POLICY "select_account_listing_settings" ON listing_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_account_listing_connections" ON listing_connections;
CREATE POLICY "select_account_listing_connections" ON listing_connections FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_account_listing_links" ON listing_links;
CREATE POLICY "select_account_listing_links" ON listing_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_account_listing_sync_events" ON listing_sync_events;
CREATE POLICY "select_account_listing_sync_events" ON listing_sync_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
