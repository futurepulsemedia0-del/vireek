/*
  # Vireek Truck-Roll Elimination Engine

  ## Why
  Not "dispatch optimization" — the question before every dispatch is:
  "Should this truck roll happen at all?"

  Seven gates are evaluated per scheduled job (remote-resolvable, evidence,
  customer media, correct part, correct technician, access, resolution
  probability). The engine is pure TypeScript (src/lib/truckRoll.ts); this
  migration stores what it decided (auditable, append-only), what people did
  about it (action ledger), and the per-account policy.

  ## Tables
  - truck_roll_assessments : append-only history of verdicts (UPDATE blocked).
  - truck_roll_actions     : append-only ledger of human/system actions
                             (media requested/received, access confirmed,
                             remote attempt outcome, owner override).
  - truck_roll_settings    : per-account policy (cost per roll, thresholds).

  ## Access
  - Reads: RLS, account-owner scope (same as jobs).
  - Writes: only through SECURITY DEFINER functions that verify the job
    belongs to the caller's account and validate every value.
  - Automatic alert: when a job scheduled within 24h first enters "hold",
    the account owner gets one (deduplicated) notification.

  Depends on: jobs, team_members, notifications, public.get_account_owner_id().
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS truck_roll_settings (
  user_id uuid PRIMARY KEY,
  truck_roll_cost numeric(8, 2) NOT NULL DEFAULT 185 CHECK (truck_roll_cost BETWEEN 0 AND 5000),
  remote_threshold integer NOT NULL DEFAULT 55 CHECK (remote_threshold BETWEEN 30 AND 95),
  min_resolution integer NOT NULL DEFAULT 80 CHECK (min_resolution BETWEEN 50 AND 99),
  min_readiness integer NOT NULL DEFAULT 75 CHECK (min_readiness BETWEEN 40 AND 99),
  notify_on_hold boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS truck_roll_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK (verdict IN ('dispatch', 'remote_first', 'hold', 'emergency', 'eliminated')),
  readiness numeric(5, 1) CHECK (readiness IS NULL OR readiness BETWEEN 0 AND 100),
  remote_score numeric(5, 1) CHECK (remote_score IS NULL OR remote_score BETWEEN 0 AND 100),
  resolution_probability numeric(5, 1) CHECK (resolution_probability IS NULL OR resolution_probability BETWEEN 0 AND 100),
  gates jsonb NOT NULL DEFAULT '[]'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_truck_roll_assessments_job
  ON truck_roll_assessments(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_truck_roll_assessments_user
  ON truck_roll_assessments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS truck_roll_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'request_media', 'media_received', 'access_confirmed',
    'remote_resolved', 'remote_failed', 'override_dispatch'
  )),
  service_type text,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  actor_id uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT truck_roll_override_needs_reason
    CHECK (kind <> 'override_dispatch' OR (note IS NOT NULL AND char_length(btrim(note)) >= 10))
);

CREATE INDEX IF NOT EXISTS idx_truck_roll_actions_job
  ON truck_roll_actions(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_truck_roll_actions_user
  ON truck_roll_actions(user_id, created_at DESC);

-- =============================================================
-- RLS (read-only for clients; every write goes through a function)
-- =============================================================

ALTER TABLE truck_roll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE truck_roll_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE truck_roll_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_truck_roll_settings" ON truck_roll_settings;
CREATE POLICY "select_own_truck_roll_settings" ON truck_roll_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_truck_roll_assessments" ON truck_roll_assessments;
CREATE POLICY "select_own_truck_roll_assessments" ON truck_roll_assessments
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_truck_roll_actions" ON truck_roll_actions;
CREATE POLICY "select_own_truck_roll_actions" ON truck_roll_actions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Decisions are evidence: rows can only be appended.
CREATE OR REPLACE FUNCTION public.prevent_truck_roll_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_truck_roll_assessments_immutable ON truck_roll_assessments;
CREATE TRIGGER trg_truck_roll_assessments_immutable
  BEFORE UPDATE ON truck_roll_assessments
  FOR EACH ROW EXECUTE FUNCTION public.prevent_truck_roll_update();

DROP TRIGGER IF EXISTS trg_truck_roll_actions_immutable ON truck_roll_actions;
CREATE TRIGGER trg_truck_roll_actions_immutable
  BEFORE UPDATE ON truck_roll_actions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_truck_roll_update();

-- =============================================================
-- SETTINGS (owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_truck_roll_settings(
  p_truck_roll_cost numeric,
  p_remote_threshold integer,
  p_min_resolution integer,
  p_min_readiness integer,
  p_notify_on_hold boolean
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
    RAISE EXCEPTION 'Only the account owner can change Truck-Roll Elimination settings';
  END IF;
  IF p_truck_roll_cost IS NULL OR p_truck_roll_cost NOT BETWEEN 0 AND 5000
     OR p_remote_threshold IS NULL OR p_remote_threshold NOT BETWEEN 30 AND 95
     OR p_min_resolution IS NULL OR p_min_resolution NOT BETWEEN 50 AND 99
     OR p_min_readiness IS NULL OR p_min_readiness NOT BETWEEN 40 AND 99 THEN
    RAISE EXCEPTION 'Invalid Truck-Roll Elimination settings';
  END IF;

  INSERT INTO truck_roll_settings (user_id, truck_roll_cost, remote_threshold, min_resolution, min_readiness, notify_on_hold, updated_at)
  VALUES (v_owner, round(p_truck_roll_cost, 2), p_remote_threshold, p_min_resolution, p_min_readiness, COALESCE(p_notify_on_hold, true), now())
  ON CONFLICT (user_id) DO UPDATE SET
    truck_roll_cost = EXCLUDED.truck_roll_cost,
    remote_threshold = EXCLUDED.remote_threshold,
    min_resolution = EXCLUDED.min_resolution,
    min_readiness = EXCLUDED.min_readiness,
    notify_on_hold = EXCLUDED.notify_on_hold,
    updated_at = now();
END;
$$;

-- =============================================================
-- ASSESSMENTS + AUTOMATIC ALERT
-- =============================================================

/*
  p_items: jsonb array of
    { job_id, verdict, readiness, remote_score, resolution_probability, gates, reasons }
  Returns how many assessments were written. An assessment is skipped when the
  latest one for that job has the same verdict, readiness within 3 points and
  is less than 6 hours old — refreshing the page never spams history.
*/
CREATE OR REPLACE FUNCTION public.record_truck_roll_assessments(p_items jsonb)
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
  v_when timestamptz;
  v_verdict text;
  v_ready numeric;
  v_prev truck_roll_assessments;
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
    RAISE EXCEPTION 'Too many assessments in one call (max 300)';
  END IF;

  SELECT COALESCE((SELECT notify_on_hold FROM truck_roll_settings WHERE user_id = v_owner), true)
  INTO v_notify;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_job_id := (v_item->>'job_id')::uuid;
    v_verdict := v_item->>'verdict';
    v_ready := NULLIF(v_item->>'readiness', '')::numeric;

    SELECT customer_name, scheduled_datetime INTO v_customer, v_when
    FROM jobs WHERE id = v_job_id AND user_id = v_owner;
    IF NOT FOUND THEN
      CONTINUE; -- not this account's job: ignore silently
    END IF;

    IF v_verdict NOT IN ('dispatch', 'remote_first', 'hold', 'emergency', 'eliminated')
       OR (v_ready IS NOT NULL AND v_ready NOT BETWEEN 0 AND 100) THEN
      RAISE EXCEPTION 'Invalid truck-roll assessment for job %', v_job_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('truck_roll:' || v_job_id::text, 0));

    SELECT * INTO v_prev FROM truck_roll_assessments
    WHERE job_id = v_job_id ORDER BY created_at DESC, id DESC LIMIT 1;
    v_have_prev := FOUND;

    IF v_have_prev
       AND v_prev.verdict = v_verdict
       AND (v_ready IS NULL OR v_prev.readiness IS NULL OR abs(v_prev.readiness - v_ready) < 3)
       AND v_prev.created_at > now() - interval '6 hours' THEN
      CONTINUE;
    END IF;

    INSERT INTO truck_roll_assessments (
      user_id, job_id, verdict, readiness, remote_score, resolution_probability, gates, reasons
    ) VALUES (
      v_owner, v_job_id, v_verdict, round(v_ready, 1),
      round(NULLIF(v_item->>'remote_score', '')::numeric, 1),
      round(NULLIF(v_item->>'resolution_probability', '')::numeric, 1),
      CASE WHEN jsonb_typeof(v_item->'gates') = 'array' THEN v_item->'gates' ELSE '[]'::jsonb END,
      CASE WHEN jsonb_typeof(v_item->'reasons') = 'array' THEN v_item->'reasons' ELSE '[]'::jsonb END
    );
    v_count := v_count + 1;

    -- One alert, only when a job happening within 24h first enters "hold".
    IF v_notify AND v_verdict = 'hold'
       AND (NOT v_have_prev OR v_prev.verdict <> 'hold')
       AND v_when IS NOT NULL AND v_when BETWEEN now() AND now() + interval '24 hours' THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (
        v_owner,
        'truck_roll',
        'Do not dispatch: ' || v_customer,
        'Vireek stopped a truck roll scheduled within 24 hours. Open the job to see which checks failed and how to fix them.',
        '/dashboard/truck-roll'
      );
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- =============================================================
-- ACTION LEDGER
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_truck_roll_action(
  p_job_id uuid,
  p_kind text,
  p_note text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_service text;
  v_id uuid;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  SELECT service_type INTO v_service FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found';
  END IF;
  IF p_kind NOT IN ('request_media', 'media_received', 'access_confirmed', 'remote_resolved', 'remote_failed', 'override_dispatch') THEN
    RAISE EXCEPTION 'Invalid action kind';
  END IF;
  -- Overriding a hold is an accountable decision: owner only, with a reason.
  IF p_kind = 'override_dispatch' THEN
    IF auth.uid() <> v_owner THEN
      RAISE EXCEPTION 'Only the account owner can override a hold';
    END IF;
    IF p_note IS NULL OR char_length(btrim(p_note)) < 10 THEN
      RAISE EXCEPTION 'A reason of at least 10 characters is required to override a hold';
    END IF;
  END IF;

  INSERT INTO truck_roll_actions (user_id, job_id, kind, service_type, note)
  VALUES (v_owner, p_job_id, p_kind, v_service, left(NULLIF(btrim(p_note), ''), 1000))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.save_truck_roll_settings(numeric, integer, integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_truck_roll_assessments(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_truck_roll_action(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_truck_roll_settings(numeric, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_truck_roll_assessments(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_truck_roll_action(uuid, text, text) TO authenticated;
