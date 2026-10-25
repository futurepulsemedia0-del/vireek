/*
  # Fuel Card Integration (/dashboard/fuel-cards)

  Import fuel-card transactions (CSV), match each one to a card, vehicle and
  driver, post fuel cost to vehicle_expenses and flag anomalies.

  - fuel_card_settings : per-account thresholds (one row per account).
  - fuel_cards         : registered cards (last 4 digits only, never a full number).
  - fuel_imports       : one row per imported file (undo = delete_fuel_import).
  - fuel_transactions  : imported rows; de-duplicated per account (dedupe_key).
  - fuel_anomalies     : rule hits per transaction with a review status.

  Matching: card -> vehicle (fuel_cards.vehicle_id), else licence plate.
  Driver: card driver, else the vehicle assignment in force at the purchase time
  (vehicle_assignments history).

  Security: everything is scoped by public.get_account_owner_id() and readable only
  by the owner or a team member with can_manage_team. Tables are written ONLY through
  SECURITY DEFINER functions, so matching and anomaly flags cannot be forged.
  Additive only: nothing existing is altered or dropped.
*/

-- =============================================================
-- ACCESS HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_fuel_cards()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    auth.uid() IS NOT NULL
    AND (
      auth.uid() = public.get_account_owner_id()
      OR EXISTS (
        SELECT 1
          FROM public.team_members tm
          LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
         WHERE tm.account_owner_id = public.get_account_owner_id()
           AND (
             tm.user_id = auth.uid()
             OR lower(tm.member_email) = lower(COALESCE((SELECT u.email FROM auth.users u WHERE u.id = auth.uid()), ''))
           )
           AND (
             COALESCE(tm.permissions ->> 'can_manage_team', 'false') = 'true'
             OR COALESCE(cr.permissions ->> 'can_manage_team', 'false') = 'true'
           )
      )
    ),
    false
  );
$$;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS fuel_card_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  max_gallons_per_txn numeric NOT NULL DEFAULT 40 CHECK (max_gallons_per_txn > 0 AND max_gallons_per_txn <= 500),
  max_txns_per_day integer NOT NULL DEFAULT 3 CHECK (max_txns_per_day BETWEEN 1 AND 20),
  double_swipe_minutes integer NOT NULL DEFAULT 120 CHECK (double_swipe_minutes BETWEEN 5 AND 1440),
  price_tolerance_pct numeric NOT NULL DEFAULT 25 CHECK (price_tolerance_pct BETWEEN 5 AND 200),
  business_hours_start smallint NOT NULL DEFAULT 5 CHECK (business_hours_start BETWEEN 0 AND 23),
  business_hours_end smallint NOT NULL DEFAULT 22 CHECK (business_hours_end BETWEEN 1 AND 24),
  mpg_min numeric NOT NULL DEFAULT 4 CHECK (mpg_min > 0 AND mpg_min <= 100),
  mpg_max numeric NOT NULL DEFAULT 45 CHECK (mpg_max > 0 AND mpg_max <= 200),
  post_to_expenses boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (business_hours_start < business_hours_end),
  CHECK (mpg_min < mpg_max)
);

CREATE TABLE IF NOT EXISTS fuel_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  provider text NOT NULL DEFAULT 'other' CHECK (char_length(btrim(provider)) BETWEEN 1 AND 40),
  card_last4 text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  tank_capacity_gallons numeric CHECK (tank_capacity_gallons IS NULL OR (tank_capacity_gallons > 0 AND tank_capacity_gallons <= 500)),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_cards_provider_last4 ON fuel_cards(user_id, lower(provider), card_last4);
CREATE INDEX IF NOT EXISTS idx_fuel_cards_vehicle ON fuel_cards(vehicle_id);

CREATE TABLE IF NOT EXISTS fuel_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  received_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  unmatched_count integer NOT NULL DEFAULT 0,
  flagged_count integer NOT NULL DEFAULT 0,
  imported_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fuel_imports_user ON fuel_imports(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fuel_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  import_id uuid REFERENCES fuel_imports(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  transaction_at timestamptz NOT NULL,
  provider text,
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  plate text,
  merchant text,
  city text,
  state text,
  product text NOT NULL DEFAULT 'other' CHECK (product IN ('gasoline', 'diesel', 'def', 'electric', 'propane', 'other', 'non_fuel')),
  gallons numeric NOT NULL DEFAULT 0 CHECK (gallons >= 0),
  unit_price numeric CHECK (unit_price IS NULL OR unit_price >= 0),
  amount numeric NOT NULL CHECK (amount >= 0),
  odometer_miles numeric CHECK (odometer_miles IS NULL OR odometer_miles >= 0),
  external_id text,
  card_id uuid REFERENCES fuel_cards(id) ON DELETE SET NULL,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text,
  match_method text NOT NULL DEFAULT 'none' CHECK (match_method IN ('card', 'plate', 'none')),
  expense_id uuid REFERENCES vehicle_expenses(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_fuel_txn_user_time ON fuel_transactions(user_id, transaction_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_txn_vehicle_time ON fuel_transactions(vehicle_id, transaction_at);
CREATE INDEX IF NOT EXISTS idx_fuel_txn_card_time ON fuel_transactions(card_id, transaction_at);
CREATE INDEX IF NOT EXISTS idx_fuel_txn_product_time ON fuel_transactions(user_id, product, transaction_at);
CREATE INDEX IF NOT EXISTS idx_fuel_txn_import ON fuel_transactions(import_id);
CREATE INDEX IF NOT EXISTS idx_fuel_txn_last4 ON fuel_transactions(user_id, card_last4);

CREATE TABLE IF NOT EXISTS fuel_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  transaction_id uuid NOT NULL REFERENCES fuel_transactions(id) ON DELETE CASCADE,
  rule text NOT NULL CHECK (rule IN (
    'card_inactive', 'unregistered_card', 'no_vehicle', 'vehicle_unavailable', 'over_capacity',
    'fuel_type_mismatch', 'non_fuel_purchase', 'double_swipe', 'daily_limit', 'price_outlier',
    'after_hours', 'odometer_regression', 'mpg_outlier'
  )),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, rule)
);

CREATE INDEX IF NOT EXISTS idx_fuel_anomalies_user_status ON fuel_anomalies(user_id, status, created_at DESC);

-- =============================================================
-- RLS: read-only for managers; writes only via the functions below
-- =============================================================

ALTER TABLE fuel_card_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_anomalies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON fuel_card_settings, fuel_cards, fuel_imports, fuel_transactions, fuel_anomalies FROM anon;
REVOKE INSERT, UPDATE, DELETE ON fuel_card_settings, fuel_cards, fuel_imports, fuel_transactions, fuel_anomalies FROM authenticated;

DROP POLICY IF EXISTS "select_fuel_card_settings" ON fuel_card_settings;
CREATE POLICY "select_fuel_card_settings" ON fuel_card_settings FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.can_manage_fuel_cards()));

DROP POLICY IF EXISTS "select_fuel_cards" ON fuel_cards;
CREATE POLICY "select_fuel_cards" ON fuel_cards FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.can_manage_fuel_cards()));

DROP POLICY IF EXISTS "select_fuel_imports" ON fuel_imports;
CREATE POLICY "select_fuel_imports" ON fuel_imports FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.can_manage_fuel_cards()));

DROP POLICY IF EXISTS "select_fuel_transactions" ON fuel_transactions;
CREATE POLICY "select_fuel_transactions" ON fuel_transactions FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.can_manage_fuel_cards()));

DROP POLICY IF EXISTS "select_fuel_anomalies" ON fuel_anomalies;
CREATE POLICY "select_fuel_anomalies" ON fuel_anomalies FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.can_manage_fuel_cards()));

-- =============================================================
-- INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._fuel_try_numeric(p text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' OR char_length(btrim(p)) > 18 THEN
    RETURN NULL;
  END IF;
  IF btrim(p) !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(p)::numeric;
END;
$$;

-- "YYYY-MM-DD[T ]HH:MM[:SS]" (no offset) is read in the account time zone;
-- values with Z / +hh[:mm] keep their own offset. Anything else -> NULL.
CREATE OR REPLACE FUNCTION public._fuel_try_timestamp(p text, p_tz text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(COALESCE(p, ''));
BEGIN
  IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' THEN
    RETURN (replace(v, 'T', ' ')::timestamp) AT TIME ZONE p_tz;
  ELSIF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RETURN v::timestamptz;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._fuel_ensure_settings(p_owner uuid, p_tz text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text := 'UTC';
BEGIN
  IF p_tz IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
    v_tz := p_tz;
  END IF;
  INSERT INTO fuel_card_settings (user_id, timezone) VALUES (p_owner, v_tz)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- Re-derives card / vehicle / driver for the given transactions and keeps
-- vehicle_expenses in sync. Safe to run any number of times.
CREATE OR REPLACE FUNCTION public._fuel_match(p_owner uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_post boolean;
  v_exp uuid;
  r record;
BEGIN
  SELECT s.timezone, s.post_to_expenses INTO v_tz, v_post
    FROM fuel_card_settings s WHERE s.user_id = p_owner;
  IF NOT FOUND THEN
    v_tz := 'UTC';
    v_post := true;
  END IF;

  WITH cand AS (
    SELECT ft.id, ft.transaction_at, ft.plate,
           CASE WHEN cc.n_all = 1 THEN cc.id_all WHEN cc.n_p = 1 THEN cc.id_p END AS card_id
      FROM fuel_transactions ft
      LEFT JOIN LATERAL (
        SELECT count(*) AS n_all,
               (array_agg(c.id))[1] AS id_all,
               count(*) FILTER (WHERE lower(c.provider) = lower(ft.provider)) AS n_p,
               (array_agg(c.id) FILTER (WHERE lower(c.provider) = lower(ft.provider)))[1] AS id_p
          FROM fuel_cards c
         WHERE c.user_id = p_owner AND ft.card_last4 IS NOT NULL AND c.card_last4 = ft.card_last4
      ) cc ON true
     WHERE ft.user_id = p_owner AND ft.id = ANY (p_ids)
  ), veh AS (
    SELECT cand.id, cand.transaction_at, cand.card_id, c.technician_id AS card_tech,
           COALESCE(c.vehicle_id, pv.id) AS vehicle_id,
           CASE WHEN c.vehicle_id IS NOT NULL THEN 'card' WHEN pv.id IS NOT NULL THEN 'plate' ELSE 'none' END AS method
      FROM cand
      LEFT JOIN fuel_cards c ON c.id = cand.card_id
      LEFT JOIN LATERAL (
        SELECT (array_agg(v.id))[1] AS id
          FROM vehicles v
         WHERE v.user_id = p_owner AND cand.plate IS NOT NULL AND cand.plate <> ''
           AND regexp_replace(upper(COALESCE(v.license_plate, '')), '[^A-Z0-9]', '', 'g') = cand.plate
        HAVING count(*) = 1
      ) pv ON true
  ), fin AS (
    SELECT veh.id, veh.card_id, veh.vehicle_id, veh.method,
           COALESCE(veh.card_tech, hist.technician_id, legacy.technician_id) AS tech_id
      FROM veh
      LEFT JOIN LATERAL (
        SELECT va.technician_id
          FROM vehicle_assignments va
         WHERE va.vehicle_id = veh.vehicle_id AND va.technician_id IS NOT NULL
           AND va.assigned_at <= veh.transaction_at
           AND (va.unassigned_at IS NULL OR veh.transaction_at < va.unassigned_at)
         ORDER BY va.assigned_at DESC
         LIMIT 1
      ) hist ON true
      LEFT JOIN LATERAL (
        SELECT v2.assigned_technician_id AS technician_id
          FROM vehicles v2
         WHERE v2.id = veh.vehicle_id AND v2.assigned_technician_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM vehicle_assignments vx WHERE vx.vehicle_id = v2.id)
      ) legacy ON true
  )
  UPDATE fuel_transactions ft
     SET card_id = f.card_id,
         vehicle_id = f.vehicle_id,
         match_method = f.method,
         technician_id = tm.id,
         technician_name = COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email)
    FROM fin f
    LEFT JOIN team_members tm ON tm.id = f.tech_id AND tm.account_owner_id = p_owner
   WHERE ft.id = f.id;

  IF NOT v_post THEN
    RETURN;
  END IF;

  -- A transaction that lost its vehicle must not keep a cost row on it.
  DELETE FROM vehicle_expenses ve
   USING fuel_transactions ft
   WHERE ft.expense_id = ve.id AND ft.user_id = p_owner
     AND ft.id = ANY (p_ids) AND ft.vehicle_id IS NULL;

  -- Vehicle changed: move the existing cost row.
  UPDATE vehicle_expenses ve
     SET vehicle_id = ft.vehicle_id
    FROM fuel_transactions ft
   WHERE ft.expense_id = ve.id AND ft.user_id = p_owner
     AND ft.id = ANY (p_ids) AND ft.vehicle_id IS NOT NULL
     AND ve.vehicle_id <> ft.vehicle_id;

  FOR r IN
    SELECT ft.id, ft.vehicle_id, ft.amount, ft.transaction_at, ft.odometer_miles,
           ft.card_last4, ft.merchant, v.odometer_miles AS veh_odo
      FROM fuel_transactions ft
      JOIN vehicles v ON v.id = ft.vehicle_id
     WHERE ft.user_id = p_owner AND ft.id = ANY (p_ids)
       AND ft.vehicle_id IS NOT NULL AND ft.expense_id IS NULL AND ft.amount > 0
  LOOP
    INSERT INTO vehicle_expenses (user_id, vehicle_id, expense_type, amount, expense_date, odometer_miles, notes)
    VALUES (
      p_owner, r.vehicle_id, 'fuel', r.amount,
      (r.transaction_at AT TIME ZONE v_tz)::date,
      -- A pump-entered odometer is often a typo: only trust a modest increase.
      CASE WHEN r.odometer_miles IS NOT NULL AND r.odometer_miles <= COALESCE(r.veh_odo, 0) + 5000
           THEN r.odometer_miles END,
      left(concat_ws(' - ', 'Fuel card *' || COALESCE(r.card_last4, '----'), NULLIF(btrim(COALESCE(r.merchant, '')), '')), 500)
    )
    RETURNING id INTO v_exp;

    UPDATE fuel_transactions SET expense_id = v_exp WHERE id = r.id;
  END LOOP;
END;
$$;

-- Recomputes OPEN anomalies for the given transactions. Reviewed
-- (confirmed / dismissed) anomalies are kept as they are.
CREATE OR REPLACE FUNCTION public._fuel_evaluate(p_owner uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s fuel_card_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_s FROM fuel_card_settings WHERE user_id = p_owner;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  DELETE FROM fuel_anomalies
   WHERE user_id = p_owner AND transaction_id = ANY (p_ids) AND status = 'open';

  INSERT INTO fuel_anomalies (user_id, transaction_id, rule, severity, details)
  SELECT p_owner, e.id, x.rule, x.severity, x.details
    FROM (
      SELECT ft.id, ft.product, ft.gallons, ft.unit_price, ft.amount,
             ft.odometer_miles AS odo, ft.card_id, ft.vehicle_id, ft.card_last4 AS last4,
             c.status AS card_status, c.tank_capacity_gallons AS card_tank,
             v.status AS veh_status, v.fuel_type AS veh_fuel,
             EXTRACT(HOUR FROM (ft.transaction_at AT TIME ZONE v_s.timezone))::int AS local_hour,
             sw.n AS swipe_n, dl.n AS day_n, pm.n AS price_n, pm.median AS price_median, pv.odo AS prev_odo
        FROM fuel_transactions ft
        LEFT JOIN fuel_cards c ON c.id = ft.card_id
        LEFT JOIN vehicles v ON v.id = ft.vehicle_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS n
            FROM fuel_transactions o
           WHERE ft.card_id IS NOT NULL AND o.user_id = p_owner AND o.card_id = ft.card_id AND o.id <> ft.id
             AND o.transaction_at <= ft.transaction_at
             AND o.transaction_at >= ft.transaction_at - (v_s.double_swipe_minutes * interval '1 minute')
             AND (o.transaction_at < ft.transaction_at OR o.id < ft.id)
        ) sw ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS n
            FROM fuel_transactions o
           WHERE ft.card_id IS NOT NULL AND o.user_id = p_owner AND o.card_id = ft.card_id
             AND o.transaction_at BETWEEN ft.transaction_at - interval '36 hours' AND ft.transaction_at
             AND (o.transaction_at AT TIME ZONE v_s.timezone)::date = (ft.transaction_at AT TIME ZONE v_s.timezone)::date
             AND (o.transaction_at < ft.transaction_at OR o.id <= ft.id)
        ) dl ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY o.unit_price) AS median
            FROM fuel_transactions o
           WHERE ft.product IN ('gasoline', 'diesel') AND ft.unit_price IS NOT NULL AND ft.unit_price > 0
             AND o.user_id = p_owner AND o.product = ft.product AND o.id <> ft.id
             AND o.unit_price IS NOT NULL AND o.unit_price > 0
             AND o.transaction_at BETWEEN ft.transaction_at - interval '30 days' AND ft.transaction_at
        ) pm ON true
        LEFT JOIN LATERAL (
          SELECT o.odometer_miles AS odo
            FROM fuel_transactions o
           WHERE ft.vehicle_id IS NOT NULL AND ft.odometer_miles IS NOT NULL
             AND o.user_id = p_owner AND o.vehicle_id = ft.vehicle_id
             AND o.odometer_miles IS NOT NULL AND o.id <> ft.id
             AND (o.transaction_at < ft.transaction_at OR (o.transaction_at = ft.transaction_at AND o.id < ft.id))
           ORDER BY o.transaction_at DESC, o.id DESC
           LIMIT 1
        ) pv ON true
       WHERE ft.user_id = p_owner AND ft.id = ANY (p_ids)
    ) e
    CROSS JOIN LATERAL (
      VALUES
        ('card_inactive', 'critical',
          jsonb_build_object('card_status', e.card_status),
          e.card_status IN ('suspended', 'cancelled')),
        ('unregistered_card', 'warning',
          jsonb_build_object('card_last4', e.last4),
          e.card_id IS NULL AND e.last4 IS NOT NULL),
        ('no_vehicle', 'warning',
          jsonb_build_object('card_last4', e.last4),
          e.card_id IS NOT NULL AND e.vehicle_id IS NULL),
        ('vehicle_unavailable', CASE WHEN e.veh_status = 'retired' THEN 'critical' ELSE 'warning' END,
          jsonb_build_object('vehicle_status', e.veh_status),
          e.veh_status IN ('retired', 'in_shop')),
        ('over_capacity', 'critical',
          jsonb_build_object('gallons', e.gallons, 'limit', COALESCE(e.card_tank, v_s.max_gallons_per_txn)),
          e.product IN ('gasoline', 'diesel', 'propane')
            AND e.gallons > COALESCE(e.card_tank, v_s.max_gallons_per_txn) * 1.05),
        ('fuel_type_mismatch', 'warning',
          jsonb_build_object('product', e.product, 'vehicle_fuel', e.veh_fuel),
          e.product IN ('gasoline', 'diesel') AND e.veh_fuel IN ('gasoline', 'diesel') AND e.product <> e.veh_fuel),
        ('non_fuel_purchase', 'warning',
          jsonb_build_object('amount', e.amount),
          e.product = 'non_fuel' AND e.amount > 0),
        ('double_swipe', 'warning',
          jsonb_build_object('minutes', v_s.double_swipe_minutes, 'previous_count', e.swipe_n),
          COALESCE(e.swipe_n, 0) > 0),
        ('daily_limit', 'warning',
          jsonb_build_object('count', e.day_n, 'limit', v_s.max_txns_per_day),
          COALESCE(e.day_n, 0) > v_s.max_txns_per_day),
        ('price_outlier', 'warning',
          jsonb_build_object('unit_price', e.unit_price, 'median', round(e.price_median::numeric, 3)),
          COALESCE(e.price_n, 0) >= 8 AND e.unit_price > e.price_median * (1 + v_s.price_tolerance_pct / 100.0)),
        ('after_hours', 'info',
          jsonb_build_object('hour', e.local_hour),
          e.local_hour < v_s.business_hours_start OR e.local_hour >= v_s.business_hours_end),
        ('odometer_regression', 'warning',
          jsonb_build_object('odometer', e.odo, 'previous', e.prev_odo),
          e.odo IS NOT NULL AND e.prev_odo IS NOT NULL AND e.odo < e.prev_odo),
        ('mpg_outlier', 'warning',
          jsonb_build_object(
            'mpg', CASE WHEN e.gallons > 0 THEN round((e.odo - e.prev_odo) / e.gallons, 1) END,
            'miles', e.odo - e.prev_odo),
          e.product IN ('gasoline', 'diesel') AND e.gallons >= 3
            AND e.odo IS NOT NULL AND e.prev_odo IS NOT NULL AND e.odo - e.prev_odo >= 25
            AND ((e.odo - e.prev_odo) / NULLIF(e.gallons, 0) < v_s.mpg_min
              OR (e.odo - e.prev_odo) / NULLIF(e.gallons, 0) > v_s.mpg_max))
    ) AS x(rule, severity, details, hit)
   WHERE x.hit IS TRUE
  ON CONFLICT (transaction_id, rule) DO NOTHING;
END;
$$;

-- =============================================================
-- PUBLIC RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.import_fuel_transactions(
  p_file_name text,
  p_rows jsonb,
  p_timezone text DEFAULT NULL,
  p_provider text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_s fuel_card_settings%ROWTYPE;
  v_import uuid;
  v_row record;
  v_reason text;
  v_ts timestamptz;
  v_digits text;
  v_card text;
  v_plate text;
  v_amount numeric;
  v_gal numeric;
  v_price numeric;
  v_odo numeric;
  v_prod text;
  v_ext text;
  v_prov text;
  v_merchant text;
  v_key text;
  v_id uuid;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_received integer;
  v_dupes integer := 0;
  v_rejected integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_matched integer := 0;
  v_flagged integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Rows must be a list' USING ERRCODE = '22023';
  END IF;
  v_received := jsonb_array_length(p_rows);
  IF v_received = 0 THEN
    RAISE EXCEPTION 'There are no rows to import' USING ERRCODE = '22023';
  END IF;
  IF v_received > 5000 THEN
    RAISE EXCEPTION 'Import at most 5,000 rows at a time' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fuel_import:' || v_owner::text));
  PERFORM public._fuel_ensure_settings(v_owner, p_timezone);
  SELECT * INTO v_s FROM fuel_card_settings WHERE user_id = v_owner;

  INSERT INTO fuel_imports (user_id, file_name, received_count)
  VALUES (v_owner, left(COALESCE(NULLIF(btrim(p_file_name), ''), 'import.csv'), 200), v_received)
  RETURNING id INTO v_import;

  FOR v_row IN
    SELECT t.ord, t.elem FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_reason := NULL;

    IF jsonb_typeof(v_row.elem) <> 'object' THEN
      v_reason := 'Row is not valid';
    ELSE
      v_ts := public._fuel_try_timestamp(v_row.elem ->> 'transaction_at', v_s.timezone);
      v_digits := regexp_replace(COALESCE(v_row.elem ->> 'card_last4', ''), '[^0-9]', '', 'g');
      v_card := CASE WHEN char_length(v_digits) >= 4 THEN right(v_digits, 4) END;
      v_plate := NULLIF(regexp_replace(upper(COALESCE(v_row.elem ->> 'plate', '')), '[^A-Z0-9]', '', 'g'), '');
      v_amount := public._fuel_try_numeric(v_row.elem ->> 'amount');
      v_gal := COALESCE(public._fuel_try_numeric(v_row.elem ->> 'gallons'), 0);
      v_price := public._fuel_try_numeric(v_row.elem ->> 'unit_price');
      v_odo := public._fuel_try_numeric(v_row.elem ->> 'odometer');

      IF v_ts IS NULL THEN
        v_reason := 'Invalid or missing date/time';
      ELSIF v_ts < timestamptz '2000-01-01 00:00:00+00' OR v_ts > now() + interval '2 days' THEN
        v_reason := 'Date is out of range';
      ELSIF v_card IS NULL AND v_plate IS NULL THEN
        v_reason := 'Missing card number or plate';
      ELSIF v_amount IS NULL THEN
        v_reason := 'Invalid or missing amount';
      ELSIF v_amount <= 0 THEN
        v_reason := 'Credit, refund or zero-amount row skipped';
      ELSIF v_amount > 100000 THEN
        v_reason := 'Amount is unrealistically large';
      ELSIF v_gal < 0 THEN
        v_reason := 'Gallons cannot be negative';
      ELSIF v_gal > 1000 THEN
        v_reason := 'Gallons are unrealistically large';
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      v_prod := lower(COALESCE(v_row.elem ->> 'product', ''));
      IF v_prod NOT IN ('gasoline', 'diesel', 'def', 'electric', 'propane', 'other', 'non_fuel') THEN
        v_prod := 'other';
      END IF;
      IF v_odo IS NOT NULL AND (v_odo < 0 OR v_odo > 2000000) THEN
        v_odo := NULL;
      END IF;
      IF v_price IS NOT NULL AND v_price < 0 THEN
        v_price := NULL;
      END IF;
      IF v_price IS NULL AND v_gal > 0 THEN
        v_price := round(v_amount / v_gal, 4);
      END IF;
      v_ext := NULLIF(left(btrim(COALESCE(v_row.elem ->> 'external_id', '')), 80), '');
      v_prov := NULLIF(left(btrim(COALESCE(v_row.elem ->> 'provider', p_provider, '')), 40), '');
      v_merchant := NULLIF(left(btrim(COALESCE(v_row.elem ->> 'merchant', '')), 120), '');

      IF v_ext IS NOT NULL THEN
        v_key := 'x:' || lower(COALESCE(v_prov, '')) || ':' || v_ext;
      ELSE
        v_key := 'h:' || md5(concat_ws('|',
          COALESCE(v_card, ''), COALESCE(v_plate, ''),
          floor(extract(epoch FROM v_ts))::bigint::text,
          round(v_amount * 100)::bigint::text,
          round(v_gal * 1000)::bigint::text,
          lower(COALESCE(v_merchant, ''))));
      END IF;

      v_id := NULL;
      INSERT INTO fuel_transactions (
        user_id, import_id, dedupe_key, transaction_at, provider, card_last4, plate,
        merchant, city, state, product, gallons, unit_price, amount, odometer_miles, external_id
      )
      VALUES (
        v_owner, v_import, v_key, v_ts, v_prov, v_card, v_plate,
        v_merchant,
        NULLIF(left(btrim(COALESCE(v_row.elem ->> 'city', '')), 80), ''),
        NULLIF(left(btrim(COALESCE(v_row.elem ->> 'state', '')), 20), ''),
        v_prod, v_gal, v_price, v_amount, v_odo, v_ext
      )
      ON CONFLICT (user_id, dedupe_key) DO NOTHING
      RETURNING id INTO v_id;

      IF v_id IS NULL THEN
        v_dupes := v_dupes + 1;
      ELSE
        v_ids := array_append(v_ids, v_id);
      END IF;
    ELSE
      v_rejected := v_rejected + 1;
      IF v_rejected <= 25 THEN
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line', COALESCE(
            CASE WHEN jsonb_typeof(v_row.elem) = 'object' THEN v_row.elem ->> 'line' END,
            v_row.ord::text),
          'reason', v_reason));
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_ids) > 0 THEN
    PERFORM public._fuel_match(v_owner, v_ids);
    PERFORM public._fuel_evaluate(v_owner, v_ids);
    SELECT count(*) INTO v_matched FROM fuel_transactions WHERE id = ANY (v_ids) AND vehicle_id IS NOT NULL;
    SELECT count(DISTINCT transaction_id) INTO v_flagged FROM fuel_anomalies WHERE transaction_id = ANY (v_ids);
  END IF;

  UPDATE fuel_imports
     SET inserted_count = cardinality(v_ids),
         duplicate_count = v_dupes,
         rejected_count = v_rejected,
         matched_count = v_matched,
         unmatched_count = cardinality(v_ids) - v_matched,
         flagged_count = v_flagged
   WHERE id = v_import;

  RETURN jsonb_build_object(
    'import_id', v_import,
    'received', v_received,
    'inserted', cardinality(v_ids),
    'duplicates', v_dupes,
    'rejected', v_rejected,
    'matched', v_matched,
    'unmatched', cardinality(v_ids) - v_matched,
    'flagged', v_flagged,
    'errors', v_errors
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.review_fuel_anomalies(p_ids uuid[], p_status text, p_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('open', 'confirmed', 'dismissed') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Select at most 500 items at a time' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'Note must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;

  UPDATE fuel_anomalies
     SET status = p_status,
         note = NULLIF(btrim(COALESCE(p_note, '')), ''),
         reviewed_by = CASE WHEN p_status = 'open' THEN NULL ELSE auth.uid() END,
         reviewed_at = CASE WHEN p_status = 'open' THEN NULL ELSE now() END
   WHERE user_id = v_owner AND id = ANY (p_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_fuel_card(
  p_id uuid,
  p_label text,
  p_provider text,
  p_last4 text,
  p_vehicle_id uuid,
  p_technician_id uuid,
  p_status text,
  p_tank_capacity numeric,
  p_notes text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_label text := btrim(COALESCE(p_label, ''));
  v_provider text := lower(btrim(COALESCE(p_provider, '')));
  v_last4 text := btrim(COALESCE(p_last4, ''));
  v_id uuid;
  v_ids uuid[];
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_label) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Card name must be 1-80 characters' USING ERRCODE = '22023';
  END IF;
  IF v_provider = '' THEN
    v_provider := 'other';
  END IF;
  IF char_length(v_provider) > 40 THEN
    RAISE EXCEPTION 'Provider must be 40 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF v_last4 !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Enter the last 4 digits of the card' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'suspended', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid card status' USING ERRCODE = '22023';
  END IF;
  IF p_tank_capacity IS NOT NULL AND (p_tank_capacity <= 0 OR p_tank_capacity > 500) THEN
    RAISE EXCEPTION 'Tank capacity must be between 0 and 500 gallons' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 500 THEN
    RAISE EXCEPTION 'Notes must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF p_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Vehicle not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_technician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM team_members WHERE id = p_technician_id AND account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Driver not found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO fuel_cards (user_id, label, provider, card_last4, vehicle_id, technician_id, status, tank_capacity_gallons, notes)
      VALUES (v_owner, v_label, v_provider, v_last4, p_vehicle_id, p_technician_id, p_status, p_tank_capacity, NULLIF(btrim(COALESCE(p_notes, '')), ''))
      RETURNING id INTO v_id;
    ELSE
      UPDATE fuel_cards
         SET label = v_label, provider = v_provider, card_last4 = v_last4, vehicle_id = p_vehicle_id,
             technician_id = p_technician_id, status = p_status, tank_capacity_gallons = p_tank_capacity,
             notes = NULLIF(btrim(COALESCE(p_notes, '')), ''), updated_at = now()
       WHERE id = p_id AND user_id = v_owner
       RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'Card not found' USING ERRCODE = 'P0002';
      END IF;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A card with those last 4 digits already exists for this provider' USING ERRCODE = '22023';
  END;

  -- Re-match recent transactions that belong to (or now belong to) this card.
  SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
    FROM (
      SELECT ft.id FROM fuel_transactions ft
       WHERE ft.user_id = v_owner
         AND (ft.card_id = v_id OR ft.card_last4 = v_last4)
         AND ft.transaction_at >= now() - interval '180 days'
       ORDER BY ft.transaction_at DESC
       LIMIT 5000
    ) s;
  IF cardinality(v_ids) > 0 THEN
    PERFORM public._fuel_match(v_owner, v_ids);
    PERFORM public._fuel_evaluate(v_owner, v_ids);
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_fuel_card(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fuel_cards WHERE id = p_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Card not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM fuel_transactions WHERE card_id = p_id) THEN
    RAISE EXCEPTION 'This card has transactions. Set its status to Cancelled instead of deleting it.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM fuel_cards WHERE id = p_id AND user_id = v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_fuel_card_settings(
  p_max_gallons numeric,
  p_max_txns_per_day integer,
  p_double_swipe_minutes integer,
  p_price_tolerance_pct numeric,
  p_hours_start smallint,
  p_hours_end smallint,
  p_mpg_min numeric,
  p_mpg_max numeric,
  p_post_to_expenses boolean,
  p_timezone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;
  IF p_max_gallons IS NULL OR p_max_gallons <= 0 OR p_max_gallons > 500 THEN
    RAISE EXCEPTION 'Max gallons per purchase must be between 0 and 500' USING ERRCODE = '22023';
  END IF;
  IF p_max_txns_per_day IS NULL OR p_max_txns_per_day NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Purchases per day must be between 1 and 20' USING ERRCODE = '22023';
  END IF;
  IF p_double_swipe_minutes IS NULL OR p_double_swipe_minutes NOT BETWEEN 5 AND 1440 THEN
    RAISE EXCEPTION 'Repeat-purchase window must be between 5 and 1440 minutes' USING ERRCODE = '22023';
  END IF;
  IF p_price_tolerance_pct IS NULL OR p_price_tolerance_pct < 5 OR p_price_tolerance_pct > 200 THEN
    RAISE EXCEPTION 'Price tolerance must be between 5 and 200 percent' USING ERRCODE = '22023';
  END IF;
  IF p_hours_start IS NULL OR p_hours_end IS NULL OR p_hours_start NOT BETWEEN 0 AND 23
     OR p_hours_end NOT BETWEEN 1 AND 24 OR p_hours_start >= p_hours_end THEN
    RAISE EXCEPTION 'Business hours are not valid' USING ERRCODE = '22023';
  END IF;
  IF p_mpg_min IS NULL OR p_mpg_max IS NULL OR p_mpg_min <= 0 OR p_mpg_max > 200 OR p_mpg_min >= p_mpg_max THEN
    RAISE EXCEPTION 'MPG range is not valid' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown time zone' USING ERRCODE = '22023';
  END IF;

  INSERT INTO fuel_card_settings (
    user_id, max_gallons_per_txn, max_txns_per_day, double_swipe_minutes, price_tolerance_pct,
    business_hours_start, business_hours_end, mpg_min, mpg_max, post_to_expenses, timezone, updated_at
  )
  VALUES (
    v_owner, p_max_gallons, p_max_txns_per_day, p_double_swipe_minutes, p_price_tolerance_pct,
    p_hours_start, p_hours_end, p_mpg_min, p_mpg_max, COALESCE(p_post_to_expenses, true), p_timezone, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    max_gallons_per_txn = EXCLUDED.max_gallons_per_txn,
    max_txns_per_day = EXCLUDED.max_txns_per_day,
    double_swipe_minutes = EXCLUDED.double_swipe_minutes,
    price_tolerance_pct = EXCLUDED.price_tolerance_pct,
    business_hours_start = EXCLUDED.business_hours_start,
    business_hours_end = EXCLUDED.business_hours_end,
    mpg_min = EXCLUDED.mpg_min,
    mpg_max = EXCLUDED.mpg_max,
    post_to_expenses = EXCLUDED.post_to_expenses,
    timezone = EXCLUDED.timezone,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.rescan_fuel_transactions(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 90), 1), 365);
  v_ids uuid[];
  v_open integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;

  PERFORM public._fuel_ensure_settings(v_owner, NULL);
  PERFORM pg_advisory_xact_lock(hashtext('fuel_import:' || v_owner::text));

  SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
    FROM (
      SELECT ft.id FROM fuel_transactions ft
       WHERE ft.user_id = v_owner AND ft.transaction_at >= now() - (v_days * interval '1 day')
       ORDER BY ft.transaction_at DESC
       LIMIT 10000
    ) s;

  IF cardinality(v_ids) > 0 THEN
    PERFORM public._fuel_match(v_owner, v_ids);
    PERFORM public._fuel_evaluate(v_owner, v_ids);
    SELECT count(*) INTO v_open FROM fuel_anomalies WHERE user_id = v_owner AND status = 'open';
  END IF;

  RETURN jsonb_build_object('scanned', cardinality(v_ids), 'open_anomalies', v_open);
END;
$$;

-- Undo an import: removes its transactions, their anomalies and the cost rows it posted.
CREATE OR REPLACE FUNCTION public.delete_fuel_import(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_fuel_cards() THEN
    RAISE EXCEPTION 'You do not have permission to manage fuel cards' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fuel_imports WHERE id = p_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM vehicle_expenses ve
   USING fuel_transactions ft
   WHERE ft.expense_id = ve.id AND ft.import_id = p_id AND ft.user_id = v_owner;

  DELETE FROM fuel_transactions WHERE import_id = p_id AND user_id = v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  DELETE FROM fuel_imports WHERE id = p_id AND user_id = v_owner;
  RETURN v_n;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.can_manage_fuel_cards() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_fuel_cards() TO authenticated;

REVOKE ALL ON FUNCTION public._fuel_try_numeric(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fuel_try_timestamp(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fuel_ensure_settings(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fuel_match(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fuel_evaluate(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.import_fuel_transactions(text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_fuel_transactions(text, jsonb, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.review_fuel_anomalies(uuid[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_fuel_anomalies(uuid[], text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.save_fuel_card(uuid, text, text, text, uuid, uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_fuel_card(uuid, text, text, text, uuid, uuid, text, numeric, text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_fuel_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fuel_card(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.save_fuel_card_settings(numeric, integer, integer, numeric, smallint, smallint, numeric, numeric, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_fuel_card_settings(numeric, integer, integer, numeric, smallint, smallint, numeric, numeric, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.rescan_fuel_transactions(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rescan_fuel_transactions(integer) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_fuel_import(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fuel_import(uuid) TO authenticated;
