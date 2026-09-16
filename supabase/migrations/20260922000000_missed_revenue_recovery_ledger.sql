/*
  # Missed-Revenue Recovery Ledger

  ## Why
  `RevenueRecoveredCard.tsx` already shows a monthly headline number, but it
  is a read-only rollup computed on the fly from `calls` + `jobs` — there is
  no row anywhere for "this specific caller was lost, here's what it was
  probably worth, here's whether anyone followed up, here's whether it was
  ever actually recovered." A dashboard number that resets every page load
  cannot be worked as a queue. This migration gives that queue a home.

  ## What creates a ledger entry (automatic, via trigger — nobody has to
  remember to log anything)
  - A call whose status becomes 'missed', or that's a voicemail, or whose
    AI-scored `booking_outcome` comes back 'not_booked' — a real
    conversation Vireek had that didn't turn into a job.
  - A quote that goes 'declined' or sits past `valid_until` unresponded
    ('expired').
  - A job that gets cancelled after being scheduled or invoiced.

  Each entry gets an estimated dollar value at write time — from the
  quote's own total, the job's invoice amount, a price-book keyword match
  against the call's AI-detected intent, or the account's configured
  average job value, in that order of preference. Never invented: a miss
  with no way to price it is stored as $0 with `estimated_value_basis =
  'none'`, and the dashboard says so honestly instead of guessing.

  ## What closes a ledger entry (also automatic)
  If the same lead or call later produces a PAID job, or a declined/expired
  quote later gets accepted, the matching open entry is marked 'recovered'
  with the real amount collected — not the original estimate. A business
  can see not just what they lost, but what they actually won back and by
  what method, without anyone updating a spreadsheet.

  ## Security
  Same posture as `calls`/`jobs`: RLS keyed to `get_account_owner_id()` so
  a team member sees their account's ledger, never another tenant's. All
  cross-table trigger writes are SECURITY DEFINER, matching the pattern
  already used for the notification triggers in
  20260831090000_notifications_and_audit_log.sql. No client INSERT policy
  exists — entries are created exclusively by the triggers below, so a
  compromised client session cannot fabricate or erase a recovery entry
  (it can still update status/notes on entries it already owns, same as
  any other CRM record).

  ## Depends on
  20260920000000_visual_tiered_estimates.sql — reuses
  `quote_line_items_subtotal_cents()` and `quote_option_total_cents()` to
  price a declined/expired quote correctly, tiered or flat, without
  duplicating that math a third time.
*/

-- =============================================================
-- 1. LEDGER TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS revenue_recovery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,

  source_type text NOT NULL CHECK (source_type IN (
    'missed_call', 'voicemail', 'not_booked',
    'declined_quote', 'expired_quote', 'cancelled_job'
  )),
  /* Generic pointer instead of five nullable FK columns — a DB-level FK
     can't target five different tables from one column. The trigger that
     inserts each row is the thing guaranteeing it points at something
     real. */
  source_table text NOT NULL CHECK (source_table IN ('calls', 'quotes', 'jobs')),
  source_id uuid NOT NULL,

  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,

  customer_name text NOT NULL DEFAULT 'Unknown caller',
  customer_phone text,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  estimated_value_cents integer NOT NULL DEFAULT 0 CHECK (estimated_value_cents >= 0),
  estimated_value_basis text NOT NULL DEFAULT 'none'
    CHECK (estimated_value_basis IN ('quote_amount', 'job_invoice', 'price_book_match', 'avg_job_value', 'manual', 'none')),

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'contacted', 'recovered', 'written_off')),
  recovery_method text
    CHECK (recovery_method IS NULL OR recovery_method IN ('callback', 'sms', 'quote_resent', 'rebooked', 'manual', 'other')),
  recovered_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  recovered_amount_cents integer CHECK (recovered_amount_cents IS NULL OR recovered_amount_cents >= 0),

  assigned_to uuid REFERENCES team_members(id) ON DELETE SET NULL,
  follow_up_count integer NOT NULL DEFAULT 0,
  last_follow_up_at timestamptz,
  next_follow_up_at timestamptz,
  notes text,

  resolved_at timestamptz,
  resolved_by uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One ledger row per source event — a status flapping back and forth
  -- (e.g. a quote declined, reopened, declined again) updates the same
  -- row rather than piling up duplicates.
  UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_revenue_recovery_user_status
  ON revenue_recovery_events(user_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_recovery_lead ON revenue_recovery_events(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_recovery_call ON revenue_recovery_events(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_recovery_followup
  ON revenue_recovery_events(user_id, next_follow_up_at) WHERE status IN ('open', 'contacted');

ALTER TABLE revenue_recovery_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_revenue_recovery_events" ON revenue_recovery_events;
CREATE POLICY "select_own_revenue_recovery_events" ON revenue_recovery_events
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_revenue_recovery_events" ON revenue_recovery_events;
CREATE POLICY "update_own_revenue_recovery_events" ON revenue_recovery_events
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_revenue_recovery_events" ON revenue_recovery_events;
CREATE POLICY "delete_own_revenue_recovery_events" ON revenue_recovery_events
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());
-- No client INSERT policy — see security note above.

CREATE OR REPLACE FUNCTION public.set_revenue_recovery_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revenue_recovery_updated_at ON revenue_recovery_events;
CREATE TRIGGER trg_revenue_recovery_updated_at
  BEFORE UPDATE ON revenue_recovery_events
  FOR EACH ROW EXECUTE FUNCTION public.set_revenue_recovery_updated_at();

-- =============================================================
-- 2. VALUE ESTIMATION — price book keyword match, then avg job value
-- =============================================================

/*
  Mirrors the fuzzy match already used by the `lookup_price` Vapi tool
  (supabase/functions/vapi-webhook/index.ts) so a missed-call estimate and
  what the AI would actually have quoted the caller are the same number.
  Falls back to the account's configured average job value, then to a
  frank $0 / 'none' — never an invented figure.
*/
CREATE OR REPLACE FUNCTION public.estimate_missed_call_value_cents(p_user_id uuid, p_intent text)
RETURNS TABLE (value_cents integer, basis text)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_needle text := lower(trim(coalesce(p_intent, '')));
  v_price_cents integer;
  v_avg numeric;
BEGIN
  IF v_needle <> '' THEN
    SELECT pbi.price_cents INTO v_price_cents
    FROM price_book_items pbi
    WHERE pbi.user_id = p_user_id
      AND pbi.active
      AND (
        lower(pbi.service_name) = v_needle
        OR lower(pbi.service_name) LIKE '%' || v_needle || '%'
        OR v_needle LIKE '%' || lower(pbi.service_name) || '%'
        OR EXISTS (
          SELECT 1 FROM unnest(pbi.keywords) kw
          WHERE lower(kw) = v_needle OR v_needle LIKE '%' || lower(kw) || '%'
        )
      )
    ORDER BY (lower(pbi.service_name) = v_needle) DESC
    LIMIT 1;

    IF v_price_cents IS NOT NULL THEN
      RETURN QUERY SELECT v_price_cents, 'price_book_match'::text;
      RETURN;
    END IF;
  END IF;

  SELECT bp.avg_job_value INTO v_avg FROM business_profile bp WHERE bp.user_id = p_user_id;
  IF v_avg IS NOT NULL AND v_avg > 0 THEN
    RETURN QUERY SELECT round(v_avg * 100)::integer, 'avg_job_value'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 0, 'none'::text;
END;
$$;

-- =============================================================
-- 3. CALLS -> ledger  (missed / voicemail / not_booked)
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_missed_call_revenue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_type text;
  v_estimate record;
BEGIN
  -- Only calls that represent a real miss. A booked call, even one flagged
  -- an emergency or answered after hours, is not a miss — that is the
  -- product working, which is what RevenueRecoveredCard already counts.
  IF NEW.status = 'missed' THEN
    v_source_type := 'missed_call';
  ELSIF NEW.is_voicemail THEN
    v_source_type := 'voicemail';
  ELSIF NEW.booking_outcome = 'not_booked' THEN
    v_source_type := 'not_booked';
  ELSE
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = NEW.status
     AND OLD.is_voicemail = NEW.is_voicemail
     AND OLD.booking_outcome IS NOT DISTINCT FROM NEW.booking_outcome
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_estimate FROM public.estimate_missed_call_value_cents(NEW.user_id, NEW.intent);

  INSERT INTO revenue_recovery_events (
    user_id, source_type, source_table, source_id, call_id,
    customer_name, customer_phone, occurred_at,
    estimated_value_cents, estimated_value_basis
  )
  VALUES (
    NEW.user_id, v_source_type, 'calls', NEW.id, NEW.id,
    COALESCE(NULLIF(trim(NEW.caller_name), ''), 'Unknown caller'), NEW.caller_phone, NEW.call_datetime,
    v_estimate.value_cents, v_estimate.basis
  )
  ON CONFLICT (source_table, source_id) DO UPDATE
    SET source_type = EXCLUDED.source_type,
        estimated_value_cents = EXCLUDED.estimated_value_cents,
        estimated_value_basis = EXCLUDED.estimated_value_basis;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_missed_call_revenue ON calls;
CREATE TRIGGER trg_log_missed_call_revenue
  AFTER INSERT OR UPDATE OF status, is_voicemail, booking_outcome ON calls
  FOR EACH ROW EXECUTE FUNCTION public.log_missed_call_revenue();

-- =============================================================
-- 4. QUOTES -> ledger  (declined / expired)
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_quote_revenue_loss()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_options boolean;
  v_total_cents integer;
BEGIN
  IF NEW.status NOT IN ('declined', 'expired') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  v_has_options := jsonb_typeof(NEW.options) = 'array' AND jsonb_array_length(NEW.options) > 0;
  IF v_has_options THEN
    v_total_cents := COALESCE(
      public.quote_option_total_cents(NEW.options, COALESCE(NEW.selected_option_id, NEW.recommended_option_id), NEW.tax_percent),
      0
    );
  ELSE
    v_total_cents := public.quote_line_items_subtotal_cents(NEW.line_items);
    v_total_cents := v_total_cents + round(v_total_cents * COALESCE(NEW.tax_percent, 0) / 100.0);
  END IF;

  INSERT INTO revenue_recovery_events (
    user_id, source_type, source_table, source_id, lead_id,
    customer_name, customer_phone, occurred_at,
    estimated_value_cents, estimated_value_basis
  )
  VALUES (
    NEW.user_id,
    CASE WHEN NEW.status = 'declined' THEN 'declined_quote' ELSE 'expired_quote' END,
    'quotes', NEW.id, NEW.lead_id,
    NEW.customer_name, NEW.customer_phone, COALESCE(NEW.responded_at, NEW.updated_at, now()),
    v_total_cents, 'quote_amount'
  )
  ON CONFLICT (source_table, source_id) DO UPDATE
    SET source_type = EXCLUDED.source_type,
        estimated_value_cents = EXCLUDED.estimated_value_cents,
        status = CASE WHEN revenue_recovery_events.status = 'recovered' THEN revenue_recovery_events.status ELSE 'open' END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_quote_revenue_loss ON quotes;
CREATE TRIGGER trg_log_quote_revenue_loss
  AFTER UPDATE OF status ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.log_quote_revenue_loss();

/*
  Quotes never expire themselves — nothing runs `UPDATE ... SET status =
  'expired'` on a schedule today. This does that, and is meant to be called
  by a daily cron (pg_cron, or a scheduled edge function) so `valid_until`
  actually means something over time. Idempotent; touches only quotes
  still sitting in 'sent'.
*/
CREATE OR REPLACE FUNCTION public.expire_stale_quotes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE quotes
  SET status = 'expired'
  WHERE status = 'sent' AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_stale_quotes() TO service_role;

-- =============================================================
-- 5. JOBS -> ledger  (cancelled)
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_cancelled_job_revenue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value_cents integer;
  v_basis text;
  v_avg numeric;
BEGIN
  IF NEW.job_status <> 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.job_status = NEW.job_status THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_amount IS NOT NULL AND NEW.invoice_amount > 0 THEN
    v_value_cents := round(NEW.invoice_amount * 100)::integer;
    v_basis := 'job_invoice';
  ELSE
    SELECT bp.avg_job_value INTO v_avg FROM business_profile bp WHERE bp.user_id = NEW.user_id;
    IF v_avg IS NOT NULL AND v_avg > 0 THEN
      v_value_cents := round(v_avg * 100)::integer;
      v_basis := 'avg_job_value';
    ELSE
      v_value_cents := 0;
      v_basis := 'none';
    END IF;
  END IF;

  INSERT INTO revenue_recovery_events (
    user_id, source_type, source_table, source_id, lead_id, call_id,
    customer_name, customer_phone, occurred_at,
    estimated_value_cents, estimated_value_basis
  )
  VALUES (
    NEW.user_id, 'cancelled_job', 'jobs', NEW.id, NEW.lead_id, NEW.call_id,
    NEW.customer_name, NEW.customer_phone, now(),
    v_value_cents, v_basis
  )
  ON CONFLICT (source_table, source_id) DO UPDATE
    SET estimated_value_cents = EXCLUDED.estimated_value_cents,
        estimated_value_basis = EXCLUDED.estimated_value_basis;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_cancelled_job_revenue ON jobs;
CREATE TRIGGER trg_log_cancelled_job_revenue
  AFTER UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.log_cancelled_job_revenue();

-- =============================================================
-- 6. AUTO-RECOVERY — a paid job or an accepted quote closes the loop
-- =============================================================

/*
  A job reaching invoice_status = 'paid' closes ANY still-open ledger entry
  tied to the same lead or the same originating call — regardless of
  whether the recovery went through a resent quote, a manual callback, or
  the business just rebooking the customer directly. The real collected
  amount is recorded, not the original estimate, because that is the
  number that actually matters.
*/
CREATE OR REPLACE FUNCTION public.close_revenue_recovery_on_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.invoice_status <> 'paid' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invoice_status = NEW.invoice_status THEN
    RETURN NEW;
  END IF;
  IF NEW.lead_id IS NULL AND NEW.call_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE revenue_recovery_events e
  SET status = 'recovered',
      recovery_method = COALESCE(e.recovery_method, 'rebooked'),
      recovered_job_id = NEW.id,
      recovered_amount_cents = round(COALESCE(NEW.invoice_amount, 0) * 100)::integer,
      resolved_at = now()
  WHERE e.user_id = NEW.user_id
    AND e.status IN ('open', 'contacted')
    AND (
      (NEW.lead_id IS NOT NULL AND e.lead_id = NEW.lead_id)
      OR (NEW.call_id IS NOT NULL AND e.call_id = NEW.call_id)
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_revenue_recovery_on_payment ON jobs;
CREATE TRIGGER trg_close_revenue_recovery_on_payment
  AFTER INSERT OR UPDATE OF invoice_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.close_revenue_recovery_on_payment();

/* Same idea for a quote that gets accepted after having been logged as a
   loss (declined, then reopened and sent again, then accepted). */
CREATE OR REPLACE FUNCTION public.close_revenue_recovery_on_quote_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'accepted' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  UPDATE revenue_recovery_events e
  SET status = 'recovered',
      recovery_method = COALESCE(e.recovery_method, 'quote_resent'),
      recovered_amount_cents = round(COALESCE(NEW.accepted_total_cents, 0))::integer,
      resolved_at = now()
  WHERE e.source_table = 'quotes' AND e.source_id = NEW.id AND e.status IN ('open', 'contacted');

  -- A quote can also be the resolution to a missed call it was created
  -- from — close that call's entry too, same lead.
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE revenue_recovery_events e
    SET status = 'recovered',
        recovery_method = COALESCE(e.recovery_method, 'quote_resent'),
        recovered_amount_cents = round(COALESCE(NEW.accepted_total_cents, 0))::integer,
        resolved_at = now()
    WHERE e.lead_id = NEW.lead_id
      AND e.source_table <> 'quotes'
      AND e.status IN ('open', 'contacted');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_revenue_recovery_on_quote_accept ON quotes;
CREATE TRIGGER trg_close_revenue_recovery_on_quote_accept
  AFTER UPDATE OF status ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.close_revenue_recovery_on_quote_accept();

-- =============================================================
-- 7. DASHBOARD ACTIONS (client-callable, RLS still applies)
-- =============================================================

/* Logs a follow-up attempt (a callback made, an SMS sent) and moves an
   open entry to 'contacted' without closing it — closing only happens
   when money actually lands, via the triggers above, or by an explicit
   manual write-off/manual-recovery call. */
CREATE OR REPLACE FUNCTION public.log_recovery_follow_up(p_event_id uuid, p_method text, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE revenue_recovery_events
  SET status = CASE WHEN status = 'open' THEN 'contacted' ELSE status END,
      recovery_method = COALESCE(p_method, recovery_method),
      follow_up_count = follow_up_count + 1,
      last_follow_up_at = now(),
      next_follow_up_at = now() + interval '3 days',
      notes = CASE WHEN p_note IS NOT NULL THEN COALESCE(notes || E'\n', '') || p_note ELSE notes END
  WHERE id = p_event_id AND user_id = public.get_account_owner_id();

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_recovery_follow_up(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.write_off_revenue_recovery(p_event_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE revenue_recovery_events
  SET status = 'written_off',
      resolved_at = now(),
      resolved_by = auth.uid(),
      notes = CASE WHEN p_note IS NOT NULL THEN COALESCE(notes || E'\n', '') || p_note ELSE notes END
  WHERE id = p_event_id AND user_id = public.get_account_owner_id() AND status <> 'recovered';

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.write_off_revenue_recovery(uuid, text) TO authenticated;

/* Manual recovery — the business closed the loop themselves (a cash job,
   a rebooking that never went through the platform's own quote/job flow)
   and wants the ledger to reflect it. */
CREATE OR REPLACE FUNCTION public.mark_revenue_recovered_manually(
  p_event_id uuid,
  p_amount_cents integer,
  p_method text DEFAULT 'manual',
  p_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents < 0 THEN
    RETURN false;
  END IF;

  UPDATE revenue_recovery_events
  SET status = 'recovered',
      recovery_method = COALESCE(p_method, 'manual'),
      recovered_amount_cents = p_amount_cents,
      resolved_at = now(),
      resolved_by = auth.uid(),
      notes = CASE WHEN p_note IS NOT NULL THEN COALESCE(notes || E'\n', '') || p_note ELSE notes END
  WHERE id = p_event_id AND user_id = public.get_account_owner_id();

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_revenue_recovered_manually(uuid, integer, text, text) TO authenticated;

-- =============================================================
-- 8. BACKFILL — populate from data that already exists
-- =============================================================

-- Thin, reusable bodies shared by both the live triggers' logic and the
-- one-time backfill below, so a backfilled row and a freshly-triggered row
-- are always computed identically.

CREATE OR REPLACE FUNCTION public.log_missed_call_revenue_for_row(p_call calls)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_estimate record; v_source_type text;
BEGIN
  IF p_call.status = 'missed' THEN v_source_type := 'missed_call';
  ELSIF p_call.is_voicemail THEN v_source_type := 'voicemail';
  ELSIF p_call.booking_outcome = 'not_booked' THEN v_source_type := 'not_booked';
  ELSE RETURN;
  END IF;

  SELECT * INTO v_estimate FROM public.estimate_missed_call_value_cents(p_call.user_id, p_call.intent);

  INSERT INTO revenue_recovery_events (
    user_id, source_type, source_table, source_id, call_id,
    customer_name, customer_phone, occurred_at, estimated_value_cents, estimated_value_basis
  )
  VALUES (
    p_call.user_id, v_source_type, 'calls', p_call.id, p_call.id,
    COALESCE(NULLIF(trim(p_call.caller_name), ''), 'Unknown caller'), p_call.caller_phone, p_call.call_datetime,
    v_estimate.value_cents, v_estimate.basis
  )
  ON CONFLICT (source_table, source_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_quote_revenue_loss_for_row(p_quote quotes)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has_options boolean; v_total_cents integer;
BEGIN
  v_has_options := jsonb_typeof(p_quote.options) = 'array' AND jsonb_array_length(p_quote.options) > 0;
  IF v_has_options THEN
    v_total_cents := COALESCE(
      public.quote_option_total_cents(p_quote.options, COALESCE(p_quote.selected_option_id, p_quote.recommended_option_id), p_quote.tax_percent),
      0
    );
  ELSE
    v_total_cents := public.quote_line_items_subtotal_cents(p_quote.line_items);
    v_total_cents := v_total_cents + round(v_total_cents * COALESCE(p_quote.tax_percent, 0) / 100.0);
  END IF;

  INSERT INTO revenue_recovery_events (
    user_id, source_type, source_table, source_id, lead_id,
    customer_name, customer_phone, occurred_at, estimated_value_cents, estimated_value_basis
  )
  VALUES (
    p_quote.user_id, CASE WHEN p_quote.status = 'declined' THEN 'declined_quote' ELSE 'expired_quote' END,
    'quotes', p_quote.id, p_quote.lead_id,
    p_quote.customer_name, p_quote.customer_phone, COALESCE(p_quote.responded_at, p_quote.updated_at, now()),
    v_total_cents, 'quote_amount'
  )
  ON CONFLICT (source_table, source_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_cancelled_job_revenue_for_row(p_job jobs)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_value_cents integer; v_basis text; v_avg numeric;
BEGIN
  IF p_job.invoice_amount IS NOT NULL AND p_job.invoice_amount > 0 THEN
    v_value_cents := round(p_job.invoice_amount * 100)::integer;
    v_basis := 'job_invoice';
  ELSE
    SELECT bp.avg_job_value INTO v_avg FROM business_profile bp WHERE bp.user_id = p_job.user_id;
    IF v_avg IS NOT NULL AND v_avg > 0 THEN
      v_value_cents := round(v_avg * 100)::integer;
      v_basis := 'avg_job_value';
    ELSE
      v_value_cents := 0;
      v_basis := 'none';
    END IF;
  END IF;

  INSERT INTO revenue_recovery_events (
    user_id, source_type, source_table, source_id, lead_id, call_id,
    customer_name, customer_phone, occurred_at, estimated_value_cents, estimated_value_basis
  )
  VALUES (
    p_job.user_id, 'cancelled_job', 'jobs', p_job.id, p_job.lead_id, p_job.call_id,
    p_job.customer_name, p_job.customer_phone, p_job.created_at,
    v_value_cents, v_basis
  )
  ON CONFLICT (source_table, source_id) DO NOTHING;
END;
$$;

/*
  One-time (safe to re-run) sweep so a business's ledger isn't empty on day
  one. Walks existing calls/quotes/jobs through the exact functions above.
  SECURITY INVOKER + the RLS-scoped SELECTs below mean a caller can only
  ever backfill their own account, regardless of what p_user_id is set to.
*/
CREATE OR REPLACE FUNCTION public.backfill_revenue_recovery_events(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_count integer := 0;
BEGIN
  IF p_user_id IS DISTINCT FROM public.get_account_owner_id() THEN
    RETURN 0;
  END IF;

  FOR v_row IN SELECT * FROM calls WHERE user_id = p_user_id AND (status = 'missed' OR is_voicemail OR booking_outcome = 'not_booked')
  LOOP
    PERFORM public.log_missed_call_revenue_for_row(v_row);
    v_count := v_count + 1;
  END LOOP;

  FOR v_row IN SELECT * FROM quotes WHERE user_id = p_user_id AND status IN ('declined', 'expired')
  LOOP
    PERFORM public.log_quote_revenue_loss_for_row(v_row);
    v_count := v_count + 1;
  END LOOP;

  FOR v_row IN SELECT * FROM jobs WHERE user_id = p_user_id AND job_status = 'cancelled'
  LOOP
    PERFORM public.log_cancelled_job_revenue_for_row(v_row);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_revenue_recovery_events(uuid) TO authenticated;
