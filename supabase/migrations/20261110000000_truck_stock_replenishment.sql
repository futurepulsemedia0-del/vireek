/*
  # Truck Stock + Parts Availability + Auto-Replenishment

  Builds on 20260928000000_parts_inventory_availability.sql (locations, parts,
  stock ledger, job_parts_required). Additive only: no table/column dropped.

  ## What this adds
  - Team-safe access: existing inventory policies were `user_id = auth.uid()`
    (owner only). Replaced with account-scoped policies (get_account_owner_id)
    so technicians can read stock and record usage/transfers; only owner/admin
    can change catalog, par levels, vendors, POs and settings.
    A BEFORE INSERT trigger stamps user_id with the account owner.
  - inventory_vendors, inventory_par_levels (min/target per truck),
    service_part_kits (service type -> parts, auto-applied to new jobs),
    replenishment_tasks (warehouse -> truck restock), purchase_orders(+lines),
    replenishment_settings.
  - Views: truck_stock_status, job_parts_sourcing, job_dispatch_readiness.
  - RPCs: dispatch_stock_fit, run_my_replenishment, run_replenishment(_all),
    complete_replenishment_task, create_purchase_order, receive_purchase_order.
  - Optional (setting, default OFF): deduct required parts from the tech's van
    when a job is completed.
  - Hourly pg_cron job (only if pg_cron is installed) for accounts that turned
    auto-replenishment on.
*/

-- =============================================================
-- 0. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.inventory_can_manage()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND tm.role = 'admin' AND tm.invite_status = 'active'
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.stamp_inventory_owner()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.user_id := COALESCE(public.get_account_owner_id(), NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.new_po_number()
RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'PO-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
$$;

-- =============================================================
-- 1. NEW TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS inventory_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  name text NOT NULL,
  email text,
  phone text,
  lead_time_days integer NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE inventory_parts
  ADD COLUMN IF NOT EXISTS preferred_vendor_id uuid REFERENCES inventory_vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendor_sku text;

CREATE TABLE IF NOT EXISTS inventory_par_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  min_quantity integer NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  target_quantity integer NOT NULL CHECK (target_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, location_id),
  CONSTRAINT par_target_gte_min CHECK (target_quantity >= min_quantity)
);
CREATE INDEX IF NOT EXISTS idx_par_levels_location ON inventory_par_levels(location_id);

CREATE TABLE IF NOT EXISTS service_part_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  service_type text NOT NULL,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, service_type, part_id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  po_number text NOT NULL,
  vendor_id uuid REFERENCES inventory_vendors(id) ON DELETE SET NULL,
  vendor_name text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'sent', 'partially_received', 'received', 'cancelled')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
  destination_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  total_cents integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  expected_at date,
  sent_at timestamptz,
  received_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, po_number)
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_user_status ON purchase_orders(user_id, status);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id),
  quantity_ordered integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_received integer NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, part_id)
);
CREATE INDEX IF NOT EXISTS idx_po_lines_part ON purchase_order_lines(part_id);

CREATE TABLE IF NOT EXISTS replenishment_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  from_location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  to_location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  reason text NOT NULL DEFAULT 'par_level' CHECK (reason IN ('par_level', 'job_shortage', 'manual')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One open restock per part per truck: makes the engine idempotent and
-- safe against a cron run overlapping a manual run.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_restock_task
  ON replenishment_tasks(part_id, to_location_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_replenishment_tasks_user_status ON replenishment_tasks(user_id, status);

CREATE TABLE IF NOT EXISTS replenishment_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  auto_replenish_enabled boolean NOT NULL DEFAULT false,
  auto_deduct_on_completion boolean NOT NULL DEFAULT false,
  po_approval_threshold_cents integer NOT NULL DEFAULT 50000 CHECK (po_approval_threshold_cents >= 0),
  lookahead_days integer NOT NULL DEFAULT 7 CHECK (lookahead_days BETWEEN 1 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_par_levels_touch ON inventory_par_levels;
CREATE TRIGGER trg_par_levels_touch BEFORE UPDATE ON inventory_par_levels
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();
DROP TRIGGER IF EXISTS trg_purchase_orders_touch ON purchase_orders;
CREATE TRIGGER trg_purchase_orders_touch BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();
DROP TRIGGER IF EXISTS trg_repl_settings_touch ON replenishment_settings;
CREATE TRIGGER trg_repl_settings_touch BEFORE UPDATE ON replenishment_settings
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();

-- One active van per technician (skipped, not fatal, if legacy data conflicts).
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_van_per_technician
    ON inventory_locations(assigned_technician_id)
    WHERE location_type = 'van' AND active AND assigned_technician_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'uniq_active_van_per_technician skipped: %', SQLERRM;
END $$;

-- =============================================================
-- 2. RLS — account-scoped (owner + team), managers write config
-- =============================================================

DO $$
DECLARE
  r record;
  t text;
  all_tables text[] := ARRAY[
    'inventory_locations', 'inventory_parts', 'inventory_stock_levels', 'inventory_transactions',
    'job_parts_required', 'inventory_vendors', 'inventory_par_levels', 'service_part_kits',
    'purchase_orders', 'purchase_order_lines', 'replenishment_tasks', 'replenishment_settings'
  ];
  member_read_manager_write text[] := ARRAY[
    'inventory_locations', 'inventory_parts', 'inventory_par_levels', 'service_part_kits', 'replenishment_tasks'
  ];
  manager_only text[] := ARRAY[
    'inventory_vendors', 'purchase_orders', 'purchase_order_lines', 'replenishment_settings'
  ];
  owner_check constant text := 'user_id = (SELECT public.get_account_owner_id())';
  manager_check constant text := 'user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage())';
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (all_tables) LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;

  FOREACH t IN ARRAY all_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;

  FOREACH t IN ARRAY member_read_manager_write LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', t || '_member_read', t, owner_check);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)', t || '_manager_write', t, manager_check, manager_check);
  END LOOP;

  FOREACH t IN ARRAY manager_only LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)', t || '_manager_all', t, manager_check, manager_check);
  END LOOP;

  -- Stock cache: read-only for everyone; only the ledger trigger writes it.
  EXECUTE format('CREATE POLICY inventory_stock_levels_member_read ON public.inventory_stock_levels FOR SELECT TO authenticated USING (%s)', owner_check);

  -- Ledger: append-only. Any account member may record usage/transfers.
  EXECUTE format('CREATE POLICY inventory_transactions_member_read ON public.inventory_transactions FOR SELECT TO authenticated USING (%s)', owner_check);
  EXECUTE format('CREATE POLICY inventory_transactions_member_insert ON public.inventory_transactions FOR INSERT TO authenticated WITH CHECK (%s)', owner_check);

  -- Job requirements: dispatchers and technicians both maintain these.
  EXECUTE format('CREATE POLICY job_parts_required_member_all ON public.job_parts_required FOR ALL TO authenticated USING (%s) WITH CHECK (%s)', owner_check, owner_check);

  -- Stamp user_id = account owner on insert (technician JWTs would otherwise stamp their own id).
  FOREACH t IN ARRAY all_tables LOOP
    IF t <> 'inventory_stock_levels' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_stamp_owner ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stamp_inventory_owner()', t);
    END IF;
  END LOOP;
END $$;

-- =============================================================
-- 3. VIEWS (security_invoker: the caller's RLS always applies)
-- =============================================================

CREATE OR REPLACE VIEW truck_stock_status
WITH (security_invoker = true) AS
SELECT
  pl.id AS par_level_id,
  pl.user_id,
  pl.location_id,
  loc.name AS location_name,
  loc.assigned_technician_id,
  pl.part_id,
  p.name AS part_name,
  p.part_number,
  a.available AS quantity_available,
  pl.min_quantity,
  pl.target_quantity,
  GREATEST(pl.target_quantity - a.available, 0) AS refill_quantity,
  CASE
    WHEN a.available <= 0 THEN 'empty'
    WHEN a.available <= pl.min_quantity THEN 'low'
    ELSE 'ok'
  END AS status
FROM inventory_par_levels pl
JOIN inventory_locations loc ON loc.id = pl.location_id AND loc.active AND loc.location_type = 'van'
JOIN inventory_parts p ON p.id = pl.part_id AND p.active
LEFT JOIN inventory_stock_levels sl ON sl.part_id = pl.part_id AND sl.location_id = pl.location_id
CROSS JOIN LATERAL (SELECT COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0)::integer AS available) a;

CREATE OR REPLACE VIEW job_parts_sourcing
WITH (security_invoker = true) AS
SELECT
  jpr.id AS requirement_id,
  jpr.user_id,
  jpr.job_id,
  j.customer_name,
  j.service_type,
  j.scheduled_datetime,
  j.assigned_technician_id,
  jpr.part_id,
  p.name AS part_name,
  p.part_number,
  jpr.quantity_required,
  jpr.status,
  s.van_qty,
  s.warehouse_qty,
  s.other_van_qty,
  o.on_order_qty,
  CASE
    WHEN s.van_qty >= jpr.quantity_required THEN 'on_truck'
    WHEN s.van_qty + s.warehouse_qty >= jpr.quantity_required THEN 'warehouse_transfer'
    WHEN s.van_qty + s.warehouse_qty + s.other_van_qty >= jpr.quantity_required THEN 'other_truck'
    WHEN s.van_qty + s.warehouse_qty + s.other_van_qty + o.on_order_qty >= jpr.quantity_required THEN 'awaiting_delivery'
    ELSE 'order_required'
  END AS sourcing_status,
  GREATEST(jpr.quantity_required - s.van_qty - s.warehouse_qty - s.other_van_qty, 0)::integer AS stock_shortfall,
  GREATEST(jpr.quantity_required - s.van_qty - s.warehouse_qty - s.other_van_qty - o.on_order_qty, 0)::integer AS order_shortfall
FROM job_parts_required jpr
JOIN jobs j ON j.id = jpr.job_id AND j.job_status IN ('scheduled', 'en_route')
JOIN inventory_parts p ON p.id = jpr.part_id
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0)) FILTER (
      WHERE loc.location_type = 'van' AND loc.assigned_technician_id IS NOT NULL
        AND loc.assigned_technician_id = j.assigned_technician_id), 0)::integer AS van_qty,
    COALESCE(SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0)) FILTER (
      WHERE loc.location_type = 'warehouse'), 0)::integer AS warehouse_qty,
    COALESCE(SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0)) FILTER (
      WHERE loc.location_type = 'van' AND loc.assigned_technician_id IS DISTINCT FROM j.assigned_technician_id), 0)::integer AS other_van_qty
  FROM inventory_stock_levels sl
  JOIN inventory_locations loc ON loc.id = sl.location_id AND loc.active
  WHERE sl.part_id = jpr.part_id
) s
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(pol.quantity_ordered - pol.quantity_received), 0)::integer AS on_order_qty
  FROM purchase_order_lines pol
  JOIN purchase_orders po ON po.id = pol.purchase_order_id AND po.status IN ('sent', 'partially_received')
  WHERE pol.part_id = jpr.part_id
) o
WHERE jpr.status IN ('needed', 'allocated', 'backordered');

CREATE OR REPLACE VIEW job_dispatch_readiness
WITH (security_invoker = true) AS
SELECT
  user_id, job_id, customer_name, service_type, scheduled_datetime, assigned_technician_id,
  COUNT(*)::integer AS parts_required_count,
  COUNT(*) FILTER (WHERE sourcing_status = 'on_truck')::integer AS parts_on_truck_count,
  CASE
    WHEN bool_and(sourcing_status = 'on_truck') THEN 'ready'
    WHEN bool_or(sourcing_status = 'order_required') THEN 'blocked'
    WHEN bool_or(sourcing_status = 'awaiting_delivery') THEN 'awaiting_delivery'
    ELSE 'needs_restock'
  END AS overall_status
FROM job_parts_sourcing
GROUP BY user_id, job_id, customer_name, service_type, scheduled_datetime, assigned_technician_id;

GRANT SELECT ON truck_stock_status, job_parts_sourcing, job_dispatch_readiness TO authenticated;

-- =============================================================
-- 4. DISPATCH: which technician's van already carries the job's parts
-- =============================================================

CREATE OR REPLACE FUNCTION public.dispatch_stock_fit(p_job_ids uuid[])
RETURNS TABLE (job_id uuid, technician_id uuid, parts_required integer, parts_on_van integer)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT
    jpr.job_id,
    loc.assigned_technician_id,
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) >= jpr.quantity_required)::integer
  FROM job_parts_required jpr
  JOIN inventory_locations loc
    ON loc.user_id = jpr.user_id AND loc.location_type = 'van' AND loc.active AND loc.assigned_technician_id IS NOT NULL
  LEFT JOIN inventory_stock_levels sl ON sl.part_id = jpr.part_id AND sl.location_id = loc.id
  WHERE jpr.job_id = ANY (p_job_ids) AND jpr.status IN ('needed', 'allocated', 'backordered')
  GROUP BY jpr.job_id, loc.assigned_technician_id;
$$;

GRANT EXECUTE ON FUNCTION public.dispatch_stock_fit(uuid[]) TO authenticated;

-- =============================================================
-- 5. AUTO-REPLENISHMENT ENGINE
-- =============================================================

-- Best warehouse to pull a part from, net of stock already promised to open restocks.
CREATE OR REPLACE FUNCTION public.pick_restock_source(p_owner uuid, p_part uuid)
RETURNS TABLE (location_id uuid, available integer)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT
    l.id,
    (COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0)
      - COALESCE((SELECT SUM(t.quantity) FROM replenishment_tasks t
                  WHERE t.status = 'open' AND t.part_id = p_part AND t.from_location_id = l.id), 0))::integer
  FROM inventory_locations l
  LEFT JOIN inventory_stock_levels sl ON sl.location_id = l.id AND sl.part_id = p_part
  WHERE l.user_id = p_owner AND l.active AND l.location_type = 'warehouse'
  ORDER BY 2 DESC, l.created_at
  LIMIT 1;
$$;

-- What to order from vendors, after warehouse->truck restocks are planned.
-- Idempotent: every open PO line (draft included) counts as already on order.
CREATE OR REPLACE FUNCTION public.replenishment_demand(p_owner uuid)
RETURNS TABLE (part_id uuid, vendor_id uuid, qty integer, unit_cost_cents integer)
LANGUAGE sql STABLE SET search_path = public
AS $$
  WITH wh AS (
    SELECT sl.part_id, SUM(sl.quantity_on_hand - sl.quantity_reserved)::integer AS avail
    FROM inventory_stock_levels sl
    JOIN inventory_locations l ON l.id = sl.location_id AND l.active AND l.location_type = 'warehouse'
    WHERE sl.user_id = p_owner GROUP BY sl.part_id
  ),
  pending_out AS (
    SELECT t.part_id, SUM(t.quantity)::integer AS qty
    FROM replenishment_tasks t
    JOIN inventory_locations l ON l.id = t.from_location_id AND l.location_type = 'warehouse'
    WHERE t.user_id = p_owner AND t.status = 'open' GROUP BY t.part_id
  ),
  open_to AS (
    SELECT t.part_id, t.to_location_id, SUM(t.quantity)::integer AS qty
    FROM replenishment_tasks t
    WHERE t.user_id = p_owner AND t.status = 'open' GROUP BY t.part_id, t.to_location_id
  ),
  on_order AS (
    SELECT pol.part_id, SUM(pol.quantity_ordered - pol.quantity_received)::integer AS qty
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
      AND po.status IN ('draft', 'pending_approval', 'sent', 'partially_received')
    WHERE po.user_id = p_owner GROUP BY pol.part_id
  ),
  van_gap AS (
    SELECT pl.part_id,
      SUM(GREATEST(pl.target_quantity - COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) - COALESCE(ot.qty, 0), 0))::integer AS qty
    FROM inventory_par_levels pl
    JOIN inventory_locations l ON l.id = pl.location_id AND l.active AND l.location_type = 'van'
    LEFT JOIN inventory_stock_levels sl ON sl.part_id = pl.part_id AND sl.location_id = pl.location_id
    LEFT JOIN open_to ot ON ot.part_id = pl.part_id AND ot.to_location_id = pl.location_id
    WHERE pl.user_id = p_owner
      AND COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) <= pl.min_quantity
    GROUP BY pl.part_id
  ),
  job_gap AS (
    SELECT jps.part_id, SUM(jps.stock_shortfall)::integer AS qty
    FROM job_parts_sourcing jps
    JOIN replenishment_settings s ON s.user_id = jps.user_id
    WHERE jps.user_id = p_owner AND jps.stock_shortfall > 0
      AND (jps.scheduled_datetime IS NULL OR jps.scheduled_datetime <= now() + make_interval(days => s.lookahead_days))
    GROUP BY jps.part_id
  ),
  calc AS (
    SELECT
      p.id AS part_id, p.preferred_vendor_id, p.unit_cost_cents, p.reorder_point, p.reorder_quantity,
      (COALESCE(wh.avail, 0) - COALESCE(po_out.qty, 0) + COALESCE(oo.qty, 0)
        - COALESCE(vg.qty, 0) - COALESCE(jg.qty, 0)) AS net_after
    FROM inventory_parts p
    LEFT JOIN wh ON wh.part_id = p.id
    LEFT JOIN pending_out po_out ON po_out.part_id = p.id
    LEFT JOIN on_order oo ON oo.part_id = p.id
    LEFT JOIN van_gap vg ON vg.part_id = p.id
    LEFT JOIN job_gap jg ON jg.part_id = p.id
    WHERE p.user_id = p_owner AND p.active
  )
  SELECT c.part_id, c.preferred_vendor_id,
         GREATEST(c.reorder_quantity, c.reorder_point - c.net_after, 1)::integer,
         c.unit_cost_cents
  FROM calc c
  WHERE c.net_after < 0 OR (c.reorder_point > 0 AND c.net_after <= c.reorder_point);
$$;

CREATE OR REPLACE FUNCTION public.run_replenishment(p_owner uuid, p_notify boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  s replenishment_settings%ROWTYPE;
  r record;
  v_src uuid;
  v_avail integer;
  v_qty integer;
  v_rows integer;
  v_tasks integer := 0;
  v_pos integer := 0;
  v_lines integer := 0;
  v_po uuid;
  v_wh uuid;
  v_total integer;
BEGIN
  INSERT INTO replenishment_settings (user_id) VALUES (p_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO s FROM replenishment_settings WHERE user_id = p_owner;

  -- A) Jobs coming up: bring parts the warehouse has onto the assigned technician's van BEFORE dispatch.
  FOR r IN
    SELECT jps.part_id, van.id AS van_id,
           (SUM(jps.quantity_required) - MAX(jps.van_qty))::integer AS need,
           (array_agg(jps.job_id ORDER BY jps.scheduled_datetime NULLS LAST))[1] AS job_id
    FROM job_parts_sourcing jps
    CROSS JOIN LATERAL (
      SELECT l.id FROM inventory_locations l
      WHERE l.user_id = jps.user_id AND l.active AND l.location_type = 'van'
        AND l.assigned_technician_id = jps.assigned_technician_id
      ORDER BY l.created_at LIMIT 1
    ) van
    WHERE jps.user_id = p_owner
      AND jps.sourcing_status = 'warehouse_transfer'
      AND jps.assigned_technician_id IS NOT NULL
      AND jps.scheduled_datetime IS NOT NULL
      AND jps.scheduled_datetime <= now() + make_interval(days => s.lookahead_days)
    GROUP BY jps.part_id, van.id
    ORDER BY MIN(jps.scheduled_datetime)
  LOOP
    v_src := NULL; v_avail := 0;
    SELECT x.location_id, x.available INTO v_src, v_avail FROM public.pick_restock_source(p_owner, r.part_id) x;
    v_qty := LEAST(r.need, COALESCE(v_avail, 0));
    IF v_src IS NOT NULL AND v_qty > 0 THEN
      INSERT INTO replenishment_tasks (user_id, part_id, from_location_id, to_location_id, quantity, reason, job_id)
      VALUES (p_owner, r.part_id, v_src, r.van_id, v_qty, 'job_shortage', r.job_id)
      ON CONFLICT (part_id, to_location_id) WHERE status = 'open' DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_tasks := v_tasks + v_rows;
    END IF;
  END LOOP;

  -- B) Par levels: top every truck that fell to/below its minimum back up to target.
  FOR r IN
    SELECT pl.part_id, pl.location_id AS van_id,
           (pl.target_quantity - COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0))::integer AS need
    FROM inventory_par_levels pl
    JOIN inventory_locations l ON l.id = pl.location_id AND l.active AND l.location_type = 'van'
    JOIN inventory_parts p ON p.id = pl.part_id AND p.active
    LEFT JOIN inventory_stock_levels sl ON sl.part_id = pl.part_id AND sl.location_id = pl.location_id
    WHERE pl.user_id = p_owner
      AND COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) <= pl.min_quantity
      AND NOT EXISTS (
        SELECT 1 FROM replenishment_tasks t
        WHERE t.status = 'open' AND t.part_id = pl.part_id AND t.to_location_id = pl.location_id)
    ORDER BY pl.part_id, pl.location_id
  LOOP
    v_src := NULL; v_avail := 0;
    SELECT x.location_id, x.available INTO v_src, v_avail FROM public.pick_restock_source(p_owner, r.part_id) x;
    v_qty := LEAST(r.need, COALESCE(v_avail, 0));
    IF v_src IS NOT NULL AND v_qty > 0 THEN
      INSERT INTO replenishment_tasks (user_id, part_id, from_location_id, to_location_id, quantity, reason)
      VALUES (p_owner, r.part_id, v_src, r.van_id, v_qty, 'par_level')
      ON CONFLICT (part_id, to_location_id) WHERE status = 'open' DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_tasks := v_tasks + v_rows;
    END IF;
  END LOOP;

  -- C) Whatever the warehouse cannot cover -> purchase orders, one per vendor.
  SELECT l.id INTO v_wh FROM inventory_locations l
  WHERE l.user_id = p_owner AND l.active AND l.location_type = 'warehouse'
  ORDER BY l.created_at LIMIT 1;

  FOR r IN SELECT DISTINCT d.vendor_id FROM public.replenishment_demand(p_owner) d LOOP
    INSERT INTO purchase_orders (user_id, po_number, vendor_id, vendor_name, status, source, destination_location_id, notes)
    VALUES (
      p_owner, public.new_po_number(), r.vendor_id,
      (SELECT v.name FROM inventory_vendors v WHERE v.id = r.vendor_id),
      'draft', 'auto', v_wh, 'Auto-generated by the replenishment engine'
    ) RETURNING id INTO v_po;

    INSERT INTO purchase_order_lines (user_id, purchase_order_id, part_id, quantity_ordered, unit_cost_cents)
    SELECT p_owner, v_po, d.part_id, d.qty, d.unit_cost_cents
    FROM public.replenishment_demand(p_owner) d
    WHERE d.vendor_id IS NOT DISTINCT FROM r.vendor_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    SELECT COALESCE(SUM(pol.quantity_ordered * pol.unit_cost_cents), 0)::integer INTO v_total
    FROM purchase_order_lines pol WHERE pol.purchase_order_id = v_po;

    UPDATE purchase_orders
    SET total_cents = v_total,
        status = CASE WHEN v_total >= s.po_approval_threshold_cents THEN 'pending_approval' ELSE 'draft' END
    WHERE id = v_po;

    v_pos := v_pos + 1;
    v_lines := v_lines + v_rows;
  END LOOP;

  IF p_notify AND (v_tasks > 0 OR v_pos > 0) THEN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      p_owner, 'system', 'Auto-replenishment ran',
      v_tasks || ' truck restock task(s) and ' || v_pos || ' purchase order(s) need your attention.',
      '/dashboard/inventory'
    );
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'tasks_created', v_tasks, 'pos_created', v_pos, 'po_lines', v_lines);
END;
$$;

CREATE OR REPLACE FUNCTION public.run_my_replenishment()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.inventory_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  RETURN public.run_replenishment(public.get_account_owner_id(), false);
END;
$$;

CREATE OR REPLACE FUNCTION public.run_replenishment_all()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT user_id FROM replenishment_settings WHERE auto_replenish_enabled LOOP
    BEGIN
      PERFORM public.run_replenishment(r.user_id, true);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_replenishment failed for %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
  RETURN n;
END;
$$;

-- =============================================================
-- 6. ACTIONS (atomic, permission-checked)
-- =============================================================

CREATE OR REPLACE FUNCTION public.complete_replenishment_task(p_task_id uuid, p_quantity integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t replenishment_tasks%ROWTYPE;
  v_avail integer;
  v_qty integer;
BEGIN
  SELECT * INTO t FROM replenishment_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR t.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF t.status <> 'open' THEN
    RETURN jsonb_build_object('status', 'not_open');
  END IF;

  v_qty := COALESCE(p_quantity, t.quantity);
  IF v_qty <= 0 OR v_qty > t.quantity THEN
    RETURN jsonb_build_object('status', 'invalid_quantity');
  END IF;

  SELECT COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) INTO v_avail
  FROM inventory_stock_levels sl WHERE sl.part_id = t.part_id AND sl.location_id = t.from_location_id
  FOR UPDATE;
  IF COALESCE(v_avail, 0) < v_qty THEN
    RETURN jsonb_build_object('status', 'insufficient_stock', 'available', COALESCE(v_avail, 0));
  END IF;

  INSERT INTO inventory_transactions (user_id, part_id, location_id, job_id, transaction_type, quantity_delta, note)
  VALUES
    (t.user_id, t.part_id, t.from_location_id, t.job_id, 'transfer_out', -v_qty, 'Truck restock'),
    (t.user_id, t.part_id, t.to_location_id, t.job_id, 'transfer_in', v_qty, 'Truck restock');

  UPDATE replenishment_tasks
  SET status = 'completed', quantity = v_qty, completed_at = now(), completed_by = auth.uid()
  WHERE id = t.id;

  RETURN jsonb_build_object('status', 'completed', 'quantity', v_qty);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_purchase_order(p_vendor_id uuid, p_lines jsonb, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_po uuid;
  v_wh uuid;
BEGIN
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one line is required';
  END IF;
  IF p_vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_vendors v WHERE v.id = p_vendor_id AND v.user_id = v_owner
  ) THEN
    RAISE EXCEPTION 'Unknown vendor';
  END IF;

  SELECT l.id INTO v_wh FROM inventory_locations l
  WHERE l.user_id = v_owner AND l.active AND l.location_type = 'warehouse'
  ORDER BY l.created_at LIMIT 1;

  INSERT INTO purchase_orders (user_id, po_number, vendor_id, vendor_name, status, source, destination_location_id, notes)
  VALUES (
    v_owner, public.new_po_number(), p_vendor_id,
    (SELECT v.name FROM inventory_vendors v WHERE v.id = p_vendor_id),
    'draft', 'manual', v_wh, p_notes
  ) RETURNING id INTO v_po;

  INSERT INTO purchase_order_lines (user_id, purchase_order_id, part_id, quantity_ordered, unit_cost_cents)
  SELECT v_owner, v_po, p.id, SUM(GREATEST((e->>'quantity')::integer, 1))::integer, p.unit_cost_cents
  FROM jsonb_array_elements(p_lines) e
  JOIN inventory_parts p ON p.id = (e->>'part_id')::uuid AND p.user_id = v_owner
  GROUP BY p.id, p.unit_cost_cents;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No valid parts in the order';
  END IF;

  UPDATE purchase_orders
  SET total_cents = (SELECT COALESCE(SUM(pol.quantity_ordered * pol.unit_cost_cents), 0) FROM purchase_order_lines pol WHERE pol.purchase_order_id = v_po)
  WHERE id = v_po;

  RETURN v_po;
END;
$$;

CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_po_id uuid, p_lines jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  po purchase_orders%ROWTYPE;
  l record;
  v_dest uuid;
  v_open integer;
  v_req integer;
  v_qty integer;
  v_any boolean := false;
  v_done boolean;
BEGIN
  IF NOT public.inventory_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND OR po.user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF po.status NOT IN ('sent', 'partially_received') THEN
    RETURN jsonb_build_object('status', 'not_receivable');
  END IF;

  v_dest := po.destination_location_id;
  IF v_dest IS NULL THEN
    SELECT x.id INTO v_dest FROM inventory_locations x
    WHERE x.user_id = po.user_id AND x.active AND x.location_type = 'warehouse'
    ORDER BY x.created_at LIMIT 1;
  END IF;
  IF v_dest IS NULL THEN
    RETURN jsonb_build_object('status', 'no_destination');
  END IF;

  FOR l IN SELECT * FROM purchase_order_lines WHERE purchase_order_id = po.id ORDER BY created_at, id FOR UPDATE LOOP
    v_open := l.quantity_ordered - l.quantity_received;
    CONTINUE WHEN v_open <= 0;
    IF p_lines IS NULL THEN
      v_qty := v_open;
    ELSE
      SELECT COALESCE(SUM((e->>'quantity')::integer), 0) INTO v_req
      FROM jsonb_array_elements(p_lines) e WHERE (e->>'line_id')::uuid = l.id;
      v_qty := LEAST(v_req, v_open);
    END IF;
    CONTINUE WHEN v_qty <= 0;

    INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
    VALUES (po.user_id, l.part_id, v_dest, 'receipt', v_qty, l.unit_cost_cents, 'Received on ' || po.po_number);
    UPDATE purchase_order_lines SET quantity_received = quantity_received + v_qty WHERE id = l.id;
    v_any := true;
  END LOOP;

  IF NOT v_any THEN
    RETURN jsonb_build_object('status', 'nothing_received');
  END IF;

  v_done := NOT EXISTS (
    SELECT 1 FROM purchase_order_lines x WHERE x.purchase_order_id = po.id AND x.quantity_received < x.quantity_ordered
  );
  UPDATE purchase_orders
  SET status = CASE WHEN v_done THEN 'received' ELSE 'partially_received' END,
      received_at = CASE WHEN v_done THEN now() ELSE received_at END
  WHERE id = po.id;

  RETURN jsonb_build_object('status', CASE WHEN v_done THEN 'received' ELSE 'partially_received' END);
END;
$$;

REVOKE ALL ON FUNCTION public.run_replenishment(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_replenishment_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_replenishment(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_replenishment_all() TO service_role;
GRANT EXECUTE ON FUNCTION public.run_my_replenishment() TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_replenishment_task(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase_order(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_can_manage() TO authenticated;

-- =============================================================
-- 7. JOB LIFECYCLE HOOKS (never block the job write)
-- =============================================================

-- New/changed service_type -> attach that service's parts kit as job requirements.
CREATE OR REPLACE FUNCTION public.apply_service_part_kit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.service_type IS NULL OR NEW.job_status NOT IN ('scheduled', 'en_route') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.service_type IS NOT DISTINCT FROM OLD.service_type THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO job_parts_required (user_id, job_id, part_id, quantity_required)
    SELECT NEW.user_id, NEW.id, k.part_id, k.quantity
    FROM service_part_kits k
    WHERE k.user_id = NEW.user_id AND lower(k.service_type) = lower(NEW.service_type)
    ON CONFLICT (job_id, part_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'apply_service_part_kit failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_service_part_kit ON jobs;
CREATE TRIGGER trg_apply_service_part_kit
  AFTER INSERT OR UPDATE OF service_type ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.apply_service_part_kit();

-- Optional (settings.auto_deduct_on_completion): consume required parts from
-- the assigned technician's van (else the fullest warehouse) on completion.
CREATE OR REPLACE FUNCTION public.deduct_job_parts_on_completion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
  v_loc uuid;
BEGIN
  IF NOT COALESCE((SELECT s.auto_deduct_on_completion FROM replenishment_settings s WHERE s.user_id = NEW.user_id), false) THEN
    RETURN NEW;
  END IF;
  BEGIN
    FOR r IN
      SELECT jpr.id, jpr.part_id, jpr.quantity_required
      FROM job_parts_required jpr
      WHERE jpr.job_id = NEW.id AND jpr.status IN ('needed', 'allocated')
    LOOP
      v_loc := NULL;
      SELECT l.id INTO v_loc
      FROM inventory_locations l
      LEFT JOIN inventory_stock_levels sl ON sl.location_id = l.id AND sl.part_id = r.part_id
      WHERE l.user_id = NEW.user_id AND l.active
        AND (
          (l.location_type = 'van' AND NEW.assigned_technician_id IS NOT NULL AND l.assigned_technician_id = NEW.assigned_technician_id)
          OR l.location_type = 'warehouse'
        )
      ORDER BY (l.location_type = 'van') DESC, COALESCE(sl.quantity_on_hand, 0) DESC
      LIMIT 1;

      IF v_loc IS NOT NULL THEN
        INSERT INTO inventory_transactions (user_id, part_id, location_id, job_id, transaction_type, quantity_delta, note)
        VALUES (NEW.user_id, r.part_id, v_loc, NEW.id, 'usage', -r.quantity_required, 'Auto-deducted on job completion');
        UPDATE job_parts_required SET status = 'installed', updated_at = now() WHERE id = r.id;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'deduct_job_parts_on_completion failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deduct_job_parts_on_completion ON jobs;
CREATE TRIGGER trg_deduct_job_parts_on_completion
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW
  WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.deduct_job_parts_on_completion();

-- =============================================================
-- 8. HOURLY SCHEDULE (only when pg_cron exists; otherwise run
--    `select public.run_replenishment_all();` from any scheduler)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-auto-replenishment');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-auto-replenishment', '15 * * * *', 'select public.run_replenishment_all()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
