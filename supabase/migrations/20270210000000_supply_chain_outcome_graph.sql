/*
  # Supply Chain Outcome Graph

  Connects the physical supply chain to the repair outcome it produced:

    Manufacturer -> Distributor -> Regional -> Local -> Truck -> Technician -> Job -> Outcome

  Nothing existing is altered. Outcomes are READ from tables that already
  exist (jobs / job_outcomes / callback_root_cause_analyses). This migration
  only adds the missing link — provenance — so every installed part can be
  traced back to the lot, supplier and manufacturer it came from.

    supply_chain_lots             — one received lot: who made it, who sold it,
                                    authenticity, promised vs actual delivery
    supply_chain_custody_events   — hops a lot made (manufacturer ... truck)
    supply_chain_installs         — part used on a job, linked to its lot
    supply_chain_part_events      — DOA / early failure / defect / return / warranty
    supply_chain_install_outcomes — view: install + lot + job outcome (read model)

  Conventions (same as the rest of the project):
    - user_id = auth.uid() RLS "for all"
    - views use security_invoker = true
    - money as *_cents integers
    - additive + idempotent (safe to re-run)
*/

-- =============================================================
-- LOTS
-- =============================================================

CREATE TABLE IF NOT EXISTS supply_chain_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  market_source_id uuid REFERENCES parts_market_sources(id) ON DELETE SET NULL,
  purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  manufacturer text,
  distributor text,
  lot_code text,
  authenticity text NOT NULL DEFAULT 'unverified'
    CHECK (authenticity IN ('verified', 'unverified', 'suspect', 'counterfeit')),
  authenticity_method text,
  promised_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  quantity_received integer NOT NULL DEFAULT 1 CHECK (quantity_received > 0),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sc_lots_user_received ON supply_chain_lots(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sc_lots_part ON supply_chain_lots(part_id, received_at);
CREATE INDEX IF NOT EXISTS idx_sc_lots_vendor ON supply_chain_lots(vendor_id) WHERE vendor_id IS NOT NULL;

ALTER TABLE supply_chain_lots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own supply chain lots" ON supply_chain_lots;
CREATE POLICY "Users manage their own supply chain lots"
  ON supply_chain_lots FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- CUSTODY EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS supply_chain_custody_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  lot_id uuid NOT NULL REFERENCES supply_chain_lots(id) ON DELETE CASCADE,
  stage text NOT NULL
    CHECK (stage IN ('manufacturer', 'distributor', 'regional_inventory', 'local_inventory', 'truck', 'technician', 'job')),
  location_label text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sc_custody_lot ON supply_chain_custody_events(lot_id, occurred_at);

ALTER TABLE supply_chain_custody_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own custody events" ON supply_chain_custody_events;
CREATE POLICY "Users manage their own custody events"
  ON supply_chain_custody_events FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- INSTALLS  (part used on a job, linked to its lot)
-- =============================================================

CREATE TABLE IF NOT EXISTS supply_chain_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  lot_id uuid REFERENCES supply_chain_lots(id) ON DELETE SET NULL,
  inventory_transaction_id uuid UNIQUE REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  installed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sc_installs_user_time ON supply_chain_installs(user_id, installed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sc_installs_job ON supply_chain_installs(job_id);
CREATE INDEX IF NOT EXISTS idx_sc_installs_lot ON supply_chain_installs(lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sc_installs_untraced ON supply_chain_installs(user_id, part_id) WHERE lot_id IS NULL;

ALTER TABLE supply_chain_installs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own supply chain installs" ON supply_chain_installs;
CREATE POLICY "Users manage their own supply chain installs"
  ON supply_chain_installs FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- PART EVENTS  (defect / return / warranty signals)
-- =============================================================

CREATE TABLE IF NOT EXISTS supply_chain_part_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  lot_id uuid NOT NULL REFERENCES supply_chain_lots(id) ON DELETE CASCADE,
  install_id uuid REFERENCES supply_chain_installs(id) ON DELETE SET NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('doa', 'early_failure', 'defect', 'return_to_vendor', 'warranty_approved', 'warranty_denied')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sc_part_events_lot ON supply_chain_part_events(lot_id, event_type);
CREATE INDEX IF NOT EXISTS idx_sc_part_events_user_time ON supply_chain_part_events(user_id, occurred_at DESC);

ALTER TABLE supply_chain_part_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own part events" ON supply_chain_part_events;
CREATE POLICY "Users manage their own part events"
  ON supply_chain_part_events FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =============================================================
-- updated_at maintenance (public.set_updated_at already exists)
-- =============================================================

DROP TRIGGER IF EXISTS supply_chain_lots_set_updated_at ON supply_chain_lots;
CREATE TRIGGER supply_chain_lots_set_updated_at BEFORE UPDATE ON supply_chain_lots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- READ MODEL  (install + lot + the outcome the job actually had)
--
-- outcome_class:
--   success  = fixed first visit, no rework, no callback
--   failure  = callback / rework / follow-up needed / unresolved
--   pending  = job has no recorded outcome yet
--   excluded = outcome not attributable to the part (parts pending, quote declined)
-- =============================================================

CREATE OR REPLACE VIEW supply_chain_install_outcomes
WITH (security_invoker = true) AS
SELECT
  i.id AS install_id,
  i.user_id,
  i.job_id,
  i.part_id,
  p.name AS part_name,
  p.part_number,
  i.lot_id,
  i.technician_id,
  i.quantity,
  i.installed_at,
  l.manufacturer,
  l.distributor,
  l.vendor_id,
  l.market_source_id,
  COALESCE(v.name, s.name, NULLIF(btrim(l.distributor), ''), 'Unknown supplier') AS supplier_name,
  jo.resolution,
  COALESCE(jo.caused_callback, false) AS caused_callback,
  COALESCE(jo.is_rework, false) AS is_rework,
  jo.customer_rating,
  CASE
    WHEN jo.id IS NULL THEN 'pending'
    WHEN jo.resolution IN ('parts_pending', 'quote_declined') THEN 'excluded'
    WHEN jo.resolution = 'fixed_first_visit' AND NOT jo.caused_callback AND NOT jo.is_rework THEN 'success'
    ELSE 'failure'
  END AS outcome_class,
  EXISTS (
    SELECT 1
    FROM callback_root_cause_analyses c
    WHERE c.original_job_id = i.job_id
      AND c.root_cause_category = 'defective_part'
      AND (c.part_id IS NULL OR c.part_id = i.part_id)
  ) AS defect_attributed
FROM supply_chain_installs i
JOIN inventory_parts p ON p.id = i.part_id
LEFT JOIN supply_chain_lots l ON l.id = i.lot_id
LEFT JOIN vendors v ON v.id = l.vendor_id
LEFT JOIN parts_market_sources s ON s.id = l.market_source_id
LEFT JOIN job_outcomes jo ON jo.job_id = i.job_id;

GRANT SELECT ON supply_chain_install_outcomes TO authenticated;

COMMENT ON VIEW supply_chain_install_outcomes IS
  'Each installed part with its lot provenance and the job outcome it produced. security_invoker=true, so it always applies the querying user''s own RLS.';

-- =============================================================
-- OPTIONAL — AUTO-TRACE  (remove this block if you prefer manual linking)
--
-- Whenever a part is consumed on a job (inventory_transactions 'usage' with a
-- job_id) an install row is created and linked FIFO to the oldest lot of that
-- part that still has units left. It can NEVER block or fail the inventory
-- transaction: any error is swallowed and the usage row is saved as normal.
-- =============================================================

CREATE OR REPLACE FUNCTION public.supply_chain_autotrace_install()
RETURNS trigger AS $$
DECLARE
  v_lot uuid;
  v_tech uuid;
  v_qty integer;
BEGIN
  IF NEW.transaction_type <> 'usage' OR NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_qty := GREATEST(1, ABS(NEW.quantity_delta));

  SELECT l.id INTO v_lot
  FROM supply_chain_lots l
  WHERE l.user_id = NEW.user_id
    AND l.part_id = NEW.part_id
    AND l.quantity_received > COALESCE(
      (SELECT SUM(i.quantity) FROM supply_chain_installs i WHERE i.lot_id = l.id), 0)
  ORDER BY l.received_at ASC
  LIMIT 1;

  SELECT assigned_technician_id INTO v_tech
  FROM inventory_locations WHERE id = NEW.location_id;

  INSERT INTO supply_chain_installs
    (user_id, job_id, part_id, lot_id, inventory_transaction_id, technician_id, quantity, installed_at)
  VALUES
    (NEW.user_id, NEW.job_id, NEW.part_id, v_lot, NEW.id, v_tech, v_qty, NEW.created_at)
  ON CONFLICT (inventory_transaction_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS inventory_transactions_supply_chain_autotrace ON inventory_transactions;
CREATE TRIGGER inventory_transactions_supply_chain_autotrace
  AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION public.supply_chain_autotrace_install();

-- =============================================================
-- Realtime (safe if the publication does not exist yet)
-- =============================================================

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE supply_chain_installs;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE supply_chain_lots;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE supply_chain_part_events;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
