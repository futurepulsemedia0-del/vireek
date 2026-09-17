/*
  # Customer Self-Service Portal

  ## Why
  Two token-gated customer-facing flows already exist in this project —
  quote acceptance (quote_token, /quote/:token) and self-reschedule
  (reschedule_token, /reschedule/:token, added in
  20260912050000_customer_self_reschedule.sql). Both are single-purpose:
  a customer with a link can do exactly one thing. This adds a third,
  broader surface: a standing portal per customer where they can see
  their job history, quotes, membership status, and request new service
  or update their own contact info — all from one durable link instead
  of a new one-off token per interaction.

  ## Design decisions worth knowing
  1. **Same security model as reschedule.** RLS on `customers`, `jobs`,
     `quotes` and `memberships` stays closed to anon entirely. All public
     access goes through narrow SECURITY DEFINER functions that validate
     the token server-side before returning anything, exactly like
     `get_job_for_reschedule`. No new RLS policy grants anon direct table
     access.
  2. **Opt-in per business**, via `business_profile.allow_customer_portal`
     (defaults false) — mirrors `allow_customer_self_reschedule`. A
     business that never turns this on has zero behavior change and zero
     new exposure.
  3. **One durable token per customer**, not per interaction. Portal
     links are meant to be handed out once (e.g. after a completed job)
     and reused, unlike reschedule/quote tokens which are single-purpose.
  4. **Matching by phone, not just customer_id.** `quotes` and
     `memberships` were built keyed on `customer_phone` / `customer_name`
     with no `customer_id` column — this mirrors the codebase's existing
     convention (see CohortLtvSection.tsx) rather than inventing a new
     join key those tables don't have.
  5. **Writes are narrow and logged.** A portal visitor can only do two
     things: request service (creates a real `lead` the business already
     works from, plus an entry in `portal_requests` for visibility) and
     update their own phone/email. Nothing else is reachable from the
     token.
*/

-- =============================================================
-- 1. Durable portal token per customer
-- =============================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portal_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_portal_token ON customers(portal_token);

-- =============================================================
-- 2. Per-business opt-in
-- =============================================================

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS allow_customer_portal boolean NOT NULL DEFAULT false;

-- =============================================================
-- 3. Portal service requests — visible to the business, written only
--    through submit_portal_service_request() below.
-- =============================================================

CREATE TABLE IF NOT EXISTS portal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,

  service_type text,
  message text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'resolved')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_requests_user_id ON portal_requests(user_id);

ALTER TABLE portal_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_portal_requests" ON portal_requests
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

CREATE POLICY "update_own_portal_requests" ON portal_requests
  FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id())
  WITH CHECK (user_id = public.get_account_owner_id());

-- Deliberately no INSERT/DELETE policy for authenticated users: rows are
-- only ever created by submit_portal_service_request() (SECURITY DEFINER,
-- runs as postgres) and are never deleted, only resolved.

-- =============================================================
-- 4. Read: the full portal bundle for one customer
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
  v_portal_enabled boolean;
  v_result jsonb;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, COALESCE(bp.allow_customer_portal, false)
  INTO v_business_name, v_portal_enabled
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_customer.user_id;

  IF NOT v_portal_enabled THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'customer', jsonb_build_object(
      'name', v_customer.name,
      'phone', v_customer.phone,
      'email', v_customer.email,
      'address', v_customer.address,
      'lifecycle_stage', v_customer.lifecycle_stage
    ),
    'business_name', v_business_name,
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', j.id,
        'service_type', j.service_type,
        'scheduled_datetime', j.scheduled_datetime,
        'job_status', j.job_status,
        'invoice_amount', j.invoice_amount,
        'invoice_status', j.invoice_status,
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

-- =============================================================
-- 5. Write: request new service (creates a real lead + a visible log row)
-- =============================================================

CREATE OR REPLACE FUNCTION public.submit_portal_service_request(
  p_token uuid,
  p_service_type text,
  p_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_portal_enabled boolean;
  v_lead_id uuid;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN false;
  END IF;

  SELECT COALESCE(bp.allow_customer_portal, false) INTO v_portal_enabled
  FROM business_profile bp WHERE bp.user_id = v_customer.user_id;
  IF NOT v_portal_enabled THEN
    RETURN false;
  END IF;

  INSERT INTO leads (user_id, customer_id, name, phone, email, service_interested, notes, stage)
  VALUES (
    v_customer.user_id, v_customer.id, v_customer.name, v_customer.phone, v_customer.email,
    NULLIF(trim(p_service_type), ''), NULLIF(trim(p_message), ''), 'new'
  )
  RETURNING id INTO v_lead_id;

  INSERT INTO portal_requests (user_id, customer_id, lead_id, service_type, message)
  VALUES (v_customer.user_id, v_customer.id, v_lead_id, NULLIF(trim(p_service_type), ''), NULLIF(trim(p_message), ''));

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_portal_service_request(uuid, text, text) TO anon, authenticated;

-- =============================================================
-- 6. Write: update own contact info
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_portal_contact_info(
  p_token uuid,
  p_phone text,
  p_email text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id uuid;
  v_portal_enabled boolean;
BEGIN
  SELECT c.id, COALESCE(bp.allow_customer_portal, false)
  INTO v_customer_id, v_portal_enabled
  FROM customers c
  LEFT JOIN business_profile bp ON bp.user_id = c.user_id
  WHERE c.portal_token = p_token;

  IF v_customer_id IS NULL OR NOT v_portal_enabled THEN
    RETURN false;
  END IF;

  UPDATE customers
  SET phone = COALESCE(NULLIF(trim(p_phone), ''), phone),
      email = COALESCE(NULLIF(trim(p_email), ''), email),
      updated_at = now()
  WHERE id = v_customer_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_portal_contact_info(uuid, text, text) TO anon, authenticated;
