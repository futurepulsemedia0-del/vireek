/*
  # Follow-up to 20290303000000_usage_ledger_overage_topups.sql

  Closes the two risks the first migration documented:

  1. Refund / dispute of a top-up pack
     topup_credits gets reversed_minutes + clawback_shortfall_minutes and reverse_topup() claws the
     minutes back from profiles.bonus_minutes. Idempotent: it works on the CUMULATIVE refunded amount
     (Stripe charge.amount_refunded), so replays and partial-then-full refunds converge.
     If the customer already spent the minutes, the balance floors at 0 and the unrecoverable part is
     recorded in clawback_shortfall_minutes for staff.

  2. Scheduled downgrade at the renewal boundary (race between customer.subscription.updated and
     invoice.created)
     profiles.usage_period_plan = the plan that was in force for the period that is currently running
     (written by the webhook from the Stripe invoice lines). The webhook closes a period with the
     HIGHER-ranked of (usage_period_plan, profiles.plan): never a lower plan's allowance or a higher rate
     for usage that happened on a better plan. period_rollover() therefore takes an optional
     included-minutes override and the plan to start the next period with.

  ## Rollback (manual)
    DROP FUNCTION IF EXISTS public.reverse_topup(text, bigint, text);
    -- restore the 7-argument period_rollover from 20290303000000 if you need the old behaviour.
    -- ALTER TABLE public.topup_credits DROP COLUMN reversed_minutes, DROP COLUMN clawback_shortfall_minutes;
    -- ALTER TABLE public.profiles DROP COLUMN usage_period_plan;
*/

-- =====================================================================================================
-- 1) Plan snapshot of the running period
-- =====================================================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS usage_period_plan text;

COMMENT ON COLUMN public.profiles.usage_period_plan IS
  'Plan that was in force for the usage period that is currently running. Written by stripe-webhook (invoice.created) / period_rollover only.';

-- Existing paying accounts: the running period is on their current plan.
UPDATE public.profiles
   SET usage_period_plan = plan
 WHERE stripe_subscription_id IS NOT NULL
   AND usage_period_plan IS NULL;

-- The snapshot is a billing column: not client-writable (same trigger as before, one more column).
CREATE OR REPLACE FUNCTION public.protect_profile_billing_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND current_user IN ('authenticated', 'anon') THEN
    IF NEW.bonus_minutes             IS DISTINCT FROM OLD.bonus_minutes
       OR NEW.usage_period_plan       IS DISTINCT FROM OLD.usage_period_plan
       OR NEW.stripe_customer_id      IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id  IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.minutes_included        IS DISTINCT FROM OLD.minutes_included
       OR NEW.minutes_used_this_month IS DISTINCT FROM OLD.minutes_used_this_month
       OR NEW.plan                    IS DISTINCT FROM OLD.plan
       OR NEW.subscription_status     IS DISTINCT FROM OLD.subscription_status
    THEN
      RAISE EXCEPTION 'billing columns cannot be changed from the client' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- =====================================================================================================
-- 2) period_rollover v2 (adds the included-minutes override and the next period's plan)
-- =====================================================================================================
DROP FUNCTION IF EXISTS public.period_rollover(uuid, text, timestamptz, timestamptz, text, integer, text);

CREATE OR REPLACE FUNCTION public.period_rollover(
  p_user              uuid,
  p_period_key        text,
  p_period_start      timestamptz,
  p_period_end        timestamptz,
  p_plan_id           text,        -- plan the CLOSING period is billed on (decided by the webhook)
  p_rate_cents        integer,
  p_currency          text,
  p_included_override integer,     -- NULL = use profiles.minutes_included (keeps custom/results-plan minutes)
  p_next_plan         text         -- plan the NEW period starts on (from the Stripe invoice lines); NULL = unchanged
)
RETURNS public.usage_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prof     record;
  v_row      public.usage_periods;
  v_policy   text;
  v_calls    integer;
  v_used     integer;
  v_included integer;
  v_gross    integer;
  v_bonus    integer := 0;
  v_overage  integer;
  v_amount   bigint;
  v_status   text;
  v_currency text := lower(coalesce(p_currency, ''));
  v_billable boolean;
BEGIN
  IF p_user IS NULL OR p_period_key IS NULL OR length(p_period_key) = 0
     OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    RAISE EXCEPTION 'period_rollover: invalid arguments' USING ERRCODE = '22023';
  END IF;
  IF p_rate_cents IS NOT NULL AND p_rate_cents < 0 THEN
    RAISE EXCEPTION 'period_rollover: invalid rate' USING ERRCODE = '22023';
  END IF;
  IF p_included_override IS NOT NULL AND p_included_override < 0 THEN
    RAISE EXCEPTION 'period_rollover: invalid included override' USING ERRCODE = '22023';
  END IF;

  SELECT id,
         COALESCE(minutes_used_this_month, 0) AS used,
         COALESCE(minutes_included, 0)        AS included,
         COALESCE(bonus_minutes, 0)           AS bonus
    INTO v_prof
    FROM public.profiles
   WHERE id = p_user
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'period_rollover: profile not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_row FROM public.usage_periods WHERE user_id = p_user AND period_key = p_period_key;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  SELECT COALESCE(SUM(CEIL(c.usage_billed_seconds / 60.0)), 0)::integer
    INTO v_calls
    FROM public.calls c
   WHERE c.user_id = p_user
     AND c.call_datetime >= p_period_start
     AND c.call_datetime <  p_period_end;

  v_used     := LEAST(v_prof.used, v_calls);
  v_included := COALESCE(p_included_override, v_prof.included);

  IF v_included <= 0 THEN
    v_gross := 0;                                   -- included <= 0 means "unlimited" in the product
  ELSE
    v_gross := GREATEST(v_used - v_included, 0);
  END IF;

  SELECT paid_overage_policy INTO v_policy FROM public.fraud_settings WHERE id = true;
  v_policy := COALESCE(v_policy, 'allow');

  v_billable := (v_policy = 'bill' AND p_rate_cents IS NOT NULL AND v_currency = 'usd');
  IF v_billable THEN
    v_bonus := LEAST(v_prof.bonus, v_gross);
  END IF;

  v_overage := v_gross - v_bonus;
  v_amount  := v_overage::bigint * COALESCE(p_rate_cents, 0);

  v_status := CASE
    WHEN v_overage = 0          THEN 'skipped_zero'
    WHEN v_policy <> 'bill'     THEN 'skipped_policy'
    WHEN p_rate_cents IS NULL   THEN 'skipped_no_rate'
    WHEN v_currency <> 'usd'    THEN 'skipped_currency'
    ELSE 'pending'
  END;

  INSERT INTO public.usage_periods (
    user_id, period_key, period_start, period_end, plan_id, included_minutes,
    used_counter_minutes, used_calls_minutes, used_minutes, gross_overage_minutes,
    bonus_applied_minutes, overage_minutes, rate_cents, amount_cents, currency, billing_status
  ) VALUES (
    p_user, p_period_key, p_period_start, p_period_end, p_plan_id, v_included,
    GREATEST(v_prof.used, 0), v_calls, v_used, v_gross,
    v_bonus, v_overage, p_rate_cents, v_amount, NULLIF(v_currency, ''), v_status
  )
  RETURNING * INTO v_row;

  UPDATE public.profiles
     SET minutes_used_this_month = (
           SELECT COALESCE(SUM(CEIL(c.usage_billed_seconds / 60.0)), 0)::integer
             FROM public.calls c
            WHERE c.user_id = p_user AND c.call_datetime >= p_period_end
         ),
         bonus_minutes     = bonus_minutes - v_bonus,
         usage_period_plan = COALESCE(p_next_plan, usage_period_plan)
   WHERE id = p_user;

  RETURN v_row;
END;
$$;

-- =====================================================================================================
-- 3) Top-up reversal (refund / dispute)
-- =====================================================================================================
ALTER TABLE public.topup_credits
  ADD COLUMN IF NOT EXISTS reversed_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clawback_shortfall_minutes integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topup_credits_reversal_bounds') THEN
    ALTER TABLE public.topup_credits
      ADD CONSTRAINT topup_credits_reversal_bounds
      CHECK (reversed_minutes >= 0 AND reversed_minutes <= minutes AND clawback_shortfall_minutes >= 0 AND clawback_shortfall_minutes <= reversed_minutes);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_topup_credits_payment_intent
  ON public.topup_credits (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON COLUMN public.topup_credits.clawback_shortfall_minutes IS
  'Minutes that had to be reversed (refund/dispute) but were already spent; staff decide how to handle them.';

CREATE OR REPLACE FUNCTION public.reverse_topup(
  p_payment_intent   text,
  p_refunded_cents   bigint,     -- CUMULATIVE refunded/disputed amount for the payment (Stripe charge.amount_refunded)
  p_reason           text
)
RETURNS text                    -- 'reversed' | 'noop' | 'not_topup'
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row    public.topup_credits;
  v_target integer;
  v_delta  integer;
  v_take   integer;
  v_bonus  integer;
BEGIN
  IF p_payment_intent IS NULL OR length(p_payment_intent) = 0 OR p_refunded_cents IS NULL OR p_refunded_cents < 0 THEN
    RAISE EXCEPTION 'reverse_topup: invalid arguments' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.topup_credits
   WHERE stripe_payment_intent_id = p_payment_intent AND status = 'credited'
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_topup';
  END IF;

  IF v_row.amount_cents IS NULL OR v_row.amount_cents <= 0 OR p_refunded_cents >= v_row.amount_cents THEN
    v_target := v_row.minutes;                                   -- full refund (or unknown amount): reverse everything
  ELSE
    v_target := LEAST(v_row.minutes, FLOOR(v_row.minutes::numeric * p_refunded_cents / v_row.amount_cents)::integer);
  END IF;

  v_delta := v_target - v_row.reversed_minutes;
  IF v_delta <= 0 THEN
    RETURN 'noop';                                               -- replay, or refund total did not grow
  END IF;

  SELECT COALESCE(bonus_minutes, 0) INTO v_bonus FROM public.profiles WHERE id = v_row.user_id FOR UPDATE;
  v_take := LEAST(COALESCE(v_bonus, 0), v_delta);

  IF v_take > 0 THEN
    UPDATE public.profiles SET bonus_minutes = bonus_minutes - v_take WHERE id = v_row.user_id;
  END IF;

  UPDATE public.topup_credits
     SET reversed_minutes = v_target,
         clawback_shortfall_minutes = clawback_shortfall_minutes + (v_delta - v_take),
         reason = COALESCE(left(p_reason, 200), reason)
   WHERE id = v_row.id;

  RETURN 'reversed';
END;
$$;

REVOKE ALL ON FUNCTION public.period_rollover(uuid, text, timestamptz, timestamptz, text, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_topup(text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.period_rollover(uuid, text, timestamptz, timestamptz, text, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_topup(text, bigint, text) TO service_role;
