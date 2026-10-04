/*
  # Outcome-Based Pricing Engine

  Sell an outcome (e.g. "HVAC uptime 98%") instead of hours or jobs. The price is
  computed client-side by src/lib/outcomePricing.ts (deterministic Monte Carlo);
  this migration stores the quote, enforces its life cycle, and keeps the books
  on delivery (measured uptime, SLA credits, actual cost).

  1. outcome_pricing_settings   One row per account: cost/margin assumptions,
                                credit schedule, annual credit cap.
  2. outcome_guarantee_quotes   A priced guarantee (draft -> quoted -> active ->
                                completed / declined / cancelled) with the full
                                inputs + result snapshot for audit.
  3. outcome_guarantee_assets   Per-equipment line: PM plan, price, expected uptime.
  4. outcome_guarantee_periods  Monthly delivery ledger: downtime, measured uptime,
                                credit owed (computed in SQL, capped per contract year).

  Functions
    outcome_pricing_equipment_history(customer, months)  repair history per asset
    save_outcome_pricing_settings(assumptions, tiers, cap) settings upsert (team-member safe)
    save_outcome_guarantee_draft(payload)                atomic quote + assets insert
    finalize_outcome_quote(quote, note)                  draft -> quoted (review gate)
    activate_outcome_guarantee(quote, start, create)     quoted -> active (+ contract row)
    record_outcome_period(...)                           monthly actuals + credit
    close_outcome_guarantee(quote, status, note)         decline / cancel / complete

  Status changes and the delivery ledger are only possible through the SECURITY
  DEFINER functions: RLS lets the client touch DRAFT quotes only.

  Reuses: customers, equipment, jobs, job_equipment, commercial_contracts,
  public.get_account_owner_id(), public.set_updated_at().

  NOTE: rename this file's timestamp so it sorts AFTER your newest migration.
*/

-- 1) Settings -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_pricing_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE DEFAULT auth.uid(),
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  credit_schedule jsonb NOT NULL DEFAULT '[
    {"up_to_pts": 0.5, "credit_pct": 5},
    {"up_to_pts": 1.5, "credit_pct": 15},
    {"up_to_pts": 3,   "credit_pct": 30},
    {"up_to_pts": 100, "credit_pct": 50}
  ]'::jsonb,
  annual_credit_cap_pct numeric(5,2) NOT NULL DEFAULT 25
    CHECK (annual_credit_cap_pct >= 0 AND annual_credit_cap_pct <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outcome_pricing_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ops" ON outcome_pricing_settings;
CREATE POLICY "select_own_ops" ON outcome_pricing_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_ops" ON outcome_pricing_settings;
CREATE POLICY "insert_own_ops" ON outcome_pricing_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_ops" ON outcome_pricing_settings;
CREATE POLICY "update_own_ops" ON outcome_pricing_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_touch_ops ON outcome_pricing_settings;
CREATE TRIGGER trigger_touch_ops BEFORE UPDATE ON outcome_pricing_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) Quotes ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_guarantee_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES commercial_contracts(id) ON DELETE SET NULL,

  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  outcome_metric text NOT NULL DEFAULT 'uptime' CHECK (outcome_metric IN ('uptime')),
  target_uptime_pct numeric(6,3) NOT NULL CHECK (target_uptime_pct >= 80 AND target_uptime_pct <= 99.99),
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 120),

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'quoted', 'active', 'completed', 'declined', 'cancelled')),
  decision text NOT NULL CHECK (decision IN ('offerable', 'needs_review', 'not_offerable')),
  review_note text,
  reviewed_by uuid,

  monthly_fee_cents bigint NOT NULL CHECK (monthly_fee_cents >= 0),
  annual_price_cents bigint NOT NULL CHECK (annual_price_cents >= 0),
  term_value_cents bigint NOT NULL CHECK (term_value_cents >= 0),
  expected_margin_pct numeric(7,2),
  probability_of_loss numeric(5,4) CHECK (probability_of_loss IS NULL OR (probability_of_loss >= 0 AND probability_of_loss <= 1)),

  model_version text NOT NULL,
  inputs jsonb NOT NULL,
  result jsonb NOT NULL,
  credit_schedule jsonb NOT NULL,
  annual_credit_cap_pct numeric(5,2) NOT NULL CHECK (annual_credit_cap_pct >= 0 AND annual_credit_cap_pct <= 100),

  starts_on date,
  ends_on date,
  finalized_at timestamptz,
  activated_at timestamptz,
  closed_at timestamptz,
  close_note text,

  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT oq_annual_is_12x_monthly CHECK (annual_price_cents = monthly_fee_cents * 12),
  CONSTRAINT oq_dates_ordered CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_ogq_user_status ON outcome_guarantee_quotes(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ogq_customer ON outcome_guarantee_quotes(customer_id);

ALTER TABLE outcome_guarantee_quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ogq" ON outcome_guarantee_quotes;
CREATE POLICY "select_own_ogq" ON outcome_guarantee_quotes FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_draft_ogq" ON outcome_guarantee_quotes;
CREATE POLICY "insert_draft_ogq" ON outcome_guarantee_quotes FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND status = 'draft');
DROP POLICY IF EXISTS "update_draft_ogq" ON outcome_guarantee_quotes;
CREATE POLICY "update_draft_ogq" ON outcome_guarantee_quotes FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND status = 'draft')
  WITH CHECK (user_id = public.get_account_owner_id() AND status = 'draft');
DROP POLICY IF EXISTS "delete_draft_ogq" ON outcome_guarantee_quotes;
CREATE POLICY "delete_draft_ogq" ON outcome_guarantee_quotes FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND status = 'draft');

DROP TRIGGER IF EXISTS trigger_touch_ogq ON outcome_guarantee_quotes;
CREATE TRIGGER trigger_touch_ogq BEFORE UPDATE ON outcome_guarantee_quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3) Assets -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_guarantee_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  quote_id uuid NOT NULL REFERENCES outcome_guarantee_quotes(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,

  label text NOT NULL,
  equipment_type text NOT NULL,
  pm_visits_per_year integer NOT NULL CHECK (pm_visits_per_year BETWEEN 0 AND 12),
  operating_hours_per_year integer NOT NULL CHECK (operating_hours_per_year BETWEEN 100 AND 8760),
  annual_price_cents bigint NOT NULL CHECK (annual_price_cents >= 0 AND annual_price_cents % 12 = 0),
  expected_uptime_pct numeric(7,3),
  p_meet_target numeric(5,4) CHECK (p_meet_target IS NULL OR (p_meet_target >= 0 AND p_meet_target <= 1)),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oga_quote ON outcome_guarantee_assets(quote_id);
CREATE INDEX IF NOT EXISTS idx_oga_equipment ON outcome_guarantee_assets(equipment_id) WHERE equipment_id IS NOT NULL;

ALTER TABLE outcome_guarantee_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_oga" ON outcome_guarantee_assets;
CREATE POLICY "select_own_oga" ON outcome_guarantee_assets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_draft_oga" ON outcome_guarantee_assets;
CREATE POLICY "insert_draft_oga" ON outcome_guarantee_assets FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (
      SELECT 1 FROM outcome_guarantee_quotes q
      WHERE q.id = quote_id AND q.user_id = public.get_account_owner_id() AND q.status = 'draft'
    )
  );

-- 4) Delivery ledger ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_guarantee_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  quote_id uuid NOT NULL REFERENCES outcome_guarantee_quotes(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES outcome_guarantee_assets(id) ON DELETE CASCADE,

  period_start date NOT NULL,
  period_end date NOT NULL,
  operating_minutes integer NOT NULL CHECK (operating_minutes > 0),
  downtime_minutes integer NOT NULL CHECK (downtime_minutes >= 0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),

  measured_uptime_pct numeric(8,4) NOT NULL,
  shortfall_pts numeric(8,4) NOT NULL CHECK (shortfall_pts >= 0),
  credit_pct numeric(5,2) NOT NULL CHECK (credit_pct >= 0 AND credit_pct <= 100),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  actual_cost_cents bigint CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
  notes text,

  recorded_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ogp_period_order CHECK (period_end >= period_start),
  CONSTRAINT ogp_downtime_within_operating CHECK (downtime_minutes <= operating_minutes),
  CONSTRAINT ogp_unique_period UNIQUE (asset_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ogp_quote ON outcome_guarantee_periods(quote_id, period_start DESC);

ALTER TABLE outcome_guarantee_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_ogp" ON outcome_guarantee_periods;
CREATE POLICY "select_own_ogp" ON outcome_guarantee_periods FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP TRIGGER IF EXISTS trigger_touch_ogp ON outcome_guarantee_periods;
CREATE TRIGGER trigger_touch_ogp BEFORE UPDATE ON outcome_guarantee_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5) Repair history per asset (RLS applies: SECURITY INVOKER) -----------------------
CREATE OR REPLACE FUNCTION public.outcome_pricing_equipment_history(
  p_customer_id uuid,
  p_window_months integer DEFAULT 36
)
RETURNS TABLE (equipment_id uuid, repair_events integer, observed_years numeric, last_repair_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    -- Observation can only start when the account started tracking jobs.
    SELECT greatest(
             now() - make_interval(months => least(greatest(p_window_months, 1), 120)),
             coalesce((SELECT min(j.scheduled_datetime) FROM jobs j), now())
           ) AS win_start
  )
  SELECT
    e.id,
    count(j.id)::int,
    round(
      greatest(
        0,
        extract(epoch FROM (now() - greatest(b.win_start, coalesce(e.install_date::timestamptz, b.win_start))))
      )::numeric / 31557600.0, 2
    ),
    max(j.scheduled_datetime)
  FROM equipment e
  CROSS JOIN bounds b
  LEFT JOIN job_equipment je ON je.equipment_id = e.id AND je.service_type = 'repair'
  LEFT JOIN jobs j ON j.id = je.job_id
    AND j.job_status = 'completed'
    AND j.scheduled_datetime >= b.win_start
  WHERE e.customer_id = p_customer_id AND e.status = 'active'
  GROUP BY e.id, b.win_start, e.install_date
$$;

-- 6) Atomic draft save (SECURITY INVOKER: RLS still applies) --------------------------
CREATE OR REPLACE FUNCTION public.save_outcome_guarantee_draft(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_asset jsonb;
  v_sum bigint := 0;
  v_annual bigint := (p_payload->>'annual_price_cents')::bigint;
  v_monthly bigint := (p_payload->>'monthly_fee_cents')::bigint;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF jsonb_typeof(p_payload->'assets') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'assets') = 0 THEN
    RAISE EXCEPTION 'A guarantee needs at least one asset';
  END IF;
  IF v_annual <> v_monthly * 12 THEN RAISE EXCEPTION 'Annual price must equal 12 x monthly fee'; END IF;

  -- RLS (SECURITY INVOKER) hides other accounts' rows, so these also prove ownership.
  IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = (p_payload->>'customer_id')::uuid) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_payload->'assets') AS a
     WHERE NULLIF(a->>'equipment_id', '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM equipment e
          WHERE e.id = (a->>'equipment_id')::uuid
            AND e.customer_id = (p_payload->>'customer_id')::uuid
       )
  ) THEN
    RAISE EXCEPTION 'An asset does not belong to this customer';
  END IF;

  FOR v_asset IN SELECT * FROM jsonb_array_elements(p_payload->'assets') LOOP
    v_sum := v_sum + (v_asset->>'annual_price_cents')::bigint;
  END LOOP;
  IF v_sum <> v_annual THEN RAISE EXCEPTION 'Asset prices (%) do not add up to the quote (%)', v_sum, v_annual; END IF;

  INSERT INTO outcome_guarantee_quotes (
    user_id, customer_id, name, target_uptime_pct, term_months, status, decision,
    monthly_fee_cents, annual_price_cents, term_value_cents, expected_margin_pct, probability_of_loss,
    model_version, inputs, result, credit_schedule, annual_credit_cap_pct
  ) VALUES (
    v_owner,
    (p_payload->>'customer_id')::uuid,
    p_payload->>'name',
    (p_payload->>'target_uptime_pct')::numeric,
    (p_payload->>'term_months')::int,
    'draft',
    p_payload->>'decision',
    v_monthly,
    v_annual,
    (p_payload->>'term_value_cents')::bigint,
    (p_payload->>'expected_margin_pct')::numeric,
    (p_payload->>'probability_of_loss')::numeric,
    p_payload->>'model_version',
    p_payload->'inputs',
    p_payload->'result',
    p_payload->'credit_schedule',
    (p_payload->>'annual_credit_cap_pct')::numeric
  ) RETURNING id INTO v_id;

  INSERT INTO outcome_guarantee_assets (
    user_id, quote_id, equipment_id, label, equipment_type, pm_visits_per_year,
    operating_hours_per_year, annual_price_cents, expected_uptime_pct, p_meet_target, details
  )
  SELECT
    v_owner, v_id,
    NULLIF(a->>'equipment_id', '')::uuid,
    a->>'label', a->>'equipment_type',
    (a->>'pm_visits_per_year')::int,
    (a->>'operating_hours_per_year')::int,
    (a->>'annual_price_cents')::bigint,
    (a->>'expected_uptime_pct')::numeric,
    (a->>'p_meet_target')::numeric,
    coalesce(a->'details', '{}'::jsonb)
  FROM jsonb_array_elements(p_payload->'assets') AS a;

  RETURN v_id;
END;
$$;

-- 7) Draft -> quoted (review gate) --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_outcome_quote(p_quote_id uuid, p_review_note text DEFAULT NULL)
RETURNS outcome_guarantee_quotes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_q outcome_guarantee_quotes;
BEGIN
  SELECT * INTO v_q FROM outcome_guarantee_quotes WHERE id = p_quote_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF v_q.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be finalized (status is %)', v_q.status; END IF;
  IF v_q.decision = 'not_offerable' THEN RAISE EXCEPTION 'This guarantee is not offerable at the requested target'; END IF;
  IF v_q.decision = 'needs_review' AND coalesce(btrim(p_review_note), '') = '' THEN
    RAISE EXCEPTION 'A review note is required to quote a guarantee flagged for review';
  END IF;

  UPDATE outcome_guarantee_quotes
     SET status = 'quoted',
         finalized_at = now(),
         review_note = CASE WHEN v_q.decision = 'needs_review' THEN btrim(p_review_note) ELSE review_note END,
         reviewed_by = CASE WHEN v_q.decision = 'needs_review' THEN auth.uid() ELSE reviewed_by END
   WHERE id = p_quote_id
   RETURNING * INTO v_q;
  RETURN v_q;
END;
$$;

-- 8) Quoted -> active (optionally creates the commercial contract) ------------------------
CREATE OR REPLACE FUNCTION public.activate_outcome_guarantee(
  p_quote_id uuid,
  p_starts_on date,
  p_create_contract boolean DEFAULT true
)
RETURNS outcome_guarantee_quotes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_q outcome_guarantee_quotes;
  v_ends date;
  v_contract uuid;
BEGIN
  IF p_starts_on IS NULL THEN RAISE EXCEPTION 'Start date is required'; END IF;
  SELECT * INTO v_q FROM outcome_guarantee_quotes WHERE id = p_quote_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF v_q.status <> 'quoted' THEN RAISE EXCEPTION 'Only a quoted guarantee can be activated (status is %)', v_q.status; END IF;

  v_ends := (p_starts_on + make_interval(months => v_q.term_months))::date - 1;
  v_contract := v_q.contract_id;

  IF p_create_contract AND v_contract IS NULL THEN
    INSERT INTO commercial_contracts (
      user_id, customer_id, contract_name, contract_type, status,
      start_date, end_date, billing_frequency, contract_value_cents, notes
    ) VALUES (
      v_owner, v_q.customer_id, left(v_q.name, 200), 'service_agreement', 'active',
      p_starts_on, v_ends, 'monthly', least(v_q.term_value_cents, 2147483647)::int,
      format('Outcome guarantee: %s%% uptime, %s-month term (Vireek Outcome Pricing).', v_q.target_uptime_pct, v_q.term_months)
    ) RETURNING id INTO v_contract;
  END IF;

  UPDATE outcome_guarantee_quotes
     SET status = 'active', starts_on = p_starts_on, ends_on = v_ends,
         activated_at = now(), contract_id = v_contract
   WHERE id = p_quote_id
   RETURNING * INTO v_q;
  RETURN v_q;
END;
$$;

-- 9) Monthly delivery ledger: measured uptime -> credit (capped per contract year) -----------
CREATE OR REPLACE FUNCTION public.record_outcome_period(
  p_asset_id uuid,
  p_period_start date,
  p_period_end date,
  p_operating_minutes integer,
  p_downtime_minutes integer,
  p_failures integer DEFAULT 0,
  p_actual_cost_cents bigint DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS outcome_guarantee_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_asset outcome_guarantee_assets;
  v_q outcome_guarantee_quotes;
  v_uptime numeric;
  v_short numeric;
  v_pct numeric := 0;
  v_raw bigint;
  v_year int;
  v_year_start date;
  v_cap bigint;
  v_used bigint;
  v_credit bigint;
  v_row outcome_guarantee_periods;
BEGIN
  SELECT * INTO v_asset FROM outcome_guarantee_assets WHERE id = p_asset_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asset not found'; END IF;
  SELECT * INTO v_q FROM outcome_guarantee_quotes WHERE id = v_asset.quote_id FOR UPDATE;
  IF v_q.status <> 'active' THEN RAISE EXCEPTION 'This guarantee is not active'; END IF;

  IF p_period_start < v_q.starts_on OR p_period_start > v_q.ends_on THEN
    RAISE EXCEPTION 'Period must start inside the contract term (% to %)', v_q.starts_on, v_q.ends_on;
  END IF;
  IF p_period_end < p_period_start OR (p_period_end - p_period_start + 1) NOT BETWEEN 28 AND 31 THEN
    RAISE EXCEPTION 'A billing period must be one month (28-31 days)';
  END IF;
  IF p_operating_minutes IS NULL OR p_operating_minutes <= 0 THEN RAISE EXCEPTION 'Operating minutes must be positive'; END IF;
  IF p_downtime_minutes IS NULL OR p_downtime_minutes < 0 OR p_downtime_minutes > p_operating_minutes THEN
    RAISE EXCEPTION 'Downtime must be between 0 and the operating minutes';
  END IF;
  IF coalesce(p_failures, 0) < 0 THEN RAISE EXCEPTION 'Failures cannot be negative'; END IF;

  v_uptime := round((1 - p_downtime_minutes::numeric / p_operating_minutes) * 100, 4);
  v_short := greatest(0, v_q.target_uptime_pct - v_uptime);

  IF v_short > 0 THEN
    -- First tier whose ceiling covers the shortfall; beyond the last tier use the last tier.
    SELECT (e.t->>'credit_pct')::numeric INTO v_pct
      FROM jsonb_array_elements(v_q.credit_schedule) WITH ORDINALITY AS e(t, ord)
     WHERE (e.t->>'up_to_pts')::numeric >= v_short
     ORDER BY e.ord LIMIT 1;
    IF v_pct IS NULL THEN
      SELECT (e.t->>'credit_pct')::numeric INTO v_pct
        FROM jsonb_array_elements(v_q.credit_schedule) WITH ORDINALITY AS e(t, ord)
       ORDER BY e.ord DESC LIMIT 1;
    END IF;
    v_pct := coalesce(v_pct, 0);
  END IF;

  v_raw := round((v_asset.annual_price_cents / 12) * v_pct / 100);
  v_year := floor((p_period_start - v_q.starts_on) / 365.0)::int;
  v_year_start := v_q.starts_on + (v_year * 365);
  v_cap := floor(v_asset.annual_price_cents * v_q.annual_credit_cap_pct / 100);

  SELECT coalesce(sum(credit_cents), 0) INTO v_used
    FROM outcome_guarantee_periods
   WHERE asset_id = p_asset_id
     AND period_start BETWEEN v_year_start AND v_year_start + 364
     AND period_start <> p_period_start;

  v_credit := least(v_raw, greatest(0, v_cap - v_used));

  INSERT INTO outcome_guarantee_periods (
    user_id, quote_id, asset_id, period_start, period_end, operating_minutes, downtime_minutes,
    failures, measured_uptime_pct, shortfall_pts, credit_pct, credit_cents, actual_cost_cents, notes
  ) VALUES (
    v_owner, v_q.id, p_asset_id, p_period_start, p_period_end, p_operating_minutes, p_downtime_minutes,
    coalesce(p_failures, 0), v_uptime, v_short, v_pct, v_credit, p_actual_cost_cents, nullif(btrim(p_notes), '')
  )
  ON CONFLICT (asset_id, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    operating_minutes = EXCLUDED.operating_minutes,
    downtime_minutes = EXCLUDED.downtime_minutes,
    failures = EXCLUDED.failures,
    measured_uptime_pct = EXCLUDED.measured_uptime_pct,
    shortfall_pts = EXCLUDED.shortfall_pts,
    credit_pct = EXCLUDED.credit_pct,
    credit_cents = EXCLUDED.credit_cents,
    actual_cost_cents = EXCLUDED.actual_cost_cents,
    notes = EXCLUDED.notes,
    recorded_by = auth.uid()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- 10) Decline / cancel / complete ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_outcome_guarantee(p_quote_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS outcome_guarantee_quotes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_q outcome_guarantee_quotes;
BEGIN
  IF p_status NOT IN ('declined', 'cancelled', 'completed') THEN RAISE EXCEPTION 'Invalid status %', p_status; END IF;
  SELECT * INTO v_q FROM outcome_guarantee_quotes WHERE id = p_quote_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF v_q.status IN ('completed', 'declined', 'cancelled') THEN RAISE EXCEPTION 'Already closed (%)', v_q.status; END IF;
  IF p_status = 'completed' AND v_q.status <> 'active' THEN RAISE EXCEPTION 'Only an active guarantee can be completed'; END IF;
  IF p_status = 'declined' AND v_q.status NOT IN ('draft', 'quoted') THEN RAISE EXCEPTION 'Only an unsigned quote can be declined'; END IF;

  UPDATE outcome_guarantee_quotes
     SET status = p_status, closed_at = now(), close_note = nullif(btrim(p_note), '')
   WHERE id = p_quote_id
   RETURNING * INTO v_q;
  RETURN v_q;
END;
$$;

-- 11) Settings upsert (resolves the account owner server-side, so team members can save) -----
CREATE OR REPLACE FUNCTION public.save_outcome_pricing_settings(
  p_assumptions jsonb,
  p_credit_schedule jsonb,
  p_cap_pct numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tier jsonb;
  v_prev numeric := 0;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF jsonb_typeof(p_assumptions) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Assumptions must be an object'; END IF;
  IF jsonb_typeof(p_credit_schedule) IS DISTINCT FROM 'array' OR jsonb_array_length(p_credit_schedule) = 0 THEN
    RAISE EXCEPTION 'Credit schedule needs at least one tier';
  END IF;
  IF p_cap_pct IS NULL OR p_cap_pct < 0 OR p_cap_pct > 100 THEN RAISE EXCEPTION 'Annual credit cap must be 0-100%%'; END IF;

  FOR v_tier IN SELECT * FROM jsonb_array_elements(p_credit_schedule) LOOP
    IF (v_tier->>'up_to_pts')::numeric <= v_prev THEN RAISE EXCEPTION 'Credit tiers must be ascending'; END IF;
    IF (v_tier->>'credit_pct')::numeric < 0 OR (v_tier->>'credit_pct')::numeric > 100 THEN
      RAISE EXCEPTION 'Tier credits must be 0-100%%';
    END IF;
    v_prev := (v_tier->>'up_to_pts')::numeric;
  END LOOP;

  INSERT INTO outcome_pricing_settings (user_id, assumptions, credit_schedule, annual_credit_cap_pct)
  VALUES (v_owner, p_assumptions, p_credit_schedule, p_cap_pct)
  ON CONFLICT (user_id) DO UPDATE SET
    assumptions = EXCLUDED.assumptions,
    credit_schedule = EXCLUDED.credit_schedule,
    annual_credit_cap_pct = EXCLUDED.annual_credit_cap_pct;
END;
$$;

-- Lock down function execution: authenticated users only.
REVOKE ALL ON FUNCTION public.finalize_outcome_quote(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.activate_outcome_guarantee(uuid, date, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_outcome_period(uuid, date, date, integer, integer, integer, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_outcome_guarantee(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_outcome_guarantee_draft(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outcome_pricing_equipment_history(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_outcome_pricing_settings(jsonb, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_outcome_quote(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_outcome_guarantee(uuid, date, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_outcome_period(uuid, date, date, integer, integer, integer, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_outcome_guarantee(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_outcome_guarantee_draft(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outcome_pricing_equipment_history(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_outcome_pricing_settings(jsonb, jsonb, numeric) TO authenticated;
