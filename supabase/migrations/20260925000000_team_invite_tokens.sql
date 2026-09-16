/*
  # Team invite acceptance tokens

  Adds a secure, single-use token to team_members so an invited teammate can
  land on a dedicated /invite/:token page, prove they own that email address,
  and be linked into the account owner's workspace — instead of the previous
  flow, which just sent people to /signup with no real verification.

  ## Changes to team_members
  - invite_token (uuid, unique, nullable) — issued when an invite is sent,
    cleared once accepted so the link can't be replayed.
  - invite_token_expires_at (timestamptz, nullable) — 14 days from the most
    recent send.
  - user_id (uuid, references auth.users) — the auth account that accepted.

  ## New functions
  - get_invite_for_token(uuid): public preview of an invite, no auth needed.
  - accept_team_invite(uuid): authenticated only. Validates the token,
    confirms the caller's auth email matches the invited email, marks the
    invite active, links user_id, and reclassifies the caller's
    auto-created profile (role + onboarding_completed) so they land in the
    owner's workspace instead of an empty onboarding flow. Refuses to touch
    an account that is already a fully onboarded owner of its own workspace.
*/

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS invite_token uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS invite_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_invite_token ON team_members(invite_token);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);

-- Already-accepted rows shouldn't keep a live token around.
UPDATE team_members SET invite_token = NULL, invite_token_expires_at = NULL WHERE invite_status = 'active';

CREATE OR REPLACE FUNCTION public.get_invite_for_token(p_token uuid)
RETURNS TABLE (
  member_email text,
  member_name text,
  role text,
  invite_status text,
  is_expired boolean,
  company_name text,
  inviter_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tm.member_email,
    tm.member_name,
    tm.role,
    tm.invite_status,
    COALESCE(tm.invite_token_expires_at < now(), false) AS is_expired,
    p.company_name,
    COALESCE(p.full_name, p.email) AS inviter_name
  FROM team_members tm
  JOIN profiles p ON p.id = tm.account_owner_id
  WHERE tm.invite_token = p_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_invite_for_token(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.accept_team_invite(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team_member_id uuid;
  v_member_email text;
  v_role text;
  v_invite_status text;
  v_expires_at timestamptz;
  v_account_owner_id uuid;
  v_caller_email text;
  v_company_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT id, member_email, role, invite_status, invite_token_expires_at, account_owner_id
  INTO v_team_member_id, v_member_email, v_role, v_invite_status, v_expires_at, v_account_owner_id
  FROM team_members
  WHERE invite_token = p_token;

  IF v_team_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;

  IF v_invite_status = 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_accepted');
  END IF;

  IF v_expires_at IS NOT NULL AND v_expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'expired');
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();

  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_member_email) THEN
    RETURN jsonb_build_object('success', false, 'error', 'email_mismatch');
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner' AND onboarding_completed = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'existing_owner');
  END IF;

  UPDATE team_members
  SET invite_status = 'active',
      user_id = auth.uid(),
      invite_token = NULL,
      invite_token_expires_at = NULL
  WHERE id = v_team_member_id;

  SELECT company_name INTO v_company_name FROM profiles WHERE id = v_account_owner_id;

  UPDATE profiles
  SET role = CASE WHEN v_role = 'admin' THEN 'admin' ELSE 'member' END,
      onboarding_completed = true,
      company_name = COALESCE(company_name, v_company_name)
  WHERE id = auth.uid();

  RETURN jsonb_build_object('success', true, 'account_owner_id', v_account_owner_id, 'company_name', v_company_name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_team_invite(uuid) TO authenticated;
