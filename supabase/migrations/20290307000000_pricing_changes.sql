/*
  # Pricing change control: pricing_changes audit table (+ approvers, staff RPCs)

  Policy: docs/pricing/change-control.md.   CI half: scripts/pricing/pricing-change-check.mjs
  (a pull request that changes src/lib/pricing.ts needs a matching entry in docs/pricing/pricing-changes.json).

  ## Tables (RLS on, NO policies, every privilege revoked from anon/authenticated)
  pricing_changes           append-only audit record of every pricing decision: requester, approver, effective date,
                            grandfathering rule, notice days, counsel-review flag, and (after deploy) git commit + fingerprints
  pricing_change_approvers  who may approve. EMPTY on purpose: nobody can approve until the owner adds a person
                            (see the SQL at the bottom of this file). Managed by SQL only, never by the app.

  ## Rules enforced by the database (not by the UI)
  - Two-person rule: approver <> requester (CHECK + RPC).
  - Only people in pricing_change_approvers can approve/reject; only staff can propose.
  - A change that requires notice cannot be approved until counsel_review = 'completed' [COUNSEL], and its
    effective_date must be at least notice_days after the approval date.
  - Rows are never deleted or truncated; descriptive fields never change after creation; status only moves
    proposed -> approved|rejected|withdrawn and approved -> effective|withdrawn. Terminal states are frozen.
  - To fix a proposal: withdraw it and propose a new one (the history stays).

  The database stores what staff recorded. It does not know what the law requires: notice_days and counsel_review are
  inputs from people. Nothing here is a legal claim [COUNSEL].

  Reuses: is_vireek_staff(uuid), _feedback_assert_staff(text) (staff check + one audit row per view per minute).

  ROLLBACK: see the comment block at the end of this file.
*/

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pricing_changes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_ref          text NOT NULL UNIQUE CHECK (change_ref ~ '^PC-[0-9]{4}-[0-9]{4}$'),
  kind                text NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'baseline')),
  title               text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  summary             text NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 4000),
  affected_plans      text[] NOT NULL DEFAULT '{}'
                        CHECK (affected_plans <@ ARRAY['free', 'starter', 'professional', 'business', 'enterprise', 'all']::text[]),
  grandfathering      text NOT NULL CHECK (grandfathering IN ('not_applicable', 'grandfathered', 'migrate_at_renewal', 'immediate')),
  notice_required     boolean NOT NULL DEFAULT false,
  notice_days         integer CHECK (notice_days IS NULL OR notice_days BETWEEN 0 AND 365),
  counsel_review      text NOT NULL DEFAULT 'not_requested' CHECK (counsel_review IN ('not_requested', 'pending', 'completed')),
  effective_date      date NOT NULL,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'effective', 'withdrawn')),
  -- No FK to auth.users on purpose: the audit row must outlive the account. Emails are snapshots.
  requested_by        uuid NOT NULL,
  requested_by_email  text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  approved_by         uuid,
  approved_by_email   text,
  approved_at         timestamptz,
  decision_note       text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  git_commit          text CHECK (git_commit IS NULL OR git_commit ~ '^[0-9a-f]{7,40}$'),
  repo_fingerprints   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(repo_fingerprints) = 'object'),
  effective_marked_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_changes_notice_pair CHECK (notice_required = (notice_days IS NOT NULL)),
  CONSTRAINT pricing_changes_approved_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT pricing_changes_two_person CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT pricing_changes_approved_needs_approver CHECK (status NOT IN ('approved', 'effective') OR approved_by IS NOT NULL),
  CONSTRAINT pricing_changes_counsel_before_approval CHECK (
    NOT notice_required OR status NOT IN ('approved', 'effective') OR counsel_review = 'completed'
  ),
  CONSTRAINT pricing_changes_notice_window CHECK (
    approved_at IS NULL OR NOT notice_required
    OR effective_date >= ((approved_at AT TIME ZONE 'UTC')::date + notice_days)
  ),
  CONSTRAINT pricing_changes_effective_needs_commit CHECK (
    status <> 'effective' OR (git_commit IS NOT NULL AND effective_marked_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_pricing_changes_status ON public.pricing_changes (status, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_pricing_changes_created ON public.pricing_changes (created_at DESC);

CREATE TABLE IF NOT EXISTS public.pricing_change_approvers (
  user_id  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pricing_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_change_approvers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pricing_changes, public.pricing_change_approvers FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Append-only guard (also blocks TRUNCATE for the table owner)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pricing_changes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'pricing_changes_append_only' USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.change_ref IS DISTINCT FROM OLD.change_ref
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.affected_plans IS DISTINCT FROM OLD.affected_plans
     OR NEW.grandfathering IS DISTINCT FROM OLD.grandfathering
     OR NEW.notice_required IS DISTINCT FROM OLD.notice_required
     OR NEW.notice_days IS DISTINCT FROM OLD.notice_days
     OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_by_email IS DISTINCT FROM OLD.requested_by_email
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pricing_changes_immutable_field' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('rejected', 'withdrawn', 'effective') THEN
    RAISE EXCEPTION 'pricing_changes_terminal_state' USING ERRCODE = '42501';
  END IF;

  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('proposed', 'approved', 'rejected', 'withdrawn'))
       OR (OLD.status = 'approved' AND NEW.status IN ('approved', 'effective', 'withdrawn'))) THEN
    RAISE EXCEPTION 'pricing_changes_invalid_transition' USING ERRCODE = '42501';
  END IF;

  IF NEW.counsel_review IS DISTINCT FROM OLD.counsel_review AND OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'pricing_changes_counsel_frozen' USING ERRCODE = '42501';
  END IF;

  IF (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approved_by_email IS DISTINCT FROM OLD.approved_by_email)
     AND NOT (OLD.status = 'proposed' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'pricing_changes_approval_frozen' USING ERRCODE = '42501';
  END IF;

  IF (NEW.git_commit IS DISTINCT FROM OLD.git_commit OR NEW.repo_fingerprints IS DISTINCT FROM OLD.repo_fingerprints
      OR NEW.effective_marked_at IS DISTINCT FROM OLD.effective_marked_at)
     AND NOT (OLD.status = 'approved' AND NEW.status = 'effective') THEN
    RAISE EXCEPTION 'pricing_changes_deploy_fields_frozen' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pricing_changes_guard_row ON public.pricing_changes;
CREATE TRIGGER trg_pricing_changes_guard_row
  BEFORE UPDATE OR DELETE ON public.pricing_changes
  FOR EACH ROW EXECUTE FUNCTION public._pricing_changes_guard();

DROP TRIGGER IF EXISTS trg_pricing_changes_guard_stmt ON public.pricing_changes;
-- lint:allow-destructive this trigger BLOCKS truncation, it does not perform it
CREATE TRIGGER trg_pricing_changes_guard_stmt
  BEFORE TRUNCATE ON public.pricing_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public._pricing_changes_guard();

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pricing_assert_staff()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._pricing_is_approver(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_uid IS NOT NULL
     AND public.is_vireek_staff(p_uid)
     AND EXISTS (SELECT 1 FROM public.pricing_change_approvers a WHERE a.user_id = p_uid);
$$;

-- ---------------------------------------------------------------------------
-- Staff RPCs (each re-checks staff status inside the function)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_pricing_change_propose(
  p_title text,
  p_summary text,
  p_effective_date date,
  p_grandfathering text,
  p_affected_plans text[] DEFAULT '{}',
  p_notice_days integer DEFAULT NULL,
  p_kind text DEFAULT 'change'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_year text := to_char(now() AT TIME ZONE 'UTC', 'YYYY');
  v_seq integer;
  v_ref text;
  v_id uuid;
BEGIN
  PERFORM public._pricing_assert_staff();
  IF p_kind NOT IN ('change', 'baseline') THEN RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023'; END IF;
  IF p_effective_date IS NULL THEN RAISE EXCEPTION 'effective_date_required' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'change' AND p_effective_date < (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'effective_date_in_past' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'baseline' AND p_notice_days IS NOT NULL THEN
    RAISE EXCEPTION 'baseline_has_no_notice' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;

  -- Serialise reference allocation; the UNIQUE constraint is the backstop.
  PERFORM pg_advisory_xact_lock(hashtext('pricing_changes_ref'));
  SELECT coalesce(max(substr(c.change_ref, 9)::integer), 0) + 1 INTO v_seq
    FROM public.pricing_changes c WHERE c.change_ref LIKE 'PC-' || v_year || '-%';
  IF v_seq > 9999 THEN RAISE EXCEPTION 'reference_space_exhausted' USING ERRCODE = '54000'; END IF;
  v_ref := 'PC-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO public.pricing_changes (
    change_ref, kind, title, summary, affected_plans, grandfathering, notice_required, notice_days,
    effective_date, requested_by, requested_by_email
  ) VALUES (
    v_ref, p_kind, btrim(p_title), btrim(p_summary), coalesce(p_affected_plans, '{}'), p_grandfathering,
    p_notice_days IS NOT NULL, p_notice_days, p_effective_date, v_uid, v_email
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'change_ref', v_ref);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pricing_change_set_counsel(p_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pricing_changes%ROWTYPE;
BEGIN
  PERFORM public._pricing_assert_staff();
  IF p_status NOT IN ('not_requested', 'pending', 'completed') THEN RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023'; END IF;
  -- Recording that counsel finished is an attestation: only approvers may do it.
  IF p_status = 'completed' AND NOT public._pricing_is_approver(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.pricing_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status <> 'proposed' THEN RAISE EXCEPTION 'not_proposed' USING ERRCODE = '22023'; END IF;
  UPDATE public.pricing_changes SET counsel_review = p_status WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'counsel_review', p_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pricing_change_decide(p_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_row public.pricing_changes%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
BEGIN
  PERFORM public._pricing_assert_staff();
  IF NOT public._pricing_is_approver(v_uid) THEN RAISE EXCEPTION 'not_an_approver' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'invalid_decision' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_row FROM public.pricing_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status <> 'proposed' THEN RAISE EXCEPTION 'not_proposed' USING ERRCODE = '22023'; END IF;
  IF v_row.requested_by = v_uid THEN RAISE EXCEPTION 'two_person_rule' USING ERRCODE = '42501'; END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;

  IF p_decision = 'reject' THEN
    IF v_note IS NULL THEN RAISE EXCEPTION 'note_required' USING ERRCODE = '22023'; END IF;
    UPDATE public.pricing_changes SET status = 'rejected', decision_note = v_note WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'status', 'rejected');
  END IF;

  IF v_row.kind = 'change' AND v_row.effective_date < v_today THEN
    RAISE EXCEPTION 'effective_date_in_past' USING ERRCODE = '22023';
  END IF;
  IF v_row.notice_required THEN
    IF v_row.counsel_review <> 'completed' THEN RAISE EXCEPTION 'counsel_review_required' USING ERRCODE = '22023'; END IF;
    IF v_row.effective_date < v_today + v_row.notice_days THEN RAISE EXCEPTION 'notice_period_too_short' USING ERRCODE = '22023'; END IF;
  END IF;

  UPDATE public.pricing_changes
     SET status = 'approved', approved_by = v_uid, approved_by_email = v_email, approved_at = now(), decision_note = v_note
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'status', 'approved');
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pricing_change_withdraw(p_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.pricing_changes%ROWTYPE;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
BEGIN
  PERFORM public._pricing_assert_staff();
  IF v_note IS NULL THEN RAISE EXCEPTION 'note_required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_row FROM public.pricing_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status NOT IN ('proposed', 'approved') THEN RAISE EXCEPTION 'not_withdrawable' USING ERRCODE = '22023'; END IF;
  IF v_row.requested_by <> v_uid AND NOT public._pricing_is_approver(v_uid) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.pricing_changes SET status = 'withdrawn', decision_note = v_note WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'status', 'withdrawn');
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pricing_change_mark_effective(p_id uuid, p_git_commit text, p_fingerprints jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.pricing_changes%ROWTYPE;
  v_bad integer;
BEGIN
  PERFORM public._pricing_assert_staff();
  IF p_git_commit IS NULL OR p_git_commit !~ '^[0-9a-f]{7,40}$' THEN RAISE EXCEPTION 'invalid_git_commit' USING ERRCODE = '22023'; END IF;
  IF p_fingerprints IS NULL OR jsonb_typeof(p_fingerprints) <> 'object' OR p_fingerprints = '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_fingerprints' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad FROM jsonb_each_text(p_fingerprints) f WHERE f.value !~ '^[0-9a-f]{64}$';
  IF v_bad > 0 THEN RAISE EXCEPTION 'invalid_fingerprints' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_row FROM public.pricing_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status <> 'approved' THEN RAISE EXCEPTION 'not_approved' USING ERRCODE = '22023'; END IF;
  IF v_row.effective_date > (now() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'not_yet_effective' USING ERRCODE = '22023'; END IF;

  UPDATE public.pricing_changes
     SET status = 'effective', git_commit = p_git_commit, repo_fingerprints = p_fingerprints, effective_marked_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'status', 'effective');
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_pricing_changes_list(p_limit integer DEFAULT 50, p_status text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._feedback_assert_staff('pricing_changes');
  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC)
    FROM (
      SELECT id, change_ref, kind, title, summary, affected_plans, grandfathering, notice_required, notice_days,
             counsel_review, effective_date, status, requested_by_email, requested_at, approved_by_email, approved_at,
             decision_note, git_commit, effective_marked_at, created_at
      FROM public.pricing_changes
      WHERE p_status IS NULL OR status = p_status
      ORDER BY created_at DESC
      LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
    ) c
  ), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._pricing_changes_guard(), public._pricing_assert_staff(), public._pricing_is_approver(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.staff_pricing_change_propose(text, text, date, text, text[], integer, text),
  public.staff_pricing_change_set_counsel(uuid, text),
  public.staff_pricing_change_decide(uuid, text, text),
  public.staff_pricing_change_withdraw(uuid, text),
  public.staff_pricing_change_mark_effective(uuid, text, jsonb),
  public.staff_pricing_changes_list(integer, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.staff_pricing_change_propose(text, text, date, text, text[], integer, text),
  public.staff_pricing_change_set_counsel(uuid, text),
  public.staff_pricing_change_decide(uuid, text, text),
  public.staff_pricing_change_withdraw(uuid, text),
  public.staff_pricing_change_mark_effective(uuid, text, jsonb),
  public.staff_pricing_changes_list(integer, text)
TO authenticated;

/*
  ## Owner setup (run once in the Supabase SQL editor; replace the email)
    INSERT INTO public.pricing_change_approvers (user_id)
    SELECT id FROM auth.users WHERE lower(email) = lower('approver@your-company.example')
    ON CONFLICT DO NOTHING;
  The approver must also be Vireek staff (is_vireek_staff). Use at least two staff accounts, otherwise nobody
  can both request and approve (two-person rule).

  ## ROLLBACK (only if no pricing_changes rows must be kept - the table is an audit record)
    DROP FUNCTION IF EXISTS public.staff_pricing_changes_list(integer, text);
    DROP FUNCTION IF EXISTS public.staff_pricing_change_mark_effective(uuid, text, jsonb);
    DROP FUNCTION IF EXISTS public.staff_pricing_change_withdraw(uuid, text);
    DROP FUNCTION IF EXISTS public.staff_pricing_change_decide(uuid, text, text);
    DROP FUNCTION IF EXISTS public.staff_pricing_change_set_counsel(uuid, text);
    DROP FUNCTION IF EXISTS public.staff_pricing_change_propose(text, text, date, text, text[], integer, text);
    DROP FUNCTION IF EXISTS public._pricing_is_approver(uuid);
    DROP FUNCTION IF EXISTS public._pricing_assert_staff();
    DROP TABLE IF EXISTS public.pricing_change_approvers;
    DROP TABLE IF EXISTS public.pricing_changes;   -- also drops its triggers
    DROP FUNCTION IF EXISTS public._pricing_changes_guard();
*/
