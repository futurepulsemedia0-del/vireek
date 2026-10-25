/*
  # Truck replenishment, transfer orders, van audits, shrinkage & dispatch alerts

  Additive only: nothing is dropped, renamed or rewritten. Builds on
    20260928000000_parts_inventory_availability.sql  (locations, parts, ledger, stock cache)
    20261110000000_truck_stock_replenishment.sql     (par levels, replenishment_tasks, helpers)
    20270410000000_tech_truck_stock.sql              (tech_stock_context)
    20270410000000_inventory_cycle_counts.sql        (cycle counts = the van-audit engine)

  ## What this adds
  - truck_ops_settings        per-account knobs (horizon, safety factor, audit cadence, shrink thresholds)
  - truck_restock_forecast()  min/max + forecast restock suggestions per truck from UPCOMING JOBS
                              (explicit job parts + historical average per service type)
  - stock_transfer_orders/_lines + RPCs: create -> pick (scan) -> ship -> receive (scan) -> complete,
                              cancel. Ledger rows are written only at ship (transfer_out) and
                              complete (transfer_in); a short receipt becomes a variance event.
  - create_transfers_from_forecast()  one click: forecast -> transfer orders (best warehouse per part)
  - van_audit_status view + start_van_audit()  scheduled blind van audits on top of cycle counts
  - inventory_variance_events + detect_inventory_variance()  shrinkage / variance detection
  - truck_stock_alerts + run_truck_ops_scan()  low-stock, stock-out, job-at-risk, audit-overdue alerts
                              pushed to the account's notifications (dispatch sees them) + realtime
  - Hourly pg_cron job (only if pg_cron exists)

  ## Security
  Same model as the existing inventory tables: every row carries user_id = ACCOUNT OWNER id; members
  can read; all writes go through SECURITY DEFINER RPCs that re-check membership, role and status.
*/

SET lock_timeout = '5s';

-- =============================================================
-- 0. PREREQUISITE CHECK (clear message instead of a cryptic error)
-- =============================================================

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_locations', 'inventory_parts', 'inventory_stock_levels', 'inventory_transactions',
    'inventory_par_levels', 'replenishment_tasks', 'job_parts_required', 'jobs', 'team_members',
    'notifications', 'inventory_counts', 'inventory_count_lines'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.get_account_owner_id()', 'public.inventory_can_manage()', 'public.stamp_inventory_owner()',
    'public.inventory_touch_updated_at()', 'public.tech_stock_context()',
    'public.start_inventory_count(uuid,text,text,text,text,uuid[],integer,boolean,text)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN missing := missing || f; END IF;
  END LOOP;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Truck-ops migration needs these objects first (apply the earlier inventory migrations): %',
      array_to_string(missing, ', ');
  END IF;
END $$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS truck_ops_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT auth.uid(),
  forecast_horizon_days integer NOT NULL DEFAULT 7 CHECK (forecast_horizon_days BETWEEN 1 AND 30),
  history_days integer NOT NULL DEFAULT 90 CHECK (history_days BETWEEN 14 AND 365),
  safety_factor numeric(4,2) NOT NULL DEFAULT 1.20 CHECK (safety_factor BETWEEN 1 AND 3),
  audit_interval_days integer NOT NULL DEFAULT 14 CHECK (audit_interval_days BETWEEN 1 AND 180),
  shrink_alert_pct numeric(5,2) NOT NULL DEFAULT 5 CHECK (shrink_alert_pct BETWEEN 0.5 AND 100),
  shrink_min_value_cents integer NOT NULL DEFAULT 2000 CHECK (shrink_min_value_cents >= 0),
  low_stock_alerts_enabled boolean NOT NULL DEFAULT true,
  alert_cooldown_hours integer NOT NULL DEFAULT 12 CHECK (alert_cooldown_hours BETWEEN 1 AND 168),
  require_scan boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_transfer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transfer_number text NOT NULL,
  from_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  to_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_transit', 'completed', 'cancelled')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'forecast', 'par_level', 'job_shortage', 'task')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  notes text,
  has_variance boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  shipped_at timestamptz,
  shipped_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_at timestamptz,
  received_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, transfer_number),
  CONSTRAINT transfer_locations_differ CHECK (from_location_id <> to_location_id)
);
CREATE INDEX IF NOT EXISTS idx_transfer_orders_user_status ON stock_transfer_orders(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_orders_to ON stock_transfer_orders(to_location_id, status);
CREATE INDEX IF NOT EXISTS idx_transfer_orders_from ON stock_transfer_orders(from_location_id, status);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES stock_transfer_orders(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id),
  qty_planned integer NOT NULL CHECK (qty_planned > 0),
  qty_picked integer NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  qty_received integer NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  picked_at timestamptz,
  picked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  pick_scanned boolean NOT NULL DEFAULT false,
  pick_override_reason text,
  received_at timestamptz,
  received_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  receive_scanned boolean NOT NULL DEFAULT false,
  receive_override_reason text,
  replenishment_task_id uuid REFERENCES replenishment_tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, part_id),
  CONSTRAINT transfer_received_lte_picked CHECK (qty_received <= qty_picked),
  CONSTRAINT transfer_picked_lte_planned CHECK (qty_picked <= qty_planned)
);
CREATE INDEX IF NOT EXISTS idx_transfer_lines_transfer ON stock_transfer_lines(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_lines_part ON stock_transfer_lines(part_id);
CREATE INDEX IF NOT EXISTS idx_transfer_lines_task ON stock_transfer_lines(replenishment_task_id) WHERE replenishment_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_variance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'count_shortage', 'count_overage', 'transfer_shortage', 'negative_stock',
    'unassigned_usage', 'overuse_vs_job', 'shrink_pattern')),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  quantity integer,
  value_cents bigint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  dedupe_key text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_variance_events_user_status ON inventory_variance_events(user_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_variance_events_location ON inventory_variance_events(location_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS truck_stock_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type text NOT NULL CHECK (alert_type IN ('low_stock', 'stockout', 'job_at_risk', 'audit_overdue')),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  location_id uuid REFERENCES inventory_locations(id) ON DELETE CASCADE,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  message text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_truck_alert_active
  ON truck_stock_alerts(user_id, dedupe_key) WHERE status IN ('open', 'acknowledged');
CREATE INDEX IF NOT EXISTS idx_truck_alerts_user_status ON truck_stock_alerts(user_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_truck_alerts_location ON truck_stock_alerts(location_id);

DROP TRIGGER IF EXISTS trg_truck_ops_settings_touch ON truck_ops_settings;
CREATE TRIGGER trg_truck_ops_settings_touch BEFORE UPDATE ON truck_ops_settings
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();
DROP TRIGGER IF EXISTS trg_transfer_orders_touch ON stock_transfer_orders;
CREATE TRIGGER trg_transfer_orders_touch BEFORE UPDATE ON stock_transfer_orders
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();
DROP TRIGGER IF EXISTS trg_stamp_owner ON truck_ops_settings;
CREATE TRIGGER trg_stamp_owner BEFORE INSERT ON truck_ops_settings
  FOR EACH ROW EXECUTE FUNCTION public.stamp_inventory_owner();

-- =============================================================
-- 2. RLS — members read; settings written by managers; everything else RPC-only
-- =============================================================

ALTER TABLE truck_ops_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_variance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE truck_stock_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS truck_ops_settings_member_read ON truck_ops_settings;
CREATE POLICY truck_ops_settings_member_read ON truck_ops_settings FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS truck_ops_settings_manager_write ON truck_ops_settings;
CREATE POLICY truck_ops_settings_manager_write ON truck_ops_settings FOR ALL TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage()))
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage()));

DROP POLICY IF EXISTS stock_transfer_orders_member_read ON stock_transfer_orders;
CREATE POLICY stock_transfer_orders_member_read ON stock_transfer_orders FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS stock_transfer_lines_member_read ON stock_transfer_lines;
CREATE POLICY stock_transfer_lines_member_read ON stock_transfer_lines FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS inventory_variance_events_member_read ON inventory_variance_events;
CREATE POLICY inventory_variance_events_member_read ON inventory_variance_events FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS truck_stock_alerts_member_read ON truck_stock_alerts;
CREATE POLICY truck_stock_alerts_member_read ON truck_stock_alerts FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

REVOKE ALL ON stock_transfer_orders, stock_transfer_lines, inventory_variance_events, truck_stock_alerts FROM anon, authenticated;
GRANT SELECT ON stock_transfer_orders, stock_transfer_lines, inventory_variance_events, truck_stock_alerts TO authenticated;
REVOKE ALL ON truck_ops_settings FROM anon;
GRANT SELECT, INSERT, UPDATE ON truck_ops_settings TO authenticated;

-- Live updates for dispatch (ignored if the publication is missing or already has the table).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.truck_stock_alerts;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_transfer_orders;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

-- =============================================================
-- 3. HELPERS
-- =============================================================

-- Settings with defaults for accounts that never saved any. Internal only.
CREATE OR REPLACE FUNCTION public.truck_ops_cfg(p_owner uuid)
RETURNS TABLE (
  forecast_horizon_days integer, history_days integer, safety_factor numeric, audit_interval_days integer,
  shrink_alert_pct numeric, shrink_min_value_cents integer, low_stock_alerts_enabled boolean,
  alert_cooldown_hours integer, require_scan boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(s.forecast_horizon_days, 7), COALESCE(s.history_days, 90), COALESCE(s.safety_factor, 1.20),
         COALESCE(s.audit_interval_days, 14), COALESCE(s.shrink_alert_pct, 5), COALESCE(s.shrink_min_value_cents, 2000),
         COALESCE(s.low_stock_alerts_enabled, true), COALESCE(s.alert_cooldown_hours, 12), COALESCE(s.require_scan, true)
  FROM (SELECT 1) o LEFT JOIN truck_ops_settings s ON s.user_id = p_owner;
$$;

-- Owner / admin / any non-technician team member (dispatchers, office staff).
CREATE OR REPLACE FUNCTION public.truck_ops_can_dispatch()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.inventory_can_manage()
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND tm.invite_status = 'active' AND tm.role <> 'technician'
    )
  );
$$;

-- Stock free to promise at one location (on hand - reserved - open restock tasks leaving it
-- - unlinked open transfer lines leaving it). May be negative.
CREATE OR REPLACE FUNCTION public.truck_location_free_qty(p_location uuid, p_part uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT (
    COALESCE((SELECT sl.quantity_on_hand - sl.quantity_reserved FROM inventory_stock_levels sl
              WHERE sl.location_id = p_location AND sl.part_id = p_part), 0)
    - COALESCE((SELECT SUM(t.quantity) FROM replenishment_tasks t
                WHERE t.status = 'open' AND t.part_id = p_part AND t.from_location_id = p_location), 0)
    - COALESCE((SELECT SUM(l.qty_planned) FROM stock_transfer_lines l
                JOIN stock_transfer_orders o ON o.id = l.transfer_id
                WHERE o.status = 'open' AND o.from_location_id = p_location AND l.part_id = p_part
                  AND l.replenishment_task_id IS NULL), 0)
  )::integer;
$$;

-- Quantity already on its way to a location (open tasks + transfer lines not tied to a task).
CREATE OR REPLACE FUNCTION public.truck_inbound_qty(p_location uuid, p_part uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT (
    COALESCE((SELECT SUM(t.quantity) FROM replenishment_tasks t
              WHERE t.status = 'open' AND t.part_id = p_part AND t.to_location_id = p_location), 0)
    + COALESCE((SELECT SUM(CASE WHEN o.status = 'open' THEN l.qty_planned ELSE l.qty_picked END)
                FROM stock_transfer_lines l
                JOIN stock_transfer_orders o ON o.id = l.transfer_id
                WHERE o.status IN ('open', 'in_transit') AND o.to_location_id = p_location AND l.part_id = p_part
                  AND l.replenishment_task_id IS NULL), 0)
  )::integer;
$$;

-- Insert-or-refresh one operational alert. Returns true when a NEW alert was created.
CREATE OR REPLACE FUNCTION public.truck_alert_upsert(
  p_owner uuid, p_type text, p_severity text, p_location uuid, p_tech uuid,
  p_part uuid, p_job uuid, p_message text, p_key text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_new boolean;
BEGIN
  INSERT INTO truck_stock_alerts (user_id, alert_type, severity, location_id, technician_id, part_id, job_id, message, dedupe_key)
  VALUES (p_owner, p_type, p_severity, p_location, p_tech, p_part, p_job, left(p_message, 500), p_key)
  ON CONFLICT (user_id, dedupe_key) WHERE status IN ('open', 'acknowledged')
  DO UPDATE SET last_seen_at = now(), alert_type = EXCLUDED.alert_type,
                severity = EXCLUDED.severity, message = EXCLUDED.message
  RETURNING (xmax = 0) INTO v_new;
  RETURN COALESCE(v_new, false);
END;
$$;

-- =============================================================
-- 4. FORECAST: min/max + upcoming-jobs restock suggestions per truck
-- =============================================================

CREATE OR REPLACE FUNCTION public.truck_forecast_internal(p_owner uuid, p_location uuid DEFAULT NULL)
RETURNS TABLE (
  location_id uuid, location_name text, technician_id uuid, part_id uuid, part_name text, part_number text,
  available integer, min_quantity integer, target_quantity integer, upcoming_jobs integer,
  explicit_demand integer, statistical_demand numeric, forecast_demand integer, inbound integer,
  projected integer, suggested_qty integer, warehouse_available integer, fulfillable_qty integer,
  order_shortfall integer, reason text, confidence text,
  first_short_job_id uuid, first_short_at timestamptz, unit_cost_cents integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH cfg AS (SELECT * FROM public.truck_ops_cfg(p_owner)),
  vans AS (
    SELECT l.id, l.name, l.assigned_technician_id AS tech
    FROM inventory_locations l
    WHERE l.user_id = p_owner AND l.active AND l.location_type = 'van'
      AND l.assigned_technician_id IS NOT NULL
      AND (p_location IS NULL OR l.id = p_location)
  ),
  upcoming AS (
    SELECT j.id AS job_id, v.id AS van_id, j.scheduled_datetime AS sched, lower(btrim(j.service_type)) AS st
    FROM jobs j
    JOIN vans v ON v.tech = j.assigned_technician_id
    CROSS JOIN cfg
    WHERE j.user_id = p_owner AND j.job_status IN ('scheduled', 'en_route')
      AND j.scheduled_datetime IS NOT NULL
      AND j.scheduled_datetime >= now() - interval '24 hours'
      AND j.scheduled_datetime <= now() + make_interval(days => cfg.forecast_horizon_days)
  ),
  hist_jobs AS (
    SELECT lower(btrim(j.service_type)) AS st, count(*)::integer AS n
    FROM jobs j CROSS JOIN cfg
    WHERE j.user_id = p_owner AND j.job_status = 'completed' AND j.service_type IS NOT NULL
      AND j.completed_at >= now() - make_interval(days => cfg.history_days)
    GROUP BY 1
  ),
  hist_use AS (
    SELECT lower(btrim(j.service_type)) AS st, t.part_id, t.job_id,
           GREATEST(-SUM(t.quantity_delta), 0)::numeric AS q
    FROM inventory_transactions t
    JOIN jobs j ON j.id = t.job_id
    CROSS JOIN cfg
    WHERE t.user_id = p_owner AND t.transaction_type IN ('usage', 'return')
      AND j.job_status = 'completed' AND j.service_type IS NOT NULL
      AND j.completed_at >= now() - make_interval(days => cfg.history_days)
    GROUP BY 1, 2, 3
  ),
  hist AS (
    SELECT hu.st, hu.part_id, SUM(hu.q) / hj.n AS avg_qty, hj.n AS sample
    FROM hist_use hu JOIN hist_jobs hj ON hj.st = hu.st
    GROUP BY hu.st, hu.part_id, hj.n
  ),
  explicit AS (
    SELECT u.job_id, u.van_id, u.sched, jpr.part_id, jpr.quantity_required::numeric AS qty
    FROM upcoming u
    JOIN job_parts_required jpr ON jpr.job_id = u.job_id AND jpr.status IN ('needed', 'allocated', 'backordered')
  ),
  stat AS (
    SELECT u.job_id, u.van_id, u.sched, h.part_id, (h.avg_qty * cfg.safety_factor) AS qty, h.sample
    FROM upcoming u
    JOIN hist h ON h.st = u.st AND h.sample >= 2
    CROSS JOIN cfg
    WHERE NOT EXISTS (SELECT 1 FROM explicit e WHERE e.job_id = u.job_id AND e.part_id = h.part_id)
  ),
  demand AS (
    SELECT job_id, van_id, sched, part_id, qty, true AS is_explicit, NULL::integer AS sample FROM explicit
    UNION ALL
    SELECT job_id, van_id, sched, part_id, qty, false, sample FROM stat
  ),
  demand_cum AS (
    SELECT d.*,
      SUM(d.qty) OVER (PARTITION BY d.van_id, d.part_id ORDER BY d.sched, d.job_id) AS cum
    FROM demand d
  ),
  first_short AS (
    SELECT DISTINCT ON (dc.van_id, dc.part_id) dc.van_id, dc.part_id, dc.job_id, dc.sched
    FROM demand_cum dc
    LEFT JOIN inventory_stock_levels sl ON sl.location_id = dc.van_id AND sl.part_id = dc.part_id
    WHERE dc.cum > COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0)
    ORDER BY dc.van_id, dc.part_id, dc.sched, dc.job_id
  ),
  agg AS (
    SELECT d.van_id, d.part_id,
           COALESCE(SUM(d.qty) FILTER (WHERE d.is_explicit), 0) AS explicit_qty,
           COALESCE(SUM(d.qty) FILTER (WHERE NOT d.is_explicit), 0) AS stat_qty,
           COUNT(DISTINCT d.job_id)::integer AS jobs_n,
           MIN(d.sample) AS min_sample
    FROM demand d GROUP BY d.van_id, d.part_id
  ),
  keys AS (
    SELECT pl.location_id AS van_id, pl.part_id FROM inventory_par_levels pl
    JOIN vans v ON v.id = pl.location_id WHERE pl.user_id = p_owner
    UNION
    SELECT a.van_id, a.part_id FROM agg a
  ),
  calc AS (
    SELECT k.van_id, k.part_id, v.name AS van_name, v.tech,
           p.name AS part_name, p.part_number, p.unit_cost_cents,
           COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0)::integer AS avail,
           pl.min_quantity, pl.target_quantity,
           COALESCE(a.jobs_n, 0) AS jobs_n,
           COALESCE(a.explicit_qty, 0) AS explicit_qty,
           COALESCE(a.stat_qty, 0) AS stat_qty,
           CEIL(COALESCE(a.explicit_qty, 0) + COALESCE(a.stat_qty, 0))::integer AS fdemand,
           public.truck_inbound_qty(k.van_id, k.part_id) AS inb,
           a.min_sample
    FROM keys k
    JOIN vans v ON v.id = k.van_id
    JOIN inventory_parts p ON p.id = k.part_id AND p.active AND p.user_id = p_owner
    LEFT JOIN inventory_stock_levels sl ON sl.location_id = k.van_id AND sl.part_id = k.part_id
    LEFT JOIN inventory_par_levels pl ON pl.location_id = k.van_id AND pl.part_id = k.part_id
    LEFT JOIN agg a ON a.van_id = k.van_id AND a.part_id = k.part_id
  ),
  sugg AS (
    SELECT c.*,
      (c.avail + c.inb - c.fdemand) AS proj,
      CASE
        WHEN c.target_quantity IS NOT NULL AND (c.avail + c.inb - c.fdemand) <= COALESCE(c.min_quantity, 0)
          THEN GREATEST(GREATEST(c.target_quantity, c.fdemand + COALESCE(c.min_quantity, 0)) - (c.avail + c.inb), 0)
        WHEN c.target_quantity IS NULL AND (c.avail + c.inb - c.fdemand) < 0
          THEN (c.fdemand - c.avail - c.inb)
        ELSE 0
      END::integer AS sq
    FROM calc c
  )
  SELECT s.van_id, s.van_name, s.tech, s.part_id, s.part_name, s.part_number,
         s.avail, s.min_quantity, s.target_quantity, s.jobs_n,
         CEIL(s.explicit_qty)::integer, ROUND(s.stat_qty, 2), s.fdemand, s.inb,
         s.proj::integer, s.sq,
         GREATEST(wh.free, 0)::integer,
         LEAST(s.sq, GREATEST(wh.free, 0))::integer,
         (s.sq - LEAST(s.sq, GREATEST(wh.free, 0)))::integer,
         CASE
           WHEN s.fdemand > 0 AND s.proj < 0 THEN 'job_demand'
           WHEN s.fdemand > 0 THEN 'forecast_min'
           ELSE 'below_min'
         END,
         CASE
           WHEN s.fdemand = 0 OR s.stat_qty = 0 THEN 'high'
           WHEN COALESCE(s.min_sample, 0) >= 8 THEN 'medium'
           ELSE 'low'
         END,
         fs.job_id, fs.sched, s.unit_cost_cents
  FROM sugg s
  LEFT JOIN first_short fs ON fs.van_id = s.van_id AND fs.part_id = s.part_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(public.truck_location_free_qty(w.id, s.part_id), 0)), 0) AS free
    FROM inventory_locations w
    WHERE w.user_id = p_owner AND w.active AND w.location_type = 'warehouse'
  ) wh
  WHERE s.sq > 0
  ORDER BY fs.sched NULLS LAST, s.van_name, s.part_name;
$$;

CREATE OR REPLACE FUNCTION public.truck_restock_forecast(p_location_id uuid DEFAULT NULL)
RETURNS TABLE (
  location_id uuid, location_name text, technician_id uuid, part_id uuid, part_name text, part_number text,
  available integer, min_quantity integer, target_quantity integer, upcoming_jobs integer,
  explicit_demand integer, statistical_demand numeric, forecast_demand integer, inbound integer,
  projected integer, suggested_qty integer, warehouse_available integer, fulfillable_qty integer,
  order_shortfall integer, reason text, confidence text,
  first_short_job_id uuid, first_short_at timestamptz, unit_cost_cents integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.truck_forecast_internal(v_owner, p_location_id);
END;
$$;

-- =============================================================
-- 5. TRANSFER ORDERS (create -> pick/scan -> ship -> receive/scan -> complete)
-- =============================================================

-- Comparison key for scanned codes: letters/digits only, case-insensitive, and for all-digit codes the
-- leading zeros are ignored (a UPC-A on the box and the EAN-13 a camera reports are the same product).
CREATE OR REPLACE FUNCTION public.truck_norm_code(p_code text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN k ~ '^[0-9]+$' THEN ltrim(k, '0') ELSE k END
  FROM (SELECT regexp_replace(lower(COALESCE(p_code, '')), '[^a-z0-9]', '', 'g') AS k) x;
$$;

-- Resolve a scanned code to a part of this account (barcode first, then part number).
CREATE OR REPLACE FUNCTION public.truck_part_by_code(p_owner uuid, p_code text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id FROM inventory_parts p
  WHERE p.user_id = p_owner AND p.active
    AND public.truck_norm_code(p_code) <> ''
    AND (public.truck_norm_code(p.barcode) = public.truck_norm_code(p_code)
         OR public.truck_norm_code(p.part_number) = public.truck_norm_code(p_code))
  ORDER BY (public.truck_norm_code(p.barcode) = public.truck_norm_code(p_code)) DESC NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_van()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c record;
  v_name text;
BEGIN
  SELECT * INTO c FROM public.tech_stock_context();
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_a_technician'); END IF;
  IF c.van_id IS NULL THEN RETURN jsonb_build_object('status', 'no_truck', 'technician_id', c.technician_id); END IF;
  SELECT name INTO v_name FROM inventory_locations WHERE id = c.van_id;
  RETURN jsonb_build_object('status', 'ok', 'technician_id', c.technician_id, 'van_id', c.van_id, 'van_name', v_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_stock_transfer(
  p_from uuid,
  p_to uuid,
  p_lines jsonb,
  p_source text DEFAULT 'manual',
  p_notes text DEFAULT NULL,
  p_job_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_number text;
  v_source text := COALESCE(p_source, 'manual');
  v_rows integer;
  v_bad uuid;
  v_norm jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.truck_ops_can_dispatch() THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  IF v_source NOT IN ('manual', 'forecast', 'par_level', 'job_shortage', 'task') THEN
    v_source := 'manual';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to
     OR (SELECT count(*) FROM inventory_locations x WHERE x.id IN (p_from, p_to) AND x.user_id = v_owner AND x.active) <> 2 THEN
    RETURN jsonb_build_object('status', 'invalid_locations');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0
     OR jsonb_array_length(p_lines) > 300 THEN
    RETURN jsonb_build_object('status', 'invalid_lines');
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job_id AND j.user_id = v_owner) THEN
    RETURN jsonb_build_object('status', 'job_not_found');
  END IF;

  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('part_id', q.part_id, 'qty', q.qty, 'task_id', q.task_id)), '[]'::jsonb)
    INTO v_norm
    FROM (
      SELECT (e->>'part_id')::uuid AS part_id,
             SUM((e->>'quantity')::integer)::integer AS qty,
             (array_agg(NULLIF(e->>'task_id', '')::uuid))[1] AS task_id
      FROM jsonb_array_elements(p_lines) e
      GROUP BY (e->>'part_id')::uuid
    ) q;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'invalid_lines');
  END;

  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(v_norm) AS t(part_id uuid, qty integer, task_id uuid)
             WHERE t.qty IS NULL OR t.qty <= 0 OR t.qty > 100000 OR t.part_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'invalid_lines');
  END IF;
  SELECT t.part_id INTO v_bad FROM jsonb_to_recordset(v_norm) AS t(part_id uuid, qty integer, task_id uuid)
  WHERE NOT EXISTS (SELECT 1 FROM inventory_parts p WHERE p.id = t.part_id AND p.user_id = v_owner AND p.active)
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'part_not_found', 'part_id', v_bad);
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_norm) AS t(part_id uuid, qty integer, task_id uuid)
    WHERE t.task_id IS NOT NULL AND (
      NOT EXISTS (SELECT 1 FROM replenishment_tasks rt
                  WHERE rt.id = t.task_id AND rt.user_id = v_owner AND rt.status = 'open'
                    AND rt.part_id = t.part_id AND rt.from_location_id = p_from AND rt.to_location_id = p_to)
      OR EXISTS (SELECT 1 FROM stock_transfer_lines l JOIN stock_transfer_orders o ON o.id = l.transfer_id
                 WHERE l.replenishment_task_id = t.task_id AND o.status IN ('open', 'in_transit'))
    )
  ) THEN
    RETURN jsonb_build_object('status', 'task_conflict');
  END IF;

  v_number := 'TO-' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || '-' ||
              upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));

  INSERT INTO stock_transfer_orders (user_id, transfer_number, from_location_id, to_location_id, source, job_id, notes, created_by)
  VALUES (v_owner, v_number, p_from, p_to, v_source, p_job_id,
          NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''), auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO stock_transfer_lines (user_id, transfer_id, part_id, qty_planned, unit_cost_cents, replenishment_task_id)
  SELECT v_owner, v_id, t.part_id, t.qty, p.unit_cost_cents, t.task_id
  FROM jsonb_to_recordset(v_norm) AS t(part_id uuid, qty integer, task_id uuid)
  JOIN inventory_parts p ON p.id = t.part_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('status', 'created', 'transfer_id', v_id, 'transfer_number', v_number, 'lines', v_rows);
END;
$$;

-- Confirm one line at the pick (warehouse) or receive (truck) stage.
-- SET semantics: calling it again with the same quantity changes nothing (safe to retry).
CREATE OR REPLACE FUNCTION public.confirm_transfer_line(
  p_line_id uuid,
  p_stage text,
  p_quantity integer,
  p_code text DEFAULT NULL,
  p_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  l stock_transfer_lines%ROWTYPE;
  o stock_transfer_orders%ROWTYPE;
  c record;
  cfg record;
  v_code text := left(btrim(COALESCE(p_code, '')), 128);
  v_reason text := NULLIF(left(btrim(COALESCE(p_override_reason, '')), 300), '');
  v_scanned boolean := false;
  v_scanned_part uuid;
  v_can_dispatch boolean;
  v_is_dest_tech boolean := false;
  v_free integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_stage NOT IN ('pick', 'receive') THEN
    RETURN jsonb_build_object('status', 'invalid_stage');
  END IF;

  SELECT * INTO l FROM stock_transfer_lines WHERE id = p_line_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT * INTO o FROM stock_transfer_orders WHERE id = l.transfer_id FOR UPDATE;

  v_can_dispatch := public.truck_ops_can_dispatch();
  SELECT * INTO c FROM public.tech_stock_context();
  IF FOUND AND c.van_id IS NOT NULL AND c.van_id = o.to_location_id THEN v_is_dest_tech := true; END IF;

  IF p_stage = 'pick' THEN
    IF NOT v_can_dispatch THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
    IF o.status <> 'open' THEN RETURN jsonb_build_object('status', 'not_open'); END IF;
    IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity > l.qty_planned THEN
      RETURN jsonb_build_object('status', 'invalid_quantity', 'max', l.qty_planned);
    END IF;
  ELSE
    IF NOT (v_can_dispatch OR v_is_dest_tech) THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
    IF o.status <> 'in_transit' THEN RETURN jsonb_build_object('status', 'not_in_transit'); END IF;
    IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity > l.qty_picked THEN
      RETURN jsonb_build_object('status', 'invalid_quantity', 'max', l.qty_picked);
    END IF;
    IF l.qty_picked = 0 THEN RETURN jsonb_build_object('status', 'not_shipped'); END IF;
  END IF;

  SELECT * INTO cfg FROM public.truck_ops_cfg(v_owner);

  IF v_code <> '' THEN
    v_scanned_part := public.truck_part_by_code(v_owner, v_code);
    IF v_scanned_part IS NULL THEN
      RETURN jsonb_build_object('status', 'unknown_code');
    END IF;
    IF v_scanned_part <> l.part_id THEN
      RETURN jsonb_build_object('status', 'wrong_part',
        'scanned_part', (SELECT p.name FROM inventory_parts p WHERE p.id = v_scanned_part));
    END IF;
    v_scanned := true;
  ELSIF p_quantity > 0 AND cfg.require_scan THEN
    IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
      RETURN jsonb_build_object('status', 'scan_required');
    END IF;
  END IF;

  IF p_stage = 'pick' THEN
    IF p_quantity > 0 THEN
      v_free := public.truck_location_free_qty(o.from_location_id, l.part_id)
                + CASE WHEN l.replenishment_task_id IS NOT NULL THEN
                    COALESCE((SELECT t.quantity FROM replenishment_tasks t WHERE t.id = l.replenishment_task_id AND t.status = 'open'), 0)
                  ELSE l.qty_planned END;
      IF v_free < p_quantity THEN
        RETURN jsonb_build_object('status', 'insufficient_stock', 'available', GREATEST(v_free, 0));
      END IF;
    END IF;
    UPDATE stock_transfer_lines
    SET qty_picked = p_quantity, picked_at = now(), picked_by = auth.uid(),
        pick_scanned = v_scanned, pick_override_reason = CASE WHEN v_scanned THEN NULL ELSE v_reason END
    WHERE id = l.id;
  ELSE
    UPDATE stock_transfer_lines
    SET qty_received = p_quantity, received_at = now(), received_by = auth.uid(),
        receive_scanned = v_scanned, receive_override_reason = CASE WHEN v_scanned THEN NULL ELSE v_reason END
    WHERE id = l.id;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'quantity', p_quantity, 'scanned', v_scanned);
END;
$$;

CREATE OR REPLACE FUNCTION public.ship_stock_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  o stock_transfer_orders%ROWTYPE;
  l record;
  v_unconfirmed integer;
  v_total integer;
  v_bad record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.truck_ops_can_dispatch() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;

  SELECT * INTO o FROM stock_transfer_orders WHERE id = p_transfer_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF o.status <> 'open' THEN RETURN jsonb_build_object('status', 'not_open'); END IF;

  SELECT count(*) FILTER (WHERE picked_at IS NULL), COALESCE(SUM(qty_picked), 0)
  INTO v_unconfirmed, v_total
  FROM stock_transfer_lines WHERE transfer_id = o.id;
  IF v_unconfirmed > 0 THEN
    RETURN jsonb_build_object('status', 'unconfirmed_lines', 'count', v_unconfirmed);
  END IF;
  IF v_total = 0 THEN RETURN jsonb_build_object('status', 'nothing_picked'); END IF;

  -- Validate every line before writing anything.
  FOR v_bad IN
    SELECT p.name, sl.quantity_on_hand - sl.quantity_reserved AS avail, ln.qty_picked
    FROM stock_transfer_lines ln
    JOIN inventory_parts p ON p.id = ln.part_id
    LEFT JOIN inventory_stock_levels sl ON sl.part_id = ln.part_id AND sl.location_id = o.from_location_id
    WHERE ln.transfer_id = o.id AND ln.qty_picked > 0
      AND COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) < ln.qty_picked
    LIMIT 1
  LOOP
    RETURN jsonb_build_object('status', 'insufficient_stock', 'part', v_bad.name, 'available', GREATEST(COALESCE(v_bad.avail, 0), 0));
  END LOOP;

  FOR l IN SELECT * FROM stock_transfer_lines WHERE transfer_id = o.id AND qty_picked > 0 ORDER BY created_at, id LOOP
    INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
    VALUES (v_owner, l.part_id, o.from_location_id, 'transfer_out', -l.qty_picked, l.unit_cost_cents,
            'Transfer ' || o.transfer_number || ' shipped');
  END LOOP;

  UPDATE stock_transfer_orders
  SET status = 'in_transit', shipped_at = now(), shipped_by = auth.uid()
  WHERE id = o.id;

  RETURN jsonb_build_object('status', 'in_transit', 'units', v_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_stock_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  o stock_transfer_orders%ROWTYPE;
  l record;
  c record;
  cfg record;
  v_unconfirmed integer;
  v_short integer;
  v_value bigint;
  v_variance integer := 0;
  v_variance_value bigint := 0;
  v_tech uuid;
  v_sev text;
  v_received integer := 0;
  v_is_tech boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO o FROM stock_transfer_orders WHERE id = p_transfer_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  SELECT * INTO c FROM public.tech_stock_context();
  v_is_tech := FOUND;
  IF NOT (public.truck_ops_can_dispatch() OR (v_is_tech AND c.van_id IS NOT NULL AND c.van_id = o.to_location_id)) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;
  IF o.status <> 'in_transit' THEN RETURN jsonb_build_object('status', 'not_in_transit'); END IF;

  SELECT count(*) INTO v_unconfirmed FROM stock_transfer_lines
  WHERE transfer_id = o.id AND qty_picked > 0 AND received_at IS NULL;
  IF v_unconfirmed > 0 THEN
    RETURN jsonb_build_object('status', 'unconfirmed_lines', 'count', v_unconfirmed);
  END IF;

  SELECT * INTO cfg FROM public.truck_ops_cfg(v_owner);
  SELECT x.assigned_technician_id INTO v_tech FROM inventory_locations x WHERE x.id = o.to_location_id;

  FOR l IN SELECT * FROM stock_transfer_lines WHERE transfer_id = o.id AND qty_picked > 0 ORDER BY created_at, id LOOP
    IF l.qty_received > 0 THEN
      INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
      VALUES (v_owner, l.part_id, o.to_location_id, 'transfer_in', l.qty_received, l.unit_cost_cents,
              'Transfer ' || o.transfer_number || ' received');
      v_received := v_received + l.qty_received;

      IF l.replenishment_task_id IS NOT NULL THEN
        UPDATE replenishment_tasks
        SET status = 'completed', quantity = l.qty_received, completed_at = now(), completed_by = auth.uid()
        WHERE id = l.replenishment_task_id AND status = 'open';
      END IF;
    END IF;

    v_short := l.qty_picked - l.qty_received;
    IF v_short > 0 THEN
      v_value := v_short::bigint * l.unit_cost_cents;
      v_sev := CASE WHEN v_value >= cfg.shrink_min_value_cents * 5 THEN 'critical'
                    WHEN v_value >= cfg.shrink_min_value_cents THEN 'warning'
                    ELSE 'info' END;
      INSERT INTO inventory_variance_events (user_id, kind, severity, location_id, technician_id, part_id, quantity, value_cents, details, dedupe_key)
      VALUES (v_owner, 'transfer_shortage', v_sev, o.to_location_id, v_tech, l.part_id, v_short, v_value,
              jsonb_build_object('transfer_id', o.id, 'transfer_number', o.transfer_number,
                                 'picked', l.qty_picked, 'received', l.qty_received,
                                 'receive_scanned', l.receive_scanned, 'note', l.receive_override_reason,
                                 'occurred_at', now()),
              'transfer:' || l.id::text)
      ON CONFLICT (user_id, dedupe_key) DO NOTHING;
      v_variance := v_variance + 1;
      v_variance_value := v_variance_value + v_value;
    END IF;
  END LOOP;

  UPDATE stock_transfer_orders
  SET status = 'completed', has_variance = (v_variance > 0), received_at = now(), received_by = auth.uid()
  WHERE id = o.id;

  IF v_variance > 0 THEN
    BEGIN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (v_owner, 'system', 'Transfer received short',
              o.transfer_number || ': ' || v_variance || ' line(s) arrived short.',
              '/dashboard/inventory/trucks?tab=variance');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'transfer shortage notification failed: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('status', 'completed', 'received_units', v_received,
                            'short_lines', v_variance, 'short_value_cents', v_variance_value);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_stock_transfer(p_transfer_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  o stock_transfer_orders%ROWTYPE;
  l record;
  v_restored integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.truck_ops_can_dispatch() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;

  SELECT * INTO o FROM stock_transfer_orders WHERE id = p_transfer_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF o.status NOT IN ('open', 'in_transit') THEN RETURN jsonb_build_object('status', 'not_cancellable'); END IF;

  IF o.status = 'in_transit' THEN
    -- Goods already left the source: put them back so nothing disappears from the ledger.
    FOR l IN SELECT * FROM stock_transfer_lines WHERE transfer_id = o.id AND qty_picked > 0 LOOP
      INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
      VALUES (v_owner, l.part_id, o.from_location_id, 'transfer_in', l.qty_picked, l.unit_cost_cents,
              'Transfer ' || o.transfer_number || ' cancelled in transit');
      v_restored := v_restored + l.qty_picked;
    END LOOP;
  END IF;

  UPDATE stock_transfer_orders
  SET status = 'cancelled', cancelled_at = now(),
      cancel_reason = NULLIF(left(btrim(COALESCE(p_reason, '')), 300), '')
  WHERE id = o.id;

  RETURN jsonb_build_object('status', 'cancelled', 'restored_units', v_restored);
END;
$$;

-- One click: forecast -> transfer orders (one per truck + source warehouse, best-stocked warehouse first).
CREATE OR REPLACE FUNCTION public.create_transfers_from_forecast(p_location_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r record;
  v_src uuid;
  v_free integer;
  v_qty integer;
  v_id uuid;
  v_key text;
  v_cache jsonb := '{}'::jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_lines integer := 0;
  v_number text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.truck_ops_can_dispatch() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('truck_forecast_transfers:' || v_owner::text, 0));

  FOR r IN
    SELECT f.* FROM public.truck_forecast_internal(v_owner, NULL) f
    WHERE f.fulfillable_qty > 0 AND (p_location_ids IS NULL OR f.location_id = ANY (p_location_ids))
    ORDER BY f.first_short_at NULLS LAST, f.location_name, f.part_name
  LOOP
    SELECT w.id, public.truck_location_free_qty(w.id, r.part_id)
    INTO v_src, v_free
    FROM inventory_locations w
    WHERE w.user_id = v_owner AND w.active AND w.location_type = 'warehouse'
    ORDER BY public.truck_location_free_qty(w.id, r.part_id) DESC, w.created_at
    LIMIT 1;

    v_qty := LEAST(r.suggested_qty, COALESCE(v_free, 0));
    CONTINUE WHEN v_src IS NULL OR v_qty <= 0;

    v_key := r.location_id::text || ':' || v_src::text;
    IF v_cache ? v_key THEN
      v_id := (v_cache ->> v_key)::uuid;
    ELSE
      v_number := 'TO-' || to_char(now() AT TIME ZONE 'UTC', 'YYMMDD') || '-' ||
                  upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
      INSERT INTO stock_transfer_orders (user_id, transfer_number, from_location_id, to_location_id, source, notes, created_by)
      VALUES (v_owner, v_number, v_src, r.location_id, 'forecast', 'Created from the restock forecast', auth.uid())
      RETURNING id INTO v_id;
      v_cache := v_cache || jsonb_build_object(v_key, v_id);
      v_ids := v_ids || v_id;
    END IF;

    INSERT INTO stock_transfer_lines (user_id, transfer_id, part_id, qty_planned, unit_cost_cents)
    VALUES (v_owner, v_id, r.part_id, v_qty, COALESCE(r.unit_cost_cents, 0))
    ON CONFLICT (transfer_id, part_id) DO NOTHING;
    v_lines := v_lines + 1;
  END LOOP;

  RETURN jsonb_build_object('status', 'ok', 'transfers', COALESCE(cardinality(v_ids), 0), 'lines', v_lines,
                            'transfer_ids', to_jsonb(v_ids));
END;
$$;

-- =============================================================
-- 6. VAN AUDITS (scheduled blind counts on top of the cycle-count engine)
-- =============================================================

CREATE OR REPLACE VIEW van_audit_status
WITH (security_invoker = true) AS
SELECT
  l.id AS location_id,
  l.user_id,
  l.name AS location_name,
  l.assigned_technician_id AS technician_id,
  tm.member_name AS technician_name,
  la.approved_at AS last_audit_at,
  la.accuracy_pct AS last_accuracy_pct,
  oc.id AS open_count_id,
  cfg.interval_days,
  (COALESCE(la.approved_at, l.created_at) + make_interval(days => cfg.interval_days)) AS due_at,
  GREATEST(floor(extract(epoch FROM (now() - (COALESCE(la.approved_at, l.created_at) + make_interval(days => cfg.interval_days)))) / 86400), 0)::integer AS days_overdue,
  CASE
    WHEN oc.id IS NOT NULL THEN 'in_progress'
    WHEN now() > COALESCE(la.approved_at, l.created_at) + make_interval(days => cfg.interval_days) THEN 'overdue'
    WHEN now() > COALESCE(la.approved_at, l.created_at) + make_interval(days => cfg.interval_days) - interval '2 days' THEN 'due_soon'
    ELSE 'ok'
  END AS audit_status
FROM inventory_locations l
LEFT JOIN team_members tm ON tm.id = l.assigned_technician_id
LEFT JOIN truck_ops_settings s ON s.user_id = l.user_id
CROSS JOIN LATERAL (SELECT COALESCE(s.audit_interval_days, 14) AS interval_days) cfg
LEFT JOIN LATERAL (
  SELECT c.approved_at, c.accuracy_pct
  FROM inventory_counts c
  WHERE c.location_id = l.id AND c.status = 'approved'
  ORDER BY c.approved_at DESC NULLS LAST
  LIMIT 1
) la ON true
LEFT JOIN LATERAL (
  SELECT c.id FROM inventory_counts c
  WHERE c.location_id = l.id AND c.status IN ('in_progress', 'pending_approval')
  ORDER BY c.created_at DESC LIMIT 1
) oc ON true
WHERE l.active AND l.location_type = 'van';

GRANT SELECT ON van_audit_status TO authenticated;

-- Start a blind audit of a van. Technicians may audit only their own truck.
-- The sheet covers every part with a par level or any stock on the truck.
CREATE OR REPLACE FUNCTION public.start_van_audit(p_location_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c record;
  v_is_tech boolean;
  v_loc uuid := p_location_id;
  v_name text;
  v_open uuid;
  v_ids uuid[];
  v_res jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.tech_stock_context();
  v_is_tech := FOUND;
  IF v_loc IS NULL THEN
    IF NOT v_is_tech OR c.van_id IS NULL THEN RETURN jsonb_build_object('status', 'no_truck'); END IF;
    v_loc := c.van_id;
  ELSIF NOT public.truck_ops_can_dispatch() AND NOT (v_is_tech AND c.van_id IS NOT NULL AND c.van_id = v_loc) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT l.name INTO v_name FROM inventory_locations l
  WHERE l.id = v_loc AND l.user_id = v_owner AND l.active AND l.location_type = 'van';
  IF v_name IS NULL THEN RETURN jsonb_build_object('status', 'invalid_location'); END IF;

  SELECT x.id INTO v_open FROM inventory_counts x
  WHERE x.location_id = v_loc AND x.user_id = v_owner AND x.status IN ('in_progress', 'pending_approval')
  ORDER BY x.created_at DESC LIMIT 1;
  IF v_open IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_open', 'count_id', v_open);
  END IF;

  SELECT COALESCE(array_agg(q.part_id), ARRAY[]::uuid[]) INTO v_ids
  FROM (
    SELECT p.id AS part_id
    FROM inventory_parts p
    LEFT JOIN inventory_par_levels pl ON pl.part_id = p.id AND pl.location_id = v_loc
    LEFT JOIN inventory_stock_levels sl ON sl.part_id = p.id AND sl.location_id = v_loc
    WHERE p.user_id = v_owner AND p.active AND (pl.id IS NOT NULL OR COALESCE(sl.quantity_on_hand, 0) <> 0)
    ORDER BY (COALESCE(sl.quantity_on_hand, 0)::bigint * p.unit_cost_cents) DESC, p.name
    LIMIT 500
  ) q;
  IF cardinality(v_ids) = 0 THEN RETURN jsonb_build_object('status', 'empty_van'); END IF;

  v_res := public.start_inventory_count(
    v_loc, left('Van audit - ' || v_name || ' - ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 120),
    'cycle', 'selected', NULL, v_ids, NULL, true, 'Scheduled van audit (blind count)');

  RETURN jsonb_build_object('status', 'started', 'count_id', v_res ->> 'count_id',
                            'line_count', (v_res ->> 'line_count')::integer);
END;
$$;

-- =============================================================
-- 7. SHRINKAGE / VARIANCE DETECTION
-- =============================================================

CREATE OR REPLACE FUNCTION public.detect_inventory_variance(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cfg record;
  v_rows integer;
  v_total integer := 0;
BEGIN
  SELECT * INTO cfg FROM public.truck_ops_cfg(p_owner);

  -- a) Physical counts approved in the last 30 days: every non-zero adjustment is a finding.
  INSERT INTO inventory_variance_events
    (user_id, kind, severity, location_id, technician_id, part_id, quantity, value_cents, details, dedupe_key)
  SELECT p_owner,
    CASE WHEN cl.applied_delta < 0 THEN 'count_shortage' ELSE 'count_overage' END,
    CASE
      WHEN abs(cl.applied_delta)::bigint * cl.unit_cost_cents >= cfg.shrink_min_value_cents::bigint * 5
        THEN CASE WHEN cl.applied_delta < 0 THEN 'critical' ELSE 'warning' END
      WHEN abs(cl.applied_delta)::bigint * cl.unit_cost_cents >= cfg.shrink_min_value_cents
        THEN CASE WHEN cl.applied_delta < 0 THEN 'warning' ELSE 'info' END
      ELSE 'info'
    END,
    c.location_id, loc.assigned_technician_id, cl.part_id, abs(cl.applied_delta),
    abs(cl.applied_delta)::bigint * cl.unit_cost_cents,
    jsonb_build_object('count_id', c.id, 'count_number', c.count_number, 'expected', cl.expected_qty,
                       'counted', cl.counted_qty, 'occurred_at', c.approved_at),
    'count:' || cl.id::text
  FROM inventory_count_lines cl
  JOIN inventory_counts c ON c.id = cl.count_id
  JOIN inventory_locations loc ON loc.id = c.location_id
  WHERE c.user_id = p_owner AND c.status = 'approved' AND c.approved_at >= now() - interval '30 days'
    AND COALESCE(cl.applied_delta, 0) <> 0
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  -- b) Trucks showing negative stock (usage recorded that the ledger never delivered).
  INSERT INTO inventory_variance_events
    (user_id, kind, severity, location_id, technician_id, part_id, quantity, value_cents, details, dedupe_key)
  SELECT p_owner, 'negative_stock', 'warning', sl.location_id, loc.assigned_technician_id, sl.part_id,
         -sl.quantity_on_hand, (-sl.quantity_on_hand)::bigint * p.unit_cost_cents,
         jsonb_build_object('on_hand', sl.quantity_on_hand, 'occurred_at', now()),
         'neg:' || sl.id::text || ':' || to_char(now(), 'IYYY-IW')
  FROM inventory_stock_levels sl
  JOIN inventory_locations loc ON loc.id = sl.location_id AND loc.active AND loc.location_type = 'van'
  JOIN inventory_parts p ON p.id = sl.part_id
  WHERE sl.user_id = p_owner AND sl.quantity_on_hand < 0
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  -- c) A large share of a truck's recent usage is not tied to any job.
  INSERT INTO inventory_variance_events
    (user_id, kind, severity, location_id, technician_id, quantity, value_cents, details, dedupe_key)
  SELECT p_owner, 'unassigned_usage',
         CASE WHEN u.nojob_v >= cfg.shrink_min_value_cents::bigint * 5 THEN 'critical' ELSE 'warning' END,
         u.location_id, loc.assigned_technician_id, u.nojob_units, u.nojob_v,
         jsonb_build_object('total_usage_cents', u.total_v, 'unassigned_cents', u.nojob_v,
                            'share_pct', round(100.0 * u.nojob_v / u.total_v, 1), 'window_days', 14,
                            'occurred_at', now()),
         'unjob:' || u.location_id::text || ':' || to_char(now(), 'IYYY-IW')
  FROM (
    SELECT t.location_id,
      SUM(-t.quantity_delta::bigint * COALESCE(t.unit_cost_cents, p.unit_cost_cents)) AS total_v,
      SUM(CASE WHEN t.job_id IS NULL THEN -t.quantity_delta::bigint * COALESCE(t.unit_cost_cents, p.unit_cost_cents) ELSE 0 END) AS nojob_v,
      SUM(CASE WHEN t.job_id IS NULL THEN -t.quantity_delta ELSE 0 END)::integer AS nojob_units
    FROM inventory_transactions t
    JOIN inventory_parts p ON p.id = t.part_id
    JOIN inventory_locations l2 ON l2.id = t.location_id AND l2.location_type = 'van'
    WHERE t.user_id = p_owner AND t.transaction_type = 'usage' AND t.created_at >= now() - interval '14 days'
    GROUP BY t.location_id
  ) u
  JOIN inventory_locations loc ON loc.id = u.location_id AND loc.active
  WHERE u.total_v > 0 AND u.nojob_v >= cfg.shrink_min_value_cents AND u.nojob_v * 100 >= u.total_v * 40
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  -- d) More parts used on a completed job than the job required.
  INSERT INTO inventory_variance_events
    (user_id, kind, severity, location_id, technician_id, part_id, job_id, quantity, value_cents, details, dedupe_key)
  SELECT p_owner, 'overuse_vs_job', 'warning', u.loc, j.assigned_technician_id, u.part_id, u.job_id,
         (u.q - jpr.quantity_required), (u.q - jpr.quantity_required)::bigint * p.unit_cost_cents,
         jsonb_build_object('required', jpr.quantity_required, 'used', u.q, 'occurred_at', now()),
         'overuse:' || u.job_id::text || ':' || u.part_id::text
  FROM (
    SELECT t.job_id, t.part_id, GREATEST(-SUM(t.quantity_delta), 0)::integer AS q,
           (array_agg(t.location_id ORDER BY t.created_at DESC))[1] AS loc
    FROM inventory_transactions t
    WHERE t.user_id = p_owner AND t.transaction_type IN ('usage', 'return') AND t.job_id IS NOT NULL
      AND t.created_at >= now() - interval '14 days'
    GROUP BY t.job_id, t.part_id
  ) u
  JOIN job_parts_required jpr ON jpr.job_id = u.job_id AND jpr.part_id = u.part_id
  JOIN jobs j ON j.id = u.job_id AND j.job_status = 'completed'
  JOIN inventory_parts p ON p.id = u.part_id
  WHERE u.q > jpr.quantity_required
    AND (u.q - jpr.quantity_required)::bigint * p.unit_cost_cents >= cfg.shrink_min_value_cents
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  -- e) Shrink pattern: a truck loses far more than its peers (30-day window).
  INSERT INTO inventory_variance_events
    (user_id, kind, severity, location_id, technician_id, value_cents, details, dedupe_key)
  SELECT p_owner, 'shrink_pattern',
         CASE WHEN r.rate >= cfg.shrink_alert_pct * 3 THEN 'critical' ELSE 'warning' END,
         r.loc_id, r.tech, r.shrink::bigint,
         jsonb_build_object('rate_pct', round(r.rate::numeric, 1), 'fleet_median_pct', round(m.med::numeric, 1),
                            'shrink_cents', r.shrink, 'usage_cents', r.cons, 'window_days', 30,
                            'occurred_at', now()),
         'pattern:' || r.loc_id::text || ':' || to_char(now(), 'IYYY-IW')
  FROM (
    SELECT loc.id AS loc_id, loc.assigned_technician_id AS tech,
           COALESCE(u.v, 0)::bigint AS cons, COALESCE(s.v, 0)::bigint AS shrink,
           CASE WHEN COALESCE(u.v, 0) + COALESCE(s.v, 0) > 0
                THEN 100.0 * COALESCE(s.v, 0) / (COALESCE(u.v, 0) + COALESCE(s.v, 0)) ELSE 0 END AS rate
    FROM inventory_locations loc
    LEFT JOIN (
      SELECT t.location_id, SUM(-t.quantity_delta::bigint * COALESCE(t.unit_cost_cents, p.unit_cost_cents)) AS v
      FROM inventory_transactions t JOIN inventory_parts p ON p.id = t.part_id
      WHERE t.user_id = p_owner AND t.transaction_type = 'usage' AND t.created_at >= now() - interval '30 days'
      GROUP BY t.location_id
    ) u ON u.location_id = loc.id
    LEFT JOIN (
      SELECT e.location_id, SUM(e.value_cents) AS v
      FROM inventory_variance_events e
      WHERE e.user_id = p_owner AND e.kind IN ('count_shortage', 'transfer_shortage') AND e.status <> 'dismissed'
        AND COALESCE((e.details ->> 'occurred_at')::timestamptz, e.detected_at) >= now() - interval '30 days'
      GROUP BY e.location_id
    ) s ON s.location_id = loc.id
    WHERE loc.user_id = p_owner AND loc.active AND loc.location_type = 'van'
  ) r
  CROSS JOIN (
    SELECT COUNT(*) FILTER (WHERE x.cons + x.shrink > 0) AS n,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY x.rate) FILTER (WHERE x.cons + x.shrink > 0), 0) AS med
    FROM (
      SELECT COALESCE(u2.v, 0) AS cons, COALESCE(s2.v, 0) AS shrink,
             CASE WHEN COALESCE(u2.v, 0) + COALESCE(s2.v, 0) > 0
                  THEN 100.0 * COALESCE(s2.v, 0) / (COALESCE(u2.v, 0) + COALESCE(s2.v, 0)) ELSE 0 END AS rate
      FROM inventory_locations l3
      LEFT JOIN (
        SELECT t.location_id, SUM(-t.quantity_delta::bigint * COALESCE(t.unit_cost_cents, p.unit_cost_cents)) AS v
        FROM inventory_transactions t JOIN inventory_parts p ON p.id = t.part_id
        WHERE t.user_id = p_owner AND t.transaction_type = 'usage' AND t.created_at >= now() - interval '30 days'
        GROUP BY t.location_id
      ) u2 ON u2.location_id = l3.id
      LEFT JOIN (
        SELECT e.location_id, SUM(e.value_cents) AS v
        FROM inventory_variance_events e
        WHERE e.user_id = p_owner AND e.kind IN ('count_shortage', 'transfer_shortage') AND e.status <> 'dismissed'
          AND COALESCE((e.details ->> 'occurred_at')::timestamptz, e.detected_at) >= now() - interval '30 days'
        GROUP BY e.location_id
      ) s2 ON s2.location_id = l3.id
      WHERE l3.user_id = p_owner AND l3.active AND l3.location_type = 'van'
    ) x
  ) m
  WHERE r.shrink >= cfg.shrink_min_value_cents AND r.rate >= cfg.shrink_alert_pct
    AND (m.n < 3 OR r.rate >= 2 * m.med)
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  RETURN jsonb_build_object('new_events', v_total);
END;
$$;

-- =============================================================
-- 8. ALERT SCAN (low stock, stock-out, jobs at risk, overdue audits, variance) -> dispatch
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_truck_ops_scan(p_owner uuid, p_notify boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cfg record;
  r record;
  v_low integer := 0;
  v_out integer := 0;
  v_risk integer := 0;
  v_audit integer := 0;
  v_resolved integer := 0;
  v_var jsonb;
  v_n_out integer := 0;
  v_n_low integer := 0;
  v_n_risk integer := 0;
  v_n_audit integer := 0;
  v_var_new integer := 0;
  v_parts text[];
  v_inb integer;
BEGIN
  SELECT * INTO cfg FROM public.truck_ops_cfg(p_owner);

  IF cfg.low_stock_alerts_enabled THEN
    FOR r IN
      SELECT pl.location_id, loc.name AS loc_name, loc.assigned_technician_id AS tech, pl.part_id, p.name AS part_name,
             COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) AS avail, pl.min_quantity
      FROM inventory_par_levels pl
      JOIN inventory_locations loc ON loc.id = pl.location_id AND loc.active AND loc.location_type = 'van'
      JOIN inventory_parts p ON p.id = pl.part_id AND p.active
      LEFT JOIN inventory_stock_levels sl ON sl.part_id = pl.part_id AND sl.location_id = pl.location_id
      WHERE pl.user_id = p_owner
        AND COALESCE(sl.quantity_on_hand - sl.quantity_reserved, 0) <= pl.min_quantity
    LOOP
      v_inb := public.truck_inbound_qty(r.location_id, r.part_id);
      PERFORM public.truck_alert_upsert(
        p_owner,
        CASE WHEN r.avail <= 0 THEN 'stockout' ELSE 'low_stock' END,
        CASE WHEN r.avail <= 0 THEN 'critical' ELSE 'warning' END,
        r.location_id, r.tech, r.part_id, NULL,
        r.loc_name || ': ' || r.part_name || ' ' ||
          CASE WHEN r.avail <= 0 THEN 'is out of stock' ELSE 'is low (' || r.avail || ' left, min ' || r.min_quantity || ')' END ||
          CASE WHEN v_inb > 0 THEN ' - ' || v_inb || ' already on the way' ELSE '' END,
        'low:' || r.location_id::text || ':' || r.part_id::text);
      IF r.avail <= 0 THEN v_out := v_out + 1; ELSE v_low := v_low + 1; END IF;
    END LOOP;
  END IF;

  -- Jobs in the next 48h whose parts the truck will not have.
  FOR r IN
    SELECT f.* FROM public.truck_forecast_internal(p_owner, NULL) f
    WHERE f.reason = 'job_demand' AND f.first_short_job_id IS NOT NULL
      AND f.first_short_at <= now() + interval '48 hours'
  LOOP
    PERFORM public.truck_alert_upsert(
      p_owner, 'job_at_risk',
      CASE WHEN r.first_short_at <= now() + interval '24 hours' THEN 'critical' ELSE 'warning' END,
      r.location_id, r.technician_id, r.part_id, r.first_short_job_id,
      r.location_name || ' will run short of ' || r.part_name || ' for a job on ' ||
        to_char(r.first_short_at AT TIME ZONE 'UTC', 'Mon DD HH24:MI') || ' UTC (has ' || r.available || ', needs ~' || r.forecast_demand || ')',
      'risk:' || r.first_short_job_id::text || ':' || r.part_id::text);
    v_risk := v_risk + 1;
  END LOOP;

  FOR r IN
    SELECT a.location_id, a.location_name, a.technician_id, a.days_overdue, a.last_audit_at
    FROM van_audit_status a
    WHERE a.user_id = p_owner AND a.audit_status = 'overdue'
  LOOP
    PERFORM public.truck_alert_upsert(
      p_owner, 'audit_overdue', 'warning', r.location_id, r.technician_id, NULL, NULL,
      r.location_name || ' van audit is ' || r.days_overdue || ' day(s) overdue' ||
        CASE WHEN r.last_audit_at IS NULL THEN ' (never audited)' ELSE '' END,
      'audit:' || r.location_id::text);
    v_audit := v_audit + 1;
  END LOOP;

  -- Conditions that cleared since the last scan.
  UPDATE truck_stock_alerts a
  SET status = 'resolved', resolved_at = now()
  WHERE a.user_id = p_owner AND a.status IN ('open', 'acknowledged') AND a.last_seen_at < now();
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  v_var := public.detect_inventory_variance(p_owner);

  IF p_notify THEN
    WITH due AS (
      UPDATE truck_stock_alerts a
      SET notified_at = now()
      WHERE a.user_id = p_owner AND a.status = 'open' AND a.severity IN ('warning', 'critical')
        AND (a.notified_at IS NULL
             OR (a.severity = 'critical' AND a.notified_at < now() - make_interval(hours => cfg.alert_cooldown_hours)))
      RETURNING a.alert_type
    )
    SELECT count(*) FILTER (WHERE alert_type = 'stockout'), count(*) FILTER (WHERE alert_type = 'low_stock'),
           count(*) FILTER (WHERE alert_type = 'job_at_risk'), count(*) FILTER (WHERE alert_type = 'audit_overdue')
    INTO v_n_out, v_n_low, v_n_risk, v_n_audit FROM due;

    v_parts := ARRAY[]::text[];
    IF v_n_out > 0 THEN v_parts := v_parts || (v_n_out || ' stock-out(s)'); END IF;
    IF v_n_low > 0 THEN v_parts := v_parts || (v_n_low || ' low-stock'); END IF;
    IF v_n_risk > 0 THEN v_parts := v_parts || (v_n_risk || ' job part shortage(s)'); END IF;
    IF v_n_audit > 0 THEN v_parts := v_parts || (v_n_audit || ' overdue van audit(s)'); END IF;
    IF cardinality(v_parts) > 0 THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (p_owner, 'system', 'Truck stock needs attention', array_to_string(v_parts, ', '),
              '/dashboard/inventory/trucks?tab=alerts');
    END IF;

    SELECT count(*) INTO v_var_new FROM inventory_variance_events e
    WHERE e.user_id = p_owner AND e.detected_at = now() AND e.severity IN ('warning', 'critical');
    IF v_var_new > 0 THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (p_owner, 'system', 'Inventory variance detected',
              v_var_new || ' new shrinkage / variance flag(s) to review.',
              '/dashboard/inventory/trucks?tab=variance');
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'stockouts', v_out, 'low_stock', v_low, 'jobs_at_risk', v_risk,
                            'audits_overdue', v_audit, 'resolved', v_resolved, 'variance_new', (v_var ->> 'new_events')::integer);
END;
$$;

CREATE OR REPLACE FUNCTION public.run_my_truck_ops_scan()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.truck_ops_can_dispatch() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
  RETURN public.run_truck_ops_scan(v_owner, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.run_truck_ops_scan_all()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT DISTINCT l.user_id FROM inventory_locations l WHERE l.location_type = 'van' AND l.active LOOP
    BEGIN
      PERFORM public.run_truck_ops_scan(r.user_id, true);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_truck_ops_scan failed for %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
  RETURN n;
END;
$$;

-- Immediate alert the moment a truck's stock crosses its minimum (no need to wait for the hourly scan).
CREATE OR REPLACE FUNCTION public.trg_truck_low_stock_alert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_new integer;
  v_old integer;
  v_min integer;
  v_loc_name text;
  v_tech uuid;
  v_part_name text;
  v_enabled boolean;
  v_created boolean;
  v_key text;
BEGIN
  BEGIN
    v_new := NEW.quantity_on_hand - NEW.quantity_reserved;
    IF TG_OP = 'UPDATE' THEN
      v_old := OLD.quantity_on_hand - OLD.quantity_reserved;
      IF v_new = v_old THEN RETURN NEW; END IF;
    END IF;

    SELECT pl.min_quantity, loc.name, loc.assigned_technician_id, p.name
    INTO v_min, v_loc_name, v_tech, v_part_name
    FROM inventory_par_levels pl
    JOIN inventory_locations loc ON loc.id = pl.location_id AND loc.active AND loc.location_type = 'van'
    JOIN inventory_parts p ON p.id = pl.part_id
    WHERE pl.part_id = NEW.part_id AND pl.location_id = NEW.location_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    v_key := 'low:' || NEW.location_id::text || ':' || NEW.part_id::text;

    IF v_new > v_min THEN
      IF TG_OP = 'UPDATE' AND v_old <= v_min THEN
        UPDATE truck_stock_alerts SET status = 'resolved', resolved_at = now()
        WHERE user_id = NEW.user_id AND dedupe_key = v_key AND status IN ('open', 'acknowledged');
      END IF;
      RETURN NEW;
    END IF;

    -- Already below the minimum before this change: only speak up again when it hits zero.
    IF TG_OP = 'UPDATE' AND v_old <= v_min AND NOT (v_old > 0 AND v_new <= 0) THEN RETURN NEW; END IF;

    SELECT low_stock_alerts_enabled INTO v_enabled FROM public.truck_ops_cfg(NEW.user_id);
    IF NOT COALESCE(v_enabled, true) THEN RETURN NEW; END IF;

    v_created := public.truck_alert_upsert(
      NEW.user_id,
      CASE WHEN v_new <= 0 THEN 'stockout' ELSE 'low_stock' END,
      CASE WHEN v_new <= 0 THEN 'critical' ELSE 'warning' END,
      NEW.location_id, v_tech, NEW.part_id, NULL,
      v_loc_name || ': ' || v_part_name || ' ' ||
        CASE WHEN v_new <= 0 THEN 'is out of stock' ELSE 'is low (' || v_new || ' left, min ' || v_min || ')' END,
      v_key);

    IF v_created OR (v_new <= 0 AND TG_OP = 'UPDATE') THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (NEW.user_id, 'system',
              CASE WHEN v_new <= 0 THEN 'Truck out of stock' ELSE 'Truck stock low' END,
              v_loc_name || ': ' || v_part_name || ' - ' || GREATEST(v_new, 0) || ' left (min ' || v_min || ').',
              '/dashboard/inventory/trucks?tab=alerts');
      UPDATE truck_stock_alerts SET notified_at = now()
      WHERE user_id = NEW.user_id AND dedupe_key = v_key AND status IN ('open', 'acknowledged');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trg_truck_low_stock_alert failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_truck_low_stock_alert ON inventory_stock_levels;
CREATE TRIGGER trg_truck_low_stock_alert
  AFTER INSERT OR UPDATE OF quantity_on_hand, quantity_reserved ON inventory_stock_levels
  FOR EACH ROW EXECUTE FUNCTION public.trg_truck_low_stock_alert();

-- =============================================================
-- 9. MANAGEMENT RPCs + SUMMARY
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_truck_alert_status(p_alert_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.truck_ops_can_dispatch() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
  IF p_status NOT IN ('acknowledged', 'resolved') THEN RETURN jsonb_build_object('status', 'invalid_status'); END IF;
  UPDATE truck_stock_alerts
  SET status = p_status, resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END
  WHERE id = p_alert_id AND user_id = v_owner AND status IN ('open', 'acknowledged');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('status', CASE WHEN v_rows = 1 THEN 'ok' ELSE 'not_found' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_variance_event_status(p_event_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT public.inventory_can_manage() THEN RETURN jsonb_build_object('status', 'forbidden'); END IF;
  IF p_status NOT IN ('acknowledged', 'resolved', 'dismissed') THEN RETURN jsonb_build_object('status', 'invalid_status'); END IF;
  UPDATE inventory_variance_events
  SET status = p_status,
      resolved_at = CASE WHEN p_status IN ('resolved', 'dismissed') THEN now() ELSE NULL END,
      resolved_by = CASE WHEN p_status IN ('resolved', 'dismissed') THEN auth.uid() ELSE NULL END,
      resolution_note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), '')
  WHERE id = p_event_id AND user_id = v_owner;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('status', CASE WHEN v_rows = 1 THEN 'ok' ELSE 'not_found' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.truck_variance_summary(p_days integer DEFAULT 30)
RETURNS TABLE (
  location_id uuid, location_name text, technician_id uuid, technician_name text,
  usage_value_cents bigint, shrink_value_cents bigint, shrink_rate_pct numeric,
  open_events integer, critical_events integer, last_audit_at timestamptz, last_accuracy_pct numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 7), 180);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT loc.id, loc.name, loc.assigned_technician_id, tm.member_name,
         COALESCE(u.v, 0)::bigint, COALESCE(s.v, 0)::bigint,
         CASE WHEN COALESCE(u.v, 0) + COALESCE(s.v, 0) > 0
              THEN round(100.0 * COALESCE(s.v, 0) / (COALESCE(u.v, 0) + COALESCE(s.v, 0)), 1) ELSE 0::numeric END,
         COALESCE(o.n, 0)::integer, COALESCE(o.crit, 0)::integer,
         a.last_audit_at, a.last_accuracy_pct
  FROM inventory_locations loc
  LEFT JOIN team_members tm ON tm.id = loc.assigned_technician_id
  LEFT JOIN (
    SELECT t.location_id, SUM(-t.quantity_delta::bigint * COALESCE(t.unit_cost_cents, p.unit_cost_cents)) AS v
    FROM inventory_transactions t JOIN inventory_parts p ON p.id = t.part_id
    WHERE t.user_id = v_owner AND t.transaction_type = 'usage' AND t.created_at >= now() - make_interval(days => v_days)
    GROUP BY t.location_id
  ) u ON u.location_id = loc.id
  LEFT JOIN (
    SELECT e.location_id, SUM(e.value_cents) AS v
    FROM inventory_variance_events e
    WHERE e.user_id = v_owner AND e.kind IN ('count_shortage', 'transfer_shortage') AND e.status <> 'dismissed'
      AND COALESCE((e.details ->> 'occurred_at')::timestamptz, e.detected_at) >= now() - make_interval(days => v_days)
    GROUP BY e.location_id
  ) s ON s.location_id = loc.id
  LEFT JOIN (
    SELECT e.location_id, count(*) AS n, count(*) FILTER (WHERE e.severity = 'critical') AS crit
    FROM inventory_variance_events e
    WHERE e.user_id = v_owner AND e.status IN ('open', 'acknowledged')
    GROUP BY e.location_id
  ) o ON o.location_id = loc.id
  LEFT JOIN van_audit_status a ON a.location_id = loc.id
  WHERE loc.user_id = v_owner AND loc.active AND loc.location_type = 'van'
  ORDER BY COALESCE(s.v, 0) DESC, loc.name;
END;
$$;

-- =============================================================
-- 10. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION
  public.truck_ops_cfg(uuid), public.truck_location_free_qty(uuid, uuid), public.truck_inbound_qty(uuid, uuid),
  public.truck_alert_upsert(uuid, text, text, uuid, uuid, uuid, uuid, text, text),
  public.truck_forecast_internal(uuid, uuid), public.truck_part_by_code(uuid, text), public.truck_norm_code(text),
  public.detect_inventory_variance(uuid), public.run_truck_ops_scan(uuid, boolean),
  public.run_truck_ops_scan_all(), public.trg_truck_low_stock_alert(), public.truck_ops_can_dispatch()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.truck_ops_cfg(uuid), public.truck_forecast_internal(uuid, uuid), public.detect_inventory_variance(uuid),
  public.run_truck_ops_scan(uuid, boolean), public.run_truck_ops_scan_all()
  TO service_role;

REVOKE ALL ON FUNCTION
  public.truck_restock_forecast(uuid), public.get_my_van(),
  public.create_stock_transfer(uuid, uuid, jsonb, text, text, uuid),
  public.confirm_transfer_line(uuid, text, integer, text, text),
  public.ship_stock_transfer(uuid), public.complete_stock_transfer(uuid), public.cancel_stock_transfer(uuid, text),
  public.create_transfers_from_forecast(uuid[]), public.start_van_audit(uuid),
  public.run_my_truck_ops_scan(), public.set_truck_alert_status(uuid, text),
  public.set_variance_event_status(uuid, text, text), public.truck_variance_summary(integer)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.truck_restock_forecast(uuid), public.get_my_van(),
  public.create_stock_transfer(uuid, uuid, jsonb, text, text, uuid),
  public.confirm_transfer_line(uuid, text, integer, text, text),
  public.ship_stock_transfer(uuid), public.complete_stock_transfer(uuid), public.cancel_stock_transfer(uuid, text),
  public.create_transfers_from_forecast(uuid[]), public.start_van_audit(uuid),
  public.run_my_truck_ops_scan(), public.set_truck_alert_status(uuid, text),
  public.set_variance_event_status(uuid, text, text), public.truck_variance_summary(integer)
  TO authenticated;

-- =============================================================
-- 11. HOURLY SCHEDULE (only when pg_cron exists)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-truck-ops-scan');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    BEGIN
      PERFORM cron.schedule('vireek-truck-ops-scan', '40 * * * *', 'select public.run_truck_ops_scan_all()');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'truck ops cron not scheduled: %', SQLERRM;
    END;
  END IF;
END $$;
