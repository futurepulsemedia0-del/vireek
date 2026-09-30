/*
  # Service Contract Intelligence

  Turns signed commercial contracts into machine-readable, auditable terms and
  evaluates every job against them (covered / not covered / billing action /
  response deadline).

  1. contract_intelligence_profiles
       One row per commercial_contracts row (unique contract_id). `terms` holds
       the structured terms (SLA, coverage, exclusions, labor/parts
       responsibility, warranty, renewal, price escalation, compliance);
       `evidence` holds the contract quote behind each extracted field so a
       human can verify it. `review_status` = 'draft' until a person verifies.
  2. job_contract_coverage
       Latest evaluation per job (unique job_id): verdict, billing action,
       response clock (started / deadline / met), reasons. Written by the app
       (RLS-scoped). The response time itself comes from the new
       jobs.first_response_at, stamped by a DB trigger the moment a job leaves
       'scheduled' — accurate even if nobody has the page open.
  3. consume_contract_intel_quota()
       Atomic hourly quota for the AI extraction edge function
       (service-role only), same pattern as consume_diagnosis_copilot_quota().

  Reuses: commercial_contracts, contract_sla_breaches, set_updated_at(),
  get_account_owner_id().

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Intelligence profile ----------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_intelligence_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL UNIQUE REFERENCES commercial_contracts(id) ON DELETE CASCADE,

  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_fields text[] NOT NULL DEFAULT '{}',

  source_kind text NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual', 'pasted_text', 'pdf')),
  source_text text CHECK (source_text IS NULL OR char_length(source_text) <= 200000),
  extraction_model text,
  extraction_confidence numeric(4,3) CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),

  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'verified')),
  verified_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cip_user ON contract_intelligence_profiles(user_id);

ALTER TABLE contract_intelligence_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_cip" ON contract_intelligence_profiles;
CREATE POLICY "select_own_cip" ON contract_intelligence_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_cip" ON contract_intelligence_profiles;
CREATE POLICY "insert_own_cip" ON contract_intelligence_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_cip" ON contract_intelligence_profiles;
CREATE POLICY "update_own_cip" ON contract_intelligence_profiles FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_cip" ON contract_intelligence_profiles;
CREATE POLICY "delete_own_cip" ON contract_intelligence_profiles FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_touch_cip ON contract_intelligence_profiles;
CREATE TRIGGER trigger_touch_cip
  BEFORE UPDATE ON contract_intelligence_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) Per-job coverage evaluation ---------------------------------------------
CREATE TABLE IF NOT EXISTS job_contract_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,

  verdict text NOT NULL
    CHECK (verdict IN ('covered', 'partially_covered', 'not_covered', 'needs_review')),
  billing_action text NOT NULL
    CHECK (billing_action IN ('do_not_bill', 'bill_parts_only', 'bill_labor_only', 'bill_customer', 'review')),
  priority text NOT NULL DEFAULT 'standard' CHECK (priority IN ('emergency', 'urgent', 'standard')),

  response_target_minutes integer,
  response_started_at timestamptz,
  response_deadline_at timestamptz,
  response_met_at timestamptz,

  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  flags text[] NOT NULL DEFAULT '{}',
  terms_verified boolean NOT NULL DEFAULT false,
  engine_version integer NOT NULL DEFAULT 1,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jcc_user_deadline
  ON job_contract_coverage(user_id, response_deadline_at) WHERE response_met_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jcc_contract ON job_contract_coverage(contract_id);

ALTER TABLE job_contract_coverage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_jcc" ON job_contract_coverage;
CREATE POLICY "select_own_jcc" ON job_contract_coverage FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_jcc" ON job_contract_coverage;
CREATE POLICY "insert_own_jcc" ON job_contract_coverage FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_jcc" ON job_contract_coverage;
CREATE POLICY "update_own_jcc" ON job_contract_coverage FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_jcc" ON job_contract_coverage;
CREATE POLICY "delete_own_jcc" ON job_contract_coverage FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id());

-- First-response timestamp on jobs: stamped by a trigger the first time a job
-- leaves 'scheduled', so the SLA is measured accurately even if nobody has the
-- Contract Intelligence page open. Existing jobs stay NULL (unknown).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS first_response_at timestamptz;

CREATE OR REPLACE FUNCTION public.stamp_job_first_response()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.job_status IN ('en_route', 'in_progress', 'completed')
     AND OLD.job_status IS DISTINCT FROM NEW.job_status
     AND NEW.first_response_at IS NULL THEN
    NEW.first_response_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_stamp_job_first_response ON jobs;
CREATE TRIGGER trigger_stamp_job_first_response
  BEFORE UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_job_first_response();

-- 3) Atomic AI-extraction quota (service role only) ---------------------------
CREATE TABLE IF NOT EXISTS contract_intel_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE contract_intel_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only the RPC below (service role) touches it.

CREATE OR REPLACE FUNCTION public.consume_contract_intel_quota(
  p_user_id uuid,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO contract_intel_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_contract_intel_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_contract_intel_quota(uuid, integer, integer) TO service_role;
