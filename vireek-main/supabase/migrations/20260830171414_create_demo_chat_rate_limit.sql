/*
  # Rate limiting for the public "Talk to Sarah" demo chat

  The /pricing and homepage live-demo chat widget is callable by anyone visiting
  the marketing site (no login required). Because each message triggers a paid
  LLM call, this table caps how many messages a single visitor can send per hour.

  ## New table
  - `demo_chat_rate_limit`
    - `ip_hash` (text) — SHA-256 hash of the visitor's IP address. We store a hash,
      never the raw IP, so no personal data is retained.
    - `window_start` (timestamptz) — start of the current 1-hour counting window.
    - `request_count` (integer) — messages sent within the current window.

  ## Security
  RLS is enabled with NO public policies. Only the `demo-chat` Edge Function
  (which uses the service-role key) can read or write this table — anonymous
  visitors and authenticated dashboard users cannot query it directly.
*/

CREATE TABLE IF NOT EXISTS demo_chat_rate_limit (
  ip_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE demo_chat_rate_limit ENABLE ROW LEVEL SECURITY;

-- Intentionally no policies: this table is only ever touched by the Edge
-- Function's service-role client, which bypasses RLS entirely.
