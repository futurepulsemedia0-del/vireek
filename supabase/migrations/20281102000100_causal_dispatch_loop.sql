/*
  # Causal Dispatch Loop — Phase 1 (logging) + Phase 2 (per-account flag)

  ## Why
  Technician effects are confounded in observational dispatch data (best techs get the hardest jobs).
  We randomize ONLY inside an "indifference set" of near-equal, already-eligible technicians and log
  the true assignment probability (propensity) so effects can later be estimated causally.

  ## Live-schema reconciliation (important)
  `dispatch_decisions` is defined twice:
    - 20261231000100_dispatch_intelligence.sql  (runs first -> this is the LIVE shape)
    - 20271012000000_dispatch_rules_engine.sql  (CREATE TABLE IF NOT EXISTS -> a silent no-op)
  The rules engine writes mode / explanation / recommended_technician_id / note, which do not exist on
  the live shape, and it omits NOT NULL columns (engine_version, confidence, applied_by, score range).
  Its inserts therefore failed silently. This migration makes the live table satisfy BOTH writers:
    - adds the missing columns (IF NOT EXISTS, so it is a no-op on a database that already has them),
    - relaxes NOT NULL on columns only one of the writers can fill,
    - widens `score` smallint(0-100) -> numeric(7,1) (lossless; rules scores are points, not 0-100),
    - extends the `source` check with 'rules_engine'.
  Existing rows are untouched (new `mode` defaults to 'manual', which is what an applied AI plan is).

  ## Phase 1 columns (all nullable — old rows and non-randomized writers stay valid)
    propensity       P(this technician | context) under the policy that was running, in (0,1]
    indifference_set jsonb: {top_id, reason, q, k, delta, members:[{id,score,ftf,p,f}]}
    set_size         number of technicians in the set (0 = none eligible)
    arm              'exploit' (deterministic / not enrolled) | 'explore' (randomized pick)
    policy_version   which selector produced the row (e.g. 'cdl-1')

  ## Append-only
  RLS still has no UPDATE/DELETE policy for users. A trigger now also blocks UPDATE for the service
  role, except the FK action ON DELETE SET NULL on technician_id / recommended_technician_id (deleting
  a team member must keep working). Cascade deletes (job/profile removed) are not affected.

  ## Phase 2 table
  dispatch_exploration_settings — one row per account. Everything defaults OFF. Reads: any account
  member; writes: time_off_can_manage() (same gate as dispatch_rules). The edge function (service
  role) may also switch an account off when a guardrail is breached.

  ## Rollback
    DROP TRIGGER IF EXISTS trg_dispatch_decisions_append_only ON dispatch_decisions;
    DROP FUNCTION IF EXISTS public.dispatch_decisions_append_only();
    DROP TABLE IF EXISTS dispatch_exploration_settings;
    (the new decision columns are nullable and may simply be left in place.)
*/
-- lint:allow-destructive smallint->numeric widening is lossless; only relaxes NOT NULL/CHECK; no data removed

-- =============================================================
-- 1. Reconcile dispatch_decisions with what the rules engine writes
-- =============================================================
ALTER TABLE dispatch_decisions
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS recommended_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS created_by uuid DEFAULT auth.uid(),
  ADD COLUMN IF NOT EXISTS propensity numeric,
  ADD COLUMN IF NOT EXISTS indifference_set jsonb,
  ADD COLUMN IF NOT EXISTS set_size integer,
  ADD COLUMN IF NOT EXISTS arm text,
  ADD COLUMN IF NOT EXISTS policy_version text;

DO $$
DECLARE
  col text;
BEGIN
  -- Columns that only one of the two writers can fill must not be NOT NULL.
  FOREACH col IN ARRAY ARRAY['engine_version', 'score', 'confidence', 'applied_by'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dispatch_decisions' AND column_name = col AND is_nullable = 'NO'
    ) THEN
      EXECUTE format('ALTER TABLE public.dispatch_decisions ALTER COLUMN %I DROP NOT NULL', col);
    END IF;
  END LOOP;

  -- score: smallint 0..100 (intelligence) -> numeric(7,1) points (rules engine).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dispatch_decisions' AND column_name = 'score' AND data_type = 'smallint'
  ) THEN
    ALTER TABLE public.dispatch_decisions DROP CONSTRAINT IF EXISTS dispatch_decisions_score_check;
    ALTER TABLE public.dispatch_decisions ALTER COLUMN score TYPE numeric(7,1) USING score::numeric(7,1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_score_range') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_score_range CHECK (score IS NULL OR score BETWEEN -1000 AND 1000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_mode_check') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_mode_check CHECK (mode IN ('auto', 'manual', 'override', 'no_eligible'));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dispatch_decisions' AND column_name = 'source') THEN
    ALTER TABLE public.dispatch_decisions DROP CONSTRAINT IF EXISTS dispatch_decisions_source_check;
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_source_check
      CHECK (source IN ('ai_plan', 'ai_plan_bulk', 'rules_engine'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_note_len') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_note_len CHECK (note IS NULL OR char_length(note) <= 1000);
  END IF;

  -- Phase 1 integrity
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_propensity_range') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_propensity_range CHECK (propensity IS NULL OR (propensity > 0 AND propensity <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_set_size_range') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_set_size_range CHECK (set_size IS NULL OR set_size BETWEEN 0 AND 50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_arm_check') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_arm_check CHECK (arm IS NULL OR arm IN ('exploit', 'explore'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_set_is_object') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_set_is_object CHECK (indifference_set IS NULL OR jsonb_typeof(indifference_set) = 'object');
  END IF;
  -- An explore row is only meaningful with a propensity, a set of >= 2 and the set that was drawn from.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dispatch_decisions'::regclass AND conname = 'dispatch_decisions_explore_complete') THEN
    ALTER TABLE public.dispatch_decisions ADD CONSTRAINT dispatch_decisions_explore_complete
      CHECK (arm IS DISTINCT FROM 'explore' OR (propensity IS NOT NULL AND set_size >= 2 AND indifference_set IS NOT NULL));
  END IF;
END $$;

-- Randomized rows are the small subset the estimator and the guardrails read.
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_explore
  ON dispatch_decisions (user_id, created_at DESC) WHERE arm = 'explore';
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_arm_recent
  ON dispatch_decisions (user_id, created_at DESC) WHERE arm IS NOT NULL;

-- Rules-engine policies (idempotent; skipped when the rules migration already created them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dispatch_decisions' AND policyname = 'dispatch_decisions_select') THEN
    CREATE POLICY "dispatch_decisions_select" ON dispatch_decisions
      FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dispatch_decisions' AND policyname = 'dispatch_decisions_insert') THEN
    CREATE POLICY "dispatch_decisions_insert" ON dispatch_decisions
      FOR INSERT TO authenticated WITH CHECK (user_id = (select public.get_account_owner_id()));
  END IF;
END $$;

-- =============================================================
-- 2. Append-only, enforced for every role (incl. service role)
-- =============================================================
CREATE OR REPLACE FUNCTION public.dispatch_decisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- UPDATE: only the FK action "ON DELETE SET NULL" (technician removed) may change a row.
  IF (to_jsonb(NEW) - 'technician_id' - 'recommended_technician_id') IS DISTINCT FROM (to_jsonb(OLD) - 'technician_id' - 'recommended_technician_id')
     OR (NEW.technician_id IS NOT NULL AND NEW.technician_id IS DISTINCT FROM OLD.technician_id)
     OR (NEW.recommended_technician_id IS NOT NULL AND NEW.recommended_technician_id IS DISTINCT FROM OLD.recommended_technician_id) THEN
    RAISE EXCEPTION 'dispatch_decisions is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispatch_decisions_append_only ON dispatch_decisions;
CREATE TRIGGER trg_dispatch_decisions_append_only
  BEFORE UPDATE ON dispatch_decisions
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_decisions_append_only();

-- =============================================================
-- 3. Per-account exploration settings (everything OFF by default)
-- =============================================================
CREATE TABLE IF NOT EXISTS dispatch_exploration_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  budget_pct numeric(5,2) NOT NULL DEFAULT 10 CHECK (budget_pct BETWEEN 0 AND 25),
  delta numeric(5,1) NOT NULL DEFAULT 3 CHECK (delta BETWEEN 0 AND 20),
  max_regret_pct numeric(5,2) NOT NULL DEFAULT 5 CHECK (max_regret_pct BETWEEN 0 AND 20),
  per_tech_weekly_cap integer NOT NULL DEFAULT 3 CHECK (per_tech_weekly_cap BETWEEN 0 AND 50),
  guardrail_tolerance_pct numeric(5,2) NOT NULL DEFAULT 5 CHECK (guardrail_tolerance_pct BETWEEN 0 AND 50),
  auto_disabled_at timestamptz,
  auto_disabled_reason text CHECK (auto_disabled_reason IS NULL OR char_length(auto_disabled_reason) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid()
);

ALTER TABLE dispatch_exploration_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dispatch_exploration_settings_select" ON dispatch_exploration_settings;
CREATE POLICY "dispatch_exploration_settings_select" ON dispatch_exploration_settings
  FOR SELECT TO authenticated USING (user_id = (select public.get_account_owner_id()));

DROP POLICY IF EXISTS "dispatch_exploration_settings_insert" ON dispatch_exploration_settings;
CREATE POLICY "dispatch_exploration_settings_insert" ON dispatch_exploration_settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()));

DROP POLICY IF EXISTS "dispatch_exploration_settings_update" ON dispatch_exploration_settings;
CREATE POLICY "dispatch_exploration_settings_update" ON dispatch_exploration_settings
  FOR UPDATE TO authenticated
  USING (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()))
  WITH CHECK (user_id = (select public.get_account_owner_id()) AND (select public.time_off_can_manage()));
-- No DELETE policy: switch it off instead of deleting the audit of how it was configured.
