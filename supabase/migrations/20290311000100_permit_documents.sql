/*
  # Permit documents (checklist + attachment references)

  Extends the Permit Transaction Agent (20270401000000_permit_transaction_agent.sql)
  with a per-application document checklist: what the authority needs, whether it
  is attached, submitted, accepted or rejected. Metadata only. The file itself
  lives wherever the tenant keeps it; `file_reference` is a free-text pointer
  (storage path or https URL). Bucket wiring: TODO(owner).

  - Purely additive and idempotent. No existing table or function is changed.
  - Access: tenant owner / team via get_account_owner_id(), same as permit_authorities.
  - A row can only be written for an application the caller's account owns.
  - user_id and application_id are immutable after insert (guard trigger).

  rollback (manual, destroys document metadata): see the rollback line below.
*/

-- rollback: DROP TABLE public.permit_documents; DROP FUNCTION public.permit_documents_guard(); (destroys document metadata - only before it holds real data)

CREATE TABLE IF NOT EXISTS public.permit_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  application_id uuid NOT NULL REFERENCES public.permit_applications(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'other'
    CHECK (kind IN ('application_form', 'site_plan', 'drawings', 'load_calc', 'equipment_spec',
                    'contractor_license', 'insurance', 'owner_authorization', 'other')),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 160),
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'needed'
    CHECK (status IN ('needed', 'attached', 'submitted', 'accepted', 'rejected')),
  file_reference text CHECK (file_reference IS NULL OR char_length(file_reference) <= 500),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permit_documents_app ON public.permit_documents (application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_permit_documents_user ON public.permit_documents (user_id);

CREATE OR REPLACE FUNCTION public.permit_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.application_id IS DISTINCT FROM OLD.application_id THEN
    RAISE EXCEPTION 'user_id and application_id are immutable.' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_permit_documents_guard ON public.permit_documents;
CREATE TRIGGER trg_permit_documents_guard
  BEFORE UPDATE ON public.permit_documents
  FOR EACH ROW EXECUTE FUNCTION public.permit_documents_guard();

ALTER TABLE public.permit_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.permit_documents FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permit_documents TO authenticated;
GRANT ALL ON public.permit_documents TO service_role;

DROP POLICY IF EXISTS "select_own_permit_documents" ON public.permit_documents;
CREATE POLICY "select_own_permit_documents" ON public.permit_documents
  FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "insert_own_permit_documents" ON public.permit_documents;
CREATE POLICY "insert_own_permit_documents" ON public.permit_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT public.get_account_owner_id())
    AND EXISTS (
      SELECT 1 FROM public.permit_applications a
       WHERE a.id = application_id AND a.user_id = (SELECT public.get_account_owner_id())
    )
  );

DROP POLICY IF EXISTS "update_own_permit_documents" ON public.permit_documents;
CREATE POLICY "update_own_permit_documents" ON public.permit_documents
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()))
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()));

DROP POLICY IF EXISTS "delete_own_permit_documents" ON public.permit_documents;
CREATE POLICY "delete_own_permit_documents" ON public.permit_documents
  FOR DELETE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
