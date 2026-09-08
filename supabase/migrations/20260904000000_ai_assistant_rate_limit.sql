/*
  # Rate limiting for the authenticated AI Assistant (ai-assistant-query)

  The public demo chat (`demo_chat_rate_limit`) already caps unauthenticated
  visitors. The in-dashboard AI Assistant had no equivalent cap — a logged-in
  user (or a compromised session) could otherwise trigger unlimited paid LLM
  calls. This closes that gap with the same "fixed window" pattern, keyed by
  `user_id` instead of a hashed IP, since every caller here is authenticated.

  ## New table
  - `ai_assistant_rate_limit`
    - `user_id` (uuid, references auth.users) — the caller.
    - `window_start` (timestamptz) — start of the current 1-hour window.
    - `request_count` (integer) — questions asked within the current window.

  ## Security
  RLS is enabled. Unlike `demo_chat_rate_limit` (service-role only, since
  visitors aren't authenticated), this table is read/written by the caller's
  own JWT-scoped client, so policies restrict every row to its owner —
  a user can only ever see or touch their own rate-limit counter.
*/

CREATE TABLE IF NOT EXISTS ai_assistant_rate_limit (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE ai_assistant_rate_limit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own rate limit row"
  ON ai_assistant_rate_limit FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own rate limit row"
  ON ai_assistant_rate_limit FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own rate limit row"
  ON ai_assistant_rate_limit FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
