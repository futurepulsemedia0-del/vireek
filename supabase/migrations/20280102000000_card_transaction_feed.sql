/*
  # Card Transaction Feed (/dashboard/card-feed)

  Import company expense-card and fuel-card purchases (CSV or the existing Plaid
  bank feed), match each one to a technician / vehicle, REQUIRE a receipt, and
  categorise through the existing expense OCR. Vireek does NOT issue cards.

  - company_cards         : registry of cards you already have (last 4 digits only, never a full number).
  - card_imports          : one row per CSV file / bank sync (undo = delete_card_import).
  - card_transactions     : imported purchases, de-duplicated, matched, with receipt state.
  - card_feed_settings    : receipt threshold, due days, bank accounts used as card feeds.

  Receipts reuse the existing expenses engine: cardfeed_submit_receipt() calls
  save_expense() (company_card, submitted for manager review, posts to the ledger on
  approval exactly like every other expense) and links the result ATOMICALLY.

  Security: scoped by public.get_account_owner_id(). Managers (expense_is_manager) see
  everything; a technician sees ONLY the purchases matched to them. All writes go through
  SECURITY DEFINER functions, so matching and receipt state cannot be forged.
  Additive only: no existing table or function is altered or dropped
  (one BEFORE DELETE trigger on expenses keeps links honest when an expense is deleted).
  Depends on: expenses (20270415000000), vehicles / vehicle_assignments, team_members, notifications.
*/

-- =============================================================
-- HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.cardfeed_my_member_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(tm.id), ARRAY[]::uuid[])
    FROM team_members tm
   WHERE tm.user_id = auth.uid()
     AND tm.account_owner_id = public.get_account_owner_id();
$$;

CREATE OR REPLACE FUNCTION public._cardfeed_try_numeric(p text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' OR char_length(btrim(p)) > 18 THEN
    RETURN NULL;
  END IF;
  IF btrim(p) !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(p)::numeric;
END;
$$;

-- "YYYY-MM-DD[T ]HH:MM[:SS]" (no offset) is read in the account time zone;
-- values with Z / +hh[:mm] keep their own offset. Anything else -> NULL.
CREATE OR REPLACE FUNCTION public._cardfeed_try_timestamp(p text, p_tz text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v text := btrim(COALESCE(p, ''));
BEGIN
  IF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' THEN
    RETURN (replace(v, 'T', ' ')::timestamp) AT TIME ZONE p_tz;
  ELSIF v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RETURN v::timestamptz;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS card_feed_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  receipt_required_over_cents integer NOT NULL DEFAULT 0 CHECK (receipt_required_over_cents BETWEEN 0 AND 10000000),
  receipt_due_days integer NOT NULL DEFAULT 7 CHECK (receipt_due_days BETWEEN 1 AND 60),
  bank_account_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  last_bank_import_at timestamptz,
  timezone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  kind text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'fuel')),
  provider text NOT NULL DEFAULT 'other' CHECK (char_length(btrim(provider)) BETWEEN 1 AND 40),
  card_last4 text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_cards_provider_last4 ON company_cards(user_id, lower(provider), card_last4);
CREATE INDEX IF NOT EXISTS idx_company_cards_technician ON company_cards(technician_id);
CREATE INDEX IF NOT EXISTS idx_company_cards_vehicle ON company_cards(vehicle_id);

CREATE TABLE IF NOT EXISTS card_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  source text NOT NULL CHECK (source IN ('csv', 'plaid')),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  received_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  unmatched_count integer NOT NULL DEFAULT 0,
  imported_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_imports_user ON card_imports(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS card_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  import_id uuid REFERENCES card_imports(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('csv', 'plaid')),
  dedupe_key text NOT NULL,
  external_id text,
  transaction_at timestamptz NOT NULL,
  provider text,
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  plate text,
  merchant text,
  city text,
  state text,
  kind text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'fuel')),
  product text,
  gallons numeric CHECK (gallons IS NULL OR gallons >= 0),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  card_id uuid REFERENCES company_cards(id) ON DELETE SET NULL,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_label text,
  technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  technician_name text,
  match_method text NOT NULL DEFAULT 'none' CHECK (match_method IN ('card', 'plate', 'none')),
  assignment_locked boolean NOT NULL DEFAULT false,
  flags text[] NOT NULL DEFAULT ARRAY[]::text[],
  receipt_status text NOT NULL DEFAULT 'required' CHECK (receipt_status IN ('required', 'not_required', 'attached', 'waived')),
  receipt_due_at timestamptz,
  expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL,
  attached_at timestamptz,
  attached_by uuid,
  waived_reason text CHECK (waived_reason IS NULL OR char_length(waived_reason) <= 500),
  waived_by uuid,
  waived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_card_txn_expense ON card_transactions(expense_id) WHERE expense_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_card_txn_user_time ON card_transactions(user_id, transaction_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_txn_tech_receipt ON card_transactions(technician_id, receipt_status);
CREATE INDEX IF NOT EXISTS idx_card_txn_receipt_due ON card_transactions(user_id, receipt_status, receipt_due_at);
CREATE INDEX IF NOT EXISTS idx_card_txn_import ON card_transactions(import_id);
CREATE INDEX IF NOT EXISTS idx_card_txn_last4 ON card_transactions(user_id, card_last4);
CREATE INDEX IF NOT EXISTS idx_card_txn_card ON card_transactions(card_id);

-- =============================================================
-- RLS: read-only; managers see all, a technician sees only their own purchases
-- =============================================================

ALTER TABLE card_feed_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_transactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON card_feed_settings, company_cards, card_imports, card_transactions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON card_feed_settings, company_cards, card_imports, card_transactions FROM authenticated;

DROP POLICY IF EXISTS "select_card_feed_settings" ON card_feed_settings;
CREATE POLICY "select_card_feed_settings" ON card_feed_settings FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.expense_is_manager()));

DROP POLICY IF EXISTS "select_company_cards" ON company_cards;
CREATE POLICY "select_company_cards" ON company_cards FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.expense_is_manager()));

DROP POLICY IF EXISTS "select_card_imports" ON card_imports;
CREATE POLICY "select_card_imports" ON card_imports FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND (SELECT public.expense_is_manager()));

DROP POLICY IF EXISTS "select_card_transactions" ON card_transactions;
CREATE POLICY "select_card_transactions" ON card_transactions FOR SELECT TO authenticated
  USING (
    user_id = (SELECT public.get_account_owner_id())
    AND (
      (SELECT public.expense_is_manager())
      OR technician_id = ANY ((SELECT public.cardfeed_my_member_ids()))
    )
  );

-- =============================================================
-- INTERNAL: settings + matching
-- =============================================================

CREATE OR REPLACE FUNCTION public._cardfeed_ensure_settings(p_owner uuid, p_tz text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text := 'UTC';
BEGIN
  IF p_tz IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
    v_tz := p_tz;
  END IF;
  INSERT INTO card_feed_settings (user_id, timezone) VALUES (p_owner, v_tz)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- Re-derives card / vehicle / technician / kind / flags. Never touches receipt state and
-- never touches a purchase a manager assigned by hand (assignment_locked). Idempotent.
-- Mirrors matchCardTransaction() in src/lib/cardFeed.ts.
CREATE OR REPLACE FUNCTION public._cardfeed_match(p_owner uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH base AS (
    SELECT ct.id, ct.transaction_at, ct.plate, ct.kind AS kind_hint,
           cc.n_all, cc.id_all, cc.n_p, cc.id_p
      FROM card_transactions ct
      LEFT JOIN LATERAL (
        SELECT count(*) AS n_all,
               (array_agg(c.id))[1] AS id_all,
               count(*) FILTER (WHERE btrim(COALESCE(ct.provider, '')) <> '' AND lower(btrim(c.provider)) = lower(btrim(ct.provider))) AS n_p,
               (array_agg(c.id) FILTER (WHERE btrim(COALESCE(ct.provider, '')) <> '' AND lower(btrim(c.provider)) = lower(btrim(ct.provider))))[1] AS id_p
          FROM company_cards c
         WHERE c.user_id = p_owner AND ct.card_last4 IS NOT NULL AND c.card_last4 = ct.card_last4
      ) cc ON true
     WHERE ct.user_id = p_owner AND ct.id = ANY (p_ids) AND NOT ct.assignment_locked
  ), res AS (
    SELECT base.*,
           CASE WHEN n_all = 1 THEN id_all WHEN n_all > 1 AND n_p = 1 THEN id_p END AS card_id,
           (n_all > 1 AND n_p <> 1) AS ambiguous
      FROM base
  ), veh AS (
    SELECT r.id, r.transaction_at, r.card_id, r.ambiguous, r.kind_hint,
           c.technician_id AS card_tech, c.kind AS card_kind, c.status AS card_status,
           pv.id AS plate_vehicle,
           COALESCE(c.vehicle_id, pv.id) AS vehicle_id
      FROM res r
      LEFT JOIN company_cards c ON c.id = r.card_id
      LEFT JOIN LATERAL (
        SELECT (array_agg(v.id))[1] AS id
          FROM vehicles v
         WHERE v.user_id = p_owner AND r.plate IS NOT NULL AND r.plate <> ''
           AND regexp_replace(upper(COALESCE(v.license_plate, '')), '[^A-Z0-9]', '', 'g') = r.plate
        HAVING count(*) = 1
      ) pv ON true
  ), fin AS (
    SELECT veh.*,
           COALESCE(veh.card_tech, hist.technician_id, legacy.technician_id) AS tech_id
      FROM veh
      LEFT JOIN LATERAL (
        SELECT va.technician_id
          FROM vehicle_assignments va
         WHERE va.vehicle_id = veh.vehicle_id AND va.technician_id IS NOT NULL
           AND va.assigned_at <= veh.transaction_at
           AND (va.unassigned_at IS NULL OR veh.transaction_at < va.unassigned_at)
         ORDER BY va.assigned_at DESC
         LIMIT 1
      ) hist ON true
      LEFT JOIN LATERAL (
        SELECT v2.assigned_technician_id AS technician_id
          FROM vehicles v2
         WHERE v2.id = veh.vehicle_id AND v2.assigned_technician_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM vehicle_assignments vx WHERE vx.vehicle_id = v2.id)
      ) legacy ON true
  )
  UPDATE card_transactions ct
     SET card_id = f.card_id,
         vehicle_id = f.vehicle_id,
         vehicle_label = v.label,
         technician_id = tm.id,
         technician_name = COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
         match_method = CASE WHEN f.card_id IS NOT NULL THEN 'card' WHEN f.plate_vehicle IS NOT NULL THEN 'plate' ELSE 'none' END,
         kind = COALESCE(f.card_kind, f.kind_hint),
         flags = array_remove(ARRAY[
           CASE WHEN ct.card_last4 IS NOT NULL AND f.card_id IS NULL AND NOT f.ambiguous THEN 'unregistered_card' END,
           CASE WHEN f.ambiguous THEN 'ambiguous_card' END,
           CASE WHEN f.card_status IS NOT NULL AND f.card_status <> 'active' THEN 'card_inactive' END,
           CASE WHEN tm.id IS NULL THEN 'no_driver' END,
           CASE WHEN EXISTS (
             SELECT 1 FROM card_transactions o
              WHERE o.user_id = p_owner AND o.id <> ct.id AND o.source <> ct.source
                AND o.amount_cents = ct.amount_cents
                AND abs(o.transaction_at::date - ct.transaction_at::date) <= 3
                AND (o.card_last4 IS NULL OR ct.card_last4 IS NULL OR o.card_last4 = ct.card_last4)
           ) THEN 'possible_duplicate' END
         ]::text[], NULL)
    FROM fin f
    LEFT JOIN vehicles v ON v.id = f.vehicle_id
    LEFT JOIN team_members tm ON tm.id = f.tech_id AND tm.account_owner_id = p_owner
   WHERE ct.id = f.id;
END;
$$;

-- =============================================================
-- PUBLIC RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.import_card_transactions(
  p_source text,
  p_file_name text,
  p_rows jsonb,
  p_timezone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_s card_feed_settings%ROWTYPE;
  v_import uuid;
  v_row record;
  v_reason text;
  v_ts timestamptz;
  v_digits text;
  v_card text;
  v_plate text;
  v_amount numeric;
  v_cents integer;
  v_gal numeric;
  v_kind text;
  v_ext text;
  v_prov text;
  v_merchant text;
  v_key text;
  v_id uuid;
  v_status text;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_received integer;
  v_dupes integer := 0;
  v_rejected integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_matched integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to import card transactions' USING ERRCODE = '42501';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('csv', 'plaid') THEN
    RAISE EXCEPTION 'Unknown import source' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Rows must be a list' USING ERRCODE = '22023';
  END IF;
  v_received := jsonb_array_length(p_rows);
  IF v_received = 0 THEN
    RAISE EXCEPTION 'There are no rows to import' USING ERRCODE = '22023';
  END IF;
  IF v_received > 5000 THEN
    RAISE EXCEPTION 'Import at most 5,000 rows at a time' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('card_import:' || v_owner::text));
  PERFORM public._cardfeed_ensure_settings(v_owner, p_timezone);
  SELECT * INTO v_s FROM card_feed_settings WHERE user_id = v_owner;

  INSERT INTO card_imports (user_id, source, file_name, received_count)
  VALUES (v_owner, p_source, left(COALESCE(NULLIF(btrim(p_file_name), ''), 'import'), 200), v_received)
  RETURNING id INTO v_import;

  FOR v_row IN
    SELECT t.ord, t.elem FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_reason := NULL;

    IF jsonb_typeof(v_row.elem) <> 'object' THEN
      v_reason := 'Row is not valid';
    ELSE
      v_ts := public._cardfeed_try_timestamp(v_row.elem ->> 'transaction_at', v_s.timezone);
      v_digits := regexp_replace(COALESCE(v_row.elem ->> 'card_last4', ''), '[^0-9]', '', 'g');
      v_card := CASE WHEN char_length(v_digits) >= 4 THEN right(v_digits, 4) END;
      v_plate := NULLIF(regexp_replace(upper(COALESCE(v_row.elem ->> 'plate', '')), '[^A-Z0-9]', '', 'g'), '');
      v_amount := public._cardfeed_try_numeric(v_row.elem ->> 'amount');
      v_gal := public._cardfeed_try_numeric(v_row.elem ->> 'gallons');

      IF v_ts IS NULL THEN
        v_reason := 'Invalid or missing date/time';
      ELSIF v_ts < timestamptz '2000-01-01 00:00:00+00' OR v_ts > now() + interval '2 days' THEN
        v_reason := 'Date is out of range';
      ELSIF p_source = 'csv' AND v_card IS NULL AND v_plate IS NULL THEN
        v_reason := 'Missing card number or plate';
      ELSIF v_amount IS NULL THEN
        v_reason := 'Invalid or missing amount';
      ELSIF v_amount <= 0 THEN
        v_reason := 'Credit, refund or zero-amount row skipped';
      ELSIF v_amount > 1000000 THEN
        v_reason := 'Amount is unrealistically large';
      ELSIF v_gal IS NOT NULL AND (v_gal < 0 OR v_gal > 1000) THEN
        v_reason := 'Gallons are not valid';
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      v_cents := round(v_amount * 100)::integer;
      v_kind := lower(COALESCE(v_row.elem ->> 'kind', ''));
      IF v_kind NOT IN ('expense', 'fuel') THEN
        v_kind := 'expense';
      END IF;
      v_ext := NULLIF(left(btrim(COALESCE(v_row.elem ->> 'external_id', '')), 80), '');
      v_prov := NULLIF(left(btrim(COALESCE(v_row.elem ->> 'provider', '')), 40), '');
      v_merchant := NULLIF(left(btrim(COALESCE(v_row.elem ->> 'merchant', '')), 120), '');

      IF v_ext IS NOT NULL THEN
        v_key := 'x:' || p_source || ':' || lower(COALESCE(v_prov, '')) || ':' || v_ext;
      ELSE
        v_key := 'h:' || md5(concat_ws('|',
          p_source, COALESCE(v_card, ''), COALESCE(v_plate, ''),
          floor(extract(epoch FROM v_ts))::bigint::text,
          v_cents::text, lower(COALESCE(v_merchant, ''))));
      END IF;

      v_status := CASE WHEN v_cents > v_s.receipt_required_over_cents THEN 'required' ELSE 'not_required' END;

      v_id := NULL;
      INSERT INTO card_transactions (
        user_id, import_id, source, dedupe_key, external_id, transaction_at, provider, card_last4, plate,
        merchant, city, state, kind, product, gallons, amount_cents, receipt_status, receipt_due_at
      )
      VALUES (
        v_owner, v_import, p_source, v_key, v_ext, v_ts, v_prov, v_card, v_plate,
        v_merchant,
        NULLIF(left(btrim(COALESCE(v_row.elem ->> 'city', '')), 80), ''),
        NULLIF(left(btrim(COALESCE(v_row.elem ->> 'state', '')), 20), ''),
        v_kind,
        NULLIF(left(btrim(COALESCE(v_row.elem ->> 'product', '')), 30), ''),
        v_gal, v_cents, v_status,
        CASE WHEN v_status = 'required' THEN v_ts + (v_s.receipt_due_days * interval '1 day') END
      )
      ON CONFLICT (user_id, dedupe_key) DO NOTHING
      RETURNING id INTO v_id;

      IF v_id IS NULL THEN
        v_dupes := v_dupes + 1;
      ELSE
        v_ids := array_append(v_ids, v_id);
      END IF;
    ELSE
      v_rejected := v_rejected + 1;
      IF v_rejected <= 25 THEN
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line', COALESCE(
            CASE WHEN jsonb_typeof(v_row.elem) = 'object' THEN v_row.elem ->> 'line' END,
            v_row.ord::text),
          'reason', v_reason));
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_ids) > 0 THEN
    PERFORM public._cardfeed_match(v_owner, v_ids);
    SELECT count(*) INTO v_matched FROM card_transactions WHERE id = ANY (v_ids) AND technician_id IS NOT NULL;

    -- One notification per technician who now owes receipts.
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT tm.user_id, 'system', 'Receipts needed for card purchases',
           'You have ' || x.n || ' new card purchase' || CASE WHEN x.n = 1 THEN '' ELSE 's' END || ' that need a receipt.',
           '/dashboard/card-feed'
      FROM (
        SELECT technician_id, count(*) AS n
          FROM card_transactions
         WHERE id = ANY (v_ids) AND receipt_status = 'required' AND technician_id IS NOT NULL
         GROUP BY technician_id
      ) x
      JOIN team_members tm ON tm.id = x.technician_id AND tm.user_id IS NOT NULL;
  END IF;

  IF p_source = 'plaid' THEN
    UPDATE card_feed_settings SET last_bank_import_at = now() WHERE user_id = v_owner;
  END IF;

  UPDATE card_imports
     SET inserted_count = cardinality(v_ids),
         duplicate_count = v_dupes,
         rejected_count = v_rejected,
         matched_count = v_matched,
         unmatched_count = cardinality(v_ids) - v_matched
   WHERE id = v_import;

  RETURN jsonb_build_object(
    'import_id', v_import,
    'received', v_received,
    'inserted', cardinality(v_ids),
    'duplicates', v_dupes,
    'rejected', v_rejected,
    'matched', v_matched,
    'unmatched', cardinality(v_ids) - v_matched,
    'errors', v_errors
  );
END;
$$;

-- The technician (or a manager) files the receipt. Reuses save_expense(): the expense is a
-- company_card expense submitted for review, and the link is made in the SAME transaction,
-- so a failed check leaves nothing behind.
CREATE OR REPLACE FUNCTION public.cardfeed_submit_receipt(
  p_txn_id uuid,
  p_data jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_uid uuid := auth.uid();
  t card_transactions%ROWTYPE;
  v_tz text;
  v_amount integer;
  v_tol integer;
  v_date date;
  v_exp uuid;
  v_exp_status text;
  v_exp_by uuid;
  v_data jsonb;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'Invalid receipt data' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO t FROM card_transactions WHERE id = p_txn_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (public.expense_is_manager() OR (t.technician_id IS NOT NULL AND t.technician_id = ANY (public.cardfeed_my_member_ids()))) THEN
    RAISE EXCEPTION 'You do not have permission to file a receipt for this purchase' USING ERRCODE = '42501';
  END IF;
  IF t.receipt_status = 'waived' THEN
    RAISE EXCEPTION 'A manager waived the receipt for this purchase' USING ERRCODE = '22023';
  END IF;

  IF t.expense_id IS NOT NULL THEN
    SELECT e.status, e.submitted_by INTO v_exp_status, v_exp_by FROM expenses e WHERE e.id = t.expense_id AND e.user_id = v_owner FOR UPDATE;
    IF FOUND THEN
      IF v_exp_status NOT IN ('draft', 'rejected') THEN
        RAISE EXCEPTION 'A receipt has already been filed for this purchase' USING ERRCODE = '22023';
      END IF;
      IF v_exp_by <> v_uid THEN
        RAISE EXCEPTION 'This purchase was filed by someone else' USING ERRCODE = '42501';
      END IF;
      v_exp := t.expense_id;
    END IF;
  END IF;

  IF nullif(p_data ->> 'receipt_path', '') IS NULL THEN
    RAISE EXCEPTION 'Attach a photo or PDF of the receipt' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_data ->> 'amount_cents', '') = '' THEN
    v_amount := t.amount_cents;
  ELSIF p_data ->> 'amount_cents' ~ '^[0-9]{1,9}$' THEN
    v_amount := (p_data ->> 'amount_cents')::integer;
  ELSE
    RAISE EXCEPTION 'Enter a valid amount' USING ERRCODE = '22023';
  END IF;
  v_tol := GREATEST(100, round(t.amount_cents * 0.05)::integer);
  IF abs(v_amount - t.amount_cents) > v_tol THEN
    RAISE EXCEPTION 'The receipt total (%) does not match the card charge (%). Check the receipt or ask a manager.',
      to_char(v_amount / 100.0, 'FM$999,999,990.00'), to_char(t.amount_cents / 100.0, 'FM$999,999,990.00')
      USING ERRCODE = '22023';
  END IF;

  SELECT timezone INTO v_tz FROM card_feed_settings WHERE user_id = v_owner;
  v_tz := COALESCE(v_tz, 'UTC');
  IF COALESCE(p_data ->> 'expense_date', '') = '' THEN
    v_date := (t.transaction_at AT TIME ZONE v_tz)::date;
  ELSIF p_data ->> 'expense_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN
    BEGIN
      v_date := (p_data ->> 'expense_date')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Enter a valid receipt date' USING ERRCODE = '22023';
    END;
  ELSE
    RAISE EXCEPTION 'Enter a valid receipt date' USING ERRCODE = '22023';
  END IF;
  IF abs(v_date - (t.transaction_at AT TIME ZONE v_tz)::date) > 10 THEN
    RAISE EXCEPTION 'The receipt date is too far from the card purchase date' USING ERRCODE = '22023';
  END IF;

  v_data := p_data || jsonb_build_object(
    'payment_method', 'company_card',
    'is_reimbursable', false,
    'amount_cents', v_amount,
    'expense_date', v_date::text,
    'vendor_name', COALESCE(NULLIF(btrim(p_data ->> 'vendor_name'), ''), t.merchant, 'Card purchase')
  );

  v_id := public.save_expense(v_exp, v_data, COALESCE(p_allocations, '[]'::jsonb), true);

  UPDATE card_transactions
     SET receipt_status = 'attached', expense_id = v_id, attached_at = now(), attached_by = v_uid,
         waived_reason = NULL, waived_by = NULL, waived_at = NULL
   WHERE id = t.id;

  PERFORM public.log_audit_event(v_owner, 'card_receipt_attached', 'card_transactions', t.id::text);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cardfeed_waive_receipt(p_ids uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_n integer;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to waive receipts' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Add a short reason (3-500 characters)' USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Select at most 500 purchases at a time' USING ERRCODE = '22023';
  END IF;

  UPDATE card_transactions
     SET receipt_status = 'waived', waived_reason = v_reason, waived_by = auth.uid(), waived_at = now()
   WHERE user_id = v_owner AND id = ANY (p_ids) AND receipt_status = 'required' AND expense_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN
    PERFORM public.log_audit_event(v_owner, 'card_receipt_waived', 'card_transactions', cardinality(p_ids)::text);
  END IF;
  RETURN v_n;
END;
$$;

-- Manual assignment (and "back to automatic" when both are NULL).
CREATE OR REPLACE FUNCTION public.cardfeed_assign(p_ids uuid[], p_technician_id uuid, p_vehicle_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
  v_tech_name text;
  v_veh_label text;
  v_open uuid[];
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to assign purchases' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Select at most 500 purchases at a time' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_open
    FROM card_transactions
   WHERE user_id = v_owner AND id = ANY (p_ids) AND expense_id IS NULL AND receipt_status IN ('required', 'not_required');

  IF cardinality(v_open) = 0 THEN
    RETURN 0;
  END IF;

  IF p_technician_id IS NULL AND p_vehicle_id IS NULL THEN
    UPDATE card_transactions SET assignment_locked = false WHERE id = ANY (v_open);
    PERFORM public._cardfeed_match(v_owner, v_open);
    RETURN cardinality(v_open);
  END IF;

  IF p_technician_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(member_name), ''), member_email) INTO v_tech_name
      FROM team_members WHERE id = p_technician_id AND account_owner_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Technician not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF p_vehicle_id IS NOT NULL THEN
    SELECT label INTO v_veh_label FROM vehicles WHERE id = p_vehicle_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Vehicle not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  UPDATE card_transactions
     SET technician_id = p_technician_id,
         technician_name = v_tech_name,
         vehicle_id = p_vehicle_id,
         vehicle_label = v_veh_label,
         assignment_locked = true,
         flags = CASE WHEN p_technician_id IS NULL THEN flags ELSE array_remove(flags, 'no_driver') END
   WHERE id = ANY (v_open);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_company_card(
  p_id uuid,
  p_label text,
  p_kind text,
  p_provider text,
  p_last4 text,
  p_vehicle_id uuid,
  p_technician_id uuid,
  p_status text,
  p_notes text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_label text := btrim(COALESCE(p_label, ''));
  v_provider text := lower(btrim(COALESCE(p_provider, '')));
  v_last4 text := btrim(COALESCE(p_last4, ''));
  v_id uuid;
  v_ids uuid[];
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to manage cards' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_label) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Card name must be 1-80 characters' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('expense', 'fuel') THEN
    RAISE EXCEPTION 'Invalid card type' USING ERRCODE = '22023';
  END IF;
  IF v_provider = '' THEN
    v_provider := 'other';
  END IF;
  IF char_length(v_provider) > 40 THEN
    RAISE EXCEPTION 'Provider must be 40 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF v_last4 !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Enter the last 4 digits of the card' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'suspended', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid card status' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 500 THEN
    RAISE EXCEPTION 'Notes must be 500 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF p_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Vehicle not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_technician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM team_members WHERE id = p_technician_id AND account_owner_id = v_owner) THEN
    RAISE EXCEPTION 'Technician not found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO company_cards (user_id, label, kind, provider, card_last4, vehicle_id, technician_id, status, notes)
      VALUES (v_owner, v_label, p_kind, v_provider, v_last4, p_vehicle_id, p_technician_id, p_status, NULLIF(btrim(COALESCE(p_notes, '')), ''))
      RETURNING id INTO v_id;
    ELSE
      UPDATE company_cards
         SET label = v_label, kind = p_kind, provider = v_provider, card_last4 = v_last4, vehicle_id = p_vehicle_id,
             technician_id = p_technician_id, status = p_status, notes = NULLIF(btrim(COALESCE(p_notes, '')), ''), updated_at = now()
       WHERE id = p_id AND user_id = v_owner
       RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'Card not found' USING ERRCODE = 'P0002';
      END IF;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A card with those last 4 digits already exists for this provider' USING ERRCODE = '22023';
  END;

  -- Re-match recent purchases that belong to (or now belong to) this card.
  SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
    FROM (
      SELECT ct.id FROM card_transactions ct
       WHERE ct.user_id = v_owner
         AND (ct.card_id = v_id OR ct.card_last4 = v_last4)
         AND ct.transaction_at >= now() - interval '180 days'
       ORDER BY ct.transaction_at DESC
       LIMIT 5000
    ) s;
  IF cardinality(v_ids) > 0 THEN
    PERFORM public._cardfeed_match(v_owner, v_ids);
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_company_card(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to manage cards' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM company_cards WHERE id = p_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Card not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM card_transactions WHERE card_id = p_id) THEN
    RAISE EXCEPTION 'This card has purchases. Set its status to Cancelled instead of deleting it.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM company_cards WHERE id = p_id AND user_id = v_owner;
END;
$$;

-- Copies cards from the existing Fuel Cards page (safe to run any number of times).
CREATE OR REPLACE FUNCTION public.cardfeed_sync_fuel_cards()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to manage cards' USING ERRCODE = '42501';
  END IF;
  IF to_regclass('public.fuel_cards') IS NULL THEN
    RETURN 0;
  END IF;
  INSERT INTO company_cards (user_id, label, kind, provider, card_last4, vehicle_id, technician_id, status, notes)
  SELECT fc.user_id, fc.label, 'fuel', lower(fc.provider), fc.card_last4, fc.vehicle_id, fc.technician_id, fc.status, fc.notes
    FROM fuel_cards fc
   WHERE fc.user_id = v_owner
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_card_feed_settings(
  p_receipt_over_cents integer,
  p_receipt_due_days integer,
  p_bank_account_ids uuid[],
  p_timezone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_ids uuid[] := COALESCE(p_bank_account_ids, ARRAY[]::uuid[]);
  v_ok integer := 0;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to change these settings' USING ERRCODE = '42501';
  END IF;
  IF p_receipt_over_cents IS NULL OR p_receipt_over_cents NOT BETWEEN 0 AND 10000000 THEN
    RAISE EXCEPTION 'Receipt threshold is not valid' USING ERRCODE = '22023';
  END IF;
  IF p_receipt_due_days IS NULL OR p_receipt_due_days NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Receipt deadline must be 1-60 days' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown time zone' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 20 THEN
    RAISE EXCEPTION 'Choose at most 20 bank accounts' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 0 THEN
    IF to_regclass('public.bank_accounts') IS NULL THEN
      RAISE EXCEPTION 'Connect a bank first' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_ok FROM bank_accounts WHERE id = ANY (v_ids) AND user_id = v_owner;
    IF v_ok <> (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) THEN
      RAISE EXCEPTION 'A selected bank account was not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO card_feed_settings (user_id, receipt_required_over_cents, receipt_due_days, bank_account_ids, timezone, updated_at)
  VALUES (v_owner, p_receipt_over_cents, p_receipt_due_days, ARRAY(SELECT DISTINCT unnest(v_ids)), p_timezone, now())
  ON CONFLICT (user_id) DO UPDATE SET
    receipt_required_over_cents = EXCLUDED.receipt_required_over_cents,
    receipt_due_days = EXCLUDED.receipt_due_days,
    bank_account_ids = EXCLUDED.bank_account_ids,
    timezone = EXCLUDED.timezone,
    updated_at = now();
END;
$$;

-- Undo an import. Refused when a receipt has already been filed for one of its purchases.
CREATE OR REPLACE FUNCTION public.delete_card_import(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_n integer;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.expense_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to undo imports' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM card_imports WHERE id = p_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM card_transactions WHERE import_id = p_id AND user_id = v_owner AND expense_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Receipts were already filed for purchases in this import, so it cannot be undone.' USING ERRCODE = '22023';
  END IF;

  DELETE FROM card_transactions WHERE import_id = p_id AND user_id = v_owner;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM card_imports WHERE id = p_id AND user_id = v_owner;
  RETURN v_n;
END;
$$;

-- Deleting an expense puts its card purchase back to "receipt needed".
CREATE OR REPLACE FUNCTION public._cardfeed_expense_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE card_transactions
     SET receipt_status = 'required', expense_id = NULL, attached_at = NULL, attached_by = NULL
   WHERE expense_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cardfeed_expense_deleted ON expenses;
CREATE TRIGGER trg_cardfeed_expense_deleted
  BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION public._cardfeed_expense_deleted();

-- =============================================================
-- ONE-TIME BACKFILL: existing Fuel Cards become company cards (kind = fuel)
-- =============================================================

DO $$
BEGIN
  IF to_regclass('public.fuel_cards') IS NOT NULL THEN
    INSERT INTO company_cards (user_id, label, kind, provider, card_last4, vehicle_id, technician_id, status, notes)
    SELECT fc.user_id, fc.label, 'fuel', lower(fc.provider), fc.card_last4, fc.vehicle_id, fc.technician_id, fc.status, fc.notes
      FROM fuel_cards fc
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.cardfeed_my_member_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardfeed_my_member_ids() TO authenticated;

REVOKE ALL ON FUNCTION public._cardfeed_try_numeric(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cardfeed_try_timestamp(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cardfeed_ensure_settings(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cardfeed_match(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cardfeed_expense_deleted() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.import_card_transactions(text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_card_transactions(text, text, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.cardfeed_submit_receipt(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardfeed_submit_receipt(uuid, jsonb, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.cardfeed_waive_receipt(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardfeed_waive_receipt(uuid[], text) TO authenticated;
REVOKE ALL ON FUNCTION public.cardfeed_assign(uuid[], uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardfeed_assign(uuid[], uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.save_company_card(uuid, text, text, text, text, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_company_card(uuid, text, text, text, text, uuid, uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_company_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_company_card(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.cardfeed_sync_fuel_cards() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardfeed_sync_fuel_cards() TO authenticated;
REVOKE ALL ON FUNCTION public.save_card_feed_settings(integer, integer, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_card_feed_settings(integer, integer, uuid[], text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_card_import(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_card_import(uuid) TO authenticated;
