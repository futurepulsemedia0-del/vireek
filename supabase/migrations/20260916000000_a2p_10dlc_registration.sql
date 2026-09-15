/*
  # A2P 10DLC brand + campaign registration tracking

  ## چرا
  Since Feb 2025, AT&T/T-Mobile/Verizon block ~100% of unregistered A2P
  10DLC SMS traffic at the carrier level — not a soft filter, a hard
  block. This is a real onboarding process per tenant (legal business
  info -> TCR Brand -> Campaign), not a toggle. These columns track
  where each tenant is in that process and gate every SMS send
  (see _shared/compliance/a2pGate.ts).
*/

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS legal_business_name text,
  ADD COLUMN IF NOT EXISTS ein text,
  ADD COLUMN IF NOT EXISTS business_registration_type text
    CHECK (business_registration_type IN ('sole_proprietorship', 'llc', 'corporation', 'partnership', 'nonprofit')),
  ADD COLUMN IF NOT EXISTS business_website text,
  ADD COLUMN IF NOT EXISTS sms_sample_message text,
  ADD COLUMN IF NOT EXISTS sms_opt_in_description text,
  ADD COLUMN IF NOT EXISTS a2p_brand_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS a2p_campaign_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS a2p_brand_sid text,
  ADD COLUMN IF NOT EXISTS a2p_campaign_sid text,
  ADD COLUMN IF NOT EXISTS a2p_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS a2p_rejection_reason text;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS a2p_brand_status_check;
ALTER TABLE profiles ADD CONSTRAINT a2p_brand_status_check
  CHECK (a2p_brand_status IN ('not_started', 'pending', 'approved', 'rejected'));

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS a2p_campaign_status_check;
ALTER TABLE profiles ADD CONSTRAINT a2p_campaign_status_check
  CHECK (a2p_campaign_status IN ('not_started', 'pending', 'approved', 'rejected'));
