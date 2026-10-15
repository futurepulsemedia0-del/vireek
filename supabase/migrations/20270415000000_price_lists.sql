/*
  # Price Lists (per-customer / per-contract / tier pricing)

  ## Why
  The Live Price Book (`price_book_items`) holds ONE price per service. Real
  service businesses sell the same service at different prices depending on
  who is buying: a negotiated rate for a commercial account, a members-only
  discount, a contractor/trade tier, a one-off price written into a contract.

  ## What this adds
  - `price_lists`: a named list that targets exactly one of
      * a customer          (scope = 'customer')
      * a commercial contract (scope = 'contract')
      * a tier              (scope = 'tier'; tier = commercial | membership | contractor,
                             optionally narrowed to one membership plan)
    with an effective date window, a priority and a draft/active/archived status.
  - `price_list_items`: per-service overrides of a price-book item. An override is
      * fixed       (value = new price, in cents)
      * percent_off (value = percent, 0-100)
      * percent_up  (value = percent, 0-500)
      * amount_off  (value = cents taken off)
    Services without an override simply fall through to the price book.

  ## Resolution order (enforced in src/lib/priceLists.ts, not in SQL)
  contract > customer > tier, then higher priority, then most recent effective_from.

  ## RLS
  Reads: anyone in the account (dispatchers/CSRs need to quote from these).
  Writes: owners/admins and team members with can_view_billing — the same bar
  as the Price Accuracy / Underpriced Jobs pages. Every write is also checked
  so a row can never point at another tenant's customer/contract/plan/price item.

  NOTE: keep this file's timestamp AFTER your newest migration.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Writers: owner/admin, or a team member with billing permission.
CREATE OR REPLACE FUNCTION public.pl_is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'))
    OR EXISTS (
      SELECT 1 FROM team_members m
      WHERE m.user_id = auth.uid()
        AND coalesce((m.permissions ->> 'can_view_billing')::boolean, false)
    )
  );
$$;

-- Referenced rows must belong to the caller's account. SECURITY DEFINER so the
-- check works for team members even where the referenced table's own RLS is
-- narrower (price_book_items is still owner-only on SELECT).
CREATE OR REPLACE FUNCTION public.pl_refs_ok(p_customer uuid, p_contract uuid, p_plan uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (p_customer IS NULL OR EXISTS (SELECT 1 FROM customers c WHERE c.id = p_customer AND c.user_id = public.get_account_owner_id()))
    AND (p_contract IS NULL OR EXISTS (SELECT 1 FROM commercial_contracts k WHERE k.id = p_contract AND k.user_id = public.get_account_owner_id()))
    AND (p_plan IS NULL OR EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.id = p_plan AND mp.user_id = public.get_account_owner_id()));
$$;

CREATE OR REPLACE FUNCTION public.pl_item_refs_ok(p_list uuid, p_book_item uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM price_lists l WHERE l.id = p_list AND l.account_owner_id = public.get_account_owner_id())
    AND EXISTS (SELECT 1 FROM price_book_items b WHERE b.id = p_book_item AND b.user_id = public.get_account_owner_id());
$$;

REVOKE ALL ON FUNCTION public.pl_is_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pl_refs_ok(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pl_item_refs_ok(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pl_is_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pl_refs_ok(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pl_item_refs_ok(uuid, uuid) TO authenticated;

-- 1) Price lists -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,

  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 1000),

  scope text NOT NULL CHECK (scope IN ('customer', 'contract', 'tier')),
  tier text CHECK (tier IN ('commercial', 'membership', 'contractor')),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  membership_plan_id uuid REFERENCES membership_plans(id) ON DELETE CASCADE,

  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  effective_from date NOT NULL DEFAULT current_date,
  effective_to date,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT price_lists_dates_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT price_lists_target_ck CHECK (
    (scope = 'customer' AND customer_id IS NOT NULL AND contract_id IS NULL AND tier IS NULL AND membership_plan_id IS NULL)
    OR (scope = 'contract' AND contract_id IS NOT NULL AND customer_id IS NULL AND tier IS NULL AND membership_plan_id IS NULL)
    OR (scope = 'tier' AND tier IS NOT NULL AND customer_id IS NULL AND contract_id IS NULL
        AND (membership_plan_id IS NULL OR tier = 'membership'))
  )
);

CREATE INDEX IF NOT EXISTS idx_price_lists_owner_status ON price_lists (account_owner_id, status, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_price_lists_customer ON price_lists (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_lists_contract ON price_lists (contract_id) WHERE contract_id IS NOT NULL;

-- 2) Per-service overrides ---------------------------------------------------
CREATE TABLE IF NOT EXISTS price_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES auth.users(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  price_book_item_id uuid NOT NULL REFERENCES price_book_items(id) ON DELETE CASCADE,

  adjustment_type text NOT NULL CHECK (adjustment_type IN ('fixed', 'percent_off', 'percent_up', 'amount_off')),
  -- cents for fixed / amount_off; percent for percent_off / percent_up
  value numeric(12, 2) NOT NULL CHECK (value >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (price_list_id, price_book_item_id),
  CONSTRAINT price_list_items_value_ck CHECK (
    (adjustment_type = 'percent_off' AND value <= 100)
    OR (adjustment_type = 'percent_up' AND value <= 500)
    OR (adjustment_type IN ('fixed', 'amount_off') AND value = trunc(value))
  )
);

CREATE INDEX IF NOT EXISTS idx_price_list_items_book_item ON price_list_items (price_book_item_id);
CREATE INDEX IF NOT EXISTS idx_price_list_items_owner ON price_list_items (account_owner_id);

DROP TRIGGER IF EXISTS trg_price_lists_updated_at ON price_lists;
CREATE TRIGGER trg_price_lists_updated_at BEFORE UPDATE ON price_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_price_list_items_updated_at ON price_list_items;
CREATE TRIGGER trg_price_list_items_updated_at BEFORE UPDATE ON price_list_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3) RLS ---------------------------------------------------------------------
ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "price_lists_read" ON price_lists;
CREATE POLICY "price_lists_read" ON price_lists FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "price_lists_insert" ON price_lists;
CREATE POLICY "price_lists_insert" ON price_lists FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.pl_is_manager()
    AND public.pl_refs_ok(customer_id, contract_id, membership_plan_id)
  );

DROP POLICY IF EXISTS "price_lists_update" ON price_lists;
CREATE POLICY "price_lists_update" ON price_lists FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.pl_is_manager())
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.pl_is_manager()
    AND public.pl_refs_ok(customer_id, contract_id, membership_plan_id)
  );

DROP POLICY IF EXISTS "price_lists_delete" ON price_lists;
CREATE POLICY "price_lists_delete" ON price_lists FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.pl_is_manager());

DROP POLICY IF EXISTS "price_list_items_read" ON price_list_items;
CREATE POLICY "price_list_items_read" ON price_list_items FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "price_list_items_insert" ON price_list_items;
CREATE POLICY "price_list_items_insert" ON price_list_items FOR INSERT TO authenticated
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.pl_is_manager()
    AND public.pl_item_refs_ok(price_list_id, price_book_item_id)
  );

DROP POLICY IF EXISTS "price_list_items_update" ON price_list_items;
CREATE POLICY "price_list_items_update" ON price_list_items FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.pl_is_manager())
  WITH CHECK (
    account_owner_id = public.get_account_owner_id()
    AND public.pl_is_manager()
    AND public.pl_item_refs_ok(price_list_id, price_book_item_id)
  );

DROP POLICY IF EXISTS "price_list_items_delete" ON price_list_items;
CREATE POLICY "price_list_items_delete" ON price_list_items FOR DELETE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.pl_is_manager());

-- 4) Team members can READ their account's price book --------------------------
-- price_book_items was created with owner-only SELECT (user_id = auth.uid()).
-- Price lists override those rows, so billing-permission team members need to
-- see them to build lists. Additive (permissive policies are OR-ed); the
-- original owner policies are untouched. Delete this block if you want the
-- price book to stay owner-only.
DROP POLICY IF EXISTS "select_account_price_book_items" ON price_book_items;
CREATE POLICY "select_account_price_book_items" ON price_book_items FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
