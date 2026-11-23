/*
  # Transcript compliance review

  A scheduled job (edge function `transcript-compliance-review`) samples AI call transcripts and checks, with
  DETERMINISTIC rules: AI disclosure given, recording disclosure given/declined-honored, opt-out honored, emergency
  handled. Failures and doubtful cases become findings with REDACTED evidence snippets, queued for a human.

  ## Tables
  - transcript_review_runs                one row per job run (counts, errors) for observability
  - transcript_compliance_reviews         one row per reviewed call + rules version (idempotency key)
  - transcript_compliance_findings        one row per failing / doubtful check, with redacted evidence + admin queue state
  - transcript_compliance_daily_summaries one row per owner per day
  - transcript_review_judge_evals         evaluation of an OPTIONAL LLM judge against the golden set (service-only)

  ## Security model
  - The job writes with the service role. Browsers can only SELECT their own account's rows, and only if
    public.ai_disclosure_can_view() (account owner, or a team member with can_edit_business_profile).
  - Evidence/outcome columns are immutable: a trigger lets only the admin-queue columns change, and those changes go
    through public.transcript_compliance_resolve() which re-checks permission and scopes to the caller's account.
  - Evidence snippets are redacted BEFORE they are written (_shared/transcript-compliance/redact.ts). The full
    transcript is never copied here; the review stores only its SHA-256 for integrity.
  - Rows reference calls ON DELETE CASCADE, so erasing a call (DSAR) erases its reviews and findings too.

  ## Rollback
    DROP FUNCTION IF EXISTS public.transcript_compliance_resolve(uuid, text, text);
    DROP TABLE IF EXISTS public.transcript_review_judge_evals, public.transcript_compliance_daily_summaries,
      public.transcript_compliance_findings, public.transcript_compliance_reviews, public.transcript_review_runs;

  ## Requires
  profiles, calls, public.get_account_owner_id(), public.ai_disclosure_can_view()
*/

-- ============================================================
-- 1. Runs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transcript_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rules_version text NOT NULL,
  sample_rate numeric(4,3) NOT NULL CHECK (sample_rate BETWEEN 0 AND 1),
  candidates integer NOT NULL DEFAULT 0,
  sampled integer NOT NULL DEFAULT 0,
  reviewed integer NOT NULL DEFAULT 0,
  findings integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  error_sample text CHECK (error_sample IS NULL OR char_length(error_sample) <= 500)
);
ALTER TABLE public.transcript_review_runs ENABLE ROW LEVEL SECURITY; -- service role only: no policies

-- ============================================================
-- 2. Reviews (one per call + rules version)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transcript_compliance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.transcript_review_runs(id) ON DELETE SET NULL,
  rules_version text NOT NULL,
  overall text NOT NULL CHECK (overall IN ('pass', 'fail', 'needs_review')),
  sampled_reason text NOT NULL CHECK (sampled_reason IN ('random', 'risk_flag')),
  risk_flags text[] NOT NULL DEFAULT '{}',
  turn_count integer NOT NULL CHECK (turn_count >= 0),
  transcript_sha256 text NOT NULL CHECK (char_length(transcript_sha256) = 64),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, rules_version)
);
CREATE INDEX IF NOT EXISTS idx_tcr_reviews_owner_time ON public.transcript_compliance_reviews (account_owner_id, reviewed_at DESC);

-- ============================================================
-- 3. Findings (+ admin queue)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transcript_compliance_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES public.transcript_compliance_reviews(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  check_id text NOT NULL CHECK (check_id IN ('ai_disclosure', 'recording_disclosure', 'opt_out_honored', 'emergency_handled')),
  outcome text NOT NULL CHECK (outcome IN ('fail', 'needs_review')),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  -- 'rules' = deterministic; 'llm_judge' = model-assisted (never a hard fail, always labeled).
  source text NOT NULL DEFAULT 'rules' CHECK (source IN ('rules', 'llm_judge')),
  rule_id text NOT NULL CHECK (char_length(rule_id) BETWEEN 1 AND 40),
  rules_version text NOT NULL,
  model text,
  prompt_version text,
  detail text NOT NULL CHECK (char_length(detail) <= 400),
  -- [{ "role": "assistant|caller|other", "turn": 0, "snippet": "<redacted, <=240 chars>" }], max 3
  evidence jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 3),
  -- admin queue
  queue_status text NOT NULL DEFAULT 'open' CHECK (queue_status IN ('open', 'acknowledged', 'resolved', 'false_positive')),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'rules' OR (outcome = 'needs_review' AND model IS NOT NULL AND prompt_version IS NOT NULL)),
  UNIQUE (call_id, check_id, source, rules_version)
);
CREATE INDEX IF NOT EXISTS idx_tcr_findings_queue
  ON public.transcript_compliance_findings (account_owner_id, queue_status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tcr_findings_review ON public.transcript_compliance_findings (review_id);

-- Only the admin-queue columns may ever change (and only through transcript_compliance_resolve()).
CREATE OR REPLACE FUNCTION public.tcr_findings_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'queue_status' - 'resolution_note' - 'resolved_by' - 'resolved_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'queue_status' - 'resolution_note' - 'resolved_by' - 'resolved_at') THEN
    RAISE EXCEPTION 'finding evidence is immutable (only queue columns may change)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_tcr_findings_guard ON public.transcript_compliance_findings;
CREATE TRIGGER trg_tcr_findings_guard BEFORE UPDATE ON public.transcript_compliance_findings
  FOR EACH ROW EXECUTE FUNCTION public.tcr_findings_guard();

-- ============================================================
-- 4. Daily summaries
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transcript_compliance_daily_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  calls_reviewed integer NOT NULL DEFAULT 0 CHECK (calls_reviewed >= 0),
  passed integer NOT NULL DEFAULT 0 CHECK (passed >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  needs_review integer NOT NULL DEFAULT 0 CHECK (needs_review >= 0),
  -- { "ai_disclosure": { "pass": n, "fail": n, "needs_review": n, "not_applicable": n }, ... }
  by_check jsonb NOT NULL DEFAULT '{}',
  open_critical integer NOT NULL DEFAULT 0 CHECK (open_critical >= 0),
  rules_version text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, day)
);

-- ============================================================
-- 5. LLM-judge evaluations (platform-level, service role only)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transcript_review_judge_evals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  prompt_version text NOT NULL,
  golden_hash text NOT NULL,
  evaluations jsonb NOT NULL,
  allowed boolean NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.transcript_review_judge_evals ENABLE ROW LEVEL SECURITY; -- service role only: no policies

-- ============================================================
-- 6. RLS: read-only for permitted members of the owning account
-- ============================================================
ALTER TABLE public.transcript_compliance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_compliance_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_compliance_daily_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tcr_reviews_select" ON public.transcript_compliance_reviews;
CREATE POLICY "tcr_reviews_select" ON public.transcript_compliance_reviews FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());

DROP POLICY IF EXISTS "tcr_findings_select" ON public.transcript_compliance_findings;
CREATE POLICY "tcr_findings_select" ON public.transcript_compliance_findings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());

DROP POLICY IF EXISTS "tcr_summaries_select" ON public.transcript_compliance_daily_summaries;
CREATE POLICY "tcr_summaries_select" ON public.transcript_compliance_daily_summaries FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());
-- No INSERT / UPDATE / DELETE policy anywhere: browsers cannot write these tables.
-- Defence in depth on top of RLS: browsers hold SELECT only (the queue is changed through the RPC below).
REVOKE ALL ON public.transcript_review_runs, public.transcript_review_judge_evals FROM anon, authenticated;
REVOKE ALL ON public.transcript_compliance_reviews, public.transcript_compliance_findings, public.transcript_compliance_daily_summaries FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.transcript_compliance_reviews, public.transcript_compliance_findings, public.transcript_compliance_daily_summaries FROM authenticated;

-- ============================================================
-- 7. Admin queue action
-- ============================================================
CREATE OR REPLACE FUNCTION public.transcript_compliance_resolve(p_finding uuid, p_status text, p_note text DEFAULT NULL)
RETURNS public.transcript_compliance_findings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row public.transcript_compliance_findings;
  v_note text := NULLIF(btrim(coalesce(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.ai_disclosure_can_view() THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('open', 'acknowledged', 'resolved', 'false_positive') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'note too long' USING ERRCODE = '22023';
  END IF;

  UPDATE public.transcript_compliance_findings f
     SET queue_status = p_status,
         resolution_note = CASE WHEN p_status = 'open' THEN NULL ELSE v_note END,
         resolved_by = CASE WHEN p_status IN ('resolved', 'false_positive') THEN auth.uid() ELSE NULL END,
         resolved_at = CASE WHEN p_status IN ('resolved', 'false_positive') THEN now() ELSE NULL END
   WHERE f.id = p_finding
     AND f.account_owner_id = public.get_account_owner_id()   -- tenant isolation: another account's id matches nothing
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finding not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.transcript_compliance_resolve(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transcript_compliance_resolve(uuid, text, text) TO authenticated;
