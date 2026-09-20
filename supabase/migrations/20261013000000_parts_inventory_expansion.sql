/*
  # Parts & Inventory — Deep Expansion

  Extends 20260928000000_parts_inventory_availability.sql (locations,
  parts, stock levels, the append-only transactions ledger, and job
  readiness) with the rest of a real parts-department workflow:

  ## Added to existing tables (additive, non-breaking)
  - inventory_parts            + barcode (scan lookup)
  - inventory_stock_levels     + bin_location_id (informational — does
                                  NOT change the part x location
                                  stock-keeping unit or the ledger
                                  trigger's ON CONFLICT key)
  - inventory_transactions     + bin_location_id (which bin a
                                  receipt/pick was logged against)

  ## New tables
  - inventory_bin_locations    — named bins within a location
  - inventory_vendors          — vendor directory
  - inventory_part_vendors     — vendor catalog: which vendors sell a
                                  part, their SKU/cost/lead time
  - inventory_purchase_orders  — PO header (draft → submitted →
                                  partial → received / cancelled)
  - inventory_purchase_order_lines — PO line items, tracks qty received
  - inventory_part_substitutes — "part B can substitute for part A"
  - inventory_serials          — serial/lot tracking per unit
  - inventory_reservations     — parts reserved (soft-held) for a job,
                                  distinct from the hard ledger; drives
                                  inventory_stock_levels.quantity_reserved
  - inventory_returns          — customer returns AND vendor core
                                  returns (return_type distinguishes),
                                  with core-credit tracking

  ## New views (security_invoker = true, matching every existing view)
  - purchase_order_summary     — PO rollup: lines, qty, cost, received%
  - inventory_forecast         — 30d vs 90d usage trend + suggested par
                                  level (deeper than low_stock_alerts)
  - open_core_returns          — pending core returns with expected
                                  vendor credit, for AP follow-up

  Every new table follows the same convention as the rest of this file:
  user_id owns the row, RLS is FOR ALL user_id = auth.uid(), and any
  quantity math that must stay consistent (reservations →
  quantity_reserved) is done by a SECURITY DEFINER trigger, never by
  client-side read-then-write.
*/

-- =============================================================
-- ALTER EXISTING TABLES
-- =============================================================

ALTER TABLE inventory_parts ADD COLUMN IF NOT EXISTS barcode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_parts_user_barcode_unique'
  ) THEN
    ALTER TABLE inventory_parts
      ADD CONSTRAINT inventory_parts_user_barcode_unique UNIQUE (user_id, barcode);
  END IF;
END $$;

-- =============================================================
-- INVENTORY_BIN_LOCATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_bin_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, code)
);

CREATE INDEX IF NOT EXISTS idx_inventory_bin_locations_location ON inventory_bin_locations(location_id);

ALTER TABLE inventory_bin_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own bin locations"
  ON inventory_bin_locations FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Now that inventory_bin_locations exists, hang the informational
-- bin reference off stock levels and the ledger. Nullable, so every
-- existing row stays valid with no bin assigned.
ALTER TABLE inventory_stock_levels
  ADD COLUMN IF NOT EXISTS bin_location_id uuid REFERENCES inventory_bin_locations(id) ON DELETE SET NULL;

ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS bin_location_id uuid REFERENCES inventory_bin_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_stock_levels_bin ON inventory_stock_levels(bin_location_id) WHERE bin_location_id IS NOT NULL;

-- =============================================================
-- INVENTORY_VENDORS
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  address text,
  default_lead_time_days integer NOT NULL DEFAULT 7 CHECK (default_lead_time_days >= 0),
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_vendors_user_id ON inventory_vendors(user_id);

ALTER TABLE inventory_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own vendors"
  ON inventory_vendors FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INVENTORY_PART_VENDORS  (vendor catalog / cross-reference)
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_part_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  vendor_sku text,
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  lead_time_days integer,
  is_preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_part_vendors_part ON inventory_part_vendors(part_id);
CREATE INDEX IF NOT EXISTS idx_inventory_part_vendors_vendor ON inventory_part_vendors(vendor_id);

ALTER TABLE inventory_part_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own part-vendor catalog"
  ON inventory_part_vendors FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Only one preferred vendor per part.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_part_vendors_one_preferred
  ON inventory_part_vendors(part_id) WHERE is_preferred;

-- =============================================================
-- INVENTORY_PURCHASE_ORDERS + LINES
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE RESTRICT,
  po_number text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'partial', 'received', 'cancelled')),
  destination_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  expected_date date,
  submitted_at timestamptz,
  received_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, po_number)
);

CREATE INDEX IF NOT EXISTS idx_inventory_po_user_status ON inventory_purchase_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_po_vendor ON inventory_purchase_orders(vendor_id);

ALTER TABLE inventory_purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own purchase orders"
  ON inventory_purchase_orders FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS inventory_purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  purchase_order_id uuid NOT NULL REFERENCES inventory_purchase_orders(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE RESTRICT,
  quantity_ordered integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_received integer NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity_received <= quantity_ordered)
);

CREATE INDEX IF NOT EXISTS idx_inventory_po_lines_po ON inventory_purchase_order_lines(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_po_lines_part ON inventory_purchase_order_lines(part_id);

ALTER TABLE inventory_purchase_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own purchase order lines"
  ON inventory_purchase_order_lines FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Keeps the PO header status in step with its lines whenever a line's
-- quantity_received changes (receiving is done by updating the line;
-- the actual stock bump is a separate inventory_transactions insert
-- made by the app in the same action, same as every other stock move).
CREATE OR REPLACE FUNCTION sync_purchase_order_status()
RETURNS trigger AS $$
DECLARE
  v_po_id uuid := COALESCE(NEW.purchase_order_id, OLD.purchase_order_id);
  v_total integer;
  v_received integer;
BEGIN
  SELECT COALESCE(SUM(quantity_ordered), 0), COALESCE(SUM(quantity_received), 0)
    INTO v_total, v_received
    FROM inventory_purchase_order_lines
    WHERE purchase_order_id = v_po_id;

  UPDATE inventory_purchase_orders
  SET
    status = CASE
      WHEN status = 'cancelled' THEN status
      WHEN status = 'draft' THEN status
      WHEN v_total = 0 THEN status
      WHEN v_received >= v_total THEN 'received'
      WHEN v_received > 0 THEN 'partial'
      ELSE 'submitted'
    END,
    received_at = CASE WHEN v_total > 0 AND v_received >= v_total THEN now() ELSE received_at END,
    updated_at = now()
  WHERE id = v_po_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_purchase_order_status ON inventory_purchase_order_lines;
CREATE TRIGGER trg_sync_purchase_order_status
  AFTER INSERT OR UPDATE OF quantity_received OR DELETE ON inventory_purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION sync_purchase_order_status();

-- =============================================================
-- INVENTORY_PART_SUBSTITUTES
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_part_substitutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  substitute_part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, substitute_part_id),
  CHECK (part_id <> substitute_part_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_part_substitutes_part ON inventory_part_substitutes(part_id);

ALTER TABLE inventory_part_substitutes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own part substitutes"
  ON inventory_part_substitutes FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INVENTORY_SERIALS  (serial / lot tracking)
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  serial_number text,
  lot_number text,
  location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'reserved', 'installed', 'returned', 'scrapped')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  installed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (serial_number IS NOT NULL OR lot_number IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serials_unique_serial
  ON inventory_serials(user_id, serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_serials_part ON inventory_serials(part_id);
CREATE INDEX IF NOT EXISTS idx_inventory_serials_lot ON inventory_serials(lot_number) WHERE lot_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_serials_job ON inventory_serials(job_id) WHERE job_id IS NOT NULL;

ALTER TABLE inventory_serials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own serials and lots"
  ON inventory_serials FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INVENTORY_RESERVATIONS  (soft-hold on stock for a job)
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'fulfilled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_part_location ON inventory_reservations(part_id, location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_job ON inventory_reservations(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active ON inventory_reservations(part_id, location_id) WHERE status = 'active';

ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own reservations"
  ON inventory_reservations FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Keeps inventory_stock_levels.quantity_reserved as a live cache of
-- active reservations — same "trigger maintains the cache, ledger/rows
-- are the source of truth" convention as apply_inventory_transaction.
CREATE OR REPLACE FUNCTION apply_inventory_reservation()
RETURNS trigger AS $$
DECLARE
  v_delta integer := 0;
  v_part_id uuid;
  v_location_id uuid;
  v_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' THEN v_delta := NEW.quantity; END IF;
    v_part_id := NEW.part_id; v_location_id := NEW.location_id; v_user_id := NEW.user_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_part_id := NEW.part_id; v_location_id := NEW.location_id; v_user_id := NEW.user_id;
    IF OLD.status = 'active' AND NEW.status <> 'active' THEN
      v_delta := -OLD.quantity;
    ELSIF OLD.status <> 'active' AND NEW.status = 'active' THEN
      v_delta := NEW.quantity;
    ELSIF OLD.status = 'active' AND NEW.status = 'active' AND OLD.quantity <> NEW.quantity THEN
      v_delta := NEW.quantity - OLD.quantity;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'active' THEN v_delta := -OLD.quantity; END IF;
    v_part_id := OLD.part_id; v_location_id := OLD.location_id; v_user_id := OLD.user_id;
  END IF;

  IF v_delta <> 0 THEN
    INSERT INTO inventory_stock_levels (user_id, part_id, location_id, quantity_on_hand, quantity_reserved)
    VALUES (v_user_id, v_part_id, v_location_id, 0, GREATEST(v_delta, 0))
    ON CONFLICT (part_id, location_id)
    DO UPDATE SET
      quantity_reserved = GREATEST(inventory_stock_levels.quantity_reserved + v_delta, 0),
      updated_at = now();
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_apply_inventory_reservation ON inventory_reservations;
CREATE TRIGGER trg_apply_inventory_reservation
  AFTER INSERT OR UPDATE OF status, quantity OR DELETE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION apply_inventory_reservation();

-- =============================================================
-- INVENTORY_RETURNS  (customer returns AND vendor core returns)
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  return_type text NOT NULL CHECK (return_type IN ('customer_return', 'core_return')),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  vendor_id uuid REFERENCES inventory_vendors(id) ON DELETE SET NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text,
  core_credit_cents integer CHECK (core_credit_cents IS NULL OR core_credit_cents >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'credited', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (return_type = 'customer_return' OR vendor_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_inventory_returns_user_status ON inventory_returns(user_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_returns_vendor ON inventory_returns(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_returns_part ON inventory_returns(part_id);

ALTER TABLE inventory_returns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own returns"
  ON inventory_returns FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- RPC: transfer_inventory_stock — atomic transfer_out + transfer_in
-- (two ledger rows, one call, no partial-transfer risk from a
-- client crashing between two separate inserts).
-- =============================================================

CREATE OR REPLACE FUNCTION transfer_inventory_stock(
  p_part_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_quantity integer,
  p_note text DEFAULT NULL,
  p_bin_location_id uuid DEFAULT NULL
)
RETURNS void AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_available integer;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Transfer quantity must be positive';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'Source and destination location must differ';
  END IF;

  SELECT (quantity_on_hand - quantity_reserved) INTO v_available
  FROM inventory_stock_levels
  WHERE part_id = p_part_id AND location_id = p_from_location_id AND user_id = v_user_id;

  IF v_available IS NULL OR v_available < p_quantity THEN
    RAISE EXCEPTION 'Only % available at the source location', COALESCE(v_available, 0);
  END IF;

  INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, note, bin_location_id)
  VALUES (v_user_id, p_part_id, p_from_location_id, 'transfer_out', -p_quantity, p_note, p_bin_location_id);

  INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, note, bin_location_id)
  VALUES (v_user_id, p_part_id, p_to_location_id, 'transfer_in', p_quantity, p_note, p_bin_location_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION transfer_inventory_stock(uuid, uuid, uuid, integer, text, uuid) TO authenticated;

-- =============================================================
-- RPC: receive_purchase_order_line — logs the receiving ledger
-- entry and advances the PO line's quantity_received atomically.
-- =============================================================

CREATE OR REPLACE FUNCTION receive_purchase_order_line(
  p_line_id uuid,
  p_quantity integer,
  p_location_id uuid,
  p_bin_location_id uuid DEFAULT NULL
)
RETURNS void AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_part_id uuid;
  v_unit_cost_cents integer;
  v_remaining integer;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Receive quantity must be positive';
  END IF;

  SELECT part_id, unit_cost_cents, (quantity_ordered - quantity_received)
    INTO v_part_id, v_unit_cost_cents, v_remaining
    FROM inventory_purchase_order_lines
    WHERE id = p_line_id AND user_id = v_user_id
    FOR UPDATE;

  IF v_part_id IS NULL THEN
    RAISE EXCEPTION 'Purchase order line not found';
  END IF;
  IF p_quantity > v_remaining THEN
    RAISE EXCEPTION 'Only % remaining on this line', v_remaining;
  END IF;

  UPDATE inventory_purchase_order_lines
  SET quantity_received = quantity_received + p_quantity
  WHERE id = p_line_id;

  INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note, bin_location_id)
  VALUES (v_user_id, v_part_id, p_location_id, 'receipt', p_quantity, v_unit_cost_cents, 'PO receipt', p_bin_location_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION receive_purchase_order_line(uuid, integer, uuid, uuid) TO authenticated;

-- =============================================================
-- PURCHASE_ORDER_SUMMARY VIEW
-- =============================================================

CREATE OR REPLACE VIEW purchase_order_summary
WITH (security_invoker = true) AS
SELECT
  po.id AS purchase_order_id,
  po.user_id,
  po.po_number,
  po.status,
  po.vendor_id,
  v.name AS vendor_name,
  po.destination_location_id,
  loc.name AS destination_location_name,
  po.expected_date,
  po.submitted_at,
  po.received_at,
  COUNT(l.id)::integer AS line_count,
  COALESCE(SUM(l.quantity_ordered), 0)::integer AS total_quantity_ordered,
  COALESCE(SUM(l.quantity_received), 0)::integer AS total_quantity_received,
  COALESCE(SUM(l.quantity_ordered * l.unit_cost_cents), 0)::bigint AS total_cost_cents,
  CASE
    WHEN COALESCE(SUM(l.quantity_ordered), 0) = 0 THEN 0
    ELSE ROUND(100.0 * COALESCE(SUM(l.quantity_received), 0) / SUM(l.quantity_ordered))
  END::integer AS percent_received
FROM inventory_purchase_orders po
JOIN inventory_vendors v ON v.id = po.vendor_id
LEFT JOIN inventory_locations loc ON loc.id = po.destination_location_id
LEFT JOIN inventory_purchase_order_lines l ON l.purchase_order_id = po.id
GROUP BY po.id, v.name, loc.name;

GRANT SELECT ON purchase_order_summary TO authenticated;

COMMENT ON VIEW purchase_order_summary IS
  'Purchase order header rolled up with its line totals — quantity ordered/received, total cost, percent received. security_invoker=true.';

-- =============================================================
-- INVENTORY_FORECAST VIEW  (deeper than low_stock_alerts: trend-aware)
-- =============================================================

CREATE OR REPLACE VIEW inventory_forecast
WITH (security_invoker = true) AS
WITH usage_30d AS (
  SELECT part_id, location_id, SUM(-quantity_delta)::numeric / 30 AS avg_daily_usage_30d
  FROM inventory_transactions
  WHERE transaction_type = 'usage' AND created_at >= now() - interval '30 days'
  GROUP BY part_id, location_id
),
usage_prior_30d AS (
  SELECT part_id, location_id, SUM(-quantity_delta)::numeric / 30 AS avg_daily_usage_prior_30d
  FROM inventory_transactions
  WHERE transaction_type = 'usage'
    AND created_at >= now() - interval '60 days'
    AND created_at < now() - interval '30 days'
  GROUP BY part_id, location_id
),
usage_90d AS (
  SELECT part_id, location_id, SUM(-quantity_delta)::numeric / 90 AS avg_daily_usage_90d
  FROM inventory_transactions
  WHERE transaction_type = 'usage' AND created_at >= now() - interval '90 days'
  GROUP BY part_id, location_id
)
SELECT
  sl.user_id,
  sl.part_id,
  p.name AS part_name,
  p.part_number,
  sl.location_id,
  loc.name AS location_name,
  sl.quantity_on_hand,
  sl.quantity_reserved,
  (sl.quantity_on_hand - sl.quantity_reserved) AS quantity_available,
  COALESCE(u30.avg_daily_usage_30d, 0) AS avg_daily_usage_30d,
  COALESCE(u90.avg_daily_usage_90d, 0) AS avg_daily_usage_90d,
  CASE
    WHEN COALESCE(up30.avg_daily_usage_prior_30d, 0) = 0 AND COALESCE(u30.avg_daily_usage_30d, 0) = 0 THEN 'flat'
    WHEN COALESCE(up30.avg_daily_usage_prior_30d, 0) = 0 THEN 'rising'
    WHEN u30.avg_daily_usage_30d > up30.avg_daily_usage_prior_30d * 1.15 THEN 'rising'
    WHEN u30.avg_daily_usage_30d < up30.avg_daily_usage_prior_30d * 0.85 THEN 'falling'
    ELSE 'flat'
  END AS demand_trend,
  CASE
    WHEN COALESCE(u30.avg_daily_usage_30d, 0) > 0
      THEN ROUND((sl.quantity_on_hand - sl.quantity_reserved)::numeric / u30.avg_daily_usage_30d, 1)
    ELSE NULL
  END AS estimated_days_of_stock,
  -- Suggested par (target on-hand) level: ~14 days of trailing 90-day
  -- average usage, never below the part's configured reorder point.
  GREATEST(CEIL(COALESCE(u90.avg_daily_usage_90d, 0) * 14), p.reorder_point)::integer AS suggested_par_level
FROM inventory_stock_levels sl
JOIN inventory_parts p ON p.id = sl.part_id AND p.active = true
JOIN inventory_locations loc ON loc.id = sl.location_id AND loc.active = true
LEFT JOIN usage_30d u30 ON u30.part_id = sl.part_id AND u30.location_id = sl.location_id
LEFT JOIN usage_prior_30d up30 ON up30.part_id = sl.part_id AND up30.location_id = sl.location_id
LEFT JOIN usage_90d u90 ON u90.part_id = sl.part_id AND u90.location_id = sl.location_id;

GRANT SELECT ON inventory_forecast TO authenticated;

COMMENT ON VIEW inventory_forecast IS
  'Demand-aware forecast per part x location: 30d vs 90d average usage, a rising/falling/flat demand_trend (30d vs the prior 30d), estimated days of stock left, and a suggested_par_level target to reorder up to. security_invoker=true.';

-- =============================================================
-- OPEN_CORE_RETURNS VIEW
-- =============================================================

CREATE OR REPLACE VIEW open_core_returns
WITH (security_invoker = true) AS
SELECT
  r.id AS return_id,
  r.user_id,
  r.part_id,
  p.name AS part_name,
  p.part_number,
  r.vendor_id,
  v.name AS vendor_name,
  r.job_id,
  r.quantity,
  r.core_credit_cents,
  (r.quantity * COALESCE(r.core_credit_cents, 0)) AS total_expected_credit_cents,
  r.status,
  r.created_at
FROM inventory_returns r
JOIN inventory_parts p ON p.id = r.part_id
LEFT JOIN inventory_vendors v ON v.id = r.vendor_id
WHERE r.return_type = 'core_return' AND r.status IN ('pending', 'received');

GRANT SELECT ON open_core_returns TO authenticated;

COMMENT ON VIEW open_core_returns IS
  'Core returns not yet credited by the vendor, with expected credit total — for accounts-payable follow-up. security_invoker=true.';
