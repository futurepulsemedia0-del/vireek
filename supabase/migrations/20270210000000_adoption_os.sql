/*
  # Vireek Change Management / Adoption OS

  AI fails without adoption. This migration answers "which technician is really using
  the system?" without creating any new tracking pipeline.

  1) get_adoption_signals()   - read-only, per-technician counts derived from data that already
                                exists: completed jobs, AI Copilot sessions linked to those jobs,
                                job documentation fields, Evidence Chain entries, signatures,
                                apprenticeship lessons and simulator attempts.
                                A manager sees every technician; a technician sees only themselves.
  2) adoption_interventions   - the onboarding plan a manager starts for a technician, with the
                                baseline score so its real effect can be measured afterwards.

  Integrity and privacy model:
    - Scores are DERIVED in the client (src/lib/adoptionIntelligence.ts), never stored as truth.
    - Measured per completed job. No location, screen-time or keystroke data is read.
    - Managers write plans; technicians can read their own. No DELETE policy: history is kept.

  Depends on: 20270105000000_technician_apprenticeship_engine.sql
              (public.apprenticeship_is_manager, public.apprenticeship_technician_in_account,
               public.apprenticeship_is_self, apprenticeship_lesson_completions).
  Purely additive - touches no existing table or function.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

-- 1) Signals ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_adoption_signals(
  p_days integer DEFAULT 30,
  p_offset_days integer DEFAULT 0
)
RETURNS TABLE (
  team_member_id uuid,
  member_name text,
  member_email text,
  jobs_completed integer,
  jobs_with_ai integer,
  ai_sessions integer,
  jobs_with_photos integer,
  jobs_with_diagnosis integer,
  jobs_with_work_notes integer,
  jobs_with_evidence integer,
  jobs_with_signature integer,
  lessons_completed integer,
  simulator_attempts integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH p AS (
    SELECT
      least(greatest(coalesce(p_days, 30), 7), 180) AS days,
      least(greatest(coalesce(p_offset_days, 0), 0), 365) AS lag_days
  ),
  b AS (
    SELECT
      now() - make_interval(days => p.lag_days) AS end_ts,
      now() - make_interval(days => p.lag_days + p.days) AS start_ts
    FROM p
  ),
  owner AS (
    SELECT public.get_account_owner_id() AS id
  ),
  manager AS (
    SELECT public.apprenticeship_is_manager() AS ok
  ),
  techs AS (
    SELECT tm.id, tm.user_id, tm.member_name, tm.member_email
    FROM team_members tm, owner, manager
    WHERE auth.uid() IS NOT NULL
      AND tm.account_owner_id = owner.id
      AND tm.role = 'technician'
      AND tm.invite_status = 'active'
      AND (manager.ok OR tm.user_id = auth.uid())
  ),
  done AS (
    SELECT
      j.id AS job_id,
      j.assigned_technician_id AS tid,
      (coalesce(cardinality(j.before_photos), 0) > 0
        AND coalesce(cardinality(j.after_photos), 0) > 0) AS has_photos,
      (btrim(coalesce(j.technician_diagnosis, '')) <> '') AS has_diagnosis,
      (btrim(coalesce(j.work_performed_notes, '')) <> ''
        OR btrim(coalesce(j.completion_notes, '')) <> '') AS has_work_notes,
      (j.customer_signature_at IS NOT NULL
        OR btrim(coalesce(j.customer_signature_data_url, '')) <> '') AS has_signature
    FROM jobs j, owner, b
    WHERE j.user_id = owner.id
      AND j.job_status = 'completed'
      AND j.completed_at >= b.start_ts
      AND j.completed_at < b.end_ts
      AND j.assigned_technician_id IN (SELECT id FROM techs)
  ),
  ai_jobs AS (
    -- A job counts once, no matter how many copilot sessions the technician ran on it.
    SELECT DISTINCT d.job_id
    FROM done d
    JOIN techs t ON t.id = d.tid
    JOIN (
      SELECT s.user_id, s.job_id FROM diagnosis_sessions s
      UNION ALL
      SELECT l.user_id, l.job_id FROM live_copilot_sessions l
    ) s ON s.job_id = d.job_id AND s.user_id = t.user_id
  ),
  evidence_jobs AS (
    SELECT DISTINCT d.job_id
    FROM done d
    JOIN job_evidence_chain_entries e
      ON e.job_id = d.job_id AND e.actor_team_member_id = d.tid
  )
  SELECT
    t.id,
    t.member_name,
    t.member_email,
    (SELECT count(*) FROM done d WHERE d.tid = t.id)::integer,
    (SELECT count(*) FROM done d WHERE d.tid = t.id AND d.job_id IN (SELECT job_id FROM ai_jobs))::integer,
    (
      SELECT count(*) FROM (
        SELECT s.created_at FROM diagnosis_sessions s WHERE s.user_id = t.user_id
        UNION ALL
        SELECT l.created_at FROM live_copilot_sessions l WHERE l.user_id = t.user_id
      ) x, b
      WHERE x.created_at >= b.start_ts AND x.created_at < b.end_ts
    )::integer,
    (SELECT count(*) FROM done d WHERE d.tid = t.id AND d.has_photos)::integer,
    (SELECT count(*) FROM done d WHERE d.tid = t.id AND d.has_diagnosis)::integer,
    (SELECT count(*) FROM done d WHERE d.tid = t.id AND d.has_work_notes)::integer,
    (SELECT count(*) FROM done d WHERE d.tid = t.id AND d.job_id IN (SELECT job_id FROM evidence_jobs))::integer,
    (SELECT count(*) FROM done d WHERE d.tid = t.id AND d.has_signature)::integer,
    (
      SELECT count(*) FROM apprenticeship_lesson_completions c, b
      WHERE c.team_member_id = t.id AND c.completed_at >= b.start_ts AND c.completed_at < b.end_ts
    )::integer,
    (
      SELECT count(*) FROM simulator_attempts a, b
      WHERE a.team_member_id = t.id
        AND a.status = 'submitted'
        AND a.submitted_at >= b.start_ts AND a.submitted_at < b.end_ts
    )::integer
  FROM techs t
  ORDER BY coalesce(nullif(btrim(t.member_name), ''), t.member_email);
$$;

REVOKE ALL ON FUNCTION public.get_adoption_signals(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_adoption_signals(integer, integer) TO authenticated;

-- 2) Onboarding plans (interventions) -------------------------------------------------
CREATE TABLE IF NOT EXISTS adoption_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'onboarding',
  focus text[] NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  status text NOT NULL DEFAULT 'open',
  baseline_score numeric(5, 1),
  outcome_score numeric(5, 1),
  due_date date,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT adoption_interventions_kind_check
    CHECK (kind IN ('onboarding', 'coaching', 'ride_along', 'recognition')),
  CONSTRAINT adoption_interventions_status_check
    CHECK (status IN ('open', 'completed', 'dismissed')),
  CONSTRAINT adoption_interventions_focus_check
    CHECK (focus <@ ARRAY['ai', 'documentation']::text[]),
  CONSTRAINT adoption_interventions_steps_check
    CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 12),
  CONSTRAINT adoption_interventions_note_check
    CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT adoption_interventions_baseline_check
    CHECK (baseline_score IS NULL OR (baseline_score >= 0 AND baseline_score <= 100)),
  CONSTRAINT adoption_interventions_outcome_check
    CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 100)),
  CONSTRAINT adoption_interventions_closed_check
    CHECK ((status = 'open' AND closed_at IS NULL) OR (status <> 'open' AND closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_adoption_interventions_account
  ON adoption_interventions(account_owner_id, created_at DESC);
-- One live plan per technician: a single, unambiguous focus at any time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_adoption_interventions_one_open
  ON adoption_interventions(team_member_id) WHERE status = 'open';

ALTER TABLE adoption_interventions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adoption_interventions_read" ON adoption_interventions;
CREATE POLICY "adoption_interventions_read"
ON adoption_interventions
FOR SELECT
TO authenticated
USING (
  account_owner_id = public.get_account_owner_id()
  AND (public.apprenticeship_is_manager() OR public.apprenticeship_is_self(team_member_id))
);

DROP POLICY IF EXISTS "adoption_interventions_manager_insert" ON adoption_interventions;
CREATE POLICY "adoption_interventions_manager_insert"
ON adoption_interventions
FOR INSERT
TO authenticated
WITH CHECK (
  account_owner_id = public.get_account_owner_id()
  AND public.apprenticeship_is_manager()
  AND public.apprenticeship_technician_in_account(team_member_id)
);

DROP POLICY IF EXISTS "adoption_interventions_manager_update" ON adoption_interventions;
CREATE POLICY "adoption_interventions_manager_update"
ON adoption_interventions
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
