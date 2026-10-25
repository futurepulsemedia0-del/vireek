/*
# Tenant success tooling: in-app NPS, feature adoption, nudges, staff at-risk view

## Why
Vireek needs to see (and act on) whether each tenant is actually getting value:
a quarterly in-app NPS, a per-account feature-adoption score, guided activation
playbooks, nudges for unused high-value features, and a staff view of at-risk
accounts that REUSES the existing staff health score (accountExplorer.computeHealth).

## What this adds (purely additive; no existing object is modified)
- success_feature_catalog   which features count toward adoption, how they are measured
                            (table / owner column / weight). Staff-tunable data, seeded below.
- nps_responses             one row per answered NPS survey (written ONLY via submit_nps_response).
- success_item_state        per-person snooze / dismiss / skip state for nudges, playbook steps
                            and the NPS prompt (written ONLY via set_success_item_state).
- get_my_success_snapshot() tenant view: feature usage + personal state + "is NPS due".
- nps_should_prompt()       cheap server-side eligibility check for the in-app prompt.
- submit_nps_response()     validates, rate-limits (1 per person per 90 days) and stores.
- set_success_item_state() / clear_success_item_state()
- staff_success_overview()  staff only; audited; usage matrix + NPS summary for every account.

## Safety
- Usage is measured with dynamic SQL built ONLY from the staff-controlled catalog (identifiers are
  quoted with %I). If a catalog table/column is missing or has an unexpected type, that single feature
  is reported as "unmeasured" and excluded from the score. The function never raises for it.
- Tenants only ever read their own account (get_account_owner_id()).
- Staff access goes through a SECURITY DEFINER function that verifies profiles.is_staff and writes an
  append-only staff_audit_log row. No tenant table gets staff RLS access.
- While a staff member is signed in as a customer (staff_impersonation_sessions), the NPS prompt is
  suppressed and NPS / state writes are refused, so staff can never answer or dismiss on a customer's behalf.

## Requires (already in your project)
profiles(role, created_at), get_account_owner_id(), is_vireek_staff(uuid), staff_audit_log,
staff_impersonation_sessions (optional - guarded), calls, jobs and the tables named in the catalog.
*/

-- ---------------------------------------------------------------------------
-- Feature catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS success_feature_catalog (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  tier text NOT NULL CHECK (tier IN ('core', 'high_value')),
  -- activity: counts only while rows keep appearing (last 180 days). setup: one row means configured.
  kind text NOT NULL CHECK (kind IN ('activity', 'setup')),
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 20),
  source_table text NOT NULL CHECK (source_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  owner_column text NOT NULL CHECK (owner_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  time_column text NOT NULL DEFAULT 'created_at' CHECK (time_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  status_column text CHECK (status_column IS NULL OR status_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  status_values text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT success_feature_status_pair CHECK ((status_column IS NULL) = (status_values IS NULL))
);

ALTER TABLE success_feature_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "success_catalog_read" ON success_feature_catalog;
CREATE POLICY "success_catalog_read" ON success_feature_catalog FOR SELECT TO authenticated USING (true);
REVOKE ALL ON success_feature_catalog FROM anon;
REVOKE INSERT, UPDATE, DELETE ON success_feature_catalog FROM authenticated;
GRANT SELECT ON success_feature_catalog TO authenticated;

INSERT INTO success_feature_catalog (key, label, tier, kind, weight, source_table, owner_column, status_column, status_values) VALUES
  ('ai_calls',        'AI call handling',      'core',       'activity', 14, 'calls',                 'user_id',          NULL,     NULL),
  ('customers',       'Customer records',      'core',       'activity',  5, 'customers',             'user_id',          NULL,     NULL),
  ('jobs',            'Job scheduling',        'core',       'activity',  8, 'jobs',                  'user_id',          NULL,     NULL),
  ('quotes',          'Quotes',                'core',       'activity',  8, 'quotes',                'user_id',          NULL,     NULL),
  ('invoices',        'Invoicing',             'core',       'activity', 10, 'invoices',              'user_id',          NULL,     NULL),
  ('team',            'Team members',          'core',       'setup',     5, 'team_members',          'account_owner_id', NULL,     NULL),
  ('phone_numbers',   'Business phone number', 'core',       'setup',     6, 'phone_numbers',         'account_id',       'status', ARRAY['active', 'porting_in']),
  ('integrations',    'Connected integrations','high_value', 'setup',     6, 'integrations',          'user_id',          'status', ARRAY['connected']),
  ('call_scripts',    'Custom call scripts',   'high_value', 'setup',     6, 'call_scripts',          'user_id',          NULL,     NULL),
  ('call_routing',    'Call routing rules',    'high_value', 'setup',     5, 'call_routing_configs',  'account_owner_id', NULL,     NULL),
  ('price_book',      'Price book',            'high_value', 'setup',     5, 'price_book_items',      'user_id',          NULL,     NULL),
  ('agreements',      'Service agreements',    'high_value', 'activity',  8, 'recurring_agreements',  'user_id',          NULL,     NULL),
  ('email_campaigns', 'Email campaigns',       'high_value', 'activity',  5, 'email_campaigns',       'user_id',          NULL,     NULL),
  ('inventory',       'Inventory tracking',    'high_value', 'setup',     4, 'inventory_parts',       'user_id',          NULL,     NULL),
  ('bank_sync',       'Bank connection',       'high_value', 'setup',     5, 'bank_connections',      'user_id',          NULL,     NULL),
  ('financing',       'Customer financing',    'high_value', 'setup',     4, 'financing_connections', 'user_id',          NULL,     NULL),
  ('expenses',        'Expense tracking',      'high_value', 'activity',  3, 'expenses',              'user_id',          NULL,     NULL),
  ('calendar_feeds',  'Calendar sync',         'high_value', 'setup',     3, 'calendar_feeds',        'user_id',          NULL,     NULL),
  ('crm_sync',        'CRM sync',              'high_value', 'setup',     4, 'crm_connections',       'user_id',          NULL,     NULL),
  ('call_blocklist',  'Spam call blocking',    'high_value', 'setup',     2, 'call_blocklist',        'account_owner_id', NULL,     NULL)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- NPS responses (written only through submit_nps_response)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nps_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 10),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  context text NOT NULL DEFAULT 'prompt' CHECK (context IN ('prompt', 'success_center')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nps_responses_user ON nps_responses (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nps_responses_account ON nps_responses (account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nps_responses_created ON nps_responses (created_at DESC);

ALTER TABLE nps_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nps_select_own" ON nps_responses;
CREATE POLICY "nps_select_own" ON nps_responses FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON nps_responses FROM anon;
REVOKE INSERT, UPDATE, DELETE ON nps_responses FROM authenticated;
GRANT SELECT ON nps_responses TO authenticated;

-- ---------------------------------------------------------------------------
-- Per-person nudge / playbook / NPS-prompt state (written only through RPC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS success_item_state (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_key text NOT NULL CHECK (item_key ~ '^[a-z0-9_:.-]{1,80}$'),
  account_owner_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('snoozed', 'dismissed', 'skipped')),
  snoozed_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key),
  CONSTRAINT success_item_snooze_pair CHECK ((status = 'snoozed') = (snoozed_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_success_item_state_owner ON success_item_state (account_owner_id);

ALTER TABLE success_item_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "success_state_select_own" ON success_item_state;
CREATE POLICY "success_state_select_own" ON success_item_state FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON success_item_state FROM anon;
REVOKE INSERT, UPDATE, DELETE ON success_item_state FROM authenticated;
GRANT SELECT ON success_item_state TO authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._success_is_impersonated(p_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.staff_impersonation_sessions') IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM staff_impersonation_sessions s
    WHERE s.target_account_id = p_owner AND s.ended_at IS NULL AND s.expires_at > now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._nps_due(p_uid uuid, p_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created timestamptz;
BEGIN
  IF p_uid IS NULL OR p_owner IS NULL THEN
    RETURN false;
  END IF;
  IF public._success_is_impersonated(p_owner) THEN
    RETURN false;
  END IF;

  SELECT p.created_at INTO v_created FROM profiles p WHERE p.id = p_owner;
  IF v_created IS NULL OR v_created > now() - interval '14 days' THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM nps_responses n WHERE n.user_id = p_uid AND n.created_at > now() - interval '90 days') THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM success_item_state s
    WHERE s.user_id = p_uid AND s.item_key = 'nps_prompt' AND s.snoozed_until IS NOT NULL AND s.snoozed_until > now()
  ) THEN
    RETURN false;
  END IF;

  -- Only ask once the account has experienced some value (a call or a job).
  RETURN EXISTS (SELECT 1 FROM calls c WHERE c.user_id = p_owner)
      OR EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = p_owner);
END;
$$;

-- Usage facts per (account, feature). Rows exist only where usage was found.
-- A row with measured = false (account_id NULL) marks a feature that could not be measured.
CREATE OR REPLACE FUNCTION public._success_usage_matrix(p_account uuid DEFAULT NULL)
RETURNS TABLE (
  account_id uuid,
  feature_key text,
  total bigint,
  recent bigint,
  last_at timestamptz,
  measured boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  r record;
  v_sql text;
  v_where text;
BEGIN
  FOR r IN SELECT * FROM success_feature_catalog c WHERE c.enabled ORDER BY c.key LOOP
    IF to_regclass(format('public.%I', r.source_table)) IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, r.key, 0::bigint, 0::bigint, NULL::timestamptz, false;
      CONTINUE;
    END IF;

    v_where := 'true';
    IF r.kind = 'activity' THEN
      v_where := format('t.%I >= now() - interval ''180 days''', r.time_column);
    END IF;
    IF r.status_column IS NOT NULL THEN
      v_where := v_where || format(' AND t.%I = ANY (%L::text[])', r.status_column, r.status_values);
    END IF;

    BEGIN
      v_sql := format(
        'SELECT t.%1$I::uuid, %2$L::text, count(*)::bigint, '
        || 'count(*) FILTER (WHERE t.%3$I >= now() - interval ''30 days'')::bigint, '
        || 'max(t.%3$I)::timestamptz, true '
        || 'FROM public.%4$I t WHERE %5$s AND t.%1$I IS NOT NULL '
        || 'AND (%6$L::uuid IS NULL OR t.%1$I = %6$L::uuid) GROUP BY 1',
        r.owner_column, r.key, r.time_column, r.source_table, v_where, p_account
      );
      RETURN QUERY EXECUTE v_sql;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT NULL::uuid, r.key, 0::bigint, 0::bigint, NULL::timestamptz, false;
    END;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tenant RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nps_should_prompt()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._nps_due(auth.uid(), public.get_account_owner_id());
$$;

CREATE OR REPLACE FUNCTION public.submit_nps_response(
  p_score integer,
  p_comment text DEFAULT NULL,
  p_context text DEFAULT 'prompt'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_comment text;
  v_context text;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > 10 THEN
    RAISE EXCEPTION 'invalid_score' USING ERRCODE = '22023';
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable');
  END IF;
  IF EXISTS (SELECT 1 FROM nps_responses n WHERE n.user_id = v_uid AND n.created_at > now() - interval '90 days') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_responded');
  END IF;

  v_context := CASE WHEN p_context = 'success_center' THEN 'success_center' ELSE 'prompt' END;
  v_comment := nullif(left(btrim(coalesce(p_comment, '')), 1000), '');

  INSERT INTO nps_responses (account_owner_id, user_id, score, comment, context)
  VALUES (v_owner, v_uid, p_score::smallint, v_comment, v_context);

  DELETE FROM success_item_state WHERE user_id = v_uid AND item_key = 'nps_prompt';

  RETURN jsonb_build_object(
    'ok', true,
    'category', CASE WHEN p_score >= 9 THEN 'promoter' WHEN p_score >= 7 THEN 'passive' ELSE 'detractor' END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_success_item_state(
  p_key text,
  p_status text,
  p_days integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_until timestamptz;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_key IS NULL OR p_key !~ '^[a-z0-9_:.-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid_key' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('snoozed', 'dismissed', 'skipped') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN; -- staff signed in as the customer must not change the customer's state
  END IF;

  IF p_status = 'snoozed' THEN
    v_until := now() + make_interval(days => least(greatest(coalesce(p_days, 7), 1), 180));
  END IF;

  INSERT INTO success_item_state (user_id, item_key, account_owner_id, status, snoozed_until, updated_at)
  VALUES (v_uid, p_key, v_owner, p_status, v_until, now())
  ON CONFLICT (user_id, item_key) DO UPDATE
    SET status = EXCLUDED.status,
        snoozed_until = EXCLUDED.snoozed_until,
        account_owner_id = EXCLUDED.account_owner_id,
        updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_success_item_state(p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public._success_is_impersonated(v_owner) THEN
    RETURN;
  END IF;
  DELETE FROM success_item_state WHERE user_id = v_uid AND item_key = p_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_success_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid := public.get_account_owner_id();
  v_created timestamptz;
  v_features jsonb;
  v_states jsonb;
BEGIN
  IF v_uid IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.created_at INTO v_created FROM profiles p WHERE p.id = v_owner;

  WITH u AS MATERIALIZED (SELECT * FROM public._success_usage_matrix(v_owner))
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', c.key,
           'label', c.label,
           'tier', c.tier,
           'kind', c.kind,
           'weight', c.weight,
           'measured', NOT EXISTS (SELECT 1 FROM u x WHERE x.feature_key = c.key AND NOT x.measured),
           'total', coalesce(us.total, 0),
           'recent', coalesce(us.recent, 0),
           'last_at', us.last_at
         ) ORDER BY c.weight DESC, c.key), '[]'::jsonb)
    INTO v_features
    FROM success_feature_catalog c
    LEFT JOIN u us ON us.feature_key = c.key AND us.measured AND us.account_id = v_owner
   WHERE c.enabled;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', s.item_key,
           'status', s.status,
           'snoozed_until', s.snoozed_until
         )), '[]'::jsonb)
    INTO v_states
    FROM success_item_state s
   WHERE s.user_id = v_uid AND s.item_key <> 'nps_prompt';

  RETURN jsonb_build_object(
    'account_created_at', v_created,
    'features', v_features,
    'states', v_states,
    'nps_due', public._nps_due(v_uid, v_owner)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff RPC (audited)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_success_overview(p_nps_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_days integer := least(greatest(coalesce(p_nps_days, 90), 7), 365);
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();

  -- One audit row per minute at most, so refreshing the view does not flood the log.
  IF NOT EXISTS (
    SELECT 1 FROM staff_audit_log l
    WHERE l.staff_id = auth.uid()
      AND l.action = 'explorer_list'
      AND l.metadata ->> 'view' = 'success_overview'
      AND l.created_at > now() - interval '1 minute'
  ) THEN
    INSERT INTO staff_audit_log (staff_id, staff_email, action, metadata)
    VALUES (auth.uid(), v_email, 'explorer_list', jsonb_build_object('view', 'success_overview'));
  END IF;

  WITH u AS MATERIALIZED (SELECT * FROM public._success_usage_matrix(NULL)),
  owners AS (SELECT p.id FROM profiles p WHERE p.role = 'owner'),
  latest AS (
    SELECT DISTINCT ON (n.account_owner_id) n.account_owner_id, n.score, n.comment, n.created_at
    FROM nps_responses n
    WHERE n.created_at >= now() - make_interval(days => v_days)
    ORDER BY n.account_owner_id, n.created_at DESC
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'catalog', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'key', c.key,
        'label', c.label,
        'tier', c.tier,
        'kind', c.kind,
        'weight', c.weight,
        'measured', NOT EXISTS (SELECT 1 FROM u x WHERE x.feature_key = c.key AND NOT x.measured)
      ) ORDER BY c.weight DESC, c.key)
      FROM success_feature_catalog c WHERE c.enabled
    ), '[]'::jsonb),
    'usage', coalesce((
      SELECT jsonb_agg(jsonb_build_object('a', us.account_id, 'k', us.feature_key, 't', us.total, 'r', us.recent, 'l', us.last_at))
      FROM u us JOIN owners o ON o.id = us.account_id
      WHERE us.measured
    ), '[]'::jsonb),
    'nps', jsonb_build_object(
      'days', v_days,
      'responses', (SELECT count(*) FROM nps_responses n WHERE n.created_at >= now() - make_interval(days => v_days)),
      'promoters', (SELECT count(*) FROM nps_responses n WHERE n.created_at >= now() - make_interval(days => v_days) AND n.score >= 9),
      'passives', (SELECT count(*) FROM nps_responses n WHERE n.created_at >= now() - make_interval(days => v_days) AND n.score BETWEEN 7 AND 8),
      'detractors', (SELECT count(*) FROM nps_responses n WHERE n.created_at >= now() - make_interval(days => v_days) AND n.score <= 6)
    ),
    'nps_latest', coalesce((
      SELECT jsonb_agg(jsonb_build_object('a', l.account_owner_id, 'score', l.score, 'comment', left(l.comment, 500), 'at', l.created_at))
      FROM latest l
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._success_is_impersonated(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._nps_due(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._success_usage_matrix(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.nps_should_prompt() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_nps_response(integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_success_item_state(text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_success_item_state(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_success_snapshot() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_success_overview(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.nps_should_prompt() TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_nps_response(integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_success_item_state(text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_success_item_state(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_success_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_success_overview(integer) TO authenticated;

COMMENT ON TABLE nps_responses IS 'In-app NPS answers. Written only by submit_nps_response (1 per person per 90 days).';
COMMENT ON TABLE success_item_state IS 'Per-person snooze/dismiss/skip state for success nudges, playbook steps and the NPS prompt.';
COMMENT ON TABLE success_feature_catalog IS 'Features that count toward the per-account adoption score and how each is measured. Staff-tunable data.';
