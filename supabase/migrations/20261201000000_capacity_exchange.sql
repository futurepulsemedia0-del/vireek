/*
# Capacity Exchange — automated matching, transfer and quality tracking

## Why
`network_handoffs` (see 20261101000000_contractor_network_hub.sql) already lets
a contractor POST a job and lets any network member CLAIM it (first-come,
manual browse). This migration adds the layer described in the product spec:

  Demand → Vireek → Available certified capacity → Match → Transfer
    → Revenue split → Quality tracking

Concretely: when a handoff is posted with `smart_match = true`, Vireek scores
every eligible, opted-in member by trade certification, region, current load
vs. stated capacity, and track record — then sequentially OFFERS the job to
the best match first, with a response window. If they decline or time out,
the offer automatically advances to the next-best match. Acceptance transfers
the job exactly like an existing claim (same table, same referral-fee split,
same coordination-contact reveal). After completion, the poster rates the
work, which feeds back into that contractor's score for future matches.

## What this migration adds (additive, idempotent, nothing existing is dropped)
1. `network_handoffs.smart_match`        — flag set when a post used the exchange.
2. `network_capacity_profiles`           — one row per member: certified trades,
                                            weekly capacity, concurrency cap,
                                            opt-in, rolling quality rating.
3. `network_handoff_matches`             — ranked, sequential offer queue per handoff.
4. `network_handoff_ratings`             — one rating per completed handoff.
5. RPCs: set_capacity_profile, compute_handoff_matches, respond_to_match,
   advance_expired_matches, rate_handoff, get_capacity_exchange_summary,
   get_handoff_match_pipeline, and an internal `_promote_next_match` helper.
6. `post_network_handoff` gains an optional `p_smart_match` parameter (old
   12-arg signature is dropped and replaced — no orphaned overload left behind).

## Security model (same posture as the rest of the network hub)
- No INSERT/UPDATE/DELETE grant on any of the new tables; every mutation goes
  through a SECURITY DEFINER RPC.
- A candidate can only ever see match rows offered to THEM
  (`candidate_id = get_account_owner_id()`) — the poster never sees which
  businesses were invited, only aggregated pipeline counts via
  `get_handoff_match_pipeline`, so member participation stays anonymous
  until a match is actually accepted (at which point the existing
  `claimed_by_name` / `claimed_by_phone` reveal on `network_handoffs` kicks in,
  exactly as it already does for a manual claim).
- Acceptance re-uses the exact same atomic
  `UPDATE network_handoffs ... WHERE status = 'open'` guard as
  `claim_network_handoff`, so a smart-matched job can never be double-claimed.

## Depends on (all already in the project)
profiles, business_profile, notifications, get_account_owner_id(),
is_network_member(), set_updated_at(), network_handoffs,
network_handoff_events (all from 20261101000000_contractor_network_hub.sql).
*/

-- ---------------------------------------------------------------------
-- 1. Flag on the existing handoff row
-- ---------------------------------------------------------------------
ALTER TABLE network_handoffs
  ADD COLUMN IF NOT EXISTS smart_match boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS network_capacity_profiles (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  certified_trades text[] NOT NULL DEFAULT '{}', -- empty = open to all trades
  weekly_capacity_hours smallint NOT NULL DEFAULT 20
    CHECK (weekly_capacity_hours BETWEEN 0 AND 168),
  max_concurrent_handoffs smallint NOT NULL DEFAULT 3
    CHECK (max_concurrent_handoffs BETWEEN 1 AND 25),
  auto_match_enabled boolean NOT NULL DEFAULT true,
  avg_rating numeric(3,2) NOT NULL DEFAULT 0 CHECK (avg_rating BETWEEN 0 AND 5),
  ratings_count integer NOT NULL DEFAULT 0 CHECK (ratings_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS network_handoff_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES network_handoffs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 10),
  score numeric(6,2) NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'offered', 'accepted', 'declined', 'expired', 'superseded')),
  offered_at timestamptz,
  responds_by timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (handoff_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_handoff_matches_candidate
  ON network_handoff_matches (candidate_id, status);
CREATE INDEX IF NOT EXISTS idx_handoff_matches_handoff_rank
  ON network_handoff_matches (handoff_id, rank);
CREATE INDEX IF NOT EXISTS idx_handoff_matches_offered_expiry
  ON network_handoff_matches (responds_by) WHERE status = 'offered';

CREATE TABLE IF NOT EXISTS network_handoff_ratings (
  handoff_id uuid PRIMARY KEY REFERENCES network_handoffs(id) ON DELETE CASCADE,
  rated_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rated_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  quality_notes text CHECK (quality_notes IS NULL OR char_length(quality_notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_handoff_ratings_rated_user
  ON network_handoff_ratings (rated_user_id);

-- ---------------------------------------------------------------------
-- 3. RLS — read-only for clients, all writes via RPC
-- ---------------------------------------------------------------------
ALTER TABLE network_capacity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_handoff_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_handoff_ratings ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_capacity_profiles FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_handoff_matches FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON network_handoff_ratings FROM authenticated, anon;
REVOKE SELECT ON network_capacity_profiles, network_handoff_matches, network_handoff_ratings FROM anon;

DROP POLICY IF EXISTS "select_own_capacity_profile" ON network_capacity_profiles;
CREATE POLICY "select_own_capacity_profile" ON network_capacity_profiles FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "select_own_handoff_matches" ON network_handoff_matches;
CREATE POLICY "select_own_handoff_matches" ON network_handoff_matches FOR SELECT TO authenticated
USING (candidate_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "select_own_handoff_ratings" ON network_handoff_ratings;
CREATE POLICY "select_own_handoff_ratings" ON network_handoff_ratings FOR SELECT TO authenticated
USING (
  rated_by = (SELECT public.get_account_owner_id())
  OR rated_user_id = (SELECT public.get_account_owner_id())
);

DROP TRIGGER IF EXISTS trigger_touch_capacity_profiles ON network_capacity_profiles;
CREATE TRIGGER trigger_touch_capacity_profiles
  BEFORE UPDATE ON network_capacity_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE network_handoff_matches;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- 4. Capacity profile RPC
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_capacity_profile(
  p_certified_trades text[],
  p_weekly_capacity_hours smallint,
  p_max_concurrent_handoffs smallint,
  p_auto_match_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_trades text[] := COALESCE(p_certified_trades, '{}');
  v_bad text[];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF auth.uid() <> v_owner THEN RAISE EXCEPTION 'OWNER_ONLY'; END IF;

  SELECT array_agg(t) INTO v_bad FROM unnest(v_trades) t
   WHERE t NOT IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;

  IF COALESCE(p_weekly_capacity_hours, -1) NOT BETWEEN 0 AND 168
     OR COALESCE(p_max_concurrent_handoffs, -1) NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  INSERT INTO network_capacity_profiles
    (user_id, certified_trades, weekly_capacity_hours, max_concurrent_handoffs, auto_match_enabled)
  VALUES
    (v_owner, v_trades, p_weekly_capacity_hours, p_max_concurrent_handoffs, COALESCE(p_auto_match_enabled, true))
  ON CONFLICT (user_id) DO UPDATE
    SET certified_trades = EXCLUDED.certified_trades,
        weekly_capacity_hours = EXCLUDED.weekly_capacity_hours,
        max_concurrent_handoffs = EXCLUDED.max_concurrent_handoffs,
        auto_match_enabled = EXCLUDED.auto_match_enabled,
        updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Internal helper — promotes the next queued candidate to "offered".
--    Not callable directly by clients (no grant to authenticated/PUBLIC);
--    only invoked from other SECURITY DEFINER functions in this file.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._promote_next_match(p_handoff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h network_handoffs;
  v_next network_handoff_matches;
BEGIN
  SELECT * INTO h FROM network_handoffs WHERE id = p_handoff_id;
  IF NOT FOUND OR h.status <> 'open' THEN RETURN; END IF;

  SELECT * INTO v_next FROM network_handoff_matches
   WHERE handoff_id = p_handoff_id AND status = 'queued'
   ORDER BY rank ASC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE network_handoff_matches
     SET status = 'offered', offered_at = now(), responds_by = now() + interval '20 minutes'
   WHERE id = v_next.id;

  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    v_next.candidate_id, 'system', 'New capacity-exchange offer',
    'A ' || h.trade_category || ' job matching your profile is now offered to you: "' || h.title || '".',
    '/dashboard/network/capacity-exchange'
  );
END;
$$;

REVOKE ALL ON FUNCTION public._promote_next_match(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Matching engine — scores and ranks eligible members, offers rank #1
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
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT * INTO h FROM network_handoffs WHERE id = p_handoff_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;
  IF h.status <> 'open' THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;

  -- Idempotent / re-runnable: clear any previous non-terminal offers first.
  DELETE FROM network_handoff_matches
   WHERE handoff_id = p_handoff_id AND status IN ('queued', 'offered');

  WITH candidates AS (
    SELECT
      bp.user_id AS candidate_id,
      lower(btrim(bp.service_area)) AS region,
      COALESCE(ncp.max_concurrent_handoffs, 3) AS max_concurrent,
      COALESCE(ncp.avg_rating, 0) AS avg_rating,
      (SELECT count(*) FROM network_handoffs nh
        WHERE nh.claimed_by = bp.user_id AND nh.status = 'claimed') AS active_load,
      (SELECT count(*) FROM network_handoffs nh2
        WHERE nh2.claimed_by = bp.user_id AND nh2.status = 'completed') AS done_count,
      (SELECT count(*) FROM network_handoff_events ev
        WHERE ev.actor_id = bp.user_id AND ev.event = 'released') AS released_count
    FROM business_profile bp
    LEFT JOIN network_capacity_profiles ncp ON ncp.user_id = bp.user_id
    WHERE bp.network_enabled
      AND bp.user_id <> v_owner
      AND COALESCE(ncp.auto_match_enabled, true)
      AND (
        ncp.certified_trades IS NULL
        OR array_length(ncp.certified_trades, 1) IS NULL
        OR h.trade_category = ANY (ncp.certified_trades)
      )
  ),
  scored AS (
    SELECT
      candidate_id,
      -- 0-25: exact service-area match. 0-20: quality rating. 0-40: completion
      -- reliability (new members with no history default to a neutral 15).
      -- 0-20: capacity headroom (more free slots vs. their own cap = higher).
      (CASE WHEN region = lower(btrim(h.region_key)) THEN 25 ELSE 0 END)
        + LEAST(20, (avg_rating / 5.0) * 20)
        + (CASE WHEN done_count + released_count = 0 THEN 15
                ELSE 40 * done_count / (done_count + released_count)::numeric END)
        + GREATEST(0, 20 - (20 * active_load / GREATEST(max_concurrent, 1)))
        AS score
    FROM candidates
    WHERE active_load < max_concurrent
  ),
  ranked AS (
    SELECT candidate_id, score,
           row_number() OVER (ORDER BY score DESC, candidate_id) AS rn
    FROM scored
  )
  INSERT INTO network_handoff_matches (handoff_id, candidate_id, rank, score, status, offered_at, responds_by)
  SELECT
    p_handoff_id, candidate_id, rn, round(score::numeric, 2),
    CASE WHEN rn = 1 THEN 'offered' ELSE 'queued' END,
    CASE WHEN rn = 1 THEN now() END,
    CASE WHEN rn = 1 THEN now() + interval '20 minutes' END
  FROM ranked
  WHERE rn <= 5;

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
-- 7. Candidate responds to an offer (accept = transfer, decline = advance)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_to_match(p_match_id uuid, p_accept boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  m network_handoff_matches;
  v_name text;
  v_phone text;
  r network_handoffs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT * INTO m FROM network_handoff_matches
   WHERE id = p_match_id AND candidate_id = v_owner;
  IF NOT FOUND OR m.status <> 'offered' THEN RAISE EXCEPTION 'MATCH_UNAVAILABLE'; END IF;

  IF m.responds_by IS NOT NULL AND m.responds_by < now() THEN
    UPDATE network_handoff_matches SET status = 'expired', responded_at = now() WHERE id = m.id;
    PERFORM public._promote_next_match(m.handoff_id);
    RAISE EXCEPTION 'MATCH_EXPIRED';
  END IF;

  IF NOT p_accept THEN
    UPDATE network_handoff_matches SET status = 'declined', responded_at = now() WHERE id = m.id;
    PERFORM public._promote_next_match(m.handoff_id);
    RETURN NULL;
  END IF;

  IF (SELECT count(*) FROM network_handoffs WHERE claimed_by = v_owner AND status = 'claimed') >= 10 THEN
    RAISE EXCEPTION 'TOO_MANY_ACTIVE_CLAIMS';
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.company_name), ''), 'Vireek member'), bp.network_contact_phone
    INTO v_name, v_phone
    FROM profiles p LEFT JOIN business_profile bp ON bp.user_id = p.id
   WHERE p.id = v_owner;

  -- Same atomic guard as claim_network_handoff: only one winner, ever.
  UPDATE network_handoffs
     SET status = 'claimed', claimed_by = v_owner, claimed_by_name = v_name,
         claimed_by_phone = v_phone, claimed_at = now()
   WHERE id = m.handoff_id AND status = 'open' AND expires_at > now() AND user_id <> v_owner
  RETURNING * INTO r;

  IF NOT FOUND THEN
    UPDATE network_handoff_matches SET status = 'expired', responded_at = now() WHERE id = m.id;
    RAISE EXCEPTION 'HANDOFF_UNAVAILABLE';
  END IF;

  UPDATE network_handoff_matches SET status = 'accepted', responded_at = now() WHERE id = m.id;
  UPDATE network_handoff_matches SET status = 'superseded'
   WHERE handoff_id = m.handoff_id AND id <> m.id AND status IN ('queued', 'offered');

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (r.id, v_owner, 'claimed');
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (
    r.user_id, 'system', 'Capacity-exchange match accepted',
    v_name || ' accepted the smart match for "' || r.title || '". Their coordination number is on the handoff card.',
    '/dashboard/network/handoffs?tab=posted'
  );
  RETURN r.id;
END;
$$;

-- ---------------------------------------------------------------------
-- 8. Maintenance — expires stale offers and advances the queue. Idempotent;
--    call from the client on page load, exactly like expire_network_handoffs.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_expired_matches()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
  rec record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  FOR rec IN
    SELECT id, handoff_id FROM network_handoff_matches
    WHERE status = 'offered' AND responds_by IS NOT NULL AND responds_by <= now()
  LOOP
    UPDATE network_handoff_matches SET status = 'expired', responded_at = now() WHERE id = rec.id;
    PERFORM public._promote_next_match(rec.handoff_id);
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------
-- 9. Quality tracking — poster rates the contractor after completion
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rate_handoff(p_handoff_id uuid, p_rating smallint, p_notes text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  h network_handoffs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;

  SELECT * INTO h FROM network_handoffs
   WHERE id = p_handoff_id AND user_id = v_owner AND status = 'completed';
  IF NOT FOUND OR h.claimed_by IS NULL THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF;

  INSERT INTO network_handoff_ratings (handoff_id, rated_by, rated_user_id, rating, quality_notes)
  VALUES (p_handoff_id, v_owner, h.claimed_by, p_rating, nullif(btrim(coalesce(p_notes, '')), ''))
  ON CONFLICT (handoff_id) DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'HANDOFF_UNAVAILABLE'; END IF; -- already rated once

  INSERT INTO network_capacity_profiles (user_id, ratings_count, avg_rating)
  VALUES (h.claimed_by, 1, p_rating)
  ON CONFLICT (user_id) DO UPDATE
    SET ratings_count = network_capacity_profiles.ratings_count + 1,
        avg_rating = round(
          ((network_capacity_profiles.avg_rating * network_capacity_profiles.ratings_count) + p_rating)
          / (network_capacity_profiles.ratings_count + 1), 2
        ),
        updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------
-- 10. Summaries
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_capacity_exchange_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  prof network_capacity_profiles;
  v_pending integer;
  v_open_smart integer;
  v_accepted integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;

  SELECT * INTO prof FROM network_capacity_profiles WHERE user_id = v_owner;
  SELECT count(*) INTO v_pending FROM network_handoff_matches
   WHERE candidate_id = v_owner AND status = 'offered';
  SELECT count(*) INTO v_open_smart FROM network_handoffs
   WHERE user_id = v_owner AND status = 'open' AND smart_match;
  SELECT count(*) INTO v_accepted FROM network_handoff_matches
   WHERE candidate_id = v_owner AND status = 'accepted';

  RETURN jsonb_build_object(
    'has_profile', prof.user_id IS NOT NULL,
    'certified_trades', COALESCE(prof.certified_trades, '{}'),
    'weekly_capacity_hours', COALESCE(prof.weekly_capacity_hours, 20),
    'max_concurrent_handoffs', COALESCE(prof.max_concurrent_handoffs, 3),
    'auto_match_enabled', COALESCE(prof.auto_match_enabled, true),
    'avg_rating', COALESCE(prof.avg_rating, 0),
    'ratings_count', COALESCE(prof.ratings_count, 0),
    'pending_offers', v_pending,
    'accepted_matches', v_accepted,
    'my_open_smart_handoffs', v_open_smart
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_handoff_match_pipeline(p_handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM network_handoffs WHERE id = p_handoff_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'HANDOFF_UNAVAILABLE';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'total', count(*),
      'offered', count(*) FILTER (WHERE status = 'offered'),
      'queued', count(*) FILTER (WHERE status = 'queued'),
      'declined', count(*) FILTER (WHERE status = 'declined'),
      'expired', count(*) FILTER (WHERE status = 'expired'),
      'accepted', count(*) FILTER (WHERE status = 'accepted'),
      'current_offer_expires_at', max(responds_by) FILTER (WHERE status = 'offered')
    )
    FROM network_handoff_matches WHERE handoff_id = p_handoff_id
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 11. Extend post_network_handoff with an opt-in smart-match flag.
--     The old 12-arg signature is dropped so no orphaned overload remains.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.post_network_handoff(
  text, text, text, text, text, timestamptz, integer, numeric, text, text, text, text
);

CREATE FUNCTION public.post_network_handoff(
  p_kind text,
  p_trade text,
  p_title text,
  p_summary text,
  p_location_label text,
  p_needed_by timestamptz,
  p_estimated_value_cents integer,
  p_referral_fee_pct numeric,
  p_customer_name text,
  p_customer_phone text,
  p_customer_address text,
  p_notes text,
  p_smart_match boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_region text;
  v_name text;
  v_id uuid;
  v_exp timestamptz;
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
  v_label text := nullif(btrim(coalesce(p_location_label, '')), '');
  v_cust text := btrim(coalesce(p_customer_name, ''));
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
  v_addr text := nullif(btrim(coalesce(p_customer_address, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.is_network_member() THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  IF COALESCE(p_kind, '') NOT IN ('capacity_overflow', 'emergency')
     OR COALESCE(p_trade, '') NOT IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')
     OR char_length(v_title) NOT BETWEEN 3 AND 120
     OR char_length(COALESCE(v_summary, '')) > 1000
     OR char_length(COALESCE(v_label, '')) > 80
     OR COALESCE(p_estimated_value_cents, 0) < 0
     OR COALESCE(p_referral_fee_pct, 10) NOT BETWEEN 0 AND 50 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF public.network_text_has_contact_info(v_title)
     OR public.network_text_has_contact_info(v_summary)
     OR public.network_text_has_contact_info(v_label) THEN
    RAISE EXCEPTION 'PII_IN_PUBLIC_FIELDS';
  END IF;
  IF v_cust = '' OR (v_phone IS NULL AND v_addr IS NULL) THEN RAISE EXCEPTION 'CONTACT_REQUIRED'; END IF;

  SELECT lower(btrim(service_area)) INTO v_region FROM business_profile WHERE user_id = v_owner;
  IF v_region IS NULL OR v_region = '' THEN RAISE EXCEPTION 'SERVICE_AREA_REQUIRED'; END IF;

  IF (SELECT count(*) FROM network_handoffs WHERE user_id = v_owner AND status = 'open') >= 15 THEN
    RAISE EXCEPTION 'TOO_MANY_OPEN';
  END IF;

  SELECT COALESCE(NULLIF(btrim(company_name), ''), 'Vireek member') INTO v_name FROM profiles WHERE id = v_owner;

  v_exp := now() + CASE WHEN p_kind = 'emergency' THEN interval '3 hours' ELSE interval '72 hours' END;
  IF p_needed_by IS NOT NULL THEN
    IF p_needed_by < now() + interval '15 minutes' THEN RAISE EXCEPTION 'NEEDED_BY_TOO_SOON'; END IF;
    v_exp := LEAST(v_exp, p_needed_by);
  END IF;

  INSERT INTO network_handoffs (
    user_id, business_name, kind, trade_category, title, summary, region_key, location_label,
    needed_by, estimated_value_cents, referral_fee_pct, expires_at
  ) VALUES (
    v_owner, v_name, p_kind, p_trade, v_title, v_summary, v_region, v_label,
    p_needed_by, p_estimated_value_cents, COALESCE(p_referral_fee_pct, 10), v_exp
  ) RETURNING id INTO v_id;

  INSERT INTO network_handoff_contacts (handoff_id, customer_name, customer_phone, customer_address, notes)
  VALUES (v_id, v_cust, v_phone, v_addr, nullif(btrim(coalesce(p_notes, '')), ''));

  INSERT INTO network_handoff_events (handoff_id, actor_id, event) VALUES (v_id, v_owner, 'posted');

  IF COALESCE(p_smart_match, false) THEN
    PERFORM public.compute_handoff_matches(v_id);
  END IF;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- 12. Grants — authenticated only
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.set_capacity_profile(text[], smallint, smallint, boolean),
  public.compute_handoff_matches(uuid),
  public.respond_to_match(uuid, boolean),
  public.advance_expired_matches(),
  public.rate_handoff(uuid, smallint, text),
  public.get_capacity_exchange_summary(),
  public.get_handoff_match_pipeline(uuid),
  public.post_network_handoff(text, text, text, text, text, timestamptz, integer, numeric, text, text, text, text, boolean)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.set_capacity_profile(text[], smallint, smallint, boolean),
  public.compute_handoff_matches(uuid),
  public.respond_to_match(uuid, boolean),
  public.advance_expired_matches(),
  public.rate_handoff(uuid, smallint, text),
  public.get_capacity_exchange_summary(),
  public.get_handoff_match_pipeline(uuid),
  public.post_network_handoff(text, text, text, text, text, timestamptz, integer, numeric, text, text, text, text, boolean)
TO authenticated;

COMMENT ON TABLE network_capacity_profiles IS
  'One row per opted-in member: certified trades, stated weekly capacity, concurrency cap and rolling quality rating used by the Capacity Exchange matching engine.';
COMMENT ON TABLE network_handoff_matches IS
  'Ranked, sequential offer queue for a smart-matched handoff. Only rank #1 is "offered" at a time; declines/timeouts promote the next rank.';
COMMENT ON TABLE network_handoff_ratings IS
  'One quality rating per completed handoff, given by the poster to the contractor who did the work. Feeds network_capacity_profiles.avg_rating.';
