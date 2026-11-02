/*
  # Access requests + broken-link reports

  ## access_requests
  A team member who opens a page they are not allowed to use can ask the account
  owner (or anyone who may edit the business profile) for access. One PENDING request
  per (requester, path). Reviewers resolve it from Team settings.

  Security model
    - Scoped to the account: account_owner_id = get_account_owner_id() (forced by trigger).
    - A requester can insert/read ONLY their own requests; they can never change status.
    - Only reviewers (owner without team row, or team member with can_edit_business_profile)
      can read the account's requests and resolve them.

  ## broken_link_reports
  Anonymous visitors can report a dead link through a SECURITY DEFINER RPC only:
    - no table privileges for anon/authenticated, the RPC is the single write path
    - it stores a path + a per-day counter, NO user data (no IP, no user agent)
    - bounded: at most 500 distinct (path, day) rows per day, paths <= 300 chars
  Only platform staff (profiles.is_staff) can read them.

  Purely additive. Safe to re-run.
*/

-- =============================================================
-- 0. REVIEWER HELPER
-- =============================================================
CREATE OR REPLACE FUNCTION public.access_requests_can_review()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (
      EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM team_members t
      LEFT JOIN custom_roles cr ON cr.id = t.custom_role_id
      WHERE t.user_id = auth.uid()
        AND COALESCE(
              (cr.permissions ->> 'can_edit_business_profile')::boolean,
              (t.permissions ->> 'can_edit_business_profile')::boolean,
              false
            )
    );
$$;

REVOKE ALL ON FUNCTION public.access_requests_can_review() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.access_requests_can_review() TO authenticated;

-- =============================================================
-- 1. access_requests
-- =============================================================
CREATE TABLE IF NOT EXISTS public.access_requests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid        NOT NULL DEFAULT public.get_account_owner_id(),
  requester_id     uuid        NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  requester_name   text        CHECK (requester_name IS NULL OR char_length(requester_name) <= 120),
  area             text        NOT NULL CHECK (char_length(area) BETWEEN 1 AND 64),
  path             text        NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300 AND path LIKE '/%'),
  message          text        CHECK (message IS NULL OR char_length(message) <= 500),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_pending
  ON public.access_requests (requester_id, path) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS access_requests_account_status
  ON public.access_requests (account_owner_id, status, created_at DESC);

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

-- Force the sensitive columns server-side, whatever the client sends.
CREATE OR REPLACE FUNCTION public.access_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.requester_id := auth.uid();
    NEW.account_owner_id := public.get_account_owner_id();
    NEW.status := 'pending';
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
  ELSE
    -- Updates are for reviewers resolving a request: nothing but the status may change.
    NEW.id := OLD.id;
    NEW.account_owner_id := OLD.account_owner_id;
    NEW.requester_id := OLD.requester_id;
    NEW.requester_name := OLD.requester_name;
    NEW.area := OLD.area;
    NEW.path := OLD.path;
    NEW.message := OLD.message;
    NEW.created_at := OLD.created_at;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.resolved_at := now();
      NEW.resolved_by := auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_access_requests_guard ON public.access_requests;
CREATE TRIGGER trg_access_requests_guard
  BEFORE INSERT OR UPDATE ON public.access_requests
  FOR EACH ROW EXECUTE FUNCTION public.access_requests_guard();

DROP POLICY IF EXISTS "access_requests_select" ON public.access_requests;
CREATE POLICY "access_requests_select" ON public.access_requests
  FOR SELECT TO authenticated
  USING (
    requester_id = (SELECT auth.uid())
    OR (account_owner_id = public.get_account_owner_id() AND public.access_requests_can_review())
  );

DROP POLICY IF EXISTS "access_requests_insert" ON public.access_requests;
CREATE POLICY "access_requests_insert" ON public.access_requests
  FOR INSERT TO authenticated
  WITH CHECK (requester_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "access_requests_update" ON public.access_requests;
CREATE POLICY "access_requests_update" ON public.access_requests
  FOR UPDATE TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.access_requests_can_review())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.access_requests_can_review());

GRANT SELECT, INSERT, UPDATE ON public.access_requests TO authenticated;

-- =============================================================
-- 2. broken_link_reports
-- =============================================================
CREATE TABLE IF NOT EXISTS public.broken_link_reports (
  path        text        NOT NULL CHECK (char_length(path) BETWEEN 1 AND 300 AND path LIKE '/%'),
  report_day  date        NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  referrer    text        CHECK (referrer IS NULL OR char_length(referrer) <= 300),
  hits        integer     NOT NULL DEFAULT 1 CHECK (hits BETWEEN 1 AND 100000),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (path, report_day)
);

ALTER TABLE public.broken_link_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "broken_link_reports_staff_read" ON public.broken_link_reports;
CREATE POLICY "broken_link_reports_staff_read" ON public.broken_link_reports
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_staff));

REVOKE ALL ON public.broken_link_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.broken_link_reports TO authenticated;

CREATE OR REPLACE FUNCTION public.report_broken_link(p_path text, p_referrer text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_path text := left(split_part(coalesce(p_path, ''), '#', 1), 300);
  v_ref  text := nullif(left(coalesce(p_referrer, ''), 300), '');
  v_day  date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  IF v_path NOT LIKE '/%' THEN
    RETURN;
  END IF;
  -- Bounded: an attacker cannot grow the table by inventing paths.
  IF NOT EXISTS (SELECT 1 FROM broken_link_reports WHERE path = v_path AND report_day = v_day)
     AND (SELECT count(*) FROM broken_link_reports WHERE report_day = v_day) >= 500 THEN
    RETURN;
  END IF;
  INSERT INTO broken_link_reports (path, report_day, referrer)
  VALUES (v_path, v_day, v_ref)
  ON CONFLICT (path, report_day)
  DO UPDATE SET hits = LEAST(broken_link_reports.hits + 1, 100000), last_seen = now();
END;
$$;

REVOKE ALL ON FUNCTION public.report_broken_link(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_broken_link(text, text) TO anon, authenticated;

-- Rollback (manual):
--   DROP TABLE public.access_requests; DROP TABLE public.broken_link_reports;
--   DROP FUNCTION public.report_broken_link(text, text); DROP FUNCTION public.access_requests_guard();
--   DROP FUNCTION public.access_requests_can_review();
