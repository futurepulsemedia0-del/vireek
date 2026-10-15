/*
# Staff customer explorer: audited access + audited impersonation

## Why
Support needs one place to see how every customer account is doing and, when
a ticket requires it, to sign in as the customer. Both are high-risk, so
neither is done with blanket table access: staff never receive RLS access to
tenant tables. They call narrow SECURITY DEFINER functions that verify
`profiles.is_staff` on the server and leave a permanent trail.

## What this does
- `staff_audit_log`   append-only trail of every staff access (a trigger blocks
                      UPDATE/DELETE for ALL roles, including service_role).
- `staff_impersonation_sessions` every "sign in as customer" session, with the
                      mandatory reason, optional ticket, 30-minute expiry.
- `staff_account_overview(p_limit)`  one row per customer account with the usage
                      signals the health score needs. No transcripts, no PII
                      beyond account identity.
- `staff_account_detail(p_account)`   one account: 30-day usage, recent calls
                      (caller number MASKED, no transcripts/summaries), team,
                      numbers, and who from staff touched it recently.

## Safety
Purely additive: new tables and functions, no existing object is modified.
Anonymous/other tenants: no access. Non-staff callers get `forbidden`.
Impersonation itself runs in the `staff-impersonate` edge function (service
role), which writes the session + both audit trails BEFORE issuing a link.

## Requires (already in your project)
profiles(is_staff, ...), is_vireek_staff(uuid), calls, team_members,
phone_numbers, audit_log + auth.users.
*/

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid,
  staff_email text,
  action text NOT NULL CHECK (action IN ('explorer_list', 'account_view', 'impersonation_start', 'impersonation_end', 'impersonation_denied')),
  target_account_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_audit_created ON staff_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_audit_target ON staff_audit_log(target_account_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.staff_audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'staff_audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_audit_immutable ON staff_audit_log;
CREATE TRIGGER trg_staff_audit_immutable
  BEFORE UPDATE OR DELETE ON staff_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.staff_audit_log_immutable();

ALTER TABLE staff_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_audit_select" ON staff_audit_log;
CREATE POLICY "staff_audit_select" ON staff_audit_log FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
REVOKE ALL ON staff_audit_log FROM anon;
REVOKE INSERT, UPDATE, DELETE ON staff_audit_log FROM authenticated;

-- ---------------------------------------------------------------------------
-- Impersonation sessions (written by the edge function with service_role)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_impersonation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  target_account_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 15 AND 500),
  ticket_ref text CHECK (ticket_ref IS NULL OR char_length(ticket_ref) <= 40),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_staff_imp_staff_started ON staff_impersonation_sessions(staff_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_imp_target ON staff_impersonation_sessions(target_account_id, started_at DESC);

ALTER TABLE staff_impersonation_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_imp_select" ON staff_impersonation_sessions;
CREATE POLICY "staff_imp_select" ON staff_impersonation_sessions FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));
REVOKE ALL ON staff_impersonation_sessions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON staff_impersonation_sessions FROM authenticated;

-- ---------------------------------------------------------------------------
-- staff_account_overview
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_account_overview(p_limit integer DEFAULT 2000)
RETURNS TABLE (
  id uuid,
  email text,
  full_name text,
  company_name text,
  plan text,
  status text,
  subscription_status text,
  dunning_stage integer,
  onboarding_completed boolean,
  minutes_used numeric,
  minutes_included numeric,
  created_at timestamptz,
  is_staff boolean,
  last_sign_in_at timestamptz,
  last_call_at timestamptz,
  calls_30d bigint,
  calls_prev_30d bigint,
  bookings_30d bigint,
  team_count bigint,
  numbers_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_email text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();

  -- One audit row per minute at most, so refreshing the page does not flood the log.
  IF NOT EXISTS (
    SELECT 1 FROM staff_audit_log l
    WHERE l.staff_id = auth.uid() AND l.action = 'explorer_list' AND l.created_at > now() - interval '1 minute'
  ) THEN
    INSERT INTO staff_audit_log (staff_id, staff_email, action) VALUES (auth.uid(), v_email, 'explorer_list');
  END IF;

  RETURN QUERY
  WITH c AS (
    SELECT cl.user_id,
           count(*) FILTER (WHERE cl.call_datetime >= now() - interval '30 days') AS c30,
           count(*) FILTER (WHERE cl.call_datetime >= now() - interval '60 days' AND cl.call_datetime < now() - interval '30 days') AS cprev,
           count(*) FILTER (WHERE cl.call_datetime >= now() - interval '30 days' AND cl.status = 'booked') AS b30,
           max(cl.call_datetime) AS last_call
    FROM calls cl
    WHERE cl.call_datetime >= now() - interval '365 days'
    GROUP BY cl.user_id
  ),
  t AS (SELECT tm.account_owner_id AS owner_id, count(*) AS n FROM team_members tm GROUP BY tm.account_owner_id),
  n AS (SELECT pn.account_id AS owner_id, count(*) AS n FROM phone_numbers pn GROUP BY pn.account_id)
  SELECT
    p.id,
    p.email::text,
    p.full_name::text,
    p.company_name::text,
    p.plan::text,
    p.status::text,
    p.subscription_status::text,
    coalesce(p.dunning_stage, 0)::integer,
    coalesce(p.onboarding_completed, false),
    coalesce(p.minutes_used_this_month, 0)::numeric,
    coalesce(p.minutes_included, 0)::numeric,
    p.created_at,
    coalesce(p.is_staff, false),
    au.last_sign_in_at,
    c.last_call,
    coalesce(c.c30, 0),
    coalesce(c.cprev, 0),
    coalesce(c.b30, 0),
    coalesce(t.n, 0),
    coalesce(n.n, 0)
  FROM profiles p
  LEFT JOIN auth.users au ON au.id = p.id
  LEFT JOIN c ON c.user_id = p.id
  LEFT JOIN t ON t.owner_id = p.id
  LEFT JOIN n ON n.owner_id = p.id
  WHERE p.role = 'owner'
  ORDER BY p.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 2000), 1), 2000);
END;
$$;

-- ---------------------------------------------------------------------------
-- staff_account_detail
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_account_detail(p_account uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_profile profiles%ROWTYPE;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_profile FROM profiles WHERE id = p_account AND role = 'owner';
  IF NOT FOUND THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id)
  VALUES (auth.uid(), v_email, 'account_view', p_account);

  SELECT jsonb_build_object(
    'id', v_profile.id,
    'email', v_profile.email,
    'company_name', v_profile.company_name,
    'full_name', v_profile.full_name,
    'plan', v_profile.plan,
    'status', v_profile.status,
    'subscription_status', v_profile.subscription_status,
    'minutes_used', coalesce(v_profile.minutes_used_this_month, 0),
    'minutes_included', coalesce(v_profile.minutes_included, 0),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'calls', d.calls, 'minutes', d.minutes) ORDER BY d.day)
      FROM (
        SELECT cl.call_datetime::date AS day,
               count(*) AS calls,
               round(coalesce(sum(cl.duration_seconds), 0) / 60.0, 1) AS minutes
        FROM calls cl
        WHERE cl.user_id = p_account AND cl.call_datetime >= now() - interval '30 days'
        GROUP BY cl.call_datetime::date
      ) d
    ), '[]'::jsonb),
    'recent_calls', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'call_datetime', r.call_datetime, 'duration_seconds', r.duration_seconds,
        'status', r.status, 'is_emergency', r.is_emergency,
        'caller_masked', CASE WHEN r.caller_phone IS NULL THEN 'Unknown'
                              ELSE '•••• ' || right(regexp_replace(r.caller_phone, '\D', '', 'g'), 4) END
      ) ORDER BY r.call_datetime DESC)
      FROM (
        SELECT cl.id, cl.call_datetime, cl.duration_seconds, cl.status, cl.is_emergency, cl.caller_phone
        FROM calls cl WHERE cl.user_id = p_account ORDER BY cl.call_datetime DESC LIMIT 10
      ) r
    ), '[]'::jsonb),
    'team', coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', coalesce(tm.member_name, tm.member_email), 'role', tm.role))
      FROM team_members tm WHERE tm.account_owner_id = p_account
    ), '[]'::jsonb),
    'numbers', coalesce((
      SELECT jsonb_agg(jsonb_build_object('phone_number', pn.phone_number))
      FROM phone_numbers pn WHERE pn.account_id = p_account
    ), '[]'::jsonb),
    'staff_access', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'staff_email', a.staff_email, 'action', a.action,
        'target_account_id', a.target_account_id, 'reason', a.reason, 'created_at', a.created_at
      ) ORDER BY a.created_at DESC)
      FROM (
        SELECT * FROM staff_audit_log WHERE target_account_id = p_account ORDER BY created_at DESC LIMIT 10
      ) a
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_account_overview(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_account_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_account_overview(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_account_detail(uuid) TO authenticated;
