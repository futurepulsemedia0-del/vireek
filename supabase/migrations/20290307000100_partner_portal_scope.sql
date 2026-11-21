/*
  # Partner portal permission scope: partner users see ONLY the accounts they referred

  Extends 20261203000000_partner_portal.sql. It does not replace it and changes none of its policies or functions.

  Model
    - A partner organisation = one `partners` row. Its OWNER is partners.user_id (unchanged).
    - NEW `partner_members`: extra people from the same partner company. Scope is fixed to 'referred_accounts'
      (read-only). Optional flag can_view_commissions (default false) controls whether they see money figures.
    - Partner users never become members of a customer account (no team_members row), so every existing tenant RLS
      policy (user_id = get_account_owner_id()) keeps returning nothing for them. This migration adds NO policy on any
      tenant table.
    - Access to a referred account is only through SECURITY DEFINER RPCs that return a fixed, minimal column set
      (business name, plan, account status, referral and commission status). No email, phone, name, jobs, calls,
      customers, invoices or notes. RLS is row-level, so a column-limited view needs functions, not policies.
    - A partner must be `approved`. Suspended/rejected/pending partners lose access immediately.
    - Every single-account view is written to the append-only partner_access_log (visible to staff and to the partner owner).
    - Self-dealing guard: a member (or the owner) who signs up through their own partner code is not credited.

  Not changed (deliberately): partners / partner_referrals / partner_link_clicks policies stay owner-or-staff.
  Members therefore cannot read those tables directly; they use the RPCs below.

  PROPOSED DEFAULT, UNVALIDATED: at most 10 members per partner (partner_max_members()).
  [COUNSEL] Showing a referred customer's business name and plan to the partner that referred them is a disclosure of
  customer data to a third party: confirm the legal basis and the notice to referred customers before enabling the portal UI.

  Idempotent: safe to run twice.

  -- rollback: DROP TRIGGER trg_partner_referrals_no_self_dealing ON public.partner_referrals;
  --   DROP FUNCTION public.partner_referrals_no_self_dealing(), public.partner_list_members(), public.partner_update_member(uuid, boolean),
  --     public.partner_remove_member(uuid), public.partner_add_member(text, boolean), public.partner_get_referred_account(uuid),
  --     public.partner_list_referred_accounts(integer, integer), public.partner_scope_context(),
  --     public.partner__referred_accounts(uuid, boolean, uuid, integer, integer), public.partner_scope_for(uuid),
  --     public.partner_members_guard(), public.partner_access_log_append_only(), public.partner_max_members();
  --   DROP TABLE public.partner_access_log, public.partner_members;   -- the access log is an audit record: export it first
*/

-- 0) limits ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_max_members()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 10 $$;

-- 1) partner_members --------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'referred_accounts' CHECK (scope = 'referred_accounts'),
  can_view_commissions boolean NOT NULL DEFAULT false,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_members_one_partner_per_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_members_partner ON public.partner_members (partner_id);

ALTER TABLE public.partner_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.partner_members TO authenticated;

DROP POLICY IF EXISTS "select_own_or_owner_or_staff_partner_members" ON public.partner_members;
CREATE POLICY "select_own_or_owner_or_staff_partner_members" ON public.partner_members
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR partner_id IN (SELECT id FROM public.partners WHERE user_id = auth.uid())
    OR public.is_vireek_staff(auth.uid())
  );
-- No INSERT/UPDATE/DELETE policy: writes only through the owner-checked RPCs below.

-- Invariants enforced for every writer (RPC, service role, plain SQL).
CREATE OR REPLACE FUNCTION public.partner_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.partners WHERE user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'A partner owner cannot also be a member.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_referrals WHERE partner_id = NEW.partner_id AND referred_user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'A referred account cannot be a member of the partner that referred it.';
  END IF;
  IF public.is_vireek_staff(NEW.user_id) THEN
    RAISE EXCEPTION 'A Vireek staff account cannot be a partner member.';
  END IF;
  IF (SELECT count(*) FROM public.partner_members WHERE partner_id = NEW.partner_id) >= public.partner_max_members() THEN
    RAISE EXCEPTION 'Member limit reached (%).', public.partner_max_members();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_members_guard ON public.partner_members;
CREATE TRIGGER trg_partner_members_guard
  BEFORE INSERT ON public.partner_members
  FOR EACH ROW EXECUTE FUNCTION public.partner_members_guard();

-- 2) partner_access_log (append-only) ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  account_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('view_account')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_access_log_partner ON public.partner_access_log (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_access_log_account ON public.partner_access_log (account_id, created_at DESC);

ALTER TABLE public.partner_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.partner_access_log TO authenticated;

DROP POLICY IF EXISTS "owner_or_staff_select_partner_access_log" ON public.partner_access_log;
CREATE POLICY "owner_or_staff_select_partner_access_log" ON public.partner_access_log
  FOR SELECT TO authenticated
  USING (
    partner_id IN (SELECT id FROM public.partners WHERE user_id = auth.uid())
    OR public.is_vireek_staff(auth.uid())
  );

CREATE OR REPLACE FUNCTION public.partner_access_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_access_log is append-only.';
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_access_log_append_only ON public.partner_access_log;
CREATE TRIGGER trg_partner_access_log_append_only
  BEFORE UPDATE OR DELETE ON public.partner_access_log
  FOR EACH ROW EXECUTE FUNCTION public.partner_access_log_append_only();

-- 3) scope resolution (internal; never granted to client roles) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_scope_for(p_user uuid)
RETURNS TABLE (partner_id uuid, is_owner boolean, can_view_commissions boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.partner_id, s.is_owner, s.can_view_commissions
  FROM (
    SELECT p.id AS partner_id, true AS is_owner, true AS can_view_commissions
      FROM public.partners p WHERE p.user_id = p_user AND p.status = 'approved'
    UNION ALL
    SELECT m.partner_id, false, m.can_view_commissions
      FROM public.partner_members m JOIN public.partners p ON p.id = m.partner_id
     WHERE m.user_id = p_user AND p.status = 'approved'
  ) s
  ORDER BY s.is_owner DESC
  LIMIT 1;
$$;

-- The one query that defines what a partner may see about a referred account.
CREATE OR REPLACE FUNCTION public.partner__referred_accounts(
  p_partner uuid, p_can_view_commissions boolean, p_account uuid, p_limit integer, p_offset integer
)
RETURNS TABLE (
  account_id uuid, company_name text, plan text, account_status text, referral_status text,
  referred_at timestamptz, converted_at timestamptz, mrr_cents integer, commission_cents integer, commission_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.referred_user_id, pr.company_name, pr.plan, pr.status, r.status, r.created_at, r.converted_at,
         CASE WHEN p_can_view_commissions THEN r.mrr_cents END,
         CASE WHEN p_can_view_commissions THEN r.commission_cents END,
         CASE WHEN p_can_view_commissions THEN r.commission_status END
    FROM public.partner_referrals r
    JOIN public.profiles pr ON pr.id = r.referred_user_id
   WHERE r.partner_id = p_partner
     AND r.referred_user_id IS NOT NULL
     AND r.status <> 'rejected'
     AND (p_account IS NULL OR r.referred_user_id = p_account)
   ORDER BY r.created_at DESC, r.id
   LIMIT greatest(1, least(coalesce(p_limit, 50), 100))
   OFFSET greatest(0, coalesce(p_offset, 0));
$$;

-- 4) client RPCs -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_scope_context()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_scope record;
  v_partner public.partners;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_scope FROM public.partner_scope_for(v_uid);
  IF NOT FOUND THEN RETURN jsonb_build_object('has_scope', false); END IF;
  SELECT * INTO v_partner FROM public.partners WHERE id = v_scope.partner_id;
  RETURN jsonb_build_object(
    'has_scope', true, 'scope', 'referred_accounts', 'partner_id', v_partner.id, 'company_name', v_partner.company_name,
    'tier', v_partner.tier, 'is_owner', v_scope.is_owner, 'can_view_commissions', v_scope.can_view_commissions
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_list_referred_accounts(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  account_id uuid, company_name text, plan text, account_status text, referral_status text,
  referred_at timestamptz, converted_at timestamptz, mrr_cents integer, commission_cents integer, commission_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_scope record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_scope FROM public.partner_scope_for(v_uid);
  IF NOT FOUND THEN RAISE EXCEPTION 'No partner access.'; END IF;
  RETURN QUERY SELECT * FROM public.partner__referred_accounts(v_scope.partner_id, v_scope.can_view_commissions, NULL, p_limit, p_offset);
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_get_referred_account(p_account uuid)
RETURNS TABLE (
  account_id uuid, company_name text, plan text, account_status text, referral_status text,
  referred_at timestamptz, converted_at timestamptz, mrr_cents integer, commission_cents integer, commission_status text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_scope record;
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_scope FROM public.partner_scope_for(v_uid);
  IF NOT FOUND THEN RAISE EXCEPTION 'No partner access.'; END IF;
  IF p_account IS NULL THEN RAISE EXCEPTION 'Account not found.'; END IF;

  SELECT EXISTS (SELECT 1 FROM public.partner__referred_accounts(v_scope.partner_id, false, p_account, 1, 0)) INTO v_found;
  -- Same message for "does not exist" and "not yours": no way to probe other partners' accounts.
  IF NOT v_found THEN RAISE EXCEPTION 'Account not found.'; END IF;

  INSERT INTO public.partner_access_log (partner_id, actor_id, account_id, action)
  VALUES (v_scope.partner_id, v_uid, p_account, 'view_account');
  RETURN QUERY SELECT * FROM public.partner__referred_accounts(v_scope.partner_id, v_scope.can_view_commissions, p_account, 1, 0);
END;
$$;

-- 5) member management (owner only) ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_add_member(p_email text, p_can_view_commissions boolean DEFAULT false)
RETURNS public.partner_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_partner public.partners;
  v_target uuid;
  v_row public.partner_members;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_partner FROM public.partners WHERE user_id = v_uid AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only an approved partner owner can manage members.'; END IF;

  SELECT id INTO v_target FROM auth.users WHERE lower(email) = lower(btrim(coalesce(p_email, '')));
  IF v_target IS NULL
     OR EXISTS (SELECT 1 FROM public.partners WHERE user_id = v_target)
     OR EXISTS (SELECT 1 FROM public.partner_members WHERE user_id = v_target)
     OR EXISTS (SELECT 1 FROM public.partner_referrals WHERE partner_id = v_partner.id AND referred_user_id = v_target)
     OR public.is_vireek_staff(v_target)
  THEN
    -- One generic message: does not reveal whether the address has a Vireek account.
    RAISE EXCEPTION 'Could not add that member.';
  END IF;

  INSERT INTO public.partner_members (partner_id, user_id, can_view_commissions, added_by)
  VALUES (v_partner.id, v_target, coalesce(p_can_view_commissions, false), v_uid)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_update_member(p_user uuid, p_can_view_commissions boolean)
RETURNS public.partner_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_partner public.partners;
  v_row public.partner_members;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_partner FROM public.partners WHERE user_id = v_uid AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only an approved partner owner can manage members.'; END IF;
  UPDATE public.partner_members SET can_view_commissions = coalesce(p_can_view_commissions, false)
   WHERE partner_id = v_partner.id AND user_id = p_user
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found.'; END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_remove_member(p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_partner public.partners;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_partner FROM public.partners WHERE user_id = v_uid AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only an approved partner owner can manage members.'; END IF;
  DELETE FROM public.partner_members WHERE partner_id = v_partner.id AND user_id = p_user;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_list_members()
RETURNS TABLE (user_id uuid, email text, can_view_commissions boolean, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_partner public.partners;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required.'; END IF;
  SELECT * INTO v_partner FROM public.partners WHERE user_id = v_uid AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only an approved partner owner can manage members.'; END IF;
  RETURN QUERY
    SELECT m.user_id, u.email::text, m.can_view_commissions, m.created_at
      FROM public.partner_members m JOIN auth.users u ON u.id = m.user_id
     WHERE m.partner_id = v_partner.id
     ORDER BY m.created_at, m.id;
END;
$$;

-- 6) self-dealing guard on attribution (no change to attribute_partner_referral itself) ---------------------------
-- A member of partner X who signs up through X's own code must not create a commissionable referral.
-- Returning NULL skips the row silently, exactly like the existing ON CONFLICT DO NOTHING path, so signup never breaks.
CREATE OR REPLACE FUNCTION public.partner_referrals_no_self_dealing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.referred_user_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.partner_members WHERE partner_id = NEW.partner_id AND user_id = NEW.referred_user_id)
    OR EXISTS (SELECT 1 FROM public.partners WHERE id = NEW.partner_id AND user_id = NEW.referred_user_id)
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_referrals_no_self_dealing ON public.partner_referrals;
CREATE TRIGGER trg_partner_referrals_no_self_dealing
  BEFORE INSERT ON public.partner_referrals
  FOR EACH ROW EXECUTE FUNCTION public.partner_referrals_no_self_dealing();

-- 7) privileges (Supabase grants EXECUTE to anon/authenticated by default, so revoke explicitly) -------------------
REVOKE ALL ON FUNCTION public.partner_max_members() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_members_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_access_log_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_referrals_no_self_dealing() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_scope_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner__referred_accounts(uuid, boolean, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_scope_context() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_list_referred_accounts(integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_get_referred_account(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_add_member(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_update_member(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_remove_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_list_members() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.partner_scope_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_list_referred_accounts(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_get_referred_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_add_member(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_update_member(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_remove_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_list_members() TO authenticated;
