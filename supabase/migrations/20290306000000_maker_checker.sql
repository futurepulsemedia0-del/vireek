-- Maker-checker: one shared "requester != approver" rule, enforced in the database.
--
-- Inventory (see docs/security/maker-checker.md):
--   workflow_approvals / compiled_workflow_approvals  -> guarded here (requested_by column + trigger)
--   closeout_steps (ready_for_approval -> submitted)  -> guarded here (approval_requested_by + trigger)
--   commercial_approval_decisions                     -> guarded here (table-level backstop; the RPC already refuses)
--   authz_approval_* / authz_access_grants            -> already refuse self approval inside their RPCs; untouched
--   commercial_approvals                              -> NOT an internal approval (records a customer's PO); out of scope
--
-- Rule: when a person who is recorded as the requester also tries to approve, the approval is refused
-- (SQLSTATE 42501, message "maker_checker_violation: ..."), unless
--   (a) the approval has a KNOWN amount below the tenant's money_threshold_cents (default 0 = every approval), or
--   (b) the tenant has no other active team member AND the approver is the tenant owner AND the tenant kept
--       solo_owner_exception on (default on). That case is allowed and written to audit_log.
-- Approvals with no human requester (requested_by IS NULL: automation, engine ticks, service role) are not
-- affected: the approver is always a person, so the two can never be the same.
-- Rows that were already pending before this migration have requested_by NULL and keep their old behavior.
-- Idempotent: safe to run more than once.

-- 1. Per-tenant settings -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.maker_checker_settings (
  user_id               uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  money_threshold_cents bigint NOT NULL DEFAULT 0
    CHECK (money_threshold_cents >= 0 AND money_threshold_cents <= 100000000000),
  solo_owner_exception  boolean NOT NULL DEFAULT true,
  updated_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.maker_checker_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maker_checker_settings_select ON public.maker_checker_settings;
CREATE POLICY maker_checker_settings_select ON public.maker_checker_settings FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS maker_checker_settings_insert ON public.maker_checker_settings;
CREATE POLICY maker_checker_settings_insert ON public.maker_checker_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.authz_can_admin()));

DROP POLICY IF EXISTS maker_checker_settings_update ON public.maker_checker_settings;
CREATE POLICY maker_checker_settings_update ON public.maker_checker_settings FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.authz_can_admin()))
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.authz_can_admin()));

-- Stamp who changed the control and leave an audit trail (lowering the threshold weakens a control).
CREATE OR REPLACE FUNCTION public.maker_checker_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  PERFORM public.log_audit_event(
    NEW.user_id, 'maker_checker.settings.change', 'maker_checker_settings', NEW.user_id::text,
    jsonb_build_object(
      'old_threshold_cents', CASE WHEN TG_OP = 'UPDATE' THEN OLD.money_threshold_cents END,
      'new_threshold_cents', NEW.money_threshold_cents,
      'old_solo_owner_exception', CASE WHEN TG_OP = 'UPDATE' THEN OLD.solo_owner_exception END,
      'new_solo_owner_exception', NEW.solo_owner_exception));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maker_checker_settings_stamp ON public.maker_checker_settings;
CREATE TRIGGER trg_maker_checker_settings_stamp
  BEFORE INSERT OR UPDATE ON public.maker_checker_settings
  FOR EACH ROW EXECUTE FUNCTION public.maker_checker_settings_stamp();

-- 2. Shared rule ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.maker_checker_has_other_member(p_tenant uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members tm
     WHERE tm.account_owner_id = p_tenant
       AND tm.user_id IS NOT NULL
       AND tm.user_id <> p_user
       AND tm.invite_status IN ('active', 'accepted')
  );
$$;

CREATE OR REPLACE FUNCTION public.maker_checker_assert(
  p_tenant       uuid,
  p_subject_type text,
  p_subject_id   text,
  p_amount_cents bigint,
  p_requester    uuid,
  p_approver     uuid,
  p_risky        boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_threshold bigint := 0;
  v_solo      boolean := true;
BEGIN
  -- No human requester, or two different people: nothing to enforce.
  IF p_requester IS NULL OR p_approver IS NULL OR p_requester IS DISTINCT FROM p_approver THEN
    RETURN;
  END IF;

  SELECT s.money_threshold_cents, s.solo_owner_exception
    INTO v_threshold, v_solo
    FROM public.maker_checker_settings s
   WHERE s.user_id = p_tenant;
  IF NOT FOUND THEN
    v_threshold := 0;
    v_solo := true;
  END IF;

  -- Only a KNOWN amount below the threshold is exempt. Unknown amount (NULL) and risky settings never are.
  IF NOT COALESCE(p_risky, false) AND p_amount_cents IS NOT NULL AND p_amount_cents < v_threshold THEN
    RETURN;
  END IF;

  -- A one-person business cannot have a second approver: allowed, but always on the record.
  IF v_solo AND p_approver = p_tenant AND NOT public.maker_checker_has_other_member(p_tenant, p_approver) THEN
    PERFORM public.log_audit_event(
      p_tenant, 'maker_checker.solo_self_approval', p_subject_type, p_subject_id,
      jsonb_build_object('amount_cents', p_amount_cents, 'risky', COALESCE(p_risky, false)));
    RETURN;
  END IF;

  RAISE EXCEPTION 'maker_checker_violation: the person who requested this cannot approve it'
    USING ERRCODE = '42501', DETAIL = format('subject=%s id=%s', p_subject_type, p_subject_id);
END;
$$;

-- 3. Generic guard for tables shaped like workflow_approvals (status, requested_by, decided_by, user_id) ---
-- TG_ARGV[0] = subject type, [1] = status value that means "approved", [2] = amount column ('' = none)
CREATE OR REPLACE FUNCTION public.maker_checker_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_subject    text := TG_ARGV[0];
  v_approved   text := TG_ARGV[1];
  v_amount_col text := NULLIF(TG_ARGV[2], '');
  n            jsonb := to_jsonb(NEW);
  o            jsonb := to_jsonb(OLD);
  v_amount     bigint;
BEGIN
  IF (n ->> 'requested_by') IS DISTINCT FROM (o ->> 'requested_by') THEN
    RAISE EXCEPTION 'maker_checker_requester_immutable: requested_by cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF (n ->> 'status') = v_approved AND (o ->> 'status') IS DISTINCT FROM v_approved THEN
    IF v_amount_col IS NOT NULL THEN
      v_amount := (n ->> v_amount_col)::bigint;
    END IF;
    PERFORM public.maker_checker_assert(
      (n ->> 'user_id')::uuid, v_subject, n ->> 'id', v_amount,
      (o ->> 'requested_by')::uuid, (n ->> 'decided_by')::uuid, false);
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Close-out: the person who moves a step to ready_for_approval is the requester ------------------------
CREATE OR REPLACE FUNCTION public.maker_checker_closeout_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'ready_for_approval' AND OLD.status IS DISTINCT FROM 'ready_for_approval' THEN
    NEW.approval_requested_by := auth.uid();
  ELSIF NEW.approval_requested_by IS DISTINCT FROM OLD.approval_requested_by THEN
    RAISE EXCEPTION 'maker_checker_requester_immutable: approval_requested_by cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM public.maker_checker_assert(
      NEW.user_id, 'closeout.step_submit', NEW.id::text, NEW.estimated_value_cents::bigint,
      OLD.approval_requested_by, NEW.approved_by, false);
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Commercial approvals: table-level backstop for the decide RPC (which already refuses self approval) ----
CREATE OR REPLACE FUNCTION public.maker_checker_commercial_decision_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rq record;
BEGIN
  IF NEW.decision <> 'approve' THEN
    RETURN NEW;
  END IF;
  SELECT r.user_id, r.requested_by, r.amount_cents
    INTO rq
    FROM public.commercial_approval_requests r
   WHERE r.id = NEW.request_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  PERFORM public.maker_checker_assert(
    rq.user_id, 'commercial.work_order_approval', NEW.request_id::text, rq.amount_cents::bigint,
    rq.requested_by, NEW.decided_by, false);
  RETURN NEW;
END;
$$;

-- 6. Attach (guarded with to_regclass so a diverged database does not abort the migration) --------------------
DO $$
BEGIN
  IF to_regclass('public.workflow_approvals') IS NOT NULL THEN
    ALTER TABLE public.workflow_approvals ADD COLUMN IF NOT EXISTS requested_by uuid;
    ALTER TABLE public.workflow_approvals ALTER COLUMN requested_by SET DEFAULT auth.uid();
    DROP TRIGGER IF EXISTS trg_maker_checker_guard ON public.workflow_approvals;
    CREATE TRIGGER trg_maker_checker_guard
      BEFORE UPDATE ON public.workflow_approvals
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.requested_by IS DISTINCT FROM NEW.requested_by)
      EXECUTE FUNCTION public.maker_checker_guard('workflow.step_approval', 'approved', '');
  END IF;

  IF to_regclass('public.compiled_workflow_approvals') IS NOT NULL THEN
    ALTER TABLE public.compiled_workflow_approvals ADD COLUMN IF NOT EXISTS requested_by uuid;
    ALTER TABLE public.compiled_workflow_approvals ALTER COLUMN requested_by SET DEFAULT auth.uid();
    DROP TRIGGER IF EXISTS trg_maker_checker_guard ON public.compiled_workflow_approvals;
    CREATE TRIGGER trg_maker_checker_guard
      BEFORE UPDATE ON public.compiled_workflow_approvals
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.requested_by IS DISTINCT FROM NEW.requested_by)
      EXECUTE FUNCTION public.maker_checker_guard('workflow.compiled_approval', 'approved', 'price_cents');
  END IF;

  IF to_regclass('public.closeout_steps') IS NOT NULL THEN
    ALTER TABLE public.closeout_steps ADD COLUMN IF NOT EXISTS approval_requested_by uuid;
    DROP TRIGGER IF EXISTS trg_maker_checker_closeout_guard ON public.closeout_steps;
    CREATE TRIGGER trg_maker_checker_closeout_guard
      BEFORE UPDATE ON public.closeout_steps
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.approval_requested_by IS DISTINCT FROM NEW.approval_requested_by)
      EXECUTE FUNCTION public.maker_checker_closeout_guard();
  END IF;

  IF to_regclass('public.commercial_approval_decisions') IS NOT NULL
     AND to_regclass('public.commercial_approval_requests') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_maker_checker_commercial_decision ON public.commercial_approval_decisions;
    CREATE TRIGGER trg_maker_checker_commercial_decision
      BEFORE INSERT ON public.commercial_approval_decisions
      FOR EACH ROW EXECUTE FUNCTION public.maker_checker_commercial_decision_guard();
  END IF;
END $$;

-- 7. Privileges: internal helpers are not callable by clients; triggers run as the table writer's trigger context.
REVOKE ALL ON FUNCTION public.maker_checker_has_other_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maker_checker_assert(uuid, text, text, bigint, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maker_checker_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maker_checker_closeout_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maker_checker_commercial_decision_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maker_checker_settings_stamp() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.maker_checker_settings FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.maker_checker_settings TO authenticated;

-- Rollback (manual, review first): DROP TRIGGER trg_maker_checker_guard ON workflow_approvals / compiled_workflow_approvals;
-- DROP TRIGGER trg_maker_checker_closeout_guard ON closeout_steps;
-- DROP TRIGGER trg_maker_checker_commercial_decision ON commercial_approval_decisions;
-- the requested_by / approval_requested_by columns can stay (nullable, unused when the triggers are gone).
