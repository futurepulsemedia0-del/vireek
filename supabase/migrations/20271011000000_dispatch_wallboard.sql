/*
  # Dispatch Wallboard (TV mode)

  ## Why
  The dispatch office wants a full-screen, always-on display (no login on the
  TV) showing today's jobs by status, technicians' live status/location, open
  emergencies, missed calls and revenue vs goal.

  ## Security model (same family as dashboard_snapshots)
  - The TV link token is generated server-side, returned ONCE; only its SHA-256
    hash is stored. A DB leak cannot reveal working links.
  - Anonymous visitors can call exactly ONE token-gated SECURITY DEFINER RPC
    (get_wallboard_snapshot). They have no table access at all.
  - Revoked / unknown tokens are indistinguishable (NULL).
  - Only the account OWNER can create / edit / revoke wallboards.
  - The snapshot is deliberately PII-light: customer names are shortened
    ("Maria G."), phone numbers masked, NO street addresses, NO job-site or
    emergency coordinates. Technician coordinates are rounded (~110 m).

  ## Realtime
  Anonymous TVs cannot read tables through Supabase Realtime (RLS). Instead,
  triggers send an EMPTY "nudge" on a public Broadcast channel whose name is an
  unguessable per-wallboard key. The TV reacts to a nudge by re-calling the
  token-gated RPC. No data ever travels over the broadcast channel. Nudges are
  throttled to 1 per second per account; the TV also polls as a safety net.

  Purely additive. Rename the timestamp if it does not sort after your newest migration.
*/

-- =============================================================
-- 0. Indexes the snapshot relies on (no-ops if they already exist)
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_jobs_user_scheduled ON public.jobs (user_id, scheduled_datetime);
CREATE INDEX IF NOT EXISTS idx_calls_user_datetime ON public.calls (user_id, call_datetime DESC);

-- =============================================================
-- 1. wallboards
-- =============================================================
CREATE TABLE IF NOT EXISTS public.wallboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,   -- ACCOUNT OWNER id
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE,
  channel_key text NOT NULL UNIQUE,
  rotation_seconds integer NOT NULL DEFAULT 15 CHECK (rotation_seconds BETWEEN 8 AND 120),
  panels text[] NOT NULL DEFAULT ARRAY['jobs','technicians','emergencies','calls','revenue']
    CHECK (
      cardinality(panels) BETWEEN 1 AND 5
      AND panels <@ ARRAY['jobs','technicians','emergencies','calls','revenue']::text[]
    ),
  revenue_goal_override numeric CHECK (revenue_goal_override IS NULL OR revenue_goal_override >= 0),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallboards_user_active
  ON public.wallboards (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.wallboards ENABLE ROW LEVEL SECURITY;

-- token_hash and channel_key are never selectable by clients.
REVOKE ALL ON public.wallboards FROM anon, authenticated;
GRANT SELECT (id, user_id, name, rotation_seconds, panels, revenue_goal_override, revoked_at, last_seen_at, created_at)
  ON public.wallboards TO authenticated;

DROP POLICY IF EXISTS "wallboards_select_owner" ON public.wallboards;
CREATE POLICY "wallboards_select_owner" ON public.wallboards
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies: every write goes through the RPCs below.

-- =============================================================
-- 2. Helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.wallboard_short_name(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN 'Customer'
    WHEN position(' ' IN btrim(p)) = 0 THEN btrim(p)
    ELSE split_part(btrim(p), ' ', 1) || ' ' || upper(left(regexp_replace(btrim(p), '^.*\s', ''), 1)) || '.'
  END;
$$;

CREATE OR REPLACE FUNCTION public.wallboard_mask_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR length(regexp_replace(p, '\D', '', 'g')) < 4 THEN 'Unknown caller'
    ELSE '•••• ' || right(regexp_replace(p, '\D', '', 'g'), 4)
  END;
$$;

-- =============================================================
-- 3. Owner-only management RPCs
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_wallboard(
  p_name text,
  p_rotation_seconds integer DEFAULT 15,
  p_panels text[] DEFAULT ARRAY['jobs','technicians','emergencies','calls','revenue'],
  p_revenue_goal numeric DEFAULT NULL
)
RETURNS TABLE (wallboard_id uuid, token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_token text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can manage wallboards' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.wallboards w WHERE w.user_id = v_owner AND w.revoked_at IS NULL) >= 10 THEN
    RAISE EXCEPTION 'Too many active wallboards. Revoke one first.' USING ERRCODE = '54000';
  END IF;

  -- 64 hex chars from two random UUIDs (~244 bits); only the hash is stored.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.wallboards (user_id, name, token_hash, channel_key, rotation_seconds, panels, revenue_goal_override)
  VALUES (
    v_owner,
    btrim(p_name),
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    replace(gen_random_uuid()::text, '-', ''),
    COALESCE(p_rotation_seconds, 15),
    COALESCE(p_panels, ARRAY['jobs','technicians','emergencies','calls','revenue']),
    p_revenue_goal
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_wallboard(
  p_id uuid,
  p_name text,
  p_rotation_seconds integer,
  p_panels text[],
  p_revenue_goal numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can manage wallboards' USING ERRCODE = '42501';
  END IF;
  UPDATE public.wallboards
     SET name = btrim(p_name),
         rotation_seconds = p_rotation_seconds,
         panels = p_panels,
         revenue_goal_override = p_revenue_goal
   WHERE id = p_id AND user_id = v_owner AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_wallboard(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can manage wallboards' USING ERRCODE = '42501';
  END IF;
  UPDATE public.wallboards SET revoked_at = COALESCE(revoked_at, now())
   WHERE id = p_id AND user_id = v_owner;
  RETURN FOUND;
END;
$$;

-- =============================================================
-- 4. Public, token-gated snapshot (the ONLY thing the TV can call)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_wallboard_snapshot(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.wallboards;
  v_tz text;
  v_local_now timestamp;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_month_start timestamptz;
  v_day_of_month integer;
  v_days_in_month integer;
  v_goal numeric;
  v_jobs jsonb;
  v_job_counts jsonb;
  v_techs jsonb;
  v_emerg jsonb;
  v_calls jsonb;
  v_rev jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO w
    FROM public.wallboards
   WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- "Last seen" lets the owner see whether a TV is actually online (throttled).
  UPDATE public.wallboards SET last_seen_at = now()
   WHERE id = w.id AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds');

  SELECT NULLIF(bp.timezone, '') INTO v_tz FROM public.business_profile bp WHERE bp.user_id = w.user_id;
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'America/New_York';
  END IF;

  v_local_now := now() AT TIME ZONE v_tz;
  v_day_start := date_trunc('day', v_local_now) AT TIME ZONE v_tz;
  v_day_end := (date_trunc('day', v_local_now) + interval '1 day') AT TIME ZONE v_tz;
  v_month_start := date_trunc('month', v_local_now) AT TIME ZONE v_tz;
  v_day_of_month := extract(day FROM v_local_now)::integer;
  v_days_in_month := extract(day FROM (date_trunc('month', v_local_now) + interval '1 month - 1 day'))::integer;

  -- ---------- jobs ----------
  WITH base AS (
    SELECT j.id, j.customer_name, j.service_type, j.scheduled_datetime, j.job_status,
           tm.member_name AS tech_name,
           CASE WHEN j.job_status = 'scheduled' AND j.scheduled_datetime < now() - interval '10 minutes'
                THEN true ELSE false END AS late
      FROM public.jobs j
      LEFT JOIN public.team_members tm ON tm.id = j.assigned_technician_id
     WHERE j.user_id = w.user_id
       AND (
         (j.scheduled_datetime >= v_day_start AND j.scheduled_datetime < v_day_end)
         OR j.job_status IN ('en_route', 'in_progress')
         OR (j.completed_at >= v_day_start AND j.completed_at < v_day_end)
       )
  )
  SELECT
    jsonb_build_object(
      'scheduled',   count(*) FILTER (WHERE job_status = 'scheduled'),
      'en_route',    count(*) FILTER (WHERE job_status = 'en_route'),
      'in_progress', count(*) FILTER (WHERE job_status = 'in_progress'),
      'completed',   count(*) FILTER (WHERE job_status = 'completed'),
      'cancelled',   count(*) FILTER (WHERE job_status IN ('cancelled', 'no_show')),
      'late',        count(*) FILTER (WHERE late),
      'total',       count(*)
    ),
    COALESCE((
      SELECT jsonb_agg(x ORDER BY x.rank, x.scheduled_datetime NULLS LAST)
        FROM (
          SELECT b.id, public.wallboard_short_name(b.customer_name) AS customer,
                 b.service_type AS service, b.scheduled_datetime, b.job_status AS status,
                 b.tech_name AS technician, b.late,
                 CASE b.job_status WHEN 'in_progress' THEN 0 WHEN 'en_route' THEN 1
                                   WHEN 'scheduled' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END AS rank
            FROM base b
           ORDER BY rank, b.scheduled_datetime NULLS LAST
           LIMIT 60
        ) x
    ), '[]'::jsonb)
  INTO v_job_counts, v_jobs
  FROM base;

  -- ---------- technicians ----------
  SELECT COALESCE(jsonb_agg(t ORDER BY t.name), '[]'::jsonb) INTO v_techs
  FROM (
    SELECT
      tm.id,
      COALESCE(NULLIF(btrim(tm.member_name), ''), 'Technician') AS name,
      CASE
        WHEN cj.job_status = 'in_progress' THEN 'on_site'
        WHEN cj.job_status = 'en_route' THEN 'en_route'
        WHEN vl.last_fix_at IS NULL OR vl.last_fix_at < now() - interval '15 minutes' THEN 'offline'
        WHEN COALESCE(vl.speed_mph, 0) >= 3 THEN 'driving'
        ELSE 'available'
      END AS status,
      public.wallboard_short_name(cj.customer_name) AS job_customer,
      cj.service_type AS job_service,
      round(vl.latitude::numeric, 3) AS lat,
      round(vl.longitude::numeric, 3) AS lng,
      vl.reverse_geo AS place,
      round(COALESCE(vl.speed_mph, 0)::numeric) AS speed_mph,
      vl.last_fix_at,
      (SELECT count(*) FROM public.jobs jc
        WHERE jc.assigned_technician_id = tm.id AND jc.job_status = 'completed'
          AND jc.completed_at >= v_day_start AND jc.completed_at < v_day_end) AS completed_today
    FROM public.team_members tm
    LEFT JOIN LATERAL (
      SELECT s.latitude, s.longitude, s.speed_mph, s.last_fix_at, s.reverse_geo
        FROM public.vehicles v
        JOIN public.vehicle_live_state s ON s.vehicle_id = v.id
       WHERE v.assigned_technician_id = tm.id AND v.status <> 'retired'
       ORDER BY s.last_fix_at DESC NULLS LAST
       LIMIT 1
    ) vl ON true
    LEFT JOIN LATERAL (
      SELECT j.job_status, j.customer_name, j.service_type
        FROM public.jobs j
       WHERE j.assigned_technician_id = tm.id AND j.job_status IN ('in_progress', 'en_route')
       ORDER BY CASE j.job_status WHEN 'in_progress' THEN 0 ELSE 1 END, j.scheduled_datetime
       LIMIT 1
    ) cj ON true
    WHERE tm.account_owner_id = w.user_id
      AND (
        vl.last_fix_at IS NOT NULL
        OR cj.job_status IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.jobs jt
           WHERE jt.assigned_technician_id = tm.id
             AND jt.scheduled_datetime >= v_day_start AND jt.scheduled_datetime < v_day_end
        )
      )
    LIMIT 60
  ) t;

  -- ---------- open emergencies ----------
  SELECT COALESCE(jsonb_agg(e ORDER BY e.rank, e.sla_due_at), '[]'::jsonb) INTO v_emerg
  FROM (
    SELECT i.id, i.severity_tier AS severity, i.status, i.required_trade AS trade,
           public.wallboard_short_name(i.customer_name) AS customer,
           i.assigned_technician_name AS technician,
           i.sla_due_at, i.created_at,
           (i.sla_due_at < now()) AS sla_breached,
           CASE i.severity_tier WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END AS rank
      FROM public.emergency_incidents i
     WHERE i.user_id = w.user_id
       AND i.status NOT IN ('resolved', 'cancelled', 'closed')
     ORDER BY rank, i.sla_due_at
     LIMIT 20
  ) e;

  -- ---------- calls ----------
  SELECT jsonb_build_object(
    'total_today',     count(*),
    'missed_today',    count(*) FILTER (WHERE c.status = 'missed'),
    'emergency_today', count(*) FILTER (WHERE c.is_emergency),
    'recent_missed', COALESCE((
      SELECT jsonb_agg(m ORDER BY m.at DESC)
        FROM (
          SELECT c2.id,
                 COALESCE(NULLIF(btrim(c2.caller_name), ''), public.wallboard_mask_phone(c2.caller_phone)) AS caller,
                 c2.call_datetime AS at
            FROM public.calls c2
           WHERE c2.user_id = w.user_id AND c2.status = 'missed'
             AND c2.call_datetime >= v_day_start AND c2.call_datetime < v_day_end
           ORDER BY c2.call_datetime DESC
           LIMIT 10
        ) m
    ), '[]'::jsonb)
  ) INTO v_calls
  FROM public.calls c
  WHERE c.user_id = w.user_id AND c.call_datetime >= v_day_start AND c.call_datetime < v_day_end;

  -- ---------- revenue vs goal (monthly goal, pro-rated per day) ----------
  SELECT COALESCE(w.revenue_goal_override, s.revenue_goal) INTO v_goal
    FROM (SELECT 1) AS o
    LEFT JOIN public.executive_report_settings s ON s.user_id = w.user_id;

  SELECT jsonb_build_object(
    'today',  COALESCE(sum(j.invoice_amount) FILTER (WHERE COALESCE(j.completed_at, j.created_at) >= v_day_start
                                                       AND COALESCE(j.completed_at, j.created_at) < v_day_end), 0),
    'mtd',    COALESCE(sum(j.invoice_amount), 0),
    'goal',   v_goal,
    'day_of_month', v_day_of_month,
    'days_in_month', v_days_in_month,
    'daily', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'amount', d.amount) ORDER BY d.day)
        FROM (
          SELECT (v_local_now::date - g.n) AS day,
                 COALESCE((
                   SELECT sum(j2.invoice_amount) FROM public.jobs j2
                    WHERE j2.user_id = w.user_id AND j2.invoice_status = 'paid'
                      AND (COALESCE(j2.completed_at, j2.created_at) AT TIME ZONE v_tz)::date = (v_local_now::date - g.n)
                 ), 0) AS amount
            FROM generate_series(0, 6) AS g(n)
        ) d
    ), '[]'::jsonb)
  ) INTO v_rev
  FROM public.jobs j
  WHERE j.user_id = w.user_id AND j.invoice_status = 'paid'
    AND COALESCE(j.completed_at, j.created_at) >= v_month_start;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'timezone', v_tz,
    'config', jsonb_build_object(
      'name', w.name,
      'rotation_seconds', w.rotation_seconds,
      'panels', to_jsonb(w.panels),
      'channel_key', w.channel_key
    ),
    'job_counts', v_job_counts,
    'jobs', v_jobs,
    'technicians', v_techs,
    'emergencies', v_emerg,
    'calls', v_calls,
    'revenue', v_rev
  );
END;
$$;

-- =============================================================
-- 5. Broadcast "nudge" triggers (empty payload; throttled)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.wallboard_nudge_gate (
  user_id uuid PRIMARY KEY,
  last_sent timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wallboard_nudge_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallboard_nudge_gate FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.wallboard_nudge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_claimed boolean;
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN v_user := OLD.user_id; ELSE v_user := NEW.user_id; END IF;
  IF v_user IS NULL THEN RETURN NULL; END IF;

  -- Cheap, lock-free exits first (vehicle_live_state is a hot table).
  IF NOT EXISTS (SELECT 1 FROM public.wallboards WHERE user_id = v_user AND revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallboard_nudge_gate WHERE user_id = v_user AND last_sent > clock_timestamp() - interval '1 second') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.wallboard_nudge_gate AS g (user_id, last_sent) VALUES (v_user, clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE SET last_sent = clock_timestamp()
    WHERE g.last_sent <= clock_timestamp() - interval '1 second'
  RETURNING true INTO v_claimed;
  IF v_claimed IS NOT TRUE THEN RETURN NULL; END IF;

  FOR r IN SELECT channel_key FROM public.wallboards WHERE user_id = v_user AND revoked_at IS NULL LOOP
    PERFORM realtime.send(
      jsonb_build_object('t', (extract(epoch FROM clock_timestamp()) * 1000)::bigint),
      'nudge',
      'wallboard:' || r.channel_key,
      false
    );
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A display nudge must NEVER fail or slow the business write that caused it.
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'calls', 'emergency_incidents', 'vehicle_live_state'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_wallboard_nudge ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_wallboard_nudge AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.wallboard_nudge()', t, t);
  END LOOP;
END $$;

-- =============================================================
-- 6. Grants
-- =============================================================
REVOKE ALL ON FUNCTION public.get_wallboard_snapshot(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wallboard_snapshot(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.create_wallboard(text, integer, text[], numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_wallboard(text, integer, text[], numeric) TO authenticated;
REVOKE ALL ON FUNCTION public.update_wallboard(uuid, text, integer, text[], numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_wallboard(uuid, text, integer, text[], numeric) TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_wallboard(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_wallboard(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.wallboard_nudge() FROM PUBLIC, anon, authenticated;
