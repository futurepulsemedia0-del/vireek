-- Add live-escalation (barge-in / warm transfer) settings to profiles
-- These store the business's configuration for escalating an in-progress
-- AI call to a live team member mid-call.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS escalation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS escalation_phone text,
  ADD COLUMN IF NOT EXISTS escalation_mode text NOT NULL DEFAULT 'warm_transfer'
    CHECK (escalation_mode IN ('warm_transfer', 'barge_in'));

-- Allow users to update their own escalation fields (already covered by the
-- existing update_own_profile policy, which uses auth.uid() = id, so no new
-- policy needed)
