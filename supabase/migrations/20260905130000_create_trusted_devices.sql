/*
  # Trusted devices for step-up OTP

  Adds a table used by the `trusted-device` edge function to remember
  devices that have already completed a full verification (password +
  OTP) so that later logins from that same device can skip the OTP
  step-up. Logins from an unrecognized device still require OTP.

  Security model:
  - The raw device token is generated on the server (inside the edge
    function) and set as an httpOnly, Secure, SameSite=Lax cookie. It is
    never exposed to client-side JavaScript and never stored in
    localStorage.
  - Only a SHA-256 hash of that token is stored here. A stolen row from
    this table cannot be replayed as a cookie.
  - This table is intentionally NOT reachable via the anon/authenticated
    Postgres roles. All reads/writes happen through the `trusted-device`
    edge function using the service role key, which enforces that a user
    can only ever see or revoke their own devices (scoped by the caller's
    verified auth.uid()). RLS is enabled with no permissive policies as
    defense in depth in case the anon/authenticated roles are ever queried
    directly.
*/

CREATE TABLE IF NOT EXISTS trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_token_hash text NOT NULL,
  device_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- One row per (user, device token hash). Prevents duplicate rows if the
-- register step is ever retried for the same cookie.
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_user_token_hash_idx
  ON trusted_devices (user_id, device_token_hash);

-- Fast lookup path used by the edge function on every login check.
CREATE INDEX IF NOT EXISTS trusted_devices_lookup_idx
  ON trusted_devices (user_id, device_token_hash)
  WHERE revoked_at IS NULL;

ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;

-- No policies are created for `anon` or `authenticated`. With RLS enabled
-- and zero permissive policies, those roles get zero rows and zero writes.
-- Only the service role (used exclusively inside the trusted-device edge
-- function) can read or write this table, which is what keeps the raw
-- token -> hash comparison and the "only your own devices" scoping
-- enforceable in one trusted place instead of relying on client-supplied
-- user_id values.
