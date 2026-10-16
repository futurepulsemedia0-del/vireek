/*
  # Email Campaigns — bulk email with Resend delivery, tracking and unsubscribe

  Adds: email_templates, email_campaigns, email_campaign_recipients,
  email_campaign_links, email_suppressions + service-role-only functions that
  record opens/clicks/unsubscribes atomically.

  ## Design notes
  - RLS follows this project's standard: `public.get_account_owner_id()`.
  - The browser can only create/edit DRAFT campaigns (RLS enforces status = 'draft').
    Every state change (schedule, send, pause, cancel) goes through the
    `email-campaigns` edge function, which re-validates and records consent.
  - Recipients/links/suppressions are written only by edge functions (service role).
  - Audience = `marketing_segments` (the Audiences page) or "all opted-in customers".
    Only customers with `customers.marketing_opt_in = true` are ever emailed;
    leads have no consent record and are excluded.
  - Unsubscribe and bounce/complaint events land in `email_suppressions`, which is
    checked again at send time. Suppressions cannot be deleted from the browser.

  ## Requires (already in your project)
  public.get_account_owner_id(), profiles, customers (+ marketing_opt_in), leads,
  marketing_segments.

  ## After applying (see also the edge function headers)
  1. supabase functions deploy email-campaigns
     supabase functions deploy email-campaign-dispatcher --no-verify-jwt
     supabase functions deploy email-track --no-verify-jwt
     supabase functions deploy email-unsubscribe --no-verify-jwt
     supabase functions deploy resend-events --no-verify-jwt
  2. supabase secrets set RESEND_API_KEY=... RESEND_FROM_EMAIL="Vireek <mail@yourdomain.com>" \
       RESEND_WEBHOOK_SECRET=whsec_... SITE_URL=https://app.vireek.com
  3. In Resend: add a webhook -> https://<project-ref>.supabase.co/functions/v1/resend-events
     (events: email.delivered, email.bounced, email.complained).
  4. Schedule the dispatcher (every 5 minutes), same pattern as your other cron jobs:
       select cron.schedule('email-campaign-dispatcher', '0-59/5 * * * *', $$
         select net.http_post(
           url := 'https://<project-ref>.supabase.co/functions/v1/email-campaign-dispatcher',
           headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'Content-Type', 'application/json'),
           body := '{}'::jsonb
         );
       $$);
*/

-- =============================================================
-- TEMPLATES
-- =============================================================

CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  subject text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 200),
  preheader text CHECK (preheader IS NULL OR char_length(preheader) <= 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_user ON email_templates(user_id, created_at DESC);
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_email_templates" ON email_templates;
CREATE POLICY "select_own_email_templates" ON email_templates
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_email_templates" ON email_templates;
CREATE POLICY "insert_own_email_templates" ON email_templates
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_email_templates" ON email_templates;
CREATE POLICY "update_own_email_templates" ON email_templates
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_email_templates" ON email_templates;
CREATE POLICY "delete_own_email_templates" ON email_templates
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- CAMPAIGNS
-- =============================================================

CREATE TABLE IF NOT EXISTS email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  subject text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 200),
  preheader text CHECK (preheader IS NULL OR char_length(preheader) <= 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  from_name text CHECK (from_name IS NULL OR char_length(from_name) <= 80),
  reply_to text CHECK (reply_to IS NULL OR char_length(reply_to) <= 254),
  -- Physical postal address printed in every footer (CAN-SPAM / CASL).
  sender_address text CHECK (sender_address IS NULL OR char_length(sender_address) <= 300),
  audience text NOT NULL DEFAULT 'all_opted_in' CHECK (audience IN ('all_opted_in', 'segment')),
  segment_id uuid REFERENCES marketing_segments(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled', 'failed')),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  compliance_ack_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  bounce_count integer NOT NULL DEFAULT 0,
  unique_opens integer NOT NULL DEFAULT 0,
  unique_clicks integer NOT NULL DEFAULT 0,
  unsubscribe_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_user ON email_campaigns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_due ON email_campaigns(status, scheduled_at)
  WHERE status IN ('scheduled', 'sending');
ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_email_campaigns" ON email_campaigns;
CREATE POLICY "select_own_email_campaigns" ON email_campaigns
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- The browser may only create and edit DRAFTS. Scheduling/sending is done by the edge function.
DROP POLICY IF EXISTS "insert_own_email_campaigns" ON email_campaigns;
CREATE POLICY "insert_own_email_campaigns" ON email_campaigns
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND status = 'draft');
DROP POLICY IF EXISTS "update_own_email_campaigns" ON email_campaigns;
CREATE POLICY "update_own_email_campaigns" ON email_campaigns
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND status = 'draft')
  WITH CHECK (user_id = public.get_account_owner_id() AND status = 'draft');
DROP POLICY IF EXISTS "delete_own_email_campaigns" ON email_campaigns;
CREATE POLICY "delete_own_email_campaigns" ON email_campaigns
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND status <> 'sending');

-- =============================================================
-- RECIPIENTS (one row per address per campaign)
-- =============================================================

CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  email text NOT NULL,
  email_key text GENERATED ALWAYS AS (lower(email)) STORED,
  name text,
  -- Unguessable per-recipient token used in tracking + unsubscribe URLs.
  token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  error text,
  provider_ref text,
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  first_opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0,
  first_clicked_at timestamptz,
  click_count integer NOT NULL DEFAULT 0,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, email_key)
);

CREATE INDEX IF NOT EXISTS idx_email_recipients_queue ON email_campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_email_recipients_provider_ref ON email_campaign_recipients(provider_ref)
  WHERE provider_ref IS NOT NULL;
ALTER TABLE email_campaign_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_email_recipients" ON email_campaign_recipients;
CREATE POLICY "select_own_email_recipients" ON email_campaign_recipients
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- TRACKED LINKS (click redirects resolve through this table, never a URL param,
-- so the tracker can't be abused as an open redirect)
-- =============================================================

CREATE TABLE IF NOT EXISTS email_campaign_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (url ~* '^https?://'),
  click_count integer NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, url)
);

ALTER TABLE email_campaign_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_email_links" ON email_campaign_links;
CREATE POLICY "select_own_email_links" ON email_campaign_links
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- SUPPRESSIONS (unsubscribe / bounce / complaint) — never deletable from the browser
-- =============================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  reason text NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint')),
  source_campaign_id uuid REFERENCES email_campaigns(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_email_suppressions" ON email_suppressions;
CREATE POLICY "select_own_email_suppressions" ON email_suppressions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- SERVICE-ROLE FUNCTIONS (atomic tracking; no direct table writes from the edge)
-- =============================================================

-- Records an open. Idempotent per call (open_count grows, unique_opens once).
CREATE OR REPLACE FUNCTION public.email_record_open(p_token uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_campaign uuid;
  v_first boolean;
BEGIN
  SELECT campaign_id, first_opened_at IS NULL INTO v_campaign, v_first
    FROM email_campaign_recipients WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE email_campaign_recipients
     SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, now())
   WHERE token = p_token;
  IF v_first THEN
    UPDATE email_campaigns SET unique_opens = unique_opens + 1 WHERE id = v_campaign;
  END IF;
END $$;

-- Records a click and returns the destination URL (NULL when the link does not
-- belong to this recipient's campaign). A click also counts as an open.
CREATE OR REPLACE FUNCTION public.email_record_click(p_token uuid, p_link uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_campaign uuid;
  v_first_click boolean;
  v_first_open boolean;
  v_url text;
BEGIN
  SELECT campaign_id, first_clicked_at IS NULL, first_opened_at IS NULL
    INTO v_campaign, v_first_click, v_first_open
    FROM email_campaign_recipients WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT url INTO v_url FROM email_campaign_links WHERE id = p_link AND campaign_id = v_campaign;
  IF v_url IS NULL THEN RETURN NULL; END IF;

  UPDATE email_campaign_recipients
     SET click_count = click_count + 1,
         first_clicked_at = COALESCE(first_clicked_at, now()),
         first_opened_at = COALESCE(first_opened_at, now()),
         open_count = CASE WHEN v_first_open THEN open_count + 1 ELSE open_count END
   WHERE token = p_token;
  UPDATE email_campaign_links SET click_count = click_count + 1 WHERE id = p_link;
  UPDATE email_campaigns
     SET unique_clicks = unique_clicks + CASE WHEN v_first_click THEN 1 ELSE 0 END,
         unique_opens = unique_opens + CASE WHEN v_first_open THEN 1 ELSE 0 END
   WHERE id = v_campaign;
  RETURN v_url;
END $$;

-- Unsubscribes a recipient: suppression row, customer consent withdrawn, counters.
-- Idempotent. Returns the email address (NULL for an unknown token).
CREATE OR REPLACE FUNCTION public.email_unsubscribe(p_token uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r email_campaign_recipients%ROWTYPE;
BEGIN
  SELECT * INTO r FROM email_campaign_recipients WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO email_suppressions (user_id, email, reason, source_campaign_id)
  VALUES (r.user_id, lower(r.email), 'unsubscribe', r.campaign_id)
  ON CONFLICT (user_id, email) DO NOTHING;

  IF r.unsubscribed_at IS NULL THEN
    UPDATE email_campaign_recipients SET unsubscribed_at = now() WHERE id = r.id;
    UPDATE email_campaigns SET unsubscribe_count = unsubscribe_count + 1 WHERE id = r.campaign_id;
  END IF;

  IF r.customer_id IS NOT NULL THEN
    UPDATE customers SET marketing_opt_in = false WHERE id = r.customer_id AND user_id = r.user_id;
  END IF;
  RETURN r.email;
END $$;

-- Adds a bounce/complaint suppression (provider webhook).
CREATE OR REPLACE FUNCTION public.email_suppress(p_user uuid, p_email text, p_reason text, p_campaign uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO email_suppressions (user_id, email, reason, source_campaign_id)
  VALUES (p_user, lower(p_email), p_reason, p_campaign)
  ON CONFLICT (user_id, email) DO NOTHING;
$$;

-- Recomputes every counter on a campaign from its recipients (self-healing).
CREATE OR REPLACE FUNCTION public.email_refresh_campaign_counts(p_campaign uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE email_campaigns c SET
    recipient_count   = s.total,
    sent_count        = s.sent,
    failed_count      = s.failed,
    delivered_count   = s.delivered,
    bounce_count      = s.bounced,
    unique_opens      = s.opened,
    unique_clicks     = s.clicked,
    unsubscribe_count = s.unsubscribed,
    updated_at        = now()
  FROM (
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'sent')::int AS sent,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
           count(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced,
           count(*) FILTER (WHERE first_opened_at IS NOT NULL)::int AS opened,
           count(*) FILTER (WHERE first_clicked_at IS NOT NULL)::int AS clicked,
           count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed
      FROM email_campaign_recipients WHERE campaign_id = p_campaign
  ) s
  WHERE c.id = p_campaign;
$$;

REVOKE ALL ON FUNCTION public.email_record_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_record_click(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_unsubscribe(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_suppress(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.email_refresh_campaign_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_record_open(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_record_click(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_unsubscribe(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_suppress(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.email_refresh_campaign_counts(uuid) TO service_role;
