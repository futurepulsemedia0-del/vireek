/*
  Erasure certificates.

  After the retention-sweep erasure job completes a full-account deletion request, it records what it did
  (erasure_job_evidence) and a signed certificate is issued (erasure_certificates). See
  supabase/functions/_shared/compliance/erasureCertificate.ts and docs/compliance/erasure-certificate.md.

  Design notes
    * The owner column is `account_id`, NOT `user_id`, on purpose: public.erase_user_rows() deletes from every
      public table that has a uuid `user_id` column. A certificate that proves an erasure must survive it.
    * No foreign key to auth.users / profiles for the same reason.
    * Both tables are written only by service_role. Owners can read their own certificates (RLS) and nothing else.
    * erasure_certificates is append-only: UPDATE, DELETE and TRUNCATE are rejected for every role, including
      service_role. Evidence must not be editable after the fact.
    * Contains no personal data: the account id is a pseudonymous uuid; there is no email, name or table row content.

  Idempotent. NOT EXECUTED in authoring (no database available). Run on a staging copy first, then
  supabase/tests/database/erasure_certificates.test.sql.

  Rollback (manual, only if nothing has been issued, otherwise keep the evidence):
    DROP TABLE public.erasure_certificates; DROP TABLE public.erasure_job_evidence;
    DROP FUNCTION public.erasure_certificates_immutable();
*/

-- ---------------------------------------------------------------------------------------------
-- 1. Evidence captured by the erasure job (input to the certificate; lets a missed issue be retried)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erasure_job_evidence (
  deletion_request_id uuid PRIMARY KEY REFERENCES public.deletion_requests(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erasure_job_evidence_created_idx ON public.erasure_job_evidence (created_at DESC);

ALTER TABLE public.erasure_job_evidence ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: only service_role (bypasses RLS) reads or writes this table.
REVOKE ALL ON public.erasure_job_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.erasure_job_evidence TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Certificates
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erasure_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_request_id uuid NOT NULL UNIQUE REFERENCES public.deletion_requests(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  certificate_number text NOT NULL UNIQUE CHECK (certificate_number ~ '^VRK-ERC-[0-9A-F]{12}$'),
  document_json text NOT NULL CHECK (length(document_json) BETWEEN 2 AND 262144),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  status text NOT NULL CHECK (status IN ('completed', 'completed_with_exceptions')),
  backup_expires_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erasure_certificates_account_idx ON public.erasure_certificates (account_id, issued_at DESC);

ALTER TABLE public.erasure_certificates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "erasure_certificates_owner_select" ON public.erasure_certificates;
CREATE POLICY "erasure_certificates_owner_select"
  ON public.erasure_certificates FOR SELECT TO authenticated
  USING (account_id = (SELECT auth.uid()));

REVOKE ALL ON public.erasure_certificates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erasure_certificates TO authenticated;
GRANT SELECT, INSERT ON public.erasure_certificates TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Append-only guard (applies to every role, service_role included)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.erasure_certificates_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'erasure_certificates is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_erasure_certificates_no_update ON public.erasure_certificates;
CREATE TRIGGER trg_erasure_certificates_no_update
  BEFORE UPDATE OR DELETE ON public.erasure_certificates
  FOR EACH ROW EXECUTE FUNCTION public.erasure_certificates_immutable();

DROP TRIGGER IF EXISTS trg_erasure_certificates_no_truncate ON public.erasure_certificates;
CREATE TRIGGER trg_erasure_certificates_no_truncate
  BEFORE TRUNCATE ON public.erasure_certificates
  FOR EACH STATEMENT EXECUTE FUNCTION public.erasure_certificates_immutable();

COMMENT ON TABLE public.erasure_certificates IS
  'Signed deletion certificates. Append-only. Owner column is account_id (not user_id) so erase_user_rows() never removes them.';
COMMENT ON TABLE public.erasure_job_evidence IS
  'What the erasure job did per deletion request. service_role only. Input to erasure_certificates.';
