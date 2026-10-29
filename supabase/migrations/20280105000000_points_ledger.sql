/*
  # Loyalty points

  - lpts_programs      : one settings row per account (enabled, redeem rate, caps, expiry, member multiplier)
  - lpts_earn_rules    : earn rules per paid invoice / completed job / promo-code bonus
  - lpts_accounts      : one balance per customer (balance can never go below zero - CHECK + row lock)
  - lpts_lots          : expiring point batches, consumed FIFO (soonest expiry first)
  - lpts_ledger        : APPEND-ONLY audit trail of every balance change (UPDATE/DELETE blocked by trigger)

  Reuse of existing modules:
  - invoices / invoice_payments : a redemption is recorded as an invoice payment (method 'other',
    reference 'loyalty:<ledger id>'), so balance due, partial payments and the paid flip are
    handled by the existing _invoice_recalc().
  - memberships : an active membership of the customer multiplies earned points.
  - promo codes : a promo_bonus rule pays extra points when the invoice carries a given promo code
    (read via to_jsonb(NEW) so this works whether or not invoices.promo_codes exists).

  Safety:
  - Clients have NO direct write access; every mutation is a SECURITY DEFINER RPC / trigger.
  - Earn triggers never block billing: any loyalty error is downgraded to a WARNING.
  - Double-redeem is blocked three ways: row locks, the amount still due on the invoice, and an
    optional idempotency key (a repeated key returns the first result without applying again).
*/

-- ------------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lpts_programs (
  account_owner_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  redeem_points_per_dollar integer NOT NULL DEFAULT 100 CHECK (redeem_points_per_dollar BETWEEN 1 AND 100000),
  min_redeem_points integer NOT NULL DEFAULT 100 CHECK (min_redeem_points >= 1),
  max_redeem_pct integer NOT NULL DEFAULT 100 CHECK (max_redeem_pct BETWEEN 1 AND 100),
  expiry_months integer CHECK (expiry_months IS NULL OR expiry_months BETWEEN 1 AND 120),
  member_multiplier numeric(4,2) NOT NULL DEFAULT 1 CHECK (member_multiplier >= 1 AND member_multiplier <= 10),
  earn_on_promo_invoices boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lpts_earn_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('invoice_paid', 'job_completed', 'promo_bonus')),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  points_per_dollar numeric(8,2) NOT NULL DEFAULT 0 CHECK (points_per_dollar >= 0 AND points_per_dollar <= 1000),
  flat_points integer NOT NULL DEFAULT 0 CHECK (flat_points >= 0 AND flat_points <= 1000000),
  promo_code text,
  min_invoice_cents integer NOT NULL DEFAULT 0 CHECK (min_invoice_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (points_per_dollar > 0 OR flat_points > 0),
  CHECK (kind <> 'promo_bonus' OR promo_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_lpts_rules_owner ON lpts_earn_rules(account_owner_id, active);

CREATE TABLE IF NOT EXISTS lpts_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  balance_points integer NOT NULL DEFAULT 0 CHECK (balance_points >= 0),
  lifetime_earned integer NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  lifetime_redeemed integer NOT NULL DEFAULT 0 CHECK (lifetime_redeemed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lpts_accounts_customer ON lpts_accounts(account_owner_id, customer_id);

CREATE TABLE IF NOT EXISTS lpts_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES lpts_accounts(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('earn', 'redeem', 'expire', 'adjust', 'reverse')),
  points integer NOT NULL CHECK (points <> 0),            -- signed: redeem / expire / reverse are negative
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  source_type text,                                       -- 'invoice' | 'job' | 'manual'
  source_id uuid,
  invoice_id uuid,                                        -- plain uuid on purpose: the ledger is immutable
  idempotency_key text,
  expires_at timestamptz,
  note text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lpts_ledger_idem ON lpts_ledger(account_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lpts_ledger_account ON lpts_ledger(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lpts_ledger_source ON lpts_ledger(account_owner_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_lpts_ledger_invoice ON lpts_ledger(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lpts_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES lpts_accounts(id) ON DELETE CASCADE,
  ledger_id uuid NOT NULL,
  points integer NOT NULL CHECK (points > 0),
  remaining integer NOT NULL CHECK (remaining >= 0),
  reversed_points integer NOT NULL DEFAULT 0 CHECK (reversed_points >= 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining <= points),
  CHECK (reversed_points <= points)
);
CREATE INDEX IF NOT EXISTS idx_lpts_lots_fifo ON lpts_lots(account_id, expires_at NULLS LAST, created_at) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS idx_lpts_lots_ledger ON lpts_lots(ledger_id);

-- ------------------------------------------------------------------
-- RLS: managers can read; nobody writes directly
-- ------------------------------------------------------------------
ALTER TABLE lpts_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lpts_earn_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE lpts_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lpts_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE lpts_lots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_lpts_programs" ON lpts_programs;
CREATE POLICY "select_lpts_programs" ON lpts_programs FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "select_lpts_earn_rules" ON lpts_earn_rules;
CREATE POLICY "select_lpts_earn_rules" ON lpts_earn_rules FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "select_lpts_accounts" ON lpts_accounts;
CREATE POLICY "select_lpts_accounts" ON lpts_accounts FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "select_lpts_ledger" ON lpts_ledger;
CREATE POLICY "select_lpts_ledger" ON lpts_ledger FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
DROP POLICY IF EXISTS "select_lpts_lots" ON lpts_lots;
CREATE POLICY "select_lpts_lots" ON lpts_lots FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

REVOKE ALL ON lpts_programs, lpts_earn_rules, lpts_accounts, lpts_ledger, lpts_lots FROM anon, authenticated;
GRANT SELECT ON lpts_programs, lpts_earn_rules, lpts_accounts, lpts_ledger, lpts_lots TO authenticated;

-- ------------------------------------------------------------------
-- Append-only ledger. Cascaded deletes (customer / account removal) run at trigger depth >= 2
-- and are allowed; a direct DELETE or any UPDATE is rejected.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lpts_ledger_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'lpts_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_lpts_ledger_immutable ON lpts_ledger;
CREATE TRIGGER trg_lpts_ledger_immutable
  BEFORE UPDATE OR DELETE ON lpts_ledger
  FOR EACH ROW EXECUTE FUNCTION public.lpts_ledger_immutable();

-- ------------------------------------------------------------------
-- Internal helpers (not granted to clients). Every mutation takes the ACCOUNT row lock first.
-- ------------------------------------------------------------------

-- invoice -> customer: explicit customer_id, else email, else phone, else a unique exact name match.
CREATE OR REPLACE FUNCTION public._lpts_resolve_customer(
  p_owner uuid, p_customer_id text, p_email text, p_phone text, p_name text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_ids uuid[];
BEGIN
  IF p_customer_id IS NOT NULL AND p_customer_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT c.id INTO v_id FROM customers c WHERE c.id = p_customer_id::uuid AND c.user_id = p_owner;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  IF nullif(btrim(p_email), '') IS NOT NULL THEN
    SELECT c.id INTO v_id FROM customers c WHERE c.user_id = p_owner AND lower(c.email) = lower(btrim(p_email)) LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  IF nullif(btrim(p_phone), '') IS NOT NULL THEN
    SELECT c.id INTO v_id FROM customers c WHERE c.user_id = p_owner AND c.phone = btrim(p_phone) LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  IF nullif(btrim(p_name), '') IS NOT NULL THEN
    SELECT array_agg(s.id) INTO v_ids FROM (
      SELECT c.id FROM customers c WHERE c.user_id = p_owner AND lower(btrim(c.name)) = lower(btrim(p_name)) LIMIT 2
    ) s;
    IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN RETURN v_ids[1]; END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Returns the (locked) account row; creates it when p_create. All columns are NULL when absent.
CREATE OR REPLACE FUNCTION public._lpts_lock_account(p_owner uuid, p_customer uuid, p_create boolean)
RETURNS lpts_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct lpts_accounts;
BEGIN
  IF p_create THEN
    INSERT INTO lpts_accounts (account_owner_id, customer_id)
    VALUES (p_owner, p_customer)
    ON CONFLICT (account_owner_id, customer_id) DO NOTHING;
  END IF;
  SELECT * INTO v_acct FROM lpts_accounts
   WHERE account_owner_id = p_owner AND customer_id = p_customer
   FOR UPDATE;
  RETURN v_acct;
END;
$$;

-- Adds points (earn / positive adjust) as a new lot. Account must be locked by the caller.
-- Returns NULL (and changes nothing) when the idempotency key was already used.
CREATE OR REPLACE FUNCTION public._lpts_credit(
  p_account uuid, p_kind text, p_points integer, p_source_type text, p_source_id uuid,
  p_invoice_id uuid, p_key text, p_note text, p_expires timestamptz, p_meta jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct lpts_accounts;
  v_id uuid := gen_random_uuid();
  v_new_id uuid;
  v_balance integer;
BEGIN
  IF p_points IS NULL OR p_points <= 0 THEN RAISE EXCEPTION 'Credit must be positive'; END IF;
  SELECT * INTO v_acct FROM lpts_accounts WHERE id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loyalty account not found'; END IF;
  v_balance := v_acct.balance_points + p_points;

  INSERT INTO lpts_ledger (id, account_owner_id, account_id, customer_id, kind, points, balance_after,
                              source_type, source_id, invoice_id, idempotency_key, expires_at, note, meta)
  VALUES (v_id, v_acct.account_owner_id, v_acct.id, v_acct.customer_id, p_kind, p_points, v_balance,
          p_source_type, p_source_id, p_invoice_id, p_key, p_expires, p_note, coalesce(p_meta, '{}'::jsonb))
  ON CONFLICT (account_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_new_id;
  IF v_new_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO lpts_lots (account_owner_id, account_id, ledger_id, points, remaining, expires_at)
  VALUES (v_acct.account_owner_id, v_acct.id, v_new_id, p_points, p_points, p_expires);

  UPDATE lpts_accounts
     SET balance_points = v_balance,
         lifetime_earned = lifetime_earned + CASE WHEN p_kind = 'earn' THEN p_points ELSE 0 END,
         updated_at = now()
   WHERE id = v_acct.id;
  RETURN v_new_id;
END;
$$;

-- Takes points out of the soonest-expiring lots. Account must be locked and swept by the caller.
CREATE OR REPLACE FUNCTION public._lpts_consume(p_account uuid, p_points integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_need integer := p_points;
  v_take integer;
  l record;
BEGIN
  IF p_points IS NULL OR p_points <= 0 THEN RAISE EXCEPTION 'Points must be positive'; END IF;
  FOR l IN
    SELECT id, remaining FROM lpts_lots
     WHERE account_id = p_account AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())
     ORDER BY expires_at NULLS LAST, created_at, id
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := least(l.remaining, v_need);
    UPDATE lpts_lots SET remaining = remaining - v_take WHERE id = l.id;
    v_need := v_need - v_take;
  END LOOP;
  IF v_need > 0 THEN RAISE EXCEPTION 'Not enough points available'; END IF;
END;
$$;

-- Expires lots that are past their date. Account must be locked by the caller.
CREATE OR REPLACE FUNCTION public._lpts_sweep(p_account uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct lpts_accounts;
  v_total integer := 0;
  v_balance integer;
  l record;
BEGIN
  SELECT * INTO v_acct FROM lpts_accounts WHERE id = p_account;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_balance := v_acct.balance_points;
  FOR l IN
    SELECT id, remaining, expires_at FROM lpts_lots
     WHERE account_id = p_account AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY expires_at, id
  LOOP
    v_balance := v_balance - l.remaining;
    INSERT INTO lpts_ledger (account_owner_id, account_id, customer_id, kind, points, balance_after,
                                idempotency_key, expires_at, note, meta)
    VALUES (v_acct.account_owner_id, v_acct.id, v_acct.customer_id, 'expire', -l.remaining, v_balance,
            'expire:lot:' || l.id::text, l.expires_at, 'Points expired', jsonb_build_object('lot_id', l.id))
    ON CONFLICT (account_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    UPDATE lpts_lots SET remaining = 0 WHERE id = l.id;
    v_total := v_total + l.remaining;
  END LOOP;
  IF v_total > 0 THEN
    UPDATE lpts_accounts SET balance_points = v_balance, updated_at = now() WHERE id = p_account;
  END IF;
  RETURN v_total;
END;
$$;

-- Claws back what a source (invoice) earned, never beyond what is still unspent.
CREATE OR REPLACE FUNCTION public._lpts_reverse_source(p_owner uuid, p_source_type text, p_source_id uuid, p_note text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  v_take integer;
  v_acct lpts_accounts;
  v_lot record;
  l record;
BEGIN
  FOR l IN
    SELECT DISTINCT lt.account_id AS account_id
      FROM lpts_lots lt
      JOIN lpts_ledger lg ON lg.id = lt.ledger_id
     WHERE lg.account_owner_id = p_owner AND lg.source_type = p_source_type AND lg.source_id = p_source_id AND lg.kind = 'earn'
  LOOP
    SELECT * INTO v_acct FROM lpts_accounts WHERE id = l.account_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM public._lpts_sweep(v_acct.id);
    SELECT * INTO v_acct FROM lpts_accounts WHERE id = v_acct.id;

    FOR v_lot IN
      SELECT lt.id, lt.points, lt.remaining, lt.reversed_points, lg.meta ->> 'rule_id' AS rule_id
        FROM lpts_lots lt
        JOIN lpts_ledger lg ON lg.id = lt.ledger_id
       WHERE lt.account_id = v_acct.id AND lg.source_type = p_source_type AND lg.source_id = p_source_id AND lg.kind = 'earn'
         AND lt.remaining > 0 AND lt.points - lt.reversed_points > 0
       ORDER BY lt.created_at, lt.id
    LOOP
      v_take := least(v_lot.remaining, v_lot.points - v_lot.reversed_points);
      IF v_take <= 0 THEN CONTINUE; END IF;
      UPDATE lpts_lots SET remaining = remaining - v_take, reversed_points = reversed_points + v_take WHERE id = v_lot.id;
      UPDATE lpts_accounts SET balance_points = balance_points - v_take, updated_at = now() WHERE id = v_acct.id;
      INSERT INTO lpts_ledger (account_owner_id, account_id, customer_id, kind, points, balance_after,
                                  source_type, source_id, idempotency_key, note, meta)
      VALUES (p_owner, v_acct.id, v_acct.customer_id, 'reverse', -v_take,
              (SELECT balance_points FROM lpts_accounts WHERE id = v_acct.id),
              p_source_type, p_source_id, 'reverse:lot:' || v_lot.id::text, p_note,
              jsonb_build_object('lot_id', v_lot.id, 'earned', v_lot.points, 'rule_id', v_lot.rule_id))
      ON CONFLICT (account_owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      v_total := v_total + v_take;
    END LOOP;
  END LOOP;
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public._lpts_multiplier(p_owner uuid, p_customer uuid, p_multiplier numeric)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_member boolean;
BEGIN
  IF p_multiplier IS NULL OR p_multiplier <= 1 THEN RETURN 1; END IF;
  SELECT c.name INTO v_name FROM customers c WHERE c.id = p_customer;
  SELECT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = p_owner
       AND m.status = 'active'
       AND (nullif(to_jsonb(m) ->> 'current_period_end', '') IS NULL
            OR (to_jsonb(m) ->> 'current_period_end')::timestamptz > now())
       AND ((to_jsonb(m) ->> 'customer_id') = p_customer::text
            OR (v_name IS NOT NULL AND lower(btrim(m.customer_name)) = lower(btrim(v_name))))
  ) INTO v_member;
  RETURN CASE WHEN v_member THEN p_multiplier ELSE 1 END;
END;
$$;

-- Points still owed to / earned by one source+rule: > 0 means "already earned, do not earn again".
CREATE OR REPLACE FUNCTION public._lpts_net_earned(p_owner uuid, p_source_type text, p_source_id uuid, p_rule uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(sum(lg.points) FILTER (WHERE lg.kind = 'earn'), 0)
       + coalesce(sum(lg.points) FILTER (WHERE lg.kind = 'reverse'), 0)
    FROM lpts_ledger lg
   WHERE lg.account_owner_id = p_owner AND lg.source_type = p_source_type AND lg.source_id = p_source_id
     AND lg.kind IN ('earn', 'reverse') AND lg.meta ->> 'rule_id' = p_rule::text;
$$;

REVOKE ALL ON FUNCTION public._lpts_resolve_customer(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_lock_account(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_credit(uuid, text, integer, text, uuid, uuid, text, text, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_consume(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_sweep(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_reverse_source(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_multiplier(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lpts_net_earned(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- Earn triggers. Loyalty must never block billing or job completion.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lpts_on_invoice_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prog lpts_programs;
  v_json jsonb := to_jsonb(NEW);
  v_promos jsonb;
  v_has_promo boolean;
  v_cust uuid;
  v_acct lpts_accounts;
  v_promo_cents bigint;
  v_redeemed bigint;
  v_base bigint;
  v_mult numeric;
  v_pts integer;
  v_expires timestamptz;
  v_count integer;
  r lpts_earn_rules;
BEGIN
  BEGIN
    SELECT * INTO v_prog FROM lpts_programs WHERE account_owner_id = NEW.user_id AND enabled;
    IF NOT FOUND THEN RETURN NEW; END IF;

    v_promos := v_json -> 'promo_codes';
    v_has_promo := CASE WHEN jsonb_typeof(v_promos) = 'array' THEN jsonb_array_length(v_promos) > 0 ELSE false END;
    IF v_has_promo AND NOT v_prog.earn_on_promo_invoices THEN RETURN NEW; END IF;

    v_cust := public._lpts_resolve_customer(NEW.user_id, v_json ->> 'customer_id', NEW.customer_email, NEW.customer_phone, NEW.customer_name);
    IF v_cust IS NULL THEN RETURN NEW; END IF;

    v_promo_cents := coalesce(nullif(v_json ->> 'promo_discount_cents', '')::numeric, 0)::bigint;
    SELECT coalesce(sum((lg.meta ->> 'applied_cents')::bigint), 0) INTO v_redeemed
      FROM lpts_ledger lg WHERE lg.invoice_id = NEW.id AND lg.kind = 'redeem';
    v_base := greatest(public.invoice_total_cents(NEW.line_items, 0) - greatest(v_promo_cents, 0) - v_redeemed, 0);
    IF v_base <= 0 THEN RETURN NEW; END IF;

    v_mult := public._lpts_multiplier(NEW.user_id, v_cust, v_prog.member_multiplier);
    v_expires := CASE WHEN v_prog.expiry_months IS NULL THEN NULL ELSE now() + make_interval(months => v_prog.expiry_months) END;

    v_acct := public._lpts_lock_account(NEW.user_id, v_cust, true);
    IF v_acct.id IS NULL THEN RETURN NEW; END IF;

    FOR r IN
      SELECT * FROM lpts_earn_rules
       WHERE account_owner_id = NEW.user_id AND active AND kind IN ('invoice_paid', 'promo_bonus')
       ORDER BY created_at, id
    LOOP
      CONTINUE WHEN v_base < r.min_invoice_cents;
      IF r.kind = 'promo_bonus' THEN
        CONTINUE WHEN NOT (CASE WHEN jsonb_typeof(v_promos) = 'array' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_promos) c WHERE upper(btrim(c)) = upper(btrim(r.promo_code))
        ) ELSE false END);
      END IF;
      CONTINUE WHEN public._lpts_net_earned(NEW.user_id, 'invoice', NEW.id, r.id) > 0;

      v_pts := least(floor((v_base::numeric / 100) * r.points_per_dollar * v_mult)::bigint + floor(r.flat_points * v_mult)::bigint, 1000000)::integer;
      CONTINUE WHEN v_pts <= 0;

      SELECT count(*) INTO v_count FROM lpts_ledger
       WHERE account_owner_id = NEW.user_id AND source_type = 'invoice' AND source_id = NEW.id AND kind = 'earn' AND meta ->> 'rule_id' = r.id::text;
      PERFORM public._lpts_credit(v_acct.id, 'earn', v_pts, 'invoice', NEW.id, NEW.id,
        'earn:invoice:' || NEW.id::text || ':' || r.id::text || ':' || v_count::text,
        r.label, v_expires,
        jsonb_build_object('rule_id', r.id, 'rule_kind', r.kind, 'base_cents', v_base, 'multiplier', v_mult));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'loyalty earn skipped for invoice %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.lpts_on_invoice_unpaid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public._lpts_reverse_source(NEW.user_id, 'invoice', NEW.id,
      CASE WHEN NEW.status = 'void' THEN 'Invoice voided' ELSE 'Invoice no longer fully paid' END);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'loyalty reversal skipped for invoice %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.lpts_on_job_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prog lpts_programs;
  v_json jsonb := to_jsonb(NEW);
  v_cust uuid;
  v_acct lpts_accounts;
  v_mult numeric;
  v_pts integer;
  v_expires timestamptz;
  r lpts_earn_rules;
BEGIN
  BEGIN
    SELECT * INTO v_prog FROM lpts_programs WHERE account_owner_id = NEW.user_id AND enabled;
    IF NOT FOUND THEN RETURN NEW; END IF;

    v_cust := public._lpts_resolve_customer(NEW.user_id, v_json ->> 'customer_id', NULL, NULL, NEW.customer_name);
    IF v_cust IS NULL THEN RETURN NEW; END IF;

    v_mult := public._lpts_multiplier(NEW.user_id, v_cust, v_prog.member_multiplier);
    v_expires := CASE WHEN v_prog.expiry_months IS NULL THEN NULL ELSE now() + make_interval(months => v_prog.expiry_months) END;

    v_acct := public._lpts_lock_account(NEW.user_id, v_cust, true);
    IF v_acct.id IS NULL THEN RETURN NEW; END IF;

    FOR r IN
      SELECT * FROM lpts_earn_rules
       WHERE account_owner_id = NEW.user_id AND active AND kind = 'job_completed' AND flat_points > 0
       ORDER BY created_at, id
    LOOP
      v_pts := least(floor(r.flat_points * v_mult)::bigint, 1000000)::integer;
      CONTINUE WHEN v_pts <= 0;
      PERFORM public._lpts_credit(v_acct.id, 'earn', v_pts, 'job', NEW.id, NULL,
        'earn:job:' || NEW.id::text || ':' || r.id::text,
        r.label, v_expires,
        jsonb_build_object('rule_id', r.id, 'rule_kind', r.kind, 'multiplier', v_mult));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'loyalty earn skipped for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lpts_invoice_paid ON invoices;
CREATE TRIGGER trg_lpts_invoice_paid
  AFTER UPDATE OF status ON invoices
  FOR EACH ROW
  WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.lpts_on_invoice_paid();

DROP TRIGGER IF EXISTS trg_lpts_invoice_paid_insert ON invoices;
CREATE TRIGGER trg_lpts_invoice_paid_insert
  AFTER INSERT ON invoices
  FOR EACH ROW
  WHEN (NEW.status = 'paid')
  EXECUTE FUNCTION public.lpts_on_invoice_paid();

DROP TRIGGER IF EXISTS trg_lpts_invoice_unpaid ON invoices;
CREATE TRIGGER trg_lpts_invoice_unpaid
  AFTER UPDATE OF status ON invoices
  FOR EACH ROW
  WHEN (OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.lpts_on_invoice_unpaid();

DROP TRIGGER IF EXISTS trg_lpts_job_completed ON jobs;
CREATE TRIGGER trg_lpts_job_completed
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW
  WHEN (NEW.job_status = 'completed' AND OLD.job_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.lpts_on_job_completed();

-- ------------------------------------------------------------------
-- Staff RPCs
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_lpts_program(
  p_enabled boolean,
  p_redeem_points_per_dollar integer,
  p_min_redeem_points integer,
  p_max_redeem_pct integer,
  p_expiry_months integer,
  p_member_multiplier numeric,
  p_earn_on_promo_invoices boolean
) RETURNS lpts_programs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row lpts_programs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to change the loyalty program' USING ERRCODE = '42501';
  END IF;
  IF p_redeem_points_per_dollar IS NULL OR p_redeem_points_per_dollar < 1 OR p_redeem_points_per_dollar > 100000 THEN
    RAISE EXCEPTION 'Points per dollar must be between 1 and 100,000';
  END IF;
  IF p_min_redeem_points IS NULL OR p_min_redeem_points < 1 THEN RAISE EXCEPTION 'Minimum redemption must be at least 1 point'; END IF;
  IF p_max_redeem_pct IS NULL OR p_max_redeem_pct < 1 OR p_max_redeem_pct > 100 THEN RAISE EXCEPTION 'Maximum share of an invoice must be 1-100%%'; END IF;
  IF p_expiry_months IS NOT NULL AND (p_expiry_months < 1 OR p_expiry_months > 120) THEN RAISE EXCEPTION 'Expiry must be 1-120 months'; END IF;
  IF p_member_multiplier IS NULL OR p_member_multiplier < 1 OR p_member_multiplier > 10 THEN RAISE EXCEPTION 'Member multiplier must be between 1 and 10'; END IF;

  INSERT INTO lpts_programs AS lp (account_owner_id, enabled, redeem_points_per_dollar, min_redeem_points, max_redeem_pct,
                                      expiry_months, member_multiplier, earn_on_promo_invoices, updated_at)
  VALUES (v_owner, coalesce(p_enabled, false), p_redeem_points_per_dollar, p_min_redeem_points, p_max_redeem_pct,
          p_expiry_months, p_member_multiplier, coalesce(p_earn_on_promo_invoices, true), now())
  ON CONFLICT (account_owner_id) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         redeem_points_per_dollar = EXCLUDED.redeem_points_per_dollar,
         min_redeem_points = EXCLUDED.min_redeem_points,
         max_redeem_pct = EXCLUDED.max_redeem_pct,
         expiry_months = EXCLUDED.expiry_months,
         member_multiplier = EXCLUDED.member_multiplier,
         earn_on_promo_invoices = EXCLUDED.earn_on_promo_invoices,
         updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_lpts_rule(
  p_id uuid,
  p_kind text,
  p_label text,
  p_points_per_dollar numeric,
  p_flat_points integer,
  p_promo_code text,
  p_min_invoice_cents integer,
  p_active boolean
) RETURNS lpts_earn_rules
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row lpts_earn_rules;
  v_promo text := nullif(upper(btrim(p_promo_code)), '');
  v_ppd numeric := coalesce(p_points_per_dollar, 0);
  v_flat integer := coalesce(p_flat_points, 0);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to change earn rules' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('invoice_paid', 'job_completed', 'promo_bonus') THEN RAISE EXCEPTION 'Invalid rule type'; END IF;
  IF nullif(btrim(p_label), '') IS NULL THEN RAISE EXCEPTION 'A rule name is required'; END IF;
  IF v_ppd < 0 OR v_ppd > 1000 THEN RAISE EXCEPTION 'Points per dollar must be between 0 and 1,000'; END IF;
  IF v_flat < 0 OR v_flat > 1000000 THEN RAISE EXCEPTION 'Bonus points must be between 0 and 1,000,000'; END IF;
  IF p_kind = 'job_completed' THEN v_ppd := 0; END IF;
  IF v_ppd = 0 AND v_flat = 0 THEN RAISE EXCEPTION 'A rule must award points per dollar or a flat bonus'; END IF;
  IF p_kind = 'promo_bonus' AND v_promo IS NULL THEN RAISE EXCEPTION 'A promo code is required for a promo bonus rule'; END IF;
  IF p_kind <> 'promo_bonus' THEN v_promo := NULL; END IF;
  IF coalesce(p_min_invoice_cents, 0) < 0 THEN RAISE EXCEPTION 'Minimum invoice cannot be negative'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO lpts_earn_rules (account_owner_id, kind, label, points_per_dollar, flat_points, promo_code, min_invoice_cents, active)
    VALUES (v_owner, p_kind, btrim(p_label), v_ppd, v_flat, v_promo, coalesce(p_min_invoice_cents, 0), coalesce(p_active, true))
    RETURNING * INTO v_row;
  ELSE
    UPDATE lpts_earn_rules
       SET kind = p_kind, label = btrim(p_label), points_per_dollar = v_ppd, flat_points = v_flat,
           promo_code = v_promo, min_invoice_cents = coalesce(p_min_invoice_cents, 0),
           active = coalesce(p_active, true), updated_at = now()
     WHERE id = p_id AND account_owner_id = v_owner
    RETURNING * INTO v_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rule not found'; END IF;
  END IF;
  RETURN v_row;
END;
$$;

-- Balance + expiry overview for one customer (sweeps expired lots first).
CREATE OR REPLACE FUNCTION public.lpts_customer_overview(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_acct lpts_accounts;
  v_soon integer;
  v_next timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to view loyalty balances' USING ERRCODE = '42501';
  END IF;
  v_acct := public._lpts_lock_account(v_owner, p_customer_id, false);
  IF v_acct.id IS NULL THEN
    RETURN jsonb_build_object('customer_id', p_customer_id, 'balance_points', 0, 'lifetime_earned', 0,
                              'lifetime_redeemed', 0, 'expiring_30d', 0, 'next_expiry', NULL);
  END IF;
  PERFORM public._lpts_sweep(v_acct.id);
  SELECT * INTO v_acct FROM lpts_accounts WHERE id = v_acct.id;
  SELECT coalesce(sum(remaining), 0)::integer, min(expires_at) INTO v_soon, v_next
    FROM lpts_lots
   WHERE account_id = v_acct.id AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() + interval '30 days';
  RETURN jsonb_build_object('customer_id', p_customer_id, 'balance_points', v_acct.balance_points,
                            'lifetime_earned', v_acct.lifetime_earned, 'lifetime_redeemed', v_acct.lifetime_redeemed,
                            'expiring_30d', v_soon, 'next_expiry', v_next);
END;
$$;

-- Everything the invoice "Pay with points" panel needs in one call.
CREATE OR REPLACE FUNCTION public.lpts_invoice_context(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_prog lpts_programs;
  v_inv invoices%ROWTYPE;
  v_cust uuid;
  v_name text;
  v_acct lpts_accounts;
  v_total bigint;
  v_net bigint;
  v_remaining bigint;
  v_already bigint;
  v_cap bigint;
  v_max_cents bigint;
  v_max_points integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  SELECT * INTO v_prog FROM lpts_programs WHERE account_owner_id = v_owner;
  IF NOT FOUND OR NOT v_prog.enabled THEN RETURN jsonb_build_object('enabled', false); END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  v_cust := public._lpts_resolve_customer(v_owner, to_jsonb(v_inv) ->> 'customer_id', v_inv.customer_email, v_inv.customer_phone, v_inv.customer_name);
  IF v_cust IS NULL THEN RETURN jsonb_build_object('enabled', true, 'customer_id', NULL, 'balance_points', 0); END IF;
  SELECT c.name INTO v_name FROM customers c WHERE c.id = v_cust;

  v_acct := public._lpts_lock_account(v_owner, v_cust, false);
  IF v_acct.id IS NOT NULL THEN
    PERFORM public._lpts_sweep(v_acct.id);
    SELECT * INTO v_acct FROM lpts_accounts WHERE id = v_acct.id;
  END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  SELECT coalesce((SELECT sum(amount_cents) FROM invoice_payments WHERE invoice_id = p_invoice_id), 0)
       - coalesce((SELECT sum(amount_cents) FROM invoice_refunds WHERE invoice_id = p_invoice_id), 0) INTO v_net;
  v_remaining := greatest(v_total - v_net, 0);
  SELECT coalesce(sum((meta ->> 'applied_cents')::bigint), 0) INTO v_already
    FROM lpts_ledger WHERE invoice_id = p_invoice_id AND kind = 'redeem';
  v_cap := greatest((v_total * v_prog.max_redeem_pct) / 100 - v_already, 0);
  v_max_cents := CASE WHEN v_inv.status IN ('paid', 'void') THEN 0 ELSE least(v_remaining, v_cap) END;
  v_max_points := least(coalesce(v_acct.balance_points, 0), ((v_max_cents * v_prog.redeem_points_per_dollar + 99) / 100)::integer);

  RETURN jsonb_build_object(
    'enabled', true,
    'customer_id', v_cust,
    'customer_name', v_name,
    'balance_points', coalesce(v_acct.balance_points, 0),
    'remaining_due_cents', v_remaining,
    'max_redeem_cents', v_max_cents,
    'max_redeem_points', v_max_points,
    'redeem_points_per_dollar', v_prog.redeem_points_per_dollar,
    'min_redeem_points', v_prog.min_redeem_points,
    'max_redeem_pct', v_prog.max_redeem_pct
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_lpts_points(
  p_customer_id uuid,
  p_invoice_id uuid,
  p_points integer,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_prog lpts_programs;
  v_inv invoices%ROWTYPE;
  v_existing lpts_ledger;
  v_acct lpts_accounts;
  v_resolved uuid;
  v_total bigint;
  v_net bigint;
  v_remaining bigint;
  v_already bigint;
  v_cap bigint;
  v_cents bigint;
  v_used integer;
  v_after bigint;
  v_balance integer;
  v_ledger uuid := gen_random_uuid();
  v_meta jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.invoice_permission('can_view_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_points IS NULL OR p_points <= 0 THEN RAISE EXCEPTION 'Enter the number of points to redeem'; END IF;

  -- Replay of an already-applied request: return the first result, apply nothing.
  IF v_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM lpts_ledger WHERE account_owner_id = v_owner AND idempotency_key = v_key;
    IF FOUND THEN
      IF v_existing.kind <> 'redeem' OR v_existing.invoice_id IS DISTINCT FROM p_invoice_id THEN
        RAISE EXCEPTION 'This request key was already used for a different action';
      END IF;
      RETURN v_existing.meta || jsonb_build_object('duplicate', true);
    END IF;
  END IF;

  SELECT * INTO v_prog FROM lpts_programs WHERE account_owner_id = v_owner;
  IF NOT FOUND OR NOT v_prog.enabled THEN RAISE EXCEPTION 'The loyalty program is not enabled'; END IF;
  IF p_points < v_prog.min_redeem_points THEN
    RAISE EXCEPTION 'The minimum redemption is % points', v_prog.min_redeem_points;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status = 'void' THEN RAISE EXCEPTION 'This invoice is void'; END IF;
  IF v_inv.status = 'paid' THEN RAISE EXCEPTION 'This invoice is already paid'; END IF;

  v_resolved := public._lpts_resolve_customer(v_owner, to_jsonb(v_inv) ->> 'customer_id', v_inv.customer_email, v_inv.customer_phone, v_inv.customer_name);
  IF v_resolved IS NULL OR v_resolved <> p_customer_id THEN
    RAISE EXCEPTION 'This invoice does not belong to that customer';
  END IF;

  v_acct := public._lpts_lock_account(v_owner, p_customer_id, false);
  IF v_acct.id IS NULL THEN RAISE EXCEPTION 'This customer has no points yet'; END IF;
  PERFORM public._lpts_sweep(v_acct.id);
  SELECT * INTO v_acct FROM lpts_accounts WHERE id = v_acct.id;
  IF p_points > v_acct.balance_points THEN RAISE EXCEPTION 'Not enough points: balance is % points', v_acct.balance_points; END IF;

  v_total := public.invoice_total_cents(v_inv.line_items, v_inv.tax_percent);
  SELECT coalesce((SELECT sum(amount_cents) FROM invoice_payments WHERE invoice_id = p_invoice_id), 0)
       - coalesce((SELECT sum(amount_cents) FROM invoice_refunds WHERE invoice_id = p_invoice_id), 0) INTO v_net;
  v_remaining := v_total - v_net;
  IF v_remaining <= 0 THEN RAISE EXCEPTION 'Nothing is left to pay on this invoice'; END IF;

  SELECT coalesce(sum((meta ->> 'applied_cents')::bigint), 0) INTO v_already
    FROM lpts_ledger WHERE invoice_id = p_invoice_id AND kind = 'redeem';
  v_cap := (v_total * v_prog.max_redeem_pct) / 100 - v_already;
  IF v_cap <= 0 THEN RAISE EXCEPTION 'The points limit for this invoice has been reached'; END IF;

  v_cents := least((p_points::bigint * 100) / v_prog.redeem_points_per_dollar, v_remaining, v_cap);
  IF v_cents <= 0 THEN RAISE EXCEPTION 'Those points are worth less than one cent'; END IF;
  v_used := ((v_cents * v_prog.redeem_points_per_dollar + 99) / 100)::integer;
  IF v_used > p_points OR v_used > v_acct.balance_points THEN RAISE EXCEPTION 'Not enough points'; END IF;

  PERFORM public._lpts_consume(v_acct.id, v_used);
  v_balance := v_acct.balance_points - v_used;
  v_after := v_remaining - v_cents;
  v_meta := jsonb_build_object('applied_points', v_used, 'applied_cents', v_cents, 'balance_points', v_balance,
                               'remaining_due_cents', v_after, 'invoice_paid', v_after = 0, 'duplicate', false);

  INSERT INTO lpts_ledger (id, account_owner_id, account_id, customer_id, kind, points, balance_after,
                              source_type, source_id, invoice_id, idempotency_key, note, meta)
  VALUES (v_ledger, v_owner, v_acct.id, p_customer_id, 'redeem', -v_used, v_balance,
          'invoice', p_invoice_id, p_invoice_id, v_key, 'Redeemed on ' || coalesce(v_inv.invoice_number, 'invoice'), v_meta);

  UPDATE lpts_accounts
     SET balance_points = v_balance, lifetime_redeemed = lifetime_redeemed + v_used, updated_at = now()
   WHERE id = v_acct.id;

  INSERT INTO invoice_payments (user_id, invoice_id, amount_cents, method, reference, note, paid_at, created_by_email)
  VALUES (v_owner, p_invoice_id, v_cents, 'other', 'loyalty:' || v_ledger::text,
          'Loyalty points redemption (' || v_used::text || ' pts)', now(),
          (SELECT email FROM auth.users WHERE id = auth.uid()));
  PERFORM public._invoice_recalc(p_invoice_id);

  BEGIN
    PERFORM public._invoice_audit(v_owner, 'invoice_lpts_redeemed', p_invoice_id,
      jsonb_build_object('ledger_id', v_ledger, 'points', v_used, 'amount_cents', v_cents));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'loyalty audit entry skipped for invoice %: %', p_invoice_id, SQLERRM;
  END;

  RETURN v_meta;
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_lpts_points(
  p_customer_id uuid,
  p_points integer,
  p_note text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_prog lpts_programs;
  v_acct lpts_accounts;
  v_existing lpts_ledger;
  v_expires timestamptz;
  v_balance integer;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to adjust points' USING ERRCODE = '42501';
  END IF;
  IF p_points IS NULL OR p_points = 0 OR abs(p_points) > 1000000 THEN RAISE EXCEPTION 'Adjustment must be between 1 and 1,000,000 points'; END IF;
  IF nullif(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = v_owner) THEN RAISE EXCEPTION 'Customer not found'; END IF;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM lpts_ledger WHERE account_owner_id = v_owner AND idempotency_key = v_key;
    IF FOUND THEN RETURN jsonb_build_object('balance_points', v_existing.balance_after, 'duplicate', true); END IF;
  END IF;

  SELECT * INTO v_prog FROM lpts_programs WHERE account_owner_id = v_owner;
  v_expires := CASE WHEN FOUND AND v_prog.expiry_months IS NOT NULL THEN now() + make_interval(months => v_prog.expiry_months) ELSE NULL END;

  v_acct := public._lpts_lock_account(v_owner, p_customer_id, true);
  PERFORM public._lpts_sweep(v_acct.id);
  SELECT * INTO v_acct FROM lpts_accounts WHERE id = v_acct.id;

  IF p_points > 0 THEN
    v_id := public._lpts_credit(v_acct.id, 'adjust', p_points, 'manual', NULL, NULL, v_key, btrim(p_note), v_expires, '{}'::jsonb);
    IF v_id IS NULL THEN RAISE EXCEPTION 'This request was already applied'; END IF;
    v_balance := v_acct.balance_points + p_points;
  ELSE
    IF v_acct.balance_points + p_points < 0 THEN RAISE EXCEPTION 'Balance cannot go below zero'; END IF;
    PERFORM public._lpts_consume(v_acct.id, -p_points);
    v_balance := v_acct.balance_points + p_points;
    INSERT INTO lpts_ledger (account_owner_id, account_id, customer_id, kind, points, balance_after, source_type, idempotency_key, note)
    VALUES (v_owner, v_acct.id, p_customer_id, 'adjust', p_points, v_balance, 'manual', v_key, btrim(p_note));
    UPDATE lpts_accounts SET balance_points = v_balance, updated_at = now() WHERE id = v_acct.id;
  END IF;
  RETURN jsonb_build_object('balance_points', v_balance, 'duplicate', false);
END;
$$;

-- Scheduled sweep for every account (also callable by service role). Not granted to clients.
CREATE OR REPLACE FUNCTION public.lpts_expire_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT account_id FROM lpts_lots WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now()
  LOOP
    PERFORM 1 FROM lpts_accounts WHERE id = r.account_id FOR UPDATE;
    v_total := v_total + public._lpts_sweep(r.account_id);
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.lpts_on_invoice_paid() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lpts_on_invoice_unpaid() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lpts_on_job_completed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lpts_expire_due() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_lpts_program(boolean, integer, integer, integer, integer, numeric, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_lpts_rule(uuid, text, text, numeric, integer, text, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lpts_customer_overview(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lpts_invoice_context(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_lpts_points(uuid, uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adjust_lpts_points(uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_lpts_program(boolean, integer, integer, integer, integer, numeric, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_lpts_rule(uuid, text, text, numeric, integer, text, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lpts_customer_overview(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lpts_invoice_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_lpts_points(uuid, uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_lpts_points(uuid, integer, text, text) TO authenticated;

-- Nightly expiry sweep when pg_cron is installed (skipped silently otherwise).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('lpts-expire-due', '15 3 * * *', 'SELECT public.lpts_expire_due()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule for loyalty expiry skipped: %', SQLERRM;
END;
$$;
