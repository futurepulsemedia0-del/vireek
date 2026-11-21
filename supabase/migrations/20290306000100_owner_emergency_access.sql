/*
  # Owner-incapacity emergency access

  ## Purpose
  An account owner designates up to 3 emergency contacts. If the owner becomes unable to act, a
  contact can request READ-ONLY access to a fixed set of business records (customers, invoices,
  jobs) so the business can keep running and its records can be exported. It is never write access
  and never payment access.

  ## Flow (all transitions are in SECURITY DEFINER functions; clients have no write privileges)
  owner designates ─▶ contact 'invited' ─▶ contact accepts (verified e-mail must match) ─▶ 'active'
  contact requests ─▶ request 'pending_verification' (one-time code e-mailed to the contact; owner notified at once)
  contact confirms code ─▶ 'waiting' (clock starts; wait_hours >= 48 enforced by CHECK; owner notified, reminders daily)
  wait elapsed AND owner has not signed in AND has not denied ─▶ 'granted' for access_days (read/export only)
  ... 'denied' (owner) | 'cancelled' (contact / owner signed in / verification failed or expired) | 'expired' | 'revoked'

  ## Invariants (each has a test in supabase/tests/database/owner_emergency_access.test.sql)
  - The delay cannot be shortened by anyone: wait_hours is snapshotted per request; the grant is only
    ever set by emergency_tick() after access_available_at, and every read re-checks it.
  - The owner can deny/revoke at any time; owner sign-in after the request cancels it automatically.
  - Contacts get no table privileges. They read only through emergency_read(), which returns an
    explicit column whitelist for one scope, capped at 500 rows per call, and writes an audit row.
  - No function here writes to any business table. There is no payment, bank or secret scope.
  - Audit log: append-only (UPDATE/DELETE/TRUNCATE blocked by trigger), per-owner SHA-256 hash chain,
    contains ids and counts only (no codes, no e-mail addresses, no record contents).
  - The e-mail code is never stored: only an HMAC computed by the edge function with a server secret.

  ## Rollback
  DROP the 4 tables + outbox, the helper/RPC functions below, and the cron job
  'vireek-emergency-access-tick'. Nothing else depends on them.
*/

-- =============================================================
-- 1. Tables
-- =============================================================
CREATE TABLE IF NOT EXISTS public.emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_email text NOT NULL CHECK (length(contact_email) <= 254 AND contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  contact_name text NOT NULL CHECK (length(btrim(contact_name)) BETWEEN 1 AND 120),
  relationship text CHECK (relationship IS NULL OR length(relationship) <= 80),
  wait_hours integer NOT NULL DEFAULT 72 CHECK (wait_hours BETWEEN 48 AND 720),
  access_days integer NOT NULL DEFAULT 30 CHECK (access_days BETWEEN 1 AND 90),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['customers', 'invoices', 'jobs']::text[]),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  contact_user_id uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_emergency_contact_email ON public.emergency_contacts (owner_id, lower(contact_email)) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_email ON public.emergency_contacts (lower(contact_email)) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user ON public.emergency_contacts (contact_user_id) WHERE contact_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.emergency_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.emergency_contacts(id) ON DELETE CASCADE,
  requester_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'waiting', 'granted', 'denied', 'cancelled', 'expired', 'revoked')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 20 AND 2000),
  code_hash text CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  code_attempts integer NOT NULL DEFAULT 0 CHECK (code_attempts >= 0),
  -- snapshots: later edits to the contact can never shorten the delay or widen the scope of a live request
  wait_hours integer NOT NULL CHECK (wait_hours >= 48),
  access_days integer NOT NULL CHECK (access_days BETWEEN 1 AND 90),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['customers', 'invoices', 'jobs']::text[]),
  verified_at timestamptz,
  access_available_at timestamptz,
  granted_at timestamptz,
  access_expires_at timestamptz,
  closed_at timestamptz,
  closed_by uuid,
  closed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- structural guarantee: a grant can only exist after verification and after the full delay
  CONSTRAINT emergency_grant_requires_delay CHECK (
    status <> 'granted' OR (verified_at IS NOT NULL AND access_available_at IS NOT NULL
      AND access_available_at >= verified_at + make_interval(hours => wait_hours)
      AND granted_at IS NOT NULL AND granted_at >= access_available_at AND access_expires_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_emergency_one_open_request ON public.emergency_access_requests (contact_id)
  WHERE status IN ('pending_verification', 'waiting', 'granted');
CREATE INDEX IF NOT EXISTS idx_emergency_requests_owner ON public.emergency_access_requests (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emergency_requests_open ON public.emergency_access_requests (status, access_available_at) WHERE status IN ('pending_verification', 'waiting', 'granted');

-- Append-only, hash-chained audit. Deliberately no FK: it must outlive contacts/requests.
CREATE TABLE IF NOT EXISTS public.emergency_access_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL,
  seq integer NOT NULL,
  request_id uuid,
  contact_id uuid,
  event text NOT NULL,
  actor_id uuid,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'contact', 'system')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  row_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, seq)
);

CREATE TABLE IF NOT EXISTS public.emergency_notice_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  request_id uuid,
  contact_id uuid,
  recipient text NOT NULL CHECK (recipient IN ('owner', 'contact')),
  kind text NOT NULL,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  last_error text,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emergency_outbox_due ON public.emergency_notice_outbox (scheduled_for) WHERE sent_at IS NULL;

-- =============================================================
-- 2. RLS and privileges (reads only; every write is an RPC)
-- =============================================================
ALTER TABLE public.emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_notice_outbox ENABLE ROW LEVEL SECURITY;

-- Owner only: a team member (even an admin) resolves to the owner via get_account_owner_id() but is NOT auth.uid().
DROP POLICY IF EXISTS "owner_select_emergency_contacts" ON public.emergency_contacts;
CREATE POLICY "owner_select_emergency_contacts" ON public.emergency_contacts FOR SELECT TO authenticated
  USING (owner_id = auth.uid() AND public.get_account_owner_id() = auth.uid());
DROP POLICY IF EXISTS "owner_select_emergency_requests" ON public.emergency_access_requests;
CREATE POLICY "owner_select_emergency_requests" ON public.emergency_access_requests FOR SELECT TO authenticated
  USING (owner_id = auth.uid() AND public.get_account_owner_id() = auth.uid());
DROP POLICY IF EXISTS "owner_select_emergency_audit" ON public.emergency_access_audit;
CREATE POLICY "owner_select_emergency_audit" ON public.emergency_access_audit FOR SELECT TO authenticated
  USING (owner_id = auth.uid() AND public.get_account_owner_id() = auth.uid());

REVOKE ALL ON public.emergency_contacts, public.emergency_access_requests, public.emergency_access_audit, public.emergency_notice_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.emergency_contacts TO authenticated;
-- code_hash / code_attempts / requester_user_id are not readable by clients, not even by the owner.
GRANT SELECT (id, owner_id, contact_id, status, reason, wait_hours, access_days, scopes, verified_at, access_available_at,
              granted_at, access_expires_at, closed_at, closed_reason, created_at)
  ON public.emergency_access_requests TO authenticated;
GRANT SELECT ON public.emergency_access_audit TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.emergency_contacts, public.emergency_access_requests, public.emergency_notice_outbox TO service_role;
GRANT SELECT, INSERT ON public.emergency_access_audit TO service_role;

-- =============================================================
-- 3. Audit: hash chain + immutability
-- =============================================================
CREATE OR REPLACE FUNCTION public._emergency_audit_hash(
  p_prev text, p_seq integer, p_event text, p_request uuid, p_contact uuid, p_actor uuid, p_role text, p_detail jsonb, p_ts timestamptz
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT encode(sha256(convert_to(
    p_prev || '|' || p_seq::text || '|' || p_event || '|' || coalesce(p_request::text, '') || '|' || coalesce(p_contact::text, '') || '|' ||
    coalesce(p_actor::text, '') || '|' || p_role || '|' || p_detail::text || '|' ||
    to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION public._emergency_audit(
  p_owner uuid, p_request uuid, p_contact uuid, p_event text, p_actor uuid, p_role text, p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prev text; v_seq integer; v_ts timestamptz := clock_timestamp(); v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('emergency_audit:' || p_owner::text, 0)); -- serialises the chain per owner
  SELECT row_hash, seq INTO v_prev, v_seq FROM emergency_access_audit WHERE owner_id = p_owner ORDER BY seq DESC LIMIT 1;
  v_prev := coalesce(v_prev, 'genesis');
  v_seq := coalesce(v_seq, 0) + 1;
  INSERT INTO emergency_access_audit (owner_id, seq, request_id, contact_id, event, actor_id, actor_role, detail, prev_hash, row_hash, created_at)
  VALUES (p_owner, v_seq, p_request, p_contact, p_event, p_actor, p_role, v_detail, v_prev,
          public._emergency_audit_hash(v_prev, v_seq, p_event, p_request, p_contact, p_actor, p_role, v_detail, v_ts), v_ts);
END $$;

CREATE OR REPLACE FUNCTION public._emergency_audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'emergency_access_audit is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS trg_emergency_audit_no_update ON public.emergency_access_audit;
CREATE TRIGGER trg_emergency_audit_no_update BEFORE UPDATE OR DELETE ON public.emergency_access_audit
  FOR EACH ROW EXECUTE FUNCTION public._emergency_audit_immutable();
DROP TRIGGER IF EXISTS trg_emergency_audit_no_truncate ON public.emergency_access_audit;
CREATE TRIGGER trg_emergency_audit_no_truncate BEFORE TRUNCATE ON public.emergency_access_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public._emergency_audit_immutable();

CREATE OR REPLACE FUNCTION public._emergency_audit_verify(p_owner uuid)
RETURNS TABLE (ok boolean, rows_checked integer, broken_at_seq integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_prev text := 'genesis'; v_expect integer := 1; v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM emergency_access_audit WHERE owner_id = p_owner ORDER BY seq LOOP
    v_n := v_n + 1;
    IF r.seq <> v_expect OR r.prev_hash <> v_prev
       OR r.row_hash <> public._emergency_audit_hash(r.prev_hash, r.seq, r.event, r.request_id, r.contact_id, r.actor_id, r.actor_role, r.detail, r.created_at) THEN
      RETURN QUERY SELECT false, v_n, r.seq; RETURN;
    END IF;
    v_prev := r.row_hash; v_expect := r.seq + 1;
  END LOOP;
  RETURN QUERY SELECT true, v_n, NULL::integer;
END $$;

-- =============================================================
-- 4. Notice outbox helper
-- =============================================================
CREATE OR REPLACE FUNCTION public._emergency_notice(
  p_owner uuid, p_request uuid, p_contact uuid, p_recipient text, p_kind text, p_when timestamptz, p_dedupe text
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO emergency_notice_outbox (owner_id, request_id, contact_id, recipient, kind, scheduled_for, dedupe_key)
  VALUES (p_owner, p_request, p_contact, p_recipient, p_kind, p_when, p_dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING;
$$;

-- Closes an open request in one place so every exit path audits and notifies identically.
CREATE OR REPLACE FUNCTION public._emergency_close(p_request uuid, p_status text, p_reason text, p_actor uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r emergency_access_requests;
BEGIN
  IF p_status NOT IN ('denied', 'cancelled', 'expired', 'revoked') THEN RAISE EXCEPTION 'bad close status %', p_status; END IF;
  UPDATE emergency_access_requests SET status = p_status, closed_at = now(), closed_by = p_actor, closed_reason = left(p_reason, 120), code_hash = NULL
   WHERE id = p_request AND status IN ('pending_verification', 'waiting', 'granted') RETURNING * INTO r;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM public._emergency_audit(r.owner_id, r.id, r.contact_id, 'request_' || p_status, p_actor, p_role, jsonb_build_object('reason', left(p_reason, 120)));
  PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'closed', now(), r.id::text || ':closed:owner');
  PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'contact', 'closed', now(), r.id::text || ':closed:contact');
  -- pending reminders for a closed request must never be delivered
  DELETE FROM emergency_notice_outbox WHERE request_id = r.id AND sent_at IS NULL AND kind IN ('reminder', 'pre_grant');
END $$;

-- Only the account owner (auth.uid() is the owner id), never a team member acting on the owner's behalf.
CREATE OR REPLACE FUNCTION public._emergency_require_owner() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid := auth.uid();
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF public.get_account_owner_id() IS DISTINCT FROM v THEN RAISE EXCEPTION 'only the account owner can do this' USING ERRCODE = '42501'; END IF;
  RETURN v;
END $$;

-- =============================================================
-- 5. Owner RPCs (authenticated)
-- =============================================================
CREATE OR REPLACE FUNCTION public.emergency_contact_add(
  p_email text, p_name text, p_relationship text DEFAULT NULL,
  p_wait_hours integer DEFAULT 72, p_access_days integer DEFAULT 30,
  p_scopes text[] DEFAULT ARRAY['customers', 'invoices', 'jobs']
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._emergency_require_owner(); v_id uuid; v_email text := lower(btrim(p_email));
BEGIN
  IF v_email = (SELECT lower(email) FROM auth.users WHERE id = v_owner) THEN
    RAISE EXCEPTION 'you cannot designate yourself' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM emergency_contacts WHERE owner_id = v_owner AND status <> 'revoked') >= 3 THEN
    RAISE EXCEPTION 'at most 3 emergency contacts' USING ERRCODE = '54000';
  END IF;
  INSERT INTO emergency_contacts (owner_id, contact_email, contact_name, relationship, wait_hours, access_days, scopes, created_by)
  VALUES (v_owner, v_email, btrim(p_name), nullif(btrim(coalesce(p_relationship, '')), ''), p_wait_hours, p_access_days, p_scopes, v_owner)
  RETURNING id INTO v_id;
  PERFORM public._emergency_audit(v_owner, NULL, v_id, 'contact_added', v_owner, 'owner', jsonb_build_object('wait_hours', p_wait_hours, 'access_days', p_access_days, 'scopes', p_scopes));
  PERFORM public._emergency_notice(v_owner, NULL, v_id, 'contact', 'invited', now(), v_id::text || ':invited');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.emergency_contact_revoke(p_contact_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._emergency_require_owner(); r record;
BEGIN
  UPDATE emergency_contacts SET status = 'revoked', revoked_at = now() WHERE id = p_contact_id AND owner_id = v_owner AND status <> 'revoked';
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._emergency_audit(v_owner, NULL, p_contact_id, 'contact_revoked', v_owner, 'owner');
  FOR r IN SELECT id FROM emergency_access_requests WHERE contact_id = p_contact_id AND status IN ('pending_verification', 'waiting', 'granted') LOOP
    PERFORM public._emergency_close(r.id, 'revoked', 'contact_revoked_by_owner', v_owner, 'owner'); -- access ends immediately
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.emergency_request_deny(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._emergency_require_owner();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM emergency_access_requests WHERE id = p_request_id AND owner_id = v_owner AND status IN ('pending_verification', 'waiting', 'granted')) THEN
    RAISE EXCEPTION 'request not found or already closed' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._emergency_close(p_request_id, 'denied', 'denied_by_owner', v_owner, 'owner'); -- also ends an active grant
END $$;

CREATE OR REPLACE FUNCTION public.emergency_audit_verify()
RETURNS TABLE (ok boolean, rows_checked integer, broken_at_seq integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public._emergency_require_owner();
BEGIN
  RETURN QUERY SELECT * FROM public._emergency_audit_verify(v_owner);
END $$;

-- =============================================================
-- 6. Contact RPCs (authenticated)
-- =============================================================
CREATE OR REPLACE FUNCTION public._emergency_caller_email() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid := auth.uid(); v_email text; v_confirmed timestamptz;
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  SELECT lower(email), email_confirmed_at INTO v_email, v_confirmed FROM auth.users WHERE id = v;
  IF v_email IS NULL OR v_confirmed IS NULL THEN RAISE EXCEPTION 'verified e-mail required' USING ERRCODE = '42501'; END IF;
  RETURN v_email;
END $$;

-- What the signed-in user has been designated for. Exposes the owner's business name only.
CREATE OR REPLACE FUNCTION public.emergency_my_designations() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_email text := public._emergency_caller_email();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'contact_id', c.id, 'owner_business', p.company_name, 'status', c.status,
      'wait_hours', c.wait_hours, 'access_days', c.access_days, 'scopes', c.scopes,
      'open_request', (SELECT jsonb_build_object('id', q.id, 'status', q.status, 'verified_at', q.verified_at,
                         'access_available_at', q.access_available_at, 'access_expires_at', q.access_expires_at, 'scopes', q.scopes)
                       FROM emergency_access_requests q WHERE q.contact_id = c.id AND q.requester_user_id = v_uid
                         AND q.status IN ('pending_verification', 'waiting', 'granted') LIMIT 1)
    ) ORDER BY c.created_at)
    FROM emergency_contacts c JOIN profiles p ON p.id = c.owner_id
    WHERE c.status <> 'revoked' AND (c.contact_user_id = v_uid OR (c.status = 'invited' AND lower(c.contact_email) = v_email))
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.emergency_contact_accept(p_contact_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_email text := public._emergency_caller_email(); c emergency_contacts;
BEGIN
  SELECT * INTO c FROM emergency_contacts WHERE id = p_contact_id AND status = 'invited' AND lower(contact_email) = v_email FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002'; END IF;
  IF v_uid = c.owner_id THEN RAISE EXCEPTION 'owner cannot accept own designation' USING ERRCODE = '42501'; END IF;
  UPDATE emergency_contacts SET status = 'active', contact_user_id = v_uid, accepted_at = now() WHERE id = c.id;
  PERFORM public._emergency_audit(c.owner_id, NULL, c.id, 'contact_accepted', v_uid, 'contact');
  PERFORM public._emergency_notice(c.owner_id, NULL, c.id, 'owner', 'accepted', now(), c.id::text || ':accepted');
END $$;

CREATE OR REPLACE FUNCTION public.emergency_request_cancel(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM emergency_access_requests WHERE id = p_request_id AND requester_user_id = v_uid AND status IN ('pending_verification', 'waiting', 'granted')) THEN
    RAISE EXCEPTION 'request not found or already closed' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._emergency_close(p_request_id, 'cancelled', 'cancelled_by_contact', v_uid, 'contact');
END $$;

-- Single gate for every read/export. One generic error on purpose: callers learn nothing about WHY.
CREATE OR REPLACE FUNCTION public._emergency_assert_grant(p_request_id uuid, p_scope text)
RETURNS public.emergency_access_requests LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); r emergency_access_requests;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'emergency access not available' USING ERRCODE = '42501'; END IF;
  SELECT * INTO r FROM emergency_access_requests WHERE id = p_request_id AND requester_user_id = v_uid;
  IF NOT FOUND
     OR r.status <> 'granted'
     OR r.verified_at IS NULL OR r.access_available_at IS NULL OR r.access_available_at > now()
     OR r.access_expires_at IS NULL OR r.access_expires_at <= now()
     OR p_scope IS NULL OR NOT (p_scope = ANY (r.scopes))
     OR NOT EXISTS (SELECT 1 FROM emergency_contacts c WHERE c.id = r.contact_id AND c.status = 'active' AND c.contact_user_id = v_uid AND c.owner_id = r.owner_id)
  THEN
    RAISE EXCEPTION 'emergency access not available' USING ERRCODE = '42501';
  END IF;
  RETURN r;
END $$;

-- READ ONLY. Explicit column whitelists; the owner is taken from the validated grant, never from input.
CREATE OR REPLACE FUNCTION public.emergency_read(p_request_id uuid, p_scope text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r emergency_access_requests := public._emergency_assert_grant(p_request_id, p_scope);
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb; v_total bigint;
BEGIN
  IF p_scope = 'customers' THEN
    SELECT count(*) INTO v_total FROM customers WHERE user_id = r.owner_id;
    SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows FROM (
      SELECT id, name, phone, email, address, customer_type, lifecycle_stage
      FROM customers WHERE user_id = r.owner_id ORDER BY created_at, id LIMIT v_limit OFFSET v_off) x;
  ELSIF p_scope = 'invoices' THEN
    SELECT count(*) INTO v_total FROM ar_invoices WHERE user_id = r.owner_id;
    SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows FROM (
      SELECT i.id, i.invoice_number, c.name AS customer_name, i.status, i.issue_date, i.due_date,
             i.subtotal_cents, i.tax_cents, i.total_cents, i.amount_paid_cents
      FROM ar_invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
      WHERE i.user_id = r.owner_id ORDER BY i.issue_date DESC, i.id LIMIT v_limit OFFSET v_off) x;
  ELSIF p_scope = 'jobs' THEN
    SELECT count(*) INTO v_total FROM jobs WHERE user_id = r.owner_id;
    SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows FROM (
      SELECT id, customer_name, service_type, address, scheduled_datetime, job_status, invoice_amount, invoice_status
      FROM jobs WHERE user_id = r.owner_id ORDER BY created_at DESC, id LIMIT v_limit OFFSET v_off) x;
  ELSE
    RAISE EXCEPTION 'emergency access not available' USING ERRCODE = '42501';
  END IF;

  PERFORM public._emergency_audit(r.owner_id, r.id, r.contact_id, 'read', auth.uid(), 'contact',
    jsonb_build_object('scope', p_scope, 'offset', v_off, 'limit', v_limit, 'returned', jsonb_array_length(v_rows)));
  PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'first_access', now(), r.id::text || ':first_access');
  RETURN jsonb_build_object('scope', p_scope, 'total', v_total, 'offset', v_off, 'limit', v_limit, 'rows', v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.emergency_log_export(p_request_id uuid, p_scope text, p_rows integer, p_format text DEFAULT 'csv')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r emergency_access_requests := public._emergency_assert_grant(p_request_id, p_scope);
BEGIN
  IF p_format NOT IN ('csv', 'json') THEN RAISE EXCEPTION 'unsupported format' USING ERRCODE = '22023'; END IF;
  PERFORM public._emergency_audit(r.owner_id, r.id, r.contact_id, 'export', auth.uid(), 'contact',
    jsonb_build_object('scope', p_scope, 'rows', greatest(coalesce(p_rows, 0), 0), 'format', p_format));
  PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'first_access', now(), r.id::text || ':first_access');
END $$;

-- =============================================================
-- 7. Service-role RPCs (the edge function owns code generation and e-mail)
-- =============================================================
CREATE OR REPLACE FUNCTION public.emergency_request_create(
  p_request_id uuid, p_contact_id uuid, p_actor_id uuid, p_reason text, p_code_hash text, p_code_ttl_minutes integer DEFAULT 30
) RETURNS TABLE (request_id uuid, contact_email text, owner_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c emergency_contacts; v_actor_email text; v_confirmed timestamptz;
BEGIN
  SELECT * INTO c FROM emergency_contacts WHERE id = p_contact_id AND status = 'active' AND contact_user_id = p_actor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not an active emergency contact' USING ERRCODE = '42501'; END IF;
  SELECT lower(u.email), u.email_confirmed_at INTO v_actor_email, v_confirmed FROM auth.users u WHERE u.id = p_actor_id;
  IF v_actor_email IS DISTINCT FROM lower(c.contact_email) OR v_confirmed IS NULL THEN
    RAISE EXCEPTION 'verified e-mail does not match the designation' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 20 THEN RAISE EXCEPTION 'reason too short' USING ERRCODE = '22023'; END IF;
  IF p_code_ttl_minutes NOT BETWEEN 5 AND 60 THEN RAISE EXCEPTION 'bad code ttl' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM emergency_access_requests q WHERE q.contact_id = c.id AND q.status = 'denied' AND q.closed_at > now() - interval '30 days') THEN
    RAISE EXCEPTION 'cooldown after owner denial' USING ERRCODE = '53400';
  END IF;
  IF (SELECT count(*) FROM emergency_access_requests q WHERE q.contact_id = c.id AND q.created_at > now() - interval '24 hours') >= 3 THEN
    RAISE EXCEPTION 'too many requests' USING ERRCODE = '53400';
  END IF;
  BEGIN
    INSERT INTO emergency_access_requests (id, owner_id, contact_id, requester_user_id, reason, code_hash, code_expires_at, wait_hours, access_days, scopes)
    VALUES (p_request_id, c.owner_id, c.id, p_actor_id, btrim(p_reason), p_code_hash, now() + make_interval(mins => p_code_ttl_minutes), c.wait_hours, c.access_days, c.scopes);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'a request is already open' USING ERRCODE = '23505';
  END;
  PERFORM public._emergency_audit(c.owner_id, p_request_id, c.id, 'requested', p_actor_id, 'contact',
    jsonb_build_object('wait_hours', c.wait_hours, 'access_days', c.access_days, 'scopes', c.scopes));
  PERFORM public._emergency_notice(c.owner_id, p_request_id, c.id, 'owner', 'requested', now(), p_request_id::text || ':requested');
  RETURN QUERY SELECT p_request_id, c.contact_email, c.owner_id;
END $$;

-- Returns a status string instead of raising, so the failed-attempt counter is committed.
CREATE OR REPLACE FUNCTION public.emergency_request_verify(p_request_id uuid, p_actor_id uuid, p_code_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r emergency_access_requests; v_avail timestamptz; v_k integer;
BEGIN
  SELECT * INTO r FROM emergency_access_requests WHERE id = p_request_id AND requester_user_id = p_actor_id AND status = 'pending_verification' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF r.code_expires_at IS NULL OR r.code_expires_at < now() THEN
    PERFORM public._emergency_close(r.id, 'cancelled', 'verification_expired', p_actor_id, 'system');
    RETURN 'expired';
  END IF;
  IF r.code_attempts >= 5 THEN RETURN 'locked'; END IF;

  IF r.code_hash IS NULL OR p_code_hash IS NULL OR r.code_hash <> p_code_hash THEN
    UPDATE emergency_access_requests SET code_attempts = code_attempts + 1 WHERE id = r.id;
    PERFORM public._emergency_audit(r.owner_id, r.id, r.contact_id, 'verify_failed', p_actor_id, 'contact', jsonb_build_object('attempt', r.code_attempts + 1));
    IF r.code_attempts + 1 >= 5 THEN
      PERFORM public._emergency_close(r.id, 'cancelled', 'too_many_attempts', p_actor_id, 'system');
      RETURN 'locked';
    END IF;
    RETURN 'invalid';
  END IF;

  v_avail := now() + make_interval(hours => r.wait_hours);
  UPDATE emergency_access_requests SET status = 'waiting', verified_at = now(), access_available_at = v_avail, code_hash = NULL, code_expires_at = NULL WHERE id = r.id;
  PERFORM public._emergency_audit(r.owner_id, r.id, r.contact_id, 'verified', p_actor_id, 'contact', jsonb_build_object('access_available_at', v_avail));
  PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'verified', now(), r.id::text || ':verified');
  -- daily reminders, then one final warning 24 h before the grant
  PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'pre_grant', v_avail - interval '24 hours', r.id::text || ':pre_grant');
  FOR v_k IN 1 .. greatest(r.wait_hours / 24 - 2, 0) LOOP
    PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'reminder', now() + make_interval(hours => v_k * 24), r.id::text || ':reminder:' || v_k);
  END LOOP;
  RETURN 'verified';
END $$;

CREATE OR REPLACE FUNCTION public.emergency_tick() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_expired integer := 0; v_granted integer := 0; v_cancelled integer := 0; v_ended integer := 0;
BEGIN
  -- (1) unconfirmed codes time out
  FOR r IN SELECT id FROM emergency_access_requests WHERE status = 'pending_verification' AND code_expires_at < now() FOR UPDATE SKIP LOCKED LOOP
    PERFORM public._emergency_close(r.id, 'cancelled', 'verification_expired', NULL, 'system'); v_expired := v_expired + 1;
  END LOOP;

  -- (2) owner signed in after the clock started => they are demonstrably able to act: cancel (waiting AND granted)
  FOR r IN
    SELECT q.id FROM emergency_access_requests q JOIN auth.users u ON u.id = q.owner_id
    WHERE q.status IN ('waiting', 'granted') AND u.last_sign_in_at IS NOT NULL
      AND u.last_sign_in_at > coalesce(q.verified_at, q.created_at)
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    PERFORM public._emergency_close(r.id, 'cancelled', 'owner_signed_in', NULL, 'system'); v_cancelled := v_cancelled + 1;
  END LOOP;

  -- (3) the delay has fully elapsed and the contact is still active => grant (the ONLY place a grant is created)
  FOR r IN
    SELECT q.id, q.owner_id, q.contact_id, q.access_days FROM emergency_access_requests q
    JOIN emergency_contacts c ON c.id = q.contact_id AND c.status = 'active'
    WHERE q.status = 'waiting' AND q.verified_at IS NOT NULL AND q.access_available_at <= now()
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    UPDATE emergency_access_requests SET status = 'granted', granted_at = now(), access_expires_at = now() + make_interval(days => r.access_days) WHERE id = r.id;
    PERFORM public._emergency_audit(r.owner_id, r.id, r.contact_id, 'granted', NULL, 'system', jsonb_build_object('read_only', true));
    PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'owner', 'granted', now(), r.id::text || ':granted:owner');
    PERFORM public._emergency_notice(r.owner_id, r.id, r.contact_id, 'contact', 'granted', now(), r.id::text || ':granted:contact');
    v_granted := v_granted + 1;
  END LOOP;

  -- (4) grants end on schedule
  FOR r IN SELECT id FROM emergency_access_requests WHERE status = 'granted' AND access_expires_at <= now() FOR UPDATE SKIP LOCKED LOOP
    PERFORM public._emergency_close(r.id, 'expired', 'access_window_elapsed', NULL, 'system'); v_ended := v_ended + 1;
  END LOOP;

  RETURN jsonb_build_object('verification_expired', v_expired, 'cancelled_owner_signed_in', v_cancelled, 'granted', v_granted, 'expired', v_ended);
END $$;

-- Outbox delivery: claim -> send (edge) -> mark. In-app notification for the owner is created on first claim,
-- so the owner sees it even if e-mail delivery is failing.
CREATE OR REPLACE FUNCTION public.emergency_claim_notices(p_limit integer DEFAULT 25)
RETURNS TABLE (
  id uuid, kind text, recipient text, to_email text, to_name text, owner_business text, contact_name text,
  request_id uuid, request_reason text, request_status text, scopes text[], wait_hours integer,
  access_available_at timestamptz, access_expires_at timestamptz, closed_reason text, attempts integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM emergency_notice_outbox o
    WHERE o.sent_at IS NULL AND o.scheduled_for <= now() AND o.attempts < 8 AND (o.claimed_until IS NULL OR o.claimed_until < now())
    ORDER BY o.scheduled_for LIMIT least(greatest(p_limit, 1), 100) FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE emergency_notice_outbox o SET claimed_until = now() + interval '5 minutes', attempts = o.attempts + 1
    FROM due WHERE o.id = due.id
    RETURNING o.id, o.kind, o.recipient, o.owner_id, o.request_id, o.contact_id, o.attempts
  ), ins AS (
    INSERT INTO notifications (user_id, type, title, message, action_url)
    SELECT cl.owner_id, 'system', 'Emergency access: ' || cl.kind,
           'There is activity on emergency access for your account. Review it now; you can deny or revoke at any time.',
           '/dashboard/emergency-access'
    FROM claimed cl WHERE cl.recipient = 'owner' AND cl.attempts = 1
    RETURNING 1
  )
  SELECT cl.id, cl.kind, cl.recipient,
         CASE WHEN cl.recipient = 'owner' THEN ou.email ELSE ec.contact_email END,
         CASE WHEN cl.recipient = 'owner' THEN p.company_name ELSE ec.contact_name END,
         p.company_name, ec.contact_name,
         cl.request_id, rq.reason, rq.status, coalesce(rq.scopes, ec.scopes), coalesce(rq.wait_hours, ec.wait_hours),
         rq.access_available_at, rq.access_expires_at, rq.closed_reason, cl.attempts
  FROM claimed cl
  LEFT JOIN auth.users ou ON ou.id = cl.owner_id
  LEFT JOIN profiles p ON p.id = cl.owner_id
  LEFT JOIN emergency_contacts ec ON ec.id = cl.contact_id
  LEFT JOIN emergency_access_requests rq ON rq.id = cl.request_id;
END $$;

CREATE OR REPLACE FUNCTION public.emergency_mark_notice(p_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE emergency_notice_outbox
     SET sent_at = CASE WHEN p_ok THEN now() ELSE NULL END,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 300) END,
         claimed_until = CASE WHEN p_ok THEN claimed_until ELSE now() + interval '2 minutes' END
   WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.emergency_audit_verify_owner(p_owner uuid)
RETURNS TABLE (ok boolean, rows_checked integer, broken_at_seq integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM public._emergency_audit_verify(p_owner); $$;

-- =============================================================
-- 8. Function privileges
-- =============================================================
REVOKE ALL ON FUNCTION
  public._emergency_audit_hash(text, integer, text, uuid, uuid, uuid, text, jsonb, timestamptz),
  public._emergency_audit(uuid, uuid, uuid, text, uuid, text, jsonb),
  public._emergency_audit_immutable(),
  public._emergency_audit_verify(uuid),
  public._emergency_notice(uuid, uuid, uuid, text, text, timestamptz, text),
  public._emergency_close(uuid, text, text, uuid, text),
  public._emergency_require_owner(),
  public._emergency_caller_email(),
  public._emergency_assert_grant(uuid, text),
  public.emergency_contact_add(text, text, text, integer, integer, text[]),
  public.emergency_contact_revoke(uuid),
  public.emergency_request_deny(uuid),
  public.emergency_audit_verify(),
  public.emergency_my_designations(),
  public.emergency_contact_accept(uuid),
  public.emergency_request_cancel(uuid),
  public.emergency_read(uuid, text, integer, integer),
  public.emergency_log_export(uuid, text, integer, text),
  public.emergency_request_create(uuid, uuid, uuid, text, text, integer),
  public.emergency_request_verify(uuid, uuid, text),
  public.emergency_tick(),
  public.emergency_claim_notices(integer),
  public.emergency_mark_notice(uuid, boolean, text),
  public.emergency_audit_verify_owner(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.emergency_contact_add(text, text, text, integer, integer, text[]),
  public.emergency_contact_revoke(uuid),
  public.emergency_request_deny(uuid),
  public.emergency_audit_verify(),
  public.emergency_my_designations(),
  public.emergency_contact_accept(uuid),
  public.emergency_request_cancel(uuid),
  public.emergency_read(uuid, text, integer, integer),
  public.emergency_log_export(uuid, text, integer, text)
TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.emergency_request_create(uuid, uuid, uuid, text, text, integer),
  public.emergency_request_verify(uuid, uuid, text),
  public.emergency_tick(),
  public.emergency_claim_notices(integer),
  public.emergency_mark_notice(uuid, boolean, text),
  public.emergency_audit_verify_owner(uuid)
TO service_role;

-- =============================================================
-- 9. Schedule (guarded). Needs, once per project (see the runbook):
--    alter database postgres set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
--    alter database postgres set app.settings.cron_secret   = '<same value as the CRON_SECRET function secret>';
-- =============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.schedule('vireek-emergency-access-tick', '*/5 * * * *', $job$
      select net.http_post(
        url := current_setting('app.settings.functions_url', true) || '/emergency-access-tick',
        headers := jsonb_build_object('x-cron-secret', current_setting('app.settings.cron_secret', true), 'Content-Type', 'application/json'),
        body := '{}'::jsonb
      );
    $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping emergency-access cron schedule: %', SQLERRM;
END $$;
