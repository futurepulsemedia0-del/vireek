/*
  # Technician ratings

  Customer rates the TECHNICIAN after a job (1-5 + tags + comment) on the same
  token-gated /review/:token page. Reuses review_requests (data) and
  technician_scorecards (snapshots). New RPC names; existing
  submit_customer_review / get_review_request are untouched.
*/

-- 1. review_requests: technician rating columns
ALTER TABLE review_requests
  ADD COLUMN IF NOT EXISTS technician_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS technician_rating smallint,
  ADD COLUMN IF NOT EXISTS technician_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS technician_comment text,
  ADD COLUMN IF NOT EXISTS technician_rated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_requests_technician_rating_check') THEN
    ALTER TABLE review_requests ADD CONSTRAINT review_requests_technician_rating_check
      CHECK (technician_rating IS NULL OR technician_rating BETWEEN 1 AND 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_requests_technician_comment_check') THEN
    ALTER TABLE review_requests ADD CONSTRAINT review_requests_technician_comment_check
      CHECK (technician_comment IS NULL OR char_length(technician_comment) <= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_requests_technician_tags_check') THEN
    ALTER TABLE review_requests ADD CONSTRAINT review_requests_technician_tags_check
      CHECK (cardinality(technician_tags) <= 8);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_review_requests_technician_rated
  ON review_requests(technician_id, technician_rated_at DESC)
  WHERE technician_rating IS NOT NULL;

-- 2. Snapshot the technician when the request is created (history survives reassignment)
CREATE OR REPLACE FUNCTION public.set_review_request_technician()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.technician_id IS NULL AND NEW.job_id IS NOT NULL THEN
    SELECT j.assigned_technician_id INTO NEW.technician_id
    FROM jobs j
    WHERE j.id = NEW.job_id AND j.user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_review_request_technician ON review_requests;
CREATE TRIGGER trg_set_review_request_technician
  BEFORE INSERT ON review_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_review_request_technician();

-- Backfill technician for existing requests (no ratings are invented)
UPDATE review_requests rr
SET technician_id = j.assigned_technician_id
FROM jobs j
WHERE rr.job_id = j.id AND j.user_id = rr.user_id
  AND rr.technician_id IS NULL AND j.assigned_technician_id IS NOT NULL;

-- 3. Allowed tags (keep in sync with src/lib/technicianRatings.ts)
CREATE OR REPLACE FUNCTION public.technician_rating_tags()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'on_time','professional','clear_communication','clean_work','knowledgeable','friendly','fair_price',
    'late','rude','messy','poor_communication','rushed','upsold','didnt_fix'
  ]::text[];
$$;

-- 4. technician_scorecards: rating columns
ALTER TABLE technician_scorecards
  ADD COLUMN IF NOT EXISTS tech_rating_avg numeric(3,2),
  ADD COLUMN IF NOT EXISTS tech_rating_responses integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tech_rating_low_count integer NOT NULL DEFAULT 0,
  /* [{ "tag": string, "count": number }] */
  ADD COLUMN IF NOT EXISTS tech_rating_tags jsonb NOT NULL DEFAULT '[]';

-- 5. Public (token-gated) read: who is being rated?
CREATE OR REPLACE FUNCTION public.get_technician_review_context(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req review_requests%ROWTYPE;
  v_tech_id uuid;
  v_name text;
BEGIN
  SELECT * INTO v_req FROM review_requests WHERE review_token = p_token;
  IF v_req.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_tech_id := v_req.technician_id;
  IF v_tech_id IS NULL AND v_req.job_id IS NOT NULL THEN
    SELECT j.assigned_technician_id INTO v_tech_id
    FROM jobs j WHERE j.id = v_req.job_id AND j.user_id = v_req.user_id;
  END IF;

  IF v_tech_id IS NULL THEN
    RETURN jsonb_build_object('available', false, 'technician_first_name', NULL::text, 'already_rated', false);
  END IF;

  -- First name only: the public page never exposes more of the technician's identity.
  SELECT NULLIF(split_part(btrim(coalesce(tm.member_name, '')), ' ', 1), '') INTO v_name
  FROM team_members tm WHERE tm.id = v_tech_id;

  RETURN jsonb_build_object(
    'available', (v_req.technician_rated_at IS NULL AND v_req.status <> 'declined'),
    'technician_first_name', v_name,
    'already_rated', (v_req.technician_rated_at IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_technician_review_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_technician_review_context(uuid) TO anon, authenticated;

-- 6. Public (token-gated) write: overall review + technician rating, atomically, one-time
CREATE OR REPLACE FUNCTION public.submit_customer_review_v2(
  p_token uuid,
  p_rating smallint,
  p_feedback text,
  p_tech_rating smallint,
  p_tech_tags text[],
  p_tech_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req review_requests%ROWTYPE;
  v_tech_id uuid;
  v_tags text[] := '{}'::text[];
  v_google_url text;
BEGIN
  IF p_rating IS NULL AND p_tech_rating IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_submit');
  END IF;
  IF p_rating IS NOT NULL AND (p_rating < 1 OR p_rating > 5) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_rating');
  END IF;
  IF p_tech_rating IS NOT NULL AND (p_tech_rating < 1 OR p_tech_rating > 5) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_technician_rating');
  END IF;

  SELECT * INTO v_req FROM review_requests WHERE review_token = p_token FOR UPDATE;
  IF v_req.id IS NULL OR v_req.status = 'declined' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_available');
  END IF;
  IF p_rating IS NOT NULL AND v_req.status <> 'sent' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_available');
  END IF;

  IF p_tech_rating IS NOT NULL THEN
    IF v_req.technician_rated_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_rated');
    END IF;

    v_tech_id := COALESCE(
      v_req.technician_id,
      (SELECT j.assigned_technician_id FROM jobs j WHERE j.id = v_req.job_id AND j.user_id = v_req.user_id)
    );
    IF v_tech_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_technician');
    END IF;

    SELECT COALESCE(array_agg(u.tag ORDER BY u.tag), '{}'::text[]) INTO v_tags
    FROM (
      SELECT DISTINCT x AS tag
      FROM unnest(COALESCE(p_tech_tags, '{}'::text[])) AS u0(x)
      WHERE x = ANY (public.technician_rating_tags())
      LIMIT 6
    ) u;
  END IF;

  UPDATE review_requests
  SET rating = CASE WHEN p_rating IS NOT NULL THEN p_rating ELSE rating END,
      feedback = CASE WHEN p_rating IS NOT NULL THEN NULLIF(btrim(coalesce(p_feedback, '')), '') ELSE feedback END,
      status = CASE WHEN p_rating IS NOT NULL THEN 'completed' ELSE status END,
      completed_at = CASE WHEN p_rating IS NOT NULL THEN now() ELSE completed_at END,
      technician_id = COALESCE(v_tech_id, technician_id),
      technician_rating = CASE WHEN p_tech_rating IS NOT NULL THEN p_tech_rating ELSE technician_rating END,
      technician_tags = CASE WHEN p_tech_rating IS NOT NULL THEN v_tags ELSE technician_tags END,
      technician_comment = CASE WHEN p_tech_rating IS NOT NULL
        THEN left(NULLIF(btrim(coalesce(p_tech_comment, '')), ''), 500) ELSE technician_comment END,
      technician_rated_at = CASE WHEN p_tech_rating IS NOT NULL THEN now() ELSE technician_rated_at END
  WHERE id = v_req.id;

  SELECT bp.google_review_url INTO v_google_url
  FROM business_profile bp WHERE bp.user_id = v_req.user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'suggest_public_review', COALESCE(p_rating >= 4, false),
    'google_review_url', v_google_url,
    'technician_rated', (p_tech_rating IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_customer_review_v2(uuid, smallint, text, smallint, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_customer_review_v2(uuid, smallint, text, smallint, text[], text) TO anon, authenticated;

-- 7. Owner alerts: low score (<= 2) + declining trend (last 5 avg < 3.5, deduped 7 days)
CREATE OR REPLACE FUNCTION public.notify_low_technician_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_url text;
  v_msg text;
  v_n integer;
  v_avg numeric;
BEGIN
  IF NEW.technician_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A failed alert must never block the customer's submission.
  BEGIN
    SELECT COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email) INTO v_name
    FROM team_members tm WHERE tm.id = NEW.technician_id;
    v_name := COALESCE(v_name, 'A technician');
    v_url := '/dashboard/technician-performance#t-' || NEW.technician_id::text;

    IF NEW.technician_rating <= 2 THEN
      v_msg := format('%s rated %s %s/5.', COALESCE(NULLIF(btrim(NEW.customer_name), ''), 'A customer'), v_name, NEW.technician_rating);
      IF cardinality(NEW.technician_tags) > 0 THEN
        v_msg := v_msg || ' Tags: ' || (SELECT string_agg(replace(t, '_', ' '), ', ') FROM unnest(NEW.technician_tags) AS u(t)) || '.';
      END IF;
      IF NEW.technician_comment IS NOT NULL THEN
        v_msg := v_msg || ' "' || left(regexp_replace(NEW.technician_comment, '\s+', ' ', 'g'), 140) || '"';
      END IF;
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (NEW.user_id, 'technician_low_rating_alert',
              format('Low rating for %s: %s/5', v_name, NEW.technician_rating), v_msg, v_url);
    END IF;

    SELECT count(*), avg(x.r) INTO v_n, v_avg
    FROM (
      SELECT rr.technician_rating AS r
      FROM review_requests rr
      WHERE rr.user_id = NEW.user_id AND rr.technician_id = NEW.technician_id AND rr.technician_rating IS NOT NULL
      ORDER BY rr.technician_rated_at DESC
      LIMIT 5
    ) x;

    IF v_n = 5 AND v_avg < 3.5 AND NOT EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.user_id = NEW.user_id AND n.type = 'technician_rating_trend_alert'
        AND n.action_url = v_url AND n.created_at > now() - interval '7 days'
    ) THEN
      INSERT INTO notifications (user_id, type, title, message, action_url)
      VALUES (NEW.user_id, 'technician_rating_trend_alert',
              format('Rating trend: %s', v_name),
              format('%s''s last 5 customer ratings average %s/5. Review recent jobs and consider coaching.', v_name, round(v_avg, 1)),
              v_url);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_low_technician_rating failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_low_technician_rating ON review_requests;
CREATE TRIGGER trg_notify_low_technician_rating
  AFTER UPDATE OF technician_rated_at ON review_requests
  FOR EACH ROW
  WHEN (OLD.technician_rated_at IS NULL AND NEW.technician_rated_at IS NOT NULL)
  EXECUTE FUNCTION public.notify_low_technician_rating();

-- 8. Dispatch: per-technician rating summary (owner's account only)
CREATE OR REPLACE FUNCTION public.technician_rating_summaries(p_days integer DEFAULT 180)
RETURNS TABLE (
  technician_id uuid,
  responses integer,
  avg_rating numeric,
  low_count integer,
  recent_avg numeric,
  tags jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT rr.technician_id AS tid, rr.technician_rating AS r, rr.technician_tags AS tg, rr.technician_rated_at AS at
    FROM review_requests rr
    WHERE rr.user_id = public.get_account_owner_id()
      AND rr.technician_id IS NOT NULL
      AND rr.technician_rating IS NOT NULL
      AND rr.technician_rated_at >= now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 180), 730)))
  ),
  tag_counts AS (
    SELECT b.tid, t.tag, count(*)::integer AS n
    FROM base b CROSS JOIN LATERAL unnest(b.tg) AS t(tag)
    GROUP BY b.tid, t.tag
  )
  SELECT
    b.tid,
    count(*)::integer,
    round(avg(b.r)::numeric, 2),
    (count(*) FILTER (WHERE b.r <= 2))::integer,
    round((avg(b.r) FILTER (WHERE b.at >= now() - interval '30 days'))::numeric, 2),
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('tag', tc.tag, 'count', tc.n) ORDER BY tc.n DESC, tc.tag)
       FROM tag_counts tc WHERE tc.tid = b.tid),
      '[]'::jsonb
    )
  FROM base b
  GROUP BY b.tid;
$$;

REVOKE ALL ON FUNCTION public.technician_rating_summaries(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.technician_rating_summaries(integer) TO authenticated;
