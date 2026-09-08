-- Add Stripe subscription columns to profiles
-- These store the Stripe customer and subscription IDs for billing integration

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

-- Allow users to update their own stripe fields (already covered by existing update_own_profile policy
-- which uses auth.uid() = id, so no new policy needed)
