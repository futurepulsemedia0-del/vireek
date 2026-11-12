/*
# Staff customer-success tasks (flag-gated, staff-only)

## Why
The at-risk playbook (docs/customer-success/at-risk.md) needs a place for internal follow-up work.
The tenant `tasks` table is shown to the customer's team and `notifications` pushes to tenant devices,
so neither may hold internal churn notes. This adds a separate, staff-only task list.

## What this adds (purely additive)
- feature flag `cs_auto_tasks`   default OFF. The master `enabled` switch is the only gate. Every RPC returns
                                 {ok:false, reason:'flag_off'} while it is off and writes nothing.
- staff_cs_tasks                 one ACTIVE (open / in_progress) task per account + playbook (partial unique index).
- staff_sync_cs_tasks(jsonb)     idempotent upsert from the at-risk list (max 200 items; invalid items are skipped).
- staff_list_cs_tasks()          active tasks, oldest due first.
- staff_update_cs_task(...)      start / done / dismiss / assign to me. Closed tasks cannot be changed.

## Safety
- RLS is on with NO policies and every table privilege is revoked from anon/authenticated:
  the table is reachable only through the SECURITY DEFINER functions below, which check is_vireek_staff().
- The risk level is computed by staff clients (computeSuccessRisk) and is NOT recomputed here; staff are the
  trust boundary. Values are range-checked and the account must be a real owner profile.
- Audit: a staff_audit_log row (existing action 'explorer_list', metadata.view = 'cs_tasks_sync' /
  'cs_task_update') is written when a task is created or changed. No new audit action value is needed.
- Tasks are never auto-closed; staff close them.

## Requires
is_vireek_staff(uuid), feature_flags (with kind, risk), staff_audit_log, profiles(id, role).

## Rollback (manual, destructive; run only on purpose)
DROP FUNCTION public.staff_update_cs_task(uuid, text, boolean);
DROP FUNCTION public.staff_list_cs_tasks();
DROP FUNCTION public.staff_sync_cs_tasks(jsonb);
DROP FUNCTION public._cs_add_business_days(integer);
DROP TABLE public.staff_cs_tasks;
DELETE FROM public.feature_flags WHERE key = 'cs_auto_tasks';
*/

-- rollback: see the commented block above (drop the 4 functions, then staff_cs_tasks, then delete the cs_auto_tasks flag row). Safe to run once the flag is off; task data is internal and not customer-facing.

DO $$
BEGIN
  IF to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regclass('public.feature_flags') IS NULL
     OR to_regclass('public.staff_audit_log') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'staff_cs_tasks: prerequisites missing (is_vireek_staff, feature_flags, staff_audit_log, profiles)';
  END IF;
END $$;

-- 1. Flag (default OFF) --------------------------------------------------------------
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct, kind, risk)
VALUES ('cs_auto_tasks', 'Customer success auto tasks',
        'Creates staff-only follow-up tasks from high/medium at-risk accounts. Master switch only (staff internal). Owner: customer-success.',
        false, 0, 'ops', 'low')
ON CONFLICT (key) DO NOTHING;

-- 2. Table ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_cs_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  playbook text NOT NULL CHECK (playbook IN ('at_risk')),
  risk_level text NOT NULL CHECK (risk_level IN ('high', 'medium')),
  risk_score smallint CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array' AND pg_column_size(reasons) <= 4096),
  suggested_action text CHECK (suggested_action IS NULL OR char_length(suggested_action) <= 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_cs_tasks_active
  ON public.staff_cs_tasks (account_id, playbook) WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_staff_cs_tasks_due
  ON public.staff_cs_tasks (due_at) WHERE status IN ('open', 'in_progress');

ALTER TABLE public.staff_cs_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_cs_tasks FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.staff_cs_tasks IS 'Internal customer-success follow-ups. Staff only, via staff_*_cs_task(s) functions. Never shown to tenants.';

-- 3. Helper: due date in business days (UTC weekdays) -------------------------------------
CREATE OR REPLACE FUNCTION public._cs_add_business_days(p_days integer)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_d timestamptz := now();
  v_n integer := 0;
  v_target integer := least(greatest(coalesce(p_days, 0), 0), 30);
BEGIN
  WHILE v_n < v_target LOOP
    v_d := v_d + interval '1 day';
    IF extract(isodow FROM (v_d AT TIME ZONE 'UTC')) < 6 THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_d;
END;
$$;

-- 4. Sync ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_sync_cs_tasks(p_candidates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_on boolean;
  v_item jsonb;
  v_account uuid;
  v_level text;
  v_score integer;
  v_title text;
  v_reasons jsonb;
  v_action text;
  v_inserted boolean;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT f.enabled INTO v_on FROM public.feature_flags f WHERE f.key = 'cs_auto_tasks';
  IF v_on IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'flag_off');
  END IF;

  IF p_candidates IS NULL OR jsonb_typeof(p_candidates) <> 'array' OR jsonb_array_length(p_candidates) > 200 THEN
    RAISE EXCEPTION 'invalid_candidates' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_candidates) AS e LOOP
    BEGIN
      IF jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION 'skip';
      END IF;
      v_account := (v_item ->> 'account_id')::uuid;
      v_level := v_item ->> 'risk_level';
      IF v_level IS NULL OR v_level NOT IN ('high', 'medium') THEN
        RAISE EXCEPTION 'skip';
      END IF;
      v_score := CASE WHEN v_item ->> 'risk_score' IS NULL THEN NULL
                      ELSE least(greatest((v_item ->> 'risk_score')::integer, 0), 100) END;
      v_title := left(btrim(coalesce(v_item ->> 'title', '')), 200);
      IF v_title = '' THEN
        RAISE EXCEPTION 'skip';
      END IF;
      v_reasons := CASE WHEN jsonb_typeof(v_item -> 'reasons') = 'array' THEN v_item -> 'reasons' ELSE '[]'::jsonb END;
      IF pg_column_size(v_reasons) > 4096 THEN
        v_reasons := '[]'::jsonb;
      END IF;
      v_action := nullif(left(btrim(coalesce(v_item ->> 'suggested_action', '')), 300), '');

      IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_account AND p.role = 'owner') THEN
        RAISE EXCEPTION 'skip';
      END IF;

      INSERT INTO public.staff_cs_tasks AS t (account_id, playbook, risk_level, risk_score, title, reasons, suggested_action, due_at)
      VALUES (v_account, 'at_risk', v_level, v_score, v_title, v_reasons, v_action,
              public._cs_add_business_days(CASE WHEN v_level = 'high' THEN 2 ELSE 5 END))
      ON CONFLICT (account_id, playbook) WHERE status IN ('open', 'in_progress')
      DO UPDATE SET risk_level = EXCLUDED.risk_level,
                    risk_score = EXCLUDED.risk_score,
                    title = EXCLUDED.title,
                    reasons = EXCLUDED.reasons,
                    suggested_action = EXCLUDED.suggested_action,
                    due_at = least(t.due_at, EXCLUDED.due_at),
                    updated_at = now()
      RETURNING (xmax = 0) INTO v_inserted;

      IF v_inserted THEN
        v_created := v_created + 1;
      ELSE
        v_updated := v_updated + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  IF v_created > 0 THEN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
    INSERT INTO public.staff_audit_log (staff_id, staff_email, action, metadata)
    VALUES (auth.uid(), v_email, 'explorer_list',
            jsonb_build_object('view', 'cs_tasks_sync', 'created', v_created, 'updated', v_updated, 'skipped', v_skipped));
  END IF;

  RETURN jsonb_build_object('ok', true, 'created', v_created, 'updated', v_updated, 'skipped', v_skipped);
END;
$$;

-- 5. List ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_list_cs_tasks()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_on boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT f.enabled INTO v_on FROM public.feature_flags f WHERE f.key = 'cs_auto_tasks';
  IF v_on IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'flag_off');
  END IF;

  RETURN jsonb_build_object('ok', true, 'tasks', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', s.id,
             'account_id', s.account_id,
             'playbook', s.playbook,
             'risk_level', s.risk_level,
             'risk_score', s.risk_score,
             'title', s.title,
             'reasons', s.reasons,
             'suggested_action', s.suggested_action,
             'status', s.status,
             'due_at', s.due_at,
             'created_at', s.created_at,
             'assigned', s.owner_id IS NOT NULL,
             'mine', coalesce(s.owner_id = auth.uid(), false)
           ) ORDER BY s.due_at, s.id)
    FROM (
      SELECT t.* FROM public.staff_cs_tasks t
      WHERE t.status IN ('open', 'in_progress')
      ORDER BY t.due_at, t.id
      LIMIT 200
    ) s
  ), '[]'::jsonb));
END;
$$;

-- 6. Update --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_update_cs_task(
  p_id uuid,
  p_status text DEFAULT NULL,
  p_assign_me boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_on boolean;
  v_email text;
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('in_progress', 'done', 'dismissed') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL AND NOT coalesce(p_assign_me, false) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT f.enabled INTO v_on FROM public.feature_flags f WHERE f.key = 'cs_auto_tasks';
  IF v_on IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'flag_off');
  END IF;

  UPDATE public.staff_cs_tasks t
     SET status = coalesce(p_status, t.status),
         owner_id = CASE WHEN coalesce(p_assign_me, false) THEN auth.uid() ELSE t.owner_id END,
         resolved_at = CASE WHEN p_status IN ('done', 'dismissed') THEN now() ELSE t.resolved_at END,
         updated_at = now()
   WHERE t.id = p_id AND t.status IN ('open', 'in_progress')
  RETURNING t.status INTO v_status;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found_or_closed');
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO public.staff_audit_log (staff_id, staff_email, action, metadata)
  VALUES (auth.uid(), v_email, 'explorer_list',
          jsonb_build_object('view', 'cs_task_update', 'task_id', p_id, 'status', v_status, 'assigned_me', coalesce(p_assign_me, false)));

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- 7. Grants --------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._cs_add_business_days(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_sync_cs_tasks(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_cs_tasks() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_update_cs_task(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_sync_cs_tasks(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_cs_tasks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_update_cs_task(uuid, text, boolean) TO authenticated;
