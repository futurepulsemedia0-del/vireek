/*
  # Vireek Outcome Assurance — Service Outcome Guarantee Engine

  ## Why
  Before a technician is dispatched, Vireek estimates the probability that the
  job will be resolved successfully on the first visit, from real signals
  (parts readiness, technician fit, diagnosis confidence, historical outcomes,
  schedule integrity, job context). The engine itself is pure TypeScript
  (src/lib/outcomeAssurance.ts); this migration stores what it decided so the
  business can audit it, alert on it, and measure how accurate it was.

  ## Tables
  - job_assurance_snapshots     : append-only history of predictions (UPDATE blocked).
  - job_assurance_interventions : ledger of interventions applied / dismissed.
  - outcome_assurance_settings  : per-account thresholds and alert switch.

  ## Access
  - Reads: RLS, account-owner scope (same as jobs).
  - Writes: only through the SECURITY DEFINER functions below, which verify the
    job belongs to the caller's account and validate every value.
  - Automatic alert: when a job first drops into "intervene", the snapshot
    function inserts a notification for the account owner (deduplicated).

  Depends on: jobs, team_members, notifications, public.get_account_owner_id().
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS outcome_assurance_settings (
  user_id uuid PRIMARY KEY,
  assured_threshold integer NOT NULL DEFAULT 85 CHECK (assured_threshold BETWEEN 50 AND 99),
  intervene_below integer NOT NULL DEFAULT 70 CHECK (intervene_below BETWEEN 30 AND 95),
  notify_on_intervene boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_assurance_thresholds_ordered CHECK (intervene_below < assured_threshold)
);

CREATE TABLE IF NOT EXISTS job_assurance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  probability numeric(5, 1) NOT NULL CHECK (probability BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('assured', 'watch', 'intervene', 'insufficient')),
  coverage numeric(5, 1) NOT NULL CHECK (coverage BETWEEN 0 AND 100),
  expected_minutes integer CHECK (expected_minutes IS NULL OR expected_minutes BETWEEN 0 AND 10080),
  parts_readiness numeric(5, 1) CHECK (parts_readiness IS NULL OR parts_readiness BETWEEN 0 AND 100),
  technician_fit numeric(5, 1) CHECK (technician_fit IS NULL OR technician_fit BETWEEN 0 AND 100),
  disruption_risk text NOT NULL CHECK (disruption_risk IN ('low', 'medium', 'high')),
  factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_assurance_snapshots_job
  ON job_assurance_snapshots(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_assurance_snapshots_user
  ON job_assurance_snapshots(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_assurance_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 60),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 1000),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'dismissed')),
  probability_before numeric(5, 1) CHECK (probability_before IS NULL OR probability_before BETWEEN 0 AND 100),
  probability_after numeric(5, 1) CHECK (probability_after IS NULL OR probability_after BETWEEN 0 AND 100),
  technician_from uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_to uuid REFERENCES team_members(id) ON DELETE SET NULL,
  actor_id uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_assurance_interventions_user
  ON job_assurance_interventions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_assurance_interventions_job
  ON job_assurance_interventions(job_id, created_at DESC);

-- =============================================================
-- RLS (read-only for clients; every write goes through a function)
-- =============================================================

ALTER TABLE outcome_assurance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assurance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assurance_interventions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_outcome_assurance_settings" ON outcome_assurance_settings;
CREATE POLICY "select_own_outcome_assurance_settings" ON outcome_assurance_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_job_assurance_snapshots" ON job_assurance_snapshots;
CREATE POLICY "select_own_job_assurance_snapshots" ON job_assurance_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_job_assurance_interventions" ON job_assurance_interventions;
CREATE POLICY "select_own_job_assurance_interventions" ON job_assurance_interventions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Predictions are evidence: rows can only be appended.
CREATE OR REPLACE FUNCTION public.prevent_job_assurance_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_assurance_snapshots_immutable ON job_assurance_snapshots;
CREATE TRIGGER trg_job_assurance_snapshots_immutable
  BEFORE UPDATE ON job_assurance_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_job_assurance_update();

DROP TRIGGER IF EXISTS trg_job_assurance_interventions_immutable ON job_assurance_interventions;
CREATE TRIGGER trg_job_assurance_interventions_immutable
  BEFORE UPDATE ON job_assurance_interventions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_job_assurance_update();

-- =============================================================
-- SETTINGS (owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_outcome_assurance_settings(
  p_assured_threshold integer,
  p_intervene_below integer,
  p_notify_on_intervene boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change Outcome Assurance settings';
  END IF;
  IF p_assured_threshold IS NULL OR p_intervene_below IS NULL
     OR p_assured_threshold NOT BETWEEN 50 AND 99
     OR p_intervene_below NOT BETWEEN 30 AND 95
     OR p_intervene_below >= p_assured_threshold THEN
    RAISE EXCEPTION 'Invalid thresholds: intervene-below must be lower than assured (50-99 / 30-95)';
  END IF;

  INSERT INTO outcome_assurance_settings (user_id, assured_threshold, intervene_below, notify_on_intervene, updated_at)
  VALUES (v_owner, p_assured_threshold, p_intervene_below, COALESCE(p_notify_on_intervene, true), now())
  ON CONFLICT (user_id) DO UPDATE SET
    assured_threshold = EXCLUDED.assured_threshold,
    intervene_below = EXCLUDED.intervene_below,
    notify_on_intervene = EXCLUDED.notify_on_intervene,
    updated_at = now();
END;
$$;

-- =============================================================
-- SNAPSHOTS + AUTOMATIC ALERT
-- =============================================================

/*
  p_items: jsonb array of
    { job_id, technician_id, probability, status, coverage, expected_minutes,
      parts_readiness, technician_fit, disruption_risk, factors }
  Returns how many snapshots were written. A snapshot is skipped when the
  latest one for that job has the same status, a probability within 2 points,
  and is less than 6 hours old — so refreshing the page never spams history.
*/
CREATE OR REPLACE FUNCTION public.record_assurance_snapshots(p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_notify boolean;
  v_item jsonb;
  v_job_id uuid;
  v_customer text;
  v_tech uuid;
  v_prob numeric;
  v_status text;
  v_cov numeric;
  v_prev job_assurance_snapshots;
  v_have_prev boolean;
  v_count integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) > 300 THEN
    RAISE EXCEPTION 'Too many snapshots in one call (max 300)';
  END IF;

  SELECT COALESCE((SELECT notify_on_intervene FROM outcome_assurance_settings WHERE user_id = v_owner), true)
  INTO v_notify;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_job_id := (v_item->>'job_id')::uuid;
    v_prob := (v_item->>'probability')::numeric;
    v_status := v_item->>'status';
    v_cov := (v_item->>'coverage')::numeric;

    SELECT customer_name INTO v_customer FROM jobs WHERE id = v_job_id AND user_id = v_owner;
    IF NOT FOUND THEN
      CONTINUE; -- not this account's job: ignore silently
    END IF;

    IF v_status NOT IN ('assured', 'watch', 'intervene', 'insufficient')
       OR v_prob IS NULL OR v_prob NOT BETWEEN 0 AND 100
       OR v_cov IS NULL OR v_cov NOT BETWEEN 0 AND 100
       OR (v_item->>'disruption_risk') NOT IN ('low', 'medium', 'high') THEN
      RAISE EXCEPTION 'Invalid assurance snapshot for job %', v_job_id;
    END IF;

    v_tech := NULLIF(v_item->>'technician_id', '')::uuid;
    IF v_tech IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM team_members WHERE id = v_tech AND account_owner_id = v_owner
    ) THEN
      v_tech := NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_job_id::text, 0));

    SELECT * INTO v_prev FROM job_assurance_snapshots
    WHERE job_id = v_job_id ORDER BY created_at DESC, id DESC LIMIT 1;
    v_have_prev := FOUND;

    IF v_have_prev
       AND v_prev.status = v_status
       AND abs(v_prev.probability - v_prob) < 2
       AND v_prev.created_at > now() - interval '6 hours' THEN
      CONTINUE;
    END IF;

    INSERT INTO job_assurance_snapshots (
      user_id, job_id, technician_id, probability, status, coverage, expected_minutes,
      parts_readiness, technician_fit, disruption_risk, factors
    ) VALUES (
      v_owner, v_job_id, v_tech, round(v_prob, 1), v_status, round(v_cov, 1),
      NULLIF(v_item->>'expected_minutes', '')::integer,
      round(NULLIF(v_item->>'parts_readiness', '')::numeric, 1),
      round(NULLIF(v_item->>'technician_fit', '')::numeric, 1),
      v_item->>'disruption_risk',
      CASE WHEN jsonb_typeof(v_item->'factors') = 'array' THEN v_item->'factors' ELSE '[]'::jsonb END
    );
    v_count := v_count + 1;

    -- Automatic intervention alert: first time this job drops into "intervene".
    IF v_notify AND v_status = 'intervene' AND (NOT v_have_prev OR v_prev.status <> 'intervene') THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (
        v_owner,
        'outcome_assurance',
        'Job at risk: ' || round(v_prob)::text || '% success probability',
        'The job for ' || v_customer || ' fell below your guarantee threshold. Vireek prepared an intervention plan.',
        '/dashboard/outcome-assurance'
      );
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- =============================================================
-- INTERVENTION LEDGER
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_assurance_intervention(
  p_job_id uuid,
  p_kind text,
  p_title text,
  p_detail text,
  p_outcome text,
  p_probability_before numeric,
  p_probability_after numeric,
  p_technician_from uuid,
  p_technician_to uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Job not found';
  END IF;
  IF p_outcome NOT IN ('applied', 'dismissed') THEN
    RAISE EXCEPTION 'Invalid outcome';
  END IF;

  INSERT INTO job_assurance_interventions (
    user_id, job_id, kind, title, detail, outcome,
    probability_before, probability_after, technician_from, technician_to
  ) VALUES (
    v_owner, p_job_id, left(p_kind, 60), left(p_title, 200), left(p_detail, 1000), p_outcome,
    round(p_probability_before, 1), round(p_probability_after, 1),
    (SELECT id FROM team_members WHERE id = p_technician_from AND account_owner_id = v_owner),
    (SELECT id FROM team_members WHERE id = p_technician_to AND account_owner_id = v_owner)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.save_outcome_assurance_settings(integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_assurance_snapshots(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_assurance_intervention(uuid, text, text, text, text, numeric, numeric, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_outcome_assurance_settings(integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_assurance_snapshots(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_assurance_intervention(uuid, text, text, text, text, numeric, numeric, uuid, uuid) TO authenticated;
