/*
# Call source attribution (Google Business Profile, Local Services Ads, etc.)

## Why
Many home-service leads call directly off a Google Maps/Business Profile
listing or a Local Services Ads badge, not the business's main number.
There is currently no way to tell those calls apart from any other —
`business_profile.vapi_phone_number_id` is a UNIQUE column, meaning the
current architecture only supports ONE Vapi phone number per business.
Attribution needs several tracking numbers (one per source) that can all
still route to the SAME AI assistant.

## What this does
- New table `call_tracking_numbers`: maps additional Vapi phone number
  IDs to a source label ("google_business_profile", "google_lsa",
  "website", "print", etc.), independent of and additive to the existing
  single `business_profile.vapi_phone_number_id` (which keeps working
  exactly as before for accounts that never set this up).
- Adds `source_channel` (text, nullable) to `calls`, populated by the
  webhook at call time by looking up the dialed number in this table —
  see the accompanying vapi-webhook edit (`resolveCallSource`). NULL for
  any call on a number that isn't registered here, so existing single-
  number accounts see no change.

## RLS
Same ownership pattern as every other per-tenant table in this project —
only the account owner (`get_account_owner_id()`) can see/manage their
own tracking numbers.
*/

CREATE TABLE IF NOT EXISTS call_tracking_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  vapi_phone_number_id text NOT NULL,
  source text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_tracking_numbers_phone_number_id
  ON call_tracking_numbers(vapi_phone_number_id);

CREATE INDEX IF NOT EXISTS idx_call_tracking_numbers_user_id
  ON call_tracking_numbers(user_id);

ALTER TABLE call_tracking_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_tracking_numbers" ON call_tracking_numbers;
CREATE POLICY "select_own_tracking_numbers"
ON call_tracking_numbers FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_tracking_numbers" ON call_tracking_numbers;
CREATE POLICY "insert_own_tracking_numbers"
ON call_tracking_numbers FOR INSERT
TO authenticated
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_tracking_numbers" ON call_tracking_numbers;
CREATE POLICY "update_own_tracking_numbers"
ON call_tracking_numbers FOR UPDATE
TO authenticated
USING (user_id = public.get_account_owner_id())
WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "delete_own_tracking_numbers" ON call_tracking_numbers;
CREATE POLICY "delete_own_tracking_numbers"
ON call_tracking_numbers FOR DELETE
TO authenticated
USING (user_id = public.get_account_owner_id());

ALTER TABLE calls
ADD COLUMN IF NOT EXISTS source_channel text;
