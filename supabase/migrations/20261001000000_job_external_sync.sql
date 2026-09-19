/*
  # External job write-back tracking (Jobber / ServiceTitan / Housecall Pro)

  Tracks whether a job booked through Sarah was successfully pushed to a
  connected external CRM, so the dashboard can show sync status and a human
  can be alerted when a push fails — instead of the job silently never
  showing up in the contractor's CRM (the exact "CSR homework" gap being
  closed here).
*/

CREATE TABLE IF NOT EXISTS job_external_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('jobber', 'service_titan', 'housecall_pro')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'error', 'not_connected')),
  external_id text,
  external_type text,
  error_message text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_job_external_syncs_user_id ON job_external_syncs(user_id);
CREATE INDEX IF NOT EXISTS idx_job_external_syncs_status ON job_external_syncs(status);

ALTER TABLE job_external_syncs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_external_syncs" ON job_external_syncs;
CREATE POLICY "select_own_job_external_syncs"
ON job_external_syncs FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION set_job_external_syncs_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_external_syncs_updated_at ON job_external_syncs;
CREATE TRIGGER trg_job_external_syncs_updated_at
  BEFORE UPDATE ON job_external_syncs
  FOR EACH ROW EXECUTE FUNCTION set_job_external_syncs_updated_at();
