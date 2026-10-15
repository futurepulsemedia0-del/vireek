/*
  # Daily Briefing

  - briefing_preferences: per-recipient delivery settings (owner row has team_member_id NULL).
  - daily_briefings:      the composed briefing per recipient per local date (powers the dashboard
                          card and makes delivery idempotent). Written by the service role only.
  - push_subscriptions.subscriber_id: which person registered a device, so a push can target ONE
    recipient instead of every device on the account. Defaults to auth.uid(), so existing client
    code needs no change; legacy rows (NULL) are treated as the owner's devices.
  - Hourly pg_cron tick -> `daily-briefing` edge function, which sends each recipient at THEIR
    local send hour (default 07:00).

  Required one-time setup (never commit real secrets):
    ALTER DATABASE postgres SET app.settings.briefing_cron_secret = '<openssl rand -hex 32>';
  (app.settings.edge_function_base_url is already set for push notifications.)
  Then: supabase secrets set BRIEFING_CRON_SECRET=<same value>
*/

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS subscriber_id uuid DEFAULT auth.uid();
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_subscriber ON push_subscriptions(subscriber_id);

-- ---------------------------------------------------------------- preferences
CREATE TABLE IF NOT EXISTS briefing_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  send_hour smallint NOT NULL DEFAULT 7 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'America/New_York',
  channel_push boolean NOT NULL DEFAULT true,
  channel_email boolean NOT NULL DEFAULT true,
  channel_in_app boolean NOT NULL DEFAULT true,
  sections text[],
  last_sent_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT briefing_sections_valid CHECK (
    sections IS NULL OR sections <@ ARRAY['yesterday','schedule','emergencies','unpaid','expiring','actions']
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_briefing_prefs_recipient
  ON briefing_preferences (account_owner_id, COALESCE(team_member_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_briefing_prefs_enabled ON briefing_preferences (enabled) WHERE enabled;

ALTER TABLE briefing_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "briefing_prefs_select" ON briefing_preferences;
CREATE POLICY "briefing_prefs_select" ON briefing_preferences FOR SELECT TO authenticated
USING (account_owner_id = auth.uid() OR team_member_id = public.get_my_team_member_id());

-- Owner manages every row of their account; a member manages only their own row.
-- The EXISTS keeps a row's (owner, member) pair consistent and un-forgeable.
DROP POLICY IF EXISTS "briefing_prefs_insert" ON briefing_preferences;
CREATE POLICY "briefing_prefs_insert" ON briefing_preferences FOR INSERT TO authenticated
WITH CHECK (
  (team_member_id IS NULL AND account_owner_id = auth.uid())
  OR (team_member_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = team_member_id AND tm.account_owner_id = briefing_preferences.account_owner_id)
      AND (account_owner_id = auth.uid() OR team_member_id = public.get_my_team_member_id()))
);

DROP POLICY IF EXISTS "briefing_prefs_update" ON briefing_preferences;
CREATE POLICY "briefing_prefs_update" ON briefing_preferences FOR UPDATE TO authenticated
USING (account_owner_id = auth.uid() OR team_member_id = public.get_my_team_member_id())
WITH CHECK (account_owner_id = auth.uid() OR team_member_id = public.get_my_team_member_id());

-- Users may only change delivery settings; `last_sent_on` belongs to the sender.
REVOKE UPDATE ON briefing_preferences FROM authenticated;
GRANT UPDATE (enabled, send_hour, timezone, channel_push, channel_email, channel_in_app, sections, updated_at)
  ON briefing_preferences TO authenticated;

-- ---------------------------------------------------------------- composed briefings
CREATE TABLE IF NOT EXISTS daily_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  briefing_date date NOT NULL,
  role text NOT NULL,
  payload jsonb NOT NULL,
  delivered jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_briefings_recipient_day
  ON daily_briefings (account_owner_id, COALESCE(team_member_id, '00000000-0000-0000-0000-000000000000'::uuid), briefing_date);

ALTER TABLE daily_briefings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_briefings_select_own" ON daily_briefings;
CREATE POLICY "daily_briefings_select_own" ON daily_briefings FOR SELECT TO authenticated
USING (
  (team_member_id IS NULL AND account_owner_id = auth.uid())
  OR team_member_id = public.get_my_team_member_id()
);
-- No INSERT/UPDATE/DELETE policies: only the edge function (service role) writes.

-- ---------------------------------------------------------------- helpers
-- Every account owner gets a default row (also covers accounts created after this migration).
CREATE OR REPLACE FUNCTION public.ensure_briefing_defaults()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  INSERT INTO briefing_preferences (account_owner_id)
  SELECT p.id FROM profiles p WHERE p.role = 'owner'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_briefing_defaults() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_briefing_defaults() TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_daily_briefing()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.briefing_cron_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'daily briefing not dispatched: app.settings.edge_function_base_url / briefing_cron_secret not set';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base_url || '/daily-briefing',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-briefing-secret', v_secret),
    body := '{}'::jsonb
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_daily_briefing() FROM PUBLIC, anon, authenticated;

-- Hourly tick (minute 5); the function decides who is due in their own timezone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule('vireek-daily-briefing', '5 * * * *', 'select public.dispatch_daily_briefing()');
  ELSE
    RAISE NOTICE 'pg_cron/pg_net not enabled: call the daily-briefing function hourly from an external scheduler instead.';
  END IF;
END $$;
