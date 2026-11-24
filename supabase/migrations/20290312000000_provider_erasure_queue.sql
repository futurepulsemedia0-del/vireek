-- Provider-side erasure queue (gap E5) + storage-object listing for account erasure.
--
-- WHAT THIS ADDS
--   1. public.provider_erasure_jobs  — one row per (account, provider, chunk of identifiers). Holds a SNAPSHOT of the
--      provider-side identifiers (Vapi call ids, Twilio SIDs, ElevenLabs voice ids), taken BEFORE local rows are
--      deleted, so a retry still works after the local rows are gone. Also stores the per-job proof.
--   2. public.claim_provider_erasure_jobs()  — lease-based claim (FOR UPDATE SKIP LOCKED), safe for concurrent sweeps.
--   3. public.storage_objects_for_account()  — lists a tenant's storage objects across ALL buckets so delete-account
--      and the sweep can remove them through the Storage API (deleting storage.objects rows directly would leave the
--      blobs behind).
--
-- DESIGN NOTES
--   * The account column is deliberately called subject_account_id (NOT user_id) and has NO foreign key:
--     public.erase_user_rows() deletes from every table with a uuid user_id column, and the proof of erasure must
--     survive both that and the deletion of the auth user.
--   * The subject snapshot contains provider resource identifiers only (no names, numbers, e-mail addresses, transcripts).
--   * Writes: service_role only. The account owner may read their own rows while the account still exists.
--   * Idempotent: safe to run more than once.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.claim_provider_erasure_jobs(integer, integer, uuid);
--   DROP FUNCTION IF EXISTS public.storage_objects_for_account(uuid, integer);
--   DROP TABLE IF EXISTS public.provider_erasure_jobs;
--   (Dropping the table discards erasure proofs — export them first if counsel needs them.)
--
-- NOT EXECUTED in authoring: run on a staging copy first.
-- TODO(counsel): decide how long erasure proofs are kept after completion (no purge job is shipped on purpose).

CREATE TABLE IF NOT EXISTS public.provider_erasure_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_account_id uuid NOT NULL,
  request_id        uuid,
  provider          text NOT NULL CHECK (provider IN ('vapi', 'twilio', 'elevenlabs', 'resend')),
  dedupe_key        text NOT NULL,
  subject           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'erased', 'not_applicable', 'unsupported', 'dead')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 50),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz,
  last_error        text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  proof             jsonb,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_erasure_jobs_dedupe_uq
  ON public.provider_erasure_jobs (dedupe_key);
CREATE INDEX IF NOT EXISTS provider_erasure_jobs_due_idx
  ON public.provider_erasure_jobs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS provider_erasure_jobs_account_idx
  ON public.provider_erasure_jobs (subject_account_id);
CREATE INDEX IF NOT EXISTS provider_erasure_jobs_request_idx
  ON public.provider_erasure_jobs (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE public.provider_erasure_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_erasure_jobs_select_own" ON public.provider_erasure_jobs;
CREATE POLICY "provider_erasure_jobs_select_own" ON public.provider_erasure_jobs
  FOR SELECT TO authenticated
  USING (subject_account_id = (SELECT public.get_account_owner_id()));

-- No INSERT/UPDATE/DELETE policies exist, and the grants are removed as well (defence in depth).
REVOKE ALL ON public.provider_erasure_jobs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.provider_erasure_jobs FROM authenticated;

-- ---------------------------------------------------------------- claim (lease)
CREATE OR REPLACE FUNCTION public.claim_provider_erasure_jobs(
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 300,
  p_subject uuid DEFAULT NULL
)
RETURNS SETOF public.provider_erasure_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT j.id
      FROM public.provider_erasure_jobs j
     WHERE j.status = 'pending'
       AND j.next_attempt_at <= now()
       AND (j.locked_until IS NULL OR j.locked_until < now())
       AND (p_subject IS NULL OR j.subject_account_id = p_subject)
     ORDER BY j.next_attempt_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.provider_erasure_jobs j
     SET locked_until = now() + make_interval(secs => GREATEST(30, LEAST(COALESCE(p_lease_seconds, 300), 3600))),
         updated_at = now()
    FROM due
   WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_provider_erasure_jobs(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_provider_erasure_jobs(integer, integer, uuid) TO service_role;

-- ---------------------------------------------------------------- storage listing
-- Every private bucket in this schema lays objects out as {account_owner_id}/... (see the storage policies and the
-- pbx-voice / voice-briefs path comments), so the first folder segment identifies the tenant.
CREATE OR REPLACE FUNCTION public.storage_objects_for_account(p_account uuid, p_limit integer DEFAULT 500)
RETURNS TABLE (bucket_id text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
   WHERE p_account IS NOT NULL
     AND (storage.foldername(o.name))[1] = p_account::text
   ORDER BY o.bucket_id, o.name
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000));
$$;

REVOKE ALL ON FUNCTION public.storage_objects_for_account(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_objects_for_account(uuid, integer) TO service_role;

COMMENT ON TABLE public.provider_erasure_jobs IS
  'Retry queue + proof for provider-side erasure (Vapi, Twilio, ElevenLabs, Resend). service_role writes only. Not live-verified.';
COMMENT ON FUNCTION public.storage_objects_for_account(uuid, integer) IS
  'Lists storage objects whose first path segment is the account owner id. service_role only. Delete through the Storage API, not SQL.';
