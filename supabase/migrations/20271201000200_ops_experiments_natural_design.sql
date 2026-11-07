/*
  # Experiment design "natural" (near-tie randomization)

  Adds 'natural' to ops_experiments.design. A natural experiment has NO job assignments of its own:
  the draws are made by dispatch (dispatch_decisions.explanation.randomization). Only technician GROUPS
  (treatment / control) are stored, exactly like the 'comparison' design, while the experiment is a draft.
  Depends on: 20270210000000_operational_experimentation.sql.
  Rollback: re-add the old CHECK (only possible if no row uses 'natural') and the old policy text.
*/
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.ops_experiments'::regclass AND con.contype = 'c' AND a.attname = 'design'
  LOOP
    EXECUTE format('ALTER TABLE public.ops_experiments DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.ops_experiments ADD CONSTRAINT ops_experiments_design_check CHECK (design IN ('randomized', 'comparison', 'natural'));

DROP POLICY IF EXISTS "ops_experiment_assignments_insert" ON ops_experiment_assignments;
CREATE POLICY "ops_experiment_assignments_insert" ON ops_experiment_assignments FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.ops_experiments_is_manager()
    AND (
      (
        unit_type = 'job'
        AND EXISTS (
          SELECT 1 FROM ops_experiments e
          WHERE e.id = experiment_id AND e.account_owner_id = public.get_account_owner_id()
            AND e.design = 'randomized' AND e.status = 'running'
        )
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = unit_id AND j.user_id = public.get_account_owner_id())
      )
      OR (
        unit_type = 'technician'
        AND EXISTS (
          SELECT 1 FROM ops_experiments e
          WHERE e.id = experiment_id AND e.account_owner_id = public.get_account_owner_id()
            AND e.design IN ('comparison', 'natural') AND e.status = 'draft'
        )
        AND EXISTS (SELECT 1 FROM team_members m WHERE m.id = unit_id AND m.account_owner_id = public.get_account_owner_id())
      )
    )
  );

-- Owner-facing read access to the draws made for THIS account (dispatch_decisions already has account-scoped RLS;
-- this index makes the analysis query (auto decisions with a randomization record, by time) cheap.
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_rz
  ON dispatch_decisions (user_id, created_at DESC)
  WHERE mode = 'auto' AND explanation ? 'randomization';
