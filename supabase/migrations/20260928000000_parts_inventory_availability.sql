/*
  # Parts / Inventory Availability Intelligence

  Tracks parts stock across locations (warehouse + per-technician vans)
  and surfaces whether upcoming jobs are actually ready to be completed
  given what's currently in stock — the same "detection ledger + rollup
  view" pattern already used by underpriced_job_detection and
  rework_intelligence.

  ## Tables
  - inventory_locations       — warehouse / van / jobsite locations
  - inventory_parts           — parts catalog (optionally linked to a
                                 price_book_items service)
  - inventory_stock_levels    — maintained cache: on-hand qty per
                                 part x location (kept in sync by a
                                 trigger off inventory_transactions —
                                 never write to this table directly)
  - inventory_transactions    — append-only stock ledger; the source of
                                 truth. quantity_delta sign is enforced
                                 by transaction_type.
  - job_parts_required        — which parts, and how many, a job needs

  ## Views (security_invoker = true, same as every other view in this
  project — always applies the querying user's own RLS)
  - parts_availability        — per part x location: available qty,
                                 trailing-30-day usage rate, estimated
                                 days of stock left, stockout_risk
  - low_stock_alerts          — parts_availability filtered/rolled up
                                 to just what needs reordering, with a
                                 suggested quantity and cost
  - job_parts_readiness       — per job x required part: is it
                                 available at the assigned tech's van
                                 (falling back to any warehouse)?
  - job_readiness_summary     — job_parts_readiness rolled up per job:
                                 ready / at_risk / no_parts_needed
*/

-- =============================================================
-- INVENTORY_LOCATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL,
  location_type text NOT NULL DEFAULT 'warehouse' CHECK (location_type IN ('warehouse', 'van', 'jobsite', 'other')),
  assigned_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_locations_user_id ON inventory_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_locations_technician ON inventory_locations(assigned_technician_id) WHERE assigned_technician_id IS NOT NULL;

ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own inventory locations"
  ON inventory_locations FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INVENTORY_PARTS
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_number text,
  name text NOT NULL,
  category text,
  unit_label text,
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  reorder_point integer NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  reorder_quantity integer NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  preferred_vendor text,
  price_book_item_id uuid REFERENCES price_book_items(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_inventory_parts_user_id ON inventory_parts(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_parts_price_book_item ON inventory_parts(price_book_item_id) WHERE price_book_item_id IS NOT NULL;

ALTER TABLE inventory_parts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own inventory parts"
  ON inventory_parts FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INVENTORY_STOCK_LEVELS  (maintained cache — write via transactions only)
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_stock_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  quantity_on_hand integer NOT NULL DEFAULT 0,
  quantity_reserved integer NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_levels_part ON inventory_stock_levels(part_id);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_levels_location ON inventory_stock_levels(location_id);

ALTER TABLE inventory_stock_levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view/manage their own stock levels"
  ON inventory_stock_levels FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INVENTORY_TRANSACTIONS  (append-only ledger — source of truth)
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('receipt', 'usage', 'transfer_in', 'transfer_out', 'adjustment', 'return')),
  quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
  unit_cost_cents integer,
  note text,
  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_transactions_sign_matches_type CHECK (
    (transaction_type IN ('receipt', 'return', 'transfer_in') AND quantity_delta > 0)
    OR (transaction_type IN ('usage', 'transfer_out') AND quantity_delta < 0)
    OR (transaction_type = 'adjustment')
  )
);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_part_location ON inventory_transactions(part_id, location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_job ON inventory_transactions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_user_created ON inventory_transactions(user_id, created_at DESC);

ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;

-- Ledger entries are never edited or deleted by users — only inserted and read.
-- Corrections happen via a new 'adjustment' row, not by mutating history.
CREATE POLICY "Users view their own inventory transactions"
  ON inventory_transactions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users record their own inventory transactions"
  ON inventory_transactions FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Keeps inventory_stock_levels as an always-current cache of the ledger.
CREATE OR REPLACE FUNCTION apply_inventory_transaction()
RETURNS trigger AS $$
BEGIN
  INSERT INTO inventory_stock_levels (user_id, part_id, location_id, quantity_on_hand)
  VALUES (NEW.user_id, NEW.part_id, NEW.location_id, NEW.quantity_delta)
  ON CONFLICT (part_id, location_id)
  DO UPDATE SET
    quantity_on_hand = inventory_stock_levels.quantity_on_hand + NEW.quantity_delta,
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_apply_inventory_transaction ON inventory_transactions;
CREATE TRIGGER trg_apply_inventory_transaction
  AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION apply_inventory_transaction();

-- =============================================================
-- JOB_PARTS_REQUIRED
-- =============================================================

CREATE TABLE IF NOT EXISTS job_parts_required (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  quantity_required integer NOT NULL CHECK (quantity_required > 0),
  status text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'allocated', 'installed', 'backordered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_job_parts_required_job ON job_parts_required(job_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_required_part ON job_parts_required(part_id);

ALTER TABLE job_parts_required ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own job parts requirements"
  ON job_parts_required FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- PARTS_AVAILABILITY VIEW
-- =============================================================

CREATE OR REPLACE VIEW parts_availability
WITH (security_invoker = true) AS
WITH usage_30d AS (
  SELECT
    part_id,
    location_id,
    SUM(-quantity_delta)::numeric / 30 AS avg_daily_usage
  FROM inventory_transactions
  WHERE transaction_type = 'usage'
    AND created_at >= now() - interval '30 days'
  GROUP BY part_id, location_id
)
SELECT
  sl.id AS stock_level_id,
  sl.user_id,
  sl.part_id,
  p.name AS part_name,
  p.part_number,
  p.category,
  p.reorder_point,
  p.reorder_quantity,
  p.unit_cost_cents,
  sl.location_id,
  loc.name AS location_name,
  loc.location_type,
  sl.quantity_on_hand,
  sl.quantity_reserved,
  (sl.quantity_on_hand - sl.quantity_reserved) AS quantity_available,
  COALESCE(u.avg_daily_usage, 0) AS avg_daily_usage_30d,
  CASE
    WHEN COALESCE(u.avg_daily_usage, 0) > 0
      THEN ROUND((sl.quantity_on_hand - sl.quantity_reserved)::numeric / u.avg_daily_usage, 1)
    ELSE NULL
  END AS estimated_days_of_stock,
  CASE
    WHEN (sl.quantity_on_hand - sl.quantity_reserved) <= 0 THEN 'critical'
    WHEN (sl.quantity_on_hand - sl.quantity_reserved) <= p.reorder_point THEN 'low'
    WHEN COALESCE(u.avg_daily_usage, 0) > 0
      AND (sl.quantity_on_hand - sl.quantity_reserved)::numeric / u.avg_daily_usage < 3 THEN 'low'
    ELSE 'ok'
  END AS stockout_risk
FROM inventory_stock_levels sl
JOIN inventory_parts p ON p.id = sl.part_id AND p.active = true
JOIN inventory_locations loc ON loc.id = sl.location_id AND loc.active = true
LEFT JOIN usage_30d u ON u.part_id = sl.part_id AND u.location_id = sl.location_id;

GRANT SELECT ON parts_availability TO authenticated;

COMMENT ON VIEW parts_availability IS
  'Live availability per part x location: quantity available, trailing-30-day usage rate, estimated days of stock left, and a stockout_risk tier (critical/low/ok). security_invoker=true.';

-- =============================================================
-- LOW_STOCK_ALERTS VIEW
-- =============================================================

CREATE OR REPLACE VIEW low_stock_alerts
WITH (security_invoker = true) AS
SELECT
  user_id,
  part_id,
  part_name,
  part_number,
  category,
  location_id,
  location_name,
  quantity_available,
  reorder_point,
  estimated_days_of_stock,
  stockout_risk,
  GREATEST(reorder_quantity, reorder_point - quantity_available, 1) AS suggested_reorder_quantity,
  (GREATEST(reorder_quantity, reorder_point - quantity_available, 1) * unit_cost_cents) AS estimated_reorder_cost_cents
FROM parts_availability
WHERE stockout_risk IN ('critical', 'low');

GRANT SELECT ON low_stock_alerts TO authenticated;

COMMENT ON VIEW low_stock_alerts IS
  'parts_availability filtered to parts that need reordering now, with a suggested quantity and cost. security_invoker=true.';

-- =============================================================
-- JOB_PARTS_READINESS VIEW  (core availability intelligence)
-- =============================================================

CREATE OR REPLACE VIEW job_parts_readiness
WITH (security_invoker = true) AS
SELECT
  jpr.id AS requirement_id,
  jpr.user_id,
  jpr.job_id,
  j.customer_name,
  j.scheduled_datetime,
  j.assigned_technician_id,
  jpr.part_id,
  p.name AS part_name,
  jpr.quantity_required,
  jpr.status,
  src.location_id AS source_location_id,
  src.location_name AS source_location_name,
  COALESCE(src.quantity_available, 0) AS quantity_available_at_source,
  CASE
    WHEN src.location_id IS NULL THEN 'no_location'
    WHEN COALESCE(src.quantity_available, 0) >= jpr.quantity_required THEN 'ready'
    ELSE 'short'
  END AS readiness_status,
  GREATEST(jpr.quantity_required - COALESCE(src.quantity_available, 0), 0) AS shortage_quantity
FROM job_parts_required jpr
JOIN jobs j ON j.id = jpr.job_id
JOIN inventory_parts p ON p.id = jpr.part_id
LEFT JOIN LATERAL (
  -- Prefer the assigned technician's own van; fall back to any
  -- warehouse location with the best availability for this part.
  SELECT pa.location_id, pa.location_name, pa.quantity_available
  FROM parts_availability pa
  JOIN inventory_locations loc ON loc.id = pa.location_id
  WHERE pa.part_id = jpr.part_id
    AND pa.user_id = jpr.user_id
    AND (
      loc.assigned_technician_id = j.assigned_technician_id
      OR loc.location_type = 'warehouse'
    )
  ORDER BY
    (loc.assigned_technician_id = j.assigned_technician_id) DESC,
    pa.quantity_available DESC
  LIMIT 1
) src ON true
WHERE j.job_status IN ('scheduled', 'en_route');

GRANT SELECT ON job_parts_readiness TO authenticated;

COMMENT ON VIEW job_parts_readiness IS
  'Per required part on an upcoming job: is it available at the assigned technician''s van (falling back to any warehouse)? readiness_status is ready/short/no_location. security_invoker=true.';

-- =============================================================
-- JOB_READINESS_SUMMARY VIEW
-- =============================================================

CREATE OR REPLACE VIEW job_readiness_summary
WITH (security_invoker = true) AS
SELECT
  user_id,
  job_id,
  customer_name,
  scheduled_datetime,
  assigned_technician_id,
  COUNT(*)::integer AS parts_required_count,
  COUNT(*) FILTER (WHERE readiness_status = 'ready')::integer AS parts_ready_count,
  COUNT(*) FILTER (WHERE readiness_status IN ('short', 'no_location'))::integer AS parts_short_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE readiness_status IN ('short', 'no_location')) = 0 THEN 'ready'
    ELSE 'at_risk'
  END AS overall_status
FROM job_parts_readiness
GROUP BY user_id, job_id, customer_name, scheduled_datetime, assigned_technician_id;

GRANT SELECT ON job_readiness_summary TO authenticated;

COMMENT ON VIEW job_readiness_summary IS
  'job_parts_readiness rolled up per job — ready vs at_risk, so dispatch can see at a glance which upcoming jobs may be delayed for lack of parts. security_invoker=true. A job with zero required-parts rows never appears here (nothing to be at risk of).';
