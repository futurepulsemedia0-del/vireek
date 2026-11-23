/*
  # Learn: role-based course completion record

  - learn_module_completions : one row per learner + course + module, written only when a module quiz is passed.
  - record_learn_completion(course, module, score_pct) : idempotent upsert (keeps the best score, counts attempts).
  - learn_team_completion_summary() : OWNER-ONLY per-person roll-up for the team completion record.

  Course content lives in src/lib/learnCourses.ts (static). The score is reported by the client, so this record is
  product-training bookkeeping, NOT proof of compliance training. The pass mark (80) is mirrored from PASS_PCT.

  Tenant model: user_id = the learner (auth.uid()); account_owner_id = public.get_account_owner_id().
  Learners read only their own rows; the account owner reads the whole account's rows. No DELETE policy.

  Rollback: DROP FUNCTION public.learn_team_completion_summary();
            DROP FUNCTION public.record_learn_completion(text, text, integer);
            DROP TABLE public.learn_module_completions;
*/

CREATE TABLE IF NOT EXISTS public.learn_module_completions (
  user_id uuid NOT NULL DEFAULT auth.uid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  course_slug text NOT NULL CHECK (course_slug IN ('owner', 'dispatcher', 'technician')),
  module_id text NOT NULL CHECK (module_id ~ '^[a-z0-9-]{1,64}$'),
  score_pct integer NOT NULL CHECK (score_pct BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  completed_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_slug, module_id)
);

CREATE INDEX IF NOT EXISTS idx_learn_completions_owner ON public.learn_module_completions (account_owner_id, course_slug);

ALTER TABLE public.learn_module_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_learn_completions" ON public.learn_module_completions;
CREATE POLICY "select_learn_completions" ON public.learn_module_completions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR account_owner_id = auth.uid());

DROP POLICY IF EXISTS "insert_own_learn_completions" ON public.learn_module_completions;
CREATE POLICY "insert_own_learn_completions" ON public.learn_module_completions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "update_own_learn_completions" ON public.learn_module_completions;
CREATE POLICY "update_own_learn_completions" ON public.learn_module_completions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND account_owner_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.record_learn_completion(p_course text, p_module text, p_score_pct integer)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_score_pct IS NULL OR p_score_pct < 80 OR p_score_pct > 100 THEN
    RAISE EXCEPTION 'Score is below the pass mark' USING ERRCODE = '22023';
  END IF;

  INSERT INTO learn_module_completions (course_slug, module_id, score_pct)
  VALUES (p_course, p_module, p_score_pct)
  ON CONFLICT (user_id, course_slug, module_id) DO UPDATE
    SET score_pct = greatest(learn_module_completions.score_pct, EXCLUDED.score_pct),
        attempts = learn_module_completions.attempts + 1,
        last_attempt_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_learn_completion(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_learn_completion(text, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.learn_team_completion_summary()
RETURNS TABLE (out_user_id uuid, out_display_name text, out_course_slug text, out_modules_completed integer, out_last_completed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can view the team completion record' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.user_id,
         coalesce(nullif(btrim(tm.member_name), ''), nullif(btrim(p.full_name), ''), tm.member_email, 'Unknown')::text,
         c.course_slug,
         count(*)::integer,
         max(c.completed_at)
    FROM learn_module_completions c
    LEFT JOIN profiles p ON p.id = c.user_id
    LEFT JOIN auth.users u ON u.id = c.user_id
    LEFT JOIN team_members tm ON tm.account_owner_id = v_owner AND lower(tm.member_email) = lower(u.email)
   WHERE c.account_owner_id = v_owner
   GROUP BY c.user_id, tm.member_name, p.full_name, tm.member_email, c.course_slug
   ORDER BY 2, c.course_slug;
END;
$$;

REVOKE ALL ON FUNCTION public.learn_team_completion_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.learn_team_completion_summary() TO authenticated;
