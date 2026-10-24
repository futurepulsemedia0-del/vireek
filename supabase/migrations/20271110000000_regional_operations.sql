/*
  # Multi-currency & regional operations

  - business_regional_settings : one row per account (currency, reporting currency,
                                 locale, tax regime/labels, units, manual FX override)
  - fx_rates                   : shared daily rates vs USD (written ONLY by the
                                 fx-rates-refresh edge function / service role)
  - get_fx_table()             : jsonb rate table for the app (honours manual override)
  - quotes / invoices / payment_requests: currency + locked FX rate columns
  - Triggers lock the FX rate automatically when an invoice is issued or a payment is paid,
    so historic reports never drift when today's rates move.

  Purely additive and idempotent: safe to run more than once. Existing rows keep
  working (NULL currency = business default, exactly like today).

  Schedule the rates refresh once, after deploying fx-rates-refresh (run in the SQL editor):
    pg_cron job name 'fx-rates-refresh', daily at 06:15 UTC, doing an HTTP POST to
    https://<project-ref>.supabase.co/functions/v1/fx-rates-refresh with header
    X-Cron-Secret = the FX_CRON_SECRET value.
*/

-- =============================================================
-- 1. Per-business regional settings
-- =============================================================
CREATE TABLE IF NOT EXISTS public.business_regional_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  country text NOT NULL DEFAULT 'US' CHECK (country ~ '^[A-Z]{2}$'),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  reporting_currency text NOT NULL DEFAULT 'USD' CHECK (reporting_currency ~ '^[A-Z]{3}$'),
  locale text NOT NULL DEFAULT 'en-US' CHECK (char_length(locale) BETWEEN 2 AND 20),
  tax_regime text NOT NULL DEFAULT 'sales_tax' CHECK (tax_regime IN ('sales_tax', 'vat', 'gst', 'none')),
  tax_label text NOT NULL DEFAULT 'Sales tax' CHECK (char_length(btrim(tax_label)) BETWEEN 1 AND 30),
  tax_id_label text NOT NULL DEFAULT 'Tax ID' CHECK (char_length(btrim(tax_id_label)) BETWEEN 1 AND 30),
  tax_id text CHECK (tax_id IS NULL OR char_length(tax_id) <= 40),
  prices_include_tax boolean NOT NULL DEFAULT false,
  default_tax_rate numeric(6,3) NOT NULL DEFAULT 0 CHECK (default_tax_rate BETWEEN 0 AND 30),
  unit_system text NOT NULL DEFAULT 'imperial' CHECK (unit_system IN ('imperial', 'metric')),
  week_start smallint NOT NULL DEFAULT 0 CHECK (week_start IN (0, 1, 6)),
  fx_mode text NOT NULL DEFAULT 'auto' CHECK (fx_mode IN ('auto', 'manual')),
  fx_manual_rates jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fx_manual_rates) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.business_regional_settings ENABLE ROW LEVEL SECURITY;

-- Everyone on the account can READ (formatting must work for staff and technicians);
-- only the account OWNER can change money/tax configuration.
DROP POLICY IF EXISTS "regional_select" ON public.business_regional_settings;
CREATE POLICY "regional_select" ON public.business_regional_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "regional_insert_owner" ON public.business_regional_settings;
CREATE POLICY "regional_insert_owner" ON public.business_regional_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "regional_update_owner" ON public.business_regional_settings;
CREATE POLICY "regional_update_owner" ON public.business_regional_settings
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP TRIGGER IF EXISTS trigger_regional_settings_updated_at ON public.business_regional_settings;
CREATE TRIGGER trigger_regional_settings_updated_at
  BEFORE UPDATE ON public.business_regional_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 2. Shared exchange rates (base USD)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.fx_rates (
  base_currency text NOT NULL DEFAULT 'USD' CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate numeric(24,10) NOT NULL CHECK (rate > 0),
  rate_date date NOT NULL,
  source text NOT NULL DEFAULT 'open_er_api',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base_currency, quote_currency, rate_date)
);

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

-- Read-only for signed-in users. No write policies on purpose: only the
-- service role (edge function) can insert/update.
DROP POLICY IF EXISTS "fx_rates_read" ON public.fx_rates;
CREATE POLICY "fx_rates_read" ON public.fx_rates FOR SELECT TO authenticated USING (true);

-- =============================================================
-- 3. Rate helpers
-- =============================================================

-- USD -> code rate for a given account (manual override first, then latest shared rate).
CREATE OR REPLACE FUNCTION public.fx_usd_rate(p_user uuid, p_code text, p_on date DEFAULT current_date)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text := upper(coalesce(p_code, ''));
  v_rate numeric;
  v_mode text;
  v_manual jsonb;
BEGIN
  IF v_code = '' THEN RETURN NULL; END IF;
  IF v_code = 'USD' THEN RETURN 1; END IF;

  SELECT s.fx_mode, s.fx_manual_rates INTO v_mode, v_manual
  FROM public.business_regional_settings s
  WHERE s.user_id = p_user;

  IF v_mode = 'manual' AND v_manual IS NOT NULL AND (v_manual ->> v_code) IS NOT NULL THEN
    BEGIN
      v_rate := (v_manual ->> v_code)::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_rate := NULL;
    END;
    IF v_rate IS NOT NULL AND v_rate > 0 THEN RETURN v_rate; END IF;
  END IF;

  SELECT r.rate INTO v_rate
  FROM public.fx_rates r
  WHERE r.base_currency = 'USD' AND r.quote_currency = v_code AND r.rate_date <= p_on
  ORDER BY r.rate_date DESC
  LIMIT 1;

  RETURN v_rate;
END;
$$;

-- 1 p_from = N p_to  (NULL when a rate is unknown — never guesses 1:1 across currencies)
CREATE OR REPLACE FUNCTION public.fx_rate_for(p_user uuid, p_from text, p_to text, p_on date DEFAULT current_date)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from numeric;
  v_to numeric;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN RETURN NULL; END IF;
  IF upper(p_from) = upper(p_to) THEN RETURN 1; END IF;
  v_from := public.fx_usd_rate(p_user, p_from, p_on);
  v_to := public.fx_usd_rate(p_user, p_to, p_on);
  IF v_from IS NULL OR v_to IS NULL OR v_from <= 0 OR v_to <= 0 THEN RETURN NULL; END IF;
  RETURN round(v_to / v_from, 10);
END;
$$;

-- Rate table for the signed-in account: {"base":"USD","asOf":"2027-04-15","rates":{"EUR":0.9,...}}
CREATE OR REPLACE FUNCTION public.get_fx_table(p_on date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_rates jsonb;
  v_as_of date;
  v_mode text;
  v_manual jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(l.quote_currency, l.rate), '{}'::jsonb), max(l.rate_date)
  INTO v_rates, v_as_of
  FROM (
    SELECT DISTINCT ON (r.quote_currency) r.quote_currency, r.rate, r.rate_date
    FROM public.fx_rates r
    WHERE r.base_currency = 'USD' AND r.rate_date <= p_on
    ORDER BY r.quote_currency, r.rate_date DESC
  ) l;

  SELECT s.fx_mode, s.fx_manual_rates INTO v_mode, v_manual
  FROM public.business_regional_settings s
  WHERE s.user_id = public.get_account_owner_id();

  IF v_mode = 'manual' AND v_manual IS NOT NULL THEN
    v_rates := v_rates || v_manual;
  END IF;

  RETURN jsonb_build_object(
    'base', 'USD',
    'asOf', v_as_of,
    'manual', coalesce(v_mode = 'manual', false),
    'rates', v_rates || jsonb_build_object('USD', 1)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_fx_table(date) TO authenticated;
REVOKE ALL ON FUNCTION public.fx_usd_rate(uuid, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_rate_for(uuid, text, text, date) FROM PUBLIC;

-- =============================================================
-- 4. Document columns (guarded: skipped if a table is missing)
-- =============================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'invoices'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS currency text CHECK (currency IS NULL OR currency ~ ''^[A-Z]{3}$'')', t);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tax_label text', t);
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['invoices', 'payment_requests'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS reporting_currency text CHECK (reporting_currency IS NULL OR reporting_currency ~ ''^[A-Z]{3}$'')', t);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS fx_rate_to_reporting numeric(24,10) CHECK (fx_rate_to_reporting IS NULL OR fx_rate_to_reporting > 0)', t);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS fx_rate_date date', t);
    END IF;
  END LOOP;
END
$$;

-- =============================================================
-- 5. Lock the FX rate when money becomes real
-- =============================================================
CREATE OR REPLACE FUNCTION public.invoices_lock_fx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz_currency text;
  v_biz_reporting text;
  v_tax_label text;
  v_cur text;
  v_rep text;
  v_rate numeric;
BEGIN
  IF NEW.status NOT IN ('sent', 'viewed', 'paid') THEN
    RETURN NEW;
  END IF;

  SELECT s.currency, s.reporting_currency, s.tax_label
  INTO v_biz_currency, v_biz_reporting, v_tax_label
  FROM public.business_regional_settings s
  WHERE s.user_id = NEW.user_id;

  -- Freeze the document currency + tax label at issue time.
  v_cur := upper(coalesce(NEW.currency, v_biz_currency, 'USD'));
  NEW.currency := v_cur;
  IF NEW.tax_label IS NULL AND v_tax_label IS NOT NULL THEN
    NEW.tax_label := v_tax_label;
  END IF;

  IF NEW.fx_rate_to_reporting IS NULL THEN
    v_rep := upper(coalesce(v_biz_reporting, v_cur));
    v_rate := public.fx_rate_for(NEW.user_id, v_cur, v_rep, current_date);
    IF v_rate IS NOT NULL THEN
      NEW.reporting_currency := v_rep;
      NEW.fx_rate_to_reporting := v_rate;
      NEW.fx_rate_date := current_date;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_requests_lock_fx()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz_reporting text;
  v_cur text;
  v_rep text;
  v_rate numeric;
BEGIN
  IF NEW.status <> 'paid' OR NEW.fx_rate_to_reporting IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.reporting_currency INTO v_biz_reporting
  FROM public.business_regional_settings s
  WHERE s.user_id = NEW.user_id;

  v_cur := upper(coalesce(NEW.currency, 'USD'));
  v_rep := upper(coalesce(v_biz_reporting, v_cur));
  v_rate := public.fx_rate_for(NEW.user_id, v_cur, v_rep, current_date);
  IF v_rate IS NOT NULL THEN
    NEW.reporting_currency := v_rep;
    NEW.fx_rate_to_reporting := v_rate;
    NEW.fx_rate_date := current_date;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.invoices') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trigger_invoices_lock_fx ON public.invoices;
    CREATE TRIGGER trigger_invoices_lock_fx
      BEFORE INSERT OR UPDATE ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION public.invoices_lock_fx();
  END IF;
  IF to_regclass('public.payment_requests') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trigger_payment_requests_lock_fx ON public.payment_requests;
    CREATE TRIGGER trigger_payment_requests_lock_fx
      BEFORE INSERT OR UPDATE ON public.payment_requests
      FOR EACH ROW EXECUTE FUNCTION public.payment_requests_lock_fx();
  END IF;
END
$$;
