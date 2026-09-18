/*
# Disaster Mutual-Aid Network

## What this does
Lets opted-in Vireek accounts broadcast an overflow-help request to other
opted-in accounts during a disaster/weather event, and lets other accounts
offer overflow call handling or technician labor in response. Reuses the
existing `business_profile.service_area` region-matching convention (see
20260930000000_regional_demand_intelligence.sql) instead of introducing a
new lat/lon geo system, and can optionally link a request to a real
`weather_surge_events` row (20260929000000_weather_surge_intelligence.sql)
so "why did we ask for help" has a real trigger behind it.

## New Tables
- mutual_aid_requests — one open ask per business at a time (not unique-
  constrained, an account can have several over time, but the UI only
  surfaces one active broadcast at once)
- mutual_aid_offers   — responses from other businesses

## Privacy model
The open-requests feed (get_open_mutual_aid_requests) is visible only to
OTHER opted-in accounts (reciprocity — you see the network only if you're
in it), and never includes a direct phone number. A phone number is only
exchanged once the requesting business explicitly accepts a specific offer
— handled by the mutual-aid-notify Edge Function, not by this migration.

## Depends on
profiles, business_profile, weather_surge_events, get_account_owner_id()
— all already present.
*/

-- =============================================================
-- BUSINESS_PROFILE: opt-in
-- =============================================================

ALTER TABLE business_profile
ADD COLUMN IF NOT EXISTS mutual_aid_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS mutual_aid_contact_phone text;

-- =============================================================
-- MUTUAL_AID_REQUESTS
-- =============================================================

CREATE TABLE IF NOT EXISTS mutual_aid_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  industry text,
  region_key text NOT NULL, -- normalized service_area, snapshotted at creation time
  trade_note text NOT NULL,
  need_type text NOT NULL DEFAULT 'both' CHECK (need_type IN ('overflow_calls', 'technician_labor', 'both')),
  related_weather_event_id uuid REFERENCES weather_surge_events(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mutual_aid_requests_status ON mutual_aid_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_mutual_aid_requests_user ON mutual_aid_requests(user_id, created_at DESC);

ALTER TABLE mutual_aid_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_mutual_aid_requests" ON mutual_aid_requests;
CREATE POLICY "select_mutual_aid_requests" ON mutual_aid_requests FOR SELECT TO authenticated
  USING (
    user_id = get_account_owner_id()
    OR (
      status = 'open'
      AND EXISTS (SELECT 1 FROM business_profile bp WHERE bp.user_id = get_account_owner_id() AND bp.mutual_aid_enabled = true)
    )
  );

DROP POLICY IF EXISTS "insert_own_mutual_aid_requests" ON mutual_aid_requests;
CREATE POLICY "insert_own_mutual_aid_requests" ON mutual_aid_requests FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "update_own_mutual_aid_requests" ON mutual_aid_requests;
CREATE POLICY "update_own_mutual_aid_requests" ON mutual_aid_requests FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "delete_own_mutual_aid_requests" ON mutual_aid_requests;
CREATE POLICY "delete_own_mutual_aid_requests" ON mutual_aid_requests FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =============================================================
-- MUTUAL_AID_OFFERS
-- =============================================================

CREATE TABLE IF NOT EXISTS mutual_aid_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES mutual_aid_requests(id) ON DELETE CASCADE,
  offering_user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  offer_type text NOT NULL DEFAULT 'overflow_calls' CHECK (offer_type IN ('overflow_calls', 'technician_labor', 'both')),
  note text,
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (request_id, offering_user_id)
);

CREATE INDEX IF NOT EXISTS idx_mutual_aid_offers_request ON mutual_aid_offers(request_id);

ALTER TABLE mutual_aid_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_mutual_aid_offers" ON mutual_aid_offers;
CREATE POLICY "select_mutual_aid_offers" ON mutual_aid_offers FOR SELECT TO authenticated
  USING (
    offering_user_id = get_account_owner_id()
    OR EXISTS (SELECT 1 FROM mutual_aid_requests r WHERE r.id = request_id AND r.user_id = get_account_owner_id())
  );

DROP POLICY IF EXISTS "insert_mutual_aid_offers" ON mutual_aid_offers;
CREATE POLICY "insert_mutual_aid_offers" ON mutual_aid_offers FOR INSERT TO authenticated
  WITH CHECK (offering_user_id = auth.uid());

DROP POLICY IF EXISTS "update_mutual_aid_offers" ON mutual_aid_offers;
CREATE POLICY "update_mutual_aid_offers" ON mutual_aid_offers FOR UPDATE TO authenticated
  USING (
    offering_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM mutual_aid_requests r WHERE r.id = request_id AND r.user_id = auth.uid())
  )
  WITH CHECK (
    offering_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM mutual_aid_requests r WHERE r.id = request_id AND r.user_id = auth.uid())
  );

-- =============================================================
-- get_open_mutual_aid_requests(): the network feed.
-- Self-healing (expires stale rows on every call) + reciprocity-gated
-- (only visible to accounts that are themselves opted in) + never
-- exposes a phone number.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_open_mutual_aid_requests()
RETURNS TABLE (
  id uuid,
  user_id uuid,
  business_name text,
  industry text,
  region_key text,
  trade_note text,
  need_type text,
  created_at timestamptz,
  expires_at timestamptz,
  my_offer_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE mutual_aid_requests SET status = 'expired' WHERE status = 'open' AND expires_at < now();

  IF NOT EXISTS (SELECT 1 FROM business_profile bp WHERE bp.user_id = auth.uid() AND bp.mutual_aid_enabled = true) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, p.company_name, r.industry, r.region_key, r.trade_note, r.need_type,
         r.created_at, r.expires_at, o.status
  FROM mutual_aid_requests r
  JOIN profiles p ON p.id = r.user_id
  LEFT JOIN mutual_aid_offers o ON o.request_id = r.id AND o.offering_user_id = auth.uid()
  WHERE r.status = 'open' AND r.user_id <> auth.uid()
  ORDER BY r.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_open_mutual_aid_requests() TO authenticated;
