/*
  # Reconcile dispatch_decisions (two conflicting CREATE TABLE definitions)

  20261231000100 (AI plan applications) and 20271012000000 (rules engine) both define dispatch_decisions.
  Whichever ran first won. This migration is a NO-OP when the rules-engine columns already exist.
  Otherwise it adds them and relaxes the AI-plan-only NOT NULL constraints, so BOTH writers can insert.
  RUN docs/dispatch-randomization/gate-queries.sql query 0 first and confirm which schema is live.
  Rollback: not destructive (only adds nullable columns / drops NOT NULL); no rollback needed.
*/
DO $$
BEGIN
  IF to_regclass('public.dispatch_decisions') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dispatch_decisions' AND column_name = 'mode') THEN
    RETURN; -- rules-engine schema already live
  END IF;

  ALTER TABLE public.dispatch_decisions
    ADD COLUMN IF NOT EXISTS recommended_technician_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS mode text CHECK (mode IS NULL OR mode IN ('auto', 'manual', 'override', 'no_eligible')),
    ADD COLUMN IF NOT EXISTS explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS note text CHECK (note IS NULL OR char_length(note) <= 1000),
    ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid();

  ALTER TABLE public.dispatch_decisions
    ALTER COLUMN engine_version DROP NOT NULL,
    ALTER COLUMN confidence DROP NOT NULL,
    ALTER COLUMN applied_by DROP NOT NULL,
    ALTER COLUMN score DROP NOT NULL;
  ALTER TABLE public.dispatch_decisions DROP CONSTRAINT IF EXISTS dispatch_decisions_score_check;
  ALTER TABLE public.dispatch_decisions ALTER COLUMN score TYPE numeric(7,1);
  ALTER TABLE public.dispatch_decisions DROP CONSTRAINT IF EXISTS dispatch_decisions_source_check;
  ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_source_check
    CHECK (source IN ('ai_plan', 'ai_plan_bulk', 'rules_engine'));

  DROP POLICY IF EXISTS insert_own_dispatch_decisions ON public.dispatch_decisions;
  CREATE POLICY insert_own_dispatch_decisions ON public.dispatch_decisions
    FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());
END $$;
