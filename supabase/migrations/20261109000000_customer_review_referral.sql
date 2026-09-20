/*
  # Customer Experience OS — Phase 3: Review + Referral (customer-facing)

  ## Why
  Two pieces of infrastructure already existed but had no customer-facing
  surface:
  - `review_requests` (20260905120000_review_requests.sql) — staff logs
    that a review was requested, but a customer had no page to actually
    leave a rating.
  - `referral_codes` / `referral_conversions` (20261011000000_marketing_
    automation.sql) — codes and reward config exist, and jobs.job_status
    trigger already auto-converts a referral when a referred customer's
    job is paid. But no customer ever saw their own code or a shareable
    link.

  ## What this adds
  1. `review_requests.review_token` (unique, per-request) + `.feedback` —
     lets a single SECURITY DEFINER pair (get_review_request /
     submit_customer_review) run a public /review/:token page, same
     pattern as reschedule/quote/portal. Submission is a one-time write:
     the RPC only accepts it while status = 'sent', so a link can't be
     replayed to overwrite a rating.
  2. `get_customer_portal_bundle` (CREATE OR REPLACE, 3rd time extending
     this same function) now also returns a `referral` object: the
     customer's own referral code (auto-provisioned on first read if
     they don't have one yet — collision-safe via a short retry loop),
     its reward, and its click count.
  3. `track_referral_click(p_code text)` — public, increments clicks and
     hands back the business's booking_slug (if any) so a `/r/:code`
     landing page can redirect a referred friend straight into booking
     with `?ref=CODE` preserved for later attribution.

  Nothing here touches `create_public_booking` or the existing
  auto-conversion trigger — capturing `ref=CODE` at booking time and
  linking it to `customers.referred_by_code` is a separate, larger change
  to the booking pipeline and deliberately left for its own migration
  rather than bundled in here.
*/

ALTER TABLE review_requests
  ADD COLUMN IF NOT EXISTS review_token uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS feedback text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_requests_review_token ON review_requests(review_token);

-- =============================================================
-- Review: read
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_review_request(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req review_requests%ROWTYPE;
  v_business_name text;
  v_google_url text;
BEGIN
  SELECT * INTO v_req FROM review_requests WHERE review_token = p_token;
  IF v_req.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, bp.google_review_url INTO v_business_name, v_google_url
  FROM profiles p LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_req.user_id;

  RETURN jsonb_build_object(
    'business_name', v_business_name,
    'google_review_url', v_google_url,
    'status', v_req.status,
    'rating', v_req.rating
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_review_request(uuid) TO anon, authenticated;

-- =============================================================
-- Review: write (one-time — only while status = 'sent')
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
    'suggest_public_review', p_rating >= 4,
    'google_review_url', v_google_url
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_customer_review(uuid, smallint, text) TO anon, authenticated;

-- =============================================================
-- Referral: click tracking + redirect target
-- =============================================================

CREATE OR REPLACE FUNCTION public.track_referral_click(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
  v_booking_slug text;
BEGIN
  UPDATE referral_codes SET clicks = clicks + 1
  WHERE code = p_code
  RETURNING user_id INTO v_owner_id;

  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  SELECT booking_slug INTO v_booking_slug FROM business_profile WHERE user_id = v_owner_id;

  RETURN jsonb_build_object('ok', true, 'booking_slug', v_booking_slug);
END;
$$;

GRANT EXECUTE ON FUNCTION public.track_referral_click(text) TO anon, authenticated;

-- =============================================================
-- Portal bundle: add the customer's own referral code (auto-provisioned)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_customer_portal_bundle(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_business_name text;
  v_booking_slug text;
  v_portal_enabled boolean;
  v_result jsonb;
  v_referral jsonb;
  i integer;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, COALESCE(bp.allow_customer_portal, false), bp.booking_slug
  INTO v_business_name, v_portal_enabled, v_booking_slug
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_customer.user_id;

  IF NOT v_portal_enabled THEN
    RETURN NULL;
  END IF;

  -- Auto-provision this customer's referral code on first portal view.
  IF NOT EXISTS (
    SELECT 1 FROM referral_codes WHERE customer_id = v_customer.id AND user_id = v_customer.user_id
  ) THEN
    FOR i IN 1..5 LOOP
      BEGIN
        INSERT INTO referral_codes (user_id, customer_id, code)
        VALUES (
          v_customer.user_id,
          v_customer.id,
          upper(substr(md5(v_customer.id::text || clock_timestamp()::text || i::text), 1, 7))
        );
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- collided on a globally-unique code, try again with a fresh random suffix
        NULL;
      END;
    END LOOP;
  END IF;

  SELECT jsonb_build_object(
    'code', rc.code,
    'reward_type', rc.reward_type,
    'reward_value', rc.reward_value,
    'clicks', rc.clicks
  ) INTO v_referral
  FROM referral_codes rc
  WHERE rc.customer_id = v_customer.id AND rc.user_id = v_customer.user_id
  LIMIT 1;

  SELECT jsonb_build_object(
    'customer', jsonb_build_object(
      'name', v_customer.name,
      'phone', v_customer.phone,
      'email', v_customer.email,
      'address', v_customer.address,
      'lifecycle_stage', v_customer.lifecycle_stage
    ),
    'business_name', v_business_name,
    'booking_slug', v_booking_slug,
    'referral', v_referral,
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', j.id,
        'service_type', j.service_type,
        'scheduled_datetime', j.scheduled_datetime,
        'job_status', j.job_status,
        'invoice_amount', j.invoice_amount,
        'invoice_status', j.invoice_status,
        'reschedule_token', j.reschedule_token,
        'payment_link_url', j.payment_link_url,
        'created_at', j.created_at
      ) ORDER BY COALESCE(j.scheduled_datetime, j.created_at) DESC)
      FROM jobs j
      WHERE j.user_id = v_customer.user_id
        AND (j.customer_id = v_customer.id
             OR (v_customer.phone IS NOT NULL AND j.customer_phone = v_customer.phone))
    ), '[]'::jsonb),
    'quotes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', q.id,
        'quote_token', q.quote_token,
        'status', q.status,
        'accepted_total_cents', q.accepted_total_cents,
        'valid_until', q.valid_until,
        'sent_at', q.sent_at,
        'created_at', q.created_at
      ) ORDER BY q.created_at DESC)
      FROM quotes q
      WHERE q.user_id = v_customer.user_id
        AND v_customer.phone IS NOT NULL AND q.customer_phone = v_customer.phone
    ), '[]'::jsonb),
    'equipment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id,
        'equipment_type', e.equipment_type,
        'make', e.make,
        'model', e.model,
        'install_date', e.install_date,
        'warranty_expires_at', e.warranty_expires_at,
        'warranty_alert_stage', e.warranty_alert_stage,
        'last_service_date', e.last_service_date
      ) ORDER BY e.created_at DESC)
      FROM equipment e
      WHERE e.user_id = v_customer.user_id
        AND e.customer_id = v_customer.id
        AND e.status = 'active'
    ), '[]'::jsonb),
    'membership', (
      SELECT jsonb_build_object(
        'status', m.status,
        'started_at', m.started_at,
        'plan_name', mp.name,
        'benefits', mp.benefits
      )
      FROM memberships m
      LEFT JOIN membership_plans mp ON mp.id = m.plan_id
      WHERE m.user_id = v_customer.user_id
        AND v_customer.phone IS NOT NULL AND m.customer_phone = v_customer.phone
        AND m.status IN ('active', 'offered')
      ORDER BY m.created_at DESC
      LIMIT 1
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_portal_bundle(uuid) TO anon, authenticated;
