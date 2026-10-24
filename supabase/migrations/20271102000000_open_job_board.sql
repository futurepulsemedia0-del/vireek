/*
# Open Job Board & Shift Bidding

## Why
Unassigned and overflow jobs used to sit on the dispatch board until a dispatcher
phoned around. The Open Job Board broadcasts them to the people who can actually
do them — eligible technicians (skill + zone + availability) and approved
subcontractors — and lets them claim or bid, with fair rotation and a dispatcher
override. When nobody inside the company can take a job it escalates into the
existing Contractor Network handoff (network_handoffs) and stays in sync.

## What this migration adds (all additive / idempotent, nothing dropped)
1. job_board_settings         one row per account: claim rules, windows, fairness
2. job_board_vendor_profiles  opts an existing `vendors` row into the board (skills, zones)
3. job_board_posts            a job broadcast to the board
4. job_board_recipients       who was offered it, when they may act (fairness / internal-first)
5. job_board_bids             technician requests and subcontractor price bids
6. job_board_vendor_tokens    hashed magic-link tokens for subcontractors (no client access)
7. job_board_events           append-only audit trail
8. RPCs (SECURITY DEFINER): post / claim / decline / bid / award (+override) / reopen /
   cancel / expire (+auto-award) / escalate-to-network / vendor offer (public, token)
9. Trigger on network_handoffs keeps an escalated post in sync with the handoff.

## Security model
- Every table is dispatcher-only (can_manage_job_board()) for SELECT; nobody gets
  INSERT/UPDATE/DELETE: every mutation is an RPC that validates account, role and state.
- Technicians read ONLY through get_my_job_board_offers() (safe fields: no vendor prices,
  no other bidders, no customer PII). Customer details never enter the board; the winner
  sees them through the normal assigned-job screens.
- Subcontractors use an unguessable, hashed, expiring token (no account). Public RPCs
  return no customer PII and re-validate eligibility on every response.
- Claim is a single locked transition (SELECT ... FOR UPDATE) so two people can never win one post.

## Depends on (already in the project)
profiles, business_profile, team_members, jobs, vendors (+ vendor_management columns),
vendor_documents, service_areas, service_area_technicians, technician_time_off,
technician_availability, notifications, network_handoffs, post_network_handoff(),
cancel_network_handoff(), network_text_has_contact_info(), get_account_owner_id(),
get_my_team_member_id().
*/

-- =====================================================================
-- 0. Helpers
-- =====================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Owner / admin / anyone with can_manage_team (incl. via custom role): the dispatcher gate.
CREATE OR REPLACE FUNCTION public.can_manage_job_board()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
        AND tm.invite_status = 'active'
        AND (
          tm.role = 'admin'
          OR COALESCE((tm.permissions ->> 'can_manage_team')::boolean, false)
          OR COALESCE((cr.permissions ->> 'can_manage_team')::boolean, false)
        )
    );
$$;

-- =====================================================================
-- 1. Settings (one row per account, created lazily)
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  default_expiry_minutes integer NOT NULL DEFAULT 120 CHECK (default_expiry_minutes BETWEEN 5 AND 10080),
  first_look_minutes integer NOT NULL DEFAULT 10 CHECK (first_look_minutes BETWEEN 0 AND 240),
  first_look_size integer NOT NULL DEFAULT 3 CHECK (first_look_size BETWEEN 1 AND 25),
  internal_first_minutes integer NOT NULL DEFAULT 15 CHECK (internal_first_minutes BETWEEN 0 AND 1440),
  fairness_window_days integer NOT NULL DEFAULT 30 CHECK (fairness_window_days BETWEEN 1 AND 365),
  require_skill_match boolean NOT NULL DEFAULT true,
  require_zone_match boolean NOT NULL DEFAULT true,
  respect_time_off boolean NOT NULL DEFAULT true,
  block_schedule_conflicts boolean NOT NULL DEFAULT true,
  max_active_bids_per_technician integer NOT NULL DEFAULT 5 CHECK (max_active_bids_per_technician BETWEEN 1 AND 50),
  allow_subcontractors boolean NOT NULL DEFAULT true,
  require_sub_documents boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_job_board_settings_updated_at ON job_board_settings;
CREATE TRIGGER trg_job_board_settings_updated_at
  BEFORE UPDATE ON job_board_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
-- 2. Subcontractor profiles (opt an existing vendor into the board)
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_vendor_profiles (
  vendor_id uuid PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  enabled boolean NOT NULL DEFAULT true,
  skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 30),
  area_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(area_ids) <= 100),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jb_vendor_profiles_user ON job_board_vendor_profiles (user_id) WHERE enabled;

DROP TRIGGER IF EXISTS trg_jb_vendor_profiles_updated_at ON job_board_vendor_profiles;
CREATE TRIGGER trg_jb_vendor_profiles_updated_at
  BEFORE UPDATE ON job_board_vendor_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
-- 3. Posts
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'unassigned' CHECK (source IN ('unassigned', 'overflow', 'reassign')),
  audience text NOT NULL DEFAULT 'both' CHECK (audience IN ('internal', 'subcontractors', 'both')),
  claim_mode text NOT NULL DEFAULT 'first_come' CHECK (claim_mode IN ('first_come', 'bidding')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  skill text CHECK (skill IS NULL OR char_length(skill) <= 60),
  area_id uuid REFERENCES service_areas(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  summary text CHECK (summary IS NULL OR char_length(summary) <= 1000),
  location_label text CHECK (location_label IS NULL OR char_length(location_label) <= 80),
  starts_at timestamptz,
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440),
  offer_cents integer CHECK (offer_cents IS NULL OR offer_cents >= 0),
  max_bid_cents integer CHECK (max_bid_cents IS NULL OR max_bid_cents >= 0),
  auto_award boolean NOT NULL DEFAULT false,

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'expired', 'cancelled', 'escalated')),
  expires_at timestamptz NOT NULL,
  first_look_ends_at timestamptz,
  subs_open_at timestamptz,

  awarded_to_type text CHECK (awarded_to_type IS NULL OR awarded_to_type IN ('technician', 'vendor', 'network')),
  awarded_technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  awarded_vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  awarded_label text,
  awarded_via text CHECK (awarded_via IS NULL OR awarded_via IN ('claim', 'bid', 'auto', 'override', 'network')),
  awarded_price_cents integer CHECK (awarded_price_cents IS NULL OR awarded_price_cents >= 0),
  awarded_at timestamptz,
  awarded_by uuid,
  override_reason text CHECK (override_reason IS NULL OR char_length(override_reason) <= 300),

  network_handoff_id uuid REFERENCES network_handoffs(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT job_board_posts_awarded_consistent
    CHECK (status <> 'awarded' OR (awarded_to_type IS NOT NULL AND awarded_at IS NOT NULL))
);

-- At most one live (open / escalated) post per job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_board_posts_live_job
  ON job_board_posts (job_id) WHERE status IN ('open', 'escalated');
CREATE INDEX IF NOT EXISTS idx_job_board_posts_user_status ON job_board_posts (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_board_posts_open_expiry ON job_board_posts (expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_job_board_posts_handoff ON job_board_posts (network_handoff_id) WHERE network_handoff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_board_posts_awarded_tech
  ON job_board_posts (awarded_technician_id, awarded_at DESC) WHERE status = 'awarded';
CREATE INDEX IF NOT EXISTS idx_job_board_posts_awarded_vendor
  ON job_board_posts (awarded_vendor_id, awarded_at DESC) WHERE status = 'awarded';

DROP TRIGGER IF EXISTS trg_job_board_posts_updated_at ON job_board_posts;
CREATE TRIGGER trg_job_board_posts_updated_at
  BEFORE UPDATE ON job_board_posts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
-- 4. Recipients (the broadcast list + fairness schedule)
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES job_board_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('technician', 'vendor')),
  technician_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE,
  label text NOT NULL,
  wave smallint NOT NULL DEFAULT 1 CHECK (wave IN (1, 2)),
  rank integer NOT NULL DEFAULT 0,
  fairness_awards integer NOT NULL DEFAULT 0,
  opens_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  declined_at timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_board_recipients_target CHECK (
    (recipient_type = 'technician' AND technician_id IS NOT NULL AND vendor_id IS NULL)
    OR (recipient_type = 'vendor' AND vendor_id IS NOT NULL AND technician_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jb_recipients_post_tech ON job_board_recipients (post_id, technician_id) WHERE technician_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jb_recipients_post_vendor ON job_board_recipients (post_id, vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jb_recipients_tech ON job_board_recipients (technician_id, created_at DESC) WHERE technician_id IS NOT NULL;

-- =====================================================================
-- 5. Bids
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES job_board_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  bidder_type text NOT NULL CHECK (bidder_type IN ('technician', 'vendor')),
  technician_id uuid REFERENCES team_members(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE,
  label text NOT NULL,
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_board_bids_target CHECK (
    (bidder_type = 'technician' AND technician_id IS NOT NULL AND vendor_id IS NULL)
    OR (bidder_type = 'vendor' AND vendor_id IS NOT NULL AND technician_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jb_bids_post_tech ON job_board_bids (post_id, technician_id) WHERE technician_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jb_bids_post_vendor ON job_board_bids (post_id, vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jb_bids_tech_active ON job_board_bids (technician_id) WHERE status = 'active' AND technician_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_job_board_bids_updated_at ON job_board_bids;
CREATE TRIGGER trg_job_board_bids_updated_at
  BEFORE UPDATE ON job_board_bids FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
-- 6. Vendor magic-link tokens (hash only; no client access at all)
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_vendor_tokens (
  post_id uuid NOT NULL REFERENCES job_board_posts(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (post_id, vendor_id)
);

-- =====================================================================
-- 7. Events (append-only audit trail)
-- =====================================================================
CREATE TABLE IF NOT EXISTS job_board_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES job_board_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  actor_user_id uuid DEFAULT auth.uid(),
  actor_label text,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jb_events_post ON job_board_events (post_id, created_at);

-- =====================================================================
-- 8. RLS — dispatcher-only reads, no direct writes
-- =====================================================================
ALTER TABLE job_board_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_board_vendor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_board_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_board_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_board_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_board_vendor_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_board_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dispatch_select_job_board_settings" ON job_board_settings;
CREATE POLICY "dispatch_select_job_board_settings" ON job_board_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_board());

DROP POLICY IF EXISTS "dispatch_select_job_board_vendor_profiles" ON job_board_vendor_profiles;
CREATE POLICY "dispatch_select_job_board_vendor_profiles" ON job_board_vendor_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_board());

DROP POLICY IF EXISTS "dispatch_select_job_board_posts" ON job_board_posts;
CREATE POLICY "dispatch_select_job_board_posts" ON job_board_posts FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_board());

DROP POLICY IF EXISTS "dispatch_select_job_board_recipients" ON job_board_recipients;
CREATE POLICY "dispatch_select_job_board_recipients" ON job_board_recipients FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_board());

DROP POLICY IF EXISTS "dispatch_select_job_board_bids" ON job_board_bids;
CREATE POLICY "dispatch_select_job_board_bids" ON job_board_bids FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_board());

DROP POLICY IF EXISTS "dispatch_select_job_board_events" ON job_board_events;
CREATE POLICY "dispatch_select_job_board_events" ON job_board_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_job_board());

-- job_board_vendor_tokens: RLS on, deliberately NO policy → unreadable by clients.
REVOKE ALL ON job_board_settings, job_board_vendor_profiles, job_board_posts, job_board_recipients,
  job_board_bids, job_board_vendor_tokens, job_board_events FROM anon, authenticated;
GRANT SELECT ON job_board_settings, job_board_vendor_profiles, job_board_posts, job_board_recipients,
  job_board_bids, job_board_events TO authenticated;

ALTER TABLE job_board_posts REPLICA IDENTITY FULL;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_board_posts;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE job_board_bids;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL;
END $$;

-- =====================================================================
-- 9. Internal helpers (not granted to clients)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.job_board_settings_for(p_owner uuid)
RETURNS job_board_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s job_board_settings;
BEGIN
  INSERT INTO job_board_settings (user_id) VALUES (p_owner) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO s FROM job_board_settings WHERE user_id = p_owner;
  RETURN s;
END;
$$;

-- The account's timezone if it is a real IANA zone, otherwise UTC.
CREATE OR REPLACE FUNCTION public.job_board_tz(p_owner uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT z.name FROM pg_timezone_names z
      WHERE z.name = (SELECT bp.timezone FROM business_profile bp WHERE bp.user_id = p_owner LIMIT 1)
      LIMIT 1),
    'UTC');
$$;

CREATE OR REPLACE FUNCTION public.job_board_event(p_post_id uuid, p_owner uuid, p_event text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO job_board_events (post_id, user_id, actor_label, event, detail)
  VALUES (
    p_post_id, p_owner,
    (SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email) FROM profiles p WHERE p.id = auth.uid()),
    p_event, COALESCE(p_detail, '{}'::jsonb));
$$;

-- Why can this technician NOT take this work? Empty array = eligible.
CREATE OR REPLACE FUNCTION public.job_board_tech_blockers(
  p_owner uuid, p_tech_id uuid, p_skill text, p_area_id uuid,
  p_starts_at timestamptz, p_duration_minutes integer, p_job_id uuid, p_tz text
) RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s job_board_settings;
  tm team_members;
  v_out text[] := '{}';
  v_day date;
  v_end timestamptz;
  v_cap integer;
BEGIN
  s := public.job_board_settings_for(p_owner);
  SELECT * INTO tm FROM team_members WHERE id = p_tech_id AND account_owner_id = p_owner;
  IF NOT FOUND OR tm.role <> 'technician' OR tm.invite_status <> 'active' OR NOT tm.dispatch_enabled THEN
    RETURN ARRAY['INACTIVE'];
  END IF;
  IF tm.user_id IS NULL THEN RETURN ARRAY['NO_LOGIN']; END IF;

  IF s.require_skill_match AND NULLIF(btrim(COALESCE(p_skill, '')), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unnest(tm.skills) x WHERE lower(btrim(x)) = lower(btrim(p_skill))) THEN
    v_out := array_append(v_out, 'SKILL'::text);
  END IF;

  IF s.require_zone_match AND p_area_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM service_area_technicians sat WHERE sat.area_id = p_area_id AND sat.technician_id = p_tech_id) THEN
    v_out := array_append(v_out, 'ZONE'::text);
  END IF;

  IF p_starts_at IS NOT NULL THEN
    v_day := (p_starts_at AT TIME ZONE p_tz)::date;
    v_end := p_starts_at + make_interval(mins => COALESCE(p_duration_minutes, 60));

    IF s.respect_time_off AND (
         EXISTS (SELECT 1 FROM technician_time_off o
                  WHERE o.technician_id = p_tech_id AND o.status = 'approved'
                    AND v_day BETWEEN o.start_date AND o.end_date)
         OR EXISTS (SELECT 1 FROM technician_availability a
                     WHERE a.technician_id = p_tech_id
                       AND NOT (EXTRACT(dow FROM (p_starts_at AT TIME ZONE p_tz))::smallint = ANY (a.working_days)))
       ) THEN
      v_out := array_append(v_out, 'TIME_OFF'::text);
    END IF;

    v_cap := COALESCE(NULLIF(tm.max_jobs_per_day, 0), 6);
    IF (SELECT count(*) FROM jobs j
         WHERE j.assigned_technician_id = p_tech_id
           AND j.user_id = p_owner
           AND j.id IS DISTINCT FROM p_job_id
           AND j.job_status NOT IN ('cancelled', 'no_show', 'completed')
           AND j.scheduled_datetime IS NOT NULL
           AND (j.scheduled_datetime AT TIME ZONE p_tz)::date = v_day) >= v_cap THEN
      v_out := array_append(v_out, 'CAPACITY'::text);
    END IF;

    IF s.block_schedule_conflicts AND EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.assigned_technician_id = p_tech_id
            AND j.user_id = p_owner
            AND j.id IS DISTINCT FROM p_job_id
            AND j.job_status NOT IN ('cancelled', 'no_show', 'completed')
            AND j.scheduled_datetime IS NOT NULL
            AND j.scheduled_datetime < v_end
            AND j.scheduled_datetime + make_interval(mins => COALESCE(j.duration_minutes, 60)) > p_starts_at) THEN
      v_out := array_append(v_out, 'CONFLICT'::text);
    END IF;
  END IF;

  RETURN v_out;
END;
$$;

-- Same question for a subcontractor (vendor). Empty array = eligible.
CREATE OR REPLACE FUNCTION public.job_board_vendor_blockers(
  p_owner uuid, p_vendor_id uuid, p_skill text, p_area_id uuid
) RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s job_board_settings;
  v vendors;
  vp job_board_vendor_profiles;
  v_out text[] := '{}';
BEGIN
  s := public.job_board_settings_for(p_owner);
  IF NOT s.allow_subcontractors THEN RETURN ARRAY['SUBS_DISABLED']; END IF;

  SELECT * INTO v FROM vendors WHERE id = p_vendor_id AND user_id = p_owner;
  IF NOT FOUND OR NOT v.active OR v.tier NOT IN ('strategic', 'preferred', 'approved') THEN
    RETURN ARRAY['NOT_APPROVED'];
  END IF;
  SELECT * INTO vp FROM job_board_vendor_profiles WHERE vendor_id = p_vendor_id AND user_id = p_owner;
  IF NOT FOUND OR NOT vp.enabled THEN RETURN ARRAY['NOT_ENROLLED']; END IF;

  IF s.require_skill_match AND NULLIF(btrim(COALESCE(p_skill, '')), '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unnest(vp.skills) x WHERE lower(btrim(x)) = lower(btrim(p_skill))) THEN
    v_out := array_append(v_out, 'SKILL'::text);
  END IF;

  IF s.require_zone_match AND p_area_id IS NOT NULL AND NOT (p_area_id = ANY (vp.area_ids)) THEN
    v_out := array_append(v_out, 'ZONE'::text);
  END IF;

  -- Every document type the vendor is required to hold must be verified and unexpired.
  IF s.require_sub_documents AND EXISTS (
       SELECT 1 FROM unnest(v.required_documents) AS rd(doc_type)
        WHERE NOT EXISTS (
          SELECT 1 FROM vendor_documents d
           WHERE d.vendor_id = v.id AND d.doc_type = rd.doc_type AND d.status = 'verified'
             AND (d.expires_on IS NULL OR d.expires_on >= current_date))) THEN
    v_out := array_append(v_out, 'DOCS'::text);
  END IF;

  RETURN v_out;
END;
$$;

-- The broadcast list for a (prospective) post, INCLUDING who is excluded and why.
-- Fairness: eligible technicians are ranked by fewest awards in the rolling window
-- (then longest since last award). The top first_look_size get an exclusive head start;
-- everyone else opens after first_look_minutes. Subcontractors open after
-- internal_first_minutes — immediately when nobody internal qualifies or the post is
-- subcontractor-only. Urgent posts skip every delay.
CREATE OR REPLACE FUNCTION public.job_board_build_audience(
  p_owner uuid, p_job_id uuid, p_skill text, p_area_id uuid, p_audience text,
  p_starts_at timestamptz, p_duration_minutes integer, p_priority text
) RETURNS TABLE (
  recipient_type text, technician_id uuid, vendor_id uuid, label text,
  wave smallint, rank integer, awards integer, opens_at timestamptz, blockers text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  s job_board_settings;
  v_now timestamptz := now();
  v_tz text;
  v_urgent boolean := (p_priority = 'urgent');
  v_first_look interval;
  v_exclusive boolean;
  v_sub_open timestamptz;
  v_tech_eligible integer := 0;
BEGIN
  s := public.job_board_settings_for(p_owner);
  v_tz := public.job_board_tz(p_owner);
  v_first_look := CASE WHEN v_urgent THEN interval '0' ELSE make_interval(mins => s.first_look_minutes) END;
  v_exclusive := v_first_look > interval '0';

  IF p_audience IN ('internal', 'both') THEN
    RETURN QUERY
    WITH t AS (
      SELECT tm.id AS tid,
             COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email) AS lbl,
             public.job_board_tech_blockers(p_owner, tm.id, p_skill, p_area_id, p_starts_at, p_duration_minutes, p_job_id, v_tz) AS blk
        FROM team_members tm
       WHERE tm.account_owner_id = p_owner AND tm.role = 'technician'
    ), a AS (
      SELECT t.*,
             (SELECT count(*) FROM job_board_posts p
               WHERE p.user_id = p_owner AND p.status = 'awarded' AND p.awarded_technician_id = t.tid
                 AND p.awarded_at >= v_now - make_interval(days => s.fairness_window_days))::integer AS aw,
             (SELECT max(p.awarded_at) FROM job_board_posts p
               WHERE p.user_id = p_owner AND p.status = 'awarded' AND p.awarded_technician_id = t.tid) AS last_aw
        FROM t
    ), r AS (
      SELECT a.*,
             CASE WHEN cardinality(a.blk) = 0
                  THEN (row_number() OVER (PARTITION BY (cardinality(a.blk) = 0) ORDER BY a.aw, a.last_aw NULLS FIRST, a.tid))::integer
             END AS rk
        FROM a
    )
    SELECT 'technician'::text, r.tid, NULL::uuid, r.lbl,
           (CASE WHEN r.rk IS NULL THEN 2
                 WHEN NOT v_exclusive OR r.rk <= s.first_look_size THEN 1 ELSE 2 END)::smallint,
           COALESCE(r.rk, 0), r.aw,
           CASE WHEN r.rk IS NOT NULL AND (NOT v_exclusive OR r.rk <= s.first_look_size) THEN v_now ELSE v_now + v_first_look END,
           r.blk
      FROM r
     ORDER BY (cardinality(r.blk) > 0), COALESCE(r.rk, 2147483647), r.lbl;

    SELECT count(*) INTO v_tech_eligible
      FROM team_members tm
     WHERE tm.account_owner_id = p_owner AND tm.role = 'technician'
       AND cardinality(public.job_board_tech_blockers(p_owner, tm.id, p_skill, p_area_id, p_starts_at, p_duration_minutes, p_job_id, v_tz)) = 0;
  END IF;

  IF p_audience IN ('subcontractors', 'both') AND s.allow_subcontractors THEN
    v_sub_open := CASE
      WHEN v_urgent OR p_audience = 'subcontractors' OR v_tech_eligible = 0 THEN v_now
      ELSE v_now + make_interval(mins => s.internal_first_minutes) END;

    RETURN QUERY
    WITH v AS (
      SELECT ve.id AS vid, ve.name AS lbl, public.job_board_vendor_blockers(p_owner, ve.id, p_skill, p_area_id) AS blk
        FROM vendors ve
        JOIN job_board_vendor_profiles vp ON vp.vendor_id = ve.id AND vp.enabled
       WHERE ve.user_id = p_owner
    ), a AS (
      SELECT v.*,
             (SELECT count(*) FROM job_board_posts p
               WHERE p.user_id = p_owner AND p.status = 'awarded' AND p.awarded_vendor_id = v.vid
                 AND p.awarded_at >= v_now - make_interval(days => s.fairness_window_days))::integer AS aw,
             (SELECT max(p.awarded_at) FROM job_board_posts p
               WHERE p.user_id = p_owner AND p.status = 'awarded' AND p.awarded_vendor_id = v.vid) AS last_aw
        FROM v
    ), r AS (
      SELECT a.*,
             CASE WHEN cardinality(a.blk) = 0
                  THEN (row_number() OVER (PARTITION BY (cardinality(a.blk) = 0) ORDER BY a.aw, a.last_aw NULLS FIRST, a.vid))::integer
             END AS rk
        FROM a
    )
    SELECT 'vendor'::text, NULL::uuid, r.vid, r.lbl, 2::smallint, COALESCE(r.rk, 0), r.aw, v_sub_open, r.blk
      FROM r
     ORDER BY (cardinality(r.blk) > 0), COALESCE(r.rk, 2147483647), r.lbl;
  END IF;
END;
$$;

-- Notify a team member (by team_members.id) if they have a login.
CREATE OR REPLACE FUNCTION public.job_board_notify_tech(p_tech_id uuid, p_title text, p_message text, p_url text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO notifications (user_id, type, title, message, action_url)
  SELECT tm.user_id, 'system', p_title, p_message, p_url
    FROM team_members tm WHERE tm.id = p_tech_id AND tm.user_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.job_board_notify_owner(p_owner uuid, p_title text, p_message text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO notifications (user_id, type, title, message, action_url)
  VALUES (p_owner, 'system', p_title, p_message, '/dashboard/job-board');
$$;

-- Applies an award. Caller has locked the post row and validated everything.
CREATE OR REPLACE FUNCTION public.job_board_apply_award(
  p_post_id uuid, p_type text, p_technician_id uuid, p_vendor_id uuid,
  p_price_cents integer, p_via text, p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r job_board_posts;
  v_label text;
BEGIN
  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id;

  IF p_type = 'technician' THEN
    SELECT COALESCE(NULLIF(btrim(member_name), ''), member_email) INTO v_label FROM team_members WHERE id = p_technician_id;
  ELSE
    SELECT name INTO v_label FROM vendors WHERE id = p_vendor_id;
  END IF;

  UPDATE job_board_posts
     SET status = 'awarded', awarded_to_type = p_type,
         awarded_technician_id = CASE WHEN p_type = 'technician' THEN p_technician_id END,
         awarded_vendor_id = CASE WHEN p_type = 'vendor' THEN p_vendor_id END,
         awarded_label = v_label, awarded_via = p_via, awarded_price_cents = p_price_cents,
         awarded_at = now(), awarded_by = auth.uid(), override_reason = p_reason
   WHERE id = p_post_id;

  UPDATE job_board_bids SET status = 'rejected'
   WHERE post_id = p_post_id AND status = 'active'
     AND NOT ((p_type = 'technician' AND technician_id = p_technician_id) OR (p_type = 'vendor' AND vendor_id = p_vendor_id));
  UPDATE job_board_bids SET status = 'accepted'
   WHERE post_id = p_post_id AND status = 'active'
     AND ((p_type = 'technician' AND technician_id = p_technician_id) OR (p_type = 'vendor' AND vendor_id = p_vendor_id));

  IF p_type = 'technician' THEN
    UPDATE jobs SET assigned_technician_id = p_technician_id, tags = array_remove(tags, 'subcontracted')
     WHERE id = r.job_id AND user_id = r.user_id;
    PERFORM public.job_board_notify_tech(p_technician_id, 'Shift assigned to you',
      '"' || r.title || '" is now on your schedule.', '/tech/today');
  ELSE
    UPDATE jobs SET assigned_technician_id = NULL,
           tags = CASE WHEN 'subcontracted' = ANY (tags) THEN tags ELSE array_append(tags, 'subcontracted') END
     WHERE id = r.job_id AND user_id = r.user_id;
  END IF;

  -- Tell the technicians who asked but did not get it.
  PERFORM public.job_board_notify_tech(b.technician_id, 'Shift filled',
           '"' || r.title || '" was assigned to someone else.', '/tech/job-board')
     FROM job_board_bids b
    WHERE b.post_id = p_post_id AND b.status = 'rejected' AND b.technician_id IS NOT NULL;

  PERFORM public.job_board_event(p_post_id, r.user_id,
    CASE WHEN p_via = 'override' THEN 'override_awarded' ELSE 'awarded' END,
    jsonb_build_object('to_type', p_type, 'to', v_label, 'via', p_via, 'price_cents', p_price_cents, 'reason', p_reason));
END;
$$;

-- =====================================================================
-- 10. Settings & subcontractor enrolment RPCs
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_job_board_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); s job_board_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  s := public.job_board_settings_for(v_owner);
  RETURN to_jsonb(s) - 'user_id';
END;
$$;

CREATE OR REPLACE FUNCTION public.save_job_board_settings(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.job_board_settings_for(v_owner);

  UPDATE job_board_settings SET
    default_expiry_minutes = COALESCE((p ->> 'default_expiry_minutes')::integer, default_expiry_minutes),
    first_look_minutes = COALESCE((p ->> 'first_look_minutes')::integer, first_look_minutes),
    first_look_size = COALESCE((p ->> 'first_look_size')::integer, first_look_size),
    internal_first_minutes = COALESCE((p ->> 'internal_first_minutes')::integer, internal_first_minutes),
    fairness_window_days = COALESCE((p ->> 'fairness_window_days')::integer, fairness_window_days),
    require_skill_match = COALESCE((p ->> 'require_skill_match')::boolean, require_skill_match),
    require_zone_match = COALESCE((p ->> 'require_zone_match')::boolean, require_zone_match),
    respect_time_off = COALESCE((p ->> 'respect_time_off')::boolean, respect_time_off),
    block_schedule_conflicts = COALESCE((p ->> 'block_schedule_conflicts')::boolean, block_schedule_conflicts),
    max_active_bids_per_technician = COALESCE((p ->> 'max_active_bids_per_technician')::integer, max_active_bids_per_technician),
    allow_subcontractors = COALESCE((p ->> 'allow_subcontractors')::boolean, allow_subcontractors),
    require_sub_documents = COALESCE((p ->> 'require_sub_documents')::boolean, require_sub_documents)
  WHERE user_id = v_owner;
EXCEPTION
  WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_INPUT';
END;
$$;

-- Vendors that could be subcontractors (approved tiers) with their board profile + compliance.
CREATE OR REPLACE FUNCTION public.get_job_board_vendors()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_res jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.name), '[]'::jsonb) INTO v_res
    FROM (
      SELECT ve.id, ve.name, ve.email, ve.phone, ve.category, ve.tier,
             COALESCE(vp.enabled, false) AS enabled,
             COALESCE(vp.skills, '{}') AS skills,
             COALESCE(vp.area_ids, '{}') AS area_ids,
             vp.notes,
             NOT EXISTS (
               SELECT 1 FROM unnest(ve.required_documents) AS rd(doc_type)
                WHERE NOT EXISTS (
                  SELECT 1 FROM vendor_documents d
                   WHERE d.vendor_id = ve.id AND d.doc_type = rd.doc_type AND d.status = 'verified'
                     AND (d.expires_on IS NULL OR d.expires_on >= current_date))) AS docs_ok
        FROM vendors ve
        LEFT JOIN job_board_vendor_profiles vp ON vp.vendor_id = ve.id
       WHERE ve.user_id = v_owner AND ve.active AND ve.tier IN ('strategic', 'preferred', 'approved')
    ) x;
  RETURN v_res;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_job_board_vendor_profile(
  p_vendor_id uuid, p_enabled boolean, p_skills text[], p_area_ids uuid[], p_notes text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_skills text[];
  v_areas uuid[];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = p_vendor_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT lower(btrim(x))) FILTER (WHERE btrim(x) <> ''), '{}')
    INTO v_skills FROM unnest(COALESCE(p_skills, '{}')) AS x;
  -- Keep only zones that really belong to this account.
  SELECT COALESCE(array_agg(a.id), '{}') INTO v_areas
    FROM service_areas a WHERE a.user_id = v_owner AND a.id = ANY (COALESCE(p_area_ids, '{}'));

  INSERT INTO job_board_vendor_profiles (vendor_id, user_id, enabled, skills, area_ids, notes)
  VALUES (p_vendor_id, v_owner, COALESCE(p_enabled, true), v_skills, v_areas, NULLIF(btrim(COALESCE(p_notes, '')), ''))
  ON CONFLICT (vendor_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, skills = EXCLUDED.skills, area_ids = EXCLUDED.area_ids, notes = EXCLUDED.notes;
EXCEPTION
  WHEN check_violation THEN RAISE EXCEPTION 'INVALID_INPUT';
END;
$$;

-- =====================================================================
-- 11. Audience preview & posting
-- =====================================================================
CREATE OR REPLACE FUNCTION public.preview_job_board_audience(
  p_job_id uuid, p_skill text, p_area_id uuid, p_audience text, p_priority text DEFAULT 'normal'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  j jobs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF COALESCE(p_audience, '') NOT IN ('internal', 'subcontractors', 'both')
     OR COALESCE(p_priority, 'normal') NOT IN ('normal', 'urgent') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  IF p_area_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_areas WHERE id = p_area_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'AREA_NOT_FOUND';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'recipient_type', a.recipient_type, 'technician_id', a.technician_id, 'vendor_id', a.vendor_id,
             'label', a.label, 'wave', a.wave, 'rank', a.rank, 'awards', a.awards,
             'opens_in_minutes', GREATEST(0, CEIL(EXTRACT(epoch FROM (a.opens_at - now())) / 60))::integer,
             'blockers', a.blockers)), '[]'::jsonb)
      FROM public.job_board_build_audience(v_owner, p_job_id, p_skill, p_area_id, p_audience,
             j.scheduled_datetime, j.duration_minutes, COALESCE(p_priority, 'normal')) a
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.post_job_board_job(
  p_job_id uuid,
  p_source text,
  p_audience text,
  p_claim_mode text,
  p_priority text,
  p_skill text,
  p_area_id uuid,
  p_title text,
  p_summary text,
  p_location_label text,
  p_offer_cents integer,
  p_max_bid_cents integer,
  p_expires_minutes integer,
  p_auto_award boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s job_board_settings;
  j jobs;
  v_id uuid;
  v_title text := btrim(COALESCE(p_title, ''));
  v_summary text := NULLIF(btrim(COALESCE(p_summary, '')), '');
  v_label text := NULLIF(btrim(COALESCE(p_location_label, '')), '');
  v_skill text := NULLIF(btrim(COALESCE(p_skill, '')), '');
  v_exp timestamptz;
  v_minutes integer;
  v_urgent boolean := COALESCE(p_priority, 'normal') = 'urgent';
  v_first_open timestamptz;
  v_sub_open timestamptz;
  v_n_tech integer;
  v_n_vendor integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  s := public.job_board_settings_for(v_owner);

  IF COALESCE(p_source, '') NOT IN ('unassigned', 'overflow', 'reassign')
     OR COALESCE(p_audience, '') NOT IN ('internal', 'subcontractors', 'both')
     OR COALESCE(p_claim_mode, '') NOT IN ('first_come', 'bidding')
     OR COALESCE(p_priority, 'normal') NOT IN ('normal', 'urgent')
     OR char_length(v_title) NOT BETWEEN 3 AND 120
     OR char_length(COALESCE(v_summary, '')) > 1000
     OR char_length(COALESCE(v_label, '')) > 80
     OR char_length(COALESCE(v_skill, '')) > 60
     OR COALESCE(p_offer_cents, 0) < 0 OR COALESCE(p_max_bid_cents, 0) < 0
     OR (p_expires_minutes IS NOT NULL AND p_expires_minutes NOT BETWEEN 5 AND 10080) THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  IF p_audience = 'subcontractors' AND NOT s.allow_subcontractors THEN RAISE EXCEPTION 'SUBS_DISABLED'; END IF;
  IF public.network_text_has_contact_info(v_title) OR public.network_text_has_contact_info(v_summary)
     OR public.network_text_has_contact_info(v_label) THEN
    RAISE EXCEPTION 'PII_IN_PUBLIC_FIELDS';
  END IF;

  SELECT * INTO j FROM jobs WHERE id = p_job_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  IF j.job_status IN ('completed', 'cancelled', 'no_show', 'en_route', 'in_progress') THEN
    RAISE EXCEPTION 'JOB_NOT_POSTABLE';
  END IF;
  IF p_source = 'unassigned' AND j.assigned_technician_id IS NOT NULL THEN RAISE EXCEPTION 'JOB_ALREADY_ASSIGNED'; END IF;
  IF EXISTS (SELECT 1 FROM job_board_posts WHERE job_id = p_job_id AND status IN ('open', 'escalated')) THEN
    RAISE EXCEPTION 'ALREADY_POSTED';
  END IF;
  IF p_area_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_areas WHERE id = p_area_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'AREA_NOT_FOUND';
  END IF;
  IF (SELECT count(*) FROM job_board_posts WHERE user_id = v_owner AND status = 'open') >= 50 THEN
    RAISE EXCEPTION 'TOO_MANY_OPEN';
  END IF;

  v_minutes := COALESCE(p_expires_minutes, s.default_expiry_minutes);
  v_exp := now() + make_interval(mins => v_minutes);
  IF j.scheduled_datetime IS NOT NULL THEN v_exp := LEAST(v_exp, j.scheduled_datetime); END IF;
  IF v_exp < now() + interval '5 minutes' THEN RAISE EXCEPTION 'EXPIRY_TOO_SOON'; END IF;

  INSERT INTO job_board_posts (
    user_id, job_id, source, audience, claim_mode, priority, skill, area_id, title, summary, location_label,
    starts_at, duration_minutes, offer_cents, max_bid_cents, auto_award, expires_at
  ) VALUES (
    v_owner, p_job_id, p_source, p_audience, p_claim_mode, COALESCE(p_priority, 'normal'), v_skill, p_area_id,
    v_title, v_summary, v_label, j.scheduled_datetime, j.duration_minutes, p_offer_cents, p_max_bid_cents,
    COALESCE(p_auto_award, false) AND p_claim_mode = 'bidding', v_exp
  ) RETURNING id INTO v_id;

  INSERT INTO job_board_recipients (post_id, user_id, recipient_type, technician_id, vendor_id, label, wave, rank, fairness_awards, opens_at)
  SELECT v_id, v_owner, a.recipient_type, a.technician_id, a.vendor_id, a.label, a.wave, a.rank, a.awards, a.opens_at
    FROM public.job_board_build_audience(v_owner, p_job_id, v_skill, p_area_id, p_audience,
           j.scheduled_datetime, j.duration_minutes, COALESCE(p_priority, 'normal')) a
   WHERE cardinality(a.blockers) = 0;

  SELECT count(*) FILTER (WHERE recipient_type = 'technician'), count(*) FILTER (WHERE recipient_type = 'vendor')
    INTO v_n_tech, v_n_vendor FROM job_board_recipients WHERE post_id = v_id;
  IF v_n_tech + v_n_vendor = 0 THEN RAISE EXCEPTION 'NO_ELIGIBLE_RECIPIENTS'; END IF;

  SELECT min(opens_at) FILTER (WHERE recipient_type = 'technician' AND wave = 2),
         min(opens_at) FILTER (WHERE recipient_type = 'vendor')
    INTO v_first_open, v_sub_open FROM job_board_recipients WHERE post_id = v_id;
  UPDATE job_board_posts SET first_look_ends_at = v_first_open, subs_open_at = v_sub_open WHERE id = v_id;

  PERFORM public.job_board_notify_tech(r.technician_id,
    CASE WHEN v_urgent THEN 'Urgent open shift' ELSE 'Open shift available' END,
    CASE WHEN r.opens_at <= now() THEN '"' || v_title || '" is open — claim it before it expires.'
         ELSE '"' || v_title || '" opens for you in ' || CEIL(EXTRACT(epoch FROM (r.opens_at - now())) / 60)::integer || ' min.' END,
    '/tech/job-board')
    FROM job_board_recipients r WHERE r.post_id = v_id AND r.recipient_type = 'technician';
  UPDATE job_board_recipients SET notified_at = now() WHERE post_id = v_id AND recipient_type = 'technician';

  PERFORM public.job_board_event(v_id, v_owner, 'posted',
    jsonb_build_object('source', p_source, 'audience', p_audience, 'claim_mode', p_claim_mode,
                       'technicians', v_n_tech, 'vendors', v_n_vendor, 'expires_at', v_exp));
  RETURN v_id;
END;
$$;

-- =====================================================================
-- 12. Technician actions
-- =====================================================================
-- Safe, technician-facing read: no vendor prices, no other bidders, no customer PII.
CREATE OR REPLACE FUNCTION public.get_my_job_board_offers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tm uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'NOT_A_TECHNICIAN'; END IF;

  RETURN jsonb_build_object(
    'server_now', now(),
    'offers', COALESCE((
      SELECT jsonb_agg(o ORDER BY (o ->> 'sort_key'), o ->> 'expires_at')
        FROM (
          SELECT jsonb_build_object(
            'post_id', p.id, 'title', p.title, 'summary', p.summary, 'location_label', p.location_label,
            'skill', p.skill, 'starts_at', p.starts_at, 'duration_minutes', p.duration_minutes,
            'offer_cents', p.offer_cents, 'priority', p.priority, 'claim_mode', p.claim_mode,
            'status', p.status, 'expires_at', p.expires_at, 'opens_at', r.opens_at, 'wave', r.wave,
            'declined', r.declined_at IS NOT NULL,
            'my_bid_status', (SELECT b.status FROM job_board_bids b WHERE b.post_id = p.id AND b.technician_id = v_tm),
            'awarded_to_me', (p.status = 'awarded' AND p.awarded_technician_id = v_tm),
            'sort_key', CASE WHEN p.status = 'open' THEN '0' ELSE '1' END
          ) AS o
            FROM job_board_recipients r
            JOIN job_board_posts p ON p.id = r.post_id
           WHERE r.technician_id = v_tm AND p.user_id = v_owner
             AND (p.status = 'open' OR p.created_at > now() - interval '14 days')
           ORDER BY p.created_at DESC
           LIMIT 100
        ) q
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_job_board_post(p_post_id uuid, p_note text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tm uuid := public.get_my_team_member_id();
  s job_board_settings;
  r job_board_posts;
  rec job_board_recipients;
  v_blockers text[];
  v_label text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'NOT_A_TECHNICIAN'; END IF;
  s := public.job_board_settings_for(v_owner);

  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' OR r.expires_at <= now() THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;

  SELECT * INTO rec FROM job_board_recipients WHERE post_id = p_post_id AND technician_id = v_tm;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_ELIGIBLE'; END IF;
  IF rec.opens_at > now() THEN RAISE EXCEPTION 'NOT_OPEN_YET'; END IF;

  v_blockers := public.job_board_tech_blockers(v_owner, v_tm, r.skill, r.area_id, r.starts_at,
                  r.duration_minutes, r.job_id, public.job_board_tz(v_owner));
  IF cardinality(v_blockers) > 0 THEN RAISE EXCEPTION 'NOT_ELIGIBLE:%', array_to_string(v_blockers, ','); END IF;

  SELECT COALESCE(NULLIF(btrim(member_name), ''), member_email) INTO v_label FROM team_members WHERE id = v_tm;
  UPDATE job_board_recipients SET declined_at = NULL, decline_reason = NULL WHERE id = rec.id;

  IF r.claim_mode = 'first_come' THEN
    PERFORM public.job_board_apply_award(p_post_id, 'technician', v_tm, NULL, r.offer_cents, 'claim', NULL);
    PERFORM public.job_board_notify_owner(v_owner, 'Shift claimed', v_label || ' claimed "' || r.title || '".');
    RETURN 'awarded';
  END IF;

  IF (SELECT count(*) FROM job_board_bids WHERE technician_id = v_tm AND status = 'active' AND post_id <> p_post_id)
       >= s.max_active_bids_per_technician THEN
    RAISE EXCEPTION 'TOO_MANY_BIDS';
  END IF;

  INSERT INTO job_board_bids (post_id, user_id, bidder_type, technician_id, label, note, status)
  VALUES (p_post_id, v_owner, 'technician', v_tm, v_label, LEFT(NULLIF(btrim(COALESCE(p_note, '')), ''), 300), 'active')
  ON CONFLICT (post_id, technician_id) WHERE technician_id IS NOT NULL
  DO UPDATE SET status = 'active', note = EXCLUDED.note;

  PERFORM public.job_board_event(p_post_id, v_owner, 'bid', jsonb_build_object('by', v_label, 'type', 'technician'));
  PERFORM public.job_board_notify_owner(v_owner, 'New shift request', v_label || ' requested "' || r.title || '".');
  RETURN 'bid';
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_job_board_post(p_post_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_tm uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'NOT_A_TECHNICIAN'; END IF;
  UPDATE job_board_recipients
     SET declined_at = now(), decline_reason = LEFT(NULLIF(btrim(COALESCE(p_reason, '')), ''), 200)
   WHERE post_id = p_post_id AND technician_id = v_tm AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_ELIGIBLE'; END IF;
  UPDATE job_board_bids SET status = 'withdrawn'
   WHERE post_id = p_post_id AND technician_id = v_tm AND status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_job_board_bid(p_post_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); v_tm uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'NOT_A_TECHNICIAN'; END IF;
  UPDATE job_board_bids SET status = 'withdrawn'
   WHERE post_id = p_post_id AND technician_id = v_tm AND user_id = v_owner AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'BID_NOT_FOUND'; END IF;
END;
$$;

-- =====================================================================
-- 13. Dispatcher actions
-- =====================================================================
-- Award from a bid, or — with p_override — straight to any technician / vendor,
-- bypassing eligibility, windows and price caps (a reason is mandatory and audited).
CREATE OR REPLACE FUNCTION public.award_job_board_post(
  p_post_id uuid,
  p_bid_id uuid DEFAULT NULL,
  p_technician_id uuid DEFAULT NULL,
  p_vendor_id uuid DEFAULT NULL,
  p_price_cents integer DEFAULT NULL,
  p_override boolean DEFAULT false,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r job_board_posts;
  b job_board_bids;
  h network_handoffs;
  v_type text;
  v_tech uuid;
  v_vendor uuid;
  v_price integer;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_blockers text[];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF COALESCE(p_price_cents, 0) < 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;

  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;

  IF COALESCE(p_override, false) THEN
    IF r.status NOT IN ('open', 'expired', 'escalated') THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;
    IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 300 THEN
      RAISE EXCEPTION 'OVERRIDE_REASON_REQUIRED';
    END IF;
    IF (p_technician_id IS NULL) = (p_vendor_id IS NULL) THEN RAISE EXCEPTION 'TARGET_REQUIRED'; END IF;
    v_tech := p_technician_id; v_vendor := p_vendor_id;
    v_type := CASE WHEN v_tech IS NOT NULL THEN 'technician' ELSE 'vendor' END;
    IF v_tech IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM team_members WHERE id = v_tech AND account_owner_id = v_owner AND role = 'technician') THEN
      RAISE EXCEPTION 'TARGET_REQUIRED';
    END IF;
    IF v_vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vendors WHERE id = v_vendor AND user_id = v_owner) THEN
      RAISE EXCEPTION 'VENDOR_NOT_FOUND';
    END IF;
    v_price := p_price_cents;
  ELSE
    IF r.status <> 'open' THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;
    IF p_bid_id IS NULL THEN RAISE EXCEPTION 'BID_NOT_FOUND'; END IF;
    SELECT * INTO b FROM job_board_bids WHERE id = p_bid_id AND post_id = p_post_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION 'BID_NOT_FOUND'; END IF;
    v_type := b.bidder_type; v_tech := b.technician_id; v_vendor := b.vendor_id;
    v_price := COALESCE(p_price_cents, b.price_cents, r.offer_cents);
    IF v_type = 'vendor' AND r.max_bid_cents IS NOT NULL AND COALESCE(v_price, 0) > r.max_bid_cents THEN
      RAISE EXCEPTION 'PRICE_ABOVE_MAX';
    END IF;
    v_blockers := CASE WHEN v_type = 'technician'
      THEN public.job_board_tech_blockers(v_owner, v_tech, r.skill, r.area_id, r.starts_at, r.duration_minutes, r.job_id, public.job_board_tz(v_owner))
      ELSE public.job_board_vendor_blockers(v_owner, v_vendor, r.skill, r.area_id) END;
    IF cardinality(v_blockers) > 0 THEN RAISE EXCEPTION 'NOT_ELIGIBLE:%', array_to_string(v_blockers, ','); END IF;
  END IF;

  -- Overriding an escalated post pulls the handoff back (unless a contractor already took it).
  IF r.status = 'escalated' AND r.network_handoff_id IS NOT NULL THEN
    SELECT * INTO h FROM network_handoffs WHERE id = r.network_handoff_id FOR UPDATE;
    IF FOUND AND h.status = 'claimed' THEN RAISE EXCEPTION 'NETWORK_ALREADY_CLAIMED'; END IF;
    UPDATE job_board_posts SET status = 'open' WHERE id = p_post_id;   -- detach first: the sync trigger then ignores the cancel
    IF FOUND AND h.status = 'open' THEN PERFORM public.cancel_network_handoff(h.id); END IF;
  END IF;

  PERFORM public.job_board_apply_award(p_post_id, v_type, v_tech, v_vendor, v_price,
            CASE WHEN COALESCE(p_override, false) THEN 'override' ELSE 'bid' END, v_reason);
END;
$$;

-- Re-open an expired / awarded / escalated post (tech dropped out, nobody bid, handoff failed...).
CREATE OR REPLACE FUNCTION public.reopen_job_board_post(p_post_id uuid, p_minutes integer DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s job_board_settings;
  r job_board_posts;
  h network_handoffs;
  v_exp timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_minutes IS NOT NULL AND p_minutes NOT BETWEEN 5 AND 10080 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  s := public.job_board_settings_for(v_owner);

  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR r.status IN ('cancelled') THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;

  v_exp := now() + make_interval(mins => COALESCE(p_minutes, s.default_expiry_minutes));
  IF r.starts_at IS NOT NULL THEN v_exp := LEAST(v_exp, r.starts_at); END IF;
  IF v_exp < now() + interval '5 minutes' THEN RAISE EXCEPTION 'EXPIRY_TOO_SOON'; END IF;
  IF r.status <> 'open' AND EXISTS (
       SELECT 1 FROM job_board_posts WHERE job_id = r.job_id AND status IN ('open', 'escalated') AND id <> r.id) THEN
    RAISE EXCEPTION 'ALREADY_POSTED';
  END IF;

  IF r.status = 'escalated' AND r.network_handoff_id IS NOT NULL THEN
    SELECT * INTO h FROM network_handoffs WHERE id = r.network_handoff_id FOR UPDATE;
    IF FOUND AND h.status = 'claimed' THEN RAISE EXCEPTION 'NETWORK_ALREADY_CLAIMED'; END IF;
    UPDATE job_board_posts SET status = 'open' WHERE id = p_post_id;   -- detach first (see award)
    IF FOUND AND h.status = 'open' THEN PERFORM public.cancel_network_handoff(h.id); END IF;
  ELSIF r.status = 'awarded' THEN
    -- Undo the assignment and take the previous winner out of this round.
    IF r.awarded_to_type = 'technician' THEN
      UPDATE jobs SET assigned_technician_id = NULL WHERE id = r.job_id AND user_id = v_owner AND assigned_technician_id = r.awarded_technician_id;
      UPDATE job_board_recipients SET declined_at = now(), decline_reason = 'Released by dispatcher'
       WHERE post_id = r.id AND technician_id = r.awarded_technician_id;
    ELSIF r.awarded_to_type = 'vendor' THEN
      UPDATE jobs SET tags = array_remove(tags, 'subcontracted') WHERE id = r.job_id AND user_id = v_owner;
      UPDATE job_board_recipients SET declined_at = now(), decline_reason = 'Released by dispatcher'
       WHERE post_id = r.id AND vendor_id = r.awarded_vendor_id;
    ELSIF r.awarded_to_type = 'network' AND r.network_handoff_id IS NOT NULL THEN
      RAISE EXCEPTION 'NETWORK_ALREADY_CLAIMED';
    END IF;
  END IF;

  IF r.status = 'open' THEN
    UPDATE job_board_posts SET expires_at = v_exp WHERE id = p_post_id;          -- plain extension: keep bids and windows
  ELSE
    UPDATE job_board_bids SET status = 'withdrawn' WHERE post_id = p_post_id AND status IN ('active', 'accepted', 'rejected');
    UPDATE job_board_posts
       SET status = 'open', expires_at = v_exp, awarded_to_type = NULL, awarded_technician_id = NULL,
           awarded_vendor_id = NULL, awarded_label = NULL, awarded_via = NULL, awarded_price_cents = NULL,
           awarded_at = NULL, awarded_by = NULL, override_reason = NULL, network_handoff_id = NULL,
           first_look_ends_at = NULL, subs_open_at = NULL
     WHERE id = p_post_id;
    -- Everyone who has not declined may act right away on a re-opened post.
    UPDATE job_board_recipients SET opens_at = now() WHERE post_id = p_post_id AND opens_at > now();
  END IF;

  PERFORM public.job_board_event(p_post_id, v_owner, 'reopened', jsonb_build_object('expires_at', v_exp, 'from', r.status));
  PERFORM public.job_board_notify_tech(rc.technician_id, 'Open shift available',
            '"' || r.title || '" is open again.', '/tech/job-board')
     FROM job_board_recipients rc
    WHERE rc.post_id = p_post_id AND rc.technician_id IS NOT NULL AND rc.declined_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_job_board_post(p_post_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r job_board_posts;
  h network_handoffs;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN ('open', 'escalated', 'expired') THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;

  UPDATE job_board_posts SET status = 'cancelled' WHERE id = p_post_id;   -- first, so the sync trigger ignores the cancel below
  UPDATE job_board_bids SET status = 'withdrawn' WHERE post_id = p_post_id AND status = 'active';
  IF r.status = 'escalated' AND r.network_handoff_id IS NOT NULL THEN
    SELECT * INTO h FROM network_handoffs WHERE id = r.network_handoff_id FOR UPDATE;
    IF FOUND AND h.status = 'claimed' THEN RAISE EXCEPTION 'NETWORK_ALREADY_CLAIMED'; END IF;
    IF FOUND AND h.status = 'open' THEN PERFORM public.cancel_network_handoff(h.id); END IF;
  END IF;
  PERFORM public.job_board_event(p_post_id, v_owner, 'cancelled');
END;
$$;

-- Expires stale posts for the caller's account; auto-awards bidding posts that opted in.
-- Idempotent: the UI calls it on load, exactly like expire_network_handoffs().
CREATE OR REPLACE FUNCTION public.expire_job_board_posts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r job_board_posts;
  b record;
  v_count integer := 0;
  v_awarded boolean;
  v_blockers text[];
  v_tz text;
  s job_board_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  v_tz := public.job_board_tz(v_owner);
  s := public.job_board_settings_for(v_owner);

  FOR r IN
    SELECT * FROM job_board_posts
     WHERE user_id = v_owner AND status = 'open' AND expires_at <= now()
     ORDER BY expires_at FOR UPDATE SKIP LOCKED
  LOOP
    v_awarded := false;
    IF r.auto_award AND r.claim_mode = 'bidding' THEN
      -- Internal bids first (fewest recent awards wins), then subcontractors by lowest price.
      FOR b IN
        SELECT bd.* FROM job_board_bids bd
         WHERE bd.post_id = r.id AND bd.status = 'active'
         ORDER BY (bd.bidder_type = 'technician') DESC,
                  (SELECT count(*) FROM job_board_posts p
                    WHERE p.status = 'awarded' AND p.awarded_technician_id = bd.technician_id
                      AND p.awarded_at >= now() - make_interval(days => s.fairness_window_days)),
                  bd.price_cents NULLS LAST, bd.created_at
      LOOP
        v_blockers := CASE WHEN b.bidder_type = 'technician'
          THEN public.job_board_tech_blockers(v_owner, b.technician_id, r.skill, r.area_id, r.starts_at, r.duration_minutes, r.job_id, v_tz)
          ELSE public.job_board_vendor_blockers(v_owner, b.vendor_id, r.skill, r.area_id) END;
        IF cardinality(v_blockers) = 0
           AND NOT (b.bidder_type = 'vendor' AND r.max_bid_cents IS NOT NULL AND COALESCE(b.price_cents, 0) > r.max_bid_cents) THEN
          PERFORM public.job_board_apply_award(r.id, b.bidder_type, b.technician_id, b.vendor_id,
                    COALESCE(b.price_cents, r.offer_cents), 'auto', NULL);
          v_awarded := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF NOT v_awarded THEN
      UPDATE job_board_posts SET status = 'expired' WHERE id = r.id;
      UPDATE job_board_bids SET status = 'withdrawn' WHERE post_id = r.id AND status = 'active';
      PERFORM public.job_board_event(r.id, v_owner, 'expired');
      PERFORM public.job_board_notify_owner(v_owner, 'Open shift expired',
        '"' || r.title || '" expired unclaimed. Re-open it, assign it directly or send it to the Contractor Network.');
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- =====================================================================
-- 14. Subcontract handoff integration (existing Contractor Network)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.escalate_job_board_post_to_network(
  p_post_id uuid, p_trade text, p_referral_fee_pct numeric DEFAULT 10,
  p_notes text DEFAULT NULL, p_smart_match boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r job_board_posts;
  j jobs;
  v_handoff uuid;
  v_value integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;
  IF r.status NOT IN ('open', 'expired') THEN RAISE EXCEPTION 'NOT_ESCALATABLE'; END IF;
  IF r.status = 'expired' AND EXISTS (
       SELECT 1 FROM job_board_posts WHERE job_id = r.job_id AND status IN ('open', 'escalated') AND id <> r.id) THEN
    RAISE EXCEPTION 'ALREADY_POSTED';
  END IF;
  SELECT * INTO j FROM jobs WHERE id = r.job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;

  v_value := COALESCE(round(j.invoice_amount * 100)::integer, r.offer_cents);

  -- Customer details travel only through the handoff's private contact block (never the public card).
  v_handoff := public.post_network_handoff(
    CASE WHEN r.priority = 'urgent' THEN 'emergency' ELSE 'capacity_overflow' END,
    p_trade, r.title, r.summary, r.location_label,
    CASE WHEN r.starts_at >= now() + interval '16 minutes' THEN r.starts_at ELSE NULL END,
    v_value, COALESCE(p_referral_fee_pct, 10),
    j.customer_name, j.customer_phone, j.address, p_notes, COALESCE(p_smart_match, false));

  UPDATE job_board_posts SET status = 'escalated', network_handoff_id = v_handoff WHERE id = p_post_id;
  UPDATE job_board_bids SET status = 'withdrawn' WHERE post_id = p_post_id AND status = 'active';
  PERFORM public.job_board_event(p_post_id, v_owner, 'escalated', jsonb_build_object('handoff_id', v_handoff));
  RETURN v_handoff;
END;
$$;

-- Keeps an escalated post in step with its handoff (claimed / released / completed / cancelled / expired).
CREATE OR REPLACE FUNCTION public.job_board_sync_network_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r job_board_posts;
BEGIN
  SELECT * INTO r FROM job_board_posts
   WHERE network_handoff_id = NEW.id AND (status = 'escalated' OR (status = 'awarded' AND awarded_to_type = 'network'))
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.status = 'claimed' AND r.status = 'escalated' THEN
    UPDATE job_board_posts
       SET status = 'awarded', awarded_to_type = 'network', awarded_via = 'network',
           awarded_label = COALESCE(NEW.claimed_by_name, 'Network contractor'), awarded_at = COALESCE(NEW.claimed_at, now())
     WHERE id = r.id;
    PERFORM public.job_board_event(r.id, r.user_id, 'network_claimed', jsonb_build_object('by', NEW.claimed_by_name));
    PERFORM public.job_board_notify_owner(r.user_id, 'Network contractor accepted',
      COALESCE(NEW.claimed_by_name, 'A contractor') || ' accepted "' || r.title || '".');
  ELSIF NEW.status = 'open' AND r.status = 'awarded' THEN              -- the contractor released it
    UPDATE job_board_posts
       SET status = 'escalated', awarded_to_type = NULL, awarded_via = NULL, awarded_label = NULL, awarded_at = NULL
     WHERE id = r.id;
    PERFORM public.job_board_event(r.id, r.user_id, 'network_released');
  ELSIF NEW.status = 'completed' AND r.status = 'awarded' THEN
    UPDATE job_board_posts SET awarded_price_cents = COALESCE(NEW.final_amount_cents, awarded_price_cents) WHERE id = r.id;
    PERFORM public.job_board_event(r.id, r.user_id, 'network_completed', jsonb_build_object('final_amount_cents', NEW.final_amount_cents));
  ELSIF NEW.status IN ('cancelled', 'expired') AND r.status = 'escalated' THEN
    UPDATE job_board_posts SET status = 'expired', network_handoff_id = NULL WHERE id = r.id;
    PERFORM public.job_board_event(r.id, r.user_id, 'network_' || NEW.status);
    PERFORM public.job_board_notify_owner(r.user_id, 'Network handoff ended',
      '"' || r.title || '" was not taken by the network. Re-open it or assign it directly.');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_board_sync_network_handoff ON network_handoffs;
CREATE TRIGGER trg_job_board_sync_network_handoff
  AFTER UPDATE OF status ON network_handoffs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.job_board_sync_network_handoff();

-- =====================================================================
-- 15. Subcontractor magic link (public, token-secured)
-- =====================================================================
-- Rotates and returns a fresh raw token (shown once). Only the SHA-256 is stored.
CREATE OR REPLACE FUNCTION public.issue_job_board_vendor_link(p_post_id uuid, p_vendor_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  r job_board_posts;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT * INTO r FROM job_board_posts WHERE id = p_post_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM job_board_recipients WHERE post_id = p_post_id AND vendor_id = p_vendor_id) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  INSERT INTO job_board_vendor_tokens (post_id, vendor_id, token_hash, expires_at)
  VALUES (p_post_id, p_vendor_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), GREATEST(r.expires_at, now()) + interval '7 days')
  ON CONFLICT (post_id, vendor_id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash, issued_at = now(), expires_at = EXCLUDED.expires_at;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_job_board_offer(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  t job_board_vendor_tokens;
  r job_board_posts;
  rec job_board_recipients;
  bd job_board_bids;
  v_company text;
  v_state text;
BEGIN
  IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 32 AND 128 THEN RETURN jsonb_build_object('state', 'invalid'); END IF;
  SELECT * INTO t FROM job_board_vendor_tokens
   WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') AND expires_at > now();
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'invalid'); END IF;

  SELECT * INTO r FROM job_board_posts WHERE id = t.post_id;
  SELECT * INTO rec FROM job_board_recipients WHERE post_id = t.post_id AND vendor_id = t.vendor_id;
  SELECT * INTO bd FROM job_board_bids WHERE post_id = t.post_id AND vendor_id = t.vendor_id;
  SELECT COALESCE(NULLIF(btrim(company_name), ''), 'Contractor') INTO v_company FROM profiles WHERE id = r.user_id;

  v_state := CASE
    WHEN r.status = 'awarded' AND r.awarded_vendor_id = t.vendor_id THEN 'won'
    WHEN r.status IN ('awarded', 'escalated') THEN 'filled'
    WHEN r.status IN ('cancelled', 'expired') OR r.expires_at <= now() THEN 'closed'
    WHEN rec.declined_at IS NOT NULL THEN 'declined'
    WHEN rec.opens_at > now() THEN 'not_yet_open'
    WHEN bd.status = 'active' THEN 'bid_submitted'
    ELSE 'open' END;

  RETURN jsonb_build_object(
    'state', v_state, 'server_now', now(), 'company', v_company,
    'vendor', (SELECT name FROM vendors WHERE id = t.vendor_id),
    'post', jsonb_build_object(
      'title', r.title, 'summary', r.summary, 'location_label', r.location_label, 'skill', r.skill,
      'starts_at', r.starts_at, 'duration_minutes', r.duration_minutes, 'offer_cents', r.offer_cents,
      'priority', r.priority, 'expires_at', r.expires_at, 'opens_at', rec.opens_at),
    'my_bid', CASE WHEN bd.id IS NULL THEN NULL
                   ELSE jsonb_build_object('price_cents', bd.price_cents, 'note', bd.note, 'status', bd.status) END);
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_job_board_offer(
  p_token text, p_action text, p_price_cents integer DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  t job_board_vendor_tokens;
  r job_board_posts;
  rec job_board_recipients;
  v_blockers text[];
  v_name text;
BEGIN
  IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 32 AND 128 THEN RAISE EXCEPTION 'INVALID_TOKEN'; END IF;
  IF COALESCE(p_action, '') NOT IN ('bid', 'decline', 'withdraw') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT * INTO t FROM job_board_vendor_tokens
   WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_TOKEN'; END IF;

  SELECT * INTO r FROM job_board_posts WHERE id = t.post_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' OR r.expires_at <= now() THEN RAISE EXCEPTION 'POST_UNAVAILABLE'; END IF;
  SELECT * INTO rec FROM job_board_recipients WHERE post_id = t.post_id AND vendor_id = t.vendor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_ELIGIBLE'; END IF;
  SELECT name INTO v_name FROM vendors WHERE id = t.vendor_id;

  IF p_action = 'decline' THEN
    UPDATE job_board_recipients SET declined_at = now(), decline_reason = LEFT(NULLIF(btrim(COALESCE(p_note, '')), ''), 200) WHERE id = rec.id;
    UPDATE job_board_bids SET status = 'withdrawn' WHERE post_id = t.post_id AND vendor_id = t.vendor_id AND status = 'active';
    PERFORM public.job_board_event(r.id, r.user_id, 'vendor_declined', jsonb_build_object('vendor', v_name));
    RETURN public.get_job_board_offer(p_token);
  END IF;

  IF p_action = 'withdraw' THEN
    UPDATE job_board_bids SET status = 'withdrawn' WHERE post_id = t.post_id AND vendor_id = t.vendor_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION 'BID_NOT_FOUND'; END IF;
    RETURN public.get_job_board_offer(p_token);
  END IF;

  -- bid
  IF rec.opens_at > now() THEN RAISE EXCEPTION 'NOT_OPEN_YET'; END IF;
  IF p_price_cents IS NULL OR p_price_cents <= 0 OR p_price_cents > 2000000000 THEN RAISE EXCEPTION 'PRICE_REQUIRED'; END IF;
  IF r.max_bid_cents IS NOT NULL AND p_price_cents > r.max_bid_cents THEN RAISE EXCEPTION 'PRICE_ABOVE_MAX'; END IF;
  v_blockers := public.job_board_vendor_blockers(r.user_id, t.vendor_id, r.skill, r.area_id);
  IF cardinality(v_blockers) > 0 THEN RAISE EXCEPTION 'NOT_ELIGIBLE:%', array_to_string(v_blockers, ','); END IF;

  UPDATE job_board_recipients SET declined_at = NULL, decline_reason = NULL WHERE id = rec.id;
  INSERT INTO job_board_bids (post_id, user_id, bidder_type, vendor_id, label, price_cents, note, status)
  VALUES (t.post_id, r.user_id, 'vendor', t.vendor_id, v_name, p_price_cents,
          LEFT(NULLIF(btrim(COALESCE(p_note, '')), ''), 300), 'active')
  ON CONFLICT (post_id, vendor_id) WHERE vendor_id IS NOT NULL
  DO UPDATE SET status = 'active', price_cents = EXCLUDED.price_cents, note = EXCLUDED.note;

  PERFORM public.job_board_event(r.id, r.user_id, 'bid', jsonb_build_object('by', v_name, 'type', 'vendor', 'price_cents', p_price_cents));
  PERFORM public.job_board_notify_owner(r.user_id, 'New subcontractor bid', v_name || ' bid on "' || r.title || '".');
  RETURN public.get_job_board_offer(p_token);
END;
$$;

-- =====================================================================
-- 16. Dispatcher insight: summary + fairness ledger
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_job_board_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object(
    'open_posts', (SELECT count(*) FROM job_board_posts WHERE user_id = v_owner AND status = 'open'),
    'awaiting_award', (SELECT count(DISTINCT p.id) FROM job_board_posts p JOIN job_board_bids b ON b.post_id = p.id AND b.status = 'active'
                        WHERE p.user_id = v_owner AND p.status = 'open'),
    'escalated', (SELECT count(*) FROM job_board_posts WHERE user_id = v_owner AND status = 'escalated'),
    'awarded_7d', (SELECT count(*) FROM job_board_posts WHERE user_id = v_owner AND status = 'awarded' AND awarded_at > now() - interval '7 days'),
    'expired_7d', (SELECT count(*) FROM job_board_posts WHERE user_id = v_owner AND status = 'expired' AND updated_at > now() - interval '7 days'),
    'avg_minutes_to_award', (SELECT round(avg(EXTRACT(epoch FROM (awarded_at - created_at)) / 60))::integer
                               FROM job_board_posts WHERE user_id = v_owner AND status = 'awarded' AND awarded_via <> 'network'
                                AND awarded_at > now() - interval '30 days')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_job_board_fairness()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id(); s job_board_settings;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT public.can_manage_job_board() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  s := public.job_board_settings_for(v_owner);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'technician_id', tm.id,
             'name', COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
             'awards', (SELECT count(*) FROM job_board_posts p WHERE p.user_id = v_owner AND p.status = 'awarded'
                          AND p.awarded_technician_id = tm.id AND p.awarded_at >= now() - make_interval(days => s.fairness_window_days)),
             'last_awarded_at', (SELECT max(p.awarded_at) FROM job_board_posts p WHERE p.user_id = v_owner AND p.status = 'awarded' AND p.awarded_technician_id = tm.id),
             'open_offers', (SELECT count(*) FROM job_board_recipients r JOIN job_board_posts p ON p.id = r.post_id
                              WHERE r.technician_id = tm.id AND p.status = 'open' AND r.declined_at IS NULL)
           ) ORDER BY COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email))
      FROM team_members tm
     WHERE tm.account_owner_id = v_owner AND tm.role = 'technician' AND tm.invite_status = 'active'
  ), '[]'::jsonb);
END;
$$;

-- =====================================================================
-- 17. Grants — internal helpers are never callable by clients
-- =====================================================================
REVOKE ALL ON FUNCTION
  public.can_manage_job_board(),
  public.job_board_settings_for(uuid),
  public.job_board_tz(uuid),
  public.job_board_event(uuid, uuid, text, jsonb),
  public.job_board_tech_blockers(uuid, uuid, text, uuid, timestamptz, integer, uuid, text),
  public.job_board_vendor_blockers(uuid, uuid, text, uuid),
  public.job_board_build_audience(uuid, uuid, text, uuid, text, timestamptz, integer, text),
  public.job_board_notify_tech(uuid, text, text, text),
  public.job_board_notify_owner(uuid, text, text),
  public.job_board_apply_award(uuid, text, uuid, uuid, integer, text, text),
  public.job_board_sync_network_handoff(),
  public.get_job_board_settings(),
  public.save_job_board_settings(jsonb),
  public.get_job_board_vendors(),
  public.save_job_board_vendor_profile(uuid, boolean, text[], uuid[], text),
  public.preview_job_board_audience(uuid, text, uuid, text, text),
  public.post_job_board_job(uuid, text, text, text, text, text, uuid, text, text, text, integer, integer, integer, boolean),
  public.get_my_job_board_offers(),
  public.claim_job_board_post(uuid, text),
  public.decline_job_board_post(uuid, text),
  public.withdraw_job_board_bid(uuid),
  public.award_job_board_post(uuid, uuid, uuid, uuid, integer, boolean, text),
  public.reopen_job_board_post(uuid, integer),
  public.cancel_job_board_post(uuid),
  public.expire_job_board_posts(),
  public.escalate_job_board_post_to_network(uuid, text, numeric, text, boolean),
  public.issue_job_board_vendor_link(uuid, uuid),
  public.get_job_board_offer(text),
  public.respond_job_board_offer(text, text, integer, text),
  public.get_job_board_summary(),
  public.get_job_board_fairness()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.can_manage_job_board(),
  public.get_job_board_settings(),
  public.save_job_board_settings(jsonb),
  public.get_job_board_vendors(),
  public.save_job_board_vendor_profile(uuid, boolean, text[], uuid[], text),
  public.preview_job_board_audience(uuid, text, uuid, text, text),
  public.post_job_board_job(uuid, text, text, text, text, text, uuid, text, text, text, integer, integer, integer, boolean),
  public.get_my_job_board_offers(),
  public.claim_job_board_post(uuid, text),
  public.decline_job_board_post(uuid, text),
  public.withdraw_job_board_bid(uuid),
  public.award_job_board_post(uuid, uuid, uuid, uuid, integer, boolean, text),
  public.reopen_job_board_post(uuid, integer),
  public.cancel_job_board_post(uuid),
  public.expire_job_board_posts(),
  public.escalate_job_board_post_to_network(uuid, text, numeric, text, boolean),
  public.issue_job_board_vendor_link(uuid, uuid),
  public.get_job_board_summary(),
  public.get_job_board_fairness()
TO authenticated;

-- The subcontractor page has no account: token-gated, PII-free, callable anonymously.
GRANT EXECUTE ON FUNCTION
  public.get_job_board_offer(text),
  public.respond_job_board_offer(text, text, integer, text)
TO anon, authenticated;

COMMENT ON TABLE job_board_posts IS
  'A job broadcast to eligible technicians / approved subcontractors. Dispatcher-only reads; writes via RPC only.';
COMMENT ON TABLE job_board_recipients IS
  'Broadcast list with the fairness schedule: opens_at encodes first-look rotation and internal-first for subcontractors.';
COMMENT ON TABLE job_board_vendor_tokens IS
  'SHA-256 of subcontractor magic-link tokens. RLS enabled with no policy: unreadable by clients.';
