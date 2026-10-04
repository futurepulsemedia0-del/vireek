/*
  # Vireek Evidence Marketplace

  ## Why
  Every job outcome a Vireek business records is a small piece of industry
  truth. Across thousands of businesses it becomes intelligence nobody else can
  produce: "this failure pattern was observed in 14,000 jobs". The Evidence
  Marketplace turns that into a product for the ecosystem (OEMs, parts
  suppliers, insurers, contractors, training providers) WITHOUT ever sharing
  personal or business-identifying data.

  ## Privacy architecture (every layer is enforced in SQL, not in the UI)
  1. OPT-IN ONLY. A business contributes nothing until its owner opts in
     (default off, versioned consent, append-only audit log). Part-usage and
     equipment signals are separate switches.
  2. DERIVED FIELDS ONLY. Only normalized keys leave a business: industry,
     job type, root cause, OEM make (matched to the OEM catalog), equipment age
     band, resolution class, duration and a part vocabulary. Never names,
     addresses, phones, notes, photos, job ids or technician ids. Free text is
     rejected by a strict key format.
  3. K-ANONYMITY. A pattern is published only when >= 5 distinct businesses AND
     >= 30 observations contributed (hard floors enforced by CHECK).
  4. DOMINANCE RULE. No single business may supply more than 40% of a pattern
     (otherwise the pattern would describe that business).
  5. DISCLOSURE CONTROL. Counts are rounded down (2 significant digits), rates
     get calibrated noise, durations are rounded to 5 minutes, a part is listed
     only if >= 5 businesses used it. This is DP-INSPIRED disclosure control,
     NOT a formally proven epsilon-differential-privacy guarantee. Say so.
  6. VALIDATION. Rework is excluded, a technician-recorded root cause is
     required, and every pattern carries an evidence-backed % (share of jobs
     with photo / measurement / test in the hash-chained evidence ledger) and a
     grade A/B/C.
  7. IMMUTABLE RELEASES. Each release is append-only and content-hashed so what
     a partner received can always be reproduced and audited.
  8. GIVE-TO-GET. Only opted-in businesses can read the network intelligence.
  9. REVOCABLE. Opting out removes the business from every FUTURE release
     immediately. Aggregates already released cannot be disaggregated.

  ## Tables
  evidence_policy, evidence_sharing_consent, evidence_consent_log,
  evidence_releases, evidence_patterns, evidence_products, evidence_partners,
  evidence_partner_keys, evidence_access_log.

  Depends on: job_outcomes, jobs, job_equipment, equipment, oem_manufacturers,
  business_profile, job_evidence_chain_entries, profiles.is_staff,
  public.get_account_owner_id(), public.is_vireek_staff().
*/

-- =============================================================
-- POLICY (hard privacy floors live in CHECK constraints)
-- =============================================================

CREATE TABLE IF NOT EXISTS evidence_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  min_contributors integer NOT NULL DEFAULT 5 CHECK (min_contributors >= 5),
  min_observations integer NOT NULL DEFAULT 30 CHECK (min_observations >= 30),
  max_dominance numeric(3, 2) NOT NULL DEFAULT 0.40 CHECK (max_dominance > 0 AND max_dominance <= 0.50),
  window_days integer NOT NULL DEFAULT 365 CHECK (window_days BETWEEN 90 AND 1095),
  consent_version integer NOT NULL DEFAULT 1 CHECK (consent_version >= 1)
);
INSERT INTO evidence_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- =============================================================
-- CONSENT
-- =============================================================

CREATE TABLE IF NOT EXISTS evidence_sharing_consent (
  user_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  share_part_usage boolean NOT NULL DEFAULT false,
  share_equipment_signals boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 1,
  consented_by uuid,
  consented_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_consent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid NOT NULL DEFAULT auth.uid(),
  action text NOT NULL CHECK (action IN ('opt_in', 'opt_out', 'update')),
  enabled boolean NOT NULL,
  share_part_usage boolean NOT NULL,
  share_equipment_signals boolean NOT NULL,
  consent_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_consent_log_user ON evidence_consent_log(user_id, created_at DESC);

-- =============================================================
-- RELEASES + PATTERNS (immutable)
-- =============================================================

CREATE TABLE IF NOT EXISTS evidence_releases (
  id uuid PRIMARY KEY,
  period_start date NOT NULL,
  period_end date NOT NULL,
  pattern_count integer NOT NULL CHECK (pattern_count >= 0),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_releases_created ON evidence_releases(created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES evidence_releases(id) DEFERRABLE INITIALLY DEFERRED,
  scope text NOT NULL CHECK (scope IN ('cause', 'equipment')),
  industry text NOT NULL,
  job_type_key text NOT NULL,
  root_cause_key text NOT NULL,
  make text NOT NULL DEFAULT '*',
  age_band text NOT NULL DEFAULT '*' CHECK (age_band IN ('*', '0-5', '6-10', '11-15', '16+')),
  observations_display integer NOT NULL CHECK (observations_display >= 30),
  contributors_display integer NOT NULL CHECK (contributors_display >= 5),
  ftf_rate numeric(4, 3) NOT NULL CHECK (ftf_rate BETWEEN 0 AND 1),
  callback_rate numeric(4, 3) NOT NULL CHECK (callback_rate BETWEEN 0 AND 1),
  median_minutes integer CHECK (median_minutes IS NULL OR median_minutes >= 0),
  top_parts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(top_parts) = 'array'),
  evidence_backed_pct integer NOT NULL CHECK (evidence_backed_pct BETWEEN 0 AND 100),
  grade text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  noise_applied boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_evidence_patterns_release ON evidence_patterns(release_id, scope, observations_display DESC);

-- =============================================================
-- PRODUCTS (single source of truth for UI and API)
-- =============================================================

CREATE TABLE IF NOT EXISTS evidence_products (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z_]{3,40}$'),
  name text NOT NULL,
  description text NOT NULL,
  partner_types text[] NOT NULL,
  scope text NOT NULL CHECK (scope IN ('cause', 'equipment', 'all')),
  fields text[] NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO evidence_products (slug, name, description, partner_types, scope, fields, sort_order) VALUES
  ('failure_patterns', 'Failure Patterns',
   'How often each failure mode occurs, by trade, equipment make and age band, with first-visit fix rate and typical duration.',
   ARRAY['oem', 'contractor', 'training_provider'], 'all',
   ARRAY['scope','industry','job_type_key','root_cause_key','make','age_band','observations_display','contributors_display','ftf_rate','median_minutes','evidence_backed_pct','grade'], 1),
  ('part_reliability', 'Part Reliability',
   'Which parts are consumed for each failure pattern, and how often, so supply can be matched to real field demand.',
   ARRAY['oem', 'parts_supplier'], 'all',
   ARRAY['scope','industry','job_type_key','root_cause_key','make','age_band','observations_display','contributors_display','top_parts','evidence_backed_pct','grade'], 2),
  ('claim_risk', 'Claim Risk Signals',
   'Callback and first-visit-fix rates by equipment make and age band: leading indicators of repeat-claim risk.',
   ARRAY['insurer'], 'equipment',
   ARRAY['industry','job_type_key','root_cause_key','make','age_band','observations_display','contributors_display','ftf_rate','callback_rate','evidence_backed_pct','grade'], 3),
  ('training_gaps', 'Training Gap Signals',
   'Job types and causes with the lowest first-visit-fix rates across the network: where field skills need support. No technician-level data.',
   ARRAY['training_provider', 'contractor'], 'cause',
   ARRAY['industry','job_type_key','root_cause_key','observations_display','contributors_display','ftf_rate','callback_rate','median_minutes','evidence_backed_pct','grade'], 4)
ON CONFLICT (slug) DO NOTHING;

-- =============================================================
-- PARTNERS, KEYS, ACCESS LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS evidence_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  partner_type text NOT NULL CHECK (partner_type IN ('oem', 'parts_supplier', 'insurer', 'contractor', 'training_provider')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  contact_email text CHECK (contact_email IS NULL OR char_length(contact_email) <= 200),
  contract_ref text CHECK (contract_ref IS NULL OR char_length(contract_ref) <= 120),
  contract_expires_at date,
  allowed_products text[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_partner_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES evidence_partners(id) ON DELETE CASCADE,
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 6 AND 24),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_evidence_partner_keys_partner ON evidence_partner_keys(partner_id);

CREATE TABLE IF NOT EXISTS evidence_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES evidence_partners(id) ON DELETE CASCADE,
  key_id uuid REFERENCES evidence_partner_keys(id) ON DELETE SET NULL,
  product text NOT NULL,
  release_id uuid,
  rows_returned integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_access_log_key ON evidence_access_log(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_access_log_created ON evidence_access_log(created_at DESC);

-- =============================================================
-- HELPERS
-- =============================================================

/* Normalizes a free-form key to a strict vocabulary; NULL if it is not a clean key. */
CREATE OR REPLACE FUNCTION public.evidence_norm_key(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN regexp_replace(lower(btrim(coalesce(p_text, ''))), '\s+', '_', 'g') ~ '^[a-z0-9_\-]{2,60}$'
    THEN regexp_replace(lower(btrim(p_text)), '\s+', '_', 'g')
    ELSE NULL END;
$$;

/* Part names keep spaces but obey the same strict character set. */
CREATE OR REPLACE FUNCTION public.evidence_norm_part(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN regexp_replace(lower(btrim(coalesce(p_text, ''))), '\s+', ' ', 'g') ~ '^[a-z0-9 \-/\.]{2,60}$'
    THEN regexp_replace(lower(btrim(p_text)), '\s+', ' ', 'g')
    ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public.evidence_round_count(p_n numeric)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT (floor(p_n / GREATEST(10::numeric, power(10::numeric, floor(log(p_n)) - 1))) * GREATEST(10::numeric, power(10::numeric, floor(log(p_n)) - 1)))::integer;
$$;

CREATE OR REPLACE FUNCTION public.evidence_sharing_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM evidence_sharing_consent
    WHERE user_id = public.get_account_owner_id() AND enabled
  );
$$;

CREATE OR REPLACE FUNCTION public.evidence_latest_release_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM evidence_releases ORDER BY created_at DESC, id DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.prevent_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_releases_immutable ON evidence_releases;
CREATE TRIGGER trg_evidence_releases_immutable BEFORE UPDATE OR DELETE ON evidence_releases
  FOR EACH ROW EXECUTE FUNCTION public.prevent_evidence_mutation();
DROP TRIGGER IF EXISTS trg_evidence_patterns_immutable ON evidence_patterns;
CREATE TRIGGER trg_evidence_patterns_immutable BEFORE UPDATE OR DELETE ON evidence_patterns
  FOR EACH ROW EXECUTE FUNCTION public.prevent_evidence_mutation();
DROP TRIGGER IF EXISTS trg_evidence_consent_log_immutable ON evidence_consent_log;
CREATE TRIGGER trg_evidence_consent_log_immutable BEFORE UPDATE OR DELETE ON evidence_consent_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_evidence_mutation();

-- =============================================================
-- RLS
-- =============================================================

ALTER TABLE evidence_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_sharing_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_consent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_partner_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_evidence_consent" ON evidence_sharing_consent;
CREATE POLICY "select_own_evidence_consent" ON evidence_sharing_consent
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_evidence_consent_log" ON evidence_consent_log;
CREATE POLICY "select_own_evidence_consent_log" ON evidence_consent_log
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

-- Give-to-get: only opted-in businesses read network intelligence.
DROP POLICY IF EXISTS "select_evidence_releases_if_contributing" ON evidence_releases;
CREATE POLICY "select_evidence_releases_if_contributing" ON evidence_releases
  FOR SELECT TO authenticated USING (public.evidence_sharing_active());

DROP POLICY IF EXISTS "select_latest_evidence_patterns_if_contributing" ON evidence_patterns;
CREATE POLICY "select_latest_evidence_patterns_if_contributing" ON evidence_patterns
  FOR SELECT TO authenticated
  USING (public.evidence_sharing_active() AND release_id = public.evidence_latest_release_id());

DROP POLICY IF EXISTS "select_evidence_products" ON evidence_products;
CREATE POLICY "select_evidence_products" ON evidence_products FOR SELECT TO authenticated USING (true);

-- Partner-side tables: staff read only. All writes go through staff RPCs or the service role.
DROP POLICY IF EXISTS "staff_select_evidence_partners" ON evidence_partners;
CREATE POLICY "staff_select_evidence_partners" ON evidence_partners
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_evidence_partner_keys" ON evidence_partner_keys;
CREATE POLICY "staff_select_evidence_partner_keys" ON evidence_partner_keys
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));
DROP POLICY IF EXISTS "staff_select_evidence_access_log" ON evidence_access_log;
CREATE POLICY "staff_select_evidence_access_log" ON evidence_access_log
  FOR SELECT TO authenticated USING (public.is_vireek_staff(auth.uid()));

-- evidence_policy: no client policy on purpose (service role / SQL editor only).

-- =============================================================
-- CONSENT RPC (owner only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_evidence_sharing(
  p_enabled boolean,
  p_share_part_usage boolean,
  p_share_equipment_signals boolean,
  p_consent_version integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_current integer;
  v_prev evidence_sharing_consent;
  v_had boolean;
  v_action text;
  v_parts boolean := COALESCE(p_share_part_usage, false);
  v_equip boolean := COALESCE(p_share_equipment_signals, false);
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change evidence sharing';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'p_enabled is required';
  END IF;
  SELECT consent_version INTO v_current FROM evidence_policy WHERE id;
  IF p_enabled AND p_consent_version IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'The sharing terms were updated. Reload and review them before opting in.';
  END IF;
  IF NOT p_enabled THEN
    v_parts := false;
    v_equip := false;
  END IF;

  SELECT * INTO v_prev FROM evidence_sharing_consent WHERE user_id = v_owner;
  v_had := FOUND;
  v_action := CASE
    WHEN p_enabled AND (NOT v_had OR NOT v_prev.enabled) THEN 'opt_in'
    WHEN NOT p_enabled AND v_had AND v_prev.enabled THEN 'opt_out'
    ELSE 'update' END;

  INSERT INTO evidence_sharing_consent (user_id, enabled, share_part_usage, share_equipment_signals, consent_version, consented_by, consented_at, revoked_at, updated_at)
  VALUES (v_owner, p_enabled, v_parts, v_equip, v_current, auth.uid(), CASE WHEN p_enabled THEN now() END, CASE WHEN NOT p_enabled THEN now() END, now())
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    share_part_usage = EXCLUDED.share_part_usage,
    share_equipment_signals = EXCLUDED.share_equipment_signals,
    consent_version = EXCLUDED.consent_version,
    consented_by = CASE WHEN EXCLUDED.enabled THEN auth.uid() ELSE evidence_sharing_consent.consented_by END,
    consented_at = CASE WHEN EXCLUDED.enabled AND NOT evidence_sharing_consent.enabled THEN now() ELSE evidence_sharing_consent.consented_at END,
    revoked_at = CASE WHEN NOT EXCLUDED.enabled AND evidence_sharing_consent.enabled THEN now() ELSE evidence_sharing_consent.revoked_at END,
    updated_at = now();

  INSERT INTO evidence_consent_log (user_id, action, enabled, share_part_usage, share_equipment_signals, consent_version)
  VALUES (v_owner, v_action, p_enabled, v_parts, v_equip, v_current);
END;
$$;

-- =============================================================
-- CONTRIBUTION SUMMARY (what MY data did, never anyone else's)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_evidence_contribution()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_window integer;
  v_industry text;
  v_eligible integer;
  v_patterns integer := 0;
  v_pulls integer;
  v_release uuid := public.evidence_latest_release_id();
  v_enabled boolean;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  SELECT window_days INTO v_window FROM evidence_policy WHERE id;
  SELECT COALESCE(lower(NULLIF(btrim(bp.primary_industry), '')), 'other') INTO v_industry FROM business_profile bp WHERE bp.user_id = v_owner;
  v_industry := COALESCE(v_industry, 'other');
  SELECT COALESCE((SELECT enabled FROM evidence_sharing_consent WHERE user_id = v_owner), false) INTO v_enabled;

  SELECT count(*) INTO v_eligible
  FROM job_outcomes o
  WHERE o.user_id = v_owner AND o.recorded_at >= now() - make_interval(days => v_window)
    AND NOT o.is_rework AND public.evidence_norm_key(o.root_cause_key) IS NOT NULL
    AND public.evidence_norm_key(o.job_type_key) IS NOT NULL;

  IF v_enabled AND v_release IS NOT NULL THEN
    SELECT count(DISTINCT p.id) INTO v_patterns
    FROM evidence_patterns p
    JOIN job_outcomes o
      ON public.evidence_norm_key(o.job_type_key) = p.job_type_key
     AND public.evidence_norm_key(o.root_cause_key) = p.root_cause_key
    WHERE p.release_id = v_release AND p.scope = 'cause' AND p.industry = v_industry
      AND o.user_id = v_owner AND o.recorded_at >= now() - make_interval(days => v_window) AND NOT o.is_rework;
  END IF;

  SELECT count(*) INTO v_pulls FROM evidence_access_log WHERE created_at >= now() - interval '30 days';

  RETURN jsonb_build_object(
    'enabled', v_enabled,
    'eligible_outcomes', v_eligible,
    'patterns_contributed_to', v_patterns,
    'partner_requests_30d', v_pulls,
    'window_days', v_window,
    'consent_version', (SELECT consent_version FROM evidence_policy WHERE id)
  );
END;
$$;

/* Who receives evidence: partner TYPES and counts only, never names. Opted-in businesses only. */
CREATE OR REPLACE FUNCTION public.get_evidence_ecosystem_summary()
RETURNS TABLE (partner_type text, active_partners integer, requests_30d integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.evidence_sharing_active() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.partner_type,
         count(DISTINCT p.id)::integer,
         count(l.id)::integer
  FROM evidence_partners p
  LEFT JOIN evidence_access_log l ON l.partner_id = p.id AND l.created_at >= now() - interval '30 days'
  WHERE p.status = 'active' AND (p.contract_expires_at IS NULL OR p.contract_expires_at >= current_date)
  GROUP BY p.partner_type
  ORDER BY p.partner_type;
END;
$$;

-- =============================================================
-- RELEASE BUILDER (service role / cron / staff wrapper only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_evidence_release()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pol evidence_policy;
  v_release uuid := gen_random_uuid();
  v_count integer;
  v_hash text;
BEGIN
  SELECT * INTO v_pol FROM evidence_policy WHERE id;

  CREATE TEMP TABLE _ev_new ON COMMIT DROP AS
  WITH base AS (
    SELECT
      o.user_id AS tenant,
      COALESCE(lower(NULLIF(btrim(bp.primary_industry), '')), 'other') AS industry,
      public.evidence_norm_key(o.job_type_key) AS job_type_key,
      public.evidence_norm_key(o.root_cause_key) AS root_cause_key,
      o.resolution,
      o.duration_minutes,
      o.caused_callback,
      CASE WHEN c.share_part_usage THEN COALESCE(o.parts_used, '{}'::text[]) ELSE '{}'::text[] END AS parts,
      CASE WHEN c.share_equipment_signals THEN m.slug END AS make,
      CASE WHEN c.share_equipment_signals AND e.install_date IS NOT NULL THEN
        CASE
          WHEN extract(year FROM age(o.recorded_at, e.install_date)) <= 5 THEN '0-5'
          WHEN extract(year FROM age(o.recorded_at, e.install_date)) <= 10 THEN '6-10'
          WHEN extract(year FROM age(o.recorded_at, e.install_date)) <= 15 THEN '11-15'
          ELSE '16+' END
      END AS age_band,
      EXISTS (
        SELECT 1 FROM job_evidence_chain_entries ev
        WHERE ev.job_id = o.job_id AND ev.kind IN ('media', 'measurement', 'test')
      ) AS backed
    FROM job_outcomes o
    JOIN evidence_sharing_consent c ON c.user_id = o.user_id AND c.enabled
    LEFT JOIN business_profile bp ON bp.user_id = o.user_id
    LEFT JOIN LATERAL (
      SELECT eq.make, eq.install_date
      FROM job_equipment je JOIN equipment eq ON eq.id = je.equipment_id
      WHERE je.job_id = o.job_id
      ORDER BY je.created_at LIMIT 1
    ) e ON true
    LEFT JOIN oem_manufacturers m ON lower(btrim(e.make)) IN (m.slug, lower(m.name))
    WHERE o.recorded_at >= now() - make_interval(days => v_pol.window_days)
      AND NOT o.is_rework
      AND public.evidence_norm_key(o.job_type_key) IS NOT NULL
      AND public.evidence_norm_key(o.root_cause_key) IS NOT NULL
  ),
  scoped AS (
    SELECT 'cause'::text AS scope, tenant, industry, job_type_key, root_cause_key, '*'::text AS make, '*'::text AS age_band,
           resolution, duration_minutes, caused_callback, parts, backed FROM base
    UNION ALL
    SELECT 'equipment', tenant, industry, job_type_key, root_cause_key, make, age_band,
           resolution, duration_minutes, caused_callback, parts, backed FROM base
    WHERE make IS NOT NULL AND age_band IS NOT NULL
  ),
  per_tenant AS (
    SELECT scope, industry, job_type_key, root_cause_key, make, age_band, tenant, count(*) AS c
    FROM scoped GROUP BY 1, 2, 3, 4, 5, 6, 7
  ),
  dom AS (
    SELECT scope, industry, job_type_key, root_cause_key, make, age_band,
           max(c)::numeric / sum(c) AS top_share
    FROM per_tenant GROUP BY 1, 2, 3, 4, 5, 6
  ),
  agg AS (
    SELECT s.scope, s.industry, s.job_type_key, s.root_cause_key, s.make, s.age_band,
           count(*) AS n,
           count(DISTINCT s.tenant) AS contributors,
           avg((s.resolution = 'fixed_first_visit')::int) AS ftf,
           avg(s.caused_callback::int) AS cb,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.duration_minutes) AS med,
           avg(s.backed::int) AS backed_pct,
           d.top_share
    FROM scoped s
    JOIN dom d USING (scope, industry, job_type_key, root_cause_key, make, age_band)
    GROUP BY s.scope, s.industry, s.job_type_key, s.root_cause_key, s.make, s.age_band, d.top_share
    HAVING count(*) >= v_pol.min_observations
       AND count(DISTINCT s.tenant) >= v_pol.min_contributors
       AND d.top_share <= v_pol.max_dominance
  ),
  parts_agg AS (
    SELECT s.scope, s.industry, s.job_type_key, s.root_cause_key, s.make, s.age_band,
           public.evidence_norm_part(pt) AS part,
           count(*) AS uses, count(DISTINCT s.tenant) AS part_tenants
    FROM scoped s, LATERAL unnest(s.parts) AS pt
    WHERE public.evidence_norm_part(pt) IS NOT NULL
    GROUP BY s.scope, s.industry, s.job_type_key, s.root_cause_key, s.make, s.age_band, public.evidence_norm_part(pt)
    HAVING count(DISTINCT s.tenant) >= v_pol.min_contributors
  ),
  parts_ranked AS (
    SELECT pa.*, a.n,
           row_number() OVER (PARTITION BY pa.scope, pa.industry, pa.job_type_key, pa.root_cause_key, pa.make, pa.age_band ORDER BY pa.uses DESC, pa.part) AS rk
    FROM parts_agg pa
    JOIN agg a USING (scope, industry, job_type_key, root_cause_key, make, age_band)
  ),
  parts_top AS (
    SELECT scope, industry, job_type_key, root_cause_key, make, age_band,
           jsonb_agg(jsonb_build_object('part', part, 'share', round(LEAST(1, uses::numeric / n), 2)) ORDER BY rk) AS top_parts
    FROM parts_ranked WHERE rk <= 5
    GROUP BY scope, industry, job_type_key, root_cause_key, make, age_band
  )
  SELECT
    a.scope, a.industry, a.job_type_key, a.root_cause_key, a.make, a.age_band,
    public.evidence_round_count(a.n) AS observations_display,
    GREATEST(5, (floor(a.contributors / 5.0) * 5)::integer) AS contributors_display,
    -- Disclosure control: calibrated noise ~0.5 standard errors, clamped to [0,1].
    round(LEAST(1, GREATEST(0, a.ftf + (random() + random() + random() - 1.5) * sqrt(GREATEST(a.ftf * (1 - a.ftf), 0.0025) / a.n)))::numeric, 3) AS ftf_rate,
    round(LEAST(1, GREATEST(0, a.cb + (random() + random() + random() - 1.5) * sqrt(GREATEST(a.cb * (1 - a.cb), 0.0025) / a.n)))::numeric, 3) AS callback_rate,
    CASE WHEN a.med IS NULL THEN NULL ELSE (round(a.med / 5.0) * 5)::integer END AS median_minutes,
    COALESCE(pt.top_parts, '[]'::jsonb) AS top_parts,
    (round(a.backed_pct * 10) * 10)::integer AS evidence_backed_pct,
    CASE
      WHEN a.contributors >= 25 AND a.n >= 500 AND a.backed_pct >= 0.5 THEN 'A'
      WHEN a.contributors >= 10 AND a.n >= 100 THEN 'B'
      ELSE 'C' END AS grade
  FROM agg a
  LEFT JOIN parts_top pt USING (scope, industry, job_type_key, root_cause_key, make, age_band);

  SELECT count(*) INTO v_count FROM _ev_new;
  IF v_count = 0 THEN
    RETURN NULL; -- nothing clears the privacy floors yet: publish nothing
  END IF;

  INSERT INTO evidence_patterns (
    release_id, scope, industry, job_type_key, root_cause_key, make, age_band,
    observations_display, contributors_display, ftf_rate, callback_rate, median_minutes,
    top_parts, evidence_backed_pct, grade
  )
  SELECT v_release, scope, industry, job_type_key, root_cause_key, make, age_band,
         observations_display, contributors_display, ftf_rate, callback_rate, median_minutes,
         top_parts, evidence_backed_pct, grade
  FROM _ev_new;

  SELECT encode(sha256(convert_to(string_agg(
           concat_ws('|', scope, industry, job_type_key, root_cause_key, make, age_band, observations_display, contributors_display, ftf_rate, callback_rate, COALESCE(median_minutes::text, ''), top_parts::text, evidence_backed_pct, grade),
           E'\n' ORDER BY scope, industry, job_type_key, root_cause_key, make, age_band), 'UTF8')), 'hex')
  INTO v_hash FROM evidence_patterns WHERE release_id = v_release;

  INSERT INTO evidence_releases (id, period_start, period_end, pattern_count, content_hash)
  VALUES (v_release, (now() - make_interval(days => v_pol.window_days))::date, now()::date, v_count, v_hash);

  RETURN v_release;
END;
$$;

-- =============================================================
-- STAFF RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.staff_run_evidence_release()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  RETURN public.refresh_evidence_release();
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_save_evidence_partner(
  p_id uuid,
  p_name text,
  p_partner_type text,
  p_status text,
  p_contact_email text,
  p_contract_ref text,
  p_contract_expires_at date,
  p_allowed_products text[],
  p_rate_limit integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_products text[] := COALESCE(p_allowed_products, '{}');
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  -- A partner may only be granted products its type is entitled to.
  IF EXISTS (
    SELECT 1 FROM unnest(v_products) AS req(product_slug)
    WHERE NOT EXISTS (SELECT 1 FROM evidence_products pr WHERE pr.slug = req.product_slug AND p_partner_type = ANY (pr.partner_types))
  ) THEN
    RAISE EXCEPTION 'One or more products are not available to this partner type';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO evidence_partners (name, partner_type, status, contact_email, contract_ref, contract_expires_at, allowed_products, rate_limit_per_minute)
    VALUES (btrim(p_name), p_partner_type, COALESCE(p_status, 'pending'), NULLIF(btrim(p_contact_email), ''), NULLIF(btrim(p_contract_ref), ''), p_contract_expires_at, v_products, COALESCE(p_rate_limit, 60))
    RETURNING id INTO v_id;
  ELSE
    UPDATE evidence_partners SET
      name = btrim(p_name), partner_type = p_partner_type, status = COALESCE(p_status, status),
      contact_email = NULLIF(btrim(p_contact_email), ''), contract_ref = NULLIF(btrim(p_contract_ref), ''),
      contract_expires_at = p_contract_expires_at, allowed_products = v_products,
      rate_limit_per_minute = COALESCE(p_rate_limit, rate_limit_per_minute)
    WHERE id = p_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Partner not found'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

/* The raw key is generated and hashed in the browser; only the hash is stored. */
CREATE OR REPLACE FUNCTION public.staff_issue_evidence_partner_key(p_partner_id uuid, p_key_hash text, p_key_prefix text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'Partner not found';
  END IF;
  INSERT INTO evidence_partner_keys (partner_id, key_prefix, key_hash)
  VALUES (p_partner_id, p_key_prefix, p_key_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_revoke_evidence_partner_key(p_key_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;
  UPDATE evidence_partner_keys SET revoked_at = now() WHERE id = p_key_id AND revoked_at IS NULL;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.refresh_evidence_release() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_evidence_sharing(boolean, boolean, boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_evidence_contribution() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_evidence_ecosystem_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_run_evidence_release() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_save_evidence_partner(uuid, text, text, text, text, text, date, text[], integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_issue_evidence_partner_key(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_revoke_evidence_partner_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_evidence_sharing(boolean, boolean, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_evidence_contribution() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_evidence_ecosystem_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_run_evidence_release() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_save_evidence_partner(uuid, text, text, text, text, text, date, text[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_issue_evidence_partner_key(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_revoke_evidence_partner_key(uuid) TO authenticated;

-- =============================================================
-- WEEKLY RELEASE (no-op, not an error, if pg_cron is not enabled)
-- =============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('vireek-refresh-evidence-release');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    PERFORM cron.schedule('vireek-refresh-evidence-release', '15 4 * * 1', 'select public.refresh_evidence_release()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
