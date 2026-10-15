/*
  # Priority Call Queue — outcome log

  The queue itself is computed from tables that already exist (revenue
  recovery ledger, quotes, invoices, memberships, calls, call_feedback and
  today's next_best_actions). This migration only adds what was missing:
  a durable record of what happened when someone worked an item.

  1. call_queue_outcomes        append-only log, one row per attempt.
  2. log_call_queue_outcome()   the ONLY write path (SECURITY DEFINER):
                                logs the attempt, keeps the recovery ledger
                                in sync, stamps customers.last_contacted_at
                                and adds a DNC suppression when asked.

  Purely additive. NOTE: rename the timestamp if it does not sort AFTER
  your newest migration.
*/

CREATE TABLE IF NOT EXISTS call_queue_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                       -- ACCOUNT OWNER id (get_account_owner_id())
  item_key text NOT NULL CHECK (char_length(item_key) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK (reason IN (
    'callback', 'abandoned_booking', 'unpaid_invoice', 'quote_followup',
    'expiring_membership', 'unhappy_customer', 'churn_risk'
  )),
  source_table text,
  source_id uuid,
  customer_name text,
  customer_phone text,
  outcome text NOT NULL CHECK (outcome IN (
    'reached_booked', 'reached_resolved', 'reached_follow_up', 'no_answer',
    'left_voicemail', 'texted', 'not_interested', 'wrong_number', 'do_not_contact'
  )),
  channel text NOT NULL DEFAULT 'call' CHECK (channel IN ('call', 'sms', 'none')),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  snooze_until timestamptz,
  value_cents integer CHECK (value_cents IS NULL OR value_cents >= 0),
  performed_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_queue_outcomes_item
  ON call_queue_outcomes(user_id, item_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_queue_outcomes_recent
  ON call_queue_outcomes(user_id, created_at DESC);

ALTER TABLE call_queue_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_call_queue_outcomes" ON call_queue_outcomes;
CREATE POLICY "select_own_call_queue_outcomes" ON call_queue_outcomes
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policy: the log is append-only and written solely
-- through log_call_queue_outcome(), so history cannot be forged or erased.

CREATE OR REPLACE FUNCTION public.log_call_queue_outcome(
  p_item_key text,
  p_reason text,
  p_source_table text,
  p_source_id uuid,
  p_customer_name text,
  p_phone text,
  p_outcome text,
  p_channel text DEFAULT 'call',
  p_note text DEFAULT NULL,
  p_snooze_until timestamptz DEFAULT NULL,
  p_value_cents integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_id uuid;
  v_digits text;
  v_e164 text;
  v_ledger_status text;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  INSERT INTO call_queue_outcomes (
    user_id, item_key, reason, source_table, source_id, customer_name,
    customer_phone, outcome, channel, note, snooze_until, value_cents
  ) VALUES (
    v_owner, p_item_key, p_reason, p_source_table, p_source_id, p_customer_name,
    p_phone, p_outcome, COALESCE(p_channel, 'call'), NULLIF(btrim(p_note), ''),
    p_snooze_until, p_value_cents
  ) RETURNING id INTO v_id;

  -- Keep the revenue-recovery ledger honest. 'recovered' is deliberately
  -- NOT set here: the ledger's own triggers close an entry only when real
  -- money is collected.
  IF p_source_table = 'revenue_recovery_events' AND p_source_id IS NOT NULL THEN
    v_ledger_status := CASE
      WHEN p_outcome IN ('not_interested', 'wrong_number', 'do_not_contact') THEN 'written_off'
      ELSE 'contacted'
    END;
    UPDATE revenue_recovery_events
    SET status = v_ledger_status,
        follow_up_count = follow_up_count + 1,
        last_follow_up_at = now(),
        next_follow_up_at = p_snooze_until,
        recovery_method = CASE
          WHEN p_channel = 'sms' THEN 'sms'
          WHEN p_channel = 'call' THEN 'callback'
          ELSE recovery_method
        END,
        resolved_at = CASE WHEN v_ledger_status = 'written_off' THEN now() ELSE resolved_at END,
        resolved_by = CASE WHEN v_ledger_status = 'written_off' THEN auth.uid() ELSE resolved_by END,
        updated_at = now()
    WHERE id = p_source_id
      AND user_id = v_owner
      AND status IN ('open', 'contacted');
  END IF;

  v_digits := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF v_digits <> '' THEN
    -- Same normalisation as normalizePhone() in _shared/compliance/dncCheck.ts
    v_e164 := CASE
      WHEN length(v_digits) = 10 THEN '+1' || v_digits
      WHEN length(v_digits) = 11 AND left(v_digits, 1) = '1' THEN '+' || v_digits
      WHEN left(p_phone, 1) = '+' THEN p_phone
      ELSE '+' || v_digits
    END;

    IF p_outcome <> 'wrong_number' THEN
      UPDATE customers SET last_contacted_at = now()
      WHERE user_id = v_owner AND phone IN (p_phone, v_e164);
    END IF;

    IF p_outcome = 'do_not_contact' THEN
      INSERT INTO dnc_suppressions (user_id, phone_number, reason)
      VALUES (v_owner, v_e164, 'manual')
      ON CONFLICT (user_id, phone_number) DO NOTHING;
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_call_queue_outcome(text, text, text, uuid, text, text, text, text, text, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_call_queue_outcome(text, text, text, uuid, text, text, text, text, text, timestamptz, integer) TO authenticated;
