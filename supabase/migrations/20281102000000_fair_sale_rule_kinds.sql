-- =============================================================
-- Fair Sale Protocol, part 1/2 — extend the regulation-as-code catalog
--
-- Adds two rule kinds to the existing compliance engine (no parallel system):
--   deposit_limit              cap on upfront payments (percent and/or absolute)
--   written_contract_threshold agreement must be in writing at/above an amount
-- and an optional `eligibilityCode` param on rescission / deposit_limit rules, so an
-- extended protection (for example a longer cancellation window for eligible consumers)
-- applies ONLY when the customer voluntarily declares eligibility.
--
-- NOT LEGAL ADVICE. This migration adds capability only. It seeds NO statutory rule:
-- every real rule must be entered as a draft with a verified citation, effective date
-- and counsel sign-off through the existing Rule review workflow before it can apply.
--
-- Mirrors supabase/functions/_shared/compliance-rules/engine.ts (validateRuleParams).
-- Depends on: 20271110000000_compliance_rule_packs.sql.
-- Safe to re-run.
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.compliance_rules') IS NULL
     OR (to_regprocedure('public.compliance_version_errors(text,text,text,text[],text,text,jsonb,jsonb,date,date)') IS NULL
         AND to_regprocedure('public.compliance_version_errors_core(text,text,text,text[],text,text,jsonb,jsonb,date,date)') IS NULL) THEN
    RAISE EXCEPTION 'compliance rule packs are missing — run 20271110000000_compliance_rule_packs.sql first.';
  END IF;
END $$;

-- 1. Widen the allowed kinds ------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.compliance_rules'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.compliance_rules DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.compliance_rules ADD CONSTRAINT compliance_rules_kind_check
    CHECK (kind IN ('recording_consent', 'ai_disclosure', 'quiet_hours', 'consent_required', 'license_display',
                    'rescission', 'required_notice', 'price_cap', 'deposit_limit', 'written_contract_threshold'));
END $$;

-- 2. Validator: keep the original as _core, wrap it for the new kinds -------------------------
-- lint:allow-destructive renames the original validator once so the wrapper can keep the public name every RPC already calls
DO $$
BEGIN
  IF to_regprocedure('public.compliance_version_errors_core(text,text,text,text[],text,text,jsonb,jsonb,date,date)') IS NULL THEN
    ALTER FUNCTION public.compliance_version_errors(text, text, text, text[], text, text, jsonb, jsonb, date, date)
      RENAME TO compliance_version_errors_core;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.compliance_version_errors(
  p_jurisdiction text, p_kind text, p_severity text, p_applies text[], p_title text, p_explanation text,
  p_params jsonb, p_refs jsonb, p_from date, p_to date
) RETURNS text[] LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  e text[];
  s text;
  v_num numeric;
BEGIN
  -- Existing kinds: unchanged behaviour, plus the optional eligibilityCode shape check.
  IF p_kind NOT IN ('deposit_limit', 'written_contract_threshold') THEN
    e := public.compliance_version_errors_core(p_jurisdiction, p_kind, p_severity, p_applies, p_title, p_explanation, p_params, p_refs, p_from, p_to);
    IF p_kind = 'rescission' AND jsonb_typeof(p_params) = 'object' AND p_params ? 'eligibilityCode'
       AND COALESCE(p_params ->> 'eligibilityCode', '') !~ '^[a-z0-9_]{2,40}$' THEN
      e := array_append(e, 'eligibilityCode must match [a-z0-9_]{2,40}');
    END IF;
    RETURN e;
  END IF;

  -- New kinds: run the generic checks (jurisdiction, severity, title, explanation, sources, dates)
  -- through the core with a known-valid stand-in kind and params, then add the kind-specific checks.
  e := public.compliance_version_errors_core(
    p_jurisdiction, 'required_notice', p_severity, ARRAY['quote']::text[], p_title, p_explanation,
    jsonb_build_object('noticeId', 'stand-in', 'text', 'stand-in'), p_refs, p_from, p_to);

  IF p_applies IS NULL OR cardinality(p_applies) = 0 THEN
    e := array_append(e, 'choose at least one surface');
  ELSE
    FOREACH s IN ARRAY p_applies LOOP
      IF NOT (s = ANY (ARRAY['quote', 'contract'])) THEN e := array_append(e, format('%s cannot apply to %s', p_kind, s)); END IF;
    END LOOP;
  END IF;

  IF COALESCE(jsonb_typeof(p_params), '') <> 'object' THEN
    RETURN array_append(e, 'params must be an object');
  END IF;

  IF p_params ? 'eligibilityCode' AND COALESCE(p_params ->> 'eligibilityCode', '') !~ '^[a-z0-9_]{2,40}$' THEN
    e := array_append(e, 'eligibilityCode must match [a-z0-9_]{2,40}');
  END IF;

  IF p_kind = 'deposit_limit' THEN
    IF NOT (p_params ? 'maxPercent') AND NOT (p_params ? 'maxAmountCents') THEN
      e := array_append(e, 'set maxPercent and/or maxAmountCents');
    END IF;
    IF p_params ? 'maxPercent' THEN
      IF jsonb_typeof(p_params -> 'maxPercent') <> 'number' THEN
        e := array_append(e, 'maxPercent must be a number > 0 and <= 100');
      ELSE
        v_num := (p_params ->> 'maxPercent')::numeric;
        IF v_num <= 0 OR v_num > 100 THEN e := array_append(e, 'maxPercent must be a number > 0 and <= 100'); END IF;
      END IF;
    END IF;
    IF p_params ? 'maxAmountCents' THEN
      IF jsonb_typeof(p_params -> 'maxAmountCents') <> 'number' THEN
        e := array_append(e, 'maxAmountCents must be an integer >= 0');
      ELSE
        v_num := (p_params ->> 'maxAmountCents')::numeric;
        IF v_num <> trunc(v_num) OR v_num < 0 THEN e := array_append(e, 'maxAmountCents must be an integer >= 0'); END IF;
      END IF;
    END IF;
    IF p_params ? 'minTotalCents' THEN
      IF jsonb_typeof(p_params -> 'minTotalCents') <> 'number' THEN
        e := array_append(e, 'minTotalCents must be an integer >= 0');
      ELSE
        v_num := (p_params ->> 'minTotalCents')::numeric;
        IF v_num <> trunc(v_num) OR v_num < 0 THEN e := array_append(e, 'minTotalCents must be an integer >= 0'); END IF;
      END IF;
    END IF;
  ELSE -- written_contract_threshold
    IF COALESCE(jsonb_typeof(p_params -> 'minAmountCents'), '') <> 'number' THEN
      e := array_append(e, 'minAmountCents must be an integer >= 0');
    ELSE
      v_num := (p_params ->> 'minAmountCents')::numeric;
      IF v_num <> trunc(v_num) OR v_num < 0 THEN e := array_append(e, 'minAmountCents must be an integer >= 0'); END IF;
    END IF;
  END IF;
  RETURN e;
END $$;
