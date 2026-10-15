/*
  # MFA recovery codes (used by the /mfa challenge page)

  Supabase Auth's MFA has TOTP but no recovery codes. These tables back the
  `mfa-recovery` edge function, which is the ONLY thing that touches them.

  - mfa_recovery_codes: one row per code. Only an HMAC of the code is stored,
    never the code itself, so a database leak cannot reveal usable codes.
  - mfa_recovery_attempts: failed/successful redeem attempts, used by the edge
    function to rate-limit guessing (5 failures / 15 min / user).

  RLS is enabled with NO policies and all client grants revoked: browsers can
  never read or write these tables; the service role (edge function) bypasses RLS.
*/

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS mfa_recovery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_attempts_user_time ON mfa_recovery_attempts (user_id, created_at DESC);

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mfa_recovery_codes FROM anon, authenticated;
REVOKE ALL ON mfa_recovery_attempts FROM anon, authenticated;

COMMENT ON TABLE mfa_recovery_codes IS 'HMAC-hashed one-time MFA recovery codes. Service role (mfa-recovery edge function) only.';
COMMENT ON TABLE mfa_recovery_attempts IS 'Recovery-code redeem attempts for rate limiting. Service role only.';
