-- =============================================================
-- Remove review gating from the customer review flow
--
-- Before: submit_customer_review / submit_customer_review_v2 returned
--   suggest_public_review = (rating >= 4), so only happy customers were shown the
--   public-review link. Selectively soliciting reviews by sentiment ("review gating")
--   is against Google's review policy and the rules on fake or filtered reviews.
-- After: every customer who submits an overall rating is shown the same public-review
--   invitation, whatever the rating. The private feedback form stays (it is additive).
--
-- Only the 'suggest_public_review' expression changes. The function bodies below are copied
-- unchanged from 20261109000000_customer_review_referral.sql (v1) and
-- 20271101000000_technician_ratings.sql (v2) — diff them before applying.
-- Rollback: re-run the original CREATE OR REPLACE from those two files (not recommended).
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_customer_review(
  p_token uuid,
  p_rating smallint,
  p_feedback text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req review_requests%ROWTYPE;
  v_google_url text;
BEGIN
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_rating');
  END IF;

  SELECT * INTO v_req FROM review_requests WHERE review_token = p_token;
  IF v_req.id IS NULL OR v_req.status <> 'sent' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_available');
  END IF;

  UPDATE review_requests
  SET rating = p_rating,
      feedback = NULLIF(trim(coalesce(p_feedback, '')), ''),
      status = 'completed',
      completed_at = now()
  WHERE id = v_req.id;

  SELECT bp.google_review_url INTO v_google_url
  FROM business_profile bp WHERE bp.user_id = v_req.user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'suggest_public_review', true,
    'google_review_url', v_google_url
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_customer_review(uuid, smallint, text) TO anon, authenticated;

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
    'suggest_public_review', (p_rating IS NOT NULL),
    'google_review_url', v_google_url,
    'technician_rated', (p_tech_rating IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_customer_review_v2(uuid, smallint, text, smallint, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_customer_review_v2(uuid, smallint, text, smallint, text[], text) TO anon, authenticated;
