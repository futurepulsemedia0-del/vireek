/*
  # Multi-location / Franchise Command Center

  - franchise_groups: one row per HQ account. owner_id is the profile
    (auth.uid()) that created the group and is the only one who can see
    the rolled-up dashboard.
  - franchise_locations: one row per location linked (or invited) into a
    group. A location is itself a normal, independent Vireek account
    (its own `profiles` row) — invited by email, and only counted in the
    HQ rollup once that account's owner accepts.

  Cross-tenant reads (HQ owner reading another account's calls/jobs/
  reviews totals) can't go through the normal per-user RLS policies on
  calls/jobs/review_requests, so the rollup is served by a SECURITY
  DEFINER function that re-checks group ownership and active-location
  membership itself before aggregating — same technique as
  get_account_owner_id() in the profiles/team_members migration.
  Direct table access to other tenants' rows is never granted.
*/

CREATE TABLE IF NOT EXISTS franchise_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE franchise_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_franchise_group" ON franchise_groups;
CREATE POLICY "select_own_franchise_group" ON franchise_groups FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_franchise_group" ON franchise_groups;
CREATE POLICY "insert_own_franchise_group" ON franchise_groups FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "update_own_franchise_group" ON franchise_groups;
CREATE POLICY "update_own_franchise_group" ON franchise_groups FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_franchise_group" ON franchise_groups;
CREATE POLICY "delete_own_franchise_group" ON franchise_groups FOR DELETE TO authenticated USING (owner_id = auth.uid());

CREATE TABLE IF NOT EXISTS franchise_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_group_id uuid NOT NULL REFERENCES franchise_groups(id) ON DELETE CASCADE,
  location_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  invited_email text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'declined')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz,
  UNIQUE (franchise_group_id, invited_email)
);

CREATE INDEX IF NOT EXISTS idx_franchise_locations_group_id ON franchise_locations(franchise_group_id);
CREATE INDEX IF NOT EXISTS idx_franchise_locations_invited_email ON franchise_locations(invited_email);
CREATE INDEX IF NOT EXISTS idx_franchise_locations_profile_id ON franchise_locations(location_profile_id);

ALTER TABLE franchise_locations ENABLE ROW LEVEL SECURITY;

-- The HQ owner manages every row in their own group.
DROP POLICY IF EXISTS "hq_manage_franchise_locations" ON franchise_locations;
CREATE POLICY "hq_manage_franchise_locations" ON franchise_locations FOR ALL TO authenticated
  USING (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()))
  WITH CHECK (franchise_group_id IN (SELECT id FROM franchise_groups WHERE owner_id = auth.uid()));

-- A location account can only ever SELECT its own invite row (to see and
-- respond to it). All mutation for an invited party goes through
-- respond_to_franchise_invite() below, never a direct UPDATE policy, so an
-- invited account can't rewrite the label or point the row at a different
-- group.
DROP POLICY IF EXISTS "select_own_franchise_invite" ON franchise_locations;
CREATE POLICY "select_own_franchise_invite" ON franchise_locations FOR SELECT TO authenticated
  USING (
    location_profile_id = auth.uid()
    OR invited_email = (SELECT email FROM auth.users WHERE id = auth.uid())
  );

-- =============================================================
-- RPC: respond_to_franchise_invite
-- Lets an invited account accept or decline, without giving it a
-- direct UPDATE policy on franchise_locations.
-- =============================================================
CREATE OR REPLACE FUNCTION public.respond_to_franchise_invite(p_location_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

  UPDATE franchise_locations
  SET
    location_profile_id = auth.uid(),
    status = CASE WHEN p_accept THEN 'active' ELSE 'declined' END,
    joined_at = CASE WHEN p_accept THEN now() ELSE joined_at END
  WHERE id = p_location_id
    AND status = 'invited'
    AND invited_email = v_email;
END;
$$;

-- =============================================================
-- RPC: get_pending_franchise_invites
-- Invites addressed to the caller's email, regardless of group.
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_pending_franchise_invites()
RETURNS TABLE (
  id uuid,
  franchise_group_id uuid,
  franchise_name text,
  label text,
  invited_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT fl.id, fl.franchise_group_id, fg.name, fl.label, fl.invited_at
  FROM franchise_locations fl
  JOIN franchise_groups fg ON fg.id = fl.franchise_group_id
  WHERE fl.status = 'invited'
    AND fl.invited_email = (SELECT email FROM auth.users WHERE id = auth.uid());
$$;

-- =============================================================
-- RPC: get_franchise_dashboard_stats
-- Rolled-up 30-day stats per active location. Only the group's HQ
-- owner can call this for their own group.
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_franchise_dashboard_stats(p_group_id uuid)
RETURNS TABLE (
  location_id uuid,
  label text,
  company_name text,
  status text,
  calls_30d bigint,
  emergency_calls_30d bigint,
  jobs_30d bigint,
  revenue_30d numeric,
  avg_rating numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM franchise_groups WHERE id = p_group_id AND owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for this franchise group';
  END IF;

  RETURN QUERY
  SELECT
    fl.id,
    fl.label,
    p.company_name,
    fl.status,
    COALESCE((SELECT count(*) FROM calls c WHERE c.user_id = fl.location_profile_id AND c.call_datetime > now() - interval '30 days'), 0),
    COALESCE((SELECT count(*) FROM calls c WHERE c.user_id = fl.location_profile_id AND c.is_emergency AND c.call_datetime > now() - interval '30 days'), 0),
    COALESCE((SELECT count(*) FROM jobs j WHERE j.user_id = fl.location_profile_id AND j.created_at > now() - interval '30 days'), 0),
    COALESCE((SELECT sum(j.invoice_amount) FROM jobs j WHERE j.user_id = fl.location_profile_id AND j.invoice_status = 'paid' AND j.created_at > now() - interval '30 days'), 0),
    (SELECT avg(r.rating) FROM review_requests r WHERE r.user_id = fl.location_profile_id AND r.rating IS NOT NULL AND r.sent_at > now() - interval '30 days')
  FROM franchise_locations fl
  LEFT JOIN profiles p ON p.id = fl.location_profile_id
  WHERE fl.franchise_group_id = p_group_id
    AND fl.status = 'active';
END;
$$;
