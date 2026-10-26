/*
  # Meal & rest break compliance (/dashboard/break-compliance)

  Configurable meal / rest break rules, technician prompts and a violation
  report built on top of the existing time clock (time_shifts +
  time_shift_breaks). Additive only: NO existing table, column, policy or
  function is altered.

  ## How breaks are classified (no change to the time clock)
  The time clock records breaks without a type, so a closed break is
  classified by its length:
    - length >= meal_min_minutes                      -> meal break
    - rest_min_minutes <= length < meal_min_minutes   -> rest break
    - shorter                                         -> does not count
  Violations are COMPUTED from the shift data by the app (never stored), so a
  rule change re-evaluates history. Only manager decisions are stored.

  ## Tables
  - break_compliance_settings   one row per account (rules + prompts)
  - break_violation_reviews     manager decision per (shift, violation code):
                                waived / excused / premium_paid

  ## Security model
  - Rows carry user_id = the ACCOUNT OWNER's id (public.get_account_owner_id()).
  - Managers (owner, or can_view_billing — same rule as the time clock
    reports) can read reviews and change rules / review violations.
  - Settings have no table policy: read/write only through RPCs. Every
    account member can read the RULES (for prompts) via my_break_rules().
  - All writes go through SECURITY DEFINER RPCs that re-check permissions.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS break_compliance_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  meal_min_minutes integer NOT NULL DEFAULT 30 CHECK (meal_min_minutes BETWEEN 5 AND 180),
  meal_deadline_minutes integer NOT NULL DEFAULT 300 CHECK (meal_deadline_minutes BETWEEN 60 AND 1440),
  meal_thresholds integer[] NOT NULL DEFAULT '{300,600}' CHECK (cardinality(meal_thresholds) BETWEEN 0 AND 4),
  rest_min_minutes integer NOT NULL DEFAULT 10 CHECK (rest_min_minutes BETWEEN 1 AND 60),
  rest_thresholds integer[] NOT NULL DEFAULT '{210,360,600}' CHECK (cardinality(rest_thresholds) BETWEEN 0 AND 6),
  premium_minutes integer NOT NULL DEFAULT 60 CHECK (premium_minutes BETWEEN 0 AND 480),
  prompts_enabled boolean NOT NULL DEFAULT true,
  prompt_lead_minutes integer NOT NULL DEFAULT 30 CHECK (prompt_lead_minutes BETWEEN 5 AND 120),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rest_min_minutes < meal_min_minutes)
);

CREATE TABLE IF NOT EXISTS break_violation_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES time_shifts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code IN ('meal_missing', 'meal_late', 'rest_missing')),
  status text NOT NULL CHECK (status IN ('waived', 'excused', 'premium_paid')),
  note text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewer_name text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, code)
);

CREATE INDEX IF NOT EXISTS idx_break_reviews_user
  ON break_violation_reviews (user_id, reviewed_at DESC);

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================

-- Owner, or an accepted team member with can_view_billing (direct or via custom role).
CREATE OR REPLACE FUNCTION public.break_comp_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.invite_status IN ('accepted', 'active')
        AND COALESCE(cr.permissions ->> 'can_view_billing', tm.permissions ->> 'can_view_billing', 'false') = 'true'
    )
  );
$$;

-- The rules for one account as JSON (defaults when the account never saved any).
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
    'prompt_lead_minutes', COALESCE(s.prompt_lead_minutes, 30)
  )
  FROM (SELECT 1) one
  LEFT JOIN break_compliance_settings s ON s.user_id = p_owner;
$$;

-- =============================================================
-- RPC: break_compliance_options — rules, caller capability, team list
-- =============================================================

CREATE OR REPLACE FUNCTION public.break_compliance_options()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_manager boolean := public.break_comp_is_manager();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'can_manage', v_manager,
    'settings', public.break_comp_settings_json(v_owner),
    'members', CASE WHEN v_manager THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.nm) ORDER BY t.nm)
      FROM (
        SELECT tm.id, COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email) AS nm
        FROM team_members tm
        WHERE tm.account_owner_id = v_owner
      ) t
    ), '[]'::jsonb) ELSE '[]'::jsonb END
  );
END;
$$;

-- =============================================================
-- RPC: my_break_rules — any account member (drives technician prompts)
-- =============================================================

CREATE OR REPLACE FUNCTION public.my_break_rules()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN public.break_comp_settings_json(v_owner);
END;
$$;

-- =============================================================
-- RPC: save_break_compliance_settings (manager)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_break_compliance_settings(
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
  v_meal integer[];
  v_rest integer[];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.break_comp_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to change break rules' USING ERRCODE = '42501';
  END IF;

  IF p_meal_min IS NULL OR p_meal_min < 5 OR p_meal_min > 180 THEN
    RAISE EXCEPTION 'Meal break length must be between 5 and 180 minutes';
  END IF;
  IF p_rest_min IS NULL OR p_rest_min < 1 OR p_rest_min > 60 THEN
    RAISE EXCEPTION 'Rest break length must be between 1 and 60 minutes';
  END IF;
  IF p_rest_min >= p_meal_min THEN
    RAISE EXCEPTION 'A meal break must be longer than a rest break';
  END IF;
  IF p_meal_deadline IS NULL OR p_meal_deadline < 60 OR p_meal_deadline > 1440 THEN
    RAISE EXCEPTION 'The first meal deadline must be between 60 and 1440 minutes';
  END IF;
  IF p_premium IS NULL OR p_premium < 0 OR p_premium > 480 THEN
    RAISE EXCEPTION 'Premium pay must be between 0 and 480 minutes';
  END IF;
  IF p_lead IS NULL OR p_lead < 5 OR p_lead > 120 THEN
    RAISE EXCEPTION 'Prompt lead time must be between 5 and 120 minutes';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_meal_thresholds, '{}'::integer[])) x WHERE x IS NULL OR x < 1 OR x > 1440)
     OR EXISTS (SELECT 1 FROM unnest(COALESCE(p_rest_thresholds, '{}'::integer[])) x WHERE x IS NULL OR x < 1 OR x > 1440) THEN
    RAISE EXCEPTION 'Shift lengths must be between 1 and 1440 minutes';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::integer[])
    INTO v_meal FROM unnest(COALESCE(p_meal_thresholds, '{}'::integer[])) x;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::integer[])
    INTO v_rest FROM unnest(COALESCE(p_rest_thresholds, '{}'::integer[])) x;

  IF cardinality(v_meal) > 4 THEN
    RAISE EXCEPTION 'Use at most 4 meal break thresholds';
  END IF;
  IF cardinality(v_rest) > 6 THEN
    RAISE EXCEPTION 'Use at most 6 rest break thresholds';
  END IF;

  INSERT INTO break_compliance_settings AS s (
    user_id, enabled, meal_min_minutes, meal_deadline_minutes, meal_thresholds,
    rest_min_minutes, rest_thresholds, premium_minutes, prompts_enabled,
    prompt_lead_minutes, updated_at
  )
  VALUES (
    v_owner, COALESCE(p_enabled, true), p_meal_min, p_meal_deadline, v_meal,
    p_rest_min, v_rest, p_premium, COALESCE(p_prompts, true), p_lead, now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      meal_min_minutes = EXCLUDED.meal_min_minutes,
      meal_deadline_minutes = EXCLUDED.meal_deadline_minutes,
      meal_thresholds = EXCLUDED.meal_thresholds,
      rest_min_minutes = EXCLUDED.rest_min_minutes,
      rest_thresholds = EXCLUDED.rest_thresholds,
      premium_minutes = EXCLUDED.premium_minutes,
      prompts_enabled = EXCLUDED.prompts_enabled,
      prompt_lead_minutes = EXCLUDED.prompt_lead_minutes,
      updated_at = now();
END;
$$;

-- =============================================================
-- RPC: review_break_violation (manager) — p_status 'open' clears the decision
-- =============================================================

CREATE OR REPLACE FUNCTION public.review_break_violation(
  p_shift_id uuid,
  p_code text,
  p_status text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_name text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.break_comp_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to review break violations' USING ERRCODE = '42501';
  END IF;
  IF p_code IS NULL OR p_code NOT IN ('meal_missing', 'meal_late', 'rest_missing') THEN
    RAISE EXCEPTION 'Unknown violation type';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('open', 'waived', 'excused', 'premium_paid') THEN
    RAISE EXCEPTION 'Unknown review status';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM time_shifts ts WHERE ts.id = p_shift_id AND ts.user_id = v_owner) THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_status = 'open' THEN
    DELETE FROM break_violation_reviews r
    WHERE r.shift_id = p_shift_id AND r.code = p_code AND r.user_id = v_owner;
    RETURN;
  END IF;

  v_name := COALESCE(
    (SELECT NULLIF(btrim(tm.member_name), '') FROM team_members tm WHERE tm.user_id = auth.uid() LIMIT 1),
    (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
  );

  INSERT INTO break_violation_reviews AS r (user_id, shift_id, code, status, note, reviewed_by, reviewer_name, reviewed_at)
  VALUES (
    v_owner, p_shift_id, p_code, p_status,
    NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''),
    auth.uid(), v_name, now()
  )
  ON CONFLICT (shift_id, code) DO UPDATE
  SET status = EXCLUDED.status,
      note = EXCLUDED.note,
      reviewed_by = EXCLUDED.reviewed_by,
      reviewer_name = EXCLUDED.reviewer_name,
      reviewed_at = now();
END;
$$;

-- =============================================================
-- RLS — reviews readable by managers of the account; everything else RPC-only
-- =============================================================

ALTER TABLE break_compliance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_violation_reviews ENABLE ROW LEVEL SECURITY;

-- break_compliance_settings intentionally has NO policy: read/write only through RPCs.

DROP POLICY IF EXISTS "Managers view break violation reviews" ON break_violation_reviews;
CREATE POLICY "Managers view break violation reviews"
  ON break_violation_reviews FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.break_comp_is_manager());

-- =============================================================
-- GRANTS — authenticated only; helpers stay internal
-- =============================================================

REVOKE ALL ON FUNCTION public.break_comp_is_manager() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.break_comp_settings_json(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.break_compliance_options() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_break_rules() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_break_compliance_settings(boolean, integer, integer, integer[], integer, integer[], integer, boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_break_violation(uuid, text, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.break_compliance_options() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_break_rules() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_break_compliance_settings(boolean, integer, integer, integer[], integer, integer[], integer, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_break_violation(uuid, text, text, text) TO authenticated;
