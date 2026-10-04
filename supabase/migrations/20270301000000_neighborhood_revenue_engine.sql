/*
  # Neighborhood Revenue Engine

  Completed Job -> Opportunity -> nearby properties (own customers only, PII-safe)
  -> likely service need -> compliant campaign -> in-zone jobs -> route density.

  Compliance model:
  - Non-customers: never stored/listed. Reached only via non-personal channels.
  - Customers: personal channels require customers.marketing_opt_in = true and
    absence from dnc_suppressions (checked server-side, SECURITY DEFINER, owner-scoped).
  - A campaign cannot leave draft/cancelled without compliance_ack_at.
  Fully idempotent; additive only.
*/

ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_opt_in_at timestamptz;

CREATE TABLE IF NOT EXISTS neighborhood_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  service_type text,
  radius_m integer NOT NULL DEFAULT 1500 CHECK (radius_m BETWEEN 200 AND 10000),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'campaign_planned', 'completed', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_nre_opps_user_status ON neighborhood_opportunities(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS neighborhood_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES neighborhood_opportunities(id) ON DELETE CASCADE,
  channel text NOT NULL
    CHECK (channel IN ('door_hanger', 'direct_mail', 'geo_ad', 'email_opt_in', 'sms_opt_in')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'active', 'completed', 'cancelled')),
  offer_text text NOT NULL CHECK (char_length(offer_text) BETWEEN 1 AND 1000),
  budget numeric NOT NULL DEFAULT 0 CHECK (budget >= 0),
  starts_on date,
  ends_on date,
  compliance_ack_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CHECK (status IN ('draft', 'cancelled') OR compliance_ack_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_nre_campaigns_user ON neighborhood_campaigns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nre_campaigns_opp ON neighborhood_campaigns(opportunity_id);

ALTER TABLE neighborhood_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE neighborhood_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_nre_opps" ON neighborhood_opportunities;
CREATE POLICY "select_own_nre_opps" ON neighborhood_opportunities
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "update_own_nre_opps" ON neighborhood_opportunities;
CREATE POLICY "update_own_nre_opps" ON neighborhood_opportunities
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
-- No INSERT/DELETE policy: opportunities are created only by the trigger below.

DROP POLICY IF EXISTS "select_own_nre_campaigns" ON neighborhood_campaigns;
CREATE POLICY "select_own_nre_campaigns" ON neighborhood_campaigns
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "insert_own_nre_campaigns" ON neighborhood_campaigns;
CREATE POLICY "insert_own_nre_campaigns" ON neighborhood_campaigns
  FOR INSERT TO authenticated WITH CHECK (
    user_id = public.get_account_owner_id()
    AND EXISTS (SELECT 1 FROM neighborhood_opportunities o
                WHERE o.id = opportunity_id AND o.user_id = public.get_account_owner_id())
  );
DROP POLICY IF EXISTS "update_own_nre_campaigns" ON neighborhood_campaigns;
CREATE POLICY "update_own_nre_campaigns" ON neighborhood_campaigns
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "delete_own_nre_campaigns" ON neighborhood_campaigns;
CREATE POLICY "delete_own_nre_campaigns" ON neighborhood_campaigns
  FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id());

-- ---------------------------------------------------------------
-- Haversine distance in metres
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._nre_distance_m(
  lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision
) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT 2 * 6371000 * asin(sqrt(LEAST(1, GREATEST(0,
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))));
$$;

-- ---------------------------------------------------------------
-- Trigger: completed job -> opportunity (never blocks the job write)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neighborhood_detect_opportunity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fire boolean := false;
BEGIN
  IF NEW.job_status = 'completed' THEN
    IF TG_OP = 'INSERT' THEN
      v_fire := true;
    ELSE
      v_fire := (OLD.job_status IS DISTINCT FROM 'completed');
    END IF;
  END IF;

  IF v_fire THEN
    INSERT INTO neighborhood_opportunities (user_id, source_job_id, service_type)
    VALUES (NEW.user_id, NEW.id, NEW.service_type)
    ON CONFLICT (source_job_id) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'neighborhood_detect_opportunity skipped: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_nre_detect_opportunity ON jobs;
CREATE TRIGGER trg_nre_detect_opportunity
  AFTER INSERT OR UPDATE OF job_status ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.neighborhood_detect_opportunity();

-- Campaign created -> opportunity moves to campaign_planned
CREATE OR REPLACE FUNCTION public.neighborhood_campaign_marks_opportunity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE neighborhood_opportunities
     SET status = 'campaign_planned', updated_at = now()
   WHERE id = NEW.opportunity_id AND status = 'open';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'neighborhood_campaign_marks_opportunity skipped: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_nre_campaign_marks_opp ON neighborhood_campaigns;
CREATE TRIGGER trg_nre_campaign_marks_opp
  AFTER INSERT ON neighborhood_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.neighborhood_campaign_marks_opportunity();

-- One-time backfill: jobs completed in the last 45 days
INSERT INTO neighborhood_opportunities (user_id, source_job_id, service_type)
SELECT j.user_id, j.id, j.service_type
FROM jobs j
WHERE j.job_status = 'completed'
  AND COALESCE(j.completed_at, j.created_at) > now() - interval '45 days'
  AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = j.user_id)
ON CONFLICT (source_job_id) DO NOTHING;

-- ---------------------------------------------------------------
-- RPC 1: open opportunities with live route-density context
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neighborhood_opportunities_overview()
RETURNS TABLE (
  opportunity_id uuid, status text, radius_m integer, source_job_id uuid,
  customer_name text, service_type text, address text, completed_at timestamptz,
  latitude double precision, longitude double precision,
  scheduled_nearby integer, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.status, o.radius_m, j.id, j.customer_name, j.service_type, j.address,
         COALESCE(j.completed_at, o.created_at), j.latitude, j.longitude,
         CASE WHEN j.latitude IS NULL OR j.longitude IS NULL THEN 0 ELSE (
           SELECT count(*)::int FROM jobs n
           WHERE n.user_id = o.user_id AND n.id <> j.id
             AND n.job_status = 'scheduled'
             AND n.scheduled_datetime >= now() AND n.scheduled_datetime < now() + interval '14 days'
             AND n.latitude BETWEEN j.latitude - o.radius_m / 111000.0 AND j.latitude + o.radius_m / 111000.0
             AND n.longitude IS NOT NULL
             AND public._nre_distance_m(j.latitude, j.longitude, n.latitude, n.longitude) <= o.radius_m
         ) END,
         o.created_at
  FROM neighborhood_opportunities o
  JOIN jobs j ON j.id = o.source_job_id
  WHERE o.user_id = public.get_account_owner_id()
    AND o.status IN ('open', 'campaign_planned')
  ORDER BY o.created_at DESC
  LIMIT 200;
$$;

-- ---------------------------------------------------------------
-- RPC 2: nearby OWN customers + equipment + compliance flags
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neighborhood_nearby_properties(p_opportunity_id uuid)
RETURNS TABLE (
  customer_id uuid, customer_name text, address text, distance_m integer,
  last_job_at timestamptz, last_service_type text, jobs_count integer,
  equipment jsonb, marketing_opt_in boolean, has_phone boolean, has_email boolean, on_dnc boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH src AS (
    SELECT o.user_id AS uid, o.radius_m AS r, j.latitude AS lat, j.longitude AS lng, j.customer_id AS cid
    FROM neighborhood_opportunities o
    JOIN jobs j ON j.id = o.source_job_id
    WHERE o.id = p_opportunity_id
      AND o.user_id = public.get_account_owner_id()
      AND j.latitude IS NOT NULL AND j.longitude IS NOT NULL
  ), hits AS (
    SELECT n.customer_id AS cust, n.address AS addr, n.service_type AS stype,
           COALESCE(n.completed_at, n.scheduled_datetime, n.created_at) AS happened,
           public._nre_distance_m(s.lat, s.lng, n.latitude, n.longitude) AS dist
    FROM src s
    JOIN jobs n ON n.user_id = s.uid
    WHERE n.customer_id IS NOT NULL
      AND n.customer_id IS DISTINCT FROM s.cid
      AND n.job_status <> 'cancelled'
      AND n.latitude BETWEEN s.lat - s.r / 111000.0 AND s.lat + s.r / 111000.0
      AND n.longitude IS NOT NULL
      AND public._nre_distance_m(s.lat, s.lng, n.latitude, n.longitude) <= s.r
  ), nearest AS (
    SELECT DISTINCT ON (cust) cust, addr, dist FROM hits ORDER BY cust, dist
  ), agg AS (
    SELECT cust, max(happened) AS last_at, count(*)::int AS cnt,
           (array_agg(stype ORDER BY happened DESC))[1] AS last_type
    FROM hits GROUP BY cust
  )
  SELECT c.id, c.name, ne.addr, round(ne.dist)::int, a.last_at, a.last_type, a.cnt,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'equipment_type', e.equipment_type,
             'install_date', e.install_date,
             'expected_lifespan_years', e.expected_lifespan_years,
             'service_interval_months', e.service_interval_months,
             'last_service_date', e.last_service_date))
           FROM equipment e
           WHERE e.customer_id = c.id AND e.user_id = c.user_id AND e.status = 'active'
         ), '[]'::jsonb),
         c.marketing_opt_in,
         (nullif(btrim(c.phone), '') IS NOT NULL),
         (nullif(btrim(c.email), '') IS NOT NULL),
         EXISTS (SELECT 1 FROM dnc_suppressions d WHERE d.user_id = c.user_id AND d.phone_number = c.phone)
  FROM nearest ne
  JOIN agg a ON a.cust = ne.cust
  JOIN customers c ON c.id = ne.cust AND c.user_id = (SELECT uid FROM src LIMIT 1)
  ORDER BY ne.dist
  LIMIT 300;
$$;

-- ---------------------------------------------------------------
-- RPC 3: measured results per campaign (in-zone jobs during window)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neighborhood_campaign_results()
RETURNS TABLE (campaign_id uuid, zone_jobs integer, zone_completed integer, zone_revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id,
         count(z.id)::int,
         (count(z.id) FILTER (WHERE z.job_status = 'completed'))::int,
         COALESCE(sum(z.invoice_amount) FILTER (WHERE z.job_status = 'completed'), 0)
  FROM neighborhood_campaigns c
  JOIN neighborhood_opportunities o ON o.id = c.opportunity_id
  JOIN jobs j ON j.id = o.source_job_id
  LEFT JOIN jobs z
    ON z.user_id = c.user_id AND z.id <> j.id
   AND j.latitude IS NOT NULL AND z.latitude IS NOT NULL AND z.longitude IS NOT NULL
   AND z.job_status <> 'cancelled'
   AND z.latitude BETWEEN j.latitude - o.radius_m / 111000.0 AND j.latitude + o.radius_m / 111000.0
   AND public._nre_distance_m(j.latitude, j.longitude, z.latitude, z.longitude) <= o.radius_m
   AND z.created_at >= COALESCE(c.starts_on, c.created_at::date)
   AND z.created_at <  COALESCE(c.ends_on, current_date) + 15
  WHERE c.user_id = public.get_account_owner_id()
    AND c.status IN ('active', 'completed')
  GROUP BY c.id;
$$;

REVOKE ALL ON FUNCTION public.neighborhood_opportunities_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neighborhood_nearby_properties(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neighborhood_campaign_results() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neighborhood_opportunities_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neighborhood_nearby_properties(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neighborhood_campaign_results() TO authenticated;
