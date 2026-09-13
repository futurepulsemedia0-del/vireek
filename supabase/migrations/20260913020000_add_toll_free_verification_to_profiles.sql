-- Toll-Free Verification (TFV) tracking. TFV is a separate carrier
-- process from 10DLC — it applies specifically to NANP toll-free
-- numbers (800, 833, 844, 855, 866, 877, 888) used to send SMS. An
-- unverified toll-free number gets its messages filtered or blocked by
-- carriers, which directly breaks the "automated SMS confirmation"
-- feature already promised on the marketing site for any customer whose
-- forwarding number happens to be toll-free.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS toll_free_verification_status text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS toll_free_verification_requested_at timestamptz;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS toll_free_verification_status_check;

ALTER TABLE profiles
  ADD CONSTRAINT toll_free_verification_status_check
  CHECK (toll_free_verification_status IN ('not_applicable', 'not_started', 'pending', 'verified', 'rejected'));
