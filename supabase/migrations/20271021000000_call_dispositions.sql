/*
  # Call dispositions (outcome tagging) + required follow-up tasks

  After each call, staff (or the AI) tags ONE outcome:
  booked, quoted, wrong_number, spam, vendor, existing_customer_issue, no_answer.

  ## Follow-up rule (single source of truth, mirrored in src/lib/callDisposition.ts
  ## and pinned by a test)
  - required: quoted, existing_customer_issue, no_answer  -> a task MUST exist
  - optional: booked, vendor
  - none:     wrong_number, spam

  ## Enforcement (not just UI)
  - set_call_disposition() writes the disposition and creates the follow-up
    task in ONE transaction (SECURITY INVOKER -> every statement runs under the
    caller's RLS, same model as complete_task()).
  - A BEFORE trigger rejects a staff-written row whose outcome requires a
    follow-up but has no follow_up_task_id, so a direct table write cannot
    bypass the rule. AI-written rows (service role) are exempt; the moment
    staff confirm or change an AI row, the rule applies.
  - Deleting the linked task later only nulls follow_up_task_id (the trigger
    fires on INSERT / UPDATE OF outcome only, so task deletion is never blocked).

  ## Access model
  - Scoped to the account: user_id = public.get_account_owner_id().
  - Any account member may tag calls; only managers (tasks_can_view_all) may delete.

  ## AI agreement
  - AI rows store ai_outcome = the AI's pick. If staff later change the outcome,
    ai_outcome is kept, so Analytics can show how often staff agree with the AI.

  Requires: get_account_owner_id(), tasks_can_view_all() and public.tasks
  (20270501000000_tasks.sql), calls, profiles, leads.
*/

-- ---------------------------------------------------------------------------
-- Rule helpers (IMMUTABLE so they can be reused anywhere, including indexes)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.call_disposition_valid_outcome(p_outcome text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_outcome IN (
    'booked', 'quoted', 'wrong_number', 'spam', 'vendor', 'existing_customer_issue', 'no_answer'
  );
$$;

CREATE OR REPLACE FUNCTION public.call_disposition_requires_follow_up(p_outcome text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_outcome IN ('quoted', 'existing_customer_issue', 'no_answer');
$$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.call_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (
    outcome IN ('booked', 'quoted', 'wrong_number', 'spam', 'vendor', 'existing_customer_issue', 'no_answer')
  ),
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'ai')),
  ai_outcome text CHECK (
    ai_outcome IS NULL
    OR ai_outcome IN ('booked', 'quoted', 'wrong_number', 'spam', 'vendor', 'existing_customer_issue', 'no_answer')
  ),
  ai_confidence numeric(3, 2) CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  follow_up_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  set_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_dispositions_one_per_call UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS idx_call_dispositions_user_outcome
  ON public.call_dispositions (user_id, outcome);
CREATE INDEX IF NOT EXISTS idx_call_dispositions_user_created
  ON public.call_dispositions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_dispositions_task
  ON public.call_dispositions (follow_up_task_id) WHERE follow_up_task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Integrity trigger: owns updated_at, locks identity columns, enforces the
-- "required follow-up" rule for staff-written rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.call_dispositions_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.note := NULLIF(btrim(COALESCE(NEW.note, '')), '');

  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.call_id := OLD.call_id;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  END IF;

  IF NEW.source = 'staff'
     AND public.call_disposition_requires_follow_up(NEW.outcome)
     AND NEW.follow_up_task_id IS NULL THEN
    RAISE EXCEPTION 'follow_up_required' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_call_dispositions_before_insert ON public.call_dispositions;
CREATE TRIGGER trigger_call_dispositions_before_insert
  BEFORE INSERT ON public.call_dispositions
  FOR EACH ROW
  EXECUTE FUNCTION public.call_dispositions_before_write();

-- UPDATE OF outcome / source only: ON DELETE SET NULL on the task link must never be blocked.
DROP TRIGGER IF EXISTS trigger_call_dispositions_before_update ON public.call_dispositions;
CREATE TRIGGER trigger_call_dispositions_before_update
  BEFORE UPDATE OF outcome, source, note ON public.call_dispositions
  FOR EACH ROW
  EXECUTE FUNCTION public.call_dispositions_before_write();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.call_dispositions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "call_dispositions_select" ON public.call_dispositions;
CREATE POLICY "call_dispositions_select" ON public.call_dispositions
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "call_dispositions_insert" ON public.call_dispositions;
CREATE POLICY "call_dispositions_insert" ON public.call_dispositions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (set_by IS NULL OR set_by = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.calls c
      WHERE c.id = call_id AND c.user_id = public.get_account_owner_id()
    )
  );

DROP POLICY IF EXISTS "call_dispositions_update" ON public.call_dispositions;
CREATE POLICY "call_dispositions_update" ON public.call_dispositions
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (
      SELECT 1 FROM public.calls c
      WHERE c.id = call_id AND c.user_id = public.get_account_owner_id()
    )
  );

DROP POLICY IF EXISTS "call_dispositions_delete" ON public.call_dispositions;
CREATE POLICY "call_dispositions_delete" ON public.call_dispositions
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tasks_can_view_all());

-- ---------------------------------------------------------------------------
-- set_call_disposition(): tag a call + create the follow-up task atomically.
-- SECURITY INVOKER on purpose: RLS of calls / tasks / call_dispositions applies.
--
-- p_task (jsonb, optional): { title, description, priority, due_at,
--                             assigned_to, assigned_to_name }
-- Returns { disposition: <row>, task_created: boolean }.
-- Errors (message text): not_authenticated, invalid_outcome, note_too_long,
--   call_not_found, invalid_follow_up, follow_up_required.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_call_disposition(
  p_call_id uuid,
  p_outcome text,
  p_note text DEFAULT NULL,
  p_task jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_call public.calls;
  v_existing public.call_dispositions;
  v_row public.call_dispositions;
  v_note text;
  v_task_id uuid;
  v_created boolean := false;
  v_title text;
  v_lead_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_outcome IS NULL OR NOT public.call_disposition_valid_outcome(p_outcome) THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(btrim(COALESCE(p_note, '')), '');
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'note_too_long' USING ERRCODE = '22023';
  END IF;

  -- Visible only if the call belongs to the caller's account (calls RLS).
  SELECT * INTO v_call FROM public.calls WHERE id = p_call_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Serialise concurrent taggers of the same call.
  SELECT * INTO v_existing FROM public.call_dispositions WHERE call_id = p_call_id FOR UPDATE;
  v_task_id := v_existing.follow_up_task_id;

  IF p_task IS NOT NULL THEN
    v_title := btrim(COALESCE(p_task ->> 'title', ''));
    IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'invalid_follow_up' USING ERRCODE = '22023';
    END IF;

    -- Idempotent: a double submit must not create a second identical open task.
    IF v_task_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tasks t WHERE t.id = v_task_id AND t.status <> 'done' AND t.title = v_title
    ) THEN
      NULL;
    ELSE
      SELECT l.id INTO v_lead_id
      FROM public.leads l
      WHERE l.call_id = p_call_id
      ORDER BY l.created_at DESC
      LIMIT 1;

      INSERT INTO public.tasks (
        title, description, priority, due_at, assigned_to, assigned_to_name, customer_id, lead_id
      )
      VALUES (
        v_title,
        NULLIF(btrim(COALESCE(p_task ->> 'description', '')), ''),
        COALESCE(NULLIF(p_task ->> 'priority', ''), 'normal'),
        NULLIF(p_task ->> 'due_at', '')::timestamptz,
        NULLIF(p_task ->> 'assigned_to', '')::uuid,
        CASE WHEN NULLIF(p_task ->> 'assigned_to', '') IS NULL THEN NULL ELSE NULLIF(p_task ->> 'assigned_to_name', '') END,
        v_call.customer_id,
        v_lead_id
      )
      RETURNING id INTO v_task_id;
      v_created := true;
    END IF;
  ELSIF public.call_disposition_requires_follow_up(p_outcome) AND v_task_id IS NULL THEN
    RAISE EXCEPTION 'follow_up_required' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.call_dispositions (user_id, call_id, outcome, source, note, follow_up_task_id, set_by)
  VALUES (v_call.user_id, p_call_id, p_outcome, 'staff', v_note, v_task_id, auth.uid())
  ON CONFLICT (call_id) DO UPDATE
    SET outcome = EXCLUDED.outcome,
        source = 'staff',
        note = EXCLUDED.note,
        follow_up_task_id = EXCLUDED.follow_up_task_id,
        set_by = EXCLUDED.set_by
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('disposition', to_jsonb(v_row), 'task_created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.set_call_disposition(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_call_disposition(uuid, text, text, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- call_disposition_summary(): server-side aggregation for Analytics.
-- Done in SQL so large accounts are never truncated by the API row cap.
-- SECURITY INVOKER -> counts only what the caller's RLS lets them see
-- (a teammate who cannot see someone else's task simply gets task counts of 0 for it).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.call_disposition_summary(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'invalid_range' USING ERRCODE = '22023';
  END IF;

  WITH scoped AS (
    SELECT
      c.id AS call_id,
      d.outcome,
      d.source,
      d.ai_outcome,
      d.follow_up_task_id,
      (t.status = 'done') AS task_done
    FROM public.calls c
    LEFT JOIN public.call_dispositions d ON d.call_id = c.id
    LEFT JOIN public.tasks t ON t.id = d.follow_up_task_id
    WHERE c.call_datetime >= p_from AND c.call_datetime <= p_to
  ),
  by_outcome AS (
    SELECT
      outcome,
      count(*) AS total,
      count(*) FILTER (WHERE source = 'ai') AS ai_count,
      count(*) FILTER (WHERE follow_up_task_id IS NOT NULL) AS with_task,
      count(*) FILTER (WHERE task_done) AS tasks_done
    FROM scoped
    WHERE outcome IS NOT NULL
    GROUP BY outcome
  )
  SELECT jsonb_build_object(
    'total_calls', (SELECT count(*) FROM scoped),
    'tagged', (SELECT count(*) FROM scoped WHERE outcome IS NOT NULL),
    'ai_reviewed', (SELECT count(*) FROM scoped WHERE source = 'staff' AND ai_outcome IS NOT NULL),
    'ai_agreed', (SELECT count(*) FROM scoped WHERE source = 'staff' AND ai_outcome IS NOT NULL AND outcome = ai_outcome),
    'by_outcome', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.total DESC) FROM by_outcome b), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.call_disposition_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.call_disposition_summary(timestamptz, timestamptz) TO authenticated;
