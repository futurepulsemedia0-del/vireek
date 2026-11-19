/*
  Photo authenticity (C2PA reading + metadata consistency heuristics)

  Stores ONE derived analysis per sealed photo capture. It is deliberately NOT part of the job evidence hash
  chain: the chain commits to bytes, times and source, while this report is a re-runnable opinion computed by
  versioned code (analyzer_version). It never contains coordinates, serial numbers, names or image content.

  - Reads: owner scope + the job's own RLS (same model as evidence_photo_captures).
  - Writes: service role only, through evp_store_authenticity() called by the photo-provenance edge function
    after it re-downloaded the object and re-verified the sealed SHA-256.
  Idempotent: safe to run twice. Depends on 20281103000000_photo_provenance.sql.
*/

CREATE TABLE IF NOT EXISTS public.evidence_photo_authenticity (
  capture_id uuid PRIMARY KEY REFERENCES public.evidence_photo_captures(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,                                   -- account owner
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  analyzed_sha256 text NOT NULL CHECK (analyzed_sha256 ~ '^[0-9a-f]{64}$'),
  analyzer_version text NOT NULL CHECK (char_length(analyzer_version) BETWEEN 1 AND 32),
  c2pa_status text NOT NULL CHECK (c2pa_status IN ('not_present', 'read', 'unsupported_format', 'too_large', 'unavailable', 'error')),
  c2pa_validation text NOT NULL CHECK (c2pa_validation IN ('valid', 'invalid', 'unknown')),
  c2pa_trust text NOT NULL CHECK (c2pa_trust IN ('trusted', 'untrusted', 'not_evaluated')),
  consistency_confidence smallint CHECK (consistency_confidence IS NULL OR consistency_confidence BETWEEN 0 AND 100),
  consistency_level text NOT NULL CHECK (consistency_level IN ('strong', 'moderate', 'weak', 'insufficient')),
  -- "insufficient" is the only level without a number, and vice versa: absence of data is never scored as "low".
  CONSTRAINT evp_auth_level_matches_number CHECK ((consistency_level = 'insufficient') = (consistency_confidence IS NULL)),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND pg_column_size(report) < 16384),
  analyzed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.evidence_photo_authenticity IS
  'Derived, re-runnable photo analysis (C2PA read + metadata consistency). A confidence with reasons, never a verdict. Not sealed in the evidence chain.';

CREATE INDEX IF NOT EXISTS idx_evp_authenticity_job ON public.evidence_photo_authenticity (job_id);
CREATE INDEX IF NOT EXISTS idx_evp_authenticity_user ON public.evidence_photo_authenticity (user_id);

CREATE OR REPLACE FUNCTION public.evp_authenticity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capture_id IS DISTINCT FROM OLD.capture_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'Ownership of an authenticity report cannot change';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_evp_authenticity_guard ON public.evidence_photo_authenticity;
CREATE TRIGGER trg_evp_authenticity_guard BEFORE UPDATE ON public.evidence_photo_authenticity
  FOR EACH ROW EXECUTE FUNCTION public.evp_authenticity_guard();

ALTER TABLE public.evidence_photo_authenticity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evp_authenticity_select" ON public.evidence_photo_authenticity;
CREATE POLICY "evp_authenticity_select" ON public.evidence_photo_authenticity FOR SELECT TO authenticated
  USING (
    user_id = (select public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = evidence_photo_authenticity.job_id)
  );

REVOKE ALL ON public.evidence_photo_authenticity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.evidence_photo_authenticity TO authenticated;

-- ---------------------------------------------------------------- write (service role only)
CREATE OR REPLACE FUNCTION public.evp_store_authenticity(
  p_owner uuid, p_capture uuid, p_sha256 text, p_version text, p_report jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.evidence_photo_captures%ROWTYPE;
  v_conf smallint;
  v_at timestamptz;
BEGIN
  SELECT * INTO c FROM public.evidence_photo_captures WHERE id = p_capture AND user_id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF c.original_sha256 IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: analysed bytes do not match the sealed original';
  END IF;
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: report must be an object';
  END IF;

  v_conf := CASE WHEN jsonb_typeof(p_report #> '{consistency,confidence}') = 'number'
                 THEN (p_report #>> '{consistency,confidence}')::numeric::smallint END;

  BEGIN
    INSERT INTO public.evidence_photo_authenticity AS a (
      capture_id, user_id, job_id, analyzed_sha256, analyzer_version,
      c2pa_status, c2pa_validation, c2pa_trust, consistency_confidence, consistency_level, report
    ) VALUES (
      c.id, c.user_id, c.job_id, p_sha256, p_version,
      coalesce(p_report #>> '{c2pa,status}', ''), coalesce(p_report #>> '{c2pa,validation}', ''), coalesce(p_report #>> '{c2pa,trust}', ''),
      v_conf, coalesce(p_report #>> '{consistency,level}', ''), p_report
    )
    ON CONFLICT (capture_id) DO UPDATE SET
      analyzed_sha256 = EXCLUDED.analyzed_sha256, analyzer_version = EXCLUDED.analyzer_version,
      c2pa_status = EXCLUDED.c2pa_status, c2pa_validation = EXCLUDED.c2pa_validation, c2pa_trust = EXCLUDED.c2pa_trust,
      consistency_confidence = EXCLUDED.consistency_confidence, consistency_level = EXCLUDED.consistency_level,
      report = EXCLUDED.report, analyzed_at = now()
    RETURNING a.analyzed_at INTO v_at;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'PHOTO_PROVENANCE_INVALID: report rejected by validation';
  END;

  RETURN jsonb_build_object('capture_id', c.id, 'analyzed_at', v_at);
END;
$$;

-- ---------------------------------------------------------------- read (signed-in, RLS applies)
CREATE OR REPLACE FUNCTION public.get_evidence_photo_authenticity(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'PHOTO_PROVENANCE_UNAUTHORIZED' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'capture_id', a.capture_id, 'analyzer_version', a.analyzer_version, 'analyzed_at', a.analyzed_at, 'report', a.report
      ) ORDER BY a.analyzed_at)
      FROM public.evidence_photo_authenticity a
      WHERE a.job_id = p_job_id        -- RLS additionally restricts to the caller's account and visible jobs
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evp_authenticity_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evp_store_authenticity(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evp_store_authenticity(uuid, uuid, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.get_evidence_photo_authenticity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_evidence_photo_authenticity(uuid) TO authenticated;
