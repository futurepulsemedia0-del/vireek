/*
  # Partner revenue share: agreements, monthly payout statements, payout records

  Depends on 20261203000000_partner_portal.sql, 20290303000000_affiliate_commission_guardrails.sql and
  20290303000100_affiliate_commission_ledger.sql. It EXTENDS that programme; it does not add a second one.

  What already existed (and is reused unchanged)
    - partners / partner_referrals (referral + channel data), partner_commission_ledger (append-only; earn,
      clawback, reinstatement, legacy), the 30-day hold, the minimum payout, refund/dispute clawbacks.

  What this migration adds (the gap)
    1. partner_agreements   versioned contract terms per partner (staff-only). Activating one applies the terms
                            through set_partner_commission_terms(), so the existing guardrails + audit still apply.
    2. partner_payouts      one row per partner per CLOSED calendar month (UTC) plus 'adhoc' rows for the existing
                            pay_partner_approved_commissions() path. Holds the amounts and an immutable statement
                            snapshot. Staff-only.
    3. calculate_partner_payouts(period, partner?)   monthly calculation from the ledger. Pure derivation: it never
                            moves a ledger status. Deterministic: eligibility is evaluated as of the first instant of
                            the following month, so re-running a closed month gives the same answer.
    4. approve_partner_payout / mark_partner_payout_paid / void_partner_payout   the workflow. Marking paid
                            re-validates every ledger entry under a row lock and aborts if anything changed.
    5. Staff read RPCs for the console and the CSV/PDF statements.

  Money rules (all amounts are integer USD cents)
    - Rounding happens ONCE per invoice, in record_partner_commission_for_invoice (round half away from zero on
      numeric, e.g. 12.5 % of 7900 = 987.5 -> 988). A statement only sums integers and re-checks that every earn
      line still equals round(base x rate / 100); a mismatch blocks approval.
    - Clawbacks (refund pro-rata, dispute) are negative ledger entries that always count. A clawback booked after a
      payout is netted in the next statement; if it exceeds the positive balance the statement is carried forward
      as 'negative_balance' and nothing is paid.
    - A net below the minimum payout (agreement value, else affiliate_min_payout_cents()) is carried forward.

  NOT covered (needs data/decisions this repository does not have)
    - Moving money (the workflow records that staff paid outside the system, same as the existing payout button).
    - Non-USD invoices (the ledger skips them), tax forms/withholding, VAT on commissions. [COUNSEL] [VERIFY]
    - The contract wording itself. partner_agreements stores a reference to the signed document; activation needs
      document_ref + an explicit counsel confirmation. [COUNSEL]

  Idempotent: safe to run twice.
*/

-- rollback (manual; keep the tables, they are financial records):
--   DROP FUNCTION IF EXISTS public.calculate_partner_payouts(date, uuid), public.approve_partner_payout(uuid),
--     public.mark_partner_payout_paid(uuid, text, text), public.void_partner_payout(uuid, text),
--     public.create_partner_agreement_draft(uuid, numeric, integer, integer, date, text, text),
--     public.activate_partner_agreement(uuid, text, boolean), public.terminate_partner_agreement(uuid, date, text),
--     public.staff_partner_payouts(date, uuid, integer), public.staff_partner_statement(uuid),
--     public.staff_partner_agreements(uuid), public.compute_partner_statement(uuid, date),
--     public.partner_ledger_payable_asof(public.partner_commission_ledger, timestamptz);
--   then restore pay_partner_approved_commissions(uuid) from 20290303000100_affiliate_commission_ledger.sql (7d).

-- 1) agreements ---------------------------------------------------------------------------
-- No FK to partners on purpose (same as partner_commission_ledger / partner_commission_audit): deleting a partner
-- account must never erase or block the financial record.
CREATE TABLE IF NOT EXISTS public.partner_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'superseded', 'terminated')),
  revenue_share_pct numeric(5, 2) NOT NULL CHECK (revenue_share_pct >= 0 AND revenue_share_pct <= 100),
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 60),
  min_payout_cents integer NOT NULL DEFAULT 5000 CHECK (min_payout_cents >= 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  effective_from date NOT NULL,
  effective_to date,
  document_ref text CHECK (document_ref IS NULL OR char_length(document_ref) BETWEEN 3 AND 500),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid,
  activated_at timestamptz,
  counsel_confirmed_by uuid,
  counsel_confirmed_at timestamptz,
  terminated_by uuid,
  terminated_at timestamptz,
  terminate_reason text CHECK (terminate_reason IS NULL OR char_length(terminate_reason) <= 500),
  CONSTRAINT partner_agreements_partner_version UNIQUE (partner_id, version),
  CONSTRAINT partner_agreements_dates CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT partner_agreements_active_needs_review CHECK (
    status = 'draft'
    OR (document_ref IS NOT NULL AND counsel_confirmed_at IS NOT NULL AND activated_at IS NOT NULL)
  )
);

-- at most one active agreement per partner
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_agreements_one_active
  ON public.partner_agreements (partner_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_partner_agreements_partner ON public.partner_agreements (partner_id, version DESC);

ALTER TABLE public.partner_agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_partner_agreements" ON public.partner_agreements;
CREATE POLICY "staff_select_partner_agreements" ON public.partner_agreements
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.partner_agreements FROM anon, authenticated;
GRANT SELECT ON public.partner_agreements TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_agreements_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a non-draft partner agreement cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' THEN
    -- the contract terms are frozen once activated; only lifecycle columns may move
    IF (to_jsonb(NEW) - 'status' - 'effective_to' - 'terminated_by' - 'terminated_at' - 'terminate_reason')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'status' - 'effective_to' - 'terminated_by' - 'terminated_at' - 'terminate_reason') THEN
      RAISE EXCEPTION 'partner agreement terms are immutable once activated; create a new version' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status IN ('superseded', 'terminated'))
  ) THEN
    RAISE EXCEPTION 'invalid agreement status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_agreements_guard ON public.partner_agreements;
CREATE TRIGGER trg_partner_agreements_guard
  BEFORE UPDATE OR DELETE ON public.partner_agreements
  FOR EACH ROW EXECUTE FUNCTION public.partner_agreements_guard();

-- 2) payouts ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  agreement_id uuid REFERENCES public.partner_agreements (id),
  agreement_version integer,
  source text NOT NULL DEFAULT 'monthly' CHECK (source IN ('monthly', 'adhoc')),
  period_start date,
  period_end date,
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  gross_cents bigint NOT NULL DEFAULT 0 CHECK (gross_cents >= 0),
  clawback_cents bigint NOT NULL DEFAULT 0 CHECK (clawback_cents <= 0),
  net_cents bigint NOT NULL DEFAULT 0,
  min_payout_cents integer NOT NULL DEFAULT 0 CHECK (min_payout_cents >= 0),
  entry_count integer NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  ledger_entry_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  status text NOT NULL DEFAULT 'calculated'
    CHECK (status IN ('calculated', 'carried_forward', 'approved', 'paid', 'void')),
  carry_reason text CHECK (carry_reason IS NULL OR carry_reason IN ('below_minimum', 'negative_balance', 'nothing_due')),
  statement jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  calculated_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  paid_at timestamptz,
  paid_by uuid,
  payment_method text CHECK (payment_method IS NULL OR char_length(payment_method) BETWEEN 2 AND 50),
  payment_reference text CHECK (payment_reference IS NULL OR char_length(payment_reference) BETWEEN 3 AND 200),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_payouts_net_is_sum CHECK (net_cents = gross_cents + clawback_cents),
  CONSTRAINT partner_payouts_period_shape CHECK (
    (source = 'monthly'
      AND period_start IS NOT NULL AND period_end IS NOT NULL
      AND period_start = date_trunc('month', period_start::timestamp)::date
      AND period_end = ((period_start + interval '1 month')::date - 1))
    OR (source = 'adhoc' AND period_start IS NULL AND period_end IS NULL)
  ),
  CONSTRAINT partner_payouts_paid_fields CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND paid_by IS NOT NULL)),
  CONSTRAINT partner_payouts_approved_fields CHECK (
    status NOT IN ('approved', 'paid') OR source = 'adhoc' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT partner_payouts_void_fields CHECK (status <> 'void' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT partner_payouts_payable_positive CHECK (status NOT IN ('approved', 'paid') OR net_cents > 0)
);

-- one live monthly statement per partner per month (a voided one can be recalculated)
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_payouts_monthly
  ON public.partner_payouts (partner_id, period_start) WHERE source = 'monthly' AND status <> 'void';
CREATE INDEX IF NOT EXISTS idx_partner_payouts_partner ON public.partner_payouts (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_payouts_period ON public.partner_payouts (period_start DESC, status);

ALTER TABLE public.partner_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_partner_payouts" ON public.partner_payouts;
CREATE POLICY "staff_select_partner_payouts" ON public.partner_payouts
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.partner_payouts FROM anon, authenticated;
GRANT SELECT ON public.partner_payouts TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_payouts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'partner_payouts is a financial record and cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IN ('approved', 'paid', 'void') THEN
    IF (to_jsonb(NEW) - 'status' - 'approved_at' - 'approved_by' - 'paid_at' - 'paid_by' - 'payment_method'
        - 'payment_reference' - 'voided_at' - 'voided_by' - 'void_reason')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'status' - 'approved_at' - 'approved_by' - 'paid_at' - 'paid_by' - 'payment_method'
        - 'payment_reference' - 'voided_at' - 'voided_by' - 'void_reason') THEN
      RAISE EXCEPTION 'an % payout is immutable (amounts, entries and statement are frozen)', OLD.status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'calculated' AND NEW.status IN ('carried_forward', 'approved', 'void'))
    OR (OLD.status = 'carried_forward' AND NEW.status IN ('calculated', 'void'))
    OR (OLD.status = 'approved' AND NEW.status IN ('paid', 'void'))
  ) THEN
    RAISE EXCEPTION 'invalid payout status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_payouts_guard ON public.partner_payouts;
CREATE TRIGGER trg_partner_payouts_guard
  BEFORE UPDATE OR DELETE ON public.partner_payouts
  FOR EACH ROW EXECUTE FUNCTION public.partner_payouts_guard();

-- 3) eligibility as of a fixed instant (the existing partner_ledger_entry_payable() uses now()) ----------------
CREATE OR REPLACE FUNCTION public.partner_ledger_payable_asof(l public.partner_commission_ledger, p_asof timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT l.status IN ('pending', 'approved')
    AND l.earned_at < p_asof
    AND (
      (l.entry_type = 'legacy' AND l.status = 'approved')
      OR (l.entry_type IN ('earn', 'reinstatement') AND l.earned_at <= p_asof - make_interval(days => public.affiliate_hold_days()))
      OR l.entry_type = 'clawback'
    )
$$;

-- 4) statement computation (internal; no access check, callers are definers that already checked) -------------
CREATE OR REPLACE FUNCTION public.compute_partner_statement(p_partner_id uuid, p_period_start date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start date := date_trunc('month', p_period_start::timestamp)::date;
  v_end date := ((date_trunc('month', p_period_start::timestamp) + interval '1 month')::date - 1);
  v_from timestamptz := (date_trunc('month', p_period_start::timestamp)) AT TIME ZONE 'UTC';
  v_asof timestamptz := (date_trunc('month', p_period_start::timestamp) + interval '1 month') AT TIME ZONE 'UTC';
  v_partner partners;
  v_agr partner_agreements;
  v_gross bigint;
  v_claw bigint;
  v_carried_in bigint;
  v_ids uuid[];
  v_count integer;
  v_min integer;
  v_net bigint;
  v_status text;
  v_reason text;
  v_lines jsonb;
  v_mismatch integer;
  v_held bigint;
  v_act_earn bigint;
  v_act_claw bigint;
  v_act_reinst bigint;
  v_act_legacy bigint;
  v_act_count integer;
BEGIN
  SELECT * INTO v_partner FROM partners WHERE id = p_partner_id;
  IF v_partner.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_agr FROM partner_agreements a
  WHERE a.partner_id = p_partner_id AND a.status <> 'draft'
    AND a.effective_from <= v_end AND (a.effective_to IS NULL OR a.effective_to > v_start)
  ORDER BY a.version DESC LIMIT 1;

  v_min := COALESCE(v_agr.min_payout_cents, public.affiliate_min_payout_cents());

  SELECT
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.amount_cents > 0), 0),
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.amount_cents < 0), 0),
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.earned_at < v_from), 0),
    COALESCE(array_agg(l.id ORDER BY l.earned_at, l.id), ARRAY[]::uuid[]),
    count(*)::integer,
    count(*) FILTER (
      WHERE l.entry_type = 'earn' AND l.base_cents IS NOT NULL AND l.rate_pct IS NOT NULL
        AND l.amount_cents <> round(l.base_cents * l.rate_pct / 100.0)::integer
    )::integer
  INTO v_gross, v_claw, v_carried_in, v_ids, v_count, v_mismatch
  FROM partner_commission_ledger l
  WHERE l.partner_id = p_partner_id AND public.partner_ledger_payable_asof(l, v_asof);

  v_net := v_gross + v_claw;

  SELECT COALESCE(SUM(l.amount_cents), 0) INTO v_held
  FROM partner_commission_ledger l
  WHERE l.partner_id = p_partner_id AND l.status IN ('pending', 'approved') AND l.earned_at < v_asof
    AND NOT public.partner_ledger_payable_asof(l, v_asof);

  SELECT
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.entry_type = 'earn'), 0),
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.entry_type = 'clawback'), 0),
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.entry_type = 'reinstatement'), 0),
    COALESCE(SUM(l.amount_cents) FILTER (WHERE l.entry_type = 'legacy'), 0),
    count(*)::integer
  INTO v_act_earn, v_act_claw, v_act_reinst, v_act_legacy, v_act_count
  FROM partner_commission_ledger l
  WHERE l.partner_id = p_partner_id AND l.status <> 'void' AND l.earned_at >= v_from AND l.earned_at < v_asof;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.earned_at, x.id), '[]'::jsonb) INTO v_lines
  FROM (
    SELECT l.id, l.entry_type, l.earned_at, l.period_index, l.base_cents, l.rate_pct, l.amount_cents,
           l.stripe_invoice_id, l.source_kind, left(l.id::text, 8) AS ref
    FROM partner_commission_ledger l
    WHERE l.partner_id = p_partner_id AND public.partner_ledger_payable_asof(l, v_asof)
    ORDER BY l.earned_at, l.id
    LIMIT 5000
  ) x;

  IF v_net < 0 THEN
    v_status := 'carried_forward'; v_reason := 'negative_balance';
  ELSIF v_net = 0 THEN
    v_status := 'carried_forward'; v_reason := 'nothing_due';
  ELSIF v_net < v_min THEN
    v_status := 'carried_forward'; v_reason := 'below_minimum';
  ELSE
    v_status := 'calculated'; v_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'partner_id', p_partner_id,
    'period_start', v_start,
    'period_end', v_end,
    'agreement_id', v_agr.id,
    'agreement_version', v_agr.version,
    'min_payout_cents', v_min,
    'gross_cents', v_gross,
    'clawback_cents', v_claw,
    'net_cents', v_net,
    'entry_count', v_count,
    'entry_ids', to_jsonb(v_ids),
    'status', v_status,
    'carry_reason', v_reason,
    'has_activity', (v_count > 0 OR v_act_count > 0 OR v_held <> 0),
    'statement', jsonb_build_object(
      'schema', 1,
      'currency', 'usd',
      'partner', jsonb_build_object(
        'company_name', v_partner.company_name, 'tier', v_partner.tier, 'channel', v_partner.channel,
        'referral_code', v_partner.referral_code, 'status', v_partner.status,
        'commission_rate', v_partner.commission_rate, 'commission_months', v_partner.commission_months
      ),
      'agreement', CASE WHEN v_agr.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_agr.id, 'version', v_agr.version, 'revenue_share_pct', v_agr.revenue_share_pct,
        'term_months', v_agr.term_months, 'min_payout_cents', v_agr.min_payout_cents,
        'document_ref', v_agr.document_ref
      ) END,
      'period', jsonb_build_object('start', v_start, 'end', v_end, 'eligibility_asof', v_asof),
      'activity', jsonb_build_object(
        'earned_cents', v_act_earn, 'clawback_cents', v_act_claw,
        'reinstated_cents', v_act_reinst, 'legacy_cents', v_act_legacy, 'entries', v_act_count
      ),
      'carried_in_cents', v_carried_in,
      'held_cents', v_held,
      'rounding_mismatches', v_mismatch,
      'lines_truncated', (v_count > 5000),
      'lines', v_lines
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compute_partner_statement(uuid, date) FROM PUBLIC, anon, authenticated;

-- 5) monthly calculation (staff or service role) ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_partner_payouts(p_period date, p_partner_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_start date;
  v_end date;
  v_pid uuid;
  v_calc jsonb;
  v_existing partner_payouts;
  v_created integer := 0;
  v_updated integer := 0;
  v_locked integer := 0;
  v_skipped integer := 0;
BEGIN
  IF v_uid IS NOT NULL AND NOT is_vireek_staff(v_uid) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_period IS NULL THEN
    RAISE EXCEPTION 'a period is required.' USING ERRCODE = '22023';
  END IF;

  v_start := date_trunc('month', p_period::timestamp)::date;
  v_end := ((v_start + interval '1 month')::date - 1);
  IF v_end >= (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'period_not_closed: % is not a completed calendar month (UTC).', v_start USING ERRCODE = 'check_violation';
  END IF;

  -- serialise concurrent runs for the same month
  PERFORM pg_advisory_xact_lock(hashtextextended('partner_payouts:' || v_start::text, 0));

  FOR v_pid IN
    SELECT p.id FROM partners p
    WHERE p.status IN ('approved', 'suspended')
      AND (p_partner_id IS NULL OR p.id = p_partner_id)
      AND EXISTS (SELECT 1 FROM partner_commission_ledger l WHERE l.partner_id = p.id)
    ORDER BY p.id
  LOOP
    v_calc := public.compute_partner_statement(v_pid, v_start);
    IF v_calc IS NULL OR NOT (v_calc->>'has_activity')::boolean THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- history is frozen: a month older than the latest approved/paid statement is never (re)calculated,
    -- because entries settled by the later payout would otherwise change what the old month shows
    IF EXISTS (
      SELECT 1 FROM partner_payouts o
      WHERE o.partner_id = v_pid AND o.source = 'monthly' AND o.status IN ('approved', 'paid') AND o.period_start > v_start
    ) THEN
      v_locked := v_locked + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM partner_payouts
    WHERE partner_id = v_pid AND period_start = v_start AND source = 'monthly' AND status <> 'void'
    FOR UPDATE;

    IF v_existing.id IS NOT NULL AND v_existing.status IN ('approved', 'paid') THEN
      v_locked := v_locked + 1;
      CONTINUE;
    END IF;

    IF v_existing.id IS NULL THEN
      INSERT INTO partner_payouts (
        partner_id, agreement_id, agreement_version, source, period_start, period_end,
        gross_cents, clawback_cents, net_cents, min_payout_cents, entry_count, ledger_entry_ids,
        status, carry_reason, statement, calculated_by
      ) VALUES (
        v_pid, NULLIF(v_calc->>'agreement_id', '')::uuid, NULLIF(v_calc->>'agreement_version', '')::integer,
        'monthly', v_start, v_end,
        (v_calc->>'gross_cents')::bigint, (v_calc->>'clawback_cents')::bigint, (v_calc->>'net_cents')::bigint,
        (v_calc->>'min_payout_cents')::integer, (v_calc->>'entry_count')::integer,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_calc->'entry_ids'))::uuid[], ARRAY[]::uuid[]),
        v_calc->>'status', v_calc->>'carry_reason', v_calc->'statement', v_uid
      );
      v_created := v_created + 1;
    ELSE
      UPDATE partner_payouts SET
        agreement_id = NULLIF(v_calc->>'agreement_id', '')::uuid,
        agreement_version = NULLIF(v_calc->>'agreement_version', '')::integer,
        gross_cents = (v_calc->>'gross_cents')::bigint,
        clawback_cents = (v_calc->>'clawback_cents')::bigint,
        net_cents = (v_calc->>'net_cents')::bigint,
        min_payout_cents = (v_calc->>'min_payout_cents')::integer,
        entry_count = (v_calc->>'entry_count')::integer,
        ledger_entry_ids = COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_calc->'entry_ids'))::uuid[], ARRAY[]::uuid[]),
        status = v_calc->>'status',
        carry_reason = v_calc->>'carry_reason',
        statement = v_calc->'statement',
        calculated_at = now(),
        calculated_by = v_uid
      WHERE id = v_existing.id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'period_start', v_start, 'period_end', v_end,
    'created', v_created, 'updated', v_updated, 'locked', v_locked, 'skipped', v_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_partner_payouts(date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_partner_payouts(date, uuid) TO authenticated, service_role;

-- 6) agreements: draft / activate / terminate -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_partner_agreement_draft(
  p_partner_id uuid,
  p_rate numeric,
  p_months integer,
  p_min_payout_cents integer,
  p_effective_from date,
  p_document_ref text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS partner_agreements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_agreements;
  v_version integer;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'Partner not found.' USING ERRCODE = 'P0002';
  END IF;
  IF p_effective_from IS NULL THEN
    RAISE EXCEPTION 'an effective date is required.' USING ERRCODE = '22023';
  END IF;

  -- serialise version numbering per partner
  PERFORM 1 FROM partners WHERE id = p_partner_id FOR UPDATE;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM partner_agreements WHERE partner_id = p_partner_id;

  INSERT INTO partner_agreements (
    partner_id, version, revenue_share_pct, term_months, min_payout_cents, effective_from,
    document_ref, notes, created_by
  ) VALUES (
    p_partner_id, v_version, p_rate, p_months, COALESCE(p_min_payout_cents, public.affiliate_min_payout_cents()),
    p_effective_from, NULLIF(btrim(p_document_ref), ''), NULLIF(btrim(p_notes), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_partner_agreement_draft(uuid, numeric, integer, integer, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_partner_agreement_draft(uuid, numeric, integer, integer, date, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.activate_partner_agreement(p_agreement_id uuid, p_reason text, p_counsel_confirmed boolean)
RETURNS partner_agreements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_agreements;
  v_prev partner_agreements;
  v_partner partners;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_counsel_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'agreement_guardrail: legal review of the signed agreement must be confirmed before activation. [COUNSEL]'
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_reason) < public.affiliate_override_min_reason_chars() THEN
    RAISE EXCEPTION 'agreement_guardrail: a reason of at least % characters is required.', public.affiliate_override_min_reason_chars()
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM partner_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Agreement not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft agreement can be activated.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.document_ref IS NULL THEN
    RAISE EXCEPTION 'agreement_guardrail: a reference to the signed agreement document is required.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.effective_from > (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'agreement_guardrail: a future-dated agreement cannot be activated yet.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_partner FROM partners WHERE id = v_row.partner_id FOR UPDATE;
  IF v_partner.id IS NULL THEN
    RAISE EXCEPTION 'Partner not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_prev FROM partner_agreements WHERE partner_id = v_row.partner_id AND status = 'active' FOR UPDATE;
  IF v_prev.id IS NOT NULL THEN
    IF v_row.effective_from <= v_prev.effective_from THEN
      RAISE EXCEPTION 'agreement_guardrail: the new agreement must start after the active one (%).', v_prev.effective_from
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE partner_agreements SET status = 'superseded', effective_to = v_row.effective_from WHERE id = v_prev.id;
  END IF;

  -- apply the terms through the existing guarded + audited path (limits and override reason still enforced)
  PERFORM public.set_partner_commission_terms(v_row.partner_id, v_row.revenue_share_pct, v_row.term_months, v_reason);

  UPDATE partner_agreements SET
    status = 'active', activated_by = auth.uid(), activated_at = now(),
    counsel_confirmed_by = auth.uid(), counsel_confirmed_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  PERFORM public.log_audit_event(
    v_partner.user_id, 'partner_agreement_activated', 'partner_agreements', v_row.id::text,
    jsonb_build_object('partner_id', v_row.partner_id, 'version', v_row.version,
                       'revenue_share_pct', v_row.revenue_share_pct, 'term_months', v_row.term_months,
                       'superseded', v_prev.id, 'reason', left(v_reason, 500))
  );
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_partner_agreement(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_partner_agreement(uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.terminate_partner_agreement(p_agreement_id uuid, p_effective_to date, p_reason text)
RETURNS partner_agreements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_agreements;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_user uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < public.affiliate_override_min_reason_chars() THEN
    RAISE EXCEPTION 'agreement_guardrail: a reason of at least % characters is required.', public.affiliate_override_min_reason_chars()
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM partner_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active agreement can be terminated.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_effective_to IS NULL OR p_effective_to <= v_row.effective_from THEN
    RAISE EXCEPTION 'agreement_guardrail: the end date must be after the start date.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_agreements SET
    status = 'terminated', effective_to = p_effective_to, terminated_by = auth.uid(),
    terminated_at = now(), terminate_reason = left(v_reason, 500)
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  SELECT user_id INTO v_user FROM partners WHERE id = v_row.partner_id;
  IF v_user IS NOT NULL THEN
    PERFORM public.log_audit_event(
      v_user, 'partner_agreement_terminated', 'partner_agreements', v_row.id::text,
      jsonb_build_object('partner_id', v_row.partner_id, 'version', v_row.version,
                         'effective_to', p_effective_to, 'reason', left(v_reason, 500))
    );
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_partner_agreement(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_partner_agreement(uuid, date, text) TO authenticated;

-- 7) payout workflow -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_partner_payout(p_payout_id uuid)
RETURNS partner_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_payouts;
  v_fresh jsonb;
  v_partner partners;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM partner_payouts WHERE id = p_payout_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Payout not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.source <> 'monthly' OR v_row.status <> 'calculated' THEN
    RAISE EXCEPTION 'payout_guardrail: only a calculated monthly statement can be approved (status: %).', v_row.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.agreement_id IS NULL THEN
    RAISE EXCEPTION 'payout_guardrail: no agreement was in force for this period; activate one and recalculate. [COUNSEL]'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_partner FROM partners WHERE id = v_row.partner_id;
  IF v_partner.id IS NULL OR v_partner.status <> 'approved' THEN
    RAISE EXCEPTION 'payout_guardrail: the partner is not in good standing.' USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE((v_row.statement->>'rounding_mismatches')::integer, 0) > 0 THEN
    RAISE EXCEPTION 'payout_guardrail: an earn line no longer matches round(base x rate); investigate before approving.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- the ledger must still say what the statement says (void / ad-hoc payment since calculation)
  v_fresh := public.compute_partner_statement(v_row.partner_id, v_row.period_start);
  IF (v_fresh->>'net_cents')::bigint IS DISTINCT FROM v_row.net_cents
     OR (v_fresh->'entry_ids') IS DISTINCT FROM to_jsonb(v_row.ledger_entry_ids) THEN
    RAISE EXCEPTION 'stale_payout: the ledger changed since this statement was calculated; recalculate the month.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_payouts SET status = 'approved', approved_at = now(), approved_by = auth.uid()
  WHERE id = v_row.id RETURNING * INTO v_row;

  PERFORM public.log_audit_event(
    v_partner.user_id, 'partner_payout_approved', 'partner_payouts', v_row.id::text,
    jsonb_build_object('partner_id', v_row.partner_id, 'period_start', v_row.period_start,
                       'net_cents', v_row.net_cents, 'agreement_version', v_row.agreement_version)
  );
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_partner_payout(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_partner_payout(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_partner_payout_paid(p_payout_id uuid, p_method text, p_reference text)
RETURNS partner_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_payouts;
  v_partner partners;
  v_method text := btrim(coalesce(p_method, ''));
  v_ref text := btrim(coalesce(p_reference, ''));
  v_locked integer;
  v_sum bigint;
  v_bad integer;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_method) < 2 OR char_length(v_method) > 50 OR char_length(v_ref) < 3 OR char_length(v_ref) > 200 THEN
    RAISE EXCEPTION 'payout_guardrail: a payment method (2-50 chars) and a bank/provider reference (3-200 chars) are required.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM partner_payouts WHERE id = p_payout_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Payout not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'payout_guardrail: only an approved payout can be marked paid (status: %).', v_row.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_partner FROM partners WHERE id = v_row.partner_id;
  IF v_partner.id IS NULL OR v_partner.status <> 'approved' THEN
    RAISE EXCEPTION 'payout_guardrail: the partner is not in good standing.' USING ERRCODE = 'check_violation';
  END IF;

  -- lock the exact entries this payout covers and prove nothing moved underneath it
  WITH locked AS (
    SELECT l.id, l.amount_cents, l.status, l.partner_id
    FROM partner_commission_ledger l
    WHERE l.id = ANY (v_row.ledger_entry_ids)
    FOR UPDATE
  )
  SELECT count(*)::integer, COALESCE(SUM(amount_cents), 0),
         count(*) FILTER (WHERE status NOT IN ('pending', 'approved') OR partner_id <> v_row.partner_id)::integer
  INTO v_locked, v_sum, v_bad FROM locked;

  IF v_locked <> COALESCE(array_length(v_row.ledger_entry_ids, 1), 0) OR v_bad > 0 OR v_sum <> v_row.net_cents THEN
    RAISE EXCEPTION 'stale_payout: ledger entries changed after approval (paid, voided or missing); void this payout and recalculate.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_commission_ledger SET status = 'paid', paid_at = now()
  WHERE id = ANY (v_row.ledger_entry_ids);

  UPDATE partner_payouts SET
    status = 'paid', paid_at = now(), paid_by = auth.uid(), payment_method = v_method, payment_reference = v_ref
  WHERE id = v_row.id RETURNING * INTO v_row;

  PERFORM public.log_audit_event(
    v_partner.user_id, 'partner_payout_paid', 'partner_payouts', v_row.id::text,
    jsonb_build_object('partner_id', v_row.partner_id, 'period_start', v_row.period_start,
                       'net_cents', v_row.net_cents, 'entries', v_row.entry_count, 'method', v_method)
  );
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_partner_payout_paid(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_partner_payout_paid(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_partner_payout(p_payout_id uuid, p_reason text)
RETURNS partner_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_payouts;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_user uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < public.affiliate_override_min_reason_chars() THEN
    RAISE EXCEPTION 'payout_guardrail: a reason of at least % characters is required.', public.affiliate_override_min_reason_chars()
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM partner_payouts WHERE id = p_payout_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Payout not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('calculated', 'carried_forward', 'approved') THEN
    RAISE EXCEPTION 'payout_guardrail: a % payout cannot be voided.', v_row.status USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_payouts SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = left(v_reason, 500)
  WHERE id = v_row.id RETURNING * INTO v_row;

  SELECT user_id INTO v_user FROM partners WHERE id = v_row.partner_id;
  IF v_user IS NOT NULL THEN
    PERFORM public.log_audit_event(
      v_user, 'partner_payout_voided', 'partner_payouts', v_row.id::text,
      jsonb_build_object('partner_id', v_row.partner_id, 'period_start', v_row.period_start,
                         'net_cents', v_row.net_cents, 'reason', left(v_reason, 500))
    );
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.void_partner_payout(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_partner_payout(uuid, text) TO authenticated;

-- 8) the existing ad-hoc payout button now leaves a payout record (behaviour otherwise unchanged) -------------------
CREATE OR REPLACE FUNCTION public.pay_partner_approved_commissions(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_gross bigint;
  v_claw bigint;
  v_count integer;
  v_ids uuid[];
  v_payout uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;

  WITH locked AS (
    SELECT l.id, l.amount_cents
    FROM partner_commission_ledger l
    WHERE l.partner_id = p_partner_id AND public.partner_ledger_entry_payable(l)
    FOR UPDATE
  )
  SELECT COALESCE(SUM(amount_cents), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents > 0), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents < 0), 0),
         COUNT(*), COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO v_total, v_gross, v_claw, v_count, v_ids FROM locked;

  IF v_total < public.affiliate_min_payout_cents() THEN
    RAISE EXCEPTION 'commission_guardrail: payable balance % cents is below the minimum payout of % cents.',
      v_total, public.affiliate_min_payout_cents()
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_commission_ledger SET status = 'paid', paid_at = now() WHERE id = ANY (v_ids);

  INSERT INTO partner_payouts (
    partner_id, source, gross_cents, clawback_cents, net_cents, min_payout_cents, entry_count, ledger_entry_ids,
    status, statement, calculated_by, paid_at, paid_by, payment_method, payment_reference
  ) VALUES (
    p_partner_id, 'adhoc', v_gross, v_claw, v_total, public.affiliate_min_payout_cents(), v_count, v_ids,
    'paid', jsonb_build_object('schema', 1, 'currency', 'usd', 'adhoc', true), auth.uid(), now(), auth.uid(),
    'unspecified', 'ad-hoc payout button'
  ) RETURNING id INTO v_payout;

  RETURN jsonb_build_object('paid_cents', v_total, 'entries', v_count, 'payout_id', v_payout);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_partner_approved_commissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_partner_approved_commissions(uuid) TO authenticated;

-- 9) staff reads ------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_partner_payouts(
  p_period date DEFAULT NULL,
  p_partner_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 200), 1), 500);
  v_start date := CASE WHEN p_period IS NULL THEN NULL ELSE date_trunc('month', p_period::timestamp)::date END;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC)
    FROM (
      SELECT o.id, o.partner_id, p.company_name, p.channel, o.source, o.period_start, o.period_end,
             o.status, o.carry_reason, o.gross_cents, o.clawback_cents, o.net_cents, o.min_payout_cents,
             o.entry_count, o.agreement_version, o.calculated_at, o.approved_at, o.paid_at,
             o.payment_method, o.payment_reference, o.created_at
      FROM partner_payouts o
      LEFT JOIN partners p ON p.id = o.partner_id
      WHERE (v_start IS NULL OR o.period_start = v_start)
        AND (p_partner_id IS NULL OR o.partner_id = p_partner_id)
      ORDER BY o.created_at DESC
      LIMIT v_limit
    ) t
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_partner_payouts(date, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_partner_payouts(date, uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_partner_statement(p_payout_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_payouts;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM partner_payouts WHERE id = p_payout_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Payout not found.' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'id', v_row.id, 'partner_id', v_row.partner_id, 'source', v_row.source,
    'period_start', v_row.period_start, 'period_end', v_row.period_end, 'status', v_row.status,
    'carry_reason', v_row.carry_reason, 'gross_cents', v_row.gross_cents, 'clawback_cents', v_row.clawback_cents,
    'net_cents', v_row.net_cents, 'min_payout_cents', v_row.min_payout_cents, 'entry_count', v_row.entry_count,
    'agreement_version', v_row.agreement_version, 'calculated_at', v_row.calculated_at,
    'approved_at', v_row.approved_at, 'paid_at', v_row.paid_at,
    'payment_method', v_row.payment_method, 'payment_reference', v_row.payment_reference,
    'statement', v_row.statement
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_partner_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_partner_statement(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_partner_agreements(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.version DESC)
    FROM (
      SELECT id, partner_id, version, status, revenue_share_pct, term_months, min_payout_cents,
             effective_from, effective_to, document_ref, activated_at, counsel_confirmed_at, terminated_at, created_at
      FROM partner_agreements WHERE partner_id = p_partner_id
      ORDER BY version DESC LIMIT 50
    ) a
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.staff_partner_agreements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_partner_agreements(uuid) TO authenticated;

/*
  Verification queries:
    SELECT status, carry_reason, count(*), sum(net_cents) FROM public.partner_payouts GROUP BY 1, 2;
    SELECT partner_id, count(*) FROM public.partner_agreements WHERE status = 'active' GROUP BY 1 HAVING count(*) > 1; -- must be empty
    -- partners that earn but have no agreement (their monthly statements cannot be approved):
    SELECT p.id, p.company_name FROM public.partners p
    WHERE p.status = 'approved' AND NOT EXISTS (SELECT 1 FROM public.partner_agreements a WHERE a.partner_id = p.id AND a.status = 'active');
*/
