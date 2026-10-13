/*
  # Customer Portal — Full History (/portal/:token/history)

  ## Why
  The portal bundle (get_customer_portal_bundle) is a dashboard snapshot. It
  has no invoices, no membership history, and no per-equipment service
  history. This adds ONE new read-only function dedicated to the history page
  instead of widening the bundle a fourth time (the bundle is already
  extended in 3 migrations and is fetched on every portal load).

  ## Security model (identical to the portal)
  - SECURITY DEFINER, validates the durable `customers.portal_token` and the
    per-business `business_profile.allow_customer_portal` opt-in.
  - Returns NULL for BOTH "bad token" and "portal disabled" — callers must
    not be able to tell the two apart.
  - No RLS changes, no new tables, no write paths, no new anon table access.
  - Deliberately NOT exposed: internal job notes, technician identity,
    serial numbers, margins/costs, other customers' rows.

  ## Matching rules (same convention as the bundle)
  - jobs:        customer_id = customer.id OR customer_phone = customer.phone
  - invoices:    job_id belongs to one of the customer's jobs OR
                 customer_phone = customer.phone. Drafts are never returned.
  - memberships: customer_phone = customer.phone (table has no customer_id)
  - equipment:   customer_id = customer.id, status <> 'removed'

  ## Totals
  Invoice totals are computed server-side from line_items + tax_percent
  (same shape as quotes: {description, quantity, unit_price_cents}) by a
  defensive helper that returns NULL instead of raising on malformed JSON,
  so one bad invoice can never break a customer's whole history page.
  The summary block is aggregated over the FULL set, not the capped lists.
*/

-- =============================================================
-- 1. Defensive invoice total helper (internal only)
-- =============================================================

CREATE OR REPLACE FUNCTION public.portal_invoice_total_cents(p_line_items jsonb, p_tax_percent numeric)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_subtotal numeric := 0;
  v_item jsonb;
BEGIN
  IF p_line_items IS NULL OR jsonb_typeof(p_line_items) <> 'array' THEN
    RETURN NULL;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_line_items) LOOP
    v_subtotal := v_subtotal
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'unit_price_cents')::numeric, 0);
  END LOOP;

  RETURN round(v_subtotal * (1 + COALESCE(p_tax_percent, 0) / 100.0))::bigint;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Internal helper: only the SECURITY DEFINER function below calls it.
REVOKE ALL ON FUNCTION public.portal_invoice_total_cents(jsonb, numeric) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 2. Read: full history bundle for one customer
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_customer_portal_history(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer customers%ROWTYPE;
  v_business_name text;
  v_portal_enabled boolean;
  v_result jsonb;
BEGIN
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE portal_token = p_token;
  IF v_customer.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.company_name, COALESCE(bp.allow_customer_portal, false)
  INTO v_business_name, v_portal_enabled
  FROM profiles p
  LEFT JOIN business_profile bp ON bp.user_id = p.id
  WHERE p.id = v_customer.user_id;

  IF NOT COALESCE(v_portal_enabled, false) THEN
    RETURN NULL;
  END IF;

  v_result := (
    WITH my_jobs AS (
      SELECT j.*
      FROM jobs j
      WHERE j.user_id = v_customer.user_id
        AND (j.customer_id = v_customer.id
             OR (v_customer.phone IS NOT NULL AND j.customer_phone = v_customer.phone))
    ),
    inv AS (
      SELECT
        i.id,
        i.invoice_number,
        i.invoice_token,
        i.status,
        i.due_date,
        i.sent_at,
        i.paid_at,
        i.created_at,
        public.portal_invoice_total_cents(i.line_items, i.tax_percent) AS total_cents
      FROM invoices i
      WHERE i.user_id = v_customer.user_id
        AND i.status <> 'draft'
        AND (i.job_id IN (SELECT id FROM my_jobs)
             OR (v_customer.phone IS NOT NULL AND i.customer_phone = v_customer.phone))
    )
    SELECT jsonb_build_object(
      'customer', jsonb_build_object(
        'name', v_customer.name,
        'customer_since', v_customer.created_at
      ),
      'business_name', v_business_name,

      'summary', jsonb_build_object(
        'completed_visits', (SELECT count(*) FROM my_jobs WHERE job_status = 'completed'),
        'total_paid_cents', COALESCE((SELECT sum(total_cents) FROM inv WHERE status = 'paid'), 0),
        'outstanding_cents', COALESCE((SELECT sum(total_cents) FROM inv WHERE status IN ('sent', 'viewed')), 0),
        'outstanding_count', (SELECT count(*) FROM inv WHERE status IN ('sent', 'viewed')),
        'total_services', (SELECT count(*) FROM my_jobs),
        'total_invoices', (SELECT count(*) FROM inv)
      ),

      'services', COALESCE((
        SELECT jsonb_agg(s.obj ORDER BY s.sort_at DESC)
        FROM (
          SELECT
            COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) AS sort_at,
            jsonb_build_object(
              'id', j.id,
              'service_type', j.service_type,
              'scheduled_datetime', j.scheduled_datetime,
              'completed_at', j.completed_at,
              'job_status', j.job_status,
              'invoice_amount', j.invoice_amount,
              'invoice_status', j.invoice_status,
              'created_at', j.created_at,
              'equipment', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', e.id,
                  'label', COALESCE(
                    NULLIF(trim(concat_ws(' ', e.make, e.model)), ''),
                    e.equipment_type
                  )
                ))
                FROM job_equipment je
                JOIN equipment e ON e.id = je.equipment_id
                WHERE je.job_id = j.id
                  AND e.customer_id = v_customer.id
              ), '[]'::jsonb)
            ) AS obj
          FROM my_jobs j
          ORDER BY COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) DESC
          LIMIT 200
        ) s
      ), '[]'::jsonb),

      'invoices', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', x.id,
          'invoice_number', x.invoice_number,
          'invoice_token', x.invoice_token,
          'status', x.status,
          'total_cents', x.total_cents,
          'due_date', x.due_date,
          'sent_at', x.sent_at,
          'paid_at', x.paid_at,
          'created_at', x.created_at
        ) ORDER BY COALESCE(x.sent_at, x.created_at) DESC)
        FROM (SELECT * FROM inv ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 200) x
      ), '[]'::jsonb),

      'memberships', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', m.id,
          'status', m.status,
          'offered_at', m.offered_at,
          'started_at', m.started_at,
          'cancelled_at', m.cancelled_at,
          'plan_name', mp.name,
          'price_cents', mp.price_cents,
          'billing_interval', mp.billing_interval,
          'benefits', mp.benefits
        ) ORDER BY m.created_at DESC)
        FROM memberships m
        LEFT JOIN membership_plans mp ON mp.id = m.plan_id
        WHERE m.user_id = v_customer.user_id
          AND v_customer.phone IS NOT NULL
          AND m.customer_phone = v_customer.phone
      ), '[]'::jsonb),

      'equipment', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', e.id,
          'equipment_type', e.equipment_type,
          'make', e.make,
          'model', e.model,
          'status', e.status,
          'install_date', e.install_date,
          'warranty_expires_at', e.warranty_expires_at,
          'last_service_date', e.last_service_date,
          'service_interval_months', e.service_interval_months,
          'service_count', (
            SELECT count(*)
            FROM job_equipment je
            JOIN my_jobs mj ON mj.id = je.job_id
            WHERE je.equipment_id = e.id AND mj.job_status = 'completed'
          )
        ) ORDER BY (e.status = 'active') DESC, e.created_at DESC)
        FROM equipment e
        WHERE e.user_id = v_customer.user_id
          AND e.customer_id = v_customer.id
          AND e.status <> 'removed'
      ), '[]'::jsonb)
    )
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_portal_history(uuid) TO anon, authenticated;
