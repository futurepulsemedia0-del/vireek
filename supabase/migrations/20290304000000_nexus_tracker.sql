/*
  # Sales-tax / VAT nexus tracker — Vireek's OWN subscription revenue per US state / country (staff only)

  ## What this adds (purely additive; no existing object is modified except one new index on billing_events)
  - `nexus_revenue_facts`        append-only ledger: ONE row per paid Stripe invoice (deduplicated by invoice id, so
                                 `invoice.paid` + `invoice.payment_succeeded` for the same invoice count once).
                                 Derived ONLY from `billing_events.payload` (already written idempotently by stripe-webhook),
                                 so the webhook needs no change and a failure here can never block billing.
  - trigger on `billing_events`  ingests new invoice events; it can NEVER fail the webhook insert.
  - `nexus_backfill()`           service-role only; replays history from billing_events (idempotent, safe to re-run).
  - `staff_nexus_revenue(date)`  staff-only SECURITY DEFINER read RPC; writes staff_audit_log (action 'explorer_list').
  - `staff_nexus_log_export(int)` staff-only; audit-logs a CSV export.

  ## What it does NOT do (see docs/finance/nexus-tracking.md)
  - It holds NO thresholds. Thresholds live in config/nexus-thresholds.json and are [COUNSEL][VERIFY].
  - No FX conversion: rows are grouped by currency. No refund/credit-note netting. Nothing here is a legal determination.

  ## Attribution rules
  - Jurisdiction = invoice.customer_address (country, state) as captured by Stripe on the invoice.   [VERIFY: Stripe address collection is enabled]
  - country missing/invalid          -> country NULL, address_status 'no_address'  (shown as UNKNOWN; never guessed)
  - US with a state that is not a 2-letter code -> state NULL, address_status 'us_state_unresolved' (never guessed)
  - non-US: state is not stored.
  - Events with livemode = false are ignored. amount_paid = 0 is ignored. Currency is lower-cased, not converted.
  - Time = status_transitions.paid_at, else event.created, else insert time (UTC).
  - Tax: invoice.tax, else sum(invoice.total_taxes[].amount), else 0.   [VERIFY against the Stripe API version in production]

  ## Security
  RLS enabled, NO policies, ALL privileges revoked from anon/authenticated on the table. Access only through the
  SECURITY DEFINER staff RPCs, which verify is_vireek_staff(auth.uid()) INSIDE the function. Tenants can never read it.

  ## Requires: billing_events(stripe_event_id,event_type,payload,created_at), is_vireek_staff(uuid), staff_audit_log.

  ## Rollback (derived data; can be rebuilt with nexus_backfill())
    DROP TRIGGER IF EXISTS billing_events_nexus ON public.billing_events;
    DROP FUNCTION IF EXISTS public.staff_nexus_log_export(integer), public.staff_nexus_revenue(date),
      public.nexus_backfill(), public.nexus_billing_trigger(), public.nexus_ingest_event(text, text, jsonb),
      public.nexus_safe_bigint(text), public.nexus_append_only();
    DROP TABLE IF EXISTS public.nexus_revenue_facts;
    DROP INDEX IF EXISTS public.billing_events_nexus_invoice_idx;
*/

-- =============================================================
-- LEDGER
-- =============================================================
CREATE TABLE IF NOT EXISTS public.nexus_revenue_facts (
  stripe_invoice_id  text PRIMARY KEY,
  source_event_id    text NOT NULL,
  stripe_customer_id text,
  country            text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  state              text CHECK (state IS NULL OR state ~ '^[A-Z0-9]{1,3}$'),
  currency           text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  gross_cents        bigint NOT NULL CHECK (gross_cents > 0),
  tax_cents          bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  paid_at            timestamptz NOT NULL,
  address_status     text NOT NULL CHECK (address_status IN ('ok', 'no_address', 'us_state_unresolved')),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nexus_state_only_us CHECK (state IS NULL OR country = 'US')
);

CREATE INDEX IF NOT EXISTS idx_nexus_facts_paid_at ON public.nexus_revenue_facts (paid_at);
CREATE INDEX IF NOT EXISTS idx_nexus_facts_juris ON public.nexus_revenue_facts (country, state, currency, paid_at);

ALTER TABLE public.nexus_revenue_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nexus_revenue_facts FROM PUBLIC, anon, authenticated;

-- Append-only: history may be added, never rewritten.
CREATE OR REPLACE FUNCTION public.nexus_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.nexus_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS nexus_revenue_facts_append_only ON public.nexus_revenue_facts;
CREATE TRIGGER nexus_revenue_facts_append_only
  BEFORE UPDATE OR DELETE ON public.nexus_revenue_facts
  FOR EACH ROW EXECUTE FUNCTION public.nexus_append_only();

-- Supports the reconciliation count in staff_nexus_revenue() without a full payload scan.
CREATE INDEX IF NOT EXISTS billing_events_nexus_invoice_idx
  ON public.billing_events ((payload #>> '{data,object,id}'))
  WHERE event_type IN ('invoice.paid', 'invoice.payment_succeeded');

-- =============================================================
-- INGEST
-- =============================================================
CREATE OR REPLACE FUNCTION public.nexus_safe_bigint(p_text text)
RETURNS bigint
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p_text ~ '^[0-9]{1,15}$' THEN p_text::bigint ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.nexus_safe_bigint(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.nexus_ingest_event(p_event_id text, p_type text, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_obj      jsonb;
  v_invoice  text;
  v_amount   bigint;
  v_currency text;
  v_country  text;
  v_state    text;
  v_tax      bigint;
  v_paid_at  timestamptz;
  v_status   text;
  v_epoch    bigint;
BEGIN
  IF p_type NOT IN ('invoice.paid', 'invoice.payment_succeeded') OR p_payload IS NULL THEN
    RETURN false;
  END IF;
  IF p_payload->>'livemode' = 'false' THEN
    RETURN false;
  END IF;

  v_obj := p_payload #> '{data,object}';
  IF v_obj IS NULL OR jsonb_typeof(v_obj) <> 'object' THEN RETURN false; END IF;

  v_invoice := nullif(btrim(v_obj->>'id'), '');
  v_amount  := public.nexus_safe_bigint(v_obj->>'amount_paid');
  v_currency := lower(nullif(btrim(v_obj->>'currency'), ''));
  IF v_invoice IS NULL OR v_amount IS NULL OR v_amount <= 0 OR v_currency IS NULL OR v_currency !~ '^[a-z]{3}$' THEN
    RETURN false;
  END IF;

  -- Jurisdiction from the invoice's customer address; never guessed.
  v_country := upper(nullif(btrim(v_obj #>> '{customer_address,country}'), ''));
  IF v_country IS NOT NULL AND v_country !~ '^[A-Z]{2}$' THEN v_country := NULL; END IF;
  v_state := NULL;
  IF v_country IS NULL THEN
    v_status := 'no_address';
  ELSIF v_country = 'US' THEN
    v_state := upper(nullif(btrim(v_obj #>> '{customer_address,state}'), ''));
    IF v_state IS NOT NULL AND v_state ~ '^[A-Z]{2}$' THEN
      v_status := 'ok';
    ELSE
      v_state := NULL;
      v_status := 'us_state_unresolved';
    END IF;
  ELSE
    v_status := 'ok';
  END IF;

  -- Tax: legacy `tax` field, else sum of `total_taxes[].amount` (newer Stripe API versions).
  v_tax := public.nexus_safe_bigint(v_obj->>'tax');
  IF v_tax IS NULL AND jsonb_typeof(v_obj->'total_taxes') = 'array' THEN
    SELECT coalesce(sum(public.nexus_safe_bigint(t->>'amount')), 0) INTO v_tax FROM jsonb_array_elements(v_obj->'total_taxes') t;
  END IF;
  v_tax := least(coalesce(v_tax, 0), v_amount);

  v_epoch := coalesce(public.nexus_safe_bigint(v_obj #>> '{status_transitions,paid_at}'), public.nexus_safe_bigint(p_payload->>'created'));
  v_paid_at := CASE WHEN v_epoch IS NOT NULL THEN to_timestamp(v_epoch) ELSE now() END;

  INSERT INTO public.nexus_revenue_facts
    (stripe_invoice_id, source_event_id, stripe_customer_id, country, state, currency, gross_cents, tax_cents, paid_at, address_status)
  VALUES
    (v_invoice, p_event_id,
     CASE WHEN jsonb_typeof(v_obj->'customer') = 'string' THEN v_obj->>'customer' ELSE v_obj #>> '{customer,id}' END,
     v_country, v_state, v_currency, v_amount, v_tax, v_paid_at, v_status)
  ON CONFLICT (stripe_invoice_id) DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.nexus_ingest_event(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- The webhook inserts into billing_events BEFORE it processes anything; this trigger must never break that.
CREATE OR REPLACE FUNCTION public.nexus_billing_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.nexus_ingest_event(NEW.stripe_event_id, NEW.event_type, NEW.payload);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'nexus_billing_trigger: ingest failed for %: %', NEW.stripe_event_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.nexus_billing_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS billing_events_nexus ON public.billing_events;
CREATE TRIGGER billing_events_nexus
  AFTER INSERT ON public.billing_events
  FOR EACH ROW EXECUTE FUNCTION public.nexus_billing_trigger();

CREATE OR REPLACE FUNCTION public.nexus_backfill()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT stripe_event_id, event_type, payload FROM public.billing_events
           WHERE event_type IN ('invoice.paid', 'invoice.payment_succeeded') ORDER BY created_at, id LOOP
    BEGIN
      IF public.nexus_ingest_event(r.stripe_event_id, r.event_type, r.payload) THEN v_n := v_n + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'nexus_backfill: skipped %: %', r.stripe_event_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.nexus_backfill() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_backfill() TO service_role;

-- One-off history replay at migration time. Guarded: a data problem must not fail the migration (re-run nexus_backfill() later).
DO $$
BEGIN
  PERFORM public.nexus_backfill();
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'nexus backfill at migration time failed: %. Run SELECT public.nexus_backfill(); as service_role.', SQLERRM;
END;
$$;

-- =============================================================
-- STAFF RPCs
-- =============================================================
-- Returns per (country, state, currency) three UTC windows ending at p_as_of (inclusive):
--   rolling_12m = the 12 months ending at the end of p_as_of; calendar_year = Jan 1 of p_as_of's year .. p_as_of;
--   prior_calendar_year = the whole previous calendar year.  gross_cents / tax_cents / n (invoices) in each.
CREATE OR REPLACE FUNCTION public.staff_nexus_revenue(p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'UTC')::date;
  v_asof    date;
  v_email   text;
  v_end     timestamptz;
  v_r12     timestamptz;
  v_cy      timestamptz;
  v_py      timestamptz;
  v_rows    jsonb;
  v_seen    bigint;
  v_ledger  bigint;
  v_first   timestamptz;
  v_last    timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  v_asof := coalesce(p_as_of, v_today);
  IF v_asof > v_today OR v_asof < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'invalid_as_of' USING ERRCODE = '22023';
  END IF;

  v_end := ((v_asof + 1)::timestamp) AT TIME ZONE 'UTC';
  v_r12 := (((v_asof + 1)::timestamp) - interval '12 months') AT TIME ZONE 'UTC';
  v_cy  := (date_trunc('year', v_asof::timestamp)) AT TIME ZONE 'UTC';
  v_py  := (date_trunc('year', v_asof::timestamp) - interval '1 year') AT TIME ZONE 'UTC';

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM staff_audit_log l
    WHERE l.staff_id = auth.uid() AND l.action = 'explorer_list'
      AND l.metadata ->> 'view' = 'nexus_tracker' AND l.created_at > now() - interval '1 minute'
  ) THEN
    INSERT INTO staff_audit_log (staff_id, staff_email, action, metadata)
    VALUES (auth.uid(), v_email, 'explorer_list', jsonb_build_object('view', 'nexus_tracker', 'as_of', v_asof));
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'country') NULLS LAST, (x->>'state') NULLS LAST, x->>'currency'), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'country', f.country,
      'state', f.state,
      'currency', f.currency,
      'unresolved', bool_or(f.address_status <> 'ok'),
      'windows', jsonb_build_object(
        'rolling_12m', jsonb_build_object(
          'gross_cents', coalesce(sum(f.gross_cents) FILTER (WHERE f.paid_at >= v_r12 AND f.paid_at < v_end), 0),
          'tax_cents',   coalesce(sum(f.tax_cents)   FILTER (WHERE f.paid_at >= v_r12 AND f.paid_at < v_end), 0),
          'n',           count(*)                    FILTER (WHERE f.paid_at >= v_r12 AND f.paid_at < v_end)),
        'calendar_year', jsonb_build_object(
          'gross_cents', coalesce(sum(f.gross_cents) FILTER (WHERE f.paid_at >= v_cy AND f.paid_at < v_end), 0),
          'tax_cents',   coalesce(sum(f.tax_cents)   FILTER (WHERE f.paid_at >= v_cy AND f.paid_at < v_end), 0),
          'n',           count(*)                    FILTER (WHERE f.paid_at >= v_cy AND f.paid_at < v_end)),
        'prior_calendar_year', jsonb_build_object(
          'gross_cents', coalesce(sum(f.gross_cents) FILTER (WHERE f.paid_at >= v_py AND f.paid_at < v_cy), 0),
          'tax_cents',   coalesce(sum(f.tax_cents)   FILTER (WHERE f.paid_at >= v_py AND f.paid_at < v_cy), 0),
          'n',           count(*)                    FILTER (WHERE f.paid_at >= v_py AND f.paid_at < v_cy))
      )
    ) AS x
    FROM public.nexus_revenue_facts f
    WHERE f.paid_at >= least(v_r12, v_py) AND f.paid_at < v_end
    GROUP BY f.country, f.state, f.currency
  ) s;

  -- Reconciliation: distinct invoices seen in billing_events vs invoices in the ledger (live-mode, paid > 0).
  SELECT count(DISTINCT b.payload #>> '{data,object,id}') INTO v_seen
  FROM public.billing_events b
  WHERE b.event_type IN ('invoice.paid', 'invoice.payment_succeeded')
    AND coalesce(b.payload ->> 'livemode', 'true') <> 'false'
    AND coalesce(public.nexus_safe_bigint(b.payload #>> '{data,object,amount_paid}'), 0) > 0
    AND nullif(btrim(b.payload #>> '{data,object,id}'), '') IS NOT NULL;
  SELECT count(*), min(paid_at), max(paid_at) INTO v_ledger, v_first, v_last FROM public.nexus_revenue_facts;

  RETURN jsonb_build_object(
    'as_of', v_asof,
    'generated_at', now(),
    'rows', v_rows,
    'coverage', jsonb_build_object(
      'billing_invoices_seen', v_seen,
      'ledger_invoices', v_ledger,
      'first_paid_at', v_first,
      'last_paid_at', v_last
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.staff_nexus_revenue(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_nexus_revenue(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_nexus_log_export(p_rows integer DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_email text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO staff_audit_log (staff_id, staff_email, action, metadata)
  VALUES (auth.uid(), v_email, 'explorer_list',
          jsonb_build_object('view', 'nexus_export', 'rows', greatest(0, least(coalesce(p_rows, 0), 100000))));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_nexus_log_export(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_nexus_log_export(integer) TO authenticated;
