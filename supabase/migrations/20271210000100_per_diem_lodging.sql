/*
  # Per-diem and lodging rules for out-of-town jobs

  ## What this adds
  1. `per_diem_policies`  one row per account: on/off, minimum one-way distance,
     overnight requirement, default meal rate, default nightly lodging cap,
     first/last-day percentage, lodging receipt rule.
  2. `per_diem_rates`     regional overrides (state-wide or one city).
  3. `per_diem_trips`     a technician's out-of-town claim. Amounts are computed by the
     database (never trusted from the client) and the rates are snapshotted on the row.
  4. RPCs: get_per_diem_policy, save_per_diem_policy, preview_per_diem,
     save_per_diem_trip, review_per_diem_trip, delete_per_diem_trip.

  ## Rules (all enforced server-side)
  - A trip qualifies when one-way miles >= min_distance_miles and (if required) it has
    at least one overnight.
  - Meals: first and last day are paid at first_last_day_pct, middle days at 100%.
  - Lodging: paid at actual cost, capped at the nightly cap x nights.
  - Rate lookup: city rate, else state rate, else account default.

  ## Books
  Approving a claim creates an expense (category "Meals & Travel"), allocates it to the job
  when one is linked, and approves it through the existing review_expense(), so the ledger
  posting, reimbursement and job-cost flows stay the single source of truth.

  ## Permissions
  Anyone on the account reads the rules and files their own claims. Reviewing needs
  expense_is_manager() (owner or can_view_billing) and never your own claim unless you are
  the owner. Editing rules needs the owner or (can_view_billing AND can_edit_business_profile).
  No client INSERT/UPDATE/DELETE policies.

  Depends on: 20270415000000_expenses.sql (expenses, expense_categories, review_expense,
  expense_is_manager), the profiles/team_members/jobs tables, log_audit_event, notifications.
*/

-- =============================================================
-- 1) Helpers
-- =============================================================

CREATE OR REPLACE FUNCTION public.per_diem_can_edit_rules()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    coalesce(auth.uid() = public.get_account_owner_id(), false)
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND coalesce(cr.permissions ->> 'can_view_billing', tm.permissions ->> 'can_view_billing', 'false') = 'true'
        AND coalesce(cr.permissions ->> 'can_edit_business_profile', tm.permissions ->> 'can_edit_business_profile', 'false') = 'true'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.per_diem_can_edit_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.per_diem_can_edit_rules() TO authenticated;

-- =============================================================
-- 2) Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS per_diem_policies (
  user_id uuid PRIMARY KEY,                                   -- account owner
  enabled boolean NOT NULL DEFAULT false,
  min_distance_miles integer NOT NULL DEFAULT 50 CHECK (min_distance_miles BETWEEN 0 AND 5000),
  require_overnight boolean NOT NULL DEFAULT true,
  default_meal_cents integer NOT NULL DEFAULT 6800 CHECK (default_meal_cents BETWEEN 0 AND 100000),
  default_lodging_cap_cents integer NOT NULL DEFAULT 12000 CHECK (default_lodging_cap_cents BETWEEN 0 AND 500000),
  first_last_day_pct smallint NOT NULL DEFAULT 75 CHECK (first_last_day_pct BETWEEN 0 AND 100),
  lodging_requires_receipt boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE per_diem_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_per_diem_policies" ON per_diem_policies;
CREATE POLICY "select_per_diem_policies" ON per_diem_policies FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS per_diem_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  city text CHECK (city IS NULL OR char_length(btrim(city)) BETWEEN 1 AND 80),   -- NULL = whole state
  meal_cents integer NOT NULL CHECK (meal_cents BETWEEN 0 AND 100000),
  lodging_cap_cents integer NOT NULL CHECK (lodging_cap_cents BETWEEN 0 AND 500000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_per_diem_rates_city
  ON per_diem_rates (user_id, state, lower(btrim(city))) WHERE city IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_per_diem_rates_state
  ON per_diem_rates (user_id, state) WHERE city IS NULL;

ALTER TABLE per_diem_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_per_diem_rates" ON per_diem_rates;
CREATE POLICY "select_per_diem_rates" ON per_diem_rates FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE TABLE IF NOT EXISTS per_diem_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                                      -- account owner (RLS scope)
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  submitted_by uuid NOT NULL,
  submitted_by_email text,
  traveler_name text NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  destination_city text CHECK (destination_city IS NULL OR char_length(destination_city) <= 80),
  destination_state text NOT NULL CHECK (destination_state ~ '^[A-Z]{2}$'),
  one_way_miles numeric(7, 1) NOT NULL CHECK (one_way_miles >= 0 AND one_way_miles <= 5000),
  start_date date NOT NULL,
  end_date date NOT NULL,
  days integer NOT NULL CHECK (days BETWEEN 1 AND 61),
  nights integer NOT NULL CHECK (nights BETWEEN 0 AND 60),
  meal_rate_cents integer NOT NULL CHECK (meal_rate_cents >= 0),
  lodging_cap_cents integer NOT NULL CHECK (lodging_cap_cents >= 0),
  lodging_actual_cents bigint NOT NULL DEFAULT 0 CHECK (lodging_actual_cents >= 0 AND lodging_actual_cents <= 100000000),
  meal_total_cents bigint NOT NULL CHECK (meal_total_cents >= 0),
  lodging_allowed_cents bigint NOT NULL CHECK (lodging_allowed_cents >= 0),
  total_cents bigint NOT NULL CHECK (total_cents >= 0 AND total_cents <= 100000000),
  eligible boolean NOT NULL DEFAULT true,
  ineligible_reason text,
  receipt_path text,
  receipt_mime text,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date AND end_date - start_date <= 60)
);

CREATE INDEX IF NOT EXISTS idx_per_diem_trips_owner_status ON per_diem_trips(user_id, status, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_per_diem_trips_submitter ON per_diem_trips(user_id, submitted_by, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_per_diem_trips_job ON per_diem_trips(job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.per_diem_trips_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_per_diem_trips_touch ON per_diem_trips;
CREATE TRIGGER trg_per_diem_trips_touch BEFORE UPDATE ON per_diem_trips
  FOR EACH ROW EXECUTE FUNCTION public.per_diem_trips_touch();

ALTER TABLE per_diem_trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_per_diem_trips" ON per_diem_trips;
CREATE POLICY "select_per_diem_trips" ON per_diem_trips FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND (submitted_by = auth.uid() OR public.expense_is_manager()));

REVOKE INSERT, UPDATE, DELETE ON per_diem_policies, per_diem_rates, per_diem_trips FROM anon, authenticated;

-- =============================================================
-- 3) Calculation (single source of truth; the client mirrors it for previews)
-- =============================================================

CREATE OR REPLACE FUNCTION public.per_diem_compute(
  p_owner uuid,
  p_state text,
  p_city text,
  p_start date,
  p_end date,
  p_miles numeric,
  p_lodging_cents bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_pol per_diem_policies%ROWTYPE;
  v_rate per_diem_rates%ROWTYPE;
  v_meal integer;
  v_cap integer;
  v_source text := 'default';
  v_days integer := (p_end - p_start) + 1;
  v_nights integer := (p_end - p_start);
  v_reason text := NULL;
  v_meal_total bigint := 0;
  v_lodging_allowed bigint := 0;
  v_lodging bigint := greatest(coalesce(p_lodging_cents, 0), 0);
BEGIN
  SELECT * INTO v_pol FROM per_diem_policies WHERE user_id = p_owner;
  IF NOT FOUND THEN
    v_meal := 6800; v_cap := 12000;
    v_reason := 'disabled';
  ELSE
    v_meal := v_pol.default_meal_cents;
    v_cap := v_pol.default_lodging_cap_cents;
    IF NOT v_pol.enabled THEN v_reason := 'disabled'; END IF;

    IF nullif(btrim(coalesce(p_city, '')), '') IS NOT NULL THEN
      SELECT * INTO v_rate FROM per_diem_rates
        WHERE user_id = p_owner AND state = p_state AND city IS NOT NULL AND lower(btrim(city)) = lower(btrim(p_city));
      IF FOUND THEN v_source := 'city'; END IF;
    END IF;
    IF v_source = 'default' THEN
      SELECT * INTO v_rate FROM per_diem_rates WHERE user_id = p_owner AND state = p_state AND city IS NULL;
      IF FOUND THEN v_source := 'state'; END IF;
    END IF;
    IF v_source <> 'default' THEN
      v_meal := v_rate.meal_cents;
      v_cap := v_rate.lodging_cap_cents;
    END IF;

    IF v_reason IS NULL AND coalesce(p_miles, 0) < v_pol.min_distance_miles THEN v_reason := 'too_close'; END IF;
    IF v_reason IS NULL AND v_pol.require_overnight AND v_nights < 1 THEN v_reason := 'not_overnight'; END IF;

    IF v_reason IS NULL THEN
      v_meal_total := round(v_meal * (greatest(v_days - 2, 0) + least(v_days, 2) * v_pol.first_last_day_pct / 100.0))::bigint;
      v_lodging_allowed := least(v_lodging, v_cap::bigint * v_nights);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_reason IS NULL,
    'reason', v_reason,
    'days', v_days,
    'nights', v_nights,
    'meal_rate_cents', v_meal,
    'lodging_cap_cents', v_cap,
    'rate_source', v_source,
    'meal_total_cents', v_meal_total,
    'lodging_allowed_cents', v_lodging_allowed,
    'lodging_over_cents', CASE WHEN v_reason IS NULL THEN v_lodging - v_lodging_allowed ELSE 0 END,
    'total_cents', v_meal_total + v_lodging_allowed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.per_diem_compute(uuid, text, text, date, date, numeric, bigint) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 4) RPCs — rules
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_per_diem_policy()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_pol per_diem_policies%ROWTYPE;
  v_rates jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT * INTO v_pol FROM per_diem_policies WHERE user_id = v_owner;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'state', state, 'city', city, 'meal_cents', meal_cents, 'lodging_cap_cents', lodging_cap_cents)
           ORDER BY state, city NULLS FIRST), '[]'::jsonb)
    INTO v_rates FROM per_diem_rates WHERE user_id = v_owner;

  RETURN jsonb_build_object(
    'configured', v_pol.user_id IS NOT NULL,
    'enabled', coalesce(v_pol.enabled, false),
    'min_distance_miles', coalesce(v_pol.min_distance_miles, 50),
    'require_overnight', coalesce(v_pol.require_overnight, true),
    'default_meal_cents', coalesce(v_pol.default_meal_cents, 6800),
    'default_lodging_cap_cents', coalesce(v_pol.default_lodging_cap_cents, 12000),
    'first_last_day_pct', coalesce(v_pol.first_last_day_pct, 75),
    'lodging_requires_receipt', coalesce(v_pol.lodging_requires_receipt, true),
    'can_edit', public.per_diem_can_edit_rules(),
    'rates', v_rates
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_per_diem_policy() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_per_diem_policy() TO authenticated;

CREATE OR REPLACE FUNCTION public.save_per_diem_policy(p_data jsonb, p_rates jsonb DEFAULT '[]'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rates jsonb := coalesce(p_rates, '[]'::jsonb);
  r jsonb;
  v_min integer;
  v_meal integer;
  v_cap integer;
  v_pct integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.per_diem_can_edit_rules() THEN
    RAISE EXCEPTION 'You do not have permission to edit per-diem rules' USING ERRCODE = '42501';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Invalid per-diem rules'; END IF;

  IF coalesce(p_data ->> 'min_distance_miles', '') !~ '^[0-9]{1,4}$' THEN RAISE EXCEPTION 'Minimum distance must be 0 to 5000 miles'; END IF;
  v_min := (p_data ->> 'min_distance_miles')::integer;
  IF v_min > 5000 THEN RAISE EXCEPTION 'Minimum distance must be 0 to 5000 miles'; END IF;

  IF coalesce(p_data ->> 'default_meal_cents', '') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'Enter a valid daily meal rate'; END IF;
  v_meal := (p_data ->> 'default_meal_cents')::integer;
  IF v_meal > 100000 THEN RAISE EXCEPTION 'Daily meal rate cannot exceed $1,000.00'; END IF;

  IF coalesce(p_data ->> 'default_lodging_cap_cents', '') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'Enter a valid nightly lodging cap'; END IF;
  v_cap := (p_data ->> 'default_lodging_cap_cents')::integer;
  IF v_cap > 500000 THEN RAISE EXCEPTION 'Nightly lodging cap cannot exceed $5,000.00'; END IF;

  IF coalesce(p_data ->> 'first_last_day_pct', '') !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'First/last day percentage must be 0 to 100'; END IF;
  v_pct := (p_data ->> 'first_last_day_pct')::integer;
  IF v_pct > 100 THEN RAISE EXCEPTION 'First/last day percentage must be 0 to 100'; END IF;

  IF jsonb_typeof(v_rates) <> 'array' OR jsonb_array_length(v_rates) > 200 THEN RAISE EXCEPTION 'Too many regional rates'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(v_rates) LOOP
    IF coalesce(r ->> 'state', '') !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Each regional rate needs a two-letter state'; END IF;
    IF r ->> 'city' IS NOT NULL AND char_length(btrim(r ->> 'city')) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'City names are limited to 80 characters';
    END IF;
    IF coalesce(r ->> 'meal_cents', '') !~ '^[0-9]{1,6}$' OR (r ->> 'meal_cents')::integer > 100000 THEN
      RAISE EXCEPTION 'Enter a valid meal rate for each region';
    END IF;
    IF coalesce(r ->> 'lodging_cap_cents', '') !~ '^[0-9]{1,6}$' OR (r ->> 'lodging_cap_cents')::integer > 500000 THEN
      RAISE EXCEPTION 'Enter a valid lodging cap for each region';
    END IF;
  END LOOP;

  INSERT INTO per_diem_policies (user_id, enabled, min_distance_miles, require_overnight, default_meal_cents,
    default_lodging_cap_cents, first_last_day_pct, lodging_requires_receipt, updated_by)
  VALUES (v_owner, coalesce((p_data ->> 'enabled')::boolean, false), v_min,
    coalesce((p_data ->> 'require_overnight')::boolean, true), v_meal, v_cap, v_pct::smallint,
    coalesce((p_data ->> 'lodging_requires_receipt')::boolean, true), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    min_distance_miles = EXCLUDED.min_distance_miles,
    require_overnight = EXCLUDED.require_overnight,
    default_meal_cents = EXCLUDED.default_meal_cents,
    default_lodging_cap_cents = EXCLUDED.default_lodging_cap_cents,
    first_last_day_pct = EXCLUDED.first_last_day_pct,
    lodging_requires_receipt = EXCLUDED.lodging_requires_receipt,
    updated_by = auth.uid(),
    updated_at = now();

  DELETE FROM per_diem_rates WHERE user_id = v_owner;
  INSERT INTO per_diem_rates (user_id, state, city, meal_cents, lodging_cap_cents)
  SELECT DISTINCT ON (x ->> 'state', lower(btrim(coalesce(x ->> 'city', ''))))
         v_owner, x ->> 'state', nullif(btrim(coalesce(x ->> 'city', '')), ''),
         (x ->> 'meal_cents')::integer, (x ->> 'lodging_cap_cents')::integer
  FROM jsonb_array_elements(v_rates) x
  ORDER BY x ->> 'state', lower(btrim(coalesce(x ->> 'city', '')));

  PERFORM public.log_audit_event(v_owner, 'per_diem_rules_updated', 'per_diem_policies', v_owner::text);
END;
$$;

REVOKE ALL ON FUNCTION public.save_per_diem_policy(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_per_diem_policy(jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.preview_per_diem(
  p_state text, p_city text, p_start date, p_end date, p_miles numeric, p_lodging_cents bigint DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 60 THEN
    RAISE EXCEPTION 'Enter valid trip dates (up to 61 days)';
  END IF;
  IF coalesce(p_state, '') !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Choose the destination state'; END IF;
  RETURN public.per_diem_compute(v_owner, p_state, p_city, p_start, p_end, p_miles, p_lodging_cents);
END;
$$;

REVOKE ALL ON FUNCTION public.preview_per_diem(text, text, date, date, numeric, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_per_diem(text, text, date, date, numeric, bigint) TO authenticated;

-- =============================================================
-- 5) RPC — file / edit a claim
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_per_diem_trip(p_id uuid, p_data jsonb, p_submit boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_row per_diem_trips%ROWTYPE;
  v_pol per_diem_policies%ROWTYPE;
  v_tm team_members%ROWTYPE;
  v_email text;
  v_name text;
  v_state text;
  v_city text;
  v_start date;
  v_end date;
  v_miles numeric;
  v_lodging bigint;
  v_job uuid;
  v_notes text;
  v_receipt text;
  v_calc jsonb;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Invalid trip data'; END IF;

  SELECT * INTO v_pol FROM per_diem_policies WHERE user_id = v_owner;
  IF NOT FOUND OR NOT v_pol.enabled THEN RAISE EXCEPTION 'Per diem is not turned on for this account'; END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_row FROM per_diem_trips WHERE id = p_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND OR v_row.submitted_by <> v_uid THEN RAISE EXCEPTION 'Trip not found'; END IF;
    IF v_row.status NOT IN ('draft', 'rejected') THEN RAISE EXCEPTION 'Only draft or rejected trips can be edited'; END IF;
  END IF;

  v_state := upper(btrim(coalesce(p_data ->> 'destination_state', '')));
  IF v_state !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Choose the destination state'; END IF;
  v_city := nullif(btrim(coalesce(p_data ->> 'destination_city', '')), '');
  IF v_city IS NOT NULL AND char_length(v_city) > 80 THEN RAISE EXCEPTION 'City names are limited to 80 characters'; END IF;

  IF coalesce(p_data ->> 'start_date', '') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(p_data ->> 'end_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Enter the trip dates';
  END IF;
  BEGIN
    v_start := (p_data ->> 'start_date')::date;
    v_end := (p_data ->> 'end_date')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Enter valid trip dates';
  END;
  IF v_end < v_start THEN RAISE EXCEPTION 'The trip cannot end before it starts'; END IF;
  IF v_end - v_start > 60 THEN RAISE EXCEPTION 'A trip claim can cover up to 61 days'; END IF;
  IF v_end > current_date + 1 THEN RAISE EXCEPTION 'The trip cannot end in the future'; END IF;

  IF coalesce(p_data ->> 'one_way_miles', '') !~ '^[0-9]{1,4}(\.[0-9])?$' THEN RAISE EXCEPTION 'Enter the one-way distance in miles'; END IF;
  v_miles := (p_data ->> 'one_way_miles')::numeric;
  IF v_miles > 5000 THEN RAISE EXCEPTION 'Enter the one-way distance in miles'; END IF;

  IF coalesce(p_data ->> 'lodging_actual_cents', '0') !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Enter a valid lodging amount'; END IF;
  v_lodging := coalesce(p_data ->> 'lodging_actual_cents', '0')::bigint;
  IF v_lodging > 100000000 THEN RAISE EXCEPTION 'Enter a valid lodging amount'; END IF;
  IF v_lodging > 0 AND v_end = v_start THEN RAISE EXCEPTION 'Lodging needs at least one overnight stay'; END IF;

  v_notes := nullif(btrim(coalesce(p_data ->> 'notes', '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN RAISE EXCEPTION 'Notes are limited to 1000 characters'; END IF;

  v_job := NULL;
  IF nullif(p_data ->> 'job_id', '') IS NOT NULL THEN
    IF (p_data ->> 'job_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'The selected job was not found';
    END IF;
    v_job := (p_data ->> 'job_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = v_job AND user_id = v_owner) THEN
      RAISE EXCEPTION 'The selected job was not found';
    END IF;
  END IF;

  v_receipt := nullif(p_data ->> 'receipt_path', '');
  IF v_receipt IS NOT NULL
     AND v_receipt IS DISTINCT FROM (CASE WHEN p_id IS NULL THEN NULL ELSE v_row.receipt_path END)
     AND (v_receipt LIKE '%..%' OR v_receipt NOT LIKE v_owner::text || '/' || v_uid::text || '/%') THEN
    RAISE EXCEPTION 'Invalid receipt';
  END IF;

  IF EXISTS (
    SELECT 1 FROM per_diem_trips t
    WHERE t.user_id = v_owner AND t.submitted_by = v_uid AND t.status <> 'rejected'
      AND (p_id IS NULL OR t.id <> p_id)
      AND daterange(t.start_date, t.end_date, '[]') && daterange(v_start, v_end, '[]')
  ) THEN
    RAISE EXCEPTION 'You already have a trip claim that overlaps these dates';
  END IF;

  v_calc := public.per_diem_compute(v_owner, v_state, v_city, v_start, v_end, v_miles, v_lodging);

  IF p_submit THEN
    IF NOT (v_calc ->> 'eligible')::boolean THEN
      RAISE EXCEPTION '%', CASE v_calc ->> 'reason'
        WHEN 'too_close' THEN 'This trip is under the minimum distance for per diem'
        WHEN 'not_overnight' THEN 'Per diem requires at least one overnight stay'
        ELSE 'This trip does not qualify for per diem' END;
    END IF;
    IF v_lodging > 0 AND v_pol.lodging_requires_receipt AND v_receipt IS NULL THEN
      RAISE EXCEPTION 'Attach the lodging receipt to submit';
    END IF;
    IF (v_calc ->> 'total_cents')::bigint < 1 THEN RAISE EXCEPTION 'This trip has nothing to claim'; END IF;
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  SELECT * INTO v_tm FROM team_members WHERE user_id = v_uid AND account_owner_id = v_owner LIMIT 1;
  v_name := coalesce(v_tm.member_name, v_tm.member_email, v_email, 'Owner');

  IF p_id IS NULL THEN
    INSERT INTO per_diem_trips (user_id, team_member_id, submitted_by, submitted_by_email, traveler_name, job_id,
      destination_city, destination_state, one_way_miles, start_date, end_date, days, nights,
      meal_rate_cents, lodging_cap_cents, lodging_actual_cents, meal_total_cents, lodging_allowed_cents, total_cents,
      eligible, ineligible_reason, receipt_path, receipt_mime, notes, status, submitted_at)
    VALUES (v_owner, v_tm.id, v_uid, v_email, v_name, v_job,
      v_city, v_state, v_miles, v_start, v_end, (v_calc ->> 'days')::integer, (v_calc ->> 'nights')::integer,
      (v_calc ->> 'meal_rate_cents')::integer, (v_calc ->> 'lodging_cap_cents')::integer, v_lodging,
      (v_calc ->> 'meal_total_cents')::bigint, (v_calc ->> 'lodging_allowed_cents')::bigint, (v_calc ->> 'total_cents')::bigint,
      (v_calc ->> 'eligible')::boolean, v_calc ->> 'reason', v_receipt, nullif(p_data ->> 'receipt_mime', ''), v_notes,
      CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END, CASE WHEN p_submit THEN now() END)
    RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE per_diem_trips SET
      job_id = v_job, destination_city = v_city, destination_state = v_state, one_way_miles = v_miles,
      start_date = v_start, end_date = v_end, days = (v_calc ->> 'days')::integer, nights = (v_calc ->> 'nights')::integer,
      meal_rate_cents = (v_calc ->> 'meal_rate_cents')::integer, lodging_cap_cents = (v_calc ->> 'lodging_cap_cents')::integer,
      lodging_actual_cents = v_lodging, meal_total_cents = (v_calc ->> 'meal_total_cents')::bigint,
      lodging_allowed_cents = (v_calc ->> 'lodging_allowed_cents')::bigint, total_cents = (v_calc ->> 'total_cents')::bigint,
      eligible = (v_calc ->> 'eligible')::boolean, ineligible_reason = v_calc ->> 'reason',
      receipt_path = v_receipt, receipt_mime = nullif(p_data ->> 'receipt_mime', ''), notes = v_notes,
      status = CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END,
      submitted_at = CASE WHEN p_submit THEN now() END,
      reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
    WHERE id = v_id;
  END IF;

  IF p_submit THEN
    PERFORM public.log_audit_event(v_owner, 'per_diem_submitted', 'per_diem_trips', v_id::text);
    IF v_uid <> v_owner THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (v_owner, 'system', 'Per diem awaiting review',
        v_name || ' submitted ' || to_char((v_calc ->> 'total_cents')::bigint / 100.0, 'FM$999,999,990.00')
          || ' for a trip to ' || coalesce(v_city || ', ', '') || v_state || '.',
        '/dashboard/per-diem');
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_per_diem_trip(uuid, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_per_diem_trip(uuid, jsonb, boolean) TO authenticated;

-- =============================================================
-- 6) RPC — approve / reject (approval flows through the expense ledger)
-- =============================================================

CREATE OR REPLACE FUNCTION public.review_per_diem_trip(p_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  v_row per_diem_trips%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_cat uuid;
  v_exp uuid;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public.expense_is_manager() THEN RAISE EXCEPTION 'You do not have permission to review per diem'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;

  SELECT * INTO v_row FROM per_diem_trips WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found'; END IF;
  IF v_row.status <> 'submitted' THEN RAISE EXCEPTION 'This trip is no longer awaiting review'; END IF;
  IF v_row.submitted_by = v_uid AND v_uid <> v_owner THEN RAISE EXCEPTION 'You cannot review your own trip'; END IF;

  IF p_decision = 'rejected' THEN
    IF v_note IS NULL OR char_length(v_note) < 3 THEN RAISE EXCEPTION 'Add a short reason for the rejection'; END IF;
    UPDATE per_diem_trips SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = left(v_note, 500)
      WHERE id = p_id;
    PERFORM public.log_audit_event(v_owner, 'per_diem_rejected', 'per_diem_trips', p_id::text);
    RETURN;
  END IF;

  IF v_row.total_cents < 1 THEN RAISE EXCEPTION 'This trip has nothing to approve'; END IF;

  PERFORM public.ensure_default_expense_categories();
  SELECT id INTO v_cat FROM expense_categories WHERE user_id = v_owner AND name = 'Meals & Travel';
  IF v_cat IS NULL THEN RAISE EXCEPTION 'The Meals & Travel expense category is missing'; END IF;

  INSERT INTO expenses (user_id, submitted_by, submitted_by_email, vendor_name, expense_date, amount_cents, tax_cents,
    category_id, payment_method, is_reimbursable, notes, receipt_path, receipt_mime, status, submitted_at)
  VALUES (v_owner, v_row.submitted_by, v_row.submitted_by_email,
    left('Per diem & lodging · ' || coalesce(v_row.destination_city || ', ', '') || v_row.destination_state, 120),
    v_row.end_date, v_row.total_cents::integer, 0, v_cat, 'other', true,
    left(format('%s · %s to %s · %s %s · meals %s, lodging %s', v_row.traveler_name, v_row.start_date, v_row.end_date,
      v_row.days, CASE WHEN v_row.days = 1 THEN 'day' ELSE 'days' END,
      to_char(v_row.meal_total_cents / 100.0, 'FM$999,999,990.00'), to_char(v_row.lodging_allowed_cents / 100.0, 'FM$999,999,990.00')), 2000),
    v_row.receipt_path, v_row.receipt_mime, 'submitted', now())
  RETURNING id INTO v_exp;

  IF v_row.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM jobs WHERE id = v_row.job_id AND user_id = v_owner) THEN
    INSERT INTO expense_allocations (expense_id, user_id, job_id, amount_cents)
    VALUES (v_exp, v_owner, v_row.job_id, v_row.total_cents::integer);
  END IF;

  -- Posts the journal entry and writes the expense audit trail.
  PERFORM public.review_expense(v_exp, 'approved', v_note);

  UPDATE per_diem_trips SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(),
    review_note = left(v_note, 500), expense_id = v_exp
  WHERE id = p_id;
  PERFORM public.log_audit_event(v_owner, 'per_diem_approved', 'per_diem_trips', p_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.review_per_diem_trip(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_per_diem_trip(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_per_diem_trip(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  DELETE FROM per_diem_trips
    WHERE id = p_id AND user_id = v_owner AND submitted_by = auth.uid() AND status IN ('draft', 'rejected');
  IF NOT FOUND THEN RAISE EXCEPTION 'Only your own draft or rejected trips can be deleted'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_per_diem_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_per_diem_trip(uuid) TO authenticated;
