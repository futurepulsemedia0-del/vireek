/*
  # Technician Retention Engine

  ## Why
  HVAC / plumbing technician turnover runs ~16-20% a year and each departure
  costs roughly $15-25k. Techs mostly leave over operational friction
  (last-minute schedule changes, on-call burden, overtime, unpaid or rejected
  time, falling earnings, unanswered requests to the office) - not just pay.
  This engine scores that friction weekly, explains every score in plain
  language, and turns each driver into a one-click action the owner approves.

  ## What this adds (additive only - nothing existing is altered)
  1. retention_can_manage()        - manager/owner-only gate used by RLS + RPCs.
  2. tech_risk_scores              - one explainable score per technician per week.
  3. retention_actions             - suggested fixes, approval state and the
                                     measured outcome (did the score improve?).
  4. retention_schedule_freezes    - "freeze the next 48 hours" guard rails.
  5. approve_retention_action / dismiss_retention_action /
     lift_retention_freeze         - the ONLY write path for authenticated users.
  6. retention_guard_frozen_schedule trigger on jobs - blocks manual moves of a
     frozen technician's jobs while a freeze is active (service-role jobs,
     customer self-reschedule tokens and cron are never blocked).

  ## Security
  - Every table is RLS-scoped to the account (get_account_owner_id()) AND to
    managers only (retention_can_manage()). Technicians never see scores.
  - Authenticated users have SELECT only; all writes go through the
    SECURITY DEFINER RPCs above or the service-role edge function.
  - No protected attribute (age, gender, ethnicity, health, ...) exists in any
    column, and the engine never reads one.

  ## Re-runnable
  Every statement is idempotent (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS).
*/

-- =============================================================
-- 1. Manager gate (owner / admin / manager only)
--    Same resolution order as is_office_member(): an invited team member is
--    judged by their team_members row, an account owner by their profile.
-- =============================================================
CREATE OR REPLACE FUNCTION public.retention_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = auth.uid()) THEN
      EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.user_id = auth.uid()
          AND tm.invite_status = 'active'
          AND tm.role IN ('admin', 'manager')
      )
    ELSE
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
  END;
$$;

REVOKE ALL ON FUNCTION public.retention_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retention_can_manage() TO authenticated, service_role;

-- =============================================================
-- 2. tech_risk_scores - one row per technician per week
-- =============================================================
CREATE TABLE IF NOT EXISTS public.tech_risk_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tech_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  week date NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  risk_band text NOT NULL CHECK (risk_band IN ('high', 'elevated', 'low', 'insufficient')),
  data_quality text NOT NULL DEFAULT 'ok' CHECK (data_quality IN ('ok', 'limited', 'insufficient')),
  confidence numeric(4, 3) NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  top_drivers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(top_drivers) = 'array'),
  signals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(signals) = 'object'),
  attrition_probability numeric(4, 3) NOT NULL DEFAULT 0 CHECK (attrition_probability BETWEEN 0 AND 1),
  est_replacement_cost integer NOT NULL DEFAULT 0 CHECK (est_replacement_cost >= 0),
  expected_annual_cost integer NOT NULL DEFAULT 0 CHECK (expected_annual_cost >= 0),
  score_delta smallint,
  model_version text NOT NULL DEFAULT 'rules-v1',
  is_demo boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tech_risk_scores_week UNIQUE (user_id, tech_id, week)
);

COMMENT ON COLUMN public.tech_risk_scores.est_replacement_cost IS
  'Whole US dollars: what losing this technician would cost (recruiting, ramp-up, lost jobs). Tenure-tiered $15k / $20k / $25k.';
COMMENT ON COLUMN public.tech_risk_scores.expected_annual_cost IS
  'Whole US dollars: attrition_probability x est_replacement_cost. A planning estimate, not a prediction about a person.';

CREATE INDEX IF NOT EXISTS idx_tech_risk_scores_user_week ON public.tech_risk_scores (user_id, week DESC);
CREATE INDEX IF NOT EXISTS idx_tech_risk_scores_tech_week ON public.tech_risk_scores (tech_id, week DESC);

ALTER TABLE public.tech_risk_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_select_tech_risk_scores" ON public.tech_risk_scores;
CREATE POLICY "managers_select_tech_risk_scores" ON public.tech_risk_scores
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.retention_can_manage());

-- =============================================================
-- 3. retention_actions - suggestion -> approval -> measured outcome
-- =============================================================
CREATE TABLE IF NOT EXISTS public.retention_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tech_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  score_id uuid REFERENCES public.tech_risk_scores(id) ON DELETE SET NULL,
  action_type text NOT NULL CHECK (action_type IN (
    'rebalance_on_call', 'freeze_schedule', 'reduce_overtime',
    'remove_paperwork_step', 'clear_office_backlog', 'manager_one_on_one'
  )),
  driver_key text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 2000),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'dismissed', 'expired')),
  baseline_score smallint CHECK (baseline_score IS NULL OR baseline_score BETWEEN 0 AND 100),
  outcome text CHECK (outcome IS NULL OR outcome IN ('improved', 'no_change', 'worsened')),
  score_after smallint CHECK (score_after IS NULL OR score_after BETWEEN 0 AND 100),
  outcome_checked_at timestamptz,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  task_id uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retention_actions_user_status ON public.retention_actions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retention_actions_tech ON public.retention_actions (tech_id, created_at DESC);
-- At most one open suggestion per technician per action type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_retention_actions_open
  ON public.retention_actions (user_id, tech_id, action_type) WHERE status = 'suggested';

ALTER TABLE public.retention_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_select_retention_actions" ON public.retention_actions;
CREATE POLICY "managers_select_retention_actions" ON public.retention_actions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.retention_can_manage());

-- =============================================================
-- 4. retention_schedule_freezes - "freeze the next 48 hours"
-- =============================================================
CREATE TABLE IF NOT EXISTS public.retention_schedule_freezes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tech_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  action_id uuid REFERENCES public.retention_actions(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  lifted_at timestamptz,
  lifted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_freeze_window CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_retention_freezes_active
  ON public.retention_schedule_freezes (tech_id, ends_at) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_retention_freezes_user ON public.retention_schedule_freezes (user_id, created_at DESC);

ALTER TABLE public.retention_schedule_freezes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_select_retention_freezes" ON public.retention_schedule_freezes;
CREATE POLICY "managers_select_retention_freezes" ON public.retention_schedule_freezes
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.retention_can_manage());

-- =============================================================
-- 5. RPCs - the only write path for authenticated users
-- =============================================================

-- Approve one suggestion. Records the baseline score (so the outcome can be
-- measured later), creates a follow-up task for the approving manager and, for
-- freeze_schedule, starts a 48-hour freeze. The task text comes from the
-- client so it is written in the manager's own language.
CREATE OR REPLACE FUNCTION public.approve_retention_action(
  p_action_id uuid,
  p_task_title text DEFAULT NULL,
  p_task_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  a public.retention_actions%ROWTYPE;
  v_baseline smallint;
  v_assignee text;
  v_title text;
  v_desc text;
  v_task uuid;
  v_freeze uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.retention_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT * INTO a FROM public.retention_actions
   WHERE id = p_action_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF a.status <> 'suggested' THEN
    RETURN jsonb_build_object('status', 'already_processed', 'current', a.status);
  END IF;

  SELECT s.score INTO v_baseline
    FROM public.tech_risk_scores s
   WHERE s.user_id = v_owner AND s.tech_id = a.tech_id
   ORDER BY s.week DESC
   LIMIT 1;

  IF a.action_type = 'freeze_schedule' THEN
    INSERT INTO public.retention_schedule_freezes (user_id, tech_id, action_id, starts_at, ends_at, created_by)
    VALUES (v_owner, a.tech_id, a.id, now(), now() + interval '48 hours', v_uid)
    RETURNING id INTO v_freeze;
  END IF;

  v_title := left(btrim(COALESCE(NULLIF(p_task_title, ''), a.title)), 200);
  v_desc := left(COALESCE(NULLIF(p_task_description, ''), a.detail), 4000);
  SELECT COALESCE(
    (SELECT tm.member_name FROM public.team_members tm WHERE tm.user_id = v_uid LIMIT 1),
    (SELECT p.full_name FROM public.profiles p WHERE p.id = v_uid)
  ) INTO v_assignee;

  -- The follow-up task is best effort: approval must never fail because the
  -- tasks table is missing or shaped differently on an older deployment.
  BEGIN
    INSERT INTO public.tasks (user_id, created_by, assigned_to, assigned_to_name, title, description, priority, due_at)
    VALUES (v_owner, v_uid, v_uid, v_assignee, v_title, v_desc, 'high', now() + interval '3 days')
    RETURNING id INTO v_task;
  EXCEPTION WHEN OTHERS THEN
    v_task := NULL;
  END;

  UPDATE public.retention_actions
     SET status = 'approved', baseline_score = v_baseline, decided_by = v_uid,
         decided_at = now(), task_id = v_task
   WHERE id = a.id;

  RETURN jsonb_build_object('status', 'applied', 'task_id', v_task, 'freeze_id', v_freeze);
END;
$$;

CREATE OR REPLACE FUNCTION public.dismiss_retention_action(p_action_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.retention_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT status INTO v_status FROM public.retention_actions
   WHERE id = p_action_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_status <> 'suggested' THEN
    RETURN jsonb_build_object('status', 'already_processed', 'current', v_status);
  END IF;

  UPDATE public.retention_actions
     SET status = 'dismissed', decided_by = auth.uid(), decided_at = now()
   WHERE id = p_action_id;

  RETURN jsonb_build_object('status', 'applied');
END;
$$;

CREATE OR REPLACE FUNCTION public.lift_retention_freeze(p_freeze_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.retention_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  UPDATE public.retention_schedule_freezes
     SET lifted_at = now(), lifted_by = auth.uid()
   WHERE id = p_freeze_id AND user_id = v_owner AND lifted_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  RETURN jsonb_build_object('status', 'applied');
END;
$$;

REVOKE ALL ON FUNCTION public.approve_retention_action(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dismiss_retention_action(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lift_retention_freeze(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_retention_action(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_retention_action(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lift_retention_freeze(uuid) TO authenticated;

-- =============================================================
-- 6. Freeze guard on jobs
--    Fires only when scheduled_datetime or assigned_technician_id actually
--    changes, and only for a signed-in user (auth.uid() IS NOT NULL). Edge
--    functions on the service role, cron jobs and the customer self-reschedule
--    token RPC have no auth.uid() and are never blocked. The manager can lift a
--    freeze at any time from the Retention page.
-- =============================================================
CREATE OR REPLACE FUNCTION public.retention_guard_frozen_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hit boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.job_status IN ('completed', 'cancelled', 'canceled') THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.retention_schedule_freezes f
     WHERE f.user_id = OLD.user_id
       AND f.lifted_at IS NULL
       AND now() >= f.starts_at AND now() < f.ends_at
       AND (
         (f.tech_id = OLD.assigned_technician_id
            AND OLD.scheduled_datetime >= f.starts_at AND OLD.scheduled_datetime < f.ends_at)
         OR
         (f.tech_id = NEW.assigned_technician_id
            AND NEW.scheduled_datetime >= f.starts_at AND NEW.scheduled_datetime < f.ends_at)
       )
  ) INTO v_hit;

  IF v_hit THEN
    RAISE EXCEPTION 'SCHEDULE_FROZEN: this technician''s schedule is frozen for the next 48 hours (Retention Engine). Lift the freeze on the Technician Retention page to make this change.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.retention_guard_frozen_schedule() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_retention_guard_frozen_schedule ON public.jobs;
CREATE TRIGGER trg_retention_guard_frozen_schedule
  BEFORE UPDATE OF scheduled_datetime, assigned_technician_id ON public.jobs
  FOR EACH ROW
  WHEN (
    OLD.scheduled_datetime IS DISTINCT FROM NEW.scheduled_datetime
    OR OLD.assigned_technician_id IS DISTINCT FROM NEW.assigned_technician_id
  )
  EXECUTE FUNCTION public.retention_guard_frozen_schedule();
