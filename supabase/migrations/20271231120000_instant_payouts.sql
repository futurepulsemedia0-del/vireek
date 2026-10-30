/*
  # Instant payouts (Stripe Connect Express)

  Lets an account owner / admin move their available Stripe balance to their
  debit card or instant-capable bank account in minutes instead of waiting for
  the normal payout schedule.

  - instant_payouts: one row per payout request. Money is integer cents.
    Clients can only READ it (owner / admin of the account). Every write goes
    through the SECURITY DEFINER functions below, which only the service role
    (the instant-payouts edge function and the Stripe webhook) can execute.
  - Double-payout protection: (user_id, idempotency_key) is unique, and a
    partial unique index allows only ONE row per account in the 'pending'
    (reserved, not yet confirmed by Stripe) state at a time.
  - Audit trail: every lifecycle step writes to the existing audit_log table
    inside the same transaction as the state change.
  - Open disputes pause instant payouts (the platform is liable for negative
    balances on money that already left): instant_payout_has_open_dispute().
*/

CREATE TABLE IF NOT EXISTS instant_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  requested_by uuid,
  requested_by_email text,
  stripe_account_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  currency text NOT NULL DEFAULT 'usd',
  destination_id text,
  destination_label text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  stripe_payout_id text UNIQUE,
  failure_code text,
  failure_message text,
  arrival_date timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instant_payouts_user_key_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_instant_payouts_user_created
  ON instant_payouts (user_id, created_at DESC);

-- At most one reserved-but-unconfirmed payout per account: kills double-click / double-tab races.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_instant_payouts_one_pending_per_account
  ON instant_payouts (user_id) WHERE status = 'pending';

ALTER TABLE instant_payouts ENABLE ROW LEVEL SECURITY;

-- Read: the account owner, or a team member whose role is owner/admin. Nobody can write directly.
DROP POLICY IF EXISTS "managers_select_instant_payouts" ON instant_payouts;
CREATE POLICY "managers_select_instant_payouts" ON instant_payouts
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (
      auth.uid() = user_id
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.user_id = auth.uid() AND tm.role IN ('owner', 'admin')
      )
    )
  );

REVOKE INSERT, UPDATE, DELETE ON instant_payouts FROM anon, authenticated;
REVOKE ALL ON instant_payouts FROM anon;

DROP TRIGGER IF EXISTS trigger_instant_payouts_updated_at ON instant_payouts;
CREATE TRIGGER trigger_instant_payouts_updated_at
  BEFORE UPDATE ON instant_payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- Open-dispute check (fail-open on schema drift, never breaks payouts)
-- =============================================================
CREATE OR REPLACE FUNCTION public.instant_payout_has_open_dispute(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open boolean := false;
BEGIN
  IF to_regclass('public.stripe_disputes') IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.stripe_disputes WHERE user_id = $1 AND closed_at IS NULL)'
      INTO v_open USING p_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE WARNING 'instant_payout_has_open_dispute: stripe_disputes schema differs, treating as no open dispute';
    v_open := false;
  END;
  RETURN COALESCE(v_open, false);
END;
$$;

-- =============================================================
-- Internal audit helper (same table/columns log_audit_event writes)
-- =============================================================
CREATE OR REPLACE FUNCTION public._instant_payout_audit(
  p_user_id uuid, p_actor_id uuid, p_actor_email text, p_action text, p_target_id text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.audit_log (user_id, actor_id, actor_email, action, target_table, target_id)
  VALUES (p_user_id, p_actor_id, p_actor_email, p_action, 'instant_payouts', p_target_id);
$$;

-- =============================================================
-- 1) Reserve: idempotent, serialized per account
-- =============================================================
CREATE OR REPLACE FUNCTION public.instant_payout_reserve(
  p_user_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_stripe_account_id text,
  p_idempotency_key text,
  p_amount_cents bigint,
  p_fee_cents bigint,
  p_currency text,
  p_destination_id text,
  p_destination_label text
)
RETURNS public.instant_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.instant_payouts;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payout amount must be greater than zero.' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize everything for this account so the checks below cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('instant_payout:' || p_user_id::text, 0));

  -- Replay of the same request (double click, retry after a dropped connection): return the original row.
  SELECT * INTO v_row FROM public.instant_payouts
  WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- A reservation that never reached Stripe and is older than Stripe's 24h idempotency window is dead.
  -- (If Stripe did create it, the payout webhook still reconciles it by id and flips it back.)
  UPDATE public.instant_payouts
  SET status = 'failed',
      failure_code = 'abandoned',
      failure_message = 'This request was never confirmed by Stripe and was closed automatically.',
      completed_at = now()
  WHERE user_id = p_user_id AND status = 'pending'
    AND stripe_payout_id IS NULL AND created_at < now() - interval '24 hours';

  IF EXISTS (SELECT 1 FROM public.instant_payouts WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'Another instant payout is still being processed. Check back in a minute.' USING ERRCODE = 'P0001';
  END IF;

  IF public.instant_payout_has_open_dispute(p_user_id) THEN
    RAISE EXCEPTION 'Instant payouts are paused while you have an open dispute.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.instant_payouts (
    user_id, requested_by, requested_by_email, stripe_account_id, idempotency_key,
    amount_cents, fee_cents, currency, destination_id, destination_label
  ) VALUES (
    p_user_id, p_actor_id, p_actor_email, p_stripe_account_id, p_idempotency_key,
    p_amount_cents, GREATEST(COALESCE(p_fee_cents, 0), 0), lower(COALESCE(p_currency, 'usd')),
    p_destination_id, p_destination_label
  )
  RETURNING * INTO v_row;

  PERFORM public._instant_payout_audit(p_user_id, p_actor_id, p_actor_email, 'instant_payout_requested', v_row.id::text);
  RETURN v_row;
END;
$$;

-- =============================================================
-- 2) Stripe accepted the payout
-- =============================================================
CREATE OR REPLACE FUNCTION public.instant_payout_mark_sent(
  p_id uuid,
  p_stripe_payout_id text,
  p_status text,
  p_fee_cents bigint,
  p_arrival timestamptz
)
RETURNS public.instant_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.instant_payouts;
  v_first boolean;
BEGIN
  IF p_status NOT IN ('in_transit', 'paid', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'Invalid payout status.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM public.instant_payouts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instant payout not found.' USING ERRCODE = 'P0001';
  END IF;

  v_first := v_row.stripe_payout_id IS NULL;

  -- Never move a row backwards (the webhook may already have said "paid").
  UPDATE public.instant_payouts SET
    stripe_payout_id = COALESCE(stripe_payout_id, p_stripe_payout_id),
    status = CASE
      WHEN status IN ('paid', 'failed', 'canceled') AND failure_code IS DISTINCT FROM 'abandoned' THEN status
      ELSE p_status
    END,
    fee_cents = COALESCE(p_fee_cents, fee_cents),
    arrival_date = COALESCE(p_arrival, arrival_date),
    failure_code = CASE WHEN p_status IN ('in_transit', 'paid') THEN NULL ELSE failure_code END,
    failure_message = CASE WHEN p_status IN ('in_transit', 'paid') THEN NULL ELSE failure_message END,
    completed_at = CASE
      WHEN p_status IN ('paid', 'failed', 'canceled') THEN COALESCE(completed_at, now())
      ELSE NULL
    END
  WHERE id = p_id
  RETURNING * INTO v_row;

  IF v_first THEN
    PERFORM public._instant_payout_audit(v_row.user_id, v_row.requested_by, v_row.requested_by_email, 'instant_payout_sent', v_row.id::text);
  END IF;
  RETURN v_row;
END;
$$;

-- =============================================================
-- 3) Stripe definitively refused the payout (no payout exists)
-- =============================================================
CREATE OR REPLACE FUNCTION public.instant_payout_mark_failed(
  p_id uuid,
  p_failure_code text,
  p_failure_message text
)
RETURNS public.instant_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.instant_payouts;
BEGIN
  UPDATE public.instant_payouts SET
    status = 'failed',
    failure_code = left(COALESCE(p_failure_code, 'stripe_error'), 100),
    failure_message = left(COALESCE(p_failure_message, 'Stripe could not complete this payout.'), 300),
    completed_at = now()
  WHERE id = p_id AND status = 'pending' AND stripe_payout_id IS NULL
  RETURNING * INTO v_row;

  IF FOUND THEN
    PERFORM public._instant_payout_audit(v_row.user_id, v_row.requested_by, v_row.requested_by_email, 'instant_payout_failed', v_row.id::text);
  ELSE
    SELECT * INTO v_row FROM public.instant_payouts WHERE id = p_id;
  END IF;
  RETURN v_row;
END;
$$;

-- =============================================================
-- 4) Webhook: payout.updated / paid / failed / canceled
--    Returns NULL for payouts we did not create (normal scheduled payouts).
-- =============================================================
CREATE OR REPLACE FUNCTION public.instant_payout_apply_stripe_update(
  p_stripe_payout_id text,
  p_stripe_account_id text,
  p_instant_payout_id uuid,
  p_status text,
  p_failure_code text,
  p_failure_message text,
  p_arrival timestamptz,
  p_fee_cents bigint
)
RETURNS public.instant_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.instant_payouts;
  v_old_rank int;
  v_new_rank int;
  v_old_status text;
  v_apply boolean;
BEGIN
  IF p_status NOT IN ('in_transit', 'paid', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'Invalid payout status.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM public.instant_payouts
  WHERE stripe_payout_id = p_stripe_payout_id
  FOR UPDATE;

  IF NOT FOUND AND p_instant_payout_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.instant_payouts
    WHERE id = p_instant_payout_id AND stripe_account_id = p_stripe_account_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.stripe_account_id IS DISTINCT FROM p_stripe_account_id THEN
    RETURN NULL;
  END IF;

  v_old_status := v_row.status;
  v_old_rank := CASE v_row.status WHEN 'pending' THEN 0 WHEN 'in_transit' THEN 1 ELSE 2 END;
  v_new_rank := CASE p_status WHEN 'in_transit' THEN 1 ELSE 2 END;
  v_apply := v_new_rank > v_old_rank
    OR (p_status = 'failed' AND v_row.status = 'paid')            -- bank returned the funds after "paid"
    OR v_row.failure_code IS NOT DISTINCT FROM 'abandoned'         -- we closed it early; Stripe is the source of truth
    OR v_row.status = p_status;                                    -- duplicate delivery: refresh details only

  IF NOT COALESCE(v_apply, false) THEN
    RETURN v_row;
  END IF;

  UPDATE public.instant_payouts SET
    stripe_payout_id = COALESCE(stripe_payout_id, p_stripe_payout_id),
    status = p_status,
    fee_cents = COALESCE(p_fee_cents, fee_cents),
    arrival_date = COALESCE(p_arrival, arrival_date),
    failure_code = CASE WHEN p_status IN ('failed', 'canceled') THEN left(COALESCE(p_failure_code, 'payout_failed'), 100) ELSE NULL END,
    failure_message = CASE WHEN p_status IN ('failed', 'canceled') THEN left(COALESCE(p_failure_message, 'The payout did not complete.'), 300) ELSE NULL END,
    completed_at = CASE WHEN p_status IN ('paid', 'failed', 'canceled') THEN COALESCE(completed_at, now()) ELSE NULL END
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  -- Audit only real transitions (duplicate webhook deliveries stay silent).
  IF v_old_status IS DISTINCT FROM v_row.status AND v_row.status IN ('paid', 'failed', 'canceled') THEN
    PERFORM public._instant_payout_audit(
      v_row.user_id, NULL, NULL,
      CASE v_row.status WHEN 'paid' THEN 'instant_payout_paid' ELSE 'instant_payout_failed' END,
      v_row.id::text
    );
  END IF;

  RETURN v_row;
END;
$$;

-- =============================================================
-- Privileges: the state machine is service-role only.
-- =============================================================
REVOKE ALL ON FUNCTION public.instant_payout_has_open_dispute(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._instant_payout_audit(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instant_payout_reserve(uuid, uuid, text, text, text, bigint, bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instant_payout_mark_sent(uuid, text, text, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instant_payout_mark_failed(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instant_payout_apply_stripe_update(text, text, uuid, text, text, text, timestamptz, bigint) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.instant_payout_has_open_dispute(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.instant_payout_reserve(uuid, uuid, text, text, text, bigint, bigint, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.instant_payout_mark_sent(uuid, text, text, bigint, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.instant_payout_mark_failed(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.instant_payout_apply_stripe_update(text, text, uuid, text, text, text, timestamptz, bigint) TO service_role;
