/*
  # Supplier PunchOut (cXML) — Ferguson / Grainger-style catalog shopping for purchase orders

  Flow (cXML 1.2 PunchOut):
    1. A manager opens a supplier's own web store from Vireek (edge fn `punchout-session`):
       Vireek sends a PunchOutSetupRequest with a one-time BuyerCookie and a return URL and gets a StartPage URL.
    2. The user shops on the supplier's site at THEIR negotiated prices and presses "Transfer cart".
    3. The supplier's browser POSTs a PunchOutOrderMessage to `punchout-return`, which stores the cart
       as a staging copy (supplier_punchout_sessions + supplier_punchout_lines) — nothing is ordered yet.
    4. The buyer reviews it in /dashboard/supplier-punchout (price changes vs. catalog are flagged) and
       `punchout_create_order()` turns it into a REAL purchase order on the existing truck-stock PO flow
       (purchase_orders / purchase_order_lines / purchase_order_line_jobs), so approval, receiving,
       inventory and job auto-resume keep working untouched.

  Builds ON TOP of 20271020000000_job_parts_ordering.sql. Nothing is dropped, renamed or rewritten.
  Additive and idempotent. The only change to an existing table is one nullable column on purchase_orders.

  ## Security model
    - Tenant isolation: every row carries user_id = account owner id; readable by managers of that account only.
    - Browser clients can only READ (RLS). Every write goes through SECURITY DEFINER RPCs or the edge functions.
    - Shared secrets live in supplier_punchout_secrets: AES-GCM ciphertext, no grants to anon/authenticated.
    - BuyerCookie is a 256-bit random value; only its SHA-256 hash is stored. The return endpoint is public
      (the supplier's browser posts to it) so the cookie is the only credential: single use, expires in 4 hours.
    - Prices come from the supplier's cart, never from the browser.

  ## Rollback (safe to leave in place)
    SELECT cron.unschedule('vireek-punchout-expire');   -- only if pg_cron is installed
*/

-- =============================================================
-- 0. PREFLIGHT
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.inventory_vendors') IS NULL
     OR to_regclass('public.supplier_catalog_items') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.purchase_order_lines') IS NULL
     OR to_regclass('public.purchase_order_line_jobs') IS NULL
     OR to_regclass('public.purchase_order_events') IS NULL
     OR to_regclass('public.inventory_locations') IS NULL
     OR to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'supplier_punchout: prerequisite tables missing. Apply 20271020000000_job_parts_ordering.sql first.';
  END IF;
  IF to_regprocedure('public.inventory_can_manage()') IS NULL
     OR to_regprocedure('public.get_account_owner_id()') IS NULL
     OR to_regprocedure('public._ensure_part_for_catalog_item(uuid)') IS NULL
     OR to_regprocedure('public._po_event(uuid,uuid,text,text,jsonb)') IS NULL
     OR to_regprocedure('public._vendor_lead_days(uuid)') IS NULL
     OR to_regprocedure('public.new_po_number()') IS NULL
     OR to_regprocedure('public.inventory_touch_updated_at()') IS NULL
     OR to_regprocedure('public.set_job_workflow_status(uuid,text,text,text,timestamptz)') IS NULL
     OR to_regprocedure('public.is_job_workflow_status(text)') IS NULL
     OR to_regprocedure('public._job_parts_eta(uuid)') IS NULL THEN
    RAISE EXCEPTION 'supplier_punchout: required helper functions are missing. Apply 20271020000000_job_parts_ordering.sql first.';
  END IF;
END $$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS supplier_punchout_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  protocol text NOT NULL DEFAULT 'cxml' CHECK (protocol IN ('cxml')),
  environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'production')),
  setup_url text NOT NULL CHECK (char_length(setup_url) <= 500 AND setup_url ~* '^https://[^/\s]+'),
  buyer_domain text NOT NULL DEFAULT 'NetworkID' CHECK (char_length(btrim(buyer_domain)) BETWEEN 1 AND 60),
  buyer_identity text NOT NULL CHECK (char_length(btrim(buyer_identity)) BETWEEN 1 AND 120),
  sender_domain text NOT NULL DEFAULT 'NetworkID' CHECK (char_length(btrim(sender_domain)) BETWEEN 1 AND 60),
  sender_identity text NOT NULL CHECK (char_length(btrim(sender_identity)) BETWEEN 1 AND 120),
  supplier_domain text NOT NULL DEFAULT 'NetworkID' CHECK (char_length(btrim(supplier_domain)) BETWEEN 1 AND 60),
  supplier_identity text NOT NULL CHECK (char_length(btrim(supplier_identity)) BETWEEN 1 AND 120),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  enabled boolean NOT NULL DEFAULT true,
  secret_set boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_message text CHECK (last_test_message IS NULL OR char_length(last_test_message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_punchout_conn_user ON supplier_punchout_connections (user_id);

CREATE TABLE IF NOT EXISTS supplier_punchout_secrets (
  connection_id uuid PRIMARY KEY REFERENCES supplier_punchout_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier_punchout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES supplier_punchout_connections(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
  started_by uuid DEFAULT auth.uid(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  destination_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  buyer_cookie_hash text NOT NULL UNIQUE CHECK (buyer_cookie_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'started', 'returned', 'ordered', 'cancelled', 'expired', 'failed')),
  currency text NOT NULL DEFAULT 'USD',
  supplier_total_cents bigint CHECK (supplier_total_cents IS NULL OR supplier_total_cents >= 0),
  line_count integer NOT NULL DEFAULT 0,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 300),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '4 hours',
  returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_punchout_sessions_user ON supplier_punchout_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_punchout_sessions_open ON supplier_punchout_sessions (expires_at) WHERE status IN ('pending', 'started');

CREATE TABLE IF NOT EXISTS supplier_punchout_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES supplier_punchout_sessions(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  sku text NOT NULL CHECK (char_length(btrim(sku)) BETWEEN 1 AND 80),
  aux_id text CHECK (aux_id IS NULL OR char_length(aux_id) <= 120),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  mpn text CHECK (mpn IS NULL OR char_length(mpn) <= 80),
  manufacturer text CHECK (manufacturer IS NULL OR char_length(manufacturer) <= 120),
  uom text NOT NULL DEFAULT 'each' CHECK (char_length(uom) BETWEEN 1 AND 20),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  classification text CHECK (classification IS NULL OR char_length(classification) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_punchout_lines_session ON supplier_punchout_lines (session_id);

-- Link a purchase order back to the punchout cart it came from (additive, nullable).
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS punchout_session_id uuid REFERENCES supplier_punchout_sessions(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS trg_punchout_conn_touch ON supplier_punchout_connections;
CREATE TRIGGER trg_punchout_conn_touch BEFORE UPDATE ON supplier_punchout_connections
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();
DROP TRIGGER IF EXISTS trg_punchout_session_touch ON supplier_punchout_sessions;
CREATE TRIGGER trg_punchout_session_touch BEFORE UPDATE ON supplier_punchout_sessions
  FOR EACH ROW EXECUTE FUNCTION public.inventory_touch_updated_at();

-- =============================================================
-- 2. RLS — managers read; all writes go through RPCs / edge functions
-- =============================================================

ALTER TABLE supplier_punchout_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_punchout_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_punchout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_punchout_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_punchout_connections_select ON supplier_punchout_connections;
CREATE POLICY supplier_punchout_connections_select ON supplier_punchout_connections FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage()));

DROP POLICY IF EXISTS supplier_punchout_sessions_select ON supplier_punchout_sessions;
CREATE POLICY supplier_punchout_sessions_select ON supplier_punchout_sessions FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage()));

DROP POLICY IF EXISTS supplier_punchout_lines_select ON supplier_punchout_lines;
CREATE POLICY supplier_punchout_lines_select ON supplier_punchout_lines FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.inventory_can_manage()));

-- No policy on secrets at all, plus no grants: only the service role (edge functions) can touch it.
REVOKE ALL ON supplier_punchout_secrets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON supplier_punchout_connections FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON supplier_punchout_sessions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON supplier_punchout_lines FROM anon, authenticated;
REVOKE ALL ON supplier_punchout_connections, supplier_punchout_sessions, supplier_punchout_lines FROM anon;

-- Review view: each cart line next to the catalog's current price (security_invoker: caller's RLS applies).
CREATE OR REPLACE VIEW supplier_punchout_line_review WITH (security_invoker = true) AS
SELECT l.id, l.session_id, l.line_no, l.sku, l.aux_id, l.name, l.description, l.mpn, l.manufacturer, l.uom,
       l.quantity, l.unit_price_cents, l.lead_time_days, l.classification,
       c.id AS catalog_item_id,
       c.unit_cost_cents AS catalog_cost_cents,
       c.active AS catalog_active
FROM supplier_punchout_lines l
JOIN supplier_punchout_sessions s ON s.id = l.session_id
LEFT JOIN supplier_catalog_items c ON c.vendor_id = s.vendor_id AND lower(c.sku) = lower(l.sku);

GRANT SELECT ON supplier_punchout_line_review TO authenticated;

-- =============================================================
-- 3. RPCs
-- =============================================================

-- 3a. Start a session (called by the edge function with the CALLER's JWT). Returns the session id.
CREATE OR REPLACE FUNCTION public.punchout_begin_session(
  p_connection uuid,
  p_cookie_hash text,
  p_job uuid DEFAULT NULL,
  p_dest uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c supplier_punchout_connections%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_cookie_hash IS NULL OR p_cookie_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid session token';
  END IF;

  SELECT * INTO c FROM supplier_punchout_connections WHERE id = p_connection AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown PunchOut connection'; END IF;
  IF NOT c.enabled THEN RAISE EXCEPTION 'This PunchOut connection is turned off'; END IF;
  IF NOT c.secret_set THEN RAISE EXCEPTION 'Add the shared secret for this connection first'; END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_vendors v WHERE v.id = c.vendor_id AND v.user_id = v_owner AND v.active) THEN
    RAISE EXCEPTION 'Supplier is inactive';
  END IF;
  IF p_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = p_job AND j.user_id = v_owner) THEN
    RAISE EXCEPTION 'Unknown job';
  END IF;
  IF p_dest IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_locations l WHERE l.id = p_dest AND l.user_id = v_owner AND l.active
  ) THEN
    RAISE EXCEPTION 'Unknown delivery location';
  END IF;
  IF (SELECT COUNT(*) FROM supplier_punchout_sessions s
      WHERE s.user_id = v_owner AND s.created_at > now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'Too many PunchOut sessions started. Try again in a few minutes';
  END IF;

  INSERT INTO supplier_punchout_sessions (user_id, connection_id, vendor_id, job_id, destination_location_id, buyer_cookie_hash, currency)
  VALUES (v_owner, c.id, c.vendor_id, p_job, p_dest, p_cookie_hash, c.currency)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 3b. Receive the cart posted back by the supplier. SERVICE ROLE ONLY (the public return endpoint).
-- Returns the session id, or NULL when the session is unknown / not open / expired.
CREATE OR REPLACE FUNCTION public.punchout_receive_cart(
  p_cookie_hash text,
  p_lines jsonb,
  p_total_cents bigint,
  p_currency text,
  p_payload_hash text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  s supplier_punchout_sessions%ROWTYPE;
  r record;
  v_n integer := 0;
BEGIN
  IF p_cookie_hash IS NULL OR p_cookie_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  IF p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid cart payload'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'Invalid cart payload'; END IF;
  IF jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'The cart is empty'; END IF;
  IF jsonb_array_length(p_lines) > 500 THEN RAISE EXCEPTION 'The cart has too many lines'; END IF;

  SELECT * INTO s FROM supplier_punchout_sessions WHERE buyer_cookie_hash = p_cookie_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Supplier double-submit of the identical cart is harmless.
  IF s.status = 'returned' AND s.payload_hash = p_payload_hash THEN RETURN s.id; END IF;
  -- A cart may be re-sent until it has been ordered or cancelled (the newest cart replaces the previous one).
  IF s.status NOT IN ('pending', 'started', 'returned') THEN RETURN NULL; END IF;
  IF s.status <> 'returned' AND s.expires_at < now() THEN
    UPDATE supplier_punchout_sessions SET status = 'expired' WHERE id = s.id;
    RETURN NULL;
  END IF;
  IF upper(COALESCE(p_currency, '')) <> s.currency THEN
    UPDATE supplier_punchout_sessions SET status = 'failed', error_message = 'Cart currency does not match the connection' WHERE id = s.id;
    RAISE EXCEPTION 'Currency mismatch';
  END IF;

  FOR r IN
    SELECT * FROM jsonb_to_recordset(p_lines) AS x(
      line_no integer, sku text, aux_id text, name text, description text, mpn text, manufacturer text,
      uom text, quantity numeric, unit_price_cents numeric, lead_time_days numeric, classification text)
  LOOP
    IF r.line_no IS NULL OR r.line_no < 1 OR r.line_no > 500
       OR r.sku IS NULL OR char_length(btrim(r.sku)) NOT BETWEEN 1 AND 80
       OR r.quantity IS NULL OR r.quantity < 1 OR r.quantity > 100000 OR r.quantity <> trunc(r.quantity)
       OR r.unit_price_cents IS NULL OR r.unit_price_cents < 0 OR r.unit_price_cents > 100000000
       OR r.unit_price_cents <> trunc(r.unit_price_cents)
       OR (r.lead_time_days IS NOT NULL AND (r.lead_time_days < 0 OR r.lead_time_days > 365 OR r.lead_time_days <> trunc(r.lead_time_days)))
    THEN
      RAISE EXCEPTION 'Invalid cart line %', COALESCE(r.line_no::text, '?');
    END IF;
  END LOOP;

  DELETE FROM supplier_punchout_lines WHERE session_id = s.id;
  INSERT INTO supplier_punchout_lines (user_id, session_id, line_no, sku, aux_id, name, description, mpn, manufacturer,
                                       uom, quantity, unit_price_cents, lead_time_days, classification)
  SELECT s.user_id, s.id, x.line_no, btrim(x.sku), left(NULLIF(btrim(x.aux_id), ''), 120),
         left(COALESCE(NULLIF(btrim(x.name), ''), btrim(x.sku)), 300),
         left(NULLIF(btrim(x.description), ''), 2000), left(NULLIF(btrim(x.mpn), ''), 80),
         left(NULLIF(btrim(x.manufacturer), ''), 120), left(COALESCE(NULLIF(btrim(x.uom), ''), 'each'), 20),
         x.quantity::integer, x.unit_price_cents::integer, x.lead_time_days::integer, left(NULLIF(btrim(x.classification), ''), 60)
  FROM jsonb_to_recordset(p_lines) AS x(
      line_no integer, sku text, aux_id text, name text, description text, mpn text, manufacturer text,
      uom text, quantity numeric, unit_price_cents numeric, lead_time_days numeric, classification text);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE supplier_punchout_sessions
     SET status = 'returned', returned_at = now(), line_count = v_n, payload_hash = p_payload_hash,
         supplier_total_cents = CASE WHEN p_total_cents IS NULL OR p_total_cents < 0 THEN NULL ELSE p_total_cents END,
         error_message = NULL
   WHERE id = s.id;
  RETURN s.id;
END;
$$;

-- 3c. Turn a reviewed cart into a purchase order.
CREATE OR REPLACE FUNCTION public.punchout_create_order(
  p_session uuid,
  p_hold_job boolean DEFAULT false,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s supplier_punchout_sessions%ROWTYPE;
  r record;
  v_vendor_name text;
  v_vendor_active boolean;
  v_dest uuid;
  v_threshold integer;
  v_status text;
  v_lead integer;
  v_total integer;
  v_po uuid;
  v_po_number text;
  v_item uuid;
  v_part uuid;
  v_line uuid;
  v_note text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_hold jsonb := jsonb_build_object('hold', 'not_requested');
  v_cur text;
  v_eta date;
  v_count integer;
  v_found boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Notes are too long (max 1000 characters)';
  END IF;

  -- Row lock: a double-click or two tabs cannot create two orders from one cart.
  SELECT * INTO s FROM supplier_punchout_sessions WHERE id = p_session AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PunchOut cart not found'; END IF;
  IF s.status = 'ordered' THEN RAISE EXCEPTION 'This cart has already been turned into an order'; END IF;
  IF s.status <> 'returned' THEN RAISE EXCEPTION 'This cart has not been sent back from the supplier yet'; END IF;

  SELECT v.name, v.active INTO v_vendor_name, v_vendor_active
  FROM inventory_vendors v WHERE v.id = s.vendor_id AND v.user_id = v_owner;
  IF NOT FOUND OR NOT v_vendor_active THEN RAISE EXCEPTION 'Supplier is inactive'; END IF;

  SELECT COUNT(*) INTO v_count FROM supplier_punchout_lines WHERE session_id = s.id;
  IF v_count = 0 THEN RAISE EXCEPTION 'The cart is empty'; END IF;

  v_dest := s.destination_location_id;
  IF v_dest IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_locations l WHERE l.id = v_dest AND l.user_id = v_owner AND l.active
  ) THEN
    v_dest := NULL;
  END IF;
  IF v_dest IS NULL THEN
    SELECT l.id INTO v_dest FROM inventory_locations l
    WHERE l.user_id = v_owner AND l.active AND l.location_type = 'warehouse'
    ORDER BY l.created_at LIMIT 1;
  END IF;
  IF v_dest IS NULL THEN
    RAISE EXCEPTION 'Create a warehouse location first (or pick a truck) so the order has somewhere to be received';
  END IF;

  SELECT COALESCE((SELECT st.po_approval_threshold_cents FROM replenishment_settings st WHERE st.user_id = v_owner), 50000)
    INTO v_threshold;
  SELECT COALESCE(MAX(l.lead_time_days), public._vendor_lead_days(s.vendor_id)) INTO v_lead
  FROM supplier_punchout_lines l WHERE l.session_id = s.id;
  v_lead := COALESCE(v_lead, 3);

  SELECT COALESCE(SUM(l.quantity::bigint * l.unit_price_cents), 0)::integer INTO v_total
  FROM supplier_punchout_lines l WHERE l.session_id = s.id;
  v_status := CASE WHEN v_total > v_threshold THEN 'pending_approval' ELSE 'draft' END;
  v_po_number := public.new_po_number();

  INSERT INTO purchase_orders (user_id, po_number, vendor_id, vendor_name, status, source, destination_location_id,
                               total_cents, expected_at, original_expected_at, notes, punchout_session_id)
  VALUES (v_owner, v_po_number, s.vendor_id, v_vendor_name, v_status, 'manual', v_dest,
          0, CURRENT_DATE + v_lead, CURRENT_DATE + v_lead,
          COALESCE(v_note, 'PunchOut cart from ' || v_vendor_name), s.id)
  RETURNING id INTO v_po;

  FOR r IN SELECT * FROM supplier_punchout_lines WHERE session_id = s.id ORDER BY line_no LOOP
    -- The supplier's price is the contract price: keep the catalog in step (the history trigger records the change).
    INSERT INTO supplier_catalog_items (user_id, vendor_id, sku, name, description, mpn, brand, uom, unit_cost_cents,
                                        lead_time_days, stock_status, source, last_imported_at)
    VALUES (v_owner, s.vendor_id, r.sku, r.name, r.description, r.mpn, r.manufacturer, r.uom, r.unit_price_cents,
            r.lead_time_days, 'in_stock', 'api', now())
    ON CONFLICT (vendor_id, lower(sku)) DO UPDATE
      SET unit_cost_cents = EXCLUDED.unit_cost_cents,
          lead_time_days = COALESCE(EXCLUDED.lead_time_days, supplier_catalog_items.lead_time_days),
          last_imported_at = now()
    RETURNING id INTO v_item;

    v_part := public._ensure_part_for_catalog_item(v_item);

    INSERT INTO purchase_order_lines (user_id, purchase_order_id, part_id, quantity_ordered, unit_cost_cents, catalog_item_id, vendor_sku)
    VALUES (v_owner, v_po, v_part, r.quantity, r.unit_price_cents, v_item, r.sku)
    ON CONFLICT (purchase_order_id, part_id) DO UPDATE
      SET quantity_ordered = purchase_order_lines.quantity_ordered + EXCLUDED.quantity_ordered,
          unit_cost_cents = LEAST(purchase_order_lines.unit_cost_cents, EXCLUDED.unit_cost_cents)
    RETURNING id INTO v_line;

    IF s.job_id IS NOT NULL THEN
      INSERT INTO purchase_order_line_jobs (user_id, po_line_id, job_id, quantity)
      VALUES (v_owner, v_line, s.job_id, r.quantity)
      ON CONFLICT (po_line_id, job_id) DO UPDATE SET quantity = purchase_order_line_jobs.quantity + EXCLUDED.quantity;
    END IF;
  END LOOP;

  UPDATE purchase_orders
     SET total_cents = COALESCE((SELECT SUM(pol.quantity_ordered::bigint * pol.unit_cost_cents)
                                 FROM purchase_order_lines pol WHERE pol.purchase_order_id = v_po), 0)::integer
   WHERE id = v_po;

  PERFORM public._po_event(v_po, v_owner, 'created',
    format('Order %s created from a %s PunchOut cart (%s)', v_po_number, v_vendor_name, v_status),
    jsonb_build_object('status', v_status, 'total_cents', v_total, 'punchout_session_id', s.id));

  UPDATE supplier_punchout_sessions SET status = 'ordered', purchase_order_id = v_po WHERE id = s.id;

  -- Optionally park the job until the parts arrive (same rules as ordering from the cart).
  IF s.job_id IS NOT NULL AND p_hold_job THEN
    SELECT j2.job_status INTO v_cur FROM jobs j2 WHERE j2.id = s.job_id AND j2.user_id = v_owner;
    v_found := FOUND;
    v_eta := public._job_parts_eta(s.job_id);
    IF NOT v_found OR v_cur IS NULL OR v_cur IN ('completed', 'cancelled', 'no_show') OR public.is_job_workflow_status(v_cur) THEN
      v_hold := jsonb_build_object('hold', 'skipped_status');
    ELSIF v_cur = 'waiting_on_parts' THEN
      v_hold := jsonb_build_object('hold', 'already_waiting');
    ELSE
      v_hold := public.set_job_workflow_status(
        s.job_id, 'waiting_on_parts', 'part_ordered',
        left('Parts ordered: ' || v_po_number, 1000),
        CASE WHEN v_eta IS NOT NULL AND ((v_eta::timestamp AT TIME ZONE 'UTC') + interval '1 day') > now() + interval '2 minutes'
             THEN (v_eta::timestamp AT TIME ZONE 'UTC') + interval '1 day' END
      );
      v_hold := jsonb_build_object('hold', COALESCE(v_hold ->> 'status', 'error'), 'reason', v_hold ->> 'reason');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'po_id', v_po, 'po_number', v_po_number, 'status', v_status, 'total_cents', v_total,
    'line_count', v_count, 'expected_at', CURRENT_DATE + v_lead, 'job', v_hold);
END;
$$;

-- 3d. Cancel a cart that has not been ordered.
CREATE OR REPLACE FUNCTION public.punchout_cancel_session(p_session uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE supplier_punchout_sessions SET status = 'cancelled'
   WHERE id = p_session AND user_id = v_owner AND status IN ('pending', 'started', 'returned');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This cart can no longer be cancelled';
  END IF;
END;
$$;

-- 3e. Housekeeping: open sessions past their expiry become `expired`; used carts are purged after 90 days.
CREATE OR REPLACE FUNCTION public.punchout_expire_sessions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE supplier_punchout_sessions SET status = 'expired'
   WHERE status IN ('pending', 'started') AND expires_at < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM supplier_punchout_sessions
   WHERE status IN ('expired', 'cancelled', 'failed') AND created_at < now() - interval '90 days';
  RETURN v_n;
END;
$$;

-- Function privileges: the browser gets exactly the RPCs it needs; the receiver is service-role only.
REVOKE ALL ON FUNCTION public.punchout_begin_session(uuid, text, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.punchout_receive_cart(text, jsonb, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.punchout_create_order(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.punchout_cancel_session(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.punchout_expire_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.punchout_begin_session(uuid, text, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.punchout_receive_cart(text, jsonb, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.punchout_create_order(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.punchout_cancel_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.punchout_expire_sessions() TO service_role;

-- Hourly sweep when pg_cron is installed (skipped silently otherwise).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-punchout-expire');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM cron.schedule('vireek-punchout-expire', '25 * * * *', 'select public.punchout_expire_sessions()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
