/*
  # Affiliate commission guardrails

  Hard limits so a partner commission cannot erase gross margin. Extends the tables/RPCs from
  20261203000000_partner_portal.sql; it does NOT add a new affiliate program.

  PROPOSED DEFAULTS — UNVALIDATED (mirror src/lib/affiliateCommission.ts; a vitest drift test checks both):
    max commission rate 20 %, max term 12 months, minimum payout 5000 cents.

  What this migration does
    1. Limit functions (single SQL source of truth for the numbers).
    2. partners.commission_months + partners.commission_override_active.
    3. Append-only audit table partner_commission_audit (staff-readable) + triggers that audit EVERY path
       (RPC, service role, plain SQL).
    4. BEFORE trigger: terms above a limit are rejected unless an explicit reason (>= 10 chars) was supplied
       through set_partner_commission_terms(); CHECK constraint as a second line of defence.
    5. Legacy rows above a limit (e.g. agency 25 %) are NOT silently changed: they are flagged as
       override_active and listed by the verification query at the bottom.
    6. apply_for_partner_program: default rate clamped to the limit.
    7. set_partner_commission_terms (staff, reason required) and pay_partner_approved_commissions
       (enforces the minimum payout); set_partner_referral_commission_status can no longer set 'paid'.

  NOT in this migration (does not exist in the codebase): a commission ledger, collected-revenue base,
  refund/chargeback clawback, a commission-term (months) consumer. See the delivery report.

  Idempotent: safe to run twice.
*/

-- rollback: DROP TRIGGER trg_partners_commission_guard / trg_partners_commission_audit ON public.partners; ALTER TABLE public.partners DROP CONSTRAINT partners_commission_within_guardrails, partners_commission_months_range; then re-apply the function bodies from 20261203000000_partner_portal.sql. The audit table and the two new columns are harmless to leave in place.

-- 1) limits ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.affiliate_max_commission_pct()
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 20::numeric $$;

CREATE OR REPLACE FUNCTION public.affiliate_max_months()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 12 $$;

CREATE OR REPLACE FUNCTION public.affiliate_min_payout_cents()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 5000 $$;

CREATE OR REPLACE FUNCTION public.affiliate_override_min_reason_chars()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 10 $$;

CREATE OR REPLACE FUNCTION public.affiliate_months_sanity_ceiling()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 60 $$;

-- 2) columns ----------------------------------------------------------------------
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS commission_months integer NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS commission_override_active boolean NOT NULL DEFAULT false;

-- 3) audit table (append-only, staff-readable, no FK so deleting a partner never erases history) --
CREATE TABLE IF NOT EXISTS public.partner_commission_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  actor_id uuid,
  op text NOT NULL CHECK (op IN ('insert', 'update')),
  old_rate numeric,
  new_rate numeric NOT NULL,
  old_months integer,
  new_months integer NOT NULL,
  override_active boolean NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_commission_audit_partner
  ON public.partner_commission_audit(partner_id, created_at DESC);

ALTER TABLE public.partner_commission_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_select_partner_commission_audit" ON public.partner_commission_audit;
CREATE POLICY "staff_select_partner_commission_audit" ON public.partner_commission_audit
  FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

REVOKE ALL ON public.partner_commission_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.partner_commission_audit FROM authenticated;

CREATE OR REPLACE FUNCTION public.partner_commission_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'partner_commission_audit is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_commission_audit_immutable ON public.partner_commission_audit;
CREATE TRIGGER trg_partner_commission_audit_immutable
  BEFORE UPDATE OR DELETE ON public.partner_commission_audit
  FOR EACH ROW EXECUTE FUNCTION public.partner_commission_audit_immutable();

-- 4a) guard: reject terms above a limit unless an explicit reason was supplied -----------
-- The reason travels in the transaction-local setting app.partner_commission_reason (set by
-- set_partner_commission_terms). It is deliberately NOT a column on partners, so a partner can never
-- read a staff note through their own row.
CREATE OR REPLACE FUNCTION public.partners_commission_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exceeds boolean;
  v_reason text;
BEGIN
  -- Terms untouched: moderation of grandfathered rows (approve/reject/suspend) keeps working.
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partners_commission_guard ON public.partners;
CREATE TRIGGER trg_partners_commission_guard
  BEFORE INSERT OR UPDATE OF commission_rate, commission_months ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.partners_commission_guard();

-- 4b) audit every change of the terms, whoever made it ------------------------------------
CREATE OR REPLACE FUNCTION public.partners_commission_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.commission_rate = OLD.commission_rate
       AND NEW.commission_months = OLD.commission_months
       AND NEW.commission_override_active = OLD.commission_override_active THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.partner_commission_audit
    (partner_id, actor_id, op, old_rate, new_rate, old_months, new_months, override_active, reason)
  VALUES (
    NEW.id,
    auth.uid(),
    lower(TG_OP),
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.commission_rate END,
    NEW.commission_rate,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.commission_months END,
    NEW.commission_months,
    NEW.commission_override_active,
    left(NULLIF(btrim(coalesce(current_setting('app.partner_commission_reason', true), '')), ''), 500)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partners_commission_audit ON public.partners;
CREATE TRIGGER trg_partners_commission_audit
  AFTER INSERT OR UPDATE OF commission_rate, commission_months, commission_override_active ON public.partners
  FOR EACH ROW EXECUTE FUNCTION public.partners_commission_audit();

-- 5) grandfather legacy rows above a limit (visible + audited, never silently changed) -------
DO $$
BEGIN
  PERFORM set_config('app.partner_commission_reason',
    'Legacy terms predating commission guardrails (migration 20290303000000); staff review required.', true);
  UPDATE public.partners
  SET commission_override_active = true
  WHERE (commission_rate > public.affiliate_max_commission_pct()
         OR commission_months > public.affiliate_max_months())
    AND commission_override_active = false;
  PERFORM set_config('app.partner_commission_reason', '', true);
END $$;

-- 4c) CHECK constraints (second line of defence; also holds if triggers are bypassed) --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_commission_months_range' AND conrelid = 'public.partners'::regclass
  ) THEN
    ALTER TABLE public.partners
      ADD CONSTRAINT partners_commission_months_range
      CHECK (commission_months BETWEEN 1 AND public.affiliate_months_sanity_ceiling());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_commission_within_guardrails' AND conrelid = 'public.partners'::regclass
  ) THEN
    ALTER TABLE public.partners
      ADD CONSTRAINT partners_commission_within_guardrails
      CHECK (
        (commission_rate <= public.affiliate_max_commission_pct()
         AND commission_months <= public.affiliate_max_months())
        OR commission_override_active
      );
  END IF;
END $$;

-- 6) apply_for_partner_program: default rate can never start above the limit -------------
CREATE OR REPLACE FUNCTION public.apply_for_partner_program(
  p_company_name text,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_tier text DEFAULT 'affiliate'
)
RETURNS partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_row partners;
BEGIN
  IF EXISTS (SELECT 1 FROM partners WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You already have a partner application on file.';
  END IF;

  IF p_tier NOT IN ('affiliate', 'agency') THEN
    p_tier := 'affiliate';
  END IF;

  LOOP
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM partners WHERE referral_code = v_code);
  END LOOP;

  INSERT INTO partners (user_id, company_name, contact_name, contact_email, contact_phone, channel, tier, referral_code, commission_rate, commission_months)
  VALUES (
    auth.uid(),
    NULLIF(TRIM(p_company_name), ''),
    NULLIF(TRIM(p_contact_name), ''),
    NULLIF(TRIM(p_contact_email), ''),
    NULLIF(TRIM(COALESCE(p_contact_phone, '')), ''),
    NULLIF(TRIM(COALESCE(p_channel, '')), ''),
    p_tier,
    v_code,
    LEAST(CASE WHEN p_tier = 'agency' THEN 25 ELSE 20 END, public.affiliate_max_commission_pct()),
    public.affiliate_max_months()
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_for_partner_program(text, text, text, text, text, text) TO authenticated;

-- 7a) staff: change a partner's terms (reason ALWAYS required; above a limit it is the override) --
CREATE OR REPLACE FUNCTION public.set_partner_commission_terms(
  p_partner_id uuid,
  p_rate numeric,
  p_months integer,
  p_reason text
)
RETURNS partners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partners;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;
  IF p_rate IS NULL OR p_rate < 0 OR p_rate > 100 THEN
    RAISE EXCEPTION 'commission_guardrail: rate must be between 0 and 100.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_months IS NULL OR p_months < 1 OR p_months > public.affiliate_months_sanity_ceiling() THEN
    RAISE EXCEPTION 'commission_guardrail: term must be between 1 and % months.', public.affiliate_months_sanity_ceiling()
      USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(v_reason) < public.affiliate_override_min_reason_chars() THEN
    RAISE EXCEPTION 'commission_guardrail: a reason of at least % characters is required for every commission change.',
      public.affiliate_override_min_reason_chars()
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.partner_commission_reason', left(v_reason, 500), true);

  UPDATE partners
  SET commission_rate = p_rate, commission_months = p_months
  WHERE id = p_partner_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Partner not found.' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_partner_commission_terms(uuid, numeric, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_partner_commission_terms(uuid, numeric, integer, text) TO authenticated;

-- 7b) staff: payouts only through the minimum-payout gate -----------------------------------
CREATE OR REPLACE FUNCTION public.pay_partner_approved_commissions(p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.' USING ERRCODE = '42501';
  END IF;

  WITH locked AS (
    SELECT id, commission_cents
    FROM partner_referrals
    WHERE partner_id = p_partner_id AND commission_status = 'approved'
    FOR UPDATE
  )
  SELECT COALESCE(SUM(commission_cents), 0), COUNT(*) INTO v_total, v_count FROM locked;

  IF v_total < public.affiliate_min_payout_cents() THEN
    RAISE EXCEPTION 'commission_guardrail: approved balance % cents is below the minimum payout of % cents.',
      v_total, public.affiliate_min_payout_cents()
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE partner_referrals
  SET commission_status = 'paid'
  WHERE partner_id = p_partner_id AND commission_status = 'approved';

  RETURN jsonb_build_object('paid_cents', v_total, 'referrals', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_partner_approved_commissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_partner_approved_commissions(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_partner_referral_commission_status(p_referral_id uuid, p_status text)
RETURNS partner_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row partner_referrals;
BEGIN
  IF NOT is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only.';
  END IF;
  IF p_status NOT IN ('pending', 'approved', 'paid', 'void') THEN
    RAISE EXCEPTION 'Invalid status.';
  END IF;
  IF p_status = 'paid' THEN
    RAISE EXCEPTION 'commission_guardrail: use pay_partner_approved_commissions(partner_id) so the minimum payout is enforced.'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE partner_referrals SET commission_status = p_status
  WHERE id = p_referral_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_partner_referral_commission_status(uuid, text) TO authenticated;

/*
  Verification queries (run manually after applying):
    -- legacy rows above a limit that need a staff decision:
    SELECT id, tier, commission_rate, commission_months FROM public.partners WHERE commission_override_active;
    -- recent changes:
    SELECT * FROM public.partner_commission_audit ORDER BY created_at DESC LIMIT 20;
*/
