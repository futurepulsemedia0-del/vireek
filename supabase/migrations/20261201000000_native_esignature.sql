/*
  # Native E-Signature

  ## Why
  Every place in Vireek that produces a document a customer needs to agree
  to — a quote, a commercial contract, or a one-off custom document —
  currently ends at "customer accepts/declines" (respond_to_quote_by_token)
  or a manual signed_by/signed_at text field typed in by hand
  (commercial_contracts). Neither produces a real, defensible signature:
  who signed, what they drew/typed, from what IP, when, having agreed to
  what consent language.

  This migration adds ONE signing system shared by all document types
  instead of a parallel flow per feature:

    - signature_requests: one row per document sent out for signature.
      document_type/document_id point at the source row loosely (no FK —
      it's polymorphic; application code owns what document_type means).
    - signature_signers: one row per person who needs to sign. Each
      signer gets their own unguessable signer_token — the only
      credential the public /sign/:token page needs.
    - signature_events: append-only audit log. Every state change is
      recorded here with IP + user agent, so a completed request
      produces a real certificate of completion.

  Same token-based public-access pattern as quotes
  (get_quote_for_token/respond_to_quote_by_token): RLS stays closed to
  anon on every table, and the public page only ever talks to SECURITY
  DEFINER functions.

  Two different trust levels for those functions, on purpose:
    - get_signature_request_for_signer is read-only and safe to expose
      directly to anon (same as get_quote_for_token).
    - Every function that WRITES (record_signature_view/consent,
      submit_signature_by_token, decline_signature_by_token) takes a
      p_ip/p_user_agent pair for the audit log, and a client-supplied IP
      is worthless for that purpose. So those are REVOKEd from
      PUBLIC/anon and only reachable through the sign-document-action
      Edge Function, which reads the real x-forwarded-for / user-agent
      request headers before calling them with the service role.

  ## Deploy order
    1. Run this migration.
    2. supabase functions deploy send-signature-request
    3. supabase functions deploy sign-document-action --no-verify-jwt
    4. Apply the front-end edits delivered alongside this migration.
*/

-- =============================================================
-- 1. Tables
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS signature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  document_type text NOT NULL CHECK (document_type IN ('quote', 'contract', 'invoice', 'custom')),
  document_id uuid,
  title text NOT NULL,
  document_summary text,
  document_url text,
  consent_text text NOT NULL DEFAULT
    'By selecting "I agree" and signing below, you consent to sign this document electronically and agree that your electronic signature is the legal equivalent of your handwritten signature.',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'partially_signed', 'completed', 'declined', 'voided', 'expired')),
  sent_at timestamptz,
  completed_at timestamptz,
  voided_at timestamptz,
  decline_reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signature_requests_user_id ON signature_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_document ON signature_requests(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_status ON signature_requests(status);

DROP TRIGGER IF EXISTS trg_signature_requests_updated_at ON signature_requests;
CREATE TRIGGER trg_signature_requests_updated_at
  BEFORE UPDATE ON signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE signature_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_signature_requests" ON signature_requests;
CREATE POLICY "select_own_signature_requests" ON signature_requests FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "insert_own_signature_requests" ON signature_requests;
CREATE POLICY "insert_own_signature_requests" ON signature_requests FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "update_own_signature_requests" ON signature_requests;
CREATE POLICY "update_own_signature_requests" ON signature_requests FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "delete_own_signature_requests" ON signature_requests;
CREATE POLICY "delete_own_signature_requests" ON signature_requests FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS signature_signers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'signer' CHECK (role IN ('signer', 'company_rep', 'witness')),
  signing_order integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  email text,
  phone text,
  signer_token uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'viewed', 'signed', 'declined')),
  signature_type text CHECK (signature_type IN ('drawn', 'typed')),
  signature_data text,
  typed_font text,
  signed_name text,
  consented_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signature_signers_token ON signature_signers(signer_token);
CREATE INDEX IF NOT EXISTS idx_signature_signers_request_id ON signature_signers(request_id);

DROP TRIGGER IF EXISTS trg_signature_signers_updated_at ON signature_signers;
CREATE TRIGGER trg_signature_signers_updated_at
  BEFORE UPDATE ON signature_signers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE signature_signers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_signature_signers" ON signature_signers;
CREATE POLICY "select_own_signature_signers" ON signature_signers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));
DROP POLICY IF EXISTS "insert_own_signature_signers" ON signature_signers;
CREATE POLICY "insert_own_signature_signers" ON signature_signers FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));
DROP POLICY IF EXISTS "update_own_signature_signers" ON signature_signers;
CREATE POLICY "update_own_signature_signers" ON signature_signers FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));
DROP POLICY IF EXISTS "delete_own_signature_signers" ON signature_signers;
CREATE POLICY "delete_own_signature_signers" ON signature_signers FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));

CREATE TABLE IF NOT EXISTS signature_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  signer_id uuid REFERENCES signature_signers(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN
    ('created', 'sent', 'opened', 'consented', 'signed', 'declined', 'completed', 'voided', 'reminder_sent')),
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signature_events_request_id ON signature_events(request_id, created_at);

ALTER TABLE signature_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_signature_events" ON signature_events;
CREATE POLICY "select_own_signature_events" ON signature_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));

-- No INSERT/UPDATE/DELETE policy for signature_events at all — every
-- write comes from the service role (Edge Functions), same posture as
-- revenue_recovery_events. A compromised client session cannot
-- fabricate or edit audit history.

-- =============================================================
-- 2. Public read: get_signature_request_for_signer
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_signature_request_for_signer(p_signer_token uuid)
RETURNS TABLE (
  request_id uuid,
  title text,
  document_type text,
  document_summary text,
  document_url text,
  consent_text text,
  request_status text,
  expires_at timestamptz,
  business_name text,
  signer_id uuid,
  signer_name text,
  signer_role text,
  signer_status text,
  signing_order integer,
  other_signers jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    r.title,
    r.document_type,
    r.document_summary,
    r.document_url,
    r.consent_text,
    r.status,
    r.expires_at,
    p.company_name,
    s.id,
    s.name,
    s.role,
    s.status,
    s.signing_order,
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name', s2.name, 'role', s2.role, 'status', s2.status) ORDER BY s2.signing_order), '[]'::jsonb)
      FROM signature_signers s2
      WHERE s2.request_id = r.id AND s2.id <> s.id
    )
  FROM signature_signers s
  JOIN signature_requests r ON r.id = s.request_id
  JOIN profiles p ON p.id = r.user_id
  WHERE s.signer_token = p_signer_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_signature_request_for_signer(uuid) TO anon, authenticated;

-- =============================================================
-- 3. Server-only writes (called by sign-document-action Edge
--    Function with the service role — never directly from a browser)
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_signature_view(p_signer_token uuid, p_ip text, p_user_agent text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signer_id uuid;
  v_request_id uuid;
BEGIN
  SELECT id, request_id INTO v_signer_id, v_request_id
  FROM signature_signers WHERE signer_token = p_signer_token;

  IF v_signer_id IS NULL THEN RETURN; END IF;

  UPDATE signature_signers SET status = 'viewed'
  WHERE id = v_signer_id AND status = 'pending';

  UPDATE signature_requests SET status = 'viewed'
  WHERE id = v_request_id AND status = 'sent';

  INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent)
  VALUES (v_request_id, v_signer_id, 'opened', p_ip, p_user_agent);
END;
$$;

REVOKE ALL ON FUNCTION public.record_signature_view(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_signature_view(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.record_signature_consent(p_signer_token uuid, p_ip text, p_user_agent text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signer_id uuid;
  v_request_id uuid;
BEGIN
  SELECT id, request_id INTO v_signer_id, v_request_id
  FROM signature_signers WHERE signer_token = p_signer_token;

  IF v_signer_id IS NULL THEN RETURN; END IF;

  UPDATE signature_signers SET consented_at = now() WHERE id = v_signer_id AND consented_at IS NULL;

  INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent)
  VALUES (v_request_id, v_signer_id, 'consented', p_ip, p_user_agent);
END;
$$;

REVOKE ALL ON FUNCTION public.record_signature_consent(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_signature_consent(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.submit_signature_by_token(
  p_signer_token uuid,
  p_signature_type text,
  p_signature_data text,
  p_typed_font text,
  p_signed_name text,
  p_ip text,
  p_user_agent text
)
RETURNS TABLE (ok boolean, request_completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signer_id uuid;
  v_request_id uuid;
  v_signer_status text;
  v_request_status text;
  v_remaining integer;
BEGIN
  IF p_signature_type NOT IN ('drawn', 'typed') OR coalesce(p_signature_data, '') = '' THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  SELECT s.id, s.status, s.request_id, r.status
  INTO v_signer_id, v_signer_status, v_request_id, v_request_status
  FROM signature_signers s
  JOIN signature_requests r ON r.id = s.request_id
  WHERE s.signer_token = p_signer_token;

  IF v_signer_id IS NULL OR v_signer_status = 'signed' OR v_signer_status = 'declined'
     OR v_request_status IN ('completed', 'declined', 'voided', 'expired') THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  UPDATE signature_signers
  SET status = 'signed',
      signature_type = p_signature_type,
      signature_data = p_signature_data,
      typed_font = p_typed_font,
      signed_name = coalesce(p_signed_name, name),
      signed_at = now(),
      ip_address = p_ip,
      user_agent = p_user_agent,
      consented_at = coalesce(consented_at, now())
  WHERE id = v_signer_id;

  INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent)
  VALUES (v_request_id, v_signer_id, 'signed', p_ip, p_user_agent);

  SELECT count(*) INTO v_remaining FROM signature_signers
  WHERE request_id = v_request_id AND status <> 'signed';

  IF v_remaining = 0 THEN
    UPDATE signature_requests SET status = 'completed', completed_at = now() WHERE id = v_request_id;
    INSERT INTO signature_events (request_id, event_type, metadata) VALUES (v_request_id, 'completed', '{}');
    RETURN QUERY SELECT true, true;
  ELSE
    UPDATE signature_requests SET status = 'partially_signed' WHERE id = v_request_id AND status <> 'partially_signed';
    RETURN QUERY SELECT true, false;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_signature_by_token(uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_signature_by_token(uuid, text, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.decline_signature_by_token(p_signer_token uuid, p_reason text, p_ip text, p_user_agent text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signer_id uuid;
  v_request_id uuid;
  v_signer_status text;
BEGIN
  SELECT id, status, request_id INTO v_signer_id, v_signer_status, v_request_id
  FROM signature_signers WHERE signer_token = p_signer_token;

  IF v_signer_id IS NULL OR v_signer_status IN ('signed', 'declined') THEN
    RETURN false;
  END IF;

  UPDATE signature_signers
  SET status = 'declined', declined_at = now(), decline_reason = p_reason, ip_address = p_ip, user_agent = p_user_agent
  WHERE id = v_signer_id;

  UPDATE signature_requests SET status = 'declined', decline_reason = p_reason WHERE id = v_request_id;

  INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent, metadata)
  VALUES (v_request_id, v_signer_id, 'declined', p_ip, p_user_agent, jsonb_build_object('reason', p_reason));

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.decline_signature_by_token(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decline_signature_by_token(uuid, text, text, text) TO service_role;
