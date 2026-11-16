-- Activation funnel (time-to-first-value). No PII: only account id, event name, timestamp.
-- One row per (account, event): the FIRST occurrence wins, so every writer is idempotent.
-- ROLLBACK (manual, run in this order):
--   DROP TRIGGER IF EXISTS trg_activation_call ON public.calls;
--   DROP TRIGGER IF EXISTS trg_activation_job ON public.jobs;
--   DROP TRIGGER IF EXISTS trg_activation_invoice ON public.invoices;
--   DROP TRIGGER IF EXISTS trg_activation_profile ON public.profiles;
--   DROP FUNCTION IF EXISTS public.activation_trg_call(), public.activation_trg_job(), public.activation_trg_invoice(), public.activation_trg_profile();
--   DROP FUNCTION IF EXISTS public.record_activation_event(text), public.staff_activation_funnel(integer), public._activation_write(uuid, text, timestamptz);
--   DROP TABLE IF EXISTS public.activation_events;

CREATE TABLE IF NOT EXISTS public.activation_events (
  account_owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN (
    'signup', 'phone_connected', 'assistant_configured', 'first_test_call',
    'first_call_logged', 'first_booking', 'first_invoice_paid')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_owner_id, event)
);
CREATE INDEX IF NOT EXISTS idx_activation_events_event_time ON public.activation_events (event, occurred_at);

ALTER TABLE public.activation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.activation_events FROM anon, authenticated;
GRANT SELECT ON public.activation_events TO authenticated;

-- Reads only. Nobody writes directly: writes go through the SECURITY DEFINER functions/triggers below.
DROP POLICY IF EXISTS "activation_events_select_own" ON public.activation_events;
CREATE POLICY "activation_events_select_own" ON public.activation_events FOR SELECT TO authenticated
  USING (account_owner_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS "activation_events_select_staff" ON public.activation_events;
CREATE POLICY "activation_events_select_staff" ON public.activation_events FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

-- Internal writer (not callable by clients).
CREATE OR REPLACE FUNCTION public._activation_write(p_owner uuid, p_event text, p_at timestamptz DEFAULT now())
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.activation_events (account_owner_id, event, occurred_at)
  SELECT p_owner, p_event, COALESCE(p_at, now())
  WHERE EXISTS (SELECT 1 FROM public.profiles WHERE id = p_owner)
  ON CONFLICT (account_owner_id, event) DO NOTHING;
$$;
REVOKE ALL ON FUNCTION public._activation_write(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;

-- Client-callable: only the three events the browser can legitimately witness.
CREATE OR REPLACE FUNCTION public.record_activation_event(p_event text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF p_event NOT IN ('phone_connected', 'assistant_configured', 'first_test_call') THEN
    RAISE EXCEPTION 'event_not_allowed' USING ERRCODE = '22023';
  END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN RAISE EXCEPTION 'no_account' USING ERRCODE = '42501'; END IF;
  PERFORM public._activation_write(v_owner, p_event);
END $$;
REVOKE ALL ON FUNCTION public.record_activation_event(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activation_event(text) TO authenticated;

-- Server-side first-value triggers (cannot be forged by a browser).
CREATE OR REPLACE FUNCTION public.activation_trg_call() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN PERFORM public._activation_write(NEW.user_id, 'first_call_logged', NEW.created_at); RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.activation_trg_job() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN PERFORM public._activation_write(NEW.user_id, 'first_booking', NEW.created_at); RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.activation_trg_invoice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'paid' THEN PERFORM public._activation_write(NEW.user_id, 'first_invoice_paid', COALESCE(NEW.paid_at, now())); END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.activation_trg_call(), public.activation_trg_job(), public.activation_trg_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_activation_call ON public.calls;
CREATE TRIGGER trg_activation_call AFTER INSERT ON public.calls FOR EACH ROW EXECUTE FUNCTION public.activation_trg_call();
DROP TRIGGER IF EXISTS trg_activation_job ON public.jobs;
CREATE TRIGGER trg_activation_job AFTER INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.activation_trg_job();
DROP TRIGGER IF EXISTS trg_activation_invoice ON public.invoices;
CREATE TRIGGER trg_activation_invoice AFTER INSERT OR UPDATE OF status ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.activation_trg_invoice();

-- Backfill signup for existing owners (profiles.created_at is the only signup evidence in the schema).
INSERT INTO public.activation_events (account_owner_id, event, occurred_at)
SELECT id, 'signup', created_at FROM public.profiles WHERE role = 'owner'
ON CONFLICT DO NOTHING;

-- New owners get a signup row automatically.
CREATE OR REPLACE FUNCTION public.activation_trg_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN IF NEW.role = 'owner' THEN PERFORM public._activation_write(NEW.id, 'signup', NEW.created_at); END IF; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION public.activation_trg_profile() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_activation_profile ON public.profiles;
CREATE TRIGGER trg_activation_profile AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.activation_trg_profile();

-- Staff funnel: cohort = owners who signed up in the last p_days. Aggregates only, no account ids returned.
CREATE OR REPLACE FUNCTION public.staff_activation_funnel(p_days integer DEFAULT 30)
RETURNS TABLE (event text, accounts bigint, pct_of_signups numeric, median_minutes_from_signup numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH cohort AS (
    SELECT account_owner_id, occurred_at AS signup_at FROM public.activation_events
    WHERE event = 'signup' AND occurred_at >= now() - make_interval(days => v_days)
  ), total AS (SELECT count(*)::numeric AS n FROM cohort),
  ev AS (
    SELECT e.event, e.account_owner_id, EXTRACT(EPOCH FROM (e.occurred_at - c.signup_at)) / 60.0 AS mins
    FROM public.activation_events e JOIN cohort c USING (account_owner_id)
  )
  SELECT k.event,
         count(ev.account_owner_id)::bigint,
         CASE WHEN (SELECT n FROM total) = 0 THEN 0 ELSE round(100.0 * count(ev.account_owner_id) / (SELECT n FROM total), 1) END,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ev.mins))::numeric, 1)
  FROM unnest(ARRAY['signup','phone_connected','assistant_configured','first_test_call','first_call_logged','first_booking','first_invoice_paid']) WITH ORDINALITY AS k(event, ord)
  LEFT JOIN ev ON ev.event = k.event
  GROUP BY k.event, k.ord ORDER BY k.ord;
END $$;
REVOKE ALL ON FUNCTION public.staff_activation_funnel(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_activation_funnel(integer) TO authenticated;
