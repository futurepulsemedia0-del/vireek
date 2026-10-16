/*
  # Referral program: reward rules, payouts, leaderboard

  Builds on referral_codes / referral_conversions (20261011000000_marketing_automation.sql),
  click tracking (20261109...) and booking attribution (20261110...). Nothing existing is replaced:
  the job-paid -> conversion trigger keeps working exactly as before.

  ## Adds
  - referral_reward_rules   : tiered rules (min job value, min earlier conversions). Managers write.
  - referral_conversions    : + reward_type / reward_value / reward_amount / qualifying_amount / rule_id,
                              filled by a BEFORE trigger when a conversion becomes 'converted'.
  - referral_payouts        : payout ledger, written ONLY by record_referral_payouts / void_referral_payout.
  - referral_conversion_details (view), get_referral_leaderboard(p_days) (function)

  ## Security
  - Every table is scoped by user_id = get_account_owner_id() (the account owner), like referral_codes.
  - Clients cannot mark a conversion 'rewarded' or edit reward amounts directly (guard trigger):
    only the payout RPCs can, and only for managers (identity_is_manager()).
  - Discount rewards are percentages: reward_amount stays NULL, so they never count as dollars.

  Requires: get_account_owner_id(), identity_is_manager(), referral_codes, referral_conversions, customers, jobs
*/

-- 1) Reward rules -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_reward_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  reward_type text NOT NULL DEFAULT 'credit',
  reward_value numeric(10,2) NOT NULL,
  min_invoice_amount numeric(10,2) NOT NULL DEFAULT 0,
  min_conversions integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rrr_name_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  CONSTRAINT rrr_type_check CHECK (reward_type IN ('credit', 'discount', 'cash')),
  CONSTRAINT rrr_value_check CHECK (reward_value > 0 AND (reward_type <> 'discount' OR reward_value <= 100)),
  CONSTRAINT rrr_min_invoice_check CHECK (min_invoice_amount >= 0),
  CONSTRAINT rrr_min_conv_check CHECK (min_conversions BETWEEN 0 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_rrr_user ON referral_reward_rules(user_id, is_active);

CREATE OR REPLACE FUNCTION public.referral_rules_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM referral_reward_rules WHERE user_id = NEW.user_id) >= 20 THEN
      RAISE EXCEPTION 'You can have at most 20 reward rules.' USING ERRCODE = '54000';
    END IF;
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'A rule cannot move to another account' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_rules_guard ON referral_reward_rules;
CREATE TRIGGER trg_referral_rules_guard
  BEFORE INSERT OR UPDATE ON referral_reward_rules
  FOR EACH ROW EXECUTE FUNCTION public.referral_rules_guard();

ALTER TABLE referral_reward_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rrr_select" ON referral_reward_rules;
CREATE POLICY "rrr_select" ON referral_reward_rules FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "rrr_insert" ON referral_reward_rules;
CREATE POLICY "rrr_insert" ON referral_reward_rules FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "rrr_update" ON referral_reward_rules;
CREATE POLICY "rrr_update" ON referral_reward_rules FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.identity_is_manager());

DROP POLICY IF EXISTS "rrr_delete" ON referral_reward_rules;
CREATE POLICY "rrr_delete" ON referral_reward_rules FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.identity_is_manager());

-- 2) Reward fields on conversions ---------------------------------------------------------------
ALTER TABLE referral_conversions
  ADD COLUMN IF NOT EXISTS reward_type text CHECK (reward_type IN ('credit', 'discount', 'cash')),
  ADD COLUMN IF NOT EXISTS reward_value numeric(10,2),
  ADD COLUMN IF NOT EXISTS reward_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS qualifying_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS rule_id uuid REFERENCES referral_reward_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rc_conversions_user_status ON referral_conversions(user_id, status);

CREATE OR REPLACE FUNCTION public.referral_conversions_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rpc boolean := coalesce(current_setting('vireek.referral_rpc', true), '') = 'on';
  v_rule referral_reward_rules%ROWTYPE;
  v_code referral_codes%ROWTYPE;
  v_prior integer;
  v_amount numeric(10,2);
BEGIN
  -- Guard: reward status and amounts change only through the payout RPCs.
  IF TG_OP = 'UPDATE' AND NOT v_rpc THEN
    IF (NEW.status IS DISTINCT FROM OLD.status AND (NEW.status = 'rewarded' OR OLD.status = 'rewarded'))
       OR NEW.rewarded_at IS DISTINCT FROM OLD.rewarded_at
       OR (OLD.reward_type IS NOT NULL AND (
            NEW.reward_type IS DISTINCT FROM OLD.reward_type
            OR NEW.reward_value IS DISTINCT FROM OLD.reward_value
            OR NEW.reward_amount IS DISTINCT FROM OLD.reward_amount
            OR NEW.qualifying_amount IS DISTINCT FROM OLD.qualifying_amount
            OR NEW.rule_id IS DISTINCT FROM OLD.rule_id)) THEN
      RAISE EXCEPTION 'Reward status and amounts are managed by the referral payout functions.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Price the reward the moment a referral converts.
  IF NEW.status = 'converted' AND NEW.reward_type IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'converted') THEN
    SELECT * INTO v_code FROM referral_codes WHERE id = NEW.referral_code_id;

    SELECT COALESCE(sum(invoice_amount), 0) INTO v_amount
    FROM jobs
    WHERE user_id = NEW.user_id AND customer_id = NEW.referred_customer_id AND invoice_status = 'paid';

    SELECT count(*) INTO v_prior
    FROM referral_conversions
    WHERE referral_code_id = NEW.referral_code_id
      AND status IN ('converted', 'rewarded')
      AND id <> NEW.id;

    SELECT * INTO v_rule
    FROM referral_reward_rules
    WHERE user_id = NEW.user_id AND is_active
      AND min_invoice_amount <= v_amount AND min_conversions <= v_prior
    ORDER BY min_conversions DESC, min_invoice_amount DESC, created_at DESC
    LIMIT 1;

    IF FOUND THEN
      NEW.rule_id := v_rule.id;
      NEW.reward_type := v_rule.reward_type;
      NEW.reward_value := v_rule.reward_value;
    ELSIF v_code.reward_value > 0 THEN
      NEW.reward_type := v_code.reward_type;
      NEW.reward_value := v_code.reward_value;
    END IF;

    NEW.qualifying_amount := v_amount;
    IF NEW.reward_type IN ('credit', 'cash') THEN
      NEW.reward_amount := NEW.reward_value;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_conversions_before_write ON referral_conversions;
CREATE TRIGGER trg_referral_conversions_before_write
  BEFORE INSERT OR UPDATE ON referral_conversions
  FOR EACH ROW EXECUTE FUNCTION public.referral_conversions_before_write();

-- Backfill: conversions that already happened keep the reward their code promised.
UPDATE referral_conversions cv
SET reward_type = rc.reward_type,
    reward_value = rc.reward_value,
    reward_amount = CASE WHEN rc.reward_type IN ('credit', 'cash') THEN rc.reward_value END
FROM referral_codes rc
WHERE rc.id = cv.referral_code_id
  AND cv.status IN ('converted', 'rewarded')
  AND cv.reward_type IS NULL
  AND rc.reward_value > 0;

-- 3) Payout ledger ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  referral_code_id uuid NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  conversion_id uuid NOT NULL REFERENCES referral_conversions(id) ON DELETE CASCADE,
  reward_type text NOT NULL,
  reward_value numeric(10,2) NOT NULL,
  amount numeric(10,2),
  method text NOT NULL,
  note text,
  paid_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT rp_type_check CHECK (reward_type IN ('credit', 'discount', 'cash')),
  CONSTRAINT rp_method_check CHECK (method IN (
    'account_credit', 'cash', 'check', 'bank_transfer', 'gift_card', 'invoice_discount', 'other'
  )),
  CONSTRAINT rp_note_check CHECK (note IS NULL OR char_length(note) <= 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rp_active_conversion ON referral_payouts(conversion_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rp_user_paid ON referral_payouts(user_id, paid_at DESC);

ALTER TABLE referral_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rp_select" ON referral_payouts;
CREATE POLICY "rp_select" ON referral_payouts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

REVOKE INSERT, UPDATE, DELETE ON referral_payouts FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_referral_payouts(
  p_conversion_ids uuid[],
  p_method text,
  p_note text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_count integer;
  v_expected integer;
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only account managers can record payouts.' USING ERRCODE = '42501';
  END IF;
  IF p_conversion_ids IS NULL OR cardinality(p_conversion_ids) = 0 OR cardinality(p_conversion_ids) > 100 THEN
    RAISE EXCEPTION 'Choose between 1 and 100 referrals.' USING ERRCODE = '22023';
  END IF;
  IF p_method NOT IN ('account_credit', 'cash', 'check', 'bank_transfer', 'gift_card', 'invoice_discount', 'other') THEN
    RAISE EXCEPTION 'Choose a payout method.' USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT x) INTO v_expected FROM unnest(p_conversion_ids) AS x;
  PERFORM set_config('vireek.referral_rpc', 'on', true);

  WITH eligible AS (
    SELECT cv.id, cv.referral_code_id, cv.reward_type, cv.reward_value, cv.reward_amount
    FROM referral_conversions cv
    WHERE cv.id = ANY (p_conversion_ids)
      AND cv.user_id = v_owner
      AND cv.status = 'converted'
      AND cv.reward_type IS NOT NULL
    FOR UPDATE
  ), ins AS (
    INSERT INTO referral_payouts (user_id, referral_code_id, conversion_id, reward_type, reward_value, amount, method, note)
    SELECT v_owner, e.referral_code_id, e.id, e.reward_type, e.reward_value, e.reward_amount,
           p_method, NULLIF(btrim(coalesce(p_note, '')), '')
    FROM eligible e
    RETURNING conversion_id
  ), upd AS (
    UPDATE referral_conversions cv
    SET status = 'rewarded', rewarded_at = now()
    FROM ins
    WHERE cv.id = ins.conversion_id
    RETURNING cv.id
  )
  SELECT count(*) INTO v_count FROM upd;

  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'Some of these referrals cannot be paid (already paid, not converted yet, or no reward set).'
      USING ERRCODE = '22023';
  END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_referral_payout(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_conversion uuid;
BEGIN
  IF NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Only account managers can void payouts.' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('vireek.referral_rpc', 'on', true);

  UPDATE referral_payouts
  SET voided_at = now(), voided_by = auth.uid()
  WHERE id = p_payout_id AND user_id = v_owner AND voided_at IS NULL
  RETURNING conversion_id INTO v_conversion;

  IF v_conversion IS NULL THEN
    RAISE EXCEPTION 'Payout not found or already voided.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE referral_conversions SET status = 'converted', rewarded_at = NULL WHERE id = v_conversion;
END;
$$;

REVOKE ALL ON FUNCTION public.record_referral_payouts(uuid[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_referral_payouts(uuid[], text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.void_referral_payout(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_referral_payout(uuid) TO authenticated;

-- 4) Read models (RLS of the caller applies) -------------------------------------------------------------
CREATE OR REPLACE VIEW referral_conversion_details WITH (security_invoker = true) AS
SELECT
  cv.id,
  cv.user_id,
  cv.referral_code_id,
  rc.code,
  rc.customer_id AS referrer_customer_id,
  rcust.name AS referrer_name,
  cv.referred_customer_id,
  refd.name AS referred_name,
  cv.status,
  cv.created_at,
  cv.converted_at,
  cv.rewarded_at,
  cv.reward_type,
  cv.reward_value,
  cv.reward_amount,
  cv.qualifying_amount,
  cv.rule_id,
  rp.id AS payout_id,
  rp.method AS payout_method,
  rp.paid_at AS payout_paid_at
FROM referral_conversions cv
JOIN referral_codes rc ON rc.id = cv.referral_code_id
LEFT JOIN customers rcust ON rcust.id = rc.customer_id
LEFT JOIN customers refd ON refd.id = cv.referred_customer_id
LEFT JOIN referral_payouts rp ON rp.conversion_id = cv.id AND rp.voided_at IS NULL;

GRANT SELECT ON referral_conversion_details TO authenticated;

CREATE OR REPLACE FUNCTION public.get_referral_leaderboard(p_days integer DEFAULT NULL)
RETURNS TABLE (
  referral_code_id uuid,
  code text,
  referrer_customer_id uuid,
  referrer_name text,
  clicks integer,
  conversions bigint,
  rewarded bigint,
  earned numeric,
  unpaid numeric,
  last_converted_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    rc.id,
    rc.code,
    rc.customer_id,
    c.name,
    rc.clicks,
    count(cv.id) FILTER (WHERE cv.status IN ('converted', 'rewarded')),
    count(cv.id) FILTER (WHERE cv.status = 'rewarded'),
    COALESCE(sum(cv.reward_amount) FILTER (WHERE cv.status = 'rewarded'), 0),
    COALESCE(sum(cv.reward_amount) FILTER (WHERE cv.status = 'converted'), 0),
    max(cv.converted_at)
  FROM referral_codes rc
  LEFT JOIN customers c ON c.id = rc.customer_id
  LEFT JOIN referral_conversions cv
    ON cv.referral_code_id = rc.id
   AND (p_days IS NULL OR cv.converted_at >= now() - make_interval(days => p_days))
  WHERE rc.user_id = public.get_account_owner_id()
  GROUP BY rc.id, c.name
$$;

GRANT EXECUTE ON FUNCTION public.get_referral_leaderboard(integer) TO authenticated;
