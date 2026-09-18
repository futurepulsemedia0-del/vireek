/*
  # Proprietary Vertical AI / Data Pipeline

  ## Why
  Every call on the platform is already run through
  `_shared/ai-core/callIntelligence.ts`, which turns a raw transcript into
  structured fields on `calls` — `intent`, `objections_raised`,
  `objections_resolved`, `upsell_opportunities`, `booking_outcome`,
  `call_score`. Today that intelligence is trapped inside one tenant's own
  account. This migration builds the pipeline that turns thousands of
  individual calls, per trade (HVAC, plumbing, electrical, roofing,
  restoration, locksmith), into a single growing asset: which objections
  actually come up in this trade and how often they get resolved, which
  intents most often turn into a booked job, which upsells the AI
  correctly spots — a compounding, cross-tenant data moat no single
  competitor's tenant-siloed transcript log can replicate.

  ## Design — deliberately mirrors 20260923000000_cross_tenant_benchmarking.sql
  This is the second feature in this schema that legitimately touches
  every tenant's data in one pass, so it reuses the same privacy contract
  rather than inventing a new one:

  1. **No raw transcript text ever leaves a tenant's row, and no LLM call
     is made here.** The mining step below is pure SQL over fields an LLM
     already extracted per-tenant at call time. This is intentional: it
     costs zero additional AI tokens, and it means the one thing that
     could actually identify a caller — the transcript itself — is never
     read, copied, or sent anywhere by this pipeline.
  2. **k-anonymity floor.** A signal (an industry + signal_type + phrase
     combination) is only written to the exposed table once at least
     `v_min_tenant_count` (5) distinct tenants each produced at least one
     call carrying it. Below that, the row does not exist.
  3. **Aggregated only, never raw.** `vertical_intelligence_signals` holds
     counts and rates, nothing that traces back to one business or one
     caller.
  4. **SECURITY DEFINER, service_role only.** `mine_vertical_intelligence()`
     is the only place that scans every tenant's calls; no client session
     can invoke it. Scheduling it (pg_cron or an external scheduler
     hitting the `vertical-ai-pipeline` edge function nightly) is an
     operational choice for whoever runs this instance, same as the
     benchmarking feature — not installed by this migration.

  ## What's mined
  Three signal types, one row per (industry, signal_type, normalized
  phrase): `objection` (with resolution_rate — how often it's overcome),
  `intent` (with booking_rate — how often that reason for calling turns
  into a booked job), and `upsell_opportunity` (how often the AI spots
  one). Phrases are normalized (lowercased, whitespace-collapsed) since
  the source fields are short LLM-generated phrases, not free-form prose —
  in practice these cluster tightly within a trade.

  ## Depends on
  Nothing new — reads `calls` (intent, objections_raised,
  objections_resolved, upsell_opportunities, booking_outcome, call_score;
  all added in 20260917000000_call_intelligence.sql and
  20260922000000_call_intelligence_2_upsell_objection.sql) and
  `business_profile.primary_industry`.
*/

-- =============================================================
-- 1. EXPOSED TABLE — anonymized, aggregated signals only
-- =============================================================

CREATE TABLE IF NOT EXISTS vertical_intelligence_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- A primary_industry slug (see src/lib/industries.ts), or 'unspecified'
  -- for tenants with no industry set.
  industry text NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('objection', 'intent', 'upsell_opportunity')),

  -- Normalized (lowercased, whitespace-collapsed) short phrase, e.g.
  -- "too expensive" or "no heat emergency".
  signal_key text NOT NULL CHECK (char_length(signal_key) > 0 AND char_length(signal_key) <= 200),

  period_start date NOT NULL,
  period_end date NOT NULL,

  -- How many distinct tenants contributed at least one call to this row.
  -- Auditable proof the k-anonymity gate below was actually applied.
  tenant_count integer NOT NULL CHECK (tenant_count >= 5),
  occurrence_count integer NOT NULL CHECK (occurrence_count >= tenant_count),

  -- Populated only for signal_type = 'objection': % of calls raising this
  -- objection where it was subsequently resolved.
  resolution_rate numeric(5, 2) CHECK (resolution_rate BETWEEN 0 AND 100),

  -- Populated only for signal_type = 'intent': % of calls with this intent
  -- that ended with booking_outcome = 'booked'.
  booking_rate numeric(5, 2) CHECK (booking_rate BETWEEN 0 AND 100),

  avg_call_score numeric(5, 2) CHECK (avg_call_score BETWEEN 0 AND 100),

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (industry, signal_type, signal_key, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_vertical_intelligence_lookup
  ON vertical_intelligence_signals(industry, signal_type, occurrence_count DESC);

ALTER TABLE vertical_intelligence_signals ENABLE ROW LEVEL SECURITY;

-- Deliberately open to every authenticated tenant: by construction (the
-- CHECK above and mine_vertical_intelligence() below) a row can only exist
-- here once it has cleared k-anonymity, so there is nothing tenant-specific
-- to protect. No INSERT/UPDATE/DELETE policy — written exclusively by
-- mine_vertical_intelligence().
DROP POLICY IF EXISTS "select_vertical_intelligence_signals" ON vertical_intelligence_signals;
CREATE POLICY "select_vertical_intelligence_signals" ON vertical_intelligence_signals
  FOR SELECT TO authenticated USING (true);

-- =============================================================
-- 2. RUN LEDGER — audit trail of each pipeline execution
-- =============================================================

CREATE TABLE IF NOT EXISTS vertical_pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  triggered_by text NOT NULL DEFAULT 'cron' CHECK (triggered_by IN ('cron', 'manual')),
  signals_written integer,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_vertical_pipeline_runs_started_at
  ON vertical_pipeline_runs(started_at DESC);

-- Service-role only, in both directions: no policy is created for
-- `authenticated`, so RLS (enabled below) blocks every client-side read
-- and write. Only the edge function, using the service-role key, can see
-- or write pipeline run history.
ALTER TABLE vertical_pipeline_runs ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 3. MINING FUNCTION — the only path that scans every tenant's calls
-- =============================================================

CREATE OR REPLACE FUNCTION public.mine_vertical_intelligence(p_period_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_tenant_count CONSTANT integer := 5;
  v_start date := CURRENT_DATE - GREATEST(1, LEAST(p_period_days, 90));
  v_end date := CURRENT_DATE;
  v_rows_written integer := 0;
BEGIN
  CREATE TEMP TABLE tmp_call_signals (
    user_id uuid,
    industry text,
    signal_type text,
    signal_key text,
    call_score smallint,
    resolved boolean,
    booked boolean
  ) ON COMMIT DROP;

  -- Objections raised, one row per objection per call.
  INSERT INTO tmp_call_signals (user_id, industry, signal_type, signal_key, call_score, resolved, booked)
  SELECT
    c.user_id,
    COALESCE(NULLIF(trim(bp.primary_industry), ''), 'unspecified'),
    'objection',
    left(regexp_replace(lower(trim(obj)), '\s+', ' ', 'g'), 200),
    c.call_score,
    c.objections_resolved,
    NULL
  FROM calls c
  JOIN business_profile bp ON bp.user_id = c.user_id
  CROSS JOIN LATERAL unnest(c.objections_raised) AS obj
  WHERE c.call_datetime::date BETWEEN v_start AND v_end
    AND trim(obj) <> '';

  -- Intents, one row per call.
  INSERT INTO tmp_call_signals (user_id, industry, signal_type, signal_key, call_score, resolved, booked)
  SELECT
    c.user_id,
    COALESCE(NULLIF(trim(bp.primary_industry), ''), 'unspecified'),
    'intent',
    left(regexp_replace(lower(trim(c.intent)), '\s+', ' ', 'g'), 200),
    c.call_score,
    NULL,
    c.booking_outcome = 'booked'
  FROM calls c
  JOIN business_profile bp ON bp.user_id = c.user_id
  WHERE c.call_datetime::date BETWEEN v_start AND v_end
    AND c.intent IS NOT NULL
    AND trim(c.intent) <> ''
    AND lower(trim(c.intent)) <> 'unknown';

  -- Upsell opportunities the AI detected, one row per opportunity per call.
  INSERT INTO tmp_call_signals (user_id, industry, signal_type, signal_key, call_score, resolved, booked)
  SELECT
    c.user_id,
    COALESCE(NULLIF(trim(bp.primary_industry), ''), 'unspecified'),
    'upsell_opportunity',
    left(regexp_replace(lower(trim(u)), '\s+', ' ', 'g'), 200),
    c.call_score,
    NULL,
    NULL
  FROM calls c
  JOIN business_profile bp ON bp.user_id = c.user_id
  CROSS JOIN LATERAL unnest(c.upsell_opportunities) AS u
  WHERE c.call_datetime::date BETWEEN v_start AND v_end
    AND trim(u) <> '';

  -- Aggregate, gated by k-anonymity, upsert into the exposed table.
  INSERT INTO vertical_intelligence_signals (
    industry, signal_type, signal_key, period_start, period_end,
    tenant_count, occurrence_count, resolution_rate, booking_rate, avg_call_score
  )
  SELECT
    industry,
    signal_type,
    signal_key,
    v_start,
    v_end,
    count(DISTINCT user_id),
    count(*),
    CASE WHEN signal_type = 'objection'
      THEN round(100.0 * count(*) FILTER (WHERE resolved) / NULLIF(count(*) FILTER (WHERE resolved IS NOT NULL), 0), 2)
    END,
    CASE WHEN signal_type = 'intent'
      THEN round(100.0 * count(*) FILTER (WHERE booked) / NULLIF(count(*), 0), 2)
    END,
    round(avg(call_score) FILTER (WHERE call_score IS NOT NULL), 2)
  FROM tmp_call_signals
  GROUP BY industry, signal_type, signal_key
  HAVING count(DISTINCT user_id) >= v_min_tenant_count
  ON CONFLICT (industry, signal_type, signal_key, period_start, period_end) DO UPDATE
    SET tenant_count = EXCLUDED.tenant_count,
        occurrence_count = EXCLUDED.occurrence_count,
        resolution_rate = EXCLUDED.resolution_rate,
        booking_rate = EXCLUDED.booking_rate,
        avg_call_score = EXCLUDED.avg_call_score,
        computed_at = now();

  GET DIAGNOSTICS v_rows_written = ROW_COUNT;

  -- Bound table growth: keep a rolling 90-day history of period snapshots.
  DELETE FROM vertical_intelligence_signals WHERE period_end < CURRENT_DATE - interval '90 days';

  RETURN v_rows_written;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mine_vertical_intelligence(integer) TO service_role;
