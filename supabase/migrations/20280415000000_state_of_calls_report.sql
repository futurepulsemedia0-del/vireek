/*
  # State of Home Service Calls - opt-in aggregate report pipeline

  PURPOSE
    Publish an annual / quarterly report built ONLY from organisations that explicitly opted in, using
    aggregate statistics that pass k-anonymity, dominance and volume thresholds.

  WHAT THIS IS NOT
    It does not reuse compute_platform_benchmarks / compute_regional_demand / outcome_benchmark_*:
    those are in-product benchmarks and are NOT consent-gated for publication (outcome_benchmark_settings
    defaults to participating = true, i.e. opt-OUT). Nothing here reads those tables.

  DESIGN
    1. Consent        report_contribution_settings (current state) + report_consent_events (append-only ledger).
                      Org-level (account owner), owner/admin only, revocable. Revocation excludes the org from every
                      future build; a pending deletion request also excludes it.
    2. Facts          report_facts_* : ONE definition of every per-organisation count. Used by the aggregate builder
                      (all consenting orgs) and by the contributor widget (the caller's own org only).
    3. Aggregation    report_build_raw_cells(): set-based aggregates, k-masked, service_role only. Output has no
                      organisation identifiers (matches RawCell in _shared/state-of-calls/schema.ts).
    4. Disclosure     Done in TypeScript (_shared/state-of-calls/disclosure.ts): dominance, volume, complementary
                      suppression, rounding, release gate. The CHECK constraints on report_cells are the final floor.
    5. Publication    report_publish_edition(): requires legal + fact-check sign-off and an unchanged cells hash.
    6. Audit          report_export_audit: append-only (trigger blocks UPDATE/DELETE).

  ACCESS MODEL
    Every table below has RLS enabled and NO client policy except the caller's own consent rows.
    Public readers only ever receive the frozen report_editions.document via the state-of-calls-public edge function.

  ROLLBACK (manual; destroys consent history - export it first if required)
    drop function if exists public.report_my_comparison(text);
    drop function if exists public.report_count_download(uuid, text);
    drop function if exists public.report_publish_edition(uuid, text, text);
    drop function if exists public.report_withdraw_edition(uuid, text, text);
    drop function if exists public.report_build_raw_cells(text, timestamptz, timestamptz, integer);
    drop function if exists public.report_facts_scalar(uuid[], timestamptz, timestamptz);
    drop function if exists public.report_facts_lang(uuid[], timestamptz, timestamptz);
    drop function if exists public.report_facts_month(uuid[], timestamptz, timestamptz);
    drop function if exists public.report_org_attrs(uuid[]);
    drop function if exists public.report_eligible_orgs();
    drop function if exists public.report_after_hours(timestamptz, text, jsonb);
    drop function if exists public.report_census_region(text);
    drop function if exists public.get_report_contribution();
    drop function if exists public.set_report_contribution(boolean, text);
    drop function if exists public.rr_can_manage_consent();
    drop table if exists public.report_download_counters, public.report_export_audit, public.report_cells,
      public.report_editions, public.report_consent_events, public.report_contribution_settings;
*/

-- ============================================================================================
-- 1. CONSENT
-- ============================================================================================
CREATE TABLE IF NOT EXISTS public.report_contribution_settings (
  account_owner_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('granted', 'revoked')),
  terms_version    text CHECK (terms_version IS NULL OR char_length(terms_version) BETWEEN 1 AND 40),
  granted_at       timestamptz,
  revoked_at       timestamptz,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_settings_granted_has_terms CHECK (status <> 'granted' OR (terms_version IS NOT NULL AND granted_at IS NOT NULL))
);
ALTER TABLE public.report_contribution_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_settings_select_own ON public.report_contribution_settings;
CREATE POLICY report_settings_select_own ON public.report_contribution_settings
  FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id());
REVOKE ALL ON public.report_contribution_settings FROM anon, authenticated;
GRANT SELECT ON public.report_contribution_settings TO authenticated;

CREATE TABLE IF NOT EXISTS public.report_consent_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  action           text NOT NULL CHECK (action IN ('granted', 'revoked')),
  terms_version    text CHECK (terms_version IS NULL OR char_length(terms_version) BETWEEN 1 AND 40),
  actor_user_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_consent_events_owner_idx ON public.report_consent_events (account_owner_id, created_at DESC);
ALTER TABLE public.report_consent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_consent_events_select_own ON public.report_consent_events;
CREATE POLICY report_consent_events_select_own ON public.report_consent_events
  FOR SELECT TO authenticated USING (account_owner_id = public.get_account_owner_id());
REVOKE ALL ON public.report_consent_events FROM anon, authenticated;
GRANT SELECT ON public.report_consent_events TO authenticated;

CREATE OR REPLACE FUNCTION public.rr_forbid_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS report_consent_events_append_only ON public.report_consent_events;
CREATE TRIGGER report_consent_events_append_only BEFORE UPDATE ON public.report_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.rr_forbid_change();
-- (DELETE is intentionally still possible: account erasure cascades from auth.users.)

-- Owner / admin of the account only. Team members cannot grant or revoke data-sharing consent.
CREATE OR REPLACE FUNCTION public.rr_can_manage_consent() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('owner', 'admin'));
$$;

CREATE OR REPLACE FUNCTION public.set_report_contribution(p_grant boolean, p_terms_version text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_current text;
  v_terms text := NULLIF(btrim(coalesce(p_terms_version, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.rr_can_manage_consent() THEN
    RAISE EXCEPTION 'Only the account owner can change data-sharing consent' USING ERRCODE = '42501';
  END IF;
  IF p_grant IS NULL THEN RAISE EXCEPTION 'p_grant is required' USING ERRCODE = '22023'; END IF;
  IF p_grant AND (v_terms IS NULL OR char_length(v_terms) > 40) THEN
    RAISE EXCEPTION 'The terms version being accepted is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('report_consent:' || v_owner::text)); -- serialise concurrent toggles
  SELECT status INTO v_current FROM report_contribution_settings WHERE account_owner_id = v_owner;

  -- idempotent: re-sending the same decision changes nothing and writes no ledger row
  IF (p_grant AND v_current = 'granted') OR (NOT p_grant AND coalesce(v_current, 'revoked') = 'revoked') THEN
    RETURN jsonb_build_object('status', coalesce(v_current, 'revoked'), 'changed', false);
  END IF;

  IF p_grant THEN
    INSERT INTO report_contribution_settings (account_owner_id, status, terms_version, granted_at, revoked_at, updated_by, updated_at)
    VALUES (v_owner, 'granted', v_terms, now(), NULL, auth.uid(), now())
    ON CONFLICT (account_owner_id) DO UPDATE
      SET status = 'granted', terms_version = EXCLUDED.terms_version, granted_at = now(), revoked_at = NULL,
          updated_by = auth.uid(), updated_at = now();
  ELSE
    UPDATE report_contribution_settings
       SET status = 'revoked', revoked_at = now(), updated_by = auth.uid(), updated_at = now()
     WHERE account_owner_id = v_owner;
  END IF;
  INSERT INTO report_consent_events (account_owner_id, action, terms_version, actor_user_id)
  VALUES (v_owner, CASE WHEN p_grant THEN 'granted' ELSE 'revoked' END, v_terms, auth.uid());
  RETURN jsonb_build_object('status', CASE WHEN p_grant THEN 'granted' ELSE 'revoked' END, 'changed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_report_contribution() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'status', coalesce(s.status, 'not_set'),
    'terms_version', s.terms_version,
    'granted_at', s.granted_at,
    'revoked_at', s.revoked_at,
    'can_manage', public.rr_can_manage_consent()
  )
  FROM (SELECT 1) one
  LEFT JOIN report_contribution_settings s ON s.account_owner_id = public.get_account_owner_id();
$$;

-- ============================================================================================
-- 2. EDITIONS, CELLS, AUDIT
-- ============================================================================================
CREATE TABLE IF NOT EXISTS public.report_editions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 60),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  kind           text NOT NULL CHECK (kind IN ('annual', 'quarterly')),
  period_key     text NOT NULL CHECK (period_key ~ '^\d{4}(-Q[1-4])?$'),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  as_of          timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  method_version text NOT NULL,
  cells_hash     text NOT NULL CHECK (cells_hash ~ '^[0-9a-f]{64}$'),
  thresholds     jsonb NOT NULL,
  disclosure_report jsonb,
  document       jsonb NOT NULL,                      -- frozen public edition document (see edition.ts)
  review         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {legal_review_at, legal_reviewer, fact_check_at, fact_checker}
  built_at       timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  withdrawn_at   timestamptz,
  CONSTRAINT report_editions_period CHECK (period_end >= period_start),
  CONSTRAINT report_editions_published_stamp CHECK (status <> 'published' OR published_at IS NOT NULL)
);
ALTER TABLE public.report_editions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_editions FROM anon, authenticated;   -- no policy: deny by default; served via edge function only

CREATE TABLE IF NOT EXISTS public.report_cells (
  edition_id         uuid NOT NULL REFERENCES public.report_editions (id) ON DELETE CASCADE,
  metric_key         text NOT NULL CHECK (metric_key IN ('answer_rate', 'missed_call_rate', 'after_hours_share', 'emergency_share',
                       'booking_conversion', 'lead_first_response_minutes', 'avg_ticket_usd', 'seasonality_index', 'language_share')),
  dim                text NOT NULL CHECK (dim IN ('national', 'trade', 'region', 'season', 'language')),
  dim_value          text NOT NULL CHECK (dim_value ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  period_key         text NOT NULL CHECK (period_key ~ '^\d{4}(-Q[1-4])?$'),
  unit               text NOT NULL CHECK (unit IN ('percent', 'minutes', 'usd')),
  suppressed         boolean NOT NULL,
  suppression_reason text CHECK (suppression_reason IN ('k_anonymity', 'dominance', 'low_volume', 'complementary', 'no_data')),
  n_orgs             integer,
  n_events           integer,
  value              numeric,
  p25                numeric,
  p50                numeric,
  p75                numeric,
  PRIMARY KEY (edition_id, metric_key, dim, dim_value, period_key),
  -- geography can never be finer than a census region; no crossed dimensions exist in this schema at all
  CONSTRAINT report_cells_region_allowlist CHECK (dim <> 'region' OR dim_value IN ('northeast', 'midwest', 'south', 'west')),
  CONSTRAINT report_cells_national_value CHECK (dim <> 'national' OR dim_value = 'all'),
  -- FINAL FLOOR: whatever the application does, a published row cannot describe fewer than 10 organisations
  CONSTRAINT report_cells_suppressed_is_empty CHECK (
    NOT suppressed OR (suppression_reason IS NOT NULL AND n_orgs IS NULL AND n_events IS NULL AND value IS NULL AND p25 IS NULL AND p50 IS NULL AND p75 IS NULL)),
  CONSTRAINT report_cells_published_floor CHECK (
    suppressed OR (suppression_reason IS NULL AND n_orgs IS NOT NULL AND n_orgs >= 10 AND n_events IS NOT NULL AND n_events >= 100 AND value IS NOT NULL))
);
ALTER TABLE public.report_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_cells FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.report_export_audit (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  action       text NOT NULL CHECK (action IN ('build', 'review_signoff', 'publish', 'withdraw', 'csv_export', 'preview')),
  edition_id   uuid,
  edition_slug text,
  cell_count   integer,
  published_cell_count integer,
  cells_hash   text,
  actor        text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 80),   -- 'system' or a staff label; never a customer
  note         text CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE INDEX IF NOT EXISTS report_export_audit_edition_idx ON public.report_export_audit (edition_id, occurred_at DESC);
ALTER TABLE public.report_export_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_export_audit FROM anon, authenticated;
DROP TRIGGER IF EXISTS report_export_audit_append_only ON public.report_export_audit;
CREATE TRIGGER report_export_audit_append_only BEFORE UPDATE OR DELETE ON public.report_export_audit
  FOR EACH ROW EXECUTE FUNCTION public.rr_forbid_change();

-- Public downloads are COUNTED per day, never logged per visitor (no IP, no user agent, no identity).
CREATE TABLE IF NOT EXISTS public.report_download_counters (
  day        date NOT NULL,
  edition_id uuid NOT NULL REFERENCES public.report_editions (id) ON DELETE CASCADE,
  format     text NOT NULL CHECK (format IN ('json', 'csv', 'embed', 'pdf')),
  n          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, edition_id, format)
);
ALTER TABLE public.report_download_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_download_counters FROM anon, authenticated;

-- ============================================================================================
-- 3. PER-ORGANISATION FACTS (single definition; internal only)
-- ============================================================================================
-- US state -> Census region. NULL when unknown. (ob_region_key returns a lowercase 2-letter code or 'all'.)
CREATE OR REPLACE FUNCTION public.report_census_region(p_state text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_state = ANY (ARRAY['ct','me','ma','nh','ri','vt','nj','ny','pa']) THEN 'northeast'
    WHEN p_state = ANY (ARRAY['il','in','mi','oh','wi','ia','ks','mn','mo','ne','nd','sd']) THEN 'midwest'
    WHEN p_state = ANY (ARRAY['de','dc','fl','ga','md','nc','sc','va','wv','al','ky','ms','tn','ar','la','ok','tx']) THEN 'south'
    WHEN p_state = ANY (ARRAY['az','co','id','mt','nv','nm','ut','wy','ak','ca','hi','or','wa']) THEN 'west'
    ELSE NULL END;
$$;

-- TRUE = outside configured hours, FALSE = inside, NULL = cannot be determined (no zone / no hours / overnight window).
-- A weekday missing from a non-empty business_hours object means "closed that day".
CREATE OR REPLACE FUNCTION public.report_after_hours(p_at timestamptz, p_tz text, p_hours jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_local timestamp;
  v_day jsonb;
  v_open time;
  v_close time;
BEGIN
  IF p_tz IS NULL OR p_hours IS NULL OR jsonb_typeof(p_hours) <> 'object' OR p_hours = '{}'::jsonb THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_tz) THEN RETURN NULL; END IF;
  v_local := p_at AT TIME ZONE p_tz;
  v_day := p_hours -> (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM v_local)::int + 1];
  IF v_day IS NULL OR jsonb_typeof(v_day) <> 'object' THEN RETURN TRUE; END IF;
  IF coalesce(v_day ->> 'open', '') !~ '^\d{2}:\d{2}$' OR coalesce(v_day ->> 'close', '') !~ '^\d{2}:\d{2}$' THEN RETURN NULL; END IF;
  BEGIN
    v_open := (v_day ->> 'open')::time; v_close := (v_day ->> 'close')::time;
  EXCEPTION WHEN others THEN RETURN NULL;
  END;
  IF v_close <= v_open THEN RETURN NULL; END IF;
  RETURN NOT (v_local::time >= v_open AND v_local::time < v_close);
END;
$$;

-- Organisations that may be included in a build RIGHT NOW: consent granted, not being deleted.
CREATE OR REPLACE FUNCTION public.report_eligible_orgs() RETURNS TABLE (org uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.account_owner_id
    FROM report_contribution_settings s
   WHERE s.status = 'granted'
     AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = s.account_owner_id)
     AND NOT EXISTS (SELECT 1 FROM deletion_requests d
                      WHERE d.user_id = s.account_owner_id AND d.request_type = 'full_account'
                        AND d.status IN ('grace_period', 'processing', 'blocked_legal_hold'));
$$;

CREATE OR REPLACE FUNCTION public.report_org_attrs(p_orgs uuid[]) RETURNS TABLE (org uuid, trade text, region text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id,
         coalesce(NULLIF(substring(regexp_replace(lower(btrim(bp.primary_industry)), '[\s_]+', '-', 'g') from '^[a-z0-9-]{2,40}$'), ''), 'other'),
         public.report_census_region(NULLIF(public.ob_region_key(bp.service_area), 'all'))
    FROM unnest(p_orgs) AS o(id)
    LEFT JOIN business_profile bp ON bp.user_id = o.id;
$$;

CREATE OR REPLACE FUNCTION public.report_facts_month(p_orgs uuid[], p_start timestamptz, p_end timestamptz)
RETURNS TABLE (org uuid, month_no integer, calls integer, missed integer, hours_eligible integer, after_hours integer,
               emergency integer, booked integer, lang_known integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH c AS (
    SELECT cl.user_id AS org,
           extract(month FROM cl.call_datetime AT TIME ZONE 'UTC')::int AS month_no,
           (cl.status = 'missed' OR cl.is_voicemail) AS is_missed,
           cl.status = 'booked' AS is_booked,
           cl.is_emergency,
           NULLIF(btrim(cl.detected_language), '') IS NOT NULL AS has_lang,
           public.report_after_hours(cl.call_datetime, rs.time_zone, bp.business_hours) AS ah
      FROM calls cl
      LEFT JOIN business_regional_settings rs ON rs.user_id = cl.user_id
      LEFT JOIN business_profile bp ON bp.user_id = cl.user_id
     WHERE cl.user_id = ANY (p_orgs)
       AND cl.call_datetime >= p_start AND cl.call_datetime < p_end
       AND cl.status IS DISTINCT FROM 'spam'
  )
  SELECT org, month_no,
         count(*)::int,
         count(*) FILTER (WHERE is_missed)::int,
         count(*) FILTER (WHERE ah IS NOT NULL)::int,
         count(*) FILTER (WHERE ah)::int,
         count(*) FILTER (WHERE is_emergency)::int,
         count(*) FILTER (WHERE is_booked AND NOT is_missed)::int,
         count(*) FILTER (WHERE has_lang)::int
    FROM c GROUP BY org, month_no;
$$;

CREATE OR REPLACE FUNCTION public.report_facts_lang(p_orgs uuid[], p_start timestamptz, p_end timestamptz)
RETURNS TABLE (org uuid, lang text, n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cl.user_id,
         CASE WHEN lower(btrim(cl.detected_language)) ~ '^[a-z][a-z -]{1,38}$'
              THEN regexp_replace(lower(btrim(cl.detected_language)), ' +', '-', 'g') ELSE 'other' END,
         count(*)::int
    FROM calls cl
   WHERE cl.user_id = ANY (p_orgs)
     AND cl.call_datetime >= p_start AND cl.call_datetime < p_end
     AND cl.status IS DISTINCT FROM 'spam'
     AND NULLIF(btrim(cl.detected_language), '') IS NOT NULL
   GROUP BY 1, 2;
$$;

-- Lead first-response (median minutes, capped at 7 days, only where recorded) and completed-job tickets.
CREATE OR REPLACE FUNCTION public.report_facts_scalar(p_orgs uuid[], p_start timestamptz, p_end timestamptz)
RETURNS TABLE (org uuid, lead_resp_n integer, lead_resp_median_min numeric, ticket_jobs integer, ticket_sum numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH l AS (
    SELECT user_id AS org, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_response_at - created_at)) / 60.0) AS med
      FROM leads
     WHERE user_id = ANY (p_orgs) AND created_at >= p_start AND created_at < p_end
       AND first_response_at IS NOT NULL AND first_response_at >= created_at
       AND first_response_at <= created_at + interval '7 days'
     GROUP BY user_id
  ), j AS (
    SELECT user_id AS org, count(*)::int AS n, sum(invoice_amount) AS total
      FROM jobs
     WHERE user_id = ANY (p_orgs) AND created_at >= p_start AND created_at < p_end
       AND job_status = 'completed' AND invoice_amount IS NOT NULL AND invoice_amount > 0
     GROUP BY user_id
  )
  SELECT o.id, coalesce(l.n, 0), l.med, coalesce(j.n, 0), coalesce(j.total, 0)
    FROM unnest(p_orgs) AS o(id)
    LEFT JOIN l ON l.org = o.id
    LEFT JOIN j ON j.org = o.id;
$$;

-- ============================================================================================
-- 4. AGGREGATE BUILDER  (output == RawCell; k-masked here, re-checked in TypeScript and by CHECK constraints)
-- ============================================================================================
CREATE OR REPLACE FUNCTION public.report_build_raw_cells(
  p_period_key text, p_start timestamptz, p_end timestamptz, p_k_min integer DEFAULT 10)
RETURNS TABLE (metric_key text, dim text, dim_value text, period_key text, n_orgs integer, n_events integer,
               pooled_value numeric, org_p25 numeric, org_p50 numeric, org_p75 numeric, max_org_share numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_orgs uuid[];
BEGIN
  IF p_period_key !~ '^\d{4}(-Q[1-4])?$' OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'invalid period' USING ERRCODE = '22023';
  END IF;
  IF p_k_min IS NULL OR p_k_min < 1 THEN RAISE EXCEPTION 'invalid k' USING ERRCODE = '22023'; END IF;
  -- Reads only: nothing below depends on now() or random(), so the same data state always yields the same rows.
  SELECT coalesce(array_agg(org ORDER BY org), '{}') INTO v_orgs FROM public.report_eligible_orgs();

  RETURN QUERY
  WITH attrs AS (SELECT * FROM public.report_org_attrs(v_orgs)),
  m AS (SELECT f.*, a.trade, a.region FROM public.report_facts_month(v_orgs, p_start, p_end) f JOIN attrs a ON a.org = f.org),
  contrib AS (
    SELECT org, trade, region, month_no, 'answer_rate'::text AS metric, (calls - missed)::numeric AS num, calls::numeric AS den FROM m
    UNION ALL SELECT org, trade, region, month_no, 'missed_call_rate', missed, calls FROM m
    UNION ALL SELECT org, trade, region, month_no, 'after_hours_share', after_hours, hours_eligible FROM m
    UNION ALL SELECT org, trade, region, month_no, 'emergency_share', emergency, calls FROM m
    UNION ALL SELECT org, trade, region, month_no, 'booking_conversion', booked, calls - missed FROM m
  ),
  dimmed AS (
    SELECT metric, 'national'::text AS d, 'all'::text AS dv, org, num, den FROM contrib
    UNION ALL SELECT metric, 'trade', trade, org, num, den FROM contrib
    UNION ALL SELECT metric, 'region', region, org, num, den FROM contrib WHERE region IS NOT NULL
    UNION ALL SELECT metric, 'season', CASE WHEN month_no IN (12, 1, 2) THEN 'winter' WHEN month_no IN (3, 4, 5) THEN 'spring'
                                              WHEN month_no IN (6, 7, 8) THEN 'summer' ELSE 'fall' END, org, num, den FROM contrib
  ),
  per_org AS (SELECT metric, d, dv, org, sum(num) AS num, sum(den) AS den FROM dimmed GROUP BY metric, d, dv, org HAVING sum(den) > 0),
  call_cells AS (
    SELECT metric AS mk, d, dv, count(*)::int AS n_orgs, sum(den)::bigint AS n_events,
           100.0 * sum(num) / sum(den) AS pooled,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY 100.0 * num / den) AS p25,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY 100.0 * num / den) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY 100.0 * num / den) AS p75,
           max(den) / sum(den) AS share
      FROM per_org GROUP BY metric, d, dv
  ),
  -- speed to first response + ticket: national / trade / region only
  sc AS (SELECT f.*, a.trade, a.region FROM public.report_facts_scalar(v_orgs, p_start, p_end) f JOIN attrs a ON a.org = f.org),
  sc_dim AS (
    SELECT 'national'::text AS d, 'all'::text AS dv, * FROM sc
    UNION ALL SELECT 'trade', trade, * FROM sc
    UNION ALL SELECT 'region', region, * FROM sc WHERE region IS NOT NULL
  ),
  lead_cells AS (
    SELECT 'lead_first_response_minutes'::text AS mk, d, dv, count(*)::int AS n_orgs, sum(lead_resp_n)::bigint AS n_events,
           NULL::numeric AS pooled,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY lead_resp_median_min) AS p25,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY lead_resp_median_min) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY lead_resp_median_min) AS p75,
           max(lead_resp_n)::numeric / sum(lead_resp_n) AS share
      FROM sc_dim WHERE lead_resp_n > 0 AND lead_resp_median_min IS NOT NULL GROUP BY d, dv
  ),
  ticket_cells AS (
    SELECT 'avg_ticket_usd'::text AS mk, d, dv, count(*)::int AS n_orgs, sum(ticket_jobs)::bigint AS n_events,
           sum(ticket_sum) / sum(ticket_jobs) AS pooled,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY ticket_sum / ticket_jobs) AS p25,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY ticket_sum / ticket_jobs) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ticket_sum / ticket_jobs) AS p75,
           max(ticket_jobs)::numeric / sum(ticket_jobs) AS share
      FROM sc_dim WHERE ticket_jobs > 0 GROUP BY d, dv
  ),
  -- seasonality: annual editions only; organisations with calls in all 12 months
  full_orgs AS (SELECT org, sum(calls) AS total FROM m GROUP BY org HAVING count(DISTINCT month_no) FILTER (WHERE calls > 0) = 12),
  season_cells AS (
    SELECT 'seasonality_index'::text AS mk, 'season'::text AS d, 'm' || lpad(m.month_no::text, 2, '0') AS dv,
           count(*)::int AS n_orgs, sum(m.calls)::bigint AS n_events, NULL::numeric AS pooled,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY 100.0 * m.calls / (fo.total / 12.0)) AS p25,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY 100.0 * m.calls / (fo.total / 12.0)) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY 100.0 * m.calls / (fo.total / 12.0)) AS p75,
           max(m.calls)::numeric / sum(m.calls) AS share
      FROM m JOIN full_orgs fo ON fo.org = m.org
     WHERE p_period_key ~ '^\d{4}$' GROUP BY m.month_no
  ),
  -- language mix: languages used by fewer than k orgs are grouped into 'other'
  lang_raw AS (SELECT * FROM public.report_facts_lang(v_orgs, p_start, p_end)),
  lang_used AS (SELECT lang, count(DISTINCT org) AS orgs FROM lang_raw GROUP BY lang),
  lang_bucket AS (SELECT lr.org, CASE WHEN lu.orgs >= p_k_min THEN lr.lang ELSE 'other' END AS b, sum(lr.n) AS n
                    FROM lang_raw lr JOIN lang_used lu USING (lang) GROUP BY 1, 2),
  lang_den AS (SELECT org, sum(lang_known) AS den FROM m GROUP BY org HAVING sum(lang_known) > 0),
  lang_grid AS (SELECT d.org, d.den, b.b FROM lang_den d CROSS JOIN (SELECT DISTINCT b FROM lang_bucket) b),
  lang_org AS (SELECT g.b, g.org, g.den, coalesce(lb.n, 0) AS num FROM lang_grid g LEFT JOIN lang_bucket lb ON lb.org = g.org AND lb.b = g.b),
  lang_cells AS (
    SELECT 'language_share'::text AS mk, 'language'::text AS d, b AS dv,
           count(*) FILTER (WHERE num > 0)::int AS n_orgs, sum(den)::bigint AS n_events,
           100.0 * sum(num) / sum(den) AS pooled,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY 100.0 * num / den) AS p25,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY 100.0 * num / den) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY 100.0 * num / den) AS p75,
           max(num)::numeric / NULLIF(sum(num), 0) AS share
      FROM lang_org GROUP BY b HAVING count(*) FILTER (WHERE num > 0) > 0
  ),
  allc AS (
    SELECT * FROM call_cells UNION ALL SELECT * FROM lead_cells UNION ALL SELECT * FROM ticket_cells
    UNION ALL SELECT * FROM season_cells UNION ALL SELECT * FROM lang_cells
  )
  SELECT a.mk, a.d, a.dv, p_period_key,
         CASE WHEN a.n_orgs < p_k_min THEN 0 ELSE a.n_orgs END,                       -- masked: a small cell never leaves the database
         CASE WHEN a.n_orgs < p_k_min THEN 0 ELSE least(a.n_events, 2147483647)::int END,
         CASE WHEN a.n_orgs < p_k_min THEN NULL ELSE a.pooled END,
         CASE WHEN a.n_orgs < p_k_min THEN NULL ELSE a.p25 END,
         CASE WHEN a.n_orgs < p_k_min THEN NULL ELSE a.p50 END,
         CASE WHEN a.n_orgs < p_k_min THEN NULL ELSE a.p75 END,
         CASE WHEN a.n_orgs < p_k_min THEN 0 ELSE coalesce(a.share, 0) END
    FROM allc a
   WHERE a.dv ~ '^[a-z0-9][a-z0-9_-]{0,39}$'
   ORDER BY a.mk, a.d, a.dv;
END;
$$;

-- ============================================================================================
-- 5. PUBLISH / WITHDRAW (service_role only; the edge function adds the admin-secret check)
-- ============================================================================================
CREATE OR REPLACE FUNCTION public.report_publish_edition(p_edition uuid, p_expected_hash text, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e report_editions%ROWTYPE;
  v_bad integer;
BEGIN
  SELECT * INTO e FROM report_editions WHERE id = p_edition FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'edition not found' USING ERRCODE = 'P0002'; END IF;
  IF e.status = 'published' THEN RETURN jsonb_build_object('status', 'published', 'changed', false); END IF;
  IF e.status <> 'draft' THEN RAISE EXCEPTION 'only a draft can be published (status: %)', e.status USING ERRCODE = '55000'; END IF;
  IF e.cells_hash <> p_expected_hash THEN RAISE EXCEPTION 'cells hash changed since review' USING ERRCODE = '55000'; END IF;
  IF coalesce(e.review ->> 'legal_review_at', '') = '' OR coalesce(e.review ->> 'fact_check_at', '') = ''
     OR coalesce(e.review ->> 'legal_reviewer', '') = '' OR coalesce(e.review ->> 'fact_checker', '') = '' THEN
    RAISE EXCEPTION 'legal review and fact-check sign-off are required' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_bad FROM report_cells WHERE edition_id = e.id AND NOT suppressed AND (n_orgs IS NULL OR n_orgs < 10 OR n_events IS NULL OR n_events < 100 OR value IS NULL);
  IF v_bad > 0 THEN RAISE EXCEPTION 'cells below threshold present' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM report_cells WHERE edition_id = e.id) THEN RAISE EXCEPTION 'edition has no cells' USING ERRCODE = '55000'; END IF;

  UPDATE report_editions SET status = 'published', published_at = now() WHERE id = e.id;
  INSERT INTO report_export_audit (action, edition_id, edition_slug, cell_count, published_cell_count, cells_hash, actor)
  SELECT 'publish', e.id, e.slug, count(*), count(*) FILTER (WHERE NOT suppressed), e.cells_hash, left(p_actor, 80)
    FROM report_cells WHERE edition_id = e.id;
  RETURN jsonb_build_object('status', 'published', 'changed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.report_withdraw_edition(p_edition uuid, p_reason text, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e report_editions%ROWTYPE;
BEGIN
  SELECT * INTO e FROM report_editions WHERE id = p_edition FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'edition not found' USING ERRCODE = 'P0002'; END IF;
  IF e.status = 'withdrawn' THEN RETURN jsonb_build_object('status', 'withdrawn', 'changed', false); END IF;
  UPDATE report_editions SET status = 'withdrawn', withdrawn_at = now() WHERE id = e.id;
  INSERT INTO report_export_audit (action, edition_id, edition_slug, cells_hash, actor, note)
  VALUES ('withdraw', e.id, e.slug, e.cells_hash, left(p_actor, 80), left(p_reason, 500));
  RETURN jsonb_build_object('status', 'withdrawn', 'changed', true);
END;
$$;

-- Public downloads are counted per day (atomic upsert), never logged per visitor.
CREATE OR REPLACE FUNCTION public.report_count_download(p_edition uuid, p_format text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO report_download_counters (day, edition_id, format, n)
  SELECT (now() AT TIME ZONE 'UTC')::date, p_edition, p_format, 1
   WHERE p_format IN ('json', 'csv', 'embed', 'pdf') AND EXISTS (SELECT 1 FROM report_editions WHERE id = p_edition AND status = 'published')
  ON CONFLICT (day, edition_id, format) DO UPDATE SET n = report_download_counters.n + 1;
$$;

-- ============================================================================================
-- 6. CONTRIBUTOR WIDGET: "You vs. similar businesses"  (contributors only, own org only)
-- ============================================================================================
-- Compares the caller's OWN metrics, for the SAME period, against the PUBLISHED cells of the latest published
-- real edition (trade cell when it was published, otherwise the national cell). It never reads other organisations'
-- data: peers come only from already-published, k-anonymous aggregates.
CREATE OR REPLACE FUNCTION public.report_my_comparison(p_slug text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  e report_editions%ROWTYPE;
  v_trade text;
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT (public.ob_is_manager() OR public.rr_can_manage_consent()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM report_contribution_settings s WHERE s.account_owner_id = v_owner AND s.status = 'granted') THEN
    RAISE EXCEPTION 'Contribute anonymized statistics to unlock this comparison' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM report_editions
   WHERE status = 'published' AND (p_slug IS NULL OR slug = p_slug) AND coalesce((document ->> 'synthetic')::boolean, false) = false
   ORDER BY published_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('edition', NULL, 'rows', '[]'::jsonb); END IF;
  SELECT trade INTO v_trade FROM public.report_org_attrs(ARRAY[v_owner]);

  WITH mine AS (
    SELECT sum(calls) AS calls, sum(missed) AS missed, sum(emergency) AS emergency, sum(booked) AS booked,
           sum(hours_eligible) AS hrs, sum(after_hours) AS ah
      FROM public.report_facts_month(ARRAY[v_owner], (e.period_start::timestamp AT TIME ZONE 'UTC'), ((e.period_end + 1)::timestamp AT TIME ZONE 'UTC'))
  ), vals AS (
    SELECT 'answer_rate' AS mk, 100.0 * (calls - missed) / NULLIF(calls, 0) AS v, calls AS n FROM mine
    UNION ALL SELECT 'missed_call_rate', 100.0 * missed / NULLIF(calls, 0), calls FROM mine
    UNION ALL SELECT 'after_hours_share', 100.0 * ah / NULLIF(hrs, 0), hrs FROM mine
    UNION ALL SELECT 'emergency_share', 100.0 * emergency / NULLIF(calls, 0), calls FROM mine
    UNION ALL SELECT 'booking_conversion', 100.0 * booked / NULLIF(calls - missed, 0), calls - missed FROM mine
  ), peer AS (
    SELECT DISTINCT ON (c.metric_key) c.metric_key, c.dim, c.dim_value, c.p25, c.p50, c.p75, c.n_orgs
      FROM report_cells c
     WHERE c.edition_id = e.id AND NOT c.suppressed AND c.period_key = e.period_key
       AND ((c.dim = 'trade' AND c.dim_value = v_trade) OR (c.dim = 'national' AND c.dim_value = 'all'))
     ORDER BY c.metric_key, (c.dim = 'trade') DESC
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'metric_key', vals.mk, 'my_value', CASE WHEN vals.n >= 30 THEN round(vals.v, 1) END, 'my_events', vals.n,
           'peer_dim', peer.dim, 'peer_value', peer.dim_value, 'peer_p25', peer.p25, 'peer_p50', peer.p50, 'peer_p75', peer.p75,
           'peer_n_orgs', peer.n_orgs) ORDER BY vals.mk), '[]'::jsonb)
    INTO v_rows
    FROM vals JOIN peer ON peer.metric_key = vals.mk;

  RETURN jsonb_build_object('edition', jsonb_build_object('slug', e.slug, 'title', e.title, 'period_key', e.period_key), 'rows', v_rows);
END;
$$;

-- ============================================================================================
-- 7. GRANTS  (internal functions: service_role only; consent + widget: authenticated)
-- ============================================================================================
REVOKE ALL ON FUNCTION public.rr_forbid_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_census_region(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_after_hours(timestamptz, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_eligible_orgs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_org_attrs(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_facts_month(uuid[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_facts_lang(uuid[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_facts_scalar(uuid[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_build_raw_cells(text, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_publish_edition(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_withdraw_edition(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_count_download(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_count_download(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_census_region(text), public.report_after_hours(timestamptz, text, jsonb),
  public.report_eligible_orgs(), public.report_org_attrs(uuid[]), public.report_facts_month(uuid[], timestamptz, timestamptz),
  public.report_facts_lang(uuid[], timestamptz, timestamptz), public.report_facts_scalar(uuid[], timestamptz, timestamptz),
  public.report_build_raw_cells(text, timestamptz, timestamptz, integer), public.report_publish_edition(uuid, text, text),
  public.report_withdraw_edition(uuid, text, text) TO service_role;
GRANT ALL ON public.report_editions, public.report_cells, public.report_export_audit, public.report_download_counters,
  public.report_contribution_settings, public.report_consent_events TO service_role;

REVOKE ALL ON FUNCTION public.rr_can_manage_consent() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_report_contribution(boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_report_contribution() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_my_comparison(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rr_can_manage_consent(), public.set_report_contribution(boolean, text),
  public.get_report_contribution(), public.report_my_comparison(text) TO authenticated, service_role;
