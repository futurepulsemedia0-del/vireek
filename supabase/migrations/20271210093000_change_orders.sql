/*
  # Change Orders — scope/price changes on jobs and install projects, with customer approval and invoice impact

  A change order (CO) is a priced, customer-approved modification to work already sold:
  extra scope, an unforeseen condition, a code requirement, or a credit.

  ## What it reuses (nothing is duplicated)
  - `jobs` / `install_projects` -> a CO belongs to a job and/or a project (at least one)
  - `customers`                 -> customer snapshot (name/email/phone stay on the CO even if the customer is edited)
  - `invoices`                  -> invoicing an approved CO creates a normal invoice (INV-xxxx numbering,
                                   public /invoice/:token page, payments, reminders — all existing behaviour)
  - `business_profile`          -> per-account counter for CO-0001, CO-0002 ... (same pattern as invoices / projects)

  ## Rules (mirrored 1:1 in src/lib/changeOrders.ts — change one, change the other)
  - Money = integer cents. line total = round(quantity * unit_price_cents) (half away from zero);
    subtotal = sum(line totals); tax = round(subtotal * tax_percent / 100); total = subtotal + tax.
    Totals are computed by a trigger and can never be written by a client.
  - Lifecycle: draft -> sent -> approved | declined | cancelled.  (draft -> approved/declined is allowed ONLY for a
    staff-recorded in-person / phone / email decision.)  declined and cancelled are final: create a new CO instead.
  - Once a CO has left draft its content is LOCKED (title, scope, lines, tax, schedule, customer snapshot).
    A SHA-256 fingerprint of that content is stored at send time and echoed in the approval event, so
    "what exactly did the customer approve?" always has a provable answer.
  - A sent link expires (default 14 days, 1-90). Expiry is derived (status = 'sent' AND expires_at <= now()), no cron needed.
    Sending again after expiry issues a fresh window on the same link.
  - Invoice impact: an approved CO with total > 0 becomes its OWN invoice. Existing invoices are never modified —
    sent invoices are tax-locked and draft invoices may carry a tax snapshot, so appending lines is unsafe.
    A credit CO (total < 0) lowers the revised contract value; it is not invoiced (no negative invoices).
  - Fractional quantities are billed exactly: the invoice line becomes quantity 1 with the CO line total.

  ## Safety
  - change_orders and change_order_events are written ONLY by SECURITY DEFINER RPCs/triggers (no client write policies,
    write privileges revoked).
  - The events table is an append-only audit trail (UPDATE always blocked).
  - Every RPC re-checks the account owner (get_account_owner_id) and the billing permission.
  - The two public RPCs expose only customer-safe fields (never internal notes, ids, or other COs) and are token-gated.

  ## Deploy
    1. Run this migration (idempotent, additive, no destructive statements).
    2. Apply the code edits delivered with it. No edge function is required.
*/

-- =============================================================
-- 0. Permission helper (owner, or team member with can_view_billing — same rule as Install Projects)
-- =============================================================

CREATE OR REPLACE FUNCTION public.can_manage_change_orders()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.custom_roles cr ON cr.id = tm.custom_role_id
      WHERE tm.member_email = (SELECT u.email FROM auth.users u WHERE u.id = auth.uid())
        AND (
          COALESCE(tm.permissions ->> 'can_view_billing', 'false') = 'true'
          OR COALESCE(cr.permissions ->> 'can_view_billing', 'false') = 'true'
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_change_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_change_orders() TO authenticated;

ALTER TABLE public.business_profile ADD COLUMN IF NOT EXISTS change_order_seq integer NOT NULL DEFAULT 0;

-- =============================================================
-- 1. Money helpers
-- =============================================================

-- Validates AND normalises a line-items array. Raises 'invalid_line_items' on anything unexpected.
-- Output lines contain exactly {description, quantity, unit_price_cents}.
CREATE OR REPLACE FUNCTION public.change_order_normalize_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  e jsonb;
  v_out jsonb := '[]'::jsonb;
  v_desc text;
  v_qty numeric;
  v_unit numeric;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'invalid_line_items';
  END IF;

  FOR e IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(e) <> 'object'
       OR jsonb_typeof(e -> 'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e -> 'quantity') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e -> 'unit_price_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_line_items';
    END IF;

    v_desc := btrim(e ->> 'description');
    v_qty := (e ->> 'quantity')::numeric;
    v_unit := (e ->> 'unit_price_cents')::numeric;

    IF length(v_desc) NOT BETWEEN 1 AND 200
       OR v_qty <= 0 OR v_qty > 100000 OR v_qty <> round(v_qty, 2)
       OR v_unit <> trunc(v_unit) OR abs(v_unit) > 100000000
       OR abs(round(v_qty * v_unit)) > 1000000000 THEN
      RAISE EXCEPTION 'invalid_line_items';
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'description', v_desc,
      'quantity', trim_scale(v_qty),
      'unit_price_cents', v_unit::bigint
    ));
  END LOOP;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.change_order_items_valid(p_items jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  PERFORM public.change_order_normalize_items(p_items);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.change_order_totals(
  p_items jsonb,
  p_tax_percent numeric,
  OUT subtotal_cents bigint,
  OUT tax_cents bigint,
  OUT total_cents bigint
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  SELECT COALESCE(SUM(round((e ->> 'quantity')::numeric * (e ->> 'unit_price_cents')::numeric)), 0)::bigint
    INTO subtotal_cents
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS e;
  tax_cents := round(subtotal_cents * COALESCE(p_tax_percent, 0) / 100)::bigint;
  total_cents := subtotal_cents + tax_cents;
END;
$$;

-- =============================================================
-- 2. Tables
-- =============================================================

CREATE TABLE IF NOT EXISTS public.change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  co_number text,
  job_id uuid REFERENCES public.jobs(id),
  project_id uuid REFERENCES public.install_projects(id),
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 160),
  customer_email text CHECK (customer_email IS NULL OR length(customer_email) <= 254),
  customer_phone text CHECK (customer_phone IS NULL OR length(customer_phone) <= 40),
  site_address text CHECK (site_address IS NULL OR length(site_address) <= 300),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  reason text NOT NULL DEFAULT 'customer_request'
    CHECK (reason IN ('customer_request', 'unforeseen_condition', 'code_requirement', 'design_change', 'scope_correction', 'other')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  internal_notes text NOT NULL DEFAULT '' CHECK (length(internal_notes) <= 4000),
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (public.change_order_items_valid(line_items)),
  tax_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 30),
  subtotal_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  schedule_impact_days integer NOT NULL DEFAULT 0 CHECK (schedule_impact_days BETWEEN -365 AND 365),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'approved', 'declined', 'cancelled')),
  approval_token uuid NOT NULL DEFAULT gen_random_uuid(),
  content_hash text,
  sent_at timestamptz,
  expires_at timestamptz,
  viewed_at timestamptz,
  responded_at timestamptz,
  approval_method text CHECK (approval_method IS NULL OR approval_method IN ('online', 'in_person', 'phone', 'email', 'other')),
  approver_name text CHECK (approver_name IS NULL OR length(btrim(approver_name)) BETWEEN 1 AND 160),
  response_note text CHECK (response_note IS NULL OR length(response_note) <= 2000),
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  invoiced_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT change_orders_has_parent CHECK (job_id IS NOT NULL OR project_id IS NOT NULL),
  CONSTRAINT change_orders_response_complete CHECK (
    status NOT IN ('approved', 'declined') OR (responded_at IS NOT NULL AND approval_method IS NOT NULL)
  ),
  CONSTRAINT change_orders_approved_has_name CHECK (status <> 'approved' OR approver_name IS NOT NULL),
  CONSTRAINT change_orders_sent_has_fingerprint CHECK (
    status NOT IN ('sent', 'approved', 'declined') OR (sent_at IS NOT NULL AND content_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_orders_token ON public.change_orders (approval_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_orders_number ON public.change_orders (user_id, co_number) WHERE co_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_change_orders_user_status ON public.change_orders (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_orders_job ON public.change_orders (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_change_orders_project ON public.change_orders (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_change_orders_invoice ON public.change_orders (invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.change_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  change_order_id uuid NOT NULL REFERENCES public.change_orders(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN ('created', 'sent', 'resent', 'viewed', 'approved', 'declined', 'cancelled', 'invoiced')),
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'customer', 'system')),
  actor_id uuid,
  actor_name text CHECK (actor_name IS NULL OR length(actor_name) <= 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_change_order_events_co ON public.change_order_events (change_order_id, created_at);

-- =============================================================
-- 3. Triggers
-- =============================================================

CREATE OR REPLACE FUNCTION public.change_orders_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
  t record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NULL THEN NEW.user_id := public.get_account_owner_id(); END IF;
    IF NEW.user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'invalid_status_transition'; END IF;
    IF NEW.co_number IS NULL OR NEW.co_number = '' THEN
      INSERT INTO business_profile (user_id, change_order_seq) VALUES (NEW.user_id, 1)
      ON CONFLICT (user_id) DO UPDATE SET change_order_seq = business_profile.change_order_seq + 1
      RETURNING change_order_seq INTO v_seq;
      NEW.co_number := 'CO-' || lpad(v_seq::text, 4, '0');
    END IF;
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.approval_token IS DISTINCT FROM OLD.approval_token
       OR NEW.co_number IS DISTINCT FROM OLD.co_number THEN
      RAISE EXCEPTION 'change_order_locked';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled', 'approved', 'declined'))
      OR (OLD.status = 'sent' AND NEW.status IN ('approved', 'declined', 'cancelled'))
      OR (OLD.status = 'approved' AND NEW.status = 'cancelled')
    ) THEN
      RAISE EXCEPTION 'invalid_status_transition';
    END IF;

    -- Content is frozen the moment the CO leaves draft. (customer_id / invoice_id are deliberately NOT here:
    -- ON DELETE SET NULL from customers / invoices must keep working.)
    IF OLD.status <> 'draft' AND (
         NEW.job_id IS DISTINCT FROM OLD.job_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
      OR NEW.customer_email IS DISTINCT FROM OLD.customer_email
      OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
      OR NEW.site_address IS DISTINCT FROM OLD.site_address
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.line_items IS DISTINCT FROM OLD.line_items
      OR NEW.tax_percent IS DISTINCT FROM OLD.tax_percent
      OR NEW.schedule_impact_days IS DISTINCT FROM OLD.schedule_impact_days
      OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
      OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
      OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
    ) THEN
      RAISE EXCEPTION 'change_order_locked';
    END IF;

    -- A recorded decision is permanent.
    IF OLD.responded_at IS NOT NULL AND (
         NEW.responded_at IS DISTINCT FROM OLD.responded_at
      OR NEW.approver_name IS DISTINCT FROM OLD.approver_name
      OR NEW.approval_method IS DISTINCT FROM OLD.approval_method
      OR NEW.response_note IS DISTINCT FROM OLD.response_note
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    ) THEN
      RAISE EXCEPTION 'change_order_locked';
    END IF;
  END IF;

  -- Parents must belong to the same account (and a cancelled project cannot take new change orders).
  IF NEW.job_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.job_id IS DISTINCT FROM OLD.job_id) THEN
    IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = NEW.job_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'job_not_found';
    END IF;
  END IF;
  IF NEW.project_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    IF NOT EXISTS (SELECT 1 FROM install_projects WHERE id = NEW.project_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'project_not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM install_projects WHERE id = NEW.project_id AND status = 'cancelled') THEN
      RAISE EXCEPTION 'project_cancelled';
    END IF;
  END IF;
  IF NEW.customer_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id AND user_id = NEW.user_id) THEN
      NEW.customer_id := NULL;
    END IF;
  END IF;

  SELECT * INTO t FROM public.change_order_totals(NEW.line_items, NEW.tax_percent);
  NEW.subtotal_cents := t.subtotal_cents;
  NEW.tax_cents := t.tax_cents;
  NEW.total_cents := t.total_cents;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_change_orders_guard ON public.change_orders;
CREATE TRIGGER trg_change_orders_guard
  BEFORE INSERT OR UPDATE ON public.change_orders
  FOR EACH ROW EXECUTE FUNCTION public.change_orders_guard();

CREATE OR REPLACE FUNCTION public.change_order_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'change_order_events_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_change_order_events_no_update ON public.change_order_events;
CREATE TRIGGER trg_change_order_events_no_update
  BEFORE UPDATE ON public.change_order_events
  FOR EACH ROW EXECUTE FUNCTION public.change_order_events_append_only();

-- =============================================================
-- 4. Row level security — read-only from the client; writes go through RPCs
-- =============================================================

ALTER TABLE public.change_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_order_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_change_orders" ON public.change_orders;
CREATE POLICY "select_change_orders" ON public.change_orders FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_change_orders());

DROP POLICY IF EXISTS "select_change_order_events" ON public.change_order_events;
CREATE POLICY "select_change_order_events" ON public.change_order_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_change_orders());

REVOKE ALL ON public.change_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.change_order_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.change_orders TO authenticated;
GRANT SELECT ON public.change_order_events TO authenticated;

-- =============================================================
-- 5. Internal helpers
-- =============================================================

-- Best-effort request metadata for the signature audit trail (PostgREST exposes headers as a GUC).
CREATE OR REPLACE FUNCTION public.change_order_request_meta()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  h jsonb;
BEGIN
  BEGIN
    h := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    h := NULL;
  END;
  IF h IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ip', NULLIF(btrim(split_part(COALESCE(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
    'user_agent', NULLIF(left(COALESCE(h ->> 'user-agent', ''), 300), '')
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.change_order_log(
  p_change_order_id uuid,
  p_type text,
  p_actor_type text,
  p_actor_name text,
  p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO change_order_events (user_id, change_order_id, event_type, actor_type, actor_id, actor_name, detail)
  SELECT co.user_id, co.id, p_type, p_actor_type,
         CASE WHEN p_actor_type = 'staff' THEN auth.uid() ELSE NULL END,
         left(p_actor_name, 200), COALESCE(p_detail, '{}'::jsonb)
    FROM change_orders co WHERE co.id = p_change_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.change_order_log(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.change_order_fingerprint(co public.change_orders)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    co.co_number, co.title, co.reason, co.description, co.line_items::text,
    co.tax_percent::text, co.schedule_impact_days::text, co.total_cents::text,
    co.customer_name, COALESCE(co.site_address, '')
  ), 'UTF8')), 'hex');
$$;

REVOKE ALL ON FUNCTION public.change_order_fingerprint(public.change_orders) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.change_order_actor_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT u.email::text FROM auth.users u WHERE u.id = auth.uid()), 'Staff');
$$;

REVOKE ALL ON FUNCTION public.change_order_actor_name() FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 6. Staff RPCs
-- =============================================================

-- Create (p_id NULL) or update a DRAFT. Payload keys (all optional on update):
--   job_id, project_id (create only), title, reason, description, internal_notes, line_items, tax_percent,
--   schedule_impact_days, customer_name, customer_email, customer_phone, site_address
CREATE OR REPLACE FUNCTION public.save_change_order(p_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  co change_orders%ROWTYPE;
  v_job uuid;
  v_project uuid;
  v_customer uuid;
  v_name text;
  v_email text;
  v_phone text;
  v_site text;
  v_title text;
  v_reason text := 'customer_request';
  v_desc text := '';
  v_notes text := '';
  v_items jsonb := '[]'::jsonb;
  v_tax numeric := 0;
  v_days integer := 0;
  v_id uuid;
  r record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_change_orders() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO co FROM change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
    IF co.status <> 'draft' THEN RAISE EXCEPTION 'change_order_locked'; END IF;
    v_title := co.title; v_reason := co.reason; v_desc := co.description; v_notes := co.internal_notes;
    v_items := co.line_items; v_tax := co.tax_percent; v_days := co.schedule_impact_days;
    v_name := co.customer_name; v_email := co.customer_email; v_phone := co.customer_phone; v_site := co.site_address;
    v_customer := co.customer_id;
  ELSE
    BEGIN
      v_job := NULLIF(p_payload ->> 'job_id', '')::uuid;
      v_project := NULLIF(p_payload ->> 'project_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_payload';
    END;
    IF v_job IS NULL AND v_project IS NULL THEN RAISE EXCEPTION 'parent_required'; END IF;

    IF v_project IS NOT NULL THEN
      SELECT id, customer_id, customer_name, site_address, status INTO r
        FROM install_projects WHERE id = v_project AND user_id = v_owner;
      IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
      IF r.status = 'cancelled' THEN RAISE EXCEPTION 'project_cancelled'; END IF;
      v_customer := r.customer_id; v_name := r.customer_name; v_site := r.site_address;
    END IF;
    IF v_job IS NOT NULL THEN
      SELECT id, customer_id, customer_name, address INTO r
        FROM jobs WHERE id = v_job AND user_id = v_owner;
      IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found'; END IF;
      v_customer := COALESCE(v_customer, r.customer_id);
      v_name := COALESCE(v_name, r.customer_name);
      v_site := COALESCE(v_site, r.address);
    END IF;
    IF v_customer IS NOT NULL THEN
      SELECT email, phone INTO v_email, v_phone FROM customers WHERE id = v_customer AND user_id = v_owner;
    END IF;
  END IF;

  IF p_payload ? 'title' THEN v_title := btrim(COALESCE(p_payload ->> 'title', '')); END IF;
  IF p_payload ? 'reason' THEN v_reason := COALESCE(p_payload ->> 'reason', ''); END IF;
  IF p_payload ? 'description' THEN v_desc := btrim(COALESCE(p_payload ->> 'description', '')); END IF;
  IF p_payload ? 'internal_notes' THEN v_notes := btrim(COALESCE(p_payload ->> 'internal_notes', '')); END IF;
  IF p_payload ? 'customer_name' THEN v_name := btrim(COALESCE(p_payload ->> 'customer_name', '')); END IF;
  IF p_payload ? 'customer_email' THEN v_email := NULLIF(btrim(COALESCE(p_payload ->> 'customer_email', '')), ''); END IF;
  IF p_payload ? 'customer_phone' THEN v_phone := NULLIF(btrim(COALESCE(p_payload ->> 'customer_phone', '')), ''); END IF;
  IF p_payload ? 'site_address' THEN v_site := NULLIF(btrim(COALESCE(p_payload ->> 'site_address', '')), ''); END IF;
  IF p_payload ? 'line_items' THEN v_items := public.change_order_normalize_items(p_payload -> 'line_items'); END IF;
  BEGIN
    IF p_payload ? 'tax_percent' THEN v_tax := COALESCE(NULLIF(p_payload ->> 'tax_percent', ''), '0')::numeric; END IF;
    IF p_payload ? 'schedule_impact_days' THEN
      v_days := COALESCE(NULLIF(p_payload ->> 'schedule_impact_days', ''), '0')::numeric::integer;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid_payload';
  END;

  IF v_title IS NULL OR length(v_title) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'invalid_title'; END IF;
  IF v_reason NOT IN ('customer_request', 'unforeseen_condition', 'code_requirement', 'design_change', 'scope_correction', 'other') THEN
    RAISE EXCEPTION 'invalid_reason';
  END IF;
  IF length(v_desc) > 4000 OR length(v_notes) > 4000 THEN RAISE EXCEPTION 'text_too_long'; END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'customer_required'; END IF;
  IF v_email IS NOT NULL AND (length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') THEN RAISE EXCEPTION 'invalid_email'; END IF;
  IF v_phone IS NOT NULL AND length(v_phone) > 40 THEN RAISE EXCEPTION 'invalid_phone'; END IF;
  IF v_site IS NOT NULL AND length(v_site) > 300 THEN RAISE EXCEPTION 'text_too_long'; END IF;
  IF v_tax < 0 OR v_tax > 30 THEN RAISE EXCEPTION 'invalid_tax'; END IF;
  IF v_days < -365 OR v_days > 365 THEN RAISE EXCEPTION 'invalid_schedule'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO change_orders (
      user_id, job_id, project_id, customer_id, customer_name, customer_email, customer_phone, site_address,
      title, reason, description, internal_notes, line_items, tax_percent, schedule_impact_days
    ) VALUES (
      v_owner, v_job, v_project, v_customer, v_name, v_email, v_phone, v_site,
      v_title, v_reason, v_desc, v_notes, v_items, v_tax, v_days
    ) RETURNING id INTO v_id;
    PERFORM public.change_order_log(v_id, 'created', 'staff', public.change_order_actor_name(), '{}'::jsonb);
    RETURN v_id;
  END IF;

  UPDATE change_orders SET
    customer_name = v_name, customer_email = v_email, customer_phone = v_phone, site_address = v_site,
    title = v_title, reason = v_reason, description = v_desc, internal_notes = v_notes,
    line_items = v_items, tax_percent = v_tax, schedule_impact_days = v_days
  WHERE id = p_id;
  RETURN p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_change_order(p_id uuid, p_expires_in_days integer DEFAULT 14)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  co change_orders%ROWTYPE;
  v_resend boolean;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_change_orders() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'invalid_expiry'; END IF;

  SELECT * INTO co FROM change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;

  v_resend := co.status = 'sent';
  IF co.status = 'sent' AND (co.expires_at IS NULL OR co.expires_at > now()) THEN
    RAISE EXCEPTION 'change_order_already_sent';
  END IF;
  IF co.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'change_order_closed'; END IF;
  IF jsonb_array_length(co.line_items) = 0 THEN RAISE EXCEPTION 'no_line_items'; END IF;

  UPDATE change_orders SET
    status = 'sent',
    sent_at = now(),
    expires_at = now() + make_interval(days => p_expires_in_days),
    content_hash = public.change_order_fingerprint(co)
  WHERE id = co.id;

  PERFORM public.change_order_log(co.id, CASE WHEN v_resend THEN 'resent' ELSE 'sent' END, 'staff',
    public.change_order_actor_name(), jsonb_build_object('expires_in_days', p_expires_in_days, 'total_cents', co.total_cents));
  RETURN co.approval_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_change_order(p_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  co change_orders%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_change_orders() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN RAISE EXCEPTION 'text_too_long'; END IF;

  SELECT * INTO co FROM change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status NOT IN ('draft', 'sent', 'approved') THEN RAISE EXCEPTION 'change_order_closed'; END IF;
  IF co.status <> 'draft' AND v_reason IS NULL THEN RAISE EXCEPTION 'reason_required'; END IF;
  IF co.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = co.invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'change_order_invoiced';
  END IF;

  UPDATE change_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason WHERE id = co.id;
  PERFORM public.change_order_log(co.id, 'cancelled', 'staff', public.change_order_actor_name(),
    jsonb_build_object('reason', v_reason, 'was', co.status));
END;
$$;

-- Staff records a decision the customer gave outside the portal (on site, by phone, by email).
CREATE OR REPLACE FUNCTION public.record_change_order_decision(
  p_id uuid,
  p_decision text,
  p_approver_name text,
  p_method text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  co change_orders%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_approver_name, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_change_orders() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_decision NOT IN ('approved', 'declined') THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('in_person', 'phone', 'email', 'other') THEN RAISE EXCEPTION 'invalid_method'; END IF;
  IF p_decision = 'approved' AND (v_name IS NULL OR length(v_name) < 2) THEN RAISE EXCEPTION 'name_required'; END IF;
  IF v_name IS NOT NULL AND length(v_name) > 160 THEN RAISE EXCEPTION 'text_too_long'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'text_too_long'; END IF;

  SELECT * INTO co FROM change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'change_order_closed'; END IF;
  IF jsonb_array_length(co.line_items) = 0 THEN RAISE EXCEPTION 'no_line_items'; END IF;

  UPDATE change_orders SET
    status = p_decision,
    sent_at = COALESCE(sent_at, now()),
    content_hash = COALESCE(content_hash, public.change_order_fingerprint(co)),
    responded_at = now(),
    approval_method = p_method,
    approver_name = COALESCE(v_name, co.customer_name),
    response_note = v_note
  WHERE id = co.id;

  PERFORM public.change_order_log(co.id, p_decision, 'staff', public.change_order_actor_name(),
    jsonb_build_object('method', p_method, 'approver_name', COALESCE(v_name, co.customer_name),
      'total_cents', co.total_cents, 'content_hash', COALESCE(co.content_hash, public.change_order_fingerprint(co))));
END;
$$;

-- Approved CO with a positive total -> its own invoice (existing invoices are never modified).
CREATE OR REPLACE FUNCTION public.invoice_change_order(p_id uuid, p_due_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  co change_orders%ROWTYPE;
  v_quote uuid;
  v_items jsonb := '[]'::jsonb;
  e jsonb;
  v_qty numeric;
  v_unit numeric;
  v_label text;
  v_inv uuid;
  v_inv_no text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_change_orders() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT * INTO co FROM change_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status <> 'approved' THEN RAISE EXCEPTION 'change_order_not_approved'; END IF;
  IF co.total_cents <= 0 THEN RAISE EXCEPTION 'change_order_not_billable'; END IF;
  IF co.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = co.invoice_id AND status <> 'void') THEN
    RAISE EXCEPTION 'already_invoiced';
  END IF;

  FOR e IN SELECT value FROM jsonb_array_elements(co.line_items) LOOP
    v_qty := (e ->> 'quantity')::numeric;
    v_unit := (e ->> 'unit_price_cents')::numeric;
    IF v_qty = trunc(v_qty) THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'description', co.co_number || ' · ' || (e ->> 'description'),
        'quantity', v_qty::bigint,
        'unit_price_cents', v_unit::bigint));
    ELSE
      v_label := co.co_number || ' · ' || (e ->> 'description') || ' (' || trim_scale(v_qty)::text || ' × '
                 || to_char(v_unit / 100.0, 'FM999,999,990.00') || ')';
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'description', left(v_label, 400),
        'quantity', 1,
        'unit_price_cents', round(v_qty * v_unit)::bigint));
    END IF;
  END LOOP;

  IF co.project_id IS NOT NULL THEN
    SELECT quote_id INTO v_quote FROM install_projects WHERE id = co.project_id AND user_id = v_owner;
  END IF;

  INSERT INTO invoices (user_id, job_id, quote_id, customer_id, customer_name, customer_email, customer_phone,
                        line_items, tax_percent, notes, due_date)
  VALUES (v_owner, co.job_id, v_quote, co.customer_id, co.customer_name, co.customer_email, co.customer_phone,
          v_items, co.tax_percent,
          'Change order ' || co.co_number || ' — ' || co.title
            || ' (approved by ' || COALESCE(co.approver_name, co.customer_name) || ' on ' || to_char(co.responded_at, 'YYYY-MM-DD') || ')',
          p_due_date)
  RETURNING id, invoice_number INTO v_inv, v_inv_no;

  UPDATE change_orders SET invoice_id = v_inv, invoiced_at = now() WHERE id = co.id;
  PERFORM public.change_order_log(co.id, 'invoiced', 'staff', public.change_order_actor_name(),
    jsonb_build_object('invoice_id', v_inv, 'invoice_number', v_inv_no, 'total_cents', co.total_cents));
  RETURN v_inv;
END;
$$;

-- =============================================================
-- 7. Public (token-gated) RPCs — customer-safe fields only
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_change_order_for_token(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  co change_orders%ROWTYPE;
  v_business text;
  v_ref text;
BEGIN
  IF p_token IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO co FROM change_orders WHERE approval_token = p_token AND status <> 'draft';
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT company_name INTO v_business FROM profiles WHERE id = co.user_id;
  IF co.project_id IS NOT NULL THEN
    SELECT COALESCE(project_number || ' · ', '') || name INTO v_ref FROM install_projects WHERE id = co.project_id;
  ELSIF co.job_id IS NOT NULL THEN
    SELECT COALESCE(service_type, 'Service job') INTO v_ref FROM jobs WHERE id = co.job_id;
  END IF;

  RETURN jsonb_build_object(
    'number', co.co_number,
    'title', co.title,
    'reason', co.reason,
    'description', co.description,
    'line_items', co.line_items,
    'tax_percent', co.tax_percent,
    'subtotal_cents', co.subtotal_cents,
    'tax_cents', co.tax_cents,
    'total_cents', co.total_cents,
    'schedule_impact_days', co.schedule_impact_days,
    'status', CASE WHEN co.status = 'sent' AND co.expires_at IS NOT NULL AND co.expires_at <= now() THEN 'expired' ELSE co.status END,
    'sent_at', co.sent_at,
    'expires_at', co.expires_at,
    'responded_at', co.responded_at,
    'approver_name', co.approver_name,
    'customer_name', co.customer_name,
    'site_address', co.site_address,
    'reference', v_ref,
    'business_name', v_business
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_change_order_view(p_token uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_token IS NULL THEN RETURN; END IF;
  UPDATE change_orders SET viewed_at = now()
   WHERE approval_token = p_token AND status = 'sent' AND viewed_at IS NULL
   RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    PERFORM public.change_order_log(v_id, 'viewed', 'customer', NULL, public.change_order_request_meta());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_change_order_by_token(
  p_token uuid,
  p_decision text,
  p_name text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  co change_orders%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF p_token IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;
  IF p_decision = 'approved' AND (v_name IS NULL OR length(v_name) < 2) THEN RAISE EXCEPTION 'name_required'; END IF;
  IF v_name IS NOT NULL AND length(v_name) > 160 THEN RAISE EXCEPTION 'text_too_long'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'text_too_long'; END IF;

  SELECT * INTO co FROM change_orders WHERE approval_token = p_token AND status <> 'draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_order_not_found'; END IF;
  IF co.status <> 'sent' THEN RAISE EXCEPTION 'change_order_closed'; END IF;
  IF co.expires_at IS NOT NULL AND co.expires_at <= now() THEN RAISE EXCEPTION 'change_order_expired'; END IF;

  UPDATE change_orders SET
    status = p_decision,
    responded_at = now(),
    approval_method = 'online',
    approver_name = COALESCE(v_name, 'Customer'),
    response_note = v_note,
    viewed_at = COALESCE(viewed_at, now())
  WHERE id = co.id;

  PERFORM public.change_order_log(co.id, p_decision, 'customer', COALESCE(v_name, 'Customer'),
    public.change_order_request_meta() || jsonb_build_object('method', 'online', 'total_cents', co.total_cents, 'content_hash', co.content_hash));

  RETURN jsonb_build_object('status', p_decision);
END;
$$;

-- =============================================================
-- 8. Grants
-- =============================================================

REVOKE ALL ON FUNCTION public.save_change_order(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_change_order(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_change_order(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_change_order_decision(uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invoice_change_order(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_change_order(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_change_order(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_change_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_change_order_decision(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_change_order(uuid, date) TO authenticated;

REVOKE ALL ON FUNCTION public.get_change_order_for_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_change_order_view(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_change_order_by_token(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_change_order_for_token(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_change_order_view(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_change_order_by_token(uuid, text, text, text) TO anon, authenticated;

COMMENT ON TABLE public.change_orders IS
  'Customer-approved scope/price changes on jobs and install projects. Written only by RPCs; content locks once sent.';
COMMENT ON TABLE public.change_order_events IS
  'Append-only audit trail for change orders (created, sent, viewed, approved, declined, cancelled, invoiced).';
