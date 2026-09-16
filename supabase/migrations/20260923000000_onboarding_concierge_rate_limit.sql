/*
  # Rate limiting for the AI-native Onboarding Concierge

  New customers finishing setup chat with the onboarding concierge
  (supabase/functions/onboarding-concierge) instead of filling out the
  classic step-by-step form. Every message triggers two paid LLM calls
  (extraction + reply), so this caps how many messages a single account
  can send per hour — its own table/limit, separate from
  `ai_assistant_rate_limit` (the dashboard "ask a question about my
  data" assistant), since the two features are used at completely
  different times and shouldn't throttle each other.

  ## New table
  - `onboarding_concierge_rate_limit`
    - `user_id` (uuid, PK) — the authenticated caller, straight from their JWT.
    - `window_start` (timestamptz) — start of the current 1-hour counting window.
    - `request_count` (integer) — messages sent within the current window.

  ## Security
  RLS is enabled with NO policies for the `authenticated` role — only the
  `onboarding-concierge` Edge Function's service-role client can read or
  write this table. This is the same "service-role only" shape that
  `site_assistant_rate_limit` uses, and that `ai_assistant_rate_limit`
  had to be RETROFITTED into later (see
  20260915010000_lock_down_ai_assistant_rate_limit.sql) after shipping
  with a bypassable authenticated policy — built correctly from the
  start here instead of needing a follow-up fix.
*/

CREATE TABLE IF NOT EXISTS onboarding_concierge_rate_limit (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE onboarding_concierge_rate_limit ENABLE ROW LEVEL SECURITY;

-- Intentionally no policies: this table is only ever touched by the Edge
-- Function's service-role client, which bypasses RLS entirely.
