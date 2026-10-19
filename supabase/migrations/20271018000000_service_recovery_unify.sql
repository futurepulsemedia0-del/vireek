/*
  # Service Recovery — one table, one schema

  ## Why
  Two different designs of `service_recovery_signals` exist in this codebase:

    A. 20261126000000_service_recovery_agent.sql — severity_score (0-100), detail, resolution_note,
       statuses open/playbook_enrolled/escalated/resolved/ignored. Used by the service-recovery-agent,
       self-healing-orchestrator, Trust Passport and Identity Graph SQL.
    B. The dashboard page (ServiceRecoveryPage), the Intelligence card and the
       detect-service-recovery-signals function — severity (low..critical), signal_excerpt,
       recommended_channel / recommended_message, outcome, executed_at, executed_channel, notes,
       customer_id/email, promise_id, review_request_id, statuses action_queued / action_sent.
       No migration ever created these columns, so the page could not read or write them.

  This migration makes the table serve BOTH, without breaking either:
    * adds every missing column (IF NOT EXISTS - safe to run on any state of the table);
    * widens the CHECK constraints to the union of both designs;
    * keeps severity <-> severity_score and signal_excerpt <-> detail in sync with a trigger, so
      rows written by either side are fully readable by the other;
    * gives staff exactly the client write access the page needs (log a manual signal, resolve /
      ignore / delete a closed one) while automated signals still cannot be fabricated by a client.

  Safe to re-run.
*/

-- =============================================================
-- 1. Table (only created if neither design was ever applied)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.service_recovery_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signal_type text NOT NULL,
  source_table text NOT NULL,
  source_id uuid,
  customer_name text NOT NULL DEFAULT 'Unknown customer',
  customer_phone text,
  severity_score smallint NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'open',
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id, signal_type)
);

-- =============================================================
-- 2. Columns from both designs
-- =============================================================

ALTER TABLE public.service_recovery_signals
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promise_id uuid,
  ADD COLUMN IF NOT EXISTS review_request_id uuid,
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS severity text,
  ADD COLUMN IF NOT EXISTS severity_score smallint NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS signal_excerpt text,
  ADD COLUMN IF NOT EXISTS detail text,
  ADD COLUMN IF NOT EXISTS recommended_channel text NOT NULL DEFAULT 'call',
  ADD COLUMN IF NOT EXISTS recommended_message text,
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS executed_channel text,
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Manual signals ("log a signal" on the page) have no source row.
ALTER TABLE public.service_recovery_signals ALTER COLUMN source_id DROP NOT NULL;

-- =============================================================
-- 3. Severity + excerpt helpers and the sync trigger
-- =============================================================

CREATE OR REPLACE FUNCTION public.service_recovery_severity_label(p_score integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_score >= 90 THEN 'critical'
    WHEN p_score >= 75 THEN 'high'
    WHEN p_score >= 50 THEN 'medium'
    ELSE 'low'
  END;
$$;

CREATE OR REPLACE FUNCTION public.service_recovery_severity_score(p_label text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_label
    WHEN 'critical' THEN 90
    WHEN 'high' THEN 75
    WHEN 'medium' THEN 50
    ELSE 25
  END::smallint;
$$;

CREATE OR REPLACE FUNCTION public.service_recovery_sync_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.severity IS NULL THEN
      NEW.severity := public.service_recovery_severity_label(NEW.severity_score);
    ELSIF NEW.severity_score = 50 THEN
      -- The writer supplied a label only (score is still the column default).
      NEW.severity_score := public.service_recovery_severity_score(NEW.severity);
    END IF;
    NEW.updated_at := COALESCE(NEW.updated_at, now());
  ELSE
    IF OLD.severity IS NOT NULL AND NEW.severity IS DISTINCT FROM OLD.severity THEN
      NEW.severity_score := public.service_recovery_severity_score(NEW.severity);
    ELSIF NEW.severity_score IS DISTINCT FROM OLD.severity_score THEN
      NEW.severity := public.service_recovery_severity_label(NEW.severity_score);
    END IF;
    NEW.updated_at := now();
  END IF;

  -- Both designs describe the same thing under two names.
  NEW.signal_excerpt := COALESCE(NEW.signal_excerpt, NEW.detail);
  NEW.detail := COALESCE(NEW.detail, NEW.signal_excerpt);

  IF NEW.status IN ('resolved', 'ignored') AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_recovery_sync_fields ON public.service_recovery_signals;
CREATE TRIGGER trg_service_recovery_sync_fields
  BEFORE INSERT OR UPDATE ON public.service_recovery_signals
  FOR EACH ROW EXECUTE FUNCTION public.service_recovery_sync_fields();

-- Backfill rows written before this migration (fires the trigger, which fills the gaps).
UPDATE public.service_recovery_signals
SET severity = public.service_recovery_severity_label(severity_score)
WHERE severity IS NULL;

UPDATE public.service_recovery_signals
SET signal_excerpt = detail
WHERE signal_excerpt IS NULL AND detail IS NOT NULL;

ALTER TABLE public.service_recovery_signals ALTER COLUMN severity SET NOT NULL;

-- =============================================================
-- 4. Constraints = union of both designs
-- =============================================================

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_signal_type_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_signal_type_check
  CHECK (signal_type IN (
    'eta_missed', 'technician_delayed', 'technician_delay', 'negative_sentiment', 'customer_dispute',
    'broken_promise', 'negative_review', 'payment_dispute', 'other'
  ));

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_source_table_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_source_table_check
  CHECK (source_table IN ('jobs', 'calls', 'promises', 'review_requests', 'manual'));

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_status_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_status_check
  CHECK (status IN ('open', 'playbook_enrolled', 'escalated', 'action_queued', 'action_sent', 'resolved', 'ignored'));

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_severity_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_severity_check
  CHECK (severity IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_severity_score_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_severity_score_check
  CHECK (severity_score BETWEEN 0 AND 100);

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_recommended_channel_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_recommended_channel_check
  CHECK (recommended_channel IN ('sms', 'email', 'call'));

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_executed_channel_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_executed_channel_check
  CHECK (executed_channel IS NULL OR executed_channel IN ('sms', 'email', 'call'));

ALTER TABLE public.service_recovery_signals DROP CONSTRAINT IF EXISTS service_recovery_signals_outcome_check;
ALTER TABLE public.service_recovery_signals ADD CONSTRAINT service_recovery_signals_outcome_check
  CHECK (outcome IN ('recovered', 'lost', 'pending'));

-- =============================================================
-- 5. Indexes
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_service_recovery_user_id ON public.service_recovery_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_service_recovery_status ON public.service_recovery_signals(status);
CREATE INDEX IF NOT EXISTS idx_service_recovery_detected_at ON public.service_recovery_signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_recovery_job_id ON public.service_recovery_signals(job_id);
CREATE INDEX IF NOT EXISTS idx_service_recovery_user_open
  ON public.service_recovery_signals(user_id, severity_score DESC, detected_at DESC)
  WHERE status IN ('open', 'playbook_enrolled', 'escalated', 'action_queued');

-- =============================================================
-- 6. Row level security
--    Automated signals are created only by the service-role agents (no client INSERT of those).
--    Staff may: read, update (resolve / ignore / escalate), log a MANUAL signal, and delete a closed one.
-- =============================================================

ALTER TABLE public.service_recovery_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_recovery_signals" ON public.service_recovery_signals;
CREATE POLICY "select_own_service_recovery_signals"
  ON public.service_recovery_signals FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_service_recovery_signals" ON public.service_recovery_signals;
CREATE POLICY "update_own_service_recovery_signals"
  ON public.service_recovery_signals FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_manual_service_recovery_signals" ON public.service_recovery_signals;
CREATE POLICY "insert_manual_service_recovery_signals"
  ON public.service_recovery_signals FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND source_table = 'manual');

DROP POLICY IF EXISTS "delete_closed_service_recovery_signals" ON public.service_recovery_signals;
CREATE POLICY "delete_closed_service_recovery_signals"
  ON public.service_recovery_signals FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (source_table = 'manual' OR status IN ('resolved', 'ignored', 'action_sent'))
  );
