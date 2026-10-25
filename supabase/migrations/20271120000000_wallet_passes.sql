/*
  # Apple Wallet + Google Wallet passes

  Pass kinds: appointment (live ETA + technician), membership, protection (equipment warranty / service
  protection), gift_card, tech_badge.

  - wallet_passes ........ one ACTIVE pass per (account, kind, subject). Holds the Apple serial + auth token,
                           the unguessable share token used by SMS / portal links, and a change version.
  - wallet_registrations . Apple devices that installed a pass (push tokens for APNs refresh pushes).
  - wallet_push_outbox ... change queue drained by the wallet-sync worker (APNs push + Google Wallet PATCH).
  - Triggers on jobs / gift_cards / memberships / equipment / team_members enqueue a push when the data shown on
    a pass changes. They NEVER block the source write (exceptions are swallowed with a WARNING).
  - Tables are server-only (RLS on, no client policies). Staff use the SECURITY DEFINER RPCs below; customers
    use the portal-token RPC; edge functions use the service role.
  Additive + idempotent.
*/

-- ============================================================
-- TABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wallet_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('appointment', 'membership', 'protection', 'gift_card', 'tech_badge')),
  subject_id uuid NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  serial text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') UNIQUE,
  auth_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  share_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  timezone text NOT NULL DEFAULT 'UTC',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  version integer NOT NULL DEFAULT 1,
  last_changed_at timestamptz NOT NULL DEFAULT now(),
  last_pushed_at timestamptz,
  google_synced_at timestamptz,
  issued_via text NOT NULL DEFAULT 'dashboard' CHECK (issued_via IN ('dashboard', 'portal', 'sms', 'api')),
  issued_by uuid,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_passes_active_subject
  ON public.wallet_passes (user_id, kind, subject_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_wallet_passes_subject ON public.wallet_passes (kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_wallet_passes_owner ON public.wallet_passes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.wallet_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid NOT NULL REFERENCES public.wallet_passes(id) ON DELETE CASCADE,
  device_library_id text NOT NULL CHECK (char_length(device_library_id) BETWEEN 1 AND 200),
  push_token text NOT NULL CHECK (char_length(push_token) BETWEEN 1 AND 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pass_id, device_library_id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_registrations_device ON public.wallet_registrations (device_library_id);

CREATE TABLE IF NOT EXISTS public.wallet_push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pass_id uuid NOT NULL REFERENCES public.wallet_passes(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'subject_changed',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one pending push per pass: bursts of edits collapse into a single refresh.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_outbox_pending ON public.wallet_push_outbox (pass_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wallet_outbox_due ON public.wallet_push_outbox (run_after) WHERE status IN ('pending', 'processing');

ALTER TABLE public.wallet_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_passes, public.wallet_registrations, public.wallet_push_outbox FROM anon, authenticated;

-- ============================================================
-- INTERNAL: enqueue a refresh push (bumps version + change tag)
-- ============================================================
CREATE OR REPLACE FUNCTION public.wallet_enqueue_push(p_pass_id uuid, p_reason text DEFAULT 'subject_changed')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.wallet_passes
     SET version = version + 1, last_changed_at = now()
   WHERE id = p_pass_id;

  INSERT INTO public.wallet_push_outbox (user_id, pass_id, reason)
  SELECT wp.user_id, wp.id, COALESCE(NULLIF(btrim(p_reason), ''), 'subject_changed')
    FROM public.wallet_passes wp
   WHERE wp.id = p_pass_id
  ON CONFLICT (pass_id) WHERE status = 'pending' DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_enqueue_push(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_enqueue_push(uuid, text) TO service_role;

-- ============================================================
-- TRIGGERS: data shown on a pass changed -> refresh the pass
-- ============================================================
CREATE OR REPLACE FUNCTION public.wallet_on_subject_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
  r record;
BEGIN
  v_kind := CASE TG_TABLE_NAME
    WHEN 'jobs' THEN 'appointment'
    WHEN 'gift_cards' THEN 'gift_card'
    WHEN 'memberships' THEN 'membership'
    WHEN 'equipment' THEN 'protection'
    WHEN 'team_members' THEN 'tech_badge'
    ELSE NULL
  END;
  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;
  FOR r IN SELECT id FROM public.wallet_passes WHERE kind = v_kind AND subject_id = NEW.id AND status = 'active' LOOP
    PERFORM public.wallet_enqueue_push(r.id, 'subject_changed');
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'wallet_on_subject_change failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_on_subject_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_wallet_jobs ON public.jobs;
CREATE TRIGGER trg_wallet_jobs
  AFTER UPDATE OF eta_minutes, eta_set_at, scheduled_datetime, assigned_technician_id, job_status,
                  arrival_window_start, arrival_window_end, address, service_type ON public.jobs
  FOR EACH ROW
  WHEN (
    OLD.eta_minutes IS DISTINCT FROM NEW.eta_minutes OR OLD.eta_set_at IS DISTINCT FROM NEW.eta_set_at
    OR OLD.scheduled_datetime IS DISTINCT FROM NEW.scheduled_datetime
    OR OLD.assigned_technician_id IS DISTINCT FROM NEW.assigned_technician_id
    OR OLD.job_status IS DISTINCT FROM NEW.job_status
    OR OLD.arrival_window_start IS DISTINCT FROM NEW.arrival_window_start
    OR OLD.arrival_window_end IS DISTINCT FROM NEW.arrival_window_end
    OR OLD.address IS DISTINCT FROM NEW.address OR OLD.service_type IS DISTINCT FROM NEW.service_type
  )
  EXECUTE FUNCTION public.wallet_on_subject_change();

DROP TRIGGER IF EXISTS trg_wallet_gift_cards ON public.gift_cards;
CREATE TRIGGER trg_wallet_gift_cards
  AFTER UPDATE OF balance_cents, status, expires_at, recipient_name ON public.gift_cards
  FOR EACH ROW
  WHEN (OLD.balance_cents IS DISTINCT FROM NEW.balance_cents OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.expires_at IS DISTINCT FROM NEW.expires_at OR OLD.recipient_name IS DISTINCT FROM NEW.recipient_name)
  EXECUTE FUNCTION public.wallet_on_subject_change();

DROP TRIGGER IF EXISTS trg_wallet_memberships ON public.memberships;
CREATE TRIGGER trg_wallet_memberships
  AFTER UPDATE OF status, plan_id, customer_name, started_at, cancelled_at ON public.memberships
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.plan_id IS DISTINCT FROM NEW.plan_id
        OR OLD.customer_name IS DISTINCT FROM NEW.customer_name)
  EXECUTE FUNCTION public.wallet_on_subject_change();

DROP TRIGGER IF EXISTS trg_wallet_equipment ON public.equipment;
CREATE TRIGGER trg_wallet_equipment
  AFTER UPDATE ON public.equipment
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.wallet_on_subject_change();

DROP TRIGGER IF EXISTS trg_wallet_team_members ON public.team_members;
CREATE TRIGGER trg_wallet_team_members
  AFTER UPDATE ON public.team_members
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.wallet_on_subject_change();

-- ============================================================
-- STAFF RPCs
-- ============================================================

-- Candidates the caller may issue a pass for (search by label).
CREATE OR REPLACE FUNCTION public.wallet_candidates(p_kind text, p_search text DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS TABLE (id uuid, label text, detail text, phone text, scheduled_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_q text := lower(btrim(COALESCE(p_search, '')));
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'appointment' THEN
    RETURN QUERY
    SELECT j.id,
           (COALESCE(NULLIF(btrim(j.customer_name), ''), 'Customer') || ' — ' || COALESCE(NULLIF(btrim(j.service_type), ''), 'Service visit'))::text,
           COALESCE(j.address, '')::text, cu.phone::text, j.scheduled_datetime
      FROM public.jobs j
      LEFT JOIN public.customers cu ON cu.id = j.customer_id
     WHERE j.user_id = c.owner_id
       AND j.scheduled_datetime IS NOT NULL
       AND j.scheduled_datetime >= now() - interval '1 day'
       AND j.job_status NOT IN ('completed', 'cancelled', 'canceled')
       AND (v_q = '' OR position(v_q IN lower(COALESCE(j.customer_name, '') || ' ' || COALESCE(j.service_type, '') || ' ' || COALESCE(j.address, ''))) > 0)
     ORDER BY j.scheduled_datetime
     LIMIT v_limit;
  ELSIF p_kind = 'membership' THEN
    RETURN QUERY
    SELECT m.id, m.customer_name::text, COALESCE(p.name, 'Membership')::text, m.customer_phone::text, m.started_at
      FROM public.memberships m
      LEFT JOIN public.membership_plans p ON p.id = m.plan_id
     WHERE m.user_id = c.owner_id AND m.status = 'active'
       AND (v_q = '' OR position(v_q IN lower(m.customer_name || ' ' || COALESCE(p.name, ''))) > 0)
     ORDER BY m.created_at DESC
     LIMIT v_limit;
  ELSIF p_kind = 'protection' THEN
    RETURN QUERY
    SELECT e.id,
           COALESCE(NULLIF(btrim(COALESCE(e.make, '') || ' ' || COALESCE(e.model, '')), ''), e.equipment_type)::text,
           (cu.name || ' · warranty ' || COALESCE(to_char(e.warranty_expires_at, 'YYYY-MM-DD'), 'not set'))::text,
           cu.phone::text, e.warranty_expires_at::timestamptz
      FROM public.equipment e
      JOIN public.customers cu ON cu.id = e.customer_id
     WHERE e.user_id = c.owner_id AND e.status = 'active'
       AND (v_q = '' OR position(v_q IN lower(cu.name || ' ' || COALESCE(e.make, '') || ' ' || COALESCE(e.model, '') || ' ' || e.equipment_type)) > 0)
     ORDER BY e.created_at DESC
     LIMIT v_limit;
  ELSIF p_kind = 'gift_card' THEN
    IF NOT public.identity_is_manager() THEN
      RETURN;
    END IF;
    RETURN QUERY
    SELECT g.id, ('Gift card ••' || right(g.code, 4))::text,
           (to_char(g.balance_cents / 100.0, 'FM999999990.00') || ' ' || upper(g.currency) || COALESCE(' · ' || g.recipient_name, ''))::text,
           NULL::text, g.expires_at
      FROM public.gift_cards g
     WHERE g.account_owner_id = c.owner_id AND g.status = 'active'
       AND (v_q = '' OR position(v_q IN lower(g.code || ' ' || COALESCE(g.recipient_name, ''))) > 0)
     ORDER BY g.created_at DESC
     LIMIT v_limit;
  ELSIF p_kind = 'tech_badge' THEN
    RETURN QUERY
    SELECT t.id, COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email)::text, t.role::text, NULL::text, t.created_at
      FROM public.team_members t
     WHERE t.account_owner_id = c.owner_id
       AND (c.can_manage OR t.id = c.member_id)
       AND (v_q = '' OR position(v_q IN lower(COALESCE(t.member_name, '') || ' ' || t.member_email)) > 0)
     ORDER BY t.created_at
     LIMIT v_limit;
  ELSE
    RAISE EXCEPTION 'Unknown pass kind' USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_candidates(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wallet_candidates(text, text, integer) TO authenticated;

-- Issue (or re-use) the active pass for a subject.
CREATE OR REPLACE FUNCTION public.wallet_issue_pass(p_kind text, p_subject_id uuid, p_timezone text DEFAULT 'UTC', p_via text DEFAULT 'dashboard')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  v_found boolean := false;
  v_customer uuid;
  v_tz text;
  v_via text := CASE WHEN p_via IN ('dashboard', 'sms', 'api') THEN p_via ELSE 'dashboard' END;
  v_row public.wallet_passes%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'appointment' THEN
    SELECT true, j.customer_id INTO v_found, v_customer FROM public.jobs j WHERE j.id = p_subject_id AND j.user_id = c.owner_id;
  ELSIF p_kind = 'membership' THEN
    SELECT true, NULL::uuid INTO v_found, v_customer FROM public.memberships m WHERE m.id = p_subject_id AND m.user_id = c.owner_id;
  ELSIF p_kind = 'protection' THEN
    SELECT true, e.customer_id INTO v_found, v_customer FROM public.equipment e WHERE e.id = p_subject_id AND e.user_id = c.owner_id;
  ELSIF p_kind = 'gift_card' THEN
    IF NOT public.identity_is_manager() THEN
      RAISE EXCEPTION 'Billing access required' USING ERRCODE = '42501';
    END IF;
    SELECT true, NULL::uuid INTO v_found, v_customer FROM public.gift_cards g WHERE g.id = p_subject_id AND g.account_owner_id = c.owner_id;
  ELSIF p_kind = 'tech_badge' THEN
    SELECT true, NULL::uuid INTO v_found, v_customer FROM public.team_members t
     WHERE t.id = p_subject_id AND t.account_owner_id = c.owner_id AND (c.can_manage OR t.id = c.member_id);
  ELSE
    RAISE EXCEPTION 'Unknown pass kind' USING ERRCODE = '22023';
  END IF;

  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'Nothing to issue a pass for' USING ERRCODE = '42501';
  END IF;

  v_tz := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = p_timezone) THEN p_timezone ELSE 'UTC' END;

  INSERT INTO public.wallet_passes (user_id, kind, subject_id, customer_id, timezone, issued_via, issued_by)
  VALUES (c.owner_id, p_kind, p_subject_id, v_customer, v_tz, v_via, auth.uid())
  ON CONFLICT (user_id, kind, subject_id) WHERE status = 'active'
  DO UPDATE SET timezone = EXCLUDED.timezone
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('id', v_row.id, 'serial', v_row.serial, 'share_token', v_row.share_token);
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_issue_pass(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wallet_issue_pass(text, uuid, text, text) TO authenticated;

-- List passes with human labels + installed-device counts.
CREATE OR REPLACE FUNCTION public.wallet_list_passes(p_kind text DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid, kind text, subject_id uuid, label text, status text, version integer, share_token uuid,
  apple_devices integer, google_synced boolean, issued_via text, pending_push boolean,
  last_changed_at timestamptz, last_pushed_at timestamptz, created_at timestamptz, voided_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  v_mgr boolean;
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_mgr := public.identity_is_manager();

  RETURN QUERY
  SELECT wp.id, wp.kind, wp.subject_id,
         (CASE wp.kind
            WHEN 'appointment' THEN COALESCE(j.customer_name, 'Appointment') || ' — ' || COALESCE(j.service_type, 'Service visit')
            WHEN 'membership' THEN COALESCE(m.customer_name, 'Membership')
            WHEN 'protection' THEN COALESCE(NULLIF(btrim(COALESCE(e.make, '') || ' ' || COALESCE(e.model, '')), ''), e.equipment_type, 'Equipment')
            WHEN 'gift_card' THEN 'Gift card ••' || COALESCE(right(g.code, 4), '????')
            ELSE COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email, 'Technician')
          END)::text,
         wp.status, wp.version, wp.share_token,
         (SELECT count(*)::integer FROM public.wallet_registrations r WHERE r.pass_id = wp.id),
         (wp.google_synced_at IS NOT NULL), wp.issued_via,
         EXISTS (SELECT 1 FROM public.wallet_push_outbox o WHERE o.pass_id = wp.id AND o.status IN ('pending', 'processing')),
         wp.last_changed_at, wp.last_pushed_at, wp.created_at, wp.voided_at
    FROM public.wallet_passes wp
    LEFT JOIN public.jobs j ON wp.kind = 'appointment' AND j.id = wp.subject_id
    LEFT JOIN public.memberships m ON wp.kind = 'membership' AND m.id = wp.subject_id
    LEFT JOIN public.equipment e ON wp.kind = 'protection' AND e.id = wp.subject_id
    LEFT JOIN public.gift_cards g ON wp.kind = 'gift_card' AND g.id = wp.subject_id
    LEFT JOIN public.team_members t ON wp.kind = 'tech_badge' AND t.id = wp.subject_id
   WHERE wp.user_id = c.owner_id
     AND (p_kind IS NULL OR wp.kind = p_kind)
     AND (wp.kind <> 'gift_card' OR v_mgr)
     AND (wp.kind <> 'tech_badge' OR c.can_manage OR wp.subject_id = c.member_id)
   ORDER BY wp.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_list_passes(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wallet_list_passes(text, integer) TO authenticated;

-- Void a pass (devices receive a refresh and show it as voided).
CREATE OR REPLACE FUNCTION public.wallet_void_pass(p_pass_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
  wp public.wallet_passes%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calendar_feed_ctx();
  IF c.owner_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO wp FROM public.wallet_passes WHERE id = p_pass_id AND user_id = c.owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF wp.kind = 'gift_card' AND NOT public.identity_is_manager() THEN
    RAISE EXCEPTION 'Billing access required' USING ERRCODE = '42501';
  END IF;
  IF wp.kind = 'tech_badge' AND NOT (c.can_manage OR wp.subject_id = c.member_id) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF wp.status = 'voided' THEN
    RETURN true;
  END IF;

  UPDATE public.wallet_passes SET status = 'voided', voided_at = now() WHERE id = wp.id;
  PERFORM public.wallet_enqueue_push(wp.id, 'voided');
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_void_pass(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wallet_void_pass(uuid) TO authenticated;

-- ============================================================
-- CUSTOMER PORTAL RPCs (token-validated)
-- ============================================================

-- What this customer can add to their wallet.
CREATE OR REPLACE FUNCTION public.get_portal_wallet_options(p_portal_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.customers%ROWTYPE;
  v_phone_digits text;
  v_out jsonb;
BEGIN
  SELECT * INTO c FROM public.customers WHERE portal_token = p_portal_token;
  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;
  v_phone_digits := regexp_replace(COALESCE(c.phone, ''), '\D', '', 'g');

  SELECT COALESCE(jsonb_agg(x ORDER BY x.sort_at), '[]'::jsonb) INTO v_out FROM (
    SELECT 'appointment'::text AS kind, j.id AS subject_id,
           (COALESCE(NULLIF(btrim(j.service_type), ''), 'Service visit'))::text AS label, j.scheduled_datetime AS sort_at
      FROM public.jobs j
     WHERE j.customer_id = c.id AND j.user_id = c.user_id AND j.scheduled_datetime IS NOT NULL
       AND j.scheduled_datetime >= now() - interval '1 day'
       AND j.job_status NOT IN ('completed', 'cancelled', 'canceled')
    UNION ALL
    SELECT 'protection', e.id, COALESCE(NULLIF(btrim(COALESCE(e.make, '') || ' ' || COALESCE(e.model, '')), ''), e.equipment_type), e.created_at
      FROM public.equipment e
     WHERE e.customer_id = c.id AND e.user_id = c.user_id AND e.status = 'active'
    UNION ALL
    SELECT 'membership', m.id, COALESCE(p.name, 'Membership'), m.created_at
      FROM public.memberships m
      LEFT JOIN public.membership_plans p ON p.id = m.plan_id
     WHERE m.user_id = c.user_id AND m.status = 'active'
       AND (
         EXISTS (SELECT 1 FROM public.jobs jj WHERE jj.id = m.job_id AND jj.customer_id = c.id)
         OR (length(v_phone_digits) >= 7 AND regexp_replace(COALESCE(m.customer_phone, ''), '\D', '', 'g') = v_phone_digits)
       )
  ) x;

  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.get_portal_wallet_options(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portal_wallet_options(uuid) TO anon, authenticated;

-- Issue from the portal. service_role only: called by the wallet-issue edge function.
CREATE OR REPLACE FUNCTION public.wallet_issue_pass_portal(p_portal_token uuid, p_kind text, p_subject_id uuid, p_timezone text DEFAULT 'UTC')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opts jsonb;
  v_c public.customers%ROWTYPE;
  v_tz text;
  v_row public.wallet_passes%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM public.customers WHERE portal_token = p_portal_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_opts := public.get_portal_wallet_options(p_portal_token);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_opts) o
     WHERE o ->> 'kind' = p_kind AND (o ->> 'subject_id')::uuid = p_subject_id
  ) THEN
    RETURN NULL;
  END IF;

  v_tz := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = p_timezone) THEN p_timezone ELSE 'UTC' END;

  INSERT INTO public.wallet_passes (user_id, kind, subject_id, customer_id, timezone, issued_via)
  VALUES (v_c.user_id, p_kind, p_subject_id, v_c.id, v_tz, 'portal')
  ON CONFLICT (user_id, kind, subject_id) WHERE status = 'active'
  DO UPDATE SET timezone = EXCLUDED.timezone
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('id', v_row.id, 'serial', v_row.serial, 'share_token', v_row.share_token);
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_issue_pass_portal(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_issue_pass_portal(uuid, text, uuid, text) TO service_role;

-- ============================================================
-- WORKER / SERVER RPCs (service_role only)
-- ============================================================

-- Everything needed to render one pass, assembled in one place.
CREATE OR REPLACE FUNCTION public.wallet_pass_payload(p_pass_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wp public.wallet_passes%ROWTYPE;
  v_org jsonb;
  v_data jsonb := NULL;
BEGIN
  SELECT * INTO wp FROM public.wallet_passes WHERE id = p_pass_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
           'name', COALESCE(NULLIF(btrim(pr.company_name), ''), 'Vireek'),
           'phone', pr.phone,
           'color', bs.primary_color,
           'accent', bs.accent_color)
    INTO v_org
    FROM public.profiles pr
    LEFT JOIN public.brand_settings bs ON bs.user_id = pr.id
   WHERE pr.id = wp.user_id;

  IF wp.kind = 'appointment' THEN
    SELECT jsonb_build_object(
             'customer_name', j.customer_name, 'service_type', j.service_type, 'address', j.address,
             'job_status', j.job_status, 'scheduled_at', j.scheduled_datetime,
             'eta_minutes', j.eta_minutes, 'eta_set_at', j.eta_set_at,
             'window_start', j.arrival_window_start, 'window_end', j.arrival_window_end,
             'technician_name', t.member_name)
      INTO v_data
      FROM public.jobs j
      LEFT JOIN public.team_members t ON t.id = j.assigned_technician_id
     WHERE j.id = wp.subject_id AND j.user_id = wp.user_id;
  ELSIF wp.kind = 'membership' THEN
    SELECT jsonb_build_object(
             'customer_name', m.customer_name, 'status', m.status, 'started_at', m.started_at,
             'plan_name', p.name, 'billing_interval', p.billing_interval, 'benefits', to_jsonb(COALESCE(p.benefits, '{}'::text[])),
             'member_ref', upper(left(replace(m.id::text, '-', ''), 8)))
      INTO v_data
      FROM public.memberships m
      LEFT JOIN public.membership_plans p ON p.id = m.plan_id
     WHERE m.id = wp.subject_id AND m.user_id = wp.user_id;
  ELSIF wp.kind = 'protection' THEN
    SELECT jsonb_build_object(
             'customer_name', cu.name, 'equipment_type', e.equipment_type, 'make', e.make, 'model', e.model,
             'serial_tail', CASE WHEN e.serial_number IS NULL THEN NULL ELSE right(e.serial_number, 4) END,
             'install_date', e.install_date, 'warranty_expires_at', e.warranty_expires_at,
             'warranty_notes', e.warranty_notes, 'equipment_status', e.status)
      INTO v_data
      FROM public.equipment e
      JOIN public.customers cu ON cu.id = e.customer_id
     WHERE e.id = wp.subject_id AND e.user_id = wp.user_id;
  ELSIF wp.kind = 'gift_card' THEN
    SELECT jsonb_build_object(
             'code', g.code, 'card_kind', g.kind, 'balance_cents', g.balance_cents, 'initial_cents', g.initial_cents,
             'currency', g.currency, 'status', g.status, 'expires_at', g.expires_at, 'recipient_name', g.recipient_name)
      INTO v_data
      FROM public.gift_cards g
     WHERE g.id = wp.subject_id AND g.account_owner_id = wp.user_id;
  ELSIF wp.kind = 'tech_badge' THEN
    SELECT jsonb_build_object(
             'name', COALESCE(NULLIF(btrim(t.member_name), ''), t.member_email), 'role', t.role,
             'badge_ref', upper(left(replace(t.id::text, '-', ''), 8)))
      INTO v_data
      FROM public.team_members t
     WHERE t.id = wp.subject_id AND t.account_owner_id = wp.user_id;
  END IF;

  RETURN jsonb_build_object(
    'pass', jsonb_build_object(
      'id', wp.id, 'user_id', wp.user_id, 'kind', wp.kind, 'serial', wp.serial, 'auth_token', wp.auth_token,
      'share_token', wp.share_token, 'timezone', wp.timezone, 'status', wp.status, 'version', wp.version,
      'last_changed_at', wp.last_changed_at, 'customer_id', wp.customer_id),
    'org', COALESCE(v_org, jsonb_build_object('name', 'Vireek')),
    'data', v_data,
    'missing', (v_data IS NULL)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.wallet_pass_payload(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_pass_payload(uuid) TO service_role;

-- Claim due outbox rows (SKIP LOCKED; stale 'processing' rows are re-claimed after 10 minutes).
CREATE OR REPLACE FUNCTION public.claim_wallet_push_batch(p_limit integer DEFAULT 25)
RETURNS TABLE (id uuid, pass_id uuid, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id
      FROM public.wallet_push_outbox o
     WHERE (o.status = 'pending' AND o.run_after <= now())
        OR (o.status = 'processing' AND o.updated_at < now() - interval '10 minutes')
     ORDER BY o.run_after
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.wallet_push_outbox o
     SET status = 'processing', attempts = o.attempts + 1, updated_at = now()
    FROM due
   WHERE o.id = due.id
  RETURNING o.id, o.pass_id, o.attempts;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_wallet_push_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_wallet_push_batch(integer) TO service_role;

-- Finish a row: sent | retry (backoff, max 5 attempts) | failed.
CREATE OR REPLACE FUNCTION public.complete_wallet_push(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.wallet_push_outbox%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.wallet_push_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_ok THEN
    UPDATE public.wallet_push_outbox SET status = 'sent', last_error = NULL, updated_at = now() WHERE id = p_id;
    UPDATE public.wallet_passes SET last_pushed_at = now() WHERE id = o.pass_id;
  ELSIF o.attempts >= 5 THEN
    UPDATE public.wallet_push_outbox SET status = 'failed', last_error = left(p_error, 500), updated_at = now() WHERE id = p_id;
  ELSE
    -- Back to pending. If a newer pending row already exists for the pass, this one is redundant.
    IF EXISTS (SELECT 1 FROM public.wallet_push_outbox x WHERE x.pass_id = o.pass_id AND x.status = 'pending' AND x.id <> o.id) THEN
      UPDATE public.wallet_push_outbox SET status = 'failed', last_error = left('superseded: ' || COALESCE(p_error, ''), 500), updated_at = now() WHERE id = p_id;
    ELSE
      UPDATE public.wallet_push_outbox
         SET status = 'pending', last_error = left(p_error, 500),
             run_after = now() + (power(2, o.attempts) * interval '30 seconds'), updated_at = now()
       WHERE id = p_id;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_wallet_push(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_wallet_push(uuid, boolean, text) TO service_role;

-- ============================================================
-- PUBLIC LANDING (branding only; the share token is the secret)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_wallet_landing(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'kind', wp.kind,
           'status', wp.status,
           'org_name', COALESCE(NULLIF(btrim(pr.company_name), ''), 'Vireek'),
           'color', bs.primary_color)
    FROM public.wallet_passes wp
    JOIN public.profiles pr ON pr.id = wp.user_id
    LEFT JOIN public.brand_settings bs ON bs.user_id = wp.user_id
   WHERE wp.share_token = p_token
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_wallet_landing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wallet_landing(uuid) TO anon, authenticated;
