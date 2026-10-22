/*
  # Procurement Network (group purchasing)

  Opt-in group purchasing across tenants, with a supplier-side portal.

    tenant opts in (explicit volume-sharing consent)
      -> browses approved supplier PROGRAMS (pn_programs)
      -> pooled volume TIERS (pn_volume_tiers) unlock better prices for everyone
      -> NEGOTIATED PRICE SCHEDULES (pn_price_schedules / _lines), reviewed by Vireek staff
      -> order routing: pn_place_order() creates a REAL purchase_orders row (status
         pending_approval) + purchase_order_items, so the tenant's existing approval,
         receiving and inventory flow is untouched. Approving the PO releases the
         order to the supplier; receiving it marks the network order delivered.
      -> at program close, pn_settle_program_internal() trues every order up to the
         FINAL pooled tier and accrues REBATES (pn_rebates) the supplier then pays.
      -> savings reporting: view pn_order_savings + pn_rebates.

  TENANT ISOLATION (the rule this whole migration is built around)
    - Every tenant-owned row carries user_id = account owner id and is readable only by
      that tenant (RLS, get_account_owner_id()).
    - Tenants NEVER read another tenant's commitments or orders. Pool numbers reach tenants
      and suppliers only through SECURITY DEFINER functions that return AGGREGATES, and
      only once at least pn_min_cohort() (3) distinct tenants contributed (k-anonymity).
      Below the cohort the pool total, participant count and gap are NULL.
    - Suppliers see their own catalog/programs, aggregated pool stats, and the orders
      placed WITH THEM (a normal B2B counterparty relationship, incl. ship-to) — never
      commitments, never other suppliers' orders, never tenant identities in aggregates.
    - Prices are computed server-side at order time; the client cannot set a price.
    - All sensitive writes go through SECURITY DEFINER RPCs with SET search_path = public.

  Additive and idempotent: nothing existing is altered except two AFTER-UPDATE triggers
  (on purchase_orders) that only touch rows in the new pn_orders table.
*/

-- =============================================================
-- 0. HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.pn_min_cohort()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

CREATE OR REPLACE FUNCTION public.pn_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

-- Owner, or a team member with can_view_billing (same gate as Tax Center / Procurement nav).
CREATE OR REPLACE FUNCTION public.pn_can_manage()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

CREATE OR REPLACE FUNCTION public.pn_is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT COALESCE((SELECT is_staff FROM profiles WHERE id = auth.uid()), false) $$;

-- =============================================================
-- 1. SUPPLIERS (non-tenant organisations) + their users
-- =============================================================

CREATE TABLE IF NOT EXISTS pn_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  legal_name text CHECK (legal_name IS NULL OR char_length(legal_name) <= 160),
  contact_name text CHECK (contact_name IS NULL OR char_length(contact_name) <= 120),
  contact_email text NOT NULL CHECK (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(contact_email) <= 200),
  phone text CHECK (phone IS NULL OR char_length(phone) <= 40),
  website text CHECK (website IS NULL OR char_length(website) <= 200),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  regions text[] NOT NULL DEFAULT '{}'::text[],
  categories text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  w9_verified boolean NOT NULL DEFAULT false,
  insurance_verified boolean NOT NULL DEFAULT false,
  review_notes text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pn_suppliers_status ON pn_suppliers(status);

CREATE TABLE IF NOT EXISTS pn_supplier_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES pn_suppliers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pn_supplier_users_user ON pn_supplier_users(user_id);

CREATE OR REPLACE FUNCTION public.pn_my_supplier_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT supplier_id FROM pn_supplier_users WHERE user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.pn_is_supplier_admin(p_supplier uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM pn_supplier_users WHERE supplier_id = p_supplier AND user_id = auth.uid() AND role = 'admin') $$;

-- =============================================================
-- 2. CATALOG
-- =============================================================

CREATE TABLE IF NOT EXISTS pn_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES pn_suppliers(id) ON DELETE CASCADE,
  sku text NOT NULL CHECK (char_length(btrim(sku)) BETWEEN 1 AND 60),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  category text CHECK (category IS NULL OR char_length(category) <= 80),
  manufacturer text CHECK (manufacturer IS NULL OR char_length(manufacturer) <= 120),
  mpn text CHECK (mpn IS NULL OR char_length(mpn) <= 80),
  unit text NOT NULL DEFAULT 'each' CHECK (char_length(unit) BETWEEN 1 AND 20),
  list_price_cents integer NOT NULL CHECK (list_price_cents >= 0 AND list_price_cents <= 1000000000),
  min_order_qty numeric NOT NULL DEFAULT 1 CHECK (min_order_qty > 0),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pn_catalog_sku ON pn_catalog_items(supplier_id, lower(sku));
CREATE INDEX IF NOT EXISTS idx_pn_catalog_supplier ON pn_catalog_items(supplier_id, active);

-- A list price referenced by a proposed/active schedule is locked: otherwise a supplier could
-- raise list after the fact, inflating the fallback prices and the "savings vs list" baseline.
CREATE OR REPLACE FUNCTION public.pn_guard_list_price()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.list_price_cents IS DISTINCT FROM OLD.list_price_cents AND EXISTS (
    SELECT 1 FROM pn_price_schedule_lines l JOIN pn_price_schedules s ON s.id = l.schedule_id
    WHERE l.catalog_item_id = OLD.id AND s.status IN ('proposed', 'active')
  ) THEN
    RAISE EXCEPTION 'This list price is locked by a submitted price schedule. Submit a new schedule version instead.';
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================
-- 3. PROGRAMS, TIERS, PRICE SCHEDULES
-- =============================================================

CREATE TABLE IF NOT EXISTS pn_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES pn_suppliers(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 160),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  category text CHECK (category IS NULL OR char_length(category) <= 80),
  terms text CHECK (terms IS NULL OR char_length(terms) <= 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date NOT NULL,
  regions text[] NOT NULL DEFAULT '{}'::text[],
  -- A tier above the lowest only unlocks once this many DISTINCT tenants have ordered.
  min_participants_for_tier integer NOT NULL DEFAULT 3 CHECK (min_participants_for_tier BETWEEN 3 AND 1000),
  bonus_rebate_bps integer NOT NULL DEFAULT 0 CHECK (bonus_rebate_bps BETWEEN 0 AND 3000),
  bonus_min_spend_cents bigint NOT NULL DEFAULT 0 CHECK (bonus_min_spend_cents >= 0),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pn_programs_dates CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_pn_programs_supplier ON pn_programs(supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_pn_programs_open ON pn_programs(status, ends_on) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS pn_volume_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES pn_programs(id) ON DELETE CASCADE,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 10),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  -- Pooled qualifying volume (sum of qty x LIST price, in cents) needed to unlock this tier.
  min_qualifying_cents bigint NOT NULL CHECK (min_qualifying_cents >= 0),
  -- Fallback discount off list when a schedule has no explicit line for an item at this tier.
  discount_bps integer NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 9000),
  UNIQUE (program_id, rank)
);

CREATE TABLE IF NOT EXISTS pn_price_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES pn_programs(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'countered', 'active', 'superseded')),
  valid_from date,
  valid_to date,
  supplier_note text CHECK (supplier_note IS NULL OR char_length(supplier_note) <= 2000),
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version),
  CONSTRAINT pn_schedule_dates CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pn_one_active_schedule ON pn_price_schedules(program_id) WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.pn_set_schedule_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(MAX(version), 0) + 1 INTO NEW.version FROM pn_price_schedules WHERE program_id = NEW.program_id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pn_schedule_version ON pn_price_schedules;
CREATE TRIGGER trg_pn_schedule_version BEFORE INSERT OR UPDATE ON pn_price_schedules
  FOR EACH ROW EXECUTE FUNCTION public.pn_set_schedule_version();

CREATE TABLE IF NOT EXISTS pn_price_schedule_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES pn_price_schedules(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES pn_catalog_items(id) ON DELETE CASCADE,
  tier_id uuid NOT NULL REFERENCES pn_volume_tiers(id) ON DELETE CASCADE,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000),
  UNIQUE (schedule_id, catalog_item_id, tier_id)
);
CREATE INDEX IF NOT EXISTS idx_pn_schedule_lines_item ON pn_price_schedule_lines(catalog_item_id);

-- A line must reference an item of the program's supplier and a tier of the same program.
CREATE OR REPLACE FUNCTION public.pn_validate_schedule_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pn_price_schedules s
    JOIN pn_programs p ON p.id = s.program_id
    JOIN pn_catalog_items ci ON ci.id = NEW.catalog_item_id AND ci.supplier_id = p.supplier_id
    JOIN pn_volume_tiers t ON t.id = NEW.tier_id AND t.program_id = p.id
    WHERE s.id = NEW.schedule_id
  ) THEN
    RAISE EXCEPTION 'Schedule line must use an item of this supplier and a tier of this program';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pn_validate_schedule_line ON pn_price_schedule_lines;
CREATE TRIGGER trg_pn_validate_schedule_line BEFORE INSERT OR UPDATE ON pn_price_schedule_lines
  FOR EACH ROW EXECUTE FUNCTION public.pn_validate_schedule_line();

-- =============================================================
-- 4. TENANT SIDE: membership, part links, vendor links, commitments
-- =============================================================

CREATE TABLE IF NOT EXISTS pn_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  region text CHECK (region IS NULL OR char_length(region) <= 60),
  categories text[] NOT NULL DEFAULT '{}'::text[],
  share_volume_consent boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 1,
  consented_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pn_active_requires_consent CHECK (status <> 'active' OR share_volume_consent)
);

CREATE TABLE IF NOT EXISTS pn_part_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  catalog_item_id uuid NOT NULL REFERENCES pn_catalog_items(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, catalog_item_id)
);

CREATE TABLE IF NOT EXISTS pn_vendor_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES pn_suppliers(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS pn_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES pn_programs(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES pn_catalog_items(id) ON DELETE CASCADE,
  committed_qty numeric NOT NULL CHECK (committed_qty > 0 AND committed_qty <= 10000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, program_id, catalog_item_id)
);
CREATE INDEX IF NOT EXISTS idx_pn_commitments_program ON pn_commitments(program_id);

-- =============================================================
-- 5. ORDERS (routed into purchase_orders) + REBATES + AUDIT
-- =============================================================

CREATE TABLE IF NOT EXISTS pn_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES pn_suppliers(id) ON DELETE RESTRICT,
  program_id uuid NOT NULL REFERENCES pn_programs(id) ON DELETE RESTRICT,
  program_title text,
  supplier_name text,
  po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval', 'placed', 'confirmed', 'shipped', 'delivered', 'cancelled')),
  tier_rank_at_order integer,
  ship_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  buyer_company text,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  supplier_note text CHECK (supplier_note IS NULL OR char_length(supplier_note) <= 2000),
  tracking text CHECK (tracking IS NULL OR char_length(tracking) <= 200),
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  placed_at timestamptz,
  confirmed_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pn_orders_user ON pn_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pn_orders_supplier ON pn_orders(supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_pn_orders_program ON pn_orders(program_id, status);
CREATE INDEX IF NOT EXISTS idx_pn_orders_po ON pn_orders(po_id) WHERE po_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pn_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES pn_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES pn_catalog_items(id) ON DELETE RESTRICT,
  part_id uuid REFERENCES inventory_parts(id) ON DELETE SET NULL,
  po_item_id uuid REFERENCES purchase_order_items(id) ON DELETE SET NULL,
  sku text NOT NULL,
  description text NOT NULL,
  qty numeric NOT NULL CHECK (qty > 0),
  list_price_cents integer NOT NULL CHECK (list_price_cents >= 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pn_order_lines_order ON pn_order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_pn_order_lines_item ON pn_order_lines(catalog_item_id);

-- What the tenant would otherwise have paid: their last purchase price for the same part,
-- else the supplier's list price. Savings are measured against this, honestly (can be < 0).
-- Kept in a TENANT-ONLY table: it reveals what the tenant pays other suppliers, so a
-- supplier must never be able to read it.
CREATE TABLE IF NOT EXISTS pn_line_baselines (
  line_id uuid PRIMARY KEY REFERENCES pn_order_lines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  baseline_unit_cents integer NOT NULL CHECK (baseline_unit_cents >= 0)
);

CREATE TABLE IF NOT EXISTS pn_rebates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES pn_programs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES pn_suppliers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tier_true_up', 'program_bonus')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'paid', 'void')),
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at timestamptz,
  paid_reference text CHECK (paid_reference IS NULL OR char_length(paid_reference) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, program_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_pn_rebates_supplier ON pn_rebates(supplier_id, status);

CREATE TABLE IF NOT EXISTS pn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES pn_suppliers(id) ON DELETE CASCADE,
  actor_id uuid,
  entity text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pn_events_user ON pn_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pn_events_supplier ON pn_events(supplier_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_pn_guard_list_price ON pn_catalog_items;
CREATE TRIGGER trg_pn_guard_list_price BEFORE UPDATE OF list_price_cents ON pn_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.pn_guard_list_price();

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pn_suppliers', 'pn_catalog_items', 'pn_programs', 'pn_memberships', 'pn_commitments', 'pn_orders', 'pn_rebates']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_touch ON %1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION public.pn_touch_updated_at()', t);
  END LOOP;
END $$;

-- =============================================================
-- 6. ROW LEVEL SECURITY
-- =============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pn_suppliers', 'pn_supplier_users', 'pn_catalog_items', 'pn_programs', 'pn_volume_tiers',
    'pn_price_schedules', 'pn_price_schedule_lines', 'pn_memberships', 'pn_part_links',
    'pn_vendor_links', 'pn_commitments', 'pn_orders', 'pn_order_lines', 'pn_line_baselines', 'pn_rebates', 'pn_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---- suppliers: members read their org; staff read all. Writes only via RPC. ----
DROP POLICY IF EXISTS pn_suppliers_select ON pn_suppliers;
CREATE POLICY pn_suppliers_select ON pn_suppliers FOR SELECT TO authenticated
  USING (id IN (SELECT public.pn_my_supplier_ids()) OR public.pn_is_staff());

DROP POLICY IF EXISTS pn_supplier_users_select ON pn_supplier_users;
CREATE POLICY pn_supplier_users_select ON pn_supplier_users FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT public.pn_my_supplier_ids()) OR public.pn_is_staff());

-- ---- catalog: supplier members manage their own catalog (staff read). ----
DROP POLICY IF EXISTS pn_catalog_select ON pn_catalog_items;
CREATE POLICY pn_catalog_select ON pn_catalog_items FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT public.pn_my_supplier_ids()) OR public.pn_is_staff());
DROP POLICY IF EXISTS pn_catalog_insert ON pn_catalog_items;
CREATE POLICY pn_catalog_insert ON pn_catalog_items FOR INSERT TO authenticated
  WITH CHECK (supplier_id IN (SELECT public.pn_my_supplier_ids()));
DROP POLICY IF EXISTS pn_catalog_update ON pn_catalog_items;
CREATE POLICY pn_catalog_update ON pn_catalog_items FOR UPDATE TO authenticated
  USING (supplier_id IN (SELECT public.pn_my_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.pn_my_supplier_ids()));
-- No DELETE: items referenced by orders are RESTRICTed; suppliers deactivate instead.

-- ---- programs / tiers / schedules: edit only while DRAFT; transitions via RPC. ----
DROP POLICY IF EXISTS pn_programs_select ON pn_programs;
CREATE POLICY pn_programs_select ON pn_programs FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT public.pn_my_supplier_ids()) OR public.pn_is_staff());
DROP POLICY IF EXISTS pn_programs_insert ON pn_programs;
CREATE POLICY pn_programs_insert ON pn_programs FOR INSERT TO authenticated
  WITH CHECK (supplier_id IN (SELECT public.pn_my_supplier_ids()) AND status = 'draft' AND settled_at IS NULL);
DROP POLICY IF EXISTS pn_programs_update ON pn_programs;
CREATE POLICY pn_programs_update ON pn_programs FOR UPDATE TO authenticated
  USING (supplier_id IN (SELECT public.pn_my_supplier_ids()) AND status = 'draft')
  WITH CHECK (supplier_id IN (SELECT public.pn_my_supplier_ids()) AND status = 'draft' AND settled_at IS NULL);

DROP POLICY IF EXISTS pn_tiers_select ON pn_volume_tiers;
CREATE POLICY pn_tiers_select ON pn_volume_tiers FOR SELECT TO authenticated
  USING (program_id IN (SELECT id FROM pn_programs WHERE supplier_id IN (SELECT public.pn_my_supplier_ids())) OR public.pn_is_staff());
DROP POLICY IF EXISTS pn_tiers_write ON pn_volume_tiers;
CREATE POLICY pn_tiers_write ON pn_volume_tiers FOR ALL TO authenticated
  USING (program_id IN (SELECT id FROM pn_programs WHERE status = 'draft' AND supplier_id IN (SELECT public.pn_my_supplier_ids())))
  WITH CHECK (program_id IN (SELECT id FROM pn_programs WHERE status = 'draft' AND supplier_id IN (SELECT public.pn_my_supplier_ids())));

DROP POLICY IF EXISTS pn_schedules_select ON pn_price_schedules;
CREATE POLICY pn_schedules_select ON pn_price_schedules FOR SELECT TO authenticated
  USING (program_id IN (SELECT id FROM pn_programs WHERE supplier_id IN (SELECT public.pn_my_supplier_ids())) OR public.pn_is_staff());
DROP POLICY IF EXISTS pn_schedules_insert ON pn_price_schedules;
CREATE POLICY pn_schedules_insert ON pn_price_schedules FOR INSERT TO authenticated
  WITH CHECK (status = 'draft' AND program_id IN (
    SELECT id FROM pn_programs WHERE status IN ('draft', 'open') AND supplier_id IN (SELECT public.pn_my_supplier_ids())));
DROP POLICY IF EXISTS pn_schedules_update ON pn_price_schedules;
CREATE POLICY pn_schedules_update ON pn_price_schedules FOR UPDATE TO authenticated
  USING (status = 'draft' AND program_id IN (SELECT id FROM pn_programs WHERE supplier_id IN (SELECT public.pn_my_supplier_ids())))
  WITH CHECK (status = 'draft' AND program_id IN (SELECT id FROM pn_programs WHERE supplier_id IN (SELECT public.pn_my_supplier_ids())));
DROP POLICY IF EXISTS pn_schedules_delete ON pn_price_schedules;
CREATE POLICY pn_schedules_delete ON pn_price_schedules FOR DELETE TO authenticated
  USING (status = 'draft' AND program_id IN (SELECT id FROM pn_programs WHERE supplier_id IN (SELECT public.pn_my_supplier_ids())));

DROP POLICY IF EXISTS pn_lines_select ON pn_price_schedule_lines;
CREATE POLICY pn_lines_select ON pn_price_schedule_lines FOR SELECT TO authenticated
  USING (schedule_id IN (
    SELECT s.id FROM pn_price_schedules s JOIN pn_programs p ON p.id = s.program_id
    WHERE p.supplier_id IN (SELECT public.pn_my_supplier_ids())) OR public.pn_is_staff());
DROP POLICY IF EXISTS pn_lines_write ON pn_price_schedule_lines;
CREATE POLICY pn_lines_write ON pn_price_schedule_lines FOR ALL TO authenticated
  USING (schedule_id IN (
    SELECT s.id FROM pn_price_schedules s JOIN pn_programs p ON p.id = s.program_id
    WHERE s.status = 'draft' AND p.supplier_id IN (SELECT public.pn_my_supplier_ids())))
  WITH CHECK (schedule_id IN (
    SELECT s.id FROM pn_price_schedules s JOIN pn_programs p ON p.id = s.program_id
    WHERE s.status = 'draft' AND p.supplier_id IN (SELECT public.pn_my_supplier_ids())));

-- ---- tenant-owned tables: read own (billing-gated); writes via RPC unless noted. ----
DROP POLICY IF EXISTS pn_memberships_select ON pn_memberships;
CREATE POLICY pn_memberships_select ON pn_memberships FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage());

DROP POLICY IF EXISTS pn_commitments_select ON pn_commitments;
CREATE POLICY pn_commitments_select ON pn_commitments FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage());

DROP POLICY IF EXISTS pn_vendor_links_select ON pn_vendor_links;
CREATE POLICY pn_vendor_links_select ON pn_vendor_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage());

-- Part links are the tenant's own mapping; they may manage them directly (own parts only).
DROP POLICY IF EXISTS pn_part_links_select ON pn_part_links;
CREATE POLICY pn_part_links_select ON pn_part_links FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage());
DROP POLICY IF EXISTS pn_part_links_insert ON pn_part_links;
CREATE POLICY pn_part_links_insert ON pn_part_links FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.pn_can_manage()
    AND EXISTS (SELECT 1 FROM inventory_parts ip WHERE ip.id = part_id AND ip.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS pn_part_links_update ON pn_part_links;
CREATE POLICY pn_part_links_update ON pn_part_links FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.pn_can_manage()
    AND EXISTS (SELECT 1 FROM inventory_parts ip WHERE ip.id = part_id AND ip.user_id = public.get_account_owner_id()));
DROP POLICY IF EXISTS pn_part_links_delete ON pn_part_links;
CREATE POLICY pn_part_links_delete ON pn_part_links FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage());

-- ---- orders: the tenant sees its own; the supplier sees only orders placed WITH it and
--      only once the tenant has approved the PO (status <> awaiting_approval). ----
DROP POLICY IF EXISTS pn_orders_select ON pn_orders;
CREATE POLICY pn_orders_select ON pn_orders FOR SELECT TO authenticated
  USING (
    (user_id = public.get_account_owner_id() AND public.pn_can_manage())
    OR (status <> 'awaiting_approval' AND supplier_id IN (SELECT public.pn_my_supplier_ids()))
  );
DROP POLICY IF EXISTS pn_order_lines_select ON pn_order_lines;
CREATE POLICY pn_order_lines_select ON pn_order_lines FOR SELECT TO authenticated
  USING (
    (user_id = public.get_account_owner_id() AND public.pn_can_manage())
    OR order_id IN (
      SELECT o.id FROM pn_orders o
      WHERE o.status <> 'awaiting_approval' AND o.supplier_id IN (SELECT public.pn_my_supplier_ids()))
  );

DROP POLICY IF EXISTS pn_line_baselines_select ON pn_line_baselines;
CREATE POLICY pn_line_baselines_select ON pn_line_baselines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.pn_can_manage());

DROP POLICY IF EXISTS pn_rebates_select ON pn_rebates;
CREATE POLICY pn_rebates_select ON pn_rebates FOR SELECT TO authenticated
  USING (
    (user_id = public.get_account_owner_id() AND public.pn_can_manage())
    OR supplier_id IN (SELECT public.pn_my_supplier_ids())
  );

DROP POLICY IF EXISTS pn_events_select ON pn_events;
CREATE POLICY pn_events_select ON pn_events FOR SELECT TO authenticated
  USING (
    (user_id = public.get_account_owner_id() AND public.pn_can_manage())
    OR supplier_id IN (SELECT public.pn_my_supplier_ids())
    OR public.pn_is_staff()
  );

-- Savings view (security_invoker: each caller's own RLS applies).
CREATE OR REPLACE VIEW pn_order_savings WITH (security_invoker = true) AS
SELECT
  o.id AS order_id,
  o.user_id,
  o.program_id,
  o.supplier_id,
  o.status,
  COALESCE(o.placed_at, o.created_at) AS ordered_at,
  COALESCE(SUM(ROUND(l.qty * l.unit_price_cents)), 0)::bigint AS paid_cents,
  COALESCE(SUM(ROUND(l.qty * b.baseline_unit_cents)), 0)::bigint AS baseline_cents,
  COALESCE(SUM(ROUND(l.qty * l.list_price_cents)), 0)::bigint AS list_cents
FROM pn_orders o
JOIN pn_order_lines l ON l.order_id = o.id
JOIN pn_line_baselines b ON b.line_id = l.id
GROUP BY o.id;

-- =============================================================
-- 7. INTERNAL FUNCTIONS (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public.pn_log(p_user uuid, p_supplier uuid, p_entity text, p_entity_id uuid, p_action text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO pn_events (user_id, supplier_id, actor_id, entity, entity_id, action, detail)
  VALUES (p_user, p_supplier, auth.uid(), p_entity, p_entity_id, p_action, COALESCE(p_detail, '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.pn_active_schedule_id(p_program uuid, p_strict_dates boolean DEFAULT true)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM pn_price_schedules
  WHERE program_id = p_program AND status = 'active'
    AND (NOT p_strict_dates OR ((valid_from IS NULL OR valid_from <= current_date) AND (valid_to IS NULL OR valid_to >= current_date)))
  ORDER BY version DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.pn_unit_price(p_schedule uuid, p_item uuid, p_tier uuid, p_list integer, p_discount_bps integer)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT unit_price_cents FROM pn_price_schedule_lines WHERE schedule_id = p_schedule AND catalog_item_id = p_item AND tier_id = p_tier),
    ROUND(p_list * (10000 - COALESCE(p_discount_bps, 0)) / 10000.0)::integer
  );
$$;

-- RAW pool state (exact numbers). Never exposed to clients; wrappers apply the cohort rule.
CREATE OR REPLACE FUNCTION public.pn_pool_state(p_program uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog pn_programs%ROWTYPE;
  v_cents bigint;
  v_ordering integer;
  v_engaged integer;
  v_committed bigint;
  v_tier pn_volume_tiers%ROWTYPE;
  v_next pn_volume_tiers%ROWTYPE;
BEGIN
  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(ROUND(l.qty * l.list_price_cents)), 0)::bigint, COUNT(DISTINCT o.user_id)::integer
    INTO v_cents, v_ordering
  FROM pn_orders o JOIN pn_order_lines l ON l.order_id = o.id
  WHERE o.program_id = p_program AND o.status IN ('placed', 'confirmed', 'shipped', 'delivered');

  SELECT COUNT(*)::integer INTO v_engaged FROM (
    SELECT o.user_id FROM pn_orders o WHERE o.program_id = p_program AND o.status IN ('placed', 'confirmed', 'shipped', 'delivered')
    UNION
    SELECT c.user_id FROM pn_commitments c WHERE c.program_id = p_program
  ) e;

  SELECT COALESCE(SUM(ROUND(c.committed_qty * ci.list_price_cents)), 0)::bigint INTO v_committed
  FROM pn_commitments c JOIN pn_catalog_items ci ON ci.id = c.catalog_item_id
  WHERE c.program_id = p_program;

  IF v_ordering >= v_prog.min_participants_for_tier THEN
    SELECT * INTO v_tier FROM pn_volume_tiers
    WHERE program_id = p_program AND min_qualifying_cents <= v_cents ORDER BY rank DESC LIMIT 1;
  END IF;
  IF v_tier.id IS NULL THEN
    SELECT * INTO v_tier FROM pn_volume_tiers WHERE program_id = p_program ORDER BY rank ASC LIMIT 1;
  END IF;
  IF v_tier.id IS NOT NULL THEN
    SELECT * INTO v_next FROM pn_volume_tiers WHERE program_id = p_program AND rank > v_tier.rank ORDER BY rank ASC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'program_id', p_program,
    'qualifying_cents', v_cents,
    'committed_cents', v_committed,
    'ordering_participants', v_ordering,
    'engaged_participants', v_engaged,
    'min_participants_for_tier', v_prog.min_participants_for_tier,
    'tier_id', v_tier.id,
    'tier_rank', v_tier.rank,
    'tier_label', v_tier.label,
    'tier_discount_bps', v_tier.discount_bps,
    'next_tier_rank', v_next.rank,
    'next_tier_label', v_next.label,
    'next_tier_min_cents', v_next.min_qualifying_cents
  );
END;
$$;

-- Cohort-masked projection (k-anonymity): the pool total, participant counts and gap are
-- NULL until pn_min_cohort() distinct tenants are engaged. Tier + thresholds are not tenant data.
CREATE OR REPLACE FUNCTION public.pn_pool_public(p_program uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s jsonb := public.pn_pool_state(p_program);
  v_visible boolean;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  v_visible := (s ->> 'engaged_participants')::integer >= public.pn_min_cohort();
  RETURN jsonb_build_object(
    'program_id', p_program,
    'cohort_visible', v_visible,
    'pooled_cents', CASE WHEN v_visible THEN s -> 'qualifying_cents' ELSE NULL END,
    'projected_cents', CASE WHEN v_visible THEN to_jsonb(((s ->> 'qualifying_cents')::bigint + (s ->> 'committed_cents')::bigint)) ELSE NULL END,
    'participants', CASE WHEN v_visible THEN s -> 'engaged_participants' ELSE NULL END,
    'gap_to_next_cents', CASE WHEN v_visible AND s ->> 'next_tier_min_cents' IS NOT NULL
      THEN to_jsonb(GREATEST((s ->> 'next_tier_min_cents')::bigint - (s ->> 'qualifying_cents')::bigint, 0)) ELSE NULL END,
    'min_participants_for_tier', s -> 'min_participants_for_tier',
    'tier_id', s -> 'tier_id',
    'tier_rank', s -> 'tier_rank',
    'tier_label', s -> 'tier_label',
    'tier_discount_bps', s -> 'tier_discount_bps',
    'next_tier_rank', s -> 'next_tier_rank',
    'next_tier_label', s -> 'next_tier_label',
    'next_tier_min_cents', s -> 'next_tier_min_cents'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_vendor_for_supplier(p_owner uuid, p_supplier uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vendor uuid;
  s pn_suppliers%ROWTYPE;
BEGIN
  SELECT vendor_id INTO v_vendor FROM pn_vendor_links WHERE user_id = p_owner AND supplier_id = p_supplier;
  IF v_vendor IS NOT NULL THEN RETURN v_vendor; END IF;
  SELECT * INTO s FROM pn_suppliers WHERE id = p_supplier;
  INSERT INTO vendors (user_id, name, contact_name, email, phone, category, notes)
  VALUES (p_owner, s.name, s.contact_name, s.contact_email, s.phone, 'Procurement Network',
          'Created automatically by the Procurement Network. Orders are routed through the network.')
  RETURNING id INTO v_vendor;
  INSERT INTO pn_vendor_links (user_id, supplier_id, vendor_id) VALUES (p_owner, p_supplier, v_vendor);
  RETURN v_vendor;
END;
$$;

-- Final-tier true-up + bonus rebates. Idempotent: only rows still 'accrued' are rewritten.
CREATE OR REPLACE FUNCTION public.pn_settle_program_internal(p_program uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog pn_programs%ROWTYPE;
  v_state jsonb;
  v_tier_id uuid;
  v_disc integer;
  v_sched uuid;
  v_rec record;
  v_sup_name text;
  v_true_up bigint;
  v_bonus bigint;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program;
  v_state := public.pn_pool_state(p_program);
  v_tier_id := NULLIF(v_state ->> 'tier_id', '')::uuid;
  v_disc := COALESCE((v_state ->> 'tier_discount_bps')::integer, 0);
  v_sched := public.pn_active_schedule_id(p_program, false);
  SELECT name INTO v_sup_name FROM pn_suppliers WHERE id = v_prog.supplier_id;

  FOR v_rec IN
    SELECT o.user_id,
           COALESCE(SUM(GREATEST(l.unit_price_cents - fp.price, 0) * l.qty), 0) AS true_up_raw,
           COALESCE(SUM(LEAST(l.unit_price_cents, fp.price) * l.qty), 0) AS net_raw,
           COALESCE(SUM(l.qty * l.list_price_cents), 0) AS list_raw
    FROM pn_orders o
    JOIN pn_order_lines l ON l.order_id = o.id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN v_tier_id IS NULL THEN l.unit_price_cents
                  ELSE public.pn_unit_price(v_sched, l.catalog_item_id, v_tier_id, l.list_price_cents, v_disc) END AS price
    ) fp
    WHERE o.program_id = p_program AND o.status IN ('placed', 'confirmed', 'shipped', 'delivered')
    GROUP BY o.user_id
  LOOP
    v_true_up := ROUND(v_rec.true_up_raw)::bigint;
    IF v_true_up > 0 THEN
      INSERT INTO pn_rebates (user_id, program_id, supplier_id, kind, amount_cents, basis)
      VALUES (v_rec.user_id, p_program, v_prog.supplier_id, 'tier_true_up', v_true_up,
              jsonb_build_object('final_tier_rank', v_state -> 'tier_rank', 'net_spend_cents', ROUND(v_rec.net_raw)::bigint,
                              'program_title', v_prog.title, 'supplier_name', v_sup_name,
                              'buyer_company', (SELECT COALESCE(NULLIF(company_name, ''), email) FROM profiles WHERE id = v_rec.user_id)))
      ON CONFLICT (user_id, program_id, kind) DO UPDATE
        SET amount_cents = EXCLUDED.amount_cents, basis = EXCLUDED.basis
        WHERE pn_rebates.status = 'accrued';
      v_count := v_count + 1;
    END IF;

    v_bonus := 0;
    IF v_prog.bonus_rebate_bps > 0 AND ROUND(v_rec.net_raw) >= v_prog.bonus_min_spend_cents THEN
      v_bonus := ROUND(v_rec.net_raw * v_prog.bonus_rebate_bps / 10000.0)::bigint;
    END IF;
    IF v_bonus > 0 THEN
      INSERT INTO pn_rebates (user_id, program_id, supplier_id, kind, amount_cents, basis)
      VALUES (v_rec.user_id, p_program, v_prog.supplier_id, 'program_bonus', v_bonus,
              jsonb_build_object('bonus_bps', v_prog.bonus_rebate_bps, 'net_spend_cents', ROUND(v_rec.net_raw)::bigint,
                              'program_title', v_prog.title, 'supplier_name', v_sup_name,
                              'buyer_company', (SELECT COALESCE(NULLIF(company_name, ''), email) FROM profiles WHERE id = v_rec.user_id)))
      ON CONFLICT (user_id, program_id, kind) DO UPDATE
        SET amount_cents = EXCLUDED.amount_cents, basis = EXCLUDED.basis
        WHERE pn_rebates.status = 'accrued';
      v_count := v_count + 1;
    END IF;
  END LOOP;

  UPDATE pn_programs SET status = 'closed', settled_at = now() WHERE id = p_program;
  PERFORM public.pn_log(NULL, v_prog.supplier_id, 'program', p_program, 'settled',
    jsonb_build_object('final_tier_rank', v_state -> 'tier_rank', 'rebates', v_count));
  RETURN v_count;
END;
$$;

-- Hourly: close + settle programs whose end date has passed.
CREATE OR REPLACE FUNCTION public.pn_close_expired_programs()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id FROM pn_programs WHERE status = 'open' AND ends_on < current_date LOOP
    PERFORM public.pn_settle_program_internal(r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('vireek-pn-close-expired-programs'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('vireek-pn-close-expired-programs', '20 * * * *', 'select public.pn_close_expired_programs()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;

-- =============================================================
-- 8. SYNC WITH THE EXISTING PURCHASE-ORDER FLOW
--    approve PO  -> network order released to the supplier (and PO marked sent)
--    cancel PO   -> network order cancelled (while the program is open)
--    receive PO  -> network order delivered
-- =============================================================

CREATE OR REPLACE FUNCTION public.pn_sync_order_from_po()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_released boolean := false;
BEGIN
  IF NEW.status IN ('approved', 'sent') THEN
    UPDATE pn_orders SET status = 'placed', placed_at = now()
    WHERE po_id = NEW.id AND status = 'awaiting_approval';
    v_released := FOUND;
    IF v_released AND NEW.status = 'approved' THEN
      UPDATE purchase_orders SET status = 'sent', sent_at = COALESCE(sent_at, now()) WHERE id = NEW.id AND status = 'approved';
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE pn_orders o SET status = 'cancelled', cancelled_at = now(),
           cancel_reason = COALESCE(o.cancel_reason, 'Purchase order cancelled by the buyer')
    WHERE o.po_id = NEW.id AND o.status IN ('awaiting_approval', 'placed', 'confirmed')
      AND EXISTS (SELECT 1 FROM pn_programs p WHERE p.id = o.program_id AND p.status = 'open');
  ELSIF NEW.status IN ('received', 'closed') THEN
    UPDATE pn_orders SET status = 'delivered', delivered_at = COALESCE(delivered_at, now())
    WHERE po_id = NEW.id AND status IN ('placed', 'confirmed', 'shipped');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pn_sync_order_from_po ON purchase_orders;
CREATE TRIGGER trg_pn_sync_order_from_po
  AFTER UPDATE OF status ON purchase_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.pn_sync_order_from_po();

-- =============================================================
-- 9. TENANT RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.pn_join_network(p_region text, p_categories text[], p_consent boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'You must consent to sharing aggregated purchasing volume to join the network';
  END IF;
  IF p_region IS NOT NULL AND char_length(p_region) > 60 THEN RAISE EXCEPTION 'Region too long'; END IF;
  IF COALESCE(array_length(p_categories, 1), 0) > 20 THEN RAISE EXCEPTION 'Too many categories'; END IF;

  INSERT INTO pn_memberships (user_id, status, region, categories, share_volume_consent, consented_at, left_at)
  VALUES (v_owner, 'active', NULLIF(btrim(p_region), ''), COALESCE(p_categories, '{}'), true, now(), NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET status = 'active', region = EXCLUDED.region, categories = EXCLUDED.categories,
        share_volume_consent = true, consented_at = now(), left_at = NULL;
  PERFORM public.pn_log(v_owner, NULL, 'membership', NULL, 'joined', jsonb_build_object('region', p_region));
  RETURN jsonb_build_object('status', 'active');
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_leave_network()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE pn_memberships SET status = 'left', share_volume_consent = false, left_at = now() WHERE user_id = v_owner;
  DELETE FROM pn_commitments WHERE user_id = v_owner;
  PERFORM public.pn_log(v_owner, NULL, 'membership', NULL, 'left');
  RETURN jsonb_build_object('status', 'left');
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_list_programs()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_member pn_memberships%ROWTYPE;
  v_out jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO v_member FROM pn_memberships WHERE user_id = v_owner AND status = 'active';
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY sort_a, sort_b), '[]'::jsonb) INTO v_out FROM (
    SELECT
      jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'category', p.category,
        'status', p.status, 'starts_on', p.starts_on, 'ends_on', p.ends_on,
        'supplier_id', s.id, 'supplier_name', s.name,
        'bonus_rebate_bps', p.bonus_rebate_bps, 'bonus_min_spend_cents', p.bonus_min_spend_cents,
        'eligible', (cardinality(p.regions) = 0 OR (v_member.region IS NOT NULL AND v_member.region = ANY (p.regions))),
        'regions', p.regions,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'rank', t.rank, 'label', t.label,
                    'min_qualifying_cents', t.min_qualifying_cents, 'discount_bps', t.discount_bps) ORDER BY t.rank)
                  FROM pn_volume_tiers t WHERE t.program_id = p.id), '[]'::jsonb),
        'pool', public.pn_pool_public(p.id),
        'my_ordered_cents', COALESCE((SELECT SUM(ROUND(l.qty * l.unit_price_cents)) FROM pn_orders o JOIN pn_order_lines l ON l.order_id = o.id
                    WHERE o.program_id = p.id AND o.user_id = v_owner AND o.status <> 'cancelled'), 0)::bigint,
        'my_committed_cents', COALESCE((SELECT SUM(ROUND(c.committed_qty * ci.list_price_cents)) FROM pn_commitments c
                    JOIN pn_catalog_items ci ON ci.id = c.catalog_item_id WHERE c.program_id = p.id AND c.user_id = v_owner), 0)::bigint
      ) AS row_json,
      (CASE p.status WHEN 'open' THEN 0 ELSE 1 END) AS sort_a,
      p.ends_on AS sort_b
    FROM pn_programs p JOIN pn_suppliers s ON s.id = p.supplier_id
    WHERE s.status = 'approved'
      AND (p.status = 'open'
           OR (p.status = 'closed' AND EXISTS (SELECT 1 FROM pn_orders o WHERE o.program_id = p.id AND o.user_id = v_owner)))
  ) q;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_program_detail(p_program uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_prog pn_programs%ROWTYPE;
  v_sup pn_suppliers%ROWTYPE;
  v_sched uuid;
  v_items jsonb;
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_memberships WHERE user_id = v_owner AND status = 'active')
     AND NOT EXISTS (SELECT 1 FROM pn_orders WHERE user_id = v_owner AND program_id = p_program) THEN
    RAISE EXCEPTION 'Join the Procurement Network first';
  END IF;
  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program AND status IN ('open', 'closed');
  IF NOT FOUND THEN RAISE EXCEPTION 'Program not found'; END IF;
  SELECT * INTO v_sup FROM pn_suppliers WHERE id = v_prog.supplier_id AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'Program not found'; END IF;
  v_sched := public.pn_active_schedule_id(p_program, false);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', ci.id, 'sku', ci.sku, 'name', ci.name, 'description', ci.description, 'category', ci.category,
      'manufacturer', ci.manufacturer, 'mpn', ci.mpn, 'unit', ci.unit,
      'list_price_cents', ci.list_price_cents, 'min_order_qty', ci.min_order_qty, 'lead_time_days', ci.lead_time_days,
      'prices', (SELECT COALESCE(jsonb_object_agg(t.id::text, public.pn_unit_price(v_sched, ci.id, t.id, ci.list_price_cents, t.discount_bps)), '{}'::jsonb)
                 FROM pn_volume_tiers t WHERE t.program_id = p_program),
      'my_commit_qty', (SELECT c.committed_qty FROM pn_commitments c WHERE c.user_id = v_owner AND c.program_id = p_program AND c.catalog_item_id = ci.id),
      'part_id', (SELECT pl.part_id FROM pn_part_links pl WHERE pl.user_id = v_owner AND pl.catalog_item_id = ci.id)
    ) ORDER BY ci.name), '[]'::jsonb) INTO v_items
  FROM pn_catalog_items ci
  WHERE ci.supplier_id = v_prog.supplier_id AND ci.active
    AND (v_sched IS NULL OR EXISTS (SELECT 1 FROM pn_price_schedule_lines pl2 WHERE pl2.schedule_id = v_sched AND pl2.catalog_item_id = ci.id)
         OR NOT EXISTS (SELECT 1 FROM pn_price_schedule_lines pl3 WHERE pl3.schedule_id = v_sched));

  RETURN jsonb_build_object(
    'program', jsonb_build_object('id', v_prog.id, 'title', v_prog.title, 'description', v_prog.description,
      'category', v_prog.category, 'terms', v_prog.terms, 'status', v_prog.status, 'starts_on', v_prog.starts_on,
      'ends_on', v_prog.ends_on, 'bonus_rebate_bps', v_prog.bonus_rebate_bps, 'bonus_min_spend_cents', v_prog.bonus_min_spend_cents,
      'min_participants_for_tier', v_prog.min_participants_for_tier),
    'supplier', jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'website', v_sup.website, 'description', v_sup.description),
    'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'rank', t.rank, 'label', t.label,
              'min_qualifying_cents', t.min_qualifying_cents, 'discount_bps', t.discount_bps) ORDER BY t.rank)
            FROM pn_volume_tiers t WHERE t.program_id = p_program), '[]'::jsonb),
    'pool', public.pn_pool_public(p_program),
    'items', v_items,
    'has_schedule', v_sched IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_set_commitment(p_program uuid, p_item uuid, p_qty numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_prog pn_programs%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_memberships WHERE user_id = v_owner AND status = 'active') THEN
    RAISE EXCEPTION 'Join the Procurement Network first';
  END IF;
  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'This program is not open'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_catalog_items WHERE id = p_item AND supplier_id = v_prog.supplier_id AND active) THEN
    RAISE EXCEPTION 'Item is not part of this program';
  END IF;
  IF p_qty IS NULL OR p_qty < 0 OR p_qty > 10000000 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
  IF p_qty = 0 THEN
    DELETE FROM pn_commitments WHERE user_id = v_owner AND program_id = p_program AND catalog_item_id = p_item;
  ELSE
    INSERT INTO pn_commitments (user_id, program_id, catalog_item_id, committed_qty)
    VALUES (v_owner, p_program, p_item, p_qty)
    ON CONFLICT (user_id, program_id, catalog_item_id) DO UPDATE SET committed_qty = EXCLUDED.committed_qty;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_place_order(
  p_program uuid, p_lines jsonb, p_ship_to jsonb, p_notes text DEFAULT NULL, p_expected_delivery date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_member pn_memberships%ROWTYPE;
  v_prog pn_programs%ROWTYPE;
  v_sup pn_suppliers%ROWTYPE;
  v_state jsonb;
  v_tier_id uuid;
  v_tier_rank integer;
  v_disc integer;
  v_sched uuid;
  v_vendor uuid;
  v_vendor_tier text;
  v_po uuid;
  v_order uuid := gen_random_uuid();
  v_number text;
  v_ship jsonb;
  v_company text;
  r record;
  ci pn_catalog_items%ROWTYPE;
  v_part uuid;
  v_price integer;
  v_baseline integer;
  v_po_item uuid;
  v_line uuid;
  v_subtotal bigint := 0;
  v_lines integer := 0;
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO v_member FROM pn_memberships WHERE user_id = v_owner AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Join the Procurement Network first'; END IF;

  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program;
  IF NOT FOUND OR v_prog.status <> 'open' OR current_date < v_prog.starts_on OR current_date > v_prog.ends_on THEN
    RAISE EXCEPTION 'This program is not open for orders';
  END IF;
  SELECT * INTO v_sup FROM pn_suppliers WHERE id = v_prog.supplier_id;
  IF v_sup.status <> 'approved' THEN RAISE EXCEPTION 'This supplier is not currently approved'; END IF;
  IF cardinality(v_prog.regions) > 0 AND (v_member.region IS NULL OR NOT v_member.region = ANY (v_prog.regions)) THEN
    RAISE EXCEPTION 'Your region is not eligible for this program';
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Order lines must be a list'; END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'An order needs between 1 and 100 lines';
  END IF;
  IF jsonb_typeof(p_ship_to) IS DISTINCT FROM 'object'
     OR char_length(btrim(COALESCE(p_ship_to ->> 'name', ''))) < 1
     OR char_length(btrim(COALESCE(p_ship_to ->> 'line1', ''))) < 1
     OR char_length(btrim(COALESCE(p_ship_to ->> 'city', ''))) < 1
     OR char_length(btrim(COALESCE(p_ship_to ->> 'postal_code', ''))) < 1 THEN
    RAISE EXCEPTION 'Ship-to name, address, city and postal code are required';
  END IF;
  v_ship := jsonb_build_object(
    'name', left(btrim(p_ship_to ->> 'name'), 120),
    'contact', left(btrim(COALESCE(p_ship_to ->> 'contact', '')), 120),
    'phone', left(btrim(COALESCE(p_ship_to ->> 'phone', '')), 40),
    'line1', left(btrim(p_ship_to ->> 'line1'), 160),
    'line2', left(btrim(COALESCE(p_ship_to ->> 'line2', '')), 160),
    'city', left(btrim(p_ship_to ->> 'city'), 80),
    'region', left(btrim(COALESCE(p_ship_to ->> 'region', '')), 60),
    'postal_code', left(btrim(p_ship_to ->> 'postal_code'), 20),
    'country', left(btrim(COALESCE(p_ship_to ->> 'country', '')), 60));

  v_sched := public.pn_active_schedule_id(p_program, true);
  IF v_sched IS NULL THEN RAISE EXCEPTION 'This program has no active price schedule'; END IF;
  v_state := public.pn_pool_state(p_program);
  v_tier_id := NULLIF(v_state ->> 'tier_id', '')::uuid;
  v_tier_rank := (v_state ->> 'tier_rank')::integer;
  v_disc := COALESCE((v_state ->> 'tier_discount_bps')::integer, 0);
  IF v_tier_id IS NULL THEN RAISE EXCEPTION 'This program has no pricing tiers'; END IF;

  v_vendor := public.pn_vendor_for_supplier(v_owner, v_prog.supplier_id);
  SELECT tier INTO v_vendor_tier FROM vendors WHERE id = v_vendor;
  IF v_vendor_tier = 'blocked' THEN RAISE EXCEPTION 'This supplier is blocked in your Vendor Management'; END IF;

  SELECT COALESCE(NULLIF(company_name, ''), email) INTO v_company FROM profiles WHERE id = v_owner;
  v_number := 'PNO-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO purchase_orders (user_id, vendor_id, status, expected_delivery_date, notes)
  VALUES (v_owner, v_vendor, 'pending_approval', p_expected_delivery,
          left('Procurement Network ' || v_number || ' - ' || v_prog.title || COALESCE(' - ' || NULLIF(btrim(p_notes), ''), ''), 2000))
  RETURNING id INTO v_po;

  INSERT INTO pn_orders (id, order_number, user_id, supplier_id, program_id, program_title, supplier_name, po_id, status, tier_rank_at_order, ship_to, buyer_company, notes)
  VALUES (v_order, v_number, v_owner, v_prog.supplier_id, p_program, v_prog.title, v_sup.name, v_po, 'awaiting_approval', v_tier_rank, v_ship, v_company, left(NULLIF(btrim(p_notes), ''), 2000));

  FOR r IN
    SELECT (e ->> 'catalog_item_id')::uuid AS item_id,
           SUM((e ->> 'qty')::numeric) AS qty,
           (array_agg(NULLIF(e ->> 'part_id', '')::uuid))[1] AS part_id
    FROM jsonb_array_elements(p_lines) e
    GROUP BY 1
  LOOP
    SELECT * INTO ci FROM pn_catalog_items WHERE id = r.item_id AND supplier_id = v_prog.supplier_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'An item in your order is not available in this program'; END IF;
    IF r.qty IS NULL OR r.qty <= 0 OR r.qty > 1000000 THEN RAISE EXCEPTION 'Invalid quantity for %', ci.sku; END IF;
    IF r.qty < ci.min_order_qty THEN RAISE EXCEPTION 'Minimum order quantity for % is %', ci.sku, ci.min_order_qty; END IF;

    v_part := r.part_id;
    IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory_parts WHERE id = v_part AND user_id = v_owner) THEN
      RAISE EXCEPTION 'Invalid inventory part for %', ci.sku;
    END IF;
    IF v_part IS NULL THEN
      SELECT part_id INTO v_part FROM pn_part_links WHERE user_id = v_owner AND catalog_item_id = ci.id;
    END IF;

    v_price := public.pn_unit_price(v_sched, ci.id, v_tier_id, ci.list_price_cents, v_disc);

    v_baseline := ci.list_price_cents;
    IF v_part IS NOT NULL THEN
      SELECT poi.unit_price_cents INTO v_baseline
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
      WHERE po.user_id = v_owner AND poi.part_id = v_part AND po.id <> v_po
        AND po.status NOT IN ('pending_approval', 'cancelled') AND poi.unit_price_cents > 0
      ORDER BY poi.created_at DESC LIMIT 1;
      IF v_baseline IS NULL THEN v_baseline := ci.list_price_cents; END IF;
    END IF;

    INSERT INTO purchase_order_items (user_id, po_id, part_id, description, quantity_ordered, unit_price_cents)
    VALUES (v_owner, v_po, v_part, left(ci.name || ' (' || ci.sku || ')', 400), r.qty, v_price)
    RETURNING id INTO v_po_item;

    INSERT INTO pn_order_lines (order_id, user_id, catalog_item_id, part_id, po_item_id, sku, description, qty, list_price_cents, unit_price_cents)
    VALUES (v_order, v_owner, ci.id, v_part, v_po_item, ci.sku, ci.name, r.qty, ci.list_price_cents, v_price)
    RETURNING id INTO v_line;
    INSERT INTO pn_line_baselines (line_id, user_id, baseline_unit_cents) VALUES (v_line, v_owner, v_baseline);

    v_subtotal := v_subtotal + ROUND(r.qty * v_price)::bigint;
    v_lines := v_lines + 1;
  END LOOP;

  UPDATE pn_orders SET subtotal_cents = v_subtotal WHERE id = v_order;
  PERFORM public.pn_log(v_owner, v_prog.supplier_id, 'order', v_order, 'placed',
    jsonb_build_object('order_number', v_number, 'lines', v_lines, 'subtotal_cents', v_subtotal, 'tier_rank', v_tier_rank));

  RETURN jsonb_build_object('order_id', v_order, 'order_number', v_number, 'po_id', v_po,
                            'subtotal_cents', v_subtotal, 'tier_rank', v_tier_rank, 'lines', v_lines);
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_cancel_order(p_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  o pn_orders%ROWTYPE;
BEGIN
  IF v_owner IS NULL OR NOT public.pn_can_manage() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO o FROM pn_orders WHERE id = p_order AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.status NOT IN ('awaiting_approval', 'placed') THEN
    RAISE EXCEPTION 'This order can no longer be cancelled (status: %)', o.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_programs WHERE id = o.program_id AND status = 'open') THEN
    RAISE EXCEPTION 'The program is closed; this order is final';
  END IF;
  UPDATE pn_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by the buyer' WHERE id = o.id;
  IF o.po_id IS NOT NULL THEN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = o.po_id AND status NOT IN ('received', 'closed', 'cancelled');
  END IF;
  PERFORM public.pn_log(v_owner, o.supplier_id, 'order', o.id, 'cancelled_by_buyer');
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- =============================================================
-- 10. SUPPLIER RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.pn_supplier_apply(
  p_name text, p_legal_name text, p_contact_name text, p_contact_email text, p_phone text,
  p_website text, p_description text, p_regions text[], p_categories text[]
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  IF EXISTS (SELECT 1 FROM pn_supplier_users WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Your account already belongs to a supplier organisation';
  END IF;
  IF COALESCE(array_length(p_regions, 1), 0) > 60 OR COALESCE(array_length(p_categories, 1), 0) > 40 THEN
    RAISE EXCEPTION 'Too many regions or categories';
  END IF;
  INSERT INTO pn_suppliers (name, legal_name, contact_name, contact_email, phone, website, description, regions, categories, status)
  VALUES (btrim(p_name), NULLIF(btrim(p_legal_name), ''), NULLIF(btrim(p_contact_name), ''), btrim(p_contact_email),
          NULLIF(btrim(p_phone), ''), NULLIF(btrim(p_website), ''), NULLIF(btrim(p_description), ''),
          COALESCE(p_regions, '{}'), COALESCE(p_categories, '{}'), 'pending')
  RETURNING id INTO v_id;
  INSERT INTO pn_supplier_users (supplier_id, user_id, role) VALUES (v_id, auth.uid(), 'admin');
  PERFORM public.pn_log(NULL, v_id, 'supplier', v_id, 'applied');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_supplier_update_profile(
  p_supplier uuid, p_contact_name text, p_contact_email text, p_phone text, p_website text,
  p_description text, p_regions text[], p_categories text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pn_is_supplier_admin(p_supplier) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE pn_suppliers SET
    contact_name = NULLIF(btrim(p_contact_name), ''), contact_email = btrim(p_contact_email),
    phone = NULLIF(btrim(p_phone), ''), website = NULLIF(btrim(p_website), ''),
    description = NULLIF(btrim(p_description), ''),
    regions = COALESCE(p_regions, '{}'), categories = COALESCE(p_categories, '{}')
  WHERE id = p_supplier;
  PERFORM public.pn_log(NULL, p_supplier, 'supplier', p_supplier, 'profile_updated');
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_supplier_add_member(p_supplier uuid, p_email text, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid;
BEGIN
  IF NOT public.pn_is_supplier_admin(p_supplier) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(btrim(p_email)) LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No Vireek account with that email yet. Ask them to sign up first.'; END IF;
  INSERT INTO pn_supplier_users (supplier_id, user_id, role) VALUES (p_supplier, v_uid, p_role)
  ON CONFLICT (supplier_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  PERFORM public.pn_log(NULL, p_supplier, 'supplier_user', v_uid, 'member_added', jsonb_build_object('role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_supplier_submit_schedule(p_schedule uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s pn_price_schedules%ROWTYPE;
  v_prog pn_programs%ROWTYPE;
  v_bad integer;
BEGIN
  SELECT * INTO s FROM pn_price_schedules WHERE id = p_schedule;
  IF NOT FOUND THEN RAISE EXCEPTION 'Schedule not found'; END IF;
  SELECT * INTO v_prog FROM pn_programs WHERE id = s.program_id;
  IF NOT (v_prog.supplier_id IN (SELECT public.pn_my_supplier_ids())) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF s.status <> 'draft' THEN RAISE EXCEPTION 'Only draft schedules can be submitted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_volume_tiers WHERE program_id = s.program_id) THEN
    RAISE EXCEPTION 'Add volume tiers first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_price_schedule_lines WHERE schedule_id = p_schedule) THEN
    RAISE EXCEPTION 'Add at least one price line';
  END IF;
  -- Prices may never exceed list, and may never rise as the tier rises.
  SELECT COUNT(*) INTO v_bad FROM pn_price_schedule_lines l JOIN pn_catalog_items ci ON ci.id = l.catalog_item_id
  WHERE l.schedule_id = p_schedule AND l.unit_price_cents > ci.list_price_cents;
  IF v_bad > 0 THEN RAISE EXCEPTION '% price line(s) exceed the list price', v_bad; END IF;
  SELECT COUNT(*) INTO v_bad FROM pn_price_schedule_lines a
    JOIN pn_volume_tiers ta ON ta.id = a.tier_id
    JOIN pn_price_schedule_lines b ON b.schedule_id = a.schedule_id AND b.catalog_item_id = a.catalog_item_id
    JOIN pn_volume_tiers tb ON tb.id = b.tier_id
  WHERE a.schedule_id = p_schedule AND tb.rank > ta.rank AND b.unit_price_cents > a.unit_price_cents;
  IF v_bad > 0 THEN RAISE EXCEPTION 'A higher tier cannot have a higher price than a lower tier (% conflict(s))', v_bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pn_volume_tiers WHERE program_id = s.program_id AND rank = (SELECT MIN(rank) FROM pn_volume_tiers WHERE program_id = s.program_id) AND min_qualifying_cents = 0) THEN
    RAISE EXCEPTION 'The lowest tier must start at 0';
  END IF;
  UPDATE pn_price_schedules SET status = 'proposed', submitted_at = now(), review_note = NULL WHERE id = p_schedule;
  PERFORM public.pn_log(NULL, v_prog.supplier_id, 'schedule', p_schedule, 'submitted');
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_supplier_set_program_status(p_program uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog pn_programs%ROWTYPE;
  v_sup pn_suppliers%ROWTYPE;
  v_n integer;
BEGIN
  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Program not found'; END IF;
  IF NOT public.pn_is_supplier_admin(v_prog.supplier_id) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO v_sup FROM pn_suppliers WHERE id = v_prog.supplier_id;

  IF p_status = 'open' THEN
    IF v_prog.status <> 'draft' THEN RAISE EXCEPTION 'Only draft programs can be opened'; END IF;
    IF v_sup.status <> 'approved' THEN RAISE EXCEPTION 'Your supplier account must be approved first'; END IF;
    IF v_prog.ends_on < current_date THEN RAISE EXCEPTION 'The end date is in the past'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pn_volume_tiers WHERE program_id = p_program AND min_qualifying_cents = 0) THEN
      RAISE EXCEPTION 'Add a base tier starting at 0';
    END IF;
    IF public.pn_active_schedule_id(p_program, false) IS NULL THEN
      RAISE EXCEPTION 'An approved (active) price schedule is required before opening';
    END IF;
    UPDATE pn_programs SET status = 'open' WHERE id = p_program;
  ELSIF p_status = 'cancelled' THEN
    IF v_prog.status NOT IN ('draft', 'open') THEN RAISE EXCEPTION 'This program cannot be cancelled'; END IF;
    SELECT COUNT(*) INTO v_n FROM pn_orders WHERE program_id = p_program AND status <> 'cancelled';
    IF v_n > 0 THEN RAISE EXCEPTION 'Programs with orders cannot be cancelled; close and settle instead'; END IF;
    UPDATE pn_programs SET status = 'cancelled' WHERE id = p_program;
  ELSIF p_status = 'closed' THEN
    IF v_prog.status <> 'open' THEN RAISE EXCEPTION 'Only open programs can be closed'; END IF;
    PERFORM public.pn_settle_program_internal(p_program);
  ELSE
    RAISE EXCEPTION 'Invalid status';
  END IF;
  PERFORM public.pn_log(NULL, v_prog.supplier_id, 'program', p_program, 'status_' || p_status);
  RETURN jsonb_build_object('status', p_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_supplier_update_order(p_order uuid, p_action text, p_tracking text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o pn_orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM pn_orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND OR NOT (o.supplier_id IN (SELECT public.pn_my_supplier_ids())) THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF p_action = 'confirm' THEN
    IF o.status <> 'placed' THEN RAISE EXCEPTION 'Only placed orders can be confirmed'; END IF;
    UPDATE pn_orders SET status = 'confirmed', confirmed_at = now(), supplier_note = COALESCE(left(p_note, 2000), supplier_note) WHERE id = o.id;
  ELSIF p_action = 'ship' THEN
    IF o.status <> 'confirmed' THEN RAISE EXCEPTION 'Confirm the order before shipping'; END IF;
    UPDATE pn_orders SET status = 'shipped', shipped_at = now(), tracking = left(NULLIF(btrim(p_tracking), ''), 200) WHERE id = o.id;
  ELSIF p_action = 'deliver' THEN
    IF o.status <> 'shipped' THEN RAISE EXCEPTION 'Only shipped orders can be marked delivered'; END IF;
    UPDATE pn_orders SET status = 'delivered', delivered_at = now() WHERE id = o.id;
  ELSIF p_action = 'cancel' THEN
    IF o.status NOT IN ('placed', 'confirmed') THEN RAISE EXCEPTION 'This order can no longer be cancelled'; END IF;
    IF char_length(btrim(COALESCE(p_note, ''))) < 3 THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pn_programs WHERE id = o.program_id AND status = 'open') THEN
      RAISE EXCEPTION 'The program is closed; this order is final';
    END IF;
    UPDATE pn_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = left(btrim(p_note), 500) WHERE id = o.id;
    IF o.po_id IS NOT NULL THEN
      UPDATE purchase_orders SET status = 'cancelled' WHERE id = o.po_id AND status NOT IN ('received', 'closed', 'cancelled');
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid action';
  END IF;
  PERFORM public.pn_log(o.user_id, o.supplier_id, 'order', o.id, 'supplier_' || p_action);
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_supplier_mark_rebate_paid(p_rebate uuid, p_reference text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r pn_rebates%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pn_rebates WHERE id = p_rebate FOR UPDATE;
  IF NOT FOUND OR NOT public.pn_is_supplier_admin(r.supplier_id) THEN RAISE EXCEPTION 'Rebate not found'; END IF;
  IF r.status <> 'accrued' THEN RAISE EXCEPTION 'Only accrued rebates can be marked paid'; END IF;
  UPDATE pn_rebates SET status = 'paid', paid_at = now(), paid_reference = left(NULLIF(btrim(p_reference), ''), 200) WHERE id = r.id;
  PERFORM public.pn_log(r.user_id, r.supplier_id, 'rebate', r.id, 'paid', jsonb_build_object('amount_cents', r.amount_cents));
END;
$$;

-- Aggregated pool view for a supplier: never per-tenant. Per-item numbers also obey the cohort.
CREATE OR REPLACE FUNCTION public.pn_supplier_program_stats(p_program uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog pn_programs%ROWTYPE;
  v_items jsonb;
BEGIN
  SELECT * INTO v_prog FROM pn_programs WHERE id = p_program;
  IF NOT FOUND OR NOT (v_prog.supplier_id IN (SELECT public.pn_my_supplier_ids())) THEN RAISE EXCEPTION 'Program not found'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('catalog_item_id', x.item_id, 'sku', ci.sku, 'name', ci.name,
           'ordered_qty', x.ordered_qty, 'committed_qty', x.committed_qty) ORDER BY ci.name), '[]'::jsonb) INTO v_items
  FROM (
    SELECT item_id,
           COUNT(DISTINCT user_id) AS tenants,
           SUM(ordered_qty) AS ordered_qty,
           SUM(committed_qty) AS committed_qty
    FROM (
      SELECT l.catalog_item_id AS item_id, o.user_id, l.qty AS ordered_qty, 0::numeric AS committed_qty
      FROM pn_order_lines l JOIN pn_orders o ON o.id = l.order_id
      WHERE o.program_id = p_program AND o.status IN ('placed', 'confirmed', 'shipped', 'delivered')
      UNION ALL
      SELECT c.catalog_item_id, c.user_id, 0::numeric, c.committed_qty FROM pn_commitments c WHERE c.program_id = p_program
    ) u GROUP BY item_id
  ) x JOIN pn_catalog_items ci ON ci.id = x.item_id
  WHERE x.tenants >= public.pn_min_cohort();

  RETURN jsonb_build_object(
    'pool', public.pn_pool_public(p_program),
    'items', v_items,
    'orders', (SELECT COUNT(*) FROM pn_orders WHERE program_id = p_program AND status NOT IN ('awaiting_approval', 'cancelled')),
    'rebates_accrued_cents', COALESCE((SELECT SUM(amount_cents) FROM pn_rebates WHERE program_id = p_program AND status = 'accrued'), 0),
    'rebates_paid_cents', COALESCE((SELECT SUM(amount_cents) FROM pn_rebates WHERE program_id = p_program AND status = 'paid'), 0)
  );
END;
$$;

-- =============================================================
-- 11. STAFF RPCs (network operator: onboarding + price negotiation)
-- =============================================================

CREATE OR REPLACE FUNCTION public.pn_staff_review_supplier(p_supplier uuid, p_decision text, p_notes text, p_w9 boolean DEFAULT NULL, p_insurance boolean DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pn_is_staff() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_decision NOT IN ('approved', 'rejected', 'suspended') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  IF p_decision = 'approved' AND NOT (COALESCE(p_w9, (SELECT w9_verified FROM pn_suppliers WHERE id = p_supplier), false)
                                      AND COALESCE(p_insurance, (SELECT insurance_verified FROM pn_suppliers WHERE id = p_supplier), false)) THEN
    RAISE EXCEPTION 'W-9 and insurance must be verified before approval';
  END IF;
  UPDATE pn_suppliers SET status = p_decision, review_notes = left(p_notes, 2000), reviewed_by = auth.uid(), reviewed_at = now(),
    w9_verified = COALESCE(p_w9, w9_verified), insurance_verified = COALESCE(p_insurance, insurance_verified)
  WHERE id = p_supplier;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  PERFORM public.pn_log(NULL, p_supplier, 'supplier', p_supplier, 'review_' || p_decision, jsonb_build_object('notes', left(p_notes, 500)));
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_staff_review_schedule(p_schedule uuid, p_decision text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s pn_price_schedules%ROWTYPE; v_sup uuid;
BEGIN
  IF NOT public.pn_is_staff() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO s FROM pn_price_schedules WHERE id = p_schedule FOR UPDATE;
  IF NOT FOUND OR s.status <> 'proposed' THEN RAISE EXCEPTION 'Only proposed schedules can be reviewed'; END IF;
  SELECT supplier_id INTO v_sup FROM pn_programs WHERE id = s.program_id;
  IF p_decision = 'approve' THEN
    UPDATE pn_price_schedules SET status = 'superseded' WHERE program_id = s.program_id AND status = 'active';
    UPDATE pn_price_schedules SET status = 'active', valid_from = COALESCE(valid_from, current_date),
      reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(p_note, 2000) WHERE id = p_schedule;
  ELSIF p_decision = 'counter' THEN
    IF char_length(btrim(COALESCE(p_note, ''))) < 3 THEN RAISE EXCEPTION 'A counter-proposal note is required'; END IF;
    UPDATE pn_price_schedules SET status = 'countered', reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(p_note, 2000)
    WHERE id = p_schedule;
  ELSE
    RAISE EXCEPTION 'Invalid decision';
  END IF;
  PERFORM public.pn_log(NULL, v_sup, 'schedule', p_schedule, 'review_' || p_decision, jsonb_build_object('note', left(p_note, 500)));
END;
$$;

CREATE OR REPLACE FUNCTION public.pn_staff_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pn_is_staff() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  RETURN jsonb_build_object(
    'pending_suppliers', COALESCE((SELECT jsonb_agg(to_jsonb(s) - 'review_notes' ORDER BY s.created_at) FROM pn_suppliers s WHERE s.status = 'pending'), '[]'::jsonb),
    'proposed_schedules', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', sc.id, 'version', sc.version, 'submitted_at', sc.submitted_at, 'supplier_note', sc.supplier_note,
        'program_id', p.id, 'program_title', p.title, 'supplier_name', su.name,
        'lines', (SELECT COUNT(*) FROM pn_price_schedule_lines l WHERE l.schedule_id = sc.id)
      ) ORDER BY sc.submitted_at) FROM pn_price_schedules sc JOIN pn_programs p ON p.id = sc.program_id JOIN pn_suppliers su ON su.id = p.supplier_id
      WHERE sc.status = 'proposed'), '[]'::jsonb),
    'network', jsonb_build_object(
      'members', (SELECT COUNT(*) FROM pn_memberships WHERE status = 'active'),
      'approved_suppliers', (SELECT COUNT(*) FROM pn_suppliers WHERE status = 'approved'),
      'open_programs', (SELECT COUNT(*) FROM pn_programs WHERE status = 'open'),
      'orders_gmv_cents', COALESCE((SELECT SUM(subtotal_cents) FROM pn_orders WHERE status NOT IN ('awaiting_approval', 'cancelled')), 0)
    )
  );
END;
$$;

-- =============================================================
-- 12. GRANTS  (internal helpers are NOT callable by clients)
-- =============================================================

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'pn_log(uuid, uuid, text, uuid, text, jsonb)',
    'pn_active_schedule_id(uuid, boolean)',
    'pn_unit_price(uuid, uuid, uuid, integer, integer)',
    'pn_pool_state(uuid)',
    'pn_pool_public(uuid)',
    'pn_vendor_for_supplier(uuid, uuid)',
    'pn_settle_program_internal(uuid)',
    'pn_close_expired_programs()',
    'pn_sync_order_from_po()',
    'pn_validate_schedule_line()',
    'pn_set_schedule_version()',
    'pn_guard_list_price()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'pn_can_manage()', 'pn_is_staff()', 'pn_my_supplier_ids()', 'pn_is_supplier_admin(uuid)', 'pn_min_cohort()',
    'pn_join_network(text, text[], boolean)', 'pn_leave_network()', 'pn_list_programs()', 'pn_program_detail(uuid)',
    'pn_set_commitment(uuid, uuid, numeric)', 'pn_place_order(uuid, jsonb, jsonb, text, date)', 'pn_cancel_order(uuid)',
    'pn_supplier_apply(text, text, text, text, text, text, text, text[], text[])',
    'pn_supplier_update_profile(uuid, text, text, text, text, text, text[], text[])',
    'pn_supplier_add_member(uuid, text, text)', 'pn_supplier_submit_schedule(uuid)',
    'pn_supplier_set_program_status(uuid, text)', 'pn_supplier_update_order(uuid, text, text, text)',
    'pn_supplier_mark_rebate_paid(uuid, text)', 'pn_supplier_program_stats(uuid)',
    'pn_staff_review_supplier(uuid, text, text, boolean, boolean)', 'pn_staff_review_schedule(uuid, text, text)', 'pn_staff_overview()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;
