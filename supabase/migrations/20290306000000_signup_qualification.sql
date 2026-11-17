/*
  # Signup qualification (post-verification, pre-dashboard)

  3 optional answers collected once, right after email-OTP / Google sign-in.
  Writes go through save_signup_qualification() only. Answers are mirrored
  into business_profile ONLY where those columns are still empty, so the
  classic onboarding never re-asks what the user already told us.
*/

CREATE TABLE IF NOT EXISTS public.signup_qualification (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('completed', 'skipped')),
  trade         text CHECK (trade IN ('hvac','plumbing','electrical','roofing','general_home_services','other')),
  team_size     text CHECK (team_size IN ('solo','2-5','6-15','16+')),
  call_handling text CHECK (call_handling IN ('in_house','answering_service','voicemail','another_ai_tool','none')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.signup_qualification ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.signup_qualification FROM anon, authenticated;
GRANT SELECT ON public.signup_qualification TO authenticated;

DROP POLICY IF EXISTS "signup_qualification_select_own" ON public.signup_qualification;
CREATE POLICY "signup_qualification_select_own"
ON public.signup_qualification FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.save_signup_qualification(
  p_trade         text,
  p_team_size     text,
  p_call_handling text,
  p_skipped       boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.signup_qualification (user_id, status, trade, team_size, call_handling)
  VALUES (
    v_uid,
    CASE WHEN p_skipped THEN 'skipped' ELSE 'completed' END,
    p_trade, p_team_size, p_call_handling
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status        = EXCLUDED.status,
    trade         = COALESCE(EXCLUDED.trade, public.signup_qualification.trade),
    team_size     = COALESCE(EXCLUDED.team_size, public.signup_qualification.team_size),
    call_handling = COALESCE(EXCLUDED.call_handling, public.signup_qualification.call_handling),
    updated_at    = now();

  -- Mirror into business_profile only for the account owner, and only into empty columns.
  IF (p_trade IS NOT NULL OR p_team_size IS NOT NULL OR p_call_handling IS NOT NULL)
     AND public.get_account_owner_id() = v_uid THEN
    INSERT INTO public.business_profile (user_id, primary_industry, team_size, current_call_handling)
    VALUES (v_uid, p_trade, p_team_size, p_call_handling)
    ON CONFLICT (user_id) DO UPDATE SET
      primary_industry      = COALESCE(public.business_profile.primary_industry, EXCLUDED.primary_industry),
      team_size             = COALESCE(public.business_profile.team_size, EXCLUDED.team_size),
      current_call_handling = COALESCE(public.business_profile.current_call_handling, EXCLUDED.current_call_handling),
      updated_at            = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_signup_qualification(text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_signup_qualification(text, text, text, boolean) TO authenticated;
