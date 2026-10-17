/*
  # Email Settings (/dashboard/settings/email)

  One row per ACCOUNT (user_id = the account owner's profile id, i.e.
  get_account_owner_id()), holding the tenant's outbound/inbound email
  configuration used by email-send and email-webhook:

    - reply_to_email / signature / sender_name / sender_local_part
    - sender domain verification state (SPF + DKIM) mirrored from the
      email provider (Resend Domains API) so the page can render instantly
    - inbound_enabled kill-switch for the tenant's inbound alias
      (profiles.inbound_email_token@INBOUND_EMAIL_DOMAIN)

  Same RLS posture as the Unified Inbox tables: the account (owner AND team
  members) can SELECT; every write goes through the service-role
  email-settings edge function, which enforces the permission gate and talks
  to the provider, so the client can never mark a domain "verified" itself.
*/

CREATE TABLE IF NOT EXISTS email_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  reply_to_email text CHECK (reply_to_email IS NULL OR length(reply_to_email) <= 254),
  signature text CHECK (signature IS NULL OR length(signature) <= 1000),
  sender_name text CHECK (sender_name IS NULL OR length(sender_name) <= 80),
  sender_local_part text NOT NULL DEFAULT 'hello' CHECK (length(sender_local_part) BETWEEN 1 AND 64),
  sender_domain text CHECK (sender_domain IS NULL OR length(sender_domain) <= 253),
  resend_domain_id text,
  domain_status text NOT NULL DEFAULT 'not_started' CHECK (domain_status IN ('not_started', 'pending', 'verified', 'failed')),
  spf_status text NOT NULL DEFAULT 'not_started' CHECK (spf_status IN ('not_started', 'pending', 'verified', 'failed')),
  dkim_status text NOT NULL DEFAULT 'not_started' CHECK (dkim_status IN ('not_started', 'pending', 'verified', 'failed')),
  dns_records jsonb NOT NULL DEFAULT '[]'::jsonb,
  domain_checked_at timestamptz,
  inbound_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A sending domain can belong to exactly one account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_settings_sender_domain
  ON email_settings (lower(sender_domain)) WHERE sender_domain IS NOT NULL;

ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_email_settings" ON email_settings;
CREATE POLICY "select_account_email_settings" ON email_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
