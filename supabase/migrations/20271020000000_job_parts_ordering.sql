/*
  # Job parts ordering — supplier catalogs, cart, purchase orders, delivery tracking

  Builds ON TOP of the existing truck-stock / replenishment system
  (20261110000000_truck_stock_replenishment.sql) and the extended job workflow
  (20270610000000_job_workflow_statuses.sql). Nothing is dropped, renamed or rewritten:
  every existing function (create_purchase_order, receive_purchase_order,
  set_job_workflow_status …) keeps working untouched.

  ## What this adds
  1. supplier_catalog_items      searchable per-supplier catalog (price, stock, lead time, pack rules)
  2. supplier_price_history      append-only price trail (powers "price changed" badges)
  3. supplier_price_imports      one row per CSV / API import run (counts + first 100 errors)
  4. supplier_feed_keys          per-supplier API keys (hashed) so a supplier can push prices / ETAs
  5. parts_order_cart            staging area: "add to job" / "add to truck" before ordering
  6. purchase_order_line_jobs    which job(s) a PO line was ordered for
  7. purchase_order_events       delivery / status timeline per PO
  8. purchase_orders             + carrier, tracking, shipment_status, original ETA, delivery timestamps
  9. RPCs   search_supplier_catalog · add_to_parts_cart · set_parts_cart_quantity · remove_from_parts_cart
            create_parts_orders_from_cart · update_po_shipment · import_supplier_prices
            create_supplier_feed_key · revoke_supplier_feed_key · job_parts_ready
 10. Triggers  receiving a PO line  -> auto-resume the job from `waiting_on_parts`
               PO ETA / status change -> hold ETA + timeline events
 11. sweep_late_po_deliveries   flags overdue POs (+ hourly pg_cron when available)
 12. Views  job_parts_orders · po_delivery_tracking   (security_invoker)

  ## Design decisions
  - Suppliers are the existing `inventory_vendors` (the same table create_purchase_order uses).
  - "Arrived" means RECEIVED INTO STOCK (existing receive_purchase_order flow), never merely
    "carrier says delivered" — a wrong count must not silently release a job. A carrier/supplier
    "delivered" update only prompts the team to receive it.
  - Price imports never touch inventory_parts.unit_cost_cents (that would silently re-value stock);
    receipts keep recording the real cost paid.
  - Job automation hooks never block receiving: failures are logged as a WARNING + timeline event.
  - Written to be schema-drift tolerant: only columns present in every known variant of
    inventory_vendors / purchase_orders are read (see "default_lead_time_days" vs "lead_time_days").

  ## Rollback
  Safe to leave in place. To disable the automation only:
    DROP TRIGGER trg_po_line_received_reconcile ON purchase_order_lines;
    DROP TRIGGER trg_po_track_changes ON purchase_orders;
*/

-- =============================================================
-- 0. PREFLIGHT — fail early with a readable message
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.purchase_order_lines') IS NULL
     OR to_regclass('public.inventory_vendors') IS NULL
     OR to_regclass('public.job_parts_required') IS NULL
     OR to_regclass('public.job_holds') IS NULL THEN
    RAISE EXCEPTION 'job_parts_ordering: prerequisite tables missing. Apply 20261110000000_truck_stock_replenishment.sql and 20270610000000_job_workflow_statuses.sql first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines' AND column_name = 'purchase_order_id'
  ) THEN
    RAISE EXCEPTION 'job_parts_ordering: purchase_order_lines has an unexpected shape (no purchase_order_id). This migration targets the truck-stock purchase order schema.';
  END IF;
  IF to_regprocedure('public.set_job_workflow_status(uuid,text,text,text,timestamptz)') IS NULL
     OR to_regprocedure('public.inventory_can_manage()') IS NULL
     OR to_regprocedure('public.new_po_number()') IS NULL THEN
    RAISE EXCEPTION 'job_parts_ordering: required helper functions are missing (set_job_workflow_status / inventory_can_manage / new_po_number).';
  END IF;
END $$;

-- =============================================================
-- 1. PURCHASE ORDER COLUMNS (additive)
-- =============================================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS carrier text CHECK (carrier IS NULL OR char_length(carrier) <= 80),
  ADD COLUMN IF NOT EXISTS tracking_number text CHECK (tracking_number IS NULL OR char_length(tracking_number) <= 120),
  ADD COLUMN IF NOT EXISTS tracking_url text CHECK (tracking_url IS NULL OR (char_length(tracking_url) <= 500 AND tracking_url ~* '^https?://')),
  ADD COLUMN IF NOT EXISTS shipment_status text NOT NULL DEFAULT 'not_shipped'
    CHECK (shipment_status IN ('not_shipped', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'exception')),
  ADD COLUMN IF NOT EXISTS original_expected_at date,
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_tracking_update_at timestamptz,
  ADD COLUMN IF NOT EXISTS late_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_open_eta
  ON purchase_orders (user_id, expected_at) WHERE status IN ('sent', 'partially_received');

-- =============================================================
-- 2. SUPPLIER CATALOG
-- =============================================================

CREATE TABLE IF NOT EXISTS supplier_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  sku text NOT NULL CHECK (char_length(btrim(sku)) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  brand text CHECK (brand IS NULL OR char_length(brand) <= 120),
  category text CHECK (category IS NULL OR char_length(category) <= 120),
  mpn text CHECK (mpn IS NULL OR char_length(mpn) <= 80),
  uom text NOT NULL DEFAULT 'each' CHECK (char_length(uom) BETWEEN 1 AND 20),
  unit_cost_cents integer NOT NULL CHECK (unit_cost_cents >= 0),
  list_price_cents integer CHECK (list_price_cents IS NULL OR list_price_cents >= 0),
  min_order_qty integer NOT NULL DEFAULT 1 CHECK (min_order_qty BETWEEN 1 AND 100000),
  pack_size integer NOT NULL DEFAULT 1 CHECK (pack_size BETWEEN 1 AND 100000),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  stock_status text NOT NULL DEFAULT 'unknown'
    CHECK (stock_status IN ('in_stock', 'low_stock', 'backorder', 'discontinued', 'unknown')),
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'api')),
  active boolean NOT NULL DEFAULT true,
  last_imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sku_norm text GENERATED ALWAYS AS (lower(regexp_replace(sku, '[^A-Za-z0-9]', '', 'g'))) STORED,
  mpn_norm text GENERATED ALWAYS AS (lower(regexp_replace(COALESCE(mpn, ''), '[^A-Za-z0-9]', '', 'g'))) STORED,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      COALESCE(sku, '') || ' ' || COALESCE(name, '') || ' ' || COALESCE(brand, '') || ' ' ||
      COALESCE(mpn, '') || ' ' || COALESCE(category, '') || ' ' || COALESCE(description, ''))
  ) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_catalog_vendor_sku ON supplier_catalog_items (vendor_id, lower(sku));
CREATE INDEX IF NOT EXISTS idx_supplier_catalog_user_active ON supplier_catalog_items (user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_supplier_catalog_tsv ON supplier_catalog_items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_supplier_catalog_sku_norm ON supplier_catalog_items (user_id, sku_norm text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_supplier_catalog_mpn_norm ON supplier_catalog_items (user_id, mpn_norm text_pattern_ops) WHERE mpn_norm <> '';
CREATE INDEX IF NOT EXISTS idx_supplier_catalog_part ON supplier_catalog_items (part_id) WHERE part_id IS NOT NULL;

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS catalog_item_id uuid REFERENCES supplier_catalog_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendor_sku text;

CREATE TABLE IF NOT EXISTS supplier_price_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('csv', 'api')),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 255),
  status text NOT NULL CHECK (status IN ('completed', 'completed_with_errors', 'failed')),
  total_rows integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  unchanged_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  price_up_count integer NOT NULL DEFAULT 0,
  price_down_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  feed_key_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_price_imports_vendor ON supplier_price_imports (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_imports_user ON supplier_price_imports (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES supplier_catalog_items(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  old_cost_cents integer,
  new_cost_cents integer NOT NULL,
  import_id uuid REFERENCES supplier_price_imports(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_price_history_item ON supplier_price_history (catalog_item_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS supplier_feed_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 6 AND 24),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT ARRAY['prices:write']::text[]
    CHECK (scopes <@ ARRAY['prices:write', 'shipments:write']::text[] AND cardinality(scopes) >= 1),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_feed_keys_vendor ON supplier_feed_keys (vendor_id) WHERE revoked_at IS NULL;

-- The hash never leaves the database for browser clients (column-level grant below).
REVOKE ALL ON supplier_feed_keys FROM anon, authenticated;
GRANT SELECT (id, user_id, vendor_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at)
  ON supplier_feed_keys TO authenticated;

-- =============================================================
-- 3. CART, JOB ALLOCATIONS, TIMELINE
-- =============================================================

CREATE TABLE IF NOT EXISTS parts_order_cart (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  destination_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  catalog_item_id uuid NOT NULL REFERENCES supplier_catalog_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  added_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_cart_line ON parts_order_cart (
  user_id, catalog_item_id,
  COALESCE(job_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(destination_location_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_parts_cart_job ON parts_order_cart (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_order_line_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  po_line_id uuid NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_line_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_po_line_jobs_job ON purchase_order_line_jobs (job_id);

CREATE TABLE IF NOT EXISTS purchase_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'status_changed', 'shipment_update', 'eta_changed', 'delayed',
    'received', 'partially_received', 'job_auto_resumed', 'job_resume_blocked'
  )),
  message text NOT NULL CHECK (char_length(message) <= 500),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_events_po ON purchase_order_events (purchase_order_id, created_at DESC);

-- =============================================================
-- 4. RLS — members read, managers write; cart / events / history are RPC-written only
-- =============================================================

DO $$
DECLARE
  owner_check constant text := 'user_id = (SELECT public.get_account_owner_id())';
  manager_check constant text := 'user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage())';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'supplier_catalog_items', 'supplier_price_history', 'supplier_price_imports', 'supplier_feed_keys',
    'parts_order_cart', 'purchase_order_line_jobs', 'purchase_order_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
  END LOOP;

  -- Catalog: any member may search; only managers edit directly (bulk edits go through the import RPC).
  CREATE POLICY supplier_catalog_items_select ON supplier_catalog_items FOR SELECT TO authenticated USING (user_id = (SELECT public.get_account_owner_id()));
  DROP POLICY IF EXISTS supplier_catalog_items_manage ON supplier_catalog_items;
  EXECUTE format($p$CREATE POLICY supplier_catalog_items_manage ON supplier_catalog_items FOR ALL TO authenticated
    USING (%s)
    WITH CHECK (%s AND EXISTS (SELECT 1 FROM inventory_vendors v WHERE v.id = vendor_id AND v.user_id = supplier_catalog_items.user_id))$p$,
    manager_check, manager_check);

  CREATE POLICY supplier_price_history_select ON supplier_price_history FOR SELECT TO authenticated USING (user_id = (SELECT public.get_account_owner_id()));
  EXECUTE format('CREATE POLICY supplier_price_imports_select ON supplier_price_imports FOR SELECT TO authenticated USING (%s)', manager_check);
  EXECUTE format('CREATE POLICY supplier_feed_keys_select ON supplier_feed_keys FOR SELECT TO authenticated USING (%s)', manager_check);
  EXECUTE format('CREATE POLICY parts_order_cart_select ON parts_order_cart FOR SELECT TO authenticated USING (%s)', owner_check);
  EXECUTE format('CREATE POLICY purchase_order_line_jobs_select ON purchase_order_line_jobs FOR SELECT TO authenticated USING (%s)', owner_check);
  EXECUTE format('CREATE POLICY purchase_order_events_select ON purchase_order_events FOR SELECT TO authenticated USING (%s)', owner_check);
END $$;

-- Maintain updated_at on the catalog.
CREATE OR REPLACE FUNCTION public.supplier_catalog_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_supplier_catalog_touch ON supplier_catalog_items;
CREATE TRIGGER trg_supplier_catalog_touch BEFORE UPDATE ON supplier_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.supplier_catalog_touch();

-- Every cost change (insert or update) leaves a history row. The import RPC tags the row with its
-- run id through the transaction-local setting `vireek.import_id`.
CREATE OR REPLACE FUNCTION public.supplier_catalog_price_history()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_import uuid := NULLIF(current_setting('vireek.import_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.unit_cost_cents IS DISTINCT FROM OLD.unit_cost_cents THEN
    INSERT INTO supplier_price_history (user_id, catalog_item_id, vendor_id, old_cost_cents, new_cost_cents, import_id)
    VALUES (NEW.user_id, NEW.id, NEW.vendor_id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.unit_cost_cents END,
            NEW.unit_cost_cents, v_import);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_supplier_catalog_price_history ON supplier_catalog_items;
CREATE TRIGGER trg_supplier_catalog_price_history
  AFTER INSERT OR UPDATE OF unit_cost_cents ON supplier_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.supplier_catalog_price_history();

-- =============================================================
-- 5. INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._vendor_lead_days(p_vendor_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  -- Tolerates both variants of inventory_vendors in the wild.
  SELECT COALESCE(
    (to_jsonb(v) ->> 'lead_time_days')::integer,
    (to_jsonb(v) ->> 'default_lead_time_days')::integer,
    3)
  FROM inventory_vendors v WHERE v.id = p_vendor_id;
$$;

CREATE OR REPLACE FUNCTION public._po_event(p_po uuid, p_owner uuid, p_type text, p_message text, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO purchase_order_events (user_id, purchase_order_id, event_type, message, details, actor)
  VALUES (p_owner, p_po, p_type, left(p_message, 500), COALESCE(p_details, '{}'::jsonb), auth.uid());
$$;

CREATE OR REPLACE FUNCTION public._notify_owner(p_owner uuid, p_type text, p_title text, p_message text, p_url text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (p_owner, p_type, left(p_title, 140), left(p_message, 500), p_url);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notification skipped: %', SQLERRM;
END;
$$;

-- Find-or-create the inventory part behind a catalog item (inventory_parts is what stock,
-- requirements and PO lines reference). Matching order: existing link -> same part number -> new.
CREATE OR REPLACE FUNCTION public._ensure_part_for_catalog_item(p_item_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c supplier_catalog_items%ROWTYPE;
  v_part uuid;
BEGIN
  SELECT * INTO c FROM supplier_catalog_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog item not found';
  END IF;
  IF c.part_id IS NOT NULL THEN
    RETURN c.part_id;
  END IF;

  SELECT p.id INTO v_part FROM inventory_parts p
  WHERE p.user_id = c.user_id AND lower(p.part_number) = lower(c.sku)
  ORDER BY p.active DESC, p.created_at LIMIT 1;

  IF v_part IS NULL THEN
    BEGIN
      INSERT INTO inventory_parts (user_id, part_number, name, category, unit_cost_cents, preferred_vendor_id, vendor_sku)
      VALUES (c.user_id, c.sku, left(c.name, 200), c.category, c.unit_cost_cents, c.vendor_id, c.sku)
      RETURNING id INTO v_part;
    EXCEPTION WHEN unique_violation THEN
      SELECT p.id INTO v_part FROM inventory_parts p
      WHERE p.user_id = c.user_id AND lower(p.part_number) = lower(c.sku) LIMIT 1;
    END;
  END IF;

  UPDATE supplier_catalog_items SET part_id = v_part WHERE id = c.id;

  -- Keep the per-part vendor cross-reference in sync when that table exists in this database.
  IF to_regclass('public.inventory_part_vendors') IS NOT NULL THEN
    BEGIN
      INSERT INTO inventory_part_vendors (user_id, part_id, vendor_id, vendor_sku, unit_cost_cents, lead_time_days)
      VALUES (c.user_id, v_part, c.vendor_id, c.sku, c.unit_cost_cents, c.lead_time_days)
      ON CONFLICT (part_id, vendor_id) DO UPDATE
        SET vendor_sku = EXCLUDED.vendor_sku, unit_cost_cents = EXCLUDED.unit_cost_cents,
            lead_time_days = COALESCE(EXCLUDED.lead_time_days, inventory_part_vendors.lead_time_days);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'inventory_part_vendors sync skipped: %', SQLERRM;
    END;
  END IF;
  RETURN v_part;
END;
$$;

-- Rounds a requested quantity up to the supplier's minimum order and pack size.
CREATE OR REPLACE FUNCTION public._order_quantity(p_requested integer, p_moq integer, p_pack integer)
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$
  SELECT LEAST(100000, (CEIL(GREATEST(p_requested, p_moq, 1)::numeric / GREATEST(p_pack, 1)) * GREATEST(p_pack, 1))::integer);
$$;

-- Is every part this job needs available (van of its technician + warehouse) and nothing still on order?
CREATE OR REPLACE FUNCTION public._job_parts_ready(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM purchase_order_line_jobs plj
      JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
      JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE plj.job_id = p_job_id AND po.status <> 'cancelled' AND pol.quantity_received < pol.quantity_ordered
    )
    AND NOT EXISTS (
      SELECT 1
      FROM job_parts_required r
      JOIN jobs j ON j.id = r.job_id
      WHERE r.job_id = p_job_id
        AND r.status IN ('needed', 'backordered')
        AND r.quantity_required > COALESCE((
          SELECT SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0))
          FROM inventory_stock_levels sl
          JOIN inventory_locations l ON l.id = sl.location_id AND l.active
          WHERE sl.part_id = r.part_id
            AND (l.location_type = 'warehouse'
                 OR (l.location_type = 'van' AND j.assigned_technician_id IS NOT NULL
                     AND l.assigned_technician_id = j.assigned_technician_id))
        ), 0)
    );
$$;

-- Public wrapper: only answers for jobs in the caller's own account.
CREATE OR REPLACE FUNCTION public.job_parts_ready(p_job_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job_id AND j.user_id = public.get_account_owner_id())
              THEN public._job_parts_ready(p_job_id) END;
$$;

-- Latest ETA across the job's still-open purchase orders.
CREATE OR REPLACE FUNCTION public._job_parts_eta(p_job_id uuid)
RETURNS date
LANGUAGE sql STABLE
AS $$
  SELECT MAX(po.expected_at)
  FROM purchase_order_line_jobs plj
  JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
  JOIN purchase_orders po ON po.id = pol.purchase_order_id
  WHERE plj.job_id = p_job_id AND po.status <> 'cancelled' AND pol.quantity_received < pol.quantity_ordered;
$$;

-- =============================================================
-- 6. SEARCH
-- =============================================================

CREATE OR REPLACE FUNCTION public.search_supplier_catalog(
  p_query text,
  p_vendor_id uuid DEFAULT NULL,
  p_in_stock_only boolean DEFAULT false,
  p_limit integer DEFAULT 30
)
RETURNS TABLE (
  id uuid, vendor_id uuid, vendor_name text, sku text, name text, brand text, category text, mpn text, uom text,
  unit_cost_cents integer, list_price_cents integer, min_order_qty integer, pack_size integer,
  lead_time_days integer, stock_status text, part_id uuid, on_hand integer,
  is_best_price boolean, prev_cost_cents integer, price_changed_at timestamptz
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_raw text := btrim(COALESCE(p_query, ''));
  v_norm text := lower(regexp_replace(v_raw, '[^A-Za-z0-9]', '', 'g'));
  v_tokens text[];
  v_tsq tsquery;
BEGIN
  IF char_length(v_norm) < 2 THEN
    RETURN;
  END IF;

  SELECT array_agg(t) INTO v_tokens
  FROM (
    SELECT lower(x) AS t FROM regexp_split_to_table(left(v_raw, 120), '[^A-Za-z0-9]+') x WHERE x <> '' LIMIT 8
  ) s;
  IF v_tokens IS NOT NULL THEN
    v_tsq := to_tsquery('simple', (SELECT string_agg(t || ':*', ' & ') FROM unnest(v_tokens) t));
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT c.*, v.name AS vname,
           COALESCE(NULLIF(c.mpn_norm, ''), c.part_id::text, c.id::text) AS match_key,
           (CASE WHEN c.sku_norm = v_norm OR c.mpn_norm = v_norm THEN 100
                 WHEN c.sku_norm LIKE v_norm || '%' OR c.mpn_norm LIKE v_norm || '%' THEN 50 ELSE 0 END)
           + (CASE WHEN v_tsq IS NOT NULL THEN ts_rank(c.search_tsv, v_tsq) * 10 ELSE 0 END)
           + (CASE c.stock_status WHEN 'in_stock' THEN 5 WHEN 'low_stock' THEN 2 WHEN 'backorder' THEN -5 ELSE 0 END) AS score
    FROM supplier_catalog_items c
    JOIN inventory_vendors v ON v.id = c.vendor_id AND v.active
    WHERE c.active
      AND c.stock_status <> 'discontinued'
      AND (p_vendor_id IS NULL OR c.vendor_id = p_vendor_id)
      AND (NOT p_in_stock_only OR c.stock_status IN ('in_stock', 'low_stock'))
      AND ((v_tsq IS NOT NULL AND c.search_tsv @@ v_tsq)
           OR c.sku_norm LIKE v_norm || '%'
           OR (c.mpn_norm <> '' AND c.mpn_norm LIKE v_norm || '%'))
  )
  SELECT m.id, m.vendor_id, m.vname, m.sku, m.name, m.brand, m.category, m.mpn, m.uom,
         m.unit_cost_cents, m.list_price_cents, m.min_order_qty, m.pack_size, m.lead_time_days, m.stock_status, m.part_id,
         COALESCE((
           SELECT SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0))::integer
           FROM inventory_stock_levels sl JOIN inventory_locations l ON l.id = sl.location_id AND l.active
           WHERE m.part_id IS NOT NULL AND sl.part_id = m.part_id
         ), 0) AS on_hand,
         (m.unit_cost_cents = MIN(m.unit_cost_cents) OVER (PARTITION BY m.match_key)
            AND COUNT(*) OVER (PARTITION BY m.match_key) > 1) AS is_best_price,
         h.old_cost_cents AS prev_cost_cents,
         h.changed_at AS price_changed_at
  FROM matched m
  LEFT JOIN LATERAL (
    SELECT ph.old_cost_cents, ph.changed_at FROM supplier_price_history ph
    WHERE ph.catalog_item_id = m.id AND ph.old_cost_cents IS NOT NULL
    ORDER BY ph.changed_at DESC LIMIT 1
  ) h ON true
  ORDER BY m.score DESC, m.unit_cost_cents ASC, m.sku ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
END;
$$;

-- =============================================================
-- 7. CART
-- =============================================================

CREATE OR REPLACE FUNCTION public.add_to_parts_cart(
  p_catalog_item_id uuid,
  p_quantity integer,
  p_job_id uuid DEFAULT NULL,
  p_destination_location_id uuid DEFAULT NULL,
  p_add_requirement boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c supplier_catalog_items%ROWTYPE;
  j jobs%ROWTYPE;
  v_qty integer;
  v_part uuid;
  v_cart uuid;
  v_dest uuid := p_destination_location_id;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 100000 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 100000';
  END IF;

  SELECT * INTO c FROM supplier_catalog_items i
  WHERE i.id = p_catalog_item_id AND i.user_id = v_owner AND i.active AND i.stock_status <> 'discontinued';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM inventory_vendors v WHERE v.id = c.vendor_id AND v.active) THEN
    RAISE EXCEPTION 'This catalog item is not available';
  END IF;

  IF p_job_id IS NOT NULL THEN
    SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Job not found';
    END IF;
    IF j.job_status IN ('completed', 'cancelled', 'no_show') THEN
      RAISE EXCEPTION 'This job is closed';
    END IF;
  ELSIF p_add_requirement THEN
    RAISE EXCEPTION 'A job is required to add a part requirement';
  END IF;

  IF v_dest IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_locations l WHERE l.id = v_dest AND l.user_id = v_owner AND l.active
  ) THEN
    RAISE EXCEPTION 'Destination location not found';
  END IF;

  v_qty := public._order_quantity(p_quantity, c.min_order_qty, c.pack_size);

  IF p_add_requirement THEN
    v_part := public._ensure_part_for_catalog_item(c.id);
    -- The job "needs" this many: never lower an existing requirement from here.
    INSERT INTO job_parts_required (user_id, job_id, part_id, quantity_required)
    VALUES (v_owner, p_job_id, v_part, p_quantity)
    ON CONFLICT (job_id, part_id) DO UPDATE
      SET quantity_required = GREATEST(job_parts_required.quantity_required, EXCLUDED.quantity_required),
          status = CASE WHEN job_parts_required.status = 'installed' THEN 'needed' ELSE job_parts_required.status END,
          updated_at = now();
  END IF;

  LOOP
    UPDATE parts_order_cart
       SET quantity = LEAST(100000, quantity + v_qty), updated_at = now()
     WHERE user_id = v_owner AND catalog_item_id = c.id
       AND job_id IS NOT DISTINCT FROM p_job_id
       AND destination_location_id IS NOT DISTINCT FROM v_dest
    RETURNING id INTO v_cart;
    IF FOUND THEN
      RETURN v_cart;
    END IF;
    BEGIN
      INSERT INTO parts_order_cart (user_id, job_id, destination_location_id, catalog_item_id, quantity)
      VALUES (v_owner, p_job_id, v_dest, c.id, v_qty)
      RETURNING id INTO v_cart;
      RETURN v_cart;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- concurrent add of the same line: loop and update it
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_parts_cart_quantity(p_cart_id uuid, p_quantity integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c supplier_catalog_items%ROWTYPE;
  v_qty integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 100000 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 100000';
  END IF;
  SELECT i.* INTO c FROM parts_order_cart pc JOIN supplier_catalog_items i ON i.id = pc.catalog_item_id
  WHERE pc.id = p_cart_id AND pc.user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cart line not found';
  END IF;
  v_qty := public._order_quantity(p_quantity, c.min_order_qty, c.pack_size);
  UPDATE parts_order_cart SET quantity = v_qty, updated_at = now() WHERE id = p_cart_id AND user_id = v_owner;
  RETURN v_qty;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_from_parts_cart(p_cart_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  DELETE FROM parts_order_cart WHERE id = p_cart_id AND user_id = public.get_account_owner_id();
END;
$$;

-- =============================================================
-- 8. CART -> PURCHASE ORDERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_parts_orders_from_cart(
  p_cart_ids uuid[] DEFAULT NULL,
  p_job_id uuid DEFAULT NULL,
  p_hold_jobs boolean DEFAULT false,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_wh uuid;
  v_threshold integer;
  g record;
  l record;
  r record;
  v_po uuid;
  v_po_number text;
  v_line uuid;
  v_total integer;
  v_lead integer;
  v_status text;
  v_orders jsonb := '[]'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_hold jsonb;
  v_eta date;
  v_note text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_job uuid;
  v_job_ids uuid[] := ARRAY[]::uuid[];
  v_po_numbers text[];
  v_cur text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_cart_ids IS NULL AND p_job_id IS NULL THEN
    RAISE EXCEPTION 'Choose which cart lines to order';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Notes are too long (max 1000 characters)';
  END IF;

  SELECT l2.id INTO v_wh FROM inventory_locations l2
  WHERE l2.user_id = v_owner AND l2.active AND l2.location_type = 'warehouse'
  ORDER BY l2.created_at LIMIT 1;

  SELECT COALESCE((SELECT s.po_approval_threshold_cents FROM replenishment_settings s WHERE s.user_id = v_owner), 50000)
    INTO v_threshold;

  -- Lock the chosen cart lines so a double-click cannot create two orders.
  CREATE TEMP TABLE _pc ON COMMIT DROP AS
  SELECT pc.id AS cart_id, pc.job_id, COALESCE(pc.destination_location_id, v_wh) AS dest, pc.quantity,
         c.id AS item_id, c.vendor_id, c.sku, c.name AS item_name, c.unit_cost_cents, c.lead_time_days,
         c.min_order_qty, c.pack_size, c.active AS item_active, c.stock_status, v.active AS vendor_active, v.name AS vendor_name
  FROM parts_order_cart pc
  JOIN supplier_catalog_items c ON c.id = pc.catalog_item_id
  JOIN inventory_vendors v ON v.id = c.vendor_id
  WHERE pc.user_id = v_owner
    AND ((p_cart_ids IS NOT NULL AND pc.id = ANY (p_cart_ids)) OR (p_cart_ids IS NULL AND pc.job_id = p_job_id))
  ORDER BY pc.created_at, pc.id
  FOR UPDATE OF pc;

  IF NOT EXISTS (SELECT 1 FROM _pc) THEN
    DROP TABLE _pc;
    RAISE EXCEPTION 'Nothing to order';
  END IF;

  -- Unavailable lines are reported and left in the cart.
  FOR r IN SELECT * FROM _pc WHERE NOT item_active OR NOT vendor_active OR stock_status = 'discontinued' LOOP
    v_skipped := v_skipped || jsonb_build_object('cart_id', r.cart_id, 'sku', r.sku, 'reason', 'unavailable');
  END LOOP;
  DELETE FROM _pc WHERE NOT item_active OR NOT vendor_active OR stock_status = 'discontinued';

  IF EXISTS (SELECT 1 FROM _pc WHERE dest IS NULL) THEN
    DROP TABLE _pc;
    RAISE EXCEPTION 'Create a warehouse location first (or pick a truck) so orders have somewhere to be received';
  END IF;

  FOR g IN SELECT vendor_id, dest, MIN(vendor_name) AS vendor_name FROM _pc GROUP BY vendor_id, dest ORDER BY MIN(vendor_name), dest LOOP
    SELECT COALESCE(SUM(quantity::bigint * unit_cost_cents), 0)::integer,
           COALESCE(MAX(COALESCE(lead_time_days, public._vendor_lead_days(g.vendor_id))), public._vendor_lead_days(g.vendor_id))
      INTO v_total, v_lead
    FROM _pc WHERE vendor_id = g.vendor_id AND dest = g.dest;

    v_status := CASE WHEN v_total > v_threshold THEN 'pending_approval' ELSE 'draft' END;
    v_po_number := public.new_po_number();

    INSERT INTO purchase_orders (user_id, po_number, vendor_id, vendor_name, status, source, destination_location_id,
                                 total_cents, expected_at, original_expected_at, notes)
    VALUES (v_owner, v_po_number, g.vendor_id, g.vendor_name, v_status, 'manual', g.dest,
            0, CURRENT_DATE + v_lead, CURRENT_DATE + v_lead, v_note)
    RETURNING id INTO v_po;

    -- One PO line per part (the table is unique on (purchase_order_id, part_id)).
    FOR l IN
      SELECT public._ensure_part_for_catalog_item(item_id) AS part_id, item_id, sku, item_name, quantity, unit_cost_cents
      FROM _pc WHERE vendor_id = g.vendor_id AND dest = g.dest
    LOOP
      INSERT INTO purchase_order_lines (user_id, purchase_order_id, part_id, quantity_ordered, unit_cost_cents, catalog_item_id, vendor_sku)
      VALUES (v_owner, v_po, l.part_id, l.quantity, l.unit_cost_cents, l.item_id, l.sku)
      ON CONFLICT (purchase_order_id, part_id) DO UPDATE
        SET quantity_ordered = purchase_order_lines.quantity_ordered + EXCLUDED.quantity_ordered,
            unit_cost_cents = LEAST(purchase_order_lines.unit_cost_cents, EXCLUDED.unit_cost_cents)
      RETURNING id INTO v_line;

      -- Allocate to the jobs this quantity was ordered for.
      INSERT INTO purchase_order_line_jobs (user_id, po_line_id, job_id, quantity)
      SELECT v_owner, v_line, x.job_id, SUM(x.quantity)::integer
      FROM _pc x
      WHERE x.vendor_id = g.vendor_id AND x.dest = g.dest AND x.item_id = l.item_id AND x.job_id IS NOT NULL
      GROUP BY x.job_id
      ON CONFLICT (po_line_id, job_id) DO UPDATE SET quantity = purchase_order_line_jobs.quantity + EXCLUDED.quantity;
    END LOOP;

    UPDATE purchase_orders
       SET total_cents = COALESCE((SELECT SUM(pol.quantity_ordered::bigint * pol.unit_cost_cents) FROM purchase_order_lines pol WHERE pol.purchase_order_id = v_po), 0)::integer
     WHERE id = v_po;

    PERFORM public._po_event(v_po, v_owner, 'created',
      format('Order %s created for %s (%s)', v_po_number, g.vendor_name, v_status),
      jsonb_build_object('status', v_status, 'total_cents', v_total));

    v_orders := v_orders || jsonb_build_object(
      'po_id', v_po, 'po_number', v_po_number, 'vendor_id', g.vendor_id, 'vendor_name', g.vendor_name,
      'status', v_status, 'total_cents', v_total, 'expected_at', CURRENT_DATE + v_lead,
      'line_count', (SELECT COUNT(*) FROM purchase_order_lines WHERE purchase_order_id = v_po));
  END LOOP;

  SELECT COALESCE(array_agg(DISTINCT x.job_id), ARRAY[]::uuid[]) INTO v_job_ids FROM _pc x WHERE x.job_id IS NOT NULL;
  SELECT array_agg(po_number) INTO v_po_numbers FROM purchase_orders WHERE id::text IN (SELECT o ->> 'po_id' FROM jsonb_array_elements(v_orders) o);

  DELETE FROM parts_order_cart WHERE id IN (SELECT cart_id FROM _pc) AND user_id = v_owner;
  DROP TABLE _pc;

  -- Optionally park jobs that cannot proceed until the parts arrive.
  FOREACH v_job IN ARRAY v_job_ids LOOP
    v_hold := jsonb_build_object('job_id', v_job, 'hold', 'not_requested');
    IF p_hold_jobs THEN
      SELECT j2.job_status INTO v_cur FROM jobs j2 WHERE j2.id = v_job;
      v_eta := public._job_parts_eta(v_job);
      IF public._job_parts_ready(v_job) THEN
        v_hold := jsonb_build_object('job_id', v_job, 'hold', 'not_needed');
      ELSIF v_cur = 'waiting_on_parts' THEN
        UPDATE job_holds SET expected_resume_at = (v_eta::timestamp AT TIME ZONE 'UTC') + interval '1 day'
         WHERE job_id = v_job AND resolved_at IS NULL AND status = 'waiting_on_parts' AND v_eta IS NOT NULL;
        v_hold := jsonb_build_object('job_id', v_job, 'hold', 'already_waiting');
      ELSIF v_cur IS NULL OR v_cur IN ('completed', 'cancelled', 'no_show') OR public.is_job_workflow_status(v_cur) THEN
        v_hold := jsonb_build_object('job_id', v_job, 'hold', 'skipped_status');
      ELSE
        v_hold := public.set_job_workflow_status(
          v_job, 'waiting_on_parts', 'part_ordered',
          left('Parts ordered: ' || array_to_string(v_po_numbers, ', '), 1000),
          CASE WHEN v_eta IS NOT NULL AND ((v_eta::timestamp AT TIME ZONE 'UTC') + interval '1 day') > now() + interval '2 minutes'
               THEN (v_eta::timestamp AT TIME ZONE 'UTC') + interval '1 day' END
        );
        v_hold := jsonb_build_object('job_id', v_job, 'hold', COALESCE(v_hold ->> 'status', 'error'), 'reason', v_hold ->> 'reason');
      END IF;
    END IF;
    v_jobs := v_jobs || v_hold;
  END LOOP;

  RETURN jsonb_build_object('orders', v_orders, 'jobs', v_jobs, 'skipped', v_skipped);
END;
$$;

-- =============================================================
-- 9. DELIVERY TRACKING
-- =============================================================

-- Core used by both the signed-in UI and the supplier API (service role). Not exposed to browsers.
CREATE OR REPLACE FUNCTION public._record_po_shipment(
  p_owner uuid,
  p_po_id uuid,
  p_carrier text,
  p_tracking_number text,
  p_tracking_url text,
  p_shipment_status text,
  p_expected_at date,
  p_source text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  po purchase_orders%ROWTYPE;
  v_carrier text := NULLIF(btrim(COALESCE(p_carrier, '')), '');
  v_number text := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_url text := NULLIF(btrim(COALESCE(p_tracking_url, '')), '');
  v_status text := NULLIF(btrim(COALESCE(p_shipment_status, '')), '');
  v_old_eta date;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO po FROM purchase_orders WHERE id = p_po_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Order not found.');
  END IF;
  IF po.status NOT IN ('sent', 'partially_received') THEN
    RETURN jsonb_build_object('status', 'invalid_state', 'reason', 'Tracking can only be updated on an order that has been sent and is not fully received.');
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('not_shipped', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'exception') THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Unknown shipment status.');
  END IF;
  IF v_url IS NOT NULL AND (char_length(v_url) > 500 OR v_url !~* '^https?://') THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Tracking link must start with http:// or https://.');
  END IF;
  IF v_carrier IS NOT NULL AND char_length(v_carrier) > 80 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Carrier name is too long.');
  END IF;
  IF v_number IS NOT NULL AND char_length(v_number) > 120 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Tracking number is too long.');
  END IF;
  IF p_expected_at IS NOT NULL AND (p_expected_at < CURRENT_DATE - 365 OR p_expected_at > CURRENT_DATE + 730) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'Expected date is out of range.');
  END IF;

  v_old_eta := po.expected_at;

  UPDATE purchase_orders SET
    carrier = COALESCE(v_carrier, carrier),
    tracking_number = COALESCE(v_number, tracking_number),
    tracking_url = COALESCE(v_url, tracking_url),
    shipment_status = COALESCE(v_status, shipment_status),
    expected_at = COALESCE(p_expected_at, expected_at),
    original_expected_at = COALESCE(original_expected_at, v_old_eta, p_expected_at),
    shipped_at = CASE WHEN COALESCE(v_status, shipment_status) IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered') THEN COALESCE(shipped_at, now()) ELSE shipped_at END,
    delivered_at = CASE WHEN v_status = 'delivered' THEN COALESCE(delivered_at, now()) WHEN v_status IS NOT NULL THEN NULL ELSE delivered_at END,
    -- a fresh ETA clears the "late" flag so a new overdue alert can fire later
    late_notified_at = CASE WHEN p_expected_at IS NOT NULL AND p_expected_at IS DISTINCT FROM po.expected_at THEN NULL ELSE late_notified_at END,
    last_tracking_update_at = now()
  WHERE id = po.id;

  IF v_status IS NOT NULL AND v_status IS DISTINCT FROM po.shipment_status THEN v_changed := array_append(v_changed, 'shipment_status'); END IF;
  IF v_number IS NOT NULL AND v_number IS DISTINCT FROM po.tracking_number THEN v_changed := array_append(v_changed, 'tracking_number'); END IF;
  IF v_carrier IS NOT NULL AND v_carrier IS DISTINCT FROM po.carrier THEN v_changed := array_append(v_changed, 'carrier'); END IF;

  IF cardinality(v_changed) > 0 THEN
    PERFORM public._po_event(po.id, p_owner, 'shipment_update',
      format('Delivery update (%s): %s', p_source, array_to_string(v_changed, ', ')),
      jsonb_build_object('source', p_source, 'changed', v_changed, 'shipment_status', COALESCE(v_status, po.shipment_status),
                         'expected_at', COALESCE(p_expected_at, v_old_eta)));
  END IF;

  -- Carrier says it is here, but stock has not been counted in yet: ask the team to receive it.
  IF v_status = 'delivered' AND po.shipment_status IS DISTINCT FROM 'delivered' THEN
    PERFORM public._notify_owner(p_owner, 'parts_delivered', 'Parts delivered — receive the order',
      format('%s from %s is marked delivered. Receive it to update stock and release waiting jobs.', po.po_number, COALESCE(po.vendor_name, 'supplier')),
      '/dashboard/truck-stock');
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'changed', v_changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_po_shipment(
  p_po_id uuid,
  p_carrier text DEFAULT NULL,
  p_tracking_number text DEFAULT NULL,
  p_tracking_url text DEFAULT NULL,
  p_shipment_status text DEFAULT NULL,
  p_expected_at date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RETURN jsonb_build_object('status', 'forbidden', 'reason', 'Only managers can update delivery details.');
  END IF;
  RETURN public._record_po_shipment(public.get_account_owner_id(), p_po_id, p_carrier, p_tracking_number,
                                    p_tracking_url, p_shipment_status, p_expected_at, 'manual');
END;
$$;

-- PO status / ETA changes: timeline entries + keep waiting jobs' expected-resume time honest.
CREATE OR REPLACE FUNCTION public.po_track_changes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public._po_event(NEW.id, NEW.user_id,
        CASE NEW.status WHEN 'received' THEN 'received' WHEN 'partially_received' THEN 'partially_received' ELSE 'status_changed' END,
        format('Status: %s → %s', OLD.status, NEW.status),
        jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;

    IF NEW.expected_at IS DISTINCT FROM OLD.expected_at THEN
      PERFORM public._po_event(NEW.id, NEW.user_id, 'eta_changed',
        format('ETA: %s → %s', COALESCE(OLD.expected_at::text, 'none'), COALESCE(NEW.expected_at::text, 'none')),
        jsonb_build_object('from', OLD.expected_at, 'to', NEW.expected_at));

      UPDATE job_holds h
         SET expected_resume_at = ((public._job_parts_eta(h.job_id)::timestamp AT TIME ZONE 'UTC') + interval '1 day')
       WHERE h.resolved_at IS NULL AND h.status = 'waiting_on_parts'
         AND public._job_parts_eta(h.job_id) IS NOT NULL
         AND h.job_id IN (
           SELECT plj.job_id FROM purchase_order_line_jobs plj
           JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
           WHERE pol.purchase_order_id = NEW.id);
    END IF;

    -- Cancelling an order must not leave jobs waiting on something that will never come.
    IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
      PERFORM public._notify_owner(NEW.user_id, 'parts_order_cancelled', 'Parts order cancelled',
        format('%s was cancelled. Jobs waiting on it still need their parts ordered.', NEW.po_number), '/dashboard/truck-stock');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'po_track_changes failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_track_changes ON purchase_orders;
CREATE TRIGGER trg_po_track_changes
  AFTER UPDATE OF status, expected_at ON purchase_orders
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.expected_at IS DISTINCT FROM OLD.expected_at)
  EXECUTE FUNCTION public.po_track_changes();

-- =============================================================
-- 10. PARTS ARRIVED -> JOB AUTOMATION
-- =============================================================

-- Returns 'resumed' | 'not_waiting' | 'not_ready' | 'slot_conflict'.
CREATE OR REPLACE FUNCTION public._job_parts_arrived(p_job_id uuid, p_po_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  j jobs%ROWTYPE;
  v_po_number text;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.job_status IS DISTINCT FROM 'waiting_on_parts' THEN
    RETURN 'not_waiting';
  END IF;
  IF NOT public._job_parts_ready(p_job_id) THEN
    RETURN 'not_ready';
  END IF;
  SELECT po_number INTO v_po_number FROM purchase_orders WHERE id = p_po_id;

  BEGIN
    UPDATE job_holds SET resolution_note = left('Parts arrived (' || COALESCE(v_po_number, 'order') || ') — resumed automatically', 1000)
     WHERE job_id = p_job_id AND resolved_at IS NULL;
    -- Always back to "scheduled": dispatch re-confirms the visit rather than assuming the tech is en route.
    UPDATE jobs SET job_status = 'scheduled' WHERE id = p_job_id;
  EXCEPTION WHEN exclusion_violation THEN
    PERFORM public._po_event(p_po_id, j.user_id, 'job_resume_blocked',
      format('Parts for %s arrived but the time slot is taken — reschedule the job.', j.customer_name),
      jsonb_build_object('job_id', p_job_id));
    PERFORM public._notify_owner(j.user_id, 'parts_arrived_reschedule', 'Parts arrived — reschedule needed',
      format('Parts for %s are in stock, but the original time slot is taken. Reschedule the job to continue.', j.customer_name),
      '/dashboard/jobs/' || p_job_id::text);
    RETURN 'slot_conflict';
  END;

  INSERT INTO job_status_events (job_id, technician_id, from_status, to_status, note)
  VALUES (p_job_id, j.assigned_technician_id, 'waiting_on_parts', 'scheduled',
          'Parts arrived (' || COALESCE(v_po_number, 'order') || ') — resumed automatically');

  PERFORM public._po_event(p_po_id, j.user_id, 'job_auto_resumed',
    format('Job for %s resumed — all parts are in stock.', j.customer_name),
    jsonb_build_object('job_id', p_job_id));
  PERFORM public._notify_owner(j.user_id, 'parts_arrived', 'Parts arrived — job ready',
    format('All parts for %s are in stock. The job is back on the schedule.', j.customer_name),
    '/dashboard/jobs/' || p_job_id::text);
  RETURN 'resumed';
END;
$$;

CREATE OR REPLACE FUNCTION public.po_line_received_reconcile()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT plj.job_id FROM purchase_order_line_jobs plj WHERE plj.po_line_id = NEW.id LOOP
    BEGIN
      PERFORM public._job_parts_arrived(r.job_id, NEW.purchase_order_id);
    EXCEPTION WHEN OTHERS THEN
      -- Never block receiving because of job automation; one bad job must not stop the others.
      RAISE WARNING 'po_line_received_reconcile failed for line % / job %: %', NEW.id, r.job_id, SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_line_received_reconcile ON purchase_order_lines;
CREATE TRIGGER trg_po_line_received_reconcile
  AFTER UPDATE OF quantity_received ON purchase_order_lines
  FOR EACH ROW
  WHEN (NEW.quantity_received > OLD.quantity_received)
  EXECUTE FUNCTION public.po_line_received_reconcile();

-- =============================================================
-- 11. LATE DELIVERY SWEEP
-- =============================================================

CREATE OR REPLACE FUNCTION public.sweep_late_po_deliveries(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
  v_count integer := 0;
  v_waiting integer;
BEGIN
  FOR r IN
    SELECT po.id, po.user_id, po.po_number, po.vendor_name, po.expected_at
    FROM purchase_orders po
    WHERE po.status IN ('sent', 'partially_received')
      AND po.expected_at IS NOT NULL AND po.expected_at < CURRENT_DATE
      AND po.late_notified_at IS NULL
      AND po.shipment_status NOT IN ('delivered')
    ORDER BY po.expected_at
    LIMIT GREATEST(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT COUNT(DISTINCT plj.job_id) INTO v_waiting
    FROM purchase_order_line_jobs plj
    JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
    JOIN jobs j ON j.id = plj.job_id AND j.job_status = 'waiting_on_parts'
    WHERE pol.purchase_order_id = r.id AND pol.quantity_received < pol.quantity_ordered;

    UPDATE purchase_orders
       SET shipment_status = CASE WHEN shipment_status IN ('not_shipped', 'shipped', 'in_transit', 'out_for_delivery') THEN 'delayed' ELSE shipment_status END,
           late_notified_at = now()
     WHERE id = r.id;

    PERFORM public._po_event(r.id, r.user_id, 'delayed',
      format('Overdue: expected %s', r.expected_at), jsonb_build_object('expected_at', r.expected_at, 'waiting_jobs', v_waiting));
    PERFORM public._notify_owner(r.user_id, 'parts_order_late', 'Parts order is overdue',
      format('%s from %s was due %s%s. Contact the supplier or update the ETA.', r.po_number, COALESCE(r.vendor_name, 'supplier'), r.expected_at,
             CASE WHEN v_waiting > 0 THEN format(' — %s job(s) are waiting on it', v_waiting) ELSE '' END),
      '/dashboard/truck-stock');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-late-po-sweep');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-late-po-sweep', '40 * * * *', 'select public.sweep_late_po_deliveries()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

-- =============================================================
-- 12. PRICE IMPORT (CSV from the UI, JSON from the supplier API)
-- =============================================================

-- Strict money parser: digits with an optional fractional part. Cents mode rounds to whole cents.
CREATE OR REPLACE FUNCTION public._parse_cents(p_raw text, p_dollars boolean, p_label text)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_raw text := btrim(COALESCE(p_raw, ''));
  v_val numeric;
BEGIN
  IF v_raw !~ '^[0-9]{1,10}(\.[0-9]{1,6})?$' THEN
    RAISE EXCEPTION 'Invalid %', p_label;
  END IF;
  v_val := CASE WHEN p_dollars THEN ROUND(v_raw::numeric * 100) ELSE ROUND(v_raw::numeric) END;
  IF v_val > 2000000000 THEN
    RAISE EXCEPTION '% is too large', p_label;
  END IF;
  RETURN v_val::integer;
END;
$$;

-- Accepted item keys: sku*, name, description, brand, category, mpn, uom,
--   unit_cost_cents | unit_cost (dollars), list_price_cents | list_price, min_order_qty, pack_size,
--   lead_time_days, stock_status.  (* required). `name` is required only for new SKUs, so
-- price-only feeds work. Max 5000 rows per call.
CREATE OR REPLACE FUNCTION public._import_supplier_prices(
  p_owner uuid,
  p_vendor_id uuid,
  p_source text,
  p_file_name text,
  p_items jsonb,
  p_actor uuid DEFAULT NULL,
  p_feed_key_id uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_import uuid := gen_random_uuid();
  e record;
  ex supplier_catalog_items%ROWTYPE;
  v_item jsonb;
  v_n integer := 0;
  v_total integer;
  v_ins integer := 0;
  v_upd integer := 0;
  v_same integer := 0;
  v_err integer := 0;
  v_up integer := 0;
  v_down integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_seen text[] := ARRAY[]::text[];
  v_sku text;
  v_name text;
  v_cost integer;
  v_list integer;
  v_moq integer;
  v_pack integer;
  v_lead integer;
  v_stock text;
  v_status text;
  v_result jsonb;
BEGIN
  IF p_source NOT IN ('csv', 'api') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_vendors v WHERE v.id = p_vendor_id AND v.user_id = p_owner) THEN
    RAISE EXCEPTION 'Unknown supplier';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items must be an array';
  END IF;
  v_total := jsonb_array_length(p_items);
  IF v_total = 0 THEN
    RAISE EXCEPTION 'No rows to import';
  END IF;
  IF v_total > 5000 THEN
    RAISE EXCEPTION 'Too many rows (max 5000 per import)';
  END IF;

  BEGIN  -- inner block: rolled back for dry runs
    INSERT INTO supplier_price_imports (id, user_id, vendor_id, source, file_name, status, total_rows, feed_key_id, created_by)
    VALUES (v_import, p_owner, p_vendor_id, p_source, left(p_file_name, 255), 'completed', v_total, p_feed_key_id, p_actor);
    PERFORM set_config('vireek.import_id', v_import::text, true);

    FOR e IN SELECT value, ordinality FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(value, ordinality) LOOP
      v_n := e.ordinality;
      v_item := e.value;
      BEGIN
        IF jsonb_typeof(v_item) <> 'object' THEN
          RAISE EXCEPTION 'Row is not an object';
        END IF;
        v_sku := btrim(COALESCE(v_item ->> 'sku', ''));
        IF v_sku = '' OR char_length(v_sku) > 80 THEN
          RAISE EXCEPTION 'SKU is required (max 80 characters)';
        END IF;
        IF lower(v_sku) = ANY (v_seen) THEN
          RAISE EXCEPTION 'Duplicate SKU in this file';
        END IF;
        v_seen := v_seen || lower(v_sku);

        -- money: cents win over dollars; garbage is rejected, never guessed
        v_cost := NULL;
        IF NULLIF(btrim(v_item ->> 'unit_cost_cents'), '') IS NOT NULL THEN
          v_cost := public._parse_cents(v_item ->> 'unit_cost_cents', false, 'unit_cost_cents');
        ELSIF NULLIF(btrim(v_item ->> 'unit_cost'), '') IS NOT NULL THEN
          v_cost := public._parse_cents(v_item ->> 'unit_cost', true, 'unit_cost');
        END IF;

        v_list := NULL;
        IF NULLIF(btrim(v_item ->> 'list_price_cents'), '') IS NOT NULL THEN
          v_list := public._parse_cents(v_item ->> 'list_price_cents', false, 'list_price_cents');
        ELSIF NULLIF(btrim(v_item ->> 'list_price'), '') IS NOT NULL THEN
          v_list := public._parse_cents(v_item ->> 'list_price', true, 'list_price');
        END IF;

        v_moq := NULL; v_pack := NULL; v_lead := NULL;
        IF NULLIF(btrim(v_item ->> 'min_order_qty'), '') IS NOT NULL THEN
          IF btrim(v_item ->> 'min_order_qty') !~ '^[0-9]{1,6}$' OR (v_item ->> 'min_order_qty')::integer NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'Invalid min_order_qty'; END IF;
          v_moq := (v_item ->> 'min_order_qty')::integer;
        END IF;
        IF NULLIF(btrim(v_item ->> 'pack_size'), '') IS NOT NULL THEN
          IF btrim(v_item ->> 'pack_size') !~ '^[0-9]{1,6}$' OR (v_item ->> 'pack_size')::integer NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'Invalid pack_size'; END IF;
          v_pack := (v_item ->> 'pack_size')::integer;
        END IF;
        IF NULLIF(btrim(v_item ->> 'lead_time_days'), '') IS NOT NULL THEN
          IF btrim(v_item ->> 'lead_time_days') !~ '^[0-9]{1,3}$' OR (v_item ->> 'lead_time_days')::integer > 365 THEN RAISE EXCEPTION 'Invalid lead_time_days'; END IF;
          v_lead := (v_item ->> 'lead_time_days')::integer;
        END IF;
        v_stock := lower(NULLIF(btrim(v_item ->> 'stock_status'), ''));
        IF v_stock IS NOT NULL AND v_stock NOT IN ('in_stock', 'low_stock', 'backorder', 'discontinued', 'unknown') THEN
          RAISE EXCEPTION 'Invalid stock_status';
        END IF;
        v_name := NULLIF(btrim(COALESCE(v_item ->> 'name', '')), '');
        IF v_name IS NOT NULL AND char_length(v_name) > 300 THEN RAISE EXCEPTION 'Name is too long (max 300)'; END IF;

        SELECT * INTO ex FROM supplier_catalog_items
         WHERE vendor_id = p_vendor_id AND lower(sku) = lower(v_sku) FOR UPDATE;

        IF NOT FOUND THEN
          IF v_cost IS NULL THEN RAISE EXCEPTION 'Price is required for a new SKU'; END IF;
          IF v_name IS NULL THEN RAISE EXCEPTION 'Name is required for a new SKU'; END IF;
          INSERT INTO supplier_catalog_items (
            user_id, vendor_id, sku, name, description, brand, category, mpn, uom, unit_cost_cents, list_price_cents,
            min_order_qty, pack_size, lead_time_days, stock_status, source, last_imported_at)
          VALUES (
            p_owner, p_vendor_id, v_sku, v_name, left(NULLIF(btrim(v_item ->> 'description'), ''), 2000),
            left(NULLIF(btrim(v_item ->> 'brand'), ''), 120), left(NULLIF(btrim(v_item ->> 'category'), ''), 120),
            left(NULLIF(btrim(v_item ->> 'mpn'), ''), 80), COALESCE(left(NULLIF(btrim(v_item ->> 'uom'), ''), 20), 'each'),
            v_cost, v_list, COALESCE(v_moq, 1), COALESCE(v_pack, 1), v_lead, COALESCE(v_stock, 'unknown'), p_source, now());
          v_ins := v_ins + 1;
        ELSE
          IF v_cost IS NOT NULL AND v_cost < ex.unit_cost_cents THEN v_down := v_down + 1; END IF;
          IF v_cost IS NOT NULL AND v_cost > ex.unit_cost_cents THEN v_up := v_up + 1; END IF;
          IF (v_cost IS NULL OR v_cost = ex.unit_cost_cents)
             AND (v_name IS NULL OR v_name = ex.name)
             AND (v_list IS NULL OR v_list IS NOT DISTINCT FROM ex.list_price_cents)
             AND (v_moq IS NULL OR v_moq = ex.min_order_qty)
             AND (v_pack IS NULL OR v_pack = ex.pack_size)
             AND (v_lead IS NULL OR v_lead IS NOT DISTINCT FROM ex.lead_time_days)
             AND (v_stock IS NULL OR v_stock = ex.stock_status)
             AND ex.active
             AND (NULLIF(btrim(v_item ->> 'brand'), '') IS NULL OR btrim(v_item ->> 'brand') = ex.brand)
             AND (NULLIF(btrim(v_item ->> 'category'), '') IS NULL OR btrim(v_item ->> 'category') = ex.category)
             AND (NULLIF(btrim(v_item ->> 'mpn'), '') IS NULL OR btrim(v_item ->> 'mpn') = ex.mpn) THEN
            UPDATE supplier_catalog_items SET last_imported_at = now(), source = p_source WHERE id = ex.id;
            v_same := v_same + 1;
          ELSE
            UPDATE supplier_catalog_items SET
              name = COALESCE(v_name, name),
              description = COALESCE(left(NULLIF(btrim(v_item ->> 'description'), ''), 2000), description),
              brand = COALESCE(left(NULLIF(btrim(v_item ->> 'brand'), ''), 120), brand),
              category = COALESCE(left(NULLIF(btrim(v_item ->> 'category'), ''), 120), category),
              mpn = COALESCE(left(NULLIF(btrim(v_item ->> 'mpn'), ''), 80), mpn),
              uom = COALESCE(left(NULLIF(btrim(v_item ->> 'uom'), ''), 20), uom),
              unit_cost_cents = COALESCE(v_cost, unit_cost_cents),
              list_price_cents = COALESCE(v_list, list_price_cents),
              min_order_qty = COALESCE(v_moq, min_order_qty),
              pack_size = COALESCE(v_pack, pack_size),
              lead_time_days = COALESCE(v_lead, lead_time_days),
              stock_status = COALESCE(v_stock, stock_status),
              active = true,
              source = p_source,
              last_imported_at = now()
            WHERE id = ex.id;
            v_upd := v_upd + 1;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_err := v_err + 1;
        IF jsonb_array_length(v_errors) < 100 THEN
          v_errors := v_errors || jsonb_build_object('row', v_n, 'sku', left(COALESCE(v_sku, ''), 80), 'message', left(SQLERRM, 200));
        END IF;
      END;
    END LOOP;

    -- Link freshly imported SKUs to existing inventory parts with the same part number.
    UPDATE supplier_catalog_items c SET part_id = p.id
      FROM inventory_parts p
     WHERE c.vendor_id = p_vendor_id AND c.part_id IS NULL AND c.last_imported_at = now()
       AND p.user_id = p_owner AND lower(p.part_number) = lower(c.sku);

    v_status := CASE WHEN v_err = 0 THEN 'completed' WHEN v_ins + v_upd + v_same > 0 THEN 'completed_with_errors' ELSE 'failed' END;
    UPDATE supplier_price_imports
       SET status = v_status, inserted_count = v_ins, updated_count = v_upd, unchanged_count = v_same,
           error_count = v_err, price_up_count = v_up, price_down_count = v_down, errors = v_errors
     WHERE id = v_import;

    v_result := jsonb_build_object(
      'import_id', CASE WHEN p_dry_run THEN NULL ELSE v_import END, 'status', v_status, 'dry_run', p_dry_run,
      'total', v_total, 'inserted', v_ins, 'updated', v_upd, 'unchanged', v_same, 'errors', v_err,
      'price_up', v_up, 'price_down', v_down, 'error_rows', v_errors);

    IF p_dry_run THEN
      RAISE EXCEPTION 'DRY_RUN_ROLLBACK' USING ERRCODE = 'P0DRY';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0DRY' THEN
    NULL; -- everything above is rolled back; v_result still holds the preview
  END;

  PERFORM set_config('vireek.import_id', '', true);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_supplier_prices(
  p_vendor_id uuid,
  p_items jsonb,
  p_file_name text DEFAULT NULL,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN public._import_supplier_prices(public.get_account_owner_id(), p_vendor_id, 'csv', p_file_name, p_items, auth.uid(), NULL, COALESCE(p_dry_run, false));
END;
$$;

-- =============================================================
-- 13. SUPPLIER FEED KEYS (hashed client-side, same pattern as api_keys)
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_supplier_feed_key(
  p_vendor_id uuid,
  p_name text,
  p_key_prefix text,
  p_key_hash text,
  p_scopes text[] DEFAULT ARRAY['prices:write']::text[]
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_vendors v WHERE v.id = p_vendor_id AND v.user_id = v_owner) THEN
    RAISE EXCEPTION 'Unknown supplier';
  END IF;
  IF (SELECT COUNT(*) FROM supplier_feed_keys k WHERE k.vendor_id = p_vendor_id AND k.revoked_at IS NULL) >= 5 THEN
    RAISE EXCEPTION 'This supplier already has 5 active keys — revoke one first';
  END IF;
  INSERT INTO supplier_feed_keys (user_id, vendor_id, name, key_prefix, key_hash, scopes)
  VALUES (v_owner, p_vendor_id, btrim(p_name), p_key_prefix, lower(p_key_hash), COALESCE(p_scopes, ARRAY['prices:write']::text[]))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_supplier_feed_key(p_key_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE supplier_feed_keys SET revoked_at = now()
   WHERE id = p_key_id AND user_id = public.get_account_owner_id() AND revoked_at IS NULL;
END;
$$;

-- Edge-function helpers (service role only): fixed 60 s window, 60 requests per key.
CREATE OR REPLACE FUNCTION public._supplier_feed_touch(p_key_id uuid, p_limit integer DEFAULT 60)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE supplier_feed_keys SET
    window_started_at = CASE WHEN window_started_at < now() - interval '60 seconds' THEN now() ELSE window_started_at END,
    window_count = CASE WHEN window_started_at < now() - interval '60 seconds' THEN 1 ELSE window_count + 1 END,
    last_used_at = now()
  WHERE id = p_key_id AND revoked_at IS NULL
  RETURNING window_count INTO v_count;
  RETURN COALESCE(v_count, p_limit + 1) <= p_limit;
END;
$$;

-- Shipment update by PO number, scoped to the key's supplier.
CREATE OR REPLACE FUNCTION public._supplier_feed_shipment(
  p_key_id uuid,
  p_po_number text,
  p_carrier text,
  p_tracking_number text,
  p_tracking_url text,
  p_shipment_status text,
  p_expected_at date
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  k supplier_feed_keys%ROWTYPE;
  v_po uuid;
BEGIN
  SELECT * INTO k FROM supplier_feed_keys WHERE id = p_key_id AND revoked_at IS NULL;
  IF NOT FOUND OR NOT ('shipments:write' = ANY (k.scopes)) THEN
    RETURN jsonb_build_object('status', 'forbidden', 'reason', 'This key cannot update shipments.');
  END IF;
  SELECT id INTO v_po FROM purchase_orders
   WHERE user_id = k.user_id AND vendor_id = k.vendor_id AND po_number = btrim(p_po_number);
  IF v_po IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found', 'reason', 'Order not found for this supplier.');
  END IF;
  RETURN public._record_po_shipment(k.user_id, v_po, p_carrier, p_tracking_number, p_tracking_url, p_shipment_status, p_expected_at, 'supplier_feed');
END;
$$;

-- =============================================================
-- 14. VIEWS
-- =============================================================

CREATE OR REPLACE VIEW job_parts_orders
WITH (security_invoker = true) AS
SELECT
  plj.job_id,
  po.id AS purchase_order_id,
  po.po_number,
  po.status AS po_status,
  po.shipment_status,
  po.expected_at,
  po.original_expected_at,
  po.carrier,
  po.tracking_number,
  po.tracking_url,
  po.vendor_name,
  pol.id AS po_line_id,
  pol.part_id,
  p.name AS part_name,
  p.part_number,
  plj.quantity AS job_quantity,
  pol.quantity_ordered,
  pol.quantity_received,
  pol.unit_cost_cents
FROM purchase_order_line_jobs plj
JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
JOIN purchase_orders po ON po.id = pol.purchase_order_id
JOIN inventory_parts p ON p.id = pol.part_id;

-- Read path for the job page: any member of the account (technicians included) may see ETAs for the
-- account's jobs, even though purchase_orders itself is manager-only.
CREATE OR REPLACE FUNCTION public.get_job_parts_orders(p_job_id uuid)
RETURNS SETOF job_parts_orders
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT plj.job_id, po.id, po.po_number, po.status, po.shipment_status, po.expected_at, po.original_expected_at,
         po.carrier, po.tracking_number, po.tracking_url, po.vendor_name,
         pol.id, pol.part_id, p.name, p.part_number, plj.quantity, pol.quantity_ordered, pol.quantity_received, pol.unit_cost_cents
  FROM purchase_order_line_jobs plj
  JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
  JOIN purchase_orders po ON po.id = pol.purchase_order_id
  JOIN inventory_parts p ON p.id = pol.part_id
  WHERE plj.job_id = p_job_id
    AND plj.user_id = public.get_account_owner_id()
    AND po.status <> 'cancelled'
  ORDER BY po.created_at DESC, p.name;
$$;

CREATE OR REPLACE VIEW po_delivery_tracking
WITH (security_invoker = true) AS
SELECT
  po.id AS purchase_order_id,
  po.user_id,
  po.po_number,
  po.vendor_id,
  po.vendor_name,
  po.status,
  po.shipment_status,
  po.expected_at,
  po.original_expected_at,
  po.carrier,
  po.tracking_number,
  po.tracking_url,
  po.total_cents,
  po.sent_at,
  po.shipped_at,
  po.delivered_at,
  (po.expected_at IS NOT NULL AND po.expected_at < CURRENT_DATE AND po.status IN ('sent', 'partially_received')) AS is_late,
  CASE WHEN po.expected_at IS NOT NULL AND po.expected_at < CURRENT_DATE AND po.status IN ('sent', 'partially_received')
       THEN CURRENT_DATE - po.expected_at END AS days_late,
  CASE WHEN po.original_expected_at IS NOT NULL AND po.expected_at IS NOT NULL
       THEN po.expected_at - po.original_expected_at END AS eta_slip_days,
  (SELECT COUNT(DISTINCT plj.job_id) FROM purchase_order_line_jobs plj
     JOIN purchase_order_lines pol ON pol.id = plj.po_line_id WHERE pol.purchase_order_id = po.id) AS linked_job_count,
  (SELECT COUNT(DISTINCT plj.job_id) FROM purchase_order_line_jobs plj
     JOIN purchase_order_lines pol ON pol.id = plj.po_line_id
     JOIN jobs j ON j.id = plj.job_id AND j.job_status = 'waiting_on_parts'
    WHERE pol.purchase_order_id = po.id AND pol.quantity_received < pol.quantity_ordered) AS waiting_job_count
FROM purchase_orders po
WHERE po.status <> 'cancelled';

GRANT SELECT ON job_parts_orders, po_delivery_tracking TO authenticated;
REVOKE ALL ON FUNCTION public.get_job_parts_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_parts_orders(uuid) TO authenticated;

-- =============================================================
-- 15. GRANTS — public RPCs for signed-in users; cores for the service role only
-- =============================================================

REVOKE ALL ON FUNCTION public._vendor_lead_days(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._po_event(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._notify_owner(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ensure_part_for_catalog_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._job_parts_arrived(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._job_parts_eta(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._job_parts_ready(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._parse_cents(text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._record_po_shipment(uuid, uuid, text, text, text, text, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._import_supplier_prices(uuid, uuid, text, text, jsonb, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._supplier_feed_touch(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._supplier_feed_shipment(uuid, text, text, text, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sweep_late_po_deliveries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._import_supplier_prices(uuid, uuid, text, text, jsonb, uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public._supplier_feed_touch(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public._supplier_feed_shipment(uuid, text, text, text, text, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.sweep_late_po_deliveries(integer) TO service_role;

REVOKE ALL ON FUNCTION public.search_supplier_catalog(text, uuid, boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_to_parts_cart(uuid, integer, uuid, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_parts_cart_quantity(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_from_parts_cart(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_parts_orders_from_cart(uuid[], uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_po_shipment(uuid, text, text, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.import_supplier_prices(uuid, jsonb, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_supplier_feed_key(uuid, text, text, text, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_supplier_feed_key(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.job_parts_ready(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_supplier_catalog(text, uuid, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_to_parts_cart(uuid, integer, uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_parts_cart_quantity(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_from_parts_cart(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_parts_orders_from_cart(uuid[], uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_po_shipment(uuid, text, text, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_supplier_prices(uuid, jsonb, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_supplier_feed_key(uuid, text, text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_supplier_feed_key(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_parts_ready(uuid) TO authenticated;
