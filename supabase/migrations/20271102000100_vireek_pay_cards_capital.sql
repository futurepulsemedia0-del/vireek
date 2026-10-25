/*
  # Vireek Pay — spend cards + Vireek Capital (receivables-based working capital)

  Depends on 20271102000000_vireek_pay_core.sql (controls, disclosures, helpers).

  ## Spend cards
  Cards are issued by a licensed issuer/program manager; Vireek stores policy + ledger only
  (never a PAN/CVV). Authorization decisions are made by the tested policy engine
  (_shared/pay/cardPolicy.ts) and recorded in card_transactions.

  ## Capital
  Vireek NEVER decides credit. It (1) computes an indicative pre-screen from real paid /
  outstanding invoice data to decide whether to SEND an application, (2) pledges the chosen
  receivables so they cannot be double-submitted, (3) stores the partner's offers verbatim.
  capital_offers cannot be inserted without the disclosure fields (total repayment, finance
  charge, term, estimated APR) — an offer that cannot be disclosed cannot be shown.
*/

-- =============================================================
-- 1. SPEND CARDS
-- =============================================================

CREATE TABLE IF NOT EXISTS spend_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  holder_name text NOT NULL CHECK (char_length(btrim(holder_name)) BETWEEN 1 AND 120),
  provider text NOT NULL,
  external_card_id text NOT NULL,
  card_type text NOT NULL DEFAULT 'virtual' CHECK (card_type IN ('virtual', 'physical')),
  brand text,
  last4 text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'frozen', 'canceled')),
  per_txn_limit_cents bigint NOT NULL CHECK (per_txn_limit_cents > 0),
  daily_limit_cents bigint NOT NULL CHECK (daily_limit_cents >= per_txn_limit_cents),
  monthly_limit_cents bigint NOT NULL CHECK (monthly_limit_cents >= daily_limit_cents),
  allowed_mcc text[],
  blocked_mcc text[] NOT NULL DEFAULT '{}',
  receipt_required_over_cents bigint NOT NULL DEFAULT 2500 CHECK (receipt_required_over_cents >= 0),
  sandbox boolean NOT NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_card_id)
);
CREATE INDEX IF NOT EXISTS idx_spend_cards_user ON spend_cards(user_id, status);
CREATE INDEX IF NOT EXISTS idx_spend_cards_member ON spend_cards(team_member_id);

CREATE TABLE IF NOT EXISTS card_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  card_id uuid NOT NULL REFERENCES spend_cards(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  external_auth_id text NOT NULL,
  kind text NOT NULL DEFAULT 'authorization' CHECK (kind IN ('authorization', 'capture', 'refund', 'reversal')),
  status text NOT NULL CHECK (status IN ('approved', 'declined', 'settled', 'reversed')),
  decline_code text,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  merchant_name text CHECK (merchant_name IS NULL OR char_length(merchant_name) <= 200),
  mcc text CHECK (mcc IS NULL OR mcc ~ '^[0-9]{4}$'),
  memo text CHECK (memo IS NULL OR char_length(memo) <= 500),
  receipt_path text,
  sandbox boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, external_auth_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_card_txn_card_created ON card_transactions(card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_txn_user_created ON card_transactions(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trigger_spend_cards_updated_at ON spend_cards;
CREATE TRIGGER trigger_spend_cards_updated_at BEFORE UPDATE ON spend_cards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_card_transactions_updated_at ON card_transactions;
CREATE TRIGGER trigger_card_transactions_updated_at BEFORE UPDATE ON card_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE spend_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON spend_cards, card_transactions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON spend_cards, card_transactions FROM authenticated;

DROP POLICY IF EXISTS "read_spend_cards" ON spend_cards;
CREATE POLICY "read_spend_cards" ON spend_cards FOR SELECT TO authenticated
  USING (team_member_id = public.get_my_team_member_id()
         OR (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage()));

DROP POLICY IF EXISTS "read_card_transactions" ON card_transactions;
CREATE POLICY "read_card_transactions" ON card_transactions FOR SELECT TO authenticated
  USING ((user_id = public.get_account_owner_id() AND public.tech_pay_can_manage())
         OR EXISTS (SELECT 1 FROM spend_cards c WHERE c.id = card_id AND c.team_member_id = public.get_my_team_member_id()));

-- Holder (or manager) may annotate a transaction: memo, receipt, job. Nothing else.
CREATE OR REPLACE FUNCTION public.card_update_transaction_meta(
  p_txn_id uuid, p_memo text, p_receipt_path text, p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  t card_transactions%ROWTYPE;
BEGIN
  SELECT x.* INTO t FROM card_transactions x
    JOIN spend_cards c ON c.id = x.card_id
   WHERE x.id = p_txn_id AND x.user_id = v_owner
     AND (public.tech_pay_can_manage() OR c.team_member_id = public.get_my_team_member_id());
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF p_receipt_path IS NOT NULL AND split_part(p_receipt_path, '/', 1) <> v_owner::text THEN
    RETURN jsonb_build_object('status', 'invalid_receipt_path');
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = p_job_id AND user_id = v_owner) THEN
    RETURN jsonb_build_object('status', 'job_not_found');
  END IF;
  UPDATE card_transactions
     SET memo = COALESCE(left(NULLIF(btrim(p_memo), ''), 500), memo),
         receipt_path = COALESCE(p_receipt_path, receipt_path),
         job_id = COALESCE(p_job_id, job_id)
   WHERE id = t.id;
  RETURN jsonb_build_object('status', 'updated');
END;
$$;

-- Private receipt bucket; first path segment must be the account owner id.
INSERT INTO storage.buckets (id, name, public) VALUES ('card-receipts', 'card-receipts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "card_receipts_insert" ON storage.objects;
CREATE POLICY "card_receipts_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'card-receipts' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);
DROP POLICY IF EXISTS "card_receipts_select" ON storage.objects;
CREATE POLICY "card_receipts_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'card-receipts' AND (storage.foldername(name))[1] = public.get_account_owner_id()::text);

-- Spend totals the policy engine needs (service role). Settled + still-approved authorizations count.
CREATE OR REPLACE FUNCTION public.pay_card_spend_totals(p_card_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'today_cents', COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('day', now())), 0),
    'month_cents', COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('month', now())), 0)
  )
  FROM card_transactions
  WHERE card_id = p_card_id AND kind IN ('authorization', 'capture') AND status IN ('approved', 'settled')
    AND created_at >= date_trunc('month', now());
$$;

-- =============================================================
-- 2. CAPITAL
-- =============================================================

CREATE TABLE IF NOT EXISTS capital_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prescreened' CHECK (status IN (
    'prescreen_not_eligible', 'prescreened', 'submitted', 'offered', 'accepted', 'funded',
    'declined_by_partner', 'withdrawn', 'expired', 'error')),
  provider text NOT NULL,
  sandbox boolean NOT NULL,
  external_application_id text,
  requested_amount_cents bigint CHECK (requested_amount_cents IS NULL OR requested_amount_cents > 0),
  prescreen jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_package_sha256 text,
  disclosure_prescreen_version integer,
  disclosure_application_version integer,
  submitted_by uuid,
  submitted_at timestamptz,
  decline_reasons jsonb,
  failure_code text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_application_id)
);
CREATE INDEX IF NOT EXISTS idx_capital_apps_user ON capital_applications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS capital_application_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES capital_applications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  face_amount_cents bigint NOT NULL CHECK (face_amount_cents > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A receivable can be pledged to at most ONE live application at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_capital_receivable_active ON capital_application_receivables(invoice_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_capital_recv_app ON capital_application_receivables(application_id);

CREATE TABLE IF NOT EXISTS capital_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES capital_applications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  sandbox boolean NOT NULL,
  external_offer_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'expired', 'withdrawn')),
  offered_amount_cents bigint NOT NULL CHECK (offered_amount_cents > 0),
  -- Mandatory disclosure fields: set by the PARTNER, stored verbatim, never computed by Vireek.
  total_repayment_cents bigint NOT NULL CHECK (total_repayment_cents >= offered_amount_cents),
  finance_charge_cents bigint NOT NULL CHECK (finance_charge_cents >= 0),
  term_days integer NOT NULL CHECK (term_days > 0),
  estimated_apr_bps integer NOT NULL CHECK (estimated_apr_bps >= 0),
  repayment_description text NOT NULL CHECK (char_length(btrim(repayment_description)) >= 10),
  terms_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_repayment_cents - offered_amount_cents = finance_charge_cents),
  UNIQUE (provider, external_offer_id)
);
CREATE INDEX IF NOT EXISTS idx_capital_offers_app ON capital_offers(application_id);

CREATE TABLE IF NOT EXISTS capital_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES capital_applications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_capital_events_app ON capital_events(application_id, id);

DROP TRIGGER IF EXISTS trigger_capital_apps_updated_at ON capital_applications;
CREATE TRIGGER trigger_capital_apps_updated_at BEFORE UPDATE ON capital_applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trigger_capital_offers_updated_at ON capital_offers;
CREATE TRIGGER trigger_capital_offers_updated_at BEFORE UPDATE ON capital_offers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Releasing receivables when an application ends without funding (atomic, cannot be forgotten).
CREATE OR REPLACE FUNCTION public.capital_release_receivables()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('prescreen_not_eligible', 'declined_by_partner', 'withdrawn', 'expired', 'error')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE capital_application_receivables SET active = false WHERE application_id = NEW.id AND active;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capital_release_receivables ON capital_applications;
CREATE TRIGGER trg_capital_release_receivables AFTER UPDATE OF status ON capital_applications
  FOR EACH ROW EXECUTE FUNCTION public.capital_release_receivables();

ALTER TABLE capital_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE capital_application_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE capital_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE capital_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON capital_applications, capital_application_receivables, capital_offers, capital_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON capital_applications, capital_application_receivables, capital_offers, capital_events FROM authenticated;

DROP POLICY IF EXISTS "managers_read_capital_apps" ON capital_applications;
CREATE POLICY "managers_read_capital_apps" ON capital_applications FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());
DROP POLICY IF EXISTS "managers_read_capital_recv" ON capital_application_receivables;
CREATE POLICY "managers_read_capital_recv" ON capital_application_receivables FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());
DROP POLICY IF EXISTS "managers_read_capital_offers" ON capital_offers;
CREATE POLICY "managers_read_capital_offers" ON capital_offers FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());
DROP POLICY IF EXISTS "managers_read_capital_events" ON capital_events;
CREATE POLICY "managers_read_capital_events" ON capital_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.tech_pay_can_manage());

-- =============================================================
-- 3. REAL REVENUE PROFILE (service role) — the ONLY input to the pre-screen
-- =============================================================
-- Revenue = paid invoices (+ paid payment requests whose job has no paid invoice, so a job
-- paid through both paths is counted once). Money is integer cents. Nothing is estimated.

CREATE OR REPLACE FUNCTION public.capital_get_revenue_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH inv AS (
    SELECT i.id, i.job_id, lower(btrim(i.customer_name)) AS customer, i.status, i.due_date, i.sent_at, i.paid_at, i.created_at,
           public.portal_invoice_total_cents(i.line_items, i.tax_percent) AS total_cents
      FROM invoices i WHERE i.user_id = p_user_id AND i.status <> 'void'
  ),
  paid_inv AS (SELECT * FROM inv WHERE status = 'paid' AND paid_at IS NOT NULL AND COALESCE(total_cents, 0) > 0),
  paid_pr AS (
    SELECT p.id, p.job_id, lower(btrim(p.customer_name)) AS customer, p.paid_at, round(p.amount * 100)::bigint AS total_cents
      FROM payment_requests p
     WHERE p.user_id = p_user_id AND p.status = 'paid' AND p.paid_at IS NOT NULL AND p.amount > 0
       AND NOT EXISTS (SELECT 1 FROM paid_inv x WHERE x.job_id IS NOT NULL AND x.job_id = p.job_id)
  ),
  revenue AS (
    SELECT paid_at, total_cents, customer FROM paid_inv
    UNION ALL SELECT paid_at, total_cents, customer FROM paid_pr
  ),
  r12 AS (SELECT * FROM revenue WHERE paid_at >= now() - interval '12 months'),
  months AS (
    SELECT m::date AS month_start,
           COALESCE((SELECT SUM(total_cents) FROM revenue r WHERE date_trunc('month', r.paid_at) = m), 0)::bigint AS cents
      FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
  ),
  cust AS (SELECT customer, SUM(total_cents) AS c FROM r12 GROUP BY customer),
  open_recv AS (
    SELECT i.id, i.customer, i.total_cents, i.due_date, COALESCE(i.sent_at, i.created_at) AS issued_at,
           EXISTS (SELECT 1 FROM capital_application_receivables cr WHERE cr.invoice_id = i.id AND cr.active) AS pledged
      FROM inv i WHERE i.status IN ('sent', 'viewed') AND COALESCE(i.total_cents, 0) > 0
     ORDER BY i.total_cents DESC LIMIT 200
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'sources', jsonb_build_array('invoices', 'payment_requests', 'stripe_disputes'),
    'first_revenue_at', (SELECT min(paid_at) FROM revenue),
    'months_of_history', COALESCE((SELECT floor(extract(epoch FROM (now() - min(paid_at))) / 2629800)::int FROM revenue), 0),
    'trailing_12m_cents', COALESCE((SELECT SUM(total_cents) FROM r12), 0),
    'trailing_3m_cents', COALESCE((SELECT SUM(total_cents) FROM revenue WHERE paid_at >= now() - interval '3 months'), 0),
    'monthly_cents', (SELECT jsonb_agg(cents ORDER BY month_start) FROM months),
    'paid_invoice_count_12m', (SELECT count(*) FROM paid_inv WHERE paid_at >= now() - interval '12 months'),
    'avg_days_to_pay', (SELECT round((avg(extract(epoch FROM (paid_at - COALESCE(sent_at, created_at))) / 86400.0))::numeric, 1)
                          FROM paid_inv WHERE paid_at >= now() - interval '12 months'),
    'on_time_rate', (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE round((count(*) FILTER (WHERE paid_at::date <= due_date))::numeric / count(*), 4) END
                       FROM paid_inv WHERE due_date IS NOT NULL AND paid_at >= now() - interval '12 months'),
    'top_customer_share_pct', (SELECT CASE WHEN COALESCE(SUM(c), 0) = 0 THEN 0 ELSE round(max(c)::numeric * 100 / SUM(c), 1) END FROM cust),
    'lost_disputes_12m', (SELECT count(*) FROM stripe_disputes d WHERE d.user_id = p_user_id AND d.status = 'lost' AND d.opened_at >= now() - interval '12 months'),
    'open_disputes', (SELECT count(*) FROM stripe_disputes d WHERE d.user_id = p_user_id
                       AND d.status IN ('needs_response', 'under_review', 'warning_needs_response', 'warning_under_review')),
    'open_receivables', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'invoice_id', id,
        'customer_ref', encode(sha256(convert_to(p_user_id::text || ':' || COALESCE(customer, ''), 'UTF8')), 'hex'),
        'amount_cents', total_cents,
        'due_date', due_date,
        'issued_at', issued_at,
        'already_pledged', pledged)) FROM open_recv), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Edge-function helper: pledge receivables to an application (all-or-nothing; unique index guards races).
CREATE OR REPLACE FUNCTION public.capital_pledge_receivables(p_application_id uuid, p_user_id uuid, p_invoice_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO capital_application_receivables (application_id, user_id, invoice_id, face_amount_cents)
  SELECT p_application_id, p_user_id, i.id, public.portal_invoice_total_cents(i.line_items, i.tax_percent)
    FROM invoices i
   WHERE i.user_id = p_user_id AND i.id = ANY (p_invoice_ids) AND i.status IN ('sent', 'viewed')
     AND COALESCE(public.portal_invoice_total_cents(i.line_items, i.tax_percent), 0) > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> COALESCE(array_length(p_invoice_ids, 1), 0) THEN
    RAISE EXCEPTION 'receivable_not_eligible' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('status', 'pledged', 'count', v_n);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'receivable_already_pledged' USING ERRCODE = '23505';
END;
$$;

-- =============================================================
-- 4. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.pay_card_spend_totals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capital_get_revenue_profile(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capital_pledge_receivables(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capital_release_receivables() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_card_spend_totals(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.capital_get_revenue_profile(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.capital_pledge_receivables(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.card_update_transaction_meta(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.card_update_transaction_meta(uuid, text, text, uuid) TO authenticated;

COMMENT ON TABLE capital_offers IS
  'Partner offers stored verbatim. Disclosure fields are NOT NULL: an offer without total cost / APR cannot exist, so it can never be shown.';
