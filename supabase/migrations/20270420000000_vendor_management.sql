/*
  # Vendor Management

  Sits ON TOP of the existing Vendor & Procurement OS — it does not replace it.

    vendors (existing)  ──┬── purchase_orders / goods_receipts / vendor_evaluations (procurement)
                          ├── ap_bills (accounting general ledger)
                          ├── vendor_bills (job-costing AP, matched by vendor name)
                          └── inventory_vendors -> inventory_part_vendors (catalog), linked via
                              vendors.inventory_vendor_id

  New in this migration (all additive / idempotent, nothing dropped or rewritten):
    - vendors: tier, website, inventory_vendor_id, review cadence, required documents
    - vendor_contracts   (supply / pricing / service agreements with renewal tracking)
    - vendor_documents   (compliance: W-9, COI, licences, expiry + verification)
    - vendor_incidents   (late / quality / billing / compliance issues, cost impact)
    - views: vendor_management_overview, vendor_price_history, vendor_catalog_overview

  Conventions match the procurement migration: user_id = auth.uid() RLS, security_invoker
  views, money as *_cents integers.
*/

-- =============================================================
-- 1. VENDOR PROFILE COLUMNS (additive)
-- =============================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'approved'
    CHECK (tier IN ('strategic', 'preferred', 'approved', 'probation', 'blocked')),
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS inventory_vendor_id uuid REFERENCES inventory_vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_cadence_days integer NOT NULL DEFAULT 180
    CHECK (review_cadence_days BETWEEN 30 AND 730),
  ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz,
  -- Empty by default so existing vendors don't suddenly show as non-compliant;
  -- required documents are opted into per vendor (the Add/Edit vendor forms).
  ADD COLUMN IF NOT EXISTS required_documents text[] NOT NULL DEFAULT '{}'::text[];

-- A blocked vendor can never stay "active" (so it can't be invited to RFQs).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_blocked_not_active') THEN
    ALTER TABLE vendors
      ADD CONSTRAINT vendors_blocked_not_active CHECK (tier <> 'blocked' OR active = false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vendors_tier ON vendors(user_id, tier);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_inventory_vendor_link
  ON vendors(user_id, inventory_vendor_id) WHERE inventory_vendor_id IS NOT NULL;

-- The inventory link must point at one of the caller's own inventory vendors.
CREATE OR REPLACE FUNCTION validate_vendor_inventory_link()
RETURNS trigger AS $$
BEGIN
  IF NEW.inventory_vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_vendors iv
    WHERE iv.id = NEW.inventory_vendor_id AND iv.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'inventory_vendor_id does not belong to this account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_vendor_inventory_link ON vendors;
CREATE TRIGGER trg_validate_vendor_inventory_link
  BEFORE INSERT OR UPDATE OF inventory_vendor_id ON vendors
  FOR EACH ROW EXECUTE FUNCTION validate_vendor_inventory_link();

-- =============================================================
-- 2. VENDOR_CONTRACTS
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  title text NOT NULL,
  contract_type text NOT NULL DEFAULT 'master_supply'
    CHECK (contract_type IN ('master_supply', 'pricing_agreement', 'service', 'rebate', 'nda', 'other')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'expired', 'terminated')),
  start_date date,
  end_date date,
  auto_renew boolean NOT NULL DEFAULT false,
  renewal_notice_days integer NOT NULL DEFAULT 60 CHECK (renewal_notice_days BETWEEN 0 AND 365),
  value_cents bigint CHECK (value_cents IS NULL OR value_cents >= 0),
  discount_percent numeric(5, 2) CHECK (discount_percent IS NULL OR discount_percent BETWEEN 0 AND 100),
  payment_terms text,
  document_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_contracts_dates_ordered CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_vendor_contracts_vendor ON vendor_contracts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_contracts_user_end ON vendor_contracts(user_id, end_date) WHERE status = 'active';

ALTER TABLE vendor_contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own vendor contracts" ON vendor_contracts;
CREATE POLICY "Users manage their own vendor contracts"
  ON vendor_contracts FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = vendor_id AND v.user_id = auth.uid())
  );

DROP TRIGGER IF EXISTS vendor_contracts_set_updated_at ON vendor_contracts;
CREATE TRIGGER vendor_contracts_set_updated_at BEFORE UPDATE ON vendor_contracts
  FOR EACH ROW EXECUTE FUNCTION set_procurement_updated_at();

-- =============================================================
-- 3. VENDOR_DOCUMENTS  (compliance)
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  doc_type text NOT NULL
    CHECK (doc_type IN ('w9', 'coi', 'license', 'tax_certificate', 'nda', 'safety_program', 'background_check', 'other')),
  title text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  issued_on date,
  expires_on date,
  document_url text,
  verified_at timestamptz,
  verified_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_documents_dates_ordered CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
);

CREATE INDEX IF NOT EXISTS idx_vendor_documents_vendor ON vendor_documents(vendor_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_vendor_documents_user_expiry ON vendor_documents(user_id, expires_on) WHERE expires_on IS NOT NULL;

ALTER TABLE vendor_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own vendor documents" ON vendor_documents;
CREATE POLICY "Users manage their own vendor documents"
  ON vendor_documents FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = vendor_id AND v.user_id = auth.uid())
  );

DROP TRIGGER IF EXISTS vendor_documents_set_updated_at ON vendor_documents;
CREATE TRIGGER vendor_documents_set_updated_at BEFORE UPDATE ON vendor_documents
  FOR EACH ROW EXECUTE FUNCTION set_procurement_updated_at();

-- =============================================================
-- 4. VENDOR_INCIDENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  incident_type text NOT NULL DEFAULT 'other'
    CHECK (incident_type IN ('late_delivery', 'quality', 'wrong_item', 'damaged', 'billing_dispute', 'communication', 'compliance', 'safety', 'other')),
  severity smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  summary text NOT NULL,
  cost_impact_cents integer NOT NULL DEFAULT 0 CHECK (cost_impact_cents >= 0),
  occurred_on date NOT NULL DEFAULT current_date,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_incidents_vendor ON vendor_incidents(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_incidents_user_open ON vendor_incidents(user_id) WHERE status = 'open';

ALTER TABLE vendor_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own vendor incidents" ON vendor_incidents;
CREATE POLICY "Users manage their own vendor incidents"
  ON vendor_incidents FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = vendor_id AND v.user_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION set_vendor_incident_state()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'resolved' THEN
    -- OLD is not assigned on INSERT, so it must never be touched in that branch.
    IF TG_OP = 'INSERT' THEN
      NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    ELSIF OLD.status IS DISTINCT FROM 'resolved' THEN
      NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    END IF;
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_incident_state ON vendor_incidents;
CREATE TRIGGER trg_vendor_incident_state BEFORE INSERT OR UPDATE ON vendor_incidents
  FOR EACH ROW EXECUTE FUNCTION set_vendor_incident_state();

-- =============================================================
-- 5. VENDOR_MANAGEMENT_OVERVIEW  (one row per vendor, raw metrics)
--    Every source is pre-aggregated per vendor_id in its own CTE, so
--    joining them can never fan out or double-count.
--    Scoring lives in src/lib/vendorManagement.ts (unit-tested), not here.
-- =============================================================

CREATE OR REPLACE VIEW vendor_management_overview
WITH (security_invoker = true) AS
WITH po_agg AS (
  SELECT
    po.vendor_id,
    COUNT(*) FILTER (WHERE po.status NOT IN ('cancelled', 'pending_approval')) AS po_count,
    COALESCE(SUM(po.total_cents) FILTER (WHERE po.status NOT IN ('cancelled', 'pending_approval')), 0)::bigint AS po_spend_cents,
    COALESCE(SUM(po.total_cents) FILTER (
      WHERE po.status NOT IN ('cancelled', 'pending_approval') AND po.created_at >= now() - interval '12 months'
    ), 0)::bigint AS po_spend_12m_cents,
    COUNT(*) FILTER (WHERE po.status IN ('approved', 'sent', 'partially_received')) AS open_po_count,
    COALESCE(SUM(po.total_cents) FILTER (WHERE po.status IN ('approved', 'sent', 'partially_received')), 0)::bigint AS open_po_cents,
    COUNT(*) FILTER (
      WHERE po.status IN ('sent', 'partially_received') AND po.expected_delivery_date < current_date
    ) AS late_open_po_count,
    MAX(po.created_at) FILTER (WHERE po.status NOT IN ('cancelled', 'pending_approval')) AS last_order_at
  FROM purchase_orders po
  GROUP BY po.vendor_id
),
first_receipt AS (
  SELECT po.id AS po_id, po.vendor_id, po.expected_delivery_date AS expected,
         MIN(gr.received_at)::date AS first_received
  FROM purchase_orders po
  JOIN goods_receipts gr ON gr.po_id = po.id
  WHERE po.expected_delivery_date IS NOT NULL
  GROUP BY po.id, po.vendor_id, po.expected_delivery_date
),
delivery_agg AS (
  SELECT
    vendor_id,
    COUNT(*) AS delivery_measured_count,
    COUNT(*) FILTER (WHERE first_received <= expected) AS delivery_on_time_count
  FROM first_receipt
  GROUP BY vendor_id
),
receipt_agg AS (
  SELECT
    po.vendor_id,
    COUNT(*) AS receipt_line_count,
    COUNT(*) FILTER (WHERE gri.condition <> 'good') AS receipt_issue_line_count
  FROM goods_receipt_items gri
  JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
  JOIN purchase_orders po ON po.id = gr.po_id
  GROUP BY po.vendor_id
),
ap_agg AS (
  SELECT
    b.vendor_id,
    COALESCE(SUM(GREATEST(b.total_cents - b.amount_paid_cents, 0)) FILTER (
      WHERE b.status IN ('approved', 'partially_paid')
    ), 0)::bigint AS ap_open_cents,
    COALESCE(SUM(GREATEST(b.total_cents - b.amount_paid_cents, 0)) FILTER (
      WHERE b.status IN ('approved', 'partially_paid') AND b.due_date < current_date
    ), 0)::bigint AS ap_overdue_cents,
    COUNT(*) FILTER (
      WHERE b.status IN ('approved', 'partially_paid') AND b.due_date < current_date AND b.total_cents > b.amount_paid_cents
    ) AS ap_overdue_count
  FROM ap_bills b
  WHERE b.vendor_id IS NOT NULL
  GROUP BY b.vendor_id
),
job_bill_agg AS (
  -- Job-costing vendor_bills only carry a vendor *name*; match case/whitespace-insensitively.
  SELECT
    v.id AS vendor_id,
    COALESCE(SUM(vb.amount_cents) FILTER (WHERE vb.status IN ('unpaid', 'overdue')), 0)::bigint AS job_bills_unpaid_cents,
    COALESCE(SUM(vb.amount_cents) FILTER (
      WHERE vb.status = 'overdue' OR (vb.status = 'unpaid' AND vb.due_date < current_date)
    ), 0)::bigint AS job_bills_overdue_cents
  FROM vendors v
  JOIN vendor_bills vb ON vb.user_id = v.user_id AND lower(btrim(vb.vendor_name)) = lower(btrim(v.name))
  GROUP BY v.id
),
eval_agg AS (
  SELECT
    ve.vendor_id,
    COUNT(*) AS eval_count,
    ROUND(AVG(ve.quality_score), 2) AS avg_quality_score,
    ROUND(AVG(ve.price_score), 2) AS avg_price_score,
    ROUND(AVG(ve.communication_score), 2) AS avg_communication_score,
    ROUND(AVG(ve.overall_score), 2) AS avg_overall_score,
    COUNT(*) FILTER (WHERE ve.on_time = true)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE ve.on_time IS NOT NULL), 0) AS eval_on_time_rate
  FROM vendor_evaluations ve
  GROUP BY ve.vendor_id
),
incident_agg AS (
  SELECT
    i.vendor_id,
    COUNT(*) FILTER (WHERE i.status = 'open') AS open_incident_count,
    COUNT(*) FILTER (WHERE i.status = 'open' AND i.severity = 3) AS critical_incident_count,
    COUNT(*) FILTER (WHERE i.occurred_on >= current_date - 365) AS incident_count_12m,
    COALESCE(SUM(i.cost_impact_cents) FILTER (WHERE i.occurred_on >= current_date - 365), 0)::bigint AS incident_cost_12m_cents
  FROM vendor_incidents i
  GROUP BY i.vendor_id
),
document_agg AS (
  SELECT
    d.vendor_id,
    COUNT(*) AS doc_count,
    COUNT(*) FILTER (WHERE d.status <> 'rejected' AND d.expires_on < current_date) AS expired_doc_count,
    COUNT(*) FILTER (
      WHERE d.status <> 'rejected' AND d.expires_on >= current_date AND d.expires_on <= current_date + 30
    ) AS expiring_doc_count,
    COUNT(*) FILTER (WHERE d.status = 'pending') AS pending_doc_count
  FROM vendor_documents d
  GROUP BY d.vendor_id
),
contract_agg AS (
  SELECT
    c.vendor_id,
    COUNT(*) FILTER (WHERE c.status = 'active' AND (c.end_date IS NULL OR c.end_date >= current_date)) AS active_contract_count,
    COUNT(*) FILTER (
      WHERE c.status = 'active' AND c.end_date >= current_date
        AND c.end_date <= current_date + c.renewal_notice_days
    ) AS expiring_contract_count,
    COUNT(*) FILTER (WHERE c.status = 'active' AND c.end_date < current_date) AS lapsed_contract_count,
    MIN(c.end_date) FILTER (WHERE c.status = 'active' AND c.end_date >= current_date) AS next_contract_end
  FROM vendor_contracts c
  GROUP BY c.vendor_id
)
SELECT
  v.id AS vendor_id,
  v.user_id,
  v.name,
  v.contact_name,
  v.email,
  v.phone,
  v.address,
  v.category,
  v.payment_terms,
  v.notes,
  v.active,
  v.tier,
  v.website,
  v.inventory_vendor_id,
  v.review_cadence_days,
  v.last_reviewed_at,
  v.required_documents,
  v.created_at,
  COALESCE(pa.po_count, 0) AS po_count,
  COALESCE(pa.po_spend_cents, 0) AS po_spend_cents,
  COALESCE(pa.po_spend_12m_cents, 0) AS po_spend_12m_cents,
  COALESCE(pa.open_po_count, 0) AS open_po_count,
  COALESCE(pa.open_po_cents, 0) AS open_po_cents,
  COALESCE(pa.late_open_po_count, 0) AS late_open_po_count,
  pa.last_order_at,
  COALESCE(da.delivery_measured_count, 0) AS delivery_measured_count,
  COALESCE(da.delivery_on_time_count, 0) AS delivery_on_time_count,
  COALESCE(ra.receipt_line_count, 0) AS receipt_line_count,
  COALESCE(ra.receipt_issue_line_count, 0) AS receipt_issue_line_count,
  COALESCE(ap.ap_open_cents, 0) AS ap_open_cents,
  COALESCE(ap.ap_overdue_cents, 0) AS ap_overdue_cents,
  COALESCE(ap.ap_overdue_count, 0) AS ap_overdue_count,
  COALESCE(jb.job_bills_unpaid_cents, 0) AS job_bills_unpaid_cents,
  COALESCE(jb.job_bills_overdue_cents, 0) AS job_bills_overdue_cents,
  COALESCE(ea.eval_count, 0) AS eval_count,
  ea.avg_quality_score,
  ea.avg_price_score,
  ea.avg_communication_score,
  ea.avg_overall_score,
  ea.eval_on_time_rate,
  COALESCE(ia.open_incident_count, 0) AS open_incident_count,
  COALESCE(ia.critical_incident_count, 0) AS critical_incident_count,
  COALESCE(ia.incident_count_12m, 0) AS incident_count_12m,
  COALESCE(ia.incident_cost_12m_cents, 0) AS incident_cost_12m_cents,
  COALESCE(dc.doc_count, 0) AS doc_count,
  COALESCE(dc.expired_doc_count, 0) AS expired_doc_count,
  COALESCE(dc.expiring_doc_count, 0) AS expiring_doc_count,
  COALESCE(dc.pending_doc_count, 0) AS pending_doc_count,
  (
    SELECT COUNT(*)
    FROM unnest(v.required_documents) AS rd(doc_type)
    WHERE NOT EXISTS (
      SELECT 1 FROM vendor_documents d
      WHERE d.vendor_id = v.id
        AND d.doc_type = rd.doc_type
        AND d.status <> 'rejected'
        AND (d.expires_on IS NULL OR d.expires_on >= current_date)
    )
  )::integer AS missing_required_doc_count,
  COALESCE(cc.active_contract_count, 0) AS active_contract_count,
  COALESCE(cc.expiring_contract_count, 0) AS expiring_contract_count,
  COALESCE(cc.lapsed_contract_count, 0) AS lapsed_contract_count,
  cc.next_contract_end
FROM vendors v
LEFT JOIN po_agg pa ON pa.vendor_id = v.id
LEFT JOIN delivery_agg da ON da.vendor_id = v.id
LEFT JOIN receipt_agg ra ON ra.vendor_id = v.id
LEFT JOIN ap_agg ap ON ap.vendor_id = v.id
LEFT JOIN job_bill_agg jb ON jb.vendor_id = v.id
LEFT JOIN eval_agg ea ON ea.vendor_id = v.id
LEFT JOIN incident_agg ia ON ia.vendor_id = v.id
LEFT JOIN document_agg dc ON dc.vendor_id = v.id
LEFT JOIN contract_agg cc ON cc.vendor_id = v.id;

GRANT SELECT ON vendor_management_overview TO authenticated;

COMMENT ON VIEW vendor_management_overview IS
  'One row per vendor with raw procurement, receiving, AP, job-bill, evaluation, incident, compliance and contract metrics for the Vendor Management page. security_invoker=true.';

-- =============================================================
-- 6. VENDOR_PRICE_HISTORY  (what each vendor actually charged per line)
-- =============================================================

CREATE OR REPLACE VIEW vendor_price_history
WITH (security_invoker = true) AS
SELECT
  poi.id AS po_item_id,
  po.vendor_id,
  po.id AS po_id,
  po.po_number,
  poi.part_id,
  poi.description,
  poi.unit_price_cents,
  poi.quantity_ordered,
  po.created_at AS ordered_at
FROM purchase_order_items poi
JOIN purchase_orders po ON po.id = poi.po_id
WHERE po.status NOT IN ('cancelled', 'pending_approval');

GRANT SELECT ON vendor_price_history TO authenticated;

COMMENT ON VIEW vendor_price_history IS
  'Every non-cancelled purchase-order line with its vendor, unit price and order date — the raw material for price-change and cross-vendor price comparison. security_invoker=true.';

-- =============================================================
-- 7. VENDOR_CATALOG_OVERVIEW  (inventory catalog, via the vendor link)
-- =============================================================

CREATE OR REPLACE VIEW vendor_catalog_overview
WITH (security_invoker = true) AS
SELECT
  v.id AS vendor_id,
  ipv.id AS catalog_entry_id,
  ipv.part_id,
  p.part_number,
  p.name AS part_name,
  ipv.vendor_sku,
  ipv.unit_cost_cents,
  ipv.lead_time_days,
  ipv.is_preferred,
  (
    SELECT MIN(x.unit_cost_cents) FROM inventory_part_vendors x WHERE x.part_id = ipv.part_id
  ) AS best_catalog_cost_cents
FROM vendors v
JOIN inventory_part_vendors ipv ON ipv.vendor_id = v.inventory_vendor_id
JOIN inventory_parts p ON p.id = ipv.part_id;

GRANT SELECT ON vendor_catalog_overview TO authenticated;

COMMENT ON VIEW vendor_catalog_overview IS
  'Parts each procurement vendor supplies according to the inventory catalog (linked through vendors.inventory_vendor_id), with the best catalog cost across all vendors for comparison. security_invoker=true.';
