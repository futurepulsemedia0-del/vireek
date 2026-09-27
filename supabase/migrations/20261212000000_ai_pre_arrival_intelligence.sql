/*
  # AI Pre-Arrival Intelligence (job_mission_briefs)

  Before a technician leaves for a job, Vireek builds a "Mission Brief":
  predicted failure + confidence, last-service history, warranty status,
  likely parts (cross-referenced against the assigned technician's own
  van stock), whether the customer has previously declined this kind of
  repair, an estimated job value + duration (both computed from this
  account's own historical jobs, never guessed by the AI), and a
  before-leaving / on-arrival checklist.

  Design choice: every FACT (warranty, $ value, duration, last service,
  decline history, parts-in-stock) is computed here / in the Edge
  Function from real rows - never asked of the LLM. The LLM only
  supplies the diagnostic prediction and the checklist text, grounded in
  those facts. This keeps the feature accurate and cheap to run.

  Purely additive - touches nothing that already exists.

  1. job_mission_briefs   one row per job (upserted on regenerate).
  2. mission_brief_usage  atomic per-caller hourly quota table.
  3. consume_mission_brief_quota()
                          same pattern as consume_diagnosis_copilot_quota() -
                          callable ONLY by the service role.

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Mission brief -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_mission_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,

  -- AI-predicted diagnosis (grounded in the facts below, never invented)
  predicted_issue text NOT NULL,
  confidence numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  reasoning text,

  -- Deterministic facts, computed server-side - not from the model
  last_service_summary text,
  last_service_days_ago integer,
  warranty_status text NOT NULL DEFAULT 'unknown' CHECK (warranty_status IN ('active', 'expired', 'unknown')),
  warranty_expires_at date,
  customer_previously_declined boolean NOT NULL DEFAULT false,
  customer_decline_context text,
  estimated_value numeric,
  estimated_value_sample_size integer NOT NULL DEFAULT 0,
  estimated_duration_minutes integer,

  -- AI output, cross-referenced against real van stock in code
  parts jsonb NOT NULL DEFAULT '[]',
  risk_flags jsonb NOT NULL DEFAULT '[]',
  before_leaving_checklist jsonb NOT NULL DEFAULT '[]',
  on_arrival_checklist jsonb NOT NULL DEFAULT '[]',

  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_mission_briefs_user_id ON job_mission_briefs(user_id);
CREATE INDEX IF NOT EXISTS idx_job_mission_briefs_equipment_id ON job_mission_briefs(equipment_id) WHERE equipment_id IS NOT NULL;

ALTER TABLE job_mission_briefs ENABLE ROW LEVEL SECURITY;

-- Same scoping as `jobs` itself, so any team member who can see the job
-- (technician included) can see its brief.
DROP POLICY IF EXISTS "select_own_mission_briefs" ON job_mission_briefs;
CREATE POLICY "select_own_mission_briefs"
ON job_mission_briefs FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- Regular clients never write this table directly - only the Edge
-- Function's service-role client does, after generating a brief. This
-- keeps predicted/estimated fields from being forged by any caller.
DROP POLICY IF EXISTS "no_direct_insert_mission_briefs" ON job_mission_briefs;
DROP POLICY IF EXISTS "no_direct_update_mission_briefs" ON job_mission_briefs;
DROP POLICY IF EXISTS "no_direct_delete_mission_briefs" ON job_mission_briefs;

-- 2) Atomic quota (service-role only) ----------------------------------------

CREATE TABLE IF NOT EXISTS mission_brief_usage (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

ALTER TABLE mission_brief_usage ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only this migration's RPC (service role) touches it.

CREATE OR REPLACE FUNCTION public.consume_mission_brief_quota(
  p_user_id uuid,
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
  INSERT INTO mission_brief_usage AS u (user_id, window_start, request_count)
  VALUES (p_user_id, now(), 1)
  ON CONFLICT (user_id) DO UPDATE
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

REVOKE ALL ON FUNCTION public.consume_mission_brief_quota(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_mission_brief_quota(uuid, integer, integer) TO service_role;

-- 3) Service-role write access on job_mission_briefs -------------------------
-- (RLS is enabled with no INSERT/UPDATE policy for `authenticated`, so only
-- the service_role key used inside the Edge Function can write here.)
GRANT ALL ON job_mission_briefs TO service_role;
