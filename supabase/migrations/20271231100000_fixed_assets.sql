/*
  # Fixed assets (/dashboard/fixed-assets)

  Register of long-lived assets (trucks, equipment, tools, computers...) with
  cost, in-service date, depreciation method, a monthly depreciation schedule,
  posting to the general ledger, and disposal with gain/loss. Additive only:
  the one existing object touched is the journal_entries.source_type CHECK,
  widened (robustly, same pattern as refunds / bank intelligence) to allow
  'fixed_asset_depreciation' and 'fixed_asset_disposal'.

  ## Tables
  - fixed_assets              one row per asset (terms, links, disposal result)
  - fixed_asset_depreciation  one row per asset per posted month
  - fixed_asset_events        audit timeline (created, updated, posted, disposed)

  ## Links
  - vehicle_id -> vehicles (fleet roster)
  - tool_id    -> tool_crib_items (company-owned equipment / tools)
  An asset links to at most one of them. Deleting the vehicle or tool never
  deletes the asset (the link is cleared).

  ## Depreciation math (single source of truth: fixed_asset_schedule())
  All amounts are integer cents. Monthly, whole-month convention.
  - Start: the in-service month ('in_service_month') or the month after
    ('following_month').
  - Straight line: month k = floor(base*k/life) - floor(base*(k-1)/life)
    with base = cost - salvage. Cents are spread evenly and the schedule sums
    to exactly base.
  - Declining balance: month rate = factor/life_months applied to the opening
    book value (factor 100-300%, 200% = double declining). It switches to the
    remaining straight-line amount as soon as that is larger (so the asset
    always reaches salvage), is capped at book value - salvage, and the final
    month takes the exact remainder.
  - Rounding is half-up on integer arithmetic (no floating point), so the
    TypeScript mirror in src/lib/fixedAssets.ts produces identical cents.
  - No depreciation is recorded for the month of disposal or later.

  ## Security model (same as tool_crib / chart of accounts)
  - Every row carries user_id = the ACCOUNT OWNER's id.
  - Reads: account members who are the owner or hold can_view_billing
    (custom-role permissions override team_members.permissions).
  - Writes: ONLY through the SECURITY DEFINER RPCs below, which re-check the
    permission, ownership of linked vehicle/tool, ledger period locks and the
    ledger-safety rules.

  ## Ledger
  - post_fixed_asset_depreciation(through): one balanced entry per month:
      Dr 6700 Depreciation Expense / Cr 1590 Accumulated Depreciation.
    Months already posted are skipped (re-running is safe); a month whose
    entry was voided is re-posted. A closed period stops the run with a clear
    message and nothing is posted.
  - dispose_fixed_asset(...): optional entry
      Dr 1590 accumulated, Dr 1000 proceeds, Cr 1500 cost, Dr/Cr 4910 loss/gain.
    Accounts 1590 / 6700 / 4910 are created on first use if missing.
  - Capitalising the purchase itself (Dr 1500) is NOT posted here: record it
    through bills / manual entries as usual.
*/

-- =============================================================
-- 0. Allow fixed-asset journal entries (robust to constraint drift)
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
    IF v_con.def ILIKE '%fixed_asset_disposal%' THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT t.m[1]) INTO v_vals
    FROM regexp_matches(v_con.def, '''([a-z_]+)''', 'g') AS t(m);
    v_vals := coalesce(v_vals, ARRAY[]::text[]) || ARRAY['fixed_asset_depreciation', 'fixed_asset_disposal'];
    EXECUTE format('ALTER TABLE public.journal_entries DROP CONSTRAINT %I', v_con.conname);
    EXECUTE format(
      'ALTER TABLE public.journal_entries ADD CONSTRAINT %I CHECK (source_type IN (%s))',
      v_con.conname,
      (SELECT string_agg(quote_literal(x), ', ') FROM (SELECT DISTINCT unnest(v_vals) AS x) s)
    );
  END LOOP;
END $$;

-- =============================================================
-- 1. TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS fixed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_number text NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT 'equipment'
    CHECK (category IN ('vehicle', 'equipment', 'tools', 'computer', 'furniture', 'leasehold', 'other')),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  serial_number text CHECK (serial_number IS NULL OR char_length(serial_number) <= 80),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  tool_id uuid REFERENCES tool_crib_items(id) ON DELETE SET NULL,
  acquisition_date date NOT NULL,
  in_service_date date NOT NULL,
  cost_cents bigint NOT NULL CHECK (cost_cents > 0 AND cost_cents <= 2000000000),
  salvage_cents bigint NOT NULL DEFAULT 0 CHECK (salvage_cents >= 0),
  useful_life_months integer NOT NULL CHECK (useful_life_months BETWEEN 1 AND 600),
  method text NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line', 'declining_balance')),
  declining_factor_pct integer NOT NULL DEFAULT 200 CHECK (declining_factor_pct BETWEEN 100 AND 300),
  start_convention text NOT NULL DEFAULT 'in_service_month'
    CHECK (start_convention IN ('in_service_month', 'following_month')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_at date,
  disposal_proceeds_cents bigint CHECK (disposal_proceeds_cents IS NULL OR disposal_proceeds_cents >= 0),
  disposal_accumulated_cents bigint,
  disposal_gain_loss_cents bigint,
  disposal_note text CHECK (disposal_note IS NULL OR char_length(disposal_note) <= 500),
  disposal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset_number),
  CONSTRAINT fixed_assets_salvage_below_cost CHECK (salvage_cents < cost_cents),
  CONSTRAINT fixed_assets_service_after_acquisition CHECK (in_service_date >= acquisition_date),
  CONSTRAINT fixed_assets_single_link CHECK (NOT (vehicle_id IS NOT NULL AND tool_id IS NOT NULL)),
  CONSTRAINT fixed_assets_disposed_consistent CHECK ((status = 'disposed') = (disposed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_user_status ON fixed_assets (user_id, status);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_vehicle ON fixed_assets (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fixed_assets_tool ON fixed_assets (tool_id) WHERE tool_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (extract(day FROM period_month) = 1),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  accumulated_cents bigint NOT NULL CHECK (accumulated_cents >= 0),
  nbv_cents bigint NOT NULL CHECK (nbv_cents >= 0),
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  posted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period_month)
);

CREATE INDEX IF NOT EXISTS idx_fixed_asset_dep_user_month ON fixed_asset_depreciation (user_id, period_month);

CREATE TABLE IF NOT EXISTS fixed_asset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'depreciation_posted', 'disposed')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fixed_asset_events_asset ON fixed_asset_events (asset_id, created_at DESC);

-- =============================================================
-- 2. ACCESS HELPERS
-- =============================================================

-- Owner => true. Team member => can_view_billing (custom role overrides).
CREATE OR REPLACE FUNCTION public._fa_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND tm.invite_status IN ('accepted', 'active')
        AND COALESCE(cr.permissions ->> 'can_view_billing', tm.permissions ->> 'can_view_billing', 'false') = 'true'
    )
  );
$$;

REVOKE ALL ON FUNCTION public._fa_can_manage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._fa_can_manage() TO authenticated;

-- Returns the account owner id, or raises. Every write RPC starts here.
CREATE OR REPLACE FUNCTION public._fa_require()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public._fa_can_manage() THEN
    RAISE EXCEPTION 'You do not have permission to manage fixed assets' USING ERRCODE = '42501';
  END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No account found for this user' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

REVOKE ALL ON FUNCTION public._fa_require() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 3. RLS — read-only for permitted members; all writes via RPC
-- =============================================================

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_depreciation ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Billing members view fixed assets" ON fixed_assets;
CREATE POLICY "Billing members view fixed assets"
  ON fixed_assets FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._fa_can_manage());

DROP POLICY IF EXISTS "Billing members view fixed asset depreciation" ON fixed_asset_depreciation;
CREATE POLICY "Billing members view fixed asset depreciation"
  ON fixed_asset_depreciation FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._fa_can_manage());

DROP POLICY IF EXISTS "Billing members view fixed asset events" ON fixed_asset_events;
CREATE POLICY "Billing members view fixed asset events"
  ON fixed_asset_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public._fa_can_manage());

-- No INSERT / UPDATE / DELETE policies: every write goes through the RPCs.

-- =============================================================
-- 4. DEPRECIATION SCHEDULE (pure, deterministic, integer cents)
-- =============================================================

CREATE OR REPLACE FUNCTION public.fixed_asset_schedule(
  p_cost bigint,
  p_salvage bigint,
  p_life integer,
  p_method text,
  p_factor_pct integer,
  p_in_service date,
  p_convention text DEFAULT 'in_service_month'
)
RETURNS TABLE (
  seq integer,
  period_month date,
  amount_cents bigint,
  accumulated_cents bigint,
  nbv_cents bigint
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_first date;
  v_base bigint;
  v_nbv bigint;
  v_acc bigint := 0;
  v_amt bigint;
  v_db bigint;
  v_sl bigint;
  v_remaining bigint;
  i integer;
BEGIN
  IF p_cost IS NULL OR p_salvage IS NULL OR p_life IS NULL OR p_in_service IS NULL
     OR p_cost <= 0 OR p_salvage < 0 OR p_salvage >= p_cost OR p_life < 1 THEN
    RETURN;
  END IF;

  v_base := p_cost - p_salvage;
  v_nbv := p_cost;
  v_first := p_in_service - (extract(day FROM p_in_service)::integer - 1);
  IF p_convention = 'following_month' THEN
    v_first := (v_first + interval '1 month')::date;
  END IF;

  FOR i IN 1..p_life LOOP
    IF p_method = 'declining_balance' THEN
      v_remaining := p_life - i + 1;
      -- round-half-up of nbv * factor / (life * 100) and (nbv - salvage) / remaining
      v_db := (2 * v_nbv * p_factor_pct + p_life::bigint * 100) / (2 * p_life::bigint * 100);
      v_sl := (2 * (v_nbv - p_salvage) + v_remaining) / (2 * v_remaining);
      v_amt := least(greatest(v_db, v_sl), v_nbv - p_salvage);
      IF i = p_life THEN
        v_amt := v_nbv - p_salvage;
      END IF;
    ELSE
      v_amt := (v_base * i) / p_life - (v_base * (i - 1)) / p_life;
    END IF;

    v_acc := v_acc + v_amt;
    v_nbv := p_cost - v_acc;

    seq := i;
    period_month := (v_first + (i - 1) * interval '1 month')::date;
    amount_cents := v_amt;
    accumulated_cents := v_acc;
    nbv_cents := v_nbv;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.fixed_asset_schedule(bigint, bigint, integer, text, integer, date, text) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 5. INTERNAL HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public._fa_account(
  p_owner uuid, p_code text, p_name text, p_type text, p_normal text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_active boolean;
BEGIN
  SELECT id, is_active INTO v_id, v_active
  FROM chart_of_accounts WHERE user_id = p_owner AND code = p_code;

  IF v_id IS NULL THEN
    INSERT INTO chart_of_accounts (user_id, code, name, type, normal_balance, is_system)
    VALUES (p_owner, p_code, p_name, p_type, p_normal, true)
    ON CONFLICT (user_id, code) DO NOTHING;
    SELECT id, is_active INTO v_id, v_active
    FROM chart_of_accounts WHERE user_id = p_owner AND code = p_code;
  END IF;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Could not find or create ledger account %', p_code;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'Ledger account % is inactive. Reactivate it in Chart of Accounts to post fixed-asset entries.', p_code;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._fa_account(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._fa_log(p_owner uuid, p_asset uuid, p_type text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO fixed_asset_events (user_id, asset_id, event_type, actor_id, note)
  VALUES (p_owner, p_asset, p_type, auth.uid(), NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''));
$$;

REVOKE ALL ON FUNCTION public._fa_log(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Shared validation for create / update. Raises a readable message.
CREATE OR REPLACE FUNCTION public._fa_validate(
  p_owner uuid,
  p_name text, p_category text, p_vehicle_id uuid, p_tool_id uuid,
  p_acquisition date, p_in_service date,
  p_cost bigint, p_salvage bigint, p_life integer,
  p_method text, p_factor integer, p_convention text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Asset name is required (max 120 characters)';
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('vehicle', 'equipment', 'tools', 'computer', 'furniture', 'leasehold', 'other') THEN
    RAISE EXCEPTION 'Choose a valid asset category';
  END IF;
  IF p_acquisition IS NULL OR p_in_service IS NULL THEN
    RAISE EXCEPTION 'Acquisition date and in-service date are required';
  END IF;
  IF p_acquisition < DATE '1990-01-01' OR p_acquisition > current_date + 366 THEN
    RAISE EXCEPTION 'Acquisition date looks wrong';
  END IF;
  IF p_in_service < p_acquisition THEN
    RAISE EXCEPTION 'In-service date cannot be before the acquisition date';
  END IF;
  IF p_in_service > current_date + 730 THEN
    RAISE EXCEPTION 'In-service date is too far in the future';
  END IF;
  IF p_cost IS NULL OR p_cost <= 0 OR p_cost > 2000000000 THEN
    RAISE EXCEPTION 'Cost must be greater than $0 and at most $20,000,000';
  END IF;
  IF p_salvage IS NULL OR p_salvage < 0 OR p_salvage >= p_cost THEN
    RAISE EXCEPTION 'Salvage value must be $0 or more and less than the cost';
  END IF;
  IF p_life IS NULL OR p_life NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Useful life must be between 1 and 600 months';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('straight_line', 'declining_balance') THEN
    RAISE EXCEPTION 'Choose straight-line or declining-balance depreciation';
  END IF;
  IF p_factor IS NULL OR p_factor NOT BETWEEN 100 AND 300 THEN
    RAISE EXCEPTION 'Declining-balance factor must be between 100%% and 300%%';
  END IF;
  IF p_convention IS NULL OR p_convention NOT IN ('in_service_month', 'following_month') THEN
    RAISE EXCEPTION 'Choose a valid start convention';
  END IF;
  IF p_vehicle_id IS NOT NULL AND p_tool_id IS NOT NULL THEN
    RAISE EXCEPTION 'Link an asset to either a vehicle or a tool, not both';
  END IF;
  IF p_vehicle_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.user_id = p_owner) THEN
    RAISE EXCEPTION 'That vehicle was not found in your fleet';
  END IF;
  IF p_tool_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tool_crib_items t WHERE t.id = p_tool_id AND t.user_id = p_owner) THEN
    RAISE EXCEPTION 'That tool was not found in your tool crib';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._fa_validate(uuid, text, text, uuid, uuid, date, date, bigint, bigint, integer, text, integer, text) FROM PUBLIC, anon, authenticated;

-- Posts every unposted scheduled month up to (and including) the month of
-- p_through, one balanced journal entry per month. Optionally one asset only.
CREATE OR REPLACE FUNCTION public._fa_post_depreciation(
  p_owner uuid, p_through date, p_asset_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_through date := p_through - (extract(day FROM p_through)::integer - 1);
  v_pending jsonb;
  v_expense uuid;
  v_accum uuid;
  v_month date;
  v_total bigint;
  v_count integer;
  v_je uuid;
  v_entries integer := 0;
  v_grand bigint := 0;
  v_assets integer := 0;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'asset_id', a.id, 'month', s.period_month, 'amount', s.amount_cents,
           'acc', s.accumulated_cents, 'nbv', s.nbv_cents
         ) ORDER BY s.period_month, a.asset_number), '[]'::jsonb)
  INTO v_pending
  FROM fixed_assets a
  CROSS JOIN LATERAL public.fixed_asset_schedule(
    a.cost_cents, a.salvage_cents, a.useful_life_months, a.method,
    a.declining_factor_pct, a.in_service_date, a.start_convention
  ) s
  WHERE a.user_id = p_owner
    AND a.status = 'active'
    AND (p_asset_id IS NULL OR a.id = p_asset_id)
    AND s.period_month <= v_through
    AND s.amount_cents > 0
    AND NOT EXISTS (
      SELECT 1
      FROM fixed_asset_depreciation d
      JOIN journal_entries j ON j.id = d.journal_entry_id
      WHERE d.asset_id = a.id AND d.period_month = s.period_month AND j.status = 'posted'
    );

  IF jsonb_array_length(v_pending) = 0 THEN
    RETURN jsonb_build_object('entries', 0, 'assets', 0, 'total_cents', 0);
  END IF;

  v_expense := public._fa_account(p_owner, '6700', 'Depreciation Expense', 'expense', 'debit');
  v_accum := public._fa_account(p_owner, '1590', 'Accumulated Depreciation', 'asset', 'credit');

  FOR v_month IN
    SELECT DISTINCT (e ->> 'month')::date FROM jsonb_array_elements(v_pending) e ORDER BY 1
  LOOP
    IF EXISTS (
      SELECT 1 FROM accounting_periods ap
      WHERE ap.user_id = p_owner AND ap.status = 'closed'
        AND ((v_month + interval '1 month')::date - 1) BETWEEN ap.period_start AND ap.period_end
    ) THEN
      RAISE EXCEPTION 'Depreciation for % is not posted yet, but that accounting period is closed. Reopen it in Chart of Accounts, then post again.',
        to_char(v_month, 'FMMonth YYYY');
    END IF;

    SELECT coalesce(sum(x.amount), 0), count(*)
    INTO v_total, v_count
    FROM jsonb_to_recordset(v_pending) AS x(asset_id uuid, month date, amount bigint, acc bigint, nbv bigint)
    WHERE x.month = v_month;

    IF v_total > 2147483647 THEN
      RAISE EXCEPTION 'Depreciation for % is too large for a single ledger entry', to_char(v_month, 'FMMonth YYYY');
    END IF;

    v_je := public.post_journal_entry(
      (v_month + interval '1 month')::date - 1,
      'Depreciation ' || to_char(v_month, 'FMMonth YYYY') || ' (' || v_count || CASE WHEN v_count = 1 THEN ' asset)' ELSE ' assets)' END,
      'fixed_asset_depreciation',
      NULL,
      jsonb_build_array(
        jsonb_build_object('account_id', v_expense, 'debit_cents', v_total, 'credit_cents', 0, 'description', 'Depreciation expense'),
        jsonb_build_object('account_id', v_accum, 'debit_cents', 0, 'credit_cents', v_total, 'description', 'Accumulated depreciation')
      )
    );

    INSERT INTO fixed_asset_depreciation
      (user_id, asset_id, period_month, amount_cents, accumulated_cents, nbv_cents, journal_entry_id, posted_by, posted_at)
    SELECT p_owner, x.asset_id, x.month, x.amount, x.acc, x.nbv, v_je, auth.uid(), now()
    FROM jsonb_to_recordset(v_pending) AS x(asset_id uuid, month date, amount bigint, acc bigint, nbv bigint)
    WHERE x.month = v_month
    ON CONFLICT (asset_id, period_month) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents,
          accumulated_cents = EXCLUDED.accumulated_cents,
          nbv_cents = EXCLUDED.nbv_cents,
          journal_entry_id = EXCLUDED.journal_entry_id,
          posted_by = EXCLUDED.posted_by,
          posted_at = EXCLUDED.posted_at;

    v_entries := v_entries + 1;
    v_grand := v_grand + v_total;
  END LOOP;

  INSERT INTO fixed_asset_events (user_id, asset_id, event_type, actor_id, note)
  SELECT p_owner, x.asset_id, 'depreciation_posted', auth.uid(),
         'Posted ' || count(*) || CASE WHEN count(*) = 1 THEN ' month' ELSE ' months' END ||
         ' through ' || to_char(max(x.month), 'FMMonth YYYY')
  FROM jsonb_to_recordset(v_pending) AS x(asset_id uuid, month date, amount bigint, acc bigint, nbv bigint)
  GROUP BY x.asset_id;

  SELECT count(DISTINCT x.asset_id) INTO v_assets
  FROM jsonb_to_recordset(v_pending) AS x(asset_id uuid, month date, amount bigint, acc bigint, nbv bigint);

  RETURN jsonb_build_object('entries', v_entries, 'assets', v_assets, 'total_cents', v_grand);
END;
$$;

REVOKE ALL ON FUNCTION public._fa_post_depreciation(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_fixed_asset(
  p_name text,
  p_category text,
  p_description text,
  p_serial_number text,
  p_vehicle_id uuid,
  p_tool_id uuid,
  p_acquisition_date date,
  p_in_service_date date,
  p_cost_cents bigint,
  p_salvage_cents bigint,
  p_life_months integer,
  p_method text,
  p_factor_pct integer,
  p_convention text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fa_require();
  v_id uuid;
  v_next integer;
BEGIN
  PERFORM public._fa_validate(
    v_owner, p_name, p_category, p_vehicle_id, p_tool_id, p_acquisition_date, p_in_service_date,
    p_cost_cents, p_salvage_cents, p_life_months, p_method, p_factor_pct, p_convention
  );

  PERFORM pg_advisory_xact_lock(hashtext('fixed_assets:' || v_owner::text));
  SELECT coalesce(max(substring(asset_number FROM '^FA-([0-9]+)$')::integer), 0) + 1
  INTO v_next FROM fixed_assets WHERE user_id = v_owner;

  INSERT INTO fixed_assets (
    user_id, asset_number, name, category, description, serial_number, vehicle_id, tool_id,
    acquisition_date, in_service_date, cost_cents, salvage_cents, useful_life_months,
    method, declining_factor_pct, start_convention, created_by
  ) VALUES (
    v_owner, 'FA-' || lpad(v_next::text, 4, '0'), btrim(p_name), p_category,
    NULLIF(btrim(COALESCE(p_description, '')), ''), NULLIF(btrim(COALESCE(p_serial_number, '')), ''),
    p_vehicle_id, p_tool_id, p_acquisition_date, p_in_service_date, p_cost_cents, p_salvage_cents,
    p_life_months, p_method, p_factor_pct, p_convention, auth.uid()
  ) RETURNING id INTO v_id;

  PERFORM public._fa_log(v_owner, v_id, 'created', btrim(p_name));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_fixed_asset(text, text, text, text, uuid, uuid, date, date, bigint, bigint, integer, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_fixed_asset(text, text, text, text, uuid, uuid, date, date, bigint, bigint, integer, text, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_fixed_asset(
  p_id uuid,
  p_name text,
  p_category text,
  p_description text,
  p_serial_number text,
  p_vehicle_id uuid,
  p_tool_id uuid,
  p_acquisition_date date,
  p_in_service_date date,
  p_cost_cents bigint,
  p_salvage_cents bigint,
  p_life_months integer,
  p_method text,
  p_factor_pct integer,
  p_convention text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fa_require();
  v_a fixed_assets%ROWTYPE;
  v_posted boolean;
BEGIN
  SELECT * INTO v_a FROM fixed_assets WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF v_a.status = 'disposed' THEN
    RAISE EXCEPTION 'Disposed assets are read-only';
  END IF;

  PERFORM public._fa_validate(
    v_owner, p_name, p_category, p_vehicle_id, p_tool_id, p_acquisition_date, p_in_service_date,
    p_cost_cents, p_salvage_cents, p_life_months, p_method, p_factor_pct, p_convention
  );

  SELECT EXISTS (
    SELECT 1 FROM fixed_asset_depreciation d
    JOIN journal_entries j ON j.id = d.journal_entry_id
    WHERE d.asset_id = p_id AND j.status = 'posted'
  ) INTO v_posted;

  IF v_posted AND (
       v_a.cost_cents IS DISTINCT FROM p_cost_cents
    OR v_a.salvage_cents IS DISTINCT FROM p_salvage_cents
    OR v_a.useful_life_months IS DISTINCT FROM p_life_months
    OR v_a.method IS DISTINCT FROM p_method
    OR (p_method = 'declining_balance' AND v_a.declining_factor_pct IS DISTINCT FROM p_factor_pct)
    OR v_a.start_convention IS DISTINCT FROM p_convention
    OR v_a.in_service_date IS DISTINCT FROM p_in_service_date
  ) THEN
    RAISE EXCEPTION 'Depreciation has already been posted for this asset, so cost, salvage, life, method and in-service date are locked.';
  END IF;

  UPDATE fixed_assets SET
    name = btrim(p_name),
    category = p_category,
    description = NULLIF(btrim(COALESCE(p_description, '')), ''),
    serial_number = NULLIF(btrim(COALESCE(p_serial_number, '')), ''),
    vehicle_id = p_vehicle_id,
    tool_id = p_tool_id,
    acquisition_date = p_acquisition_date,
    in_service_date = p_in_service_date,
    cost_cents = p_cost_cents,
    salvage_cents = p_salvage_cents,
    useful_life_months = p_life_months,
    method = p_method,
    declining_factor_pct = CASE WHEN p_method = 'declining_balance' THEN p_factor_pct ELSE declining_factor_pct END,
    start_convention = p_convention,
    updated_at = now()
  WHERE id = p_id;

  -- Unposted rows (e.g. from a voided entry) would no longer match the terms.
  DELETE FROM fixed_asset_depreciation d
  WHERE d.asset_id = p_id
    AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = d.journal_entry_id AND j.status = 'posted');

  PERFORM public._fa_log(v_owner, p_id, 'updated', btrim(p_name));
END;
$$;

REVOKE ALL ON FUNCTION public.update_fixed_asset(uuid, text, text, text, text, uuid, uuid, date, date, bigint, bigint, integer, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_fixed_asset(uuid, text, text, text, text, uuid, uuid, date, date, bigint, bigint, integer, text, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_fixed_asset(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fa_require();
  v_a fixed_assets%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM fixed_assets WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF v_a.status = 'disposed' THEN
    RAISE EXCEPTION 'Disposed assets are part of your ledger history and cannot be deleted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fixed_asset_depreciation d
    JOIN journal_entries j ON j.id = d.journal_entry_id
    WHERE d.asset_id = p_id AND j.status = 'posted'
  ) THEN
    RAISE EXCEPTION 'Depreciation has been posted to the ledger for this asset. Void those entries first, or dispose of the asset instead.';
  END IF;
  DELETE FROM fixed_assets WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_fixed_asset(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fixed_asset(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_fixed_asset_depreciation(p_through date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fa_require();
BEGIN
  IF p_through IS NULL THEN
    RAISE EXCEPTION 'Choose the month to post through';
  END IF;
  IF p_through - (extract(day FROM p_through)::integer - 1)
     > current_date - (extract(day FROM current_date)::integer - 1) THEN
    RAISE EXCEPTION 'Depreciation cannot be posted for a future month';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fixed_assets_post:' || v_owner::text));
  RETURN public._fa_post_depreciation(v_owner, p_through, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.post_fixed_asset_depreciation(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_fixed_asset_depreciation(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.dispose_fixed_asset(
  p_id uuid,
  p_date date,
  p_proceeds_cents bigint,
  p_note text DEFAULT NULL,
  p_post_to_ledger boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._fa_require();
  v_a fixed_assets%ROWTYPE;
  v_cut date;
  v_acc bigint;
  v_nbv bigint;
  v_gl bigint;
  v_lines jsonb := '[]'::jsonb;
  v_je uuid;
  v_asset_acct uuid;
  v_accum_acct uuid;
  v_cash_acct uuid;
  v_gl_acct uuid;
BEGIN
  SELECT * INTO v_a FROM fixed_assets WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found';
  END IF;
  IF v_a.status = 'disposed' THEN
    RAISE EXCEPTION 'This asset has already been disposed';
  END IF;
  IF p_date IS NULL OR p_date < v_a.in_service_date THEN
    RAISE EXCEPTION 'Disposal date cannot be before the in-service date';
  END IF;
  IF p_date > current_date THEN
    RAISE EXCEPTION 'Disposal date cannot be in the future';
  END IF;
  IF p_proceeds_cents IS NULL OR p_proceeds_cents < 0 OR p_proceeds_cents > 2000000000 THEN
    RAISE EXCEPTION 'Proceeds must be between $0 and $20,000,000';
  END IF;

  v_cut := p_date - (extract(day FROM p_date)::integer - 1);

  IF EXISTS (
    SELECT 1 FROM fixed_asset_depreciation d
    JOIN journal_entries j ON j.id = d.journal_entry_id
    WHERE d.asset_id = p_id AND j.status = 'posted' AND d.period_month >= v_cut
  ) THEN
    RAISE EXCEPTION 'Depreciation is already posted for % or later. Void those ledger entries first, or choose a later disposal date.',
      to_char(v_cut, 'FMMonth YYYY');
  END IF;

  IF p_post_to_ledger THEN
    PERFORM pg_advisory_xact_lock(hashtext('fixed_assets_post:' || v_owner::text));
    PERFORM public._fa_post_depreciation(v_owner, (v_cut - interval '1 month')::date, p_id);
  END IF;

  SELECT coalesce(sum(s.amount_cents), 0) INTO v_acc
  FROM public.fixed_asset_schedule(
    v_a.cost_cents, v_a.salvage_cents, v_a.useful_life_months, v_a.method,
    v_a.declining_factor_pct, v_a.in_service_date, v_a.start_convention
  ) s
  WHERE s.period_month < v_cut;

  v_nbv := v_a.cost_cents - v_acc;
  v_gl := p_proceeds_cents - v_nbv;

  IF p_post_to_ledger THEN
    v_asset_acct := public._fa_account(v_owner, '1500', 'Vehicles and Equipment', 'asset', 'debit');
    v_accum_acct := public._fa_account(v_owner, '1590', 'Accumulated Depreciation', 'asset', 'credit');
    v_cash_acct := public._fa_account(v_owner, '1000', 'Cash and Bank', 'asset', 'debit');
    v_gl_acct := public._fa_account(v_owner, '4910', 'Gain (Loss) on Asset Disposal', 'revenue', 'credit');

    IF v_acc > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_accum_acct, 'debit_cents', v_acc, 'credit_cents', 0, 'description', 'Remove accumulated depreciation'));
    END IF;
    IF p_proceeds_cents > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_cash_acct, 'debit_cents', p_proceeds_cents, 'credit_cents', 0, 'description', 'Disposal proceeds'));
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_asset_acct, 'debit_cents', 0, 'credit_cents', v_a.cost_cents, 'description', 'Remove asset cost'));
    IF v_gl > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_gl_acct, 'debit_cents', 0, 'credit_cents', v_gl, 'description', 'Gain on disposal'));
    ELSIF v_gl < 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_gl_acct, 'debit_cents', -v_gl, 'credit_cents', 0, 'description', 'Loss on disposal'));
    END IF;

    v_je := public.post_journal_entry(
      p_date,
      'Disposal of ' || v_a.asset_number || ' ' || v_a.name,
      'fixed_asset_disposal',
      p_id,
      v_lines
    );
  END IF;

  UPDATE fixed_assets SET
    status = 'disposed',
    disposed_at = p_date,
    disposal_proceeds_cents = p_proceeds_cents,
    disposal_accumulated_cents = v_acc,
    disposal_gain_loss_cents = v_gl,
    disposal_note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''),
    disposal_journal_entry_id = v_je,
    updated_at = now()
  WHERE id = p_id;

  PERFORM public._fa_log(
    v_owner, p_id, 'disposed',
    'Disposed ' || to_char(p_date, 'YYYY-MM-DD') || ', gain/loss ' || v_gl || ' cents' ||
    CASE WHEN p_post_to_ledger THEN '' ELSE ' (not posted to ledger)' END
  );

  RETURN jsonb_build_object(
    'accumulated_cents', v_acc, 'nbv_cents', v_nbv, 'gain_loss_cents', v_gl, 'journal_entry_id', v_je
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispose_fixed_asset(uuid, date, bigint, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispose_fixed_asset(uuid, date, bigint, text, boolean) TO authenticated;
