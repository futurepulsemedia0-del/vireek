/*
# Lead source attribution (call tracking numbers)

## Why
There was no way to know which channel (Google Business Profile, a specific
ad campaign, a referral partner, the website) a call actually came from.
Phone calls don't carry that information on their own — the standard,
honest way to get it is call tracking numbers: the business publishes a
different phone number per channel, each forwarding to Vireek, and Vireek
tells them apart by which number was dialed. That requires actually setting
up additional phone numbers in Vapi and pointing each one at the right
channel — a real operational step, not just a toggle. See the note left in
supabase/functions/vapi-webhook/index.ts and the "Call Sources" section on
BusinessProfilePage for the manual part of this.

## What this does
- `call_sources` — one row per tracking number a business has set up:
  `vapi_phone_number_id` (Vapi's ID for that number, copied from the Vapi
  dashboard) and a human `label` ("Google Business Profile", "Facebook Ad —
  March", "Referral partner: Jim's Plumbing"). A business with only one
  number simply has zero rows here — nothing breaks, calls just show as
  unattributed.
- `calls.source_label` — a plain text snapshot of the matched label at the
  time of the call (not a foreign key to call_sources on purpose: if a label
  is renamed or a tracking number retired later, past calls should keep
  showing what they were attributed to at the time, not silently change).

RLS on call_sources mirrors every other per-user table in this project.
*/

CREATE TABLE IF NOT EXISTS call_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  vapi_phone_number_id text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, vapi_phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_call_sources_user_id ON call_sources(user_id);

ALTER TABLE call_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_call_sources" ON call_sources;
CREATE POLICY "select_own_call_sources" ON call_sources FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_call_sources" ON call_sources;
CREATE POLICY "insert_own_call_sources" ON call_sources FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_call_sources" ON call_sources;
CREATE POLICY "update_own_call_sources" ON call_sources FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_call_sources" ON call_sources;
CREATE POLICY "delete_own_call_sources" ON call_sources FOR DELETE TO authenticated USING (user_id = auth.uid());

ALTER TABLE calls
ADD COLUMN IF NOT EXISTS source_label text;
