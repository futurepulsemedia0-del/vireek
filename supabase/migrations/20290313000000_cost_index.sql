/*
  # Vireek Cost Index — published, anonymized repair / install price index  (item 140)

  Reuses the State of Calls consent + eligibility pipeline (report_contribution_settings, report_eligible_orgs,
  report_org_attrs, report_census_region). Only organisations with an active 'granted' consent contribute;
  revoking consent or a pending deletion excludes them from the NEXT build, and publish re-derives the numbers.

  Privacy floors (SQL CHECKs are the last line; TypeScript disclosure control is the first):
    k >= 10 organisations, >= 100 jobs, dominance cap enforced in TypeScript (max org share <= 0.35),
    geography never finer than a US Census region, prices rounded ($10 / $50 / $100 steps), counts rounded.

  Nothing is inferred: a job contributes only if its service_type is mapped to 'repair' or 'install' in
  cost_index_service_map (staff-maintained, EMPTY by default => an empty index, never a guessed one).
  TODO(owner): supply the service_type mapping and confirm PARAMS (price band, min jobs per org).
  TODO(counsel): public wording, terms of the opt-in for price data.

  Rollback (dev/staging): DROP TABLE cost_index_audit, cost_index_cells, cost_index_releases, cost_index_service_map CASCADE;
  drop the cost_index_* / staff_*cost_index* functions.
*/

CREATE OR REPLACE FUNCTION public.cost_index_service_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(substring(regexp_replace(lower(btrim(coalesce(p, ''))), '[\s_]+', '-', 'g') from '^[a-z0-9-]{2,60}$'), '');
$$;

-- Mirror of priceStepCents() in _shared/cost-index/schema.ts
CREATE OR REPLACE FUNCTION public.cost_index_step_cents(v bigint) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v < 100000 THEN 1000 WHEN v < 1000000 THEN 5000 ELSE 10000 END;
$$;

CREATE TABLE IF NOT EXISTS public.cost_index_service_map (
  service_key text PRIMARY KEY CHECK (service_key ~ '^[a-z0-9-]{2,60}$'),
  job_kind    text NOT NULL CHECK (job_kind IN ('repair', 'install')),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cost_index_service_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_index_service_map FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.cost_index_releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 60),
  period_key      text NOT NULL CHECK (period_key ~ '^\d{4}(-Q[1-4])?$'),
  release_seq     integer NOT NULL CHECK (release_seq >= 1),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  as_of           timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded', 'withdrawn')),
  method_version  text NOT NULL,
  cells_hash      text NOT NULL CHECK (cells_hash ~ '^[0-9a-f]{64}$'),
  thresholds      jsonb NOT NULL,
  disclosure_report jsonb,
  changelog       text NOT NULL DEFAULT '' CHECK (char_length(changelog) <= 1000),
  document        jsonb NOT NULL,
  review          jsonb NOT NULL DEFAULT '{}'::jsonb,
  superseded_by   uuid REFERENCES public.cost_index_releases (id),
  built_at        timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  withdrawn_at    timestamptz,
  withdrawn_reason text,
  UNIQUE (period_key, release_seq),
  CONSTRAINT cir_period CHECK (period_end >= period_start),
  CONSTRAINT cir_published_stamp CHECK (status NOT IN ('published', 'superseded') OR published_at IS NOT NULL)
);
ALTER TABLE public.cost_index_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_index_releases FROM anon, authenticated;   -- served by the public edge function only

CREATE TABLE IF NOT EXISTS public.cost_index_cells (
  release_id uuid NOT NULL REFERENCES public.cost_index_releases (id) ON DELETE CASCADE,
  job_kind   text NOT NULL CHECK (job_kind IN ('repair', 'install')),
  trade      text NOT NULL CHECK (trade ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  region     text NOT NULL CHECK (region IN ('all', 'northeast', 'midwest', 'south', 'west')),
  period_key text NOT NULL CHECK (period_key ~ '^\d{4}(-Q[1-4])?$'),
  suppressed boolean NOT NULL,
  suppression_reason text CHECK (suppression_reason IN ('k_anonymity', 'dominance', 'low_volume', 'complementary', 'no_data')),
  n_orgs integer, n_jobs integer, p25_cents bigint, p50_cents bigint, p75_cents bigint,
  PRIMARY KEY (release_id, job_kind, trade, region, period_key),
  CONSTRAINT cic_suppressed_empty CHECK (
    NOT suppressed OR (suppression_reason IS NOT NULL AND n_orgs IS NULL AND n_jobs IS NULL AND p25_cents IS NULL AND p50_cents IS NULL AND p75_cents IS NULL)),
  -- FINAL FLOOR: whatever the application does, a published row cannot describe < 10 organisations / < 100 jobs, or carry exact prices.
  CONSTRAINT cic_published_floor CHECK (
    suppressed OR (suppression_reason IS NULL AND n_orgs IS NOT NULL AND n_orgs >= 10 AND n_jobs IS NOT NULL AND n_jobs >= 100
      AND p25_cents IS NOT NULL AND p50_cents IS NOT NULL AND p75_cents IS NOT NULL
      AND p25_cents <= p50_cents AND p50_cents <= p75_cents
      AND p25_cents % public.cost_index_step_cents(p25_cents) = 0
      AND p50_cents % public.cost_index_step_cents(p50_cents) = 0
      AND p75_cents % public.cost_index_step_cents(p75_cents) = 0))
);
ALTER TABLE public.cost_index_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_index_cells FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.cost_index_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('build', 'review', 'publish', 'withdraw', 'service_map')),
  release_id uuid, release_slug text, cells_hash text, actor text NOT NULL, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cost_index_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_index_audit FROM anon, authenticated;
DROP TRIGGER IF EXISTS cost_index_audit_append_only ON public.cost_index_audit;
CREATE TRIGGER cost_index_audit_append_only BEFORE UPDATE OR DELETE ON public.cost_index_audit
  FOR EACH ROW EXECUTE FUNCTION public.rr_forbid_change();

-- Aggregation: org-level medians first, then percentiles ACROSS organisations. No organisation identifier leaves this function.
CREATE OR REPLACE FUNCTION public.cost_index_build_raw_cells(
  p_period_key text, p_start timestamptz, p_end timestamptz, p_k_min integer DEFAULT 10,
  p_floor_cents integer DEFAULT 2500, p_ceiling_cents integer DEFAULT 25000000, p_min_jobs_per_org integer DEFAULT 3)
RETURNS TABLE (trade text, region text, job_kind text, period_key text, n_orgs integer, n_jobs integer,
               org_p25_cents numeric, org_p50_cents numeric, org_p75_cents numeric, max_org_share numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_orgs uuid[];
BEGIN
  IF p_period_key !~ '^\d{4}(-Q[1-4])?$' OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'invalid period' USING ERRCODE = '22023';
  END IF;
  IF p_k_min IS NULL OR p_k_min < 1 OR p_floor_cents IS NULL OR p_floor_cents < 0 OR p_ceiling_cents IS NULL
     OR p_ceiling_cents <= p_floor_cents OR p_min_jobs_per_org IS NULL OR p_min_jobs_per_org < 1 THEN
    RAISE EXCEPTION 'invalid parameters' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(org ORDER BY org), '{}') INTO v_orgs FROM public.report_eligible_orgs();

  RETURN QUERY
  WITH attrs AS (SELECT * FROM public.report_org_attrs(v_orgs)),
  j AS (
    SELECT jb.user_id AS org, a.trade, a.region, m.job_kind, round(jb.invoice_amount * 100)::bigint AS cents
      FROM public.jobs jb
      JOIN attrs a ON a.org = jb.user_id
      JOIN public.cost_index_service_map m ON m.service_key = public.cost_index_service_key(jb.service_type)
     WHERE jb.user_id = ANY (v_orgs) AND jb.created_at >= p_start AND jb.created_at < p_end
       AND jb.job_status = 'completed' AND jb.invoice_amount IS NOT NULL
       AND round(jb.invoice_amount * 100) BETWEEN p_floor_cents AND p_ceiling_cents
       AND a.region IS NOT NULL AND a.trade <> 'other'
  ),
  per_org AS (
    SELECT org, trade, region, job_kind, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY cents) AS med
      FROM j GROUP BY org, trade, region, job_kind HAVING count(*) >= p_min_jobs_per_org
  ),
  cells AS (
    SELECT org, trade, region, job_kind, n, med FROM per_org
    UNION ALL SELECT org, trade, 'all', job_kind, n, med FROM per_org
  )
  SELECT c.trade, c.region, c.job_kind, p_period_key, count(*)::int, sum(c.n)::int,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY c.med), percentile_cont(0.5) WITHIN GROUP (ORDER BY c.med),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY c.med), max(c.n)::numeric / sum(c.n)
    FROM cells c GROUP BY c.trade, c.region, c.job_kind
   HAVING count(*) >= p_k_min;
END;
$$;

-- Atomic creation of a draft release + cells; assigns the next release_seq for the period; replaces older drafts.
CREATE OR REPLACE FUNCTION public.cost_index_create_release(
  p_period_key text, p_period_start date, p_period_end date, p_as_of timestamptz, p_title text, p_method_version text,
  p_cells_hash text, p_thresholds jsonb, p_report jsonb, p_changelog text, p_document jsonb, p_cells jsonb, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_seq integer; v_id uuid := gen_random_uuid(); v_slug text;
BEGIN
  IF jsonb_typeof(p_cells) <> 'array' THEN RAISE EXCEPTION 'cells must be an array' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cost_index:' || p_period_key));
  DELETE FROM public.cost_index_releases WHERE period_key = p_period_key AND status = 'draft';
  SELECT coalesce(max(release_seq), 0) + 1 INTO v_seq FROM public.cost_index_releases WHERE period_key = p_period_key;
  v_slug := 'cost-index-' || lower(p_period_key) || '-r' || v_seq;
  INSERT INTO public.cost_index_releases (id, slug, period_key, release_seq, title, period_start, period_end, as_of, method_version,
                                          cells_hash, thresholds, disclosure_report, changelog, document)
  VALUES (v_id, v_slug, p_period_key, v_seq, left(p_title, 160), p_period_start, p_period_end, p_as_of, p_method_version,
          p_cells_hash, p_thresholds, p_report, left(coalesce(p_changelog, ''), 1000), p_document);
  INSERT INTO public.cost_index_cells (release_id, job_kind, trade, region, period_key, suppressed, suppression_reason, n_orgs, n_jobs, p25_cents, p50_cents, p75_cents)
  SELECT v_id, x ->> 'job_kind', x ->> 'trade', x ->> 'region', x ->> 'period_key', (x ->> 'suppressed')::boolean, x ->> 'suppression_reason',
         (x ->> 'n_orgs')::int, (x ->> 'n_jobs')::int, (x ->> 'p25_cents')::bigint, (x ->> 'p50_cents')::bigint, (x ->> 'p75_cents')::bigint
    FROM jsonb_array_elements(p_cells) x;
  INSERT INTO public.cost_index_audit (action, release_id, release_slug, cells_hash, actor) VALUES ('build', v_id, v_slug, p_cells_hash, left(p_actor, 80));
  RETURN jsonb_build_object('id', v_id, 'slug', v_slug, 'release_seq', v_seq);
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_index_set_review(p_release uuid, p_review jsonb, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.cost_index_releases%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.cost_index_releases WHERE id = p_release FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'only a draft can be reviewed' USING ERRCODE = '55000'; END IF;
  UPDATE public.cost_index_releases SET review = p_review WHERE id = p_release;
  INSERT INTO public.cost_index_audit (action, release_id, release_slug, cells_hash, actor) VALUES ('review', r.id, r.slug, r.cells_hash, left(p_actor, 80));
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Mirror of reviewComplete() in _shared/cost-index/release.ts. Keep the item list identical.
CREATE OR REPLACE FUNCTION public.cost_index_publish_release(p_release uuid, p_expected_hash text, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.cost_index_releases%ROWTYPE; v_item text; v_bad integer; v_a text; v_b text;
BEGIN
  SELECT * INTO r FROM public.cost_index_releases WHERE id = p_release FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status = 'published' THEN RETURN jsonb_build_object('status', 'published', 'changed', false); END IF;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'only a draft can be published (status: %)', r.status USING ERRCODE = '55000'; END IF;
  IF r.cells_hash <> p_expected_hash THEN RAISE EXCEPTION 'cells hash changed since review' USING ERRCODE = '55000'; END IF;
  FOREACH v_item IN ARRAY ARRAY['consent_ledger_checked', 'thresholds_confirmed', 'service_map_reviewed', 'spot_check_recomputed', 'methodology_page_current', 'legal_review_complete'] LOOP
    IF coalesce(r.review -> 'items' ->> v_item, '') <> 'true' THEN RAISE EXCEPTION 'review item not ticked: %', v_item USING ERRCODE = '55000'; END IF;
  END LOOP;
  v_a := lower(btrim(coalesce(r.review ->> 'reviewer', '')));
  v_b := lower(btrim(coalesce(r.review ->> 'second_reviewer', '')));
  IF v_a = '' OR v_b = '' OR v_a = v_b THEN RAISE EXCEPTION 'two different named reviewers are required' USING ERRCODE = '55000'; END IF;
  SELECT count(*) INTO v_bad FROM public.cost_index_cells WHERE release_id = r.id AND NOT suppressed AND (n_orgs < 10 OR n_jobs < 100);
  IF v_bad > 0 THEN RAISE EXCEPTION 'cells below threshold present' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cost_index_cells WHERE release_id = r.id AND NOT suppressed) THEN
    RAISE EXCEPTION 'release has no publishable cells' USING ERRCODE = '55000';
  END IF;

  UPDATE public.cost_index_releases SET status = 'superseded', superseded_by = r.id
   WHERE period_key = r.period_key AND status = 'published' AND id <> r.id;
  UPDATE public.cost_index_releases SET status = 'published', published_at = now() WHERE id = r.id;
  INSERT INTO public.cost_index_audit (action, release_id, release_slug, cells_hash, actor) VALUES ('publish', r.id, r.slug, r.cells_hash, left(p_actor, 80));
  RETURN jsonb_build_object('status', 'published', 'changed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_index_withdraw_release(p_release uuid, p_reason text, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.cost_index_releases%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.cost_index_releases WHERE id = p_release FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status = 'withdrawn' THEN RETURN jsonb_build_object('status', 'withdrawn', 'changed', false); END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.cost_index_releases SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = left(p_reason, 500) WHERE id = r.id;
  INSERT INTO public.cost_index_audit (action, release_id, release_slug, cells_hash, actor, note) VALUES ('withdraw', r.id, r.slug, r.cells_hash, left(p_actor, 80), left(p_reason, 500));
  RETURN jsonb_build_object('status', 'withdrawn', 'changed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.cost_index_set_service_map(p_service text, p_kind text, p_actor text DEFAULT 'staff')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key text := public.cost_index_service_key(p_service);
BEGIN
  IF v_key IS NULL THEN RAISE EXCEPTION 'invalid service key' USING ERRCODE = '22023'; END IF;
  IF p_kind IS NULL THEN
    DELETE FROM public.cost_index_service_map WHERE service_key = v_key;
  ELSE
    INSERT INTO public.cost_index_service_map (service_key, job_kind) VALUES (v_key, p_kind)
    ON CONFLICT (service_key) DO UPDATE SET job_kind = EXCLUDED.job_kind, updated_at = now();
  END IF;
  INSERT INTO public.cost_index_audit (action, actor, note) VALUES ('service_map', left(p_actor, 80), v_key || ' -> ' || coalesce(p_kind, 'removed'));
  RETURN jsonb_build_object('service_key', v_key, 'job_kind', p_kind);
END;
$$;

-- Grants: everything internal is service_role only.
REVOKE ALL ON FUNCTION public.cost_index_service_key(text), public.cost_index_step_cents(bigint),
  public.cost_index_build_raw_cells(text, timestamptz, timestamptz, integer, integer, integer, integer),
  public.cost_index_create_release(text, date, date, timestamptz, text, text, text, jsonb, jsonb, text, jsonb, jsonb, text),
  public.cost_index_set_review(uuid, jsonb, text), public.cost_index_publish_release(uuid, text, text),
  public.cost_index_withdraw_release(uuid, text, text), public.cost_index_set_service_map(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cost_index_service_key(text), public.cost_index_step_cents(bigint),
  public.cost_index_build_raw_cells(text, timestamptz, timestamptz, integer, integer, integer, integer),
  public.cost_index_create_release(text, date, date, timestamptz, text, text, text, jsonb, jsonb, text, jsonb, jsonb, text),
  public.cost_index_set_review(uuid, jsonb, text), public.cost_index_publish_release(uuid, text, text),
  public.cost_index_withdraw_release(uuid, text, text), public.cost_index_set_service_map(text, text, text) TO service_role;
GRANT ALL ON public.cost_index_service_map, public.cost_index_releases, public.cost_index_cells, public.cost_index_audit TO service_role;
