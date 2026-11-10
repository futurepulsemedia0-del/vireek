/*
  # Founder KPIs (Part B, platform staff ONLY)

  Vireek has no subscription HISTORY table (profiles holds only the current plan/status), so net and gross
  dollar retention cannot be computed from it. This migration builds one from the only complete record that
  exists: the full Stripe event payloads that stripe-webhook already stores in billing_events.

    founder_mrr_from_subscription(jsonb)  list-price MRR (cents) of a Stripe subscription object
    founder_ingest_event(...)             billing_events row -> subscription_mrr_events (idempotent)
    trigger billing_events_founder_mrr    ingests new events; it can NEVER fail the webhook insert
    founder_backfill_mrr()                one-off + repeatable backfill from billing_events
    subscription_mrr_events               append-only MRR ledger (state changes keyed by Stripe customer id)
    founder_cac_inputs (+ _audit)         MANUAL monthly inputs: S&M spend, gross margin, platform fee revenue
    founder_get_* / founder_upsert_*      staff-only SECURITY DEFINER RPCs (is_vireek_staff(auth.uid()))

  MRR rules (documented in docs/ANALYTICS_METRICS.md):
    * counts statuses active and past_due; trialing / canceled / unpaid / incomplete = 0
    * list price x quantity, normalised to a month (year /12, week x52/12, day x365/12, interval_count honoured)
    * metered prices (no unit_amount) count 0; coupons and discounts are NOT netted
    * customer.subscription.deleted = MRR 0
    * ledger time = Stripe event "created" (not insert time) so replays and out-of-order delivery are safe

  UNVERIFIED (cannot be seen from the repository): which Stripe event types the production webhook endpoint is
  subscribed to. founder_get_data_health() reports how many created/updated/deleted events were actually
  received so the gap is visible on the dashboard instead of silently skewing retention.

  Tenant boundary: all tables are RLS-enabled with NO policies and all privileges revoked from anon and
  authenticated; only the RPCs below (which verify staff status inside the function) can read or write them.

  ROLLBACK: see the comment block at the end of this file.
*/

-- =============================================================
-- MRR PARSER
-- =============================================================
CREATE OR REPLACE FUNCTION public.founder_mrr_from_subscription(p_sub jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(CASE WHEN COALESCE(p_sub->>'status', '') IN ('active', 'past_due') THEN COALESCE((
    SELECT sum(
      CASE WHEN (i->'price'->>'unit_amount') ~ '^[0-9]+$' THEN (i->'price'->>'unit_amount')::numeric ELSE 0 END
      * CASE WHEN (i->>'quantity') ~ '^[0-9]+$' THEN (i->>'quantity')::numeric ELSE 1 END
      * CASE i->'price'->'recurring'->>'interval'
          WHEN 'month' THEN 1.0 WHEN 'year' THEN 1.0 / 12 WHEN 'week' THEN 52.0 / 12 WHEN 'day' THEN 365.0 / 12 ELSE 0 END
      / CASE WHEN (i->'price'->'recurring'->>'interval_count') ~ '^[1-9][0-9]{0,3}$'
             THEN (i->'price'->'recurring'->>'interval_count')::numeric ELSE 1 END
    )
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_sub->'items'->'data') = 'array' THEN p_sub->'items'->'data' ELSE '[]'::jsonb END) AS i
  ), 0) ELSE 0 END)::bigint;
$$;

-- =============================================================
-- LEDGER
-- =============================================================
CREATE TABLE IF NOT EXISTS public.subscription_mrr_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stripe_event_id text NOT NULL UNIQUE,
  -- Stripe customer id is the account key. It is always present on subscription events, whereas mapping to a
  -- profile can lag; history is therefore never lost to a failed lookup and never cascades away with a profile.
  account_key text NOT NULL,
  event_at timestamptz NOT NULL,
  ord smallint NOT NULL CHECK (ord IN (0, 1, 2)), -- created < updated < deleted when timestamps tie
  kind text NOT NULL CHECK (kind IN ('subscription_created', 'subscription_updated', 'subscription_deleted')),
  status text,
  price_id text,
  mrr_cents bigint NOT NULL CHECK (mrr_cents >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_mrr_events_order ON public.subscription_mrr_events (event_at, ord, id);
CREATE INDEX IF NOT EXISTS idx_subscription_mrr_events_account ON public.subscription_mrr_events (account_key, event_at);

ALTER TABLE public.subscription_mrr_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_mrr_events FROM anon, authenticated;

-- Append-only: history may be added, never rewritten.
CREATE OR REPLACE FUNCTION public.founder_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS subscription_mrr_events_append_only ON public.subscription_mrr_events;
CREATE TRIGGER subscription_mrr_events_append_only
  BEFORE UPDATE OR DELETE ON public.subscription_mrr_events
  FOR EACH ROW EXECUTE FUNCTION public.founder_append_only();

CREATE OR REPLACE FUNCTION public.founder_ingest_event(p_event_id text, p_type text, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub jsonb;
  v_customer text;
  v_created text;
  v_ord smallint;
  v_kind text;
  v_mrr bigint;
BEGIN
  IF p_type NOT IN ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') THEN
    RETURN false;
  END IF;
  v_sub := p_payload->'data'->'object';
  v_customer := v_sub->>'customer';
  v_created := p_payload->>'created';
  IF v_customer IS NULL OR v_customer = '' OR v_created IS NULL OR v_created !~ '^[0-9]{1,12}$' THEN
    RETURN false;
  END IF;
  v_ord := CASE p_type WHEN 'customer.subscription.created' THEN 0 WHEN 'customer.subscription.updated' THEN 1 ELSE 2 END;
  v_kind := CASE p_type WHEN 'customer.subscription.created' THEN 'subscription_created'
                        WHEN 'customer.subscription.updated' THEN 'subscription_updated' ELSE 'subscription_deleted' END;
  v_mrr := CASE WHEN p_type = 'customer.subscription.deleted' THEN 0 ELSE public.founder_mrr_from_subscription(v_sub) END;

  INSERT INTO public.subscription_mrr_events (stripe_event_id, account_key, event_at, ord, kind, status, price_id, mrr_cents)
  VALUES (p_event_id, v_customer, to_timestamp(v_created::bigint), v_ord, v_kind, v_sub->>'status',
          v_sub->'items'->'data'->0->'price'->>'id', COALESCE(v_mrr, 0))
  ON CONFLICT (stripe_event_id) DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.founder_ingest_event(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- The webhook inserts into billing_events BEFORE it processes dunning; this trigger must never break that.
CREATE OR REPLACE FUNCTION public.founder_mrr_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.founder_ingest_event(NEW.stripe_event_id, NEW.event_type, NEW.payload);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'founder_mrr_trigger: ingest failed for %: %', NEW.stripe_event_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.founder_mrr_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS billing_events_founder_mrr ON public.billing_events;
CREATE TRIGGER billing_events_founder_mrr
  AFTER INSERT ON public.billing_events
  FOR EACH ROW EXECUTE FUNCTION public.founder_mrr_trigger();

CREATE OR REPLACE FUNCTION public.founder_backfill_mrr()
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
           WHERE event_type LIKE 'customer.subscription.%' ORDER BY created_at, id LOOP
    BEGIN
      IF public.founder_ingest_event(r.stripe_event_id, r.event_type, r.payload) THEN v_n := v_n + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'founder_backfill_mrr: skipped %: %', r.stripe_event_id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.founder_backfill_mrr() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.founder_backfill_mrr() TO service_role;

-- billing_events.id exists (uuid) - ordering by created_at, id is deterministic.
DO $$
BEGIN
  PERFORM public.founder_backfill_mrr();
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'founder backfill skipped: %', SQLERRM; -- rerun: select public.founder_backfill_mrr();
END $$;

-- =============================================================
-- MANUAL INPUTS (+ append-only audit)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.founder_cac_inputs (
  month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  spend_cents bigint NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  gross_margin_bp integer NOT NULL DEFAULT 0 CHECK (gross_margin_bp BETWEEN 0 AND 10000),
  platform_fee_cents bigint NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.founder_cac_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.founder_cac_inputs FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.founder_cac_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month text NOT NULL,
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  before jsonb,
  after jsonb,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.founder_cac_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.founder_cac_audit FROM anon, authenticated;
DROP TRIGGER IF EXISTS founder_cac_audit_append_only ON public.founder_cac_audit;
CREATE TRIGGER founder_cac_audit_append_only
  BEFORE UPDATE OR DELETE ON public.founder_cac_audit
  FOR EACH ROW EXECUTE FUNCTION public.founder_append_only();

CREATE OR REPLACE FUNCTION public.founder_cac_audit_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.founder_cac_audit (month, action, before, after, actor)
  VALUES (COALESCE(NEW.month, OLD.month), lower(TG_OP),
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
          auth.uid());
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS founder_cac_inputs_audit ON public.founder_cac_inputs;
CREATE TRIGGER founder_cac_inputs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.founder_cac_inputs
  FOR EACH ROW EXECUTE FUNCTION public.founder_cac_audit_trg();

-- =============================================================
-- STAFF-ONLY RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.founder_require_staff()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'platform staff only' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.founder_require_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.founder_require_staff() TO authenticated;

CREATE OR REPLACE FUNCTION public.founder_get_mrr_ledger()
RETURNS TABLE (account_key text, event_at timestamptz, mrr_cents bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.founder_require_staff();
  RETURN QUERY SELECT e.account_key, e.event_at, e.mrr_cents FROM public.subscription_mrr_events e ORDER BY e.event_at, e.ord, e.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.founder_get_signups(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (account_key text, created_at timestamptz, activated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.founder_require_staff();
  -- Signups = non-staff profiles that are not someone else's team member. Activation = first completed job.
  RETURN QUERY
  SELECT COALESCE(p.stripe_customer_id, p.id::text), p.created_at,
         (SELECT min(COALESCE(j.completed_at, j.scheduled_datetime, j.created_at))
            FROM public.jobs j WHERE j.user_id = p.id AND j.job_status = 'completed')
  FROM public.profiles p
  WHERE p.created_at >= p_from AND p.created_at < p_to
    AND NOT COALESCE(p.is_staff, false)
    AND NOT EXISTS (SELECT 1 FROM public.team_members tm WHERE lower(tm.member_email) = lower(p.email));
END;
$$;

CREATE OR REPLACE FUNCTION public.founder_get_module_usage(p_asof timestamptz)
RETURNS TABLE (account_key text, module_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.founder_require_staff();
  -- A module is "used" when the account created at least one row of its anchor table in the 30 days before p_asof.
  RETURN QUERY
  SELECT DISTINCT p.stripe_customer_id, m.module_key
  FROM public.profiles p
  JOIN (
    SELECT DISTINCT user_id, 'jobs'::text AS module_key FROM public.jobs WHERE created_at >= p_asof - interval '30 days' AND created_at < p_asof
    UNION ALL SELECT DISTINCT user_id, 'quotes' FROM public.quotes WHERE created_at >= p_asof - interval '30 days' AND created_at < p_asof
    UNION ALL SELECT DISTINCT user_id, 'invoices' FROM public.invoices WHERE created_at >= p_asof - interval '30 days' AND created_at < p_asof
    UNION ALL SELECT DISTINCT user_id, 'job_costing' FROM public.job_cost_entries WHERE user_id IS NOT NULL AND created_at >= p_asof - interval '30 days' AND created_at < p_asof
    UNION ALL SELECT DISTINCT user_id, 'timesheets' FROM public.timesheets WHERE created_at >= p_asof - interval '30 days' AND created_at < p_asof
  ) m ON m.user_id = p.id
  WHERE p.stripe_customer_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.founder_get_payment_volume(p_from timestamptz, p_to timestamptz)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v bigint;
BEGIN
  PERFORM public.founder_require_staff();
  -- Gross card payment volume recorded on invoices. Refunds are not netted (documented).
  SELECT COALESCE(sum(amount_cents), 0)::bigint INTO v FROM public.invoice_payments
   WHERE method = 'card' AND paid_at >= p_from AND paid_at < p_to;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.founder_get_cac_inputs()
RETURNS SETOF public.founder_cac_inputs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.founder_require_staff();
  RETURN QUERY SELECT * FROM public.founder_cac_inputs ORDER BY month DESC LIMIT 60;
END;
$$;

CREATE OR REPLACE FUNCTION public.founder_upsert_cac_input(
  p_month text, p_spend_cents bigint, p_gross_margin_bp integer, p_platform_fee_cents bigint, p_note text
)
RETURNS public.founder_cac_inputs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.founder_cac_inputs;
BEGIN
  PERFORM public.founder_require_staff();
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'invalid month' USING ERRCODE = '22023'; END IF;
  IF p_spend_cents IS NULL OR p_spend_cents < 0 OR p_platform_fee_cents IS NULL OR p_platform_fee_cents < 0 THEN
    RAISE EXCEPTION 'amounts must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_gross_margin_bp IS NULL OR p_gross_margin_bp < 0 OR p_gross_margin_bp > 10000 THEN
    RAISE EXCEPTION 'gross margin must be 0..10000 bp' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.founder_cac_inputs AS t (month, spend_cents, gross_margin_bp, platform_fee_cents, note, updated_by, updated_at)
  VALUES (p_month, p_spend_cents, p_gross_margin_bp, p_platform_fee_cents, NULLIF(btrim(p_note), ''), auth.uid(), now())
  ON CONFLICT (month) DO UPDATE SET spend_cents = EXCLUDED.spend_cents, gross_margin_bp = EXCLUDED.gross_margin_bp,
    platform_fee_cents = EXCLUDED.platform_fee_cents, note = EXCLUDED.note, updated_by = auth.uid(), updated_at = now()
  RETURNING * INTO r;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.founder_get_data_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  PERFORM public.founder_require_staff();
  SELECT jsonb_build_object(
    'billing_subscription_events', (SELECT count(*) FROM public.billing_events WHERE event_type LIKE 'customer.subscription.%'),
    'ledger_rows', (SELECT count(*) FROM public.subscription_mrr_events),
    'created_events', (SELECT count(*) FROM public.subscription_mrr_events WHERE kind = 'subscription_created'),
    'updated_events', (SELECT count(*) FROM public.subscription_mrr_events WHERE kind = 'subscription_updated'),
    'deleted_events', (SELECT count(*) FROM public.subscription_mrr_events WHERE kind = 'subscription_deleted'),
    'oldest_event_at', (SELECT min(event_at) FROM public.subscription_mrr_events),
    'newest_event_at', (SELECT max(event_at) FROM public.subscription_mrr_events)
  ) INTO v;
  RETURN v;
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'founder_get_mrr_ledger()', 'founder_get_signups(timestamptz, timestamptz)', 'founder_get_module_usage(timestamptz)',
    'founder_get_payment_volume(timestamptz, timestamptz)', 'founder_get_cac_inputs()',
    'founder_upsert_cac_input(text, bigint, integer, bigint, text)', 'founder_get_data_health()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;

/* ROLLBACK (manual; the ledger is derived data and can be rebuilt with founder_backfill_mrr()):
DROP TRIGGER IF EXISTS billing_events_founder_mrr ON public.billing_events;
DROP FUNCTION IF EXISTS public.founder_mrr_trigger();
DROP FUNCTION IF EXISTS public.founder_get_data_health();
DROP FUNCTION IF EXISTS public.founder_upsert_cac_input(text, bigint, integer, bigint, text);
DROP FUNCTION IF EXISTS public.founder_get_cac_inputs();
DROP FUNCTION IF EXISTS public.founder_get_payment_volume(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.founder_get_module_usage(timestamptz);
DROP FUNCTION IF EXISTS public.founder_get_signups(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.founder_get_mrr_ledger();
DROP FUNCTION IF EXISTS public.founder_require_staff();
DROP TABLE IF EXISTS public.founder_cac_inputs, public.founder_cac_audit;   -- audit history is lost: export first
DROP FUNCTION IF EXISTS public.founder_cac_audit_trg();
DROP TRIGGER IF EXISTS subscription_mrr_events_append_only ON public.subscription_mrr_events;
DROP TABLE IF EXISTS public.subscription_mrr_events;
DROP FUNCTION IF EXISTS public.founder_backfill_mrr();
DROP FUNCTION IF EXISTS public.founder_ingest_event(text, text, jsonb);
DROP FUNCTION IF EXISTS public.founder_append_only();
DROP FUNCTION IF EXISTS public.founder_mrr_from_subscription(jsonb);
*/
