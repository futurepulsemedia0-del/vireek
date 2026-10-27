/*
  # Break rule set (jurisdiction) for meal & rest break compliance

  Adds ONE column and ONE RPC on top of 20271210000000_break_compliance.sql.
  Additive only: no existing column, policy or function signature changes.

  - break_compliance_settings.jurisdiction  rule set code picked by the manager
    (CA, WA, OR, CO, IL, FED). The rule numbers themselves stay in the existing
    columns; the rule-set DATA lives in the app (src/lib/breakRules.ts).
  - break_comp_settings_json()  now also returns 'jurisdiction'
    (same signature, CREATE OR REPLACE keeps its grants).
  - apply_break_jurisdiction()  manager-only; saves the rule numbers through the
    existing save_break_compliance_settings() (same validation) and the rule
    set code in ONE transaction.

  Not legal advice: rule sets are a general starting point (see breakRules.ts).
*/

ALTER TABLE break_compliance_settings
  ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'CA'
  CHECK (jurisdiction ~ '^[A-Z]{2,12}$');

CREATE OR REPLACE FUNCTION public.break_comp_settings_json(p_owner uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'enabled', COALESCE(s.enabled, true),
    'meal_min_minutes', COALESCE(s.meal_min_minutes, 30),
    'meal_deadline_minutes', COALESCE(s.meal_deadline_minutes, 300),
    'meal_thresholds', to_jsonb(COALESCE(s.meal_thresholds, ARRAY[300, 600])),
    'rest_min_minutes', COALESCE(s.rest_min_minutes, 10),
    'rest_thresholds', to_jsonb(COALESCE(s.rest_thresholds, ARRAY[210, 360, 600])),
    'premium_minutes', COALESCE(s.premium_minutes, 60),
    'prompts_enabled', COALESCE(s.prompts_enabled, true),
    'prompt_lead_minutes', COALESCE(s.prompt_lead_minutes, 30),
    'jurisdiction', COALESCE(s.jurisdiction, 'CA')
  )
  FROM (SELECT 1) one
  LEFT JOIN break_compliance_settings s ON s.user_id = p_owner;
$$;

CREATE OR REPLACE FUNCTION public.apply_break_jurisdiction(
  p_jurisdiction text,
  p_enabled boolean,
  p_meal_min integer,
  p_meal_deadline integer,
  p_meal_thresholds integer[],
  p_rest_min integer,
  p_rest_thresholds integer[],
  p_premium integer,
  p_prompts boolean,
  p_lead integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_code text := upper(btrim(COALESCE(p_jurisdiction, '')));
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.break_comp_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to change break rules' USING ERRCODE = '42501';
  END IF;
  IF v_code !~ '^[A-Z]{2,12}$' THEN
    RAISE EXCEPTION 'Unknown break rule set';
  END IF;

  -- Same validation and upsert as a normal rules save (creates the row if missing).
  PERFORM public.save_break_compliance_settings(
    p_enabled, p_meal_min, p_meal_deadline, p_meal_thresholds,
    p_rest_min, p_rest_thresholds, p_premium, p_prompts, p_lead
  );

  UPDATE break_compliance_settings
  SET jurisdiction = v_code, updated_at = now()
  WHERE user_id = v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_break_jurisdiction(text, boolean, integer, integer, integer[], integer, integer[], integer, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_break_jurisdiction(text, boolean, integer, integer, integer[], integer, integer[], integer, boolean, integer) TO authenticated;
