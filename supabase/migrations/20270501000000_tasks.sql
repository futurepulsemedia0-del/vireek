/*
  # Tasks (/dashboard/tasks)

  Team to-dos with assignee, due date, priority, recurrence, reminders and
  optional links to a customer / job / lead.

  ## Access model (enforced here, not just in the UI)
  - Everything is scoped to the account: user_id = public.get_account_owner_id().
  - Managers (account owner, or a team member whose effective can_view_all_jobs
    is true — custom role overrides the base flag, same as AuthContext) see and
    manage every task in the account and may assign to anyone.
  - Everyone else sees only tasks assigned to them, plus unassigned tasks they
    created, and can only assign to themselves or leave unassigned.
  - Linked customer/job/lead must be visible to the writer (RLS of those tables).

  ## Recurrence
  Completing a recurring task goes through public.complete_task(), which in ONE
  transaction marks it done and creates the next occurrence. The client supplies
  the next due date (single tested implementation in src/lib/tasks.ts); the
  function locks the row, so a double click can never create two copies.

  ## Reminders
  Stored as reminder_offset_minutes before due. They are surfaced in-app only
  (the notifications table is account-wide and also fans out push to every
  device, so writing task titles there would leak them to the whole team).

  Requires: get_account_owner_id(), team_members(user_id, permissions,
  custom_role_id), custom_roles(permissions), profiles, customers, jobs, leads.
*/

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to_name text,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz,
  reminder_offset_minutes integer CHECK (reminder_offset_minutes IS NULL OR reminder_offset_minutes BETWEEN 0 AND 43200),
  recurrence text NOT NULL DEFAULT 'none'
    CHECK (recurrence IN ('none', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  recurrence_ends_on date,
  recurrence_parent_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_recurrence_needs_due CHECK (recurrence = 'none' OR due_at IS NOT NULL),
  CONSTRAINT tasks_reminder_needs_due CHECK (reminder_offset_minutes IS NULL OR due_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due ON public.tasks (user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_open ON public.tasks (assigned_to, due_at) WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS idx_tasks_user_completed ON public.tasks (user_id, completed_at DESC) WHERE status = 'done';
CREATE INDEX IF NOT EXISTS idx_tasks_customer_id ON public.tasks (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON public.tasks (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_lead_id ON public.tasks (lead_id) WHERE lead_id IS NOT NULL;
-- One next-occurrence per task: makes re-completing a reopened task idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_child_per_parent
  ON public.tasks (recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Integrity trigger: trims title, locks ownership columns, owns completed_at.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tasks_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.title := btrim(NEW.title);

  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    IF NEW.status = 'done' THEN
      NEW.completed_at := CASE WHEN OLD.status = 'done' THEN OLD.completed_at ELSE now() END;
    ELSE
      NEW.completed_at := NULL;
    END IF;
  ELSE
    NEW.completed_at := CASE WHEN NEW.status = 'done' THEN COALESCE(NEW.completed_at, now()) ELSE NULL END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tasks_before_write ON public.tasks;
CREATE TRIGGER trigger_tasks_before_write
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.tasks_before_write();

-- ---------------------------------------------------------------------------
-- Manager check (mirrors AuthContext: custom role overrides base permission).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tasks_can_view_all()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    NOT EXISTS (SELECT 1 FROM team_members m WHERE m.user_id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM team_members m
      LEFT JOIN custom_roles cr ON cr.id = m.custom_role_id
      WHERE m.user_id = auth.uid()
        AND COALESCE(
          (cr.permissions ->> 'can_view_all_jobs')::boolean,
          (m.permissions ->> 'can_view_all_jobs')::boolean,
          false
        )
    );
$$;

REVOKE ALL ON FUNCTION public.tasks_can_view_all() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tasks_can_view_all() TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (
      public.tasks_can_view_all()
      OR assigned_to = auth.uid()
      OR (assigned_to IS NULL AND created_by = auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks_insert" ON public.tasks;
CREATE POLICY "tasks_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND (
      public.tasks_can_view_all()
      OR assigned_to = auth.uid()
      OR assigned_to IS NULL
    )
    AND (customer_id IS NULL OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = customer_id))
    AND (job_id IS NULL OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_id))
    AND (lead_id IS NULL OR EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id))
  );

DROP POLICY IF EXISTS "tasks_update" ON public.tasks;
CREATE POLICY "tasks_update" ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (
      public.tasks_can_view_all()
      OR assigned_to = auth.uid()
      OR (assigned_to IS NULL AND created_by = auth.uid())
    )
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (
      public.tasks_can_view_all()
      OR assigned_to = auth.uid()
      OR (assigned_to IS NULL AND created_by = auth.uid())
    )
    AND (customer_id IS NULL OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = customer_id))
    AND (job_id IS NULL OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_id))
    AND (lead_id IS NULL OR EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id))
  );

DROP POLICY IF EXISTS "tasks_delete" ON public.tasks;
CREATE POLICY "tasks_delete" ON public.tasks
  FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.tasks_can_view_all() OR created_by = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- complete_task(): atomic "mark done + spawn next occurrence".
-- SECURITY INVOKER on purpose — every statement runs under the caller's RLS.
-- Returns the new task id, or NULL when nothing was spawned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_task(p_task_id uuid, p_next_due_at timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task public.tasks;
  v_new_id uuid;
BEGIN
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_task.status = 'done' THEN
    RETURN NULL; -- already completed (double click / second device)
  END IF;

  UPDATE public.tasks SET status = 'done' WHERE id = p_task_id;

  IF v_task.recurrence <> 'none'
     AND v_task.due_at IS NOT NULL
     AND p_next_due_at IS NOT NULL
     AND p_next_due_at > v_task.due_at THEN
    INSERT INTO public.tasks (
      assigned_to, assigned_to_name, title, description, status, priority,
      due_at, reminder_offset_minutes, recurrence, recurrence_ends_on,
      recurrence_parent_id, customer_id, job_id, lead_id
    )
    VALUES (
      v_task.assigned_to, v_task.assigned_to_name, v_task.title, v_task.description, 'todo', v_task.priority,
      p_next_due_at, v_task.reminder_offset_minutes, v_task.recurrence, v_task.recurrence_ends_on,
      v_task.id, v_task.customer_id, v_task.job_id, v_task.lead_id
    )
    ON CONFLICT (recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_new_id;
  END IF;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_task(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_task(uuid, timestamptz) TO authenticated;
