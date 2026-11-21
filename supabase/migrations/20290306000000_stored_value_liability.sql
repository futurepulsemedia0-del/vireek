/*
  # Stored-value liability view (per tenant)

  ## What counts as stored value here (verified against the migrations in the repo)
  - gift_cards (kind = gift_card | store_credit) + gift_card_transactions   (20270402000000_gift_cards.sql)
  - loyalty points: lpts_accounts / lpts_programs / lpts_ledger             (20280105000000_points_ledger.sql)
    valued at redeem_points_per_dollar. Reported as its own kind and NOT part of the total
    unless the tenant opts in (stored_value_settings.include_loyalty_points).

  ## Deliberately NOT included (checked, not stored value in the current schema)
  - credit_memos (20270402000000_refunds_credit_memos.sql): 1:1 with a Stripe refund that is paid back
    to the original payment method, so there is no spendable balance.
  - memberships / membership_plans: plan + status only, no prepaid balance column.
  - booking / payment-plan deposits: terms on settings/plan rows, no balance ledger.
  - wallet_passes: Apple/Google Wallet pass registrations, not money.
  - supplier_credit_memos / vendor_rma_credits: payables owed TO the tenant, not liabilities.
  If deposits or prepaid memberships later get a balance ledger, add a UNION branch to
  stored_value_instruments_v and a value to the instrument_kind CHECK on stored_value_state_rules.

  ## Legal posture
  Nothing here concludes that any balance is escheatable, expired, void or owed.
  stored_value_state_rules ships EMPTY on purpose: every row must be entered and signed off by counsel.
  [COUNSEL] [VERIFY]

  ## Security
  - Views are security_invoker = true: the caller's RLS on gift_cards / lpts_* applies
    (account owner or manager with billing permission only).
  - Settings are written only through set_stored_value_settings() (manager check, input validation).
  - State rules are read-only for clients; maintained by staff via service role.
*/

-- ---------------------------------------------------------------------------
-- 1. Per-tenant settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stored_value_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[A-Z]{2}$'),
  review_period_months integer CHECK (review_period_months IS NULL OR review_period_months BETWEEN 1 AND 120),
  include_loyalty_points boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.stored_value_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_stored_value_settings" ON public.stored_value_settings;
CREATE POLICY "select_stored_value_settings" ON public.stored_value_settings FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.identity_is_manager());
REVOKE ALL ON public.stored_value_settings FROM anon, authenticated;
GRANT SELECT ON public.stored_value_settings TO authenticated;

COMMENT ON TABLE public.stored_value_settings IS
  'Tenant choices for the stored-value view. review_period_months is the tenant''s own operational review window (overrides the state rule). [COUNSEL][VERIFY]';

-- ---------------------------------------------------------------------------
-- 2. State rules config (EMPTY by design)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stored_value_state_rules (
  state_code text NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  instrument_kind text NOT NULL CHECK (instrument_kind IN ('gift_card', 'store_credit', 'loyalty_points')),
  review_period_months integer CHECK (review_period_months IS NULL OR review_period_months BETWEEN 1 AND 120),
  rule_status text NOT NULL DEFAULT 'unreviewed' CHECK (rule_status IN ('unreviewed', 'counsel_reviewed')),
  marker text NOT NULL DEFAULT '[COUNSEL][VERIFY]',
  source_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state_code, instrument_kind),
  CONSTRAINT svsr_reviewed_requires_reviewer CHECK (rule_status <> 'counsel_reviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

ALTER TABLE public.stored_value_state_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_stored_value_state_rules" ON public.stored_value_state_rules;
CREATE POLICY "select_stored_value_state_rules" ON public.stored_value_state_rules FOR SELECT TO authenticated
  USING (public.identity_is_manager());
REVOKE ALL ON public.stored_value_state_rules FROM anon, authenticated;
GRANT SELECT ON public.stored_value_state_rules TO authenticated;

COMMENT ON TABLE public.stored_value_state_rules IS
  'Per-state review windows for stored value. Ships empty. Every row needs counsel sign-off before use. Not legal advice. [COUNSEL][VERIFY]';

-- ---------------------------------------------------------------------------
-- 3. Settings writer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_stored_value_settings(
  p_state_code text,
  p_review_period_months integer,
  p_include_loyalty_points boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_state text := upper(nullif(btrim(p_state_code), ''));
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_state IS NOT NULL AND v_state !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'invalid_state_code' USING ERRCODE = '22023';
  END IF;
  IF p_review_period_months IS NOT NULL AND p_review_period_months NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_review_period' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stored_value_settings (account_owner_id, state_code, review_period_months, include_loyalty_points, updated_at)
  VALUES (v_owner, v_state, p_review_period_months, COALESCE(p_include_loyalty_points, false), now())
  ON CONFLICT (account_owner_id) DO UPDATE
    SET state_code = EXCLUDED.state_code,
        review_period_months = EXCLUDED.review_period_months,
        include_loyalty_points = EXCLUDED.include_loyalty_points,
        updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.set_stored_value_settings(text, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_stored_value_settings(text, integer, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Supporting index (latest-activity lookup per points account)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lpts_ledger_account_kind_created
  ON public.lpts_ledger (account_id, kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Instrument-level view (one row per open balance)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.stored_value_instruments_v WITH (security_invoker = true) AS
WITH raw AS (
  SELECT
    g.account_owner_id,
    g.id                                   AS instrument_id,
    g.kind::text                           AS instrument_kind,
    g.balance_cents::bigint                AS balance_cents,
    lower(g.currency)                      AS currency,
    g.created_at                           AS issued_at,
    g.expires_at                           AS expires_at,
    COALESCE(a.last_tx, g.created_at)      AS last_activity_at,
    right(g.code, 4)                       AS reference_suffix,
    (COALESCE(a.ledger_sum, 0) = g.balance_cents) AS ledger_reconciled
  FROM public.gift_cards g
  LEFT JOIN LATERAL (
    SELECT max(t.created_at) FILTER (WHERE t.kind <> 'void') AS last_tx,
           COALESCE(sum(t.amount_cents), 0)                  AS ledger_sum
    FROM public.gift_card_transactions t
    WHERE t.gift_card_id = g.id
  ) a ON true
  WHERE g.status = 'active' AND g.balance_cents > 0

  UNION ALL

  SELECT
    la.account_owner_id,
    la.id,
    'loyalty_points'::text,
    floor(la.balance_points * 100.0 / p.redeem_points_per_dollar)::bigint,
    'usd'::text,
    la.created_at,
    NULL::timestamptz,
    COALESCE(l.last_tx, la.created_at),
    right(la.customer_id::text, 4),
    NULL::boolean
  FROM public.lpts_accounts la
  JOIN public.lpts_programs p ON p.account_owner_id = la.account_owner_id
  LEFT JOIN LATERAL (
    SELECT max(x.created_at) AS last_tx
    FROM public.lpts_ledger x
    WHERE x.account_id = la.id AND x.kind IN ('earn', 'redeem', 'adjust')
  ) l ON true
  WHERE la.balance_points > 0
),
cfg AS (
  SELECT r.*,
         COALESCE(s.review_period_months, sr.review_period_months) AS period_months
  FROM raw r
  LEFT JOIN public.stored_value_settings s ON s.account_owner_id = r.account_owner_id
  LEFT JOIN public.stored_value_state_rules sr
         ON sr.state_code = s.state_code AND sr.instrument_kind = r.instrument_kind
)
SELECT
  c.account_owner_id,
  c.instrument_id,
  c.instrument_kind,
  c.balance_cents,
  c.currency,
  c.issued_at,
  c.expires_at,
  c.last_activity_at,
  c.reference_suffix,
  c.ledger_reconciled,
  (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS is_expired,
  GREATEST(0, floor(extract(epoch FROM (now() - c.last_activity_at)) / 86400))::integer AS days_inactive,
  CASE
    WHEN now() - c.last_activity_at <= interval '180 days' THEN '0_180'
    WHEN now() - c.last_activity_at <= interval '365 days' THEN '181_365'
    WHEN now() - c.last_activity_at <= interval '730 days' THEN '366_730'
    ELSE '731_plus'
  END AS inactivity_bucket,
  c.period_months AS review_period_months,
  (c.period_months IS NOT NULL
   AND c.last_activity_at <= now() - make_interval(months => c.period_months)) AS past_review_period
FROM cfg c;

COMMENT ON VIEW public.stored_value_instruments_v IS
  'Open stored-value balances per tenant (RLS of the caller applies). past_review_period only compares inactivity with a configured window; it is not a legal determination. [COUNSEL][VERIFY]';

-- ---------------------------------------------------------------------------
-- 6. Outstanding balances per tenant / kind / currency
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.stored_value_liability_summary_v WITH (security_invoker = true) AS
SELECT
  account_owner_id,
  instrument_kind,
  currency,
  count(*)::integer                                                                 AS instrument_count,
  COALESCE(sum(balance_cents), 0)::bigint                                           AS outstanding_cents,
  count(*) FILTER (WHERE is_expired)::integer                                       AS expired_count,
  COALESCE(sum(balance_cents) FILTER (WHERE is_expired), 0)::bigint                 AS expired_cents,
  count(*) FILTER (WHERE past_review_period)::integer                               AS past_review_count,
  COALESCE(sum(balance_cents) FILTER (WHERE past_review_period), 0)::bigint         AS past_review_cents,
  count(*) FILTER (WHERE ledger_reconciled IS FALSE)::integer                       AS unreconciled_count,
  min(last_activity_at)                                                             AS oldest_activity_at
FROM public.stored_value_instruments_v
GROUP BY account_owner_id, instrument_kind, currency;

-- ---------------------------------------------------------------------------
-- 7. Dormancy distribution per tenant / kind / currency / bucket
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.stored_value_dormancy_v WITH (security_invoker = true) AS
SELECT
  account_owner_id,
  instrument_kind,
  currency,
  inactivity_bucket,
  count(*)::integer                         AS instrument_count,
  COALESCE(sum(balance_cents), 0)::bigint   AS balance_cents
FROM public.stored_value_instruments_v
GROUP BY account_owner_id, instrument_kind, currency, inactivity_bucket;

REVOKE ALL ON public.stored_value_instruments_v, public.stored_value_liability_summary_v, public.stored_value_dormancy_v FROM PUBLIC, anon;
GRANT SELECT ON public.stored_value_instruments_v, public.stored_value_liability_summary_v, public.stored_value_dormancy_v TO authenticated;

/*
  ROLLBACK (manual, in this order):
    DROP VIEW IF EXISTS public.stored_value_dormancy_v, public.stored_value_liability_summary_v, public.stored_value_instruments_v;
    DROP FUNCTION IF EXISTS public.set_stored_value_settings(text, integer, boolean);
    DROP TABLE IF EXISTS public.stored_value_state_rules, public.stored_value_settings;
    DROP INDEX IF EXISTS public.idx_lpts_ledger_account_kind_created;
*/
