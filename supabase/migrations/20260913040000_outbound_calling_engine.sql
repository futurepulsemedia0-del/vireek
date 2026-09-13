/*
  # Outbound Calling Engine — schema support

  outbound_campaigns / outbound_calls already existed (dashboard toggle +
  log view), but nothing ever populated the queue or placed a call — this
  is the real gap. Two things were missing to make that possible:

  1. Timestamps to trigger off of. `leads.stage` and `jobs.job_status`
     could change with no record of *when* — so "call this lead 24h after
     they were quoted" or "text this job 4h after it was completed" had
     nothing to compare against. Adding stage_updated_at / completed_at,
     kept current by triggers, same pattern as updated_at elsewhere.
  2. Dedupe indexes so outbound-queue-builder (see the two new edge
     functions) can run every few minutes without re-queuing the same
     lead/job every time it runs — ON CONFLICT DO NOTHING relies on these.
*/

ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION set_lead_stage_updated_at()
RETURNS trigger AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_lead_stage_updated_at ON leads;
CREATE TRIGGER trg_set_lead_stage_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_lead_stage_updated_at();

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE OR REPLACE FUNCTION set_job_completed_at()
RETURNS trigger AS $$
BEGIN
  IF NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed' THEN
    NEW.completed_at = now();
  ELSIF NEW.job_status <> 'completed' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_job_completed_at ON jobs;
CREATE TRIGGER trg_set_job_completed_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_job_completed_at();

ALTER TABLE outbound_calls
  ADD COLUMN IF NOT EXISTS vapi_call_id text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_calls_vapi_call_id
  ON outbound_calls(vapi_call_id) WHERE vapi_call_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_calls_dedupe_lead
  ON outbound_calls(user_id, campaign_type, lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_calls_dedupe_job
  ON outbound_calls(user_id, campaign_type, job_id) WHERE job_id IS NOT NULL;
