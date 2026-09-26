/*
  # Autonomous Operations Center

  ## Why
  A real ops center owns a problem end-to-end: Detection -> Root Cause
  -> Action + Owner -> Execution -> real Outcome — and tracks recurrence
  when a "resolved" problem comes back. decision_ledger_entries
  (20261206000000) tracks DECISIONS (recommend/approve/act/outcome);
  this tracks operational PROBLEMS (detect/diagnose/assign/execute/
  resolve). The two are complementary, not overlapping, and can be
  cross-linked via linked_ledger_entry_id.

  All lifecycle transitions go through SECURITY DEFINER functions below
  so status can't skip stages or be edited out of order from the client,
  and every transition is permanently appended to `timeline`.
*/

CREATE TABLE IF NOT EXISTS operations_center_problems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  linked_ledger_entry_id uuid REFERENCES decision_ledger_entries(id) ON DELETE SET NULL,
  recurrence_of_id uuid REFERENCES operations_center_problems(id) ON DELETE SET NULL,

  title text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'custom'
    CHECK (category IN ('dispatch', 'staffing', 'quality', 'customer', 'vendor', 'system', 'safety', 'financial', 'custom')),
  severity text NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('auto', 'agent', 'manual')),

  status text NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected', 'root_cause_identified', 'action_assigned', 'in_execution', 'resolved', 'reopened')),

  detected_at timestamptz NOT NULL DEFAULT now(),

  /* Root Cause */
  root_cause text,
  root_cause_category text,
  root_cause_identified_at timestamptz,

  /* Action + Owner */
  action_plan text,
  owner_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  action_assigned_at timestamptz,

  /* Execution */
  execution_started_at timestamptz,

  /* Outcome */
  outcome_status text CHECK (outcome_status IS NULL OR outcome_status IN ('resolved', 'partially_resolved', 'unresolved')),
  outcome_notes text,
  outcome_recorded_at timestamptz,

  /* Append-only audit trail: [{ at, stage, note }, ...] — written only by the functions below */
  timeline jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_center_problems_user_status
  ON operations_center_problems(user_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_center_problems_recurrence
  ON operations_center_problems(recurrence_of_id) WHERE recurrence_of_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_ops_center_problems_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_center_problems_touch ON operations_center_problems;
CREATE TRIGGER trg_ops_center_problems_touch
  BEFORE UPDATE ON operations_center_problems
  FOR EACH ROW EXECUTE FUNCTION public.touch_ops_center_problems_updated_at();

ALTER TABLE operations_center_problems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ops_center_problems" ON operations_center_problems;
CREATE POLICY "select_own_ops_center_problems" ON operations_center_problems
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_ops_center_problems" ON operations_center_problems;
CREATE POLICY "insert_own_ops_center_problems" ON operations_center_problems
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
-- عمداً UPDATE policy عمومی نیست — تغییر stage فقط از طریق functionهای
-- SECURITY DEFINER پایین انجام می‌شود تا ترتیب مراحل و timeline دستکاری نشود.
DROP POLICY IF EXISTS "delete_own_ops_center_problems" ON operations_center_problems;
CREATE POLICY "delete_own_ops_center_problems" ON operations_center_problems
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FUNCTIONS (تنها راه رسمی پیشروی در چرخه: root cause -> action/owner -> execution -> outcome)
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_ops_problem_root_cause(p_id uuid, p_root_cause text, p_root_cause_category text)
RETURNS operations_center_problems
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row operations_center_problems;
BEGIN
  UPDATE operations_center_problems
  SET status = 'root_cause_identified',
      root_cause = btrim(p_root_cause),
      root_cause_category = p_root_cause_category,
      root_cause_identified_at = now(),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'root_cause_identified', 'note', btrim(p_root_cause)))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'detected'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Problem not found, not yours, or not awaiting root cause'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ops_problem_root_cause(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_ops_problem_action_owner(p_id uuid, p_action_plan text, p_owner_id uuid)
RETURNS operations_center_problems
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row operations_center_problems;
BEGIN
  UPDATE operations_center_problems
  SET status = 'action_assigned',
      action_plan = btrim(p_action_plan),
      owner_id = p_owner_id,
      action_assigned_at = now(),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'action_assigned', 'note', btrim(p_action_plan)))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'root_cause_identified'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Problem not found, not yours, or root cause not identified yet'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_ops_problem_action_owner(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_ops_problem_execution(p_id uuid)
RETURNS operations_center_problems
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row operations_center_problems;
BEGIN
  UPDATE operations_center_problems
  SET status = 'in_execution',
      execution_started_at = now(),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'in_execution', 'note', null))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'action_assigned'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Problem not found, not yours, or no action assigned yet'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.start_ops_problem_execution(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_ops_problem_outcome(p_id uuid, p_outcome_status text, p_notes text)
RETURNS operations_center_problems
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row operations_center_problems;
  v_next_status text;
BEGIN
  IF p_outcome_status NOT IN ('resolved', 'partially_resolved', 'unresolved') THEN
    RAISE EXCEPTION 'Invalid outcome_status';
  END IF;
  v_next_status := CASE WHEN p_outcome_status = 'unresolved' THEN 'reopened' ELSE 'resolved' END;

  UPDATE operations_center_problems
  SET status = v_next_status,
      outcome_status = p_outcome_status,
      outcome_notes = NULLIF(btrim(p_notes), ''),
      outcome_recorded_at = now(),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', v_next_status, 'note', NULLIF(btrim(p_notes), '')))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'in_execution'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Problem not found, not yours, or not in execution yet'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ops_problem_outcome(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_ops_problem(p_id uuid, p_reason text)
RETURNS operations_center_problems
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row operations_center_problems;
BEGIN
  UPDATE operations_center_problems
  SET status = 'action_assigned',
      execution_started_at = NULL,
      outcome_status = NULL,
      outcome_notes = NULL,
      outcome_recorded_at = NULL,
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'reopened', 'note', btrim(p_reason)))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status IN ('resolved', 'reopened')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Problem not found, not yours, or not in a resolved state'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_ops_problem(uuid, text) TO authenticated;
