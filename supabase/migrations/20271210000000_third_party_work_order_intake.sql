/*
  # Third-party work-order intake (warranty / insurance / manufacturer / property-manager jobs)

  ## What this adds
  - `third_party_payers`            per-tenant partner config: SLA targets, intake token, email alias tag,
                                    sender domains, default NTE, "authorization required" switch. Owner-only
                                    (the token is a credential).
  - `third_party_work_orders`       one row per request received by email or API. Written ONLY by edge functions
                                    (service role) and by the `third_party_wo_act` RPC. Tenants can read, never write.
  - `third_party_work_order_events` immutable audit trail (received / accepted / authorized / SLA alerts ...).
  - `third_party_wo_act(...)`       the single SECURITY DEFINER entry point for every human action
                                    (accept, decline, request_info, resume, quote, authorize, deny_authorization,
                                    schedule, complete, cancel, edit). Accepting creates the commercial
                                    `work_orders` row (PO = payer reference, NTE = authorized amount) and
                                    scheduling creates/moves its first visit, so the existing Work Orders page,
                                    NTE cap and billing rules apply unchanged.
  - `third_party_intake_sla_sweep()` service-role only: at-risk / breached notifications + 30-day raw payload purge.

  ## Approval steps (enforced in the database, not only the UI)
  1. Acceptance decision      new -> accepted | declined | awaiting_payer
  2. Payer authorization      pending -> authorized | denied (not_required when the partner needs none)
  3. Work cannot be scheduled or completed until authorization is authorized / not_required
  Status machine: new -> accepted -> scheduled -> completed; awaiting_payer pauses the SLA clock and resumes
  to the exact previous status (due dates shift by the paused time). Terminal: declined, cancelled, completed.

  ## SLA (frozen per request at intake, so changing a partner later never rewrites history)
  accept_due_at   = received + accept_within_minutes
  schedule_due_at = received + schedule_within_hours (never later than complete_due_at)
  complete_due_at = payer-supplied deadline, else received + complete_within_hours
  priority caps:  urgent  -> accept <= 60 min, schedule <= 12 h, complete <= 48 h
                  emergency -> accept <= 30 min, schedule <= 4 h,  complete <= 24 h
  "At risk" = 25% or less of the current stage window left (same rule as the UI).

  ## Security
  RLS everywhere. Reads need `public.can_manage_work_orders()` (same billing gate as Work Orders).
  Partner config: `auth.uid()` (owner only). Not added to supabase_realtime on purpose.
*/

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 1. PARTNERS (payers)
-- =============================================================
CREATE TABLE IF NOT EXISTS third_party_payers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'home_warranty'
    CHECK (kind IN ('home_warranty', 'insurance', 'manufacturer', 'property_manager', 'other')),
  enabled boolean NOT NULL DEFAULT true,
  email_tag text CHECK (email_tag IS NULL OR email_tag ~ '^[a-z0-9]{2,24}$'),
  sender_domains text[] NOT NULL DEFAULT '{}' CHECK (cardinality(sender_domains) <= 20),
  accept_within_minutes integer NOT NULL DEFAULT 120 CHECK (accept_within_minutes BETWEEN 5 AND 10080),
  schedule_within_hours integer NOT NULL DEFAULT 24 CHECK (schedule_within_hours BETWEEN 1 AND 720),
  complete_within_hours integer NOT NULL DEFAULT 72 CHECK (complete_within_hours BETWEEN 1 AND 2160),
  default_nte_cents integer CHECK (default_nte_cents IS NULL OR default_nte_cents >= 0),
  require_authorization boolean NOT NULL DEFAULT true,
  intake_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT third_party_payers_sla_order_chk CHECK (schedule_within_hours <= complete_within_hours)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tpp_user_name ON third_party_payers(user_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_tpp_user_tag ON third_party_payers(user_id, email_tag) WHERE email_tag IS NOT NULL;

ALTER TABLE third_party_payers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tpp_select_owner" ON third_party_payers;
CREATE POLICY "tpp_select_owner" ON third_party_payers FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "tpp_insert_owner" ON third_party_payers;
CREATE POLICY "tpp_insert_owner" ON third_party_payers FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "tpp_update_owner" ON third_party_payers;
CREATE POLICY "tpp_update_owner" ON third_party_payers FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "tpp_delete_owner" ON third_party_payers;
CREATE POLICY "tpp_delete_owner" ON third_party_payers FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS trigger_touch_third_party_payers ON third_party_payers;
CREATE TRIGGER trigger_touch_third_party_payers
  BEFORE UPDATE ON third_party_payers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- 2. INTAKE REQUESTS
-- =============================================================
CREATE TABLE IF NOT EXISTS third_party_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  payer_id uuid REFERENCES third_party_payers(id) ON DELETE SET NULL,
  payer_name text NOT NULL CHECK (char_length(btrim(payer_name)) BETWEEN 1 AND 120),
  received_via text NOT NULL CHECK (received_via IN ('email', 'api')),
  external_ref text CHECK (external_ref IS NULL OR char_length(external_ref) <= 120),
  dedupe_key text NOT NULL,

  priority text NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard', 'urgent', 'emergency')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 5000),
  service_type text CHECK (service_type IS NULL OR char_length(service_type) <= 120),
  customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 40),
  customer_email text CHECK (customer_email IS NULL OR char_length(customer_email) <= 200),
  service_address text CHECK (service_address IS NULL OR char_length(service_address) <= 300),
  policy_number text CHECK (policy_number IS NULL OR char_length(policy_number) <= 120),
  nte_cents integer CHECK (nte_cents IS NULL OR nte_cents >= 0),
  quoted_cents integer CHECK (quoted_cents IS NULL OR quoted_cents >= 0),

  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'awaiting_payer', 'accepted', 'declined', 'scheduled', 'completed', 'cancelled')),
  needs_review boolean NOT NULL DEFAULT false,
  review_reasons text[] NOT NULL DEFAULT '{}',

  authorization_status text NOT NULL DEFAULT 'pending'
    CHECK (authorization_status IN ('not_required', 'pending', 'authorized', 'denied')),
  authorization_ref text CHECK (authorization_ref IS NULL OR char_length(authorization_ref) <= 120),
  authorized_cents integer CHECK (authorized_cents IS NULL OR authorized_cents >= 0),
  authorized_at timestamptz,

  decline_reason text CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 2000),
  scheduled_for timestamptz,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,

  received_at timestamptz NOT NULL DEFAULT now(),
  accept_due_at timestamptz,
  schedule_due_at timestamptz,
  complete_due_at timestamptz,
  responded_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  paused_at timestamptz,
  paused_from_status text CHECK (paused_from_status IS NULL OR paused_from_status IN ('new', 'accepted', 'scheduled')),
  risk_alerted_stages text[] NOT NULL DEFAULT '{}',
  breach_alerted_stages text[] NOT NULL DEFAULT '{}',

  raw_payload text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_tpwo_user_received ON third_party_work_orders(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpwo_user_status ON third_party_work_orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tpwo_payer ON third_party_work_orders(payer_id) WHERE payer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tpwo_work_order ON third_party_work_orders(work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tpwo_sla_sweep ON third_party_work_orders(status)
  WHERE status IN ('new', 'accepted', 'scheduled');

-- =============================================================
-- 3. AUDIT TRAIL
-- =============================================================
CREATE TABLE IF NOT EXISTS third_party_work_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  intake_id uuid NOT NULL REFERENCES third_party_work_orders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tpwoe_intake ON third_party_work_order_events(intake_id, created_at);

-- =============================================================
-- 4. TRIGGER: integrity, SLA freeze, status machine, approval gate
-- =============================================================
CREATE OR REPLACE FUNCTION public.third_party_wo_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p record;
  v_accept_min integer := 120;
  v_sched_h integer := 24;
  v_comp_h integer := 72;
  v_require_auth boolean := true;
  v_shift interval;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.received_at := COALESCE(NEW.received_at, now());

    IF NEW.payer_id IS NOT NULL THEN
      SELECT * INTO p FROM third_party_payers WHERE id = NEW.payer_id AND user_id = NEW.user_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Partner does not belong to this account' USING ERRCODE = '42501';
      END IF;
      v_accept_min := p.accept_within_minutes;
      v_sched_h := p.schedule_within_hours;
      v_comp_h := p.complete_within_hours;
      v_require_auth := p.require_authorization;
    END IF;

    IF NEW.priority = 'emergency' THEN
      v_accept_min := LEAST(v_accept_min, 30);
      v_sched_h := LEAST(v_sched_h, 4);
      v_comp_h := LEAST(v_comp_h, 24);
    ELSIF NEW.priority = 'urgent' THEN
      v_accept_min := LEAST(v_accept_min, 60);
      v_sched_h := LEAST(v_sched_h, 12);
      v_comp_h := LEAST(v_comp_h, 48);
    END IF;

    -- A payer-supplied deadline wins when it is in the future relative to receipt.
    IF NEW.complete_due_at IS NULL OR NEW.complete_due_at <= NEW.received_at THEN
      NEW.complete_due_at := NEW.received_at + make_interval(hours => v_comp_h);
    END IF;
    NEW.schedule_due_at := LEAST(
      COALESCE(NEW.schedule_due_at, NEW.received_at + make_interval(hours => v_sched_h)),
      NEW.complete_due_at
    );
    NEW.accept_due_at := LEAST(
      COALESCE(NEW.accept_due_at, NEW.received_at + make_interval(mins => v_accept_min)),
      NEW.schedule_due_at
    );

    -- Intake always starts clean, whatever the sender claimed.
    NEW.status := 'new';
    NEW.responded_at := NULL;
    NEW.accepted_at := NULL;
    NEW.completed_at := NULL;
    NEW.paused_at := NULL;
    NEW.paused_from_status := NULL;
    NEW.work_order_id := NULL;
    NEW.scheduled_for := NULL;
    NEW.decline_reason := NULL;
    NEW.risk_alerted_stages := '{}';
    NEW.breach_alerted_stages := '{}';

    IF NOT v_require_auth THEN
      NEW.authorization_status := 'not_required';
      NEW.authorized_cents := NULL;
      NEW.authorized_at := NULL;
    ELSIF NEW.authorization_status = 'authorized' THEN
      NEW.authorized_cents := COALESCE(NEW.authorized_cents, NEW.nte_cents);
      NEW.authorized_at := now();
    ELSE
      NEW.authorization_status := 'pending';
      NEW.authorized_cents := NULL;
      NEW.authorized_at := NULL;
    END IF;

    RETURN NEW;
  END IF;

  -- ---------------- UPDATE ----------------
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A request cannot be moved to another account' USING ERRCODE = '42501';
  END IF;
  NEW.received_at := OLD.received_at;
  NEW.received_via := OLD.received_via;
  NEW.dedupe_key := OLD.dedupe_key;
  -- payer_id may only be cleared (ON DELETE SET NULL when a partner is removed), never re-pointed.
  IF NEW.payer_id IS NOT NULL AND NEW.payer_id IS DISTINCT FROM OLD.payer_id THEN
    NEW.payer_id := OLD.payer_id;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'new' AND NEW.status IN ('accepted', 'declined', 'awaiting_payer', 'cancelled'))
      OR (OLD.status = 'accepted' AND NEW.status IN ('scheduled', 'completed', 'awaiting_payer', 'cancelled'))
      OR (OLD.status = 'scheduled' AND NEW.status IN ('accepted', 'completed', 'awaiting_payer', 'cancelled'))
      OR (OLD.status = 'awaiting_payer' AND NEW.status IN ('declined', 'cancelled'))
      OR (OLD.status = 'awaiting_payer' AND NEW.status = OLD.paused_from_status)
    ) THEN
      RAISE EXCEPTION 'Cannot move a work order request from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status IN ('scheduled', 'completed')
       AND NEW.authorization_status NOT IN ('authorized', 'not_required') THEN
      RAISE EXCEPTION 'Payer authorization is required before this work can be scheduled or completed'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'scheduled' AND NEW.scheduled_for IS NULL THEN
      RAISE EXCEPTION 'Choose a date and time to schedule this work' USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'declined' AND char_length(btrim(COALESCE(NEW.decline_reason, ''))) < 3 THEN
      RAISE EXCEPTION 'A decline reason is required' USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'new' AND NEW.responded_at IS NULL THEN
      NEW.responded_at := now();
    END IF;
    IF NEW.status = 'accepted' AND NEW.accepted_at IS NULL THEN
      NEW.accepted_at := now();
    END IF;
    IF NEW.status = 'completed' THEN
      NEW.completed_at := now();
    END IF;

    -- SLA pause: "waiting on payer" stops the clock; resuming shifts every deadline by the paused time.
    IF NEW.status = 'awaiting_payer' THEN
      NEW.paused_at := now();
      NEW.paused_from_status := OLD.status;
    ELSIF OLD.status = 'awaiting_payer' THEN
      IF NEW.status = OLD.paused_from_status AND OLD.paused_at IS NOT NULL THEN
        v_shift := now() - OLD.paused_at;
        NEW.accept_due_at := OLD.accept_due_at + v_shift;
        NEW.schedule_due_at := OLD.schedule_due_at + v_shift;
        NEW.complete_due_at := OLD.complete_due_at + v_shift;
      END IF;
      NEW.paused_at := NULL;
      NEW.paused_from_status := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_third_party_wo_before_write ON third_party_work_orders;
CREATE TRIGGER trigger_third_party_wo_before_write
  BEFORE INSERT OR UPDATE ON third_party_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.third_party_wo_before_write();

DROP TRIGGER IF EXISTS trigger_touch_third_party_work_orders ON third_party_work_orders;
CREATE TRIGGER trigger_touch_third_party_work_orders
  BEFORE UPDATE ON third_party_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- After insert: audit "received" + owner notification. A notification failure must NEVER lose a work order.
CREATE OR REPLACE FUNCTION public.third_party_wo_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min integer;
BEGIN
  INSERT INTO third_party_work_order_events (user_id, intake_id, kind, to_status, note)
  VALUES (NEW.user_id, NEW.id, 'received', 'new', 'Received via ' || NEW.received_via);

  BEGIN
    v_min := GREATEST(1, round(extract(epoch FROM (NEW.accept_due_at - NEW.received_at)) / 60)::integer);
    INSERT INTO notifications (user_id, type, title, message, action_url)
    VALUES (
      NEW.user_id,
      'third_party_work_order',
      'New work order from ' || NEW.payer_name,
      left(NEW.title, 120) || ' - respond within '
        || CASE WHEN v_min >= 120 THEN (v_min / 60)::text || ' h' ELSE v_min::text || ' min' END || '.',
      '/dashboard/third-party-intake'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_third_party_wo_after_insert ON third_party_work_orders;
CREATE TRIGGER trigger_third_party_wo_after_insert
  AFTER INSERT ON third_party_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.third_party_wo_after_insert();

-- =============================================================
-- 5. RLS (read-only for tenants; writes go through the RPC / edge functions)
-- =============================================================
ALTER TABLE third_party_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE third_party_work_order_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tpwo_select_account" ON third_party_work_orders;
CREATE POLICY "tpwo_select_account" ON third_party_work_orders FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

DROP POLICY IF EXISTS "tpwoe_select_account" ON third_party_work_order_events;
CREATE POLICY "tpwoe_select_account" ON third_party_work_order_events FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_work_orders());

-- =============================================================
-- 6. RPC: every human action
-- =============================================================
CREATE OR REPLACE FUNCTION public.third_party_wo_act(
  p_id uuid,
  p_action text,
  p_note text DEFAULT NULL,
  p_amount_cents integer DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_when timestamptz DEFAULT NULL,
  p_fields jsonb DEFAULT NULL
)
RETURNS third_party_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row third_party_work_orders;
  v_prev text;
  v_wo uuid;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_approval text;
  v_event_note text;
  v_nte text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_work_orders() THEN
    RAISE EXCEPTION 'You do not have permission to do that' USING ERRCODE = '42501';
  END IF;
  IF p_amount_cents IS NOT NULL AND p_amount_cents < 0 THEN
    RAISE EXCEPTION 'Amount cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'Note is too long (2000 characters max)' USING ERRCODE = '22023';
  END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 120 THEN
    RAISE EXCEPTION 'Reference is too long (120 characters max)' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM third_party_work_orders WHERE id = p_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work order request not found' USING ERRCODE = 'P0002';
  END IF;
  v_prev := v_row.status;

  IF v_row.status IN ('declined', 'cancelled', 'completed') THEN
    RAISE EXCEPTION 'This request is already closed (%)', v_row.status USING ERRCODE = '23514';
  END IF;

  CASE p_action
    WHEN 'accept' THEN
      IF v_row.work_order_id IS NULL THEN
        v_approval := CASE v_row.authorization_status
          WHEN 'authorized' THEN 'approved'
          WHEN 'not_required' THEN 'not_required'
          WHEN 'denied' THEN 'rejected'
          ELSE 'pending' END;
        INSERT INTO work_orders (
          user_id, title, description, po_number, status, approval_status, approver_name,
          site_address, site_contact_name, site_contact_phone, site_contact_email, not_to_exceed_cents
        ) VALUES (
          v_owner,
          left(v_row.title, 200),
          left('Source: ' || v_row.payer_name || COALESCE(' - Ref ' || v_row.external_ref, '')
               || E'\n\n' || COALESCE(v_row.description, ''), 5000),
          v_row.external_ref,
          'draft',
          v_approval,
          CASE WHEN v_approval = 'approved' THEN v_row.payer_name END,
          v_row.service_address,
          v_row.customer_name,
          v_row.customer_phone,
          v_row.customer_email,
          COALESCE(v_row.authorized_cents, v_row.nte_cents)
        ) RETURNING id INTO v_wo;
        v_row.work_order_id := v_wo;
      END IF;
      v_row.status := 'accepted';

    WHEN 'decline' THEN
      IF v_note IS NULL OR char_length(v_note) < 3 THEN
        RAISE EXCEPTION 'A decline reason is required' USING ERRCODE = '23514';
      END IF;
      v_row.decline_reason := v_note;
      v_row.status := 'declined';

    WHEN 'request_info' THEN
      v_row.status := 'awaiting_payer';

    WHEN 'resume' THEN
      IF v_row.status <> 'awaiting_payer' THEN
        RAISE EXCEPTION 'This request is not waiting on the payer' USING ERRCODE = '23514';
      END IF;
      v_row.status := v_row.paused_from_status;

    WHEN 'quote' THEN
      IF p_amount_cents IS NULL THEN
        RAISE EXCEPTION 'Enter the quoted amount' USING ERRCODE = '22023';
      END IF;
      v_row.quoted_cents := p_amount_cents;

    WHEN 'authorize' THEN
      v_row.authorization_status := 'authorized';
      v_row.authorized_cents := COALESCE(p_amount_cents, v_row.authorized_cents, v_row.nte_cents);
      v_row.authorization_ref := COALESCE(v_ref, v_row.authorization_ref);
      v_row.authorized_at := now();

    WHEN 'deny_authorization' THEN
      IF v_row.authorization_status = 'not_required' THEN
        RAISE EXCEPTION 'This partner does not require authorization' USING ERRCODE = '23514';
      END IF;
      v_row.authorization_status := 'denied';
      v_row.authorized_cents := NULL;
      v_row.authorized_at := NULL;

    WHEN 'schedule' THEN
      IF p_when IS NULL THEN
        RAISE EXCEPTION 'Choose a date and time to schedule this work' USING ERRCODE = '23514';
      END IF;
      IF v_row.status NOT IN ('accepted', 'scheduled') THEN
        RAISE EXCEPTION 'Accept this request before scheduling it' USING ERRCODE = '23514';
      END IF;
      v_row.scheduled_for := p_when;
      v_row.status := 'scheduled';

    WHEN 'complete' THEN
      v_row.status := 'completed';

    WHEN 'cancel' THEN
      v_row.status := 'cancelled';

    WHEN 'edit' THEN
      IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RAISE EXCEPTION 'Nothing to update' USING ERRCODE = '22023';
      END IF;
      IF p_fields->'title' IS NOT NULL THEN
        v_row.title := NULLIF(btrim(COALESCE(p_fields->>'title', '')), '');
        IF v_row.title IS NULL THEN
          RAISE EXCEPTION 'Title is required' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF p_fields->'customer_name' IS NOT NULL THEN v_row.customer_name := NULLIF(btrim(COALESCE(p_fields->>'customer_name', '')), ''); END IF;
      IF p_fields->'customer_phone' IS NOT NULL THEN v_row.customer_phone := NULLIF(btrim(COALESCE(p_fields->>'customer_phone', '')), ''); END IF;
      IF p_fields->'customer_email' IS NOT NULL THEN v_row.customer_email := NULLIF(btrim(COALESCE(p_fields->>'customer_email', '')), ''); END IF;
      IF p_fields->'service_address' IS NOT NULL THEN v_row.service_address := NULLIF(btrim(COALESCE(p_fields->>'service_address', '')), ''); END IF;
      IF p_fields->'service_type' IS NOT NULL THEN v_row.service_type := NULLIF(btrim(COALESCE(p_fields->>'service_type', '')), ''); END IF;
      IF p_fields->'policy_number' IS NOT NULL THEN v_row.policy_number := NULLIF(btrim(COALESCE(p_fields->>'policy_number', '')), ''); END IF;
      IF p_fields->'external_ref' IS NOT NULL THEN v_row.external_ref := NULLIF(btrim(COALESCE(p_fields->>'external_ref', '')), ''); END IF;
      IF p_fields->'nte_cents' IS NOT NULL THEN
        v_nte := btrim(COALESCE(p_fields->>'nte_cents', ''));
        IF v_nte = '' THEN
          v_row.nte_cents := NULL;
        ELSIF v_nte ~ '^[0-9]{1,10}$' AND v_nte::bigint <= 2147483647 THEN
          v_row.nte_cents := v_nte::integer;
        ELSE
          RAISE EXCEPTION 'NTE must be a valid amount' USING ERRCODE = '22023';
        END IF;
      END IF;

    ELSE
      RAISE EXCEPTION 'Unknown action: %', p_action USING ERRCODE = '22023';
  END CASE;

  UPDATE third_party_work_orders SET
    status = v_row.status,
    title = v_row.title,
    external_ref = v_row.external_ref,
    service_type = v_row.service_type,
    customer_name = v_row.customer_name,
    customer_phone = v_row.customer_phone,
    customer_email = v_row.customer_email,
    service_address = v_row.service_address,
    policy_number = v_row.policy_number,
    nte_cents = v_row.nte_cents,
    quoted_cents = v_row.quoted_cents,
    authorization_status = v_row.authorization_status,
    authorization_ref = v_row.authorization_ref,
    authorized_cents = v_row.authorized_cents,
    authorized_at = v_row.authorized_at,
    decline_reason = v_row.decline_reason,
    scheduled_for = v_row.scheduled_for,
    work_order_id = v_row.work_order_id,
    needs_review = false
  WHERE id = p_id
  RETURNING * INTO v_row;

  -- Keep the commercial work order (PO / NTE / approval / status) in lock-step.
  IF v_row.work_order_id IS NOT NULL THEN
    UPDATE work_orders SET
      approval_status = CASE v_row.authorization_status
        WHEN 'authorized' THEN 'approved'
        WHEN 'not_required' THEN 'not_required'
        WHEN 'denied' THEN 'rejected'
        ELSE 'pending' END,
      approver_name = CASE WHEN v_row.authorization_status = 'authorized' THEN v_row.payer_name ELSE approver_name END,
      approval_notes = CASE WHEN v_row.authorization_status = 'authorized' THEN v_row.authorization_ref ELSE approval_notes END,
      not_to_exceed_cents = COALESCE(v_row.authorized_cents, v_row.nte_cents),
      status = CASE
        WHEN v_row.status = 'completed' THEN 'completed'
        WHEN v_row.status IN ('cancelled', 'declined') THEN 'cancelled'
        WHEN v_row.status = 'scheduled' AND status = 'draft' THEN 'scheduled'
        ELSE status END
    WHERE id = v_row.work_order_id AND user_id = v_owner;

    IF p_action = 'edit' THEN
      UPDATE work_orders SET
        title = left(v_row.title, 200),
        po_number = v_row.external_ref,
        site_address = v_row.service_address,
        site_contact_name = v_row.customer_name,
        site_contact_phone = v_row.customer_phone,
        site_contact_email = v_row.customer_email
      WHERE id = v_row.work_order_id AND user_id = v_owner;
    END IF;

    IF p_action = 'schedule' THEN
      UPDATE work_order_visits SET
        scheduled_start = p_when,
        scheduled_end = p_when + interval '2 hours'
      WHERE id = (
        SELECT id FROM work_order_visits
        WHERE work_order_id = v_row.work_order_id AND status = 'scheduled'
        ORDER BY visit_number LIMIT 1
      );
      IF NOT FOUND THEN
        INSERT INTO work_order_visits (user_id, work_order_id, scheduled_start, scheduled_end)
        VALUES (v_owner, v_row.work_order_id, p_when, p_when + interval '2 hours');
      END IF;
    END IF;
  END IF;

  v_event_note := left(concat_ws(' | ',
    v_note,
    CASE WHEN v_ref IS NOT NULL THEN 'Ref ' || v_ref END,
    CASE WHEN p_amount_cents IS NOT NULL THEN 'Amount ' || to_char(p_amount_cents / 100.0, 'FM999999990.00') END,
    CASE WHEN p_action = 'schedule' THEN 'For ' || to_char(p_when AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' END
  ), 2000);

  INSERT INTO third_party_work_order_events (user_id, intake_id, kind, from_status, to_status, actor_id, note)
  VALUES (v_owner, p_id, p_action, v_prev, v_row.status, auth.uid(), v_event_note);

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.third_party_wo_act(uuid, text, text, integer, text, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.third_party_wo_act(uuid, text, text, integer, text, timestamptz, jsonb) TO authenticated;

-- =============================================================
-- 7. SLA SWEEP (service role only; called by the edge function, see docs below)
-- =============================================================
CREATE OR REPLACE FUNCTION public.third_party_intake_sla_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_breach integer := 0;
  v_risk integer := 0;
  v_purged integer := 0;
BEGIN
  -- 1) Deadlines already missed (one alert per request per stage).
  WITH cur AS (
    SELECT t.id,
      CASE t.status WHEN 'new' THEN 'accept' WHEN 'accepted' THEN 'schedule' ELSE 'complete' END AS stage,
      CASE t.status WHEN 'new' THEN t.accept_due_at WHEN 'accepted' THEN t.schedule_due_at ELSE t.complete_due_at END AS due_at
    FROM third_party_work_orders t
    WHERE t.status IN ('new', 'accepted', 'scheduled') AND t.paused_at IS NULL
  ), hit AS (
    UPDATE third_party_work_orders t
       SET breach_alerted_stages = array_append(t.breach_alerted_stages, c.stage)
      FROM cur c
     WHERE t.id = c.id
       AND c.due_at IS NOT NULL AND c.due_at < now()
       AND NOT (c.stage = ANY (t.breach_alerted_stages))
    RETURNING t.id, t.user_id, t.title, t.payer_name, c.stage
  ), n AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT h.user_id, 'third_party_sla_breach', 'SLA missed: ' || h.payer_name,
           left(h.title, 100) || ' - the ' || h.stage || ' deadline has passed.',
           '/dashboard/third-party-intake'
      FROM hit h
    RETURNING 1
  )
  INSERT INTO third_party_work_order_events (user_id, intake_id, kind, note)
  SELECT h.user_id, h.id, 'sla_breach', h.stage || ' deadline passed' FROM hit h;
  GET DIAGNOSTICS v_breach = ROW_COUNT;

  -- 2) At risk: 25% or less of the stage window left.
  WITH cur AS (
    SELECT t.id,
      CASE t.status WHEN 'new' THEN 'accept' WHEN 'accepted' THEN 'schedule' ELSE 'complete' END AS stage,
      CASE t.status WHEN 'new' THEN t.accept_due_at WHEN 'accepted' THEN t.schedule_due_at ELSE t.complete_due_at END AS due_at,
      CASE t.status WHEN 'new' THEN t.received_at ELSE COALESCE(t.accepted_at, t.received_at) END AS start_at
    FROM third_party_work_orders t
    WHERE t.status IN ('new', 'accepted', 'scheduled') AND t.paused_at IS NULL
  ), hit AS (
    UPDATE third_party_work_orders t
       SET risk_alerted_stages = array_append(t.risk_alerted_stages, c.stage)
      FROM cur c
     WHERE t.id = c.id
       AND c.due_at IS NOT NULL AND c.due_at >= now()
       AND now() >= c.due_at - (c.due_at - c.start_at) * 0.25::double precision
       AND NOT (c.stage = ANY (t.risk_alerted_stages))
    RETURNING t.id, t.user_id, t.title, t.payer_name, c.stage
  ), n AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT h.user_id, 'third_party_sla_risk', 'SLA at risk: ' || h.payer_name,
           left(h.title, 100) || ' - the ' || h.stage || ' deadline is close.',
           '/dashboard/third-party-intake'
      FROM hit h
    RETURNING 1
  )
  INSERT INTO third_party_work_order_events (user_id, intake_id, kind, note)
  SELECT h.user_id, h.id, 'sla_risk', h.stage || ' deadline is close' FROM hit h;
  GET DIAGNOSTICS v_risk = ROW_COUNT;

  -- 3) Raw payloads are only for parser debugging.
  UPDATE third_party_work_orders SET raw_payload = NULL
   WHERE raw_payload IS NOT NULL AND received_at < now() - interval '30 days';
  GET DIAGNOSTICS v_purged = ROW_COUNT;

  RETURN jsonb_build_object('breached', v_breach, 'at_risk', v_risk, 'purged', v_purged);
END;
$$;

REVOKE ALL ON FUNCTION public.third_party_intake_sla_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.third_party_intake_sla_sweep() TO service_role;

/*
  ## Scheduling the SLA sweeper (run once, after deploying the `third-party-intake` function)
    select cron.schedule('third-party-intake-sweep', '* * * * *', $$
      select net.http_post(
        url := 'https://<PROJECT_REF>.supabase.co/functions/v1/third-party-intake?action=sweep',
        headers := jsonb_build_object('X-Cron-Secret', '<CRON_SECRET>')
      );
    $$);
*/
