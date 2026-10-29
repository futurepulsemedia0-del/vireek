/*
  # Local rank tracking (geo-grid) — /dashboard/geo-grid

  ## Why
  Shows where a business appears in Google Maps results for a keyword from a grid of points around it
  (3x3 .. 9x9), re-scanned on a schedule so the owner can see local visibility improve or slip.

  ## Model (every row scoped to the account owner: user_id = get_account_owner_id())
    geo_grid_locations — a tracked business (Google place id + coordinates). Archived, never deleted.
    geo_grid_keywords  — a keyword tracked for a location: grid size, radius, schedule.
    geo_grid_scans     — one run (status, aggregates). Written ONLY by the geo-grid-scan edge function.
    geo_grid_points    — one row per grid cell of a scan (rank, outcome, top competitors). Same writer.

  ## Security
  - RLS: every member of the account can read; only owners / members with can_edit_business_profile can
    create or edit locations and keywords. No DELETE policy anywhere: items are archived.
  - Guard triggers pin ownership, the place id / coordinates, scheduling fields and archive timestamps, so a
    client can never forge them. Scheduling fields change only through the service-role functions below.
  - begin / finish / defer / due / usage functions are service_role only (execute revoked from anon and
    authenticated). The edge function checks the caller's permission first (geo_grid_context()).
  - Cost control: the edge function passes a monthly point budget to geo_grid_begin_scan(), which enforces it.
*/

-- =============================================================
-- Permission helper (owner, else team flag, custom role overrides — mirrors the UI)
-- =============================================================

CREATE OR REPLACE FUNCTION public.geo_grid_can_manage()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.user_id = auth.uid()
        AND COALESCE(
          CASE WHEN cr.permissions ? 'can_edit_business_profile'
               THEN (cr.permissions -> 'can_edit_business_profile') = 'true'::jsonb END,
          (tm.permissions -> 'can_edit_business_profile') = 'true'::jsonb,
          false
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.geo_grid_context()
RETURNS TABLE (account_owner_id uuid, can_manage boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_account_owner_id(), public.geo_grid_can_manage();
$$;

-- =============================================================
-- GEO_GRID_LOCATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS geo_grid_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  business_name text NOT NULL CHECK (char_length(btrim(business_name)) BETWEEN 1 AND 160),
  google_place_id text NOT NULL CHECK (char_length(google_place_id) BETWEEN 10 AND 300 AND google_place_id !~ '\s'),
  address text CHECK (address IS NULL OR char_length(address) <= 300),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -85 AND 85),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  archived_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_grid_locations_place
  ON geo_grid_locations (user_id, google_place_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_geo_grid_locations_account
  ON geo_grid_locations (user_id, created_at);

ALTER TABLE geo_grid_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_geo_grid_locations" ON geo_grid_locations;
CREATE POLICY "select_account_geo_grid_locations" ON geo_grid_locations FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_geo_grid_locations" ON geo_grid_locations;
CREATE POLICY "insert_account_geo_grid_locations" ON geo_grid_locations FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND public.geo_grid_can_manage()
  );

DROP POLICY IF EXISTS "update_account_geo_grid_locations" ON geo_grid_locations;
CREATE POLICY "update_account_geo_grid_locations" ON geo_grid_locations FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.geo_grid_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.geo_grid_can_manage());

-- No DELETE policy on purpose: archive instead.

CREATE OR REPLACE FUNCTION public.guard_geo_grid_location()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.business_name := btrim(NEW.business_name);
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    NEW.archived_at := NULL;
    SELECT count(*) INTO v_count FROM geo_grid_locations WHERE user_id = NEW.user_id AND archived_at IS NULL;
    IF v_count >= 25 THEN
      RAISE EXCEPTION 'You can track up to 25 locations. Archive one to add another.' USING ERRCODE = '53400';
    END IF;
    RETURN NEW;
  END IF;

  -- Identity of the tracked place never changes: archive it and add the right one instead.
  NEW.user_id := OLD.user_id;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.google_place_id := OLD.google_place_id;
  NEW.latitude := OLD.latitude;
  NEW.longitude := OLD.longitude;
  NEW.archived_at := CASE WHEN NEW.archived_at IS NULL THEN NULL ELSE COALESCE(OLD.archived_at, now()) END;

  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    -- Archiving a location archives its keywords too (they cannot be scanned without it).
    UPDATE geo_grid_keywords SET archived_at = now() WHERE location_id = NEW.id AND archived_at IS NULL;
  ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    SELECT count(*) INTO v_count FROM geo_grid_locations WHERE user_id = NEW.user_id AND archived_at IS NULL AND id <> NEW.id;
    IF v_count >= 25 THEN
      RAISE EXCEPTION 'You can track up to 25 locations. Archive one to restore another.' USING ERRCODE = '53400';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_geo_grid_location ON geo_grid_locations;
CREATE TRIGGER trg_guard_geo_grid_location
  BEFORE INSERT OR UPDATE ON geo_grid_locations
  FOR EACH ROW EXECUTE FUNCTION public.guard_geo_grid_location();

-- =============================================================
-- GEO_GRID_KEYWORDS
-- =============================================================

CREATE TABLE IF NOT EXISTS geo_grid_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES geo_grid_locations(id) ON DELETE CASCADE,
  keyword text NOT NULL CHECK (char_length(btrim(keyword)) BETWEEN 2 AND 120),
  grid_size smallint NOT NULL DEFAULT 5 CHECK (grid_size IN (3, 5, 7, 9)),
  radius_m integer NOT NULL DEFAULT 8047 CHECK (radius_m BETWEEN 800 AND 40234),
  schedule text NOT NULL DEFAULT 'manual' CHECK (schedule IN ('manual', 'weekly', 'monthly')),
  next_run_at timestamptz,
  last_scan_at timestamptz,
  archived_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_grid_keywords_active
  ON geo_grid_keywords (location_id, lower(btrim(keyword)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_geo_grid_keywords_account
  ON geo_grid_keywords (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_geo_grid_keywords_due
  ON geo_grid_keywords (next_run_at)
  WHERE archived_at IS NULL AND schedule <> 'manual';

ALTER TABLE geo_grid_keywords ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_geo_grid_keywords" ON geo_grid_keywords;
CREATE POLICY "select_account_geo_grid_keywords" ON geo_grid_keywords FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_account_geo_grid_keywords" ON geo_grid_keywords;
CREATE POLICY "insert_account_geo_grid_keywords" ON geo_grid_keywords FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND public.geo_grid_can_manage()
  );

DROP POLICY IF EXISTS "update_account_geo_grid_keywords" ON geo_grid_keywords;
CREATE POLICY "update_account_geo_grid_keywords" ON geo_grid_keywords FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.geo_grid_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.geo_grid_can_manage());

-- No DELETE policy on purpose: archive instead.

CREATE OR REPLACE FUNCTION public.guard_geo_grid_keyword()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rpc boolean := COALESCE(current_setting('vireek.geo_grid_rpc', true), '') = 'on';
  v_count integer;
  v_activating boolean;
BEGIN
  NEW.keyword := btrim(regexp_replace(NEW.keyword, '\s+', ' ', 'g'));
  NEW.updated_at := now();

  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.location_id := OLD.location_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;

  IF NOT v_rpc THEN
    NEW.archived_at := CASE
      WHEN NEW.archived_at IS NULL THEN NULL
      WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.archived_at, now())
      ELSE NULL
    END;
    IF TG_OP = 'INSERT' THEN
      NEW.last_scan_at := NULL;
      NEW.next_run_at := NULL;
    ELSE
      NEW.last_scan_at := OLD.last_scan_at;
      NEW.next_run_at := OLD.next_run_at;
    END IF;
  END IF;

  IF NEW.archived_at IS NOT NULL THEN
    v_activating := false;
  ELSIF TG_OP = 'INSERT' THEN
    v_activating := true;
  ELSE
    v_activating := OLD.archived_at IS NOT NULL;
  END IF;
  IF v_activating THEN
    IF NOT EXISTS (
      SELECT 1 FROM geo_grid_locations l
      WHERE l.id = NEW.location_id AND l.user_id = NEW.user_id AND l.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Choose an active location for this keyword.' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_count FROM geo_grid_keywords
      WHERE user_id = NEW.user_id AND archived_at IS NULL AND id <> NEW.id;
    IF v_count >= 50 THEN
      RAISE EXCEPTION 'You can track up to 50 keywords. Archive one to add another.' USING ERRCODE = '53400';
    END IF;
  END IF;

  IF NOT v_rpc THEN
    IF NEW.archived_at IS NOT NULL OR NEW.schedule = 'manual' THEN
      NEW.next_run_at := NULL;
    ELSIF NEW.next_run_at IS NULL THEN
      NEW.next_run_at := now() + CASE NEW.schedule WHEN 'weekly' THEN interval '7 days' ELSE interval '30 days' END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_geo_grid_keyword ON geo_grid_keywords;
CREATE TRIGGER trg_guard_geo_grid_keyword
  BEFORE INSERT OR UPDATE ON geo_grid_keywords
  FOR EACH ROW EXECUTE FUNCTION public.guard_geo_grid_keyword();

-- =============================================================
-- GEO_GRID_SCANS (service-role writes only)
-- =============================================================

CREATE TABLE IF NOT EXISTS geo_grid_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  keyword_id uuid NOT NULL REFERENCES geo_grid_keywords(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES geo_grid_locations(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  triggered_by text NOT NULL CHECK (triggered_by IN ('manual', 'schedule')),
  grid_size smallint NOT NULL CHECK (grid_size IN (3, 5, 7, 9)),
  radius_m integer NOT NULL CHECK (radius_m > 0),
  center_lat double precision NOT NULL,
  center_lng double precision NOT NULL,
  point_count integer NOT NULL CHECK (point_count > 0),
  checked_count integer NOT NULL DEFAULT 0,
  ranked_count integer NOT NULL DEFAULT 0,
  top3_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  avg_rank numeric(4, 1),
  solv numeric(5, 1),
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  created_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_geo_grid_scans_keyword
  ON geo_grid_scans (user_id, keyword_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_geo_grid_scans_account
  ON geo_grid_scans (user_id, started_at DESC);

-- At most one running scan per keyword (stops double-clicks and cron/manual overlap).
CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_grid_scans_running
  ON geo_grid_scans (keyword_id)
  WHERE status = 'running';

ALTER TABLE geo_grid_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_geo_grid_scans" ON geo_grid_scans;
CREATE POLICY "select_account_geo_grid_scans" ON geo_grid_scans FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE: only the geo-grid-scan function (service role) writes.

-- =============================================================
-- GEO_GRID_POINTS (service-role writes only)
-- =============================================================

CREATE TABLE IF NOT EXISTS geo_grid_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scan_id uuid NOT NULL REFERENCES geo_grid_scans(id) ON DELETE CASCADE,
  row_idx smallint NOT NULL CHECK (row_idx BETWEEN 0 AND 8),
  col_idx smallint NOT NULL CHECK (col_idx BETWEEN 0 AND 8),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ranked', 'not_found', 'error')),
  rank smallint CHECK (rank IS NULL OR rank BETWEEN 1 AND 20),
  competitors jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(competitors) = 'array' AND jsonb_array_length(competitors) <= 3),
  CONSTRAINT geo_grid_points_rank_matches_outcome CHECK ((outcome = 'ranked') = (rank IS NOT NULL)),
  CONSTRAINT uq_geo_grid_points_cell UNIQUE (scan_id, row_idx, col_idx)
);

CREATE INDEX IF NOT EXISTS idx_geo_grid_points_account
  ON geo_grid_points (user_id, scan_id);

ALTER TABLE geo_grid_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_account_geo_grid_points" ON geo_grid_points;
CREATE POLICY "select_account_geo_grid_points" ON geo_grid_points FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No client INSERT/UPDATE/DELETE: only the geo-grid-scan function (service role) writes.

-- =============================================================
-- Service-role functions (called by the geo-grid-scan edge function only)
-- =============================================================

-- Points billed this calendar month (UTC): running scans count in full, finished scans by what was really checked.
CREATE OR REPLACE FUNCTION public.geo_grid_month_usage(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(sum(CASE WHEN s.status = 'running' THEN s.point_count ELSE s.checked_count + s.error_count END), 0)::integer
  FROM geo_grid_scans s
  WHERE s.user_id = p_user_id
    AND s.started_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
$$;

-- Validates, enforces the monthly budget and opens a 'running' scan. Returns what the scanner needs as jsonb.
CREATE OR REPLACE FUNCTION public.geo_grid_begin_scan(
  p_user_id uuid,
  p_keyword_id uuid,
  p_triggered_by text,
  p_created_by uuid,
  p_monthly_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kw geo_grid_keywords;
  v_loc geo_grid_locations;
  v_points integer;
  v_used integer;
  v_limit integer := GREATEST(COALESCE(p_monthly_limit, 0), 0);
  v_scan_id uuid;
BEGIN
  IF p_triggered_by NOT IN ('manual', 'schedule') THEN
    RAISE EXCEPTION 'Unknown trigger.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_kw FROM geo_grid_keywords
    WHERE id = p_keyword_id AND user_id = p_user_id AND archived_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Keyword not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_loc FROM geo_grid_locations
    WHERE id = v_kw.location_id AND user_id = p_user_id AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The location for this keyword is archived.' USING ERRCODE = '55000';
  END IF;

  -- Scans abandoned by a crashed run must not block the keyword forever.
  UPDATE geo_grid_scans
    SET status = 'failed', error = 'The scan did not finish in time.', completed_at = now()
    WHERE keyword_id = v_kw.id AND status = 'running' AND started_at < now() - interval '10 minutes';

  v_points := v_kw.grid_size * v_kw.grid_size;
  v_used := public.geo_grid_month_usage(p_user_id);
  IF v_limit > 0 AND v_used + v_points > v_limit THEN
    RAISE EXCEPTION 'Monthly scan budget reached (% of % points used). It resets on the 1st.', v_used, v_limit
      USING ERRCODE = '53400';
  END IF;

  BEGIN
    INSERT INTO geo_grid_scans (
      user_id, keyword_id, location_id, keyword, triggered_by, grid_size, radius_m,
      center_lat, center_lng, point_count, created_by
    ) VALUES (
      p_user_id, v_kw.id, v_loc.id, v_kw.keyword, p_triggered_by, v_kw.grid_size, v_kw.radius_m,
      v_loc.latitude, v_loc.longitude, v_points, p_created_by
    ) RETURNING id INTO v_scan_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A scan for this keyword is already running.' USING ERRCODE = '55000';
  END;

  RETURN jsonb_build_object(
    'scan_id', v_scan_id,
    'keyword', v_kw.keyword,
    'grid_size', v_kw.grid_size,
    'radius_m', v_kw.radius_m,
    'center_lat', v_loc.latitude,
    'center_lng', v_loc.longitude,
    'place_id', v_loc.google_place_id,
    'business_name', v_loc.business_name,
    'point_count', v_points
  );
END;
$$;

-- Closes a scan: computes the aggregates from the stored points (the database is the authority) and moves the
-- keyword's schedule forward. Idempotent: a scan that is no longer running is returned unchanged.
CREATE OR REPLACE FUNCTION public.geo_grid_finish_scan(
  p_scan_id uuid,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS geo_grid_scans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scan geo_grid_scans;
  v_status text := p_status;
  v_error text := NULLIF(btrim(COALESCE(p_error, '')), '');
  v_checked integer;
  v_ranked integer;
  v_top3 integer;
  v_errors integer;
  v_avg numeric;
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Unknown status.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_scan FROM geo_grid_scans WHERE id = p_scan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Scan not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_scan.status <> 'running' THEN
    RETURN v_scan;
  END IF;

  SELECT
    count(*) FILTER (WHERE outcome IN ('ranked', 'not_found')),
    count(*) FILTER (WHERE outcome = 'ranked'),
    count(*) FILTER (WHERE outcome = 'ranked' AND rank <= 3),
    count(*) FILTER (WHERE outcome = 'error'),
    avg(rank) FILTER (WHERE outcome = 'ranked')
  INTO v_checked, v_ranked, v_top3, v_errors, v_avg
  FROM geo_grid_points
  WHERE scan_id = p_scan_id;

  IF v_status = 'completed' AND v_checked = 0 THEN
    v_status := 'failed';
    v_error := COALESCE(v_error, 'No grid points could be checked.');
  END IF;

  UPDATE geo_grid_scans SET
    status = v_status,
    checked_count = v_checked,
    ranked_count = v_ranked,
    top3_count = v_top3,
    error_count = v_errors,
    avg_rank = CASE WHEN v_ranked > 0 THEN round(v_avg, 1) END,
    solv = CASE WHEN v_checked > 0 THEN round(100.0 * v_top3 / v_checked, 1) END,
    error = left(v_error, 500),
    completed_at = now()
  WHERE id = p_scan_id
  RETURNING * INTO v_scan;

  PERFORM set_config('vireek.geo_grid_rpc', 'on', true);
  UPDATE geo_grid_keywords SET
    last_scan_at = CASE WHEN v_status = 'completed' THEN now() ELSE last_scan_at END,
    next_run_at = CASE
      WHEN archived_at IS NOT NULL OR schedule = 'manual' THEN NULL
      WHEN v_status = 'failed' THEN now() + interval '6 hours'
      WHEN schedule = 'weekly' THEN now() + interval '7 days'
      ELSE now() + interval '30 days'
    END
  WHERE id = v_scan.keyword_id;
  PERFORM set_config('vireek.geo_grid_rpc', 'off', true);

  RETURN v_scan;
END;
$$;

-- Pushes a scheduled keyword's next run forward (e.g. the account is over budget) so it cannot hog the queue.
CREATE OR REPLACE FUNCTION public.geo_grid_defer_keyword(p_keyword_id uuid, p_hours integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('vireek.geo_grid_rpc', 'on', true);
  UPDATE geo_grid_keywords
    SET next_run_at = now() + make_interval(hours => LEAST(GREATEST(COALESCE(p_hours, 24), 1), 168))
    WHERE id = p_keyword_id AND archived_at IS NULL AND schedule <> 'manual';
  PERFORM set_config('vireek.geo_grid_rpc', 'off', true);
END;
$$;

-- Scheduled keywords that are due, oldest first.
CREATE OR REPLACE FUNCTION public.geo_grid_due_keywords(p_limit integer DEFAULT 3)
RETURNS TABLE (due_user_id uuid, due_keyword_id uuid, due_created_by uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT k.user_id, k.id, k.created_by
  FROM geo_grid_keywords k
  JOIN geo_grid_locations l ON l.id = k.location_id AND l.archived_at IS NULL
  WHERE k.archived_at IS NULL
    AND k.schedule <> 'manual'
    AND k.next_run_at IS NOT NULL
    AND k.next_run_at <= now()
    AND NOT EXISTS (SELECT 1 FROM geo_grid_scans s WHERE s.keyword_id = k.id AND s.status = 'running')
  ORDER BY k.next_run_at ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 3), 1), 20);
$$;

-- =============================================================
-- Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.geo_grid_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.geo_grid_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.geo_grid_can_manage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.geo_grid_context() TO authenticated;

REVOKE ALL ON FUNCTION public.geo_grid_month_usage(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_grid_begin_scan(uuid, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_grid_finish_scan(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_grid_defer_keyword(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_grid_due_keywords(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geo_grid_month_usage(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_grid_begin_scan(uuid, uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_grid_finish_scan(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_grid_defer_keyword(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_grid_due_keywords(integer) TO service_role;

COMMENT ON TABLE geo_grid_locations IS
  'Businesses tracked for local rank (Google place id + coordinates). Archived, never deleted; identity fields are immutable.';
COMMENT ON TABLE geo_grid_keywords IS
  'Keyword per location with grid size, radius and schedule. Scheduling fields change only through the service-role functions.';
COMMENT ON TABLE geo_grid_scans IS
  'One geo-grid run. Written only by the geo-grid-scan edge function via geo_grid_begin_scan / geo_grid_finish_scan.';
COMMENT ON TABLE geo_grid_points IS
  'One row per grid cell of a scan: rank (1-20), outcome and the top three competitors at that point.';

-- =============================================================
-- OPTIONAL (run separately, only after replacing the placeholders): scheduled scans, hourly
--   select cron.schedule('geo-grid-scheduled-scans', '10 * * * *', $cron$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/geo-grid-scan',
--       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
--       body := jsonb_build_object('action','run_due')
--     ); $cron$);
-- =============================================================
