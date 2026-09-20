/*
  # Customer Experience OS — Phase 1: Portal Unification

  ## Why
  The self-service portal (20260925000000_customer_self_service_portal.sql)
  already returns jobs, quotes and membership, but the UI has no way to act
  on any of them from inside the portal — the customer had to be handed a
  *separate* link for reschedule (/reschedule/:token) or payment. This
  patches `get_customer_portal_bundle` (CREATE OR REPLACE, same signature,
  same security model — no new grants, no RLS changes) to also return:

    - each job's own `reschedule_token` and `payment_link_url`, so the
      portal can deep-link "Reschedule" / "Pay now" buttons per job
    - `booking_slug`, so the portal can offer a "Book new service" button
      straight to the business's existing public booking page
    - `equipment`: the customer's units from `equipment` (already written
      by CustomerDetailPage's "Add equipment" form), with warranty fields,
      so the portal can show warranty status the customer previously had
      no visibility into at all

  No new tables, no new write paths — read-only additions to an existing
  SECURITY DEFINER function.
*/

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

-- Signature is unchanged (still get_customer_portal_bundle(uuid)) so the
-- existing GRANT from 20260925000000 still applies; re-stated here only
-- for safety in case this migration ever runs standalone against a fresh DB.
GRANT EXECUTE ON FUNCTION public.get_customer_portal_bundle(uuid) TO anon, authenticated;
