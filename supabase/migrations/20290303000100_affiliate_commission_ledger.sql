/*
  # Affiliate commission ledger (collected-revenue base, term enforcement, clawback, payout gate)

  Depends on 20290303000000_affiliate_commission_guardrails.sql. Replaces the one-shot
  "list price x rate" estimate with an append-only ledger driven by Stripe events.

  PROPOSED DEFAULT — UNVALIDATED: hold period 30 days (affiliate_hold_days(); mirrors AFFILIATE_HOLD_DAYS).

  Rules
    - EARN: one entry per paid subscription invoice. base = amount_paid - tax (USD only), commission =
      round(base x frozen rate). At most `months` earn entries per referral; rate and months are FROZEN at the
      first earn (later term changes never rewrite a running referral).
    - Effective terms above the limit are honoured only if a staff override was recorded
      (partners.commission_override_approved); grandfathered legacy rows are clamped to the limit.
    - CLAWBACK: refunds (pro-rata by refunded/charged amount), disputes (full remainder). Dispute won ->
      REINSTATEMENT. A clawback after payout becomes a negative entry netted against the next payout.
    - PAYOUT: pay_partner_approved_commissions pays only entries past the hold period (clawbacks always
      count) and only if the net balance >= affiliate_min_payout_cents().
    - Idempotent per Stripe invoice / event id. The ledger is append-only (only status/paid/void fields change).
    - Pre-ledger estimates are preserved as 'legacy' entries and are NOT payable until staff approve them.

  Not covered (needs data this repo does not have): non-USD invoices (skipped, never converted), partner
  payout execution (money movement), tax forms.

  Idempotent: safe to run twice.
*/

-- rollback: DROP FUNCTION public.record_partner_commission_for_invoice(text,text,integer,integer,text,timestamptz), public.record_partner_commission_clawback(text,text,text,text,integer,integer,text), public.record_partner_commission_reinstatement(text,text,text,text), public.void_partner_commission_entry(uuid,text), public.staff_partner_commission_overview(), public.staff_partner_ledger(uuid,integer); DROP TRIGGER trg_partner_ledger_rollup ON public.partner_commission_ledger; then restore function bodies from 20261203000000_partner_portal.sql and 20290303000000_affiliate_commission_guardrails.sql. Keep the ledger table (financial record).

-- 1) hold period ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.affiliate_hold_days()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 30 $$;

-- 2) columns ----------------------------------------------------------------------------
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS commission_override_approved boolean NOT NULL DEFAULT false;

ALTER TABLE public.partner_referrals
  ADD COLUMN IF NOT EXISTS terms_rate numeric,
  ADD COLUMN IF NOT EXISTS terms_months integer,
  ADD COLUMN IF NOT EXISTS terms_frozen_at timestamptz;

-- 3) guard: an override is "approved" only when it passed the explicit-reason check ---------
CREATE OR REPLACE FUNCTION public.partners_commission_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exceeds boolean;
  v_reason text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.commission_rate = OLD.commission_rate AND NEW.commission_months = OLD.commission_months THEN
      RETURN NEW;
    END IF;
  END IF;

  v_exceeds := NEW.commission_rate > public.affiliate_max_commission_pct()
            OR NEW.commission_months > public.affiliate_max_months();

  IF v_exceeds THEN
    v_reason := btrim(coalesce(current_setting('app.partner_commission_reason', true), ''));
    IF char_length(v_reason) < public.affiliate_override_min_reason_chars() THEN
      RAISE EXCEPTION 'commission_guardrail: rate % %% / % months exceeds the limit (% %% / % months); a staff override reason of at least % characters is required.',
        NEW.commission_rate, NEW.commission_months,
        public.affiliate_max_commission_pct(), public.affiliate_max_months(),
        public.affiliate_override_min_reason_chars()
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.commission_override_active := v_exceeds;
  NEW.commission_override_approved := v_exceeds;
  RETURN NEW;
END;
$$;

-- Overrides that staff already made through set_partner_commission_terms (audit row with a real actor + reason).
UPDATE public.partners p
SET commission_override_approved = true
WHERE p.commission_override_active
  AND NOT p.commission_override_approved
  AND EXISTS (
    SELECT 1 FROM public.partner_commission_audit a
    WHERE a.partner_id = p.id AND a.override_active AND a.actor_id IS NOT NULL
      AND a.reason IS NOT NULL AND a.reason NOT LIKE 'Legacy terms predating%'
  );

-- 4) ledger -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_commission_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('earn', 'clawback', 'reinstatement', 'legacy')),
  amount_cents integer NOT NULL,
  base_cents integer,
  rate_pct numeric,
  period_index integer,
  stripe_invoice_id text,
  stripe_event_id text,
  source_kind text CHECK (source_kind IS NULL OR source_kind IN ('refund', 'dispute')),
  source_ref text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'void')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  earned_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_amount_sign CHECK (
    (entry_type = 'earn' AND amount_cents > 0)
    OR (entry_type = 'clawback' AND amount_cents < 0)
    OR (entry_type = 'reinstatement' AND amount_cents > 0)
    OR (entry_type = 'legacy' AND amount_cents >= 0)
  ),
  CONSTRAINT ledger_earn_fields CHECK (
    entry_type <> 'earn'
    OR (stripe_invoice_id IS NOT NULL AND period_index >= 1 AND base_cents >= 0 AND rate_pct IS NOT NULL)
  ),
  CONSTRAINT ledger_adjustment_fields CHECK (
    entry_type NOT IN ('clawback', 'reinstatement')
    OR (stripe_event_id IS NOT NULL AND stripe_invoice_id IS NOT NULL AND source_kind IS NOT NULL AND source_ref IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_earn_invoice
  ON public.partner_commission_ledger(stripe_invoice_id) WHERE entry_type = 'earn';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_earn_period
  ON public.partner_commission_ledger(referral_id, period_index) WHERE entry_type = 'earn';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_adjustment_event
  ON public.partner_commission_ledger(stripe_event_id, entry_type) WHERE entry_type IN ('clawback', 'reinstatement');
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_legacy_referral
  ON public.partner_commission_ledger(referral_id) WHERE entry_type = 'legacy';
CREATE INDEX IF NOT EXISTS idx_ledger_partner_status ON public.partner_commission_ledger(partner_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_referral ON public.partner_commission_ledger(referral_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice ON public.partner_commission_ledger(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

ALTER TABLE public.partner_commission_ledger ENABLE ROW LEVEL SECURITY;

-- Staff only. Partners read their totals through partner_referrals / get_partner_dashboard_stats(), so an internal
-- void reason or staff id can never reach a partner.
DROP POLICY IF EXISTS "staff_select_partner_commission_ledger" ON public.partner_commission_ledger;
CREATE POLICY "staff_select_partner_commission_ledger" ON public.partner_commission_ledger
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.partner_commission_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.partner_commission_ledger FROM authenticated;

CREATE OR REPLACE FUNCTION public.partner_commission_ledger_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'partner_commission_ledger is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'paid_at' - 'voided_at' - 'voided_by' - 'void_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'paid_at' - 'voided_at' - 'voided_by' - 'void_reason') THEN
    RAISE EXCEPTION 'partner_commission_ledger entries are immutable except status fields' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('paid', 'void') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a % ledger entry cannot change status', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_ledger_guard ON public.partner_commission_ledger;
CREATE TRIGGER trg_partner_ledger_guard
  BEFORE UPDATE OR DELETE ON public.partner_commission_ledger
  FOR EACH ROW EXECUTE FUNCTION public.partner_commission_ledger_guard();

-- payable = past the hold period (clawbacks always), or a legacy estimate staff explicitly approved
CREATE OR REPLACE FUNCTION public.partner_ledger_entry_payable(l public.partner_commission_ledger)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT l.status IN ('pending', 'approved') AND (
    (l.entry_type = 'legacy' AND l.status = 'approved')
    OR (l.entry_type IN ('earn', 'reinstatement') AND l.earned_at <= now() - make_interval(days => public.affiliate_hold_days()))
    OR l.entry_type = 'clawback'
  )
$$;

-- keeps partner_referrals.commission_cents/status (read by the partner portal) in step with the ledger
CREATE OR REPLACE FUNCTION public.recompute_partner_referral_rollup(p_referral_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE partner_referrals r SET
    commission_cents = COALESCE((SELECT SUM(l.amount_cents) FROM partner_commission_ledger l
                                 WHERE l.referral_id = r.id AND l.status <> 'void'), 0),
    commission_status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM partner_commission_ledger l WHERE l.referral_id = r.id AND l.status <> 'void')
        THEN CASE WHEN EXISTS (SELECT 1 FROM partner_commission_ledger l WHERE l.referral_id = r.id) THEN 'void' ELSE 'pending' END
      WHEN NOT EXISTS (SELECT 1 FROM partner_commission_ledger l WHERE l.referral_id = r.id AND l.status IN ('pending', 'approved'))
        THEN 'paid'
      WHEN NOT EXISTS (SELECT 1 FROM partner_commission_ledger l WHERE l.referral_id = r.id AND l.status = 'pending')
        THEN 'approved'
      ELSE 'pending'
    END
  WHERE r.id = p_referral_id;
$$;

REVOKE ALL ON FUNCTION public.recompute_partner_referral_rollup(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.partner_ledger_rollup_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.recompute_partner_referral_rollup(NEW.referral_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_ledger_rollup ON public.partner_commission_ledger;
CREATE TRIGGER trg_partner_ledger_rollup
  AFTER INSERT OR UPDATE OF status ON public.partner_commission_ledger
  FOR EACH ROW EXECUTE FUNCTION public.partner_ledger_rollup_trigger();

-- 5) preserve pre-ledger estimates (never silently dropped, never auto-payable) ---------------
INSERT INTO public.partner_commission_ledger (partner_id, referral_id, entry_type, amount_cents, status, earned_at, reason)
SELECT r.partner_id, r.id, 'legacy', r.commission_cents,
       CASE r.commission_status WHEN 'paid' THEN 'paid' WHEN 'void' THEN 'void' WHEN 'approved' THEN 'approved' ELSE 'pending' END,
       COALESCE(r.converted_at, r.created_at),
       'Pre-ledger estimate (list price x rate); not verified against collected revenue.'
FROM public.partner_referrals r
WHERE r.commission_cents > 0
ON CONFLICT (referral_id) WHERE entry_type = 'legacy' DO NOTHING;

-- 6) profile trigger: conversion/churn only; commission comes exclusively from collected invoices -----
CREATE OR REPLACE FUNCTION public.sync_partner_referral_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referral partner_referrals;
  v_mrr_cents integer;
BEGIN
  SELECT * INTO v_referral FROM partner_referrals WHERE referred_user_id = NEW.id;
  IF v_referral.id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Informational only (list price); never used to compute commission.
  v_mrr_cents := CASE NEW.plan
    WHEN 'starter' THEN 7900
    WHEN 'professional' THEN 19900
    WHEN 'business' THEN 39900
    ELSE 0
  END;

  IF NEW.subscription_status = 'active' AND v_mrr_cents > 0 AND v_referral.status IN ('signed_up', 'churned') THEN
    UPDATE partner_referrals SET
      status = 'converted',
      mrr_cents = v_mrr_cents,
      converted_at = COALESCE(converted_at, now())
    WHERE id = v_referral.id;
  ELSIF NEW.subscription_status IN ('suspended') AND v_referral.status = 'converted' THEN
    UPDATE partner_referrals SET status = 'churned' WHERE id = v_referral.id;
  END IF;

  RETURN NEW;
END;
$$;

-- 7a) EARN — service role only (called by stripe-webhook) ----------------------------------------
CREATE OR REPLACE FUNCTION public.record_partner_commission_for_invoice(
  p_customer_id text,
  p_invoice_id text,
  p_amount_paid_cents integer,
  p_tax_cents integer,
  p_currency text,
  p_paid_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_ref partner_referrals;
  v_partner partners;
  v_rate numeric;
  v_months integer;
  v_n integer;
  v_base integer;
  v_amount integer;
  v_rows integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Service role only.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_customer_id, '') = '' OR coalesce(p_invoice_id, '') = '' THEN
    RAISE EXCEPTION 'customer and invoice ids are required.' USING ERRCODE = '22023';
  END IF;
  IF lower(coalesce(p_currency, '')) <> 'usd' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'non_usd');
  END IF;
  IF coalesce(p_amount_paid_cents, 0) <= 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'zero_amount');
  END IF;

  SELECT id INTO v_user FROM profiles WHERE stripe_customer_id = p_customer_id;
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_profile');
  END IF;

  SELECT * INTO v_ref FROM partner_referrals WHERE referred_user_id = v_user FOR UPDATE;
  IF v_ref.id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'not_referred');
  END IF;

  SELECT * INTO v_partner FROM partners WHERE id = v_ref.partner_id;
  IF v_partner.id IS NULL OR v_partner.status <> 'approved' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'partner_not_active');
  END IF;

  IF EXISTS (SELECT 1 FROM partner_commission_ledger WHERE entry_type = 'earn' AND stripe_invoice_id = p_invoice_id) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  IF v_ref.terms_frozen_at IS NULL THEN
    IF v_partner.commission_override_approved THEN
      v_rate := v_partner.commission_rate;
      v_months := v_partner.commission_months;
    ELSE
      v_rate := LEAST(v_partner.commission_rate, public.affiliate_max_commission_pct());
      v_months := LEAST(v_partner.commission_months, public.affiliate_max_months());
    END IF;
    UPDATE partner_referrals
    SET terms_rate = v_rate, terms_months = v_months, terms_frozen_at = now()
    WHERE id = v_ref.id;
  ELSE
    v_rate := v_ref.terms_rate;
    v_months := v_ref.terms_months;
  END IF;

  SELECT count(*) INTO v_n FROM partner_commission_ledger WHERE referral_id = v_ref.id AND entry_type = 'earn';
  IF v_n >= v_months THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'term_exhausted');
  END IF;

  v_base := GREATEST(0, p_amount_paid_cents - GREATEST(0, coalesce(p_tax_cents, 0)));
  v_amount := round(v_base * v_rate / 100.0)::integer;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'zero_commission');
  END IF;

  INSERT INTO partner_commission_ledger
    (partner_id, referral_id, entry_type, amount_cents, base_cents, rate_pct, period_index, stripe_invoice_id, earned_at)
  VALUES
    (v_partner.id, v_ref.id, 'earn', v_amount, v_base, v_rate, v_n + 1, p_invoice_id, coalesce(p_paid_at, now()))
  ON CONFLICT (stripe_invoice_id) WHERE entry_type = 'earn' DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  RETURN jsonb_build_object('status', 'earned', 'amount_cents', v_amount, 'base_cents', v_base, 'period', v_n + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.record_partner_commission_for_invoice(text, text, integer, integer, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_partner_commission_for_invoice(text, text, integer, integer, text, timestamptz) TO service_role;

-- 7b) CLAWBACK (refund pro-rata, dispute full remainder) — service role only --------------------
CREATE OR REPLACE FUNCTION public.record_partner_commission_clawback(
  p_event_id text,
  p_invoice_id text,
  p_source_kind text,
  p_source_ref text,
  p_refunded_cents integer,
  p_charge_amount_cents integer,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_earn partner_commission_ledger;
  v_net_clawed integer;
  v_refund_clawed integer;
  v_target integer;
  v_delta integer;
  v_rows integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Service role only.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_event_id, '') = '' OR coalesce(p_invoice_id, '') = '' OR coalesce(p_source_ref, '') = '' THEN
    RAISE EXCEPTION 'event, invoice and source ids are required.' USING ERRCODE = '22023';
  END IF;
  IF p_source_kind NOT IN ('refund', 'dispute') THEN
    RAISE EXCEPTION 'source kind must be refund or dispute.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_earn FROM partner_commission_ledger
  WHERE entry_type = 'earn' AND stripe_invoice_id = p_invoice_id AND status <> 'void';
  IF v_earn.id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_commission');
  END IF;

  -- serialise adjustments for this referral
  PERFORM 1 FROM partner_referrals WHERE id = v_earn.referral_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM partner_commission_ledger WHERE entry_type = 'clawback' AND stripe_event_id = p_event_id) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT COALESCE(-SUM(amount_cents), 0) INTO v_net_clawed
  FROM partner_commission_ledger
  WHERE stripe_invoice_id = p_invoice_id AND entry_type IN ('clawback', 'reinstatement') AND status <> 'void';

  IF p_source_kind = 'dispute' THEN
    IF EXISTS (SELECT 1 FROM partner_commission_ledger
               WHERE entry_type = 'clawback' AND source_kind = 'dispute' AND source_ref = p_source_ref) THEN
      RETURN jsonb_build_object('status', 'duplicate');
    END IF;
    v_delta := v_earn.amount_cents - v_net_clawed;
  ELSE
    IF coalesce(p_charge_amount_cents, 0) <= 0 OR coalesce(p_refunded_cents, 0) <= 0 THEN
      RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_refund_amount');
    END IF;
    SELECT COALESCE(-SUM(amount_cents), 0) INTO v_refund_clawed
    FROM partner_commission_ledger
    WHERE stripe_invoice_id = p_invoice_id AND entry_type = 'clawback' AND source_kind = 'refund' AND status <> 'void';
    v_target := round(v_earn.amount_cents * LEAST(1::numeric, p_refunded_cents::numeric / p_charge_amount_cents))::integer;
    v_delta := LEAST(v_target - v_refund_clawed, v_earn.amount_cents - v_net_clawed);
  END IF;

  IF v_delta <= 0 THEN
    RETURN jsonb_build_object('status', 'noop');
  END IF;

  INSERT INTO partner_commission_ledger
    (partner_id, referral_id, entry_type, amount_cents, stripe_invoice_id, stripe_event_id, source_kind, source_ref, reason)
  VALUES
    (v_earn.partner_id, v_earn.referral_id, 'clawback', -v_delta, p_invoice_id, p_event_id, p_source_kind, p_source_ref,
     left(coalesce(p_reason, p_source_kind), 500))
  ON CONFLICT (stripe_event_id, entry_type) WHERE entry_type IN ('clawback', 'reinstatement') DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  RETURN jsonb_build_object('status', 'clawed_back', 'amount_cents', v_delta);
END;
$$;

REVOKE ALL ON FUNCTION public.record_partner_commission_clawback(text, text, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_partner_commission_clawback(text, text, text, text, integer, integer, text) TO service_role;

-- 7c) REINSTATEMENT (dispute won) — service role only -------------------------------------------
CREATE OR REPLACE FUNCTION public.record_partner_commission_reinstatement(
  p_event_id text,
  p_invoice_id text,
  p_source_ref text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clawback partner_commission_ledger;
  v_clawed integer;
  v_reinstated integer;
  v_delta integer;
  v_rows integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Service role only.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_event_id, '') = '' OR coalesce(p_invoice_id, '') = '' OR coalesce(p_source_ref, '') = '' THEN
    RAISE EXCEPTION 'event, invoice and source ids are required.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_clawback FROM partner_commission_ledger
  WHERE entry_type = 'clawback' AND source_kind = 'dispute' AND source_ref = p_source_ref AND status <> 'void'
  ORDER BY created_at LIMIT 1;
  IF v_clawback.id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_clawback');
  END IF;

  PERFORM 1 FROM partner_referrals WHERE id = v_clawback.referral_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM partner_commission_ledger WHERE entry_type = 'reinstatement' AND stripe_event_id = p_event_id) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT COALESCE(-SUM(amount_cents), 0) INTO v_clawed FROM partner_commission_ledger
  WHERE entry_type = 'clawback' AND source_kind = 'dispute' AND source_ref = p_source_ref AND status <> 'void';
  SELECT COALESCE(SUM(amount_cents), 0) INTO v_reinstated FROM partner_commission_ledger
  WHERE entry_type = 'reinstatement' AND source_kind = 'dispute' AND source_ref = p_source_ref AND status <> 'void';
  v_delta := v_clawed - v_reinstated;
  IF v_delta <= 0 THEN
    RETURN jsonb_build_object('status', 'noop');
  END IF;

  INSERT INTO partner_commission_ledger
    (partner_id, referral_id, entry_type, amount_cents, stripe_invoice_id, stripe_event_id, source_kind, source_ref, reason, earned_at)
  VALUES
    (v_clawback.partner_id, v_clawback.referral_id, 'reinstatement', v_delta, p_invoice_id, p_event_id, 'dispute', p_source_ref,
     left(coalesce(p_reason, 'dispute won'), 500), now())
  ON CONFLICT (stripe_event_id, entry_type) WHERE entry_type IN ('clawback', 'reinstatement') DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  RETURN jsonb_build_object('status', 'reinstated', 'amount_cents', v_delta);
END;
$$;

REVOKE ALL ON FUNCTION public.record_partner_commission_reinstatement(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_partner_commission_reinstatement(text, text, text, text) TO service_role;

-- 7d) PAYOUT gate (replaces the version from 20290303000000) ----------------------------------------
CREATE OR REPLACE FUNCTION public.pay_partner_approved_commissions(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_count integer;
  v_ids uuid[];
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
  SELECT COALESCE(SUM(amount_cents), 0), COUNT(*), COALESCE(array_agg(id), ARRAY[]::uuid[])
  INTO v_total, v_count, v_ids FROM locked;

  IF v_total < public.affiliate_min_payout_cents() THEN
    RAISE EXCEPTION 'commission_guardrail: payable balance % cents is below the minimum payout of % cents.',
      v_total, public.affiliate_min_payout_cents()
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_commission_ledger SET status = 'paid', paid_at = now() WHERE id = ANY (v_ids);

  RETURN jsonb_build_object('paid_cents', v_total, 'entries', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_partner_approved_commissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_partner_approved_commissions(uuid) TO authenticated;

-- 7e) legacy review: 'approved' approves the referral's legacy estimate; everything else is automatic --
CREATE OR REPLACE FUNCTION public.set_partner_referral_commission_status(p_referral_id uuid, p_status text)
RETURNS partner_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_referrals;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_status <> 'approved' THEN
    RAISE EXCEPTION 'commission_guardrail: commission status is ledger-driven. Use void_partner_commission_entry(entry_id, reason) to void, pay_partner_approved_commissions(partner_id) to pay. Only ''approved'' (pre-ledger legacy estimates) is accepted here.'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE partner_commission_ledger SET status = 'approved'
  WHERE referral_id = p_referral_id AND entry_type = 'legacy' AND status = 'pending';
  SELECT * INTO v_row FROM partner_referrals WHERE id = p_referral_id;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_partner_referral_commission_status(uuid, text) TO authenticated;

-- 7f) staff: void an unpaid entry (reason required) ------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_partner_commission_entry(p_entry_id uuid, p_reason text)
RETURNS partner_commission_ledger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_commission_ledger;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < public.affiliate_override_min_reason_chars() THEN
    RAISE EXCEPTION 'commission_guardrail: a reason of at least % characters is required.', public.affiliate_override_min_reason_chars()
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_commission_ledger
  SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = left(v_reason, 500)
  WHERE id = p_entry_id AND status IN ('pending', 'approved')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Entry not found or already paid/void.' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_partner_commission_entry(uuid, text) TO authenticated;

-- 7g) partner dashboard now reads the ledger (replaces the version from 20261203000000) -------------
CREATE OR REPLACE FUNCTION public.get_partner_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_partner partners;
  v_result jsonb;
BEGIN
  SELECT * INTO v_partner FROM partners WHERE user_id = auth.uid();
  IF v_partner.id IS NULL THEN
    RETURN jsonb_build_object('has_application', false);
  END IF;

  SELECT jsonb_build_object(
    'has_application', true,
    'partner', to_jsonb(v_partner),
    'total_clicks', (SELECT count(*) FROM partner_link_clicks WHERE partner_id = v_partner.id),
    'total_referrals', (SELECT count(*) FROM partner_referrals WHERE partner_id = v_partner.id),
    'converted_referrals', (SELECT count(*) FROM partner_referrals WHERE partner_id = v_partner.id AND status = 'converted'),
    'churned_referrals', (SELECT count(*) FROM partner_referrals WHERE partner_id = v_partner.id AND status = 'churned'),
    'pending_commission_cents', (SELECT COALESCE(SUM(amount_cents), 0) FROM partner_commission_ledger WHERE partner_id = v_partner.id AND status IN ('pending', 'approved')),
    'paid_commission_cents', (SELECT COALESCE(SUM(amount_cents), 0) FROM partner_commission_ledger WHERE partner_id = v_partner.id AND status = 'paid'),
    'is_certified', (SELECT EXISTS(SELECT 1 FROM partner_certifications WHERE user_id = auth.uid()))
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_partner_dashboard_stats() TO authenticated;

-- 7h) staff reads ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_partner_commission_overview()
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
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.applied_at DESC)
    FROM (
      SELECT
        p.id, p.company_name, p.contact_email, p.tier, p.status, p.commission_rate, p.commission_months,
        p.commission_override_active, p.commission_override_approved, p.applied_at,
        (SELECT count(*) FROM partner_referrals r WHERE r.partner_id = p.id) AS referrals,
        COALESCE(SUM(l.amount_cents) FILTER (WHERE public.partner_ledger_entry_payable(l)), 0) AS payable_cents,
        COALESCE(SUM(l.amount_cents) FILTER (WHERE l.status IN ('pending', 'approved') AND NOT public.partner_ledger_entry_payable(l)), 0) AS held_cents,
        COALESCE(SUM(l.amount_cents) FILTER (WHERE l.status = 'paid'), 0) AS paid_cents,
        COALESCE(SUM(l.amount_cents) FILTER (WHERE l.entry_type = 'clawback' AND l.status <> 'void'), 0) AS clawed_back_cents
      FROM partners p
      LEFT JOIN partner_commission_ledger l ON l.partner_id = p.id
      GROUP BY p.id
      ORDER BY p.applied_at DESC
      LIMIT 500
    ) t
  ), '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.staff_partner_commission_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_partner_ledger(p_partner_id uuid, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 100), 1), 500);
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'entries', COALESCE((
      SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC)
      FROM (
        SELECT l.id, l.referral_id, l.entry_type, l.amount_cents, l.base_cents, l.rate_pct, l.period_index,
               l.stripe_invoice_id, l.source_kind, l.status, l.reason, l.earned_at, l.paid_at, l.void_reason, l.created_at,
               public.partner_ledger_entry_payable(l) AS payable
        FROM partner_commission_ledger l
        WHERE l.partner_id = p_partner_id
        ORDER BY l.created_at DESC
        LIMIT v_limit
      ) e
    ), '[]'::jsonb),
    'audit', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC)
      FROM (
        SELECT op, old_rate, new_rate, old_months, new_months, override_active, reason, created_at
        FROM partner_commission_audit
        WHERE partner_id = p_partner_id
        ORDER BY created_at DESC
        LIMIT 50
      ) a
    ), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.staff_partner_ledger(uuid, integer) TO authenticated;

/*
  Verification queries:
    SELECT entry_type, status, count(*), sum(amount_cents) FROM public.partner_commission_ledger GROUP BY 1, 2;
    SELECT id, commission_cents, commission_status FROM public.partner_referrals WHERE commission_cents <> 0;
*/
