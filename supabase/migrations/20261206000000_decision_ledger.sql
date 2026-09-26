/*
  # Decision Ledger

  ## Why
  business_decisions (20260928000000) captures the RECOMMENDATION only —
  once approved/rejected the trail goes cold. This table is the full
  audit ledger of a decision's entire life: Recommendation + Evidence
  -> Approval -> Action -> real measured Outcome, with an append-only
  `timeline` so every stage transition is permanently recorded (who,
  when, why). Works for AI-engine decisions (linked_decision_id set)
  and purely manual decisions (linked_decision_id null) alike.

  All stage transitions go through SECURITY DEFINER functions below so
  the timeline can never be edited or skipped from the client — only
  appended to, in order.
*/

CREATE TABLE IF NOT EXISTS decision_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  linked_decision_id uuid REFERENCES business_decisions(id) ON DELETE SET NULL,

  title text NOT NULL,
  category text NOT NULL DEFAULT 'operations'
    CHECK (category IN ('pricing', 'dispatch', 'staffing', 'marketing', 'collections', 'retention', 'operations', 'custom')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('ai_recommendation', 'agent', 'manual')),

  /* Recommendation + Evidence */
  recommendation text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  confidence_score numeric(5, 2) CHECK (confidence_score IS NULL OR (confidence_score BETWEEN 0 AND 100)),
  expected_impact numeric(12, 2),

  status text NOT NULL DEFAULT 'recommended'
    CHECK (status IN ('recommended', 'approved', 'rejected', 'action_taken', 'outcome_recorded', 'expired')),

  /* Approval */
  approved_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approval_notes text,

  /* Action */
  action_taken text,
  action_taken_at timestamptz,
  action_taken_by uuid REFERENCES team_members(id) ON DELETE SET NULL,

  /* Real Outcome */
  actual_outcome_value numeric(12, 2),
  outcome_recorded_at timestamptz,
  outcome_notes text,

  /* Append-only audit trail: [{ at, stage, note }, ...] — written only by the functions below */
  timeline jsonb NOT NULL DEFAULT '[]',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_ledger_entries_user_status
  ON decision_ledger_entries(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_ledger_entries_linked_decision
  ON decision_ledger_entries(linked_decision_id) WHERE linked_decision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_decision_ledger_entries_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_decision_ledger_entries_touch ON decision_ledger_entries;
CREATE TRIGGER trg_decision_ledger_entries_touch
  BEFORE UPDATE ON decision_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_decision_ledger_entries_updated_at();

ALTER TABLE decision_ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_decision_ledger_entries" ON decision_ledger_entries;
CREATE POLICY "select_own_decision_ledger_entries" ON decision_ledger_entries
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_decision_ledger_entries" ON decision_ledger_entries;
CREATE POLICY "insert_own_decision_ledger_entries" ON decision_ledger_entries
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
-- عمداً UPDATE policy عمومی نیست — تغییر status/approval/action/outcome فقط از طریق
-- functionهای SECURITY DEFINER پایین انجام می‌شود تا timeline هرگز دستکاری نشود.
DROP POLICY IF EXISTS "delete_own_decision_ledger_entries" ON decision_ledger_entries;
CREATE POLICY "delete_own_decision_ledger_entries" ON decision_ledger_entries
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- =============================================================
-- FUNCTIONS (تنها راه رسمی approve / reject / action / outcome)
-- =============================================================

CREATE OR REPLACE FUNCTION public.approve_decision_ledger_entry(p_id uuid, p_approved_by uuid, p_notes text)
RETURNS decision_ledger_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row decision_ledger_entries;
BEGIN
  UPDATE decision_ledger_entries
  SET status = 'approved',
      approved_by = p_approved_by,
      approved_at = now(),
      approval_notes = NULLIF(btrim(p_notes), ''),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'approved', 'note', NULLIF(btrim(p_notes), '')))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'recommended'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found, not yours, or not in a state that can be approved'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_decision_ledger_entry(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_decision_ledger_entry(p_id uuid, p_notes text)
RETURNS decision_ledger_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row decision_ledger_entries;
BEGIN
  UPDATE decision_ledger_entries
  SET status = 'rejected',
      approval_notes = NULLIF(btrim(p_notes), ''),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'rejected', 'note', NULLIF(btrim(p_notes), '')))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'recommended'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found, not yours, or not in a state that can be rejected'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_decision_ledger_entry(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_decision_ledger_action(p_id uuid, p_action_taken text, p_action_taken_by uuid)
RETURNS decision_ledger_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row decision_ledger_entries;
BEGIN
  UPDATE decision_ledger_entries
  SET status = 'action_taken',
      action_taken = btrim(p_action_taken),
      action_taken_at = now(),
      action_taken_by = p_action_taken_by,
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'action_taken', 'note', btrim(p_action_taken)))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'approved'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found, not yours, or not approved yet'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_decision_ledger_action(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_decision_ledger_outcome(p_id uuid, p_actual_outcome_value numeric, p_notes text)
RETURNS decision_ledger_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row decision_ledger_entries;
BEGIN
  UPDATE decision_ledger_entries
  SET status = 'outcome_recorded',
      actual_outcome_value = p_actual_outcome_value,
      outcome_recorded_at = now(),
      outcome_notes = NULLIF(btrim(p_notes), ''),
      timeline = timeline || jsonb_build_array(jsonb_build_object('at', now(), 'stage', 'outcome_recorded', 'note', NULLIF(btrim(p_notes), '')))
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'action_taken'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found, not yours, or no action recorded yet'; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_decision_ledger_outcome(uuid, numeric, text) TO authenticated;
