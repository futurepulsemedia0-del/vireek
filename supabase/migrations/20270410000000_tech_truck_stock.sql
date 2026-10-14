/*
  # Technician truck stock (/tech/truck-stock)

  Field-facing, offline-safe actions on top of the existing inventory ledger
  (20260928000000 / 20261013000000 / 20261110000000). Additive only.

  ## What this adds
  - tech_stock_op_log: idempotency log. Every action carries a client-generated
    operation id, so a request replayed after a dead-zone retry never records
    the same usage twice.
  - get_my_truck_stock(): one round trip with everything the technician screen
    needs offline (their van, stock vs par levels, open restocks, active jobs,
    vendors, a slim part catalog for barcode lookup).
  - tech_use_part(): scan-to-use. Writes a 'usage' ledger row against the
    technician's own van. Never blocks the field: if the van shows less than
    was used (stale count), it is still recorded and flagged for the office.
  - tech_request_restock(): low-stock request -> replenishment_tasks
    (reason 'manual'), merged with any open restock for the same part/truck.
  - tech_return_part(): put back on truck, send to warehouse (atomic
    transfer), or core return to a vendor (inventory_returns).

  ## Security
  All functions are SECURITY DEFINER but derive identity from auth.uid():
  a technician can only touch their own van, parts and jobs of their own
  account, and only jobs assigned to them. No table policy is loosened.
*/

-- =============================================================
-- 1. Columns / tables
-- =============================================================

ALTER TABLE replenishment_tasks
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS note text;

CREATE TABLE IF NOT EXISTS tech_stock_op_log (
  client_op_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  op_type text NOT NULL CHECK (op_type IN ('use', 'request', 'return')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tech_stock_op_log_user_created ON tech_stock_op_log(user_id, created_at DESC);

-- RLS on with no policies: reachable only through the SECURITY DEFINER functions below.
ALTER TABLE tech_stock_op_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tech_stock_op_log FROM anon, authenticated;

-- =============================================================
-- 2. Internal helpers (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public.tech_stock_context()
RETURNS TABLE (owner_id uuid, technician_id uuid, van_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.get_account_owner_id(),
    tm.id,
    (SELECT l.id
       FROM inventory_locations l
      WHERE l.user_id = public.get_account_owner_id()
        AND l.location_type = 'van'
        AND l.active
        AND l.assigned_technician_id = tm.id
      ORDER BY l.created_at
      LIMIT 1)
  FROM team_members tm
  WHERE tm.user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.tech_stock_finish(p_op_id uuid, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE tech_stock_op_log SET result = p_result WHERE client_op_id = p_op_id;
  RETURN p_result;
END;
$$;

REVOKE ALL ON FUNCTION public.tech_stock_context() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tech_stock_finish(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 3. READ: everything the screen needs, in one call
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_my_truck_stock()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  v_van_name text;
  v_items jsonb;
  v_jobs jsonb;
  v_vendors jsonb;
  v_catalog jsonb;
BEGIN
  SELECT * INTO c FROM public.tech_stock_context();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_a_technician');
  END IF;
  IF c.van_id IS NULL THEN
    RETURN jsonb_build_object('error', 'no_truck', 'technician_id', c.technician_id);
  END IF;

  SELECT name INTO v_van_name FROM inventory_locations WHERE id = c.van_id;

  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.name), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      p.id AS part_id,
      p.name,
      p.part_number,
      p.barcode,
      p.category,
      p.unit_label,
      COALESCE(sl.quantity_on_hand, 0) AS on_hand,
      COALESCE(sl.quantity_reserved, 0) AS reserved,
      pl.min_quantity,
      pl.target_quantity,
      COALESCE((
        SELECT SUM(t.quantity)::integer
          FROM replenishment_tasks t
         WHERE t.status = 'open' AND t.part_id = p.id AND t.to_location_id = c.van_id
      ), 0) AS requested_qty
    FROM inventory_parts p
    LEFT JOIN inventory_stock_levels sl ON sl.part_id = p.id AND sl.location_id = c.van_id
    LEFT JOIN inventory_par_levels pl ON pl.part_id = p.id AND pl.location_id = c.van_id
    WHERE p.user_id = c.owner_id
      AND p.active
      AND (pl.id IS NOT NULL OR COALESCE(sl.quantity_on_hand, 0) <> 0)
  ) x;

  SELECT COALESCE(jsonb_agg(row_to_json(j)::jsonb ORDER BY j.scheduled_datetime NULLS LAST), '[]'::jsonb) INTO v_jobs
  FROM (
    SELECT jb.id, jb.customer_name, jb.service_type, jb.scheduled_datetime, jb.job_status
      FROM jobs jb
     WHERE jb.user_id = c.owner_id
       AND jb.assigned_technician_id = c.technician_id
       AND (jb.job_status IN ('scheduled', 'en_route', 'in_progress')
            OR jb.completed_at > now() - interval '24 hours')
     ORDER BY jb.scheduled_datetime NULLS LAST
     LIMIT 30
  ) j;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name) ORDER BY v.name), '[]'::jsonb) INTO v_vendors
  FROM (
    SELECT id, name FROM inventory_vendors
     WHERE user_id = c.owner_id AND active
     ORDER BY name LIMIT 200
  ) v;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'part_number', k.part_number, 'barcode', k.barcode) ORDER BY k.name), '[]'::jsonb) INTO v_catalog
  FROM (
    SELECT id, name, part_number, barcode FROM inventory_parts
     WHERE user_id = c.owner_id AND active
     ORDER BY name LIMIT 1500
  ) k;

  RETURN jsonb_build_object(
    'technician_id', c.technician_id,
    'location', jsonb_build_object('id', c.van_id, 'name', v_van_name),
    'items', v_items,
    'jobs', v_jobs,
    'vendors', v_vendors,
    'catalog', v_catalog,
    'generated_at', to_jsonb(now())
  );
END;
$$;

-- =============================================================
-- 4. WRITE: scan-to-use
-- =============================================================

CREATE OR REPLACE FUNCTION public.tech_use_part(
  p_op_id uuid,
  p_part_id uuid,
  p_quantity integer,
  p_job_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  v_prev jsonb;
  v_before integer;
  v_after integer;
  v_min integer;
  v_required integer;
  v_used integer;
BEGIN
  SELECT * INTO c FROM public.tech_stock_context();
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_a_technician'); END IF;
  IF c.van_id IS NULL THEN RETURN jsonb_build_object('status', 'no_truck'); END IF;
  IF p_op_id IS NULL OR p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 10000 THEN
    RETURN jsonb_build_object('status', 'invalid_quantity');
  END IF;

  INSERT INTO tech_stock_op_log (client_op_id, user_id, technician_id, op_type)
  VALUES (p_op_id, c.owner_id, c.technician_id, 'use')
  ON CONFLICT (client_op_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT result INTO v_prev FROM tech_stock_op_log WHERE client_op_id = p_op_id AND technician_id = c.technician_id;
    RETURN COALESCE(v_prev, jsonb_build_object('status', 'applied')) || jsonb_build_object('duplicate', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_parts WHERE id = p_part_id AND user_id = c.owner_id AND active) THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'part_not_found'));
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = c.owner_id AND assigned_technician_id = c.technician_id
  ) THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'job_not_found'));
  END IF;

  SELECT COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) INTO v_before
  FROM (SELECT 1) one
  LEFT JOIN inventory_stock_levels sl ON sl.part_id = p_part_id AND sl.location_id = c.van_id;

  INSERT INTO inventory_transactions (user_id, part_id, location_id, job_id, transaction_type, quantity_delta, note, created_by)
  VALUES (c.owner_id, p_part_id, c.van_id, p_job_id, 'usage', -p_quantity,
          COALESCE(NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''), 'Scanned on truck'), c.technician_id);

  v_after := COALESCE(v_before, 0) - p_quantity;

  -- Keep the optional auto-deduct-on-completion hook from consuming the same part twice.
  IF p_job_id IS NOT NULL THEN
    SELECT jpr.quantity_required INTO v_required
      FROM job_parts_required jpr
     WHERE jpr.job_id = p_job_id AND jpr.part_id = p_part_id AND jpr.status IN ('needed', 'allocated');
    IF v_required IS NOT NULL THEN
      SELECT COALESCE(SUM(-t.quantity_delta), 0)::integer INTO v_used
        FROM inventory_transactions t
       WHERE t.job_id = p_job_id AND t.part_id = p_part_id AND t.transaction_type = 'usage';
      IF v_used >= v_required THEN
        UPDATE job_parts_required SET status = 'installed', updated_at = now()
         WHERE job_id = p_job_id AND part_id = p_part_id;
      END IF;
    END IF;
  END IF;

  SELECT pl.min_quantity INTO v_min
    FROM inventory_par_levels pl WHERE pl.part_id = p_part_id AND pl.location_id = c.van_id;

  RETURN public.tech_stock_finish(p_op_id, jsonb_build_object(
    'status', 'applied',
    'quantity_after', v_after,
    'min_quantity', v_min,
    'low', (v_min IS NOT NULL AND v_after <= v_min),
    'negative_stock', (COALESCE(v_before, 0) < p_quantity)
  ));
END;
$$;

-- =============================================================
-- 5. WRITE: low-stock request
-- =============================================================

CREATE OR REPLACE FUNCTION public.tech_request_restock(
  p_op_id uuid,
  p_part_id uuid,
  p_quantity integer,
  p_job_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  v_prev jsonb;
  v_from uuid;
  v_task uuid;
  v_merged boolean;
BEGIN
  SELECT * INTO c FROM public.tech_stock_context();
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_a_technician'); END IF;
  IF c.van_id IS NULL THEN RETURN jsonb_build_object('status', 'no_truck'); END IF;
  IF p_op_id IS NULL OR p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 10000 THEN
    RETURN jsonb_build_object('status', 'invalid_quantity');
  END IF;

  INSERT INTO tech_stock_op_log (client_op_id, user_id, technician_id, op_type)
  VALUES (p_op_id, c.owner_id, c.technician_id, 'request')
  ON CONFLICT (client_op_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT result INTO v_prev FROM tech_stock_op_log WHERE client_op_id = p_op_id AND technician_id = c.technician_id;
    RETURN COALESCE(v_prev, jsonb_build_object('status', 'applied')) || jsonb_build_object('duplicate', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_parts WHERE id = p_part_id AND user_id = c.owner_id AND active) THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'part_not_found'));
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = c.owner_id AND assigned_technician_id = c.technician_id
  ) THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'job_not_found'));
  END IF;

  SELECT ps.location_id INTO v_from FROM public.pick_restock_source(c.owner_id, p_part_id) ps;
  IF v_from IS NULL THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'no_source'));
  END IF;

  INSERT INTO replenishment_tasks (user_id, part_id, from_location_id, to_location_id, quantity, reason, job_id, requested_by, note)
  VALUES (c.owner_id, p_part_id, v_from, c.van_id, p_quantity, 'manual', p_job_id, c.technician_id,
          NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''))
  ON CONFLICT (part_id, to_location_id) WHERE status = 'open'
  DO UPDATE SET
    quantity = GREATEST(replenishment_tasks.quantity, EXCLUDED.quantity),
    requested_by = COALESCE(replenishment_tasks.requested_by, EXCLUDED.requested_by),
    note = COALESCE(EXCLUDED.note, replenishment_tasks.note)
  RETURNING id, (xmax <> 0) INTO v_task, v_merged;

  RETURN public.tech_stock_finish(p_op_id, jsonb_build_object(
    'status', 'applied',
    'task_id', v_task,
    'merged', COALESCE(v_merged, false)
  ));
END;
$$;

-- =============================================================
-- 6. WRITE: returns (unused -> truck, truck -> warehouse, vendor core)
-- =============================================================

CREATE OR REPLACE FUNCTION public.tech_return_part(
  p_op_id uuid,
  p_part_id uuid,
  p_quantity integer,
  p_kind text,
  p_job_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_vendor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  v_prev jsonb;
  v_avail integer;
  v_warehouse uuid;
  v_vendor uuid;
  v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
BEGIN
  SELECT * INTO c FROM public.tech_stock_context();
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_a_technician'); END IF;
  IF c.van_id IS NULL THEN RETURN jsonb_build_object('status', 'no_truck'); END IF;
  IF p_op_id IS NULL OR p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 10000 THEN
    RETURN jsonb_build_object('status', 'invalid_quantity');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('unused', 'to_warehouse', 'core') THEN
    RETURN jsonb_build_object('status', 'invalid_kind');
  END IF;

  INSERT INTO tech_stock_op_log (client_op_id, user_id, technician_id, op_type)
  VALUES (p_op_id, c.owner_id, c.technician_id, 'return')
  ON CONFLICT (client_op_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT result INTO v_prev FROM tech_stock_op_log WHERE client_op_id = p_op_id AND technician_id = c.technician_id;
    RETURN COALESCE(v_prev, jsonb_build_object('status', 'applied')) || jsonb_build_object('duplicate', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_parts WHERE id = p_part_id AND user_id = c.owner_id AND active) THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'part_not_found'));
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = c.owner_id AND assigned_technician_id = c.technician_id
  ) THEN
    RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'job_not_found'));
  END IF;

  IF p_kind = 'unused' THEN
    INSERT INTO inventory_transactions (user_id, part_id, location_id, job_id, transaction_type, quantity_delta, note, created_by)
    VALUES (c.owner_id, p_part_id, c.van_id, p_job_id, 'return', p_quantity,
            COALESCE('Put back on truck: ' || v_reason, 'Put back on truck'), c.technician_id);

  ELSIF p_kind = 'to_warehouse' THEN
    SELECT l.id INTO v_warehouse
      FROM inventory_locations l
     WHERE l.user_id = c.owner_id AND l.location_type = 'warehouse' AND l.active
     ORDER BY l.created_at LIMIT 1;
    IF v_warehouse IS NULL THEN
      RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'no_warehouse'));
    END IF;

    SELECT COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) INTO v_avail
      FROM (SELECT 1) one
      LEFT JOIN inventory_stock_levels sl ON sl.part_id = p_part_id AND sl.location_id = c.van_id;
    IF COALESCE(v_avail, 0) < p_quantity THEN
      RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'insufficient_stock', 'available', GREATEST(COALESCE(v_avail, 0), 0)));
    END IF;

    INSERT INTO inventory_transactions (user_id, part_id, location_id, job_id, transaction_type, quantity_delta, note, created_by)
    VALUES
      (c.owner_id, p_part_id, c.van_id, p_job_id, 'transfer_out', -p_quantity, COALESCE('Returned to warehouse: ' || v_reason, 'Returned to warehouse'), c.technician_id),
      (c.owner_id, p_part_id, v_warehouse, p_job_id, 'transfer_in', p_quantity, COALESCE('Returned to warehouse: ' || v_reason, 'Returned to warehouse'), c.technician_id);

  ELSE -- 'core': the old unit goes back to the vendor for credit; van stock is unchanged.
    SELECT v.id INTO v_vendor
      FROM inventory_vendors v
     WHERE v.user_id = c.owner_id AND v.active
       AND v.id = COALESCE(p_vendor_id, (SELECT ip.preferred_vendor_id FROM inventory_parts ip WHERE ip.id = p_part_id));
    IF v_vendor IS NULL THEN
      RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'vendor_required'));
    END IF;

    INSERT INTO inventory_returns (user_id, return_type, part_id, job_id, location_id, vendor_id, quantity, reason, status)
    VALUES (c.owner_id, 'core_return', p_part_id, p_job_id, c.van_id, v_vendor, p_quantity, v_reason, 'pending');
  END IF;

  RETURN public.tech_stock_finish(p_op_id, jsonb_build_object('status', 'applied', 'kind', p_kind));
END;
$$;

-- =============================================================
-- 7. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.get_my_truck_stock() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tech_use_part(uuid, uuid, integer, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tech_request_restock(uuid, uuid, integer, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tech_return_part(uuid, uuid, integer, text, uuid, text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_my_truck_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tech_use_part(uuid, uuid, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tech_request_restock(uuid, uuid, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tech_return_part(uuid, uuid, integer, text, uuid, text, uuid) TO authenticated;
