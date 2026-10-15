/*
  # Shareable read-only dashboard snapshots

  The owner freezes a set of AGGREGATE widgets (no customer records) into a
  snapshot and shares an expiring link / PDF with partners, accountants or
  franchisors.

  Security model
  - The raw link token is generated server-side, returned ONCE, and only its
    SHA-256 hash is stored. A database leak cannot reveal working links.
  - Anonymous visitors can only call two token-gated SECURITY DEFINER RPCs;
    they have no table access at all.
  - Expired / revoked / unknown tokens are indistinguishable to the visitor.
  - Only the account OWNER (not team members) can create or revoke.
  - Views are tracked per open (time + truncated user-agent; no IP, no cookies).

  Purely additive. Rename the timestamp if it does not sort after your newest migration.
*/

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,                        -- ACCOUNT OWNER id
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  audience text CHECK (audience IS NULL OR char_length(audience) <= 80),
  token_hash text NOT NULL UNIQUE,
  widget_keys text[] NOT NULL CHECK (cardinality(widget_keys) BETWEEN 1 AND 20),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 204800),
  period_days integer NOT NULL CHECK (period_days IN (7, 30, 90)),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_owner
  ON dashboard_snapshots(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_snapshot_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES dashboard_snapshots(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshot_views_snapshot
  ON dashboard_snapshot_views(snapshot_id, viewed_at DESC);

ALTER TABLE dashboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_snapshot_views ENABLE ROW LEVEL SECURITY;

-- token_hash is never selectable by clients, even the owner.
REVOKE ALL ON dashboard_snapshots FROM anon, authenticated;
GRANT SELECT (id, user_id, title, audience, widget_keys, payload, period_days, expires_at,
              revoked_at, view_count, first_viewed_at, last_viewed_at, created_at)
  ON dashboard_snapshots TO authenticated;
REVOKE ALL ON dashboard_snapshot_views FROM anon, authenticated;
GRANT SELECT ON dashboard_snapshot_views TO authenticated;

DROP POLICY IF EXISTS "select_own_dashboard_snapshots" ON dashboard_snapshots;
CREATE POLICY "select_own_dashboard_snapshots" ON dashboard_snapshots
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "select_own_dashboard_snapshot_views" ON dashboard_snapshot_views;
CREATE POLICY "select_own_dashboard_snapshot_views" ON dashboard_snapshot_views
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM dashboard_snapshots s
            WHERE s.id = snapshot_id AND s.user_id = public.get_account_owner_id())
  );
-- No INSERT/UPDATE/DELETE policies: all writes go through the RPCs below.

-- ---------------------------------------------------------------------------
-- Create (owner only). Returns the raw token exactly once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_dashboard_snapshot(
  p_title text,
  p_audience text,
  p_widget_keys text[],
  p_payload jsonb,
  p_period_days integer,
  p_expiry_days integer
)
RETURNS TABLE (snapshot_id uuid, token text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_allowed constant text[] := ARRAY[
    'calls_total','missed_call_rate','emergency_calls','jobs_completed','revenue_collected',
    'lead_conversion','positive_sentiment','call_volume_trend','lead_sources','call_outcomes'
  ];
  v_token text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can share dashboard snapshots' USING ERRCODE = '42501';
  END IF;
  IF p_expiry_days IS NULL OR p_expiry_days < 1 OR p_expiry_days > 90 THEN
    RAISE EXCEPTION 'Expiry must be between 1 and 90 days' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_widget_keys <@ v_allowed) THEN
    RAISE EXCEPTION 'Unknown widget' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM dashboard_snapshots s
      WHERE s.user_id = v_owner AND s.revoked_at IS NULL AND s.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'Too many active snapshots. Revoke one first.' USING ERRCODE = '54000';
  END IF;

  -- 64 hex chars from two random UUIDs (~244 bits); only the hash is stored.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp := now() + make_interval(days => p_expiry_days);

  INSERT INTO dashboard_snapshots (user_id, title, audience, token_hash, widget_keys, payload, period_days, expires_at)
  VALUES (v_owner, btrim(p_title), NULLIF(btrim(COALESCE(p_audience, '')), ''),
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
          p_widget_keys, p_payload, p_period_days, v_exp)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_token, v_exp;
END;
$$;

-- ---------------------------------------------------------------------------
-- Revoke (owner only). Idempotent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_dashboard_snapshot(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can revoke dashboard snapshots' USING ERRCODE = '42501';
  END IF;
  UPDATE dashboard_snapshots SET revoked_at = COALESCE(revoked_at, now())
  WHERE id = p_id AND user_id = v_owner;
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Public read (token-gated). NULL for unknown, expired or revoked links.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_dashboard_snapshot(p_token text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT jsonb_build_object(
    'title', s.title,
    'audience', s.audience,
    'business_name', COALESCE(p.company_name, ''),
    'payload', s.payload,
    'created_at', s.created_at,
    'expires_at', s.expires_at
  )
  FROM dashboard_snapshots s
  LEFT JOIN profiles p ON p.id = s.user_id
  WHERE p_token ~ '^[0-9a-f]{64}$'
    AND s.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    AND s.revoked_at IS NULL
    AND s.expires_at > now();
$$;

-- ---------------------------------------------------------------------------
-- Public view tracking (token-gated, only for live links).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_dashboard_snapshot_view(p_token text, p_user_agent text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  SELECT id INTO v_id FROM dashboard_snapshots
  WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    AND revoked_at IS NULL AND expires_at > now();
  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO dashboard_snapshot_views (snapshot_id, user_agent)
  VALUES (v_id, left(NULLIF(btrim(COALESCE(p_user_agent, '')), ''), 160));

  UPDATE dashboard_snapshots
  SET view_count = view_count + 1,
      first_viewed_at = COALESCE(first_viewed_at, now()),
      last_viewed_at = now()
  WHERE id = v_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_dashboard_snapshot(text, text, text[], jsonb, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_dashboard_snapshot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_dashboard_snapshot(text, text, text[], jsonb, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_dashboard_snapshot(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_snapshot(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_dashboard_snapshot_view(text, text) TO anon, authenticated;
