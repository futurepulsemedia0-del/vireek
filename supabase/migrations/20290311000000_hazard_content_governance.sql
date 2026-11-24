/*
  # Hazard content governance (2029-03-11)

  Safety-critical content (gas, carbon monoxide, electrical, refrigerant) needs a named human reviewer, a review date,
  an expiry and a version before it may be PUBLISHED to, or USED by, the AI. See docs/safety/hazard-content-governance.md.

  Adds (additive, idempotent; no existing row is rewritten, no existing policy weakened):
    1. medical_emergency safety rule row in vertical_ontology_entries (keeps parity with ontologySeed.ts).
    2. Governance columns on vertical_ontology_entries, diag_hypotheses, diag_questions:
         hazard_domains, review_expires_on (+ reviewer_qualification, reviewed_by, reviewed_at, content_version, hazard_tier
         on the diag tables; the ontology already has reviewed / reviewed_by / reviewed_at / version).
    3. hazard_detect_domains(text) and hazard_review_is_current(...) helpers.
    4. A BEFORE INSERT/UPDATE trigger on the three tables that blocks PUBLISHING instructional hazard content without a
       current review. Safety-rule floor rows ("leave the building, call 911") are never blocked. Rows that exist today and
       are not edited are untouched (the runtime gate in vertical-ai/runtime.ts keeps them away from the AI until reviewed).
    5. hazard_content_review_log (append-only audit trail) and record_hazard_review(...) (service_role only).

  Not executed in the authoring environment (no Postgres available): run `supabase db reset` + `supabase test db` before release.

  Rollback (new objects only; the added columns are harmless to keep):
    DROP TRIGGER IF EXISTS trg_hazard_publish_gate ON public.vertical_ontology_entries;
    DROP TRIGGER IF EXISTS trg_hazard_publish_gate ON public.diag_hypotheses;
    DROP TRIGGER IF EXISTS trg_hazard_publish_gate ON public.diag_questions;
    DROP FUNCTION IF EXISTS public.enforce_hazard_publish();
    DROP FUNCTION IF EXISTS public.record_hazard_review(text, text, integer, text, text, date, text);
    DROP TABLE IF EXISTS public.hazard_content_review_log;
    DROP FUNCTION IF EXISTS public.hazard_review_is_current(text, text, timestamptz, date);
    DROP FUNCTION IF EXISTS public.hazard_detect_domains(text);
*/

-- rollback: drop the triggers, functions and the review log listed in the header comment; the added columns and the medical_emergency row are harmless to keep.

-- =============================================================
-- 1. medical_emergency safety rule (floor content; never blocked)
-- =============================================================
INSERT INTO public.vertical_ontology_entries
  (trade, kind, key, version, title, payload, source, effective_on, expires_on, jurisdiction, confidence, reviewed)
VALUES
  ('all', 'safety_rule', 'medical_emergency', 1, 'Medical emergency (unconscious, not breathing, chest pain)',
   '{"flag":"medical_emergency","guidance":"Call 911 right now for anyone who is unconscious, not breathing, has chest pain or is badly hurt, and stay with them. Emergency responders come first. I''m alerting our on-call technician too."}'::jsonb,
   'Vireek editorial v1 - standard public-safety guidance summary (not yet reviewed by a licensed professional)',
   '2026-11-01', NULL, 'US', 0.9, false)
ON CONFLICT (trade, kind, key, version, jurisdiction) DO NOTHING;

-- =============================================================
-- 2. GOVERNANCE COLUMNS
-- =============================================================
ALTER TABLE public.vertical_ontology_entries
  ADD COLUMN IF NOT EXISTS review_expires_on date,
  ADD COLUMN IF NOT EXISTS reviewer_qualification text,
  ADD COLUMN IF NOT EXISTS hazard_domains text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.diag_hypotheses
  ADD COLUMN IF NOT EXISTS hazard_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hazard_tier text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewer_qualification text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_expires_on date;

ALTER TABLE public.diag_questions
  ADD COLUMN IF NOT EXISTS hazard_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hazard_tier text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewer_qualification text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_expires_on date;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['diag_hypotheses', 'diag_questions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_hazard_tier_chk') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (hazard_tier IN (''none'', ''floor'', ''guardrail'', ''instructional''))', t, t || '_hazard_tier_chk');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_content_version_chk') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (content_version >= 1)', t, t || '_content_version_chk');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_review_window_chk') THEN
      EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
        (reviewed_by IS NULL AND reviewed_at IS NULL AND review_expires_on IS NULL)
        OR (reviewed_by IS NOT NULL AND char_length(btrim(reviewed_by)) >= 3 AND reviewed_at IS NOT NULL AND review_expires_on IS NOT NULL
            AND review_expires_on > (reviewed_at AT TIME ZONE 'UTC')::date
            AND review_expires_on - (reviewed_at AT TIME ZONE 'UTC')::date <= 366)
      ) NOT VALID$f$, t, t || '_review_window_chk');
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vertical_ontology_review_window_chk') THEN
    ALTER TABLE public.vertical_ontology_entries ADD CONSTRAINT vertical_ontology_review_window_chk CHECK (
      NOT reviewed OR (review_expires_on IS NOT NULL
        AND review_expires_on > (reviewed_at AT TIME ZONE 'UTC')::date
        AND review_expires_on - (reviewed_at AT TIME ZONE 'UTC')::date <= 366)
    ) NOT VALID;
  END IF;
END $$;

-- =============================================================
-- 3. HELPERS (mirror supabase/functions/_shared/safety-governance/hazardGovernance.ts; a test keeps them in step)
-- =============================================================
CREATE OR REPLACE FUNCTION public.hazard_detect_domains(p_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(array_agg(d ORDER BY o), '{}'::text[]) FROM (
    SELECT 'gas'::text AS d, 1 AS o WHERE left(COALESCE(p_text, ''), 20000) ~* '(natural gas|propane|lpg|gas (leak|smell|odou?r|line|lines|valve|supply|pipe|piping|furnace|appliance|appliances|meter|shut ?off|pressure|permit)|smell(s|ing)? (of )?gas|pilot light|flame sensor|\ygas\y|huele a gas|fuga de gas)'
    UNION ALL
    SELECT 'carbon_monoxide', 2 WHERE left(COALESCE(p_text, ''), 20000) ~* '(carbon monoxide|monoxide|\yco (alarm|alarms|detector|detectors|sensor|safety|risk|poisoning)|\yco2? alarm|\yflue\y|\yventing\y|backdraft)'
    UNION ALL
    SELECT 'electrical', 3 WHERE left(COALESCE(p_text, ''), 20000) ~* '(\yelectrical\y|electric shock|live wir(e|es|ing)|\ywiring\y|\ybreakers?\y|(main|sub|electrical|breaker|service) panel|\ygfci\y|arc ?fault|\ysparking\y|\ysparks\y|\yarcing\y|\ylockout\y|\ytagout\y|high voltage|\yenergized\y)'
    UNION ALL
    SELECT 'refrigerant', 4 WHERE left(COALESCE(p_text, ''), 20000) ~* '(\yrefrigerant|\yfreon\y|\yr-?410a\y|\yr-?22\y|\yr-?32\y|\yr-?454b\y|epa ?608|\ysuperheat\y|\ysubcool|\ybrazing\y|nitrogen purge|low charge)'
  ) x;
$$;

CREATE OR REPLACE FUNCTION public.hazard_review_is_current(p_reviewed_by text, p_qualification text, p_reviewed_at timestamptz, p_expires date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT p_reviewed_by IS NOT NULL AND char_length(btrim(p_reviewed_by)) >= 3
     AND p_qualification IS NOT NULL AND char_length(btrim(p_qualification)) >= 3
     AND p_reviewed_at IS NOT NULL AND p_expires IS NOT NULL
     AND (p_reviewed_at AT TIME ZONE 'UTC')::date <= (now() AT TIME ZONE 'UTC')::date
     AND p_expires > (now() AT TIME ZONE 'UTC')::date
     AND p_expires > (p_reviewed_at AT TIME ZONE 'UTC')::date
     AND p_expires - (p_reviewed_at AT TIME ZONE 'UTC')::date <= 366;
$$;

REVOKE ALL ON FUNCTION public.hazard_detect_domains(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hazard_review_is_current(text, text, timestamptz, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hazard_detect_domains(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hazard_review_is_current(text, text, timestamptz, date) TO service_role;

-- =============================================================
-- 4. PUBLISH GATE
-- =============================================================
CREATE OR REPLACE FUNCTION public.enforce_hazard_publish()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_text text;
  v_domains text[];
  v_content_changed boolean := false;
  v_publishing boolean := false;
  v_floor boolean := false;
  v_reviewed boolean;
  v_id text;
BEGIN
  IF TG_TABLE_NAME = 'vertical_ontology_entries' THEN
    -- caller synonyms are what people say ("gas smell"), not guidance: excluded from the scan
    v_text := NEW.title || ' ' || COALESCE((NEW.payload - 'synonyms')::text, '');
    v_id := NEW.trade || ':' || NEW.kind || ':' || NEW.key;
    v_floor := NEW.kind = 'safety_rule';
    v_publishing := NEW.status = 'active';
    v_reviewed := NEW.reviewed AND public.hazard_review_is_current(NEW.reviewed_by, NEW.reviewer_qualification, NEW.reviewed_at, NEW.review_expires_on);
    IF TG_OP = 'UPDATE' THEN
      v_content_changed := (NEW.title, NEW.payload, NEW.version, NEW.kind, NEW.key) IS DISTINCT FROM (OLD.title, OLD.payload, OLD.version, OLD.kind, OLD.key) OR OLD.status IS DISTINCT FROM 'active';
    END IF;
  ELSIF TG_TABLE_NAME = 'diag_hypotheses' THEN
    v_id := NEW.domain_code || ':' || NEW.code;
    v_text := NEW.label || ' ' || COALESCE(NEW.parts_hint, '');
    v_floor := NEW.hazard_tier IN ('floor', 'guardrail');
    v_publishing := true;
    v_reviewed := public.hazard_review_is_current(NEW.reviewed_by, NEW.reviewer_qualification, NEW.reviewed_at, NEW.review_expires_on);
    IF TG_OP = 'UPDATE' THEN
      v_content_changed := (NEW.label, NEW.parts_hint, NEW.safety, NEW.prior, NEW.content_version) IS DISTINCT FROM (OLD.label, OLD.parts_hint, OLD.safety, OLD.prior, OLD.content_version);
    END IF;
  ELSE -- diag_questions
    v_id := NEW.domain_code || ':' || NEW.code;
    v_text := NEW.text || ' ' || COALESCE(NEW.help, '') || ' ' || NEW.options::text;
    v_floor := NEW.hazard_tier IN ('floor', 'guardrail');
    v_publishing := NEW.status = 'active';
    v_reviewed := public.hazard_review_is_current(NEW.reviewed_by, NEW.reviewer_qualification, NEW.reviewed_at, NEW.review_expires_on);
    IF TG_OP = 'UPDATE' THEN
      v_content_changed := (NEW.text, NEW.help, NEW.options, NEW.effort, NEW.content_version) IS DISTINCT FROM (OLD.text, OLD.help, OLD.options, OLD.effort, OLD.content_version) OR OLD.status IS DISTINCT FROM 'active';
    END IF;
  END IF;

  -- A writer can never under-declare: the stored domains are the union of what was declared and what the text contains.
  v_domains := ARRAY(SELECT DISTINCT d FROM unnest(COALESCE(NEW.hazard_domains, '{}'::text[]) || public.hazard_detect_domains(v_text)) AS d ORDER BY d);
  NEW.hazard_domains := v_domains;

  IF cardinality(v_domains) = 0 OR v_floor OR NOT v_publishing THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT v_content_changed THEN
    RETURN NEW; -- untouched legacy rows keep working; the runtime gate still withholds them from the AI until reviewed
  END IF;
  IF NOT v_reviewed THEN
    RAISE EXCEPTION 'hazard_content_unreviewed: % % touches [%] and has no current review (reviewer, qualification, review date, expiry and version are required)',
      TG_TABLE_NAME, v_id, array_to_string(v_domains, ',')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_hazard_publish() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hazard_publish_gate ON public.vertical_ontology_entries;
CREATE TRIGGER trg_hazard_publish_gate BEFORE INSERT OR UPDATE ON public.vertical_ontology_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_hazard_publish();
DROP TRIGGER IF EXISTS trg_hazard_publish_gate ON public.diag_hypotheses;
CREATE TRIGGER trg_hazard_publish_gate BEFORE INSERT OR UPDATE ON public.diag_hypotheses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_hazard_publish();
DROP TRIGGER IF EXISTS trg_hazard_publish_gate ON public.diag_questions;
CREATE TRIGGER trg_hazard_publish_gate BEFORE INSERT OR UPDATE ON public.diag_questions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_hazard_publish();

-- =============================================================
-- 5. AUDIT LOG + REVIEW WRITER
-- =============================================================
CREATE TABLE IF NOT EXISTS public.hazard_content_review_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_kind text NOT NULL CHECK (content_kind IN ('ontology', 'diag_hypothesis', 'diag_question')),
  content_key text NOT NULL CHECK (char_length(content_key) BETWEEN 1 AND 200),
  content_version integer NOT NULL CHECK (content_version >= 1),
  reviewer text NOT NULL CHECK (char_length(btrim(reviewer)) >= 3),
  reviewer_qualification text NOT NULL CHECK (char_length(btrim(reviewer_qualification)) >= 3),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  expires_on date NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hazard_review_log_content ON public.hazard_content_review_log (content_kind, content_key, created_at DESC);

ALTER TABLE public.hazard_content_review_log ENABLE ROW LEVEL SECURITY;
-- no policies: only the service role (which bypasses RLS) reads or writes
REVOKE ALL ON public.hazard_content_review_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hazard_review_log_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'hazard_content_review_log is append-only' USING ERRCODE = 'check_violation';
END;
$$;
REVOKE ALL ON FUNCTION public.hazard_review_log_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_hazard_review_log_append_only ON public.hazard_content_review_log;
CREATE TRIGGER trg_hazard_review_log_append_only BEFORE UPDATE OR DELETE ON public.hazard_content_review_log
  FOR EACH ROW EXECUTE FUNCTION public.hazard_review_log_append_only();

/*
  record_hazard_review: the ONLY supported way to mark hazard content reviewed.
    p_kind 'ontology'        p_key = '<trade>:<kind>:<key>'   (e.g. 'hvac:symptom:no_cooling')   p_version = row version
    p_kind 'diag_hypothesis' p_key = '<domain_code>:<code>'   p_version = content_version
    p_kind 'diag_question'   p_key = '<domain_code>:<code>'   p_version = content_version
  The reviewer must be a named person; the expiry must be in the future and at most 366 days out. The write is logged.
*/
CREATE OR REPLACE FUNCTION public.record_hazard_review(
  p_kind text, p_key text, p_version integer, p_reviewer text, p_qualification text, p_expires_on date, p_note text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_parts text[] := string_to_array(p_key, ':');
  v_n integer := 0;
BEGIN
  IF p_reviewer IS NULL OR char_length(btrim(p_reviewer)) < 3 THEN RAISE EXCEPTION 'reviewer is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_qualification IS NULL OR char_length(btrim(p_qualification)) < 3 THEN RAISE EXCEPTION 'reviewer qualification is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_expires_on IS NULL OR p_expires_on <= v_today OR p_expires_on - v_today > 366 THEN RAISE EXCEPTION 'expiry must be after today and at most 366 days out' USING ERRCODE = 'check_violation'; END IF;
  IF p_version IS NULL OR p_version < 1 THEN RAISE EXCEPTION 'version is required' USING ERRCODE = 'check_violation'; END IF;

  IF p_kind = 'ontology' AND array_length(v_parts, 1) = 3 THEN
    UPDATE public.vertical_ontology_entries
       SET reviewed = true, reviewed_by = btrim(p_reviewer), reviewer_qualification = btrim(p_qualification), reviewed_at = now(), review_expires_on = p_expires_on
     WHERE trade = v_parts[1] AND kind = v_parts[2] AND key = v_parts[3] AND version = p_version;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'diag_hypothesis' AND array_length(v_parts, 1) = 2 THEN
    UPDATE public.diag_hypotheses
       SET reviewed_by = btrim(p_reviewer), reviewer_qualification = btrim(p_qualification), reviewed_at = now(), review_expires_on = p_expires_on
     WHERE domain_code = v_parts[1] AND code = v_parts[2] AND content_version = p_version;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'diag_question' AND array_length(v_parts, 1) = 2 THEN
    UPDATE public.diag_questions
       SET reviewed_by = btrim(p_reviewer), reviewer_qualification = btrim(p_qualification), reviewed_at = now(), review_expires_on = p_expires_on
     WHERE domain_code = v_parts[1] AND code = v_parts[2] AND content_version = p_version;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unknown content kind or malformed key' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_n <> 1 THEN
    RAISE EXCEPTION 'no content row matches % % at version % (a review is bound to one version)', p_kind, p_key, p_version USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.hazard_content_review_log (content_kind, content_key, content_version, reviewer, reviewer_qualification, expires_on, note)
  VALUES (p_kind, p_key, p_version, btrim(p_reviewer), btrim(p_qualification), p_expires_on, p_note);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_hazard_review(text, text, integer, text, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_hazard_review(text, text, integer, text, text, date, text) TO service_role;
