/*
  # CSR phone-desk screen-pop

  One round-trip, RLS-enforced lookup that powers the live CSR desk
  (/dashboard/csr-desk): given a call, return the customer record, open jobs,
  equipment, outstanding balance, open quotes, the previous conversation and
  durable customer memory.

  Design notes
  - SECURITY INVOKER: every table read goes through the caller's RLS
    (`user_id = get_account_owner_id()`), so a CSR can never see another
    account's data even if the call id is guessed.
  - Phone matching uses `phone_key()` (last 10 digits) so "+1 (555) 010-2030",
    "5550102030" and "15550102030" are the same customer. The functional
    indexes below keep the lookup index-driven.
  - Live calls need no new table: the existing Vapi webhook already upserts a
    `calls` row on the first status-update, and `calls` is already in the
    `supabase_realtime` publication. "Live" == duration_seconds IS NULL and
    started in the last 45 minutes.
  - `csr_call_actions` is an append-only audit trail for desk actions
    (book / quote / transfer).
*/

-- ---------------------------------------------------------------- phone_key

CREATE OR REPLACE FUNCTION public.phone_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) < 7 THEN NULL
    ELSE right(regexp_replace(p, '\D', '', 'g'), 10)
  END
$$;

CREATE INDEX IF NOT EXISTS idx_customers_phone_key ON public.customers (user_id, public.phone_key(phone));
CREATE INDEX IF NOT EXISTS idx_jobs_phone_key ON public.jobs (user_id, public.phone_key(customer_phone));
CREATE INDEX IF NOT EXISTS idx_invoices_phone_key ON public.invoices (user_id, public.phone_key(customer_phone));
CREATE INDEX IF NOT EXISTS idx_quotes_phone_key ON public.quotes (user_id, public.phone_key(customer_phone));
CREATE INDEX IF NOT EXISTS idx_calls_phone_key ON public.calls (user_id, public.phone_key(caller_phone), call_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_customer_memory_phone_key ON public.customer_memory (user_id, public.phone_key(customer_phone), created_at DESC);

-- Fast "who is on the phone right now" scan for the realtime queue.
CREATE INDEX IF NOT EXISTS idx_calls_live
  ON public.calls (user_id, call_datetime DESC)
  WHERE duration_seconds IS NULL AND is_voicemail = false;

-- ---------------------------------------------------------------- audit trail

CREATE TABLE IF NOT EXISTS public.csr_call_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid DEFAULT auth.uid(),
  call_id uuid REFERENCES public.calls(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('book', 'quote', 'transfer')),
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_csr_call_actions_user ON public.csr_call_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_csr_call_actions_call ON public.csr_call_actions (call_id);

ALTER TABLE public.csr_call_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_csr_call_actions" ON public.csr_call_actions;
CREATE POLICY "select_own_csr_call_actions" ON public.csr_call_actions
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "insert_own_csr_call_actions" ON public.csr_call_actions;
CREATE POLICY "insert_own_csr_call_actions" ON public.csr_call_actions
  FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id());

-- ---------------------------------------------------------------- screen-pop RPC

CREATE OR REPLACE FUNCTION public.csr_screen_pop(p_call_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_call public.calls%ROWTYPE;
  v_key text;
  v_customer public.customers%ROWTYPE;
  v_has_customer boolean := false;
  v_balance jsonb;
BEGIN
  SELECT * INTO v_call FROM public.calls WHERE id = p_call_id;  -- RLS applies
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_key := public.phone_key(v_call.caller_phone);

  IF v_key IS NOT NULL THEN
    SELECT c.* INTO v_customer
    FROM public.customers c
    WHERE c.user_id = v_call.user_id AND public.phone_key(c.phone) = v_key
    ORDER BY c.updated_at DESC
    LIMIT 1;
    v_has_customer := FOUND;
  END IF;

  -- Outstanding balance across sent/viewed invoices (line items + tax).
  SELECT jsonb_build_object(
    'outstanding_cents', coalesce(sum(t.total_cents), 0)::bigint,
    'overdue_cents', coalesce(sum(t.total_cents) FILTER (WHERE t.due_date < current_date), 0)::bigint,
    'open_invoice_count', count(*)::int,
    'oldest_due_date', min(t.due_date)
  )
  INTO v_balance
  FROM (
    SELECT
      i.due_date,
      round(
        coalesce((
          SELECT sum(coalesce((li->>'quantity')::numeric, 0) * coalesce((li->>'unit_price_cents')::numeric, 0))
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.line_items) = 'array' THEN i.line_items ELSE '[]'::jsonb END) li
        ), 0) * (1 + coalesce(i.tax_percent, 0) / 100)
      )::bigint AS total_cents
    FROM public.invoices i
    WHERE i.user_id = v_call.user_id
      AND i.status IN ('sent', 'viewed')
      AND (
        (v_key IS NOT NULL AND public.phone_key(i.customer_phone) = v_key)
        OR (v_has_customer AND i.job_id IN (SELECT j.id FROM public.jobs j WHERE j.customer_id = v_customer.id))
      )
  ) t;

  RETURN jsonb_build_object(
    'matched', v_has_customer,
    'customer', CASE WHEN v_has_customer THEN jsonb_build_object(
        'id', v_customer.id, 'name', v_customer.name, 'phone', v_customer.phone, 'email', v_customer.email,
        'address', v_customer.address, 'customer_type', v_customer.customer_type,
        'lifecycle_stage', v_customer.lifecycle_stage, 'tags', to_jsonb(v_customer.tags), 'notes', v_customer.notes
      ) ELSE NULL END,

    'open_jobs', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.scheduled_datetime NULLS LAST)
      FROM (
        SELECT j.id, j.service_type, j.job_status, j.scheduled_datetime, j.address, j.eta_minutes,
               j.warranty_expires_at, j.completed_at
        FROM public.jobs j
        WHERE j.user_id = v_call.user_id
          AND j.job_status IN ('scheduled', 'en_route', 'in_progress')
          AND ((v_has_customer AND j.customer_id = v_customer.id)
               OR (v_key IS NOT NULL AND public.phone_key(j.customer_phone) = v_key))
        ORDER BY j.scheduled_datetime NULLS LAST
        LIMIT 5
      ) x
    ), '[]'::jsonb),

    'recent_jobs', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.completed_at DESC NULLS LAST)
      FROM (
        SELECT j.id, j.service_type, j.job_status, j.scheduled_datetime, j.address, j.eta_minutes,
               j.warranty_expires_at, j.completed_at
        FROM public.jobs j
        WHERE j.user_id = v_call.user_id
          AND j.job_status = 'completed'
          AND ((v_has_customer AND j.customer_id = v_customer.id)
               OR (v_key IS NOT NULL AND public.phone_key(j.customer_phone) = v_key))
        ORDER BY j.completed_at DESC NULLS LAST
        LIMIT 5
      ) x
    ), '[]'::jsonb),

    'equipment', CASE WHEN v_has_customer THEN coalesce((
      SELECT jsonb_agg(to_jsonb(x))
      FROM (
        SELECT e.id, e.equipment_type, e.make, e.model, e.install_date, e.warranty_expires_at,
               e.expected_lifespan_years, e.service_interval_months, e.last_service_date
        FROM public.equipment e
        WHERE e.user_id = v_call.user_id AND e.customer_id = v_customer.id AND e.status = 'active'
        ORDER BY e.install_date DESC NULLS LAST
        LIMIT 8
      ) x
    ), '[]'::jsonb) ELSE '[]'::jsonb END,

    'balance', coalesce(v_balance, jsonb_build_object(
      'outstanding_cents', 0, 'overdue_cents', 0, 'open_invoice_count', 0, 'oldest_due_date', NULL)),

    'open_quotes', coalesce((
      SELECT jsonb_agg(to_jsonb(x))
      FROM (
        SELECT q.id, q.status, q.sent_at, q.ai_detected_issue,
               coalesce(q.accepted_total_cents, round(
                 coalesce((
                   SELECT sum(coalesce((li->>'quantity')::numeric, 0) * coalesce((li->>'unit_price_cents')::numeric, 0))
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.line_items) = 'array' THEN q.line_items ELSE '[]'::jsonb END) li
                 ), 0) * (1 + coalesce(q.tax_percent, 0) / 100)
               ))::bigint AS total_cents
        FROM public.quotes q
        WHERE q.user_id = v_call.user_id
          AND q.status IN ('draft', 'sent')
          AND v_key IS NOT NULL AND public.phone_key(q.customer_phone) = v_key
        ORDER BY q.created_at DESC
        LIMIT 3
      ) x
    ), '[]'::jsonb),

    'last_conversation', (
      SELECT jsonb_build_object(
        'call_id', pc.id, 'call_datetime', pc.call_datetime, 'summary', pc.summary,
        'sentiment', pc.sentiment, 'intent', pc.intent, 'recommended_follow_up', pc.recommended_follow_up,
        'objections_raised', coalesce(to_jsonb(pc.objections_raised), '[]'::jsonb),
        'objections_resolved', pc.objections_resolved, 'duration_seconds', pc.duration_seconds)
      FROM public.calls pc
      WHERE v_key IS NOT NULL
        AND pc.user_id = v_call.user_id
        AND pc.id <> v_call.id
        AND pc.duration_seconds IS NOT NULL
        AND public.phone_key(pc.caller_phone) = v_key
      ORDER BY pc.call_datetime DESC
      LIMIT 1
    ),

    'memory', CASE WHEN v_key IS NULL THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('category', m.category, 'fact', m.fact))
      FROM (
        SELECT cm.category, cm.fact
        FROM public.customer_memory cm
        WHERE cm.user_id = v_call.user_id AND public.phone_key(cm.customer_phone) = v_key
        ORDER BY cm.created_at DESC
        LIMIT 5
      ) m
    ), '[]'::jsonb) END,

    'history', jsonb_build_object(
      'total_calls', (
        SELECT count(*)::int FROM public.calls hc
        WHERE v_key IS NOT NULL AND hc.user_id = v_call.user_id AND hc.id <> v_call.id
          AND public.phone_key(hc.caller_phone) = v_key
      ),
      'last_call_at', (
        SELECT max(hc.call_datetime) FROM public.calls hc
        WHERE v_key IS NOT NULL AND hc.user_id = v_call.user_id AND hc.id <> v_call.id
          AND public.phone_key(hc.caller_phone) = v_key
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.csr_screen_pop(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.csr_screen_pop(uuid) TO authenticated;
