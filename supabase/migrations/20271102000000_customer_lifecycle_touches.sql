/*
  # Customer Lifecycle Touches
  Birthday · home-purchase anniversary · equipment-install anniversary · first-service anniversary.
  Opt-in only, template messages + optional offers, and a lifecycle calendar.

  ## What this adds (additive only — no existing table/column/policy/trigger is changed)
  - customer_lifecycle_profiles        : per-customer dates (birth MONTH+DAY only, home-purchase date) and the customer's
                                         explicit consent (which touches, which channels, how it was given, when).
  - customer_lifecycle_consent_events  : append-only audit trail of every consent change (consent evidence).
  - lifecycle_touch_settings           : per account × touch type: lead days, send hour, years window, equipment-type
                                         filter, offer, and the marketing_campaigns row that owns the templates.
  - lifecycle_touch_log                : delivery ledger, one row per occurrence × channel. Its unique key is what makes
                                         the hourly sender idempotent (a message can never go out twice) and it carries
                                         the offer code / redemption state.
  - lifecycle_occurrences()            : THE single definition of "who has an anniversary on which day" (service role).
  - get_lifecycle_calendar()           : same data for the dashboard calendar, owner-scoped, with delivery status.
  - set_customer_lifecycle_profile()   : the ONLY write path for dates + consent (validated, audited).
  - ensure_lifecycle_touch_setup()     : idempotently creates the 4 touch settings + their marketing campaigns/steps.
  - redeem_lifecycle_offer()           : staff redeem an offer code once.
  - get_lifecycle_stats()              : sent / offers / redemptions per touch.
  - dispatch_lifecycle_touch_tick()    : hourly pg_cron → edge function (same pattern as daily briefing).

  ## Reuse (nothing is rebuilt)
  - Templates live in marketing_campaigns (campaign_type = 'lifecycle', trigger_type = 'manual') +
    marketing_campaign_steps, so they show up in the existing Marketing page and can be paused there.
    The campaign's status IS the on/off switch of the touch.
  - Every send is mirrored into marketing_campaign_enrollments / marketing_campaign_sends (enrollment status
    'completed', so the existing marketing-campaign-dispatcher never touches them).
  - Sending goes through the existing gates: customer communication preferences, STOP/DNC, A2P, quiet hours.

  ## Privacy by design
  - Birth YEAR is never stored (no age). Only month + day.
  - Nothing is sent without a recorded opt-in for that touch type AND for that channel.
  - Consent changes are audited; dates are only writable through the validated RPC.

  ## Requires (already in your project)
  public.get_account_owner_id(), public.update_updated_at(), profiles, customers (+ deleted_at), equipment,
  jobs (customer_id, completed_at, deleted_at), marketing_campaigns, marketing_campaign_steps,
  marketing_campaign_enrollments, marketing_campaign_sends, customer_communication_preferences, business_profile(timezone).
  Optional: pg_cron + pg_net (otherwise call the edge function hourly from any scheduler).
*/

-- =============================================================
-- 0. Date helper (leap-day rule: a Feb-29 date is celebrated on Feb 28 in non-leap years)
-- =============================================================
CREATE OR REPLACE FUNCTION public.lifecycle_anniversary_date(p_month integer, p_day integer, p_year integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_month IS NULL OR p_day IS NULL OR p_year IS NULL THEN NULL
    WHEN p_month = 2 AND p_day = 29 AND (make_date(p_year, 3, 1) - make_date(p_year, 2, 1)) <> 29
      THEN make_date(p_year, 2, 28)
    ELSE make_date(p_year, p_month, p_day)
  END
$$;

-- =============================================================
-- 1. Per-customer dates + consent
-- =============================================================
CREATE TABLE IF NOT EXISTS customer_lifecycle_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  birth_month smallint CHECK (birth_month BETWEEN 1 AND 12),
  birth_day smallint CHECK (birth_day BETWEEN 1 AND 31),
  home_purchase_date date,

  -- Consent: which touches the customer agreed to, and on which channels.
  opted_in_touches text[] NOT NULL DEFAULT '{}',
  email_consent boolean NOT NULL DEFAULT false,
  sms_consent boolean NOT NULL DEFAULT false,
  consent_source text CHECK (consent_source IN ('verbal', 'written', 'booking_form', 'customer_portal')),
  consent_at timestamptz,
  consent_withdrawn_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (customer_id),
  CONSTRAINT lifecycle_birth_pair CHECK ((birth_month IS NULL) = (birth_day IS NULL)),
  CONSTRAINT lifecycle_birth_valid CHECK (
    birth_month IS NULL OR birth_day <= CASE birth_month WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END
  ),
  CONSTRAINT lifecycle_touches_valid CHECK (
    opted_in_touches <@ ARRAY['birthday', 'home_purchase_anniversary', 'equipment_install_anniversary', 'first_service_anniversary']::text[]
  ),
  CONSTRAINT lifecycle_home_date_sane CHECK (
    home_purchase_date IS NULL OR (home_purchase_date >= DATE '1900-01-01' AND home_purchase_date <= DATE '2100-01-01')
  )
);

CREATE INDEX IF NOT EXISTS idx_clp_user ON customer_lifecycle_profiles (user_id);

ALTER TABLE customer_lifecycle_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clp_select" ON customer_lifecycle_profiles;
CREATE POLICY "clp_select" ON customer_lifecycle_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- Writes only through set_customer_lifecycle_profile() (SECURITY DEFINER) and the service role.
REVOKE ALL ON customer_lifecycle_profiles FROM anon, authenticated;
GRANT SELECT ON customer_lifecycle_profiles TO authenticated;

DROP TRIGGER IF EXISTS trg_clp_updated_at ON customer_lifecycle_profiles;
CREATE TRIGGER trg_clp_updated_at BEFORE UPDATE ON customer_lifecycle_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE IF NOT EXISTS customer_lifecycle_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  changed_by uuid,
  source text,
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clce_customer ON customer_lifecycle_consent_events (customer_id, created_at DESC);

ALTER TABLE customer_lifecycle_consent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clce_select" ON customer_lifecycle_consent_events;
CREATE POLICY "clce_select" ON customer_lifecycle_consent_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON customer_lifecycle_consent_events FROM anon, authenticated;
GRANT SELECT ON customer_lifecycle_consent_events TO authenticated;

-- =============================================================
-- 2. Touch settings (one row per account × touch type)
-- =============================================================
CREATE TABLE IF NOT EXISTS lifecycle_touch_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  touch_type text NOT NULL CHECK (touch_type IN ('birthday', 'home_purchase_anniversary', 'equipment_install_anniversary', 'first_service_anniversary')),
  -- The marketing campaign that owns the templates; its status ('active'/'paused'/'draft') is the on/off switch.
  campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL,

  lead_days smallint NOT NULL DEFAULT 0 CHECK (lead_days BETWEEN 0 AND 30),
  send_hour smallint NOT NULL DEFAULT 9 CHECK (send_hour BETWEEN 0 AND 23),
  min_years smallint NOT NULL DEFAULT 1 CHECK (min_years BETWEEN 1 AND 100),
  max_years smallint NOT NULL DEFAULT 25 CHECK (max_years BETWEEN 1 AND 100),
  -- equipment anniversaries only; empty = every equipment type
  equipment_types text[] NOT NULL DEFAULT '{}',

  offer_enabled boolean NOT NULL DEFAULT false,
  offer_type text NOT NULL DEFAULT 'percent_off' CHECK (offer_type IN ('percent_off', 'amount_off', 'free_service', 'custom')),
  offer_value numeric(10, 2) CHECK (offer_value IS NULL OR offer_value >= 0),
  offer_title text CHECK (offer_title IS NULL OR char_length(offer_title) <= 120),
  offer_terms text CHECK (offer_terms IS NULL OR char_length(offer_terms) <= 500),
  offer_valid_days smallint NOT NULL DEFAULT 30 CHECK (offer_valid_days BETWEEN 1 AND 365),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, touch_type),
  CONSTRAINT lifecycle_years_order CHECK (min_years <= max_years),
  CONSTRAINT lifecycle_offer_title CHECK (NOT offer_enabled OR (offer_title IS NOT NULL AND btrim(offer_title) <> '')),
  CONSTRAINT lifecycle_offer_value CHECK (
    NOT offer_enabled OR offer_type IN ('free_service', 'custom')
    OR (offer_value IS NOT NULL AND offer_value > 0 AND (offer_type <> 'percent_off' OR offer_value <= 100))
  )
);

ALTER TABLE lifecycle_touch_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lts_select" ON lifecycle_touch_settings;
CREATE POLICY "lts_select" ON lifecycle_touch_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- campaign_id must be one of the caller's OWN campaigns (the sender loads templates by this id).
DROP POLICY IF EXISTS "lts_insert" ON lifecycle_touch_settings;
CREATE POLICY "lts_insert" ON lifecycle_touch_settings FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (campaign_id IS NULL OR EXISTS (SELECT 1 FROM marketing_campaigns c WHERE c.id = campaign_id AND c.user_id = public.get_account_owner_id()))
  );

DROP POLICY IF EXISTS "lts_update" ON lifecycle_touch_settings;
CREATE POLICY "lts_update" ON lifecycle_touch_settings FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id())
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (campaign_id IS NULL OR EXISTS (SELECT 1 FROM marketing_campaigns c WHERE c.id = campaign_id AND c.user_id = public.get_account_owner_id()))
  );

REVOKE ALL ON lifecycle_touch_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON lifecycle_touch_settings TO authenticated;

DROP TRIGGER IF EXISTS trg_lts_updated_at ON lifecycle_touch_settings;
CREATE TRIGGER trg_lts_updated_at BEFORE UPDATE ON lifecycle_touch_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- =============================================================
-- 3. Delivery ledger (one row per occurrence × channel)
-- =============================================================
CREATE TABLE IF NOT EXISTS lifecycle_touch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  touch_type text NOT NULL CHECK (touch_type IN ('birthday', 'home_purchase_anniversary', 'equipment_install_anniversary', 'first_service_anniversary')),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Deliberately NOT a foreign key: history must survive equipment deletion, and SET NULL could collide with the unique key below.
  equipment_id uuid,
  occurrence_year smallint NOT NULL,
  occurrence_date date NOT NULL,
  years_count smallint,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  status text NOT NULL CHECK (status IN ('claimed', 'sent', 'deferred', 'failed', 'skipped')),
  skip_reason text,
  error text,
  attempts smallint NOT NULL DEFAULT 0,
  provider_ref text,
  campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL,

  offer_code text,
  offer_label text,
  offer_terms text,
  offer_expires_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by uuid,

  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- THE idempotency guarantee: one ledger row per customer × touch × (equipment) × year × channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lifecycle_touch_log
  ON lifecycle_touch_log (user_id, touch_type, customer_id, COALESCE(equipment_id, '00000000-0000-0000-0000-000000000000'::uuid), occurrence_year, channel);
CREATE INDEX IF NOT EXISTS idx_ltl_user_date ON lifecycle_touch_log (user_id, occurrence_date DESC);
CREATE INDEX IF NOT EXISTS idx_ltl_customer ON lifecycle_touch_log (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ltl_offer_code ON lifecycle_touch_log (user_id, offer_code) WHERE offer_code IS NOT NULL;

ALTER TABLE lifecycle_touch_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ltl_select" ON lifecycle_touch_log;
CREATE POLICY "ltl_select" ON lifecycle_touch_log FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE ALL ON lifecycle_touch_log FROM anon, authenticated;
GRANT SELECT ON lifecycle_touch_log TO authenticated;

DROP TRIGGER IF EXISTS trg_ltl_updated_at ON lifecycle_touch_log;
CREATE TRIGGER trg_ltl_updated_at BEFORE UPDATE ON lifecycle_touch_log
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Speeds up the first-service lookup (earliest completed job per customer).
CREATE INDEX IF NOT EXISTS idx_jobs_lifecycle_first_service
  ON jobs (user_id, customer_id) WHERE job_status = 'completed' AND customer_id IS NOT NULL;

-- =============================================================
-- 4. Occurrences — the single source of truth for "what is coming up"
-- =============================================================
CREATE OR REPLACE FUNCTION public.lifecycle_occurrences(p_user_id uuid, p_from date, p_to date)
RETURNS TABLE (
  touch_type text,
  customer_id uuid,
  customer_name text,
  equipment_id uuid,
  equipment_label text,
  occurrence_date date,
  occurrence_year integer,
  years_count integer,
  opted_in boolean,
  email_consent boolean,
  sms_consent boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_tz text;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR (p_to - p_from) > 400 THEN
    RAISE EXCEPTION 'invalid date range' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(bp.timezone), ''), 'UTC') INTO v_tz FROM business_profile bp WHERE bp.user_id = p_user_id;
  v_tz := COALESCE(v_tz, 'UTC');
  BEGIN
    PERFORM now() AT TIME ZONE v_tz;
  EXCEPTION WHEN OTHERS THEN
    v_tz := 'UTC';
  END;

  RETURN QUERY
  WITH cfg AS (
    SELECT s.touch_type, s.min_years, s.max_years, s.equipment_types
    FROM lifecycle_touch_settings s
    WHERE s.user_id = p_user_id
  ),
  src AS (
    SELECT 'birthday'::text AS touch_type, p.customer_id AS customer_id, NULL::uuid AS equipment_id, NULL::text AS equipment_label,
           NULL::text AS equipment_type, NULL::date AS source_date, p.birth_month::int AS m, p.birth_day::int AS d
    FROM customer_lifecycle_profiles p
    WHERE p.user_id = p_user_id AND p.birth_month IS NOT NULL
    UNION ALL
    SELECT 'home_purchase_anniversary'::text, p.customer_id, NULL::uuid, NULL::text, NULL::text, p.home_purchase_date,
           EXTRACT(month FROM p.home_purchase_date)::int, EXTRACT(day FROM p.home_purchase_date)::int
    FROM customer_lifecycle_profiles p
    WHERE p.user_id = p_user_id AND p.home_purchase_date IS NOT NULL
    UNION ALL
    SELECT 'equipment_install_anniversary'::text, e.customer_id, e.id, NULLIF(btrim(concat_ws(' ', e.make, e.equipment_type)), ''), e.equipment_type, e.install_date,
           EXTRACT(month FROM e.install_date)::int, EXTRACT(day FROM e.install_date)::int
    FROM equipment e
    WHERE e.user_id = p_user_id AND e.status = 'active' AND e.install_date IS NOT NULL
    UNION ALL
    SELECT 'first_service_anniversary'::text, fj.customer_id, NULL::uuid, NULL::text, NULL::text, fj.first_date,
           EXTRACT(month FROM fj.first_date)::int, EXTRACT(day FROM fj.first_date)::int
    FROM (
      SELECT j.customer_id,
             (MIN(COALESCE(j.completed_at, j.scheduled_datetime, j.created_at)) AT TIME ZONE v_tz)::date AS first_date
      FROM jobs j
      WHERE j.user_id = p_user_id AND j.customer_id IS NOT NULL AND j.job_status = 'completed' AND j.deleted_at IS NULL
      GROUP BY j.customer_id
    ) fj
  ),
  cand AS (
    SELECT s.*, y.yr, public.lifecycle_anniversary_date(s.m, s.d, y.yr) AS occ_date
    FROM src s
    CROSS JOIN (SELECT generate_series(EXTRACT(year FROM p_from)::int, EXTRACT(year FROM p_to)::int) AS yr) y
  )
  SELECT c.touch_type, c.customer_id, cu.name, c.equipment_id, c.equipment_label, c.occ_date, c.yr,
         CASE WHEN c.touch_type = 'birthday' THEN NULL ELSE c.yr - EXTRACT(year FROM c.source_date)::int END,
         COALESCE(c.touch_type = ANY (pr.opted_in_touches), false),
         COALESCE(pr.email_consent, false),
         COALESCE(pr.sms_consent, false)
  FROM cand c
  JOIN customers cu ON cu.id = c.customer_id AND cu.user_id = p_user_id AND cu.deleted_at IS NULL
  LEFT JOIN customer_lifecycle_profiles pr ON pr.customer_id = c.customer_id AND pr.user_id = p_user_id
  LEFT JOIN cfg ON cfg.touch_type = c.touch_type
  WHERE c.occ_date BETWEEN p_from AND p_to
    AND (
      c.touch_type = 'birthday'
      OR (c.yr - EXTRACT(year FROM c.source_date)::int) BETWEEN COALESCE(cfg.min_years, 1) AND COALESCE(cfg.max_years, 25)
    )
    AND (
      c.touch_type <> 'equipment_install_anniversary'
      OR cfg.touch_type IS NULL
      OR cardinality(cfg.equipment_types) = 0
      OR EXISTS (SELECT 1 FROM unnest(cfg.equipment_types) t(v) WHERE lower(btrim(t.v)) = lower(btrim(c.equipment_type)))
    )
  ORDER BY c.occ_date, cu.name, c.touch_type
  LIMIT 5000;
END;
$$;
REVOKE ALL ON FUNCTION public.lifecycle_occurrences(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lifecycle_occurrences(uuid, date, date) TO service_role;

-- Dashboard calendar (owner-scoped) with delivery status per channel.
CREATE OR REPLACE FUNCTION public.get_lifecycle_calendar(p_from date, p_to date)
RETURNS TABLE (
  touch_type text,
  customer_id uuid,
  customer_name text,
  equipment_id uuid,
  equipment_label text,
  occurrence_date date,
  occurrence_year integer,
  years_count integer,
  opted_in boolean,
  email_consent boolean,
  sms_consent boolean,
  delivery jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT o.touch_type, o.customer_id, o.customer_name, o.equipment_id, o.equipment_label, o.occurrence_date, o.occurrence_year,
         o.years_count, o.opted_in, o.email_consent, o.sms_consent,
         COALESCE((
           SELECT jsonb_object_agg(l.channel, jsonb_build_object('status', l.status, 'reason', l.skip_reason))
           FROM lifecycle_touch_log l
           WHERE l.user_id = v_owner
             AND l.touch_type = o.touch_type
             AND l.customer_id = o.customer_id
             AND COALESCE(l.equipment_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(o.equipment_id, '00000000-0000-0000-0000-000000000000'::uuid)
             AND l.occurrence_year = o.occurrence_year
         ), '{}'::jsonb)
  FROM public.lifecycle_occurrences(v_owner, p_from, p_to) o;
END;
$$;
REVOKE ALL ON FUNCTION public.get_lifecycle_calendar(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_lifecycle_calendar(date, date) TO authenticated;

-- =============================================================
-- 5. Write path for dates + consent (validated, audited)
-- =============================================================
CREATE OR REPLACE FUNCTION public.set_customer_lifecycle_profile(
  p_customer_id uuid,
  p_birth_month integer,
  p_birth_day integer,
  p_home_purchase_date date,
  p_opted_in_touches text[],
  p_email_consent boolean,
  p_sms_consent boolean,
  p_consent_source text
)
RETURNS public.customer_lifecycle_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_touches text[] := COALESCE(p_opted_in_touches, '{}');
  v_email boolean := COALESCE(p_email_consent, false);
  v_sms boolean := COALESCE(p_sms_consent, false);
  v_prev public.customer_lifecycle_profiles;
  v_row public.customer_lifecycle_profiles;
  v_had boolean := false;
  v_has boolean;
  v_changed boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = p_customer_id AND c.user_id = v_owner AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'customer not found' USING ERRCODE = 'P0002';
  END IF;

  IF (p_birth_month IS NULL) <> (p_birth_day IS NULL) THEN
    RAISE EXCEPTION 'birth month and day must be given together' USING ERRCODE = '22023';
  END IF;
  IF p_birth_month IS NOT NULL AND (
    p_birth_month NOT BETWEEN 1 AND 12 OR p_birth_day < 1
    OR p_birth_day > CASE p_birth_month WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END
  ) THEN
    RAISE EXCEPTION 'invalid birth month/day' USING ERRCODE = '22023';
  END IF;
  IF p_home_purchase_date IS NOT NULL AND (p_home_purchase_date > CURRENT_DATE OR p_home_purchase_date < DATE '1900-01-01') THEN
    RAISE EXCEPTION 'home purchase date must be a past date' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_touches <@ ARRAY['birthday', 'home_purchase_anniversary', 'equipment_install_anniversary', 'first_service_anniversary']::text[]) THEN
    RAISE EXCEPTION 'unknown touch type' USING ERRCODE = '22023';
  END IF;

  v_has := cardinality(v_touches) > 0 AND (v_email OR v_sms);
  IF cardinality(v_touches) > 0 AND NOT (v_email OR v_sms) THEN
    RAISE EXCEPTION 'choose at least one channel the customer agreed to' USING ERRCODE = '22023';
  END IF;
  IF v_has AND p_consent_source IS NULL THEN
    RAISE EXCEPTION 'record how the customer gave consent' USING ERRCODE = '22023';
  END IF;
  IF NOT v_has THEN
    -- no touches or no channel = no consent: never keep dangling channel flags
    v_touches := '{}';
    v_email := false;
    v_sms := false;
  END IF;

  SELECT * INTO v_prev FROM customer_lifecycle_profiles WHERE customer_id = p_customer_id FOR UPDATE;
  IF FOUND THEN
    v_had := cardinality(v_prev.opted_in_touches) > 0 AND (v_prev.email_consent OR v_prev.sms_consent);
  END IF;

  v_changed := NOT FOUND
    OR v_prev.opted_in_touches IS DISTINCT FROM v_touches
    OR v_prev.email_consent IS DISTINCT FROM v_email
    OR v_prev.sms_consent IS DISTINCT FROM v_sms;

  INSERT INTO customer_lifecycle_profiles AS t (
    user_id, customer_id, birth_month, birth_day, home_purchase_date,
    opted_in_touches, email_consent, sms_consent, consent_source, consent_at, consent_withdrawn_at
  ) VALUES (
    v_owner, p_customer_id, p_birth_month, p_birth_day, p_home_purchase_date,
    v_touches, v_email, v_sms, CASE WHEN v_has THEN p_consent_source END, CASE WHEN v_has THEN now() END, NULL
  )
  ON CONFLICT (customer_id) DO UPDATE SET
    birth_month = EXCLUDED.birth_month,
    birth_day = EXCLUDED.birth_day,
    home_purchase_date = EXCLUDED.home_purchase_date,
    opted_in_touches = EXCLUDED.opted_in_touches,
    email_consent = EXCLUDED.email_consent,
    sms_consent = EXCLUDED.sms_consent,
    consent_source = CASE WHEN v_has THEN COALESCE(p_consent_source, t.consent_source) ELSE t.consent_source END,
    consent_at = CASE WHEN v_has AND v_changed THEN now() WHEN v_has THEN t.consent_at ELSE t.consent_at END,
    consent_withdrawn_at = CASE WHEN v_has THEN NULL WHEN v_had THEN now() ELSE t.consent_withdrawn_at END
  RETURNING * INTO v_row;

  IF v_changed THEN
    INSERT INTO customer_lifecycle_consent_events (user_id, customer_id, changed_by, source, changes)
    VALUES (
      v_owner, p_customer_id, auth.uid(), p_consent_source,
      jsonb_build_object(
        'before', CASE WHEN v_prev.id IS NULL THEN NULL ELSE jsonb_build_object('touches', v_prev.opted_in_touches, 'email', v_prev.email_consent, 'sms', v_prev.sms_consent) END,
        'after', jsonb_build_object('touches', v_row.opted_in_touches, 'email', v_row.email_consent, 'sms', v_row.sms_consent)
      )
    );
  END IF;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.set_customer_lifecycle_profile(uuid, integer, integer, date, text[], boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_lifecycle_profile(uuid, integer, integer, date, text[], boolean, boolean, text) TO authenticated;

-- =============================================================
-- 6. Idempotent setup: 4 settings rows + their marketing campaigns/steps (templates come from the app)
-- =============================================================
CREATE OR REPLACE FUNCTION public.ensure_lifecycle_touch_setup(p_templates jsonb)
RETURNS SETOF public.lifecycle_touch_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  t jsonb;
  s jsonb;
  v_type text;
  v_campaign uuid;
  v_order integer;
  v_settings public.lifecycle_touch_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_templates IS NULL OR jsonb_typeof(p_templates) <> 'array' OR jsonb_array_length(p_templates) > 4 THEN
    RAISE EXCEPTION 'invalid templates' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle_setup:' || v_owner::text, 0));

  FOR t IN SELECT * FROM jsonb_array_elements(p_templates) LOOP
    v_type := t ->> 'touch_type';
    IF v_type IS NULL OR NOT (v_type = ANY (ARRAY['birthday', 'home_purchase_anniversary', 'equipment_install_anniversary', 'first_service_anniversary'])) THEN
      RAISE EXCEPTION 'unknown touch type' USING ERRCODE = '22023';
    END IF;

    v_campaign := NULL;
    SELECT * INTO v_settings FROM lifecycle_touch_settings WHERE user_id = v_owner AND touch_type = v_type;
    IF FOUND AND v_settings.campaign_id IS NOT NULL THEN
      SELECT c.id INTO v_campaign FROM marketing_campaigns c WHERE c.id = v_settings.campaign_id AND c.user_id = v_owner;
    END IF;

    IF v_campaign IS NULL THEN
      INSERT INTO marketing_campaigns (user_id, name, campaign_type, trigger_type, trigger_event, status)
      VALUES (v_owner, left(COALESCE(t ->> 'name', v_type), 120), 'lifecycle', 'manual', t ->> 'trigger_event', 'draft')
      RETURNING id INTO v_campaign;

      v_order := 0;
      FOR s IN SELECT * FROM jsonb_array_elements(COALESCE(t -> 'steps', '[]'::jsonb)) LOOP
        IF s ->> 'channel' NOT IN ('email', 'sms') THEN
          RAISE EXCEPTION 'unknown channel' USING ERRCODE = '22023';
        END IF;
        v_order := v_order + 1;
        INSERT INTO marketing_campaign_steps (campaign_id, user_id, step_order, delay_hours, channel, subject, body)
        VALUES (v_campaign, v_owner, v_order, 0, s ->> 'channel', s ->> 'subject', s ->> 'body');
      END LOOP;
    END IF;

    INSERT INTO lifecycle_touch_settings (user_id, touch_type, campaign_id, lead_days, send_hour)
    VALUES (v_owner, v_type, v_campaign, COALESCE((t ->> 'lead_days')::int, 0), COALESCE((t ->> 'send_hour')::int, 9))
    ON CONFLICT (user_id, touch_type) DO UPDATE
      SET campaign_id = EXCLUDED.campaign_id
      WHERE lifecycle_touch_settings.campaign_id IS DISTINCT FROM EXCLUDED.campaign_id;
  END LOOP;

  RETURN QUERY SELECT * FROM lifecycle_touch_settings WHERE user_id = v_owner ORDER BY touch_type;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_lifecycle_touch_setup(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_lifecycle_touch_setup(jsonb) TO authenticated;

-- =============================================================
-- 7. Offer redemption + stats
-- =============================================================
CREATE OR REPLACE FUNCTION public.redeem_lifecycle_offer(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_code text := upper(btrim(COALESCE(p_code, '')));
  r public.lifecycle_touch_log;
  v_rows integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO r FROM lifecycle_touch_log
  WHERE user_id = v_owner AND offer_code = v_code AND status = 'sent'
  ORDER BY sent_at NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF r.offer_expires_at IS NOT NULL AND r.offer_expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired', 'expires_at', r.offer_expires_at);
  END IF;
  IF r.redeemed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_redeemed', 'redeemed_at', r.redeemed_at);
  END IF;

  UPDATE lifecycle_touch_log
  SET redeemed_at = now(), redeemed_by = auth.uid()
  WHERE user_id = v_owner AND offer_code = v_code AND redeemed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_redeemed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'offer', r.offer_label,
    'terms', r.offer_terms,
    'touch_type', r.touch_type,
    'customer_id', r.customer_id,
    'customer_name', (SELECT c.name FROM customers c WHERE c.id = r.customer_id),
    'expires_at', r.offer_expires_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.redeem_lifecycle_offer(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_lifecycle_offer(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_lifecycle_stats(p_days integer DEFAULT 90)
RETURNS TABLE (touch_type text, touches_sent bigint, offers_sent bigint, offers_redeemed bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT l.touch_type,
         count(DISTINCT (l.customer_id, COALESCE(l.equipment_id, '00000000-0000-0000-0000-000000000000'::uuid), l.occurrence_year)) FILTER (WHERE l.status = 'sent'),
         count(DISTINCT l.offer_code) FILTER (WHERE l.status = 'sent' AND l.offer_code IS NOT NULL),
         count(DISTINCT l.offer_code) FILTER (WHERE l.redeemed_at IS NOT NULL)
  FROM lifecycle_touch_log l
  WHERE l.user_id = v_owner AND l.created_at >= now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 90), 3650)))
  GROUP BY l.touch_type;
END;
$$;
REVOKE ALL ON FUNCTION public.get_lifecycle_stats(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_lifecycle_stats(integer) TO authenticated;

-- =============================================================
-- 8. Hourly schedule (pg_cron → pg_net → edge function), same pattern as the daily briefing
--    One-time setup (SQL editor):
--      ALTER DATABASE postgres SET app.settings.lifecycle_cron_secret = '<same value as the LIFECYCLE_CRON_SECRET function secret>';
--    app.settings.edge_function_base_url is the one you already set for the daily briefing.
-- =============================================================
CREATE OR REPLACE FUNCTION public.dispatch_lifecycle_touch_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text := current_setting('app.settings.edge_function_base_url', true);
  v_secret text := current_setting('app.settings.lifecycle_cron_secret', true);
BEGIN
  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'lifecycle tick not dispatched: app.settings.edge_function_base_url / lifecycle_cron_secret not set';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_base_url || '/lifecycle-touch-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-lifecycle-secret', v_secret),
    body := '{}'::jsonb
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_lifecycle_touch_tick() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule('vireek-lifecycle-touch-tick', '20 * * * *', 'select public.dispatch_lifecycle_touch_tick()');
  ELSE
    RAISE NOTICE 'pg_cron/pg_net not enabled: call the lifecycle-touch-tick function hourly from an external scheduler instead.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;
