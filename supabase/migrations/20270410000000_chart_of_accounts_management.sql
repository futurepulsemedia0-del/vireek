/*
  # Chart of Accounts management — editor, service mapping, period locking

  ## Why
  20261203000001_accounting_general_ledger.sql created chart_of_accounts and
  accounting_periods, but the only way to touch them was a seed function and
  a name-only upsert. There was no way to retype/re-parent/deactivate an
  account, nothing mapped a service to a revenue account, and no RPC could
  ever close (or reopen) a period — so the "closed period" guard in
  post_journal_entry() could never actually fire.

  ## What this adds (nothing existing is altered except one nullable column)
  1. chart_of_accounts.description (nullable).
  2. service_account_mappings — service name -> revenue account, per account
     owner, case-insensitive unique.
  3. accounting_audit_events — append-only trail for account edits, service
     mappings and period open/close.
  4. can_manage_chart_of_accounts() — owner, or team member with
     can_view_billing (same rule as 20270301000000_receivables_intelligence).
  5. RPCs (all SECURITY DEFINER, all scoped by get_account_owner_id()):
       get_chart_of_accounts_overview, create_chart_account,
       update_chart_account, set_chart_account_active,
       get_service_mapping_overview, upsert_service_account_mapping,
       delete_service_account_mapping, resolve_service_revenue_account,
       get_accounting_periods_overview, set_accounting_period_status,
       lock_accounting_periods_through.

  ## Safety rules enforced server-side
  - Accounts with ledger activity can never change type or contra-ness.
  - System accounts keep their code/type and can't be deactivated.
  - An account can only be deactivated at a zero posted balance, with no
    active sub-accounts, no service mappings and no linked bank account.
  - Sub-accounts must share their parent's type; re-parenting can't create a
    cycle.
  - Only the account owner can reopen a closed period, and must give a reason.
  - Every state change writes an audit event.

  RLS: new tables are SELECT-only for authenticated users who pass
  can_manage_chart_of_accounts(); every write goes through the RPCs.
*/

-- =============================================================
-- COLUMN
-- =============================================================

ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS description text;

-- =============================================================
-- ACCESS HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_chart_of_accounts()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.account_owner_id = public.get_account_owner_id()
        AND COALESCE((tm.permissions ->> 'can_view_billing')::boolean, false)
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_chart_of_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_chart_of_accounts() TO authenticated;

-- Returns the account owner id, or raises. Every write RPC starts here.
CREATE OR REPLACE FUNCTION public._coa_require_manager()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_manage_chart_of_accounts() THEN
    RAISE EXCEPTION 'You do not have permission to manage the chart of accounts' USING ERRCODE = '42501';
  END IF;
  v_user := public.get_account_owner_id();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No account found for this user' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public._coa_require_manager() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._coa_natural_balance(p_type text, p_contra boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN (p_type IN ('asset', 'expense')) <> COALESCE(p_contra, false) THEN 'debit'
    ELSE 'credit'
  END;
$$;

REVOKE ALL ON FUNCTION public._coa_natural_balance(text, boolean) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- AUDIT TRAIL
-- =============================================================

CREATE TABLE IF NOT EXISTS accounting_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'service_mapping', 'period')),
  entity_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounting_audit_events_user ON accounting_audit_events(user_id, created_at DESC);

ALTER TABLE accounting_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_accounting_audit_events" ON accounting_audit_events;
CREATE POLICY "select_own_accounting_audit_events" ON accounting_audit_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_chart_of_accounts());

CREATE OR REPLACE FUNCTION public._coa_audit(p_user uuid, p_entity_type text, p_entity_id uuid, p_action text, p_detail jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO accounting_audit_events (user_id, actor_id, entity_type, entity_id, action, detail)
  VALUES (p_user, auth.uid(), p_entity_type, p_entity_id, p_action, COALESCE(p_detail, '{}'::jsonb));
$$;

REVOKE ALL ON FUNCTION public._coa_audit(uuid, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- SERVICE -> REVENUE ACCOUNT MAPPING
-- =============================================================

CREATE TABLE IF NOT EXISTS service_account_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  service_name text NOT NULL CHECK (char_length(btrim(service_name)) BETWEEN 1 AND 120),
  revenue_account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_account_mappings_name
  ON service_account_mappings (user_id, (lower(btrim(service_name))));
CREATE INDEX IF NOT EXISTS idx_service_account_mappings_account ON service_account_mappings(revenue_account_id);

ALTER TABLE service_account_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_service_account_mappings" ON service_account_mappings;
CREATE POLICY "select_own_service_account_mappings" ON service_account_mappings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_chart_of_accounts());

-- =============================================================
-- RPC: get_chart_of_accounts_overview
-- All accounts (active and inactive) with ledger usage and posted balance.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_chart_of_accounts_overview()
RETURNS TABLE (
  id uuid, code text, name text, type text, normal_balance text,
  is_system boolean, is_active boolean, parent_account_id uuid, description text,
  line_count bigint, balance_cents bigint, mapping_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._coa_require_manager();

  RETURN QUERY
  SELECT
    c.id, c.code, c.name, c.type, c.normal_balance,
    c.is_system, c.is_active, c.parent_account_id, c.description,
    COALESCE(t.line_count, 0)::bigint,
    CASE WHEN c.normal_balance = 'debit'
      THEN COALESCE(t.debit_sum, 0) - COALESCE(t.credit_sum, 0)
      ELSE COALESCE(t.credit_sum, 0) - COALESCE(t.debit_sum, 0)
    END::bigint,
    (SELECT count(*) FROM service_account_mappings m WHERE m.revenue_account_id = c.id)::bigint
  FROM chart_of_accounts c
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS line_count,
      sum(jl.debit_cents) FILTER (WHERE je.status = 'posted') AS debit_sum,
      sum(jl.credit_cents) FILTER (WHERE je.status = 'posted') AS credit_sum
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = c.id
  ) t ON true
  WHERE c.user_id = v_user
  ORDER BY c.code;
END;
$$;

REVOKE ALL ON FUNCTION public.get_chart_of_accounts_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_chart_of_accounts_overview() TO authenticated;

-- =============================================================
-- RPC: create_chart_account
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_chart_account(
  p_code text,
  p_name text,
  p_type text,
  p_parent_account_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_contra boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_code text := btrim(p_code);
  v_name text := btrim(p_name);
  v_desc text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_parent chart_of_accounts%ROWTYPE;
  v_id uuid;
BEGIN
  v_user := public._coa_require_manager();

  IF v_code IS NULL OR v_code !~ '^[0-9A-Za-z][0-9A-Za-z.-]{1,15}$' THEN
    RAISE EXCEPTION 'Account code must be 2-16 characters: letters, numbers, dots or dashes';
  END IF;
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Account name is required (max 120 characters)';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('asset', 'liability', 'equity', 'revenue', 'expense') THEN
    RAISE EXCEPTION 'Invalid account type';
  END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 500 THEN
    RAISE EXCEPTION 'Description is limited to 500 characters';
  END IF;

  IF p_parent_account_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM chart_of_accounts WHERE id = p_parent_account_id AND user_id = v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'Parent account not found'; END IF;
    IF NOT v_parent.is_active THEN RAISE EXCEPTION 'Parent account is inactive'; END IF;
    IF v_parent.type <> p_type THEN RAISE EXCEPTION 'A sub-account must have the same type as its parent'; END IF;
  END IF;

  BEGIN
    INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, parent_account_id, description)
    VALUES (v_user, v_code, v_name, p_type, public._coa_natural_balance(p_type, p_contra), p_parent_account_id, v_desc)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Account code % is already in use', v_code;
  END;

  PERFORM public._coa_audit(v_user, 'account', v_id, 'created',
    jsonb_build_object('code', v_code, 'name', v_name, 'type', p_type, 'contra', COALESCE(p_contra, false)));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_chart_account(text, text, text, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_chart_account(text, text, text, uuid, text, boolean) TO authenticated;

-- =============================================================
-- RPC: update_chart_account (full new state)
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_chart_account(
  p_id uuid,
  p_code text,
  p_name text,
  p_type text,
  p_contra boolean,
  p_parent_account_id uuid,
  p_description text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_row chart_of_accounts%ROWTYPE;
  v_parent chart_of_accounts%ROWTYPE;
  v_code text := btrim(p_code);
  v_name text := btrim(p_name);
  v_desc text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_nb text;
  v_cycle boolean;
BEGIN
  v_user := public._coa_require_manager();

  SELECT * INTO v_row FROM chart_of_accounts WHERE id = p_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  IF v_code IS NULL OR v_code !~ '^[0-9A-Za-z][0-9A-Za-z.-]{1,15}$' THEN
    RAISE EXCEPTION 'Account code must be 2-16 characters: letters, numbers, dots or dashes';
  END IF;
  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Account name is required (max 120 characters)';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('asset', 'liability', 'equity', 'revenue', 'expense') THEN
    RAISE EXCEPTION 'Invalid account type';
  END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 500 THEN
    RAISE EXCEPTION 'Description is limited to 500 characters';
  END IF;

  v_nb := public._coa_natural_balance(p_type, p_contra);

  IF v_code <> v_row.code AND v_row.is_system THEN
    RAISE EXCEPTION 'The code of a system account cannot be changed';
  END IF;

  IF p_type <> v_row.type OR v_nb <> v_row.normal_balance THEN
    IF v_row.is_system THEN
      RAISE EXCEPTION 'The type of a system account cannot be changed';
    END IF;
    IF EXISTS (SELECT 1 FROM journal_lines WHERE account_id = p_id) THEN
      RAISE EXCEPTION 'This account has ledger activity, so its type cannot change. Create a new account and use it for future postings.';
    END IF;
    IF EXISTS (SELECT 1 FROM chart_of_accounts WHERE parent_account_id = p_id AND type <> p_type) THEN
      RAISE EXCEPTION 'Retype or move its sub-accounts first';
    END IF;
    IF p_type <> 'revenue' AND EXISTS (SELECT 1 FROM service_account_mappings WHERE revenue_account_id = p_id) THEN
      RAISE EXCEPTION 'Remove this account''s service mappings before changing it away from revenue';
    END IF;
  END IF;

  IF p_parent_account_id IS NOT NULL THEN
    IF p_parent_account_id = p_id THEN RAISE EXCEPTION 'An account cannot be its own parent'; END IF;
    SELECT * INTO v_parent FROM chart_of_accounts WHERE id = p_parent_account_id AND user_id = v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'Parent account not found'; END IF;
    IF v_parent.type <> p_type THEN RAISE EXCEPTION 'A sub-account must have the same type as its parent'; END IF;
    IF p_parent_account_id IS DISTINCT FROM v_row.parent_account_id AND NOT v_parent.is_active THEN
      RAISE EXCEPTION 'Parent account is inactive';
    END IF;

    -- UNION (not UNION ALL) so pre-existing bad data can never loop forever.
    WITH RECURSIVE anc(id, parent_account_id) AS (
      SELECT c.id, c.parent_account_id FROM chart_of_accounts c WHERE c.id = p_parent_account_id AND c.user_id = v_user
      UNION
      SELECT c.id, c.parent_account_id FROM chart_of_accounts c JOIN anc a ON c.id = a.parent_account_id WHERE c.user_id = v_user
    )
    SELECT EXISTS (SELECT 1 FROM anc WHERE id = p_id) INTO v_cycle;
    IF v_cycle THEN RAISE EXCEPTION 'That parent would create a loop in the account tree'; END IF;
  END IF;

  IF v_code = v_row.code AND v_name = v_row.name AND p_type = v_row.type AND v_nb = v_row.normal_balance
     AND p_parent_account_id IS NOT DISTINCT FROM v_row.parent_account_id
     AND v_desc IS NOT DISTINCT FROM v_row.description THEN
    RETURN;
  END IF;

  BEGIN
    UPDATE chart_of_accounts SET
      code = v_code, name = v_name, type = p_type, normal_balance = v_nb,
      parent_account_id = p_parent_account_id, description = v_desc, updated_at = now()
    WHERE id = p_id AND user_id = v_user;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Account code % is already in use', v_code;
  END;

  PERFORM public._coa_audit(v_user, 'account', p_id, 'updated', jsonb_build_object(
    'before', jsonb_build_object('code', v_row.code, 'name', v_row.name, 'type', v_row.type, 'normal_balance', v_row.normal_balance, 'parent_account_id', v_row.parent_account_id),
    'after', jsonb_build_object('code', v_code, 'name', v_name, 'type', p_type, 'normal_balance', v_nb, 'parent_account_id', p_parent_account_id)
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.update_chart_account(uuid, text, text, text, boolean, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_chart_account(uuid, text, text, text, boolean, uuid, text) TO authenticated;

-- =============================================================
-- RPC: set_chart_account_active
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_chart_account_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_row chart_of_accounts%ROWTYPE;
  v_balance bigint;
  v_linked boolean := false;
BEGIN
  v_user := public._coa_require_manager();

  SELECT * INTO v_row FROM chart_of_accounts WHERE id = p_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_row.is_active = p_active THEN RETURN; END IF;

  IF p_active THEN
    IF v_row.parent_account_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM chart_of_accounts WHERE id = v_row.parent_account_id AND NOT is_active
    ) THEN
      RAISE EXCEPTION 'Reactivate the parent account first';
    END IF;
  ELSE
    IF v_row.is_system THEN
      RAISE EXCEPTION 'System accounts are used by invoicing, payroll and banking and cannot be deactivated';
    END IF;
    IF EXISTS (SELECT 1 FROM chart_of_accounts WHERE parent_account_id = p_id AND user_id = v_user AND is_active) THEN
      RAISE EXCEPTION 'Deactivate or move its active sub-accounts first';
    END IF;
    IF EXISTS (SELECT 1 FROM service_account_mappings WHERE revenue_account_id = p_id) THEN
      RAISE EXCEPTION 'Remap the services that post to this account first';
    END IF;
    IF to_regclass('public.bank_accounts') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM bank_accounts WHERE gl_account_id = $1)' INTO v_linked USING p_id;
      IF v_linked THEN RAISE EXCEPTION 'A connected bank account posts to this account'; END IF;
    END IF;

    SELECT COALESCE(sum(jl.debit_cents - jl.credit_cents), 0) INTO v_balance
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.account_id = p_id AND je.status = 'posted';
    IF v_balance <> 0 THEN
      RAISE EXCEPTION 'This account still has a balance of % cents. Transfer it out before deactivating.', abs(v_balance);
    END IF;
  END IF;

  UPDATE chart_of_accounts SET is_active = p_active, updated_at = now() WHERE id = p_id AND user_id = v_user;
  PERFORM public._coa_audit(v_user, 'account', p_id, CASE WHEN p_active THEN 'reactivated' ELSE 'deactivated' END,
    jsonb_build_object('code', v_row.code, 'name', v_row.name));
END;
$$;

REVOKE ALL ON FUNCTION public.set_chart_account_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_chart_account_active(uuid, boolean) TO authenticated;

-- =============================================================
-- RPCs: service mapping
-- =============================================================

-- Union of services from the price book, past jobs and existing mappings,
-- so unmapped real-world services are visible without any manual entry.
CREATE OR REPLACE FUNCTION public.get_service_mapping_overview()
RETURNS TABLE (
  service_name text, in_price_book boolean, job_count bigint,
  mapping_id uuid, revenue_account_id uuid, notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._coa_require_manager();

  RETURN QUERY
  WITH pb AS (
    SELECT lower(btrim(p.service_name)) AS k, min(btrim(p.service_name)) AS nm
    FROM price_book_items p
    WHERE p.user_id = v_user AND p.active AND btrim(p.service_name) <> ''
    GROUP BY 1
  ), jb AS (
    SELECT lower(btrim(j.service_type)) AS k, min(btrim(j.service_type)) AS nm, count(*) AS cnt
    FROM jobs j
    WHERE j.user_id = v_user AND j.service_type IS NOT NULL AND btrim(j.service_type) <> ''
    GROUP BY 1
  ), mp AS (
    SELECT lower(btrim(m.service_name)) AS k, m.id, m.service_name AS nm, m.revenue_account_id AS rev, m.notes AS nts
    FROM service_account_mappings m
    WHERE m.user_id = v_user
  ), keys AS (
    SELECT pb.k FROM pb UNION SELECT jb.k FROM jb UNION SELECT mp.k FROM mp
  )
  SELECT
    COALESCE(mp.nm, pb.nm, jb.nm)::text,
    (pb.k IS NOT NULL),
    COALESCE(jb.cnt, 0)::bigint,
    mp.id, mp.rev, mp.nts
  FROM keys
  LEFT JOIN pb ON pb.k = keys.k
  LEFT JOIN jb ON jb.k = keys.k
  LEFT JOIN mp ON mp.k = keys.k
  ORDER BY (mp.id IS NOT NULL), COALESCE(jb.cnt, 0) DESC, 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_service_mapping_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_service_mapping_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_service_account_mapping(
  p_service_name text,
  p_revenue_account_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_name text := btrim(p_service_name);
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_acct chart_of_accounts%ROWTYPE;
  v_id uuid;
BEGIN
  v_user := public._coa_require_manager();

  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Service name is required (max 120 characters)';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 300 THEN
    RAISE EXCEPTION 'Notes are limited to 300 characters';
  END IF;

  SELECT * INTO v_acct FROM chart_of_accounts WHERE id = p_revenue_account_id AND user_id = v_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_acct.type <> 'revenue' THEN RAISE EXCEPTION 'Services can only post to revenue accounts'; END IF;
  IF NOT v_acct.is_active THEN RAISE EXCEPTION 'That account is inactive'; END IF;

  INSERT INTO service_account_mappings (user_id, service_name, revenue_account_id, notes)
  VALUES (v_user, v_name, p_revenue_account_id, v_notes)
  ON CONFLICT (user_id, (lower(btrim(service_name))))
  DO UPDATE SET revenue_account_id = EXCLUDED.revenue_account_id, notes = EXCLUDED.notes, updated_at = now()
  RETURNING id INTO v_id;

  PERFORM public._coa_audit(v_user, 'service_mapping', v_id, 'mapped',
    jsonb_build_object('service', v_name, 'account_code', v_acct.code, 'account_name', v_acct.name));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_service_account_mapping(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_service_account_mapping(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_service_account_mapping(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_name text;
BEGIN
  v_user := public._coa_require_manager();
  DELETE FROM service_account_mappings WHERE id = p_id AND user_id = v_user RETURNING service_name INTO v_name;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Mapping not found'; END IF;
  PERFORM public._coa_audit(v_user, 'service_mapping', p_id, 'unmapped', jsonb_build_object('service', v_name));
END;
$$;

REVOKE ALL ON FUNCTION public.delete_service_account_mapping(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_service_account_mapping(uuid) TO authenticated;

-- Read-only resolver for invoicing code. Any team member who can create an
-- invoice may call it; it only ever returns the owner's active revenue account.
CREATE OR REPLACE FUNCTION public.resolve_service_revenue_account(p_service_name text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.revenue_account_id
  FROM service_account_mappings m
  JOIN chart_of_accounts c ON c.id = m.revenue_account_id AND c.is_active
  WHERE auth.uid() IS NOT NULL
    AND m.user_id = public.get_account_owner_id()
    AND lower(btrim(m.service_name)) = lower(btrim(p_service_name))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_service_revenue_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_service_revenue_account(text) TO authenticated;

-- =============================================================
-- RPCs: period locking
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_accounting_periods_overview(p_year integer)
RETURNS TABLE (period_start date, period_end date, status text, closed_at timestamptz, entry_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._coa_require_manager();
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'Year out of range';
  END IF;

  RETURN QUERY
  SELECT
    m.s,
    (m.s + interval '1 month' - interval '1 day')::date,
    CASE WHEN cl.n > 0 THEN 'closed' ELSE 'open' END,
    cl.last_closed,
    (SELECT count(*) FROM journal_entries je
      WHERE je.user_id = v_user AND je.status = 'posted'
        AND je.entry_date BETWEEN m.s AND (m.s + interval '1 month' - interval '1 day')::date)::bigint
  FROM (SELECT g::date AS s FROM generate_series(make_date(p_year, 1, 1), make_date(p_year, 12, 1), interval '1 month') g) m
  CROSS JOIN LATERAL (
    SELECT count(*) AS n, max(ap.closed_at) AS last_closed
    FROM accounting_periods ap
    WHERE ap.user_id = v_user AND ap.status = 'closed'
      AND ap.period_start <= (m.s + interval '1 month' - interval '1 day')::date
      AND ap.period_end >= m.s
  ) cl
  ORDER BY m.s;
END;
$$;

REVOKE ALL ON FUNCTION public.get_accounting_periods_overview(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_accounting_periods_overview(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_accounting_period_status(
  p_period_start date,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_start date := p_period_start;
  v_end date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_changed integer;
BEGIN
  v_user := public._coa_require_manager();

  IF v_start IS NULL OR v_start <> date_trunc('month', v_start)::date THEN
    RAISE EXCEPTION 'Period start must be the first day of a month';
  END IF;
  v_end := (v_start + interval '1 month' - interval '1 day')::date;

  IF p_status = 'closed' THEN
    IF v_start > date_trunc('month', current_date)::date THEN
      RAISE EXCEPTION 'A future period cannot be closed yet';
    END IF;

    INSERT INTO accounting_periods (user_id, period_start, period_end, status, closed_at, closed_by)
    VALUES (v_user, v_start, v_end, 'closed', now(), auth.uid())
    ON CONFLICT (user_id, period_start, period_end)
    DO UPDATE SET status = 'closed', closed_at = now(), closed_by = auth.uid()
    WHERE accounting_periods.status <> 'closed';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    IF v_changed > 0 THEN
      PERFORM public._coa_audit(v_user, 'period', NULL, 'closed',
        jsonb_build_object('period_start', v_start, 'period_end', v_end, 'reason', v_reason));
    END IF;

  ELSIF p_status = 'open' THEN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()) THEN
      RAISE EXCEPTION 'Only the account owner can reopen a closed period' USING ERRCODE = '42501';
    END IF;
    IF v_reason IS NULL OR char_length(v_reason) < 5 THEN
      RAISE EXCEPTION 'A reason of at least 5 characters is required to reopen a period';
    END IF;

    UPDATE accounting_periods SET status = 'open', closed_at = NULL, closed_by = NULL
    WHERE user_id = v_user AND period_start = v_start AND period_end = v_end AND status = 'closed';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    IF EXISTS (
      SELECT 1 FROM accounting_periods
      WHERE user_id = v_user AND status = 'closed' AND period_start <= v_end AND period_end >= v_start
    ) THEN
      RAISE EXCEPTION 'This month is also covered by a longer closed range. Reopen that range instead.';
    END IF;

    IF v_changed > 0 THEN
      PERFORM public._coa_audit(v_user, 'period', NULL, 'reopened',
        jsonb_build_object('period_start', v_start, 'period_end', v_end, 'reason', v_reason));
    END IF;

  ELSE
    RAISE EXCEPTION 'Status must be open or closed';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_accounting_period_status(date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_accounting_period_status(date, text, text) TO authenticated;

-- Closes every still-open month from the first month with ledger activity
-- through p_through_month (inclusive). Returns how many months were closed.
CREATE OR REPLACE FUNCTION public.lock_accounting_periods_through(p_through_month date, p_reason text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_to date;
  v_from date;
  v_count integer;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  v_user := public._coa_require_manager();

  IF p_through_month IS NULL THEN RAISE EXCEPTION 'Choose a month to lock through'; END IF;
  v_to := date_trunc('month', p_through_month)::date;
  IF v_to > date_trunc('month', current_date)::date THEN
    RAISE EXCEPTION 'A future period cannot be closed yet';
  END IF;

  SELECT COALESCE(date_trunc('month', min(entry_date))::date, v_to) INTO v_from
  FROM journal_entries WHERE user_id = v_user;
  v_from := LEAST(v_from, v_to);

  IF (EXTRACT(year FROM age(v_to, v_from)) * 12 + EXTRACT(month FROM age(v_to, v_from))) > 120 THEN
    RAISE EXCEPTION 'That range is too long. Lock in smaller steps.';
  END IF;

  INSERT INTO accounting_periods (user_id, period_start, period_end, status, closed_at, closed_by)
  SELECT v_user, g::date, (g + interval '1 month' - interval '1 day')::date, 'closed', now(), auth.uid()
  FROM generate_series(v_from, v_to, interval '1 month') g
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_periods ap
    WHERE ap.user_id = v_user AND ap.status = 'closed'
      AND ap.period_start <= (g + interval '1 month' - interval '1 day')::date AND ap.period_end >= g::date
  )
  ON CONFLICT (user_id, period_start, period_end)
  DO UPDATE SET status = 'closed', closed_at = now(), closed_by = auth.uid();
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    PERFORM public._coa_audit(v_user, 'period', NULL, 'locked_through',
      jsonb_build_object('through', v_to, 'from', v_from, 'months_closed', v_count, 'reason', v_reason));
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_accounting_periods_through(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_accounting_periods_through(date, text) TO authenticated;
