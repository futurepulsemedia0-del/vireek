/*
  # Vireek Technician Apprenticeship Engine

  Turns "training" into a measured path:
    Job -> Learning -> Simulation -> Assessment -> Certification -> Real Job

  Almost everything is DERIVED in the client engine (src/lib/technicianApprenticeship.ts)
  from evidence that already exists: completed jobs, review ratings and server-scored
  simulator attempts. This migration adds only what genuinely needs storage.

  1) apprenticeship_plans            - the target a manager sets for a technician (managers write).
  2) apprenticeship_lesson_completions - self-attested Learning stage (written only by an RPC).
  3) get_apprenticeship_sim_evidence() - read-only view of a technician's scored attempts,
                                         including the per-dimension breakdown the summary RPC omits.

  Integrity model (same as the Simulator and Trust Passport):
    - There is NO writable certification table. Certification is derived, so it cannot be inflated.
    - Learning is the only self-attested stage and cannot certify anyone by itself.
    - Technicians can read their own plan and evidence; managers read their whole account.
    - No DELETE policy: plans are cancelled by status, so history is kept.

  Purely additive - touches no existing table or function.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 0) Helpers (SECURITY DEFINER so policies never recurse through team_members RLS) ----
CREATE OR REPLACE FUNCTION public.apprenticeship_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.apprenticeship_technician_in_account(p_member_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.id = p_member_id
      AND tm.role = 'technician'
      AND tm.account_owner_id = public.get_account_owner_id()
  );
$$;

CREATE OR REPLACE FUNCTION public.apprenticeship_is_self(p_member_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.id = p_member_id AND tm.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.apprenticeship_is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apprenticeship_technician_in_account(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apprenticeship_is_self(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apprenticeship_is_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.apprenticeship_technician_in_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apprenticeship_is_self(uuid) TO authenticated;

-- 1) Plans ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apprenticeship_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  target_level smallint NOT NULL,
  trades text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  baseline_readiness numeric(5, 1),
  baseline_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_date date,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT apprenticeship_plans_level_check CHECK (target_level BETWEEN 1 AND 5),
  CONSTRAINT apprenticeship_plans_status_check CHECK (status IN ('active', 'completed', 'cancelled')),
  CONSTRAINT apprenticeship_plans_trades_check CHECK (trades <@ ARRAY['hvac', 'plumbing', 'electrical', 'appliance']::text[]),
  CONSTRAINT apprenticeship_plans_baseline_check CHECK (baseline_readiness IS NULL OR (baseline_readiness >= 0 AND baseline_readiness <= 100))
);

CREATE INDEX IF NOT EXISTS idx_apprenticeship_plans_account
  ON apprenticeship_plans(account_owner_id, created_at DESC);
-- One live plan per technician: a single, unambiguous target at any time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_apprenticeship_plans_one_active
  ON apprenticeship_plans(team_member_id) WHERE status = 'active';

ALTER TABLE apprenticeship_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "apprenticeship_plans_read" ON apprenticeship_plans;
CREATE POLICY "apprenticeship_plans_read"
ON apprenticeship_plans
FOR SELECT
TO authenticated
USING (
  account_owner_id = public.get_account_owner_id()
  AND (public.apprenticeship_is_manager() OR public.apprenticeship_is_self(team_member_id))
);

DROP POLICY IF EXISTS "apprenticeship_plans_manager_insert" ON apprenticeship_plans;
CREATE POLICY "apprenticeship_plans_manager_insert"
ON apprenticeship_plans
FOR INSERT
TO authenticated
WITH CHECK (
  account_owner_id = public.get_account_owner_id()
  AND public.apprenticeship_is_manager()
  AND public.apprenticeship_technician_in_account(team_member_id)
);

DROP POLICY IF EXISTS "apprenticeship_plans_manager_update" ON apprenticeship_plans;
CREATE POLICY "apprenticeship_plans_manager_update"
ON apprenticeship_plans
FOR UPDATE
TO authenticated
USING (
  account_owner_id = public.get_account_owner_id()
  AND public.apprenticeship_is_manager()
)
WITH CHECK (
  account_owner_id = public.get_account_owner_id()
  AND public.apprenticeship_is_manager()
  AND public.apprenticeship_technician_in_account(team_member_id)
);
-- Intentionally no DELETE policy.

-- 2) Learning completions (self-attested; written only by the RPC below) --------------
CREATE TABLE IF NOT EXISTS apprenticeship_lesson_completions (
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_member_id, lesson_id),
  CONSTRAINT apprenticeship_lesson_id_check CHECK (lesson_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$')
);

CREATE INDEX IF NOT EXISTS idx_apprenticeship_lessons_account
  ON apprenticeship_lesson_completions(account_owner_id);

ALTER TABLE apprenticeship_lesson_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "apprenticeship_lessons_read" ON apprenticeship_lesson_completions;
CREATE POLICY "apprenticeship_lessons_read"
ON apprenticeship_lesson_completions
FOR SELECT
TO authenticated
USING (
  account_owner_id = public.get_account_owner_id()
  AND (public.apprenticeship_is_manager() OR public.apprenticeship_is_self(team_member_id))
);
-- Intentionally no INSERT/UPDATE/DELETE policy: only complete_apprenticeship_lesson() writes.

CREATE OR REPLACE FUNCTION public.complete_apprenticeship_lesson(p_lesson_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid;
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_lesson_id IS NULL OR p_lesson_id !~ '^[a-z0-9][a-z0-9_-]{2,63}$' THEN
    RAISE EXCEPTION 'Invalid lesson' USING ERRCODE = '22023';
  END IF;

  SELECT tm.id, tm.account_owner_id
  INTO v_member, v_owner
  FROM team_members tm
  WHERE tm.user_id = auth.uid()
    AND tm.role = 'technician'
    AND tm.invite_status = 'active'
  LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION 'Only active technicians can complete lessons' USING ERRCODE = '42501';
  END IF;

  INSERT INTO apprenticeship_lesson_completions (team_member_id, account_owner_id, lesson_id)
  VALUES (v_member, v_owner, p_lesson_id)
  ON CONFLICT (team_member_id, lesson_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_apprenticeship_lesson(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_apprenticeship_lesson(text) TO authenticated;

-- 3) Scored simulator evidence (read-only) --------------------------------------------
/*
  One row per submitted attempt in the last 365 days, with the per-dimension breakdown
  that get_technician_simulator_summary() aggregates away. A manager sees every
  technician on the account; a technician sees only their own rows.
*/
CREATE OR REPLACE FUNCTION public.get_apprenticeship_sim_evidence(
  p_technician_id uuid DEFAULT NULL
)
RETURNS TABLE (
  technician_id uuid,
  trade text,
  difficulty text,
  score integer,
  passed boolean,
  submitted_at timestamptz,
  breakdown jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH owner AS (
    SELECT public.get_account_owner_id() AS id
  ),
  manager AS (
    SELECT public.apprenticeship_is_manager() AS ok
  ),
  techs AS (
    SELECT tm.id
    FROM team_members tm, owner, manager
    WHERE tm.account_owner_id = owner.id
      AND tm.role = 'technician'
      AND (p_technician_id IS NULL OR tm.id = p_technician_id)
      AND (manager.ok OR tm.user_id = auth.uid())
  )
  SELECT
    a.team_member_id,
    a.trade,
    a.difficulty,
    a.score,
    coalesce(a.passed, false),
    a.submitted_at,
    a.result -> 'breakdown'
  FROM simulator_attempts a
  JOIN techs t ON t.id = a.team_member_id
  WHERE a.status = 'submitted'
    AND a.score IS NOT NULL
    AND a.submitted_at >= now() - interval '365 days'
  ORDER BY a.submitted_at DESC
  LIMIT 2000;
$$;

REVOKE ALL ON FUNCTION public.get_apprenticeship_sim_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_apprenticeship_sim_evidence(uuid) TO authenticated;
