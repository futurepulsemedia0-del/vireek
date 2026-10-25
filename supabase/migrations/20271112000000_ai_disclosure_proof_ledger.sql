/*
  # AI Disclosure Proof Ledger

  Builds on 20260913070000_mandatory_ai_disclosure.sql (business_profile.ai_disclosure_script
  / ai_disclosure_enabled). That migration says WHAT must be said; this one PROVES it was said.

  ## Tables
  - ai_disclosure_versions    immutable history of every exact disclosure wording used
                              (account script edits + built-in translations).
  - call_ai_disclosures       one proof row per call: which version/language was planned,
                              and after the call whether the transcript really contains it
                              (when, offset, evidence excerpt, transcript hash).
  - ai_disclosure_drift_checks  history of "business_profile script vs live Vapi first message".

  ## Access model
  - Reads: account owner + members with can_edit_business_profile (ai_disclosure_can_view()).
  - Writes: service role / SECURITY DEFINER only (the webhook + drift scanner). No client writes.
  - Proof rows become immutable once final (trigger), so the ledger can be used as evidence.

  ## Notes
  - Purely additive. business_profile gets ONE new column (ai_disclosure_language, default 'en').
  - Alerts reuse the existing `notifications` table (deduped per type).
*/

-- ---------------------------------------------------------------------------
-- 1. business_profile: which language the account script is written in
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_profile
  ADD COLUMN IF NOT EXISTS ai_disclosure_language text NOT NULL DEFAULT 'en';

ALTER TABLE public.business_profile
  DROP CONSTRAINT IF EXISTS business_profile_ai_disclosure_language_check;
ALTER TABLE public.business_profile
  ADD CONSTRAINT business_profile_ai_disclosure_language_check
  CHECK (ai_disclosure_language IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja'));

-- ---------------------------------------------------------------------------
-- 2. Permission helper (same rule as can_manage_documents(): owner, or member
--    whose effective permission includes can_edit_business_profile)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_disclosure_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM public.team_members t WHERE t.user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM public.team_members t
      LEFT JOIN public.custom_roles cr ON cr.id = t.custom_role_id
      WHERE t.user_id = auth.uid()
        AND COALESCE(
              (cr.permissions ->> 'can_edit_business_profile')::boolean,
              (t.permissions ->> 'can_edit_business_profile')::boolean,
              false
            )
    );
$$;
GRANT EXECUTE ON FUNCTION public.ai_disclosure_can_view() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. ai_disclosure_versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_disclosure_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  language text NOT NULL CHECK (language IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja')),
  version integer NOT NULL CHECK (version > 0),
  disclosure_text text NOT NULL CHECK (char_length(btrim(disclosure_text)) > 0 AND char_length(disclosure_text) <= 1000),
  text_sha256 text NOT NULL,
  source text NOT NULL CHECK (source IN ('business_profile', 'builtin_translation', 'owner_override')),
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT ai_disclosure_versions_unique_text UNIQUE (user_id, language, text_sha256),
  CONSTRAINT ai_disclosure_versions_unique_version UNIQUE (user_id, language, source, version)
);

-- At most one "current account script" per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_disclosure_versions_one_current
  ON public.ai_disclosure_versions (user_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_ai_disclosure_versions_user_created
  ON public.ai_disclosure_versions (user_id, created_at DESC);

ALTER TABLE public.ai_disclosure_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_disclosure_versions_select" ON public.ai_disclosure_versions;
CREATE POLICY "ai_disclosure_versions_select" ON public.ai_disclosure_versions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());

REVOKE ALL ON public.ai_disclosure_versions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.ai_disclosure_versions FROM authenticated;
GRANT SELECT ON public.ai_disclosure_versions TO authenticated;

-- Registers (or re-activates) an exact wording; returns its version id.
-- Same text twice -> same row. Only p_source = 'business_profile' moves the "current" flag.
CREATE OR REPLACE FUNCTION public.ai_disclosure_register_version(
  p_user_id uuid, p_language text, p_text text, p_source text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text text := btrim(COALESCE(p_text, ''));
  v_hash text;
  v_id uuid;
  v_current boolean;
  v_next integer;
BEGIN
  IF v_text = '' THEN
    RAISE EXCEPTION 'ai_disclosure_text_blank' USING ERRCODE = 'check_violation';
  END IF;
  v_hash := encode(sha256(convert_to(v_text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':disclosure', 0));

  SELECT id, is_current INTO v_id, v_current
  FROM public.ai_disclosure_versions
  WHERE user_id = p_user_id AND language = p_language AND text_sha256 = v_hash;

  IF FOUND THEN
    IF p_source = 'business_profile' AND NOT v_current THEN
      UPDATE public.ai_disclosure_versions
        SET is_current = false, superseded_at = now()
        WHERE user_id = p_user_id AND is_current;
      UPDATE public.ai_disclosure_versions
        SET is_current = true, activated_at = now(), superseded_at = NULL
        WHERE id = v_id;
    END IF;
    RETURN v_id;
  END IF;

  IF p_source = 'business_profile' THEN
    UPDATE public.ai_disclosure_versions
      SET is_current = false, superseded_at = now()
      WHERE user_id = p_user_id AND is_current;
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next
  FROM public.ai_disclosure_versions
  WHERE user_id = p_user_id AND language = p_language AND source = p_source;

  INSERT INTO public.ai_disclosure_versions
    (user_id, language, version, disclosure_text, text_sha256, source, is_current)
  VALUES
    (p_user_id, p_language, v_next, v_text, v_hash, p_source, p_source = 'business_profile')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_disclosure_register_version(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_disclosure_register_version(uuid, text, text, text) TO service_role;

-- Every script edit is captured automatically, even a direct SQL/API write.
-- Never blocks saving the profile: a ledger problem is logged as a warning only.
CREATE OR REPLACE FUNCTION public.business_profile_register_disclosure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.user_id)
     OR char_length(btrim(COALESCE(NEW.ai_disclosure_script, ''))) = 0 THEN
    RETURN NEW;
  END IF;
  PERFORM public.ai_disclosure_register_version(
    NEW.user_id, NEW.ai_disclosure_language, NEW.ai_disclosure_script, 'business_profile');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ai_disclosure version registration failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_business_profile_register_disclosure ON public.business_profile;
CREATE TRIGGER trigger_business_profile_register_disclosure
  AFTER INSERT OR UPDATE OF ai_disclosure_script, ai_disclosure_language ON public.business_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.business_profile_register_disclosure();

-- Backfill: current script of every existing account becomes version 1.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT bp.user_id, bp.ai_disclosure_language AS lang, bp.ai_disclosure_script AS script
    FROM public.business_profile bp
    WHERE bp.user_id IN (SELECT id FROM public.profiles)
      AND char_length(btrim(COALESCE(bp.ai_disclosure_script, ''))) > 0
  LOOP
    PERFORM public.ai_disclosure_register_version(r.user_id, r.lang, r.script, 'business_profile');
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. call_ai_disclosures (the proof)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.call_ai_disclosures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  vapi_call_id text NOT NULL,
  call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL,
  version_id uuid REFERENCES public.ai_disclosure_versions(id) ON DELETE SET NULL,
  language text NOT NULL CHECK (language IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja')),
  selection_reason text NOT NULL CHECK (selection_reason IN ('caller_language_match', 'caller_language_translation', 'default_fallback')),
  disclosure_text text NOT NULL,
  disclosure_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'late', 'partial', 'missing', 'no_transcript', 'not_applicable')),
  matched_via text CHECK (matched_via IS NULL OR matched_via IN ('planned', 'alternate_version')),
  delivered_at timestamptz,
  offset_seconds numeric(8, 2) CHECK (offset_seconds IS NULL OR offset_seconds >= 0),
  transcript_char_offset integer CHECK (transcript_char_offset IS NULL OR transcript_char_offset >= 0),
  matched_turn_index integer CHECK (matched_turn_index IS NULL OR matched_turn_index >= 0),
  match_score numeric(4, 3) CHECK (match_score IS NULL OR match_score BETWEEN 0 AND 1),
  evidence_excerpt text CHECK (evidence_excerpt IS NULL OR char_length(evidence_excerpt) <= 600),
  transcript_sha256 text,
  detected_language text CHECK (detected_language IS NULL OR detected_language IN ('en', 'es', 'zh', 'hi', 'fr', 'de', 'ar', 'fa', 'ja')),
  language_mismatch boolean NOT NULL DEFAULT false,
  call_started_at timestamptz,
  call_duration_seconds integer CHECK (call_duration_seconds IS NULL OR call_duration_seconds >= 0),
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_ai_disclosures_one_per_call UNIQUE (user_id, vapi_call_id)
);

CREATE INDEX IF NOT EXISTS idx_call_ai_disclosures_user_created
  ON public.call_ai_disclosures (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_ai_disclosures_user_status
  ON public.call_ai_disclosures (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_ai_disclosures_call
  ON public.call_ai_disclosures (call_id) WHERE call_id IS NOT NULL;

-- Once a row leaves 'pending' its proof columns can never change.
-- Only the call link and the alert stamp may still be filled in.
CREATE OR REPLACE FUNCTION public.call_ai_disclosures_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  IF OLD.status <> 'pending'
     AND (to_jsonb(NEW) - 'alerted_at' - 'call_id' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'alerted_at' - 'call_id' - 'updated_at') THEN
    RAISE EXCEPTION 'ai_disclosure_proof_is_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_call_ai_disclosures_guard ON public.call_ai_disclosures;
CREATE TRIGGER trigger_call_ai_disclosures_guard
  BEFORE UPDATE ON public.call_ai_disclosures
  FOR EACH ROW
  EXECUTE FUNCTION public.call_ai_disclosures_guard();

ALTER TABLE public.call_ai_disclosures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "call_ai_disclosures_select" ON public.call_ai_disclosures;
CREATE POLICY "call_ai_disclosures_select" ON public.call_ai_disclosures
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());

REVOKE ALL ON public.call_ai_disclosures FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.call_ai_disclosures FROM authenticated;
GRANT SELECT ON public.call_ai_disclosures TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. ai_disclosure_drift_checks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_disclosure_drift_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  trigger_source text NOT NULL DEFAULT 'scheduled' CHECK (trigger_source IN ('scheduled', 'manual')),
  vapi_assistant_id text,
  status text NOT NULL CHECK (status IN ('in_sync', 'drift', 'no_first_message', 'unreachable', 'not_configured')),
  reason text,
  expected_text text,
  live_first_message text CHECK (live_first_message IS NULL OR char_length(live_first_message) <= 2000),
  similarity numeric(4, 3) CHECK (similarity IS NULL OR similarity BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS idx_ai_disclosure_drift_user_checked
  ON public.ai_disclosure_drift_checks (user_id, checked_at DESC);

ALTER TABLE public.ai_disclosure_drift_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_disclosure_drift_select" ON public.ai_disclosure_drift_checks;
CREATE POLICY "ai_disclosure_drift_select" ON public.ai_disclosure_drift_checks
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.ai_disclosure_can_view());

REVOKE ALL ON public.ai_disclosure_drift_checks FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.ai_disclosure_drift_checks FROM authenticated;
GRANT SELECT ON public.ai_disclosure_drift_checks TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Alerts (reuse notifications) — deduped so a misconfiguration can't spam
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_disclosure_raise_alert(
  p_user_id uuid, p_type text, p_title text, p_message text, p_action_url text,
  p_dedupe_minutes integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_type, 0));
  IF EXISTS (
    SELECT 1 FROM public.notifications
    WHERE user_id = p_user_id AND type = p_type
      AND created_at > now() - make_interval(mins => GREATEST(p_dedupe_minutes, 1))
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.notifications (user_id, type, title, message, action_url)
  VALUES (p_user_id, p_type, p_title, p_message, p_action_url);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_disclosure_raise_alert(uuid, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_disclosure_raise_alert(uuid, text, text, text, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Summary for the dashboard (SECURITY INVOKER: RLS applies)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_disclosure_summary(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total',             count(*),
    'delivered',         count(*) FILTER (WHERE status = 'delivered'),
    'late',              count(*) FILTER (WHERE status = 'late'),
    'partial',           count(*) FILTER (WHERE status = 'partial'),
    'missing',           count(*) FILTER (WHERE status = 'missing'),
    'no_transcript',     count(*) FILTER (WHERE status = 'no_transcript'),
    'not_applicable',    count(*) FILTER (WHERE status = 'not_applicable'),
    'pending',           count(*) FILTER (WHERE status = 'pending'),
    'language_mismatch', count(*) FILTER (WHERE language_mismatch)
  )
  FROM public.call_ai_disclosures
  WHERE user_id = public.get_account_owner_id()
    AND created_at >= p_from
    AND created_at < p_to;
$$;
GRANT EXECUTE ON FUNCTION public.ai_disclosure_summary(timestamptz, timestamptz) TO authenticated;

COMMENT ON TABLE public.call_ai_disclosures IS
  'Per-call proof that the AI-voice disclosure was (or was not) spoken. Immutable once final.';
COMMENT ON TABLE public.ai_disclosure_versions IS
  'Every exact disclosure wording ever used (account script edits + built-in translations).';
COMMENT ON TABLE public.ai_disclosure_drift_checks IS
  'History of business_profile.ai_disclosure_script vs the live Vapi assistant first message.';
