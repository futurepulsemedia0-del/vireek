/*
  # Vireek Customer Trust Layer

  ## Why
  A measurable Trust Score per job (0-100), built from 10 weighted signals
  and shown to the customer as verifiable badges. The score is NEVER typed
  in by a client: every event's score is derived server-side, either from
  real system records (job status, ETA, credentials, photo verification,
  invoice) or from structured staff inputs mapped by fixed rules below.

  ## Tables
  - job_trust_events : append-only evidence ledger (UPDATE blocked by trigger,
                       no INSERT/UPDATE/DELETE policy for clients).
  - job_trust_scores : one derived snapshot row per job (score, tier,
                       coverage, per-signal breakdown, badges).

  ## Weights (sum = 100)
  eta_accuracy 12 | technician_identity 12 | price_transparency 12 |
  work_evidence 12 | quote_changes 10 | arrival_punctuality 10 |
  diagnosis_confidence 8 | communication_quality 8 | warranty 8 |
  payment_transparency 8

  Only signals that have evidence count; the score is the weighted average
  of those, and `coverage` (% of total weight with evidence) is stored so a
  job with 2 signals is never presented as "fully verified".

  ## Access
  - Staff read: RLS (account owner scope).
  - Staff write: record_job_trust_event() / refresh_job_trust_score().
  - Customer read: get_public_job_trust(token) — token = jobs.reschedule_token,
    opt-in via business_profile.allow_public_trust_page (default off).
*/

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS allow_public_trust_page boolean NOT NULL DEFAULT false;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS job_trust_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  signal text NOT NULL CHECK (signal IN (
    'eta_accuracy', 'technician_identity', 'price_transparency', 'diagnosis_confidence',
    'quote_change', 'communication_quality', 'arrival_punctuality', 'work_evidence',
    'warranty', 'payment_transparency'
  )),
  score numeric(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  verified boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'staff', 'customer')),
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_trust_events_job_signal
  ON job_trust_events(job_id, signal, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_trust_events_user_created
  ON job_trust_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_trust_scores (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  trust_score numeric(5, 1) CHECK (trust_score IS NULL OR trust_score BETWEEN 0 AND 100),
  tier text NOT NULL DEFAULT 'pending' CHECK (tier IN ('excellent', 'good', 'fair', 'at_risk', 'pending')),
  coverage numeric(5, 1) NOT NULL DEFAULT 0,
  dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  badges jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_trust_scores_user_updated
  ON job_trust_scores(user_id, updated_at DESC);

-- =============================================================
-- RLS (read-only for clients; all writes via functions below)
-- =============================================================

ALTER TABLE job_trust_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_trust_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_job_trust_events" ON job_trust_events;
CREATE POLICY "select_own_job_trust_events" ON job_trust_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_job_trust_scores" ON job_trust_scores;
CREATE POLICY "select_own_job_trust_scores" ON job_trust_scores
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Evidence is immutable: rows can only be appended.
CREATE OR REPLACE FUNCTION public.prevent_job_trust_event_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_trust_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_job_trust_events_immutable ON job_trust_events;
CREATE TRIGGER trg_job_trust_events_immutable
  BEFORE UPDATE ON job_trust_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_job_trust_event_update();

-- =============================================================
-- SCORE ENGINE (internal — not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._recompute_job_trust(p_job_id uuid)
RETURNS job_trust_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_pen numeric;
  v_qn integer;
  v_has_lock boolean;
  v_dims jsonb;
  v_total numeric;
  v_weight numeric;
  v_b_identity boolean;
  v_b_price boolean;
  v_b_quote_bad boolean;
  v_b_work boolean;
  v_b_warranty boolean;
  v_b_parts boolean;
  v_score numeric;
  v_cov numeric;
  v_tier text;
  v_row job_trust_scores;
BEGIN
  SELECT user_id INTO v_user FROM jobs WHERE id = p_job_id;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  -- Quote stability: each customer-approved change costs 8 points, each
  -- unapproved change costs 30.
  SELECT
    COALESCE(SUM(CASE WHEN COALESCE((metadata->>'customer_approved')::boolean, false) THEN 8 ELSE 30 END), 0),
    COUNT(*)
  INTO v_pen, v_qn
  FROM job_trust_events WHERE job_id = p_job_id AND signal = 'quote_change';

  SELECT EXISTS (
    SELECT 1 FROM job_trust_events WHERE job_id = p_job_id AND signal = 'price_transparency'
  ) INTO v_has_lock;

  WITH weights(signal, weight) AS (
    VALUES
      ('eta_accuracy', 12), ('technician_identity', 12), ('price_transparency', 12),
      ('work_evidence', 12), ('arrival_punctuality', 10), ('diagnosis_confidence', 8),
      ('communication_quality', 8), ('warranty', 8), ('payment_transparency', 8)
  ),
  latest AS (
    SELECT DISTINCT ON (signal) signal, score, verified
    FROM job_trust_events
    WHERE job_id = p_job_id AND signal <> 'quote_change'
    ORDER BY signal, created_at DESC, id DESC
  ),
  dims AS (
    SELECT w.signal::text AS signal, w.weight::integer AS weight, l.score::numeric AS score, l.verified AS verified
    FROM weights w JOIN latest l ON l.signal = w.signal
    UNION ALL
    SELECT 'quote_changes'::text, 10, GREATEST(0, 100 - v_pen)::numeric, v_has_lock
    WHERE v_qn > 0 OR v_has_lock
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object('signal', signal, 'weight', weight, 'score', round(score, 1), 'verified', verified)
      ORDER BY weight DESC, signal
    ), '[]'::jsonb),
    SUM(score * weight),
    SUM(weight),
    COALESCE(bool_or(signal = 'technician_identity' AND verified AND score >= 90), false),
    COALESCE(bool_or(signal = 'price_transparency' AND score >= 70), false),
    COALESCE(bool_or(signal = 'quote_changes' AND score < 70), false),
    COALESCE(bool_or(signal = 'work_evidence' AND verified AND score >= 90), false),
    COALESCE(bool_or(signal = 'warranty' AND verified AND score > 0), false)
  INTO v_dims, v_total, v_weight, v_b_identity, v_b_price, v_b_quote_bad, v_b_work, v_b_warranty
  FROM dims;

  SELECT COALESCE((
    SELECT (metadata->>'parts_verified')::boolean
    FROM job_trust_events
    WHERE job_id = p_job_id AND signal = 'diagnosis_confidence'
    ORDER BY created_at DESC, id DESC LIMIT 1
  ), false) INTO v_b_parts;

  IF v_weight IS NULL OR v_weight = 0 THEN
    v_score := NULL;
    v_cov := 0;
  ELSE
    v_score := round(v_total / v_weight, 1);
    v_cov := v_weight;
  END IF;

  v_tier := CASE
    WHEN v_score IS NULL OR v_cov < 40 THEN 'pending'
    WHEN v_score >= 90 THEN 'excellent'
    WHEN v_score >= 75 THEN 'good'
    WHEN v_score >= 60 THEN 'fair'
    ELSE 'at_risk'
  END;

  INSERT INTO job_trust_scores (job_id, user_id, trust_score, tier, coverage, dimensions, badges, updated_at)
  VALUES (
    p_job_id, v_user, v_score, v_tier, v_cov, v_dims,
    jsonb_build_object(
      'technician_verified', v_b_identity,
      'price_locked', v_b_price AND NOT v_b_quote_bad,
      'parts_verified', v_b_parts,
      'work_documented', v_b_work,
      'warranty_active', v_b_warranty
    ),
    now()
  )
  ON CONFLICT (job_id) DO UPDATE SET
    trust_score = EXCLUDED.trust_score,
    tier = EXCLUDED.tier,
    coverage = EXCLUDED.coverage,
    dimensions = EXCLUDED.dimensions,
    badges = EXCLUDED.badges,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public._recompute_job_trust(uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- AUTOMATIC SYSTEM SIGNALS (from real job data)
-- A trust-telemetry failure must NEVER block a dispatch/job update,
-- so the whole body is guarded and only raises a WARNING.
-- =============================================================

CREATE OR REPLACE FUNCTION public.trg_job_trust_signals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_creds integer := 0;
  v_late numeric;
  v_promised timestamptz;
  v_locked numeric;
  v_var numeric;
  v_score numeric;
  v_old jobs%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := OLD;
  END IF;
  BEGIN
    -- 1) Technician identity
    IF NEW.assigned_technician_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.assigned_technician_id IS DISTINCT FROM v_old.assigned_technician_id) THEN
      BEGIN
        SELECT count(*) INTO v_creds
        FROM technician_credentials
        WHERE technician_id = NEW.assigned_technician_id
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at >= current_date);
      EXCEPTION WHEN undefined_table OR undefined_column THEN
        v_creds := 0;
      END;
      INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail, metadata)
      VALUES (
        NEW.user_id, NEW.id, 'technician_identity',
        CASE WHEN v_creds > 0 THEN 100 ELSE 45 END, v_creds > 0, 'system',
        CASE WHEN v_creds > 0 THEN 'Assigned technician holds active credentials on file'
             ELSE 'Technician assigned; no active credentials on file' END,
        jsonb_build_object('technician_id', NEW.assigned_technician_id, 'active_credentials', v_creds)
      );
    END IF;

    -- 2) Arrival: punctuality vs schedule, ETA accuracy vs promised ETA
    IF TG_OP = 'UPDATE' AND NEW.job_status = 'in_progress' AND v_old.job_status IS DISTINCT FROM 'in_progress' THEN
      IF NEW.scheduled_datetime IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM job_trust_events WHERE job_id = NEW.id AND signal = 'arrival_punctuality') THEN
        v_late := extract(epoch FROM (now() - NEW.scheduled_datetime)) / 60;
        v_score := CASE WHEN v_late <= 10 THEN 100 ELSE GREATEST(0, 100 - (v_late - 10) * 2.5) END;
        INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail, metadata)
        VALUES (NEW.user_id, NEW.id, 'arrival_punctuality', v_score, true, 'system',
          CASE WHEN v_late <= 10 THEN 'Arrived on time' ELSE 'Arrived ' || round(v_late) || ' min after the scheduled time' END,
          jsonb_build_object('minutes_late', round(v_late)));
      END IF;

      IF NEW.eta_minutes IS NOT NULL AND NEW.eta_set_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM job_trust_events WHERE job_id = NEW.id AND signal = 'eta_accuracy') THEN
        v_promised := NEW.eta_set_at + make_interval(mins => NEW.eta_minutes);
        v_late := extract(epoch FROM (now() - v_promised)) / 60;
        v_score := CASE WHEN v_late <= 5 THEN 100 ELSE GREATEST(0, 100 - (v_late - 5) * 4) END;
        INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail, metadata)
        VALUES (NEW.user_id, NEW.id, 'eta_accuracy', v_score, true, 'system',
          CASE WHEN v_late <= 5 THEN 'Arrived within the promised ETA' ELSE 'Arrived ' || round(v_late) || ' min after the promised ETA' END,
          jsonb_build_object('minutes_late', round(v_late), 'eta_minutes', NEW.eta_minutes));
      END IF;
    END IF;

    -- 3) Work evidence
    IF NEW.evidence_verified_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR v_old.evidence_verified_at IS DISTINCT FROM NEW.evidence_verified_at) THEN
      INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail)
      VALUES (NEW.user_id, NEW.id, 'work_evidence', 100, true, 'system', 'Job photos passed evidence verification');
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.job_status = 'completed' AND v_old.job_status IS DISTINCT FROM 'completed'
       AND NEW.evidence_verified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM job_trust_events WHERE job_id = NEW.id AND signal = 'work_evidence') THEN
      INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail)
      VALUES (NEW.user_id, NEW.id, 'work_evidence', 30, false, 'system', 'Job completed without verified photo evidence');
    END IF;

    -- 4) Payment transparency: invoice vs the price the customer agreed to
    IF NEW.invoice_amount IS NOT NULL AND NEW.invoice_status IN ('sent', 'paid')
       AND (TG_OP = 'INSERT'
            OR v_old.invoice_status IS DISTINCT FROM NEW.invoice_status
            OR v_old.invoice_amount IS DISTINCT FROM NEW.invoice_amount) THEN
      SELECT COALESCE(
        (SELECT (metadata->>'new_total')::numeric FROM job_trust_events
          WHERE job_id = NEW.id AND signal = 'quote_change'
            AND COALESCE((metadata->>'customer_approved')::boolean, false)
          ORDER BY created_at DESC, id DESC LIMIT 1),
        (SELECT (metadata->>'locked_total')::numeric FROM job_trust_events
          WHERE job_id = NEW.id AND signal = 'price_transparency'
          ORDER BY created_at DESC, id DESC LIMIT 1)
      ) INTO v_locked;

      IF v_locked IS NULL THEN
        INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail)
        VALUES (NEW.user_id, NEW.id, 'payment_transparency', 80, false, 'system',
                'Invoice issued; no locked price on record to compare against');
      ELSE
        v_var := abs(NEW.invoice_amount - v_locked) / NULLIF(v_locked, 0) * 100;
        v_score := CASE WHEN v_var IS NULL OR v_var <= 1 THEN 100 ELSE GREATEST(0, 100 - v_var * 4) END;
        INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail, metadata)
        VALUES (NEW.user_id, NEW.id, 'payment_transparency', v_score, true, 'system',
          CASE WHEN v_var IS NULL OR v_var <= 1 THEN 'Invoice matches the agreed price'
               ELSE 'Invoice differs from the agreed price by ' || round(v_var, 1) || '%' END,
          jsonb_build_object('agreed_total', v_locked, 'invoice_amount', NEW.invoice_amount));
      END IF;
    END IF;

    PERFORM public._recompute_job_trust(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trust layer signal failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_trust_signals ON jobs;
CREATE TRIGGER trg_job_trust_signals
  AFTER INSERT OR UPDATE OF assigned_technician_id, job_status, evidence_verified_at, invoice_status, invoice_amount
  ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.trg_job_trust_signals();

-- Backfill an empty (score = null) row for existing jobs so they appear in the dashboard.
INSERT INTO job_trust_scores (job_id, user_id)
SELECT id, user_id FROM jobs
ON CONFLICT (job_id) DO NOTHING;

-- =============================================================
-- STAFF FUNCTIONS
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_job_trust_score(p_job_id uuid)
RETURNS job_trust_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = public.get_account_owner_id()) THEN
    RAISE EXCEPTION 'Job not found';
  END IF;
  RETURN public._recompute_job_trust(p_job_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_job_trust_score(uuid) TO authenticated;

-- Manual signals accepted from staff (fixed scoring rules, no client-supplied score):
--   price_transparency    : locked_total, itemized, customer_acknowledged
--   quote_change          : previous_total, new_total, reason, customer_approved
--   diagnosis_confidence  : confidence_pct, parts_verified
--   communication_quality : response_minutes, updates_sent
--   warranty              : warranty_days
CREATE OR REPLACE FUNCTION public.record_job_trust_event(
  p_job_id uuid,
  p_signal text,
  p_inputs jsonb DEFAULT '{}'::jsonb,
  p_detail text DEFAULT NULL
)
RETURNS job_trust_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_member uuid;
  v_score numeric;
  v_verified boolean := false;
  v_meta jsonb := '{}'::jsonb;
  v_total numeric;
  v_prev numeric;
  v_flag boolean;
  v_flag2 boolean;
  v_num numeric;
  v_num2 numeric;
  v_reason text;
BEGIN
  SELECT user_id INTO v_user FROM jobs WHERE id = p_job_id AND user_id = public.get_account_owner_id();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  SELECT id INTO v_member FROM team_members
  WHERE member_email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1;

  IF p_signal = 'price_transparency' THEN
    v_total := (p_inputs->>'locked_total')::numeric;
    IF v_total IS NULL OR v_total < 0 THEN RAISE EXCEPTION 'locked_total is required'; END IF;
    v_flag := COALESCE((p_inputs->>'itemized')::boolean, false);
    v_flag2 := COALESCE((p_inputs->>'customer_acknowledged')::boolean, false);
    v_score := 40 + CASE WHEN v_flag THEN 30 ELSE 0 END + CASE WHEN v_flag2 THEN 30 ELSE 0 END;
    v_verified := v_flag2;
    v_meta := jsonb_build_object('locked_total', v_total, 'itemized', v_flag, 'customer_acknowledged', v_flag2);

  ELSIF p_signal = 'quote_change' THEN
    v_prev := (p_inputs->>'previous_total')::numeric;
    v_total := (p_inputs->>'new_total')::numeric;
    v_reason := NULLIF(btrim(COALESCE(p_inputs->>'reason', '')), '');
    IF v_prev IS NULL OR v_total IS NULL OR v_prev < 0 OR v_total < 0 THEN
      RAISE EXCEPTION 'previous_total and new_total are required';
    END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'A reason for the quote change is required'; END IF;
    v_flag := COALESCE((p_inputs->>'customer_approved')::boolean, false);
    v_score := CASE WHEN v_flag THEN 85 ELSE 40 END;
    v_verified := v_flag;
    v_meta := jsonb_build_object('previous_total', v_prev, 'new_total', v_total, 'reason', v_reason, 'customer_approved', v_flag);

  ELSIF p_signal = 'diagnosis_confidence' THEN
    v_num := (p_inputs->>'confidence_pct')::numeric;
    IF v_num IS NULL OR v_num < 0 OR v_num > 100 THEN RAISE EXCEPTION 'confidence_pct must be between 0 and 100'; END IF;
    v_flag := COALESCE((p_inputs->>'parts_verified')::boolean, false);
    v_score := v_num;
    v_verified := v_flag;
    v_meta := jsonb_build_object('confidence_pct', v_num, 'parts_verified', v_flag);

  ELSIF p_signal = 'communication_quality' THEN
    v_num := (p_inputs->>'response_minutes')::numeric;
    v_num2 := COALESCE((p_inputs->>'updates_sent')::numeric, 0);
    IF v_num IS NULL OR v_num < 0 OR v_num2 < 0 THEN RAISE EXCEPTION 'response_minutes must be zero or more'; END IF;
    v_score := GREATEST(0,
      CASE WHEN v_num <= 5 THEN 100 WHEN v_num <= 15 THEN 90 WHEN v_num <= 60 THEN 70 ELSE 40 END
      - CASE WHEN v_num2 = 0 THEN 20 ELSE 0 END);
    v_meta := jsonb_build_object('response_minutes', v_num, 'updates_sent', v_num2);

  ELSIF p_signal = 'warranty' THEN
    v_num := (p_inputs->>'warranty_days')::numeric;
    IF v_num IS NULL OR v_num < 0 THEN RAISE EXCEPTION 'warranty_days must be zero or more'; END IF;
    v_score := CASE WHEN v_num >= 365 THEN 100 WHEN v_num >= 90 THEN 90 WHEN v_num >= 30 THEN 75 WHEN v_num > 0 THEN 60 ELSE 0 END;
    v_verified := v_num > 0;
    v_meta := jsonb_build_object('warranty_days', v_num);

  ELSE
    RAISE EXCEPTION 'Signal % cannot be recorded manually', p_signal;
  END IF;

  INSERT INTO job_trust_events (user_id, job_id, signal, score, verified, source, detail, metadata, recorded_by)
  VALUES (v_user, p_job_id, p_signal, v_score, v_verified, 'staff', NULLIF(btrim(COALESCE(p_detail, '')), ''), v_meta, v_member);

  RETURN public._recompute_job_trust(p_job_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_job_trust_event(uuid, text, jsonb, text) TO authenticated;

-- Opt-in switch for the public customer page (business_profile is not
-- directly writable through a shared policy for every member role).
CREATE OR REPLACE FUNCTION public.get_trust_layer_settings()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT allow_public_trust_page FROM business_profile WHERE user_id = public.get_account_owner_id() LIMIT 1),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.set_public_trust_page(p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR auth.uid() IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change this setting';
  END IF;
  UPDATE business_profile SET allow_public_trust_page = p_enabled WHERE user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complete your business profile first';
  END IF;
  RETURN p_enabled;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trust_layer_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_public_trust_page(boolean) TO authenticated;

-- =============================================================
-- CUSTOMER-FACING READ (token-gated, display-safe fields only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_public_job_trust(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_business text;
  v_enabled boolean;
  v_tech text;
  v_s job_trust_scores%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE reschedule_token = p_token;
  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, COALESCE(bp.allow_public_trust_page, false)
  INTO v_business, v_enabled
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_job.user_id;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NULL;
  END IF;

  SELECT member_name INTO v_tech FROM team_members WHERE id = v_job.assigned_technician_id;
  SELECT * INTO v_s FROM job_trust_scores WHERE job_id = v_job.id;

  RETURN jsonb_build_object(
    'business_name', v_business,
    'service_type', v_job.service_type,
    'technician_name', v_tech,
    'job_status', v_job.job_status,
    'trust_score', v_s.trust_score,
    'tier', COALESCE(v_s.tier, 'pending'),
    'coverage', COALESCE(v_s.coverage, 0),
    'dimensions', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('signal', d->>'signal', 'score', (d->>'score')::numeric, 'verified', (d->>'verified')::boolean))
       FROM jsonb_array_elements(v_s.dimensions) d),
      '[]'::jsonb),
    'badges', COALESCE(v_s.badges, '{}'::jsonb),
    'updated_at', v_s.updated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_job_trust(uuid) TO anon, authenticated;
