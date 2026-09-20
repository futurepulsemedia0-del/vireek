/*
  # insurance-claim-status-update automation support

  Tracks the last status a customer was texted about, so the sweep can
  detect "status changed since we last texted" without needing a DB trigger
  — same idempotency pattern as jobs.no_show_text_sent_at.
*/

ALTER TABLE insurance_claims
  ADD COLUMN IF NOT EXISTS last_texted_status text,
  ADD COLUMN IF NOT EXISTS status_texted_at timestamptz;
