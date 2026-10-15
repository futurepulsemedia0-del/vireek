/*
  # NPS / CSAT analytics — one normalized feed over both feedback sources

  The two customer-feedback sources that exist today:
  - review_requests  — the per-JOB survey sent after service (public
    /review/:token page): rating 1-5 + free-text `feedback`.
  - call_feedback    — the per-CALL rating (1-5 + comment) on the AI assistant's call.

  Both have RLS of `user_id = auth.uid()`, i.e. they are invisible to every
  team member except the one who created the row. Analytics must cover the
  whole ACCOUNT, so this migration adds ONE SECURITY DEFINER read function that
  - resolves the account via get_account_owner_id() (never from the request),
  - allows only the owner or a member whose effective can_view_all_jobs is true
    (custom role overrides the base flag, same as the client's AuthContext),
  - returns both sources normalized, joined to job / technician / service /
    site postal code / call lead source, so the client can slice by any dimension.

  Nothing is written; no table policy is loosened.
*/

CREATE INDEX IF NOT EXISTS idx_review_requests_user_completed ON review_requests (user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_feedback_user_created ON call_feedback (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.can_view_feedback_analytics()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_flag text;
BEGIN
  IF v_owner IS NULL OR auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  IF auth.uid() = v_owner THEN
    RETURN true;
  END IF;

  SELECT coalesce(cr.permissions ->> 'can_view_all_jobs', tm.permissions ->> 'can_view_all_jobs')
    INTO v_flag
    FROM team_members tm
    LEFT JOIN custom_roles cr ON cr.id = tm.custom_role_id
   WHERE tm.account_owner_id = v_owner
     AND tm.member_email = (SELECT email FROM auth.users WHERE id = auth.uid())
   LIMIT 1;

  RETURN coalesce(v_flag::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_view_feedback_analytics() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_feedback_records(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer DEFAULT 5000
)
RETURNS TABLE (
  source text,
  feedback_id uuid,
  rating smallint,
  comment text,
  responded_at timestamptz,
  job_id uuid,
  call_id uuid,
  customer_name text,
  technician_id uuid,
  technician_name text,
  service_type text,
  address text,
  postal_code text,
  scheduled_datetime timestamptz,
  lead_source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT public.can_view_feedback_analytics() THEN
    RAISE EXCEPTION 'Not allowed to view feedback analytics' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH account_users AS (
    SELECT v_owner AS id
    UNION
    SELECT u.id
      FROM team_members tm
      JOIN auth.users u ON u.email = tm.member_email
     WHERE tm.account_owner_id = v_owner
  ),
  fb AS (
    SELECT 'review'::text AS src, rr.id AS fid, rr.rating AS rt, rr.feedback AS cmt,
           coalesce(rr.completed_at, rr.sent_at) AS at, rr.job_id AS jid, NULL::uuid AS cid, rr.customer_name AS cname
      FROM review_requests rr
     WHERE rr.user_id IN (SELECT id FROM account_users)
       AND rr.rating IS NOT NULL
       AND coalesce(rr.completed_at, rr.sent_at) >= p_from
       AND coalesce(rr.completed_at, rr.sent_at) < p_to
    UNION ALL
    SELECT 'call'::text, cf.id, cf.rating, cf.comment, cf.created_at,
           (SELECT j.id FROM jobs j WHERE j.call_id = cf.call_id AND j.user_id = v_owner ORDER BY j.created_at LIMIT 1),
           cf.call_id, ca.caller_name
      FROM call_feedback cf
      JOIN calls ca ON ca.id = cf.call_id
     WHERE cf.user_id IN (SELECT id FROM account_users)
       AND cf.created_at >= p_from
       AND cf.created_at < p_to
  )
  SELECT fb.src, fb.fid, fb.rt, nullif(btrim(fb.cmt), ''), fb.at, j.id, coalesce(fb.cid, j.call_id),
         coalesce(j.customer_name, fb.cname), tm.id, coalesce(tm.member_name, tm.member_email),
         j.service_type, j.address, cs.postal_code, j.scheduled_datetime,
         coalesce(c2.lead_source, c2.source_channel)
    FROM fb
    LEFT JOIN jobs j ON j.id = fb.jid AND j.user_id = v_owner
    LEFT JOIN team_members tm ON tm.id = j.assigned_technician_id AND tm.account_owner_id = v_owner
    LEFT JOIN customer_sites cs ON cs.id = j.site_id AND cs.user_id = v_owner
    LEFT JOIN calls c2 ON c2.id = coalesce(fb.cid, j.call_id) AND c2.user_id = v_owner
   ORDER BY fb.at DESC
   LIMIT least(greatest(p_limit, 1), 10000);
END;
$$;

REVOKE ALL ON FUNCTION public.get_feedback_records(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_feedback_records(timestamptz, timestamptz, integer) TO authenticated;

COMMENT ON FUNCTION public.get_feedback_records IS
  'Account-wide NPS/CSAT feed: review_requests (per job) + call_feedback (per call), normalized and joined to job/technician/service/zip/lead source. Owner or can_view_all_jobs only.';
