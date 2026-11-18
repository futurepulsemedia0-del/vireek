/*
# Membership identity: one rule everywhere

## Problem
Membership was resolved two different ways. get_account_owner_id() used team_members.user_id,
but ~75 other helpers and policies matched team_members.member_email to auth.users.email.
Consequences: a pending invite granted access as soon as the invitee signed up with that email
(before accepting); a removed member's row kept matching whoever later registered the same email;
a member who changed their email lost access in email-matched helpers only.

## Rule enforced from now on
A caller is a team member of an account only when ALL hold:
  1. team_members.user_id = auth.uid()            (identity is the user id, never the email)
  2. invite_status IN ('active','accepted')        ('active' is what accept_team_invite writes;
                                                    'accepted' is tolerated as a synonym)
  3. deactivated_at IS NULL                        (new column; owner/admin controlled via RPC)

## What this migration does
- Adds team_members.deactivated_at / deactivated_by / former_user_id.
- INVARIANT (trigger trg_team_members_liveness): a row that is not live never carries user_id. When a member is
  deactivated/removed/reset to pending, user_id moves to former_user_id; reactivation restores it. This single rule fixes
  the ~118 existing user_id-based checks that never looked at invite_status, without rewriting them.
- Adds the single predicate public.team_member_is_live(status, deactivated_at) and
  public.is_live_team_member(owner).
- Redefines get_account_owner_id() and get_my_team_member_id() on that predicate.
- Safe backfill of team_members.user_id for accepted rows that lack it (see conditions below);
  every row touched is logged in team_member_identity_backfill so it can be reverted.
- Keeps member_email in sync when a user changes their auth email (display only, no longer security).
- Trigger: authenticated/anon clients can no longer set or change user_id or deactivated_* directly
  (previously an owner could point a team row at any user id). RPCs and service_role are unaffected.
- RPC team_member_set_active(member, active) with audit_log entry.
- accept_team_invite(): refuses deactivated rows, locks the row, same return shape.
- team_members SELECT policy: email branch narrowed to the caller's OWN pending invite.

The ~75 remaining helpers/policies that still compare member_email are rewritten by the NEXT
migration (20290306000010_membership_identity_rewrite_helpers.sql). Apply both, in order.

## Rollback
- Backfill:  UPDATE team_members SET user_id = NULL WHERE id IN (SELECT team_member_id FROM team_member_identity_backfill);
- Helpers:   re-run 20261212000000_technician_mobile_os.sql's get_account_owner_id()/get_my_team_member_id().
- Liveness cleanup: UPDATE team_members SET user_id = former_user_id, former_user_id = NULL
  WHERE former_user_id IS NOT NULL AND user_id IS NULL AND invite_status IN ('active','accepted') AND deactivated_at IS NULL;
- Columns are additive; leaving them is harmless.
*/

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS former_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_team_members_user_live
  ON public.team_members (user_id)
  WHERE user_id IS NOT NULL AND deactivated_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The one predicate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_member_is_live(p_invite_status text, p_deactivated_at timestamptz)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(p_invite_status IN ('active', 'accepted'), false) AND p_deactivated_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION public.team_member_is_live(text, timestamptz) TO anon, authenticated, service_role;

-- Caller-only (no user parameter, so it cannot be used to probe other people's membership).
CREATE OR REPLACE FUNCTION public.is_live_team_member(p_owner uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.user_id = auth.uid()
      AND tm.user_id IS NOT NULL
      AND (p_owner IS NULL OR tm.account_owner_id = p_owner)
      AND public.team_member_is_live(tm.invite_status, tm.deactivated_at)
  );
$$;
REVOKE ALL ON FUNCTION public.is_live_team_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_live_team_member(uuid) TO authenticated, service_role;

-- Internal resolver. Not callable by clients: get_account_owner_id() (SECURITY DEFINER) is the entry point.
CREATE OR REPLACE FUNCTION public._membership_owner_id(p_user uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT tm.account_owner_id
       FROM team_members tm
      WHERE tm.user_id = p_user
        AND public.team_member_is_live(tm.invite_status, tm.deactivated_at)
      ORDER BY tm.created_at, tm.id
      LIMIT 1),
    (SELECT p.id FROM profiles p WHERE p.id = p_user)
  );
$$;
REVOKE ALL ON FUNCTION public._membership_owner_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._membership_owner_id(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_account_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._membership_owner_id(auth.uid());
$$;
GRANT EXECUTE ON FUNCTION public.get_account_owner_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_team_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.id
    FROM team_members tm
   WHERE tm.user_id = auth.uid()
     AND public.team_member_is_live(tm.invite_status, tm.deactivated_at)
   ORDER BY tm.created_at, tm.id
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_team_member_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Safe backfill of user_id (reversible)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_member_identity_backfill (
  team_member_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  backfilled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.team_member_identity_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_member_identity_backfill FROM anon, authenticated;

DO $backfill$
DECLARE
  v_linked integer;
BEGIN
  /*
    Only rows that are ALREADY accepted (live) but have no user_id. Pending rows are never linked here:
    accepting an invite is the only way a pending row gets a user.
    A row is linked only when the match is unambiguous:
      - the email belongs to exactly one confirmed, non-deleted auth user,
      - that user is not the owner of the row's own account,
      - that user maps to exactly one such row, and is not already linked to another live row.
  */
  WITH cand AS (
    SELECT tm.id AS tm_id, u.id AS uid
      FROM public.team_members tm
      JOIN auth.users u ON lower(btrim(u.email)) = lower(btrim(tm.member_email))
     WHERE tm.user_id IS NULL
       AND public.team_member_is_live(tm.invite_status, tm.deactivated_at)
       AND u.email_confirmed_at IS NOT NULL
       AND u.deleted_at IS NULL
       AND u.id <> tm.account_owner_id
  ), one_user_per_row AS (
    SELECT tm_id, (array_agg(uid))[1] AS uid FROM cand GROUP BY tm_id HAVING count(*) = 1
  ), one_row_per_user AS (
    SELECT uid FROM one_user_per_row GROUP BY uid HAVING count(*) = 1
  ), final AS (
    SELECT r.tm_id, r.uid
      FROM one_user_per_row r
      JOIN one_row_per_user o ON o.uid = r.uid
     WHERE NOT EXISTS (
       SELECT 1 FROM public.team_members x
        WHERE x.user_id = r.uid AND x.id <> r.tm_id
          AND public.team_member_is_live(x.invite_status, x.deactivated_at)
     )
  ), logged AS (
    INSERT INTO public.team_member_identity_backfill (team_member_id, user_id)
    SELECT tm_id, uid FROM final
    ON CONFLICT (team_member_id) DO NOTHING
    RETURNING team_member_id, user_id
  )
  UPDATE public.team_members tm
     SET user_id = logged.user_id
    FROM logged
   WHERE tm.id = logged.team_member_id
     AND tm.user_id IS NULL;
  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RAISE NOTICE 'membership identity backfill: % team_members rows linked to a user_id', v_linked;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- 4. Keep member_email in sync when a user changes their auth email
--    (display / invite bookkeeping only; authorization no longer reads it)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_team_member_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    BEGIN
      UPDATE public.team_members
         SET member_email = NEW.email
       WHERE user_id = NEW.id
         AND member_email IS DISTINCT FROM NEW.email;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- never block an auth email change over bookkeeping; identity is user_id
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_team_member_email ON auth.users;
CREATE TRIGGER trg_sync_team_member_email
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_email();

-- ---------------------------------------------------------------------------
-- 5. Direct client writes can no longer assign identity or deactivation
--    (SECURITY DEFINER RPCs run as the function owner, so they are not affected)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_members_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.user_id IS NOT NULL OR NEW.former_user_id IS NOT NULL OR NEW.deactivated_at IS NOT NULL OR NEW.deactivated_by IS NOT NULL THEN
        RAISE EXCEPTION 'user_id and deactivation are set by the server only' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.former_user_id IS DISTINCT FROM OLD.former_user_id
         OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
         OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by THEN
        RAISE EXCEPTION 'user_id and deactivation can only be changed through the server functions' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_members_identity_guard ON public.team_members;
CREATE TRIGGER trg_team_members_identity_guard
  BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_identity_guard();

-- ---------------------------------------------------------------------------
-- 5b. Liveness invariant: only a live row may carry user_id
--     Name sorts AFTER trg_team_members_identity_guard on purpose (BEFORE triggers fire by name), so the guard only
--     ever sees the client's own change, never this internal move.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_members_liveness_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.team_member_is_live(NEW.invite_status, NEW.deactivated_at) THEN
    -- Reactivation: restore the identity, unless that user has meanwhile become live somewhere else.
    IF TG_OP = 'UPDATE'
       AND NEW.user_id IS NULL
       AND NEW.former_user_id IS NOT NULL
       AND NOT public.team_member_is_live(OLD.invite_status, OLD.deactivated_at)
       AND NOT EXISTS (
         SELECT 1 FROM public.team_members x
          WHERE x.user_id = NEW.former_user_id AND x.id <> NEW.id
            AND public.team_member_is_live(x.invite_status, x.deactivated_at)
       )
    THEN
      NEW.user_id := NEW.former_user_id;
      NEW.former_user_id := NULL;
    END IF;
  ELSIF NEW.user_id IS NOT NULL THEN
    NEW.former_user_id := NEW.user_id;
    NEW.user_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_members_liveness ON public.team_members;
CREATE TRIGGER trg_team_members_liveness
  BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_liveness_sync();

-- One-time cleanup: rows that are already not live but still carry a user_id (reversible via former_user_id).
UPDATE public.team_members
   SET former_user_id = user_id,
       user_id = NULL
 WHERE user_id IS NOT NULL
   AND NOT public.team_member_is_live(invite_status, deactivated_at);

-- ---------------------------------------------------------------------------
-- 6. Deactivate / reactivate (audited)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_member_set_active(p_member_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_row public.team_members%ROWTYPE;
  v_allowed boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_row FROM public.team_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;

  v_allowed := v_row.account_owner_id = v_caller
    OR EXISTS (
      SELECT 1 FROM public.team_members me
       WHERE me.user_id = v_caller
         AND me.account_owner_id = v_row.account_owner_id
         AND public.team_member_is_live(me.invite_status, me.deactivated_at)
         AND (me.role = 'admin' OR COALESCE((me.permissions ->> 'can_manage_team')::boolean, false))
    );
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden');
  END IF;

  IF v_row.user_id IS NOT NULL AND v_row.user_id = v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot_change_self');
  END IF;

  IF p_active AND v_row.deactivated_at IS NULL THEN
    RETURN jsonb_build_object('success', true, 'changed', false);
  END IF;
  IF NOT p_active AND v_row.deactivated_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'changed', false);
  END IF;

  UPDATE public.team_members
     SET deactivated_at = CASE WHEN p_active THEN NULL ELSE now() END,
         deactivated_by = CASE WHEN p_active THEN NULL ELSE v_caller END
   WHERE id = p_member_id;

  INSERT INTO public.audit_log (user_id, actor_id, action, target_table, target_id)
  VALUES (v_row.account_owner_id, v_caller,
          CASE WHEN p_active THEN 'team_member_reactivated' ELSE 'team_member_deactivated' END,
          'team_members', p_member_id);

  RETURN jsonb_build_object('success', true, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.team_member_set_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_member_set_active(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. accept_team_invite: refuse deactivated rows, lock the row (no double-accept race)
--    Return shape unchanged.
-- ---------------------------------------------------------------------------
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
  v_deactivated_at timestamptz;
  v_caller_email text;
  v_company_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT id, member_email, role, invite_status, invite_token_expires_at, account_owner_id, deactivated_at
    INTO v_team_member_id, v_member_email, v_role, v_invite_status, v_expires_at, v_account_owner_id, v_deactivated_at
    FROM team_members
   WHERE invite_token = p_token
   FOR UPDATE;

  IF v_team_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;

  IF v_deactivated_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'deactivated');
  END IF;

  IF v_invite_status IN ('active', 'accepted') THEN
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

-- ---------------------------------------------------------------------------
-- 8. team_members SELECT: owner, the member themself (by user_id), or the caller's own PENDING invite
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "select_own_team_members" ON public.team_members;
CREATE POLICY "select_own_team_members"
ON public.team_members FOR SELECT
TO authenticated
USING (
  account_owner_id = auth.uid()
  OR user_id = auth.uid()
  OR (
    user_id IS NULL
    AND invite_status = 'pending'
    AND lower(member_email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
  )
);
