/*
  # In-home sales presentation mode

  Tablet-first Good/Better/Best sales visits for comfort advisors, built ON TOP of
  the existing quote, tiered-estimate (quotes.options), native e-signature,
  in-person payment (job_payments) and commission-plan code. Nothing existing is
  altered except additive columns.

  ## Added
  - team_members.is_comfort_advisor   — who may run presentations (owner/admin always may)
  - jobs.visit_type                   — 'service' | 'sales_appointment'
  - leads.referred_by_team_member_id / referral_job_id — technician-generated leads
  - sales_presentations               — one row per sales appointment (outcome, sold totals)

  ## Security
  - Quotes are owner-only under RLS, so advisors (team members) never touch quotes
    directly: EVERY read/write here is a SECURITY DEFINER RPC that resolves
    get_account_owner_id() and re-checks the caller's role.
  - sales_presentations: RLS on, SELECT only (owner scope AND (own row OR manager)).
    No client INSERT/UPDATE/DELETE policy.
  - Sold totals are recomputed server-side from quotes.options; a sale requires a
    COMPLETED native e-signature on that quote.
  - Deposits (cash/check) mirror record_manual_payment so one ledger stays the truth.
*/

-- =============================================================
-- 1. COLUMNS
-- =============================================================
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_comfort_advisor boolean NOT NULL DEFAULT false;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visit_type text NOT NULL DEFAULT 'service';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_visit_type_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_visit_type_check CHECK (visit_type IN ('service', 'sales_appointment'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_jobs_sales_appointments ON jobs(user_id, scheduled_datetime) WHERE visit_type = 'sales_appointment';

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS referred_by_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_referral_job ON leads(referral_job_id) WHERE referral_job_id IS NOT NULL;

-- =============================================================
-- 2. ACCESS HELPER  ('manager' | 'advisor' | NULL)
-- =============================================================
CREATE OR REPLACE FUNCTION public._sales_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN public._is_account_manager() THEN 'manager'
    WHEN EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.account_owner_id = public.get_account_owner_id()
        AND tm.is_comfort_advisor
    ) THEN 'advisor'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public._sales_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._sales_role() TO authenticated;

-- =============================================================
-- 3. SALES_PRESENTATIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS sales_presentations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  advisor_user_id uuid NOT NULL,
  advisor_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  appointment_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'presented', 'sold', 'lost')),
  selected_option_id text,
  financing_term_months integer CHECK (financing_term_months IS NULL OR financing_term_months BETWEEN 1 AND 180),
  deposit_due_cents integer NOT NULL DEFAULT 0 CHECK (deposit_due_cents >= 0),
  sold_subtotal_cents bigint CHECK (sold_subtotal_cents IS NULL OR sold_subtotal_cents >= 0),
  sold_total_cents bigint CHECK (sold_total_cents IS NULL OR sold_total_cents >= 0),
  install_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  signature_request_id uuid,
  lost_reason text CHECK (lost_reason IS NULL OR char_length(lost_reason) <= 500),
  presented_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'sold' OR (sold_total_cents IS NOT NULL AND sold_subtotal_cents IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (deposit_due_cents <= COALESCE(sold_total_cents, 2147483647))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_presentations_job ON sales_presentations(appointment_job_id);
CREATE INDEX IF NOT EXISTS idx_sales_presentations_owner_closed ON sales_presentations(user_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_presentations_advisor ON sales_presentations(advisor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_presentations_quote ON sales_presentations(quote_id);

DROP TRIGGER IF EXISTS trigger_sales_presentations_updated_at ON sales_presentations;
CREATE TRIGGER trigger_sales_presentations_updated_at
  BEFORE UPDATE ON sales_presentations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE sales_presentations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_sales_presentations" ON sales_presentations;
CREATE POLICY "select_sales_presentations" ON sales_presentations
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND (advisor_user_id = auth.uid() OR public._sales_role() = 'manager'));

-- =============================================================
-- 4. TEAM / ACCESS
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_my_sales_access()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('role', public._sales_role(), 'member_id', public.get_my_team_member_id());
$$;

CREATE OR REPLACE FUNCTION public.list_sales_team()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public._is_account_manager() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'member_id', tm.id,
      'name', COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
      'email', tm.member_email,
      'role', tm.role,
      'is_comfort_advisor', tm.is_comfort_advisor
    ) ORDER BY COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email))
    FROM team_members tm
    WHERE tm.account_owner_id = v_owner AND tm.invite_status = 'active'
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_comfort_advisor(p_member_id uuid, p_value boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public._is_account_manager() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE team_members SET is_comfort_advisor = COALESCE(p_value, false)
  WHERE id = p_member_id AND account_owner_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

-- =============================================================
-- 5. APPOINTMENTS + TECHNICIAN-GENERATED LEADS
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_sales_appointment(
  p_customer_name text,
  p_phone text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_advisor_member_id uuid DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public._sales_role();
  v_advisor uuid := p_advisor_member_id;
  v_name text := left(btrim(COALESCE(p_customer_name, '')), 120);
  v_job uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'name_required' USING ERRCODE = 'P0001'; END IF;

  IF v_role = 'advisor' THEN
    v_advisor := public.get_my_team_member_id();
  ELSIF v_advisor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_members WHERE id = v_advisor AND account_owner_id = v_owner AND is_comfort_advisor
  ) THEN
    RAISE EXCEPTION 'invalid_advisor' USING ERRCODE = 'P0001';
  END IF;

  IF p_lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads WHERE id = p_lead_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'lead_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO jobs (user_id, lead_id, customer_id, customer_name, customer_phone, service_type, address,
                    scheduled_datetime, assigned_technician_id, job_status, visit_type, notes)
  VALUES (v_owner, p_lead_id, p_customer_id, v_name, NULLIF(left(btrim(COALESCE(p_phone, '')), 40), ''),
          'In-home sales consultation', NULLIF(left(btrim(COALESCE(p_address, '')), 300), ''),
          p_scheduled_at, v_advisor, 'scheduled', 'sales_appointment',
          NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''))
  RETURNING id INTO v_job;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_sales_lead_from_job(
  p_job_id uuid,
  p_reason text,
  p_service text DEFAULT NULL,
  p_preferred_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_lead uuid;
  v_appt uuid;
  v_reason text := left(btrim(COALESCE(p_reason, '')), 1000);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF char_length(v_reason) < 3 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public._is_account_manager() OR COALESCE(v_job.assigned_technician_id = public.get_my_team_member_id(), false)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_job.visit_type <> 'service' THEN RAISE EXCEPTION 'not_a_service_visit' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_lead FROM leads WHERE referral_job_id = p_job_id AND user_id = v_owner;
  IF v_lead IS NOT NULL THEN
    SELECT id INTO v_appt FROM jobs WHERE lead_id = v_lead AND visit_type = 'sales_appointment' ORDER BY created_at LIMIT 1;
    RETURN jsonb_build_object('lead_id', v_lead, 'appointment_job_id', v_appt, 'duplicate', true);
  END IF;

  BEGIN
    INSERT INTO leads (user_id, name, phone, service_interested, notes, stage, source, customer_id,
                       referred_by_team_member_id, referral_job_id)
    VALUES (v_owner, v_job.customer_name, v_job.customer_phone,
            NULLIF(left(btrim(COALESCE(p_service, '')), 120), ''), v_reason, 'new', 'technician_referral',
            v_job.customer_id, public.get_my_team_member_id(), p_job_id)
    RETURNING id INTO v_lead;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_lead FROM leads WHERE referral_job_id = p_job_id AND user_id = v_owner;
    SELECT id INTO v_appt FROM jobs WHERE lead_id = v_lead AND visit_type = 'sales_appointment' ORDER BY created_at LIMIT 1;
    RETURN jsonb_build_object('lead_id', v_lead, 'appointment_job_id', v_appt, 'duplicate', true);
  END;

  INSERT INTO jobs (user_id, lead_id, customer_id, customer_name, customer_phone, service_type, address,
                    scheduled_datetime, job_status, visit_type, notes)
  VALUES (v_owner, v_lead, v_job.customer_id, v_job.customer_name, v_job.customer_phone,
          'In-home sales consultation', v_job.address, p_preferred_at, 'scheduled', 'sales_appointment',
          left('Technician referral: ' || v_reason, 1000))
  RETURNING id INTO v_appt;

  BEGIN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (v_owner, 'quote_viewed', 'New sales lead from a technician',
            v_job.customer_name || ' needs a sales appointment: ' || left(v_reason, 140), '/dashboard/sales');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a notification problem must never block the referral
  END;

  RETURN jsonb_build_object('lead_id', v_lead, 'appointment_job_id', v_appt, 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_sales_appointments(p_limit integer DEFAULT 150)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public._sales_role();
  v_me uuid := public.get_my_team_member_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x.r ORDER BY x.sort_at DESC)
    FROM (
      SELECT
        COALESCE(j.scheduled_datetime, j.created_at) AS sort_at,
        jsonb_build_object(
          'job_id', j.id,
          'customer_name', j.customer_name,
          'customer_phone', j.customer_phone,
          'address', j.address,
          'scheduled_datetime', j.scheduled_datetime,
          'assigned_member_id', j.assigned_technician_id,
          'advisor_name', COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email),
          'lead_id', j.lead_id,
          'customer_id', j.customer_id,
          'notes', j.notes,
          'from_technician', (l.referral_job_id IS NOT NULL),
          'referred_by', COALESCE(NULLIF(btrim(rt.member_name), ''), rt.member_email),
          'presentation_id', sp.id,
          'presentation_status', sp.status,
          'sold_total_cents', sp.sold_total_cents
        ) AS r
      FROM jobs j
      LEFT JOIN team_members tm ON tm.id = j.assigned_technician_id
      LEFT JOIN leads l ON l.id = j.lead_id
      LEFT JOIN team_members rt ON rt.id = l.referred_by_team_member_id
      LEFT JOIN sales_presentations sp ON sp.appointment_job_id = j.id
      WHERE j.user_id = v_owner
        AND j.visit_type = 'sales_appointment'
        AND (v_role = 'manager' OR j.assigned_technician_id = v_me)
      ORDER BY COALESCE(j.scheduled_datetime, j.created_at) DESC
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 150), 300))
    ) x
  ), '[]'::jsonb);
END;
$$;

-- =============================================================
-- 6. START A PRESENTATION  (attach an existing quote OR clone a template)
-- =============================================================
CREATE OR REPLACE FUNCTION public.list_presentable_quotes(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public._sales_role();
  v_job jobs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_role IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner AND visit_type = 'sales_appointment';
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'advisor' AND v_job.assigned_technician_id IS DISTINCT FROM public.get_my_team_member_id() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'quotes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'customer_name', q.customer_name, 'status', q.status, 'created_at', q.created_at,
        'option_count', jsonb_array_length(q.options)
      ) ORDER BY q.created_at DESC)
      FROM (
        SELECT * FROM quotes
        WHERE user_id = v_owner AND status IN ('draft', 'sent')
          AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0
          AND ((v_job.lead_id IS NOT NULL AND lead_id = v_job.lead_id)
            OR (v_job.customer_id IS NOT NULL AND customer_id = v_job.customer_id))
        ORDER BY created_at DESC LIMIT 20
      ) q
    ), '[]'::jsonb),
    'templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'category', t.category) ORDER BY t.use_count DESC, t.name)
      FROM (SELECT * FROM estimate_templates WHERE user_id = v_owner ORDER BY use_count DESC LIMIT 50) t
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.start_sales_presentation(
  p_job_id uuid,
  p_quote_id uuid DEFAULT NULL,
  p_template_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public._sales_role();
  v_job jobs%ROWTYPE;
  v_existing sales_presentations%ROWTYPE;
  v_quote quotes%ROWTYPE;
  v_tpl estimate_templates%ROWTYPE;
  v_quote_id uuid;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_role IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner AND visit_type = 'sales_appointment' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'advisor' AND v_job.assigned_technician_id IS DISTINCT FROM public.get_my_team_member_id() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing FROM sales_presentations WHERE appointment_job_id = p_job_id;
  IF FOUND AND (v_existing.status <> 'draft' OR (p_quote_id IS NULL AND p_template_id IS NULL)) THEN
    RETURN v_existing.id;
  END IF;

  IF p_quote_id IS NOT NULL THEN
    SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND user_id = v_owner AND status IN ('draft', 'sent');
    IF NOT FOUND OR jsonb_typeof(v_quote.options) <> 'array' OR jsonb_array_length(v_quote.options) = 0 THEN
      RAISE EXCEPTION 'quote_not_presentable' USING ERRCODE = 'P0001';
    END IF;
    v_quote_id := v_quote.id;
  ELSIF p_template_id IS NOT NULL THEN
    SELECT * INTO v_tpl FROM estimate_templates WHERE id = p_template_id AND user_id = v_owner;
    IF NOT FOUND OR jsonb_typeof(v_tpl.options) <> 'array' OR jsonb_array_length(v_tpl.options) = 0 THEN
      RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO quotes (user_id, lead_id, customer_id, customer_name, customer_phone, tax_percent, status,
                        options, deposit_percent, presentation_note, recommended_option_id)
    VALUES (v_owner, v_job.lead_id, v_job.customer_id, v_job.customer_name, v_job.customer_phone,
            COALESCE(v_tpl.tax_percent, 0), 'draft', v_tpl.options, COALESCE(v_tpl.deposit_percent, 0),
            v_tpl.presentation_note,
            (SELECT o ->> 'id' FROM jsonb_array_elements(v_tpl.options) o WHERE o ->> 'recommended' = 'true' LIMIT 1))
    RETURNING id INTO v_quote_id;
    UPDATE estimate_templates SET use_count = use_count + 1 WHERE id = v_tpl.id;
  ELSE
    RAISE EXCEPTION 'quote_required' USING ERRCODE = 'P0001';
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE sales_presentations SET quote_id = v_quote_id WHERE id = v_existing.id;
    RETURN v_existing.id;
  END IF;

  INSERT INTO sales_presentations (user_id, advisor_user_id, advisor_member_id, appointment_job_id, lead_id, customer_id, quote_id)
  VALUES (v_owner, auth.uid(), public.get_my_team_member_id(), v_job.id, v_job.lead_id, v_job.customer_id, v_quote_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- =============================================================
-- 7. THE PRESENTATION PAYLOAD  (everything the tablet needs, one round trip)
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_sales_presentation(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public._sales_role();
  v_sp sales_presentations%ROWTYPE;
  v_job jobs%ROWTYPE;
  v_quote quotes%ROWTYPE;
  v_customer uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_role IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_sp FROM sales_presentations WHERE id = p_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'advisor' AND v_sp.advisor_user_id <> auth.uid() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_job FROM jobs WHERE id = v_sp.appointment_job_id;
  SELECT * INTO v_quote FROM quotes WHERE id = v_sp.quote_id;
  v_customer := COALESCE(v_sp.customer_id, v_job.customer_id);

  RETURN jsonb_build_object(
    'presentation', to_jsonb(v_sp),
    'job', jsonb_build_object('id', v_job.id, 'customer_name', v_job.customer_name, 'customer_phone', v_job.customer_phone,
                              'address', v_job.address, 'scheduled_datetime', v_job.scheduled_datetime),
    'quote', jsonb_build_object(
      'id', v_quote.id, 'status', v_quote.status, 'customer_name', v_quote.customer_name,
      'customer_phone', v_quote.customer_phone, 'customer_email', v_quote.customer_email,
      'options', v_quote.options, 'photos', v_quote.photos, 'tax_percent', v_quote.tax_percent,
      'deposit_percent', v_quote.deposit_percent, 'recommended_option_id', v_quote.recommended_option_id,
      'presentation_note', v_quote.presentation_note),
    'equipment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model, 'serial_number', e.serial_number,
        'install_date', e.install_date, 'warranty_expires_at', e.warranty_expires_at,
        'expected_lifespan_years', e.expected_lifespan_years, 'last_service_date', e.last_service_date, 'notes', e.notes
      ) ORDER BY e.install_date NULLS LAST)
      FROM equipment e WHERE v_customer IS NOT NULL AND e.customer_id = v_customer AND e.user_id = v_owner AND e.status = 'active'
    ), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(h) FROM (
        SELECT jsonb_build_object('id', j.id, 'service_type', j.service_type, 'job_status', j.job_status,
                                  'date', COALESCE(j.completed_at, j.scheduled_datetime, j.created_at), 'invoice_amount', j.invoice_amount) AS h
        FROM jobs j
        WHERE v_customer IS NOT NULL AND j.customer_id = v_customer AND j.user_id = v_owner
          AND j.visit_type = 'service' AND j.id <> v_job.id
        ORDER BY COALESCE(j.completed_at, j.scheduled_datetime, j.created_at) DESC LIMIT 8
      ) hh
    ), '[]'::jsonb),
    'job_photos', COALESCE((
      SELECT jsonb_agg(p) FROM (
        SELECT jsonb_build_object('id', jp.id, 'storage_path', jp.storage_path, 'caption', jp.caption, 'kind', jp.kind, 'created_at', jp.created_at) AS p
        FROM job_photos jp
        WHERE v_customer IS NOT NULL AND jp.customer_id = v_customer AND jp.user_id = v_owner
        ORDER BY jp.created_at DESC LIMIT 12
      ) pp
    ), '[]'::jsonb),
    'financing', jsonb_build_object(
      'connected', EXISTS (SELECT 1 FROM financing_connections fc WHERE fc.user_id = v_owner AND fc.status = 'connected'),
      'terms', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('term_months', t.term_months, 'apr_bps', t.apr_bps, 'samples', t.samples) ORDER BY t.term_months)
        FROM (
          SELECT fo.term_months,
                 round(percentile_cont(0.5) WITHIN GROUP (ORDER BY fo.apr_bps))::integer AS apr_bps,
                 count(*) AS samples
          FROM financing_offers fo
          WHERE fo.user_id = v_owner AND fo.status IN ('approved', 'loan_confirmed', 'funded')
            AND fo.apr_bps IS NOT NULL AND fo.term_months IS NOT NULL AND fo.term_months > 0
          GROUP BY fo.term_months ORDER BY count(*) DESC, fo.term_months LIMIT 6
        ) t
      ), '[]'::jsonb)
    ),
    'deposit_paid_cents', COALESCE((
      SELECT sum(jp.amount_cents) FROM job_payments jp WHERE jp.job_id = v_sp.install_job_id AND jp.status = 'succeeded'
    ), 0),
    'signed_request_id', (
      SELECT sr.id FROM signature_requests sr
      WHERE sr.user_id = v_owner AND sr.document_type = 'quote' AND sr.document_id = v_sp.quote_id AND sr.status = 'completed'
      ORDER BY sr.completed_at DESC NULLS LAST LIMIT 1
    )
  );
END;
$$;

-- =============================================================
-- 8. OUTCOMES
-- =============================================================
CREATE OR REPLACE FUNCTION public.mark_sales_presented(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE sales_presentations
  SET status = 'presented', presented_at = now()
  WHERE id = p_id AND user_id = public.get_account_owner_id() AND status = 'draft'
    AND (advisor_user_id = auth.uid() OR public._is_account_manager());
END;
$$;

CREATE OR REPLACE FUNCTION public.close_sales_presentation_lost(p_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_sp sales_presentations%ROWTYPE;
BEGIN
  SELECT * INTO v_sp FROM sales_presentations
  WHERE id = p_id AND user_id = public.get_account_owner_id() FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT (v_sp.advisor_user_id = auth.uid() OR public._is_account_manager()) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sp.status = 'sold' THEN RAISE EXCEPTION 'already_sold' USING ERRCODE = 'P0001'; END IF;
  IF v_sp.status = 'lost' THEN RETURN; END IF;
  UPDATE sales_presentations
  SET status = 'lost', closed_at = now(), presented_at = COALESCE(presented_at, now()),
      lost_reason = NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '')
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_sales_presentation_won(
  p_id uuid,
  p_option_id text,
  p_signature_request_id uuid,
  p_deposit_cents integer DEFAULT 0,
  p_financing_term_months integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_sp sales_presentations%ROWTYPE;
  v_quote quotes%ROWTYPE;
  v_option jsonb;
  v_subtotal bigint;
  v_total bigint;
  v_deposit integer := GREATEST(COALESCE(p_deposit_cents, 0), 0);
  v_job uuid;
  v_service text;
  v_scope text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;

  SELECT * INTO v_sp FROM sales_presentations WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR NOT (v_sp.advisor_user_id = auth.uid() OR public._is_account_manager()) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sp.status = 'sold' THEN
    RETURN jsonb_build_object('install_job_id', v_sp.install_job_id, 'total_cents', v_sp.sold_total_cents,
                              'deposit_due_cents', v_sp.deposit_due_cents, 'duplicate', true);
  END IF;
  IF v_sp.status = 'lost' THEN RAISE EXCEPTION 'already_lost' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = v_sp.quote_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR v_quote.status NOT IN ('draft', 'sent') THEN RAISE EXCEPTION 'quote_unavailable' USING ERRCODE = 'P0001'; END IF;

  SELECT o INTO v_option FROM jsonb_array_elements(v_quote.options) o WHERE o ->> 'id' = p_option_id LIMIT 1;
  IF v_option IS NULL THEN RAISE EXCEPTION 'invalid_option' USING ERRCODE = 'P0001'; END IF;

  -- A real, completed e-signature on THIS quote is mandatory.
  IF NOT EXISTS (
    SELECT 1 FROM signature_requests sr
    WHERE sr.id = p_signature_request_id AND sr.user_id = v_owner AND sr.document_type = 'quote'
      AND sr.document_id = v_quote.id AND sr.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'signature_required' USING ERRCODE = 'P0001';
  END IF;

  v_subtotal := public.quote_line_items_subtotal_cents(v_option -> 'line_items');
  v_total := public.quote_option_total_cents(v_quote.options, p_option_id, v_quote.tax_percent);
  IF v_total IS NULL OR v_total <= 0 THEN RAISE EXCEPTION 'invalid_option' USING ERRCODE = 'P0001'; END IF;
  IF v_deposit > v_total THEN RAISE EXCEPTION 'deposit_exceeds_total' USING ERRCODE = 'P0001'; END IF;

  v_service := NULLIF(left(btrim(COALESCE(v_option ->> 'name', '')), 120), '');
  SELECT string_agg(li ->> 'description', '; ') INTO v_scope FROM jsonb_array_elements(COALESCE(v_option -> 'line_items', '[]'::jsonb)) li;

  UPDATE quotes
  SET status = 'accepted', responded_at = now(), selected_option_id = p_option_id, accepted_total_cents = v_total::integer
  WHERE id = v_quote.id;

  INSERT INTO quote_events (quote_id, user_id, event_type, option_id, metadata)
  VALUES (v_quote.id, v_owner, 'accepted', p_option_id,
          jsonb_build_object('total_cents', v_total, 'in_home', true, 'presentation_id', v_sp.id));

  IF v_sp.lead_id IS NOT NULL THEN
    UPDATE leads SET stage = 'won', quote_amount = round(v_total / 100.0) WHERE id = v_sp.lead_id AND user_id = v_owner;
  END IF;

  SELECT id INTO v_job FROM jobs WHERE quote_id = v_quote.id AND user_id = v_owner ORDER BY created_at LIMIT 1;
  IF v_job IS NULL THEN
    INSERT INTO jobs (user_id, lead_id, customer_id, customer_name, customer_phone, service_type, address,
                      job_status, invoice_status, invoice_amount, quote_id, dispatch_note)
    SELECT v_owner, v_sp.lead_id, COALESCE(v_sp.customer_id, aj.customer_id), aj.customer_name, aj.customer_phone,
           v_service, aj.address, 'scheduled', 'not_sent', round(v_total / 100.0, 2), v_quote.id,
           NULLIF(left('Sold in-home. Scope: ' || COALESCE(v_scope, ''), 500), 'Sold in-home. Scope: ')
    FROM jobs aj WHERE aj.id = v_sp.appointment_job_id
    RETURNING id INTO v_job;
  END IF;

  UPDATE sales_presentations
  SET status = 'sold', selected_option_id = p_option_id, signature_request_id = p_signature_request_id,
      sold_subtotal_cents = v_subtotal, sold_total_cents = v_total, deposit_due_cents = v_deposit,
      financing_term_months = p_financing_term_months, install_job_id = v_job,
      presented_at = COALESCE(presented_at, now()), closed_at = now()
  WHERE id = v_sp.id;

  BEGIN
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (v_owner, 'quote_viewed', 'In-home sale closed',
            v_quote.customer_name || ' signed an in-home estimate worth $' || to_char(round(v_total / 100.0), 'FM999,999,990') || '.',
            '/dashboard/sales');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object('install_job_id', v_job, 'total_cents', v_total, 'deposit_due_cents', v_deposit, 'duplicate', false);
END;
$$;

-- =============================================================
-- 9. DEPOSIT (cash / check) — same ledger + invariants as record_manual_payment
-- =============================================================
CREATE OR REPLACE FUNCTION public.record_sale_deposit(
  p_presentation_id uuid,
  p_method text,
  p_amount_cents integer,
  p_client_request_id uuid,
  p_check_number text DEFAULT NULL,
  p_check_bank text DEFAULT NULL,
  p_check_payer text DEFAULT NULL,
  p_tendered_cents integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_sp sales_presentations%ROWTYPE;
  v_paid bigint;
  v_check text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'unauthenticated'); END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'check') THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_method'); END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_sp FROM sales_presentations WHERE id = p_presentation_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND OR NOT (v_sp.advisor_user_id = auth.uid() OR public._is_account_manager()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF v_sp.status <> 'sold' OR v_sp.install_job_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_sold'); END IF;

  IF p_client_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM job_payments WHERE user_id = v_owner AND client_request_id = p_client_request_id
  ) THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true);
  END IF;

  SELECT COALESCE(sum(amount_cents), 0) INTO v_paid FROM job_payments WHERE job_id = v_sp.install_job_id AND status = 'succeeded';
  IF v_paid + p_amount_cents > v_sp.sold_total_cents THEN
    RETURN jsonb_build_object('success', false, 'error', 'exceeds_balance', 'balance_cents', GREATEST(v_sp.sold_total_cents - v_paid, 0));
  END IF;

  IF p_method = 'check' THEN
    v_check := upper(btrim(COALESCE(p_check_number, '')));
    IF v_check !~ '^[A-Z0-9-]{1,20}$' THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_check_number'); END IF;
  ELSE
    v_check := NULL;
    IF p_tendered_cents IS NOT NULL AND p_tendered_cents < p_amount_cents THEN
      RETURN jsonb_build_object('success', false, 'error', 'tendered_less_than_amount');
    END IF;
  END IF;

  BEGIN
    INSERT INTO job_payments (user_id, job_id, method, status, amount_cents, tendered_cents, recorded_by_member_id,
                              recorded_by_user_id, note, check_number, check_bank, check_payer_name, deposit_status, client_request_id)
    VALUES (v_owner, v_sp.install_job_id, p_method, 'succeeded', p_amount_cents,
            CASE WHEN p_method = 'cash' THEN COALESCE(p_tendered_cents, p_amount_cents) ELSE NULL END,
            public.get_my_team_member_id(), auth.uid(), 'In-home sale deposit', v_check,
            NULLIF(btrim(COALESCE(p_check_bank, '')), ''), NULLIF(btrim(COALESCE(p_check_payer, '')), ''),
            'undeposited', p_client_request_id)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_check_number');
  END;

  PERFORM public._sync_job_invoice_status(v_sp.install_job_id);
  RETURN jsonb_build_object('success', true, 'payment_id', v_id,
                            'balance_cents', GREATEST(v_sp.sold_total_cents - v_paid - p_amount_cents, 0));
END;
$$;

-- =============================================================
-- 10. PERFORMANCE — close rate, average ticket, commission inputs by advisor
--     Managers see everyone; advisors see only themselves.
--     Commission is evaluated client-side with the SAME engine (resolveCommission).
-- =============================================================
CREATE OR REPLACE FUNCTION public.get_sales_performance(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_role text := public._sales_role();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR v_role IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start OR p_end - p_start > 731 THEN
    RAISE EXCEPTION 'invalid_range' USING ERRCODE = 'P0001';
  END IF;

  RETURN (
    WITH scoped AS (
      SELECT sp.* FROM sales_presentations sp
      WHERE sp.user_id = v_owner AND (v_role = 'manager' OR sp.advisor_user_id = auth.uid())
    ), agg AS (
      SELECT s.advisor_user_id,
             (array_agg(s.advisor_member_id) FILTER (WHERE s.advisor_member_id IS NOT NULL))[1] AS member_id,
             count(*) FILTER (WHERE s.created_at::date BETWEEN p_start AND p_end) AS appointments,
             count(*) FILTER (WHERE s.presented_at::date BETWEEN p_start AND p_end) AS presented,
             count(*) FILTER (WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end) AS sold,
             count(*) FILTER (WHERE s.status = 'lost' AND s.closed_at::date BETWEEN p_start AND p_end) AS lost,
             COALESCE(sum(s.sold_subtotal_cents) FILTER (WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end), 0) AS sold_subtotal_cents,
             COALESCE(sum(s.sold_total_cents) FILTER (WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end), 0) AS sold_total_cents,
             count(*) FILTER (WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end AND s.financing_term_months IS NOT NULL) AS financed,
             COALESCE(sum(s.deposit_due_cents) FILTER (WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end), 0) AS deposit_due_cents
      FROM scoped s GROUP BY s.advisor_user_id
    ), dep AS (
      SELECT s.advisor_user_id, COALESCE(sum(jp.amount_cents), 0) AS cents
      FROM scoped s JOIN job_payments jp ON jp.job_id = s.install_job_id AND jp.status = 'succeeded'
      WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end
      GROUP BY s.advisor_user_id
    ), rows AS (
      SELECT a.*, COALESCE(d.cents, 0) AS deposit_collected_cents,
             COALESCE(NULLIF(btrim(tm.member_name), ''), tm.member_email, pr.full_name, pr.email, 'Advisor') AS name,
             e.commission_rate_percent AS employee_rate_percent,
             pl.tier_mode, pl.tier_period,
             (SELECT jsonb_agg(jsonb_build_object('min_cents', t.min_cents, 'rate_percent', t.rate_percent) ORDER BY t.min_cents)
                FROM commission_plan_tiers t WHERE t.plan_id = pl.id) AS tiers
      FROM agg a
      LEFT JOIN dep d ON d.advisor_user_id = a.advisor_user_id
      LEFT JOIN team_members tm ON tm.id = a.member_id
      LEFT JOIN profiles pr ON pr.id = a.advisor_user_id
      LEFT JOIN employees e ON e.user_id = v_owner AND e.team_member_id = a.member_id AND e.active
      LEFT JOIN LATERAL (
        SELECT cp.id, cp.tier_mode, cp.tier_period FROM commission_plans cp
        WHERE e.id IS NOT NULL AND cp.user_id = v_owner AND cp.active AND (cp.id = e.commission_plan_id OR cp.is_default)
        ORDER BY (cp.id = e.commission_plan_id) DESC NULLS LAST LIMIT 1
      ) pl ON true
    )
    SELECT jsonb_build_object(
      'role', v_role,
      'advisors', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'advisor_user_id', r.advisor_user_id, 'name', r.name,
          'appointments', r.appointments, 'presented', r.presented, 'sold', r.sold, 'lost', r.lost,
          'sold_subtotal_cents', r.sold_subtotal_cents, 'sold_total_cents', r.sold_total_cents,
          'financed', r.financed, 'deposit_due_cents', r.deposit_due_cents, 'deposit_collected_cents', r.deposit_collected_cents,
          'employee_rate_percent', r.employee_rate_percent,
          'plan', CASE WHEN r.tier_mode IS NULL OR r.tiers IS NULL THEN NULL
                       ELSE jsonb_build_object('mode', r.tier_mode, 'period', r.tier_period, 'tiers', r.tiers) END
        ) ORDER BY r.sold_total_cents DESC) FROM rows r
      ), '[]'::jsonb),
      'sales', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('advisor_user_id', s.advisor_user_id, 'closed_at', s.closed_at, 'subtotal_cents', s.sold_subtotal_cents) ORDER BY s.closed_at)
        FROM scoped s WHERE s.status = 'sold' AND s.closed_at::date BETWEEN p_start AND p_end
      ), '[]'::jsonb)
    )
  );
END;
$$;

-- =============================================================
-- 11. GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.get_my_sales_access() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_sales_team() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_comfort_advisor(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_sales_appointment(text, text, text, timestamptz, uuid, uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_sales_lead_from_job(uuid, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_sales_appointments(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_presentable_quotes(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_sales_presentation(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sales_presentation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_sales_presented(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_sales_presentation_lost(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_sales_presentation_won(uuid, text, uuid, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_sale_deposit(uuid, text, integer, uuid, text, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sales_performance(date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_my_sales_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_sales_team() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_comfort_advisor(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_appointment(text, text, text, timestamptz, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_lead_from_job(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_sales_appointments(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_presentable_quotes(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_sales_presentation(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_presentation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_sales_presented(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_sales_presentation_lost(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_sales_presentation_won(uuid, text, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_sale_deposit(uuid, text, integer, uuid, text, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_performance(date, date) TO authenticated;

COMMENT ON TABLE sales_presentations IS
  'One row per in-home sales appointment presentation. Written only by SECURITY DEFINER RPCs; sold totals are recomputed server-side from quotes.options and require a completed native e-signature.';
