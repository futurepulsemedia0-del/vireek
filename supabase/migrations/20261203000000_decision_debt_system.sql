/*
  # Decision Debt System

  ## Why
  "Technical debt" for decisions: every decision or action the owner
  knows needs to happen but keeps postponing quietly costs money and
  operational health every single day it sits open — a discount policy
  nobody finalized, a broken process nobody fixed, a vendor contract
  nobody renegotiated. This table tracks those items explicitly and
  turns the delay into a running dollar figure, so "we'll get to it"
  has a visible price tag instead of hiding as an invisible cost.

  All accrual math (days outstanding x daily cost, severity-weighted
  operational debt) runs client-side in src/lib/decisionDebt.ts — this
  table only persists the item itself. Nothing here duplicates
  business_decisions (20260928000000_business_decision_engine.sql),
  which recommends what to decide; this tracks what was NOT decided
  and what that inaction is costing.
*/

CREATE TABLE IF NOT EXISTS decision_debt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),

  title text NOT NULL,
  description text,

  category text NOT NULL DEFAULT 'custom'
    CHECK (category IN ('pricing', 'staffing', 'process', 'customer', 'vendor', 'marketing', 'equipment', 'policy', 'custom')),

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'abandoned')),

  operational_severity text NOT NULL DEFAULT 'medium'
    CHECK (operational_severity IN ('low', 'medium', 'high', 'critical')),

  /* Owner's own estimate of what one day of inaction costs, in dollars */
  daily_financial_cost numeric(12, 2) NOT NULL DEFAULT 0 CHECK (daily_financial_cost >= 0),

  /* When this was first flagged as a stalled decision — accrual clock starts here */
  identified_at timestamptz NOT NULL DEFAULT now(),
  /* Optional self-imposed deadline; days past this also feed the "overdue" view */
  decision_needed_by date,

  /* Optional link to the AI recommender this item stalled out of */
  linked_decision_id uuid REFERENCES business_decisions(id) ON DELETE SET NULL,

  resolution_notes text,
  resolved_at timestamptz,

  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_debt_items_user_status
  ON decision_debt_items(user_id, status, identified_at DESC);

CREATE OR REPLACE FUNCTION public.touch_decision_debt_items_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_decision_debt_items_touch ON decision_debt_items;
CREATE TRIGGER trg_decision_debt_items_touch
  BEFORE UPDATE ON decision_debt_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_decision_debt_items_updated_at();

ALTER TABLE decision_debt_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_decision_debt_items" ON decision_debt_items;
CREATE POLICY "select_own_decision_debt_items" ON decision_debt_items
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_decision_debt_items" ON decision_debt_items;
CREATE POLICY "insert_own_decision_debt_items" ON decision_debt_items
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_decision_debt_items" ON decision_debt_items;
CREATE POLICY "update_own_decision_debt_items" ON decision_debt_items
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_decision_debt_items" ON decision_debt_items;
CREATE POLICY "delete_own_decision_debt_items" ON decision_debt_items
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
