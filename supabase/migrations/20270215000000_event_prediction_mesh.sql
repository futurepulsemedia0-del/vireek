/*
  # Event Prediction Mesh

  The Event Bus tells you what happened. The Event Prediction Mesh forecasts
  which events are likely to happen next (demand spike, parts shortage,
  dispatch pressure, SLA breach, customer escalation) and proposes
  preemptive actions a human approves before the event occurs.

  ## What this adds (additive only — no existing table is altered)
  - prediction_mesh_runs         one row per forecast run (signals snapshot + signature)
  - prediction_mesh_predictions  one row per forecast event, later resolved
                                 with what actually happened (calibration)
  - prediction_mesh_actions      preemptive actions: proposed -> approved /
                                 dismissed / completed (or superseded by a newer run)
  - decide_prediction_action()   SECURITY DEFINER RPC: records the decision,
                                 appends to business_activity_events and
                                 notifies the account owner on approval

  All tables are tenant-scoped with RLS on public.get_account_owner_id(),
  matching the rest of the schema.
*/

-- =============================================================
-- RUNS
-- =============================================================
CREATE TABLE IF NOT EXISTS prediction_mesh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  engine_version text NOT NULL,
  horizon_hours integer NOT NULL CHECK (horizon_hours BETWEEN 6 AND 336),
  data_coverage numeric(4,2) NOT NULL CHECK (data_coverage BETWEEN 0 AND 1),
  unavailable_sources text[] NOT NULL DEFAULT '{}',
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prediction_mesh_runs_user ON prediction_mesh_runs(user_id, created_at DESC);

ALTER TABLE prediction_mesh_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_prediction_mesh_runs" ON prediction_mesh_runs;
CREATE POLICY "select_own_prediction_mesh_runs" ON prediction_mesh_runs FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_prediction_mesh_runs" ON prediction_mesh_runs;
CREATE POLICY "insert_own_prediction_mesh_runs" ON prediction_mesh_runs FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());

-- =============================================================
-- PREDICTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS prediction_mesh_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES prediction_mesh_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  event_kind text NOT NULL CHECK (event_kind IN (
    'demand_spike', 'parts_shortage', 'dispatch_pressure', 'sla_breach', 'customer_escalation'
  )),
  probability numeric(5,4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  base_probability numeric(5,4) NOT NULL CHECK (base_probability BETWEEN 0 AND 1),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  level text NOT NULL CHECK (level IN ('low', 'elevated', 'high', 'critical')),
  drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  cascade jsonb NOT NULL DEFAULT '[]'::jsonb,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  observed boolean,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prediction_mesh_predictions_window CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS idx_prediction_mesh_predictions_run ON prediction_mesh_predictions(run_id);
CREATE INDEX IF NOT EXISTS idx_prediction_mesh_predictions_user ON prediction_mesh_predictions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_mesh_predictions_unresolved
  ON prediction_mesh_predictions(user_id, window_end) WHERE resolved_at IS NULL;

ALTER TABLE prediction_mesh_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_prediction_mesh_predictions" ON prediction_mesh_predictions;
CREATE POLICY "select_own_prediction_mesh_predictions" ON prediction_mesh_predictions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_prediction_mesh_predictions" ON prediction_mesh_predictions;
CREATE POLICY "insert_own_prediction_mesh_predictions" ON prediction_mesh_predictions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM prediction_mesh_runs r WHERE r.id = run_id AND r.user_id = public.get_account_owner_id())
  );
-- Only the outcome columns may change, and only once the window has closed.
DROP POLICY IF EXISTS "resolve_own_prediction_mesh_predictions" ON prediction_mesh_predictions;
CREATE POLICY "resolve_own_prediction_mesh_predictions" ON prediction_mesh_predictions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND resolved_at IS NULL AND window_end <= now())
  WITH CHECK (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.guard_prediction_mesh_prediction_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.event_kind IS DISTINCT FROM OLD.event_kind
     OR NEW.probability IS DISTINCT FROM OLD.probability
     OR NEW.base_probability IS DISTINCT FROM OLD.base_probability
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.level IS DISTINCT FROM OLD.level
     OR NEW.drivers IS DISTINCT FROM OLD.drivers
     OR NEW.cascade IS DISTINCT FROM OLD.cascade
     OR NEW.window_start IS DISTINCT FROM OLD.window_start
     OR NEW.window_end IS DISTINCT FROM OLD.window_end THEN
    RAISE EXCEPTION 'prediction_mesh_predictions: forecast fields are immutable; only the outcome may be recorded';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_prediction_mesh_prediction_update ON prediction_mesh_predictions;
CREATE TRIGGER trg_guard_prediction_mesh_prediction_update
  BEFORE UPDATE ON prediction_mesh_predictions
  FOR EACH ROW EXECUTE FUNCTION public.guard_prediction_mesh_prediction_update();

-- =============================================================
-- ACTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS prediction_mesh_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES prediction_mesh_runs(id) ON DELETE CASCADE,
  event_kind text NOT NULL CHECK (event_kind IN (
    'demand_spike', 'parts_shortage', 'dispatch_pressure', 'sla_breach', 'customer_escalation'
  )),
  action_key text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  href text NOT NULL,
  urgency text NOT NULL CHECK (urgency IN ('now', 'today', 'this_week')),
  probability numeric(5,4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'dismissed', 'completed', 'superseded')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prediction_mesh_actions_user ON prediction_mesh_actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_mesh_actions_open
  ON prediction_mesh_actions(user_id, action_key) WHERE status = 'proposed';

ALTER TABLE prediction_mesh_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_prediction_mesh_actions" ON prediction_mesh_actions;
CREATE POLICY "select_own_prediction_mesh_actions" ON prediction_mesh_actions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_prediction_mesh_actions" ON prediction_mesh_actions;
CREATE POLICY "insert_own_prediction_mesh_actions" ON prediction_mesh_actions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND status = 'proposed'
    AND EXISTS (SELECT 1 FROM prediction_mesh_runs r WHERE r.id = run_id AND r.user_id = public.get_account_owner_id())
  );
-- Direct updates are limited to superseding stale proposals; real decisions go through the RPC.
DROP POLICY IF EXISTS "supersede_own_prediction_mesh_actions" ON prediction_mesh_actions;
CREATE POLICY "supersede_own_prediction_mesh_actions" ON prediction_mesh_actions FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND status = 'proposed')
  WITH CHECK (user_id = public.get_account_owner_id() AND status = 'superseded');

-- =============================================================
-- DECISION RPC
-- =============================================================
CREATE OR REPLACE FUNCTION public.decide_prediction_action(
  p_action_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS prediction_mesh_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row prediction_mesh_actions;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'decide_prediction_action: not authenticated';
  END IF;
  IF p_decision NOT IN ('approved', 'dismissed', 'completed') THEN
    RAISE EXCEPTION 'decide_prediction_action: invalid decision %', p_decision;
  END IF;

  SELECT * INTO v_row FROM prediction_mesh_actions
   WHERE id = p_action_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_prediction_action: action not found';
  END IF;

  -- proposed -> approved | dismissed ; approved -> completed
  IF NOT (
    (v_row.status = 'proposed' AND p_decision IN ('approved', 'dismissed'))
    OR (v_row.status = 'approved' AND p_decision = 'completed')
  ) THEN
    RAISE EXCEPTION 'decide_prediction_action: cannot move from % to %', v_row.status, p_decision;
  END IF;

  UPDATE prediction_mesh_actions
     SET status = p_decision,
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_action_id
   RETURNING * INTO v_row;

  PERFORM public.append_activity_event(
    'prediction_mesh_action',
    v_row.id,
    'preemptive_action_' || p_decision,
    jsonb_build_object(
      'event_kind', v_row.event_kind,
      'action_key', v_row.action_key,
      'probability', v_row.probability,
      'note', v_row.decision_note
    ),
    'user',
    NULL, NULL, '{}'::jsonb,
    v_owner
  );

  IF p_decision = 'approved' THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      v_owner,
      'prediction_mesh',
      'Preemptive action approved',
      v_row.title,
      v_row.href
    );
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_prediction_action(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_prediction_action(uuid, text, text) TO authenticated;
