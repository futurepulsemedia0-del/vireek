/*
# Capacity Exchange — Liquidity Layer (v2)

Upgrades the existing Capacity Exchange (20261201000000_capacity_exchange.sql)
from "rank by region / rating / load" into a two-sided, real-time market for
field-service capacity:

  Demand (waiting jobs)  <->  Supply (idle technicians / vans)

Matching now weighs 10 explainable factors (100 pts): geography, skills,
reliability, quality, verified trust, availability, SLA, equipment, price,
insurance. Hard gates (never offered): certified trade, required skills,
required equipment, required insurance, price ceiling, SLA ceiling, load cap.

## Additive & idempotent
- Only ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE.
- compute_handoff_matches keeps its signature (uuid) -> integer.
- post_network_handoff / respond_to_match / _promote_next_match untouched.
- Also fixes a latent bug: re-running compute_handoff_matches after a candidate
  declined/expired hit UNIQUE (handoff_id, candidate_id). Prior candidates are
  now excluded and the insert is ON CONFLICT DO NOTHING.

## Security (same posture as the network hub)
- No client INSERT/UPDATE/DELETE on any new table; all writes via SECURITY
  DEFINER RPCs. Credentials are private to their owner; other members only ever
  see aggregate counts and (as a candidate) their own score breakdown.
- Credentials start `self_declared`; only a platform admin (profiles.role =
  'admin') can mark them `verified` / `rejected` via review_capacity_credential.

## Depends on
profiles, business_profile, notifications, get_account_owner_id(),
is_network_member(), set_updated_at(), network_text_has_contact_info(),
network_handoffs, network_handoff_events, network_capacity_profiles,
network_handoff_matches.
*/

-- ---------------------------------------------------------------------
-- 1. Column additions
-- ---------------------------------------------------------------------
ALTER TABLE network_capacity_profiles
  ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS equipment text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS service_regions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hourly_rate_cents integer
    CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS sla_response_minutes smallint
    CHECK (sla_response_minutes IS NULL OR sla_response_minutes BETWEEN 5 AND 10080);

ALTER TABLE network_handoffs
  ADD COLUMN IF NOT EXISTS required_skills text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS required_equipment text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sla_minutes smallint
    CHECK (sla_minutes IS NULL OR sla_minutes BETWEEN 5 AND 10080),
  ADD COLUMN IF NOT EXISTS max_hourly_rate_cents integer
    CHECK (max_hourly_rate_cents IS NULL OR max_hourly_rate_cents BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS requires_insurance boolean NOT NULL DEFAULT false;

ALTER TABLE network_handoff_matches
  ADD COLUMN IF NOT EXISTS score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------
-- 2. New tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('insurance', 'license', 'certification', 'oem_authorization')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  trade text CHECK (trade IS NULL OR trade IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')),
  expires_on date,
  status text NOT NULL DEFAULT 'self_declared' CHECK (status IN ('self_declared', 'verified', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_credentials_insurance_needs_expiry
    CHECK (kind <> 'insurance' OR expires_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_network_credentials_user ON network_credentials (user_id, kind);

CREATE TABLE IF NOT EXISTS network_capacity_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  business_name text NOT NULL,
  region_key text NOT NULL,
  trades text[] NOT NULL CHECK (cardinality(trades) BETWEEN 1 AND 7),
  technicians_available smallint NOT NULL CHECK (technicians_available BETWEEN 1 AND 50),
  vehicles_idle smallint NOT NULL DEFAULT 0 CHECK (vehicles_idle BETWEEN 0 AND 50),
  available_from timestamptz NOT NULL DEFAULT now(),
  available_until timestamptz NOT NULL,
  hourly_rate_cents integer CHECK (hourly_rate_cents IS NULL OR hourly_rate_cents BETWEEN 0 AND 1000000),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_capacity_listings_window CHECK (available_until > available_from)
);
CREATE INDEX IF NOT EXISTS idx_capacity_listings_user ON network_capacity_listings (user_id, status);
CREATE INDEX IF NOT EXISTS idx_capacity_listings_active
  ON network_capacity_listings (region_key, available_until) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- 3. RLS — read-only for clients, all writes via RPC
-- ---------------------------------------------------------------------
ALTER TABLE network_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_capacity_listings ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_credentials FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_capacity_listings FROM authenticated, anon;
REVOKE SELECT ON network_credentials, network_capacity_listings FROM anon;

DROP POLICY IF EXISTS "select_own_network_credentials" ON network_credentials;
CREATE POLICY "select_own_network_credentials" ON network_credentials FOR SELECT TO authenticated
USING (
  user_id = (SELECT public.get_account_owner_id())
  OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

DROP POLICY IF EXISTS "select_network_capacity_listings" ON network_capacity_listings;
CREATE POLICY "select_network_capacity_listings" ON network_capacity_listings FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_account_owner_id()));

DROP TRIGGER IF EXISTS trigger_touch_network_credentials ON network_credentials;
CREATE TRIGGER trigger_touch_network_credentials
  BEFORE UPDATE ON network_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_touch_capacity_listings ON network_capacity_listings;
CREATE TRIGGER trigger_touch_capacity_listings
  BEFORE UPDATE ON network_capacity_listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE network_capacity_listings;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 4. Validation helper (slug tags: skills / equipment)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_valid_tags(p text[], p_max integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p IS NOT NULL
    AND COALESCE(array_length(p, 1), 0) <= p_max
    AND NOT EXISTS (SELECT 1 FROM unnest(p) t WHERE t IS NULL OR t !~ '^[a-z0-9_]{2,40}$');
$$;

-- ---------------------------------------------------------------------
-- 5. Capability profile (skills, equipment, extra regions, rate, SLA)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_capacity_capabilities(
  p_skills text[],
  p_equipment text[],
  p_service_regions text[],
  p_hourly_rate_cents integer,
  p_sla_response_minutes smallint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_skills text[] := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_skills, '{}')) t ORDER BY t);
  v_equipment text[] := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_equipment, '{}')) t ORDER BY t);
  v_regions text[] := ARRAY(
    SELECT DISTINCT lower(btrim(r)) FROM unnest(COALESCE(p_service_regions, '{}')) r
    WHERE btrim(COALESCE(r, '')) <> '' ORDER BY 1
  );
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF auth.uid() <> v_owner THEN RAISE EXCEPTION 'OWNER_ONLY'; END IF;

  IF NOT public.network_valid_tags(v_skills, 12)
     OR NOT public.network_valid_tags(v_equipment, 12)
     OR COALESCE(array_length(v_regions, 1), 0) > 10
     OR EXISTS (
       SELECT 1 FROM unnest(v_regions) r
       WHERE char_length(r) > 60 OR public.network_text_has_contact_info(r)
     )
     OR (p_hourly_rate_cents IS NOT NULL AND p_hourly_rate_cents NOT BETWEEN 0 AND 1000000)
     OR (p_sla_response_minutes IS NOT NULL AND p_sla_response_minutes NOT BETWEEN 5 AND 10080) THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  INSERT INTO network_capacity_profiles
    (user_id, skills, equipment, service_regions, hourly_rate_cents, sla_response_minutes)
  VALUES
    (v_owner, v_skills, v_equipment, v_regions, p_hourly_rate_cents, p_sla_response_minutes)
  ON CONFLICT (user_id) DO UPDATE
    SET skills = EXCLUDED.skills,
        equipment = EXCLUDED.equipment,
        service_regions = EXCLUDED.service_regions,
        hourly_rate_cents = EXCLUDED.hourly_rate_cents,
        sla_response_minutes = EXCLUDED.sla_response_minutes,
        updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------
-- 6. Credentials (insurance / license / certification / OEM authorization)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_capacity_credential(
  p_kind text,
  p_label text,
  p_trade text,
  p_expires_on date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_label text := btrim(COALESCE(p_label, ''));
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF auth.uid() <> v_owner THEN RAISE EXCEPTION 'OWNER_ONLY'; END IF;

  IF COALESCE(p_kind, '') NOT IN ('insurance', 'license', 'certification', 'oem_authorization')
     OR char_length(v_label) NOT BETWEEN 2 AND 80
     OR public.network_text_has_contact_info(v_label)
     OR (p_trade IS NOT NULL AND p_trade NOT IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general'))
     OR (p_kind = 'insurance' AND (p_expires_on IS NULL OR p_expires_on < current_date))
     OR (p_expires_on IS NOT NULL AND p_expires_on > current_date + interval '20 years') THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF (SELECT count(*) FROM network_credentials WHERE user_id = v_owner) >= 20 THEN
    RAISE EXCEPTION 'TOO_MANY_CREDENTIALS';
  END IF;

  INSERT INTO network_credentials (user_id, kind, label, trade, expires_on)
  VALUES (v_owner, p_kind, v_label, p_trade, p_expires_on)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_capacity_credential(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF auth.uid() <> v_owner THEN RAISE EXCEPTION 'OWNER_ONLY'; END IF;
  DELETE FROM network_credentials WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDENTIAL_UNAVAILABLE'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_capacity_credential(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c network_credentials;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF COALESCE(p_status, '') NOT IN ('verified', 'rejected') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;

  UPDATE network_credentials
     SET status = p_status, reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = p_id
  RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDENTIAL_UNAVAILABLE'; END IF;

  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    c.user_id, 'system',
    CASE WHEN p_status = 'verified' THEN 'Credential verified' ELSE 'Credential rejected' END,
    CASE WHEN p_status = 'verified'
      THEN 'Your credential "' || c.label || '" is now verified and boosts your Capacity Exchange trust score.'
      ELSE 'Your credential "' || c.label || '" could not be verified. Update it and resubmit.' END,
    '/dashboard/network/capacity-exchange'
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 7. Job requirements (poster side) — set before matching runs
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_handoff_requirements(
  p_handoff_id uuid,
  p_skills text[],
  p_equipment text[],
  p_sla_minutes smallint,
  p_max_hourly_rate_cents integer,
  p_requires_insurance boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_skills text[] := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_skills, '{}')) t ORDER BY t);
  v_equipment text[] := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_equipment, '{}')) t ORDER BY t);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  IF NOT public.network_valid_tags(v_skills, 12)
     OR NOT public.network_valid_tags(v_equipment, 12)
     OR (p_sla_minutes IS NOT NULL AND p_sla_minutes NOT BETWEEN 5 AND 10080)
     OR (p_max_hourly_rate_cents IS NOT NULL AND p_max_hourly_rate_cents NOT BETWEEN 0 AND 1000000) THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  UPDATE network_handoffs
     SET required_skills = v_skills,
         required_equipment = v_equipment,
         sla_minutes = p_sla_minutes,
         max_hourly_rate_cents = p_max_hourly_rate_cents,
         requires_insurance = COALESCE(p_requires_insurance, false)
   WHERE id = p_handoff_id AND user_id = v_owner AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- 8. Supply listings (idle technicians / vans)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_capacity_listing(
  p_trades text[],
  p_technicians smallint,
  p_vehicles smallint,
  p_available_from timestamptz,
  p_available_until timestamptz,
  p_hourly_rate_cents integer,
  p_note text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_trades text[] := ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(p_trades, '{}')) t ORDER BY t);
  v_from timestamptz := COALESCE(p_available_from, now());
  v_note text := nullif(btrim(COALESCE(p_note, '')), '');
  v_region text;
  v_name text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.is_network_member() THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  IF COALESCE(array_length(v_trades, 1), 0) = 0
     OR NOT (v_trades <@ ARRAY['hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general'])
     OR COALESCE(p_technicians, 0) NOT BETWEEN 1 AND 50
     OR COALESCE(p_vehicles, 0) NOT BETWEEN 0 AND 50
     OR p_available_until IS NULL
     OR v_from < now() - interval '1 hour'
     OR p_available_until <= v_from
     OR p_available_until <= now() + interval '15 minutes'
     OR p_available_until > now() + interval '14 days'
     OR (p_hourly_rate_cents IS NOT NULL AND p_hourly_rate_cents NOT BETWEEN 0 AND 1000000)
     OR char_length(COALESCE(v_note, '')) > 300
     OR public.network_text_has_contact_info(v_note) THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  SELECT lower(btrim(service_area)) INTO v_region FROM business_profile WHERE user_id = v_owner;
  IF v_region IS NULL OR v_region = '' THEN RAISE EXCEPTION 'SERVICE_AREA_REQUIRED'; END IF;

  IF (SELECT count(*) FROM network_capacity_listings
       WHERE user_id = v_owner AND status = 'active' AND available_until > now()) >= 5 THEN
    RAISE EXCEPTION 'TOO_MANY_LISTINGS';
  END IF;

  SELECT COALESCE(NULLIF(btrim(company_name), ''), 'Vireek member') INTO v_name FROM profiles WHERE id = v_owner;

  INSERT INTO network_capacity_listings
    (user_id, business_name, region_key, trades, technicians_available, vehicles_idle,
     available_from, available_until, hourly_rate_cents, note)
  VALUES
    (v_owner, v_name, v_region, v_trades, p_technicians, COALESCE(p_vehicles, 0),
     v_from, p_available_until, p_hourly_rate_cents, v_note)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_capacity_listing(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  UPDATE network_capacity_listings SET status = 'withdrawn'
   WHERE id = p_id AND user_id = v_owner AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'LISTING_UNAVAILABLE'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_capacity_listings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  UPDATE network_capacity_listings SET status = 'expired'
   WHERE status = 'active' AND available_until <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------
-- 9. Matching engine v2 — hard gates + 10-factor explainable score (100 pts)
--    geo 20 | skills 12 | reliability 12 | quality 10 | trust 8 |
--    availability 15 | sla 6 | equipment 5 | price 7 | insurance 5
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_handoff_matches(p_handoff_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  h network_handoffs;
  v_ref timestamptz;
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT * INTO h FROM network_handoffs WHERE id = p_handoff_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;
  IF h.status <> 'open' THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;

  v_ref := COALESCE(h.needed_by, now());

  -- Re-runnable: clear only non-terminal offers.
  DELETE FROM network_handoff_matches
   WHERE handoff_id = p_handoff_id AND status IN ('queued', 'offered');

  WITH candidates AS (
    SELECT
      bp.user_id AS candidate_id,
      lower(btrim(bp.service_area)) AS region,
      COALESCE(ncp.service_regions, '{}') AS service_regions,
      COALESCE(ncp.max_concurrent_handoffs, 3) AS max_concurrent,
      COALESCE(ncp.avg_rating, 0) AS avg_rating,
      COALESCE(ncp.ratings_count, 0) AS ratings_count,
      ncp.hourly_rate_cents AS rate_cents,
      ncp.sla_response_minutes AS sla_min,
      (SELECT count(*) FROM network_handoffs nh
        WHERE nh.claimed_by = bp.user_id AND nh.status = 'claimed') AS active_load,
      (SELECT count(*) FROM network_handoffs nh2
        WHERE nh2.claimed_by = bp.user_id AND nh2.status = 'completed') AS done_count,
      (SELECT count(*) FROM network_handoff_events ev
        WHERE ev.actor_id = bp.user_id AND ev.event = 'released') AS released_count,
      COALESCE(cr.verified_valid, 0) AS verified_valid,
      COALESCE(cr.has_insurance, false) AS has_insurance,
      COALESCE(cr.verified_insurance, false) AS verified_insurance,
      COALESCE(lst.techs, 0) AS listed_techs
    FROM business_profile bp
    LEFT JOIN network_capacity_profiles ncp ON ncp.user_id = bp.user_id
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE c.status = 'verified'
                           AND (c.expires_on IS NULL OR c.expires_on >= v_ref::date)) AS verified_valid,
        bool_or(c.kind = 'insurance' AND c.status <> 'rejected'
                AND c.expires_on >= v_ref::date) AS has_insurance,
        bool_or(c.kind = 'insurance' AND c.status = 'verified'
                AND c.expires_on >= v_ref::date) AS verified_insurance
      FROM network_credentials c WHERE c.user_id = bp.user_id
    ) cr ON true
    LEFT JOIN LATERAL (
      SELECT max(l.technicians_available) AS techs
      FROM network_capacity_listings l
      WHERE l.user_id = bp.user_id AND l.status = 'active'
        AND l.available_from <= v_ref AND l.available_until >= v_ref
        AND h.trade_category = ANY (l.trades)
    ) lst ON true
    WHERE bp.network_enabled
      AND bp.user_id <> v_owner
      AND COALESCE(ncp.auto_match_enabled, true)
      -- Hard gates
      AND (ncp.certified_trades IS NULL
           OR array_length(ncp.certified_trades, 1) IS NULL
           OR h.trade_category = ANY (ncp.certified_trades))
      AND h.required_skills <@ COALESCE(ncp.skills, '{}')
      AND h.required_equipment <@ COALESCE(ncp.equipment, '{}')
      AND (h.max_hourly_rate_cents IS NULL OR ncp.hourly_rate_cents IS NULL
           OR ncp.hourly_rate_cents <= h.max_hourly_rate_cents)
      AND (h.sla_minutes IS NULL OR ncp.sla_response_minutes IS NULL
           OR ncp.sla_response_minutes <= h.sla_minutes)
      -- Never re-offer to someone who already declined / expired / was tried
      AND NOT EXISTS (
        SELECT 1 FROM network_handoff_matches pm
        WHERE pm.handoff_id = p_handoff_id AND pm.candidate_id = bp.user_id
      )
  ),
  gated AS (
    SELECT * FROM candidates
    WHERE active_load < max_concurrent
      AND (NOT h.requires_insurance OR has_insurance)
  ),
  parts AS (
    SELECT
      candidate_id,
      (CASE WHEN region = lower(btrim(h.region_key)) THEN 20
            WHEN lower(btrim(h.region_key)) = ANY (service_regions) THEN 16
            ELSE 0 END)::numeric AS geo,
      (CASE WHEN cardinality(h.required_skills) = 0 THEN 6 ELSE 12 END)::numeric AS skills,
      (CASE WHEN done_count + released_count = 0 THEN 5
            ELSE 12 * done_count / (done_count + released_count)::numeric END) AS reliability,
      (CASE WHEN ratings_count = 0 THEN 4 ELSE 10 * avg_rating / 5.0 END)::numeric AS quality,
      (8 * LEAST(verified_valid, 4) / 4.0)::numeric AS trust,
      (GREATEST(0, 9 - 9.0 * active_load / GREATEST(max_concurrent, 1))
        + CASE WHEN listed_techs > 0 THEN 6 ELSE 0 END)::numeric AS availability,
      (CASE WHEN h.sla_minutes IS NULL THEN 3
            WHEN sla_min IS NULL THEN 1.5
            ELSE 3 + 3 * (1 - sla_min::numeric / h.sla_minutes) END)::numeric AS sla,
      (CASE WHEN cardinality(h.required_equipment) = 0 THEN 2.5 ELSE 5 END)::numeric AS equipment,
      (CASE WHEN h.max_hourly_rate_cents IS NULL THEN 3.5
            WHEN rate_cents IS NULL THEN 2
            WHEN h.max_hourly_rate_cents = 0 THEN 3.5
            ELSE 7 * (1 - 0.5 * rate_cents::numeric / h.max_hourly_rate_cents) END)::numeric AS price,
      (CASE WHEN verified_insurance THEN 5 WHEN has_insurance THEN 3 ELSE 0 END)::numeric AS insurance
    FROM gated
  ),
  scored AS (
    SELECT p.*,
           p.geo + p.skills + p.reliability + p.quality + p.trust
             + p.availability + p.sla + p.equipment + p.price + p.insurance AS score
    FROM parts p
  ),
  ranked AS (
    SELECT s.*, row_number() OVER (ORDER BY s.score DESC, s.candidate_id) AS rn
    FROM scored s
  )
  INSERT INTO network_handoff_matches
    (handoff_id, candidate_id, rank, score, status, offered_at, responds_by, score_breakdown)
  SELECT
    p_handoff_id, r.candidate_id, r.rn, round(r.score, 2),
    CASE WHEN r.rn = 1 THEN 'offered' ELSE 'queued' END,
    CASE WHEN r.rn = 1 THEN now() END,
    CASE WHEN r.rn = 1 THEN now() + interval '20 minutes' END,
    jsonb_build_object(
      'geo', round(r.geo, 1), 'skills', round(r.skills, 1),
      'reliability', round(r.reliability, 1), 'quality', round(r.quality, 1),
      'trust', round(r.trust, 1), 'availability', round(r.availability, 1),
      'sla', round(r.sla, 1), 'equipment', round(r.equipment, 1),
      'price', round(r.price, 1), 'insurance', round(r.insurance, 1)
    )
  FROM ranked r
  WHERE r.rn <= 5
  ON CONFLICT (handoff_id, candidate_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE network_handoffs SET smart_match = true WHERE id = p_handoff_id;

  INSERT INTO notifications (user_id, type, title, message, action_url)
  SELECT m.candidate_id, 'system', 'New capacity-exchange offer',
         'A ' || h.trade_category || ' job matching your profile is offered to you: "' || h.title || '".',
         '/dashboard/network/capacity-exchange'
  FROM network_handoff_matches m
  WHERE m.handoff_id = p_handoff_id AND m.status = 'offered';

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------
-- 10. Market pulse — anonymised, aggregate-only, members only
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_market_pulse()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_region text;
  v_waiting integer;
  v_active integer;
  v_max integer;
  v_load integer;
  v_my_listings integer;
  v_my_techs integer;
  v_my_vans integer;
  v_fit integer;
  v_position text;
  v_network jsonb;
  v_markets jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.is_network_member() THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  SELECT lower(btrim(service_area)) INTO v_region FROM business_profile WHERE user_id = v_owner;

  SELECT count(*) INTO v_waiting FROM network_handoffs
   WHERE user_id = v_owner AND status = 'open' AND expires_at > now();
  SELECT count(*) INTO v_active FROM network_handoffs
   WHERE claimed_by = v_owner AND status = 'claimed';
  SELECT max_concurrent_handoffs INTO v_max FROM network_capacity_profiles WHERE user_id = v_owner;
  v_max := COALESCE(v_max, 3);
  v_load := LEAST(100, round(100.0 * v_active / GREATEST(v_max, 1)))::integer;

  SELECT count(*), COALESCE(sum(technicians_available), 0), COALESCE(sum(vehicles_idle), 0)
    INTO v_my_listings, v_my_techs, v_my_vans
    FROM network_capacity_listings
   WHERE user_id = v_owner AND status = 'active' AND available_until > now();

  SELECT count(*) INTO v_fit FROM network_handoffs h2
   WHERE h2.status = 'open' AND h2.expires_at > now() AND h2.user_id <> v_owner
     AND h2.region_key = v_region
     AND EXISTS (
       SELECT 1 FROM network_capacity_listings l
       WHERE l.user_id = v_owner AND l.status = 'active' AND l.available_until > now()
         AND h2.trade_category = ANY (l.trades)
     );

  v_position := CASE
    WHEN v_waiting > 0 OR v_load >= 80 THEN 'short_capacity'
    WHEN v_my_techs > 0 THEN 'surplus_capacity'
    ELSE 'balanced'
  END;

  SELECT jsonb_build_object(
    'open_jobs', (SELECT count(*) FROM network_handoffs WHERE status = 'open' AND expires_at > now()),
    'open_value_cents', (SELECT COALESCE(sum(estimated_value_cents), 0) FROM network_handoffs
                          WHERE status = 'open' AND expires_at > now()),
    'available_technicians', (SELECT COALESCE(sum(technicians_available), 0) FROM network_capacity_listings
                               WHERE status = 'active' AND available_until > now()),
    'idle_vehicles', (SELECT COALESCE(sum(vehicles_idle), 0) FROM network_capacity_listings
                       WHERE status = 'active' AND available_until > now()),
    'members', (SELECT count(*) FROM business_profile WHERE network_enabled),
    'median_minutes_to_accept_30d', (
      SELECT round((percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM (fc.at - p.at)) / 60))::numeric, 0)
        FROM (SELECT handoff_id, created_at AS at FROM network_handoff_events
               WHERE event = 'posted' AND created_at > now() - interval '30 days') p
        JOIN (SELECT handoff_id, min(created_at) AS at FROM network_handoff_events
               WHERE event = 'claimed' GROUP BY handoff_id) fc USING (handoff_id)
    ),
    'fill_rate_30d_pct', (
      SELECT round(100.0 * count(*) FILTER (WHERE claimed_at IS NOT NULL)
                   / NULLIF(count(*) FILTER (WHERE status <> 'open'), 0))
        FROM network_handoffs WHERE created_at > now() - interval '30 days'
    )
  ) INTO v_network;

  WITH demand AS (
    SELECT region_key AS region, trade_category AS trade, count(*) AS jobs,
           COALESCE(sum(estimated_value_cents), 0) AS value_cents
    FROM network_handoffs WHERE status = 'open' AND expires_at > now()
    GROUP BY 1, 2
  ),
  supply AS (
    SELECT l.region_key AS region, t AS trade,
           sum(l.technicians_available) AS techs, sum(l.vehicles_idle) AS vans
    FROM network_capacity_listings l, unnest(l.trades) t
    WHERE l.status = 'active' AND l.available_until > now()
    GROUP BY 1, 2
  ),
  joined AS (
    SELECT COALESCE(d.region, s.region) AS region, COALESCE(d.trade, s.trade) AS trade,
           COALESCE(d.jobs, 0) AS jobs, COALESCE(d.value_cents, 0) AS value_cents,
           COALESCE(s.techs, 0) AS techs, COALESCE(s.vans, 0) AS vans
    FROM demand d FULL JOIN supply s ON s.region = d.region AND s.trade = d.trade
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.jobs DESC, x.techs DESC), '[]'::jsonb)
    INTO v_markets
    FROM (SELECT * FROM joined ORDER BY jobs DESC, techs DESC LIMIT 12) x;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'mine', jsonb_build_object(
      'position', v_position,
      'waiting_jobs', v_waiting,
      'active_claimed', v_active,
      'max_concurrent', v_max,
      'load_pct', v_load,
      'active_listings', v_my_listings,
      'idle_technicians', v_my_techs,
      'idle_vehicles', v_my_vans,
      'open_jobs_for_my_listings', v_fit
    ),
    'network', v_network,
    'markets', v_markets
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 11. Grants — authenticated only
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.set_capacity_capabilities(text[], text[], text[], integer, smallint),
  public.add_capacity_credential(text, text, text, date),
  public.remove_capacity_credential(uuid),
  public.review_capacity_credential(uuid, text),
  public.set_handoff_requirements(uuid, text[], text[], smallint, integer, boolean),
  public.publish_capacity_listing(text[], smallint, smallint, timestamptz, timestamptz, integer, text),
  public.withdraw_capacity_listing(uuid),
  public.expire_capacity_listings(),
  public.get_market_pulse()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.set_capacity_capabilities(text[], text[], text[], integer, smallint),
  public.add_capacity_credential(text, text, text, date),
  public.remove_capacity_credential(uuid),
  public.review_capacity_credential(uuid, text),
  public.set_handoff_requirements(uuid, text[], text[], smallint, integer, boolean),
  public.publish_capacity_listing(text[], smallint, smallint, timestamptz, timestamptz, integer, text),
  public.withdraw_capacity_listing(uuid),
  public.expire_capacity_listings(),
  public.get_market_pulse()
TO authenticated;

COMMENT ON TABLE network_credentials IS
  'Insurance / license / certification / OEM credentials per member. Self-declared until an admin verifies. Private to the owner; used only as scoring input and hard gates by compute_handoff_matches.';
COMMENT ON TABLE network_capacity_listings IS
  'Supply side of the Capacity Exchange: idle technicians / vans a member offers for a time window. Feeds availability scoring and the anonymised market pulse.';
