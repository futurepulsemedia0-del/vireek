/*
  # Maintenance-agreement renewal workflow

  ## Why
  memberships (20260912030000) + the lifecycle OS (20261105000000) already
  bill a renewal invoice, roll the period, flag past_due and churn. What was
  missing is the *proactive* part that decides whether a renewal happens:

    - a 60 / 30 / 7-day pipeline with a record per renewal (one row per
      membership per renewal date) so renewal rate is measurable,
    - a renewal quote the customer can review / accept / decline,
    - auto-renew against a card on file (off-session), with retries,
    - non-renewing members closed out at period end and fed into the existing
      win-back playbook (membership.churned) and recovery ledger,
    - a renewal-rate KPI for the Overview.

  Everything reuses what exists: memberships, membership_plans,
  payment_requests (the money ledger), revenue_recovery_events,
  membership-lifecycle-agent (daily cron) and the workflow engine. No new
  cron, no new Stripe webhook, no parallel Stripe Subscriptions object.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy membership-lifecycle-agent public-payment stripe-payment-webhook --no-verify-jwt
       (public-payment / stripe-payment-webhook only if you applied the card-on-file edits)
    3. Apply the code edits delivered alongside this migration.
    4. Re-install the "Membership Win-Back" playbook (Workflows -> Playbooks)
       so the new multi-step sequence replaces your installed copy.
*/

-- =============================================================
-- 1. memberships — card on file + explicit auto-charge consent
-- =============================================================

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text,
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS card_last4 text,
  ADD COLUMN IF NOT EXISTS card_exp_month smallint CHECK (card_exp_month IS NULL OR card_exp_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS card_exp_year smallint,
  ADD COLUMN IF NOT EXISTS auto_renew_consent_at timestamptz;

-- Optional renewal price. NULL = renew at the plan's current price.
ALTER TABLE membership_plans
  ADD COLUMN IF NOT EXISTS renewal_price_cents integer
    CHECK (renewal_price_cents IS NULL OR renewal_price_cents >= 0);

-- =============================================================
-- 2. membership_renewal_cycles — one row per membership per renewal date
-- =============================================================

CREATE TABLE IF NOT EXISTS membership_renewal_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES membership_plans(id) ON DELETE SET NULL,
  -- The renewal date this cycle is for (= memberships.current_period_end when created).
  period_end timestamptz NOT NULL,
  stage text NOT NULL DEFAULT 'upcoming_60'
    CHECK (stage IN ('upcoming_60', 'upcoming_30', 'upcoming_7', 'due', 'past_due', 'renewed', 'lapsed', 'cancelled')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  previous_amount_cents integer NOT NULL CHECK (previous_amount_cents >= 0),
  payment_route text NOT NULL DEFAULT 'pay_link'
    CHECK (payment_route IN ('card_on_file', 'pay_link')),
  -- Renewal quote: the customer-facing renewal offer at /renew/:quote_token.
  quote_token uuid NOT NULL DEFAULT gen_random_uuid(),
  quote_status text NOT NULL DEFAULT 'sent'
    CHECK (quote_status IN ('sent', 'accepted', 'declined')),
  quote_responded_at timestamptz,
  notices_sent text[] NOT NULL DEFAULT '{}',
  charge_attempts integer NOT NULL DEFAULT 0 CHECK (charge_attempts >= 0),
  last_charge_attempt_at timestamptz,
  last_charge_error text,
  payment_request_id uuid REFERENCES payment_requests(id) ON DELETE SET NULL,
  outcome text CHECK (outcome IS NULL OR outcome IN ('renewed', 'lapsed', 'cancelled')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, period_end)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_cycles_quote_token ON membership_renewal_cycles(quote_token);
CREATE INDEX IF NOT EXISTS idx_renewal_cycles_user_open ON membership_renewal_cycles(user_id, period_end) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_renewal_cycles_user_resolved ON membership_renewal_cycles(user_id, resolved_at) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_renewal_cycles_membership ON membership_renewal_cycles(membership_id);

ALTER TABLE membership_renewal_cycles ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner: cycles are written by the lifecycle agent (service role)
-- and the token-gated RPC below, never directly from the browser.
DROP POLICY IF EXISTS "select_own_membership_renewal_cycles" ON membership_renewal_cycles;
CREATE POLICY "select_own_membership_renewal_cycles" ON membership_renewal_cycles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- =============================================================
-- 3. Keep cycles in step with the membership (any writer: agent,
--    webhook, dashboard) — closes the cycle with the right outcome.
-- =============================================================

CREATE OR REPLACE FUNCTION public.sync_renewal_cycle_on_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active'
     AND OLD.current_period_end IS NOT NULL
     AND NEW.current_period_end IS NOT NULL
     AND NEW.current_period_end > OLD.current_period_end THEN
    -- Period rolled forward = renewed.
    UPDATE membership_renewal_cycles
    SET stage = 'renewed', outcome = 'renewed', resolved_at = now(), updated_at = now()
    WHERE membership_id = NEW.id AND outcome IS NULL AND period_end <= NEW.current_period_end;
  ELSIF NEW.status = 'churned' AND OLD.status IS DISTINCT FROM 'churned' THEN
    UPDATE membership_renewal_cycles
    SET stage = 'lapsed', outcome = 'lapsed', resolved_at = now(), updated_at = now()
    WHERE membership_id = NEW.id AND outcome IS NULL;
  ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE membership_renewal_cycles
    SET stage = 'cancelled', outcome = 'cancelled', resolved_at = now(), updated_at = now()
    WHERE membership_id = NEW.id AND outcome IS NULL;
  ELSIF NEW.status = 'past_due' AND OLD.status IS DISTINCT FROM 'past_due' THEN
    UPDATE membership_renewal_cycles
    SET stage = 'past_due', updated_at = now()
    WHERE membership_id = NEW.id AND outcome IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_renewal_cycle_on_membership_change ON memberships;
CREATE TRIGGER trg_sync_renewal_cycle_on_membership_change
  AFTER UPDATE OF status, current_period_end ON memberships
  FOR EACH ROW EXECUTE FUNCTION public.sync_renewal_cycle_on_membership_change();

-- =============================================================
-- 4. Public renewal quote (token-gated, same model as get_quote_for_token)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_membership_renewal_for_token(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'business_name', p.company_name,
    'plan_name', pl.name,
    'customer_first_name', split_part(m.customer_name, ' ', 1),
    'billing_interval', pl.billing_interval,
    'benefits', COALESCE(to_jsonb(pl.benefits), '[]'::jsonb),
    'period_end', c.period_end,
    'amount_cents', c.amount_cents,
    'previous_amount_cents', c.previous_amount_cents,
    'quote_status', c.quote_status,
    'outcome', c.outcome,
    'auto_renew', m.auto_renew,
    'card_brand', CASE WHEN c.payment_route = 'card_on_file' THEN m.card_brand END,
    'card_last4', CASE WHEN c.payment_route = 'card_on_file' THEN m.card_last4 END,
    'pay_token', CASE WHEN pr.status IN ('sent', 'overdue', 'failed') THEN pr.public_token END
  )
  FROM membership_renewal_cycles c
  JOIN memberships m ON m.id = c.membership_id
  LEFT JOIN membership_plans pl ON pl.id = c.plan_id
  LEFT JOIN profiles p ON p.id = c.user_id
  LEFT JOIN payment_requests pr ON pr.id = m.last_payment_request_id AND m.current_period_end = c.period_end
  WHERE c.quote_token = p_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_membership_renewal_for_token(uuid) TO anon, authenticated;

-- The only write path a customer gets: accept (keep / re-enable auto-renew) or
-- decline (membership runs to the end of the paid period, then closes and enters win-back).
CREATE OR REPLACE FUNCTION public.respond_to_membership_renewal(p_token uuid, p_action text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle membership_renewal_cycles%ROWTYPE;
BEGIN
  IF p_action NOT IN ('accept', 'decline') THEN
    RETURN 'invalid_action';
  END IF;

  SELECT * INTO v_cycle FROM membership_renewal_cycles WHERE quote_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_cycle.outcome IS NOT NULL OR v_cycle.period_end <= now() THEN RETURN 'closed'; END IF;

  UPDATE membership_renewal_cycles
  SET quote_status = CASE WHEN p_action = 'accept' THEN 'accepted' ELSE 'declined' END,
      quote_responded_at = now(),
      updated_at = now()
  WHERE id = v_cycle.id;

  UPDATE memberships
  SET auto_renew = (p_action = 'accept')
  WHERE id = v_cycle.membership_id AND status IN ('active', 'past_due');

  RETURN CASE WHEN p_action = 'accept' THEN 'accepted' ELSE 'declined' END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_membership_renewal(uuid, text) TO anon, authenticated;

-- =============================================================
-- 5. Renewal KPIs (owner-scoped through RLS — SECURITY INVOKER)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_membership_renewal_kpis(p_window_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_window_days, 90), 730)));
  v_renewed integer; v_lapsed integer; v_cancelled integer;
  v_open_cycles integer; v_open_cycles_cents bigint; v_at_risk_cents bigint;
  v_active integer; v_card integer; v_recovered bigint; v_open bigint;
BEGIN
  SELECT count(*) FILTER (WHERE outcome = 'renewed'),
         count(*) FILTER (WHERE outcome = 'lapsed'),
         count(*) FILTER (WHERE outcome = 'cancelled')
    INTO v_renewed, v_lapsed, v_cancelled
  FROM membership_renewal_cycles
  WHERE user_id = auth.uid() AND outcome IS NOT NULL AND resolved_at >= v_since;

  SELECT count(*), COALESCE(sum(amount_cents), 0)
    INTO v_open_cycles, v_open_cycles_cents
  FROM membership_renewal_cycles
  WHERE user_id = auth.uid() AND outcome IS NULL;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_at_risk_cents
  FROM membership_renewal_cycles
  WHERE user_id = auth.uid() AND outcome IS NULL
    AND (stage = 'past_due' OR quote_status = 'declined' OR (payment_route = 'pay_link' AND stage IN ('upcoming_7', 'due')));

  SELECT count(*) FILTER (WHERE status = 'active'),
         count(*) FILTER (WHERE status = 'active' AND auto_renew AND stripe_payment_method_id IS NOT NULL AND auto_renew_consent_at IS NOT NULL)
    INTO v_active, v_card
  FROM memberships WHERE user_id = auth.uid();

  SELECT COALESCE(sum(recovered_amount_cents), 0) INTO v_recovered
  FROM revenue_recovery_events
  WHERE user_id = auth.uid() AND source_table = 'memberships' AND status = 'recovered' AND resolved_at >= v_since;

  SELECT COALESCE(sum(estimated_value_cents), 0) INTO v_open
  FROM revenue_recovery_events
  WHERE user_id = auth.uid() AND source_table = 'memberships' AND status IN ('open', 'contacted');

  RETURN jsonb_build_object(
    'window_days', GREATEST(1, LEAST(COALESCE(p_window_days, 90), 730)),
    'renewed', v_renewed,
    'lapsed', v_lapsed,
    'cancelled', v_cancelled,
    'renewal_rate', CASE WHEN v_renewed + v_lapsed + v_cancelled = 0 THEN NULL
                         ELSE round(v_renewed::numeric * 100 / (v_renewed + v_lapsed + v_cancelled), 1) END,
    'open_cycles', v_open_cycles,
    'open_cycles_cents', v_open_cycles_cents,
    'at_risk_cents', v_at_risk_cents,
    'active_members', v_active,
    'auto_charge_ready', v_card,
    'winback_recovered_cents', v_recovered,
    'winback_open_cents', v_open
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_membership_renewal_kpis(integer) TO authenticated;
