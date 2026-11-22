/*
  # E-signature evidence: consent record, document fingerprint, tamper-evident audit chain, certificate store

  Extends 20261201000000_native_esignature.sql. What already existed (verified in that migration and in
  sign-document-action): signer IP, user agent, view/consent/sign/decline timestamps, an event log, and a
  free-text consent_text. What was missing, and is added here:

  1. DOCUMENT FINGERPRINT. On insert, signature_requests stores the exact canonical text of what is being
     signed (document_snapshot: type, id, title, summary, url, optional client file hash, consent text,
     consent version) and its SHA-256 (document_sha256), plus consent_text_sha256. Computed by a trigger, so
     the Edge Function and any other writer cannot skip or fake it. LIMIT: this fingerprints the metadata the
     signer was shown. It does not hash the bytes behind document_url. An optional document_file_sha256, supplied
     by the sender and recorded as sender-asserted, can cover the file bytes. [VERIFY] by the product team.
  2. CONSENT RECORD. signature_consents: one row per signer holding the consent text as shown, its hash, the
     version, how consent was captured, IP, user agent and time. Before this, only consented_at existed and
     signing silently set it.
  3. TAMPER-EVIDENT AUDIT CHAIN. Every new signature_events row gets seq, prev_hash and event_hash =
     SHA-256 of an exact stored preimage that includes the previous hash, per request. Events can no longer be
     updated, and cannot be deleted once consent or a signature exists. Signed requests, signed signers and the
     snapshot columns are immutable. Legacy rows (created before this migration) are NOT back-filled: they stay
     unchained and certificates say so.
  4. CERTIFICATE STORE. signature_certificates holds the issued certificate (JSON) with its SHA-256 and an
     HMAC seal made by the Edge Function with a secret that is not in the database. Rows are write-once.
     A person with database-only access cannot forge a valid seal.
  5. The signing function binds the signature to the document: the 'signed' event records the signature
     fingerprint, document_sha256 and consent_text_sha256, and the request row is locked while signing
     (fixes a race where two last signers could both see "one remaining").

  ## Behaviour changes (intentional)
  - Title, document fields and consent text of a request cannot be edited after it leaves 'draft'.
  - A request with consent/signature/decline events cannot be deleted (void it instead).
  - Signed signer rows cannot be edited or deleted.
  - record_signature_consent is ignored once a request is closed or the signer already signed/declined.

  ## Not claimed
  Legal sufficiency (ESIGN/UETA/eIDAS), identity proofing and admissibility are NOT established by this
  migration. See docs/ESIGNATURE_EVIDENCE.md, items tagged [COUNSEL].

  Idempotent. Run after 20261201000000_native_esignature.sql. No back-fill, no data rewrite.

  ## Rollback (destroys evidence; only before real use)
  DROP TABLE public.signature_certificates; DROP TABLE public.signature_consents;
  DROP TRIGGER trg_sig_requests_evidence ON public.signature_requests; DROP TRIGGER trg_sig_requests_no_delete ON public.signature_requests;
  DROP TRIGGER trg_sig_signers_guard ON public.signature_signers; DROP TRIGGER trg_sig_events_chain ON public.signature_events;
  DROP TRIGGER trg_sig_events_guard ON public.signature_events; DROP FUNCTION public.get_signature_evidence(uuid);
  (then drop the added columns and re-apply submit_signature_by_token / record_signature_consent from 20261201000000_native_esignature.sql)
*/

-- =============================================================
-- 0. HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.esign_sha256_hex(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(COALESCE(p_text, ''), 'UTF8')), 'hex');
$$;

-- =============================================================
-- 1. COLUMNS
-- =============================================================

ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS consent_version text NOT NULL DEFAULT 'v1';
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_file_sha256 text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_snapshot text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS document_sha256 text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS consent_text_sha256 text;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS evidence_version smallint;

ALTER TABLE signature_events ADD COLUMN IF NOT EXISTS seq integer;
ALTER TABLE signature_events ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE signature_events ADD COLUMN IF NOT EXISTS event_hash text;
ALTER TABLE signature_events ADD COLUMN IF NOT EXISTS hash_preimage text;
ALTER TABLE signature_events ADD COLUMN IF NOT EXISTS chain_version smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sigreq_file_hash_check' AND conrelid = 'public.signature_requests'::regclass) THEN
    ALTER TABLE signature_requests ADD CONSTRAINT sigreq_file_hash_check
      CHECK (document_file_sha256 IS NULL OR document_file_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sigreq_consent_version_check' AND conrelid = 'public.signature_requests'::regclass) THEN
    ALTER TABLE signature_requests ADD CONSTRAINT sigreq_consent_version_check
      CHECK (char_length(consent_version) BETWEEN 1 AND 40);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_signature_events_chain_seq
  ON signature_events(request_id, seq) WHERE seq IS NOT NULL;

-- =============================================================
-- 2. REQUEST FINGERPRINT + IMMUTABILITY
-- =============================================================

CREATE OR REPLACE FUNCTION public.signature_requests_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.document_type IS DISTINCT FROM OLD.document_type
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.document_summary IS DISTINCT FROM OLD.document_summary
       OR NEW.document_url IS DISTINCT FROM OLD.document_url
       OR NEW.document_file_sha256 IS DISTINCT FROM OLD.document_file_sha256
       OR NEW.consent_text IS DISTINCT FROM OLD.consent_text
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.document_snapshot IS DISTINCT FROM OLD.document_snapshot
       OR NEW.document_sha256 IS DISTINCT FROM OLD.document_sha256
       OR NEW.consent_text_sha256 IS DISTINCT FROM OLD.consent_text_sha256
       OR NEW.evidence_version IS DISTINCT FROM OLD.evidence_version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'The signed document and consent text cannot be changed after sending.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT, or UPDATE of a draft: (re)compute the fingerprint from the row itself. Client-supplied values are overwritten.
  NEW.document_snapshot := jsonb_build_array(
    'vireek-esign-doc-v1', NEW.id, NEW.user_id, NEW.document_type, NEW.document_id, NEW.title,
    NEW.document_summary, NEW.document_url, NEW.document_file_sha256, NEW.consent_text, NEW.consent_version
  )::text;
  NEW.document_sha256 := public.esign_sha256_hex(NEW.document_snapshot);
  NEW.consent_text_sha256 := public.esign_sha256_hex(NEW.consent_text);
  NEW.evidence_version := 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sig_requests_evidence ON signature_requests;
CREATE TRIGGER trg_sig_requests_evidence BEFORE INSERT OR UPDATE ON signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.signature_requests_evidence();

CREATE OR REPLACE FUNCTION public.signature_requests_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM signature_events e
    WHERE e.request_id = OLD.id AND e.event_type IN ('consented', 'signed', 'declined', 'completed')
  ) THEN
    RAISE EXCEPTION 'A request with consent or signature evidence cannot be deleted. Void it instead.' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sig_requests_no_delete ON signature_requests;
CREATE TRIGGER trg_sig_requests_no_delete BEFORE DELETE ON signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.signature_requests_no_delete();

-- =============================================================
-- 3. SIGNERS: a signed row is frozen
-- =============================================================

CREATE OR REPLACE FUNCTION public.signature_signers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION 'A signed signer record cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'signed' AND (
       NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.signing_order IS DISTINCT FROM OLD.signing_order OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.email IS DISTINCT FROM OLD.email OR NEW.phone IS DISTINCT FROM OLD.phone
       OR NEW.signer_token IS DISTINCT FROM OLD.signer_token OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.signature_type IS DISTINCT FROM OLD.signature_type OR NEW.signature_data IS DISTINCT FROM OLD.signature_data
       OR NEW.typed_font IS DISTINCT FROM OLD.typed_font OR NEW.signed_name IS DISTINCT FROM OLD.signed_name
       OR NEW.consented_at IS DISTINCT FROM OLD.consented_at OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.ip_address IS DISTINCT FROM OLD.ip_address OR NEW.user_agent IS DISTINCT FROM OLD.user_agent
     ) THEN
    RAISE EXCEPTION 'A signed signer record cannot be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sig_signers_guard ON signature_signers;
CREATE TRIGGER trg_sig_signers_guard BEFORE UPDATE OR DELETE ON signature_signers
  FOR EACH ROW EXECUTE FUNCTION public.signature_signers_guard();

-- =============================================================
-- 4. EVENTS: hash chain + append-only
-- =============================================================

CREATE OR REPLACE FUNCTION public.signature_events_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
  v_prev text;
  v_ts text;
  v_pre text;
BEGIN
  -- Serialise writers per request so seq and prev_hash are gap-free and linear.
  PERFORM pg_advisory_xact_lock(hashtextextended('esign-chain:' || NEW.request_id::text, 0));
  SELECT e.seq, e.event_hash INTO v_seq, v_prev
  FROM signature_events e
  WHERE e.request_id = NEW.request_id AND e.seq IS NOT NULL
  ORDER BY e.seq DESC LIMIT 1;

  NEW.seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := COALESCE(v_prev, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  v_ts := to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_pre := jsonb_build_array(
    'vireek-esign-evt-v1', NEW.id, NEW.request_id, NEW.seq, NEW.event_type, NEW.signer_id,
    NEW.ip_address, NEW.user_agent, NEW.metadata, v_ts, NEW.prev_hash
  )::text;
  NEW.hash_preimage := v_pre;
  NEW.event_hash := public.esign_sha256_hex(v_pre);
  NEW.chain_version := 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sig_events_chain ON signature_events;
CREATE TRIGGER trg_sig_events_chain BEFORE INSERT ON signature_events
  FOR EACH ROW EXECUTE FUNCTION public.signature_events_chain();

CREATE OR REPLACE FUNCTION public.signature_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Signature events are append-only.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM signature_events e
    WHERE e.request_id = OLD.request_id AND e.event_type IN ('consented', 'signed', 'declined', 'completed')
  ) THEN
    RAISE EXCEPTION 'Signature events with consent or signature evidence cannot be deleted.' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sig_events_guard ON signature_events;
CREATE TRIGGER trg_sig_events_guard BEFORE UPDATE OR DELETE ON signature_events
  FOR EACH ROW EXECUTE FUNCTION public.signature_events_guard();

-- =============================================================
-- 5. CONSENT RECORDS
-- =============================================================

CREATE TABLE IF NOT EXISTS signature_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES signature_requests(id) ON DELETE RESTRICT,
  signer_id uuid NOT NULL REFERENCES signature_signers(id) ON DELETE RESTRICT,
  consent_text text NOT NULL,
  consent_text_sha256 text NOT NULL,
  consent_version text NOT NULL,
  method text NOT NULL,
  ip_address text,
  user_agent text,
  consented_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sigcons_unique_signer UNIQUE (signer_id),
  CONSTRAINT sigcons_method_check CHECK (method IN ('checkbox_click', 'captured_at_signing')),
  CONSTRAINT sigcons_hash_check CHECK (consent_text_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_signature_consents_request ON signature_consents(request_id);

CREATE OR REPLACE FUNCTION public.esign_write_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'This evidence record is write-once.' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_sig_consents_once ON signature_consents;
CREATE TRIGGER trg_sig_consents_once BEFORE UPDATE OR DELETE ON signature_consents
  FOR EACH ROW EXECUTE FUNCTION public.esign_write_once();

ALTER TABLE signature_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON signature_consents FROM anon, authenticated;
GRANT SELECT ON signature_consents TO authenticated;
DROP POLICY IF EXISTS "select_own_signature_consents" ON signature_consents;
CREATE POLICY "select_own_signature_consents" ON signature_consents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));

-- =============================================================
-- 6. CERTIFICATE STORE (written by the Edge Function with the service role only)
-- =============================================================

CREATE TABLE IF NOT EXISTS signature_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES signature_requests(id) ON DELETE RESTRICT,
  certificate_json jsonb NOT NULL,
  certificate_sha256 text NOT NULL,
  seal_hmac text NOT NULL,
  seal_key_id text NOT NULL,
  chain_head_hash text,
  event_count integer NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sigcert_hash_check CHECK (certificate_sha256 ~ '^[0-9a-f]{64}$' AND seal_hmac ~ '^[0-9a-f]{64}$')
);

DROP TRIGGER IF EXISTS trg_sig_certs_once ON signature_certificates;
CREATE TRIGGER trg_sig_certs_once BEFORE UPDATE OR DELETE ON signature_certificates
  FOR EACH ROW EXECUTE FUNCTION public.esign_write_once();

ALTER TABLE signature_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON signature_certificates FROM anon, authenticated;
GRANT SELECT ON signature_certificates TO authenticated;
DROP POLICY IF EXISTS "select_own_signature_certificates" ON signature_certificates;
CREATE POLICY "select_own_signature_certificates" ON signature_certificates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM signature_requests r WHERE r.id = request_id AND r.user_id = auth.uid()));

-- =============================================================
-- 7. SIGNING FLOW (same signatures as 20261201000000; behaviour extended)
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_signature_consent(p_signer_token uuid, p_ip text, p_user_agent text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signer signature_signers%ROWTYPE;
  v_req signature_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_signer FROM signature_signers WHERE signer_token = p_signer_token;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_req FROM signature_requests WHERE id = v_signer.request_id;
  IF v_signer.status IN ('signed', 'declined') OR v_req.status IN ('completed', 'declined', 'voided', 'expired', 'draft') THEN
    RETURN;
  END IF;

  INSERT INTO signature_consents (request_id, signer_id, consent_text, consent_text_sha256, consent_version, method, ip_address, user_agent)
  VALUES (v_req.id, v_signer.id, v_req.consent_text, public.esign_sha256_hex(v_req.consent_text), v_req.consent_version, 'checkbox_click', p_ip, p_user_agent)
  ON CONFLICT (signer_id) DO NOTHING;

  IF FOUND THEN
    UPDATE signature_signers SET consented_at = now() WHERE id = v_signer.id AND consented_at IS NULL;
    INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent, metadata)
    VALUES (v_req.id, v_signer.id, 'consented', p_ip, p_user_agent,
            jsonb_build_object('consent_text_sha256', public.esign_sha256_hex(v_req.consent_text), 'consent_version', v_req.consent_version, 'method', 'checkbox_click'));
  END IF;
END;
$$;

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
  v_req_id uuid;
  v_req signature_requests%ROWTYPE;
  v_signer signature_signers%ROWTYPE;
  v_remaining integer;
BEGIN
  IF p_signature_type NOT IN ('drawn', 'typed') OR coalesce(p_signature_data, '') = '' THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  SELECT request_id INTO v_req_id FROM signature_signers WHERE signer_token = p_signer_token;
  IF v_req_id IS NULL THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  -- Lock the request first, then the signer: concurrent last-signers cannot both see "one remaining".
  SELECT * INTO v_req FROM signature_requests WHERE id = v_req_id FOR UPDATE;
  SELECT * INTO v_signer FROM signature_signers WHERE signer_token = p_signer_token FOR UPDATE;

  IF v_signer.status IN ('signed', 'declined') OR v_req.status IN ('draft', 'completed', 'declined', 'voided', 'expired') THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  -- Consent evidence. The UI gates signing on the checkbox, which normally recorded consent earlier.
  -- If that call was lost, record it now and label it honestly.
  INSERT INTO signature_consents (request_id, signer_id, consent_text, consent_text_sha256, consent_version, method, ip_address, user_agent)
  VALUES (v_req.id, v_signer.id, v_req.consent_text, public.esign_sha256_hex(v_req.consent_text), v_req.consent_version, 'captured_at_signing', p_ip, p_user_agent)
  ON CONFLICT (signer_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent, metadata)
    VALUES (v_req.id, v_signer.id, 'consented', p_ip, p_user_agent,
            jsonb_build_object('consent_text_sha256', public.esign_sha256_hex(v_req.consent_text), 'consent_version', v_req.consent_version, 'method', 'captured_at_signing'));
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
  WHERE id = v_signer.id;

  INSERT INTO signature_events (request_id, signer_id, event_type, ip_address, user_agent, metadata)
  VALUES (v_req.id, v_signer.id, 'signed', p_ip, p_user_agent, jsonb_build_object(
    'signature_type', p_signature_type,
    'signature_sha256', public.esign_sha256_hex(p_signature_data),
    'signed_name', coalesce(p_signed_name, v_signer.name),
    'signer_role', v_signer.role,
    'document_sha256', v_req.document_sha256,
    'consent_text_sha256', v_req.consent_text_sha256));

  SELECT count(*) INTO v_remaining FROM signature_signers
  WHERE request_id = v_req.id AND status <> 'signed';

  IF v_remaining = 0 THEN
    UPDATE signature_requests SET status = 'completed', completed_at = now() WHERE id = v_req.id;
    INSERT INTO signature_events (request_id, event_type, metadata)
    VALUES (v_req.id, 'completed', jsonb_build_object('document_sha256', v_req.document_sha256, 'signer_count', (SELECT count(*) FROM signature_signers WHERE request_id = v_req.id)));
    RETURN QUERY SELECT true, true;
  ELSE
    UPDATE signature_requests SET status = 'partially_signed' WHERE id = v_req.id AND status <> 'partially_signed';
    RETURN QUERY SELECT true, false;
  END IF;
END;
$$;

-- =============================================================
-- 8. EVIDENCE READ (service role only; the Edge Function checks who may see it)
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_signature_evidence(p_request_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'request', jsonb_build_object(
      'id', r.id, 'owner_id', r.user_id, 'business_name', p.company_name, 'document_type', r.document_type,
      'document_id', r.document_id, 'title', r.title, 'document_summary', r.document_summary, 'document_url', r.document_url,
      'consent_text', r.consent_text, 'consent_version', r.consent_version, 'status', r.status,
      'sent_at', r.sent_at, 'completed_at', r.completed_at, 'expires_at', r.expires_at,
      'evidence_version', r.evidence_version, 'document_snapshot', r.document_snapshot, 'document_sha256', r.document_sha256,
      'document_file_sha256', r.document_file_sha256, 'consent_text_sha256', r.consent_text_sha256),
    'signers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'email', s.email, 'phone', s.phone, 'role', s.role, 'signing_order', s.signing_order,
        'status', s.status, 'signature_type', s.signature_type, 'signature_sha256', public.esign_sha256_hex(s.signature_data),
        'typed_signature', CASE WHEN s.signature_type = 'typed' THEN s.signature_data END,
        'signed_name', s.signed_name, 'consented_at', s.consented_at, 'signed_at', s.signed_at,
        'ip_address', s.ip_address, 'user_agent', s.user_agent) ORDER BY s.signing_order, s.created_at)
      FROM signature_signers s WHERE s.request_id = r.id), '[]'::jsonb),
    'consents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'signer_id', c.signer_id, 'consent_text_sha256', c.consent_text_sha256, 'consent_version', c.consent_version,
        'method', c.method, 'ip_address', c.ip_address, 'user_agent', c.user_agent, 'consented_at', c.consented_at)
        ORDER BY c.consented_at)
      FROM signature_consents c WHERE c.request_id = r.id), '[]'::jsonb),
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'seq', e.seq, 'event_type', e.event_type, 'signer_id', e.signer_id, 'ip_address', e.ip_address,
        'user_agent', e.user_agent, 'metadata', e.metadata,
        'created_at', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'prev_hash', e.prev_hash, 'event_hash', e.event_hash, 'hash_preimage', e.hash_preimage, 'chain_version', e.chain_version)
        ORDER BY e.seq NULLS FIRST, e.created_at, e.id)
      FROM signature_events e WHERE e.request_id = r.id), '[]'::jsonb)
  )
  FROM signature_requests r
  JOIN profiles p ON p.id = r.user_id
  WHERE r.id = p_request_id;
$$;

-- =============================================================
-- 9. PRIVILEGES
-- =============================================================

REVOKE ALL ON FUNCTION public.get_signature_evidence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_signature_evidence(uuid) TO service_role;
-- Pure hashing helper: safe for authenticated callers (the request trigger runs as the inserting user).
REVOKE ALL ON FUNCTION public.esign_sha256_hex(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.esign_sha256_hex(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.signature_requests_evidence(), public.signature_requests_no_delete(), public.signature_signers_guard(),
  public.signature_events_chain(), public.signature_events_guard(), public.esign_write_once() FROM PUBLIC, anon, authenticated;
-- record_signature_consent / submit_signature_by_token keep the service_role-only ACLs from 20261201000000.
