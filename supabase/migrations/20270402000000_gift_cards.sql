/*
  # Gift cards & store credit

  - gift_cards: coded, expiring stored-value instruments (gift_card | store_credit)
  - gift_card_transactions: append-only balance ledger (issue / redeem / adjust / void)
  - Scoped by account_owner_id = get_account_owner_id() (team members share the owner's data)
  - Reads need the billing permission (identity_is_manager()); clients have NO direct write access —
    every mutation goes through a SECURITY DEFINER RPC that locks the row, validates and writes
    card + ledger (+ invoice) atomically, so balances can't be tampered with from the browser.
  - Expiry is derived from expires_at (no cron needed); stored status is active | depleted | voided.
*/

CREATE TABLE IF NOT EXISTS gift_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  code text NOT NULL,
  kind text NOT NULL DEFAULT 'gift_card' CHECK (kind IN ('gift_card', 'store_credit')),
  initial_cents integer NOT NULL CHECK (initial_cents > 0 AND initial_cents <= 10000000),
  balance_cents integer NOT NULL CHECK (balance_cents >= 0 AND balance_cents <= 10000000),
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted', 'voided')),
  recipient_name text,
  recipient_email text,
  note text,
  expires_at timestamptz,
  issued_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_owner ON gift_cards(account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_cards_owner_status ON gift_cards(account_owner_id, status);

CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  gift_card_id uuid NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('issue', 'redeem', 'adjust', 'void')),
  amount_cents integer NOT NULL,            -- signed: redeem/void are negative
  balance_after_cents integer NOT NULL CHECK (balance_after_cents >= 0),
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  note text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gct_card ON gift_card_transactions(gift_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gct_invoice ON gift_card_transactions(invoice_id) WHERE invoice_id IS NOT NULL;

ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_card_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_gift_cards" ON gift_cards;
CREATE POLICY "select_gift_cards" ON gift_cards FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "select_gift_card_transactions" ON gift_card_transactions;
CREATE POLICY "select_gift_card_transactions" ON gift_card_transactions FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());

-- Read-only for clients; writes only via the RPCs below.
REVOKE ALL ON gift_cards, gift_card_transactions FROM anon, authenticated;
GRANT SELECT ON gift_cards, gift_card_transactions TO authenticated;

-- ------------------------------------------------------------------
-- Code generator: 12 chars from an unambiguous 31-char alphabet (no I/L/O/0/1),
-- drawn from CSPRNG-backed gen_random_uuid() bytes (skipping version/variant bytes 6 and 8).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_gift_card_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  idx constant int[] := ARRAY[0,1,2,3,4,5,7,9,10,11,12,13];
  raw bytea := uuid_send(gen_random_uuid());
  result text := '';
  i int;
BEGIN
  FOR i IN 1..12 LOOP
    result := result || substr(alphabet, (get_byte(raw, idx[i]) % 31) + 1, 1);
    IF i IN (4, 8) THEN result := result || '-'; END IF;
  END LOOP;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.generate_gift_card_code() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- issue_gift_card
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_gift_card(
  p_kind text,
  p_amount_cents integer,
  p_recipient_name text DEFAULT NULL,
  p_recipient_email text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS gift_cards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_card gift_cards;
  v_try int := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to issue gift cards' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('gift_card', 'store_credit') THEN
    RAISE EXCEPTION 'Invalid card type';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 10000000 THEN
    RAISE EXCEPTION 'Amount must be between $0.01 and $100,000';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Expiry date must be in the future';
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      INSERT INTO gift_cards (account_owner_id, code, kind, initial_cents, balance_cents,
                              recipient_name, recipient_email, note, expires_at)
      VALUES (v_owner, public.generate_gift_card_code(), p_kind, p_amount_cents, p_amount_cents,
              nullif(btrim(p_recipient_name), ''), nullif(btrim(p_recipient_email), ''),
              nullif(btrim(p_note), ''), p_expires_at)
      RETURNING * INTO v_card;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try >= 5 THEN RAISE EXCEPTION 'Could not generate a unique code, please retry'; END IF;
    END;
  END LOOP;

  INSERT INTO gift_card_transactions (account_owner_id, gift_card_id, kind, amount_cents, balance_after_cents, note)
  VALUES (v_owner, v_card.id, 'issue', p_amount_cents, p_amount_cents, v_card.note);

  RETURN v_card;
END;
$$;

-- ------------------------------------------------------------------
-- redeem_gift_card — optionally against an invoice; marks it paid when fully covered
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_gift_card(
  p_code text,
  p_invoice_id uuid DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_norm text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_card gift_cards;
  v_inv invoices;
  v_sub numeric;
  v_total integer;
  v_done integer;
  v_remaining integer := NULL;
  v_apply integer;
  v_new_balance integer;
  v_paid boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to redeem gift cards' USING ERRCODE = '42501';
  END IF;
  IF length(v_norm) <> 12 THEN
    RAISE EXCEPTION 'Gift card not found';
  END IF;

  SELECT * INTO v_card FROM gift_cards
   WHERE account_owner_id = v_owner
     AND code = substr(v_norm, 1, 4) || '-' || substr(v_norm, 5, 4) || '-' || substr(v_norm, 9, 4)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gift card not found'; END IF;
  IF v_card.status = 'voided' THEN RAISE EXCEPTION 'This card has been voided'; END IF;
  IF v_card.expires_at IS NOT NULL AND v_card.expires_at <= now() THEN RAISE EXCEPTION 'This card has expired'; END IF;
  IF v_card.status = 'depleted' OR v_card.balance_cents <= 0 THEN RAISE EXCEPTION 'This card has no remaining balance'; END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF v_inv.status IN ('paid', 'void') THEN RAISE EXCEPTION 'This invoice is already %', v_inv.status; END IF;

    SELECT coalesce(sum((li ->> 'quantity')::numeric * (li ->> 'unit_price_cents')::numeric), 0) INTO v_sub
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_inv.line_items) = 'array' THEN v_inv.line_items ELSE '[]'::jsonb END) li;
    v_total := (v_sub + round(v_sub * coalesce(v_inv.tax_percent, 0) / 100))::integer;

    SELECT coalesce(sum(-amount_cents), 0) INTO v_done
      FROM gift_card_transactions WHERE invoice_id = p_invoice_id AND kind = 'redeem';
    v_remaining := greatest(v_total - v_done, 0);
    IF v_remaining = 0 THEN RAISE EXCEPTION 'This invoice is already fully covered'; END IF;

    v_apply := coalesce(p_amount_cents, least(v_card.balance_cents, v_remaining));
    IF v_apply > v_remaining THEN RAISE EXCEPTION 'Amount exceeds what is still owed on this invoice'; END IF;
  ELSE
    IF p_amount_cents IS NULL THEN RAISE EXCEPTION 'Enter an amount to redeem'; END IF;
    v_apply := p_amount_cents;
  END IF;

  IF v_apply <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  IF v_apply > v_card.balance_cents THEN RAISE EXCEPTION 'Amount exceeds the card balance'; END IF;

  v_new_balance := v_card.balance_cents - v_apply;
  UPDATE gift_cards
     SET balance_cents = v_new_balance,
         status = CASE WHEN v_new_balance = 0 THEN 'depleted' ELSE status END,
         updated_at = now()
   WHERE id = v_card.id;

  INSERT INTO gift_card_transactions (account_owner_id, gift_card_id, kind, amount_cents, balance_after_cents, invoice_id)
  VALUES (v_owner, v_card.id, 'redeem', -v_apply, v_new_balance, p_invoice_id);

  IF p_invoice_id IS NOT NULL THEN
    v_remaining := v_remaining - v_apply;
    IF v_remaining = 0 THEN
      UPDATE invoices SET status = 'paid', paid_at = now(), payment_method = 'gift_card', updated_at = now()
       WHERE id = p_invoice_id;
      v_paid := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'applied_cents', v_apply,
    'balance_cents', v_new_balance,
    'invoice_paid', v_paid,
    'remaining_due_cents', v_remaining
  );
END;
$$;

-- ------------------------------------------------------------------
-- adjust_gift_card — top-up or correction (note required for the audit trail)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_gift_card(p_card_id uuid, p_delta_cents integer, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_card gift_cards;
  v_new integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to adjust gift cards' USING ERRCODE = '42501';
  END IF;
  IF p_delta_cents IS NULL OR p_delta_cents = 0 THEN RAISE EXCEPTION 'Adjustment cannot be zero'; END IF;
  IF nullif(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;

  SELECT * INTO v_card FROM gift_cards WHERE id = p_card_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gift card not found'; END IF;
  IF v_card.status = 'voided' THEN RAISE EXCEPTION 'A voided card cannot be adjusted'; END IF;

  v_new := v_card.balance_cents + p_delta_cents;
  IF v_new < 0 THEN RAISE EXCEPTION 'Balance cannot go below zero'; END IF;
  IF v_new > 10000000 THEN RAISE EXCEPTION 'Balance cannot exceed $100,000'; END IF;

  UPDATE gift_cards
     SET balance_cents = v_new,
         status = CASE WHEN v_new = 0 THEN 'depleted' ELSE 'active' END,
         updated_at = now()
   WHERE id = v_card.id;

  INSERT INTO gift_card_transactions (account_owner_id, gift_card_id, kind, amount_cents, balance_after_cents, note)
  VALUES (v_owner, v_card.id, 'adjust', p_delta_cents, v_new, btrim(p_note));
END;
$$;

-- ------------------------------------------------------------------
-- void_gift_card — zeroes the balance, keeps the history
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_gift_card(p_card_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_card gift_cards;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'You do not have permission to void gift cards' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_card FROM gift_cards WHERE id = p_card_id AND account_owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gift card not found'; END IF;
  IF v_card.status = 'voided' THEN RAISE EXCEPTION 'This card is already voided'; END IF;

  UPDATE gift_cards SET status = 'voided', balance_cents = 0, updated_at = now() WHERE id = v_card.id;

  INSERT INTO gift_card_transactions (account_owner_id, gift_card_id, kind, amount_cents, balance_after_cents, note)
  VALUES (v_owner, v_card.id, 'void', -v_card.balance_cents, 0, nullif(btrim(p_reason), ''));
END;
$$;

REVOKE ALL ON FUNCTION public.issue_gift_card(text, integer, text, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_gift_card(text, uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.adjust_gift_card(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_gift_card(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_gift_card(text, integer, text, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_gift_card(text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_gift_card(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_gift_card(uuid, text) TO authenticated;
