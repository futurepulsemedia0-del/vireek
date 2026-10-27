/*
  # Fixed Assets — register, depreciation schedules, ledger posting

  ## Why
  The general ledger (20261203000001) and chart-of-accounts management
  (20270410000000) exist, but nothing tracks capital assets: vehicles, tools,
  equipment and computers sit as one lump on the balance sheet and are never
  depreciated, so profit is overstated and the balance sheet is wrong.

  ## What this adds
  1. fixed_assets — the register (cost, salvage, life, method, account mapping,
     disposal result). Optional link to fleet `vehicles`.
  2. fixed_asset_depreciation_lines — the monthly schedule per asset
     (scheduled -> posted | cancelled), each posted line points at the journal entry.
  3. fixed_asset_events — append-only activity trail.
  4. journal_entries.source_type widened with fixed_asset_acquisition,
     fixed_asset_depreciation, fixed_asset_disposal (same robust pattern as refunds).
  5. RPCs (SECURITY DEFINER, scoped by get_account_owner_id(), gated by
     can_manage_chart_of_accounts()):
       fixed_assets_ensure_accounts, get_fixed_assets_overview,
       get_fixed_asset_schedule, get_depreciation_run_preview,
       get_depreciation_forecast, create_fixed_asset, update_fixed_asset,
       delete_fixed_asset, post_depreciation_run, dispose_fixed_asset.

  ## Accounting rules
  - Methods: straight_line, declining_balance (double-declining with automatic
    switch to straight-line so the asset lands exactly on salvage),
    sum_of_years, none (land). Whole-month convention: depreciation starts in
    the month the asset is placed in service. Cents are distributed so the
    schedule always sums exactly to cost - salvage.
  - Depreciation run: one journal entry per calendar month
    (Dr Depreciation Expense / Cr Accumulated Depreciation, grouped by account).
    Only months that have ended are posted. Months in a closed accounting period
    are skipped and reported, never forced.
  - Disposal: depreciates through the disposal month, cancels the rest of the
    schedule, then posts Dr cash (proceeds) + Dr accumulated depreciation
    + Dr loss / Cr asset cost + Cr gain, all in one transaction.
  - Once any depreciation is posted, cost/dates/method/life/accounts are locked.
  - Clients never write to these tables or to the ledger directly.
*/

-- =============================================================
-- 0. PREREQUISITES (clear error instead of an obscure failure)
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.journal_entries') IS NULL
     OR to_regclass('public.chart_of_accounts') IS NULL
     OR to_regclass('public.accounting_periods') IS NULL THEN
    RAISE EXCEPTION 'Fixed assets needs the general ledger. Apply 20261203000001_accounting_general_ledger.sql first.';
  END IF;
  IF to_regprocedure('public.can_manage_chart_of_accounts()') IS NULL
     OR to_regprocedure('public._coa_require_manager()') IS NULL THEN
    RAISE EXCEPTION 'Fixed assets needs chart-of-accounts management. Apply 20270410000000_chart_of_accounts_management.sql first.';
  END IF;
END $$;

-- =============================================================
-- 1. ALLOW FIXED-ASSET JOURNAL ENTRIES (robust to constraint drift)
-- =============================================================

DO $$
DECLARE
  v_con record;
  v_vals text[];
BEGIN
  FOR v_con IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    WHERE c.conrelid = 'public.journal_entries'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%source_type%'
  LOOP
    IF v_con.def ILIKE '%fixed_asset_depreciation%' THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT t.m[1]) INTO v_vals
    FROM regexp_matches(v_con.def, '''([a-z_]+)''', 'g') AS t(m);
    v_vals := coalesce(v_vals, ARRAY[]::text[])
      || ARRAY['fixed_asset_acquisition', 'fixed_asset_depreciation', 'fixed_asset_disposal'];
    EXECUTE format('ALTER TABLE public.journal_entries DROP CONSTRAINT %I', v_con.conname);
    EXECUTE format(
      'ALTER TABLE public.journal_entries ADD CONSTRAINT %I CHECK (source_type IN (%s))',
      v_con.conname,
      (SELECT string_agg(quote_literal(x), ', ') FROM (SELECT DISTINCT unnest(v_vals) AS x) s)
    );
  END LOOP;
END $$;

-- =============================================================
-- 2. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS fixed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asset_tag text NOT NULL CHECK (char_length(btrim(asset_tag)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  category text NOT NULL CHECK (category IN (
    'vehicle', 'equipment', 'tools', 'computer', 'furniture', 'leasehold', 'building', 'software', 'land', 'other'
  )),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  serial_number text CHECK (serial_number IS NULL OR char_length(serial_number) <= 80),
  location text CHECK (location IS NULL OR char_length(location) <= 120),
  vehicle_id uuid,
  acquisition_date date NOT NULL,
  in_service_date date NOT NULL,
  cost_cents integer NOT NULL CHECK (cost_cents > 0),
  salvage_cents integer NOT NULL DEFAULT 0 CHECK (salvage_cents >= 0),
  useful_life_months integer NOT NULL DEFAULT 0 CHECK (useful_life_months BETWEEN 0 AND 600),
  method text NOT NULL CHECK (method IN ('straight_line', 'declining_balance', 'sum_of_years', 'none')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fully_depreciated', 'disposed')),
  asset_account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  accumulated_account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  expense_account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  acquisition_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  disposal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  disposed_on date,
  disposal_proceeds_cents integer CHECK (disposal_proceeds_cents IS NULL OR disposal_proceeds_cents >= 0),
  disposal_gain_loss_cents integer,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixed_assets_salvage_lte_cost CHECK (salvage_cents <= cost_cents),
  CONSTRAINT fixed_assets_service_after_acquisition CHECK (in_service_date >= acquisition_date),
  CONSTRAINT fixed_assets_life_matches_method CHECK (method = 'none' OR useful_life_months >= 1),
  UNIQUE (user_id, asset_tag)
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_user_status ON fixed_assets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_vehicle ON fixed_assets(vehicle_id) WHERE vehicle_id IS NOT NULL;

-- Optional link to fleet vehicles; only added when that table exists.
DO $$
BEGIN
  IF to_regclass('public.vehicles') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'fixed_assets_vehicle_id_fkey' AND conrelid = 'public.fixed_assets'::regclass
     ) THEN
    ALTER TABLE public.fixed_assets
      ADD CONSTRAINT fixed_assets_vehicle_id_fkey
      FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  accumulated_cents integer NOT NULL CHECK (accumulated_cents >= 0),
  book_value_cents integer NOT NULL CHECK (book_value_cents >= 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'posted', 'cancelled')),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  posted_at timestamptz,
  posted_by uuid,
  UNIQUE (asset_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_fa_lines_user_status_period ON fixed_asset_depreciation_lines(user_id, status, period_end);
CREATE INDEX IF NOT EXISTS idx_fa_lines_asset ON fixed_asset_depreciation_lines(asset_id);

CREATE TABLE IF NOT EXISTS fixed_asset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asset_id uuid REFERENCES fixed_assets(id) ON DELETE SET NULL,
  actor_id uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fixed_asset_events_user ON fixed_asset_events(user_id, created_at DESC);

-- =============================================================
-- 3. RLS — read-only for authenticated; every write is an RPC below
-- =============================================================

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_fixed_assets" ON fixed_assets;
CREATE POLICY "select_own_fixed_assets" ON fixed_assets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_chart_of_accounts());

ALTER TABLE fixed_asset_depreciation_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_fixed_asset_depreciation_lines" ON fixed_asset_depreciation_lines;
CREATE POLICY "select_own_fixed_asset_depreciation_lines" ON fixed_asset_depreciation_lines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_chart_of_accounts());

ALTER TABLE fixed_asset_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_fixed_asset_events" ON fixed_asset_events;
CREATE POLICY "select_own_fixed_asset_events" ON fixed_asset_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_chart_of_accounts());

-- =============================================================
-- 4. INTERNAL HELPERS (not callable by clients)
-- =============================================================

CREATE OR REPLACE FUNCTION public._fa_period_closed(p_user uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounting_periods ap
    WHERE ap.user_id = p_user AND ap.status = 'closed'
      AND p_date BETWEEN ap.period_start AND ap.period_end
  );
$$;

CREATE OR REPLACE FUNCTION public._fa_audit(p_user uuid, p_asset uuid, p_action text, p_detail jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO fixed_asset_events (user_id, asset_id, actor_id, action, detail)
  VALUES (p_user, p_asset, auth.uid(), p_action, COALESCE(p_detail, '{}'::jsonb));
$$;

-- Finds (or creates) a standard account by code. If that code is already used by an
-- account of a different type, tries the next codes so we never hijack a custom account.
CREATE OR REPLACE FUNCTION public._fa_resolve_account(
  p_user uuid, p_code text, p_name text, p_type text, p_normal text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_try integer;
  v_code text;
  v_id uuid;
  v_row chart_of_accounts%ROWTYPE;
BEGIN
  FOR v_try IN 0..9 LOOP
    v_code := (p_code::integer + v_try)::text;
    v_id := NULL;
    SELECT * INTO v_row FROM chart_of_accounts c WHERE c.user_id = p_user AND c.code = v_code;
    IF NOT FOUND THEN
      INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system)
      VALUES (p_user, v_code, p_name, p_type, p_normal, true)
      ON CONFLICT (user_id, code) DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NOT NULL THEN RETURN v_id; END IF;
      SELECT * INTO v_row FROM chart_of_accounts c WHERE c.user_id = p_user AND c.code = v_code;
    END IF;
    IF v_row.type = p_type AND v_row.normal_balance = p_normal AND v_row.is_active THEN
      RETURN v_row.id;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Could not find or create the % account. Add it in the chart of accounts and select it manually.', p_name;
END;
$$;

-- User-scoped balanced journal poster (same rules as post_journal_entry).
CREATE OR REPLACE FUNCTION public._fa_post_je(
  p_user uuid, p_entry_date date, p_memo text, p_source_type text, p_source_id uuid, p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_debit bigint := 0;
  v_credit bigint := 0;
  v_n integer := 0;
BEGIN
  PERFORM public._gl_assert_period_open(p_user, p_entry_date);
  IF p_lines IS NULL OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least two lines';
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_debit := v_debit + coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := v_credit + coalesce((v_line->>'credit_cents')::bigint, 0);
    IF coalesce((v_line->>'debit_cents')::bigint, 0) > 2147483647
       OR coalesce((v_line->>'credit_cents')::bigint, 0) > 2147483647 THEN
      RAISE EXCEPTION 'Amount exceeds the ledger line limit';
    END IF;
  END LOOP;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Journal entry does not balance: % debit vs % credit', v_debit, v_credit;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('fa-gl:' || p_user::text, 0));

  INSERT INTO journal_entries (user_id, entry_number, entry_date, memo, source_type, source_id, created_by)
  VALUES (p_user, public._gl_next_number(p_user, 'JE', 'journal_entries'), p_entry_date, p_memo, p_source_type, p_source_id, auth.uid())
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_n := v_n + 1;
    INSERT INTO journal_lines (journal_entry_id, line_number, account_id, debit_cents, credit_cents, description)
    VALUES (
      v_entry_id, v_n, (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit_cents')::integer, 0), coalesce((v_line->>'credit_cents')::integer, 0),
      v_line->>'description'
    );
  END LOOP;
  RETURN v_entry_id;
END;
$$;

-- Shared validation for create / update.
CREATE OR REPLACE FUNCTION public._fa_validate(
  p_user uuid, p_name text, p_category text, p_acquisition_date date, p_in_service_date date,
  p_cost integer, p_salvage integer, p_life integer, p_method text,
  p_asset_account uuid, p_accumulated_account uuid, p_expense_account uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Enter an asset name (up to 120 characters).';
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('vehicle', 'equipment', 'tools', 'computer', 'furniture', 'leasehold', 'building', 'software', 'land', 'other') THEN
    RAISE EXCEPTION 'Choose a valid asset category.';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('straight_line', 'declining_balance', 'sum_of_years', 'none') THEN
    RAISE EXCEPTION 'Choose a valid depreciation method.';
  END IF;
  IF p_acquisition_date IS NULL OR p_in_service_date IS NULL THEN
    RAISE EXCEPTION 'Enter the acquisition and in-service dates.';
  END IF;
  IF p_in_service_date < p_acquisition_date THEN
    RAISE EXCEPTION 'The in-service date cannot be before the acquisition date.';
  END IF;
  IF p_cost IS NULL OR p_cost <= 0 THEN
    RAISE EXCEPTION 'Cost must be greater than zero.';
  END IF;
  IF p_salvage IS NULL OR p_salvage < 0 OR p_salvage > p_cost THEN
    RAISE EXCEPTION 'Salvage value must be between zero and the cost.';
  END IF;
  IF p_method <> 'none' AND (p_life IS NULL OR p_life < 1 OR p_life > 600) THEN
    RAISE EXCEPTION 'Useful life must be between 1 and 600 months.';
  END IF;
  IF p_asset_account IS NULL OR NOT EXISTS (
    SELECT 1 FROM chart_of_accounts c WHERE c.id = p_asset_account AND c.user_id = p_user AND c.type = 'asset' AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active asset account for the cost.';
  END IF;
  IF p_accumulated_account IS NULL OR NOT EXISTS (
    SELECT 1 FROM chart_of_accounts c WHERE c.id = p_accumulated_account AND c.user_id = p_user AND c.type = 'asset' AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active accumulated depreciation account.';
  END IF;
  IF p_expense_account IS NULL OR NOT EXISTS (
    SELECT 1 FROM chart_of_accounts c WHERE c.id = p_expense_account AND c.user_id = p_user AND c.type = 'expense' AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Choose an active depreciation expense account.';
  END IF;
  IF p_asset_account = p_accumulated_account THEN
    RAISE EXCEPTION 'The asset account and the accumulated depreciation account must be different.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._fa_refresh_status(p_asset_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE fixed_assets f
  SET status = CASE
        WHEN f.method <> 'none' AND NOT EXISTS (
          SELECT 1 FROM fixed_asset_depreciation_lines l WHERE l.asset_id = f.id AND l.status = 'scheduled'
        ) THEN 'fully_depreciated'
        ELSE 'active'
      END,
      updated_at = now()
  WHERE f.id = p_asset_id AND f.status <> 'disposed';
$$;

-- Rebuilds the not-yet-posted part of an asset's schedule. Integer math only, so the
-- lines always sum exactly to cost - salvage. Mirrors buildSchedule() in src/lib/fixedAssets.ts.
CREATE OR REPLACE FUNCTION public._fa_build_schedule(p_asset_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a fixed_assets%ROWTYPE;
  v_life integer;
  v_k integer;
  v_rem integer;
  v_dep bigint;
  v_bv bigint;
  v_acc bigint := 0;
  v_amt bigint := 0;
  v_cum bigint;
  v_prev bigint := 0;
  v_w bigint;
  v_total bigint;
  v_ddb bigint;
  v_sl bigint;
  v_first date;
  v_start date;
  v_count integer := 0;
BEGIN
  SELECT * INTO a FROM fixed_assets f WHERE f.id = p_asset_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;

  DELETE FROM fixed_asset_depreciation_lines l WHERE l.asset_id = p_asset_id AND l.status = 'scheduled';

  IF a.method = 'none' THEN
    PERFORM public._fa_refresh_status(p_asset_id);
    RETURN 0;
  END IF;

  v_life := a.useful_life_months;
  v_dep := a.cost_cents - a.salvage_cents;
  v_bv := a.cost_cents;
  v_total := (v_life::bigint * (v_life + 1)) / 2;
  v_first := date_trunc('month', a.in_service_date::timestamp)::date;

  FOR v_k IN 1..v_life LOOP
    v_rem := v_life - v_k + 1;
    IF a.method = 'straight_line' THEN
      v_cum := (v_dep * v_k) / v_life;
      v_amt := v_cum - v_prev;
      v_prev := v_cum;
    ELSIF a.method = 'sum_of_years' THEN
      v_w := v_k::bigint * v_life - (v_k::bigint * (v_k - 1)) / 2;
      v_cum := (v_dep * v_w) / v_total;
      v_amt := v_cum - v_prev;
      v_prev := v_cum;
    ELSE
      v_ddb := (2 * v_bv + v_life / 2) / v_life;
      v_sl := (v_bv - a.salvage_cents + v_rem / 2) / v_rem;
      v_amt := LEAST(GREATEST(v_ddb, v_sl), v_bv - a.salvage_cents);
    END IF;

    v_acc := v_acc + v_amt;
    v_bv := a.cost_cents - v_acc;

    IF v_amt > 0 THEN
      v_start := (v_first + make_interval(months => v_k - 1))::date;
      INSERT INTO fixed_asset_depreciation_lines (
        user_id, asset_id, period_start, period_end, amount_cents, accumulated_cents, book_value_cents, status
      ) VALUES (
        a.user_id, a.id, v_start, ((v_start + interval '1 month')::date - 1),
        v_amt::integer, v_acc::integer, v_bv::integer, 'scheduled'
      )
      ON CONFLICT (asset_id, period_start) DO NOTHING;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  PERFORM public._fa_refresh_status(p_asset_id);
  RETURN v_count;
END;
$$;

-- Posts every scheduled line whose period ended on/before p_period_end_max.
-- One journal entry per month. Closed periods are skipped and counted.
CREATE OR REPLACE FUNCTION public._fa_post_lines(p_user uuid, p_period_end_max date, p_asset_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period record;
  v_je_lines jsonb;
  v_entry_id uuid;
  v_entry_date date;
  v_count integer;
  v_sum bigint;
  v_posted integer := 0;
  v_total bigint := 0;
  v_entries integer := 0;
  v_skipped integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fa-post:' || p_user::text, 0));

  FOR v_period IN
    SELECT l.period_start, l.period_end
    FROM fixed_asset_depreciation_lines l
    WHERE l.user_id = p_user AND l.status = 'scheduled' AND l.period_end <= p_period_end_max
      AND (p_asset_id IS NULL OR l.asset_id = p_asset_id)
    GROUP BY l.period_start, l.period_end
    ORDER BY l.period_start
  LOOP
    v_entry_date := LEAST(v_period.period_end, current_date);
    IF public._fa_period_closed(p_user, v_entry_date) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT count(*), coalesce(sum(l.amount_cents), 0)
    INTO v_count, v_sum
    FROM fixed_asset_depreciation_lines l
    WHERE l.user_id = p_user AND l.status = 'scheduled' AND l.period_start = v_period.period_start
      AND (p_asset_id IS NULL OR l.asset_id = p_asset_id);

    SELECT jsonb_agg(q.obj ORDER BY q.side, q.account_id)
    INTO v_je_lines
    FROM (
      SELECT 1 AS side, f.expense_account_id AS account_id,
             jsonb_build_object(
               'account_id', f.expense_account_id,
               'debit_cents', sum(l.amount_cents),
               'credit_cents', 0,
               'description', 'Depreciation expense'
             ) AS obj
      FROM fixed_asset_depreciation_lines l
      JOIN fixed_assets f ON f.id = l.asset_id
      WHERE l.user_id = p_user AND l.status = 'scheduled' AND l.period_start = v_period.period_start
        AND (p_asset_id IS NULL OR l.asset_id = p_asset_id)
      GROUP BY f.expense_account_id
      UNION ALL
      SELECT 2, f.accumulated_account_id,
             jsonb_build_object(
               'account_id', f.accumulated_account_id,
               'debit_cents', 0,
               'credit_cents', sum(l.amount_cents),
               'description', 'Accumulated depreciation'
             )
      FROM fixed_asset_depreciation_lines l
      JOIN fixed_assets f ON f.id = l.asset_id
      WHERE l.user_id = p_user AND l.status = 'scheduled' AND l.period_start = v_period.period_start
        AND (p_asset_id IS NULL OR l.asset_id = p_asset_id)
      GROUP BY f.accumulated_account_id
    ) q;

    v_entry_id := public._fa_post_je(
      p_user, v_entry_date,
      'Depreciation - ' || to_char(v_period.period_start, 'Mon YYYY'),
      'fixed_asset_depreciation', NULL, v_je_lines
    );

    UPDATE fixed_asset_depreciation_lines l
    SET status = 'posted', journal_entry_id = v_entry_id, posted_at = now(), posted_by = auth.uid()
    WHERE l.user_id = p_user AND l.status = 'scheduled' AND l.period_start = v_period.period_start
      AND (p_asset_id IS NULL OR l.asset_id = p_asset_id);

    v_posted := v_posted + v_count;
    v_total := v_total + v_sum;
    v_entries := v_entries + 1;
  END LOOP;

  PERFORM public._fa_refresh_status(f.id)
  FROM fixed_assets f
  WHERE f.user_id = p_user AND f.status <> 'disposed' AND (p_asset_id IS NULL OR f.id = p_asset_id);

  RETURN jsonb_build_object(
    'posted_lines', v_posted,
    'posted_cents', v_total,
    'entries', v_entries,
    'skipped_closed_periods', v_skipped
  );
END;
$$;

-- =============================================================
-- 5. RPC: default accounts (idempotent)
-- =============================================================

CREATE OR REPLACE FUNCTION public.fixed_assets_ensure_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := public._coa_require_manager();
  PERFORM public.ensure_default_chart_of_accounts();
  RETURN jsonb_build_object(
    'asset_account_id', public._fa_resolve_account(v_user, '1500', 'Vehicles and Equipment', 'asset', 'debit'),
    'accumulated_account_id', public._fa_resolve_account(v_user, '1590', 'Accumulated Depreciation', 'asset', 'credit'),
    'expense_account_id', public._fa_resolve_account(v_user, '6600', 'Depreciation Expense', 'expense', 'debit')
  );
END;
$$;

-- =============================================================
-- 6. RPC: reads
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_fixed_assets_overview()
RETURNS TABLE (
  id uuid, asset_tag text, name text, category text, description text, serial_number text, location text,
  vehicle_id uuid, acquisition_date date, in_service_date date, cost_cents integer, salvage_cents integer,
  useful_life_months integer, method text, status text, asset_account_id uuid, accumulated_account_id uuid,
  expense_account_id uuid, acquisition_entry_id uuid, disposed_on date, disposal_proceeds_cents integer,
  disposal_gain_loss_cents integer, notes text, created_at timestamptz,
  accumulated_cents bigint, posted_months bigint, scheduled_months bigint,
  next_period_start date, next_amount_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
BEGIN
  v_user := public._coa_require_manager();

  RETURN QUERY
  SELECT
    f.id, f.asset_tag, f.name, f.category, f.description, f.serial_number, f.location,
    f.vehicle_id, f.acquisition_date, f.in_service_date, f.cost_cents, f.salvage_cents,
    f.useful_life_months, f.method, f.status, f.asset_account_id, f.accumulated_account_id,
    f.expense_account_id, f.acquisition_entry_id, f.disposed_on, f.disposal_proceeds_cents,
    f.disposal_gain_loss_cents, f.notes, f.created_at,
    COALESCE(s.accumulated, 0)::bigint,
    COALESCE(s.posted_n, 0)::bigint,
    COALESCE(s.sched_n, 0)::bigint,
    s.next_start,
    s.next_amt::bigint
  FROM fixed_assets f
  LEFT JOIN LATERAL (
    SELECT
      sum(l.amount_cents) FILTER (WHERE l.status = 'posted') AS accumulated,
      count(*) FILTER (WHERE l.status = 'posted') AS posted_n,
      count(*) FILTER (WHERE l.status = 'scheduled') AS sched_n,
      min(l.period_start) FILTER (WHERE l.status = 'scheduled') AS next_start,
      (array_agg(l.amount_cents ORDER BY l.period_start) FILTER (WHERE l.status = 'scheduled'))[1] AS next_amt
    FROM fixed_asset_depreciation_lines l
    WHERE l.asset_id = f.id
  ) s ON true
  WHERE f.user_id = v_user
  ORDER BY f.asset_tag;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_fixed_asset_schedule(p_asset_id uuid)
RETURNS TABLE (
  line_id uuid, period_start date, period_end date, amount_cents integer, accumulated_cents integer,
  book_value_cents integer, status text, journal_entry_id uuid, entry_number text, entry_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
BEGIN
  v_user := public._coa_require_manager();
  IF NOT EXISTS (SELECT 1 FROM fixed_assets f WHERE f.id = p_asset_id AND f.user_id = v_user) THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;

  RETURN QUERY
  SELECT l.id, l.period_start, l.period_end, l.amount_cents, l.accumulated_cents, l.book_value_cents,
         l.status, l.journal_entry_id, je.entry_number, je.status
  FROM fixed_asset_depreciation_lines l
  LEFT JOIN journal_entries je ON je.id = l.journal_entry_id
  WHERE l.asset_id = p_asset_id AND l.user_id = v_user
  ORDER BY l.period_start;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_depreciation_run_preview(p_through date DEFAULT NULL)
RETURNS TABLE (period_start date, period_end date, asset_count integer, total_cents bigint, is_closed boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_cut date;
BEGIN
  v_user := public._coa_require_manager();
  v_cut := LEAST(COALESCE(p_through, current_date), current_date);

  RETURN QUERY
  SELECT l.period_start, l.period_end, count(*)::integer, sum(l.amount_cents)::bigint,
         public._fa_period_closed(v_user, LEAST(l.period_end, current_date))
  FROM fixed_asset_depreciation_lines l
  WHERE l.user_id = v_user AND l.status = 'scheduled' AND l.period_end <= v_cut
  GROUP BY l.period_start, l.period_end
  ORDER BY l.period_start;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_depreciation_forecast(p_from date DEFAULT NULL, p_months integer DEFAULT 12)
RETURNS TABLE (period_start date, scheduled_cents bigint, posted_cents bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_from timestamp;
  v_n integer;
BEGIN
  v_user := public._coa_require_manager();
  v_from := date_trunc('month', COALESCE(p_from, current_date)::timestamp);
  v_n := GREATEST(LEAST(COALESCE(p_months, 12), 36), 1);

  RETURN QUERY
  SELECT m.d::date,
         COALESCE(sum(l.amount_cents) FILTER (WHERE l.status = 'scheduled'), 0)::bigint,
         COALESCE(sum(l.amount_cents) FILTER (WHERE l.status = 'posted'), 0)::bigint
  FROM generate_series(v_from, v_from + make_interval(months => v_n - 1), interval '1 month') AS m(d)
  LEFT JOIN fixed_asset_depreciation_lines l ON l.user_id = v_user AND l.period_start = m.d::date
  GROUP BY m.d
  ORDER BY m.d;
END;
$$;

-- =============================================================
-- 7. RPC: create / update / delete
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_fixed_asset(
  p_name text, p_category text, p_asset_tag text, p_description text, p_serial_number text, p_location text,
  p_vehicle_id uuid, p_acquisition_date date, p_in_service_date date, p_cost_cents integer, p_salvage_cents integer,
  p_useful_life_months integer, p_method text, p_asset_account_id uuid, p_accumulated_account_id uuid,
  p_expense_account_id uuid, p_offset_account_id uuid, p_notes text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_id uuid;
  v_tag text;
  v_n integer;
  v_name text;
  v_life integer;
  v_entry uuid;
BEGIN
  v_user := public._coa_require_manager();
  v_name := btrim(coalesce(p_name, ''));
  v_life := CASE WHEN p_method = 'none' THEN 0 ELSE p_useful_life_months END;

  PERFORM public._fa_validate(
    v_user, v_name, p_category, p_acquisition_date, p_in_service_date, p_cost_cents, p_salvage_cents,
    v_life, p_method, p_asset_account_id, p_accumulated_account_id, p_expense_account_id
  );

  PERFORM pg_advisory_xact_lock(hashtextextended('fa-tag:' || v_user::text, 0));
  v_tag := nullif(btrim(coalesce(p_asset_tag, '')), '');
  IF v_tag IS NULL THEN
    SELECT count(*) + 1 INTO v_n FROM fixed_assets f WHERE f.user_id = v_user;
    LOOP
      v_tag := 'FA-' || lpad(v_n::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM fixed_assets f WHERE f.user_id = v_user AND lower(f.asset_tag) = lower(v_tag));
      v_n := v_n + 1;
    END LOOP;
  ELSIF char_length(v_tag) > 40 THEN
    RAISE EXCEPTION 'Asset tag must be 40 characters or fewer.';
  ELSIF EXISTS (SELECT 1 FROM fixed_assets f WHERE f.user_id = v_user AND lower(f.asset_tag) = lower(v_tag)) THEN
    RAISE EXCEPTION 'Asset tag % is already in use.', v_tag;
  END IF;

  INSERT INTO fixed_assets (
    user_id, asset_tag, name, category, description, serial_number, location, vehicle_id,
    acquisition_date, in_service_date, cost_cents, salvage_cents, useful_life_months, method,
    asset_account_id, accumulated_account_id, expense_account_id, notes, created_by
  ) VALUES (
    v_user, v_tag, v_name, p_category,
    nullif(btrim(coalesce(p_description, '')), ''), nullif(btrim(coalesce(p_serial_number, '')), ''),
    nullif(btrim(coalesce(p_location, '')), ''), p_vehicle_id,
    p_acquisition_date, p_in_service_date, p_cost_cents, p_salvage_cents, v_life, p_method,
    p_asset_account_id, p_accumulated_account_id, p_expense_account_id,
    nullif(btrim(coalesce(p_notes, '')), ''), auth.uid()
  )
  RETURNING id INTO v_id;

  PERFORM public._fa_build_schedule(v_id);

  IF p_offset_account_id IS NOT NULL THEN
    IF p_offset_account_id = p_asset_account_id OR NOT EXISTS (
      SELECT 1 FROM chart_of_accounts c WHERE c.id = p_offset_account_id AND c.user_id = v_user AND c.is_active
    ) THEN
      RAISE EXCEPTION 'Choose a different, active account for the other side of the acquisition entry.';
    END IF;
    v_entry := public._fa_post_je(
      v_user, p_acquisition_date, 'Acquisition - ' || v_name || ' (' || v_tag || ')',
      'fixed_asset_acquisition', v_id,
      jsonb_build_array(
        jsonb_build_object('account_id', p_asset_account_id, 'debit_cents', p_cost_cents, 'credit_cents', 0, 'description', v_name),
        jsonb_build_object('account_id', p_offset_account_id, 'debit_cents', 0, 'credit_cents', p_cost_cents, 'description', v_name)
      )
    );
    UPDATE fixed_assets f SET acquisition_entry_id = v_entry WHERE f.id = v_id;
  END IF;

  PERFORM public._fa_audit(v_user, v_id, 'created', jsonb_build_object(
    'tag', v_tag, 'name', v_name, 'cost_cents', p_cost_cents, 'method', p_method,
    'acquisition_entry', v_entry IS NOT NULL
  ));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_fixed_asset(
  p_id uuid, p_name text, p_category text, p_asset_tag text, p_description text, p_serial_number text, p_location text,
  p_vehicle_id uuid, p_acquisition_date date, p_in_service_date date, p_cost_cents integer, p_salvage_cents integer,
  p_useful_life_months integer, p_method text, p_asset_account_id uuid, p_accumulated_account_id uuid,
  p_expense_account_id uuid, p_notes text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  a fixed_assets%ROWTYPE;
  v_name text;
  v_tag text;
  v_life integer;
  v_has_posted boolean;
  v_terms_changed boolean;
BEGIN
  v_user := public._coa_require_manager();

  SELECT * INTO a FROM fixed_assets f WHERE f.id = p_id AND f.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF a.status = 'disposed' THEN
    RAISE EXCEPTION 'A disposed asset can no longer be edited.';
  END IF;

  v_name := btrim(coalesce(p_name, ''));
  v_life := CASE WHEN p_method = 'none' THEN 0 ELSE p_useful_life_months END;

  PERFORM public._fa_validate(
    v_user, v_name, p_category, p_acquisition_date, p_in_service_date, p_cost_cents, p_salvage_cents,
    v_life, p_method, p_asset_account_id, p_accumulated_account_id, p_expense_account_id
  );

  v_tag := nullif(btrim(coalesce(p_asset_tag, '')), '');
  IF v_tag IS NULL THEN
    v_tag := a.asset_tag;
  ELSIF char_length(v_tag) > 40 THEN
    RAISE EXCEPTION 'Asset tag must be 40 characters or fewer.';
  ELSIF EXISTS (
    SELECT 1 FROM fixed_assets f WHERE f.user_id = v_user AND f.id <> p_id AND lower(f.asset_tag) = lower(v_tag)
  ) THEN
    RAISE EXCEPTION 'Asset tag % is already in use.', v_tag;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM fixed_asset_depreciation_lines l WHERE l.asset_id = p_id AND l.status = 'posted'
  ) INTO v_has_posted;

  v_terms_changed :=
    a.cost_cents IS DISTINCT FROM p_cost_cents
    OR a.salvage_cents IS DISTINCT FROM p_salvage_cents
    OR a.useful_life_months IS DISTINCT FROM v_life
    OR a.method IS DISTINCT FROM p_method
    OR a.in_service_date IS DISTINCT FROM p_in_service_date
    OR a.acquisition_date IS DISTINCT FROM p_acquisition_date
    OR a.asset_account_id IS DISTINCT FROM p_asset_account_id
    OR a.accumulated_account_id IS DISTINCT FROM p_accumulated_account_id
    OR a.expense_account_id IS DISTINCT FROM p_expense_account_id;

  IF v_terms_changed AND v_has_posted THEN
    RAISE EXCEPTION 'Depreciation has already been posted for this asset, so cost, dates, method, life and accounts are locked. Dispose of it and add a new asset if the terms changed.';
  END IF;
  IF a.acquisition_entry_id IS NOT NULL AND (
    a.cost_cents IS DISTINCT FROM p_cost_cents
    OR a.acquisition_date IS DISTINCT FROM p_acquisition_date
    OR a.asset_account_id IS DISTINCT FROM p_asset_account_id
  ) THEN
    RAISE EXCEPTION 'An acquisition entry was posted for this asset, so its cost, acquisition date and asset account are locked.';
  END IF;

  UPDATE fixed_assets f
  SET asset_tag = v_tag,
      name = v_name,
      category = p_category,
      description = nullif(btrim(coalesce(p_description, '')), ''),
      serial_number = nullif(btrim(coalesce(p_serial_number, '')), ''),
      location = nullif(btrim(coalesce(p_location, '')), ''),
      vehicle_id = p_vehicle_id,
      acquisition_date = p_acquisition_date,
      in_service_date = p_in_service_date,
      cost_cents = p_cost_cents,
      salvage_cents = p_salvage_cents,
      useful_life_months = v_life,
      method = p_method,
      asset_account_id = p_asset_account_id,
      accumulated_account_id = p_accumulated_account_id,
      expense_account_id = p_expense_account_id,
      notes = nullif(btrim(coalesce(p_notes, '')), ''),
      updated_at = now()
  WHERE f.id = p_id;

  IF v_terms_changed THEN
    PERFORM public._fa_build_schedule(p_id);
  END IF;

  PERFORM public._fa_audit(v_user, p_id, 'updated', jsonb_build_object(
    'tag', v_tag, 'name', v_name, 'terms_changed', v_terms_changed
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_fixed_asset(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  a fixed_assets%ROWTYPE;
BEGIN
  v_user := public._coa_require_manager();
  SELECT * INTO a FROM fixed_assets f WHERE f.id = p_id AND f.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF a.status = 'disposed' THEN
    RAISE EXCEPTION 'A disposed asset is part of your books and cannot be deleted.';
  END IF;
  IF a.acquisition_entry_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM fixed_asset_depreciation_lines l WHERE l.asset_id = p_id AND l.status = 'posted'
  ) THEN
    RAISE EXCEPTION 'This asset has ledger entries. Dispose of it instead of deleting it.';
  END IF;

  PERFORM public._fa_audit(v_user, NULL, 'deleted', jsonb_build_object('tag', a.asset_tag, 'name', a.name, 'cost_cents', a.cost_cents));
  DELETE FROM fixed_assets f WHERE f.id = p_id AND f.user_id = v_user;
END;
$$;

-- =============================================================
-- 8. RPC: depreciation run + disposal
-- =============================================================

CREATE OR REPLACE FUNCTION public.post_depreciation_run(p_through date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_cut date;
  v_result jsonb;
BEGIN
  v_user := public._coa_require_manager();
  v_cut := LEAST(COALESCE(p_through, current_date), current_date);
  v_result := public._fa_post_lines(v_user, v_cut, NULL);
  IF (v_result->>'posted_lines')::integer > 0 OR (v_result->>'skipped_closed_periods')::integer > 0 THEN
    PERFORM public._fa_audit(v_user, NULL, 'depreciation_posted', v_result || jsonb_build_object('through', v_cut));
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispose_fixed_asset(
  p_id uuid, p_disposal_date date, p_proceeds_cents integer, p_deposit_account_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  a fixed_assets%ROWTYPE;
  v_proceeds integer;
  v_post jsonb;
  v_acc bigint;
  v_bv bigint;
  v_gl bigint;
  v_gain uuid;
  v_loss uuid;
  v_lines jsonb := '[]'::jsonb;
  v_entry uuid;
  v_memo text;
BEGIN
  v_user := public._coa_require_manager();

  SELECT * INTO a FROM fixed_assets f WHERE f.id = p_id AND f.user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF a.status = 'disposed' THEN
    RAISE EXCEPTION 'This asset has already been disposed of.';
  END IF;

  v_proceeds := coalesce(p_proceeds_cents, 0);
  IF p_disposal_date IS NULL OR p_disposal_date < a.in_service_date THEN
    RAISE EXCEPTION 'The disposal date must be on or after the in-service date.';
  END IF;
  IF p_disposal_date > current_date THEN
    RAISE EXCEPTION 'The disposal date cannot be in the future.';
  END IF;
  IF v_proceeds < 0 THEN
    RAISE EXCEPTION 'Proceeds cannot be negative.';
  END IF;
  IF v_proceeds > 0 AND (p_deposit_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM chart_of_accounts c WHERE c.id = p_deposit_account_id AND c.user_id = v_user AND c.is_active
  )) THEN
    RAISE EXCEPTION 'Choose the account the sale proceeds were deposited to.';
  END IF;
  IF public._fa_period_closed(v_user, p_disposal_date) THEN
    RAISE EXCEPTION 'The accounting period for % is closed. Reopen it before recording this disposal.', p_disposal_date;
  END IF;

  -- Depreciate through the end of the disposal month (whole-month convention).
  v_post := public._fa_post_lines(
    v_user, ((date_trunc('month', p_disposal_date::timestamp) + interval '1 month')::date - 1), p_id
  );
  IF (v_post->>'skipped_closed_periods')::integer > 0 THEN
    RAISE EXCEPTION 'Some depreciation months up to the disposal date are in closed periods. Reopen them, then try again.';
  END IF;

  UPDATE fixed_asset_depreciation_lines l SET status = 'cancelled'
  WHERE l.asset_id = p_id AND l.status = 'scheduled';

  SELECT COALESCE(sum(l.amount_cents), 0) INTO v_acc
  FROM fixed_asset_depreciation_lines l WHERE l.asset_id = p_id AND l.status = 'posted';

  v_bv := a.cost_cents - v_acc;
  v_gl := v_proceeds - v_bv;

  IF v_proceeds > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', p_deposit_account_id, 'debit_cents', v_proceeds, 'credit_cents', 0, 'description', 'Sale proceeds'));
  END IF;
  IF v_acc > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', a.accumulated_account_id, 'debit_cents', v_acc, 'credit_cents', 0, 'description', 'Remove accumulated depreciation'));
  END IF;
  IF v_gl < 0 THEN
    v_loss := public._fa_resolve_account(v_user, '6910', 'Loss on Disposal of Assets', 'expense', 'debit');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_loss, 'debit_cents', -v_gl, 'credit_cents', 0, 'description', 'Loss on disposal'));
  END IF;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', a.asset_account_id, 'debit_cents', 0, 'credit_cents', a.cost_cents, 'description', 'Remove asset cost'));
  IF v_gl > 0 THEN
    v_gain := public._fa_resolve_account(v_user, '4920', 'Gain on Sale of Assets', 'revenue', 'credit');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_gain, 'debit_cents', 0, 'credit_cents', v_gl, 'description', 'Gain on disposal'));
  END IF;

  v_memo := 'Disposal - ' || a.name || ' (' || a.asset_tag || ')'
    || CASE WHEN nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN '' ELSE ': ' || btrim(p_reason) END;

  v_entry := public._fa_post_je(v_user, p_disposal_date, left(v_memo, 300), 'fixed_asset_disposal', p_id, v_lines);

  UPDATE fixed_assets f
  SET status = 'disposed',
      disposed_on = p_disposal_date,
      disposal_proceeds_cents = v_proceeds,
      disposal_gain_loss_cents = v_gl::integer,
      disposal_entry_id = v_entry,
      updated_at = now()
  WHERE f.id = p_id;

  PERFORM public._fa_audit(v_user, p_id, 'disposed', jsonb_build_object(
    'tag', a.asset_tag, 'name', a.name, 'date', p_disposal_date, 'proceeds_cents', v_proceeds,
    'book_value_cents', v_bv, 'gain_loss_cents', v_gl, 'reason', nullif(btrim(coalesce(p_reason, '')), '')
  ));

  RETURN jsonb_build_object(
    'entry_id', v_entry, 'accumulated_cents', v_acc, 'book_value_cents', v_bv, 'gain_loss_cents', v_gl
  );
END;
$$;

-- =============================================================
-- 9. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public._fa_period_closed(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_audit(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_resolve_account(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_post_je(uuid, date, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_validate(uuid, text, text, date, date, integer, integer, integer, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_refresh_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_build_schedule(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._fa_post_lines(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fixed_assets_ensure_accounts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_fixed_assets_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_fixed_asset_schedule(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_depreciation_run_preview(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_depreciation_forecast(date, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_fixed_asset(text, text, text, text, text, text, uuid, date, date, integer, integer, integer, text, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_fixed_asset(uuid, text, text, text, text, text, text, uuid, date, date, integer, integer, integer, text, uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_fixed_asset(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_depreciation_run(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dispose_fixed_asset(uuid, date, integer, uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fixed_assets_ensure_accounts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fixed_assets_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fixed_asset_schedule(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_depreciation_run_preview(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_depreciation_forecast(date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_fixed_asset(text, text, text, text, text, text, uuid, date, date, integer, integer, integer, text, uuid, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_fixed_asset(uuid, text, text, text, text, text, text, uuid, date, date, integer, integer, integer, text, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_fixed_asset(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_depreciation_run(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispose_fixed_asset(uuid, date, integer, uuid, text) TO authenticated;
