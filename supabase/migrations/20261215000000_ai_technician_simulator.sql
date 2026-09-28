/*
  # AI Technician Simulator  (Vireek Technician Academy -> Certification -> Trust Passport)

  A technician is given an AI-generated, realistic service scenario. They must
  ask the customer questions, choose measurements, pass safety gates, make a
  diagnosis, pick parts and decide. The result is scored by a DETERMINISTIC
  rubric (AI writes the scenario and the coaching text; AI never decides the
  score). Passing attempts feed a derived certification level that appears in
  the Trust Passport and Skill Graph - clearly labelled "simulator", never
  mixed into real-job metrics.

  Integrity model (same philosophy as the Trust Passport):
    - simulator_scenarios holds the hidden ground truth. RLS is enabled with NO
      policies: only the Edge Function (service role) can ever read it, so the
      answer can never reach the browser before submission.
    - simulator_attempts is readable by its owner only; there is NO client
      INSERT/UPDATE/DELETE policy. Score, pass flag and events are written only
      by the Edge Function through the RPCs below.
    - Certification level is DERIVED live by get_technician_simulator_summary();
      there is no writable "certification" table to inflate.

  Purely additive - touches no existing table or function.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 1) Hidden ground truth (service role only) --------------------------------
CREATE TABLE IF NOT EXISTS simulator_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trade text NOT NULL,
  difficulty text NOT NULL,
  brief jsonb NOT NULL,
  truth jsonb NOT NULL,
  model text,
  source_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulator_scenarios_trade_check CHECK (trade IN ('hvac', 'plumbing', 'electrical', 'appliance')),
  CONSTRAINT simulator_scenarios_difficulty_check CHECK (difficulty IN ('foundation', 'professional', 'master'))
);

ALTER TABLE simulator_scenarios ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: the truth is unreadable by every client role.

-- 2) Attempts (owner can read; only the Edge Function writes) ----------------
CREATE TABLE IF NOT EXISTS simulator_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  account_owner_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  scenario_id uuid NOT NULL REFERENCES simulator_scenarios(id) ON DELETE CASCADE,
  trade text NOT NULL,
  difficulty text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  brief jsonb NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  score integer,
  passed boolean,
  result jsonb,
  source_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  CONSTRAINT simulator_attempts_status_check CHECK (status IN ('active', 'submitted', 'expired')),
  CONSTRAINT simulator_attempts_trade_check CHECK (trade IN ('hvac', 'plumbing', 'electrical', 'appliance')),
  CONSTRAINT simulator_attempts_difficulty_check CHECK (difficulty IN ('foundation', 'professional', 'master')),
  CONSTRAINT simulator_attempts_score_check CHECK (score IS NULL OR (score >= 0 AND score <= 100))
);

CREATE INDEX IF NOT EXISTS idx_simulator_attempts_user_started
  ON simulator_attempts(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_simulator_attempts_member_submitted
  ON simulator_attempts(team_member_id, submitted_at DESC) WHERE status = 'submitted';
-- One live attempt per person: prevents scenario-shopping and double spend.
CREATE UNIQUE INDEX IF NOT EXISTS uq_simulator_attempts_one_active
  ON simulator_attempts(user_id) WHERE status = 'active';

ALTER TABLE simulator_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_simulator_attempts" ON simulator_attempts;
CREATE POLICY "users_read_own_simulator_attempts"
ON simulator_attempts
FOR SELECT
TO authenticated
USING (user_id = auth.uid());
-- Intentionally no INSERT/UPDATE/DELETE policy for authenticated.

-- 3) Per-bucket quota (service role only) ------------------------------------
CREATE TABLE IF NOT EXISTS simulator_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket)
);

ALTER TABLE simulator_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies.

CREATE OR REPLACE FUNCTION public.consume_simulator_quota(
  p_user_id uuid,
  p_bucket text,
  p_max integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO simulator_usage AS u (user_id, bucket, window_start, request_count)
  VALUES (p_user_id, p_bucket, now(), 1)
  ON CONFLICT (user_id, bucket) DO UPDATE
    SET window_start = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
          ELSE u.window_start
        END,
        request_count = CASE
          WHEN u.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
          ELSE u.request_count + 1
        END
  RETURNING u.request_count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_simulator_quota(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_simulator_quota(uuid, text, integer, integer) TO service_role;

-- 4) Atomic event append (service role only) ---------------------------------
-- Single UPDATE => no read-modify-write race between rapid clicks.
CREATE OR REPLACE FUNCTION public.append_simulator_event(
  p_attempt_id uuid,
  p_user_id uuid,
  p_event jsonb,
  p_max_events integer DEFAULT 80
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE simulator_attempts
  SET events = events || jsonb_build_array(p_event)
  WHERE id = p_attempt_id
    AND user_id = p_user_id
    AND status = 'active'
    AND expires_at > now()
    AND jsonb_array_length(events) < p_max_events;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.append_simulator_event(uuid, uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_simulator_event(uuid, uuid, jsonb, integer) TO service_role;

-- 5) Atomic finalize (service role only) -------------------------------------
-- The status = 'active' guard makes double-submit a no-op (returns false).
CREATE OR REPLACE FUNCTION public.finalize_simulator_attempt(
  p_attempt_id uuid,
  p_user_id uuid,
  p_score integer,
  p_passed boolean,
  p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE simulator_attempts
  SET status = 'submitted',
      submitted_at = now(),
      score = p_score,
      passed = p_passed,
      result = p_result
  WHERE id = p_attempt_id
    AND user_id = p_user_id
    AND status = 'active'
    AND expires_at > now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_simulator_attempt(uuid, uuid, integer, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_simulator_attempt(uuid, uuid, integer, boolean, jsonb) TO service_role;

-- 6) Derived certification summary (read-only, no writable table) ------------
/*
  Level per trade (365-day lookback, passes only):
    master        >= 3 passed attempts at 'master'
    professional  >= 3 passed attempts at 'professional'
    foundation    >= 3 passed attempts at 'foundation'
  A pass already requires score >= 70, correct root cause and zero safety
  violations (enforced server-side in the Edge Function scoring module).

  Visibility: owners/admins and anyone with can_view_billing see every
  technician; a technician sees only their own row.
*/
CREATE OR REPLACE FUNCTION public.get_technician_simulator_summary(
  p_technician_id uuid DEFAULT NULL
)
RETURNS TABLE (
  technician_id uuid,
  attempts_completed integer,
  attempts_passed integer,
  avg_score numeric,
  last_attempt_at timestamptz,
  trades jsonb
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
    SELECT (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
      OR EXISTS (
        SELECT 1 FROM team_members m
        WHERE m.user_id = auth.uid()
          AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
      )
    ) AS ok
  ),
  techs AS (
    SELECT tm.id
    FROM team_members tm, owner, manager
    WHERE tm.account_owner_id = owner.id
      AND tm.role = 'technician'
      AND (p_technician_id IS NULL OR tm.id = p_technician_id)
      AND (manager.ok OR tm.user_id = auth.uid())
  ),
  att AS (
    SELECT a.team_member_id, a.trade, a.difficulty, a.score, a.passed, a.submitted_at
    FROM simulator_attempts a
    JOIN techs t ON t.id = a.team_member_id
    WHERE a.status = 'submitted'
      AND a.submitted_at >= now() - interval '365 days'
  ),
  by_trade AS (
    SELECT
      team_member_id,
      trade,
      count(*) AS n,
      count(*) FILTER (WHERE passed) AS n_passed,
      count(*) FILTER (WHERE passed AND difficulty = 'foundation') AS p_foundation,
      count(*) FILTER (WHERE passed AND difficulty = 'professional') AS p_professional,
      count(*) FILTER (WHERE passed AND difficulty = 'master') AS p_master,
      round(avg(score), 1) AS avg_score,
      max(score) AS best_score
    FROM att
    GROUP BY team_member_id, trade
  ),
  trade_json AS (
    SELECT
      team_member_id,
      sum(n)::integer AS n,
      sum(n_passed)::integer AS n_passed,
      jsonb_object_agg(
        trade,
        jsonb_build_object(
          'level', CASE
            WHEN p_master >= 3 THEN 'master'
            WHEN p_professional >= 3 THEN 'professional'
            WHEN p_foundation >= 3 THEN 'foundation'
            ELSE 'none'
          END,
          'attempts', n,
          'passed', n_passed,
          'passed_foundation', p_foundation,
          'passed_professional', p_professional,
          'passed_master', p_master,
          'avg_score', avg_score,
          'best_score', best_score
        )
      ) AS trades
    FROM by_trade
    GROUP BY team_member_id
  ),
  overall AS (
    SELECT team_member_id, round(avg(score), 1) AS avg_score, max(submitted_at) AS last_at
    FROM att
    GROUP BY team_member_id
  )
  SELECT
    t.id,
    coalesce(tj.n, 0),
    coalesce(tj.n_passed, 0),
    o.avg_score,
    o.last_at,
    coalesce(tj.trades, '{}'::jsonb)
  FROM techs t
  LEFT JOIN trade_json tj ON tj.team_member_id = t.id
  LEFT JOIN overall o ON o.team_member_id = t.id;
$$;

REVOKE ALL ON FUNCTION public.get_technician_simulator_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_technician_simulator_summary(uuid) TO authenticated;
