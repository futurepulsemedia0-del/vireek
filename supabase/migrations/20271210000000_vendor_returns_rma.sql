/*
  # Vendor Returns (RMA)  (/dashboard/inventory/rma)

  Return parts to a vendor: link the return to a purchase order line and/or the
  job usage it came from, record the reason, the vendor's RMA number, the ship
  status, the credit expected / received, and the inventory adjustment.

  - vendor_rmas        : one row per return (header, shipment, credit totals).
  - vendor_rma_lines   : parts returned. source = 'stock' (part is on a shelf/truck
                         and is removed from stock when the RMA ships) or
                         'installed' (a failed part already used on a job: no stock
                         movement, it is only claimed back).
  - vendor_rma_credits : credit memos / refunds received. Append-only, can be voided.
  - vendor_rma_events  : audit trail of every state change.
  - vendor_rma_counters: per-account sequence for RMA-00001 style numbers.

  Reuses: inventory_vendors, inventory_parts, inventory_locations, inventory_stock_levels,
  inventory_transactions (ledger), purchase_orders / purchase_order_lines, jobs.
  Stock moves ONLY through the ledger as 'adjustment' rows (so the existing stock cache
  trigger keeps inventory_stock_levels correct and demand forecasting, which only reads
  'usage'/'return' rows, is not distorted).

  Security: everything is scoped by public.get_account_owner_id(). Account members can
  read; every write goes through SECURITY DEFINER functions that require
  public.inventory_can_manage() (owner / admin). Tables have no direct write access.
  Additive only: nothing existing is altered or dropped.
*/

-- =============================================================
-- 0. PRECONDITIONS (fails early with a clear message, changes nothing)
-- =============================================================

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
  f text;
  c text;
  tbl text;
  col text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_vendors', 'inventory_parts', 'inventory_locations', 'inventory_stock_levels',
    'inventory_transactions', 'purchase_orders', 'purchase_order_lines', 'jobs'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN missing := missing || t::text; END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.get_account_owner_id()', 'public.inventory_can_manage()'] LOOP
    IF to_regprocedure(f) IS NULL THEN missing := missing || f::text; END IF;
  END LOOP;

  FOREACH c IN ARRAY ARRAY[
    'purchase_orders.vendor_id', 'purchase_orders.po_number', 'purchase_orders.user_id', 'purchase_orders.created_at',
    'purchase_orders.received_at', 'jobs.user_id', 'jobs.customer_name', 'jobs.service_type',
    'purchase_order_lines.purchase_order_id', 'purchase_order_lines.part_id', 'purchase_order_lines.user_id',
    'purchase_order_lines.quantity_received', 'purchase_order_lines.unit_cost_cents', 'purchase_order_lines.created_at',
    'inventory_parts.preferred_vendor_id', 'inventory_parts.unit_cost_cents',
    'inventory_stock_levels.quantity_reserved', 'inventory_transactions.unit_cost_cents'
  ] LOOP
    tbl := split_part(c, '.', 1);
    col := split_part(c, '.', 2);
    IF to_regclass('public.' || tbl) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = tbl AND column_name = col
    ) THEN
      missing := missing || c::text;
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Vendor returns (RMA) needs these objects first (apply the earlier inventory / job-parts-ordering migrations): %',
      array_to_string(missing, ', ');
  END IF;
END $$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS vendor_rma_counters (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vendor_rmas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  rma_number text NOT NULL CHECK (char_length(rma_number) BETWEEN 1 AND 40),
  vendor_rma_number text CHECK (vendor_rma_number IS NULL OR char_length(vendor_rma_number) BETWEEN 1 AND 80),
  vendor_id uuid NOT NULL REFERENCES inventory_vendors(id) ON DELETE RESTRICT,
  purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'authorized', 'shipped', 'received_by_vendor', 'resolved', 'closed', 'rejected', 'cancelled')),
  reason_code text NOT NULL
    CHECK (reason_code IN ('defective', 'dead_on_arrival', 'damaged_in_transit', 'wrong_item', 'over_shipped', 'warranty_failure', 'not_needed', 'other')),
  reason_notes text CHECK (reason_notes IS NULL OR char_length(reason_notes) <= 2000),
  resolution text NOT NULL DEFAULT 'credit' CHECK (resolution IN ('credit', 'refund', 'replacement')),
  ship_status text NOT NULL DEFAULT 'not_shipped'
    CHECK (ship_status IN ('not_shipped', 'shipped', 'in_transit', 'delivered', 'exception')),
  carrier text CHECK (carrier IS NULL OR char_length(carrier) <= 80),
  tracking_number text CHECK (tracking_number IS NULL OR char_length(tracking_number) <= 120),
  tracking_url text CHECK (tracking_url IS NULL OR (char_length(tracking_url) <= 500 AND tracking_url ~* '^https?://')),
  restocking_fee_cents integer NOT NULL DEFAULT 0 CHECK (restocking_fee_cents BETWEEN 0 AND 100000000),
  return_freight_cents integer NOT NULL DEFAULT 0 CHECK (return_freight_cents BETWEEN 0 AND 100000000),
  credit_expected_cents integer NOT NULL DEFAULT 0 CHECK (credit_expected_cents >= 0),
  credit_received_cents integer NOT NULL DEFAULT 0 CHECK (credit_received_cents >= 0),
  authorized_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  closed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, rma_number)
);

CREATE INDEX IF NOT EXISTS idx_vendor_rmas_user_status ON vendor_rmas (user_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_rmas_user_created ON vendor_rmas (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_rmas_vendor ON vendor_rmas (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_rmas_po ON vendor_rmas (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_rma_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  rma_id uuid NOT NULL REFERENCES vendor_rmas(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'stock' CHECK (source IN ('stock', 'installed')),
  location_id uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_credit_cents integer NOT NULL DEFAULT 0 CHECK (unit_credit_cents BETWEEN 0 AND 10000000),
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  purchase_order_line_id uuid REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  usage_transaction_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  serial_number text CHECK (serial_number IS NULL OR char_length(serial_number) <= 120),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  ship_transaction_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  inbound_transaction_id uuid REFERENCES inventory_transactions(id) ON DELETE SET NULL,
  quantity_replaced integer NOT NULL DEFAULT 0 CHECK (quantity_replaced >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rma_id, line_no),
  CHECK (source = 'installed' OR location_id IS NOT NULL),
  CHECK (quantity_replaced <= quantity)
);

CREATE INDEX IF NOT EXISTS idx_vendor_rma_lines_rma ON vendor_rma_lines (rma_id);
CREATE INDEX IF NOT EXISTS idx_vendor_rma_lines_part ON vendor_rma_lines (part_id);
CREATE INDEX IF NOT EXISTS idx_vendor_rma_lines_po_line ON vendor_rma_lines (purchase_order_line_id) WHERE purchase_order_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_rma_lines_usage ON vendor_rma_lines (usage_transaction_id) WHERE usage_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_rma_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  rma_id uuid NOT NULL REFERENCES vendor_rmas(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 2000000000),
  kind text NOT NULL DEFAULT 'credit_memo' CHECK (kind IN ('credit_memo', 'refund', 'other')),
  reference text CHECK (reference IS NULL OR char_length(reference) <= 120),
  received_on date NOT NULL DEFAULT current_date,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_rma_credits_rma ON vendor_rma_credits (rma_id, created_at);

CREATE TABLE IF NOT EXISTS vendor_rma_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  rma_id uuid NOT NULL REFERENCES vendor_rmas(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 40),
  from_status text,
  to_status text,
  message text CHECK (message IS NULL OR char_length(message) <= 500),
  amount_cents integer,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_rma_events_rma ON vendor_rma_events (rma_id, created_at);

-- =============================================================
-- 2. ROW LEVEL SECURITY: members read, nobody writes directly
-- =============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_rmas', 'vendor_rma_lines', 'vendor_rma_credits', 'vendor_rma_events', 'vendor_rma_counters'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['vendor_rmas', 'vendor_rma_lines', 'vendor_rma_credits', 'vendor_rma_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_member_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (user_id = (SELECT public.get_account_owner_id()))',
      t || '_member_read', t
    );
  END LOOP;

  -- Defence in depth: even with a policy mistake, clients cannot write these tables.
  FOREACH t IN ARRAY ARRAY['vendor_rmas', 'vendor_rma_lines', 'vendor_rma_credits', 'vendor_rma_events', 'vendor_rma_counters'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
  END LOOP;
  REVOKE ALL ON public.vendor_rma_counters FROM authenticated;
END $$;

-- =============================================================
-- 3. INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.vendor_rma_assert_manager()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.inventory_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to manage vendor returns.' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_rma_uuid(p text)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(p) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'A line contains an invalid reference.' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p)::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_rma_nonneg_int(p text, p_label text, p_max integer)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_ok boolean := true;
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(p) !~ '^[0-9]{1,9}$' THEN
    v_ok := false;
  ELSIF btrim(p)::bigint > p_max THEN
    v_ok := false;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION '% must be a whole number between 0 and %.', p_label, p_max USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p)::integer;
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_rma_next_number(p_owner uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO vendor_rma_counters AS c (user_id, last_number)
  VALUES (p_owner, 1)
  ON CONFLICT (user_id) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO v_n;
  RETURN 'RMA-' || lpad(v_n::text, 5, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_rma_log(
  p_owner uuid, p_rma_id uuid, p_type text, p_from text, p_to text, p_message text, p_amount integer
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO vendor_rma_events (user_id, rma_id, event_type, from_status, to_status, message, amount_cents, created_by)
  VALUES (p_owner, p_rma_id, p_type, p_from, p_to, left(p_message, 500), p_amount, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_rma_lock(p_owner uuid, p_rma_id uuid)
RETURNS vendor_rmas
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r vendor_rmas;
BEGIN
  SELECT * INTO r FROM vendor_rmas WHERE id = p_rma_id AND user_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That vendor return could not be found.' USING ERRCODE = 'P0002';
  END IF;
  RETURN r;
END;
$$;

-- Units of a PO line / usage ledger row already claimed by other live returns.
-- Callable by members (the list functions below run as the caller) but only ever
-- answers for the caller's own account.
CREATE OR REPLACE FUNCTION public.vendor_rma_committed_qty(p_owner uuid, p_po_line uuid, p_usage_tx uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(SUM(l.quantity), 0)::integer
    FROM vendor_rma_lines l
    JOIN vendor_rmas r ON r.id = l.rma_id
   WHERE p_owner = public.get_account_owner_id()
     AND l.user_id = p_owner
     AND r.status NOT IN ('cancelled', 'rejected')
     AND (
       (p_po_line IS NOT NULL AND l.purchase_order_line_id = p_po_line)
       OR (p_usage_tx IS NOT NULL AND l.usage_transaction_id = p_usage_tx)
     );
$$;

-- =============================================================
-- 4. save_vendor_rma : create or edit (draft / authorized only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_vendor_rma(
  p_rma_id uuid,
  p_vendor_id uuid,
  p_purchase_order_id uuid,
  p_reason_code text,
  p_reason_notes text,
  p_resolution text,
  p_restocking_fee_cents integer,
  p_vendor_rma_number text,
  p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_id uuid;
  v_reason text := lower(btrim(COALESCE(p_reason_code, '')));
  v_resolution text := lower(btrim(COALESCE(p_resolution, 'credit')));
  v_fee integer := COALESCE(p_restocking_fee_cents, 0);
  v_vnum text := NULLIF(btrim(COALESCE(p_vendor_rma_number, '')), '');
  v_notes text := NULLIF(btrim(COALESCE(p_reason_notes, '')), '');
  v_line jsonb;
  v_no integer := 0;
  v_part uuid;
  v_src text;
  v_loc uuid;
  v_qty integer;
  v_credit integer;
  v_cost integer;
  v_po_line uuid;
  v_usage uuid;
  v_job uuid;
  v_serial text;
  v_note text;
  v_pol purchase_order_lines;
  v_tx inventory_transactions;
  v_part_cost integer;
  v_remaining integer;
  v_total bigint := 0;
  v_expected integer;
BEGIN
  IF p_vendor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM inventory_vendors v WHERE v.id = p_vendor_id AND v.user_id = v_owner
  ) THEN
    RAISE EXCEPTION 'Choose a vendor.' USING ERRCODE = '22023';
  END IF;
  IF v_reason NOT IN ('defective', 'dead_on_arrival', 'damaged_in_transit', 'wrong_item', 'over_shipped', 'warranty_failure', 'not_needed', 'other') THEN
    RAISE EXCEPTION 'Choose a return reason.' USING ERRCODE = '22023';
  END IF;
  IF v_resolution NOT IN ('credit', 'refund', 'replacement') THEN
    RAISE EXCEPTION 'Choose what you expect from the vendor: credit, refund or replacement.' USING ERRCODE = '22023';
  END IF;
  IF v_fee < 0 OR v_fee > 100000000 THEN
    RAISE EXCEPTION 'The restocking fee is out of range.' USING ERRCODE = '22023';
  END IF;
  IF v_vnum IS NOT NULL AND char_length(v_vnum) > 80 THEN
    RAISE EXCEPTION 'The vendor RMA number is too long (80 characters max).' USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'The notes are too long (2000 characters max).' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Add at least one part to return.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) < 1 OR jsonb_array_length(p_lines) > 100 THEN
    RAISE EXCEPTION 'A return needs between 1 and 100 lines.' USING ERRCODE = '22023';
  END IF;

  IF p_purchase_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_orders po
     WHERE po.id = p_purchase_order_id AND po.user_id = v_owner AND po.vendor_id = p_vendor_id
  ) THEN
    RAISE EXCEPTION 'That purchase order does not belong to this vendor.' USING ERRCODE = '22023';
  END IF;

  IF p_rma_id IS NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO vendor_rmas (
      id, user_id, rma_number, vendor_rma_number, vendor_id, purchase_order_id,
      reason_code, reason_notes, resolution, restocking_fee_cents, created_by
    ) VALUES (
      v_id, v_owner, public.vendor_rma_next_number(v_owner), v_vnum, p_vendor_id, p_purchase_order_id,
      v_reason, v_notes, v_resolution, v_fee, auth.uid()
    );
  ELSE
    v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
    IF v_rma.status NOT IN ('draft', 'authorized') THEN
      RAISE EXCEPTION 'Only draft or authorized returns can be edited.' USING ERRCODE = '22023';
    END IF;
    IF v_rma.status = 'authorized' AND v_rma.vendor_id <> p_vendor_id THEN
      RAISE EXCEPTION 'The vendor cannot be changed after the return is authorized.' USING ERRCODE = '22023';
    END IF;
    v_id := v_rma.id;
    UPDATE vendor_rmas
       SET vendor_id = p_vendor_id,
           purchase_order_id = p_purchase_order_id,
           vendor_rma_number = COALESCE(v_vnum, vendor_rma_number),
           reason_code = v_reason,
           reason_notes = v_notes,
           resolution = v_resolution,
           restocking_fee_cents = v_fee,
           updated_at = now()
     WHERE id = v_id;
    DELETE FROM vendor_rma_lines WHERE rma_id = v_id;
  END IF;

  FOR v_line IN SELECT e.value FROM jsonb_array_elements(p_lines) AS e(value) LOOP
    v_no := v_no + 1;
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Line % is not valid.', v_no USING ERRCODE = '22023';
    END IF;

    v_part := public.vendor_rma_uuid(v_line ->> 'part_id');
    v_po_line := public.vendor_rma_uuid(v_line ->> 'purchase_order_line_id');
    v_usage := public.vendor_rma_uuid(v_line ->> 'usage_transaction_id');
    v_job := public.vendor_rma_uuid(v_line ->> 'job_id');
    v_loc := public.vendor_rma_uuid(v_line ->> 'location_id');
    v_src := lower(btrim(COALESCE(v_line ->> 'source', 'stock')));
    v_serial := NULLIF(btrim(COALESCE(v_line ->> 'serial_number', '')), '');
    v_note := NULLIF(btrim(COALESCE(v_line ->> 'note', '')), '');
    v_qty := public.vendor_rma_nonneg_int(v_line ->> 'quantity', 'Quantity', 100000);

    IF v_part IS NULL THEN
      RAISE EXCEPTION 'Line %: choose a part.', v_no USING ERRCODE = '22023';
    END IF;
    IF v_qty IS NULL OR v_qty < 1 THEN
      RAISE EXCEPTION 'Line %: quantity must be at least 1.', v_no USING ERRCODE = '22023';
    END IF;
    IF v_src NOT IN ('stock', 'installed') THEN
      RAISE EXCEPTION 'Line %: choose whether the part is in stock or already installed.', v_no USING ERRCODE = '22023';
    END IF;
    IF v_serial IS NOT NULL AND char_length(v_serial) > 120 THEN
      RAISE EXCEPTION 'Line %: the serial number is too long.', v_no USING ERRCODE = '22023';
    END IF;
    IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
      RAISE EXCEPTION 'Line %: the note is too long.', v_no USING ERRCODE = '22023';
    END IF;

    SELECT p.unit_cost_cents INTO v_part_cost FROM inventory_parts p WHERE p.id = v_part AND p.user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line %: that part could not be found.', v_no USING ERRCODE = '22023';
    END IF;
    v_cost := v_part_cost;

    IF v_loc IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM inventory_locations x WHERE x.id = v_loc AND x.user_id = v_owner
    ) THEN
      RAISE EXCEPTION 'Line %: that stock location could not be found.', v_no USING ERRCODE = '22023';
    END IF;
    IF v_src = 'stock' AND v_loc IS NULL THEN
      RAISE EXCEPTION 'Line %: choose the stock location the part is returned from.', v_no USING ERRCODE = '22023';
    END IF;
    IF v_resolution = 'replacement' AND v_loc IS NULL THEN
      RAISE EXCEPTION 'Line %: choose where the replacement will be received.', v_no USING ERRCODE = '22023';
    END IF;

    IF v_po_line IS NOT NULL THEN
      SELECT * INTO v_pol FROM purchase_order_lines x WHERE x.id = v_po_line AND x.user_id = v_owner;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Line %: that purchase order line could not be found.', v_no USING ERRCODE = '22023';
      END IF;
      IF v_pol.part_id <> v_part THEN
        RAISE EXCEPTION 'Line %: the purchase order line is for a different part.', v_no USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM purchase_orders po
         WHERE po.id = v_pol.purchase_order_id AND po.user_id = v_owner AND po.vendor_id = p_vendor_id
      ) THEN
        RAISE EXCEPTION 'Line %: the purchase order belongs to a different vendor.', v_no USING ERRCODE = '22023';
      END IF;
      v_remaining := v_pol.quantity_received - public.vendor_rma_committed_qty(v_owner, v_po_line, NULL);
      IF v_qty > v_remaining THEN
        RAISE EXCEPTION 'Line %: only % unit(s) of that purchase order line can still be returned.', v_no, GREATEST(v_remaining, 0)
          USING ERRCODE = '22023';
      END IF;
      v_cost := v_pol.unit_cost_cents;
    END IF;

    IF v_usage IS NOT NULL THEN
      SELECT * INTO v_tx FROM inventory_transactions x WHERE x.id = v_usage AND x.user_id = v_owner;
      IF NOT FOUND OR v_tx.transaction_type <> 'usage' THEN
        RAISE EXCEPTION 'Line %: that part usage record could not be found.', v_no USING ERRCODE = '22023';
      END IF;
      IF v_tx.part_id <> v_part THEN
        RAISE EXCEPTION 'Line %: the usage record is for a different part.', v_no USING ERRCODE = '22023';
      END IF;
      IF v_src <> 'installed' THEN
        RAISE EXCEPTION 'Line %: a part that was used on a job is an installed part, not stock.', v_no USING ERRCODE = '22023';
      END IF;
      v_remaining := abs(v_tx.quantity_delta) - public.vendor_rma_committed_qty(v_owner, NULL, v_usage);
      IF v_qty > v_remaining THEN
        RAISE EXCEPTION 'Line %: only % unit(s) of that usage can still be returned.', v_no, GREATEST(v_remaining, 0)
          USING ERRCODE = '22023';
      END IF;
      v_job := COALESCE(v_tx.job_id, v_job);
      IF v_po_line IS NULL AND v_tx.unit_cost_cents IS NOT NULL THEN
        v_cost := v_tx.unit_cost_cents;
      END IF;
    END IF;

    IF v_job IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jobs j WHERE j.id = v_job AND j.user_id = v_owner
    ) THEN
      RAISE EXCEPTION 'Line %: that job could not be found.', v_no USING ERRCODE = '22023';
    END IF;

    v_credit := public.vendor_rma_nonneg_int(v_line ->> 'unit_credit_cents', 'Credit per unit', 10000000);
    IF v_credit IS NULL THEN
      v_credit := v_cost;
    END IF;

    INSERT INTO vendor_rma_lines (
      user_id, rma_id, line_no, part_id, source, location_id, quantity, unit_credit_cents, unit_cost_cents,
      purchase_order_line_id, usage_transaction_id, job_id, serial_number, note
    ) VALUES (
      v_owner, v_id, v_no, v_part, v_src, v_loc, v_qty, v_credit, v_cost,
      v_po_line, v_usage, v_job, v_serial, v_note
    );

    v_total := v_total + (v_qty::bigint * v_credit::bigint);
  END LOOP;

  IF v_total > 2000000000 THEN
    RAISE EXCEPTION 'The credit total is too large.' USING ERRCODE = '22023';
  END IF;

  v_expected := CASE
    WHEN v_resolution = 'replacement' THEN 0
    ELSE GREATEST(v_total - v_fee::bigint, 0)::integer
  END;

  UPDATE vendor_rmas SET credit_expected_cents = v_expected, updated_at = now() WHERE id = v_id;

  IF p_rma_id IS NULL THEN
    PERFORM public.vendor_rma_log(v_owner, v_id, 'created', NULL, 'draft', 'Created with ' || v_no || ' line(s).', v_expected);
  ELSE
    PERFORM public.vendor_rma_log(v_owner, v_id, 'edited', v_rma.status, v_rma.status, 'Edited (' || v_no || ' line(s)).', v_expected);
  END IF;

  RETURN v_id;
END;
$$;

-- =============================================================
-- 5. WORKFLOW
-- =============================================================

CREATE OR REPLACE FUNCTION public.authorize_vendor_rma(p_rma_id uuid, p_vendor_rma_number text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_num text := NULLIF(btrim(COALESCE(p_vendor_rma_number, '')), '');
BEGIN
  IF v_num IS NULL THEN
    RAISE EXCEPTION 'Enter the RMA number the vendor gave you.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_num) > 80 THEN
    RAISE EXCEPTION 'The vendor RMA number is too long (80 characters max).' USING ERRCODE = '22023';
  END IF;
  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft return can be authorized.' USING ERRCODE = '22023';
  END IF;
  UPDATE vendor_rmas
     SET status = 'authorized', vendor_rma_number = v_num, authorized_at = now(), updated_at = now()
   WHERE id = v_rma.id;
  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'authorized', 'draft', 'authorized', 'Vendor RMA number ' || v_num || '.', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.ship_vendor_rma(
  p_rma_id uuid,
  p_carrier text,
  p_tracking_number text,
  p_tracking_url text,
  p_return_freight_cents integer
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_carrier text := NULLIF(btrim(COALESCE(p_carrier, '')), '');
  v_track text := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_url text := NULLIF(btrim(COALESCE(p_tracking_url, '')), '');
  v_freight integer := COALESCE(p_return_freight_cents, 0);
  g record;
  l record;
  v_avail integer;
  v_pname text;
  v_lname text;
  v_tx uuid;
  v_units integer := 0;
BEGIN
  IF v_carrier IS NOT NULL AND char_length(v_carrier) > 80 THEN
    RAISE EXCEPTION 'The carrier name is too long.' USING ERRCODE = '22023';
  END IF;
  IF v_track IS NOT NULL AND char_length(v_track) > 120 THEN
    RAISE EXCEPTION 'The tracking number is too long.' USING ERRCODE = '22023';
  END IF;
  IF v_url IS NOT NULL AND (char_length(v_url) > 500 OR v_url !~* '^https?://') THEN
    RAISE EXCEPTION 'The tracking link must start with http:// or https://.' USING ERRCODE = '22023';
  END IF;
  IF v_freight < 0 OR v_freight > 100000000 THEN
    RAISE EXCEPTION 'The freight cost is out of range.' USING ERRCODE = '22023';
  END IF;

  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status NOT IN ('draft', 'authorized') THEN
    RAISE EXCEPTION 'This return has already shipped or is no longer open.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vendor_rma_lines x WHERE x.rma_id = v_rma.id) THEN
    RAISE EXCEPTION 'This return has no lines.' USING ERRCODE = '22023';
  END IF;

  -- 1) Check availability for every (part, location) first, locking the stock rows in a fixed order.
  FOR g IN
    SELECT x.part_id, x.location_id, SUM(x.quantity)::integer AS need
      FROM vendor_rma_lines x
     WHERE x.rma_id = v_rma.id AND x.source = 'stock'
     GROUP BY x.part_id, x.location_id
     ORDER BY x.part_id, x.location_id
  LOOP
    SELECT s.quantity_on_hand - s.quantity_reserved INTO v_avail
      FROM inventory_stock_levels s
     WHERE s.part_id = g.part_id AND s.location_id = g.location_id AND s.user_id = v_owner
       FOR UPDATE;
    IF COALESCE(v_avail, 0) < g.need THEN
      SELECT p.name INTO v_pname FROM inventory_parts p WHERE p.id = g.part_id;
      SELECT lo.name INTO v_lname FROM inventory_locations lo WHERE lo.id = g.location_id;
      RAISE EXCEPTION 'Only % of "%" available at % (% needed).',
        GREATEST(COALESCE(v_avail, 0), 0), COALESCE(v_pname, 'part'), COALESCE(v_lname, 'location'), g.need
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 2) Remove the stock through the ledger (the stock cache is maintained by its trigger).
  FOR l IN
    SELECT x.id, x.part_id, x.location_id, x.quantity, x.unit_cost_cents
      FROM vendor_rma_lines x
     WHERE x.rma_id = v_rma.id AND x.source = 'stock'
     ORDER BY x.line_no
  LOOP
    INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
    VALUES (v_owner, l.part_id, l.location_id, 'adjustment', -l.quantity, l.unit_cost_cents,
            left('Vendor return ' || v_rma.rma_number || ' shipped', 500))
    RETURNING id INTO v_tx;
    UPDATE vendor_rma_lines SET ship_transaction_id = v_tx WHERE id = l.id;
    v_units := v_units + l.quantity;
  END LOOP;

  UPDATE vendor_rmas
     SET status = 'shipped',
         ship_status = 'shipped',
         shipped_at = now(),
         carrier = v_carrier,
         tracking_number = v_track,
         tracking_url = v_url,
         return_freight_cents = v_freight,
         updated_at = now()
   WHERE id = v_rma.id;

  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'shipped', v_rma.status, 'shipped',
    'Shipped. ' || v_units || ' unit(s) removed from stock.', NULL);
  RETURN v_units;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_vendor_rma_shipment(
  p_rma_id uuid,
  p_ship_status text,
  p_carrier text,
  p_tracking_number text,
  p_tracking_url text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_ship text := lower(btrim(COALESCE(p_ship_status, '')));
  v_carrier text := NULLIF(btrim(COALESCE(p_carrier, '')), '');
  v_track text := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_url text := NULLIF(btrim(COALESCE(p_tracking_url, '')), '');
  v_status text;
BEGIN
  IF v_ship NOT IN ('shipped', 'in_transit', 'delivered', 'exception') THEN
    RAISE EXCEPTION 'Choose a valid shipment status.' USING ERRCODE = '22023';
  END IF;
  IF v_carrier IS NOT NULL AND char_length(v_carrier) > 80 THEN
    RAISE EXCEPTION 'The carrier name is too long.' USING ERRCODE = '22023';
  END IF;
  IF v_track IS NOT NULL AND char_length(v_track) > 120 THEN
    RAISE EXCEPTION 'The tracking number is too long.' USING ERRCODE = '22023';
  END IF;
  IF v_url IS NOT NULL AND (char_length(v_url) > 500 OR v_url !~* '^https?://') THEN
    RAISE EXCEPTION 'The tracking link must start with http:// or https://.' USING ERRCODE = '22023';
  END IF;

  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status NOT IN ('shipped', 'received_by_vendor') THEN
    RAISE EXCEPTION 'Shipment details can only be updated while the return is shipped or received by the vendor.' USING ERRCODE = '22023';
  END IF;

  v_status := CASE
    WHEN v_ship = 'delivered' THEN 'received_by_vendor'
    ELSE 'shipped'
  END;

  UPDATE vendor_rmas
     SET ship_status = v_ship,
         status = v_status,
         carrier = COALESCE(v_carrier, carrier),
         tracking_number = COALESCE(v_track, tracking_number),
         tracking_url = COALESCE(v_url, tracking_url),
         delivered_at = CASE WHEN v_ship = 'delivered' THEN COALESCE(delivered_at, now()) ELSE NULL END,
         updated_at = now()
   WHERE id = v_rma.id;

  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'shipment_updated', v_rma.status, v_status, 'Shipment status: ' || v_ship || '.', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_vendor_rma_credit(
  p_rma_id uuid,
  p_amount_cents integer,
  p_kind text,
  p_reference text,
  p_received_on date,
  p_note text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_kind text := lower(btrim(COALESCE(p_kind, 'credit_memo')));
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_date date := COALESCE(p_received_on, current_date);
  v_id uuid;
  v_received bigint;
  v_status text;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents < 1 OR p_amount_cents > 2000000000 THEN
    RAISE EXCEPTION 'Enter a credit amount greater than zero.' USING ERRCODE = '22023';
  END IF;
  IF v_kind NOT IN ('credit_memo', 'refund', 'other') THEN
    RAISE EXCEPTION 'Choose a valid credit type.' USING ERRCODE = '22023';
  END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 120 THEN
    RAISE EXCEPTION 'The reference is too long.' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note is too long.' USING ERRCODE = '22023';
  END IF;
  IF v_date > current_date + 1 THEN
    RAISE EXCEPTION 'The received date cannot be in the future.' USING ERRCODE = '22023';
  END IF;

  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status NOT IN ('shipped', 'received_by_vendor', 'resolved') THEN
    RAISE EXCEPTION 'Credit can only be recorded after the return has shipped.' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(c.amount_cents), 0)::bigint + p_amount_cents INTO v_received
    FROM vendor_rma_credits c
   WHERE c.rma_id = v_rma.id AND c.voided_at IS NULL;
  IF v_received > 2000000000 THEN
    RAISE EXCEPTION 'The total credit is too large.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO vendor_rma_credits (user_id, rma_id, amount_cents, kind, reference, received_on, note, created_by)
  VALUES (v_owner, v_rma.id, p_amount_cents, v_kind, v_ref, v_date, v_note, auth.uid())
  RETURNING id INTO v_id;

  v_status := v_rma.status;
  IF v_rma.status IN ('shipped', 'received_by_vendor')
     AND v_rma.resolution <> 'replacement'
     AND v_received >= v_rma.credit_expected_cents THEN
    v_status := 'resolved';
  END IF;

  UPDATE vendor_rmas
     SET credit_received_cents = v_received::integer, status = v_status, updated_at = now()
   WHERE id = v_rma.id;

  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'credit_recorded', v_rma.status, v_status,
    COALESCE(v_ref, 'Credit received') || '.', p_amount_cents);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_vendor_rma_credit(p_credit_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_credit vendor_rma_credits;
  v_rma vendor_rmas;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_received bigint;
  v_status text;
BEGIN
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason is too long.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_credit FROM vendor_rma_credits WHERE id = p_credit_id AND user_id = v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That credit could not be found.' USING ERRCODE = 'P0002';
  END IF;
  v_rma := public.vendor_rma_lock(v_owner, v_credit.rma_id);
  IF v_rma.status = 'closed' THEN
    RAISE EXCEPTION 'A closed return cannot be changed.' USING ERRCODE = '22023';
  END IF;
  -- Re-read under the RMA lock so two people voiding at once cannot both succeed.
  SELECT * INTO v_credit FROM vendor_rma_credits WHERE id = p_credit_id;
  IF v_credit.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'That credit was already voided.' USING ERRCODE = '22023';
  END IF;

  UPDATE vendor_rma_credits SET voided_at = now(), void_reason = v_reason WHERE id = v_credit.id;

  SELECT COALESCE(SUM(c.amount_cents), 0)::bigint INTO v_received
    FROM vendor_rma_credits c
   WHERE c.rma_id = v_rma.id AND c.voided_at IS NULL;

  v_status := v_rma.status;
  IF v_rma.status = 'resolved' AND v_rma.resolution <> 'replacement' AND v_received < v_rma.credit_expected_cents THEN
    v_status := CASE WHEN v_rma.ship_status = 'delivered' THEN 'received_by_vendor' ELSE 'shipped' END;
  END IF;

  UPDATE vendor_rmas
     SET credit_received_cents = v_received::integer, status = v_status, updated_at = now()
   WHERE id = v_rma.id;

  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'credit_voided', v_rma.status, v_status,
    COALESCE(v_reason, 'Credit voided') || '.', -v_credit.amount_cents);
END;
$$;

CREATE OR REPLACE FUNCTION public.receive_vendor_rma_replacement(p_rma_id uuid, p_lines jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  l record;
  v_open integer;
  v_req integer;
  v_qty integer;
  v_tx uuid;
  v_total integer := 0;
  v_done boolean;
  v_status text;
BEGIN
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The replacement lines are not valid.' USING ERRCODE = '22023';
  END IF;

  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.resolution <> 'replacement' THEN
    RAISE EXCEPTION 'This return is not set up for a replacement.' USING ERRCODE = '22023';
  END IF;
  IF v_rma.status NOT IN ('shipped', 'received_by_vendor') THEN
    RAISE EXCEPTION 'A replacement can only be received after the return has shipped.' USING ERRCODE = '22023';
  END IF;

  FOR l IN
    SELECT x.id, x.part_id, x.location_id, x.quantity, x.quantity_replaced, x.unit_cost_cents
      FROM vendor_rma_lines x
     WHERE x.rma_id = v_rma.id
     ORDER BY x.line_no
  LOOP
    v_open := l.quantity - l.quantity_replaced;
    CONTINUE WHEN v_open <= 0;
    IF p_lines IS NULL THEN
      v_qty := v_open;
    ELSE
      SELECT COALESCE(SUM(public.vendor_rma_nonneg_int(e.value ->> 'quantity', 'Quantity', 100000)), 0)::integer INTO v_req
        FROM jsonb_array_elements(p_lines) AS e(value)
       WHERE public.vendor_rma_uuid(e.value ->> 'line_id') = l.id;
      v_qty := LEAST(v_req, v_open);
    END IF;
    CONTINUE WHEN v_qty <= 0;

    INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
    VALUES (v_owner, l.part_id, l.location_id, 'adjustment', v_qty, l.unit_cost_cents,
            left('Vendor return ' || v_rma.rma_number || ' replacement received', 500))
    RETURNING id INTO v_tx;
    UPDATE vendor_rma_lines
       SET quantity_replaced = quantity_replaced + v_qty, inbound_transaction_id = v_tx
     WHERE id = l.id;
    v_total := v_total + v_qty;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'There is nothing to receive.' USING ERRCODE = '22023';
  END IF;

  v_done := NOT EXISTS (
    SELECT 1 FROM vendor_rma_lines x WHERE x.rma_id = v_rma.id AND x.quantity_replaced < x.quantity
  );
  v_status := CASE WHEN v_done THEN 'resolved' ELSE v_rma.status END;

  UPDATE vendor_rmas SET status = v_status, updated_at = now() WHERE id = v_rma.id;
  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'replacement_received', v_rma.status, v_status,
    v_total || ' replacement unit(s) added to stock.', NULL);
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_vendor_rma(p_rma_id uuid, p_restock boolean, p_note text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  l record;
  v_tx uuid;
  v_units integer := 0;
BEGIN
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note is too long.' USING ERRCODE = '22023';
  END IF;
  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status NOT IN ('draft', 'authorized', 'shipped', 'received_by_vendor') THEN
    RAISE EXCEPTION 'This return can no longer be rejected.' USING ERRCODE = '22023';
  END IF;
  IF v_rma.credit_received_cents > 0 THEN
    RAISE EXCEPTION 'Void the recorded credit before rejecting this return.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM vendor_rma_lines x WHERE x.rma_id = v_rma.id AND x.quantity_replaced > 0) THEN
    RAISE EXCEPTION 'Replacement units were already received for this return.' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_restock, false) THEN
    FOR l IN
      SELECT x.id, x.part_id, x.location_id, x.quantity, x.unit_cost_cents
        FROM vendor_rma_lines x
       WHERE x.rma_id = v_rma.id AND x.source = 'stock'
         AND x.ship_transaction_id IS NOT NULL AND x.inbound_transaction_id IS NULL
       ORDER BY x.line_no
    LOOP
      INSERT INTO inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta, unit_cost_cents, note)
      VALUES (v_owner, l.part_id, l.location_id, 'adjustment', l.quantity, l.unit_cost_cents,
              left('Vendor return ' || v_rma.rma_number || ' rejected, restocked', 500))
      RETURNING id INTO v_tx;
      UPDATE vendor_rma_lines SET inbound_transaction_id = v_tx WHERE id = l.id;
      v_units := v_units + l.quantity;
    END LOOP;
  END IF;

  UPDATE vendor_rmas SET status = 'rejected', updated_at = now() WHERE id = v_rma.id;
  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'rejected', v_rma.status, 'rejected',
    COALESCE(v_note, 'Rejected by the vendor') || CASE WHEN v_units > 0 THEN ' (' || v_units || ' unit(s) restocked)' ELSE '' END || '.', NULL);
  RETURN v_units;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_vendor_rma(p_rma_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note is too long.' USING ERRCODE = '22023';
  END IF;
  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status NOT IN ('draft', 'authorized') THEN
    RAISE EXCEPTION 'Only a draft or authorized return can be cancelled. If it already shipped, mark it rejected instead.' USING ERRCODE = '22023';
  END IF;
  UPDATE vendor_rmas SET status = 'cancelled', updated_at = now() WHERE id = v_rma.id;
  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'cancelled', v_rma.status, 'cancelled', COALESCE(v_note, 'Cancelled') || '.', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_vendor_rma(p_rma_id uuid, p_accept_shortfall boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.vendor_rma_assert_manager();
  v_rma vendor_rmas;
  v_short integer := 0;
  v_open_units integer;
BEGIN
  v_rma := public.vendor_rma_lock(v_owner, p_rma_id);
  IF v_rma.status NOT IN ('resolved', 'rejected', 'received_by_vendor') THEN
    RAISE EXCEPTION 'Only a resolved, rejected or vendor-received return can be closed.' USING ERRCODE = '22023';
  END IF;
  IF v_rma.status = 'received_by_vendor' AND NOT COALESCE(p_accept_shortfall, false) THEN
    RAISE EXCEPTION 'The vendor has not fully resolved this return. Accept the shortfall to close it.' USING ERRCODE = '22023';
  END IF;

  IF v_rma.resolution = 'replacement' THEN
    SELECT COALESCE(SUM(x.quantity - x.quantity_replaced), 0)::integer INTO v_open_units
      FROM vendor_rma_lines x WHERE x.rma_id = v_rma.id;
    v_short := v_open_units;
  ELSE
    v_short := GREATEST(v_rma.credit_expected_cents - v_rma.credit_received_cents, 0);
  END IF;

  UPDATE vendor_rmas SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = v_rma.id;
  PERFORM public.vendor_rma_log(v_owner, v_rma.id, 'closed', v_rma.status, 'closed',
    CASE
      WHEN v_rma.status = 'rejected' THEN 'Closed.'
      WHEN v_short > 0 AND v_rma.resolution = 'replacement' THEN 'Closed with ' || v_short || ' unit(s) not replaced.'
      WHEN v_short > 0 THEN 'Closed with an unrecovered shortfall.'
      ELSE 'Closed.'
    END,
    CASE WHEN v_rma.resolution = 'replacement' OR v_rma.status = 'rejected' THEN NULL ELSE v_short END);
END;
$$;

-- =============================================================
-- 6. PICKER QUERIES (run as the caller: RLS applies)
-- =============================================================

CREATE OR REPLACE FUNCTION public.list_vendor_returnable_lines(p_vendor_id uuid)
RETURNS TABLE (
  po_line_id uuid,
  po_id uuid,
  po_number text,
  part_id uuid,
  part_name text,
  part_number text,
  quantity_received integer,
  quantity_committed integer,
  unit_cost_cents integer,
  received_at timestamptz
)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT l.id,
         po.id,
         po.po_number,
         l.part_id,
         ip.name,
         ip.part_number,
         l.quantity_received::integer,
         public.vendor_rma_committed_qty(po.user_id, l.id, NULL),
         l.unit_cost_cents::integer,
         COALESCE(po.received_at, po.created_at)
    FROM purchase_order_lines l
    JOIN purchase_orders po ON po.id = l.purchase_order_id
    JOIN inventory_parts ip ON ip.id = l.part_id
   WHERE po.vendor_id = p_vendor_id
     AND po.user_id = public.get_account_owner_id()
     AND l.quantity_received > 0
   ORDER BY COALESCE(po.received_at, po.created_at) DESC, po.po_number, l.created_at
   LIMIT 300;
$$;

CREATE OR REPLACE FUNCTION public.list_vendor_returnable_usage(p_vendor_id uuid)
RETURNS TABLE (
  usage_transaction_id uuid,
  part_id uuid,
  part_name text,
  part_number text,
  job_id uuid,
  job_label text,
  quantity_used integer,
  quantity_committed integer,
  unit_cost_cents integer,
  used_at timestamptz
)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT t.id,
         t.part_id,
         ip.name,
         ip.part_number,
         t.job_id,
         NULLIF(btrim(concat_ws(' · ', j.customer_name, j.service_type)), ''),
         abs(t.quantity_delta)::integer,
         public.vendor_rma_committed_qty(t.user_id, NULL, t.id),
         COALESCE(t.unit_cost_cents, ip.unit_cost_cents)::integer,
         t.created_at
    FROM inventory_transactions t
    JOIN inventory_parts ip ON ip.id = t.part_id
    LEFT JOIN jobs j ON j.id = t.job_id
   WHERE t.user_id = public.get_account_owner_id()
     AND t.transaction_type = 'usage'
     AND t.created_at >= now() - interval '365 days'
     AND (
       ip.preferred_vendor_id = p_vendor_id
       OR EXISTS (
         SELECT 1
           FROM purchase_order_lines pl
           JOIN purchase_orders po ON po.id = pl.purchase_order_id
          WHERE po.vendor_id = p_vendor_id AND po.user_id = t.user_id AND pl.part_id = t.part_id
       )
     )
   ORDER BY t.created_at DESC
   LIMIT 300;
$$;

-- =============================================================
-- 7. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.vendor_rma_assert_manager() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_rma_uuid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_rma_nonneg_int(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_rma_next_number(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_rma_log(uuid, uuid, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendor_rma_lock(uuid, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.vendor_rma_committed_qty(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_rma_committed_qty(uuid, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.save_vendor_rma(uuid, uuid, uuid, text, text, text, integer, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.authorize_vendor_rma(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ship_vendor_rma(uuid, text, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_vendor_rma_shipment(uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_vendor_rma_credit(uuid, integer, text, text, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_vendor_rma_credit(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_vendor_rma_replacement(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_vendor_rma(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_vendor_rma(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_vendor_rma(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_vendor_returnable_lines(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_vendor_returnable_usage(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_vendor_rma(uuid, uuid, uuid, text, text, text, integer, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_vendor_rma(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ship_vendor_rma(uuid, text, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_vendor_rma_shipment(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_vendor_rma_credit(uuid, integer, text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_vendor_rma_credit(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_vendor_rma_replacement(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_vendor_rma(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_vendor_rma(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_vendor_rma(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_vendor_returnable_lines(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_vendor_returnable_usage(uuid) TO authenticated;

COMMENT ON TABLE vendor_rmas IS
  'Vendor returns (RMA). Read by account members; written only via the *_vendor_rma* functions, which post stock changes to inventory_transactions as adjustment rows.';

NOTIFY pgrst, 'reload schema';
