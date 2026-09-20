/*
  # Vendor & Procurement OS

  Connects a part need straight through to a paid, evaluated purchase:

    inventory shortage / job shortage / manual request
      -> purchase_requests   ("we need this")
      -> rfqs + rfq_items    ("ask vendors for pricing")
      -> rfq_vendors         (who was invited)
      -> vendor_quotes + vendor_quote_items  ("what they offered")
      -> purchase_orders + purchase_order_items  ("what we ordered, from whom")
      -> goods_receipts + goods_receipt_items    ("what actually showed up")
          -> feeds inventory_transactions (existing ledger from
             parts_inventory_availability), so stock levels update
             automatically on receiving — never written to directly.
      -> vendor_bills        (existing accounts-payable table — a PO
                               can be linked to the bill that pays it)
      -> vendor_evaluations  ("how did that vendor do")

  Same conventions as every other module in this project:
    - single-tenant-per-row via user_id = auth.uid(), RLS "for all"
    - views use security_invoker = true
    - money stored as *_cents integers
    - human-readable numbers (RFQ-/PO-) generated in a trigger, never
      client-side, so they can never collide or be forged
*/

-- =============================================================
-- VENDORS
-- =============================================================

CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  address text,
  category text,
  payment_terms text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_user_id ON vendors(user_id);
CREATE INDEX IF NOT EXISTS idx_vendors_active ON vendors(user_id, active) WHERE active = true;

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own vendors"
  ON vendors FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- PURCHASE_REQUESTS  (the "part need")
-- =============================================================

CREATE TABLE IF NOT EXISTS purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  description text,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  reason text NOT NULL DEFAULT 'manual' CHECK (reason IN ('low_stock', 'job_shortage', 'manual')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  needed_by date,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'rfq_sent', 'quotes_received', 'approved', 'ordered', 'received', 'cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_requests_needs_description CHECK (part_id IS NOT NULL OR description IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_user_id ON purchase_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_part ON purchase_requests(part_id) WHERE part_id IS NOT NULL;

ALTER TABLE purchase_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own purchase requests"
  ON purchase_requests FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- RFQS  (Request For Quote)
-- =============================================================

CREATE TABLE IF NOT EXISTS rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  rfq_number text,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'quotes_in', 'awarded', 'cancelled')),
  due_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, rfq_number)
);

CREATE INDEX IF NOT EXISTS idx_rfqs_user_id ON rfqs(user_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(user_id, status);

ALTER TABLE rfqs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own rfqs"
  ON rfqs FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION set_rfq_number()
RETURNS trigger AS $$
BEGIN
  IF NEW.rfq_number IS NULL THEN
    NEW.rfq_number := 'RFQ-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(NEW.id::text, 1, 4));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_rfq_number ON rfqs;
CREATE TRIGGER trg_set_rfq_number
  BEFORE INSERT OR UPDATE ON rfqs
  FOR EACH ROW EXECUTE FUNCTION set_rfq_number();

-- =============================================================
-- RFQ_ITEMS
-- =============================================================

CREATE TABLE IF NOT EXISTS rfq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  rfq_id uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  purchase_request_id uuid REFERENCES purchase_requests(id) ON DELETE SET NULL,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfq_items_rfq ON rfq_items(rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_items_purchase_request ON rfq_items(purchase_request_id) WHERE purchase_request_id IS NOT NULL;

ALTER TABLE rfq_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own rfq items"
  ON rfq_items FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- RFQ_VENDORS  (who was invited to bid)
-- =============================================================

CREATE TABLE IF NOT EXISTS rfq_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  rfq_id uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'responded', 'declined')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_rfq_vendors_rfq ON rfq_vendors(rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_vendors_vendor ON rfq_vendors(vendor_id);

ALTER TABLE rfq_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own rfq vendor invites"
  ON rfq_vendors FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- VENDOR_QUOTES  (a vendor's response to an RFQ)
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  rfq_id uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'selected', 'rejected')),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  shipping_cents integer NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  valid_until date,
  notes text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_quotes_rfq ON vendor_quotes(rfq_id);
CREATE INDEX IF NOT EXISTS idx_vendor_quotes_vendor ON vendor_quotes(vendor_id);

ALTER TABLE vendor_quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own vendor quotes"
  ON vendor_quotes FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- VENDOR_QUOTE_ITEMS  (line-level pricing per RFQ item)
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  vendor_quote_id uuid NOT NULL REFERENCES vendor_quotes(id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES rfq_items(id) ON DELETE CASCADE,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity_offered numeric,
  notes text,
  UNIQUE (vendor_quote_id, rfq_item_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_quote_items_quote ON vendor_quote_items(vendor_quote_id);
CREATE INDEX IF NOT EXISTS idx_vendor_quote_items_rfq_item ON vendor_quote_items(rfq_item_id);

ALTER TABLE vendor_quote_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own vendor quote items"
  ON vendor_quote_items FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- PURCHASE_ORDERS
-- =============================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  po_number text,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  rfq_id uuid REFERENCES rfqs(id) ON DELETE SET NULL,
  vendor_quote_id uuid REFERENCES vendor_quotes(id) ON DELETE SET NULL,
  purchase_request_id uuid REFERENCES purchase_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled')),
  subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  shipping_cents integer NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents integer GENERATED ALWAYS AS (subtotal_cents + shipping_cents + tax_cents) STORED,
  expected_delivery_date date,
  approved_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  approved_at timestamptz,
  sent_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, po_number)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_user_id ON purchase_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(user_id, status);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own purchase orders"
  ON purchase_orders FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION set_po_number()
RETURNS trigger AS $$
BEGIN
  IF NEW.po_number IS NULL THEN
    NEW.po_number := 'PO-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(NEW.id::text, 1, 4));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_po_number ON purchase_orders;
CREATE TRIGGER trg_set_po_number
  BEFORE INSERT OR UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_po_number();

-- =============================================================
-- PURCHASE_ORDER_ITEMS
-- =============================================================

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity_ordered numeric NOT NULL CHECK (quantity_ordered > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity_received numeric NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_part ON purchase_order_items(part_id) WHERE part_id IS NOT NULL;

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own purchase order items"
  ON purchase_order_items FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Keeps purchase_orders.subtotal_cents equal to SUM(quantity_ordered * unit_price_cents)
-- across its items, so the generated total_cents column is always trustworthy.
CREATE OR REPLACE FUNCTION recalc_po_subtotal()
RETURNS trigger AS $$
DECLARE
  target_po uuid := COALESCE(NEW.po_id, OLD.po_id);
BEGIN
  UPDATE purchase_orders po
  SET subtotal_cents = COALESCE((
    SELECT SUM(ROUND(quantity_ordered * unit_price_cents))::integer
    FROM purchase_order_items
    WHERE po_id = target_po
  ), 0)
  WHERE po.id = target_po;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_recalc_po_subtotal ON purchase_order_items;
CREATE TRIGGER trg_recalc_po_subtotal
  AFTER INSERT OR UPDATE OR DELETE ON purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION recalc_po_subtotal();

-- =============================================================
-- GOODS_RECEIPTS  (receiving)
-- =============================================================

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_po ON goods_receipts(po_id);

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own goods receipts"
  ON goods_receipts FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- GOODS_RECEIPT_ITEMS
-- =============================================================

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  goods_receipt_id uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_item_id uuid NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  quantity_received numeric NOT NULL CHECK (quantity_received > 0),
  location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  condition text NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'partial')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_receipt ON goods_receipt_items(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_po_item ON goods_receipt_items(po_item_id);

ALTER TABLE goods_receipt_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own goods receipt items"
  ON goods_receipt_items FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- On receiving: (1) bump purchase_order_items.quantity_received,
-- (2) recompute the parent PO's status, (3) if the part is a catalog
-- part with a stock location, write it into the existing
-- inventory_transactions ledger so parts_availability updates itself —
-- receiving is the one place procurement and inventory meet.
CREATE OR REPLACE FUNCTION apply_goods_receipt_item()
RETURNS trigger AS $$
DECLARE
  v_po_id uuid;
  v_part_id uuid;
  v_unit_price_cents integer;
  v_total_ordered numeric;
  v_total_received numeric;
BEGIN
  SELECT poi.po_id, poi.part_id, poi.unit_price_cents
  INTO v_po_id, v_part_id, v_unit_price_cents
  FROM purchase_order_items poi
  WHERE poi.id = NEW.po_item_id;

  UPDATE purchase_order_items
  SET quantity_received = quantity_received + NEW.quantity_received
  WHERE id = NEW.po_item_id;

  IF v_part_id IS NOT NULL AND NEW.location_id IS NOT NULL AND NEW.condition <> 'damaged' THEN
    INSERT INTO inventory_transactions (
      user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note
    ) VALUES (
      NEW.user_id, v_part_id, NEW.location_id, 'receipt', NEW.quantity_received::integer,
      v_unit_price_cents, 'Received against ' || (SELECT po_number FROM purchase_orders WHERE id = v_po_id)
    );
  END IF;

  SELECT SUM(quantity_ordered), SUM(quantity_received)
  INTO v_total_ordered, v_total_received
  FROM purchase_order_items
  WHERE po_id = v_po_id;

  UPDATE purchase_orders
  SET status = CASE
        WHEN v_total_received >= v_total_ordered THEN 'received'
        WHEN v_total_received > 0 THEN 'partially_received'
        ELSE status
      END,
      updated_at = now()
  WHERE id = v_po_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_apply_goods_receipt_item ON goods_receipt_items;
CREATE TRIGGER trg_apply_goods_receipt_item
  AFTER INSERT ON goods_receipt_items
  FOR EACH ROW EXECUTE FUNCTION apply_goods_receipt_item();

-- =============================================================
-- VENDOR_EVALUATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  on_time boolean,
  quality_score smallint CHECK (quality_score BETWEEN 1 AND 5),
  price_score smallint CHECK (price_score BETWEEN 1 AND 5),
  communication_score smallint CHECK (communication_score BETWEEN 1 AND 5),
  overall_score numeric GENERATED ALWAYS AS (
    ROUND((COALESCE(quality_score, 0) + COALESCE(price_score, 0) + COALESCE(communication_score, 0))::numeric
      / NULLIF((CASE WHEN quality_score IS NOT NULL THEN 1 ELSE 0 END
              + CASE WHEN price_score IS NOT NULL THEN 1 ELSE 0 END
              + CASE WHEN communication_score IS NOT NULL THEN 1 ELSE 0 END), 0), 2)
  ) STORED,
  notes text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_evaluations_vendor ON vendor_evaluations(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_evaluations_po ON vendor_evaluations(po_id) WHERE po_id IS NOT NULL;

ALTER TABLE vendor_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own vendor evaluations"
  ON vendor_evaluations FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- LINK EXISTING VENDOR_BILLS TO A PURCHASE ORDER (optional, additive)
-- =============================================================

ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_bills_po ON vendor_bills(po_id) WHERE po_id IS NOT NULL;

-- =============================================================
-- RFQ_QUOTE_COMPARISON VIEW  (side-by-side vendor comparison)
-- =============================================================

CREATE OR REPLACE VIEW rfq_quote_comparison
WITH (security_invoker = true) AS
SELECT
  ri.rfq_id,
  ri.id AS rfq_item_id,
  ri.description AS item_description,
  ri.quantity AS quantity_requested,
  vq.id AS vendor_quote_id,
  vq.vendor_id,
  v.name AS vendor_name,
  vq.status AS quote_status,
  vq.lead_time_days,
  vq.valid_until,
  vqi.unit_price_cents,
  COALESCE(vqi.quantity_offered, ri.quantity) AS quantity_offered,
  ROUND(vqi.unit_price_cents * COALESCE(vqi.quantity_offered, ri.quantity))::integer AS line_total_cents,
  RANK() OVER (
    PARTITION BY ri.id
    ORDER BY vqi.unit_price_cents ASC
  ) AS price_rank
FROM rfq_items ri
JOIN vendor_quote_items vqi ON vqi.rfq_item_id = ri.id
JOIN vendor_quotes vq ON vq.id = vqi.vendor_quote_id AND vq.status IN ('submitted', 'selected', 'rejected')
JOIN vendors v ON v.id = vq.vendor_id;

GRANT SELECT ON rfq_quote_comparison TO authenticated;

COMMENT ON VIEW rfq_quote_comparison IS
  'Per RFQ line item, every vendor quote side by side with a price_rank (1 = cheapest), for the vendor-comparison step of procurement. security_invoker=true.';

-- =============================================================
-- VENDOR_SCORECARD VIEW  (vendor evaluation rollup)
-- =============================================================

CREATE OR REPLACE VIEW vendor_scorecard
WITH (security_invoker = true) AS
SELECT
  v.id AS vendor_id,
  v.user_id,
  v.name AS vendor_name,
  v.category,
  v.active,
  COUNT(DISTINCT po.id) FILTER (WHERE po.status NOT IN ('cancelled', 'pending_approval')) AS total_orders,
  COALESCE(SUM(po.total_cents) FILTER (WHERE po.status NOT IN ('cancelled', 'pending_approval')), 0) AS total_spend_cents,
  MAX(po.created_at) AS last_order_at,
  ROUND(AVG(ve.quality_score), 2) AS avg_quality_score,
  ROUND(AVG(ve.price_score), 2) AS avg_price_score,
  ROUND(AVG(ve.communication_score), 2) AS avg_communication_score,
  ROUND(AVG(ve.overall_score), 2) AS avg_overall_score,
  COUNT(ve.id) FILTER (WHERE ve.on_time = true)::numeric
    / NULLIF(COUNT(ve.id) FILTER (WHERE ve.on_time IS NOT NULL), 0) AS on_time_rate,
  COUNT(ve.id) AS evaluation_count
FROM vendors v
LEFT JOIN purchase_orders po ON po.vendor_id = v.id
LEFT JOIN vendor_evaluations ve ON ve.vendor_id = v.id
GROUP BY v.id, v.user_id, v.name, v.category, v.active;

GRANT SELECT ON vendor_scorecard TO authenticated;

COMMENT ON VIEW vendor_scorecard IS
  'One row per vendor: total orders, total spend, average quality/price/communication/overall scores, and on-time delivery rate — the vendor-evaluation rollup. security_invoker=true.';

-- =============================================================
-- PROCUREMENT_PIPELINE VIEW  (Kanban-style status rollup)
-- =============================================================

CREATE OR REPLACE VIEW procurement_pipeline
WITH (security_invoker = true) AS
SELECT
  pr.id AS purchase_request_id,
  pr.user_id,
  pr.description,
  p.name AS part_name,
  pr.quantity_requested,
  pr.reason,
  pr.needed_by,
  pr.status AS request_status,
  r.id AS rfq_id,
  r.rfq_number,
  r.status AS rfq_status,
  po.id AS po_id,
  po.po_number,
  po.status AS po_status,
  po.total_cents AS po_total_cents,
  vend.name AS awarded_vendor_name
FROM purchase_requests pr
LEFT JOIN inventory_parts p ON p.id = pr.part_id
LEFT JOIN rfq_items ri ON ri.purchase_request_id = pr.id
LEFT JOIN rfqs r ON r.id = ri.rfq_id
LEFT JOIN purchase_orders po ON po.purchase_request_id = pr.id
LEFT JOIN vendors vend ON vend.id = po.vendor_id;

GRANT SELECT ON procurement_pipeline TO authenticated;

COMMENT ON VIEW procurement_pipeline IS
  'One row per purchase request showing its linked RFQ and purchase order status side by side — powers the procurement Kanban board. security_invoker=true.';

-- updated_at maintenance, matching the pattern used across the project
CREATE OR REPLACE FUNCTION set_procurement_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendors_set_updated_at ON vendors;
CREATE TRIGGER vendors_set_updated_at BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_procurement_updated_at();

DROP TRIGGER IF EXISTS purchase_requests_set_updated_at ON purchase_requests;
CREATE TRIGGER purchase_requests_set_updated_at BEFORE UPDATE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION set_procurement_updated_at();

DROP TRIGGER IF EXISTS vendor_quotes_set_updated_at ON vendor_quotes;
CREATE TRIGGER vendor_quotes_set_updated_at BEFORE UPDATE ON vendor_quotes
  FOR EACH ROW EXECUTE FUNCTION set_procurement_updated_at();
